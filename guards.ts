import { NextRequest, NextResponse } from "next/server";
import {
  isSameOriginRequest,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "@/lib/security/auth";
import { enforceRateLimit } from "@/lib/security/rate-limit";

function unauthorized() {
  return NextResponse.json(
    { ok: false, error: "Authentication required." },
    {
      status: 401,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}

export async function authorizeApiRead(request: NextRequest): Promise<NextResponse | null> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token) ? null : unauthorized();
}

export async function authorizeApiMutation(
  request: NextRequest,
  scope: string,
  perClientMaximum: number,
  globalMaximum: number,
  windowSeconds = 60,
): Promise<NextResponse | null> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "Cross-origin request rejected." },
      { status: 403, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const authResponse = await authorizeApiRead(request);
  if (authResponse) return authResponse;

  try {
    const result = await enforceRateLimit(
      request,
      scope,
      perClientMaximum,
      globalMaximum,
      windowSeconds,
    );
    if (!result.allowed) {
      return NextResponse.json(
        { ok: false, error: "Rate limit exceeded. Please retry later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(result.retryAfterSeconds),
            "Cache-Control": "no-store, max-age=0",
          },
        },
      );
    }
    return null;
  } catch (error) {
    console.error(
      "API rate limiter unavailable:",
      error instanceof Error ? error.message : "Unknown database error",
    );
    return NextResponse.json(
      { ok: false, error: "Security service unavailable. Request blocked." },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
