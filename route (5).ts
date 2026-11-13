import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents/registry";
import { enqueueTask } from "@/lib/tasks/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 40 * 1024;
const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

function jsonError(error: string, status: number) {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: NO_STORE_HEADERS },
  );
}

/** Restrict the HTTP Host header to the local Next.js listener names. */
function hasAllowedHost(request: NextRequest): boolean {
  const rawHost = request.headers.get("host");
  if (!rawHost || rawHost.length > 255) return false;

  try {
    const parsed = new URL(`http://${rawHost}`);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const allowedHostname = ["127.0.0.1", "localhost", "::1"].includes(hostname);
    const allowedPort = parsed.port === "" || parsed.port === "3000";

    return (
      allowedHostname &&
      allowedPort &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function hasValidBearerToken(request: NextRequest): boolean {
  const configured = process.env.MONSTER_VOICE_TASK_TOKEN?.trim() ?? "";
  if (configured.length < 40) return false;

  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return false;

  const expected = Buffer.from(configured, "utf8");
  const supplied = Buffer.from(match[1], "utf8");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function POST(request: NextRequest) {
  if (!hasAllowedHost(request)) {
    return jsonError("Only loopback Host values are accepted.", 403);
  }

  const configuredToken = process.env.MONSTER_VOICE_TASK_TOKEN?.trim() ?? "";
  if (configuredToken.length < 40) {
    return jsonError("Voice task authentication is not configured.", 503);
  }
  if (!hasValidBearerToken(request)) {
    return jsonError("Invalid voice task credentials.", 401);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return jsonError("Content-Type must be application/json.", 415);
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (!contentLengthHeader || !/^\d+$/.test(contentLengthHeader)) {
    return jsonError("A valid Content-Length header is required.", 411);
  }
  const declaredLength = Number(contentLengthHeader);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > MAX_BODY_BYTES) {
    return jsonError("Request body is empty or exceeds the size limit.", 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonError("Unable to read request body.", 400);
  }
  if (Buffer.byteLength(rawBody, "utf8") !== declaredLength || Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return jsonError("Request body length is invalid.", 400);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError("Request body must be valid JSON.", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("Request body must be an object.", 400);
  }

  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("title") || !keys.includes("description")) {
    return jsonError("Only title and description fields are accepted.", 400);
  }

  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!title || title.length > 160) {
    return jsonError("title must contain 1-160 characters.", 400);
  }
  if (!description || description.length > 8000) {
    return jsonError("description must contain 1-8000 characters.", 400);
  }

  const researcher = AGENTS.find((agent) => agent.id === "researcher");
  if (!researcher) {
    return jsonError("Researcher agent is not registered.", 503);
  }

  const taskInput = [
    "Voice-originated task.",
    `Title: ${title}`,
    "",
    "User request:",
    description,
  ].join("\n");

  try {
    const task = await enqueueTask({
      agentId: researcher.id,
      input: taskInput,
      enableTools: true,
      priority: 100,
      maxAttempts: 3,
      correlationId: `voice-${randomUUID()}`,
    });

    return NextResponse.json(
      { ok: true, task, message: "Task accepted by MONSTER Task Queue." },
      { status: 201, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error(
      "Voice task enqueue failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return jsonError("Unable to enqueue voice task. Check the server logs.", 500);
  }
}