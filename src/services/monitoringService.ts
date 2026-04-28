/**
 * src/services/monitoringService.ts
 *
 * Asset uptime / response-time monitoring. Runs an authenticated probe per
 * asset based on `Asset.monitorType`:
 *   - fortimanager / fortigate → FortiOS REST GET /api/v2/monitor/system/status
 *   - activedirectory          → reuses the AD integration's bindDn/bindPassword;
 *                                Windows hosts get a WinRM SOAP Identify, Linux
 *                                hosts (realm-joined) get an SSH connect+auth
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
import { resolveOidSync, ensureRegistryLoaded } from "./oidRegistry.js";
import {
  pickVendorProfile,
  type VendorTelemetryProfile,
} from "./vendorTelemetryProfiles.js";

export type MonitorType =
  | "fortimanager"
  | "fortigate"
  | "activedirectory"
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
  // System tab cadences. Telemetry = CPU% + memory snapshot (lightweight,
  // ~60s by default). System info = full interface + storage scrape
  // (heavier, ~600s/10min by default). Retention is per stream so we can
  // keep CPU/mem trends longer than per-interface counters if storage
  // pressure becomes an issue.
  telemetryIntervalSeconds:  number;
  systemInfoIntervalSeconds: number;
  telemetryRetentionDays:    number;
  systemInfoRetentionDays:   number;
}

const SETTING_KEY = "monitorSettings";

const DEFAULT_SETTINGS: MonitorSettings = {
  intervalSeconds: 60,
  failureThreshold: 3,
  sampleRetentionDays: 30,
  telemetryIntervalSeconds:  60,
  systemInfoIntervalSeconds: 600,
  telemetryRetentionDays:    30,
  systemInfoRetentionDays:   30,
};

const PROBE_TIMEOUT_MS = 10_000;
const sysUpTimeOid = "1.3.6.1.2.1.1.3.0";

/**
 * Decide which protocol the AD-locked monitor should use for a given asset OS.
 * Returns null when the OS isn't realm-monitorable, in which case the AD sync
 * leaves the asset unlocked and the operator picks ICMP/SNMP manually.
 *
 * Exported so the AD sync (in integrations.ts) can apply the same lock policy
 * at discovery time as the probe applies at run time.
 */
export function getAdMonitorProtocol(os: string | null | undefined): "winrm" | "ssh" | null {
  if (!os) return null;
  const lower = os.toLowerCase();
  if (lower.includes("windows")) return "winrm";
  if (lower.includes("linux")) return "ssh";
  return null;
}

export async function getMonitorSettings(): Promise<MonitorSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const v = (row?.value as Record<string, unknown> | null) ?? {};
  return {
    intervalSeconds:           toPositiveInt(v.intervalSeconds,           DEFAULT_SETTINGS.intervalSeconds),
    failureThreshold:          toPositiveInt(v.failureThreshold,          DEFAULT_SETTINGS.failureThreshold),
    sampleRetentionDays:       toPositiveInt(v.sampleRetentionDays,       DEFAULT_SETTINGS.sampleRetentionDays),
    telemetryIntervalSeconds:  toPositiveInt(v.telemetryIntervalSeconds,  DEFAULT_SETTINGS.telemetryIntervalSeconds),
    systemInfoIntervalSeconds: toPositiveInt(v.systemInfoIntervalSeconds, DEFAULT_SETTINGS.systemInfoIntervalSeconds),
    telemetryRetentionDays:    toPositiveInt(v.telemetryRetentionDays,    DEFAULT_SETTINGS.telemetryRetentionDays),
    systemInfoRetentionDays:   toPositiveInt(v.systemInfoRetentionDays,   DEFAULT_SETTINGS.systemInfoRetentionDays),
  };
}

export async function updateMonitorSettings(input: Partial<MonitorSettings>): Promise<MonitorSettings> {
  const current = await getMonitorSettings();
  const pick = (v: unknown, fallback: number): number => v != null ? toPositiveInt(v, fallback) : fallback;
  const next: MonitorSettings = {
    intervalSeconds:           pick(input.intervalSeconds,           current.intervalSeconds),
    failureThreshold:          pick(input.failureThreshold,          current.failureThreshold),
    sampleRetentionDays:       pick(input.sampleRetentionDays,       current.sampleRetentionDays),
    telemetryIntervalSeconds:  pick(input.telemetryIntervalSeconds,  current.telemetryIntervalSeconds),
    systemInfoIntervalSeconds: pick(input.systemInfoIntervalSeconds, current.systemInfoIntervalSeconds),
    telemetryRetentionDays:    pick(input.telemetryRetentionDays,    current.telemetryRetentionDays),
    systemInfoRetentionDays:   pick(input.systemInfoRetentionDays,   current.systemInfoRetentionDays),
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

    const type = asset.monitorType as MonitorType;
    // AD-discovered Windows hosts often have no IP yet (only dnsName/hostname),
    // and WinRM resolves FQDNs fine — fall back so the probe can still run.
    const targetIp =
      asset.ipAddress ||
      (type === "activedirectory" ? (asset.dnsName || asset.hostname) : null);
    if (!targetIp) return finish(start, false, "Asset has no IP address");

    if (type === "fortimanager" || type === "fortigate") {
      if (!asset.discoveredByIntegration) {
        return finish(start, false, "Originating integration not found");
      }
      return await probeFortinet(targetIp, asset.discoveredByIntegration as any, start);
    }
    if (type === "activedirectory") {
      if (!asset.discoveredByIntegration) {
        return finish(start, false, "Originating integration not found");
      }
      if (asset.discoveredByIntegration.type !== "activedirectory") {
        return finish(start, false, "Originating integration is not Active Directory");
      }
      return await probeActiveDirectory(targetIp, asset.os, asset.discoveredByIntegration as any, start);
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

  // Optional SNMP override: when the integration has `monitorCredentialId`
  // set to a stored SNMP credential, run sysUpTime via SNMP instead of the
  // FortiOS REST API. SNMP typically responds in <50 ms vs hundreds of ms
  // for the API path, which is the whole point of the override.
  const credId = cfg.monitorCredentialId;
  if (credId && typeof credId === "string") {
    const cred = await prisma.credential.findUnique({ where: { id: credId } });
    if (!cred) return finish(start, false, "Integration's monitor credential not found");
    if (cred.type !== "snmp") return finish(start, false, `Integration's monitor credential must be SNMP (got "${cred.type}")`);
    return await probeSnmp(host, cred.config as Record<string, unknown>, start);
  }

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

// AD-discovered hosts reuse the integration's bind credentials for the probe,
// mirroring how FMG/FortiGate-discovered firewalls reuse the integration's API
// token. Windows hosts get WinRM (5986/HTTPS Basic); realm-joined Linux hosts
// get SSH (22). The bind DN must be in UPN form (user@domain.com) or down-level
// form (DOMAIN\user) for both WinRM and SSH-to-realmd to accept it.
async function probeActiveDirectory(
  host: string,
  os: string | null | undefined,
  integration: { type: string; config: Record<string, unknown> },
  start: number,
): Promise<ProbeResult> {
  const cfg = integration.config || {};
  const username = String(cfg.bindDn || "");
  const password = String(cfg.bindPassword || "");
  if (!username || !password) {
    return finish(start, false, "Active Directory bind credentials not configured");
  }
  const protocol = getAdMonitorProtocol(os);
  if (protocol === "winrm") {
    return await probeWinRm(host, { username, password, useHttps: true, port: 5986 }, start);
  }
  if (protocol === "ssh") {
    return await probeSsh(host, { username, password, port: 22 }, start);
  }
  return finish(start, false, "Asset OS is not Windows or Linux — cannot pick AD probe protocol");
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

function mapSnmpAuthProtocol(value: unknown): unknown {
  switch (value) {
    case "MD5":    return snmp.AuthProtocols.md5;
    case "SHA":    return snmp.AuthProtocols.sha;
    case "SHA224": return snmp.AuthProtocols.sha224;
    case "SHA256": return snmp.AuthProtocols.sha256;
    case "SHA384": return snmp.AuthProtocols.sha384;
    case "SHA512": return snmp.AuthProtocols.sha512;
    default: throw new Error(`Unsupported SNMP v3 authProtocol "${String(value)}"`);
  }
}

function mapSnmpPrivProtocol(value: unknown): unknown {
  switch (value) {
    case "DES":     return snmp.PrivProtocols.des;
    case "AES":     return snmp.PrivProtocols.aes;
    case "AES256B": return snmp.PrivProtocols.aes256b;
    case "AES256R": return snmp.PrivProtocols.aes256r;
    default: throw new Error(`Unsupported SNMP v3 privProtocol "${String(value)}"`);
  }
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
        const user: any = {
          name: String(config.username || ""),
          level: securityLevel,
        };
        if (securityLevel !== snmp.SecurityLevel.noAuthNoPriv) {
          user.authProtocol = mapSnmpAuthProtocol(config.authProtocol);
          user.authKey      = String(config.authKey || "");
        }
        if (securityLevel === snmp.SecurityLevel.authPriv) {
          user.privProtocol = mapSnmpPrivProtocol(config.privProtocol);
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

// ─── System tab: telemetry + system-info collection ────────────────────────
//
// These run on independent cadences from the response-time probe. Telemetry
// (CPU/memory) ticks every ~60s; system info (interfaces + storage) ticks
// every ~10min. ICMP and SSH cannot deliver this data. WinRM is not yet
// supported — see `collectTelemetryWinRm` / `collectSystemInfoWinRm` below.

export interface TelemetrySample {
  cpuPct?:        number | null;
  memPct?:        number | null;
  memUsedBytes?:  number | null;
  memTotalBytes?: number | null;
  /** One entry per sensor; empty/undefined when the device doesn't expose temperatures. Persisted as AssetTemperatureSample rows. */
  temperatures?:  TemperatureSample[];
}

export interface InterfaceSample {
  ifName:       string;
  adminStatus?: string | null;
  operStatus?:  string | null;
  speedBps?:    number | null;
  ipAddress?:   string | null;
  macAddress?:  string | null;
  inOctets?:    number | null;
  outOctets?:   number | null;
  /** Cumulative IF-MIB ifInErrors / FortiOS errors_in. */
  inErrors?:    number | null;
  /** Cumulative IF-MIB ifOutErrors / FortiOS errors_out. */
  outErrors?:   number | null;
  /** "physical" | "aggregate" | "vlan" | "loopback" | "tunnel" — FortiOS REST + SNMP ifType OID. */
  ifType?:      string | null;
  /** Aggregate name (for member ports) or parent interface name (for VLANs). FortiOS REST only. */
  ifParent?:    string | null;
  /** 802.1Q VLAN ID. FortiOS REST only. */
  vlanId?:      number | null;
}

export interface StorageSample {
  mountPath:   string;
  totalBytes?: number | null;
  usedBytes?:  number | null;
}

/** One row per temperature sensor reported by the device. Celsius is null when the sensor is non-readable / not-present. */
export interface TemperatureSample {
  sensorName: string;
  celsius:    number | null;
}

/**
 * One row per FortiOS phase-1 IPsec tunnel. `status` rolls phase-2 selectors up
 * to "up" / "down" / "partial". Bytes are summed across every phase-2 selector
 * under this phase-1 and are cumulative — FortiOS resets when phase-1 renegotiates.
 */
export interface IpsecTunnelSample {
  tunnelName:     string;
  remoteGateway:  string | null;
  status:         "up" | "down" | "partial";
  incomingBytes:  number | null;
  outgoingBytes:  number | null;
  proxyIdCount:   number | null;
}

export interface SystemInfoSample {
  interfaces:    InterfaceSample[];
  storage:       StorageSample[];
  ipsecTunnels?: IpsecTunnelSample[];
}

export interface CollectionResult<T> {
  /** false → monitor type can't deliver this data; caller should not stamp lastXxxAt */
  supported: boolean;
  /** Set on a successful collection (even if some sub-fields are null). */
  data?: T;
  /** Short failure reason; only set when supported && data is undefined. */
  error?: string;
}

/** Cap on the amount of work a single subtree walk will do. Guards against pathological devices that publish huge ifTables. */
const SNMP_WALK_MAX = 1000;

export async function collectTelemetry(assetId: string): Promise<CollectionResult<TelemetrySample>> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { monitorCredential: true, discoveredByIntegration: true },
  });
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };
  if (!asset.monitorType) return { supported: false };
  const type = asset.monitorType as MonitorType;
  const targetIp =
    asset.ipAddress ||
    (type === "activedirectory" ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  try {
    if (type === "fortimanager" || type === "fortigate") {
      if (!asset.discoveredByIntegration) return { supported: true, error: "Originating integration not found" };
      const data = await collectTelemetryFortinet(targetIp, asset.discoveredByIntegration as any);
      return { supported: true, data };
    }
    if (type === "snmp") {
      if (!asset.monitorCredential) return { supported: true, error: "No SNMP credential selected" };
      const data = await collectTelemetrySnmp(
        targetIp,
        asset.monitorCredential.config as Record<string, unknown>,
        asset.manufacturer,
        asset.model,
        asset.os,
      );
      return { supported: true, data };
    }
    if (type === "winrm" || type === "activedirectory") {
      // TODO: implement WMI Enumerate over WS-Management. Tracked separately.
      return { supported: false };
    }
    return { supported: false };
  } catch (err: any) {
    return { supported: true, error: err?.message || "Telemetry collection failed" };
  }
}

/**
 * Light variant of collectSystemInfo that only returns the interfaces, storage
 * mountpoints, and IPsec tunnels the operator pinned for fast-cadence polling
 * (Asset.monitoredInterfaces / monitoredStorage / monitoredIpsecTunnels). The
 * underlying fetch still walks the full set on each protocol (one SNMP session
 * or one FortiOS round-trip), but the filter keeps us from writing noisy rows
 * for everything else once per minute. IPsec is only fetched from FortiOS when
 * tunnels are pinned — the endpoint can be slow on busy gateways and we don't
 * want to hammer it from the fast cadence unless asked.
 */
export async function collectFastFiltered(assetId: string): Promise<CollectionResult<SystemInfoSample>> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { monitorCredential: true, discoveredByIntegration: true },
  });
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };
  if (!asset.monitorType) return { supported: false };
  const wantedIfaces  = (asset.monitoredInterfaces   || []) as string[];
  const wantedStorage = (asset.monitoredStorage      || []) as string[];
  const wantedTunnels = (asset.monitoredIpsecTunnels || []) as string[];
  if (wantedIfaces.length === 0 && wantedStorage.length === 0 && wantedTunnels.length === 0) {
    return { supported: false };
  }
  const type = asset.monitorType as MonitorType;
  const targetIp =
    asset.ipAddress ||
    (type === "activedirectory" ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  try {
    let full: SystemInfoSample;
    if (type === "fortimanager" || type === "fortigate") {
      if (!asset.discoveredByIntegration) return { supported: true, error: "Originating integration not found" };
      // Only ask FortiOS for IPsec when we actually have a pinned tunnel —
      // /api/v2/monitor/vpn/ipsec is the slow endpoint we're trying to avoid
      // on the fast cadence.
      full = await collectSystemInfoFortinet(targetIp, asset.discoveredByIntegration as any, { includeIpsec: wantedTunnels.length > 0 });
    } else if (type === "snmp") {
      if (!asset.monitorCredential) return { supported: true, error: "No SNMP credential selected" };
      full = await collectSystemInfoSnmp(targetIp, asset.monitorCredential.config as Record<string, unknown>);
    } else {
      return { supported: false };
    }
    const wantIf = new Set(wantedIfaces);
    const wantSt = new Set(wantedStorage);
    const wantTn = new Set(wantedTunnels);
    const interfaces = wantedIfaces.length  ? full.interfaces.filter((i) => wantIf.has(i.ifName)) : [];
    const storage    = wantedStorage.length ? full.storage.filter((s) => wantSt.has(s.mountPath)) : [];
    const ipsecTunnels = (wantedTunnels.length && Array.isArray(full.ipsecTunnels))
      ? full.ipsecTunnels.filter((t) => wantTn.has(t.tunnelName))
      : undefined;
    return { supported: true, data: { interfaces, storage, ipsecTunnels } };
  } catch (err: any) {
    return { supported: true, error: err?.message || "Fast-cadence scrape failed" };
  }
}

/**
 * Persist a fast-cadence scrape. Mirrors recordSystemInfoResult for the three
 * sample tables, but does NOT touch Asset.associatedIps (that is owned by the
 * full system-info pass) and does NOT advance lastSystemInfoAt — the fast pass
 * is supplementary and the next full scrape is still gated on its own cadence.
 */
export async function recordFastFilteredResult(assetId: string, result: CollectionResult<SystemInfoSample>): Promise<void> {
  if (!result.supported || !result.data) return;
  const d = result.data;
  const now = new Date();
  if (d.interfaces.length > 0) {
    await prisma.assetInterfaceSample.createMany({
      data: d.interfaces.map((i) => ({
        assetId,
        timestamp: now,
        ifName:      i.ifName,
        adminStatus: i.adminStatus ?? null,
        operStatus:  i.operStatus ?? null,
        speedBps:    i.speedBps != null ? BigInt(Math.round(i.speedBps)) : null,
        ipAddress:   i.ipAddress ?? null,
        macAddress:  i.macAddress ?? null,
        inOctets:    i.inOctets  != null ? BigInt(Math.round(i.inOctets))  : null,
        outOctets:   i.outOctets != null ? BigInt(Math.round(i.outOctets)) : null,
        inErrors:    i.inErrors  != null ? BigInt(Math.round(i.inErrors))  : null,
        outErrors:   i.outErrors != null ? BigInt(Math.round(i.outErrors)) : null,
      })),
    });
  }
  if (d.storage.length > 0) {
    await prisma.assetStorageSample.createMany({
      data: d.storage.map((s) => ({
        assetId,
        timestamp: now,
        mountPath:  s.mountPath,
        totalBytes: s.totalBytes != null ? BigInt(Math.round(s.totalBytes)) : null,
        usedBytes:  s.usedBytes  != null ? BigInt(Math.round(s.usedBytes))  : null,
      })),
    });
  }
  if (Array.isArray(d.ipsecTunnels) && d.ipsecTunnels.length > 0) {
    await prisma.assetIpsecTunnelSample.createMany({
      data: d.ipsecTunnels.map((t) => ({
        assetId,
        timestamp: now,
        tunnelName:    t.tunnelName,
        remoteGateway: t.remoteGateway,
        status:        t.status,
        incomingBytes: t.incomingBytes != null ? BigInt(Math.round(t.incomingBytes)) : null,
        outgoingBytes: t.outgoingBytes != null ? BigInt(Math.round(t.outgoingBytes)) : null,
        proxyIdCount:  t.proxyIdCount,
      })),
    });
  }
}

export async function collectSystemInfo(assetId: string): Promise<CollectionResult<SystemInfoSample>> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { monitorCredential: true, discoveredByIntegration: true },
  });
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };
  if (!asset.monitorType) return { supported: false };
  const type = asset.monitorType as MonitorType;
  const targetIp =
    asset.ipAddress ||
    (type === "activedirectory" ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  try {
    if (type === "fortimanager" || type === "fortigate") {
      if (!asset.discoveredByIntegration) return { supported: true, error: "Originating integration not found" };
      const data = await collectSystemInfoFortinet(targetIp, asset.discoveredByIntegration as any, { includeIpsec: true });
      return { supported: true, data };
    }
    if (type === "snmp") {
      if (!asset.monitorCredential) return { supported: true, error: "No SNMP credential selected" };
      const data = await collectSystemInfoSnmp(targetIp, asset.monitorCredential.config as Record<string, unknown>);
      return { supported: true, data };
    }
    if (type === "winrm" || type === "activedirectory") {
      return { supported: false };
    }
    return { supported: false };
  } catch (err: any) {
    return { supported: true, error: err?.message || "System info collection failed" };
  }
}

// ─── FortiOS collectors ─────────────────────────────────────────────────────
//
// FortiOS exposes CPU and memory only as percentages via the resource/usage
// monitor, so memUsedBytes/memTotalBytes are left null. The interface monitor
// returns the cumulative tx/rx counters and link state. There's no real
// notion of mountable storage on a FortiGate, so the storage list stays empty.

function buildFortinetConfig(host: string, integration: { type: string; config: Record<string, unknown> }): FortiGateConfig | { error: string } {
  const cfg = integration.config || {};
  let apiUser  = "";
  let apiToken = "";
  if (integration.type === "fortimanager") {
    apiUser  = String(cfg.fortigateApiUser  || "");
    apiToken = String(cfg.fortigateApiToken || "");
    if (!apiToken) return { error: "FortiManager direct-mode API token not configured" };
  } else {
    apiUser  = String(cfg.apiUser  || "");
    apiToken = String(cfg.apiToken || "");
    if (!apiToken) return { error: "FortiGate API token not configured" };
  }
  return {
    host,
    apiUser,
    apiToken,
    verifySsl: cfg.verifySsl !== true ? false : true,
  };
}

async function collectTelemetryFortinet(host: string, integration: { type: string; config: Record<string, unknown> }): Promise<TelemetrySample> {
  const fg = buildFortinetConfig(host, integration);
  if ("error" in fg) throw new Error(fg.error);

  // /api/v2/monitor/system/resource/usage returns a `results` object keyed by
  // resource name (cpu, mem, disk, session, ...). Each entry can be either an
  // array of {interval, current, historical} samples or a single object,
  // depending on FortiOS version. Pull whatever's freshest.
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/resource/usage", { query: { scope: "global" } });
  const cpuPct = pickFortinetUsage(res?.cpu);
  const memPct = pickFortinetUsage(res?.mem ?? res?.memory);
  const temperatures = await collectTemperaturesFortinet(fg).catch(() => [] as TemperatureSample[]);
  return { cpuPct, memPct, memUsedBytes: null, memTotalBytes: null, temperatures };
}

// FortiOS exposes temperature, fan, and power sensors at one endpoint. We
// filter to type === "temperature" and keep only readable sensors. Older
// FortiOS firmwares 404 this endpoint — caller swallows the failure.
async function collectTemperaturesFortinet(fg: FortiGateConfig): Promise<TemperatureSample[]> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/sensor-info", {});
  const list: TemperatureSample[] = [];
  const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
  for (const s of arr) {
    if (!s || typeof s !== "object") continue;
    const type = String((s as any).type || "").toLowerCase();
    if (type && type !== "temperature") continue;
    // Older firmwares omit `type` entirely; treat names that look like temp sensors as temperature.
    const name = String((s as any).name || "").trim();
    if (!type && !/temp|cpu|board|chassis|°c/i.test(name)) continue;
    if (!name) continue;
    const value = (s as any).value;
    const n = typeof value === "number" ? value : (typeof value === "string" ? Number(value) : NaN);
    list.push({ sensorName: name, celsius: Number.isFinite(n) ? Math.round(n * 10) / 10 : null });
  }
  return list;
}

function pickFortinetUsage(node: unknown): number | null {
  if (node == null) return null;
  // Flat number?
  if (typeof node === "number" && Number.isFinite(node)) return clampPct(node);
  // Object with `current`?
  if (typeof node === "object" && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    if (typeof obj.current === "number") return clampPct(obj.current);
    // historical may be the freshest; take the last entry
    if (Array.isArray(obj.historical) && obj.historical.length > 0) {
      const last = obj.historical[obj.historical.length - 1];
      if (typeof last === "number") return clampPct(last);
    }
  }
  // Array of {interval, current, historical} — pick the entry with shortest
  // interval (typically "1-min"), falling back to the first.
  if (Array.isArray(node) && node.length > 0) {
    const sorted = [...node].sort((a, b) => intervalRank(a?.interval) - intervalRank(b?.interval));
    for (const entry of sorted) {
      if (entry == null) continue;
      if (typeof entry.current === "number") return clampPct(entry.current);
      if (Array.isArray(entry.historical) && entry.historical.length > 0) {
        const last = entry.historical[entry.historical.length - 1];
        if (typeof last === "number") return clampPct(last);
      }
    }
  }
  return null;
}

function intervalRank(s: unknown): number {
  // 1-min < 10-min < 30-min < 1-hour < 1-day < anything else
  switch (s) {
    case "1-min":  return 0;
    case "10-min": return 1;
    case "30-min": return 2;
    case "1-hour": return 3;
    case "1-day":  return 4;
    default:       return 5;
  }
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 100) / 100;
}

async function collectSystemInfoFortinet(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  opts: { includeIpsec?: boolean } = {},
): Promise<SystemInfoSample> {
  const fg = buildFortinetConfig(host, integration);
  if ("error" in fg) throw new Error(fg.error);

  // /api/v2/monitor/system/interface returns runtime stats but only includes
  // `type` / `vlanid` / `interface` (parent) sporadically depending on FortiOS
  // version — many 7.x firmwares omit them entirely. The CMDB endpoint is the
  // canonical source for type metadata, so we fetch it alongside the monitor
  // payload and merge. CMDB failure is non-fatal (e.g. token without cmdb
  // permission): we still get flat interface stats, just no nesting.
  const cmdbByName = new Map<string, { type: string | null; parent: string | null; vlanId: number | null; members: string[] }>();
  try {
    const cmdb = await fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/interface", { query: { vdom: "root" } });
    const arr = Array.isArray(cmdb) ? cmdb : (Array.isArray(cmdb?.results) ? cmdb.results : []);
    for (const c of arr) {
      if (!c || typeof c !== "object" || typeof c.name !== "string") continue;
      const t = typeof c.type === "string" ? c.type : null;
      // CMDB `member` is an array of { interface_name } entries on aggregate
      // and hard-switch / vap-switch interfaces.
      const members: string[] = Array.isArray(c.member)
        ? c.member.map((m: any) => (typeof m === "string" ? m : (typeof m?.interface_name === "string" ? m.interface_name : null))).filter(Boolean)
        : [];
      cmdbByName.set(c.name, {
        type:    t,
        parent:  t === "vlan" && typeof c.interface === "string" ? c.interface : null,
        vlanId:  t === "vlan" && typeof c.vlanid === "number" ? c.vlanid : null,
        members,
      });
    }
  } catch { /* tokens without cmdb scope — fall back to monitor-only types */ }

  const interfaces: InterfaceSample[] = [];
  try {
    // The interface monitor returns a results object keyed by interface name.
    // include_vlan/include_aggregate are required to get sub-interfaces in
    // the response — by default FortiOS returns physical interfaces only,
    // which is why VLANs and aggregates were never showing up under their
    // parents in the System tab tree.
    const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/interface", {
      query: { scope: "vdom", include_vlan: "true", include_aggregate: "true" },
    });
    const obj = (res && typeof res === "object" && !Array.isArray(res)) ? res as Record<string, any> : {};
    for (const [name, info] of Object.entries(obj)) {
      if (!info || typeof info !== "object") continue;
      const i = info as any;
      // Pick the first IPv4 if the device exposes a list, else fall back to the legacy `ip` string.
      let ip: string | null = null;
      if (Array.isArray(i.ipv4_addresses) && i.ipv4_addresses.length > 0) {
        const a = i.ipv4_addresses[0];
        ip = typeof a === "string" ? a : (a?.ip || null);
      } else if (typeof i.ip === "string") {
        ip = i.ip.split(" ")[0];
      }
      const speedMbps = typeof i.speed === "number" ? i.speed : null;
      // Prefer CMDB type/parent/vlanid; fall back to whatever the monitor
      // payload happened to include.
      const cmdbEntry = cmdbByName.get(name);
      const rawType   = cmdbEntry?.type ?? (typeof i.type === "string" ? i.type : null);
      const rawParent = cmdbEntry?.parent ?? (i.type === "vlan" && typeof i.interface === "string" ? i.interface : null);
      const rawVlanId = cmdbEntry?.vlanId ?? (i.type === "vlan" && typeof i.vlanid === "number" ? i.vlanid : null);
      interfaces.push({
        ifName:      name,
        adminStatus: i.status === "down" ? "down" : i.status === "up" ? "up" : (i.status ?? null),
        operStatus:  i.link === false ? "down" : i.link === true ? "up" : null,
        speedBps:    speedMbps != null ? Math.round(speedMbps * 1_000_000) : null,
        ipAddress:   ip,
        macAddress:  typeof i.mac === "string" ? i.mac.toUpperCase() : null,
        inOctets:    pickFiniteNumber(i.rx_bytes),
        outOctets:   pickFiniteNumber(i.tx_bytes),
        inErrors:    pickFiniteNumber(i.rx_errors  ?? i.errors_in),
        outErrors:   pickFiniteNumber(i.tx_errors  ?? i.errors_out),
        ifType:      normalizeFortiIfType(rawType),
        ifParent:    rawParent,
        vlanId:      rawVlanId,
      });
    }
    // Back-fill ifParent on member ports of aggregate / hard-switch /
    // vap-switch interfaces. CMDB carries the canonical `member` array; we
    // also accept the monitor-side `member` array as a fallback.
    const ifMap = new Map(interfaces.map((s) => [s.ifName, s]));
    for (const iface of interfaces) {
      if (iface.ifType !== "aggregate") continue;
      const cmdbEntry = cmdbByName.get(iface.ifName);
      const monitorEntry = obj[iface.ifName] as any;
      const members =
        cmdbEntry?.members.length ? cmdbEntry.members :
        Array.isArray(monitorEntry?.member) ? monitorEntry.member.map(String) : [];
      for (const memberName of members) {
        const member = ifMap.get(String(memberName));
        if (member && !member.ifParent) member.ifParent = iface.ifName;
      }
    }
  } catch (err: any) {
    // Re-throw — partial collection of interfaces is fine, but no interfaces
    // means the call genuinely failed.
    if (interfaces.length === 0) throw err;
  }
  // IPsec tunnels are best-effort: older FortiOS firmwares 404 the endpoint,
  // and a FortiGate without IPsec configured returns an empty list. Either
  // way we should not fail the whole system-info pass — the System tab simply
  // hides the section when the array is empty. Skipped entirely on the fast
  // (per-minute) cadence so we don't hammer the endpoint.
  const ipsecTunnels = opts.includeIpsec
    ? await collectIpsecTunnelsFortinet(fg).catch(() => [] as IpsecTunnelSample[])
    : undefined;
  return { interfaces, storage: [], ipsecTunnels };
}

/**
 * FortiOS exposes IPsec tunnels at /api/v2/monitor/vpn/ipsec. Each entry has
 * a `proxyid` array of phase-2 selectors with their own status + byte
 * counters; we roll them up into a single row per phase-1 tunnel for the
 * System tab. Older firmwares 404 this endpoint — caller swallows the failure.
 *
 * ADVPN shortcut tunnels (dynamic spoke-to-spoke SAs created on demand) are
 * filtered out: they idle in and out as traffic flows, polluting the table
 * with ephemeral rows that aren't pinnable for fast polling. FortiOS marks
 * them with a non-empty `parent` field pointing back at the configured
 * template tunnel; the template itself has no `parent`.
 */
async function collectIpsecTunnelsFortinet(fg: FortiGateConfig): Promise<IpsecTunnelSample[]> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/vpn/ipsec", { query: { scope: "vdom" } });
  const arr = Array.isArray(res?.results) ? res.results : (Array.isArray(res) ? res : []);
  const out: IpsecTunnelSample[] = [];
  for (const t of arr) {
    if (!t || typeof t !== "object") continue;
    const name = String((t as any).name || "").trim();
    if (!name) continue;
    const parent = (t as any).parent;
    if (typeof parent === "string" && parent.trim()) continue;
    const proxyArr = Array.isArray((t as any).proxyid) ? (t as any).proxyid : [];
    let upCount = 0;
    let downCount = 0;
    let inBytes = 0;
    let outBytes = 0;
    let anyBytes = false;
    for (const p of proxyArr) {
      if (!p || typeof p !== "object") continue;
      const s = String((p as any).status || "").toLowerCase();
      if (s === "up") upCount++; else downCount++;
      const ib = pickFiniteNumber((p as any).incoming_bytes);
      const ob = pickFiniteNumber((p as any).outgoing_bytes);
      if (ib != null) { inBytes  += ib; anyBytes = true; }
      if (ob != null) { outBytes += ob; anyBytes = true; }
    }
    let status: "up" | "down" | "partial";
    if (proxyArr.length === 0) {
      // No phase-2 selectors reported — fall back to the phase-1 connect_count
      // (>0 = up). Some FortiOS releases omit `proxyid` entirely on dial-up
      // tunnels with no active children.
      const cc = pickFiniteNumber((t as any).connect_count);
      status = cc != null && cc > 0 ? "up" : "down";
    } else if (downCount === 0) status = "up";
    else if (upCount === 0)     status = "down";
    else                        status = "partial";
    const rgwy = (t as any).rgwy ?? (t as any).tun_id ?? null;
    out.push({
      tunnelName:    name,
      remoteGateway: typeof rgwy === "string" && rgwy ? rgwy : null,
      status,
      incomingBytes: anyBytes ? inBytes  : null,
      outgoingBytes: anyBytes ? outBytes : null,
      proxyIdCount:  proxyArr.length || null,
    });
  }
  return out;
}

function pickFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeFortiIfType(raw: unknown): string | null {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.toLowerCase();
  if (t === "physical" || t === "wl-mesh")                                          return "physical";
  if (t === "aggregate" || t === "redundant" || t === "hard-switch" || t === "vap-switch") return "aggregate";
  if (t === "vlan")                                                                  return "vlan";
  if (t === "loopback")                                                              return "loopback";
  if (t === "tunnel" || t === "ssl" || t === "vxlan" || t === "gre" ||
      t === "ipsec"  || t === "vdom-link")                                           return "tunnel";
  return null;
}

// ─── SNMP collectors ────────────────────────────────────────────────────────
//
// HOST-RESOURCES-MIB delivers CPU (hrProcessorLoad), memory (hrStorage rows
// where hrStorageType = hrStorageRam), and storage (hrStorage rows where the
// type is hrStorageFixedDisk). IF-MIB delivers per-interface counters. Both
// are walked once per system-info pass.

const OID = {
  hrProcessorLoad:           "1.3.6.1.2.1.25.3.3.1.2",
  hrStorageType:             "1.3.6.1.2.1.25.2.3.1.2",
  hrStorageDescr:            "1.3.6.1.2.1.25.2.3.1.3",
  hrStorageAllocationUnits:  "1.3.6.1.2.1.25.2.3.1.4",
  hrStorageSize:             "1.3.6.1.2.1.25.2.3.1.5",
  hrStorageUsed:             "1.3.6.1.2.1.25.2.3.1.6",
  hrStorageRam:              "1.3.6.1.2.1.25.2.1.2",
  hrStorageFixedDisk:        "1.3.6.1.2.1.25.2.1.4",
  hrStorageRemovableDisk:    "1.3.6.1.2.1.25.2.1.5",
  // IF-MIB
  ifDescr:        "1.3.6.1.2.1.2.2.1.2",
  ifType:         "1.3.6.1.2.1.2.2.1.3",
  ifSpeed:        "1.3.6.1.2.1.2.2.1.5",
  ifPhysAddress:  "1.3.6.1.2.1.2.2.1.6",
  ifAdminStatus:  "1.3.6.1.2.1.2.2.1.7",
  ifOperStatus:   "1.3.6.1.2.1.2.2.1.8",
  ifInOctets:     "1.3.6.1.2.1.2.2.1.10",
  ifInErrors:     "1.3.6.1.2.1.2.2.1.14",
  ifOutOctets:    "1.3.6.1.2.1.2.2.1.16",
  ifOutErrors:    "1.3.6.1.2.1.2.2.1.20",
  ifName:         "1.3.6.1.2.1.31.1.1.1.1",
  ifHCInOctets:   "1.3.6.1.2.1.31.1.1.1.6",
  ifHCOutOctets:  "1.3.6.1.2.1.31.1.1.1.10",
  ifHighSpeed:    "1.3.6.1.2.1.31.1.1.1.15",
  ipAdEntIfIndex: "1.3.6.1.2.1.4.20.1.2",
  // ENTITY-MIB / ENTITY-SENSOR-MIB (RFC 4133 / 3433). For temperature
  // sensors, entPhySensorType=8 (celsius). entPhySensorScale + Precision tell
  // us how to scale entPhySensorValue back to a real number; entPhysicalDescr
  // (indexed by the same physical-entity index) gives the operator-friendly
  // sensor name.
  entPhysicalDescr:       "1.3.6.1.2.1.47.1.1.1.1.2",
  entPhySensorType:       "1.3.6.1.2.1.99.1.1.1.1",
  entPhySensorScale:      "1.3.6.1.2.1.99.1.1.1.2",
  entPhySensorPrecision:  "1.3.6.1.2.1.99.1.1.1.3",
  entPhySensorValue:      "1.3.6.1.2.1.99.1.1.1.4",
  entPhySensorOperStatus: "1.3.6.1.2.1.99.1.1.1.5",
};

function buildSnmpSession(host: string, config: Record<string, unknown>): any {
  const port = toPositiveInt(config.port, 161);
  const version = config.version === "v3" ? "v3" : "v2c";
  if (version === "v2c") {
    return snmp.createSession(host, String(config.community || ""), {
      port,
      version: snmp.Version2c,
      timeout: PROBE_TIMEOUT_MS,
      retries: 0,
    });
  }
  const securityLevel = config.securityLevel === "noAuthNoPriv"
    ? snmp.SecurityLevel.noAuthNoPriv
    : config.securityLevel === "authNoPriv"
      ? snmp.SecurityLevel.authNoPriv
      : snmp.SecurityLevel.authPriv;
  const user: any = { name: String(config.username || ""), level: securityLevel };
  if (securityLevel !== snmp.SecurityLevel.noAuthNoPriv) {
    user.authProtocol = mapSnmpAuthProtocol(config.authProtocol);
    user.authKey      = String(config.authKey || "");
  }
  if (securityLevel === snmp.SecurityLevel.authPriv) {
    user.privProtocol = mapSnmpPrivProtocol(config.privProtocol);
    user.privKey      = String(config.privKey || "");
  }
  return snmp.createV3Session(host, user, {
    port,
    version: snmp.Version3,
    timeout: PROBE_TIMEOUT_MS,
    retries: 0,
  });
}

/**
 * Walk an OID subtree and return varbinds keyed by the index suffix that
 * follows `baseOid.`. Stops once SNMP_WALK_MAX rows have been collected.
 */
function snmpWalk(session: any, baseOid: string): Promise<Map<string, any>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, any>();
    const prefix = baseOid + ".";
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(out);
    };
    try {
      session.subtree(
        baseOid,
        20, // maxRepetitions
        (varbinds: any[]) => {
          for (const vb of varbinds) {
            if (snmp.isVarbindError(vb)) continue;
            if (typeof vb.oid !== "string" || !vb.oid.startsWith(prefix)) continue;
            const suffix = vb.oid.slice(prefix.length);
            out.set(suffix, vb.value);
            if (out.size >= SNMP_WALK_MAX) return finish();
          }
        },
        (err?: Error) => finish(err),
      );
    } catch (err: any) {
      finish(err);
    }
  });
}

function snmpVbToString(v: unknown): string {
  if (v == null) return "";
  if (Buffer.isBuffer(v)) return v.toString("utf8").replace(/ +$/, "");
  return String(v);
}

function snmpVbToNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (Buffer.isBuffer(v) && v.length <= 8) {
    let n = 0n;
    for (const b of v) n = (n << 8n) | BigInt(b);
    return Number(n);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function snmpMacFromBuffer(v: unknown): string | null {
  if (!Buffer.isBuffer(v) || v.length !== 6) return null;
  return Array.from(v).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

async function withSnmpSession<T>(host: string, config: Record<string, unknown>, fn: (s: any) => Promise<T>): Promise<T> {
  const session = buildSnmpSession(host, config);
  // net-snmp emits 'error' rather than throwing for socket/listener errors;
  // attach a no-op listener so a stray error doesn't kill the process. The
  // walk itself will still propagate the error through its callback.
  session.on?.("error", () => {});
  try {
    return await fn(session);
  } finally {
    try { session.close?.(); } catch {}
  }
}

async function collectTelemetrySnmp(
  host: string,
  config: Record<string, unknown>,
  manufacturer?: string | null,
  model?: string | null,
  os?: string | null,
): Promise<TelemetrySample> {
  // Make sure the symbol table is populated before we try to resolve any
  // vendor symbols. ensureRegistryLoaded short-circuits after the first call.
  await ensureRegistryLoaded();
  const profile = pickVendorProfile(manufacturer, os);
  const scope = { manufacturer, model };

  return await withSnmpSession(host, config, async (session) => {
    let cpuPct: number | null = null;
    let memUsedBytes: number | null = null;
    let memTotalBytes: number | null = null;
    let memPct: number | null = null;

    // ── CPU ──
    // Try the vendor profile first if one matches and its symbol resolves.
    // If the vendor query yields nothing (MIB not uploaded, or device doesn't
    // expose the OID), fall back to HOST-RESOURCES-MIB so a stock SNMP host
    // still gets coverage.
    if (profile?.cpu) {
      cpuPct = await collectCpuVendor(session, profile, profile.cpu, scope).catch(() => null);
    }
    if (cpuPct == null) {
      cpuPct = await collectCpuHostResources(session).catch(() => null);
    }

    // ── Memory ──
    if (profile?.memory) {
      const m = await collectMemoryVendor(session, profile, profile.memory, scope).catch(() => null);
      if (m) {
        memUsedBytes  = m.memUsedBytes  ?? memUsedBytes;
        memTotalBytes = m.memTotalBytes ?? memTotalBytes;
        memPct        = m.memPct        ?? memPct;
      }
    }
    if (memUsedBytes == null && memPct == null) {
      const hrm = await collectMemoryHostResources(session).catch(() => null);
      if (hrm) {
        memUsedBytes  = hrm.memUsedBytes;
        memTotalBytes = hrm.memTotalBytes;
        memPct        = hrm.memPct;
      }
    } else if (memUsedBytes != null && memTotalBytes != null && memTotalBytes > 0 && memPct == null) {
      memPct = clampPct((memUsedBytes / memTotalBytes) * 100);
    }

    // Temperatures: walk ENTITY-SENSOR-MIB and pick rows with type=8 (celsius)
    // and operStatus=1 (ok). entPhysicalDescr (ENTITY-MIB) keyed by the same
    // physical-entity index gives the friendly name. Devices that don't
    // implement the MIB just return nothing.
    const temperatures = await collectTemperaturesSnmp(session).catch(() => [] as TemperatureSample[]);

    return { cpuPct, memPct, memUsedBytes, memTotalBytes, temperatures };
  });
}

// ─── Vendor + HOST-RESOURCES-MIB helpers ──────────────────────────────────

async function collectCpuHostResources(session: any): Promise<number | null> {
  const cpuRows = await snmpWalk(session, OID.hrProcessorLoad);
  const vals: number[] = [];
  for (const v of cpuRows.values()) {
    const n = snmpVbToNumber(v);
    if (n != null) vals.push(n);
  }
  if (vals.length === 0) return null;
  return clampPct(vals.reduce((a, b) => a + b, 0) / vals.length);
}

async function collectMemoryHostResources(
  session: any,
): Promise<{ memUsedBytes: number | null; memTotalBytes: number | null; memPct: number | null } | null> {
  const types = await snmpWalk(session, OID.hrStorageType);
  const ramIdx = [...types.entries()].find(([, v]) => snmpVbToString(v) === OID.hrStorageRam)?.[0];
  if (!ramIdx) return null;
  const [units, size, used] = await Promise.all([
    snmpWalk(session, OID.hrStorageAllocationUnits + "." + ramIdx).catch(() => new Map()),
    snmpWalk(session, OID.hrStorageSize             + "." + ramIdx).catch(() => new Map()),
    snmpWalk(session, OID.hrStorageUsed             + "." + ramIdx).catch(() => new Map()),
  ]);
  const u = snmpVbToNumber(units.get("")) ?? 1;
  const s = snmpVbToNumber(size.get(""));
  const ud = snmpVbToNumber(used.get(""));
  let memUsedBytes: number | null = null;
  let memTotalBytes: number | null = null;
  let memPct: number | null = null;
  if (s != null) memTotalBytes = s * u;
  if (ud != null) memUsedBytes = ud * u;
  if (memTotalBytes && memTotalBytes > 0 && memUsedBytes != null) {
    memPct = clampPct((memUsedBytes / memTotalBytes) * 100);
  }
  return { memUsedBytes, memTotalBytes, memPct };
}

// Resolve a vendor symbolic OID and emit a single GET on the `.0` instance,
// or a subtree walk + average / sum depending on the profile mode.
async function collectCpuVendor(
  session: any,
  profile: VendorTelemetryProfile,
  cpu: NonNullable<VendorTelemetryProfile["cpu"]>,
  scope: { manufacturer?: string | null; model?: string | null },
): Promise<number | null> {
  const oid = resolveOidSync(cpu.symbol, scope);
  if (!oid) {
    logger.debug({ vendor: profile.vendor, symbol: cpu.symbol, scope }, "vendor CPU symbol unresolved — upload its MIB to enable");
    return null;
  }
  if (cpu.mode === "scalar") {
    const v = await snmpGetScalar(session, oid);
    const n = snmpVbToNumber(v);
    return n != null ? clampPct(n) : null;
  }
  // walk-avg
  const rows = await snmpWalk(session, oid);
  const vals: number[] = [];
  for (const v of rows.values()) {
    const n = snmpVbToNumber(v);
    if (n != null) vals.push(n);
  }
  if (vals.length === 0) return null;
  return clampPct(vals.reduce((a, b) => a + b, 0) / vals.length);
}

async function collectMemoryVendor(
  session: any,
  profile: VendorTelemetryProfile,
  mem: NonNullable<VendorTelemetryProfile["memory"]>,
  scope: { manufacturer?: string | null; model?: string | null },
): Promise<{ memUsedBytes: number | null; memTotalBytes: number | null; memPct: number | null } | null> {
  // Prefer byte-form pairs (used + free or used + total). When both are
  // missing fall back to a single percent symbol.
  const usedOid  = mem.usedBytesSymbol  ? resolveOidSync(mem.usedBytesSymbol,  scope) : null;
  const freeOid  = mem.freeBytesSymbol  ? resolveOidSync(mem.freeBytesSymbol,  scope) : null;
  const totalOid = mem.totalBytesSymbol ? resolveOidSync(mem.totalBytesSymbol, scope) : null;
  const pctOid   = mem.pctSymbol        ? resolveOidSync(mem.pctSymbol,        scope) : null;

  const sumWalk = async (oid: string): Promise<number | null> => {
    if (mem.walkSubtree) {
      const rows = await snmpWalk(session, oid);
      let total = 0;
      let any = false;
      for (const v of rows.values()) {
        const n = snmpVbToNumber(v);
        if (n != null) { total += n; any = true; }
      }
      return any ? total : null;
    }
    const v = await snmpGetScalar(session, oid);
    return snmpVbToNumber(v);
  };

  let memUsedBytes: number | null = null;
  let memTotalBytes: number | null = null;
  let memPct: number | null = null;

  if (usedOid) memUsedBytes = await sumWalk(usedOid).catch(() => null);
  if (totalOid) {
    memTotalBytes = await sumWalk(totalOid).catch(() => null);
  } else if (freeOid && memUsedBytes != null) {
    const free = await sumWalk(freeOid).catch(() => null);
    if (free != null) memTotalBytes = memUsedBytes + free;
  }

  if (memUsedBytes != null && memTotalBytes && memTotalBytes > 0) {
    memPct = clampPct((memUsedBytes / memTotalBytes) * 100);
  } else if (pctOid) {
    const p = await sumWalk(pctOid).catch(() => null);
    if (p != null) {
      // Walked-then-summed percentages (e.g. Juniper jnxOperatingBuffer
      // averaged across operating entities) are technically a sum, but the
      // operator-meaningful value is the average. Re-divide by row count.
      if (mem.walkSubtree && pctOid) {
        const rows = await snmpWalk(session, pctOid).catch(() => new Map());
        const count = [...rows.values()].filter((v) => snmpVbToNumber(v) != null).length;
        memPct = count > 0 ? clampPct(p / count) : null;
      } else {
        memPct = clampPct(p);
      }
    }
  }

  if (memUsedBytes == null && memTotalBytes == null && memPct == null) return null;
  return { memUsedBytes, memTotalBytes, memPct };
}

// Single-OID GET (instance .0). Returns the varbind value or null.
function snmpGetScalar(session: any, oid: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = oid.endsWith(".0") ? oid : oid + ".0";
    try {
      session.get([target], (err: Error | null, varbinds: any[]) => {
        if (err) return reject(err);
        const vb = varbinds?.[0];
        if (!vb || snmp.isVarbindError(vb)) return resolve(null);
        resolve(vb.value);
      });
    } catch (err: any) {
      reject(err);
    }
  });
}

async function collectTemperaturesSnmp(session: any): Promise<TemperatureSample[]> {
  const [types, values, scales, precisions, opers, descrs] = await Promise.all([
    snmpWalk(session, OID.entPhySensorType).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorValue).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorScale).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorPrecision).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorOperStatus).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalDescr).catch(() => new Map()),
  ]);
  const out: TemperatureSample[] = [];
  for (const [idx, typeRaw] of types.entries()) {
    const t = snmpVbToNumber(typeRaw);
    if (t !== 8) continue; // RFC 3433: 8 = celsius
    const oper = snmpVbToNumber(opers.get(idx));
    // 1 = ok, 2 = unavailable, 3 = nonoperational. Skip non-ok rows.
    if (oper != null && oper !== 1) continue;
    const raw = snmpVbToNumber(values.get(idx));
    if (raw == null) continue;
    const scale = snmpVbToNumber(scales.get(idx));   // SI prefix code
    const prec  = snmpVbToNumber(precisions.get(idx)); // decimal-point shift
    const celsius = scaleEntitySensor(raw, scale, prec);
    out.push({
      sensorName: snmpVbToString(descrs.get(idx)) || `sensor-${idx}`,
      celsius:    Number.isFinite(celsius) ? Math.round(celsius * 10) / 10 : null,
    });
  }
  return out;
}

// Apply ENTITY-SENSOR-MIB scale + precision to a raw integer reading. Scale is
// the SI-prefix code (1=10^-24 ... 9=10^0 ... 17=10^24); precision is a signed
// shift of the decimal point. Both default to "no scaling" when omitted.
function scaleEntitySensor(raw: number, scale: number | null, precision: number | null): number {
  const sExp = scale != null ? (scale - 9) * 3 : 0;
  const pExp = precision != null ? -precision : 0;
  return raw * Math.pow(10, sExp) * Math.pow(10, pExp);
}

async function collectSystemInfoSnmp(host: string, config: Record<string, unknown>): Promise<SystemInfoSample> {
  return await withSnmpSession(host, config, async (session) => {
    // Storage: walk hrStorage and pick rows tagged as fixed/removable disk.
    const storage: StorageSample[] = [];
    try {
      const types = await snmpWalk(session, OID.hrStorageType);
      const diskIdxs = [...types.entries()].filter(([, v]) => {
        const t = snmpVbToString(v);
        return t === OID.hrStorageFixedDisk || t === OID.hrStorageRemovableDisk;
      }).map(([k]) => k);
      if (diskIdxs.length > 0) {
        const [descrs, units, sizes, useds] = await Promise.all([
          snmpWalk(session, OID.hrStorageDescr).catch(() => new Map()),
          snmpWalk(session, OID.hrStorageAllocationUnits).catch(() => new Map()),
          snmpWalk(session, OID.hrStorageSize).catch(() => new Map()),
          snmpWalk(session, OID.hrStorageUsed).catch(() => new Map()),
        ]);
        for (const idx of diskIdxs) {
          const u = snmpVbToNumber(units.get(idx)) ?? 1;
          const s = snmpVbToNumber(sizes.get(idx));
          const ud = snmpVbToNumber(useds.get(idx));
          storage.push({
            mountPath:  snmpVbToString(descrs.get(idx)) || `disk-${idx}`,
            totalBytes: s != null  ? s * u  : null,
            usedBytes:  ud != null ? ud * u : null,
          });
        }
      }
    } catch { /* fall through; storage stays empty */ }

    // Interfaces: build a map keyed by ifIndex from IF-MIB columns. Prefer
    // ifName / ifHC*Octets / ifHighSpeed when present; otherwise fall back
    // to the legacy 32-bit columns.
    const interfaces: InterfaceSample[] = [];
    try {
      const [
        names, descrs, admin, oper, speeds, hiSpeeds, mac,
        in32, out32, inHC, outHC, ipMap, inErr, outErr, ifTypes,
      ] = await Promise.all([
        snmpWalk(session, OID.ifName).catch(() => new Map()),
        snmpWalk(session, OID.ifDescr).catch(() => new Map()),
        snmpWalk(session, OID.ifAdminStatus).catch(() => new Map()),
        snmpWalk(session, OID.ifOperStatus).catch(() => new Map()),
        snmpWalk(session, OID.ifSpeed).catch(() => new Map()),
        snmpWalk(session, OID.ifHighSpeed).catch(() => new Map()),
        snmpWalk(session, OID.ifPhysAddress).catch(() => new Map()),
        snmpWalk(session, OID.ifInOctets).catch(() => new Map()),
        snmpWalk(session, OID.ifOutOctets).catch(() => new Map()),
        snmpWalk(session, OID.ifHCInOctets).catch(() => new Map()),
        snmpWalk(session, OID.ifHCOutOctets).catch(() => new Map()),
        snmpWalk(session, OID.ipAdEntIfIndex).catch(() => new Map()),
        snmpWalk(session, OID.ifInErrors).catch(() => new Map()),
        snmpWalk(session, OID.ifOutErrors).catch(() => new Map()),
        snmpWalk(session, OID.ifType).catch(() => new Map()),
      ]);

      // Build ifIndex → first IP map by inverting ipAdEntIfIndex (suffix is the IP itself).
      const ipByIfIndex = new Map<string, string>();
      for (const [ip, idxRaw] of ipMap.entries()) {
        const idx = String(snmpVbToNumber(idxRaw) ?? "");
        if (!idx) continue;
        if (!ipByIfIndex.has(idx)) ipByIfIndex.set(idx, ip);
      }

      const allIdx = new Set<string>([
        ...names.keys(), ...descrs.keys(), ...admin.keys(), ...oper.keys(),
      ]);
      for (const idx of allIdx) {
        const name = snmpVbToString(names.get(idx)) || snmpVbToString(descrs.get(idx)) || `if-${idx}`;
        const speedHi = snmpVbToNumber(hiSpeeds.get(idx));
        const speed32 = snmpVbToNumber(speeds.get(idx));
        const speedBps = speedHi && speedHi > 0
          ? speedHi * 1_000_000
          : (speed32 != null ? speed32 : null);
        const inHi = snmpVbToNumber(inHC.get(idx));
        const outHi = snmpVbToNumber(outHC.get(idx));
        interfaces.push({
          ifName:      name,
          adminStatus: ifStatusLabel(snmpVbToNumber(admin.get(idx))),
          operStatus:  ifStatusLabel(snmpVbToNumber(oper.get(idx))),
          speedBps,
          ipAddress:   ipByIfIndex.get(idx) || null,
          macAddress:  snmpMacFromBuffer(mac.get(idx)),
          inOctets:    inHi != null  ? inHi  : snmpVbToNumber(in32.get(idx)),
          outOctets:   outHi != null ? outHi : snmpVbToNumber(out32.get(idx)),
          inErrors:    snmpVbToNumber(inErr.get(idx)),
          outErrors:   snmpVbToNumber(outErr.get(idx)),
          ifType:      snmpIfTypeLabel(snmpVbToNumber(ifTypes.get(idx))),
        });
      }
    } catch { /* fall through */ }

    return { interfaces, storage };
  });
}

function ifStatusLabel(n: number | null): string | null {
  switch (n) {
    case 1: return "up";
    case 2: return "down";
    case 3: return "testing";
    case 4: return "unknown";
    case 5: return "dormant";
    case 6: return "notPresent";
    case 7: return "lowerLayerDown";
    default: return null;
  }
}

// Maps IF-MIB ifType integer (1.3.6.1.2.1.2.2.1.3) to our canonical type string.
// Only covers the values commonly seen on network gear; everything else is null.
function snmpIfTypeLabel(n: number | null | undefined): string | null {
  switch (n) {
    case 6:   return "physical";   // ethernetCsmacd
    case 24:  return "loopback";   // softwareLoopback
    case 131: return "tunnel";     // tunnel
    case 135: return "vlan";       // l2vlan
    case 161: return "aggregate";  // ieee8023adLag
    case 166: return "tunnel";     // mpls
    default:  return null;
  }
}

// ─── Persisting telemetry / system info ─────────────────────────────────────

export async function recordTelemetryResult(assetId: string, result: CollectionResult<TelemetrySample>): Promise<void> {
  if (!result.supported) return;
  const now = new Date();
  if (result.data) {
    const d = result.data;
    await prisma.assetTelemetrySample.create({
      data: {
        assetId,
        timestamp: now,
        cpuPct:        d.cpuPct ?? null,
        memPct:        d.memPct ?? null,
        memUsedBytes:  d.memUsedBytes  != null ? BigInt(Math.round(d.memUsedBytes))  : null,
        memTotalBytes: d.memTotalBytes != null ? BigInt(Math.round(d.memTotalBytes)) : null,
      },
    });
    if (Array.isArray(d.temperatures) && d.temperatures.length > 0) {
      await prisma.assetTemperatureSample.createMany({
        data: d.temperatures.map((t) => ({
          assetId,
          timestamp: now,
          sensorName: t.sensorName,
          celsius:    t.celsius,
        })),
      });
    }
  }
  // Always advance the cadence stamp so a transient failure doesn't make us
  // hammer the device every 5 s.
  await prisma.asset.update({ where: { id: assetId }, data: { lastTelemetryAt: now } });
}

export async function recordSystemInfoResult(assetId: string, result: CollectionResult<SystemInfoSample>): Promise<void> {
  if (!result.supported) return;
  const now = new Date();
  if (result.data) {
    const d = result.data;
    if (d.interfaces.length > 0) {
      await prisma.assetInterfaceSample.createMany({
        data: d.interfaces.map((i) => ({
          assetId,
          timestamp: now,
          ifName:      i.ifName,
          adminStatus: i.adminStatus ?? null,
          operStatus:  i.operStatus ?? null,
          speedBps:    i.speedBps != null ? BigInt(Math.round(i.speedBps)) : null,
          ipAddress:   i.ipAddress ?? null,
          macAddress:  i.macAddress ?? null,
          inOctets:    i.inOctets  != null ? BigInt(Math.round(i.inOctets))  : null,
          outOctets:   i.outOctets != null ? BigInt(Math.round(i.outOctets)) : null,
          inErrors:    i.inErrors  != null ? BigInt(Math.round(i.inErrors))  : null,
          outErrors:   i.outErrors != null ? BigInt(Math.round(i.outErrors)) : null,
          ifType:      i.ifType   ?? null,
          ifParent:    i.ifParent ?? null,
          vlanId:      i.vlanId   ?? null,
        })),
      });
    }
    if (d.storage.length > 0) {
      await prisma.assetStorageSample.createMany({
        data: d.storage.map((s) => ({
          assetId,
          timestamp: now,
          mountPath:  s.mountPath,
          totalBytes: s.totalBytes != null ? BigInt(Math.round(s.totalBytes)) : null,
          usedBytes:  s.usedBytes  != null ? BigInt(Math.round(s.usedBytes))  : null,
        })),
      });
    }
    if (Array.isArray(d.ipsecTunnels) && d.ipsecTunnels.length > 0) {
      await prisma.assetIpsecTunnelSample.createMany({
        data: d.ipsecTunnels.map((t) => ({
          assetId,
          timestamp: now,
          tunnelName:    t.tunnelName,
          remoteGateway: t.remoteGateway,
          status:        t.status,
          incomingBytes: t.incomingBytes != null ? BigInt(Math.round(t.incomingBytes)) : null,
          outgoingBytes: t.outgoingBytes != null ? BigInt(Math.round(t.outgoingBytes)) : null,
          proxyIdCount:  t.proxyIdCount,
        })),
      });
    }
    // Mirror per-interface IPs+MACs into Asset.associatedIps. Replaces what
    // the old FMG/FortiGate Phase 4b used to write — discovery no longer
    // populates interface IPs, so the System tab is the single source for
    // them once monitoring is on. Manual entries (`source: "manual"`) are
    // preserved across pulls.
    const associatedIps = buildAssociatedIpsFromInterfaces(assetId, d.interfaces, now);
    if (associatedIps !== null) {
      await prisma.asset.update({ where: { id: assetId }, data: { associatedIps: associatedIps as any } });
    }
  }
  await prisma.asset.update({ where: { id: assetId }, data: { lastSystemInfoAt: now } });
}

/**
 * Build the new Asset.associatedIps payload from a fresh interface scrape.
 * Returns null when the asset doesn't exist or the scrape returned no
 * interface IPs (in which case we leave whatever is there alone — better to
 * keep a stale-ish list than wipe it on a transient empty result).
 */
async function buildAssociatedIpsFromInterfaces(
  assetId: string,
  interfaces: InterfaceSample[],
  now: Date,
): Promise<unknown[] | null> {
  const monitorEntries: Array<Record<string, unknown>> = [];
  for (const i of interfaces) {
    if (!i.ipAddress) continue;
    monitorEntries.push({
      ip:            i.ipAddress,
      interfaceName: i.ifName,
      ...(i.macAddress ? { mac: i.macAddress } : {}),
      source:        "monitor-system-info",
      lastSeen:      now.toISOString(),
    });
  }
  if (monitorEntries.length === 0) return null;

  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { associatedIps: true } });
  if (!asset) return null;
  const existing: any[] = Array.isArray(asset.associatedIps) ? (asset.associatedIps as any[]) : [];
  const manualEntries = existing.filter((e: any) => e?.source === "manual");
  return [...manualEntries, ...monitorEntries];
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
  /** System tab cadences. Tallied separately so a slow telemetry call doesn't look like a probe failure. */
  telemetry:    { collected: number; failed: number };
  systemInfo:   { collected: number; failed: number };
  fastFiltered: { collected: number; failed: number };
}

/**
 * One iteration of the monitor job. Picks assets due for any of the three
 * cadences (response-time probe, telemetry, system info) and runs the due
 * work in parallel. Each cadence has its own due check + per-asset interval
 * override (`monitorIntervalSec`, `telemetryIntervalSec`, `systemInfoIntervalSec`).
 */
export async function runMonitorPass(opts?: { concurrency?: number }): Promise<RunStats> {
  const settings = await getMonitorSettings();
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 8, 32));
  const now = new Date();

  const candidates = await prisma.asset.findMany({
    where: { monitored: true, monitorType: { not: null } },
    select: {
      id: true,
      lastMonitorAt: true, monitorIntervalSec: true,
      lastTelemetryAt: true, telemetryIntervalSec: true,
      lastSystemInfoAt: true, systemInfoIntervalSec: true,
      monitoredInterfaces: true,
      monitoredStorage: true,
      monitoredIpsecTunnels: true,
    },
  });

  function isDue(last: Date | null, perAsset: number | null, defaultSec: number): boolean {
    if (defaultSec <= 0) return false;
    const intervalSec = perAsset || defaultSec;
    if (!last) return true;
    return now.getTime() - last.getTime() >= intervalSec * 1000;
  }

  type Work = {
    id: string;
    probe:        boolean;
    telemetry:    boolean;
    systemInfo:   boolean;
    fastFiltered: boolean;
  };
  const work: Work[] = candidates.map((a) => {
    const probe = isDue(a.lastMonitorAt, a.monitorIntervalSec, settings.intervalSeconds);
    const hasFastPin =
      (Array.isArray(a.monitoredInterfaces)   && a.monitoredInterfaces.length   > 0) ||
      (Array.isArray(a.monitoredStorage)      && a.monitoredStorage.length      > 0) ||
      (Array.isArray(a.monitoredIpsecTunnels) && a.monitoredIpsecTunnels.length > 0);
    return {
      id: a.id,
      probe,
      telemetry:    isDue(a.lastTelemetryAt,  a.telemetryIntervalSec,  settings.telemetryIntervalSeconds),
      systemInfo:   isDue(a.lastSystemInfoAt, a.systemInfoIntervalSec, settings.systemInfoIntervalSeconds),
      // Pinned interfaces / storage / tunnels ride the response-time cadence —
      // intervalSeconds defaults to 60s. The full systemInfo pass at ~10 min
      // still covers everything, so this only adds work for the pinned subset.
      fastFiltered: probe && hasFastPin,
    };
  }).filter((w) => w.probe || w.telemetry || w.systemInfo || w.fastFiltered);

  const stats: RunStats = {
    probed: 0, succeeded: 0, failed: 0,
    telemetry:  { collected: 0, failed: 0 },
    systemInfo: { collected: 0, failed: 0 },
    fastFiltered: { collected: 0, failed: 0 },
  };
  if (work.length === 0) return stats;

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < work.length) {
      const idx = cursor++;
      const w = work[idx];
      if (w.probe) {
        try {
          const result = await probeAsset(w.id);
          await recordProbeResult(w.id, result);
          stats.probed++;
          if (result.success) stats.succeeded++;
          else stats.failed++;
        } catch (err) {
          logger.error({ err, assetId: w.id }, "Monitor probe crashed");
          stats.probed++;
          stats.failed++;
        }
      }
      if (w.telemetry) {
        try {
          const tr = await collectTelemetry(w.id);
          await recordTelemetryResult(w.id, tr);
          if (tr.supported) {
            if (tr.data) stats.telemetry.collected++;
            else stats.telemetry.failed++;
          }
        } catch (err) {
          logger.error({ err, assetId: w.id }, "Telemetry collection crashed");
          stats.telemetry.failed++;
        }
      }
      if (w.systemInfo) {
        try {
          const sr = await collectSystemInfo(w.id);
          await recordSystemInfoResult(w.id, sr);
          if (sr.supported) {
            if (sr.data) stats.systemInfo.collected++;
            else stats.systemInfo.failed++;
          }
        } catch (err) {
          logger.error({ err, assetId: w.id }, "System info collection crashed");
          stats.systemInfo.failed++;
        }
      }
      // Skip the fast scrape when the full one already ran this tick — they'd
      // hit the same endpoint twice. The full scrape already wrote rows for
      // every interface / mountpoint / tunnel, including the pinned ones.
      if (w.fastFiltered && !w.systemInfo) {
        try {
          const fr = await collectFastFiltered(w.id);
          await recordFastFilteredResult(w.id, fr);
          if (fr.supported) {
            if (fr.data) stats.fastFiltered.collected++;
            else stats.fastFiltered.failed++;
          }
        } catch (err) {
          logger.error({ err, assetId: w.id }, "Fast-cadence scrape crashed");
          stats.fastFiltered.failed++;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, () => worker()));
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

/**
 * Trim AssetTelemetrySample + AssetTemperatureSample rows older than the
 * telemetry retention window. Temperatures share telemetry's retention because
 * they're collected on the same cadence and we never want one to outlive the
 * other when stitching them onto the same chart.
 */
export async function pruneTelemetrySamples(): Promise<number> {
  const { telemetryRetentionDays } = await getMonitorSettings();
  if (!telemetryRetentionDays || telemetryRetentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - telemetryRetentionDays * 24 * 3600 * 1000);
  const [tel, temps] = await Promise.all([
    prisma.assetTelemetrySample.deleteMany({   where: { timestamp: { lt: cutoff } } }),
    prisma.assetTemperatureSample.deleteMany({ where: { timestamp: { lt: cutoff } } }),
  ]);
  return tel.count + temps.count;
}

/**
 * Trim AssetInterfaceSample + AssetStorageSample + AssetIpsecTunnelSample rows
 * older than the system info retention window. Returns total rows removed.
 */
export async function pruneSystemInfoSamples(): Promise<number> {
  const { systemInfoRetentionDays } = await getMonitorSettings();
  if (!systemInfoRetentionDays || systemInfoRetentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - systemInfoRetentionDays * 24 * 3600 * 1000);
  const [ifaces, storage, ipsec] = await Promise.all([
    prisma.assetInterfaceSample.deleteMany({    where: { timestamp: { lt: cutoff } } }),
    prisma.assetStorageSample.deleteMany({      where: { timestamp: { lt: cutoff } } }),
    prisma.assetIpsecTunnelSample.deleteMany({  where: { timestamp: { lt: cutoff } } }),
  ]);
  return ifaces.count + storage.count + ipsec.count;
}
