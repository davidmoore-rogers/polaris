/**
 * src/api/routes/serverSettings.ts — NTP and certificate management endpoints
 */

import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { execSync, spawn } from "node:child_process";
import { gzipSync, createGunzip } from "node:zlib";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  X509Certificate,
  createPrivateKey,
} from "node:crypto";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync, createReadStream, openSync, readSync, closeSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { totalmem } from "node:os";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getNtpSettings,
  updateNtpSettings,
  testNtpSync,
  listCertificates,
  addCertificate,
  deleteCertificate,
} from "../../services/serverSettingsService.js";
import { getDnsSettings, updateDnsSettings, createResolver } from "../../services/dnsService.js";
import type { DnsSettings } from "../../services/dnsService.js";
import { getOuiStatus, refreshOuiDatabase, getOuiOverrides, setOuiOverride, deleteOuiOverride, lookupOuiDetailed } from "../../services/ouiService.js";
import { getDashSettings, saveDashSettings } from "../../services/dashSettingsService.js";
import { requirePermission } from "../middleware/permissions.js";
import { logEvent } from "./events.js";
import {
  normalizeCriteria,
  reconcileTag,
  previewTagCriteria,
  stripTagAssignments,
} from "../../services/tagAssignmentService.js";
import { setEnvVar } from "../../utils/envFile.js";
import {
  checkForUpdates,
  applyUpdate,
  getUpdateStatus,
  clearUpdateStatus,
  initUpdateStatus,
  isUpdateMechanismAvailable,
  getRecentCommits,
  getUpdateRepoInfo,
  getUpdateTrain,
  setUpdateTrain,
  restartService,
} from "../../services/updateService.js";
import { getPublicUrlPort } from "../../utils/publicUrl.js";
import { validateBackupPassword } from "../../utils/backupPassword.js";
import { getServerCertFingerprint, getServerCertHostnames, getServerCertExpiry } from "../../services/certInfo.js";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { hasActiveDiscoveries } from "./integrations.js";
import { logger } from "../../utils/logger.js";
import { Prisma } from "../../generated/prisma/client.js";
import { getCapacitySnapshot, recordCapacityTransition } from "../../services/capacityService.js";
import { getSampleRetention, updateSampleRetention } from "../../services/sampleRetentionService.js";
import { getAgentEventLogConfig, updateAgentEventLogConfig } from "../../services/osEventLogService.js";
import {
  getBootTimeMode,
  getQueueMode,
  setQueueMode,
  isPgbossInstalled,
} from "../../services/queueService.js";
import { BACKUP_DIR, UPLOADS_DIR } from "../../utils/paths.js";
import { maintenanceLimiter } from "../middleware/rateLimits.js";
import { getAppVersion } from "../../utils/version.js";
import { getDirectDatabaseUrl } from "../../utils/dbConnections.js";
import { isTimescaleAvailable } from "../../services/timescaleService.js";

const TAG_COLORS = ["#4fc3f7","#4ade80","#f59e0b","#f472b6","#a78bfa","#fb923c","#38bdf8","#34d399","#e879f9","#facc15","#f87171","#2dd4bf","#818cf8","#c084fc"];
function randomTagColor() { return TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)]; }

function bufferToPem(buf: Buffer, filename: string): string {
  const text = buf.toString("utf-8");
  if (text.includes("-----BEGIN ")) return text;

  const isKey = filename.endsWith(".key");
  const label = isKey ? "PRIVATE KEY" : "CERTIFICATE";
  const b64 = buf.toString("base64");
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function validatePem(pem: string, filename: string): void {
  const isKey = filename.endsWith(".key");
  try {
    if (isKey) {
      createPrivateKey(pem);
    } else {
      new X509Certificate(pem);
    }
  } catch {
    throw new AppError(400, isKey ? "File is not a valid PEM private key" : "File is not a valid PEM certificate");
  }
}

function detectImageMagic(buf: Buffer): ".png" | ".jpg" | ".webp" | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return ".jpg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return null;
}

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });
// Disk storage so large backups aren't buffered in memory
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpdir()),
    filename: (_req, _file, cb) => cb(null, `polaris-restore-upload-${Date.now()}`),
  }),
});

const APP_VERSION: string = getAppVersion();

// ─── Database ──────────────────────────────────────────────────────────────

interface DbTableRow { name: string; rows: bigint; size: string; sort_pages: bigint }

// Public-schema ordinary tables, sized by catalog `relpages` (heap + indexes) —
// instant, unlike the pg_*_size() helpers that stat() every relfilenode.
// Parent-only: for a TimescaleDB hypertable the parent's own relpages are ~0
// (the data lives in chunk relations under _timescaledb_internal), so a
// hypertable sorts to the bottom at ~0 size. Used only as the fallback.
const PLAIN_TABLES_SQL = `
  SELECT
    c.relname AS name,
    COALESCE(s.n_live_tup, 0)::bigint AS rows,
    pg_size_pretty(
      (c.relpages + COALESCE(ti.relpages, 0))::bigint * current_setting('block_size')::bigint
    ) AS size,
    (c.relpages + COALESCE(ti.relpages, 0))::bigint AS sort_pages
  FROM pg_class c
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  LEFT JOIN LATERAL (
    SELECT SUM(i.relpages)::bigint AS relpages
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid = c.oid
  ) ti ON true
  WHERE c.relkind = 'r'
    AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ORDER BY sort_pages DESC
`;

// Chunk-aware variant: folds every hypertable's chunk relations — both the
// uncompressed chunks AND the compressed chunks (attributed back to the user
// hypertable via `compressed_hypertable_id`) — into the parent's size + row
// count, so hypertables appear in the list at their real on-disk footprint.
// Still catalog-only (SUM of relpages over pg_class), so it stays instant. The
// chunk-name join to pg_class naturally drops already-dropped chunks.
const CHUNK_AWARE_TABLES_SQL = `
  WITH ht AS (
    SELECT id, table_name, compressed_hypertable_id
    FROM _timescaledb_catalog.hypertable
  ),
  chunk_rel AS (
    SELECT
      COALESCE(userht.table_name, ownerht.table_name) AS user_table,
      -- true when ch is a compressed chunk (owned by an internal compression
      -- hypertable that a user hypertable points at via compressed_hypertable_id)
      (userht.id IS NOT NULL) AS is_compressed_chunk,
      ch.schema_name AS chunk_schema,
      ch.table_name  AS chunk_table
    FROM _timescaledb_catalog.chunk ch
    JOIN ht ownerht ON ownerht.id = ch.hypertable_id
    LEFT JOIN ht userht ON userht.compressed_hypertable_id = ownerht.id
  ),
  chunk_class AS (
    SELECT cr.user_table, cr.is_compressed_chunk, cls.oid, cls.relpages
    FROM chunk_rel cr
    JOIN pg_namespace ns ON ns.nspname = cr.chunk_schema
    JOIN pg_class cls ON cls.relname = cr.chunk_table AND cls.relnamespace = ns.oid
  ),
  chunk_sizes AS (
    SELECT
      cc.user_table,
      SUM(cc.relpages)::bigint AS heap_pages,
      -- Logical rows from uncompressed chunks only: a compressed chunk's
      -- n_live_tup is its batch count (~1 row per 1000 logical rows) and would
      -- badly understate the total. Bytes above are counted for both.
      COALESCE(SUM(CASE WHEN cc.is_compressed_chunk THEN 0 ELSE s.n_live_tup END), 0)::bigint AS rows,
      COALESCE(SUM(idx.pages), 0)::bigint AS index_pages
    FROM chunk_class cc
    LEFT JOIN pg_stat_user_tables s ON s.relid = cc.oid
    LEFT JOIN LATERAL (
      SELECT SUM(i.relpages)::bigint AS pages
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
      WHERE x.indrelid = cc.oid
    ) idx ON true
    GROUP BY cc.user_table
  )
  SELECT
    c.relname AS name,
    (COALESCE(s.n_live_tup, 0) + COALESCE(cz.rows, 0))::bigint AS rows,
    pg_size_pretty(
      (c.relpages + COALESCE(ti.relpages, 0) + COALESCE(cz.heap_pages, 0) + COALESCE(cz.index_pages, 0))::bigint
        * current_setting('block_size')::bigint
    ) AS size,
    (c.relpages + COALESCE(ti.relpages, 0) + COALESCE(cz.heap_pages, 0) + COALESCE(cz.index_pages, 0))::bigint AS sort_pages
  FROM pg_class c
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  LEFT JOIN LATERAL (
    SELECT SUM(i.relpages)::bigint AS relpages
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid = c.oid
  ) ti ON true
  LEFT JOIN chunk_sizes cz ON cz.user_table = c.relname
  WHERE c.relkind = 'r'
    AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ORDER BY sort_pages DESC
`;

// Chunk-aware when TimescaleDB is present; falls back to parent-only sizing when
// it isn't installed or the internal catalog shape is unreadable (version drift)
// so the Database card never breaks.
async function queryDatabaseTables(): Promise<DbTableRow[]> {
  if (isTimescaleAvailable()) {
    try {
      return await prisma.$queryRawUnsafe<DbTableRow[]>(CHUNK_AWARE_TABLES_SQL);
    } catch (err) {
      logger.warn({ err }, "database_tables.chunk_aware_query_failed; falling back to parent-only sizing");
    }
  }
  return prisma.$queryRawUnsafe<DbTableRow[]>(PLAIN_TABLES_SQL);
}

router.get("/database", async (_req, res, next) => {
  try {
    // Fan out every stat query in parallel. The previous serial chain ran each
    // await in turn, but the real problem was that pg_database_size() and the
    // per-table pg_total_relation_size() iteration were inherently minutes-slow
    // at prod scale — TimescaleDB hypertables (asset_monitor_samples, the five
    // *_hourly + *_daily rollups, etc.) decompose into thousands of chunk
    // relations, and each pg_*_size() helper stat()'s every relfilenode behind
    // them. We now read sizes from `pg_class.relpages * block_size` instead:
    // it's a catalog-only sum that lives in shared buffers, returns instantly,
    // and is updated by autovacuum so values are accurate as of the last
    // ANALYZE (minute-scale lag is acceptable for an operator dashboard).
    //
    // The pg_stat_ssl query keys on pg_backend_pid() of the BACKEND running
    // that statement; under direct-connect (no PgBouncer in transaction mode)
    // each parallel query picks its own pooled backend and the lookup still
    // resolves correctly because every backend shares the same SSL config.
    //
    // Public-schema filter on the table list: pg-boss's `pgboss.*` tables
    // and TimescaleDB's `_timescaledb_internal.*` chunks would otherwise
    // flood the operator-facing list. Each hypertable's chunks (uncompressed +
    // compressed) are folded back into its parent row by queryDatabaseTables()
    // so hypertables show their real footprint; the same chunk bytes are also
    // counted toward the database-size total via the catalog sum below.
    const [
      versionResult,
      dbNameResult,
      sizeResult,
      tablesResult,
      connResult,
      uptimeResult,
      sslResult,
    ] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>("SELECT version()"),
      prisma.$queryRawUnsafe<any[]>("SELECT current_database() AS db"),
      prisma.$queryRawUnsafe<any[]>(`
        SELECT pg_size_pretty(
          current_setting('block_size')::bigint * SUM(relpages::bigint)
        ) AS size
        FROM pg_class
        WHERE relkind IN ('r', 'i', 't', 'm')
      `),
      queryDatabaseTables(),
      prisma.$queryRawUnsafe<any[]>(`
        SELECT
          (SELECT count(*)::integer FROM pg_stat_activity WHERE datname = current_database()) AS active,
          (SELECT setting::integer FROM pg_settings WHERE name = 'max_connections') AS max
      `),
      prisma.$queryRawUnsafe<any[]>(
        "SELECT date_trunc('second', current_timestamp - pg_postmaster_start_time())::text AS uptime"
      ),
      prisma.$queryRawUnsafe<{ ssl: boolean }[]>(
        "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
      ),
    ]);

    const version = versionResult[0]?.version || "Unknown";
    const dbName = dbNameResult[0]?.db || "unknown";
    const databaseSize = sizeResult[0]?.size || "Unknown";
    const tables = tablesResult.map((t: any) => ({
      name: t.name,
      rows: Number(t.rows),
      size: t.size,
    }));
    const activeConnections = Number(connResult[0]?.active || 0);
    const maxConnections = Number(connResult[0]?.max || 100);
    const uptime = uptimeResult[0]?.uptime || "Unknown";

    // Parse version string to extract short version
    const versionMatch = version.match(/PostgreSQL\s+([\d.]+)/);
    const shortVersion = versionMatch ? versionMatch[1] : version;

    // Parse connection URL for host/port
    const connUrl = process.env.DATABASE_URL || "";
    const urlMatch = connUrl.match(/@([^:/?]+)(?::(\d+))?/);
    const host = urlMatch ? urlMatch[1] : "localhost";
    const port = urlMatch && urlMatch[2] ? parseInt(urlMatch[2], 10) : 5432;

    // Authoritative SSL state from the live backend, not the URL — `sslmode`
    // has six values (require / verify-ca / verify-full / no-verify / prefer /
    // disable) plus the legacy `ssl=true`, and "prefer" only resolves at
    // negotiation time. pg_stat_ssl reports what the connection actually did.
    const ssl = sslResult[0]?.ssl ? "Enabled" : "Disabled";

    res.json({
      type: "PostgreSQL",
      version: shortVersion,
      host,
      port,
      database: dbName,
      ssl,
      databaseSize,
      tableCount: tables.length,
      tables,
      activeConnections,
      maxConnections,
      uptime: String(uptime),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Database Backup ──────────────────────────────────────────────────────

mkdirSync(BACKUP_DIR, { recursive: true });

// Backup ids are server-generated (`bk-<ts>`), but the delete/download routes
// accept them from the URL — resolve and require containment under BACKUP_DIR
// before any filesystem access. Returns null for anything that escapes.
function backupFilePath(id: unknown): string | null {
  const p = resolve(BACKUP_DIR, String(id));
  return p.startsWith(BACKUP_DIR + sep) ? p : null;
}

router.post("/database/backup", maintenanceLimiter, async (req, res, next) => {
  try {
    // Reject empty/weak passphrases before they become an AES-256-GCM key —
    // see src/utils/backupPassword.ts + the 2026-06-03 review (M5). null = no
    // passphrase = unencrypted backup (a legitimate choice).
    let password: string | null;
    try {
      password = validateBackupPassword(req.body?.password);
    } catch (e: any) {
      throw new AppError(400, e?.message || "Invalid backup password");
    }
    // pg_dump goes direct to Postgres even under PgBouncer — the COPY-heavy
    // dump protocol doesn't proxy reliably through transaction-pool mode.
    // Falls back to DATABASE_URL when POLARIS_DB_DIRECT_URL is unset.
    const connUrl = getDirectDatabaseUrl();
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupId = `bk-${Date.now()}`;
    const filename = `polaris-backup-${APP_VERSION}-${ts}${password ? ".enc" : ""}.gz`;
    const tmpFile = join(tmpdir(), `polaris-dump-${Date.now()}.sql`);

    try {
      execSync(`pg_dump "${connUrl}" --no-owner --no-acl --clean --if-exists -f "${tmpFile}"`, {
        timeout: 120000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      throw new AppError(500, "pg_dump failed: " + (err.stderr?.toString() || err.message));
    }

    let payload = readFileSync(tmpFile);
    try { unlinkSync(tmpFile); } catch {}

    payload = gzipSync(payload);

    if (password) {
      const salt = randomBytes(32);
      const key = scryptSync(password, salt, 32);
      const iv = randomBytes(16);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const magic = Buffer.from("POLARIS\0");
      payload = Buffer.concat([magic, salt, iv, authTag, encrypted]);
    }

    writeFileSync(join(BACKUP_DIR, backupId), payload);

    const backupRecord = {
      id: backupId,
      filename,
      size: payload.length,
      encrypted: !!password,
      createdAt: new Date().toISOString(),
    };
    const existing = await prisma.setting.findUnique({ where: { key: "backup_history" } });
    const history: any[] = existing?.value && Array.isArray(existing.value) ? existing.value as any[] : [];
    history.push(backupRecord);
    if (history.length > 50) history.splice(0, history.length - 50);
    await prisma.setting.upsert({
      where: { key: "backup_history" },
      update: { value: history },
      create: { key: "backup_history", value: history },
    });

    await logEvent({
      level: "info",
      action: "server.backup.created",
      resourceType: "backup",
      resourceId: backupId,
      resourceName: filename,
      actor: req.session?.username,
      message: `Database backup created: ${filename} (${payload.length} bytes${password ? ", encrypted" : ""})`,
    });

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", payload.length);
    res.end(payload);
  } catch (err) {
    next(err);
  }
});

router.post("/database/restore", maintenanceLimiter, restoreUpload.single("file"), async (req, res, next) => {
  // Track upload temp file for cleanup regardless of outcome. multer's
  // diskStorage generates the temp name itself, but the path rides in on
  // req.file — require containment under tmpdir() before touching it.
  const rawUploadedPath: string | undefined = (req.file as any)?.path;
  const uploadedPath: string | undefined =
    rawUploadedPath && resolve(rawUploadedPath).startsWith(tmpdir() + sep)
      ? resolve(rawUploadedPath)
      : undefined;
  let decryptedTempPath: string | null = null;

  try {
    if (!req.file || !uploadedPath) throw new AppError(400, "No backup file uploaded");
    if (await hasActiveDiscoveries()) throw new AppError(409, "A discovery is currently running — wait for it to finish or abort it before restoring");
    const password: string | null = req.body?.password || null;
    // psql restore goes direct — see backup-route comment above for why.
    const connUrl = getDirectDatabaseUrl();

    // Check magic bytes from disk to detect encryption without loading the whole file
    const magic = Buffer.from("POLARIS\0");
    const headerBuf = Buffer.alloc(8);
    const fd = openSync(uploadedPath!, "r");
    try { readSync(fd, headerBuf, 0, 8, 0); } finally { closeSync(fd); }
    const isEncrypted = req.file.size > 72 && headerBuf.equals(magic);

    // gzipSourcePath points to the (possibly decrypted) gzip file to stream into psql
    let gzipSourcePath = uploadedPath!;

    if (isEncrypted) {
      if (!password) throw new AppError(400, "This backup is encrypted — a password is required to restore it");
      const payload = readFileSync(uploadedPath!);
      const salt = payload.subarray(8, 40);
      const iv = payload.subarray(40, 56);
      const authTag = payload.subarray(56, 72);
      const ciphertext = payload.subarray(72);
      const key = scryptSync(password, salt, 32);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      let decrypted: Buffer;
      try {
        decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new AppError(400, "Decryption failed — incorrect password or corrupted file");
      }
      decryptedTempPath = join(tmpdir(), `polaris-restore-dec-${Date.now()}.gz`);
      writeFileSync(decryptedTempPath, decrypted);
      gzipSourcePath = decryptedTempPath;
    }

    // Stream: gzip file → gunzip → psql stdin
    // No decompressed-size cap or upload-size cap — handles arbitrarily large databases.
    const psql = spawn("psql", [connUrl, "--single-transaction"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!psql.stdin) throw new AppError(500, "Failed to open psql stdin");

    let psqlStderr = "";
    psql.stderr.on("data", (chunk: Buffer) => { psqlStderr += chunk.toString(); });

    const psqlExit = new Promise<void>((resolve, reject) => {
      psql.on("error", reject);
      psql.on("close", (code: number) => {
        if (code === 0) resolve();
        else reject(new AppError(500, `psql restore failed (exit ${code}): ${psqlStderr.slice(-500) || "no output"}`));
      });
    });

    try {
      await pipeline(createReadStream(gzipSourcePath), createGunzip(), psql.stdin);
      await psqlExit;
    } catch (err: any) {
      psql.kill();
      if (err instanceof AppError) throw err;
      throw new AppError(500, "Restore failed: " + (err.message || String(err)));
    }

    res.json({ ok: true, message: "Database restored successfully" });
  } catch (err) {
    next(err);
  } finally {
    if (decryptedTempPath) { try { unlinkSync(decryptedTempPath); } catch {} }
    if (uploadedPath) { try { unlinkSync(uploadedPath); } catch {} }
  }
});

router.get("/database/backups", maintenanceLimiter, async (_req, res, next) => {
  try {
    const existing = await prisma.setting.findUnique({ where: { key: "backup_history" } });
    const history: any[] = existing?.value && Array.isArray(existing.value) ? existing.value as any[] : [];
    const enriched = history.map((r: any) => ({ ...r, path: backupFilePath(r.id) }));
    res.json(enriched.reverse());
  } catch (err) {
    next(err);
  }
});

router.delete("/database/backups/:id", maintenanceLimiter, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const safePath = backupFilePath(id);
    if (!safePath) throw new AppError(400, "Invalid backup id");
    const existing = await prisma.setting.findUnique({ where: { key: "backup_history" } });
    const history: any[] = existing?.value && Array.isArray(existing.value) ? existing.value as any[] : [];
    const idx = history.findIndex((r: any) => r.id === id);
    if (idx === -1) throw new AppError(404, "Backup not found");

    const removed = history[idx];
    history.splice(idx, 1);
    await prisma.setting.upsert({
      where: { key: "backup_history" },
      update: { value: history },
      create: { key: "backup_history", value: history },
    });

    if (existsSync(safePath)) unlinkSync(safePath);

    await logEvent({
      level: "warning",
      action: "server.backup.deleted",
      resourceType: "backup",
      resourceId: id,
      resourceName: removed?.filename || id,
      actor: req.session?.username,
      message: `Database backup deleted: ${removed?.filename || id}`,
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.get("/database/backups/:id/download", maintenanceLimiter, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const filePath = backupFilePath(id);
    if (!filePath) throw new AppError(400, "Invalid backup id");
    const existing = await prisma.setting.findUnique({ where: { key: "backup_history" } });
    const history: any[] = existing?.value && Array.isArray(existing.value) ? existing.value as any[] : [];
    const record = history.find((r: any) => r.id === id);
    if (!record) throw new AppError(404, "Backup not found");

    if (!existsSync(filePath)) throw new AppError(404, "Backup file no longer exists on disk");

    const payload = readFileSync(filePath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${record.filename}"`);
    res.setHeader("Content-Length", payload.length);
    res.end(payload);
  } catch (err) {
    next(err);
  }
});

// ─── Tags ──────────────────────────────────────────────────────────────────

router.get("/tags", async (_req, res, next) => {
  try {
    const tags = await prisma.tag.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
    res.json(tags);
  } catch (err) {
    next(err);
  }
});

router.post("/tags", async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) throw new AppError(400, "Tag name is required");

    const existing = await prisma.tag.findUnique({ where: { name } });
    if (existing) throw new AppError(409, `Tag "${name}" already exists`);

    // Validate + normalize optional auto-assignment criteria (null = manual tag).
    const criteria = normalizeCriteria(req.body.criteria);

    const tag = await prisma.tag.create({
      data: {
        name,
        category: req.body.category || "General",
        color: req.body.color || randomTagColor(),
        criteria: criteria ? (criteria as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
    await logEvent({
      level: "info",
      action: "tag.created",
      resourceType: "tag",
      resourceId: tag.id,
      resourceName: tag.name,
      actor: req.session?.username,
      message: `Tag created: "${tag.name}" (category ${tag.category})${criteria ? ` with ${criteria.rules.length} auto-assign rule(s)` : ""}`,
    });
    // Apply criteria immediately (best-effort; the periodic job is the safety net).
    if (criteria) {
      reconcileTag(tag.id).catch((err) =>
        logger.warn({ err: err?.message ?? String(err), tagId: tag.id }, "tag create: reconcile failed"),
      );
    }
    res.status(201).json(tag);
  } catch (err) {
    next(err);
  }
});

router.get("/tags/settings", async (_req, res, next) => {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "tagSettings" } });
    res.json(row ? row.value : { enforce: false });
  } catch (err) {
    next(err);
  }
});

router.put("/tags/settings", async (req, res, next) => {
  try {
    const value = { enforce: req.body.enforce === true };
    const row = await prisma.setting.upsert({
      where: { key: "tagSettings" },
      update: { value },
      create: { key: "tagSettings", value },
    });
    await logEvent({
      level: "info",
      action: "tag.settings.updated",
      resourceType: "setting",
      resourceName: "tagSettings",
      actor: req.session?.username,
      message: `Tag enforcement ${value.enforce ? "enabled" : "disabled"}`,
    });
    res.json(row.value);
  } catch (err) {
    next(err);
  }
});

router.put("/tags/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.tag.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Tag not found");

    const name = (req.body.name ?? existing.name).trim();
    if (!name) throw new AppError(400, "Tag name is required");

    const renamed = name !== existing.name;
    if (renamed) {
      const dupe = await prisma.tag.findUnique({ where: { name } });
      if (dupe) throw new AppError(409, `Tag "${name}" already exists`);
    }

    // `criteria` only changes when the key is present in the body. Absent key =
    // leave as-is; explicit null / empty = clear (becomes a manual tag).
    const criteriaProvided = Object.prototype.hasOwnProperty.call(req.body, "criteria");
    const nextCriteria = criteriaProvided ? normalizeCriteria(req.body.criteria) : undefined;

    const tag = await prisma.tag.update({
      where: { id },
      data: {
        name,
        category: req.body.category ?? existing.category,
        color: req.body.color ?? existing.color,
        ...(criteriaProvided
          ? { criteria: nextCriteria ? (nextCriteria as unknown as Prisma.InputJsonValue) : Prisma.DbNull }
          : {}),
      },
    });

    if (renamed) {
      const oldName = existing.name;
      await Promise.all([
        prisma.$executeRaw`UPDATE ip_blocks SET tags = array_replace(tags, ${oldName}, ${name}) WHERE ${oldName} = ANY(tags)`,
        prisma.$executeRaw`UPDATE subnets SET tags = array_replace(tags, ${oldName}, ${name}) WHERE ${oldName} = ANY(tags)`,
        prisma.$executeRaw`UPDATE assets SET tags = array_replace(tags, ${oldName}, ${name}) WHERE ${oldName} = ANY(tags)`,
      ]);
    }

    await logEvent({
      level: "info",
      action: "tag.updated",
      resourceType: "tag",
      resourceId: tag.id,
      resourceName: tag.name,
      actor: req.session?.username,
      message: renamed
        ? `Tag renamed: "${existing.name}" → "${tag.name}" (rewritten across blocks/subnets/assets)`
        : `Tag updated: "${tag.name}"`,
    });

    // Re-run the managed-sync diff whenever criteria changed (or the tag was
    // renamed, since provenance is keyed by tagId but the applied string moved).
    if (criteriaProvided || renamed) {
      reconcileTag(tag.id).catch((err) =>
        logger.warn({ err: err?.message ?? String(err), tagId: tag.id }, "tag update: reconcile failed"),
      );
    }

    res.json(tag);
  } catch (err) {
    next(err);
  }
});

router.delete("/tags/:id", async (req, res, next) => {
  try {
    const tag = await prisma.tag.findUnique({ where: { id: req.params.id } });
    if (!tag) throw new AppError(404, "Tag not found");
    // Strip engine-applied copies (and their provenance) before deleting. Manual
    // copies on assets the engine never tagged are untouched — same as before.
    let stripped = 0;
    if (tag.criteria != null) {
      stripped = await stripTagAssignments(tag.id, tag.name);
    }
    await prisma.tag.delete({ where: { id: req.params.id } });
    await logEvent({
      level: "warning",
      action: "tag.deleted",
      resourceType: "tag",
      resourceId: tag.id,
      resourceName: tag.name,
      actor: req.session?.username,
      message: `Tag deleted: "${tag.name}"${stripped ? ` (removed from ${stripped} auto-assigned asset(s))` : ""}`,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Dry-run a criteria blob: how many assets match, a sample, and (when tagId is
// given) the +add / -remove delta vs. that tag's current auto-assignments.
// Drives the live preview line in the tag criteria builder.
router.post("/tags/preview-criteria", async (req, res, next) => {
  try {
    const tagId = typeof req.body.tagId === "string" ? req.body.tagId : undefined;
    const preview = await previewTagCriteria(req.body.criteria, tagId);
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

// ─── NTP ────────────────────────────────────────────────────────────────────

router.get("/ntp", async (_req, res, next) => {
  try {
    res.json(await getNtpSettings());
  } catch (err) {
    next(err);
  }
});

router.put("/ntp", async (req, res, next) => {
  try {
    res.json(await updateNtpSettings(req.body));
  } catch (err) {
    next(err);
  }
});

router.post("/ntp/test", async (req, res, next) => {
  try {
    res.json(await testNtpSync(req.body));
  } catch (err) {
    next(err);
  }
});

// ─── Certificates ───────────────────────────────────────────────────────────

router.get("/certificates", async (_req, res, next) => {
  try {
    const certs = await listCertificates();
    // Strip PEM content from list response
    const strip = (c: any) => ({ ...c, pem: undefined });
    res.json({
      trustedCAs: certs.trustedCAs.map(strip),
      serverCerts: certs.serverCerts.map(strip),
    });
  } catch (err) {
    next(err);
  }
});

// Server-leaf cert mutations are always rejected — nginx owns TLS for the
// life of the install. CA records (category="ca") stay editable because
// outbound TLS to integrations (LDAP, SMTP) still depends on them. The 409
// message is the actionable guidance for an operator who landed here.
const SERVER_CERT_EXTERNAL_MESSAGE =
  "Polaris is fronted by an external proxy; manage the server cert via POLARIS_PROXY_CERT_PATH";

router.post("/certificates", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const category = req.body.category === "server" ? "server" : "ca";
    if (category === "server") {
      return res.status(409).json({ error: SERVER_CERT_EXTERNAL_MESSAGE });
    }
    const pem = bufferToPem(req.file.buffer, req.file.originalname);
    validatePem(pem, req.file.originalname);
    const record = await addCertificate(category as any, req.file.originalname, pem);
    res.status(201).json({ ...record, pem: undefined });
  } catch (err) {
    next(err);
  }
});

router.delete("/certificates/:id", async (req, res, next) => {
  try {
    const all = await listCertificates();
    const target = [...all.serverCerts, ...all.trustedCAs].find((c) => c.id === req.params.id);
    if (target && target.category === "server") {
      return res.status(409).json({ error: SERVER_CERT_EXTERNAL_MESSAGE });
    }
    await deleteCertificate(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ─── HTTPS ──────────────────────────────────────────────────────────────────
// nginx terminates TLS; Polaris reads the cert file via certInfo.ts to render
// the Identification tab's informational pane (fingerprint, SANs, expiry,
// cert path). No mutation routes — operator manages cert via the file path.

router.get("/https", async (_req, res, next) => {
  try {
    const hosts = getServerCertHostnames();
    res.json({
      externallyManaged: true,
      running: true,
      enabled: true,
      port: getPublicUrlPort() ?? 443,
      httpPort: null,
      certId: null,
      keyId: null,
      redirectHttp: false,
      fingerprint: getServerCertFingerprint(),
      cn: hosts?.cn ?? null,
      dnsSans: hosts?.dnsSans ?? [],
      ipSans: hosts?.ipSans ?? [],
      expiresAt: getServerCertExpiry(),
      certPath: process.env.POLARIS_PROXY_CERT_PATH ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── DNS ───────────────────────────────────────────────────────────────────

router.get("/dns", async (_req, res, next) => {
  try {
    res.json(await getDnsSettings());
  } catch (err) {
    next(err);
  }
});

router.put("/dns", async (req, res, next) => {
  try {
    const servers: string[] = (req.body.servers || [])
      .map((s: string) => s.trim())
      .filter(Boolean);
    const mode = (req.body.mode || "standard") as DnsSettings["mode"];
    const dohUrl = (req.body.dohUrl || "").trim();
    const verifyTls = req.body.verifyTls === true;

    // Validate server entries — allow IPs, hostnames, and host:port
    if (mode !== "doh") {
      for (const s of servers) {
        if (!/^[\w.\-:[\]]+$/.test(s)) {
          throw new AppError(400, `Invalid DNS server entry: "${s}". Use an IP address or hostname (e.g. 8.8.8.8, dns.google, or [2001:4860:4860::8888]).`);
        }
      }
    }

    // Validate DoH URL
    if (mode === "doh") {
      if (!dohUrl) throw new AppError(400, "A DoH URL is required when using DNS over HTTPS mode.");
      if (!/^https:\/\/.+/.test(dohUrl)) throw new AppError(400, "DoH URL must start with https://");
    }

    const saved = await updateDnsSettings({ servers, mode, dohUrl, verifyTls });
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

router.post("/dns/test", async (req, res, next) => {
  try {
    const servers: string[] = (req.body.servers || [])
      .map((s: string) => s.trim())
      .filter(Boolean);
    const mode = (req.body.mode || "standard") as DnsSettings["mode"];
    const dohUrl = (req.body.dohUrl || "").trim();
    const verifyTls = req.body.verifyTls === true;
    const testIp = req.body.testIp || "8.8.8.8";

    if (mode === "doh" && !dohUrl) {
      return res.json({ ok: false, message: "No DoH URL configured", results: [] });
    }

    // Carry verifyTls so the test exercises the operator's chosen TLS behavior.
    const targets = mode === "doh"
      ? [{ label: `DoH (${dohUrl})`, settings: { servers: [], mode, dohUrl, verifyTls } as DnsSettings }]
      : mode === "dot"
        ? servers.map((s) => ({ label: `DoT (${s}:853)`, settings: { servers: [s], mode, dohUrl: "", verifyTls } as DnsSettings }))
        : servers.length > 0
          ? servers.map((s) => ({ label: s, settings: { servers: [s], mode: "standard" as const, dohUrl: "", verifyTls: false } }))
          : [{ label: "system DNS", settings: { servers: [], mode: "standard" as const, dohUrl: "", verifyTls: false } }];

    const results = await Promise.all(targets.map(async (t) => {
      const resolver = await createResolver(t.settings);
      const start = Date.now();
      try {
        const records = await resolver.reverse(testIp);
        const elapsed = Date.now() - start;
        const name = records[0]?.name || "(no PTR)";
        const ttlNote = records[0]?.ttl != null ? ` TTL ${records[0].ttl}s` : "";
        return { server: t.label, ok: true, message: `${testIp} → ${name}${ttlNote} in ${elapsed}ms` };
      } catch (dnsErr: any) {
        const elapsed = Date.now() - start;
        if (dnsErr.code === "ENOTFOUND" || dnsErr.code === "ENODATA") {
          return { server: t.label, ok: true, message: `Reachable but no PTR record for ${testIp} (${elapsed}ms)` };
        }
        return { server: t.label, ok: false, message: `${dnsErr.message || dnsErr.code || "Unknown error"} (${elapsed}ms)` };
      }
    }));

    const allOk = results.every((r) => r.ok);
    res.json({ ok: allOk, message: results.map((r) => `${r.server}: ${r.message}`).join("; "), results });
  } catch (err) {
    next(err);
  }
});

// ─── OUI Database ──────────────────────────────────────────────────────────

router.get("/oui", async (_req, res, next) => {
  try {
    res.json(await getOuiStatus());
  } catch (err) {
    next(err);
  }
});

router.post("/oui/refresh", async (_req, res, next) => {
  try {
    const result = await refreshOuiDatabase();
    res.json({ ok: true, ...result, message: `OUI database refreshed: ${result.entries.toLocaleString()} vendors loaded` });
  } catch (err) {
    next(err);
  }
});

router.get("/oui/lookup/:prefix", async (req, res, next) => {
  try {
    const result = await lookupOuiDetailed(req.params.prefix);
    if (!result.normalized) throw new AppError(400, "Invalid MAC or prefix — supply at least 3 bytes (e.g. AA:BB:CC)");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── OUI Overrides ────────────────────────────────────────────────────────

router.get("/oui/overrides", async (_req, res, next) => {
  try {
    res.json(await getOuiOverrides());
  } catch (err) {
    next(err);
  }
});

router.post("/oui/overrides", async (req, res, next) => {
  try {
    const { prefix, manufacturer, device } = req.body;
    if (!prefix || !manufacturer) throw new AppError(400, "prefix and manufacturer are required");
    const clean = prefix.replace(/[:\-.\s]/g, "").toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(clean)) throw new AppError(400, "prefix must be 6 hex characters (e.g. AA:BB:CC)");
    const deviceTrim = typeof device === "string" ? device.trim() : "";
    const result = await setOuiOverride(prefix, manufacturer.trim(), deviceTrim || undefined);

    // Update matching assets — match MAC addresses starting with this prefix
    // MAC format in DB is uppercase colon-separated: "AA:BB:CC:DD:EE:FF"
    const macPrefix = clean.match(/.{2}/g)!.join(":");
    const updateData: { manufacturer: string; model?: string } = { manufacturer: manufacturer.trim() };
    if (deviceTrim) updateData.model = deviceTrim;
    const updated = await prisma.asset.updateMany({
      where: { macAddress: { startsWith: macPrefix } },
      data: updateData,
    });

    await logEvent({
      level: "info",
      action: "oui.override.set",
      resourceType: "ouiOverride",
      resourceId: clean,
      resourceName: macPrefix,
      actor: req.session?.username,
      message: `OUI override set for ${macPrefix} → ${manufacturer.trim()}${deviceTrim ? ` / ${deviceTrim}` : ""} (${updated.count} assets rewritten)`,
    });

    res.json({ ...result, assetsUpdated: updated.count });
  } catch (err) {
    next(err);
  }
});

router.delete("/oui/overrides/:prefix", async (req, res, next) => {
  try {
    await deleteOuiOverride(req.params.prefix);
    await logEvent({
      level: "info",
      action: "oui.override.removed",
      resourceType: "ouiOverride",
      resourceId: req.params.prefix,
      resourceName: req.params.prefix,
      actor: req.session?.username,
      message: `OUI override removed for ${req.params.prefix}`,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── MIB Database ─────────────────────────────────────────────────────────
//
// MIB browse + walk routes have moved to src/api/routes/mibs.ts so they can
// be mounted under /server-settings/mibs with a more permissive guard
// (admin OR assets-admin on reads) than the rest of /server-settings, which
// stays admin-only. See router.ts for the mount order — the mibs router is
// matched FIRST for paths starting with /server-settings/mibs.

// ─── PostgreSQL Tuning Check ───────────────────────────────────────────────

const PG_TUNING_THRESHOLDS = {
  assets: 160,        // 80% of 200
  subnets: 1600,      // 80% of 2,000
  reservations: 160000, // 80% of 200,000
};

function buildPgRecommended(): Record<string, { min: number; unit: string; display: string }> {
  const ram = totalmem();
  const MB = 1024 * 1024;
  const GB = 1024 * MB;

  // Round to clean multiples of 8 so the recommended values sit on the same
  // boundaries operators are used to seeing in postgresql.conf (8/16/24/32 GB,
  // 8/16/24 MB). Postgres accepts any MB-resolution value, but recommending
  // "15 GB" or "46 GB" reads as an arbitrary fraction of host RAM — bumping
  // those to the nearest 8 GB (16 GB / 48 GB) makes the recommendation
  // actionable without a "...why that specific number?" pause.
  const roundToMultipleOf = (b: number, unit: number) => Math.round(b / unit) * unit;
  const EIGHT_MB = 8 * MB;
  const EIGHT_GB = 8 * GB;

  // For shared_buffers / effective_cache_size: round to 8 GB on hosts where
  // the natural value lands ≥4 GB (so it rounds up cleanly), and fall back to
  // 8 MB rounding on tiny-RAM hosts where 8-GB rounding would collapse to 0.
  const sharedBuffers = Math.max(
    128 * MB,
    roundToMultipleOf(ram * 0.25, EIGHT_GB) || roundToMultipleOf(ram * 0.25, EIGHT_MB),
  );
  const effectiveCache = Math.max(
    256 * MB,
    roundToMultipleOf(ram * 0.75, EIGHT_GB) || roundToMultipleOf(ram * 0.75, EIGHT_MB),
  );
  // work_mem: RAM/128, rounded to nearest 8 MB, capped at 256 MB, min 32 MB.
  const workMem = Math.max(32 * MB, Math.min(256 * MB, roundToMultipleOf(ram / 128, EIGHT_MB)));

  const fmt = (b: number) =>
    b >= GB ? (b / GB) + "GB"
    : (b / MB) + "MB";

  return {
    shared_buffers:      { min: sharedBuffers,  unit: "bytes", display: fmt(sharedBuffers) },
    work_mem:            { min: workMem,        unit: "bytes", display: fmt(workMem) },
    effective_cache_size:{ min: effectiveCache, unit: "bytes", display: fmt(effectiveCache) },
    random_page_cost:    { min: -1,             unit: "cost",  display: "1.1" },
  };
}

function parsePgBytes(val: string): number {
  const s = val.trim();
  // PostgreSQL reports in 8kB pages for shared_buffers, or kB/MB/GB suffixes
  const m = s.match(/^(\d+)\s*(kB|MB|GB|TB)?$/i);
  if (!m) return parseInt(s, 10) || 0;
  const n = parseInt(m[1], 10);
  switch ((m[2] || "").toUpperCase()) {
    case "KB": return n * 1024;
    case "MB": return n * 1024 * 1024;
    case "GB": return n * 1024 * 1024 * 1024;
    case "TB": return n * 1024 * 1024 * 1024 * 1024;
    default:   return n; // unit-less = 8kB pages for shared_buffers
  }
}

/**
 * Compute the pg-tuning data: per-setting current vs recommended pairs, the
 * pg_settings config-file path, plus the `pgTuningNeeded` flag consumed by
 * capacityService.
 *
 * Extracted into a helper so both `/pg-tuning` and `/capacity-advisor` can
 * reuse it without duplicating the PG_SETTINGS query. Returns null when no
 * threshold is crossed (small install — no tuning advice yet).
 */
interface PgTuningRow {
  name: string;
  current: string;
  recommended: string;
  ok: boolean;
  /** True when the current value was set explicitly via ALTER SYSTEM
   *  (postgresql.auto.conf). Such a value is a deliberate operator choice, so
   *  the advisor treats it as OK even when below its heuristic recommendation —
   *  otherwise an operator who intentionally lowered work_mem (e.g. to stop
   *  swapping) gets a permanent false "Stage" nag, and staging would write to
   *  postgresql.conf which auto.conf overrides anyway. */
  operatorOverride: boolean;
}

/**
 * True when a pg_settings row's value comes from postgresql.auto.conf — i.e. it
 * was set by ALTER SYSTEM. Postgres reports such values with
 * source='configuration file' and a sourcefile ending in postgresql.auto.conf.
 */
function isAutoConfOverride(s: { sourcefile: string | null }): boolean {
  return !!s.sourcefile && /postgresql\.auto\.conf$/.test(s.sourcefile.replace(/\\/g, "/"));
}
interface PgTuningResult {
  settings: PgTuningRow[];
  pgConfigFile: string | null;
  pgTuningNeeded: boolean;
}
async function computePgTuning(): Promise<PgTuningResult | null> {
  const [assetCount, subnetCount, reservationCount] = await Promise.all([
    prisma.asset.count(),
    prisma.subnet.count(),
    prisma.reservation.count(),
  ]);

  const triggered: string[] = [];
  if (assetCount >= PG_TUNING_THRESHOLDS.assets) triggered.push("assets");
  if (subnetCount >= PG_TUNING_THRESHOLDS.subnets) triggered.push("subnets");
  if (reservationCount >= PG_TUNING_THRESHOLDS.reservations) triggered.push("reservations");
  if (!triggered.length) return null;

  const pgSettings = await prisma.$queryRawUnsafe<{ name: string; setting: string; unit: string | null; sourcefile: string | null }[]>(
    `SELECT name, setting, unit, sourcefile FROM pg_settings WHERE name IN ('shared_buffers', 'work_mem', 'effective_cache_size', 'random_page_cost', 'config_file')`
  );
  const pgConfigFile = pgSettings.find((s) => s.name === "config_file")?.setting || null;

  const PG_RECOMMENDED = buildPgRecommended();
  const settings: PgTuningRow[] = pgSettings.map((s) => {
    if (s.name === "config_file") return null;
    const rec = PG_RECOMMENDED[s.name];
    if (!rec) return null;
    // An explicit ALTER SYSTEM override is a deliberate operator choice — never
    // flag it as needing change, regardless of the heuristic recommendation.
    const operatorOverride = isAutoConfOverride(s);
    let currentBytes: number;
    let ok: boolean;
    if (s.name === "random_page_cost") {
      const val = parseFloat(s.setting);
      ok = operatorOverride || val <= 1.1;
      return { name: s.name, current: String(val), recommended: rec.display, ok, operatorOverride };
    }
    if (s.unit === "8kB") {
      currentBytes = parseInt(s.setting, 10) * 8192;
    } else if (s.unit === "kB") {
      currentBytes = parseInt(s.setting, 10) * 1024;
    } else {
      currentBytes = parsePgBytes(s.setting);
    }
    ok = operatorOverride || currentBytes >= rec.min;
    let currentDisplay: string;
    if (currentBytes >= 1024 * 1024 * 1024) currentDisplay = (currentBytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "") + "GB";
    else if (currentBytes >= 1024 * 1024) currentDisplay = (currentBytes / (1024 * 1024)).toFixed(0) + "MB";
    else currentDisplay = (currentBytes / 1024).toFixed(0) + "kB";
    return { name: s.name, current: currentDisplay, recommended: rec.display, ok, operatorOverride };
  }).filter((s): s is PgTuningRow => s !== null);

  const allOk = settings.every((s) => s.ok);
  return { settings, pgConfigFile, pgTuningNeeded: !allOk };
}

/** Project the pg-tuning rows into the shape the Capacity Advisor consumes. */
function pgTuningToAdvisorShape(t: PgTuningResult | null): import("../../services/capacityAdvisorService.js").PgTuningExternal {
  const find = (name: string): PgTuningRow | undefined =>
    t?.settings.find((s) => s.name === name);
  const sb = find("shared_buffers");
  const ec = find("effective_cache_size");
  const wm = find("work_mem");
  const rp = find("random_page_cost");
  const PG_DEFAULTS = buildPgRecommended();
  return {
    sharedBuffers: {
      current: sb?.current ?? null,
      recommended: sb?.recommended ?? PG_DEFAULTS.shared_buffers.display,
      changeRequired: sb ? !sb.ok : false,
      operatorOverride: sb?.operatorOverride ?? false,
    },
    effectiveCacheSize: {
      current: ec?.current ?? null,
      recommended: ec?.recommended ?? PG_DEFAULTS.effective_cache_size.display,
      changeRequired: ec ? !ec.ok : false,
      operatorOverride: ec?.operatorOverride ?? false,
    },
    workMem: {
      current: wm?.current ?? null,
      recommended: wm?.recommended ?? PG_DEFAULTS.work_mem.display,
      changeRequired: wm ? !wm.ok : false,
      operatorOverride: wm?.operatorOverride ?? false,
    },
    randomPageCost: {
      current: rp?.current ?? null,
      recommended: rp?.recommended ?? PG_DEFAULTS.random_page_cost.display,
      changeRequired: rp ? !rp.ok : false,
      operatorOverride: rp?.operatorOverride ?? false,
    },
  };
}

router.get("/pg-tuning", async (_req, res, next) => {
  try {
    const tuning = await computePgTuning();
    if (!tuning) {
      const capacity = await getCapacitySnapshot({ pgTuningNeeded: false });
      void recordCapacityTransition(capacity);
      return res.json({ settings: [], pgConfigFile: null, capacity });
    }

    // Layer the capacity snapshot on top so callers get a single source of
    // truth for severity, reasons, host stats, sample-table breakdown, and
    // steady-state size projection. The card consumes `settings` + `pgConfigFile`
    // alongside `capacity` to render the inline pg-tuning rows under the
    // `pg_tuning_needed` reason.
    const capacity = await getCapacitySnapshot({
      pgTuningNeeded: tuning.pgTuningNeeded,
    });

    // Best-effort transition Event so a flip into watch/amber/red flows out
    // through eventArchiveService → syslog/SFTP even if no admin loads the
    // Maintenance tab.
    void recordCapacityTransition(capacity);

    res.json({ settings: tuning.settings, pgConfigFile: tuning.pgConfigFile, capacity });
  } catch (err) {
    next(err);
  }
});

// ─── Monitor queue mode ──────────────────────────────────────────────────
//
// Two-state config (cursor | pgboss) backed by Setting.monitor.queueMode.
// The currently-running process always uses its boot-time mode; a flip
// here writes the Setting and returns success. The next application
// restart picks up the new mode. Surfaced on the Maintenance tab so
// admins can act on the `pgboss_recommended` capacity reason without
// shell access.

router.get("/queue-mode", async (_req, res, next) => {
  try {
    const persisted = await getQueueMode();
    const active = getBootTimeMode();
    res.json({
      active,                  // what this process is using
      persisted,               // what next restart will use
      restartRequired: active !== persisted,
      pgbossInstalled: isPgbossInstalled(),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/queue-mode", async (req, res, next) => {
  try {
    const requested = req.body?.mode;
    if (requested !== "cursor" && requested !== "pgboss") {
      throw new AppError(400, "mode must be 'cursor' or 'pgboss'");
    }
    if (requested === "pgboss" && !isPgbossInstalled()) {
      throw new AppError(409, "pg-boss is not installed in this build");
    }
    await setQueueMode(requested);
    await logEvent({
      level: "info",
      action: "monitor.queue_mode.set",
      resourceType: "setting",
      resourceName: "monitor.queueMode",
      actor: req.session?.username,
      message: `Monitor queue mode set to ${requested} (effective on next restart)`,
    });
    res.json({
      ok: true,
      persisted: requested,
      active: getBootTimeMode(),
      restartRequired: getBootTimeMode() !== requested,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Sample retention (tiered: detail / hourly / daily, per stream + class) ─
//
// Phase 5 pulled sample retention out of the per-tier monitor-settings
// hierarchy into a single global setting edited from the Maintenance card.
// One Setting("sampleRetention") row carries 3 streams × 3 tiers × 3 classes
// of retention days. See sampleRetentionService for the shape.

router.get("/sample-retention", async (_req, res, next) => {
  try {
    res.json({ retention: await getSampleRetention() });
  } catch (err) {
    next(err);
  }
});

router.put("/sample-retention", async (req, res, next) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const updated = await updateSampleRetention(body);
    await logEvent({
      level: "info",
      action: "sample_retention.updated",
      resourceType: "setting",
      resourceName: "sampleRetention",
      actor: req.session?.username,
      message: "Sample retention updated",
      details: { retention: updated as any },
    });
    res.json({ retention: updated });
  } catch (err) {
    next(err);
  }
});

// ─── Dash wallboard config ──────────────────────────────────────────────────
//
// The unauthenticated read-only /dash surface (own process, POLARIS_ROLE=dash;
// see src/dash/dashServer.ts). Reads ride the blanket serverSettingsSystem
// read gate; the PUT is explicitly fullwrite-gated because it enables an
// unauthenticated surface / widens its source-IP scope. The dash listener
// picks a change up within ~10s via dashSettingsService's TTL cache.

const DashSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  ipScope: z.enum(["rfc1918", "all", "custom"]).optional(),
  // CIDR validation + normalization happens in saveDashSettings (shared with
  // the parse path); here we only bound the array shape.
  allowedCidrs: z.array(z.string()).max(200).optional(),
});

router.get("/dash", async (_req, res, next) => {
  try {
    res.json({ dash: await getDashSettings() });
  } catch (err) {
    next(err);
  }
});

router.put("/dash", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const input = DashSettingsSchema.parse(req.body ?? {});
    const before = await getDashSettings();
    const updated = await saveDashSettings(input);
    await logEvent({
      // "all" is the widest posture — flag it at warning level.
      level: updated.enabled && updated.ipScope === "all" ? "warning" : "info",
      action: "dash_settings.updated",
      resourceType: "setting",
      resourceName: "dashConfig",
      actor: req.session?.username,
      message: updated.enabled
        ? `Dash wallboard enabled (${describeDashScope(updated)})`
        : "Dash wallboard disabled",
      details: { before: before as any, after: updated as any },
    });
    res.json({ dash: updated });
  } catch (err) {
    next(err);
  }
});

function describeDashScope(s: { ipScope: string; allowedCidrs: string[] }): string {
  if (s.ipScope === "all") return "ALL source IPs";
  if (s.ipScope === "custom") return `custom source IPs: ${s.allowedCidrs.join(", ") || "(none)"}`;
  return "RFC1918 + loopback sources only";
}

// ─── Agent OS event-log config ────────────────────────────────────────────
//
// Global master switch + curation filter for the OS event-log → audit Events
// ingest (osEventLogService). Default disabled — operator opts in. Delivered to
// agents via GET /agents/config and applied server-side at /samples ingest.

router.get("/agent-event-log", async (_req, res, next) => {
  try {
    res.json({ config: await getAgentEventLogConfig() });
  } catch (err) {
    next(err);
  }
});

router.put("/agent-event-log", async (req, res, next) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const updated = await updateAgentEventLogConfig(body);
    await logEvent({
      level: "info",
      action: "agent_event_log.updated",
      resourceType: "setting",
      resourceName: "agentEventLog",
      actor: req.session?.username,
      message: `Agent OS event-log collection ${updated.enabled ? "enabled" : "disabled"} (min level: ${updated.minLevel})`,
      details: { config: updated as any },
    });
    res.json({ config: updated });
  } catch (err) {
    next(err);
  }
});

// ─── Capacity Advisor ─────────────────────────────────────────────────────
//
// GET returns the advisor state (per-lever current vs recommended) alongside
// the capacity snapshot and pg-tuning data — single round-trip for the UI.
// POST /stage applies operator-selected env-driven recommendations to .env
// (restart-required to take effect); advisory-only levers (max_connections,
// PostgreSQL tuning) are skipped because they need a PostgreSQL restart.

router.get("/capacity-advisor", async (_req, res, next) => {
  try {
    const tuning = await computePgTuning();
    const pgTuningExternal = pgTuningToAdvisorShape(tuning);
    const { getCapacitySnapshotWithAdvisor } = await import("../../services/capacityService.js");
    const { snapshot, advisor } = await getCapacitySnapshotWithAdvisor({
      pgTuningNeeded: tuning?.pgTuningNeeded ?? false,
      pgTuning: pgTuningExternal,
    });
    void recordCapacityTransition(snapshot);
    const { getDbConnectionMode } = await import("../../utils/dbConnections.js");
    res.json({
      advisor,
      capacity: snapshot,
      pgTuning: {
        settings: tuning?.settings ?? [],
        pgConfigFile: tuning?.pgConfigFile ?? null,
      },
      dbConnectionMode: getDbConnectionMode(),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/capacity-advisor/stage", async (req, res, next) => {
  try {
    const keysRaw = req.body?.keys;
    if (!Array.isArray(keysRaw) || keysRaw.length === 0) {
      throw new AppError(400, "keys must be a non-empty array of advisor lever names");
    }
    const keys = keysRaw.map((k) => String(k)) as import("../../services/capacityAdvisorService.js").AdvisorLeverKey[];
    // Fresh recompute so we never write a stale recommendation.
    const tuning = await computePgTuning();
    const pgTuningExternal = pgTuningToAdvisorShape(tuning);
    const { getCapacitySnapshotWithAdvisor } = await import("../../services/capacityService.js");
    const { advisor } = await getCapacitySnapshotWithAdvisor({
      pgTuningNeeded: tuning?.pgTuningNeeded ?? false,
      pgTuning: pgTuningExternal,
    });
    const { stageAdvisorState } = await import("../../services/capacityAdvisorService.js");
    const receipt = await stageAdvisorState(keys, advisor);

    const applied = receipt.results.filter((r) => r.status === "applied");
    const errored = receipt.results.filter((r) => r.status === "error");
    if (applied.length > 0) {
      await logEvent({
        level: "info",
        action: "capacity_advisor.staged",
        resourceType: "system",
        actor: req.session?.username,
        message: `Capacity Advisor staged ${applied.length} value${applied.length === 1 ? "" : "s"} (restart required)`,
        details: {
          staged:  applied.map((r) => ({ key: r.key, old: r.oldValue, new: r.newValue })),
          skipped: receipt.results.filter((r) => r.status === "skipped").map((r) => ({ key: r.key, reason: r.reason })),
          errors:  errored.map((r) => ({ key: r.key, reason: r.reason })),
        },
      });
    }
    if (errored.length > 0) {
      await logEvent({
        level: "warning",
        action: "capacity_advisor.stage_failed",
        resourceType: "system",
        actor: req.session?.username,
        message: `Capacity Advisor: ${errored.length} stage operation${errored.length === 1 ? "" : "s"} failed`,
        details: { errors: errored.map((r) => ({ key: r.key, reason: r.reason })) },
      });
    }

    res.json(receipt);
  } catch (err) {
    next(err);
  }
});

// ─── Bearer-token generation for /metrics and /health ─────────────────────
//
// Driven by [Generate token] buttons on the `metrics_token_unset` and
// `health_token_unset` capacity reasons. Writes a fresh 32-byte hex value
// into .env and stamps process.env so the gate takes effect without a
// restart. Admin-only by virtue of the parent /server-settings guard.
router.post("/security-tokens/generate", async (req, res, next) => {
  try {
    const which = req.body?.which;
    if (which !== "metrics" && which !== "health") {
      throw new AppError(400, "which must be 'metrics' or 'health'");
    }
    const key = which === "metrics" ? "METRICS_TOKEN" : "HEALTH_TOKEN";
    const value = randomBytes(32).toString("hex");
    setEnvVar(key, value);
    process.env[key] = value;
    await logEvent({
      level: "info",
      action: "server.security_token.generated",
      resourceType: "setting",
      resourceName: key,
      actor: req.session?.username,
      message: `Bearer token generated for ${which === "metrics" ? "/metrics" : "/health"}`,
    });
    res.json({ ok: true, key });
  } catch (err) {
    next(err);
  }
});

// ─── Restart ─────────────────────────────────────────────────────────────
//
// Operator-triggered process restart. Used by the Capacity Advisor card
// after staging env-driven values that only take effect on next boot.
// On Linux exits with code 1 so systemd's Restart=on-failure brings the
// process back; on Windows shells out to NSSM. Responds before the exit
// so the client sees a clean 200 and can switch to its restart-polling UI.
router.post("/restart", async (req, res, next) => {
  try {
    await logEvent({
      level: "warning",
      action: "server.restart.requested",
      resourceType: "server",
      actor: req.session?.username,
      message: `Operator-triggered restart by ${req.session?.username ?? "(unknown)"}`,
    });
    res.json({ ok: true, message: "Restarting..." });
    setTimeout(() => { restartService(); }, 500);
  } catch (err) {
    next(err);
  }
});

// ─── Application Updates ──────────────────────────────────────────────────

// Initialize update status on module load (detects post-restart state)
initUpdateStatus();

router.get("/updates/check", async (_req, res, next) => {
  try {
    const status = await checkForUpdates();
    res.json(status);
  } catch (err) {
    next(err);
  }
});

router.get("/updates/status", (_req, res) => {
  res.json(getUpdateStatus());
});

// Which git repo the updater pulls from + where that choice comes from
// (POLARIS_UPDATE_REPO env override vs. the install's existing origin remote).
// Drives the "Update source" row on the Application Updates card.
router.get("/updates/repo", async (_req, res, next) => {
  try {
    res.json(await getUpdateRepoInfo());
  } catch (err) {
    next(err);
  }
});

router.post("/updates/apply", async (req, res, next) => {
  try {
    if (!isUpdateMechanismAvailable()) {
      return res.status(409).json({ error: "In-app updates are disabled in this deployment." });
    }
    const status = getUpdateStatus();
    if (status.state === "applying" || status.state === "restarting") {
      return res.status(409).json({ error: "An update is already in progress" });
    }
    const password: string | null = (req.body && typeof req.body.password === "string" && req.body.password.length > 0)
      ? req.body.password
      : null;
    // Start the update in the background
    applyUpdate(password).catch((err) => {
      logger.error({ err }, "Update failed");
    });
    // Return immediately — client should poll /updates/status
    res.json({ started: true, message: "Update started — poll /updates/status for progress" });
  } catch (err) {
    next(err);
  }
});

router.post("/updates/dismiss", (_req, res) => {
  clearUpdateStatus();
  res.json({ ok: true });
});

router.get("/updates/settings", async (_req, res, next) => {
  try {
    const [setting, train] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "update.skip_backup" } }),
      getUpdateTrain(),
    ]);
    res.json({ skipBackup: setting?.value === true, train });
  } catch (err) {
    next(err);
  }
});

// PUT accepts either/both of { skipBackup, train } and updates only the keys
// present, so the frontend can persist the backup checkbox and the train
// dropdown independently without clobbering the other.
router.put("/updates/settings", async (req, res, next) => {
  try {
    const body = req.body || {};

    if ("skipBackup" in body) {
      const skipBackup = !!body.skipBackup;
      await prisma.setting.upsert({
        where: { key: "update.skip_backup" },
        update: { value: skipBackup },
        create: { key: "update.skip_backup", value: skipBackup },
      });
      await logEvent({
        level: skipBackup ? "warning" : "info",
        action: "update.settings.changed",
        resourceType: "setting",
        resourceName: "update.skip_backup",
        actor: req.session?.username,
        message: `Pre-update backup ${skipBackup ? "DISABLED — updates will apply without a safety backup" : "enabled"}`,
        details: { skipBackup },
      });
    }

    if ("train" in body) {
      const train: "nightly" | "release" = body.train === "release" ? "release" : "nightly";
      await setUpdateTrain(train);
      await logEvent({
        level: "info",
        action: "update.settings.changed",
        resourceType: "setting",
        resourceName: "update.train",
        actor: req.session?.username,
        message: `Update train set to "${train}" (${train === "release" ? "published releases only" : "latest commits"})`,
        details: { train },
      });
    }

    const [setting, train] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "update.skip_backup" } }),
      getUpdateTrain(),
    ]);
    res.json({ skipBackup: setting?.value === true, train });
  } catch (err) {
    next(err);
  }
});

router.get("/updates/history", async (req, res, next) => {
  try {
    const limit = parseInt(String(req.query.limit || ""), 10) || 20;
    res.json(await getRecentCommits(limit));
  } catch (err) {
    next(err);
  }
});

// ─── Branding ─────────────────────────────────────────────────────────────

interface BrandingSettings {
  appName: string;
  subtitle: string;
  logoUrl: string;
}

const BRANDING_DEFAULTS: BrandingSettings = {
  appName: "Polaris",
  subtitle: "Network Management Tool",
  logoUrl: "/logo.png",
};

export async function getBranding(): Promise<BrandingSettings & { version: string }> {
  const row = await prisma.setting.findUnique({ where: { key: "branding" } });
  const saved = row ? (row.value as Record<string, unknown>) : {};
  return {
    appName:  (saved.appName as string)  || BRANDING_DEFAULTS.appName,
    subtitle: saved.subtitle !== undefined ? (saved.subtitle as string) : BRANDING_DEFAULTS.subtitle,
    logoUrl:  (saved.logoUrl as string)  || BRANDING_DEFAULTS.logoUrl,
    version:  APP_VERSION,
  };
}

router.get("/branding", async (_req, res, next) => {
  try {
    res.json(await getBranding());
  } catch (err) {
    next(err);
  }
});

router.put("/branding", async (req, res, next) => {
  try {
    const current = await getBranding();
    const updated: BrandingSettings = {
      appName:  (req.body.appName  ?? current.appName).trim()  || BRANDING_DEFAULTS.appName,
      subtitle: (req.body.subtitle ?? current.subtitle).trim(),
      logoUrl:  current.logoUrl,
    };
    await prisma.setting.upsert({
      where:  { key: "branding" },
      update: { value: updated as any },
      create: { key: "branding", value: updated as any },
    });
    await logEvent({
      level: "info",
      action: "branding.updated",
      resourceType: "setting",
      resourceName: "branding",
      actor: req.session?.username,
      message: `Branding updated: appName="${updated.appName}", subtitle="${updated.subtitle}"`,
    });
    res.json({ ...updated, version: APP_VERSION });
  } catch (err) {
    next(err);
  }
});

const LOGO_DIR = UPLOADS_DIR;
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post("/branding/logo", maintenanceLimiter, logoUpload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, "No file uploaded");
    const ext = detectImageMagic(req.file.buffer);
    if (!ext) throw new AppError(400, "Unsupported image format — PNG, JPEG, or WebP required");

    mkdirSync(LOGO_DIR, { recursive: true });
    const filename = `custom-logo${ext}`;
    writeFileSync(join(LOGO_DIR, filename), req.file.buffer);
    const logoUrl = `/uploads/${filename}`;

    const current = await getBranding();
    const updated: BrandingSettings = { appName: current.appName, subtitle: current.subtitle, logoUrl };
    await prisma.setting.upsert({
      where:  { key: "branding" },
      update: { value: updated as any },
      create: { key: "branding", value: updated as any },
    });
    await logEvent({
      level: "info",
      action: "branding.logo.updated",
      resourceType: "setting",
      resourceName: "branding",
      actor: req.session?.username,
      message: `Custom logo set (${filename})`,
    });
    res.json({ ...updated, version: APP_VERSION });
  } catch (err) {
    next(err);
  }
});

router.delete("/branding/logo", maintenanceLimiter, async (req, res, next) => {
  try {
    const current = await getBranding();
    // Remove old custom logo file
    if (current.logoUrl.startsWith("/uploads/")) {
      const oldPath = join(LOGO_DIR, current.logoUrl.replace("/uploads/", ""));
      if (existsSync(oldPath)) unlinkSync(oldPath);
    }
    const updated: BrandingSettings = { appName: current.appName, subtitle: current.subtitle, logoUrl: BRANDING_DEFAULTS.logoUrl };
    await prisma.setting.upsert({
      where:  { key: "branding" },
      update: { value: updated as any },
      create: { key: "branding", value: updated as any },
    });
    await logEvent({
      level: "info",
      action: "branding.logo.removed",
      resourceType: "setting",
      resourceName: "branding",
      actor: req.session?.username,
      message: "Custom logo removed — reverted to default",
    });
    res.json({ ...updated, version: APP_VERSION });
  } catch (err) {
    next(err);
  }
});

// ─── Polaris Agent build routes ──────────────────────────────────────
//
// Drives the "Build agent binaries" card on the Maintenance tab. Phase B
// ships the minimum useful surface: inventory + start-build + poll-status.
// Phase D extends with queueing, Phase E with cancellation, Phase F with
// the prune button.

router.get("/agents/inventory", async (_req, res, next) => {
  try {
    const { getInventory } = await import("../../services/agentBuildService.js");
    res.json(await getInventory());
  } catch (err) { next(err); }
});

router.post("/agents/build", async (req, res, next) => {
  try {
    const { startBuild, BuildQueueFullError, GoUnavailableError } =
      await import("../../services/agentBuildService.js");
    const actor = req.session?.username || "unknown";
    try {
      const result = await startBuild({ actor });
      res.json(result);
    } catch (err) {
      if (err instanceof BuildQueueFullError) {
        return res.status(409).json({ error: err.message });
      }
      if (err instanceof GoUnavailableError) {
        return res.status(400).json({ error: `Go is not available on this Polaris server: ${err.message}. Install Go 1.22+ and reload.` });
      }
      throw err;
    }
  } catch (err) { next(err); }
});

router.get("/agents/build/current", async (_req, res, next) => {
  try {
    const { getCurrentBuildAndQueue } = await import("../../services/agentBuildService.js");
    res.json(getCurrentBuildAndQueue());
  } catch (err) { next(err); }
});

router.get("/agents/build/:buildId", async (req, res, next) => {
  try {
    const { getBuild } = await import("../../services/agentBuildService.js");
    const state = getBuild(req.params.buildId as string);
    if (!state) return res.status(404).json({ error: "Build not found" });
    res.json(state);
  } catch (err) { next(err); }
});

/**
 * Aggregated view of installed agents for the Maintenance card. Returns
 * per-version counts plus the live in-flight upgrade counts so the UI
 * can render both the "N of M installed agents are out-of-date" line AND
 * a live "X upgrading / Y failed" status while an upgrade-all is fanning
 * out. The frontend polls this endpoint every couple of seconds while a
 * batch upgrade is in progress; counts reconstruct from DB state so the
 * panel survives page reloads / tab switches.
 */
router.get("/agents/installed-summary", async (_req, res, next) => {
  try {
    const { prisma } = await import("../../db.js");
    const { getInventory } = await import("../../services/agentBuildService.js");
    const inv = await getInventory();
    // Pull every ManagedAgent row regardless of installStatus so we can
    // partition into active / upgrading / upgrade_failed without a
    // second query.
    const rows = await prisma.managedAgent.findMany({
      select: { agentVersion: true, installStatus: true },
    });
    const histogram = new Map<string, number>();
    let totalActive = 0;
    let upgrading = 0;
    let upgradeFailed = 0;
    for (const r of rows) {
      if (r.installStatus === "active") {
        totalActive++;
        const v = r.agentVersion ?? "unknown";
        histogram.set(v, (histogram.get(v) ?? 0) + 1);
      } else if (r.installStatus === "upgrading") {
        upgrading++;
      } else if (r.installStatus === "upgrade_failed") {
        upgradeFailed++;
      }
    }
    const current = inv.manifest?.currentVersion ?? null;
    let outOfDate = 0;
    for (const [v, n] of histogram) {
      if (current && v !== current) outOfDate += n;
    }
    res.json({
      totalActive,
      currentVersion: current,
      outOfDate,
      upgrading,
      upgradeFailed,
      byVersion:      Object.fromEntries(histogram),
    });
  } catch (err) { next(err); }
});

/**
 * Bulk-upgrade every active ManagedAgent whose agentVersion lags the
 * current manifest. Logic lives in `upgradeAllOutdated` in
 * agentInstallService so the same path is reachable from the post-build
 * auto-upgrade hook.
 */
router.post("/agents/upgrade-all", async (req, res, next) => {
  try {
    const { getInventory } = await import("../../services/agentBuildService.js");
    const { upgradeAllOutdated } = await import("../../services/agentInstallService.js");
    const inv = await getInventory();
    if (!inv.manifest?.currentVersion) {
      return res.status(400).json({ error: "No agent binaries available — build them first." });
    }
    const actor = req.session?.username || "unknown";
    const result = await upgradeAllOutdated(actor);
    res.json(result);
  } catch (err) { next(err); }
});

router.get("/agents/auto-build-setting", async (_req, res, next) => {
  try {
    const { prisma } = await import("../../db.js");
    const row = await prisma.setting.findUnique({ where: { key: "agent.autoBuildOnVersionMismatch" } });
    // Default ON when the Setting row is absent.
    const v = row?.value as { enabled?: boolean } | null;
    res.json({ enabled: v?.enabled !== false });
  } catch (err) { next(err); }
});

router.put("/agents/auto-build-setting", async (req, res, next) => {
  try {
    const { prisma } = await import("../../db.js");
    const enabled = !!(req.body && req.body.enabled);
    await prisma.setting.upsert({
      where:  { key: "agent.autoBuildOnVersionMismatch" },
      update: { value: { enabled } as any },
      create: { key: "agent.autoBuildOnVersionMismatch", value: { enabled } as any },
    });
    await logEvent({
      level: "info",
      action: "agent.auto_build_setting.changed",
      resourceType: "setting",
      resourceName: "agent.autoBuildOnVersionMismatch",
      actor: req.session?.username,
      message: `Agent auto-build on version mismatch ${enabled ? "enabled" : "disabled"}`,
    });
    res.json({ enabled });
  } catch (err) { next(err); }
});

/**
 * Auto-upgrade setting. When enabled, every successful agent build
 * triggers an upgrade-all fan-out for active+outdated agents. Default
 * OFF — operators must opt in so a routine `agent/VERSION` bump doesn't
 * surprise-reboot every installed agent during a Polaris update.
 */
router.get("/agents/auto-upgrade-setting", async (_req, res, next) => {
  try {
    const { prisma } = await import("../../db.js");
    const row = await prisma.setting.findUnique({ where: { key: "agent.autoUpgradeOnNewBuild" } });
    const v = row?.value as { enabled?: boolean } | null;
    res.json({ enabled: v?.enabled === true });
  } catch (err) { next(err); }
});

router.put("/agents/auto-upgrade-setting", async (req, res, next) => {
  try {
    const { prisma } = await import("../../db.js");
    const enabled = !!(req.body && req.body.enabled);
    await prisma.setting.upsert({
      where:  { key: "agent.autoUpgradeOnNewBuild" },
      update: { value: { enabled } as any },
      create: { key: "agent.autoUpgradeOnNewBuild", value: { enabled } as any },
    });
    await logEvent({
      level: "warning",
      action: "agent.auto_upgrade_setting.changed",
      resourceType: "setting",
      resourceName: "agent.autoUpgradeOnNewBuild",
      actor: req.session?.username,
      message: `Agent auto-upgrade on new build ${enabled ? "ENABLED — new builds will fan out upgrades to the agent fleet" : "disabled"}`,
    });
    res.json({ enabled });
  } catch (err) { next(err); }
});

router.post("/agents/prune", async (req, res, next) => {
  try {
    const { pruneOldAgentVersions } = await import("../../services/agentBuildService.js");
    const { logEvent } = await import("./events.js");
    const actor = req.session?.username || "unknown";
    const result = await pruneOldAgentVersions();
    if (result.removed.length > 0) {
      const totalBytes = result.removed.reduce((sum, e) => sum + e.bytes, 0);
      await logEvent({
        action:       "agent.versions.pruned",
        level:        "info",
        actor,
        resourceType: "polaris-agent",
        message:      `Manually pruned ${result.removed.length} old agent version(s), freed ${(totalBytes / (1024*1024)).toFixed(1)} MiB`,
        details:      { removed: result.removed, protected: result.protected, trigger: "manual" },
      });
    }
    res.json(result);
  } catch (err) { next(err); }
});

// Operator-settable URL override for what gets stamped into agent.conf at
// install time. Empty / null means "use the cert-derived default" — the
// resolver in agentInstallService.inferOwnServerUrl() falls back through
// POLARIS_PUBLIC_URL → HTTPS cert SAN/CN/IP → POLARIS_PUBLIC_HOST.
router.get("/agents/server-url", async (_req, res, next) => {
  try {
    const { prisma } = await import("../../db.js");
    const { AGENT_SERVER_URL_SETTING_KEY, inferOwnServerUrl, inferOwnServerUrlSync } =
      await import("../../services/agentInstallService.js");
    const row = await prisma.setting.findUnique({ where: { key: AGENT_SERVER_URL_SETTING_KEY } });
    const raw = (row?.value as { url?: string } | null)?.url;
    const override = raw && typeof raw === "string" && raw.trim() ? raw.trim().replace(/\/$/, "") : null;
    res.json({
      override,
      effective: await inferOwnServerUrl(),
      derived:   inferOwnServerUrlSync(),
    });
  } catch (err) { next(err); }
});

router.put("/agents/server-url", async (req, res, next) => {
  try {
    const { prisma } = await import("../../db.js");
    const { logEvent } = await import("./events.js");
    const { AGENT_SERVER_URL_SETTING_KEY, inferOwnServerUrl, inferOwnServerUrlSync } =
      await import("../../services/agentInstallService.js");
    const actor = req.session?.username || "unknown";
    const raw = req.body && typeof req.body.url !== "undefined" ? req.body.url : null;

    // Empty string / null / whitespace clears the override and falls back
    // to the derived default. Operators do this from the UI by emptying
    // the input + clicking Save.
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      await prisma.setting.delete({ where: { key: AGENT_SERVER_URL_SETTING_KEY } }).catch(() => { /* already absent */ });
      await logEvent({
        action:       "agent.server_url.cleared",
        level:        "info",
        actor,
        resourceType: "polaris-agent",
        message:      "Agent server-URL override cleared",
      });
      return res.json({
        override:  null,
        effective: await inferOwnServerUrl(),
        derived:   inferOwnServerUrlSync(),
      });
    }

    if (typeof raw !== "string") {
      return res.status(400).json({ error: "url must be a string" });
    }
    const trimmed = raw.trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(trimmed)) {
      return res.status(400).json({ error: "url must start with http:// or https://" });
    }
    try { new URL(trimmed); }
    catch { return res.status(400).json({ error: "url is not a valid absolute URL" }); }

    await prisma.setting.upsert({
      where:  { key: AGENT_SERVER_URL_SETTING_KEY },
      update: { value: { url: trimmed } as any },
      create: { key: AGENT_SERVER_URL_SETTING_KEY, value: { url: trimmed } as any },
    });
    await logEvent({
      action:       "agent.server_url.set",
      level:        "info",
      actor,
      resourceType: "polaris-agent",
      message:      `Agent server-URL override set to ${trimmed}`,
      details:      { url: trimmed },
    });
    res.json({
      override:  trimmed,
      effective: await inferOwnServerUrl(),
      derived:   inferOwnServerUrlSync(),
    });
  } catch (err) { next(err); }
});

// ─── Agent code signing (Azure Trusted Signing) ────────────────────────────
// Operator config for signing the two Windows agent binaries as a post-build
// step in agentBuildService (jsign + Azure Trusted Signing; FAIL-OPEN — a
// signing failure warns + stamps the sidebar-alert Setting but never blocks
// the build). Secret discipline mirrors notificationChannelService: the
// client secret is masked on read and preserved on write when the client
// echoes the mask back.

router.get("/agents/signing", async (_req, res, next) => {
  try {
    const { getSigningConfigMasked, signingAvailability } =
      await import("../../services/agentSigningService.js");
    const config = await getSigningConfigMasked();
    res.json({ config, availability: await signingAvailability() });
  } catch (err) { next(err); }
});

const SigningConfigSchema = z.object({
  enabled:      z.boolean().optional(),
  endpoint:     z.string().trim().max(300).optional(),
  accountName:  z.string().trim().max(200).optional(),
  profileName:  z.string().trim().max(200).optional(),
  tenantId:     z.string().trim().max(100).optional(),
  clientId:     z.string().trim().max(100).optional(),
  clientSecret: z.string().max(500).optional(),
  jsignJarPath: z.string().trim().max(500).optional(),
});

router.put("/agents/signing", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const { getSigningConfigRaw, updateSigningConfig, signingAvailability, MASK } =
      await import("../../services/agentSigningService.js");
    const { logEvent } = await import("./events.js");
    const actor = req.session?.username || "unknown";

    const parsed = SigningConfigSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const input = parsed.data;
    if (input.endpoint && !/^https:\/\//i.test(input.endpoint)) {
      return res.status(400).json({ error: "endpoint must start with https://" });
    }

    const before = await getSigningConfigRaw();
    const config = await updateSigningConfig(input);
    const clientSecretChanged =
      typeof input.clientSecret === "string" &&
      input.clientSecret.trim() !== "" &&
      input.clientSecret !== MASK;

    await logEvent({
      action:       "agent.signing.config_updated",
      level:        "info",
      actor,
      resourceType: "polaris-agent",
      message:      `Agent code-signing config updated (${config.enabled ? "enabled" : "disabled"})`,
      details: {
        enabled:            config.enabled,
        wasEnabled:         before.enabled,
        endpoint:           config.endpoint,
        accountName:        config.accountName,
        profileName:        config.profileName,
        tenantId:           config.tenantId,
        clientId:           config.clientId,
        clientSecretChanged,
      },
    });
    res.json({ config, availability: await signingAvailability() });
  } catch (err) { next(err); }
});

// Dry-run validation: availability probe + a REAL Entra ID token fetch
// (proves the tenant/client/secret triple without invoking jsign — there's
// nothing to sign outside a build). Gated fullwrite because it exercises the
// stored secret against Entra ID.
router.post("/agents/signing/test", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const { testSigningSetup } = await import("../../services/agentSigningService.js");
    const { logEvent } = await import("./events.js");
    const actor = req.session?.username || "unknown";
    const result = await testSigningSetup();
    await logEvent({
      action:       "agent.signing.test",
      level:        result.ok ? "info" : "warning",
      actor,
      resourceType: "polaris-agent",
      message:      `Agent code-signing test ${result.ok ? "succeeded" : "failed"}: ${result.message}`,
      details:      { ok: result.ok },
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── Agent cert-pin rotation (Phase 2 dual-pin) ────────────────────────────
// Operators stage a new pin BEFORE rotating the server cert so the entire
// agent fleet trusts both old + new pins during the rotation window. After
// every agent heartbeats post-rotation, the operator retires the old pin to
// re-narrow trust. The pin set lives on each ManagedAgent row across the
// `serverCertFingerprint` (canonical / first) + `additionalServerCertFingerprints`
// (staged) columns; the union is checked at enroll and pushed to agents via
// /config. See cross-cutting/polaris-agent → "Cert pin rotation" in TOUCHES.md.

const PinFingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/i, "fingerprint must be sha256:<64 hex chars>");

const CertPinBulkAddSchema = z.object({
  pin: PinFingerprintSchema,
});

const CertPinBulkRemoveSchema = z.object({
  pin: PinFingerprintSchema,
});

/**
 * Fleet-wide pin usage summary. Returns one entry per distinct pin observed
 * across all active ManagedAgents with separate counts for "canonical" (first
 * in the agent's pin list) and "staged" (in additionalServerCertFingerprints).
 * Drives the Maintenance card's rotation pane — the UI uses these numbers to
 * tell operators when it's safe to retire an old pin (no agent has it as its
 * only canonical with no staged replacement).
 */
router.get("/agents/cert-pins/summary", async (_req, res, next) => {
  try {
    const { prisma } = await import("../../db.js");
    const rows = await prisma.managedAgent.findMany({
      where:  { installStatus: "active" },
      select: {
        serverCertFingerprint:            true,
        additionalServerCertFingerprints: true,
      },
    });
    const tally = new Map<string, { canonical: number; staged: number }>();
    for (const r of rows) {
      const canon = r.serverCertFingerprint.toLowerCase();
      const entry = tally.get(canon) ?? { canonical: 0, staged: 0 };
      entry.canonical += 1;
      tally.set(canon, entry);
      for (const p of r.additionalServerCertFingerprints) {
        const key = p.toLowerCase();
        const e = tally.get(key) ?? { canonical: 0, staged: 0 };
        e.staged += 1;
        tally.set(key, e);
      }
    }
    res.json({
      totalActiveAgents: rows.length,
      pins: Array.from(tally.entries()).map(([pin, counts]) => ({ pin, ...counts })),
    });
  } catch (err) { next(err); }
});

/**
 * Stage a new pin across every active agent. Idempotent — agents that
 * already have the pin (canonical or staged) are skipped. Sends a
 * refresh-config WS frame to every connected agent so the pin set takes
 * effect within seconds; offline agents pick it up on next /config poll
 * (and restart via os.Exit so systemd cycles them with the new pin).
 */
router.post("/agents/cert-pins/bulk-add", async (req, res, next) => {
  try {
    const body = CertPinBulkAddSchema.parse(req.body);
    const pin = body.pin.toLowerCase();
    const { prisma } = await import("../../db.js");
    const { logEvent } = await import("./events.js");
    const { refreshConfig } = await import("../../services/agentChannelService.js");
    const actor = req.session?.username || "unknown";

    const rows = await prisma.managedAgent.findMany({
      where:  { installStatus: "active" },
      select: {
        id:                               true,
        serverCertFingerprint:            true,
        additionalServerCertFingerprints: true,
      },
    });

    let added = 0;
    let alreadyPresent = 0;
    for (const r of rows) {
      const union = [r.serverCertFingerprint.toLowerCase(), ...r.additionalServerCertFingerprints.map((p) => p.toLowerCase())];
      if (union.includes(pin)) {
        alreadyPresent += 1;
        continue;
      }
      await prisma.managedAgent.update({
        where: { id: r.id },
        data:  { additionalServerCertFingerprints: { push: pin } },
      });
      added += 1;
      // Fire-and-forget WS push so online agents apply within seconds.
      try { refreshConfig(r.id); } catch { /* offline — picks up next poll */ }
    }

    await logEvent({
      action:       "agent.cert_pin_staged_bulk",
      level:        "info",
      actor,
      resourceType: "polaris-agent",
      message:      `Staged cert pin on ${added} agent(s) (${alreadyPresent} already had it)`,
      details:      { pin, added, alreadyPresent, totalActive: rows.length },
    });
    res.json({ pin, added, alreadyPresent, totalActive: rows.length });
  } catch (err) { next(err); }
});

/**
 * Retire a pin across every active agent. When the pin is the canonical
 * one, the first staged pin gets promoted to canonical (otherwise the
 * agent would lose its only trust anchor). When the pin would be the
 * LAST trusted pin on an agent, that agent is left untouched and the
 * response carries `agentsWithLastPinSkipped: N` — the operator must
 * stage a replacement first.
 */
router.post("/agents/cert-pins/bulk-remove", async (req, res, next) => {
  try {
    const body = CertPinBulkRemoveSchema.parse(req.body);
    const pin = body.pin.toLowerCase();
    const { prisma } = await import("../../db.js");
    const { logEvent } = await import("./events.js");
    const { refreshConfig } = await import("../../services/agentChannelService.js");
    const actor = req.session?.username || "unknown";

    const rows = await prisma.managedAgent.findMany({
      where:  { installStatus: "active" },
      select: {
        id:                               true,
        serverCertFingerprint:            true,
        additionalServerCertFingerprints: true,
      },
    });

    let removed = 0;
    let notPresent = 0;
    let lastPinSkipped = 0;
    for (const r of rows) {
      const union = [r.serverCertFingerprint, ...r.additionalServerCertFingerprints];
      const remaining = union.filter((p) => p.toLowerCase() !== pin);
      if (remaining.length === union.length) {
        notPresent += 1;
        continue;
      }
      if (remaining.length === 0) {
        lastPinSkipped += 1;
        continue;
      }
      await prisma.managedAgent.update({
        where: { id: r.id },
        data: {
          serverCertFingerprint:            remaining[0],
          additionalServerCertFingerprints: remaining.slice(1),
        },
      });
      removed += 1;
      try { refreshConfig(r.id); } catch { /* offline */ }
    }

    await logEvent({
      action:       "agent.cert_pin_retired_bulk",
      level:        "info",
      actor,
      resourceType: "polaris-agent",
      message:      `Retired cert pin from ${removed} agent(s) (${lastPinSkipped} skipped: would have been last pin)`,
      details:      { pin, removed, notPresent, lastPinSkipped, totalActive: rows.length },
    });
    res.json({ pin, removed, notPresent, lastPinSkipped, totalActive: rows.length });
  } catch (err) { next(err); }
});

router.delete("/agents/build/:buildId", async (req, res, next) => {
  try {
    const { cancelBuild, BuildAlreadyFinishedError, BuildNotFoundError } =
      await import("../../services/agentBuildService.js");
    const actor = req.session?.username || "unknown";
    try {
      await cancelBuild(req.params.buildId as string, actor);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof BuildNotFoundError) {
        return res.status(404).json({ error: "Build not found" });
      }
      if (err instanceof BuildAlreadyFinishedError) {
        return res.status(409).json({ error: "Build already finished" });
      }
      throw err;
    }
  } catch (err) { next(err); }
});

export default router;
