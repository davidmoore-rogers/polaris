/**
 * src/services/eventArchiveService.ts — Event export settings & archive transfer
 *
 * Manages two export mechanisms:
 *   1. Archive Export (SFTP/SCP) — batched archive files sent before pruning
 *   2. Syslog Forwarding (UDP/TCP/TLS) — real-time event forwarding
 *
 * Archives are only generated when export settings are configured and enabled.
 */

import { exec } from "node:child_process";
import { createSocket } from "node:dgram";
import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

const execAsync = promisify(exec);

export interface ArchiveSettings {
  enabled: boolean;
  protocol: "sftp" | "scp";
  host: string;
  port: number;
  username: string;
  password?: string;
  keyPath?: string;
  remotePath: string;
}

const SETTINGS_KEY = "eventArchive";

const DEFAULT_SETTINGS: ArchiveSettings = {
  enabled: false,
  protocol: "scp",
  host: "",
  port: 22,
  username: "",
  password: "",
  keyPath: "",
  remotePath: "/var/archive/shelob",
};

export async function getArchiveSettings(): Promise<ArchiveSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(row.value as Record<string, unknown>) } as ArchiveSettings;
}

export async function updateArchiveSettings(
  settings: Partial<ArchiveSettings>,
): Promise<ArchiveSettings> {
  const current = await getArchiveSettings();
  const merged: ArchiveSettings = { ...current, ...settings };

  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: merged as any },
    update: { value: merged as any },
  });

  return merged;
}

/**
 * Test the SFTP/SCP connection by attempting a small file transfer.
 */
export async function testConnection(
  settings: ArchiveSettings,
): Promise<{ ok: boolean; message: string }> {
  if (!settings.host || !settings.username) {
    return { ok: false, message: "Host and username are required" };
  }

  try {
    const cmd = buildTestCommand(settings);
    await execAsync(cmd, { timeout: 15_000 });
    return { ok: true, message: `Connected to ${settings.host} via ${settings.protocol.toUpperCase()}` };
  } catch (err: any) {
    const msg = err.stderr || err.message || "Connection failed";
    return { ok: false, message: msg.toString().trim().split("\n")[0] };
  }
}

function buildTestCommand(s: ArchiveSettings): string {
  const portFlag = s.protocol === "sftp" ? `-oPort=${s.port}` : `-P ${s.port}`;
  const keyFlag = s.keyPath ? `-i "${s.keyPath}"` : "";
  const opts = `-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes ${keyFlag}`;

  if (s.protocol === "sftp") {
    return `echo "bye" | sftp ${opts} ${portFlag} ${s.username}@${s.host}`;
  }
  // SCP: try to list remote directory
  return `ssh ${opts} -p ${s.port} ${s.username}@${s.host} "test -d '${s.remotePath}' && echo ok || mkdir -p '${s.remotePath}'"`;
}

/**
 * Archive events older than the given cutoff and export via SFTP/SCP.
 * Returns the count of archived events, or 0 if archiving is not configured.
 */
export async function archiveAndExport(cutoff: Date): Promise<number> {
  const settings = await getArchiveSettings();
  if (!settings.enabled || !settings.host || !settings.username) {
    return 0;
  }

  const events = await prisma.event.findMany({
    where: { timestamp: { lt: cutoff } },
    orderBy: { timestamp: "asc" },
  });

  if (events.length === 0) return 0;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `shelob-events-${timestamp}.json`;
  const tempDir = join(tmpdir(), "shelob-archives");
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
  const localPath = join(tempDir, filename);

  try {
    writeFileSync(localPath, JSON.stringify(events, null, 2), "utf-8");

    const cmd = buildTransferCommand(settings, localPath, filename);
    await execAsync(cmd, { timeout: 60_000 });

    logger.info({ count: events.length, filename, host: settings.host }, "Event archive exported");
    return events.length;
  } catch (err) {
    logger.error(err, "Failed to export event archive");
    throw err;
  } finally {
    try { unlinkSync(localPath); } catch { /* ignore cleanup errors */ }
  }
}

function buildTransferCommand(s: ArchiveSettings, localPath: string, filename: string): string {
  const keyFlag = s.keyPath ? `-i "${s.keyPath}"` : "";
  const opts = `-o StrictHostKeyChecking=no -o ConnectTimeout=10 ${keyFlag}`;
  const remoteDest = `${s.remotePath}/${filename}`;

  if (s.protocol === "sftp") {
    const batchFile = localPath + ".batch";
    writeFileSync(batchFile, `put "${localPath}" "${remoteDest}"\nbye\n`, "utf-8");
    return `sftp ${opts} -oPort=${s.port} -b "${batchFile}" ${s.username}@${s.host}`;
  }
  return `scp ${opts} -P ${s.port} "${localPath}" ${s.username}@${s.host}:"${remoteDest}"`;
}

// ─── Syslog Settings ────────────────────────────────────────────────────────

export interface SyslogSettings {
  enabled: boolean;
  protocol: "udp" | "tcp" | "tls";
  host: string;
  port: number;
  facility: string;
  severity: "info" | "warning" | "error";
  format: "rfc5424" | "rfc3164";
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

const SYSLOG_KEY = "eventSyslog";

const DEFAULT_SYSLOG: SyslogSettings = {
  enabled: false,
  protocol: "udp",
  host: "",
  port: 514,
  facility: "local0",
  severity: "info",
  format: "rfc5424",
  tlsCaPath: "",
  tlsCertPath: "",
  tlsKeyPath: "",
};

export async function getSyslogSettings(): Promise<SyslogSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SYSLOG_KEY } });
  if (!row) return { ...DEFAULT_SYSLOG };
  return { ...DEFAULT_SYSLOG, ...(row.value as Record<string, unknown>) } as SyslogSettings;
}

export async function updateSyslogSettings(
  settings: Partial<SyslogSettings>,
): Promise<SyslogSettings> {
  const current = await getSyslogSettings();
  const merged: SyslogSettings = { ...current, ...settings };

  await prisma.setting.upsert({
    where: { key: SYSLOG_KEY },
    create: { key: SYSLOG_KEY, value: merged as any },
    update: { value: merged as any },
  });

  return merged;
}

/**
 * Test syslog connectivity by sending a test message.
 */
export async function testSyslogConnection(
  settings: SyslogSettings,
): Promise<{ ok: boolean; message: string }> {
  if (!settings.host) {
    return { ok: false, message: "Host is required" };
  }

  const testMsg = "<134>1 " + new Date().toISOString() + " shelob test - - - Shelob syslog connection test";

  try {
    if (settings.protocol === "udp") {
      await sendUdp(settings.host, settings.port, testMsg);
    } else if (settings.protocol === "tcp") {
      await sendTcp(settings.host, settings.port, testMsg);
    } else {
      await sendTls(settings, testMsg);
    }
    return {
      ok: true,
      message: `Test message sent to ${settings.host}:${settings.port} via ${settings.protocol.toUpperCase()}`,
    };
  } catch (err: any) {
    return { ok: false, message: err.message || "Connection failed" };
  }
}

function sendUdp(host: string, port: number, msg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = createSocket("udp4");
    const buf = Buffer.from(msg);
    client.send(buf, 0, buf.length, port, host, (err) => {
      client.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

function sendTcp(host: string, port: number, msg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Connection timeout"));
    }, 10_000);
    const socket: Socket = createConnection({ host, port }, () => {
      socket.write(msg + "\n", () => {
        clearTimeout(timeout);
        socket.end();
        resolve();
      });
    });
    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function sendTls(settings: SyslogSettings, msg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const opts: Record<string, unknown> = {
      host: settings.host,
      port: settings.port,
      rejectUnauthorized: !!settings.tlsCaPath,
    };
    if (settings.tlsCaPath) opts.ca = readFileSync(settings.tlsCaPath);
    if (settings.tlsCertPath) opts.cert = readFileSync(settings.tlsCertPath);
    if (settings.tlsKeyPath) opts.key = readFileSync(settings.tlsKeyPath);

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("TLS connection timeout"));
    }, 10_000);

    const socket = tlsConnect(opts as any, () => {
      socket.write(msg + "\n", () => {
        clearTimeout(timeout);
        socket.end();
        resolve();
      });
    });
    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
