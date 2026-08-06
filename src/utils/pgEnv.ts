/**
 * src/utils/pgEnv.ts — turn a PostgreSQL connection URL into libpq PG* env vars.
 *
 * Why this exists: `pg_dump` and `psql` used to receive the connection string as
 * a command-line argument. Two problems with that, both real:
 *
 *   1. The full URL — password included — is visible in the process table to
 *      every local user (`ps aux`), and lands in any process listing, audit
 *      trail, or core dump for the duration of the dump.
 *   2. The backup route built the command as an interpolated shell string, so
 *      the same URL also reached a shell, and Node's child_process error message
 *      is literally `Command failed: <the whole command>`. That message was
 *      being concatenated into an AppError and returned in the HTTP response.
 *
 * libpq reads PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE / PGSSLMODE
 * from the environment, so passing them that way keeps the credential out of
 * argv entirely while changing nothing about how the tools connect.
 *
 * Pure and dependency-free so it can be unit-tested without a database.
 */

import { AppError } from "./errors.js";

export interface PgEnv {
  PGHOST: string;
  PGPORT: string;
  PGUSER: string;
  PGPASSWORD: string;
  PGDATABASE: string;
  PGSSLMODE?: string;
  /** Set only when the URL pins a non-default schema (Prisma's `?schema=`). */
  PGOPTIONS?: string;
}

/**
 * Parse a `postgresql://user:pass@host:port/db?params` URL into the PG* overlay.
 *
 * Handles the shapes Polaris actually produces and accepts:
 *   - percent-encoded credentials (a password with `@`, `/` or `:` in it)
 *   - the `postgres://` scheme alias
 *   - Prisma's extra query params (`schema`, `connection_limit`, `pgbouncer`,
 *     `sslmode`) — only `schema` and `sslmode` mean anything to libpq
 *   - a missing port (defaults to 5432)
 *
 * Throws AppError 500 on an unusable URL rather than returning a half-built
 * environment that would make pg_dump fail with something inscrutable.
 */
export function pgEnvFromDatabaseUrl(rawUrl: string): PgEnv {
  if (!rawUrl) {
    throw new AppError(500, "No database URL is configured (DATABASE_URL / POLARIS_DB_DIRECT_URL)");
  }

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new AppError(500, "The configured database URL could not be parsed");
  }

  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") {
    throw new AppError(500, `Unsupported database URL scheme "${u.protocol.replace(":", "")}"`);
  }

  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!database) {
    throw new AppError(500, "The configured database URL does not name a database");
  }

  const env: PgEnv = {
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database,
  };

  const sslmode = u.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;

  // Prisma's `?schema=` sets the search_path for application queries. libpq has
  // no equivalent variable, but PGOPTIONS is forwarded as backend options, and
  // `-c search_path=` is how psql/pg_dump are pointed at a non-public schema.
  const schema = u.searchParams.get("schema");
  if (schema && schema !== "public") env.PGOPTIONS = `-c search_path=${schema}`;

  return env;
}

/**
 * Build the full child-process environment for a pg_dump / psql / pg_restore
 * invocation: the current environment with the PG* overlay applied.
 *
 * Any PG* variable already present in process.env is deliberately overwritten —
 * the URL is the source of truth, and a stray inherited PGDATABASE silently
 * dumping the wrong database is exactly the failure this prevents.
 */
export function pgChildEnv(rawUrl: string): NodeJS.ProcessEnv {
  return { ...process.env, ...pgEnvFromDatabaseUrl(rawUrl) };
}

/**
 * Redact the password from a connection URL so it can appear in a log line.
 * Never use the raw URL in an operator-facing message.
 */
export function redactDatabaseUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable database URL>";
  }
}
