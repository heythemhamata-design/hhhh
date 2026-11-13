import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRead, authorizeApiMutation } from "@/lib/security/guards";
import { AGENTS } from "@/lib/agents/registry";
import { enqueueTask, listRecentTasks } from "@/lib/tasks/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const blocked = await authorizeApiRead(request);
  if (blocked) return blocked;

  try {
    const requested = Number(request.nextUrl.searchParams.get("limit") || 30);
    const limit = Number.isInteger(requested)
      ? Math.max(1, Math.min(requested, 100))
      : 30;

    const tasks = await listRecentTasks(limit);

    return NextResponse.json(
      { ok: true, tasks },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Task listing failed:", error);
    return NextResponse.json(
      { ok: false, error: "Unable to load tasks." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const blocked = await authorizeApiMutation(
    request,
    "tasks-create",
    10,
    40,
    60,
  );
  if (blocked) return blocked;

  try {
    const body: unknown = await request.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { ok: false, error: "Request body must be an object." },
        { status: 400 },
      );
    }

    const input = body as Record<string, unknown>;

    const agent = typeof input.agentId === "string"
      ? AGENTS.find((item) => item.id === input.agentId)
      : undefined;

    if (!agent) {
      return NextResponse.json(
        { ok: false, error: "Unknown agentId." },
        { status: 400 },
      );
    }

    if (
      typeof input.task !== "string" ||
      input.task.trim().length === 0 ||
      input.task.length > 12_000
    ) {
      return NextResponse.json(
        { ok: false, error: "Task must contain between 1 and 12000 characters." },
        { status: 400 },
      );
    }

    if (
      input.enableTools !== undefined &&
      typeof input.enableTools !== "boolean"
    ) {
      return NextResponse.json(
        { ok: false, error: "enableTools must be a boolean." },
        { status: 400 },
      );
    }

    // Tool capabilities are resolved only by the server-side policy.
    // The client cannot submit or expand an allowedTools list.
    const task = await enqueueTask({
      agentId: agent.id,
      input: input.task.trim(),
      enableTools: input.enableTools === true,
      priority: 100,
      maxAttempts: 3,
    });

    return NextResponse.json(
      { ok: true, task },
      {
        status: 201,
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    const isInputError =
      /Task input|Priority|maxAttempts|not registered|disabled|allowedTools|dependency/i.test(message);

    if (isInputError) {
      return NextResponse.json(
        { ok: false, error: message },
        { status: 400 },
      );
    }

    console.error("Task enqueue failed:", error);

    return NextResponse.json(
      { ok: false, error: "Unable to enqueue task. Check the server logs." },
      { status: 500 },
    );
  }
}