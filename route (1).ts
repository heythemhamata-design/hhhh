import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRead, authorizeApiMutation } from "@/lib/security/guards";
import { getPostgresPool } from "@/lib/db/postgres";

import { AGENTS } from "@/lib/agents/registry";
import {
  getAgentRuntimeCatalog,
  runAgentTask,
} from "@/lib/agents/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const blocked = await authorizeApiRead(request);
  if (blocked) return blocked;
  return NextResponse.json(
    {
      ok: true,
      service: "monster-ai-agent-runtime",
      endpoint: "/api/agents/run",
      totalAgents: AGENTS.length,
      agents: getAgentRuntimeCatalog(),
      directExecutionMode: "no-tools-no-memory-context",
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}

export async function POST(request: NextRequest) {
  const blocked = await authorizeApiMutation(request, "agents-run", 10, 40, 60);
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

    if (
      typeof input.agentId !== "string" ||
      !AGENTS.some((agent) => agent.id === input.agentId)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "Unknown agentId.",
          availableAgents: AGENTS.map((agent) => agent.id),
        },
        { status: 400 },
      );
    }

    const agentId = input.agentId as (typeof AGENTS)[number]["id"];

    let agentEnabled: boolean | null = null;

    try {
      const agentState = await getPostgresPool().query<{ enabled: boolean }>(
        "SELECT enabled FROM agents WHERE id = $1",
        [agentId],
      );

      if (agentState.rowCount === 1) {
        agentEnabled = agentState.rows[0].enabled;
      }
    } catch (error) {
      console.error("[api/agents/run] Agent availability lookup failed.", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });

      return NextResponse.json(
        { ok: false, error: "Agent availability service unavailable." },
        { status: 503 },
      );
    }

    if (agentEnabled === null) {
      return NextResponse.json(
        { ok: false, error: "Agent is not registered in PostgreSQL." },
        { status: 404 },
      );
    }

    if (!agentEnabled) {
      return NextResponse.json(
        { ok: false, error: "Agent is disabled." },
        { status: 409 },
      );
    }

    if (
      typeof input.task !== "string" ||
      input.task.trim().length === 0 ||
      input.task.length > 12_000
    ) {
      return NextResponse.json(
        { ok: false, error: "task must contain between 1 and 12000 characters." },
        { status: 400 },
      );
    }

    if (input.enableTools !== undefined && typeof input.enableTools !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "enableTools must be a boolean." },
        { status: 400 },
      );
    }

    // This direct route has no authentication layer. It therefore cannot grant
    // tool execution. Tool-enabled work must enter through the trusted task queue.
    if (input.enableTools === true) {
      return NextResponse.json(
        {
          ok: false,
          error: "Direct agent execution cannot run tools. Submit a task through the authorized Task Queue instead.",
        },
        { status: 403 },
      );
    }

    const result = await runAgentTask({
      agentId,
      task: input.task.trim(),
      enableTools: false,
      allowedTools: [],
      includeMemoryContext: false,
      signal: request.signal,
    });

    return NextResponse.json(
      {
        ok: true,
        service: "monster-ai-agent-runtime",
        timestamp: new Date().toISOString(),
        ...result,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown runtime error.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
