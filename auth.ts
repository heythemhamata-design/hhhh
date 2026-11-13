import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export const SESSION_COOKIE_NAME = "monster_ai_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export type AdminSession = {
  sub: "admin";
  iat: number;
  exp: number;
  nonce: string;
};

function getAuthSecret(): Buffer | null {
  const value = process.env.MONSTER_AUTH_SECRET;
  if (!value || value.length < 64) return null;
  return Buffer.from(value, "utf8");
}

function sign(payload: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function isAuthConfigured(): boolean {
  const hash = process.env.MONSTER_ADMIN_PASSWORD_HASH;
  return Boolean(getAuthSecret() && hash && hash.startsWith("scrypt$"));
}

export function verifyAdminPassword(password: string): boolean {
  const stored = process.env.MONSTER_ADMIN_PASSWORD_HASH;
  if (!stored || password.length === 0) return false;

  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  if (!/^[a-f0-9]{32,128}$/i.test(parts[1]) || !/^[a-f0-9]{128}$/i.test(parts[2])) {
    return false;
  }

  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const actual = scryptSync(password, salt, expected.length, {
      N: 16_384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createSessionToken(nowSeconds = Math.floor(Date.now() / 1000)): string {
  const secret = getAuthSecret();
  if (!secret) throw new Error("MONSTER_AUTH_SECRET is not configured.");

  const session: AdminSession = {
    sub: "admin",
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString("hex"),
  };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(
  token: string | undefined | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): AdminSession | null {
  if (!token || token.length > 2_048) return null;
  const secret = getAuthSecret();
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    return null;
  }

  const expectedSignature = Buffer.from(sign(payload, secret), "base64url");
  const receivedSignature = Buffer.from(signature, "base64url");
  if (
    expectedSignature.length !== receivedSignature.length ||
    !timingSafeEqual(expectedSignature, receivedSignature)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<AdminSession>;
    if (
      decoded.sub !== "admin" ||
      typeof decoded.iat !== "number" ||
      typeof decoded.exp !== "number" ||
      typeof decoded.nonce !== "string" ||
      decoded.nonce.length !== 32 ||
      decoded.iat > nowSeconds + 60 ||
      decoded.exp <= nowSeconds ||
      decoded.exp <= decoded.iat ||
      decoded.exp - decoded.iat > SESSION_TTL_SECONDS
    ) {
      return null;
    }
    return decoded as AdminSession;
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.MONSTER_COOKIE_SECURE === "true",
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const configuredOrigin = process.env.MONSTER_APP_ORIGIN;

  if (!origin || !configuredOrigin) return false;

  try {
    const actual = new URL(origin);
    const expected = new URL(configuredOrigin);

    if (
      !["http:", "https:"].includes(expected.protocol) ||
      expected.pathname !== "/" ||
      expected.search ||
      expected.hash
    ) {
      return false;
    }

    return actual.origin === expected.origin;
  } catch {
    return false;
  }
}
