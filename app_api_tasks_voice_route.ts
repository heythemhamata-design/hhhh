import { timingSafeEqual, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { enqueueTask } from "@/lib/tasks/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TITLE_CHARS = 160;
const MAX_DESCRIPTION_CHARS = 8_000;
let voiceRateWindowStart = Date.now();
let voiceRateCount = 0;

function consumeVoiceRateLimit(): boolean {
  const now = Date.now();
  if (now - voiceRateWindowStart >= 60_000) {
    voiceRateWindowStart = now;
    voiceRateCount = 0;
  }
  if (voiceRateCount >= 10) return false;
  voiceRateCount += 1;
  return true;
}

function isLocalHostHeader(request: NextRequest): boolean {
  const rawHost = (request.headers.get("host") ?? "").toLowerCase();
  const hostname = rawHost.startsWith("[")
    ? rawHost.slice(1, rawHost.indexOf("]"))
    : rawHost.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function hasValidVoiceToken(request: NextRequest): boolean {
  const expected = process.env.MONSTER_VOICE_TASK_TOKEN ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const supplied = match?.[1] ?? "";

  // Missing or weak server configuration fails closed.
  if (expected.length < 40 || supplied.length === 0) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}

export async function POST(request: NextRequest) {
  if (!isLocalHostHeader(request) || !hasValidVoiceToken(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized voice service." },
      { status: 401, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
  if (!consumeVoiceRateLimit()) {
    return NextResponse.json(
      { ok: false, error: "Voice task rate limit exceeded." },
      { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return NextResponse.json(
      { ok: false, error: "Content-Type must be application/json." },
      { status: 415 },
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Request body is too large." }, { status: 413 });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to read request body." }, { status: 400 });
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Request body is too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "Body must be a JSON object." }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";

  if (!title || title.length > MAX_TITLE_CHARS) {
    return NextResponse.json(
      { ok: false, error: `title must contain 1-${MAX_TITLE_CHARS} characters.` },
      { status: 400 },
    );
  }
  if (!description || description.length > MAX_DESCRIPTION_CHARS) {
    return NextResponse.json(
      { ok: false, error: `description must contain 1-${MAX_DESCRIPTION_CHARS} characters.` },
      { status: 400 },
    );
  }

  try {
    // Voice can create only a researcher task. The server policy decides its tools.
    // The model cannot choose an agent, expand allowedTools, or choose a priority.
    const task = await enqueueTask({
      agentId: "researcher",
      input: `VOICE TASK: ${title}\n\n${description}`,
      enableTools: true,
      priority: 100,
      maxAttempts: 3,
      correlationId: `voice-${randomUUID()}`,
    });

    return NextResponse.json(
      { ok: true, task },
      { status: 201, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Voice task enqueue failed:", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { ok: false, error: "Unable to enqueue voice task." },
      { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
