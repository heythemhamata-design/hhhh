// app/api/agents/route.ts

import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRead } from "@/lib/security/guards";
import { getAgentRegistry } from "@/lib/agents/registry";
import { getPostgresPool } from "@/lib/db/postgres";
import { DEFAULT_AI_MODEL } from "@/lib/ai/models";

export const dynamic = "force-dynamic";

type AgentRow = {
  id: string;
  enabled: boolean;
  model_id: string | null;
  configured: boolean;
  connected: boolean;
};

type OperationalStatus =
  | "disabled"
  | "enabled_idle"
  | "busy"
  | "not_registered"
  | "runtime_unavailable"
  | "unknown";

export async function GET(request: NextRequest) {
  // Preserve the original authentication flow.
  const blocked = await authorizeApiRead(request);
  if (blocked) return blocked;

  const registry = getAgentRegistry();


  let dbById = new Map<string, AgentRow>();
  const busyByAgent = new Map<string, number>();
  let degraded = false;

  try {
    const pool = getPostgresPool();

    const [agentsRes, busyRes] = await Promise.all([
      pool.query<AgentRow>(
        "SELECT id, enabled, model_id, configured, connected FROM agents"
      ),
      pool.query<{ agent_id: string | null; n: number }>(
        `SELECT agent_id, COUNT(*)::int AS n
         FROM tasks
         WHERE status = 'running'
         GROUP BY agent_id`
      ),
    ]);

    for (const row of agentsRes.rows) {
      dbById.set(row.id, row);
    }

    for (const row of busyRes.rows) {
      if (row.agent_id !== null) {
        busyByAgent.set(row.agent_id, row.n);
      }
    }
  } catch (error) {
    // Do not expose database connection details or credentials.
    console.error(
      "[api/agents] PostgreSQL unavailable; returning degraded state.",
      { errorName: error instanceof Error ? error.name : "UnknownError" }
    );

    degraded = true;
    dbById = new Map();
  }

  // This checks server-side OmniRoute configuration, not external provider health.
  const modelRouteConfigured =
    !degraded && Boolean(process.env.OMNIROUTE_API_KEY?.trim());

  const agents = registry.map((agent) => {
    const db = dbById.get(agent.id) ?? null;
    const running = degraded
      ? null
      : busyByAgent.get(agent.id) ?? 0;

    let operational_status: OperationalStatus;

    if (degraded) {
      operational_status = "unknown";
    } else if (!db) {
      operational_status = "not_registered";
    } else if (!db.enabled) {
      operational_status = "disabled";
    } else if ((running ?? 0) > 0) {
      operational_status = "busy";
    } else if (!modelRouteConfigured) {
      operational_status = "runtime_unavailable";
    } else {
      operational_status = "enabled_idle";
    }

    const integrationConfigured = degraded ? null : db?.configured ?? false;
    const integrationConnected = degraded ? null : db?.connected ?? false;
    const model_configured = degraded ? null : modelRouteConfigured;

    const runtime_configured =
      !degraded && db?.enabled === true && modelRouteConfigured;

    return {
      ...agent,

      status: degraded
        ? "error" as const
        : !db || !db.enabled || !modelRouteConfigured
          ? "not_configured" as const
          : (running ?? 0) > 0
            ? "busy" as const
            : "ready" as const,

      enabled: degraded ? null : db?.enabled ?? null,

      // Runtime model selection is dynamic. The stored value is retained only
      // as legacy metadata and is not used for model selection.
      model_id: degraded ? null : DEFAULT_AI_MODEL,
      model_route: DEFAULT_AI_MODEL,
      legacy_model_id: degraded ? null : db?.model_id ?? null,

      running_tasks: running,
      operational_status,
      runtime_configured,
      model_configured,

      // Per-agent configuration/connectivity refers to external integrations.
      configured: integrationConfigured,
      connected: integrationConnected,
      integration_configured: integrationConfigured,
      integration_connected: integrationConnected,

      connectivity: degraded
        ? "unknown" as const
        : integrationConnected
          ? "connected" as const
          : "not_connected" as const,
    };
  });

  const total = agents.length;

  const configuredCount = degraded
    ? null
    : agents.filter((agent) => agent.integration_configured === true).length;

  const connectedCount = degraded
    ? null
    : agents.filter((agent) => agent.integration_connected === true).length;

  const modelConfiguredCount = degraded
    ? null
    : modelRouteConfigured
      ? total
      : 0;

  const runtimeConfiguredCount = agents.filter(
    (agent) => agent.runtime_configured === true
  ).length;

  const summary = {
    total,
    configured: configuredCount,
    modelConfigured: modelConfiguredCount,
    connected: connectedCount,
    integrationConfigured: configuredCount,
    integrationConnected: connectedCount,

    notConfigured: degraded
      ? null
      : total - (configuredCount ?? 0),

    runtimeConfigured: runtimeConfiguredCount,

    enabledIdle: agents.filter(
      (agent) => agent.operational_status === "enabled_idle"
    ).length,

    busy: agents.filter(
      (agent) => agent.operational_status === "busy"
    ).length,

    disabled: agents.filter(
      (agent) => agent.operational_status === "disabled"
    ).length,

    notRegistered: agents.filter(
      (agent) => agent.operational_status === "not_registered"
    ).length,

    unknown: agents.filter(
      (agent) => agent.operational_status === "unknown"
    ).length,
  };

  const body = {
    ok: true,
    service: "monster-ai-command-center",
    endpoint: "/api/agents",
    status: degraded || !modelRouteConfigured ? "degraded" : "operational",
    timestamp: new Date().toISOString(),
    summary,
    agents,
    degraded,
  };

  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
