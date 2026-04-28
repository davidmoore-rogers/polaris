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
import {
  listMibs,
  getMib,
  createMib,
  deleteMib,
  getMibFacets,
  getProfileStatus,
} from "../../services/mibService.js";
import { logEvent } from "./events.js";
import {
  checkForUpdates,
  applyUpdate,
  getUpdateStatus,
  clearUpdateStatus,
  initUpdateStatus,
  getRecentCommits,
} from "../../services/updateService.js";
import { applyHttps, isHttpsRunning } from "../../httpsManager.js";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { hasActiveDiscoveries } from "./integrations.js";
import { logger } from "../../utils/logger.js";
import { getCapacitySnapshot } from "../../services/capacityService.js";

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

const APP_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ["../../../package.json", "../../package.json"]) {
      const p = join(here, rel);
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf-8"));
      const [major, minor] = (pkg.version || "0.9.0").split(".");
      try {
        // Patch = git commit count, so version always matches the commit
        const patch = execSync("git rev-list --count HEAD", { encoding: "utf-8" }).trim();
        return `${major}.${minor}.${patch}`;
      } catch {
        return pkg.version || "0.0.0";
      }
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
  // Track upload temp file for cleanup regardless of outcome
  const uploadedPath: string | undefined = (req.file as any)?.path;
  let decryptedTempPath: string | null = null;

  try {
    if (!req.file) throw new AppError(400, "No backup file uploaded");
    if (hasActiveDiscoveries()) throw new AppError(409, "A discovery is currently running — wait for it to finish or abort it before restoring");
    const password: string | null = req.body?.password || null;
    const connUrl = process.env.DATABASE_URL || "";

    // Check magic bytes from disk to detect encryption without loading the whole file
    const magic = Buffer.from("SHELOB1\0");
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

router.post("/certificates", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const category = req.body.category === "server" ? "server" : "ca";
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

// ─── MIB Database ──────────────────────────────────────────────────────────

router.get("/mibs/facets", async (_req, res, next) => {
  try {
    res.json(await getMibFacets());
  } catch (err) {
    next(err);
  }
});

router.get("/mibs/profile-status", async (_req, res, next) => {
  try {
    res.json(await getProfileStatus());
  } catch (err) {
    next(err);
  }
});

router.get("/mibs", async (req, res, next) => {
  try {
    const scopeRaw = typeof req.query.scope === "string" ? req.query.scope : "all";
    const scope: "all" | "device" | "generic" =
      scopeRaw === "device" || scopeRaw === "generic" ? scopeRaw : "all";
    const manufacturer = typeof req.query.manufacturer === "string" && req.query.manufacturer.trim()
      ? req.query.manufacturer.trim()
      : undefined;
    const model = typeof req.query.model === "string" && req.query.model.trim()
      ? req.query.model.trim()
      : undefined;
    res.json(await listMibs({ manufacturer, model, scope }));
  } catch (err) {
    next(err);
  }
});

router.get("/mibs/:id/download", async (req, res, next) => {
  try {
    const row = await getMib(req.params.id);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${row.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    res.send(row.contents);
  } catch (err) {
    next(err);
  }
});

router.get("/mibs/:id", async (req, res, next) => {
  try {
    res.json(await getMib(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post("/mibs", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, "No MIB file uploaded");
    const text = req.file.buffer.toString("utf-8");
    const created = await createMib({
      filename: req.file.originalname,
      contents: text,
      manufacturer: typeof req.body?.manufacturer === "string" ? req.body.manufacturer : null,
      model: typeof req.body?.model === "string" ? req.body.model : null,
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
      uploadedBy: req.session?.username ?? null,
    });
    logEvent({
      action: "mib.uploaded",
      actor: req.session?.username,
      resourceType: "mib",
      resourceId: created.id,
      resourceName: created.moduleName,
      message:
        `Uploaded MIB ${created.moduleName}` +
        (created.manufacturer ? ` for ${created.manufacturer}${created.model ? ` ${created.model}` : ""}` : " (generic)"),
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.delete("/mibs/:id", async (req, res, next) => {
  try {
    const row = await getMib(req.params.id);
    await deleteMib(req.params.id);
    logEvent({
      action: "mib.deleted",
      actor: req.session?.username,
      resourceType: "mib",
      resourceId: row.id,
      resourceName: row.moduleName,
      message: `Deleted MIB ${row.moduleName}`,
    });
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

function buildPgRecommended(): Record<string, { min: number; unit: string; display: string }> {
  const ram = totalmem();
  const MB = 1024 * 1024;
  const GB = 1024 * MB;

  // Floor all values to whole-MB boundaries so recommendations match what
  // PostgreSQL accepts and comparisons don't produce "60MB → 60MB" false positives.
  const floorMB = (b: number) => Math.floor(b / MB) * MB;
  const floorGB = (b: number) => Math.floor(b / GB) * GB;

  const sharedBuffers = Math.max(128 * MB, floorGB(ram * 0.25) || floorMB(ram * 0.25));
  const effectiveCache = Math.max(256 * MB, floorGB(ram * 0.75) || floorMB(ram * 0.75));
  // work_mem: RAM/128, capped at 256 MB, min 32 MB
  const workMem = Math.max(32 * MB, Math.min(256 * MB, floorMB(ram / 128)));

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

    const counts = { assets: assetCount, subnets: subnetCount, reservations: reservationCount };
    const dbSizeResult = await prisma.$queryRawUnsafe<{ size: bigint }[]>(
      "SELECT pg_database_size(current_database()) AS size"
    );
    const dbSizeBytes = Number(dbSizeResult[0]?.size ?? 0);
    const minRam = getMinRecommendedRamBytes(dbSizeBytes);
    const currentRam = totalmem();
    const GB = 1024 * 1024 * 1024;
    const currentRamGb    = Math.round(currentRam / GB);
    const recommendedRamGb = minRam / GB;
    // Compare in whole GBs so a server displaying "8 GB" is never flagged against an "8 GB" target
    const ramInsufficient = currentRamGb < recommendedRamGb;

    const PG_RECOMMENDED = buildPgRecommended();
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
    const pgTuningNeeded = !allOk;

    // Layer the capacity snapshot on top so callers get a single source of
    // truth for severity, reasons, host stats, sample-table breakdown, and
    // steady-state size projection. The legacy fields above are preserved
    // for backwards compatibility.
    const capacity = await getCapacitySnapshot({ ramInsufficient, pgTuningNeeded });

    res.json({
      needed: pgTuningNeeded,
      triggered,
      counts,
      thresholds: PG_TUNING_THRESHOLDS,
      settings,
      snoozedUntil: isSnoozed ? snoozedUntil : null,
      ramInsufficient,
      currentRamGb,
      recommendedRamGb,
      capacity,
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

const LOGO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "public", "uploads");
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

export default router;
