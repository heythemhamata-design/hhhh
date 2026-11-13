import assert from "node:assert/strict";
import fs from "node:fs";
import { loadEnvConfig } from "@next/env";
import { CURRENT_TOOL_POLICY_VERSION, resolveAgentToolGrant, resolvePersistedAgentToolGrant, TOOL_REPLAY_CLASS } from "../lib/ai/tool-policy";
import { validateOrchestrationPlan, persistOrchestrationPlan } from "../lib/tasks/orchestrator";
import { getPostgresPool } from "../lib/db/postgres";
import { runAgentTask } from "../lib/agents/runtime";

loadEnvConfig(process.cwd());

function makePlan(agentId: "researcher" | "memory", enableTools: boolean) {
  return {
    summary: "F2 isolated policy persistence test",
    tasks: [{
      key: "step_1",
      agentId,
      title: "F2 isolated test task",
      task: "Verify the persisted task-level tool grant.",
      dependsOn: [],
      priority: 100,
      enableTools,
    }],
    topologicalOrder: ["step_1"],
  } as any;
}

async function persistWithMockPool(agentId: "researcher" | "memory", enableTools: boolean) {
  const pool = getPostgresPool();
  const ownDescriptor = Object.getOwnPropertyDescriptor(pool, "connect");
  const childMetadataRows: Record<string, unknown>[] = [];
  const fakeClient = {
    async query(sqlValue: unknown, values?: unknown[]) {
      const sql = String(sqlValue).replace(/\s+/g, " ").trim();
      if (sql.startsWith("SELECT id, enabled FROM agents")) {
        const ids = Array.isArray(values?.[0]) ? values[0] as string[] : [];
        return { rows: ids.map((id) => ({ id, enabled: true })), rowCount: ids.length };
      }
      if (sql.startsWith("INSERT INTO tasks")) {
        if (sql.includes("'orchestration_plan'")) {
          return { rows: [{ id: "10000000-0000-4000-8000-000000000001" }], rowCount: 1 };
        }
        if (sql.includes("VALUES ($1, $2, 'agent_task'")) {
          childMetadataRows.push(JSON.parse(String(values?.[6])) as Record<string, unknown>);
          return { rows: [{ id: "10000000-0000-4000-8000-000000000002" }], rowCount: 1 };
        }
        if (sql.includes("VALUES ($1, 'chief_of_staff', 'agent_task'")) {
          return { rows: [{ id: "10000000-0000-4000-8000-000000000003" }], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  Object.defineProperty(pool, "connect", {
    configurable: true,
    writable: true,
    value: async () => fakeClient,
  });

  try {
    await persistOrchestrationPlan({
      goal: "F2 isolated persistence test",
      plan: makePlan(agentId, enableTools),
      maxAttempts: 2,
    });
    if (childMetadataRows.length !== 1) throw new Error(`Expected exactly one child metadata row for ${agentId}; got ${childMetadataRows.length}.`);
    return childMetadataRows[0];
  } finally {
    if (ownDescriptor) Object.defineProperty(pool, "connect", ownDescriptor);
    else Reflect.deleteProperty(pool, "connect");
  }
}

function responseWithText(content: string) {
  return {
    id: "f2-mock-completion",
    object: "chat.completion",
    created: 1,
    model: "f2-mock-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  };
}

function responseWithWebSearchCall() {
  return {
    id: "f2-mock-tool-call",
    object: "chat.completion",
    created: 1,
    model: "f2-mock-model",
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "f2-call-web-search",
          type: "function",
          function: { name: "web_search", arguments: JSON.stringify({ query: "F2 mock query" }) },
        }],
      },
    }],
  };
}

async function runRuntimeWithMock(response: unknown) {
  const requests: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, any>);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
}

async function main() {
  console.log("========== MONSTER F2 RESEARCHER WEB SEARCH TEST ==========");

  // A. Policy contract: v2 enables web_search; explicit empty grants stay empty; v1 remains restricted.
  assert.equal(CURRENT_TOOL_POLICY_VERSION, 2);
  const researcherDefaults = resolveAgentToolGrant("researcher");
  assert.ok(researcherDefaults.includes("web_search"));
  assert.equal(researcherDefaults.includes("run_powershell"), false, "Researcher must not receive Windows action capability.");
  assert.deepEqual(resolveAgentToolGrant("researcher", []), []);
  assert.ok(resolvePersistedAgentToolGrant("researcher", researcherDefaults, 2).includes("web_search"));
  const legacyResearcher = resolvePersistedAgentToolGrant("researcher", ["calculate", "get_current_datetime"], 1);
  assert.equal(legacyResearcher.includes("web_search"), false);
  assert.throws(
    () => resolvePersistedAgentToolGrant("researcher", researcherDefaults, 1),
    /outside the maximum policy/,
  );
  console.log("POLICY_V2_RESEARCHER_WEB_SEARCH=PASS");
  console.log("POLICY_EMPTY_GRANT=PASS");
  console.log("POLICY_V1_LEGACY_RESTRICTED=PASS");

  // B. Plan validation: tool-enabled Researcher tasks require plan-level permission.
  const enabledRaw = JSON.stringify({
    summary: "Research current facts",
    tasks: [{ key: "step_1", agentId: "researcher", title: "Research", task: "Find current facts from web sources.", dependsOn: [], priority: 100, enableTools: true }],
  });
  assert.throws(() => validateOrchestrationPlan(enabledRaw, false), /allow-tools true was not supplied/);
  const allowedPlan = validateOrchestrationPlan(enabledRaw, true);
  assert.equal(allowedPlan.tasks[0].enableTools, true);
  const disabledRaw = JSON.stringify({
    summary: "Research without external tools",
    tasks: [{ key: "step_1", agentId: "researcher", title: "Research", task: "Prepare a background summary only.", dependsOn: [], priority: 100, enableTools: false }],
  });
  assert.equal(validateOrchestrationPlan(disabledRaw, false).tasks[0].enableTools, false);
  console.log("PLAN_ALLOW_TOOLS_GUARD=PASS");

  // C. Persist with a fake pg PoolClient. No database connection or SQL write is performed.
  const researcherDisabled = await persistWithMockPool("researcher", false);
  assert.equal(researcherDisabled.enableTools, false);
  assert.deepEqual(researcherDisabled.allowedTools, []);
  assert.equal(researcherDisabled.toolPolicyVersion, 2);
  const researcherEnabled = await persistWithMockPool("researcher", true);
  assert.equal(researcherEnabled.enableTools, true);
  assert.ok((researcherEnabled.allowedTools as string[]).includes("web_search"));
  assert.equal(researcherEnabled.toolPolicyVersion, 2);
  console.log("PERSIST_RESEARCHER_TOOLS_DISABLED=PASS");
  console.log("PERSIST_RESEARCHER_WEB_SEARCH_GRANTED=PASS");

  // G1 characterization only: document the currently configured Memory grant. This is NOT a security assertion.
  const memoryDefaults = resolveAgentToolGrant("memory");
  assert.ok(memoryDefaults.includes("memory_save"));
  assert.equal(TOOL_REPLAY_CLASS.memory_save, "strict");
  const memoryEnabled = await persistWithMockPool("memory", true);
  assert.ok((memoryEnabled.allowedTools as string[]).includes("memory_save"));
  console.log("KNOWN_G1_BASELINE_MEMORY_SAVE=OBSERVED (unchanged by F2)");

  // D. Runtime tests. Mock global fetch and disable Memory retrieval to guarantee no DB/network side effects.
  const originalFetch = globalThis.fetch;
  const envNames = ["OMNIROUTE_API_KEY", "OMNIROUTE_BASE_URL", "MONSTER_OMNIROUTE_TIMEOUT_MS"];
  const oldEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.OMNIROUTE_API_KEY = "f2-local-mock-key-not-a-real-credential";
  process.env.OMNIROUTE_BASE_URL = "http://127.0.0.1:20128/v1";
  process.env.MONSTER_OMNIROUTE_TIMEOUT_MS = "10000";

  try {
    const disabledRequests = await runRuntimeWithMock(responseWithText("mock final answer"));
    const disabledResult = await runAgentTask({
      agentId: "researcher",
      task: "Prepare a short background summary.",
      enableTools: false,
      includeMemoryContext: false,
    });
    assert.equal(disabledRequests.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(disabledRequests[0], "tools"), false);
    const disabledSystem = disabledRequests[0].messages.find((message: any) => message.role === "system")?.content;
    assert.match(String(disabledSystem), /only tools granted to you for this task are: none/i);
    assert.equal(disabledResult.toolsEnabled, false);
    console.log("RUNTIME_DISABLED_OMITS_TOOLS_AND_PROMPT_SAYS_NONE=PASS");

    await runRuntimeWithMock(responseWithWebSearchCall());
    await assert.rejects(
      () => runAgentTask({
        agentId: "researcher",
        task: "Try an ungranted search.",
        enableTools: false,
        includeMemoryContext: false,
      }),
      /although this task has no granted tools: web_search/,
    );
    console.log("RUNTIME_DISABLED_REJECTS_UNREQUESTED_TOOL_CALL=PASS");

    const enabledRequests = await runRuntimeWithMock(responseWithText("mock answer with search capability available"));
    const enabledResult = await runAgentTask({
      agentId: "researcher",
      task: "Research the requested current facts.",
      enableTools: true,
      allowedTools: ["web_search"],
      includeMemoryContext: false,
    });
    assert.equal(enabledRequests.length, 1);
    assert.ok(enabledRequests[0].tools?.some((tool: any) => tool.function?.name === "web_search"));
    const enabledSystem = enabledRequests[0].messages.find((message: any) => message.role === "system")?.content;
    assert.match(String(enabledSystem), /web_search/);
    assert.equal(enabledResult.toolsEnabled, true);
    console.log("RUNTIME_ENABLED_EXPOSES_WEB_SEARCH=PASS");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of oldEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  // E. Planner prompt source contracts. The CLI already contains its Memory safety instruction; no duplicate is added.
  const apiPromptSource = fs.readFileSync("app/api/orchestrator/route.ts", "utf8");
  const cliPromptSource = fs.readFileSync("scripts/orchestrator-plan.ts", "utf8");
  const obsoletePattern = /no\s+web\/browser\s+search\s+capability\s+in\s+this\s+orchestrator/i;
  assert.equal(obsoletePattern.test(apiPromptSource), false);
  assert.equal(obsoletePattern.test(cliPromptSource), false);
  for (const [label, source] of [["API", apiPromptSource], ["CLI", cliPromptSource]] as const) {
    assert.match(source, /read-only web_search tool available only when plan-level tools are explicitly enabled/i, `${label} prompt lacks the Researcher capability instruction.`);
    assert.match(source, /For tasks requiring current facts or external research, set enableTools=true only on a Researcher task when plan-level permission is enabled; otherwise keep it false/i, `${label} prompt lacks the conditional Researcher tool activation instruction.`);
    assert.match(source, /successful web_search result confirms it/i, `${label} prompt lacks the external-verification safety clause.`);
  }
  assert.match(apiPromptSource, /Never alter memory unless explicitly requested/i);
  assert.match(cliPromptSource, /do not save, delete, or modify memories unless the user explicitly requests a memory change/i);
  console.log("PLANNER_API_AND_CLI_PROMPT_CONTRACTS=PASS");
  console.log("API_AND_CLI_MEMORY_SAFETY_PROMPTS_PRESERVED=PASS");

  console.log("F2_RESEARCHER_WEB_SEARCH_TEST=PASS");
  console.log("NOTE: test-agent-governance.ts is intentionally excluded; its pre-existing G1 baseline failure is tracked separately.");
}

main().catch((error) => {
  console.error("F2_RESEARCHER_WEB_SEARCH_TEST=FAIL");
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});