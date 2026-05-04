/**
 * src/setup/setupRoutes.ts — API endpoints for first-run setup wizard
 */

import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { statfs, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import pg from "pg";
import { markSetupComplete } from "./detectSetup.js";
import { hashPassword } from "../utils/password.js";
import { ENV_FILE, STATE_DIR } from "../utils/paths.js";

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

// POST /api/setup/preflight — runs after the operator picks a DB host but
// before finalize. Returns disk-free info for every volume Polaris will write
// to (state dir + app dir) and, when the DB host is localhost, the
// conventional PostgreSQL data directory candidates so the wizard can warn
// "your /var is only 8 GB, this is going to bite you in 6 months."
//
// Cross-platform via node:fs/promises — RHEL, Ubuntu, Windows all return
// usable statfs data. PostgreSQL's actual `data_directory` isn't available
// here (we haven't connected yet), so we walk a list of conventional paths
// per platform and report the first one that exists. The runtime
// `capacityService` resolves PGDATA authoritatively via `SHOW data_directory`
// once the DB connection is up.
const PG_DATA_DIR_CANDIDATES: string[] = process.platform === "win32"
  ? [
      "C:\\Program Files\\PostgreSQL\\17\\data",
      "C:\\Program Files\\PostgreSQL\\16\\data",
      "C:\\Program Files\\PostgreSQL\\15\\data",
      "C:\\Program Files\\PostgreSQL\\14\\data",
      "C:\\Program Files\\PostgreSQL\\13\\data",
    ]
  : [
      "/var/lib/pgsql/data",
      "/var/lib/pgsql/17/data",
      "/var/lib/pgsql/16/data",
      "/var/lib/pgsql/15/data",
      "/var/lib/postgresql/17/main",
      "/var/lib/postgresql/16/main",
      "/var/lib/postgresql/15/main",
      "/var/lib/postgresql/14/main",
    ];

const PreflightSchema = z.object({
  dbHost: z.string().min(1).optional(),
});

// Recommended minimums. Below these, the wizard surfaces a warning but
// doesn't block — the operator may know a layout the heuristic doesn't.
// 50 GB DB volume covers a ~1000-asset deployment on default retention with
// 6 months of headroom; 5 GB app/state gets through a couple of update cycles
// (each update copies the new bundle, then verifies, then swaps).
const RECOMMENDED_DB_FREE_GB = 50;
const RECOMMENDED_APP_FREE_GB = 5;

interface PreflightVolume {
  role: "app" | "state" | "db";
  path: string;
  freeBytes: number;
  totalBytes: number;
  freePct: number;
  recommendedMinFreeGb: number;
  meetsRecommendation: boolean;
  notes: string | null;
}

async function statfsForPreflight(role: PreflightVolume["role"], path: string, recommendedMinFreeGb: number): Promise<PreflightVolume | null> {
  try {
    const fs = await statfs(path);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    const totalBytes = Number(fs.blocks) * Number(fs.bsize);
    const freePct = totalBytes > 0 ? freeBytes / totalBytes : 1;
    const minFreeBytes = recommendedMinFreeGb * 1024 ** 3;
    return {
      role,
      path,
      freeBytes,
      totalBytes,
      freePct,
      recommendedMinFreeGb,
      meetsRecommendation: freeBytes >= minFreeBytes,
      notes: null,
    };
  } catch {
    return null;
  }
}

async function pickFirstExistingPath(candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    try {
      await stat(p);
      return p;
    } catch {
      // not present, keep going
    }
  }
  return null;
}

router.post("/preflight", async (req, res) => {
  try {
    const { dbHost } = PreflightSchema.parse(req.body || {});

    const isLocal = dbHost
      ? ["localhost", "127.0.0.1", "::1", ""].includes(dbHost.toLowerCase().trim())
      : true;

    const out: PreflightVolume[] = [];

    // App + state volumes (almost always the same on a default install where
    // POLARIS_STATE_DIR is unset; getVolumes-style dedupe by stat.dev would
    // collapse them at runtime, but for a one-shot wizard pass we keep them
    // separate so the operator sees both paths labeled).
    const appProbe = await statfsForPreflight("app", resolve(__dirname, "..", ".."), RECOMMENDED_APP_FREE_GB);
    if (appProbe) out.push(appProbe);
    const stateProbe = await statfsForPreflight("state", STATE_DIR, RECOMMENDED_APP_FREE_GB);
    if (stateProbe) out.push(stateProbe);

    let dbCandidatePath: string | null = null;
    let dbProbe: PreflightVolume | null = null;
    if (isLocal) {
      dbCandidatePath = await pickFirstExistingPath(PG_DATA_DIR_CANDIDATES);
      if (dbCandidatePath) {
        dbProbe = await statfsForPreflight("db", dbCandidatePath, RECOMMENDED_DB_FREE_GB);
        if (dbProbe) out.push(dbProbe);
      }
    }

    // Dedupe by (freeBytes,totalBytes) heuristic (statfs doesn't surface
    // device id portably enough here; identical free+total on the same host
    // means same filesystem in practice).
    const seen = new Set<string>();
    const deduped: PreflightVolume[] = [];
    for (const v of out) {
      const key = `${v.freeBytes}|${v.totalBytes}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(v);
    }

    const warnings: string[] = [];
    for (const v of deduped) {
      if (!v.meetsRecommendation) {
        const gb = (v.freeBytes / 1024 ** 3).toFixed(1);
        warnings.push(
          v.role === "db"
            ? `Database volume (${v.path}) has only ${gb} GB free — recommended ≥ ${v.recommendedMinFreeGb} GB. Sample tables grow with monitored asset count and retention; you may run out of space within months.`
            : `${v.role === "app" ? "Application" : "State"} volume (${v.path}) has only ${gb} GB free — recommended ≥ ${v.recommendedMinFreeGb} GB. Backups and update rollback both need headroom.`,
        );
      }
    }

    if (isLocal && !dbCandidatePath) {
      warnings.push(
        "PostgreSQL data directory could not be located via the standard paths — disk-free check on the DB volume was skipped. The runtime check will catch it once the DB connection is established.",
      );
    }
    if (!isLocal) {
      warnings.push(
        `Database host (${dbHost}) is not local — disk-free check on the DB volume was skipped. Make sure the DB host has at least ${RECOMMENDED_DB_FREE_GB} GB free on its data volume before completing setup.`,
      );
    }

    res.json({
      ok: warnings.length === 0,
      isDbLocal: isLocal,
      volumes: deduped,
      warnings,
      recommendedDbFreeGb: RECOMMENDED_DB_FREE_GB,
      recommendedAppFreeGb: RECOMMENDED_APP_FREE_GB,
    });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ ok: false, message: "Invalid input", errors: err.errors });
    }
    res.status(500).json({ ok: false, message: err.message || "Preflight check failed" });
  }
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
