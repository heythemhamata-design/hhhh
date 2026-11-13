type OmniRouteRequest = {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: readonly unknown[];
  tool_choice?: "auto" | "required";
  signal?: AbortSignal;
};

export type OmniRouteToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type OmniRouteMessage = {
  role: string;
  content?: string | null;
  tool_calls?: OmniRouteToolCall[];
};

export type OmniRouteResponse = {
  /** Provider/model selected by OmniRoute, which may differ from the requested alias. */
  model?: string;
  choices?: Array<{
    message?: OmniRouteMessage;
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
    type?: string;
  };
};

/** HTTP failure from OmniRoute, preserving provider retry metadata for the queue. */
export class OmniRouteHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`OmniRoute error: ${message}`);
    this.name = "OmniRouteHttpError";
  }
}

function durationToMs(value: string, unit: string): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const normalized = unit.toLowerCase();
  const multiplier = normalized.startsWith("ms") || normalized.startsWith("millisecond")
    ? 1
    : normalized === "s" || normalized.startsWith("sec") || normalized.startsWith("second")
      ? 1_000
      : normalized === "m" || normalized.startsWith("min") || normalized.startsWith("minute")
        ? 60_000
        : normalized === "h" || normalized.startsWith("hr") || normalized.startsWith("hour")
          ? 3_600_000
          : null;

  return multiplier === null ? null : Math.ceil(amount * multiplier);
}

/** Parses Retry-After as seconds or an HTTP date. */
export function parseRetryAfterHeader(
  value: string | null,
  nowMs = Date.now(),
): number | null {
  if (!value?.trim()) return null;

  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.ceil(Number(trimmed) * 1_000);
  }

  const retryAt = Date.parse(trimmed);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - nowMs) : null;
}

/** Fallback parser for provider messages such as "reset after 5m". */
export function parseRetryDelayFromMessage(message: string): number | null {
  const unit = "(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)";
  const amount = "(\\d+(?:\\.\\d+)?)";
  const patterns = [
    new RegExp(`(?:reset|retry|cooldown|cool\\s*down|available|try again)[\\s\\S]{0,64}?\\b${amount}\\s*${unit}\\b`, "i"),
    new RegExp(`\\b(?:after|in)\\s+${amount}\\s*${unit}\\b`, "i"),
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      const delay = durationToMs(match[1], match[2]);
      if (delay !== null) return delay;
    }
  }

  return null;
}

export async function createOmniRouteCompletion(
  payload: OmniRouteRequest,
): Promise<OmniRouteResponse> {
  const apiKey = process.env.OMNIROUTE_API_KEY;
  if (!apiKey) throw new Error("OMNIROUTE_API_KEY is not configured.");

  const baseUrl = (
    process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128/v1"
  ).replace(/\/+$/, "");

  const { signal, ...requestPayload } = payload;
  const configuredTimeoutMs = process.env.MONSTER_OMNIROUTE_TIMEOUT_MS;
  const omniRouteRequestTimeoutMs =
    configuredTimeoutMs === undefined ? 180_000 : Number(configuredTimeoutMs);
  if (
    !Number.isSafeInteger(omniRouteRequestTimeoutMs) ||
    omniRouteRequestTimeoutMs < 10_000 ||
    omniRouteRequestTimeoutMs > 600_000
  ) {
    throw new Error(
      "MONSTER_OMNIROUTE_TIMEOUT_MS must be an integer between 10000 and 600000.",
    );
  }
  const timeoutSignal = AbortSignal.timeout(omniRouteRequestTimeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestPayload),
    cache: "no-store",
    signal: requestSignal,
  });

  const raw = await response.text();
  let data: OmniRouteResponse;
  try {
    data = JSON.parse(raw) as OmniRouteResponse;
  } catch {
    if (!response.ok) {
      const message = raw.trim().slice(0, 2_000) || `HTTP ${response.status}`;
      const retryAfterMs =
        parseRetryAfterHeader(response.headers.get("retry-after")) ??
        parseRetryDelayFromMessage(message);
      throw new OmniRouteHttpError(response.status, message, retryAfterMs);
    }
    throw new Error(`OmniRoute returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const message = data.error?.message || `HTTP ${response.status}`;
    const retryAfterMs =
      parseRetryAfterHeader(response.headers.get("retry-after")) ??
      parseRetryDelayFromMessage(message);
    throw new OmniRouteHttpError(response.status, message, retryAfterMs);
  }

  return data;
}
