import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { getPostgresPool } from "../lib/db/postgres";
import { executeWorkspaceTool, type WorkspaceToolExecution } from "../lib/workspace/tools";

loadEnvConfig(process.cwd());

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + stableJson(record[key]),
  ).join(",") + "}";
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeExecution(
  taskId: string,
  agentId: string,
  tool: string,
  operationIndex: number,
  args: Record<string, unknown>,
): WorkspaceToolExecution {
  return {
    taskId,
    runId: randomUUID(),
    correlationId: `phase2.3-post-effect-crash:${taskId}`,
    agentId,
    operationIndex,
    operationKey: hash(`${taskId}:${tool}:${operationIndex}`),
    argumentsHash: hash(stableJson(args)),
  };
}

async function insertStartReceipt(
  pool: ReturnType<typeof getPostgresPool>,
  execution: WorkspaceToolExecution,
  tool: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO public.task_events
      (task_id, run_id, correlation_id, agent_id, tool_name, event_type, severity, success, details)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'tool.execution_started', 'info', false, $6::jsonb)`,
    [
      execution.taskId,
      execution.runId,
      execution.correlationId,
      execution.agentId,
      tool,
      JSON.stringify({
        tool,
        operationIndex: execution.operationIndex,
        operationKey: execution.operationKey,
        argumentsHash: execution.argumentsHash,
      }),
    ],
  );
}

async function assertNoSuccessReceipt(
  pool: ReturnType<typeof getPostgresPool>,
  taskId: string,
  operationKey: string,
): Promise<void> {
  const result = await pool.query<{ starts: string; successes: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE event_type = 'tool.execution_started')::text AS starts,
       COUNT(*) FILTER (WHERE event_type = 'tool.execution_succeeded')::text AS successes
     FROM public.task_events
     WHERE task_id = $1::uuid AND details->>'operationKey' = $2`,
    [taskId, operationKey],
  );
  assert.equal(result.rows[0]?.starts, "1", "Expected exactly one durable start marker.");
  assert.equal(result.rows[0]?.successes, "0", "No success receipt should exist in the simulated crash window.");
}

async function main(): Promise<void> {
  const pool = getPostgresPool();
  const token = randomUUID();
  const workspaceParent = path.resolve(process.cwd(), "workspace");
  const relativeRoot = `phase2_3_post_effect_crash_${token}`;
  const absoluteRoot = path.resolve(workspaceParent, relativeRoot);
  assert.ok(absoluteRoot.startsWith(workspaceParent + path.sep), "Temporary test path must remain under workspace.");

  const operationKeys: string[] = [];
  let taskId: string | null = null;
  let cleanupComplete = false;

  console.log(`Post-effect crash-window marker: ${token}`);
  console.log("This test simulates process death AFTER a filesystem mutation but BEFORE tool.execution_succeeded is written.");
  console.log("It uses a terminal task only as an event anchor; it never changes that task.");

  try {
    const anchor = await pool.query<{ id: string }>(
      `SELECT id::text AS id
       FROM public.tasks
       WHERE status IN ('completed', 'failed', 'cancelled')
       ORDER BY updated_at DESC
       LIMIT 1`,
    );
    assert.equal(anchor.rowCount, 1, "A terminal task is required as an isolated event anchor.");
    taskId = anchor.rows[0].id;
    const agentId = "editor";
    const baseOperationIndex = Number.parseInt(token.replace(/-/g, "").slice(0, 7), 16);

    await mkdir(absoluteRoot, { recursive: true });

    // Case A: the file write happened, but the process died before success receipt.
    const writeArgs = {
      path: `${relativeRoot}/write-after-effect.txt`,
      content: `WRITE_EFFECT_ALREADY_APPLIED_${token}`,
    };
    const writeExecution = makeExecution(taskId, agentId, "workspace_write_file", baseOperationIndex, writeArgs);
    operationKeys.push(writeExecution.operationKey);
    await insertStartReceipt(pool, writeExecution, "workspace_write_file");
    const writePath = path.join(absoluteRoot, "write-after-effect.txt");
    await writeFile(writePath, writeArgs.content, { encoding: "utf8", flag: "wx" });

    const writeRetry = await executeWorkspaceTool(
      "workspace_write_file",
      JSON.stringify(writeArgs),
      makeExecution(taskId, agentId, "workspace_write_file", baseOperationIndex, writeArgs),
    );
    assert.equal(writeRetry?.ok, false);
    assert.equal(writeRetry?.status, "outcome_unknown");
    assert.equal(await readFile(writePath, "utf8"), writeArgs.content, "Replay must not overwrite the already-written file.");
    await assertNoSuccessReceipt(pool, taskId, writeExecution.operationKey);
    console.log("PASS: post-write/pre-receipt crash simulation was blocked; existing file content was preserved.");

    // Case B: the append happened, but no success receipt was committed.
    const appendPath = path.join(absoluteRoot, "append-after-effect.txt");
    await writeFile(appendPath, "BASE\n", { encoding: "utf8", flag: "wx" });
    const appendArgs = {
      path: `${relativeRoot}/append-after-effect.txt`,
      content: `APPEND_EFFECT_ALREADY_APPLIED_${token}\n`,
    };
    const appendExecution = makeExecution(taskId, agentId, "workspace_append_file", baseOperationIndex + 1, appendArgs);
    operationKeys.push(appendExecution.operationKey);
    await insertStartReceipt(pool, appendExecution, "workspace_append_file");
    await appendFile(appendPath, appendArgs.content, "utf8");

    const appendRetry = await executeWorkspaceTool(
      "workspace_append_file",
      JSON.stringify(appendArgs),
      makeExecution(taskId, agentId, "workspace_append_file", baseOperationIndex + 1, appendArgs),
    );
    assert.equal(appendRetry?.ok, false);
    assert.equal(appendRetry?.status, "outcome_unknown");
    const appendContent = await readFile(appendPath, "utf8");
    assert.equal(appendContent, `BASE\n${appendArgs.content}`, "Replay must not duplicate appended bytes.");
    assert.equal(appendContent.split(appendArgs.content.trim()).length - 1, 1);
    await assertNoSuccessReceipt(pool, taskId, appendExecution.operationKey);
    console.log("PASS: post-append/pre-receipt crash simulation was blocked; appended content remained exactly once.");

    // Case C: directory creation happened, but the success receipt is absent.
    const directoryArgs = { path: `${relativeRoot}/directory-after-effect/nested` };
    const directoryExecution = makeExecution(taskId, agentId, "workspace_create_directory", baseOperationIndex + 2, directoryArgs);
    operationKeys.push(directoryExecution.operationKey);
    await insertStartReceipt(pool, directoryExecution, "workspace_create_directory");
    const directoryPath = path.join(absoluteRoot, "directory-after-effect", "nested");
    await mkdir(directoryPath, { recursive: true });

    const directoryRetry = await executeWorkspaceTool(
      "workspace_create_directory",
      JSON.stringify(directoryArgs),
      makeExecution(taskId, agentId, "workspace_create_directory", baseOperationIndex + 2, directoryArgs),
    );
    assert.equal(directoryRetry?.ok, false);
    assert.equal(directoryRetry?.status, "outcome_unknown");
    assert.equal((await stat(directoryPath)).isDirectory(), true);
    await assertNoSuccessReceipt(pool, taskId, directoryExecution.operationKey);
    console.log("PASS: post-directory-creation/pre-receipt crash simulation was blocked; existing directory was preserved.");

    console.log("RESULT: PASS — post-effect/pre-success crash-window suppression verified for write, append and directory creation.");
  } finally {
    let eventCleanup = false;
    let fileCleanup = false;
    try {
      if (taskId && operationKeys.length > 0) {
        await pool.query(
          `DELETE FROM public.task_events
           WHERE task_id = $1::uuid AND details->>'operationKey' = ANY($2::text[])`,
          [taskId, operationKeys],
        );
      }
      eventCleanup = true;
    } catch (error) {
      console.error(`EVENT_CLEANUP_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await rm(absoluteRoot, { recursive: true, force: true });
      fileCleanup = true;
    } catch (error) {
      console.error(`WORKSPACE_CLEANUP_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    cleanupComplete = eventCleanup && fileCleanup;
    console.log(`CLEANUP_STATUS: ${cleanupComplete ? "complete" : "incomplete"}`);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`RESULT: FAIL — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
