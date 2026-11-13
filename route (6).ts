import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRead } from "@/lib/security/guards";
import { getTaskDetails } from "@/lib/tasks/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) {
  const blocked = await authorizeApiRead(request);
  if (blocked) return blocked;

  try {
    const { taskId } = await context.params;

    if (!UUID_RE.test(taskId)) {
      return NextResponse.json(
        { ok: false, error: "Invalid task ID." },
        { status: 400 },
      );
    }

    const task = await getTaskDetails(taskId);

    if (!task) {
      return NextResponse.json(
        { ok: false, error: "Task not found." },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { ok: true, task },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Task detail lookup failed:", error);

    return NextResponse.json(
      { ok: false, error: "Unable to load task details." },
      { status: 500 },
    );
  }
}