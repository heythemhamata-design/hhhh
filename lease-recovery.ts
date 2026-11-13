import type { PoolClient } from "pg";
import { TOOL_REPLAY_CLASS } from "../ai/tool-policy";

export type RecoveredExpiredTask = {
  id: string;
  agent_id: string | null;
  run_id: string | null;
  status: "queued" | "failed";
  attempt_count: number;
  metadata: Record<string, unknown>;
  side_effect_blocked: boolean;
  side_effect_tools: string[];
};

const SIDE_EFFECT_TOOL_NAMES = Object.entries(TOOL_REPLAY_CLASS)
  .filter(([, replayClass]) => replayClass !== "safe-replay")
  .map(([toolName]) => toolName);

/**
 * Recover stale running tasks inside the caller's transaction.
 * A durable start OR success marker for a non-safe-replay tool in the current
 * task (across every attempt/run) makes the outcome unsafe to replay. Such a task is failed for manual
 * reconciliation instead of being returned to the queue.
 */
export async function recoverExpiredTaskLeases(
  client: PoolClient,
  staleSeconds: number,
): Promise<RecoveredExpiredTask[]> {
  if (!Number.isInteger(staleSeconds) || staleSeconds < 1) {
    throw new Error("staleSeconds must be a positive integer.");
  }

  const result = await client.query<RecoveredExpiredTask>(
    `WITH expired AS MATERIALIZED (
       SELECT
         t.id,
         EXISTS (
           SELECT 1
           FROM public.task_events e
           WHERE e.task_id = t.id
             AND e.tool_name = ANY($2::text[])
             AND e.event_type IN ('tool.execution_started', 'tool.execution_succeeded')
         ) AS side_effect_blocked,
         ARRAY(
           SELECT DISTINCT e.tool_name
           FROM public.task_events e
           WHERE e.task_id = t.id
             AND e.tool_name = ANY($2::text[])
             AND e.event_type IN ('tool.execution_started', 'tool.execution_succeeded')
           ORDER BY e.tool_name
         ) AS side_effect_tools
       FROM public.tasks t
       WHERE t.status = 'running'
         AND COALESCE(t.heartbeat_at, t.locked_at, t.started_at, t.updated_at)
             < clock_timestamp() - ($1::int * interval '1 second')
       FOR UPDATE OF t SKIP LOCKED
     ), updated AS (
       UPDATE public.tasks t
       SET status = CASE
             WHEN expired.side_effect_blocked OR t.attempt_count >= t.max_attempts THEN 'failed'
             ELSE 'queued'
           END,
           available_at = CASE
             WHEN expired.side_effect_blocked OR t.attempt_count >= t.max_attempts THEN t.available_at
             ELSE clock_timestamp() + interval '5 seconds'
           END,
           error = left(
             concat_ws(E'\\n', NULLIF(t.error, ''),
               CASE
                 WHEN expired.side_effect_blocked THEN
                   'Worker lease expired after a side-effecting tool started or succeeded; automatic replay was suppressed. Manual reconciliation is required.'
                 ELSE
                   'Worker lease expired; task recovered by the queue supervisor.'
               END),
             4000
           ),
           completed_at = CASE
             WHEN expired.side_effect_blocked OR t.attempt_count >= t.max_attempts THEN clock_timestamp()
             ELSE NULL
           END,
           locked_by = NULL,
           locked_at = NULL,
           heartbeat_at = NULL,
           updated_at = clock_timestamp()
       FROM expired
       WHERE t.id = expired.id
       RETURNING t.id, t.agent_id, t.run_id, t.status, t.attempt_count, t.metadata
     )
     SELECT updated.*, expired.side_effect_blocked, expired.side_effect_tools
     FROM updated
     JOIN expired ON expired.id = updated.id
     ORDER BY updated.id`,
    [staleSeconds, SIDE_EFFECT_TOOL_NAMES],
  );

  for (const task of result.rows) {
    const correlationId = typeof task.metadata?.correlationId === "string"
      ? task.metadata.correlationId
      : null;

    await client.query(
      `INSERT INTO public.task_events
        (task_id, run_id, correlation_id, agent_id,
         event_type, severity, success, details)
       VALUES ($1,$2,$3,$4,'task.lease_expired','warning',false,$5::jsonb)`,
      [
        task.id,
        task.run_id,
        correlationId,
        task.agent_id,
        JSON.stringify({
          status: task.status,
          attemptCount: task.attempt_count,
          sideEffectBlocked: task.side_effect_blocked,
          sideEffectTools: task.side_effect_tools,
          recoveryAction: task.side_effect_blocked
            ? "suppressed_for_manual_reconciliation"
            : task.status === "queued"
              ? "requeued"
              : "attempts_exhausted",
        }),
      ],
    );
  }

  return result.rows;
}