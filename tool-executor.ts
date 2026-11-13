import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { PoolClient } from "pg";
import { getPostgresPool } from "@/lib/db/postgres";
import { executeMemoryTool } from "@/lib/memory/store";
import { WORKSPACE_TOOLS, executeWorkspaceTool } from "@/lib/workspace/tools";
import type { AgentId } from "@/lib/agents/registry";
import { TOOL_REPLAY_CLASS } from "@/lib/ai/tool-policy";
import {
  CHAT_ALLOWED_TOOLS,
  resolveAgentToolGrant,
} from "@/lib/ai/tool-policy";

type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    strict: boolean;
    parameters: Record<string, unknown>;
  };
};

const numberSchema = { type: "number" };

const calculateTool: ToolDefinition = {
  type: "function",
  function: {
    name: "calculate",
    description:
      "Perform accurate arithmetic: add, subtract, multiply, divide, or calculate a percentage. For percentage, calculate (value / total) * 100.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["add", "subtract", "multiply", "divide", "percentage"],
        },
        a: numberSchema,
        b: numberSchema,
      },
      required: ["operation", "a", "b"],
      additionalProperties: false,
    },
  },
};

const addNumbersTool: ToolDefinition = {
  type: "function",
  function: {
    name: "add_numbers",
    description: "Add two finite numbers and return their exact sum.",
    strict: true,
    parameters: {
      type: "object",
      properties: { a: numberSchema, b: numberSchema },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
};

const dateTimeTool: ToolDefinition = {
  type: "function",
  function: {
    name: "get_current_datetime",
    description:
      "Get the current server date and time in ISO format, with a requested IANA timezone.",
    strict: true,
    parameters: {
      type: "object",
      properties: { timezone: { type: "string" } },
      required: ["timezone"],
      additionalProperties: false,
    },
  },
};

const transformTextTool: ToolDefinition = {
  type: "function",
  function: {
    name: "transform_text",
    description:
      "Transform text using uppercase, lowercase, trim, or character count.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        operation: {
          type: "string",
          enum: ["uppercase", "lowercase", "trim", "count"],
        },
      },
      required: ["text", "operation"],
      additionalProperties: false,
    },
  },
};

const parseJsonTool: ToolDefinition = {
  type: "function",
  function: {
    name: "parse_json",
    description:
      "Parse and validate a JSON string. Return the parsed data or a clear validation error.",
    strict: true,
    parameters: {
      type: "object",
      properties: { json: { type: "string" } },
      required: ["json"],
      additionalProperties: false,
    },
  },
};

const memorySaveTool: ToolDefinition = {
  type: "function",
  function: {
    name: "memory_save",
    description:
      "Save durable, useful information to persistent project memory. Use only for information worth remembering.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        category: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "content", "category", "tags"],
      additionalProperties: false,
    },
  },
};

const memorySearchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "memory_search",
    description: "Search persistent project memory for information relevant to a query.",
    strict: true,
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

const memoryListTool: ToolDefinition = {
  type: "function",
  function: {
    name: "memory_list",
    description: "List saved memories. Use category 'all' to list every category.",
    strict: true,
    parameters: {
      type: "object",
      properties: { category: { type: "string" } },
      required: ["category"],
      additionalProperties: false,
    },
  },
};


const webSearchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the public web using DuckDuckGo. Return only titles, URLs and snippets actually present in the search response. If the provider blocks the request or changes its markup, return an explicit error instead of inventing results.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200 },
        maxResults: { type: "integer", minimum: 1, maximum: 8 },
      },
      required: ["query", "maxResults"],
      additionalProperties: false,
    },
  },
};

const runPowerShellTool: ToolDefinition = {
  type: "function",
  function: {
    name: "run_powershell",
    description:
      "Perform one of the fixed, allowlisted Windows actions. Supported actions are open_url (open a validated public HTTP(S) URL in the default browser) and create_workspace_directory (create a relative directory inside the MONSTER workspace). Arbitrary PowerShell commands, scripts, executables, file paths, and shell text are never accepted.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["open_url", "create_workspace_directory"],
        },
        target: { type: "string", minLength: 1, maxLength: 2048 },
      },
      required: ["action", "target"],
      additionalProperties: false,
    },
  },
};

export const MEMORY_TOOLS: readonly ToolDefinition[] = [
  memorySaveTool,
  memorySearchTool,
  memoryListTool,
];

export const AVAILABLE_TOOLS: readonly ToolDefinition[] = [
  calculateTool,
  addNumbersTool,
  dateTimeTool,
  transformTextTool,
  parseJsonTool,
  webSearchTool,
  runPowerShellTool,
  ...WORKSPACE_TOOLS,
  ...MEMORY_TOOLS,
];

export type ToolName =
  | "calculate"
  | "add_numbers"
  | "get_current_datetime"
  | "transform_text"
  | "parse_json"
  | "web_search"
  | "run_powershell"
  | "workspace_list_files"
  | "workspace_read_file"
  | "workspace_write_file"
  | "workspace_append_file"
  | "workspace_create_directory"
  | "memory_save"
  | "memory_search"
  | "memory_list";

export type ToolExecutionStatus = "succeeded" | "failed" | "outcome_unknown" | "denied";

export type ToolExecutionResult = {
  ok: boolean;
  status?: ToolExecutionStatus;
  tool: string;
  result?: unknown;
  error?: string;
};

export type ToolExecutionContext =
  | {
      kind: "agent";
      agentId: AgentId;
      /** A task-level subset. The executor verifies it against the agent ceiling. */
      allowedTools: readonly ToolName[];
      /** Present only for durable queue-worker tasks; never supplied by model output. */
      taskExecution?: {
        taskId: string;
        runId: string;
        correlationId: string | null;
        operationIndex: number;
      };
      signal?: AbortSignal;
    }
  | {
      kind: "chat";
      /** Chat grants are server-owned in tool-policy.ts; callers cannot supply a list. */
      signal?: AbortSignal;
    };

function isAuthorized(name: string, context: ToolExecutionContext): boolean {
  if (context.kind === "chat") {
    return CHAT_ALLOWED_TOOLS.includes(name as (typeof CHAT_ALLOWED_TOOLS)[number]);
  }

  if (context.kind === "agent") {
    if (!Array.isArray(context.allowedTools)) return false;
    try {
      const bounded = resolveAgentToolGrant(context.agentId, context.allowedTools);
      return bounded.includes(name as ToolName);
    } catch {
      return false;
    }
  }

  return false;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error("Tool execution was aborted.");
}

const MEMORY_TOOL_NAMES: readonly ToolName[] = [
  "memory_save",
  "memory_search",
  "memory_list",
];

const WORKSPACE_TOOL_NAMES: readonly ToolName[] = [
  "workspace_list_files",
  "workspace_read_file",
  "workspace_write_file",
  "workspace_append_file",
  "workspace_create_directory",
];

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + stableJson(record[key]),
  ).join(",") + "}";
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseArguments(rawArguments: string): Record<string, unknown> {
  if (typeof rawArguments !== "string" || rawArguments.length > 200_000) {
    throw new Error("Tool arguments must be a JSON string under 200000 characters.");
  }

  const args: unknown = JSON.parse(rawArguments);
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("Tool arguments must be a JSON object.");
  }

  return args as Record<string, unknown>;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`);
  }
  return value;
}

function executeCalculation(args: Record<string, unknown>) {
  const operation = args.operation;
  const a = requireNumber(args, "a");
  const b = requireNumber(args, "b");

  let result: number;
  switch (operation) {
    case "add":
      result = a + b;
      break;
    case "subtract":
      result = a - b;
      break;
    case "multiply":
      result = a * b;
      break;
    case "divide":
      if (b === 0) throw new Error("Division by zero is not allowed.");
      result = a / b;
      break;
    case "percentage":
      if (b === 0) throw new Error("Percentage total cannot be zero.");
      result = (a / b) * 100;
      break;
    default:
      throw new Error("Unsupported calculation operation.");
  }

  if (!Number.isFinite(result)) {
    throw new Error("Calculation produced a non-finite result.");
  }

  return { operation, a, b, result };
}

function executeDateTime(args: Record<string, unknown>) {
  const timezone = args.timezone;
  if (typeof timezone !== "string" || !timezone.trim()) {
    throw new Error("A valid IANA timezone is required.");
  }

  const now = new Date();
  let localTime: string;

  try {
    localTime = new Intl.DateTimeFormat("en-GB", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: timezone,
    }).format(now);
  } catch {
    throw new Error("Invalid IANA timezone.");
  }

  return { iso: now.toISOString(), timezone, localTime };
}

function executeTextTransform(args: Record<string, unknown>) {
  const text = args.text;
  const operation = args.operation;

  if (typeof text !== "string") throw new Error("text must be a string.");
  if (text.length > 50_000) {
    throw new Error("Text exceeds the 50000 character limit.");
  }

  switch (operation) {
    case "uppercase":
      return { operation, result: text.toUpperCase() };
    case "lowercase":
      return { operation, result: text.toLowerCase() };
    case "trim":
      return { operation, result: text.trim() };
    case "count":
      return {
        operation,
        characters: text.length,
        words: text.trim() ? text.trim().split(/\s+/).length : 0,
      };
    default:
      throw new Error("Unsupported text transformation.");
  }
}

function executeParseJson(args: Record<string, unknown>) {
  const json = args.json;
  if (typeof json !== "string") throw new Error("json must be a string.");
  if (json.length > 100_000) {
    throw new Error("JSON input exceeds the 100000 character limit.");
  }

  return { valid: true, data: JSON.parse(json) as unknown };
}


const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const WEB_SEARCH_TIMEOUT_MS = 12_000;
const WEB_SEARCH_MAX_RESPONSE_BYTES = 1_500_000;
const POWERSHELL_ACTION_TIMEOUT_MS = 8_000;
const POWERSHELL_OPEN_URL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$target = [Environment]::GetEnvironmentVariable('MONSTER_OPEN_URL')",
  "if ([string]::IsNullOrWhiteSpace($target)) { exit 2 }",
  "Start-Process -FilePath $target -ErrorAction Stop",
  "exit 0",
].join("; ");

function assertExactKeys(
  args: Record<string, unknown>,
  expected: readonly string[],
): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`Unexpected argument: ${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`Missing required argument: ${key}`);
    }
  }
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${key} exceeds the ${maxLength} character limit.`);
  }
  if (normalized.includes("\0")) {
    throw new Error(`${key} contains a null character.`);
  }
  return normalized;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    quot: "\"",
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const hex = code[1]?.toLowerCase() === "x";
      const numeric = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > 0x10ffff) return "";
      try {
        return String.fromCodePoint(numeric);
      } catch {
        return "";
      }
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function cleanHtmlText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

function readHtmlAttribute(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attributes.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw === undefined ? null : decodeHtmlEntities(raw);
}

function normalizeDuckDuckGoResultUrl(rawHref: string): string | null {
  try {
    const parsed = new URL(rawHref, "https://duckduckgo.com/");
    if (parsed.hostname === "duckduckgo.com" && parsed.pathname.startsWith("/l/")) {
      const target = parsed.searchParams.get("uddg");
      if (!target) return null;
      const resolved = new URL(target);
      if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return null;
      if (resolved.username || resolved.password) return null;
      if (resolved.hostname === "duckduckgo.com" || resolved.hostname.endsWith(".duckduckgo.com")) return null;
      resolved.hash = "";
      return resolved.toString();
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com")) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractClassElementText(region: string, className: string): string {
  const openingTags = /<(a|div|span)\b([^>]*)>/gi;
  let opening: RegExpExecArray | null;

  while ((opening = openingTags.exec(region)) !== null) {
    const classes = readHtmlAttribute(opening[2] ?? "", "class") ?? "";
    if (!classes.split(/\s+/).includes(className)) continue;

    const closing = new RegExp(`<\/${opening[1]}\\s*>`, "ig");
    closing.lastIndex = openingTags.lastIndex;
    const closeMatch = closing.exec(region);
    if (!closeMatch) return "";

    return cleanHtmlText(region.slice(openingTags.lastIndex, closeMatch.index));
  }

  return "";
}

function parseDuckDuckGoHtml(html: string, maxResults: number) {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  const titleAnchors = anchors.filter((match) => {
    const className = readHtmlAttribute(match[1] ?? "", "class") ?? "";
    return className.split(/\s+/).includes("result__a");
  });

  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const seen = new Set<string>();

  for (let index = 0; index < titleAnchors.length && results.length < maxResults; index++) {
    const match = titleAnchors[index];
    const href = readHtmlAttribute(match[1] ?? "", "href");
    const title = cleanHtmlText(match[2] ?? "");
    if (!href || !title) continue;

    const url = normalizeDuckDuckGoResultUrl(href);
    if (!url || seen.has(url)) continue;

    const start = (match.index ?? 0) + match[0].length;
    const nextStart = titleAnchors[index + 1]?.index ?? Math.min(html.length, start + 8_000);
    const region = html.slice(start, Math.max(start, Math.min(nextStart, start + 8_000)));
    const snippet = extractClassElementText(region, "result__snippet");

    seen.add(url);
    results.push({ title, url, snippet });
  }

  return results;
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Search provider response exceeds the size limit.");
  }
  if (!response.body) throw new Error("Search provider returned an empty response body.");

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Search provider response exceeds the size limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total).toString("utf8");
}

async function executeWebSearch(
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  assertExactKeys(args, ["query", "maxResults"]);
  const query = requireString(args, "query", 200);
  const maxResults = args.maxResults;
  if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 8) {
    throw new Error("maxResults must be an integer between 1 and 8.");
  }
  throwIfAborted(signal);

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, WEB_SEARCH_TIMEOUT_MS);

  try {
    const endpoint = new URL(DUCKDUCKGO_HTML_ENDPOINT);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("kp", "1");

    const response = await fetch(endpoint, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "MONSTER-AI-Command-Center/1.0 (server-side web search)",
      },
    });

    // DuckDuckGo can return HTTP 202 with a challenge page and no result nodes.
    if (response.status === 202 || response.status === 403 || response.status === 429) {
      throw new Error(`DuckDuckGo search is currently blocked or rate-limited (HTTP ${response.status}).`);
    }
    if (response.status !== 200) {
      throw new Error(`DuckDuckGo search failed with HTTP ${response.status}.`);
    }

    const html = await readResponseTextLimited(response, WEB_SEARCH_MAX_RESPONSE_BYTES);
    const results = parseDuckDuckGoHtml(html, maxResults);
    if (results.length === 0) {
      throw new Error("DuckDuckGo returned no parseable result nodes. The provider may be challenging this request or its HTML may have changed; no results were fabricated.");
    }

    return {
      provider: "duckduckgo_html",
      query,
      resultCount: results.length,
      results,
      retrievedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    if (timedOut) throw new Error(`Web search timed out after ${WEB_SEARCH_TIMEOUT_MS} ms.`);
    if (error instanceof Error) throw error;
    throw new Error("Web search failed with an unknown provider error.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function validatePublicBrowserUrl(value: string): string {
  if (value.length > 2_048 || value !== value.trim()) {
    throw new Error("URL must be at most 2048 characters with no surrounding whitespace.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("target must be a valid absolute URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS URLs can be opened.");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing embedded credentials are not allowed.");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("Non-standard URL ports are not allowed.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const blockedSuffixes = [".localhost", ".local", ".internal", ".test", ".invalid", ".example"];
  if (
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.startsWith("[") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
    blockedSuffixes.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error("Only public DNS hostnames can be opened; local, private, and IP-literal targets are blocked.");
  }

  url.hash = "";
  return url.toString();
}

function buildMinimalWindowsEnvironment(url: string): NodeJS.ProcessEnv {
  // Next.js augments NodeJS.ProcessEnv with a required NODE_ENV property.
  // Pass only a normalized, known value while preserving the minimal allowlist.
  const currentNodeEnv = process.env.NODE_ENV;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV:
      currentNodeEnv === "development" || currentNodeEnv === "test"
        ? currentNodeEnv
        : "production",
  };
  for (const key of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.MONSTER_OPEN_URL = url;
  return env;
}

async function openUrlWithPowerShell(url: string, signal?: AbortSignal): Promise<{ action: "open_url"; launched: true; url: string }> {
  if (process.platform !== "win32") {
    throw new Error("run_powershell open_url is available only on Windows.");
  }
  throwIfAborted(signal);

  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_OPEN_URL_SCRIPT],
    {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      env: buildMinimalWindowsEnvironment(url),
    },
  );

  return await new Promise((resolve, reject) => {
    let termination: "timeout" | "aborted" | null = null;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      termination = "aborted";
      child.kill();
    };
    const timer = setTimeout(() => {
      termination = "timeout";
      child.kill();
    }, POWERSHELL_ACTION_TIMEOUT_MS);

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => fail(new Error(`Unable to start the fixed PowerShell browser action: ${error.message}`)));
    child.once("close", (code) => {
      if (termination === "aborted") {
        fail(new Error("PowerShell browser action was aborted; browser launch outcome may be unknown."));
      } else if (termination === "timeout") {
        fail(new Error("PowerShell browser action timed out; browser launch outcome may be unknown."));
      } else if (code !== 0) {
        fail(new Error(`PowerShell browser action exited with code ${String(code)}.`));
      } else if (!settled) {
        settled = true;
        cleanup();
        resolve({ action: "open_url", launched: true, url });
      }
    });
  });
}

type DurableOpenUrlExecution = {
  taskId: string;
  runId: string;
  correlationId: string | null;
  agentId: AgentId;
  operationIndex: number;
};

/**
 * Durable receipt for the external open_url action.
 * The start event is committed before PowerShell is launched. Any uncertain
 * outcome is therefore visible to lease-recovery and cannot be replayed.
 */
async function executeDurableOpenUrl(
  url: string,
  execution: DurableOpenUrlExecution,
  signal: AbortSignal | undefined,
  markStarted: () => void,
): Promise<{ action: "open_url"; launched: true; url: string }> {
  if (!Number.isSafeInteger(execution.operationIndex) || execution.operationIndex < 0) {
    throw new Error("A valid durable operation index is required for open_url.");
  }

  const operationKey = hashText(`${execution.taskId}:side-effect:${execution.operationIndex}`);
  const argumentsHash = hashText(stableJson({ action: "open_url", target: url }));
  const lockKey = `monster-ai-side-effect:${execution.taskId}:${operationKey}`;
  const clientPool = getPostgresPool();
  let client: PoolClient | null = null;
  let lockAcquired = false;
  let transactionOpen = false;
  let discardClient = false;

  try {
    throwIfAborted(signal);
    client = await clientPool.connect();

    const lockDeadline = Date.now() + 30_000;
    while (Date.now() < lockDeadline) {
      throwIfAborted(signal);
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked",
        [lockKey],
      );
      if (lock.rows[0]?.locked === true) {
        lockAcquired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!lockAcquired) {
      // Another execution may still be performing this same logical action.
      // Mark the local result uncertain so the live Worker will not retry it.
      markStarted();
      throw new Error("Another execution still holds the open_url operation lock. Automatic replay is suppressed; reconcile before retrying.");
    }

    const prior = await client.query<{
      tool_name: string | null;
      event_type: string;
      details: Record<string, unknown> | null;
    }>(
      `SELECT tool_name, event_type, details
       FROM public.task_events
       WHERE task_id = $1::uuid
         AND details->>'operationIndex' = $2::text
         AND event_type IN ('tool.execution_started', 'tool.execution_succeeded')
       ORDER BY id ASC`,
      [execution.taskId, execution.operationIndex],
    );

    for (const row of prior.rows) {
      const details = row.details ?? {};
      if (
        row.tool_name !== "run_powershell" ||
        details.tool !== "run_powershell" ||
        details.action !== "open_url" ||
        details.operationKey !== operationKey
      ) {
        markStarted();
        throw new Error("open_url operation identity conflict. The task step was already reserved by another side-effecting operation; manual reconciliation is required.");
      }
      if (details.argumentsHash !== argumentsHash) {
        markStarted();
        throw new Error("open_url idempotency conflict: this task step was recorded with different URL arguments. Automatic replay is suppressed.");
      }
    }

    const successes = prior.rows.filter((row) => row.event_type === "tool.execution_succeeded");
    if (successes.length > 1) {
      markStarted();
      throw new Error("Multiple open_url success receipts exist. Manual reconciliation is required.");
    }

    if (successes.length === 1) {
      const details = successes[0].details ?? {};
      const saved = details.result;
      if (
        !saved || typeof saved !== "object" || Array.isArray(saved) ||
        (saved as Record<string, unknown>).action !== "open_url" ||
        (saved as Record<string, unknown>).launched !== true
      ) {
        markStarted();
        throw new Error("Stored open_url success receipt is malformed. Manual reconciliation is required.");
      }
      return { action: "open_url", launched: true, url };
    }

    if (prior.rows.some((row) => row.event_type === "tool.execution_started")) {
      markStarted();
      throw new Error("A prior open_url execution started but has no durable success receipt. The browser outcome is unknown; automatic replay is suppressed.");
    }

    // Set the in-memory guard before BEGIN/COMMIT. If COMMIT acknowledgement is
    // lost, the live Worker must treat the outcome as uncertain. No browser
    // process is launched until COMMIT has returned successfully.
    markStarted();
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      `INSERT INTO public.task_events
        (task_id, run_id, correlation_id, agent_id, tool_name,
         event_type, severity, success, details)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'run_powershell',
         'tool.execution_started', 'info', false, $5::jsonb)`,
      [
        execution.taskId,
        execution.runId,
        execution.correlationId,
        execution.agentId,
        JSON.stringify({
          tool: "run_powershell",
          action: "open_url",
          operationIndex: execution.operationIndex,
          operationKey,
          argumentsHash,
          targetHash: hashText(url),
        }),
      ],
    );
    await client.query("COMMIT");
    transactionOpen = false;

    await openUrlWithPowerShell(url, signal);
    throwIfAborted(signal);

    // Do not persist the full URL: query strings may contain sensitive tokens.
    const durableResult = { action: "open_url", launched: true };
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      `INSERT INTO public.task_events
        (task_id, run_id, correlation_id, agent_id, tool_name,
         event_type, severity, success, details)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'run_powershell',
         'tool.execution_succeeded', 'info', true, $5::jsonb)`,
      [
        execution.taskId,
        execution.runId,
        execution.correlationId,
        execution.agentId,
        JSON.stringify({
          tool: "run_powershell",
          action: "open_url",
          operationIndex: execution.operationIndex,
          operationKey,
          argumentsHash,
          targetHash: hashText(url),
          result: durableResult,
        }),
      ],
    );
    await client.query("COMMIT");
    transactionOpen = false;

    return { action: "open_url", launched: true, url };
  } catch (error) {
    if (client && transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discardClient = true;
      }
      transactionOpen = false;
    }
    throw error;
  } finally {
    if (client) {
      if (lockAcquired) {
        try {
          const unlocked = await client.query<{ unlocked: boolean }>(
            "SELECT pg_advisory_unlock(hashtextextended($1::text, 0)) AS unlocked",
            [lockKey],
          );
          if (unlocked.rows[0]?.unlocked !== true) discardClient = true;
        } catch {
          discardClient = true;
        }
      }
      client.release(discardClient);
    }
  }
}
function validateWorkspaceRelativeTarget(value: string): string {
  if (value.length > 240) throw new Error("Workspace directory path exceeds 240 characters.");
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error("Workspace directory target must be a safe relative path.");
  }
  return normalized;
}

async function executeControlledWindowsAction(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  markStarted: () => void,
): Promise<unknown> {
  assertExactKeys(args, ["action", "target"]);
  const action = requireString(args, "action", 64);
  const rawTarget = requireString(args, "target", 2_048);

  if (action === "open_url") {
    const url = validatePublicBrowserUrl(rawTarget);
    if (process.platform !== "win32") {
      throw new Error("run_powershell open_url is available only on Windows.");
    }
    if (context.kind !== "agent" || !context.taskExecution) {
      throw new Error("A durable task execution context is required for open_url.");
    }
    return await executeDurableOpenUrl(
      url,
      { ...context.taskExecution, agentId: context.agentId },
      context.signal,
      markStarted,
    );
  }

  if (action === "create_workspace_directory") {
    const relativePath = validateWorkspaceRelativeTarget(rawTarget);
    const taskExecution = context.kind === "agent" ? context.taskExecution : undefined;
    const workspaceExecution = context.kind === "agent" && taskExecution
      ? {
          ...taskExecution,
          agentId: context.agentId,
          operationKey: hashText(`${taskExecution.taskId}:side-effect:${taskExecution.operationIndex}`),
          argumentsHash: hashText(stableJson({ path: relativePath })),
        }
      : undefined;

    markStarted();
    const workspaceResult = await executeWorkspaceTool(
      "workspace_create_directory",
      JSON.stringify({ path: relativePath }),
      workspaceExecution,
    );
    if (!workspaceResult) {
      throw new Error("Workspace directory tool is not registered.");
    }
    if (!workspaceResult.ok) {
      throw new Error(workspaceResult.error ?? "Workspace directory creation failed.");
    }
    return workspaceResult.result;
  }

  throw new Error("Unsupported controlled Windows action.");
}

function permissionDenied(name: string): ToolExecutionResult {
  return {
    ok: false,
    status: "denied",
    tool: name,
    error: `Permission denied: tool ${name} has no explicit grant in this execution context.`,
  };
}

export async function executeTool(
  name: string,
  rawArguments: string,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  let executionStarted = false;
  try {
    if (!context || typeof context !== "object" || !isAuthorized(name, context)) {
      return permissionDenied(name);
    }

    // Check cancellation and authorization before parsing attacker-controlled arguments.
    throwIfAborted(context.signal);
    const isRegistered = AVAILABLE_TOOLS.some(
      (tool) => tool.function.name === name,
    );
    if (!isRegistered) return permissionDenied(name);
    if (name === "run_powershell" && (context.kind !== "agent" || !context.taskExecution)) {
      return {
        ok: false,
        status: "denied",
        tool: name,
        error: "A durable task execution context is required for Windows actions.",
      };
    }

    const args = parseArguments(rawArguments);
    let result: unknown;

    switch (name) {
      case "calculate":
        result = executeCalculation(args);
        break;
      case "add_numbers": {
        const a = requireNumber(args, "a");
        const b = requireNumber(args, "b");
        const sum = a + b;
        if (!Number.isFinite(sum)) {
          throw new Error("Addition produced a non-finite result.");
        }
        result = { a, b, result: sum };
        break;
      }
      case "get_current_datetime":
        result = executeDateTime(args);
        break;
      case "transform_text":
        result = executeTextTransform(args);
        break;
      case "parse_json":
        result = executeParseJson(args);
        break;
      case "web_search":
        result = await executeWebSearch(args, context.signal);
        break;
      case "run_powershell":
        result = await executeControlledWindowsAction(args, context, () => {
          executionStarted = true;
        });
        break;
      default: {
        if (MEMORY_TOOL_NAMES.includes(name as ToolName)) {
          executionStarted = name === "memory_save";
          let memoryExecution: {
            taskId: string;
            runId: string;
            correlationId: string | null;
            agentId: string;
            operationIndex: number;
            operationKey: string;
            argumentsHash: string;
          } | undefined;
          if (name === "memory_save" && context.kind === "agent" && context.taskExecution) {
            const taskExecution = context.taskExecution;
            memoryExecution = {
              ...taskExecution,
              agentId: context.agentId,
              // The logical step identity stays stable even if a regenerated model
              // response changes title/category/content; the arguments hash then
              // detects the conflict instead of overwriting a committed write.
              operationKey: hashText(`${taskExecution.taskId}:side-effect:${taskExecution.operationIndex}`),
              argumentsHash: hashText(stableJson(args)),
            };
          }
          const memoryResult = await executeMemoryTool(name, rawArguments, memoryExecution);
          if (memoryResult) return memoryResult as ToolExecutionResult;
          throw new Error(`Memory tool did not handle registered tool: ${name}`);
        }

        if (WORKSPACE_TOOL_NAMES.includes(name as ToolName)) {
          executionStarted = TOOL_REPLAY_CLASS[name as ToolName] !== "safe-replay";
          const taskExecution = context.kind === "agent" ? context.taskExecution : undefined;
          const workspaceExecution = executionStarted && context.kind === "agent" && taskExecution
            ? {
                ...taskExecution,
                agentId: context.agentId,
                operationKey: hashText(`${taskExecution.taskId}:side-effect:${taskExecution.operationIndex}`),
                argumentsHash: hashText(stableJson(args)),
              }
            : undefined;
          const workspaceResult = await executeWorkspaceTool(name, rawArguments, workspaceExecution);
          if (workspaceResult) {
            const normalized = workspaceResult as ToolExecutionResult;
            return {
              ...normalized,
              status: normalized.status ?? (normalized.ok ? "succeeded" : (executionStarted ? "outcome_unknown" : "failed")),
            };
          }
          throw new Error(`Workspace tool did not handle registered tool: ${name}`);
        }

        throw new Error(`Tool not registered: ${name}`);
      }
    }

    throwIfAborted(context.signal);
    return { ok: true, status: "succeeded", tool: name, result };
  } catch (error) {
    const replayClass = TOOL_REPLAY_CLASS[name as ToolName];
    const status: ToolExecutionStatus = executionStarted && replayClass && replayClass !== "safe-replay"
      ? "outcome_unknown"
      : "failed";
    return {
      ok: false,
      status,
      tool: name,
      error: error instanceof Error
        ? error.message
        : "Unknown tool execution error.",
    };
  }
}
