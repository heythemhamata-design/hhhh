import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  runId = randomUUID(),
): WorkspaceToolExecution {
  return {
    taskId,
    runId,
    correlationId: `phase2.3-workspace-replay:${taskId}`,
    agentId,
    operationIndex,
    operationKey: hash(`${taskId}:${tool}:${operationIndex}`),
    argumentsHash: hash(stableJson(args)),
  };
}

async function main(): Promise<void> {
  const pool = getPostgresPool();
  const token = randomUUID();
  const relativeRoot = `phase2_3_workspace_replay_${token}`;
  const absoluteRoot = path.resolve(process.cwd(), "workspace", relativeRoot);
  const operationKeys: string[] = [];
  let taskId: string | null = null;
  let cleanupComplete = false;

  console.log(`Temporary workspace replay marker: ${token}`);
  console.log("This test writes only inside a unique temporary directory under ./workspace and attaches test receipts to an existing terminal task.");

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

    await mkdir(absoluteRoot, { recursive: true });

    // 1. Confirmed write + replay must return the receipt without rewriting.
    const writeArgs = { path: `${relativeRoot}/write.txt`, content: `WRITE_ONCE_${token}` };
    const writeExec1 = makeExecution(taskId, agentId, "workspace_write_file", 201, writeArgs);
    operationKeys.push(writeExec1.operationKey);
    const writeFirst = await executeWorkspaceTool("workspace_write_file", JSON.stringify(writeArgs), writeExec1);
    assert.equal(writeFirst?.ok, true, "Initial write should succeed.");
    assert.equal(writeFirst?.status, "succeeded");
    console.log("PASS: first workspace_write_file completed with a durable success receipt.");

    const writeExec2 = makeExecution(taskId, agentId, "workspace_write_file", 201, writeArgs);
    const writeReplay = await executeWorkspaceTool("workspace_write_file", JSON.stringify(writeArgs), writeExec2);
    assert.equal(writeReplay?.ok, true);
    assert.equal(writeReplay?.status, "succeeded");
    assert.equal(await readFile(path.join(absoluteRoot, "write.txt"), "utf8"), writeArgs.content);
    console.log("PASS: write replay returned cached success and preserved file content.");

    // Same logical step with different arguments must not overwrite the file.
    const conflictArgs = { path: writeArgs.path, content: `SHOULD_NOT_OVERWRITE_${token}` };
    const conflictExec = makeExecution(taskId, agentId, "workspace_write_file", 201, conflictArgs);
    const conflict = await executeWorkspaceTool("workspace_write_file", JSON.stringify(conflictArgs), conflictExec);
    assert.equal(conflict?.ok, false);
    assert.equal(conflict?.status, "outcome_unknown");
    assert.equal(await readFile(path.join(absoluteRoot, "write.txt"), "utf8"), writeArgs.content);
    console.log("PASS: changed arguments for the same write step were rejected without overwriting the file.");

    // 2. Append replay must not duplicate bytes.
    const appendPath = path.join(absoluteRoot, "append.txt");
    await writeFile(appendPath, "BASE\n", { encoding: "utf8", flag: "wx" });
    const appendArgs = { path: `${relativeRoot}/append.txt`, content: `APPENDED_ONCE_${token}\n` };
    const appendExec1 = makeExecution(taskId, agentId, "workspace_append_file", 202, appendArgs);
    operationKeys.push(appendExec1.operationKey);
    const appendFirst = await executeWorkspaceTool("workspace_append_file", JSON.stringify(appendArgs), appendExec1);
    assert.equal(appendFirst?.ok, true);
    assert.equal(appendFirst?.status, "succeeded");
    const appendExec2 = makeExecution(taskId, agentId, "workspace_append_file", 202, appendArgs);
    const appendReplay = await executeWorkspaceTool("workspace_append_file", JSON.stringify(appendArgs), appendExec2);
    assert.equal(appendReplay?.ok, true);
    assert.equal(appendReplay?.status, "succeeded");
    assert.equal(await readFile(appendPath, "utf8"), `BASE\n${appendArgs.content}`);
    console.log("PASS: workspace_append_file replay did not append duplicate content.");

    // 3. Directory creation is receipt-backed too.
    const directoryArgs = { path: `${relativeRoot}/created/nested` };
    const directoryExec1 = makeExecution(taskId, agentId, "workspace_create_directory", 203, directoryArgs);
    operationKeys.push(directoryExec1.operationKey);
    const directoryFirst = await executeWorkspaceTool("workspace_create_directory", JSON.stringify(directoryArgs), directoryExec1);
    assert.equal(directoryFirst?.ok, true);
    assert.equal(directoryFirst?.status, "succeeded");
    const directoryExec2 = makeExecution(taskId, agentId, "workspace_create_directory", 203, directoryArgs);
    const directoryReplay = await executeWorkspaceTool("workspace_create_directory", JSON.stringify(directoryArgs), directoryExec2);
    assert.equal(directoryReplay?.ok, true);
    assert.equal(directoryReplay?.status, "succeeded");
    assert.equal((await stat(path.join(absoluteRoot, "created", "nested"))).isDirectory(), true);
    console.log("PASS: workspace_create_directory replay returned the receipt without repeating the operation.");

    // 4. Simulate process death after the durable start marker but before filesystem work.
    const crashArgs = { path: `${relativeRoot}/must-not-exist.txt`, content: `NO_REPLAY_${token}` };
    const crashExec = makeExecution(taskId, agentId, "workspace_write_file", 204, crashArgs);
    operationKeys.push(crashExec.operationKey);
    await pool.query(
      `INSERT INTO public.task_events
        (task_id, run_id, correlation_id, agent_id, tool_name, event_type, severity, success, details)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'workspace_write_file', 'tool.execution_started', 'info', false, $5::jsonb)`,
      [
        crashExec.taskId,
        crashExec.runId,
        crashExec.correlationId,
        crashExec.agentId,
        JSON.stringify({
          tool: "workspace_write_file",
          operationIndex: crashExec.operationIndex,
          operationKey: crashExec.operationKey,
          argumentsHash: crashExec.argumentsHash,
        }),
      ],
    );
    const crashReplay = await executeWorkspaceTool("workspace_write_file", JSON.stringify(crashArgs), makeExecution(
      taskId,
      agentId,
      "workspace_write_file",
      204,
      crashArgs,
    ));
    assert.equal(crashReplay?.ok, false);
    assert.equal(crashReplay?.status, "outcome_unknown");
    await assert.rejects(readFile(path.join(absoluteRoot, "must-not-exist.txt"), "utf8"));
    console.log("PASS: start-without-success marker blocked replay and did not create the file.");

    // 5. Mutation without durable task identity must fail closed.
    const noContext = await executeWorkspaceTool(
      "workspace_write_file",
      JSON.stringify({ path: `${relativeRoot}/no-context.txt`, content: "DENIED" }),
    );
    assert.equal(noContext?.ok, false);
    assert.equal(noContext?.status, "denied");
    await assert.rejects(readFile(path.join(absoluteRoot, "no-context.txt"), "utf8"));
    console.log("PASS: workspace mutation without durable task identity was denied.");

    const receipts = await pool.query<{ operation_key: string; event_type: string; total: string }>(
      `SELECT details->>'operationKey' AS operation_key, event_type, COUNT(*)::text AS total
       FROM public.task_events
       WHERE task_id = $1::uuid
         AND details->>'operationKey' = ANY($2::text[])
       GROUP BY details->>'operationKey', event_type
       ORDER BY operation_key, event_type`,
      [taskId, operationKeys],
    );
    const countFor = (key: string, eventType: string) =>
      Number(receipts.rows.find((row) => row.operation_key === key && row.event_type === eventType)?.total ?? 0);
    for (const key of [writeExec1.operationKey, appendExec1.operationKey, directoryExec1.operationKey]) {
      assert.equal(countFor(key, "tool.execution_started"), 1, `Expected one start marker for ${key}.`);
      assert.equal(countFor(key, "tool.execution_succeeded"), 1, `Expected one success receipt for ${key}.`);
    }
    assert.equal(countFor(crashExec.operationKey, "tool.execution_started"), 1);
    assert.equal(countFor(crashExec.operationKey, "tool.execution_succeeded"), 0);
    console.log(`PASS: exactly one start/success receipt per completed operation; simulated interrupted operation has only one start marker.`);

    console.log("RESULT: PASS — durable workspace write/append/directory replay, conflict handling and crash-window suppression verified.");
  } finally {
    let eventCleanup = false;
    let fileCleanup = false;
    try {
      if (taskId && operationKeys.length > 0) {
        await pool.query(
          `DELETE FROM public.task_events
           WHERE task_id = $1::uuid
             AND details->>'operationKey' = ANY($2::text[])`,
          [taskId, operationKeys],
        );
      }
      eventCleanup = true;
    } catch (error) {
      console.error(`EVENT_CLEANUP_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await rm(absoluteRoot, { recursive: true, force: true });
      fileCleanup = true;
    } catch (error) {
      console.error(`FILE_CLEANUP_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
    cleanupComplete = eventCleanup && fileCleanup;
    await pool.end();
    console.log(`CLEANUP_STATUS: ${cleanupComplete ? "complete" : "incomplete"}`);
  }
}

main().catch((error) => {
  console.error(`WORKSPACE REPLAY TEST FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
