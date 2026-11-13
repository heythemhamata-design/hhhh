import { loadEnvConfig } from "@next/env";
import { getPostgresPool } from "../lib/db/postgres";

loadEnvConfig(process.cwd());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const planId = process.argv[2];
  if (!planId || !UUID_RE.test(planId)) {
    throw new Error("Usage: npm run orchestrator:status -- <plan-uuid>");
  }

  const pool = getPostgresPool();
  const planResult = await pool.query(
    `SELECT id, task_type, status, input, result, metadata, run_id, created_at, completed_at
     FROM tasks
     WHERE id = $1 AND task_type = 'orchestration_plan'`,
    [planId],
  );
  if (planResult.rowCount !== 1) throw new Error("Orchestration plan not found.");

  const [children, events] = await Promise.all([
    pool.query(
      `SELECT id, agent_id, input, status, priority, attempt_count, max_attempts,
              result, error, metadata, run_id, locked_by, locked_at,
              heartbeat_at, available_at, started_at, completed_at, created_at
       FROM tasks WHERE parent_task_id = $1 ORDER BY created_at, id`,
      [planId],
    ),
    pool.query(
      `SELECT id, task_id, run_id, correlation_id, agent_id, event_type,
              severity, tool_name, success, details, created_at
       FROM task_events
       WHERE task_id = $1 OR task_id IN (SELECT id FROM tasks WHERE parent_task_id = $1)
       ORDER BY created_at, id LIMIT 500`,
      [planId],
    ),
  ]);

  const childIds = children.rows.map((row) => row.id);
  const dependencies = childIds.length
    ? await pool.query(
        `SELECT task_id, depends_on_task_id
         FROM task_dependencies WHERE task_id = ANY($1::uuid[])
         ORDER BY task_id, depends_on_task_id`,
        [childIds],
      )
    : { rows: [] as Array<{ task_id: string; depends_on_task_id: string }> };

  console.log(JSON.stringify({
    plan: planResult.rows[0],
    tasks: children.rows,
    dependencies: dependencies.rows,
    events: events.rows,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(`ORCHESTRATOR STATUS FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await getPostgresPool().end(); } catch { /* preserve primary result */ }
  });
