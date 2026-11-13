import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { getPostgresPool } from "../lib/db/postgres";
import { recoverExpiredTaskLeases } from "../lib/tasks/lease-recovery";

loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const pool = getPostgresPool();
  const token = randomUUID();
  const createdTaskIds: string[] = [];
  const expectedRunIds = new Map<string, string>();
  let cleanupComplete = false;

  console.log(`Lease recovery side-effect guard marker: ${token}`);
  console.log("This test creates three stale synthetic tasks inside a transaction, runs the same recovery helper used by Worker, and commits only after all three are blocked.");

  try {
    const agent = await pool.query<{ id: string; enabled: boolean }>(
      "SELECT id, enabled FROM public.agents WHERE id = 'editor'",
    );
    assert.equal(agent.rowCount, 1, "Editor agent must exist.");
    assert.equal(agent.rows[0].enabled, true, "Editor agent must be enabled.");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const scenarios = [
        { tool: "workspace_write_file", eventType: "tool.execution_started", priorRun: false },
        { tool: "memory_save", eventType: "tool.execution_succeeded", priorRun: false },
        { tool: "workspace_append_file", eventType: "tool.execution_started", priorRun: true },
      ] as const;

      for (const scenario of scenarios) {
        const taskId = randomUUID();
        const runId = randomUUID();
        const eventRunId = scenario.priorRun ? randomUUID() : runId;
        createdTaskIds.push(taskId);
        expectedRunIds.set(taskId, runId);

        await client.query(
          `INSERT INTO public.tasks
            (id, agent_id, task_type, input, status, priority, attempt_count,
             max_attempts, metadata, run_id, locked_by, locked_at, heartbeat_at,
             started_at, available_at)
           VALUES
            ($1::uuid, 'editor', 'agent_task', $2, 'running', 100, 1,
             3, $3::jsonb, $4::uuid, $5, clock_timestamp() - interval '20 minutes',
             clock_timestamp() - interval '20 minutes',
             clock_timestamp() - interval '20 minutes', clock_timestamp())`,
          [
            taskId,
            `PHASE2_3_LEASE_RECOVERY_GUARD_${token}_${scenario.tool}`,
            JSON.stringify({
              correlationId: `phase2.3-lease-recovery:${token}:${scenario.tool}`,
              enableTools: false,
              allowedTools: [],
              toolPolicyVersion: 1,
            }),
            runId,
            `phase2.3-test:${token}`,
          ],
        );

        await client.query(
          `INSERT INTO public.task_events
            (task_id, run_id, correlation_id, agent_id, tool_name,
             event_type, severity, success, details)
           VALUES ($1::uuid, $2::uuid, $3, 'editor', $4, $5, 'info', $6, $7::jsonb)`,
          [
            taskId,
            eventRunId,
            `phase2.3-lease-recovery:${token}:${scenario.tool}`,
            scenario.tool,
            scenario.eventType,
            scenario.eventType === "tool.execution_succeeded",
            JSON.stringify({
              tool: scenario.tool,
              operationIndex: 0,
              operationKey: `${taskId}:side-effect:0`,
              argumentsHash: `test-${token}`,
              ...(scenario.eventType === "tool.execution_succeeded" ? { result: { simulated: true } } : {}),
            }),
          ],
        );
      }

      const recovered = await recoverExpiredTaskLeases(client, 90);
      assert.equal(recovered.length, 3, "All synthetic stale tasks should be recovered.");

      for (const task of recovered) {
        assert.equal(task.status, "failed", `Task ${task.id} must fail closed instead of returning to queued.`);
        assert.equal(task.side_effect_blocked, true, `Task ${task.id} must carry side-effect block flag.`);
        assert.equal(task.attempt_count, 1, "Recovery must not increment attempt_count.");
        assert.equal(task.side_effect_tools.length, 1, "Exactly one side-effect tool should be reported.");
        assert.match(task.side_effect_tools[0], /^(workspace_write_file|workspace_append_file|memory_save)$/);
      }

      await client.query("COMMIT");
      console.log("PASS: recovery helper blocked start-without-success, success-receipt, and prior-run side-effect tasks.");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
      throw error;
    } finally {
      client.release();
    }

    const persisted = await pool.query<{
      id: string;
      status: string;
      attempt_count: number;
      run_id: string;
      locked_by: string | null;
      error: string | null;
    }>(
      `SELECT id::text AS id, status, attempt_count, run_id::text AS run_id, locked_by, error
       FROM public.tasks
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [createdTaskIds],
    );
    assert.equal(persisted.rowCount, 3, "All three synthetic tasks should persist after recovery.");

    for (const task of persisted.rows) {
      assert.equal(task.status, "failed");
      assert.equal(task.attempt_count, 1);
      assert.equal(task.run_id, expectedRunIds.get(task.id), "Recovery must preserve the expired run identity for audit.");
      assert.equal(task.locked_by, null);
      assert.match(task.error ?? "", /automatic replay was suppressed/i);
    }
    console.log("PASS: all tasks persisted as failed with ownership cleared and attempt count unchanged.");

    const events = await pool.query<{
      task_id: string;
      event_type: string;
      details: Record<string, unknown>;
    }>(
      `SELECT task_id::text AS task_id, event_type, details
       FROM public.task_events
       WHERE task_id = ANY($1::uuid[])
         AND event_type = 'task.lease_expired'
       ORDER BY task_id`,
      [createdTaskIds],
    );
    assert.equal(events.rowCount, 3, "Each task should have exactly one recovery event.");
    for (const event of events.rows) {
      assert.equal(event.details.sideEffectBlocked, true);
      assert.equal(event.details.recoveryAction, "suppressed_for_manual_reconciliation");
    }
    console.log("PASS: task.lease_expired events record sideEffectBlocked and manual-reconciliation action, including prior-run evidence.");

    const claimed = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
       FROM public.task_events
       WHERE task_id = ANY($1::uuid[])
         AND event_type = 'task.claimed'`,
      [createdTaskIds],
    );
    assert.equal(Number(claimed.rows[0]?.total ?? 0), 0, "Blocked tasks must never be claimed again.");
    console.log("PASS: no recovered task was re-claimed; no new run or duplicate side effect could start.");

    const secondClient = await pool.connect();
    try {
      await secondClient.query("BEGIN");
      const secondPass = await recoverExpiredTaskLeases(secondClient, 90);
      assert.equal(secondPass.length, 0, "A second recovery pass must be idempotent.");
      await secondClient.query("COMMIT");
    } catch (error) {
      try { await secondClient.query("ROLLBACK"); } catch { /* preserve primary failure */ }
      throw error;
    } finally {
      secondClient.release();
    }
    console.log("PASS: second recovery pass produced no duplicate recovery events.");

    console.log("RESULT: PASS — expired leases with durable side-effect start/success evidence are failed closed and never re-queued.");
  } finally {
    let eventCleanup = false;
    let taskCleanup = false;
    try {
      if (createdTaskIds.length > 0) {
        await pool.query(
          "DELETE FROM public.task_events WHERE task_id = ANY($1::uuid[])",
          [createdTaskIds],
        );
      }
      eventCleanup = true;
    } catch (error) {
      console.error(`EVENT_CLEANUP_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (createdTaskIds.length > 0) {
        await pool.query(
          "DELETE FROM public.tasks WHERE id = ANY($1::uuid[])",
          [createdTaskIds],
        );
      }
      taskCleanup = true;
    } catch (error) {
      console.error(`TASK_CLEANUP_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
    cleanupComplete = eventCleanup && taskCleanup;
    await pool.end();
    console.log(`CLEANUP_STATUS: ${cleanupComplete ? "complete" : "incomplete"}`);
  }
}

main().catch((error) => {
  console.error(`LEASE RECOVERY SIDE-EFFECT GUARD TEST FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
