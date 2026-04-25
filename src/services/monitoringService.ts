/**
 * src/services/monitoringService.ts
 *
 * Asset uptime / response-time monitoring. Runs an authenticated probe per
 * asset based on `Asset.monitorType`:
 *   - fortimanager / fortigate → FortiOS REST GET /api/v2/monitor/system/status
 *   - snmp                     → net-snmp authenticated GET on sysUpTime
 *   - winrm                    → SOAP Identify with HTTP basic auth
 *   - ssh                      → ssh2 connect+authenticate
 *   - icmp                     → spawn the system ping
 *
 * A "successful" probe means the credential authenticated and the device
 * answered (so a misconfigured credential surfaces as down rather than up).
 *
 * Each probe writes one AssetMonitorSample row (responseTimeMs is null on
 * failure — that's the "packet loss" signal). The asset's
 * `consecutiveFailures` counter rolls forward; when it crosses
 * `monitor.failureThreshold`, the asset transitions to `monitorStatus = "down"`
 * and a single `monitor.status_changed` Event is emitted. Recovery
 * transitions emit one as well.
 */

import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import * as snmp from "net-snmp";
import { Client as SshClient } from "ssh2";

import { prisma } from "../db.js";
import { fgRequest, type FortiGateConfig } from "./fortigateService.js";
import { logEvent } from "../api/routes/events.js";
import { logger } from "../utils/logger.js";

export type MonitorType =
  | "fortimanager"
  | "fortigate"
  | "snmp"
  | "winrm"
  | "ssh"
  | "icmp";

export interface ProbeResult {
  success: boolean;
  /** Wall-clock duration of the probe, rounded to integer ms. */
  responseTimeMs: number;
  /** Short human-readable reason on failure; null on success. */
  error?: string;
}

export interface MonitorSettings {
  intervalSeconds: number;
  failureThreshold: number;
  sampleRetentionDays: number;
}

const SETTING_KEY = "monitorSettings";

const DEFAULT_SETTINGS: MonitorSettings = {
  intervalSeconds: 30,
  failureThreshold: 3,
  sampleRetentionDays: 30,
};

const PROBE_TIMEOUT_MS = 10_000;
const sysUpTimeOid = "1.3.6.1.2.1.1.3.0";

export async function getMonitorSettings(): Promise<MonitorSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const v = (row?.value as Record<string, unknown> | null) ?? {};
  return {
    intervalSeconds:     toPositiveInt(v.intervalSeconds,     DEFAULT_SETTINGS.intervalSeconds),
    failureThreshold:    toPositiveInt(v.failureThreshold,    DEFAULT_SETTINGS.failureThreshold),
    sampleRetentionDays: toPositiveInt(v.sampleRetentionDays, DEFAULT_SETTINGS.sampleRetentionDays),
  };
}

export async function updateMonitorSettings(input: Partial<MonitorSettings>): Promise<MonitorSettings> {
  const current = await getMonitorSettings();
  const next: MonitorSettings = {
    intervalSeconds:     input.intervalSeconds     != null ? toPositiveInt(input.intervalSeconds,     current.intervalSeconds)     : current.intervalSeconds,
    failureThreshold:    input.failureThreshold    != null ? toPositiveInt(input.failureThreshold,    current.failureThreshold)    : current.failureThreshold,
    sampleRetentionDays: input.sampleRetentionDays != null ? toPositiveInt(input.sampleRetentionDays, current.sampleRetentionDays) : current.sampleRetentionDays,
  };
  await prisma.setting.upsert({
    where:  { key: SETTING_KEY },
    update: { value: next as any },
    create: { key: SETTING_KEY, value: next as any },
  });
  return next;
}

function toPositiveInt(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

// ─── Probe entry point ──────────────────────────────────────────────────────

/**
 * Run a single probe against the asset (no DB writes — caller persists).
 * The probe always returns a result; thrown errors are caught and packaged
 * into `{ success: false, error }` so the monitor loop never aborts.
 */
export async function probeAsset(assetId: string): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { monitorCredential: true, discoveredByIntegration: true },
    });
    if (!asset) return finish(start, false, "Asset not found");
    if (!asset.monitored) return finish(start, false, "Monitoring disabled");
    if (!asset.monitorType) return finish(start, false, "No monitor type configured");

    const targetIp = asset.ipAddress;
    if (!targetIp) return finish(start, false, "Asset has no IP address");

    const type = asset.monitorType as MonitorType;

    if (type === "fortimanager" || type === "fortigate") {
      if (!asset.discoveredByIntegration) {
        return finish(start, false, "Originating integration not found");
      }
      return await probeFortinet(targetIp, asset.discoveredByIntegration as any, start);
    }
    if (type === "icmp") {
      return await probeIcmp(targetIp, start);
    }
    if (type === "snmp") {
      if (!asset.monitorCredential) return finish(start, false, "No SNMP credential selected");
      return await probeSnmp(targetIp, asset.monitorCredential.config as Record<string, unknown>, start);
    }
    if (type === "winrm") {
      if (!asset.monitorCredential) return finish(start, false, "No WinRM credential selected");
      return await probeWinRm(targetIp, asset.monitorCredential.config as Record<string, unknown>, start);
    }
    if (type === "ssh") {
      if (!asset.monitorCredential) return finish(start, false, "No SSH credential selected");
      return await probeSsh(targetIp, asset.monitorCredential.config as Record<string, unknown>, start);
    }
    return finish(start, false, `Unknown monitor type "${type}"`);
  } catch (err: any) {
    return finish(start, false, err?.message || "Unknown probe error");
  }
}

function finish(startedAt: number, success: boolean, error?: string): ProbeResult {
  const ms = Math.max(0, Math.round(performance.now() - startedAt));
  return success ? { success, responseTimeMs: ms } : { success: false, responseTimeMs: ms, error };
}

// ─── Probe implementations ──────────────────────────────────────────────────

async function probeFortinet(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  start: number,
): Promise<ProbeResult> {
  const cfg = integration.config || {};
  let apiUser  = "";
  let apiToken = "";
  if (integration.type === "fortimanager") {
    apiUser  = String(cfg.fortigateApiUser  || "");
    apiToken = String(cfg.fortigateApiToken || "");
    if (!apiToken) return finish(start, false, "FortiManager direct-mode API token not configured");
  } else {
    apiUser  = String(cfg.apiUser  || "");
    apiToken = String(cfg.apiToken || "");
    if (!apiToken) return finish(start, false, "FortiGate API token not configured");
  }

  const fgConfig: FortiGateConfig = {
    host,
    apiUser,
    apiToken,
    verifySsl: cfg.verifySsl !== true ? false : true,
  };

  try {
    await fgRequest<unknown>(fgConfig, "GET", "/api/v2/monitor/system/status");
    return finish(start, true);
  } catch (err: any) {
    return finish(start, false, err?.message || "FortiOS request failed");
  }
}

async function probeIcmp(host: string, start: number): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolve) => {
    const isWindows = process.platform === "win32";
    const args = isWindows
      ? ["-n", "1", "-w", String(PROBE_TIMEOUT_MS), host]
      : ["-c", "1", "-W", String(Math.ceil(PROBE_TIMEOUT_MS / 1000)), host];
    const child = spawn("ping", args, { stdio: ["ignore", "pipe", "pipe"] });
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch {}
      resolve(finish(start, false, "ping timed out"));
    }, PROBE_TIMEOUT_MS + 2_000);
    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(finish(start, false, err.message));
    });
    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === 0) resolve(finish(start, true));
      else resolve(finish(start, false, `ping exit ${code}`));
    });
  });
}

async function probeSnmp(host: string, config: Record<string, unknown>, start: number): Promise<ProbeResult> {
  const port = toPositiveInt(config.port, 161);
  const version = config.version === "v3" ? "v3" : "v2c";
  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      try { (session as any)?.close?.(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finishOnce(finish(start, false, "SNMP timed out")), PROBE_TIMEOUT_MS);

    let session: any;
    try {
      if (version === "v2c") {
        session = snmp.createSession(host, String(config.community || ""), {
          port,
          version: snmp.Version2c,
          timeout: PROBE_TIMEOUT_MS,
          retries: 0,
        });
      } else {
        const securityLevel = config.securityLevel === "noAuthNoPriv"
          ? snmp.SecurityLevel.noAuthNoPriv
          : config.securityLevel === "authNoPriv"
            ? snmp.SecurityLevel.authNoPriv
            : snmp.SecurityLevel.authPriv;
        const authProtocol = config.authProtocol === "MD5" ? snmp.AuthProtocols.md5 : snmp.AuthProtocols.sha;
        const privProtocol = config.privProtocol === "DES" ? snmp.PrivProtocols.des : snmp.PrivProtocols.aes;
        const user: any = {
          name: String(config.username || ""),
          level: securityLevel,
        };
        if (securityLevel !== snmp.SecurityLevel.noAuthNoPriv) {
          user.authProtocol = authProtocol;
          user.authKey      = String(config.authKey || "");
        }
        if (securityLevel === snmp.SecurityLevel.authPriv) {
          user.privProtocol = privProtocol;
          user.privKey      = String(config.privKey || "");
        }
        session = snmp.createV3Session(host, user, {
          port,
          version: snmp.Version3,
          timeout: PROBE_TIMEOUT_MS,
          retries: 0,
        });
      }

      session.on("error", (err: Error) => finishOnce(finish(start, false, err?.message || "SNMP error")));
      session.get([sysUpTimeOid], (err: Error | null, varbinds: any[]) => {
        clearTimeout(timer);
        if (err) return finishOnce(finish(start, false, err.message || "SNMP get failed"));
        if (!varbinds || varbinds.length === 0) {
          return finishOnce(finish(start, false, "SNMP returned no varbinds"));
        }
        const vb = varbinds[0];
        if (snmp.isVarbindError(vb)) {
          return finishOnce(finish(start, false, snmp.varbindError(vb)));
        }
        finishOnce(finish(start, true));
      });
    } catch (err: any) {
      clearTimeout(timer);
      finishOnce(finish(start, false, err?.message || "SNMP setup failed"));
    }
  });
}

async function probeWinRm(host: string, config: Record<string, unknown>, start: number): Promise<ProbeResult> {
  const useHttps = config.useHttps !== false;
  const port = toPositiveInt(config.port, useHttps ? 5986 : 5985);
  const username = String(config.username || "");
  const password = String(config.password || "");
  if (!username || !password) return finish(start, false, "WinRM credential incomplete");

  // Minimal WS-Management Identify request — exercises authentication
  // without needing a configured shell/runspace.
  const body =
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ` +
    `xmlns:wsmid="http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd">` +
    `<s:Header/><s:Body><wsmid:Identify/></s:Body></s:Envelope>`;

  const url = new URL(`${useHttps ? "https" : "http"}://${host}:${port}/wsman`);
  const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };
    const reqFn = useHttps ? httpsRequest : httpRequest;
    const req = reqFn({
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: "POST",
      headers: {
        "Authorization":  auth,
        "Content-Type":   "application/soap+xml;charset=UTF-8",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      rejectUnauthorized: false,
      timeout: PROBE_TIMEOUT_MS,
    } as any, (res) => {
      // Drain the body so the socket can close cleanly.
      res.on("data", () => {});
      res.on("end", () => {
        if (res.statusCode === 200) return finishOnce(finish(start, true));
        if (res.statusCode === 401) return finishOnce(finish(start, false, "WinRM authentication failed"));
        finishOnce(finish(start, false, `WinRM HTTP ${res.statusCode}`));
      });
    });
    req.on("timeout", () => { try { req.destroy(); } catch {}; finishOnce(finish(start, false, "WinRM timed out")); });
    req.on("error", (err) => finishOnce(finish(start, false, err.message || "WinRM error")));
    req.write(body);
    req.end();
  });
}

async function probeSsh(host: string, config: Record<string, unknown>, start: number): Promise<ProbeResult> {
  const port = toPositiveInt(config.port, 22);
  const username = String(config.username || "");
  const password = typeof config.password === "string" ? config.password : "";
  const privateKey = typeof config.privateKey === "string" ? config.privateKey : "";
  if (!username || (!password && !privateKey)) return finish(start, false, "SSH credential incomplete");

  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const client = new SshClient();
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      try { client.end(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finishOnce(finish(start, false, "SSH timed out")), PROBE_TIMEOUT_MS);

    client.on("ready", () => {
      clearTimeout(timer);
      finishOnce(finish(start, true));
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      finishOnce(finish(start, false, err.message || "SSH error"));
    });

    try {
      const opts: any = {
        host,
        port,
        username,
        readyTimeout: PROBE_TIMEOUT_MS,
      };
      if (privateKey) opts.privateKey = privateKey;
      else opts.password = password;
      client.connect(opts);
    } catch (err: any) {
      clearTimeout(timer);
      finishOnce(finish(start, false, err?.message || "SSH connect failed"));
    }
  });
}

// ─── Persisting a probe result ──────────────────────────────────────────────

/**
 * Apply a probe result to the asset row + history. Updates
 * monitorStatus / consecutiveFailures, writes one AssetMonitorSample, and
 * fires a single monitor.status_changed Event on transition.
 */
export async function recordProbeResult(assetId: string, result: ProbeResult): Promise<void> {
  const settings = await getMonitorSettings();
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      hostname: true,
      monitored: true,
      monitorStatus: true,
      consecutiveFailures: true,
    },
  });
  if (!asset) return;

  const now = new Date();
  const newConsec = result.success ? 0 : (asset.consecutiveFailures ?? 0) + 1;
  const previousStatus = asset.monitorStatus ?? "unknown";
  let nextStatus: "up" | "down" | "unknown";
  if (result.success) {
    nextStatus = "up";
  } else if (newConsec >= settings.failureThreshold) {
    nextStatus = "down";
  } else {
    // Below threshold — keep prior up/down status (we know it's failing
    // right now, but a single failed sample shouldn't flip the pill yet).
    nextStatus = (previousStatus === "up" || previousStatus === "down") ? previousStatus : "unknown";
  }

  await prisma.assetMonitorSample.create({
    data: {
      assetId,
      timestamp: now,
      success: result.success,
      responseTimeMs: result.success ? result.responseTimeMs : null,
      error: result.success ? null : (result.error ?? null),
    },
  });

  await prisma.asset.update({
    where: { id: assetId },
    data: {
      monitorStatus: nextStatus,
      lastMonitorAt: now,
      lastResponseTimeMs: result.success ? result.responseTimeMs : null,
      consecutiveFailures: newConsec,
    },
  });

  if (previousStatus !== nextStatus && (nextStatus === "up" || nextStatus === "down")) {
    logEvent({
      action: "monitor.status_changed",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: asset.hostname || undefined,
      level: nextStatus === "down" ? "warning" : "info",
      message:
        `Monitor: ${asset.hostname || assetId} ${previousStatus} → ${nextStatus}` +
        (result.error ? ` (${result.error})` : ""),
      details: {
        previousStatus,
        nextStatus,
        responseTimeMs: result.success ? result.responseTimeMs : null,
        error: result.error ?? null,
        consecutiveFailures: newConsec,
      },
    });
  }
}

// ─── Bulk pass + sample retention ───────────────────────────────────────────

interface RunStats {
  probed:    number;
  succeeded: number;
  failed:    number;
}

/**
 * One iteration of the monitor job: pick assets that are due and probe
 * them in parallel (small concurrency cap). Each asset's per-asset
 * `monitorIntervalSec` overrides the global default.
 */
export async function runMonitorPass(opts?: { concurrency?: number }): Promise<RunStats> {
  const settings = await getMonitorSettings();
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 8, 32));
  const now = new Date();

  const candidates = await prisma.asset.findMany({
    where: { monitored: true, monitorType: { not: null } },
    select: { id: true, lastMonitorAt: true, monitorIntervalSec: true },
  });

  const due = candidates.filter((a) => {
    const intervalSec = a.monitorIntervalSec || settings.intervalSeconds;
    if (!a.lastMonitorAt) return true;
    return now.getTime() - a.lastMonitorAt.getTime() >= intervalSec * 1000;
  });

  if (due.length === 0) return { probed: 0, succeeded: 0, failed: 0 };

  const stats: RunStats = { probed: 0, succeeded: 0, failed: 0 };
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < due.length) {
      const idx = cursor++;
      const id = due[idx].id;
      try {
        const result = await probeAsset(id);
        await recordProbeResult(id, result);
        stats.probed++;
        if (result.success) stats.succeeded++;
        else stats.failed++;
      } catch (err) {
        logger.error({ err, assetId: id }, "Monitor probe crashed");
        stats.probed++;
        stats.failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, () => worker()));
  return stats;
}

/**
 * Trim AssetMonitorSample rows older than the configured retention window.
 * 0 (or negative) disables retention.
 */
export async function pruneMonitorSamples(): Promise<number> {
  const { sampleRetentionDays } = await getMonitorSettings();
  if (!sampleRetentionDays || sampleRetentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - sampleRetentionDays * 24 * 3600 * 1000);
  const { count } = await prisma.assetMonitorSample.deleteMany({
    where: { timestamp: { lt: cutoff } },
  });
  return count;
}
