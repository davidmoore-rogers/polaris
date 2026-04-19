/**
 * src/api/routes/serverSettings.ts — NTP and certificate management endpoints
 */

import { Router } from "express";
import multer from "multer";
import { execSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
import {
  checkForUpdates,
  applyUpdate,
  getUpdateStatus,
  clearUpdateStatus,
  initUpdateStatus,
} from "../../services/updateService.js";
import { applyHttps, isHttpsRunning } from "../../httpsManager.js";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });
const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });

const APP_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Works from both src/ (dev) and dist/ (build)
    for (const rel of ["../../../package.json", "../../package.json"]) {
      const p = join(here, rel);
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8")).version || "0.0.0";
    }
    return "0.0.0";
  } catch { return "0.0.0"; }
})();

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

    const tablesResult = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        relname AS name,
        n_live_tup::integer AS rows,
        pg_size_pretty(pg_total_relation_size(quote_ident(relname))) AS size
      FROM pg_stat_user_tables
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
    const ssl = connUrl.includes("sslmode=require") || connUrl.includes("ssl=true") ? "Enabled" : "Disabled";

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

const BACKUP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "backups");
mkdirSync(BACKUP_DIR, { recursive: true });

router.post("/database/backup", async (req, res, next) => {
  try {
    const password: string | null = req.body?.password || null;
    const connUrl = process.env.DATABASE_URL || "";
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupId = `bk-${Date.now()}`;
    const filename = `shelob-backup-${APP_VERSION}-${ts}${password ? ".enc" : ""}.gz`;
    const tmpFile = join(tmpdir(), `shelob-dump-${Date.now()}.sql`);

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
      const magic = Buffer.from("SHELOB1\0");
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
  try {
    if (!req.file) throw new AppError(400, "No backup file uploaded");
    const password: string | null = req.body?.password || null;
    const connUrl = process.env.DATABASE_URL || "";

    let payload = req.file.buffer;

    // Check if encrypted
    const magic = Buffer.from("SHELOB1\0");
    const isEncrypted = payload.length > 72 && payload.subarray(0, 8).equals(magic);

    if (isEncrypted) {
      if (!password) throw new AppError(400, "This backup is encrypted — a password is required to restore it");
      const salt = payload.subarray(8, 40);
      const iv = payload.subarray(40, 56);
      const authTag = payload.subarray(56, 72);
      const ciphertext = payload.subarray(72);
      const key = scryptSync(password, salt, 32);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      try {
        payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new AppError(400, "Decryption failed — incorrect password or corrupted file");
      }
    }

    // Decompress
    try {
      payload = gunzipSync(payload);
    } catch {
      throw new AppError(400, "Decompression failed — file is not a valid gzip archive");
    }

    // Write SQL to temp file and restore with psql
    const tmpFile = join(tmpdir(), `shelob-restore-${Date.now()}.sql`);
    writeFileSync(tmpFile, payload);

    try {
      // --single-transaction: rollback everything if any statement fails
      execSync(`psql "${connUrl}" --single-transaction -f "${tmpFile}"`, {
        timeout: 120000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      throw new AppError(500, "psql restore failed: " + (err.stderr?.toString() || err.message));
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }

    res.json({ ok: true, message: "Database restored successfully" });
  } catch (err) {
    next(err);
  }
});

router.get("/database/backups", async (_req, res, next) => {
  try {
    const existing = await prisma.setting.findUnique({ where: { key: "backup_history" } });
    const history: any[] = existing?.value && Array.isArray(existing.value) ? existing.value as any[] : [];
    res.json(history.reverse());
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
        color: req.body.color || "#4fc3f7",
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

    if (name !== existing.name) {
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

router.post("/certificates", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const category = req.body.category === "server" ? "server" : "ca";
    const pem = req.file.buffer.toString("utf-8");
    const record = await addCertificate(category as any, req.file.originalname, pem);
    res.status(201).json({ ...record, pem: undefined });
  } catch (err) {
    next(err);
  }
});

router.delete("/certificates/:id", async (req, res, next) => {
  try {
    await deleteCertificate(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post("/certificates/generate", async (req, res, next) => {
  try {
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
    const settings = await getHttpsSettings();
    res.json({ ...settings, running: isHttpsRunning() });
  } catch (err) {
    next(err);
  }
});

router.put("/https", async (req, res, next) => {
  try {
    const settings = await updateHttpsSettings(req.body);
    res.json({ ...settings, running: isHttpsRunning() });
  } catch (err) {
    next(err);
  }
});

router.post("/https/apply", async (_req, res, next) => {
  try {
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
      return res.json({ ok: false, message: "No DoH URL configured" });
    }

    const resolver = await createResolver({ servers, mode, dohUrl });
    const start = Date.now();
    try {
      const hostnames = await resolver.reverse(testIp);
      const elapsed = Date.now() - start;
      const via = mode === "doh" ? `DoH (${dohUrl})` : mode === "dot" ? `DoT (${servers[0]}:853)` : servers.length > 0 ? servers[0] : "system DNS";
      res.json({
        ok: true,
        message: `Resolved ${testIp} → ${hostnames[0] || "(no PTR)"} in ${elapsed}ms via ${via}`,
      });
    } catch (dnsErr: any) {
      const elapsed = Date.now() - start;
      if (dnsErr.code === "ENOTFOUND" || dnsErr.code === "ENODATA") {
        res.json({ ok: true, message: `Server reachable but no PTR record for ${testIp} (${elapsed}ms)` });
      } else {
        res.json({ ok: false, message: `DNS query failed: ${dnsErr.code || dnsErr.message} (${elapsed}ms)` });
      }
    }
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
    const { prefix, manufacturer } = req.body;
    if (!prefix || !manufacturer) throw new AppError(400, "prefix and manufacturer are required");
    const clean = prefix.replace(/[:\-.\s]/g, "").toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(clean)) throw new AppError(400, "prefix must be 6 hex characters (e.g. AA:BB:CC)");
    const result = await setOuiOverride(prefix, manufacturer.trim());

    // Update matching assets — match MAC addresses starting with this prefix
    // MAC format in DB is uppercase colon-separated: "AA:BB:CC:DD:EE:FF"
    const macPrefix = clean.match(/.{2}/g)!.join(":");
    const updated = await prisma.asset.updateMany({
      where: { macAddress: { startsWith: macPrefix } },
      data: { manufacturer: manufacturer.trim() },
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

// ─── PostgreSQL Tuning Check ───────────────────────────────────────────────

const PG_TUNING_THRESHOLDS = {
  assets: 160,        // 80% of 200
  subnets: 1600,      // 80% of 2,000
  reservations: 160000, // 80% of 200,000
};

const PG_RECOMMENDED: Record<string, { min: number; unit: string; display: string }> = {
  shared_buffers:     { min: 2 * 1024 * 1024 * 1024,   unit: "bytes", display: "2GB" },
  work_mem:           { min: 32 * 1024 * 1024,          unit: "bytes", display: "32MB" },
  effective_cache_size:{ min: 4 * 1024 * 1024 * 1024,   unit: "bytes", display: "4GB" },
  random_page_cost:   { min: -1,                        unit: "cost",  display: "1.1" }, // special: ≤ 1.1
};

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

router.get("/pg-tuning", async (_req, res, next) => {
  try {
    // 1. Count records to see if any threshold is crossed
    const [assetCount, subnetCount, reservationCount] = await Promise.all([
      prisma.asset.count(),
      prisma.subnet.count(),
      prisma.reservation.count(),
    ]);

    const triggered: string[] = [];
    if (assetCount >= PG_TUNING_THRESHOLDS.assets) triggered.push("assets");
    if (subnetCount >= PG_TUNING_THRESHOLDS.subnets) triggered.push("subnets");
    if (reservationCount >= PG_TUNING_THRESHOLDS.reservations) triggered.push("reservations");

    if (!triggered.length) {
      return res.json({ needed: false, triggered: [], settings: [], snoozedUntil: null });
    }

    // 2. Check snooze state
    const snoozeRow = await prisma.setting.findUnique({ where: { key: "pg_tuning_snooze" } });
    const snoozedUntil = (snoozeRow?.value as any)?.until || null;
    const isSnoozed = snoozedUntil && new Date(snoozedUntil) > new Date();

    // 3. Query current PostgreSQL settings
    const pgSettings = await prisma.$queryRawUnsafe<{ name: string; setting: string; unit: string | null }[]>(
      `SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers', 'work_mem', 'effective_cache_size', 'random_page_cost')`
    );

    const settings = pgSettings.map((s) => {
      const rec = PG_RECOMMENDED[s.name];
      if (!rec) return null;

      let currentBytes: number;
      let ok: boolean;

      if (s.name === "random_page_cost") {
        const val = parseFloat(s.setting);
        ok = val <= 1.1;
        return { name: s.name, current: String(val), recommended: rec.display, ok };
      }

      // PostgreSQL reports shared_buffers in 8kB pages, work_mem in kB, etc.
      if (s.unit === "8kB") {
        currentBytes = parseInt(s.setting, 10) * 8192;
      } else if (s.unit === "kB") {
        currentBytes = parseInt(s.setting, 10) * 1024;
      } else {
        currentBytes = parsePgBytes(s.setting);
      }

      ok = currentBytes >= rec.min;
      // Format current value for display
      let currentDisplay: string;
      if (currentBytes >= 1024 * 1024 * 1024) currentDisplay = (currentBytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "") + "GB";
      else if (currentBytes >= 1024 * 1024) currentDisplay = (currentBytes / (1024 * 1024)).toFixed(0) + "MB";
      else currentDisplay = (currentBytes / 1024).toFixed(0) + "kB";

      return { name: s.name, current: currentDisplay, recommended: rec.display, ok };
    }).filter(Boolean);

    const allOk = settings.every((s: any) => s.ok);

    res.json({
      needed: !allOk,
      triggered,
      counts: { assets: assetCount, subnets: subnetCount, reservations: reservationCount },
      thresholds: PG_TUNING_THRESHOLDS,
      settings,
      snoozedUntil: isSnoozed ? snoozedUntil : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/pg-tuning/snooze", async (req, res, next) => {
  try {
    const days = Math.min(30, Math.max(1, parseInt(req.body?.days, 10) || 7));
    const until = new Date(Date.now() + days * 86400000).toISOString();
    await prisma.setting.upsert({
      where: { key: "pg_tuning_snooze" },
      update: { value: { until } },
      create: { key: "pg_tuning_snooze", value: { until } },
    });
    res.json({ ok: true, snoozedUntil: until });
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

router.post("/updates/apply", async (_req, res, next) => {
  try {
    const status = getUpdateStatus();
    if (status.state === "applying" || status.state === "restarting") {
      return res.status(409).json({ error: "An update is already in progress" });
    }
    // Start the update in the background
    applyUpdate().catch((err) => {
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

// ─── Branding ─────────────────────────────────────────────────────────────

interface BrandingSettings {
  appName: string;
  subtitle: string;
  logoUrl: string;
}

const BRANDING_DEFAULTS: BrandingSettings = {
  appName: "Shelob",
  subtitle: "Network Management Tool",
  logoUrl: "/logo.webp",
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

const LOGO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "public", "uploads");
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post("/branding/logo", logoUpload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, "No file uploaded");
    const ext = req.file.mimetype === "image/svg+xml" ? ".svg"
      : req.file.mimetype === "image/png" ? ".png"
      : req.file.mimetype === "image/webp" ? ".webp"
      : req.file.mimetype === "image/jpeg" ? ".jpg"
      : null;
    if (!ext) throw new AppError(400, "Unsupported image format");

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

export default router;
