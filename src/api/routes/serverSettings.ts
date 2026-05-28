/**
 * src/api/routes/serverSettings.ts — NTP and certificate management endpoints
 */

import { Router } from "express";
import multer from "multer";
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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getNtpSettings,
  updateNtpSettings,
  testNtpSync,
  listCertificates,
  addCertificate,
  deleteCertificate,
  getHttpsSettings,
  updateHttpsSettings,
  generateSelfSignedCert,
} from "../../services/serverSettingsService.js";
import { getDnsSettings, updateDnsSettings, createResolver } from "../../services/dnsService.js";
import type { DnsSettings } from "../../services/dnsService.js";
import { getOuiStatus, refreshOuiDatabase, getOuiOverrides, setOuiOverride, deleteOuiOverride } from "../../services/ouiService.js";
import { logEvent } from "./events.js";
import { setEnvVar } from "../../utils/envFile.js";
import {
  checkForUpdates,
  applyUpdate,
  getUpdateStatus,
  clearUpdateStatus,
  initUpdateStatus,
  isUpdateMechanismAvailable,
  getRecentCommits,
  restartService,
} from "../../services/updateService.js";
import { applyHttps, isHttpsRunning, isHttpsExternallyManaged, getHttpsPort } from "../../httpsRuntime.js";
import { getServerCertFingerprint, getServerCertHostnames, getServerCertExpiry } from "../../services/certInfo.js";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { hasActiveDiscoveries } from "./integrations.js";
import { logger } from "../../utils/logger.js";
import { getCapacitySnapshot, recordCapacityTransition } from "../../services/capacityService.js";
import { getSampleRetention, updateSampleRetention } from "../../services/sampleRetentionService.js";
import {
  getBootTimeMode,
  getQueueMode,
  setQueueMode,
  isPgbossInstalled,
} from "../../services/queueService.js";
import { BACKUP_DIR, UPLOADS_DIR } from "../../utils/paths.js";
import { getAppVersion } from "../../utils/version.js";
import { getDirectDatabaseUrl } from "../../utils/dbConnections.js";

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

router.get("/database", async (_req, res, next) => {
  try {
    // Query PostgreSQL for version, size, table stats, and connections
    const versionResult = await prisma.$queryRawUnsafe<any[]>("SELECT version()");
    const version = versionResult[0]?.version || "Unknown";

    const dbNameResult = await prisma.$queryRawUnsafe<any[]>("SELECT current_database() AS db");
    const dbName = dbNameResult[0]?.db || "unknown";

    const sizeResult = await prisma.$queryRawUnsafe<any[]>(
      "SELECT pg_size_pretty(pg_database_size(current_database())) AS size"
    );
    const databaseSize = sizeResult[0]?.size || "Unknown";

    // Restrict to the public schema so pg-boss's internal tables (in the
    // `pgboss` schema, including `pgboss.version`) don't show up in the
    // operator-facing table list AND don't trip pg_total_relation_size(quote_ident(relname))
    // — that helper produces an unqualified identifier, which Postgres
    // tries to resolve via search_path; tables outside `public` fail with
    // `relation "<name>" does not exist`.
    const tablesResult = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        relname AS name,
        n_live_tup::integer AS rows,
        pg_size_pretty(pg_total_relation_size(quote_ident(relname))) AS size
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(quote_ident(relname)) DESC
    `);
    const tables = tablesResult.map((t: any) => ({
      name: t.name,
      rows: Number(t.rows),
      size: t.size,
    }));

    const connResult = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        (SELECT count(*)::integer FROM pg_stat_activity WHERE datname = current_database()) AS active,
        (SELECT setting::integer FROM pg_settings WHERE name = 'max_connections') AS max
    `);
    const activeConnections = Number(connResult[0]?.active || 0);
    const maxConnections = Number(connResult[0]?.max || 100);

    const uptimeResult = await prisma.$queryRawUnsafe<any[]>(
      "SELECT date_trunc('second', current_timestamp - pg_postmaster_start_time())::text AS uptime"
    );
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
    const sslResult = await prisma.$queryRawUnsafe<{ ssl: boolean }[]>(
      "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
    );
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

router.post("/database/backup", async (req, res, next) => {
  try {
    const password: string | null = req.body?.password || null;
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

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", payload.length);
    res.end(payload);
  } catch (err) {
    next(err);
  }
});

router.post("/database/restore", restoreUpload.single("file"), async (req, res, next) => {
  // Track upload temp file for cleanup regardless of outcome
  const uploadedPath: string | undefined = (req.file as any)?.path;
  let decryptedTempPath: string | null = null;

  try {
    if (!req.file) throw new AppError(400, "No backup file uploaded");
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

router.get("/database/backups", async (_req, res, next) => {
  try {
    const existing = await prisma.setting.findUnique({ where: { key: "backup_history" } });
    const history: any[] = existing?.value && Array.isArray(existing.value) ? existing.value as any[] : [];
    const enriched = history.map((r: any) => ({ ...r, path: join(BACKUP_DIR, r.id) }));
    res.json(enriched.reverse());
  } catch (err) {
    next(err);
  }
});

router.delete("/database/backups/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.setting.findUnique({ where: { key: "backup_history" } });
    const history: any[] = existing?.value && Array.isArray(existing.value) ? existing.value as any[] : [];
    const idx = history.findIndex((r: any) => r.id === id);
    if (idx === -1) throw new AppError(404, "Backup not found");

    history.splice(idx, 1);
    await prisma.setting.upsert({
      where: { key: "backup_history" },
      update: { value: history },
      create: { key: "backup_history", value: history },
    });

    const filePath = join(BACKUP_DIR, id);
    if (existsSync(filePath)) unlinkSync(filePath);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.get("/database/backups/:id/download", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.setting.findUnique({ where: { key: "backup_history" } });
    const history: any[] = existing?.value && Array.isArray(existing.value) ? existing.value as any[] : [];
    const record = history.find((r: any) => r.id === id);
    if (!record) throw new AppError(404, "Backup not found");

    const filePath = join(BACKUP_DIR, id);
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

    const tag = await prisma.tag.create({
      data: {
        name,
        category: req.body.category || "General",
        color: req.body.color || randomTagColor(),
      },
    });
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

    const tag = await prisma.tag.update({
      where: { id },
      data: {
        name,
        category: req.body.category ?? existing.category,
        color: req.body.color ?? existing.color,
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

    res.json(tag);
  } catch (err) {
    next(err);
  }
});

router.delete("/tags/:id", async (req, res, next) => {
  try {
    const tag = await prisma.tag.findUnique({ where: { id: req.params.id } });
    if (!tag) throw new AppError(404, "Tag not found");
    await prisma.tag.delete({ where: { id: req.params.id } });
    res.status(204).send();
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

// Server-leaf cert mutations are inert in proxy mode — nginx owns TLS. CA
// records (category="ca") stay editable because outbound TLS to integrations
// (LDAP, SMTP) still depends on them. The 409 message is the actionable
// guidance for an operator who landed here from the UI without realizing
// they're in proxy mode.
const PROXY_LEAF_LOCKED_MESSAGE =
  "Polaris is fronted by an external proxy; manage the server cert via POLARIS_PROXY_CERT_PATH";

router.post("/certificates", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const category = req.body.category === "server" ? "server" : "ca";
    if (category === "server" && isHttpsExternallyManaged()) {
      return res.status(409).json({ error: PROXY_LEAF_LOCKED_MESSAGE });
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
    if (isHttpsExternallyManaged()) {
      // Look up the record's category before refusing — CA records stay deletable.
      const all = await listCertificates();
      const target = [...all.serverCerts, ...all.trustedCAs].find((c) => c.id === req.params.id);
      if (target && target.category === "server") {
        return res.status(409).json({ error: PROXY_LEAF_LOCKED_MESSAGE });
      }
    }
    await deleteCertificate(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post("/certificates/generate", async (req, res, next) => {
  try {
    if (isHttpsExternallyManaged()) {
      return res.status(409).json({ error: PROXY_LEAF_LOCKED_MESSAGE });
    }
    const cn = req.body.commonName || "localhost";
    const days = Math.min(3650, Math.max(1, parseInt(req.body.days, 10) || 365));
    const result = await generateSelfSignedCert(cn, days);
    res.status(201).json({
      cert: { ...result.cert, pem: undefined },
      key: { ...result.key, pem: undefined },
    });
  } catch (err) {
    next(err);
  }
});

// ─── HTTPS ──────────────────────────────────────────────────────────────────

router.get("/https", async (_req, res, next) => {
  try {
    if (isHttpsExternallyManaged()) {
      // Proxy mode: the cert lives in a file nginx reads. Return what the
      // Identification tab needs to render an informational pane —
      // fingerprint (for the agent-pin check operators rely on), SANs (so
      // they can verify the cert claims the right names), expiry (so the
      // amber/red pill fires before the cert lapses), and the file path
      // they'd edit. Keep `enabled`/`port` populated so any existing
      // frontend code reading those keys doesn't crash.
      const hosts = getServerCertHostnames();
      return res.json({
        externallyManaged: true,
        running: true,
        enabled: true,
        port: getHttpsPort() ?? 443,
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
    }
    const settings = await getHttpsSettings();
    res.json({ ...settings, running: isHttpsRunning(), externallyManaged: false });
  } catch (err) {
    next(err);
  }
});

router.put("/https", async (req, res, next) => {
  try {
    if (isHttpsExternallyManaged()) {
      return res.status(409).json({ error: PROXY_LEAF_LOCKED_MESSAGE });
    }
    const settings = await updateHttpsSettings(req.body);
    res.json({ ...settings, running: isHttpsRunning() });
  } catch (err) {
    next(err);
  }
});

router.post("/https/apply", async (_req, res, next) => {
  try {
    if (isHttpsExternallyManaged()) {
      return res.status(409).json({ error: PROXY_LEAF_LOCKED_MESSAGE });
    }
    const result = await applyHttps();
    res.json({ ...result, running: isHttpsRunning() });
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

    const saved = await updateDnsSettings({ servers, mode, dohUrl });
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
    const testIp = req.body.testIp || "8.8.8.8";

    if (mode === "doh" && !dohUrl) {
      return res.json({ ok: false, message: "No DoH URL configured", results: [] });
    }

    const targets = mode === "doh"
      ? [{ label: `DoH (${dohUrl})`, settings: { servers: [], mode, dohUrl } as DnsSettings }]
      : mode === "dot"
        ? servers.map((s) => ({ label: `DoT (${s}:853)`, settings: { servers: [s], mode, dohUrl: "" } as DnsSettings }))
        : servers.length > 0
          ? servers.map((s) => ({ label: s, settings: { servers: [s], mode: "standard" as const, dohUrl: "" } }))
          : [{ label: "system DNS", settings: { servers: [], mode: "standard" as const, dohUrl: "" } }];

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

    res.json({ ...result, assetsUpdated: updated.count });
  } catch (err) {
    next(err);
  }
});

router.delete("/oui/overrides/:prefix", async (req, res, next) => {
  try {
    await deleteOuiOverride(req.params.prefix);
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

// Returns minimum host RAM (bytes) recommended for a database of the given size.
// Target: ~2x the DB size (half as Postgres shared_buffers + OS page cache,
// half as OS/application overhead), with a 4 GB floor. Rounded up to the next
// power of two to match common server RAM sizes.
function getMinRecommendedRamBytes(dbSizeBytes: number): number {
  const GB = 1024 * 1024 * 1024;
  const target = Math.max(4 * GB, dbSizeBytes * 2);
  return Math.pow(2, Math.ceil(Math.log2(target / GB))) * GB;
}

// Server RAM ships in standard sizes (commonly powers of 2: 4/8/16/32/64 GiB),
// but the kernel reserves a few percent for firmware/iGPU/etc., so totalmem()
// reports less than the installed amount — a 16 GiB box typically shows up as
// ~15.4–15.7 GiB. Snap to the nearest power-of-2 GiB when within 10%, so the
// displayed size matches what the operator put in the slot and the comparison
// against a power-of-2 recommendation doesn't trip on rounding alone. Falls
// back to nearest-integer GiB for non-pow2 sizes (12 / 24 / 48 GiB).
function detectInstalledRamGb(rawBytes: number): number {
  const GB = 1024 * 1024 * 1024;
  const rawGb = rawBytes / GB;
  if (rawGb < 1) return Math.max(1, Math.round(rawGb));
  const nextPow2 = Math.pow(2, Math.ceil(Math.log2(rawGb)));
  if (rawGb / nextPow2 >= 0.90) return nextPow2;
  return Math.round(rawGb);
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
 * pg_settings config-file path, plus the `recommendedRamGb` and `pgTuningNeeded`
 * values consumed by capacityService.
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
}
interface PgTuningResult {
  settings: PgTuningRow[];
  pgConfigFile: string | null;
  /** 0 = RAM is sufficient; positive = the recommended minimum GB (next power-of-2 above 2× DB size). */
  recommendedRamGb: number;
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

  const pgSettings = await prisma.$queryRawUnsafe<{ name: string; setting: string; unit: string | null }[]>(
    `SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers', 'work_mem', 'effective_cache_size', 'random_page_cost', 'config_file')`
  );
  const pgConfigFile = pgSettings.find((s) => s.name === "config_file")?.setting || null;

  const dbSizeResult = await prisma.$queryRawUnsafe<{ size: bigint }[]>(
    "SELECT pg_database_size(current_database()) AS size"
  );
  const dbSizeBytes = Number(dbSizeResult[0]?.size ?? 0);
  const GB = 1024 * 1024 * 1024;
  const currentRam = totalmem();
  // Compare against the raw 2× target so pow2 rounding doesn't create a
  // false positive: a 20 GB DB has a raw target of 40 GB. If the server has
  // 32 GB the warning fires correctly (32 < 40); if the DB is 15 GB the
  // target is 30 GB and 32 GB is sufficient — no false positive.
  // The display value (next power-of-2 above the raw target) is used only
  // in the suggestion text so it names a standard server RAM tier to aim for.
  const rawTargetBytes = Math.max(4 * GB, dbSizeBytes * 2);
  const ramInsufficient = currentRam < rawTargetBytes;
  const recommendedRamGb = ramInsufficient
    ? Math.pow(2, Math.ceil(Math.log2(rawTargetBytes / GB)))
    : 0;

  const PG_RECOMMENDED = buildPgRecommended();
  const settings: PgTuningRow[] = pgSettings.map((s) => {
    if (s.name === "config_file") return null;
    const rec = PG_RECOMMENDED[s.name];
    if (!rec) return null;
    let currentBytes: number;
    let ok: boolean;
    if (s.name === "random_page_cost") {
      const val = parseFloat(s.setting);
      ok = val <= 1.1;
      return { name: s.name, current: String(val), recommended: rec.display, ok };
    }
    if (s.unit === "8kB") {
      currentBytes = parseInt(s.setting, 10) * 8192;
    } else if (s.unit === "kB") {
      currentBytes = parseInt(s.setting, 10) * 1024;
    } else {
      currentBytes = parsePgBytes(s.setting);
    }
    ok = currentBytes >= rec.min;
    let currentDisplay: string;
    if (currentBytes >= 1024 * 1024 * 1024) currentDisplay = (currentBytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "") + "GB";
    else if (currentBytes >= 1024 * 1024) currentDisplay = (currentBytes / (1024 * 1024)).toFixed(0) + "MB";
    else currentDisplay = (currentBytes / 1024).toFixed(0) + "kB";
    return { name: s.name, current: currentDisplay, recommended: rec.display, ok };
  }).filter((s): s is PgTuningRow => s !== null);

  const allOk = settings.every((s) => s.ok);
  return { settings, pgConfigFile, recommendedRamGb, pgTuningNeeded: !allOk };
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
    },
    effectiveCacheSize: {
      current: ec?.current ?? null,
      recommended: ec?.recommended ?? PG_DEFAULTS.effective_cache_size.display,
      changeRequired: ec ? !ec.ok : false,
    },
    workMem: {
      current: wm?.current ?? null,
      recommended: wm?.recommended ?? PG_DEFAULTS.work_mem.display,
      changeRequired: wm ? !wm.ok : false,
    },
    randomPageCost: {
      current: rp?.current ?? null,
      recommended: rp?.recommended ?? PG_DEFAULTS.random_page_cost.display,
      changeRequired: rp ? !rp.ok : false,
    },
  };
}

router.get("/pg-tuning", async (_req, res, next) => {
  try {
    const tuning = await computePgTuning();
    if (!tuning) {
      const capacity = await getCapacitySnapshot({ recommendedRamGb: 0, pgTuningNeeded: false });
      void recordCapacityTransition(capacity);
      return res.json({ settings: [], pgConfigFile: null, capacity });
    }

    // Layer the capacity snapshot on top so callers get a single source of
    // truth for severity, reasons, host stats, sample-table breakdown, and
    // steady-state size projection. The card consumes `settings` + `pgConfigFile`
    // alongside `capacity` to render the inline pg-tuning rows under the
    // `pg_tuning_needed` reason.
    const capacity = await getCapacitySnapshot({
      recommendedRamGb: tuning.recommendedRamGb,
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
      recommendedRamGb: tuning?.recommendedRamGb ?? 0,
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
      recommendedRamGb: tuning?.recommendedRamGb ?? 0,
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
    const setting = await prisma.setting.findUnique({ where: { key: "update.skip_backup" } });
    res.json({ skipBackup: setting?.value === true });
  } catch (err) {
    next(err);
  }
});

router.put("/updates/settings", async (req, res, next) => {
  try {
    const skipBackup = !!req.body?.skipBackup;
    await prisma.setting.upsert({
      where: { key: "update.skip_backup" },
      update: { value: skipBackup },
      create: { key: "update.skip_backup", value: skipBackup },
    });
    res.json({ skipBackup });
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
    res.json({ ...updated, version: APP_VERSION });
  } catch (err) {
    next(err);
  }
});

const LOGO_DIR = UPLOADS_DIR;
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post("/branding/logo", logoUpload.single("file"), async (req, res, next) => {
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
    res.json({ ...updated, version: APP_VERSION });
  } catch (err) {
    next(err);
  }
});

router.delete("/branding/logo", async (_req, res, next) => {
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
 * per-version counts so the UI can render "N of M installed agents are
 * out-of-date" without fetching every ManagedAgent row.
 */
router.get("/agents/installed-summary", async (_req, res, next) => {
  try {
    const { prisma } = await import("../../db.js");
    const { getInventory } = await import("../../services/agentBuildService.js");
    const inv = await getInventory();
    const rows = await prisma.managedAgent.findMany({
      where:  { installStatus: "active" },
      select: { agentVersion: true },
    });
    const histogram = new Map<string, number>();
    for (const r of rows) {
      const v = r.agentVersion ?? "unknown";
      histogram.set(v, (histogram.get(v) ?? 0) + 1);
    }
    const current = inv.manifest?.currentVersion ?? null;
    let outOfDate = 0;
    for (const [v, n] of histogram) {
      if (current && v !== current) outOfDate += n;
    }
    res.json({
      totalActive:    rows.length,
      currentVersion: current,
      outOfDate,
      byVersion:      Object.fromEntries(histogram),
    });
  } catch (err) { next(err); }
});

/**
 * Bulk-upgrade every active ManagedAgent whose agentVersion lags the
 * current manifest. Each per-agent upgrade goes through the regular
 * state machine + per-agent audit events, so partial failures land
 * naturally as installStatus="upgrade_failed" per row.
 *
 * Promise pool of 4 — the SSH/WinRM connections are the bottleneck;
 * higher parallelism risks tripping concurrent-connection limits on
 * some hosts (Windows WinRM caps at ~5 by default).
 */
router.post("/agents/upgrade-all", async (req, res, next) => {
  try {
    const { prisma } = await import("../../db.js");
    const { getInventory } = await import("../../services/agentBuildService.js");
    const { startUpgrade } = await import("../../services/agentInstallService.js");
    const actor = req.session?.username || "unknown";

    const inv = await getInventory();
    const currentVersion = inv.manifest?.currentVersion;
    if (!currentVersion) {
      return res.status(400).json({ error: "No agent binaries available — build them first." });
    }

    const eligible = await prisma.managedAgent.findMany({
      where: {
        installStatus: "active",
        NOT: { agentVersion: currentVersion },
      },
      select: { id: true, assetId: true, agentVersion: true },
    });

    // Promise pool — bounded concurrency. Cheap manual implementation
    // since we don't need anything fancier.
    const perAsset: Array<{ assetId: string; managedAgentId: string; ok: boolean; error?: string }> = [];
    const POOL = 4;
    let cursor = 0;
    async function worker() {
      while (cursor < eligible.length) {
        const i = cursor++;
        const e = eligible[i];
        try {
          await startUpgrade({ managedAgentId: e.id, actor });
          perAsset.push({ assetId: e.assetId, managedAgentId: e.id, ok: true });
        } catch (err: any) {
          perAsset.push({ assetId: e.assetId, managedAgentId: e.id, ok: false, error: err?.message ?? String(err) });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(POOL, eligible.length) }, () => worker()));

    res.json({
      eligible: eligible.length,
      queued:   perAsset.filter((p) => p.ok).length,
      perAsset,
    });
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
