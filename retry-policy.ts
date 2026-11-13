import {
  OmniRouteHttpError,
  parseRetryDelayFromMessage,
} from "@/lib/ai/omniroute";

export type RetryDelayOptions = {
  rateLimitFallbackDelayMs?: number;
  maxRetryDelayMs?: number;
};

export type RetryClass = "retryable" | "terminal" | "cooldown";

export type TaskRetryDecisionInput = {
  hasUnsafeSideEffect: boolean;
  isTaskPolicyError: boolean;
  isAgentProtocolError: boolean;
  isFinalizer: boolean;
  retryClass: RetryClass;
  attemptCount: number;
  maxAttempts: number;
};

/**
 * Shared production decision used by the queue Worker and direct regression tests.
 * A confirmed/uncertain side effect always suppresses automatic task replay.
 */
export function shouldRetryTask(input: TaskRetryDecisionInput): boolean {
  return !input.hasUnsafeSideEffect &&
    !input.isTaskPolicyError &&
    (!input.isAgentProtocolError || input.isFinalizer) &&
    input.retryClass !== "terminal" &&
    input.attemptCount < input.maxAttempts;
}

export function classifyRetry(error: unknown): RetryClass {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");

  if (error instanceof OmniRouteHttpError) {
    const status = error.status;
    if (status === 429) return "cooldown";
    if (status === 402) {
      const hintedDelay = error.retryAfterMs ?? parseRetryDelayFromMessage(message);
      return hintedDelay !== null ? "cooldown" : "terminal";
    }
    if ([400, 401, 403, 404, 422].includes(status)) return "terminal";
    if (status === 408 || status === 425 || status >= 500) return "retryable";
    if (status >= 400 && status < 500) return "terminal";
  }

  if (/all credentials .*cooling down|resource has been exhausted|rate.?limit|too many requests/i.test(message)) {
    return "cooldown";
  }
  if (/\b(fetch failed|econnreset|econnrefused|econnaborted|etimedout|eai_again|enotfound|socket hang up|network error|connect timeout|connect_timeout|und_err_connect_timeout|request timeout|timed out|timeout)\b/i.test(message)) {
    return "retryable";
  }
  return "retryable";
}

export function isProviderCooldownError(error: unknown): boolean {
  return classifyRetry(error) === "cooldown";
}

/**
 * Returns a queue delay that respects upstream Retry-After/reset hints.
 * No model/provider switching happens here; this only schedules a later retry.
 */
export function getTaskRetryDelayMs(
  error: unknown,
  attemptCount: number,
  options: RetryDelayOptions = {},
): number {
  const rateLimitFallbackDelayMs = options.rateLimitFallbackDelayMs ?? 300_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 86_400_000;
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const explicitDelay = error instanceof OmniRouteHttpError
    ? error.retryAfterMs
    : null;
  const parsedDelay = explicitDelay ?? parseRetryDelayFromMessage(message);

  if (parsedDelay !== null) {
    return Math.min(maxRetryDelayMs, Math.max(1_000, Math.ceil(parsedDelay)));
  }

  if (isProviderCooldownError(error)) {
    return Math.min(maxRetryDelayMs, Math.max(1_000, rateLimitFallbackDelayMs));
  }

  return Math.min(
    maxRetryDelayMs,
    5_000 * (2 ** Math.max(0, attemptCount - 1)),
  );
}
