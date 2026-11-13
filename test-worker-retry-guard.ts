import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { hasUnsafeToolOutcome } from "../lib/ai/tool-policy";
import { shouldRetryTask, type TaskRetryDecisionInput } from "../lib/tasks/retry-policy";

function decide(
  overrides: Partial<Omit<TaskRetryDecisionInput, "hasUnsafeSideEffect">> & {
    toolLog?: Array<{ tool: string; status?: string; ok?: boolean }>;
    hasUnsafeSideEffect?: boolean;
  } = {},
): boolean {
  const toolLog = overrides.toolLog ?? [];
  const hasUnsafeSideEffect = overrides.hasUnsafeSideEffect ?? hasUnsafeToolOutcome(toolLog);
  return shouldRetryTask({
    hasUnsafeSideEffect,
    isTaskPolicyError: overrides.isTaskPolicyError ?? false,
    isAgentProtocolError: overrides.isAgentProtocolError ?? false,
    isFinalizer: overrides.isFinalizer ?? false,
    retryClass: overrides.retryClass ?? "retryable",
    attemptCount: overrides.attemptCount ?? 1,
    maxAttempts: overrides.maxAttempts ?? 3,
  });
}

async function main(): Promise<void> {
  assert.equal(
    decide({ toolLog: [{ tool: "memory_save", ok: true, status: "succeeded" }] }),
    false,
    "confirmed memory side effect must suppress retry",
  );
  console.log("PASS: succeeded side-effect outcome suppresses automatic retry.");

  assert.equal(
    decide({ toolLog: [{ tool: "workspace_append_file", ok: false, status: "outcome_unknown" }] }),
    false,
    "unknown workspace side effect must suppress retry",
  );
  console.log("PASS: outcome_unknown side-effect outcome suppresses automatic retry.");

  assert.equal(
    decide({ toolLog: [{ tool: "workspace_write_file", ok: false, status: "failed" }] }),
    true,
    "known pre-effect failure may retry for retryable provider failure",
  );
  console.log("PASS: known failed side-effect attempt remains retryable for a retryable upstream error.");

  assert.equal(
    decide({ toolLog: [{ tool: "workspace_write_file", ok: false, status: "denied" }] }),
    true,
    "denied operation is not a confirmed or unknown side effect",
  );
  console.log("PASS: denied tool result is not misclassified as a completed side effect.");

  assert.equal(
    decide({ toolLog: [{ tool: "memory_search", ok: true, status: "succeeded" }] }),
    true,
    "safe replay tool must not suppress retry",
  );
  console.log("PASS: safe-replay tool success does not suppress task retry.");

  assert.equal(decide({ retryClass: "cooldown" }), true);
  assert.equal(decide({ retryClass: "terminal" }), false);
  console.log("PASS: cooldown remains schedulable; terminal errors do not retry.");

  assert.equal(decide({ attemptCount: 3, maxAttempts: 3 }), false);
  assert.equal(decide({ isTaskPolicyError: true }), false);
  assert.equal(decide({ isAgentProtocolError: true, isFinalizer: false }), false);
  assert.equal(decide({ isAgentProtocolError: true, isFinalizer: true }), true);
  console.log("PASS: attempt limits, policy failures and finalizer protocol exception match Worker rules.");

  const workerSource = await readFile(path.resolve(process.cwd(), "scripts/task-worker.ts"), "utf8");
  assert.match(workerSource, /const shouldRetry = shouldRetryTask\(\{/);
  assert.match(workerSource, /hasUnsafeSideEffect,/);
  assert.match(workerSource, /isTaskPolicyError: originalError instanceof TaskPolicyError/);
  assert.match(workerSource, /isAgentProtocolError: originalError instanceof AgentProtocolError/);
  assert.match(workerSource, /attemptCount: task\.attempt_count/);
  assert.match(workerSource, /maxAttempts: task\.max_attempts/);
  console.log("PASS: live Worker retry path calls the same tested shouldRetryTask function.");

  console.log("RESULT: PASS — direct retry decision matrix and Worker callsite integration verified.");
}

main().catch((error) => {
  console.error(`WORKER RETRY GUARD TEST FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
