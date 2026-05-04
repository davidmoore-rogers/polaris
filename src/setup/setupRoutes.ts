/**
 * src/setup/setupRoutes.ts — API endpoints for first-run setup wizard
 */

import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import pg from "pg";
import { markSetupComplete } from "./detectSetup.js";
import { hashPassword } from "../utils/password.js";
import { ENV_FILE } from "../utils/paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const router = Router();

const DbConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  username: z.string().min(1),
  password: z.string(),
  database: z.string().min(1),
  ssl: z.boolean().default(false),
  sslAllowSelfSigned: z.boolean().default(false),
});

type DbConfig = z.infer<typeof DbConfigSchema>;

function buildPgClientOptions(db: DbConfig, database: string): pg.ClientConfig {
  // No sslmode in the connection string — pg-connection-string parses it into
  // its own ssl options that conflict with the explicit `ssl` field below in
  // a version-dependent way. Carrying TLS settings on the explicit field only
  // is unambiguous.
  const connectionString = `postgresql://${encodeURIComponent(db.username)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${database}`;
  const opts: pg.ClientConfig = { connectionString, connectionTimeoutMillis: 8000 };
  if (db.ssl) {
    opts.ssl = db.sslAllowSelfSigned ? { rejectUnauthorized: false } : true;
  }
  return opts;
}

const passwordSchema = z.string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number")
  .regex(/[^a-zA-Z0-9]/, "Password must contain a special character");

const FinalizeSchema = z.object({
  db: DbConfigSchema,
  admin: z.object({
    username: z.string().min(1).max(64),
    password: passwordSchema,
  }),
  app: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    sessionSecret: z.string().min(16),
  }),
});

function buildConnectionString(db: DbConfig): string {
  const encoded = encodeURIComponent(db.password);
  const base = `postgresql://${encodeURIComponent(db.username)}:${encoded}@${db.host}:${db.port}/${db.database}`;
  if (!db.ssl) return base;
  // sslmode=no-verify keeps TLS but skips cert validation — recognized by
  // node-postgres (the driver used by @prisma/adapter-pg at runtime).
  return `${base}?sslmode=${db.sslAllowSelfSigned ? "no-verify" : "require"}`;
}

// GET /api/setup/status
router.get("/status", (_req, res) => {
  res.json({ needsSetup: true });
});

// POST /api/setup/generate-secret
router.post("/generate-secret", (_req, res) => {
  res.json({ secret: randomBytes(32).toString("hex") });
});

// POST /api/setup/test-connection
router.post("/test-connection", async (req, res) => {
  try {
    const db = DbConfigSchema.parse(req.body);

    // Connect to the postgres default database to test server connectivity
    const client = new pg.Client(buildPgClientOptions(db, "postgres"));
    await client.connect();

    // Check PostgreSQL version
    const versionResult = await client.query("SELECT version()");
    const version = versionResult.rows[0]?.version || "Unknown";

    // Check if target database exists
    const dbCheck = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [db.database],
    );
    const dbExists = (dbCheck.rowCount ?? 0) > 0;

    await client.end();

    res.json({
      ok: true,
      version,
      databaseExists: dbExists,
      message: dbExists
        ? `Connected — ${version.split(",")[0]}`
        : `Connected — database "${db.database}" will be created during setup`,
    });
  } catch (err: any) {
    const msg = err.code === "ECONNREFUSED"
      ? `Connection refused — ${req.body.host}:${req.body.port}`
      : err.code === "ENOTFOUND"
      ? `Host not found — ${req.body.host}`
      : err.code === "ETIMEDOUT"
      ? `Connection timed out — ${req.body.host}:${req.body.port}`
      : err.code === "28P01"
      ? "Authentication failed — check username and password"
      : err.message || "Connection failed";
    res.json({ ok: false, message: msg });
  }
});

// POST /api/setup/finalize
router.post("/finalize", async (req, res) => {
  try {
    const { db, admin, app } = FinalizeSchema.parse(req.body);

    // Safety: don't overwrite existing working config
    if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0) {
      return res.status(409).json({ ok: false, message: "Application is already configured" });
    }

    // Step 1: Create database if it doesn't exist
    const serverClient = new pg.Client(buildPgClientOptions(db, "postgres"));
    await serverClient.connect();

    const dbCheck = await serverClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [db.database],
    );
    if ((dbCheck.rowCount ?? 0) === 0) {
      // Use double-quote escaping for the database name
      const safeName = db.database.replace(/"/g, '""');
      await serverClient.query(`CREATE DATABASE "${safeName}"`);
    }
    await serverClient.end();

    // Step 2: Write .env file
    //
    // We emit the variables the wizard collected as live values, AND the
    // common optional ones as commented-out documentation so operators
    // can find them without having to consult .env.example. Keep the
    // commented blocks in sync with .env.example.
    const databaseUrl = buildConnectionString(db);
    const envContent = [
      "# Polaris — Application Configuration",
      "# Generated by first-run setup wizard. Edit and restart Polaris",
      "# to apply changes.",
      "",
      "# Database",
      `DATABASE_URL=${databaseUrl}`,
      "",
      "# App",
      `PORT=${app.port}`,
      "NODE_ENV=production",
      "LOG_LEVEL=info",
      "",
      "# Session secret — required when NODE_ENV=production (server refuses",
      "# to boot without it). Regenerate with `openssl rand -hex 64` if you",
      "# need to invalidate every active session.",
      `SESSION_SECRET=${app.sessionSecret}`,
      "",
      "# Reverse-proxy trust — leave UNSET when the app is exposed directly",
      "# to the internet. Setting this while not behind a proxy lets clients",
      "# spoof their IP via X-Forwarded-For and bypass the login rate limiter.",
      "# Enable only when running behind nginx/Caddy/Cloudflare/an ALB/etc:",
      "#   TRUST_PROXY=1              # trust the nearest one hop",
      "#   TRUST_PROXY=loopback       # trust 127.0.0.1 / ::1",
      "#   TRUST_PROXY=10.0.0.0/8     # trust a specific CIDR",
      "# See https://expressjs.com/en/guide/behind-proxies.html",
      "# TRUST_PROXY=",
      "",
      "# Health check token — when set, /health requires",
      "# `Authorization: Bearer <token>`. Leave unset on private deployments;",
      "# set a long random value when Polaris is public-facing and you want",
      "# to limit health pings to your own monitoring.",
      "# HEALTH_TOKEN=",
      "",
    ].join("\n");

    mkdirSync(dirname(ENV_FILE), { recursive: true });
    writeFileSync(ENV_FILE, envContent, "utf-8");

    // Step 3: Set DATABASE_URL in current process so Prisma can use it
    process.env.DATABASE_URL = databaseUrl;
    process.env.PORT = String(app.port);
    process.env.SESSION_SECRET = app.sessionSecret;

    // Step 4: Run Prisma migrations
    const projectRoot = resolve(__dirname, "..", "..");
    try {
      execSync("npx prisma migrate deploy", {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
        timeout: 120000,
      });
    } catch (migrateErr: any) {
      const stderr = migrateErr.stderr?.toString() || migrateErr.message;
      return res.status(500).json({
        ok: false,
        step: "migrations",
        message: `Database migration failed: ${stderr.slice(0, 500)}`,
      });
    }

    // Step 5: Create admin user via raw pg
    const appClient = new pg.Client(buildPgClientOptions(db, db.database));
    await appClient.connect();

    const passwordHash = await hashPassword(admin.password);
    // Column names: password_hash and auth_provider are @map()'d to snake_case
    // in the Prisma schema; createdAt and updatedAt are not, so they're
    // generated as quoted camelCase columns. updatedAt has no DB default
    // (Prisma sets it on every write at the application layer), so we have
    // to supply NOW() explicitly here.
    await appClient.query(
      `INSERT INTO users (id, username, password_hash, role, auth_provider, "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'admin', 'local', NOW())
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, role = 'admin', "updatedAt" = NOW()`,
      [admin.username, passwordHash],
    );
    await appClient.end();

    // Write the setup-complete marker so future boots refuse to show the
    // wizard even if .env is deleted or DATABASE_URL is cleared.
    markSetupComplete();

    res.json({ ok: true, message: "Setup complete. The application is restarting." });

    // Step 6: Restart the process after response flushes
    setTimeout(() => {
      process.exit(0);
    }, 1500);
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ ok: false, message: "Invalid input", errors: err.errors });
    }
    res.status(500).json({ ok: false, message: err.message || "Setup failed" });
  }
});

export default router;
