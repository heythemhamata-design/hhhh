import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRead } from "@/lib/security/guards";
import { getPostgresPool } from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ planId: string }> },
) {
  const blocked = await authorizeApiRead(request);
  if (blocked) return blocked;

  try {
    const { planId } = await context.params;

    if (!UUID_RE.test(planId)) {
      return NextResponse.json(
        { ok: false, error: "Invalid plan ID." },
        { status: 400 },
      );
    }

    const pool = getPostgresPool();

    const planResult = await pool.query(
      `SELECT id, task_type, status, input, result, metadata,
              run_id, created_at, completed_at
       FROM tasks
       WHERE id = $1 AND task_type = 'orchestration_plan'`,
      [planId],
    );

    if (planResult.rowCount !== 1) {
      return NextResponse.json(
        { ok: false, error: "Orchestration plan not found." },
        { status: 404 },
      );
    }

    const [children, events] = await Promise.all([
      pool.query(
        `SELECT id, agent_id, task_type, input, status, priority,
                attempt_count, max_attempts, result, error, metadata,
                run_id, locked_by, locked_at, heartbeat_at,
                available_at, started_at, completed_at, created_at
         FROM tasks
         WHERE parent_task_id = $1
         ORDER BY created_at, id`,
        [planId],
      ),
      pool.query(
        `SELECT id, task_id, run_id, correlation_id, agent_id,
                event_type, severity, tool_name, success, details, created_at
         FROM task_events
         WHERE task_id = $1
            OR task_id IN (
              SELECT id FROM tasks WHERE parent_task_id = $1
            )
         ORDER BY created_at, id
         LIMIT 500`,
        [planId],
      ),
    ]);

    const childIds = children.rows.map((row) => row.id);

    const dependencies = childIds.length
      ? await pool.query(
          `SELECT task_id, depends_on_task_id
           FROM task_dependencies
           WHERE task_id = ANY($1::uuid[])
           ORDER BY task_id, depends_on_task_id`,
          [childIds],
        )
      : { rows: [] as Array<{
          task_id: string;
          depends_on_task_id: string;
        }> };

    const isFinalizer = (row: (typeof children.rows)[number]) => {
      const metadata = row.metadata && typeof row.metadata === "object"
        ? row.metadata as Record<string, unknown>
        : {};
      return metadata.orchestrationRole === "finalizer";
    };
    const specialistTasks = children.rows.filter((row) => !isFinalizer(row));
    const finalizerTask = children.rows.find((row) => isFinalizer(row)) ?? null;
    const specialistStatuses = specialistTasks.map((row) => row.status);
    const specialistActive = specialistStatuses.some((status) =>
      ["queued", "blocked", "running"].includes(status),
    );
    const specialistFailed = specialistStatuses.filter((status) =>
      ["failed", "cancelled"].includes(status),
    ).length;
    const specialistCompleted = specialistStatuses.filter((status) => status === "completed").length;
    const finalizerActive = Boolean(finalizerTask &&
      ["queued", "blocked", "running"].includes(finalizerTask.status));

    let executionStatus = "completed";
    if (finalizerTask && ["failed", "cancelled"].includes(finalizerTask.status)) {
      executionStatus = "failed";
    } else if (specialistTasks.length === 0) {
      executionStatus = "empty";
    } else if (specialistActive || finalizerActive) {
      executionStatus = "running";
    } else if (finalizerTask) {
      if (finalizerTask.status !== "completed") {
        executionStatus = "failed";
      } else if (specialistFailed > 0 && specialistCompleted > 0) {
        executionStatus = "partial_failure";
      } else if (specialistFailed > 0 || specialistCompleted === 0) {
        executionStatus = "failed";
      } else {
        executionStatus = "completed";
      }
    } else if (specialistFailed > 0 && specialistCompleted > 0) {
      // Backward compatibility for plans created before the finalizer existed.
      executionStatus = "partial_failure";
    } else if (specialistFailed > 0) {
      executionStatus = "failed";
    } else if (specialistActive) {
      executionStatus = "running";
    }
    const parent = planResult.rows[0];
    const storedResult =
      parent.result && typeof parent.result === "object"
        ? parent.result as Record<string, unknown>
        : {};

    return NextResponse.json(
      {
        ok: true,
        executionStatus,
        plan: {
          ...parent,
          summary:
            typeof storedResult.summary === "string"
              ? storedResult.summary
              : "",
          taskCount:
            typeof storedResult.taskCount === "number"
              ? storedResult.taskCount
              : specialistTasks.length,
          finalizerTaskId:
            typeof storedResult.finalizerTaskId === "string"
              ? storedResult.finalizerTaskId
              : finalizerTask?.id ?? null,
          finalizerStatus: finalizerTask?.status ?? null,
          finalReport:
            typeof storedResult.finalReport === "string"
              ? storedResult.finalReport
              : null,
          finalReportTruncated: storedResult.finalReportTruncated === true,
          finalizationError:
            typeof storedResult.finalizationError === "string"
              ? storedResult.finalizationError
              : finalizerTask && ["failed", "cancelled"].includes(finalizerTask.status)
                ? (typeof finalizerTask.error === "string" && finalizerTask.error
                    ? finalizerTask.error
                    : `Finalizer ${finalizerTask.status} without a stored failure message.`)
                : null,
        },
        tasks: children.rows,
        dependencies: dependencies.rows,
        events: events.rows,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Orchestration status lookup failed:", error);

    return NextResponse.json(
      { ok: false, error: "Unable to load orchestration status." },
      { status: 500 },
    );
  }
}