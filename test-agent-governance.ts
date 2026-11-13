import assert from "node:assert/strict";
import { AGENTS } from "../lib/agents/registry";
import {
  DEFAULT_TOOLS_BY_AGENT,
  MAX_TOOLS_BY_AGENT,
  resolveAgentToolGrant,
  TOOL_REPLAY_CLASS,
} from "../lib/ai/tool-policy";
import type { ToolName } from "../lib/ai/tool-executor";

assert.equal(AGENTS.length, 18, "Expected exactly 18 registered agents.");

const mutatingTools = new Set<ToolName>([
  "memory_save",
  "workspace_write_file",
  "workspace_append_file",
  "workspace_create_directory",
]);

for (const agent of AGENTS) {
  const defaults = resolveAgentToolGrant(agent.id);

  for (const tool of defaults) {
    assert.equal(
      TOOL_REPLAY_CLASS[tool],
      "safe-replay",
      `${agent.id} has a non-read-only default tool: ${tool}`,
    );

    assert.equal(
      mutatingTools.has(tool),
      false,
      `${agent.id} has a mutating default tool: ${tool}`,
    );
  }
}

assert.deepEqual(
  resolveAgentToolGrant("chief_of_staff"),
  [],
  "Chief of Staff must have no default tools.",
);

assert.throws(
  () => resolveAgentToolGrant("chief_of_staff", ["calculate"]),
  /Tool grant rejected/,
  "Chief of Staff must reject even explicitly requested tools.",
);

assert.equal(
  resolveAgentToolGrant("memory").includes("memory_save"),
  false,
  "Memory agent must not receive memory_save by default.",
);

assert.deepEqual(
  DEFAULT_TOOLS_BY_AGENT.memory,
  resolveAgentToolGrant("memory"),
  "Memory default grant and resolved grant must match.",
);

for (const agent of AGENTS) {
  const maximum = MAX_TOOLS_BY_AGENT[agent.id];

  assert.equal(
    maximum.includes("workspace_write_file"),
    false,
    `${agent.id} must not have workspace_write_file in its maximum policy.`,
  );

  assert.equal(
    maximum.includes("workspace_append_file"),
    false,
    `${agent.id} must not have workspace_append_file in its maximum policy.`,
  );

  assert.equal(
    maximum.includes("workspace_create_directory"),
    false,
    `${agent.id} must not have workspace_create_directory in its maximum policy.`,
  );
}

console.log("PASS: 18 registered agents.");
console.log("PASS: All default grants are safe-replay/read-only.");
console.log("PASS: Chief of Staff has no tool capabilities.");
console.log("PASS: Memory default excludes memory_save.");
console.log("PASS: No agent maximum policy grants Workspace mutation.");
console.log("AGENT GOVERNANCE TEST: PASS");