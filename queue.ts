import { randomUUID } from "node:crypto";
import { getPostgresPool } from "@/lib/db/postgres";
import { AGENTS, type AgentId } from "@/lib/agents/registry";
import { CURRENT_TOOL_POLICY_VERSION, resolveAgentToolGrant } from "@/lib/ai/tool-policy";
import type { ToolName } from "@/lib/ai/tool-executor";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TaskStatus =
  | "blocked"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type EnqueueTaskInput = {
  agentId: AgentId;
  input: string;
  enableTools?: boolean;
  /** Optional task-level tool grant. It can only narrow the agent's server policy. */
  allowedTools?: ToolName[];
  priority?: number;
  maxAttempts?: number;
  dependencies?: string[];
  conversationId?: string | null;
  correlationId?: string;
};

export type EnqueuedTask = {
  id: string;
  status: TaskStatus;
  agent_id: string;
  priority: number;
  max_attempts: number;
  dependencies: string[];
  correlation_id: string;
  created_at: string;
};

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID.`);
  }
}

export async function enqueueTask(input: EnqueueTaskInput): Promise<EnqueuedTask> {
  const agent = AGENTS.find((item) => item.id === input.agentId);
  if (!agent) throw new Error("Unknown agentId.");

  const taskText = input.input.trim();
  if (!taskText || taskText.length > 12_000) {
    throw new Error("Task input must contain between 1 and 12000 characters.");
  }

  const priority = input.priority ?? 100;
  if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
    throw new Error("Priority must be an integer between -1000 and 1000; lower numbers run first.");
  }

  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("maxAttempts must be an integer between 1 and 10.");
  }

  if (input.conversationId) assertUuid(input.conversationId, "conversationId");

  // Resolve before opening the transaction. A disabled-tools task stores no
  // capabilities at all; a non-empty grant while tools are disabled is rejected.
  // When enabled, explicit grants can only narrow the server-owned agent ceiling.
  let allowedTools: ToolName[];
  if (input.enableTools === true) {
    allowedTools = resolveAgentToolGrant(input.agentId, input.allowedTools);
  } else {
    if (input.allowedTools !== undefined) {
      if (!Array.isArray(input.allowedTools) || input.allowedTools.length > 0) {
        throw new Error("allowedTools must be omitted or empty when enableTools is false.");
      }
    }
    allowedTools = [];
  }

  const dependencies = [...new Set(input.dependencies ?? [])];
  if (dependencies.length > 20) {
    throw new Error("A task can depend on at most 20 existing tasks in V1.");
  }
  for (const dependencyId of dependencies) assertUuid(dependencyId, "dependencyId");

  const correlationId = input.correlationId?.trim() || randomUUID();
  if (correlationId.length > 128) throw new Error("correlationId is too long.");

  const pool = getPostgresPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const agentResult = await client.query<{ id: string; enabled: boolean }>(
      "SELECT id, enabled FROM agents WHERE id = $1 FOR SHARE",
      [input.agentId],
    );

    if (agentResult.rowCount !== 1 || !agentResult.rows[0].enabled) {
      throw new Error(`Agent ${input.agentId} is not registered or is disabled in PostgreSQL.`);
    }

    let dependencyRows: Array<{ id: string; status: TaskStatus }> = [];

    if (dependencies.length > 0) {
      const dependencyResult = await client.query<{ id: string; status: TaskStatus }>(
        "SELECT id, status FROM tasks WHERE id = ANY($1::uuid[]) FOR SHARE",
        [dependencies],
      );

      dependencyRows = dependencyResult.rows;
      const found = new Set(dependencyRows.map((row) => row.id));
      const missing = dependencies.filter((id) => !found.has(id));

      if (missing.length > 0) {
        throw new Error(`Unknown dependency task IDs: ${missing.join(", ")}`);
      }

      const terminalFailures = dependencyRows.filter(
        (row) => row.status === "failed" || row.status === "cancelled",
      );

      if (terminalFailures.length > 0) {
        throw new Error("A new task cannot depend on a failed or cancelled task.");
      }
    }

    const initialStatus: TaskStatus = dependencyRows.some(
      (row) => row.status !== "completed",
    )
      ? "blocked"
      : "queued";

    const metadata = {
      enableTools: input.enableTools === true,
      allowedTools,
      toolPolicyVersion: CURRENT_TOOL_POLICY_VERSION,
      source: "task-cli-v1",
      correlationId,
    };

    const insert = await client.query<{
      id: string;
      status: TaskStatus;
      agent_id: string;
      priority: number;
      max_attempts: number;
      created_at: Date | string;
    }>(
      `INSERT INTO tasks
        (agent_id, task_type, input, status, priority, max_attempts,
         conversation_id, metadata, available_at)
       VALUES ($1, 'agent_task', $2, $3, $4, $5, $6, $7::jsonb, now())
       RETURNING id, status, agent_id, priority, max_attempts, created_at`,
      [
        input.agentId,
        taskText,
        initialStatus,
        priority,
        maxAttempts,
        input.conversationId ?? null,
        JSON.stringify(metadata),
      ],
    );

    const task = insert.rows[0];

    for (const dependencyId of dependencies) {
      await client.query(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [task.id, dependencyId],
      );
    }

    await client.query(
      `INSERT INTO task_events
        (task_id, correlation_id, agent_id, event_type, severity, success, details)
       VALUES ($1, $2, $3, $4, 'info', true, $5::jsonb)`,
      [
        task.id,
        correlationId,
        input.agentId,
        initialStatus === "blocked" ? "task.blocked" : "task.queued",
        JSON.stringify({
          priority,
          maxAttempts,
          dependencyCount: dependencies.length,
          enableTools: input.enableTools === true,
          allowedTools,
          toolPolicyVersion: CURRENT_TOOL_POLICY_VERSION,
        }),
      ],
    );

    await client.query("COMMIT");

    return {
      ...task,
      created_at: task.created_at instanceof Date
        ? task.created_at.toISOString()
        : new Date(task.created_at).toISOString(),
      dependencies,
      correlation_id: correlationId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listRecentTasks(limit = 30) {
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 30;
  const result = await getPostgresPool().query(
    `SELECT id, agent_id, task_type, status, priority, attempt_count,
            max_attempts, error, result, run_id, available_at, started_at,
            completed_at, created_at, updated_at
     FROM tasks
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit],
  );
  return result.rows;
}

export async function getTaskDetails(taskId: string) {
  assertUuid(taskId, "taskId");
  const pool = getPostgresPool();
  const task = await pool.query(
    `SELECT id, conversation_id, parent_task_id, agent_id, task_type, input,
            status, priority, attempt_count, max_attempts, result, error,
            metadata, run_id, locked_by, locked_at, heartbeat_at, available_at,
            started_at, completed_at, created_at, updated_at
     FROM tasks WHERE id = $1`,
    [taskId],
  );

  if (task.rowCount === 0) return null;

  const [dependencies, events] = await Promise.all([
    pool.query(
      `SELECT d.depends_on_task_id AS id, t.status
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = $1
       ORDER BY d.created_at`,
      [taskId],
    ),
    pool.query(
      `SELECT id, run_id, correlation_id, agent_id, event_type, severity,
              tool_name, success, details, created_at
       FROM task_events WHERE task_id = $1
       ORDER BY created_at ASC, id ASC LIMIT 200`,
      [taskId],
    ),
  ]);

  return {
    ...task.rows[0],
    dependencies: dependencies.rows,
    events: events.rows,
  };
}

export async function cancelPendingTask(taskId: string) {
  assertUuid(taskId, "taskId");
  const client = await getPostgresPool().connect();

  try {
    await client.query("BEGIN");

    const changed = await client.query<{
      id: string;
      agent_id: string | null;
      run_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `UPDATE tasks
       SET status = 'cancelled', completed_at = now(), updated_at = now(),
           locked_by = NULL, locked_at = NULL, heartbeat_at = NULL
       WHERE id = $1 AND status IN ('queued', 'blocked')
       RETURNING id, agent_id, run_id, metadata`,
      [taskId],
    );

    if (changed.rowCount === 1) {
      const row = changed.rows[0];
      const correlationId = typeof row.metadata?.correlationId === "string"
        ? row.metadata.correlationId
        : null;

      await client.query(
        `INSERT INTO task_events
          (task_id, run_id, correlation_id, agent_id, event_type,
           severity, success, details)
         VALUES ($1, $2, $3, $4, 'task.cancelled', 'warning', true, '{}'::jsonb)`,
        [row.id, row.run_id, correlationId, row.agent_id],
      );
    }

    await client.query("COMMIT");
    return changed.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
