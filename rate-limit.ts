import { createHash } from "node:crypto";
import { getPostgresPool } from "@/lib/db/postgres";

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getClientHint(request: Request): string {
  // The application is intended to remain bound to loopback. When a trusted
  // local reverse proxy is introduced, configure it to overwrite these headers.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const candidate = forwarded || realIp || "local-client";
  return candidate.slice(0, 128);
}

async function consumeBucket(
  bucketKey: string,
  maximum: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const pool = getPostgresPool();
  const result = await pool.query<{
    request_count: number;
    window_started_at: Date | string;
  }>(
    `
      INSERT INTO api_rate_limits (bucket_key, window_started_at, request_count, updated_at)
      VALUES ($1, NOW(), 1, NOW())
      ON CONFLICT (bucket_key) DO UPDATE SET
        request_count = CASE
          WHEN api_rate_limits.window_started_at <= NOW() - ($2::int * INTERVAL '1 second') THEN 1
          ELSE api_rate_limits.request_count + 1
        END,
        window_started_at = CASE
          WHEN api_rate_limits.window_started_at <= NOW() - ($2::int * INTERVAL '1 second') THEN NOW()
          ELSE api_rate_limits.window_started_at
        END,
        updated_at = NOW()
      RETURNING request_count, window_started_at
    `,
    [bucketKey, windowSeconds],
  );

  const row = result.rows[0];
  const startedAt = row.window_started_at instanceof Date
    ? row.window_started_at.getTime()
    : new Date(row.window_started_at).getTime();
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((startedAt + windowSeconds * 1_000 - Date.now()) / 1_000),
  );

  return {
    allowed: row.request_count <= maximum,
    retryAfterSeconds,
  };
}

/**
 * Uses two independent buckets: a hashed client hint and a global ceiling.
 * The global bucket means spoofing forwarding headers cannot disable limits.
 */
export async function enforceRateLimit(
  request: Request,
  scope: string,
  perClientMaximum: number,
  globalMaximum: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const clientKey = digest(`${scope}:client:${getClientHint(request)}`);
  const globalKey = digest(`${scope}:global`);

  const clientResult = await consumeBucket(clientKey, perClientMaximum, windowSeconds);
  if (!clientResult.allowed) return clientResult;

  return consumeBucket(globalKey, globalMaximum, windowSeconds);
}
