import { Pool } from "pg";

type MonsterGlobal = typeof globalThis & {
  __monsterAiPostgresPool?: Pool;
};

const globalForPostgres = globalThis as MonsterGlobal;

/**
 * Lazily create one PostgreSQL pool per Node.js process.
 * The global cache prevents Next.js development hot reloads from creating
 * a new pool on every module reload.
 */
export function getPostgresPool(): Pool {
  if (globalForPostgres.__monsterAiPostgresPool) {
    return globalForPostgres.__monsterAiPostgresPool;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not configured. Add it to the server environment before using persistent memory.",
    );
  }

  const requestedMax = Number.parseInt(
    process.env.MONSTER_DB_POOL_MAX ?? "5",
    10,
  );
  const max = Number.isFinite(requestedMax)
    ? Math.max(1, Math.min(requestedMax, 10))
    : 5;

  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    application_name: "monster-ai-command-center",
  });

  pool.on("error", (error: Error) => {
    // Do not log connection strings or credentials.
    console.error("Unexpected idle PostgreSQL client error:", error.message);
  });

  globalForPostgres.__monsterAiPostgresPool = pool;
  return pool;
}
