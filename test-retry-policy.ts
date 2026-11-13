import assert from "node:assert/strict";
import { hasUnsafeToolOutcome } from "../lib/ai/tool-policy";
import {
  OmniRouteHttpError,
  parseRetryAfterHeader,
  parseRetryDelayFromMessage,
} from "../lib/ai/omniroute";
import {
  classifyRetry,
  getTaskRetryDelayMs,
  isProviderCooldownError,
} from "../lib/tasks/retry-policy";

const now = Date.parse("2026-11-03T17:00:00.000Z");

assert.equal(parseRetryAfterHeader("300", now), 300_000);
assert.equal(
  parseRetryAfterHeader("Tue, 03 Nov 2026 17:05:00 GMT", now),
  300_000,
);
assert.equal(parseRetryDelayFromMessage("Quota reset after 5m"), 300_000);
assert.equal(parseRetryDelayFromMessage("Try again in 30 seconds"), 30_000);
assert.equal(parseRetryDelayFromMessage("No retry metadata"), null);

const rateLimited = new OmniRouteHttpError(429, "Rate limited", null);
assert.equal(isProviderCooldownError(rateLimited), true);
assert.equal(getTaskRetryDelayMs(rateLimited, 1), 300_000);

const resetHint = new OmniRouteHttpError(429, "Resource exhausted (reset after 5m)", null);
assert.equal(getTaskRetryDelayMs(resetHint, 1), 300_000);

const coolingDown = new Error("All credentials for model x are cooling down");
assert.equal(isProviderCooldownError(coolingDown), true);
assert.equal(getTaskRetryDelayMs(coolingDown, 1), 300_000);

assert.equal(getTaskRetryDelayMs(new Error("temporary network error"), 1), 5_000);
assert.equal(getTaskRetryDelayMs(new Error("temporary network error"), 2), 10_000);
assert.equal(
  getTaskRetryDelayMs(rateLimited, 1, { maxRetryDelayMs: 120_000 }),
  120_000,
);

// HTTP classification: permanent client/auth failures must not be retried.
for (const status of [400, 401, 403, 404, 422]) {
  assert.equal(classifyRetry(new OmniRouteHttpError(status, `HTTP ${status}`)), "terminal");
}

// Quota exhaustion is cooldown only when a concrete reset/Retry-After is known.
const quotaWithReset = new OmniRouteHttpError(402, "Quota reset after 5m", null);
const quotaWithoutReset = new OmniRouteHttpError(402, "Payment required: quota exhausted", null);
assert.equal(classifyRetry(quotaWithReset), "cooldown");
assert.equal(isProviderCooldownError(quotaWithReset), true);
assert.equal(classifyRetry(quotaWithoutReset), "terminal");

assert.equal(classifyRetry(new OmniRouteHttpError(408, "Request timeout")), "retryable");
assert.equal(classifyRetry(new OmniRouteHttpError(429, "Rate limited")), "cooldown");
assert.equal(classifyRetry(new OmniRouteHttpError(503, "Upstream unavailable")), "retryable");
assert.equal(classifyRetry(new Error("fetch failed: ECONNRESET")), "retryable");

// A confirmed or uncertain side effect blocks automatic task replay.
assert.equal(hasUnsafeToolOutcome([{ tool: "memory_save", ok: true, status: "succeeded" }]), true);
assert.equal(hasUnsafeToolOutcome([{ tool: "memory_save", ok: false, status: "outcome_unknown" }]), true);
assert.equal(hasUnsafeToolOutcome([{ tool: "memory_save", ok: false, status: "failed" }]), false);
assert.equal(hasUnsafeToolOutcome([{ tool: "memory_search", ok: true, status: "succeeded" }]), false);
assert.equal(hasUnsafeToolOutcome([{ tool: "workspace_append_file", ok: true, status: "succeeded" }]), true);

console.log("Retry policy tests passed.");
