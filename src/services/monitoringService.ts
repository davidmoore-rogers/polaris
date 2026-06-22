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
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import * as snmp from "net-snmp";
import { Client as SshClient } from "ssh2";

import { prisma } from "../db.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";
import { AppError } from "../utils/errors.js";
import { addMacAddresses } from "../utils/macAddresses.js";
import { pingHost } from "../utils/icmpPing.js";
import {
  fortiosBool,
  parseFortiosMemberList,
  buildFortiswitchTrunkMembers,
  findFortiswitchUplinkPorts,
} from "../utils/fortiswitchCmdb.js";
// Re-exported so existing import sites (unit tests, etc.) keep resolving these
// from monitoringService; implementations live in utils/fortiswitchCmdb.ts.
export { parseFortiosMemberList, buildFortiswitchTrunkMembers, findFortiswitchUplinkPorts };
import { fgRequest, type FortiGateConfig } from "./fortigateService.js";
import {
  fmgProxyRest,
  resolveDeviceMgmtIpViaFmg,
  type FortiManagerConfig,
} from "./fortimanagerService.js";
import { logEvent } from "../api/routes/events.js";
import { logger } from "../utils/logger.js";
import { parseFortiapTelemetrySnapshot } from "../utils/fortiapMonitorRow.js";
import { deriveRadioBand } from "../utils/fortiapRadioBand.js";
import { resolveOidSync, ensureRegistryLoaded } from "./oidRegistry.js";
import {
  pickVendorProfile,
  type VendorTelemetryProfile,
} from "./vendorTelemetryProfiles.js";
import {
  getProfileFor as getDbManufacturerProfile,
  type MetricKey,
  type MetricRow,
} from "./manufacturerProfileService.js";
import {
  startPassTimer,
  startWorkTimer,
  recordWorkOutcome,
  recordProbe,
  setMonitoredAssets,
  setQueueDepth,
  startSampleWriteTimer,
} from "../metrics.js";
import pg from "pg";
import { dropChunks, getEffectiveCompressAfterDays } from "./timescaleService.js";
import { getSampleRetention, FOREVER, unselectedSlowPruneWindow, tieredPruneWindow } from "./sampleRetentionService.js";
import { getDirectDatabaseUrl } from "../utils/dbConnections.js";
import {
  enqueueMonitorSample,
  enqueueTelemetrySample,
  enqueueHardwareSensorSamples,
  enqueueInterfaceSamples,
  enqueueStorageSamples,
  enqueueIpsecTunnelSamples,
  enqueuePerfSlaSamples,
} from "./sampleWriteBuffer.js";
import {
  classifyHardwareSensor,
  normalizeFgAlarmStatus,
  normalizeRestAlarmStatus,
} from "../utils/hardwareSensors.js";
import { enqueueProbePatch, getPendingProbePatch } from "./probePatchBuffer.js";
import {
  type PollingMethod,
  type AssetSourceKind,
  type Stream,
  isPollingMethod,
  isPollingMethodCompatible,
  isMethodValidForStream,
  assetSourceKindFromIntegrationType,
} from "../utils/pollingCompatibility.js";
import { propagateAfterStatusChange } from "./dependencyTreeService.js";
import { triggerRetryAfterStatusChange } from "./reservationService.js";
import { recordIpHistoryEntries } from "./assetIpHistoryService.js";

export interface ProbeResult {
  success: boolean;
  /** Wall-clock duration of the probe, rounded to integer ms. */
  responseTimeMs: number;
  /** Short human-readable reason on failure; null on success. */
  error?: string;
  /**
   * Device sysUpTime in whole seconds, set only by the SNMP probe (which
   * reads sysUpTime as its reachability OID anyway). undefined for every other
   * transport. recordProbeResult uses it for reboot detection — see
   * Asset.lastUptimeSec / lastRebootAt.
   */
  uptimeSec?: number;
}

/**
 * Slim subset of Asset columns that `recordProbeResult` needs for its
 * state-machine update. Lets the hot loop (runProbeFor) preload the asset
 * once and skip the second findUnique inside recordProbeResult.
 *
 * The type is structural — fields named the same as on the Asset model so
 * a `Prisma.AssetGetPayload<...>` row (the shape probeAsset already loads
 * with its includes) satisfies it without an explicit map step.
 */
export interface AssetMonitorSnapshot {
  id: string;
  hostname: string | null;
  assetType: string;
  monitored: boolean;
  monitorStatus: string | null;
  /** Last SNMP sysUpTime reading (whole seconds); drives reboot detection. */
  lastUptimeSec?: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  discoveredByIntegrationId: string | null;
  monitorIntervalSec: number | null;
  cpuMemoryIntervalSec: number | null;
  temperatureIntervalSec: number | null;
  systemInfoIntervalSec: number | null;
  probeTimeoutMs: number | null;
  cpuMemoryTimeoutMs?: number | null;
  temperatureTimeoutMs?: number | null;
  systemInfoTimeoutMs?: number | null;
}

// ─── Monitor settings hierarchy ─────────────────────────────────────────────
//
// Resolution order (most-specific wins):
//
//   per-asset override  →  (assetType + integration) class override
//                       →  integration tier   (for integration-discovered assets)
//                          OR manual tier     (for orphan assets)
//                       →  hardcoded floor    (final safety net; never user-visible)
//
// Tier-3 ("integration tier" / "manual tier") storage:
//   - integration tier → Integration.config.monitorSettings JSON blob
//   - manual tier      → Setting row keyed "manualMonitorSettings"
//
// Tier-2 ("class override") storage: MonitorClassOverride table, one row per
//   (integrationId, assetType). Null integrationId = override for orphan assets.
//
// Tier-1 ("per-asset") storage: individual columns on Asset
//   (monitorIntervalSec, telemetryIntervalSec, systemInfoIntervalSec,
//    probeTimeoutMs). null = inherit.
//
// Probe timeout note: there is no asset-level override for `failureThreshold`
// or any retention field. Those cascade only down to tier-2.
//
// `MonitorTierSettings` is the canonical "all eight settings populated" shape
// used at every level of the resolver after merging. `MonitorOverrideSettings`
// is the partial shape used at tier-1 / tier-2 (null = inherit).

export interface MonitorTierSettings {
  intervalSeconds:           number;
  failureThreshold:          number;
  /** Probe TCP/UDP/HTTP timeout in milliseconds. Default 5000. Range 100..60000. */
  probeTimeoutMs:            number;
  /**
   * Per-request timeout (ms) for the CPU+memory collector. Applied to
   * FortiOS REST + SNMP sessions inside collectCpuMemory. Default 10000.
   * Range 1000..120000.
   */
  cpuMemoryTimeoutMs:        number;
  /**
   * Per-request timeout (ms) for the temperature collector. Applied to
   * FortiOS REST + SNMP sessions inside collectTemperature (ENTITY-SENSOR-MIB
   * walk, Fortinet sensor-name heuristic, FortiAP scalar fallback). Default
   * 10000. Range 1000..120000.
   */
  temperatureTimeoutMs:      number;
  /**
   * Per-request timeout (ms) for the interface / storage / LLDP collector.
   * Applied to FortiOS REST + SNMP sessions inside collectSystemInfo +
   * collectFastFiltered. Default 10000. Range 1000..120000.
   */
  systemInfoTimeoutMs:       number;
  cpuMemoryIntervalSeconds:  number;
  temperatureIntervalSeconds: number;
  systemInfoIntervalSeconds: number;
  /**
   * Phase 2 carve-out — LLDP rides its own pg-boss queue
   * (polaris-monitor-lldp) and its own cadence. Defaults to the systemInfo
   * cadence at the floor; operators can set it slower (e.g. once an hour
   * while interfaces scrape every 10 min) to cut LLDP-MIB walk pressure
   * on big fleets.
   */
  lldpIntervalSeconds:       number;
  /** Per-request timeout (ms) for the LLDP collector. Default 10000. */
  lldpTimeoutMs:             number;
  /**
   * Phase 2 carve-out — Storage rides its own pg-boss queue
   * (polaris-monitor-storage) and its own cadence. Same shape as
   * lldpIntervalSeconds / lldpTimeoutMs.
   */
  storageIntervalSeconds:    number;
  storageTimeoutMs:          number;
  /**
   * Cross-transport streams (agent / SNMP / SSH / WinRM / REST). Each rides its
   * own cadence + timeout like LLDP / Storage. processes = running-program
   * inventory + per-program CPU/RAM; eventLog = curated OS event-log entries
   * folded into the audit Event table. Method sets enforced by
   * utils/pollingCompatibility STREAM_METHODS.
   */
  processesIntervalSeconds:  number;
  processesTimeoutMs:        number;
  eventLogIntervalSeconds:   number;
  eventLogTimeoutMs:         number;
  sampleRetentionDays:       number;
  /**
   * Single retention setting shared by AssetTelemetrySample (CPU/memory)
   * AND AssetHardwareSensorSample. The stream split affects polling method /
   * cadence / credential / MIB / timeout — sample retention is table-level
   * so one knob covers both sample tables.
   */
  telemetryRetentionDays:    number;
  systemInfoRetentionDays:   number;
  /**
   * Per-stream polling method. null at this tier = "no operator preference,
   * fall back to the source default". The resolver checks compatibility
   * against the asset's source via utils/pollingCompatibility and silently
   * skips an incompatible value (e.g. an integration tier with REST API
   * doesn't apply to an Active Directory asset since AD can't speak REST API).
   */
  responseTimePolling:       PollingMethod | null;
  cpuMemoryPolling:          PollingMethod | null;
  temperaturePolling:        PollingMethod | null;
  interfacesPolling:         PollingMethod | null;
  lldpPolling:               PollingMethod | null;
  processesPolling:          PollingMethod | null;
  eventLogPolling:           PollingMethod | null;
  /**
   * Storage stream — SNMP-only when enabled (HOST-RESOURCES-MIB hrStorageTable
   * plus vendor disk fallbacks). Independent of `interfacesPolling` so
   * operators can disable storage on FMG/FortiGate firewalls (which don't
   * expose meaningful mountpoints) without losing interface scrapes. Source
   * defaults: FMG/FortiGate → "disabled"; every other source → null (= not
   * delivered). Operators opt in by picking SNMP at any tier.
   */
  storagePolling:            PollingMethod | null;
  /**
   * Per-stream MIB identifier hint. Either `"std:<key>"` referencing a
   * built-in standard MIB (used by the asset-detail SNMP Walk tab UI for
   * symbol resolution; ignored by the telemetry collector), or the UUID of
   * an uploaded MibFile row. null at any tier = inherit from below.
   *
   * Consumed by `collectCpuMemorySnmp` / `collectTemperatureSnmp` to override
   * vendor-profile selection when an uploaded MIB is set — useful for assets
   * whose `manufacturer + model` would otherwise fall into the wrong profile
   * (the canonical case being FortiSwitches that pre-Phase-4d landed under
   * the generic Fortinet profile and queried FortiGate-only OIDs).
   */
  responseTimeMibId:         string | null;
  cpuMemoryMibId:            string | null;
  temperatureMibId:          string | null;
  interfacesMibId:           string | null;
  lldpMibId:                 string | null;
  processesMibId:            string | null;
  /**
   * Per-stream Credential FK ids. Only the class-override tier (tier-2) stores
   * these — tier-3 (integration / manual) keeps its credential out-of-band on
   * `Integration.config.monitorCredentialId`, and tier-1 (per-asset) goes
   * through Prisma `include` on the asset row. Resolved value reflects the
   * class override; dispatchers check resolved-vs-per-asset to pick the
   * credential record actually used at probe time.
   */
  responseTimeCredentialId:  string | null;
  cpuMemoryCredentialId:     string | null;
  temperatureCredentialId:   string | null;
  interfacesCredentialId:    string | null;
  lldpCredentialId:          string | null;
  processesCredentialId:     string | null;
  eventLogCredentialId:      string | null;
}

export type MonitorOverrideSettings = Partial<MonitorTierSettings>;

/** Final per-asset shape after the resolver walks all four tiers. */
export type ResolvedMonitorSettings = MonitorTierSettings;

/**
 * Hardcoded floor — final fallback when the integration / manual tier hasn't
 * been seeded yet (e.g. fresh install before the migration job runs, or an
 * orphan asset and no operator has touched the manual tier). Operators never
 * see this value in any UI; it just keeps the system running.
 */
const HARDCODED_FLOOR: MonitorTierSettings = {
  intervalSeconds:           60,
  failureThreshold:          3,
  probeTimeoutMs:            5000,
  cpuMemoryTimeoutMs:        10_000,
  temperatureTimeoutMs:      10_000,
  systemInfoTimeoutMs:       10_000,
  cpuMemoryIntervalSeconds:  60,
  temperatureIntervalSeconds: 60,
  systemInfoIntervalSeconds: 600,
  // Phase 2: LLDP + Storage default to the same baseline as systemInfo so
  // existing fleets see no behavior change at the floor; operators can
  // tune each independently from the per-class subtabs.
  lldpIntervalSeconds:       600,
  lldpTimeoutMs:             10_000,
  storageIntervalSeconds:    600,
  storageTimeoutMs:          10_000,
  // Cross-transport streams default to the system-info baseline cadence at the
  // floor. They resolve to "disabled" until an operator opts in at some tier,
  // so the cadence only matters once a method is selected.
  processesIntervalSeconds:  600,
  processesTimeoutMs:        10_000,
  eventLogIntervalSeconds:   600,
  eventLogTimeoutMs:         10_000,
  sampleRetentionDays:       30,
  telemetryRetentionDays:    30,
  systemInfoRetentionDays:   30,
  // Polling fields default to null at every tier. Source-aware defaults
  // (FMG/FortiGate -> rest_api, AD/Entra/Win -> icmp, manual -> icmp for
  // responseTime + null for the other streams) are applied by the resolver
  // via defaultPollingForSource().
  responseTimePolling:       null,
  cpuMemoryPolling:          null,
  temperaturePolling:        null,
  interfacesPolling:         null,
  lldpPolling:               null,
  storagePolling:            null,
  processesPolling:          null,
  eventLogPolling:           null,
  // MIB ID hints default to null at the floor — vendor profile selection
  // uses the asset's own manufacturer/model when no tier supplies a MIB.
  responseTimeMibId:         null,
  cpuMemoryMibId:            null,
  temperatureMibId:          null,
  interfacesMibId:           null,
  lldpMibId:                 null,
  processesMibId:            null,
  // Per-stream credential IDs only exist on the class-override tier; tier-3
  // and the floor always carry null and dispatchers fall through.
  responseTimeCredentialId:  null,
  cpuMemoryCredentialId:     null,
  temperatureCredentialId:   null,
  interfacesCredentialId:    null,
  lldpCredentialId:          null,
  processesCredentialId:     null,
  eventLogCredentialId:      null,
};

// ─── Legacy global-tier types (transitional, scheduled for removal) ────────
//
// The old single-row `monitorSettings` Setting + per-class switch/accessPoint
// blocks (formerly named fortiswitch/fortiap — see the renameMonitorClassKeys
// startup job for the JSON-key migration). Kept alive temporarily so the
// prune helpers and capacityService continue working while the multi-tier
// retention work seeds new shapes. After the legacy row is fully decoupled
// these types get removed in a follow-up pass.

/** @deprecated use MonitorTierSettings */
export interface MonitorClassSettings {
  intervalSeconds:           number;
  failureThreshold:          number;
  probeTimeoutMs:            number;
  sampleRetentionDays:       number;
  telemetryIntervalSeconds:  number;
  systemInfoIntervalSeconds: number;
  telemetryRetentionDays:    number;
  systemInfoRetentionDays:   number;
}

/** @deprecated legacy storage shape; new code uses MonitorTierSettings */
export interface MonitorSettings extends MonitorClassSettings {
  switch:      MonitorClassSettings;
  accessPoint: MonitorClassSettings;
}

const SETTING_KEY = "monitorSettings";
const MANUAL_SETTING_KEY = "manualMonitorSettings";

// Legacy default shape — maps the new stream-split floor back to the
// pre-split `telemetryIntervalSeconds` field name that the deprecated
// MonitorClassSettings + MonitorSettings types still expose. Used only by
// the transitional legacy-row fallback path (loadLegacyGlobalAsTier +
// capacityService); new code reads HARDCODED_FLOOR directly.
const DEFAULT_CLASS_SETTINGS: MonitorClassSettings = {
  intervalSeconds:           HARDCODED_FLOOR.intervalSeconds,
  failureThreshold:          HARDCODED_FLOOR.failureThreshold,
  probeTimeoutMs:            HARDCODED_FLOOR.probeTimeoutMs,
  sampleRetentionDays:       HARDCODED_FLOOR.sampleRetentionDays,
  telemetryIntervalSeconds:  HARDCODED_FLOOR.cpuMemoryIntervalSeconds,
  systemInfoIntervalSeconds: HARDCODED_FLOOR.systemInfoIntervalSeconds,
  telemetryRetentionDays:    HARDCODED_FLOOR.telemetryRetentionDays,
  systemInfoRetentionDays:   HARDCODED_FLOOR.systemInfoRetentionDays,
};

const DEFAULT_SETTINGS: MonitorSettings = {
  ...DEFAULT_CLASS_SETTINGS,
  switch:      { ...DEFAULT_CLASS_SETTINGS },
  accessPoint: { ...DEFAULT_CLASS_SETTINGS },
};

const sysUpTimeOid = "1.3.6.1.2.1.1.3.0";

// Per-request timeout for SNMP sessions / FortiOS REST calls inside the
// HEAVY-cadence collectors (collectTelemetry / collectSystemInfo / SNMP walks).
// These walks issue many requests and we want each individual request to fail
// fast on a wedged peer rather than burn the entire walk budget on one OID.
//
// NOT used by the response-time probes — those resolve their timeout through
// `resolveMonitorSettings(asset).probeTimeoutMs` per asset (default 5000ms,
// range 100..60000) and pass it down via the `timeoutMs` argument on every
// probe function.
const COLLECTOR_REQUEST_TIMEOUT_MS = 10_000;

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

function readClassFromJson(v: Record<string, unknown> | undefined, defaults: MonitorClassSettings): MonitorClassSettings {
  const o = v ?? {};
  return {
    intervalSeconds:           toPositiveInt(o.intervalSeconds,           defaults.intervalSeconds),
    failureThreshold:          toPositiveInt(o.failureThreshold,          defaults.failureThreshold),
    probeTimeoutMs:            toPositiveInt(o.probeTimeoutMs,            defaults.probeTimeoutMs),
    sampleRetentionDays:       toPositiveInt(o.sampleRetentionDays,       defaults.sampleRetentionDays),
    telemetryIntervalSeconds:  toPositiveInt(o.telemetryIntervalSeconds,  defaults.telemetryIntervalSeconds),
    systemInfoIntervalSeconds: toPositiveInt(o.systemInfoIntervalSeconds, defaults.systemInfoIntervalSeconds),
    telemetryRetentionDays:    toPositiveInt(o.telemetryRetentionDays,    defaults.telemetryRetentionDays),
    systemInfoRetentionDays:   toPositiveInt(o.systemInfoRetentionDays,   defaults.systemInfoRetentionDays),
  };
}

export async function getMonitorSettings(): Promise<MonitorSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const v = (row?.value as Record<string, unknown> | null) ?? {};
  // Top-level fields are the baseline default for every class group too —
  // a fresh install with no per-class entries inherits the operator's
  // top-level values, not the hard-coded constants.
  const base = readClassFromJson(v, DEFAULT_CLASS_SETTINGS);
  // Per-class overrides: prefer the new switch/accessPoint keys; fall back
  // to the legacy fortiswitch/fortiap keys until renameMonitorClassKeys
  // (one-shot startup job) rewrites them. After fleet-wide migration this
  // fallback can go.
  const swRaw = (v.switch      as Record<string, unknown> | undefined)
             ?? (v.fortiswitch as Record<string, unknown> | undefined)
             ?? undefined;
  const apRaw = (v.accessPoint as Record<string, unknown> | undefined)
             ?? (v.fortiap     as Record<string, unknown> | undefined)
             ?? undefined;
  return {
    ...base,
    switch:      readClassFromJson(swRaw, base),
    accessPoint: readClassFromJson(apRaw, base),
  };
}

function mergeClassUpdate(current: MonitorClassSettings, input: Partial<MonitorClassSettings> | undefined): MonitorClassSettings {
  if (!input) return current;
  const pick = (v: unknown, fallback: number): number => v != null ? toPositiveInt(v, fallback) : fallback;
  return {
    intervalSeconds:           pick(input.intervalSeconds,           current.intervalSeconds),
    failureThreshold:          pick(input.failureThreshold,          current.failureThreshold),
    probeTimeoutMs:            pick(input.probeTimeoutMs,            current.probeTimeoutMs),
    sampleRetentionDays:       pick(input.sampleRetentionDays,       current.sampleRetentionDays),
    telemetryIntervalSeconds:  pick(input.telemetryIntervalSeconds,  current.telemetryIntervalSeconds),
    systemInfoIntervalSeconds: pick(input.systemInfoIntervalSeconds, current.systemInfoIntervalSeconds),
    telemetryRetentionDays:    pick(input.telemetryRetentionDays,    current.telemetryRetentionDays),
    systemInfoRetentionDays:   pick(input.systemInfoRetentionDays,   current.systemInfoRetentionDays),
  };
}

export type MonitorSettingsUpdateInput = Partial<MonitorClassSettings> & {
  switch?:      Partial<MonitorClassSettings>;
  accessPoint?: Partial<MonitorClassSettings>;
};

export async function updateMonitorSettings(input: MonitorSettingsUpdateInput): Promise<MonitorSettings> {
  const current = await getMonitorSettings();
  // Top-level values are written directly at the JSON root for backward compat
  // with the existing API consumers.
  const baseUpdate: Partial<MonitorClassSettings> = {
    intervalSeconds:           input.intervalSeconds,
    failureThreshold:          input.failureThreshold,
    probeTimeoutMs:            input.probeTimeoutMs,
    sampleRetentionDays:       input.sampleRetentionDays,
    telemetryIntervalSeconds:  input.telemetryIntervalSeconds,
    systemInfoIntervalSeconds: input.systemInfoIntervalSeconds,
    telemetryRetentionDays:    input.telemetryRetentionDays,
    systemInfoRetentionDays:   input.systemInfoRetentionDays,
  };
  const base = mergeClassUpdate(current, baseUpdate);
  const next: MonitorSettings = {
    ...base,
    switch:      mergeClassUpdate(current.switch,      input.switch),
    accessPoint: mergeClassUpdate(current.accessPoint, input.accessPoint),
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

// ─── Monitor settings resolver ──────────────────────────────────────────────
//
// `resolveMonitorSettings(asset)` is the runtime entry point that walks the
// hierarchy and returns the effective settings for one asset. Tier-3 readers
// (`loadIntegrationTierSettings` / `loadManualTierSettings`) and the class
// override loader memoize their results in module-local Maps, so the hot
// monitor loop can resolve hundreds of assets per pass with only one DB hit
// per (integration/manual) tuple plus one per (tier, assetType) pair.
//
// Cache invalidation is the responsibility of any code that writes to the
// underlying storage — call `invalidateMonitorSettingsCache(scope)` after
// upserting an Integration.config.monitorSettings, the manualMonitorSettings
// row, or a MonitorClassOverride row. The migration job (step 5) calls
// `invalidateMonitorSettingsCache()` (no scope = full clear) at the end.
//
// Transitional fallback: when the new tier rows aren't seeded yet (i.e. the
// migration job hasn't run), `loadLegacyGlobalAsTier` reads the old
// `monitorSettings` Setting row and projects it into a tier-shaped value.
// Once the migration has run + deleted that row, the loaders fall through to
// HARDCODED_FLOOR for the brief window where a fresh integration has no
// monitor settings yet (operators set them as needed via the new routes).

const MANUAL_TIER_CACHE_KEY = "__manual__";
const tierCache = new Map<string, MonitorTierSettings>();
const classOverrideCache = new Map<string, MonitorOverrideSettings | null>();
// Sidecar: did the cached integration tier-3 derive systemInfoIntervalSeconds
// from Integration.pollInterval (true) or read it from an explicit tier-3
// JSON value (false)? Drives the "integrationPollInterval" provenance label
// in resolveMonitorSettingsWithProvenance so the UI can render
// `Inherit: 14400s (4h, from <integration> discovery cycle)` instead of a
// generic integration-tier badge. Manual-tier rows are not eligible (no
// pollInterval to inherit from).
const tierSystemInfoFromPollIntervalCache = new Map<string, boolean>();

function classCacheKey(integrationId: string | null, assetType: string): string {
  return `${integrationId ?? MANUAL_TIER_CACHE_KEY}:${assetType}`;
}

/**
 * Drop cached resolver state. Call this whenever the underlying storage
 * changes (integration save, manual-tier save, class-override CRUD,
 * migration job). Without a scope, clears everything.
 */
export function invalidateMonitorSettingsCache(scope?: {
  integrationId?: string | null;
  assetType?: string;
}): void {
  if (!scope) {
    tierCache.clear();
    classOverrideCache.clear();
    tierSystemInfoFromPollIntervalCache.clear();
    return;
  }
  const tierKey = scope.integrationId === null ? MANUAL_TIER_CACHE_KEY : scope.integrationId;
  if (tierKey != null) {
    if (tierKey === MANUAL_TIER_CACHE_KEY) {
      // Manual tier is a single cached entry (no per-class branches), so the
      // legacy key clear still works.
      tierCache.delete(MANUAL_TIER_CACHE_KEY);
      tierSystemInfoFromPollIntervalCache.delete(MANUAL_TIER_CACHE_KEY);
    } else if (scope.assetType) {
      // Per-class evict — Phase 2 cache key is `${integrationId}:${assetType}`.
      const k = `${tierKey}:${scope.assetType}`;
      tierCache.delete(k);
      tierSystemInfoFromPollIntervalCache.delete(k);
    } else {
      // Whole-integration evict — walk every `<integrationId>:<assetType>`
      // entry. Integration config writes (PUT /integrations/:id, per-class
      // streams edits) hit this path so every assetType variant refreshes.
      for (const k of Array.from(tierCache.keys())) {
        if (k.startsWith(`${tierKey}:`)) {
          tierCache.delete(k);
          tierSystemInfoFromPollIntervalCache.delete(k);
        }
      }
    }
    if (scope.assetType) {
      classOverrideCache.delete(`${tierKey}:${scope.assetType}`);
    } else {
      for (const k of Array.from(classOverrideCache.keys())) {
        if (k.startsWith(`${tierKey}:`)) classOverrideCache.delete(k);
      }
    }
  } else {
    // No tier identified — fall back to a full class-cache clear.
    classOverrideCache.clear();
  }
}

function readPollingFromJson(v: Record<string, unknown> | undefined, key: string): PollingMethod | null {
  if (!v) return null;
  const raw = v[key];
  return isPollingMethod(raw) ? raw : null;
}

function tierFromJson(v: Record<string, unknown> | null | undefined): MonitorTierSettings {
  const o = v ?? {};
  // Per-stream polling may be stored in one of two shapes depending on which
  // code path wrote it:
  //   nested (original design): { polling: { responseTime, telemetry, interfaces, lldp } }
  //   flat   (route writes):    { responseTimePolling, telemetryPolling, ... }
  // Try nested first; fall back to the flat key so both formats work.
  const pollingBlock = (o.polling as Record<string, unknown> | undefined) ?? undefined;
  const flat = o as Record<string, unknown>;
  // Stream-split migration compatibility: tier-3 JSON written before the
  // split carried `telemetryIntervalSeconds` / `telemetryTimeoutMs` /
  // `telemetryPolling` / `telemetryMibId`. The migration SQL rewrites those
  // keys in-place, but a fresh install booting against an older row (e.g.
  // recovery / replay) needs the fallback so existing operator selections
  // carry forward identically.
  const legacyInterval = toPositiveIntOr(o.telemetryIntervalSeconds, null);
  const legacyTimeout  = toPositiveIntOr(o.telemetryTimeoutMs,        null);
  return {
    intervalSeconds:            toPositiveInt(o.intervalSeconds,           HARDCODED_FLOOR.intervalSeconds),
    failureThreshold:           toPositiveInt(o.failureThreshold,          HARDCODED_FLOOR.failureThreshold),
    probeTimeoutMs:             toPositiveInt(o.probeTimeoutMs,            HARDCODED_FLOOR.probeTimeoutMs),
    cpuMemoryTimeoutMs:         toPositiveInt(o.cpuMemoryTimeoutMs,        legacyTimeout  ?? HARDCODED_FLOOR.cpuMemoryTimeoutMs),
    temperatureTimeoutMs:       toPositiveInt(o.temperatureTimeoutMs,      legacyTimeout  ?? HARDCODED_FLOOR.temperatureTimeoutMs),
    systemInfoTimeoutMs:        toPositiveInt(o.systemInfoTimeoutMs,       HARDCODED_FLOOR.systemInfoTimeoutMs),
    cpuMemoryIntervalSeconds:   toPositiveInt(o.cpuMemoryIntervalSeconds,  legacyInterval ?? HARDCODED_FLOOR.cpuMemoryIntervalSeconds),
    temperatureIntervalSeconds: toPositiveInt(o.temperatureIntervalSeconds, legacyInterval ?? HARDCODED_FLOOR.temperatureIntervalSeconds),
    systemInfoIntervalSeconds:  toPositiveInt(o.systemInfoIntervalSeconds, HARDCODED_FLOOR.systemInfoIntervalSeconds),
    // Phase 1 wrote lldpIntervalSeconds / lldpTimeoutMs / storageIntervalSeconds
    // / storageTimeoutMs as additive flat keys on the integration-tier JSON
    // before the per-class streams blocks existed. Continue to read them here
    // as the integration-tier default; per-class streams entries override at
    // dispatch time via loadIntegrationTierSettings(.., assetType).
    lldpIntervalSeconds:        toPositiveInt(o.lldpIntervalSeconds,       HARDCODED_FLOOR.lldpIntervalSeconds),
    lldpTimeoutMs:              toPositiveInt(o.lldpTimeoutMs,             HARDCODED_FLOOR.lldpTimeoutMs),
    storageIntervalSeconds:     toPositiveInt(o.storageIntervalSeconds,    HARDCODED_FLOOR.storageIntervalSeconds),
    storageTimeoutMs:           toPositiveInt(o.storageTimeoutMs,          HARDCODED_FLOOR.storageTimeoutMs),
    processesIntervalSeconds:   toPositiveInt(o.processesIntervalSeconds,  HARDCODED_FLOOR.processesIntervalSeconds),
    processesTimeoutMs:         toPositiveInt(o.processesTimeoutMs,        HARDCODED_FLOOR.processesTimeoutMs),
    eventLogIntervalSeconds:    toPositiveInt(o.eventLogIntervalSeconds,   HARDCODED_FLOOR.eventLogIntervalSeconds),
    eventLogTimeoutMs:          toPositiveInt(o.eventLogTimeoutMs,         HARDCODED_FLOOR.eventLogTimeoutMs),
    sampleRetentionDays:        toPositiveInt(o.sampleRetentionDays,       HARDCODED_FLOOR.sampleRetentionDays),
    telemetryRetentionDays:     toPositiveInt(o.telemetryRetentionDays,    HARDCODED_FLOOR.telemetryRetentionDays),
    systemInfoRetentionDays:    toPositiveInt(o.systemInfoRetentionDays,   HARDCODED_FLOOR.systemInfoRetentionDays),
    responseTimePolling:        readPollingFromJson(pollingBlock, "responseTime") ?? readPollingFromJson(flat, "responseTimePolling"),
    cpuMemoryPolling:           readPollingFromJson(pollingBlock, "cpuMemory")    ?? readPollingFromJson(flat, "cpuMemoryPolling")    ?? readPollingFromJson(pollingBlock, "telemetry") ?? readPollingFromJson(flat, "telemetryPolling"),
    temperaturePolling:         readPollingFromJson(pollingBlock, "temperature")  ?? readPollingFromJson(flat, "temperaturePolling")  ?? readPollingFromJson(pollingBlock, "telemetry") ?? readPollingFromJson(flat, "telemetryPolling"),
    interfacesPolling:          readPollingFromJson(pollingBlock, "interfaces")   ?? readPollingFromJson(flat, "interfacesPolling"),
    lldpPolling:                readPollingFromJson(pollingBlock, "lldp")         ?? readPollingFromJson(flat, "lldpPolling"),
    storagePolling:             readPollingFromJson(pollingBlock, "storage")      ?? readPollingFromJson(flat, "storagePolling"),
    processesPolling:           readPollingFromJson(pollingBlock, "processes")    ?? readPollingFromJson(flat, "processesPolling"),
    eventLogPolling:            readPollingFromJson(pollingBlock, "eventLog")     ?? readPollingFromJson(flat, "eventLogPolling"),
    responseTimeMibId:          readMibIdFromJson(flat.responseTimeMibId),
    cpuMemoryMibId:             readMibIdFromJson(flat.cpuMemoryMibId)   ?? readMibIdFromJson(flat.telemetryMibId),
    temperatureMibId:           readMibIdFromJson(flat.temperatureMibId) ?? readMibIdFromJson(flat.telemetryMibId),
    interfacesMibId:            readMibIdFromJson(flat.interfacesMibId),
    lldpMibId:                  readMibIdFromJson(flat.lldpMibId),
    processesMibId:             readMibIdFromJson(flat.processesMibId),
    // Tier-3 storage doesn't carry per-stream credentials — they only live
    // on the class-override row (tier-2). Always null here; loadClassOverride
    // surfaces the real values, and resolveMonitorSettings merges them onto
    // the final resolved object.
    responseTimeCredentialId:   null,
    cpuMemoryCredentialId:      null,
    temperatureCredentialId:    null,
    interfacesCredentialId:     null,
    lldpCredentialId:           null,
    processesCredentialId:      null,
    eventLogCredentialId:       null,
  };
}

// Like toPositiveInt but returns the fallback as-is (including null) when
// the input isn't a positive integer. Used by the stream-split tierFromJson
// to chain legacy-key fallback before defaulting to the hardcoded floor.
function toPositiveIntOr(v: unknown, fallback: number | null): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.trunc(v);
  return fallback;
}

function readMibIdFromJson(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/**
 * Source-default polling method per stream. Used when no tier (integration,
 * class, asset) supplies a value and we need *something* to start with.
 *
 * - FMG / FortiGate: REST API for every stream — the integration's stored
 *   API token covers all four.
 * - AD / Entra / Windows Server: only the response-time stream is supported
 *   on these hosts, and ICMP is the safest "everything works" baseline. The
 *   other three streams default to null so the System tab politely says
 *   "not delivered for this asset".
 * - Manual: ICMP for response-time only — operator must explicitly pick a
 *   credentialed method (and a credential) to enable telemetry/interfaces
 *   on a manually-created asset.
 */
function defaultPollingForSource(
  source: AssetSourceKind,
  stream: Stream,
): PollingMethod | null {
  // Cross-transport streams default to "disabled" everywhere — they're opt-in
  // (operator picks agent / SNMP / SSH / WinRM, or REST for eventLog on a
  // FortiGate). Keeping them off by default means no behavior change for
  // existing fleets until an operator turns them on at some tier.
  if (stream === "processes" || stream === "eventLog") return "disabled";
  if (source === "fortimanager" || source === "fortigate") {
    // FortiOS exposes lldp-neighbors but most fleets don't enable LLDP per
    // interface, so the endpoint returns nothing on every probe. Default
    // off; operators flip to rest_api when their fleet actually has it.
    if (stream === "lldp") return "disabled";
    // FortiOS appliances don't expose meaningful mountable storage; default
    // off so the SNMP storage walk doesn't run wasted scrapes against every
    // FortiGate / FortiSwitch / FortiAP. Operators opt in by picking SNMP.
    if (stream === "storage") return "disabled";
    // Response Time is the cheapest probe — ICMP is the universal default
    // for routable devices. CPU/mem/interfaces/temperature still default to
    // REST API because that's where the data actually is.
    if (stream === "responseTime") return "icmp";
    return "rest_api";
  }
  if (source === "activedirectory" || source === "entraid" || source === "windowsserver") {
    return stream === "responseTime" ? "icmp" : null;
  }
  // manual
  return stream === "responseTime" ? "icmp" : null;
}

async function loadLegacyGlobalAsTier(): Promise<MonitorTierSettings | null> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row?.value) return null;
  return tierFromJson(row.value as Record<string, unknown>);
}

/**
 * Picks the per-class streams block on the integration config for the given
 * assetType. FMG / FortiGate route firewall→fortigateMonitor, switch→
 * fortiswitchMonitor, access_point→fortiapMonitor; AD / Entra / Windows
 * Server route workstation→workstationMonitor, server→serverMonitor. Every
 * other (assetType, integration-type) pair returns undefined so the resolver
 * falls back to the flat `monitorSettings` JSON for that asset class.
 */
function pickClassStreamsBlock(
  integrationType: string | null,
  cfg: Record<string, unknown>,
  assetType: string,
): Record<string, unknown> | undefined {
  if (integrationType === "fortimanager" || integrationType === "fortigate") {
    let block: Record<string, unknown> | undefined;
    if (assetType === "firewall")          block = cfg.fortigateMonitor   as Record<string, unknown> | undefined;
    else if (assetType === "switch")       block = cfg.fortiswitchMonitor as Record<string, unknown> | undefined;
    else if (assetType === "access_point") block = cfg.fortiapMonitor     as Record<string, unknown> | undefined;
    if (!block) return undefined;
    const streams = block.streams as Record<string, unknown> | undefined;
    return streams && typeof streams === "object" ? streams : undefined;
  }
  if (integrationType === "activedirectory" || integrationType === "entraid" || integrationType === "windowsserver") {
    let block: Record<string, unknown> | undefined;
    if (assetType === "workstation") block = cfg.workstationMonitor as Record<string, unknown> | undefined;
    else if (assetType === "server")  block = cfg.serverMonitor      as Record<string, unknown> | undefined;
    if (!block) return undefined;
    const streams = block.streams as Record<string, unknown> | undefined;
    return streams && typeof streams === "object" ? streams : undefined;
  }
  return undefined;
}

/**
 * Overlay a per-class streams block onto a tier-3 baseline. Each stream
 * carries up to 6 fields (polling / credentialId / intervalSeconds /
 * timeoutMs / failureThreshold / mibId); non-null values win over the
 * baseline, null/undefined leaves the baseline in place. Mutates `base`
 * in place and returns it for chaining convenience.
 */
function applyClassStreamsOverlay(
  base: MonitorTierSettings,
  streams: Record<string, unknown> | undefined,
): MonitorTierSettings {
  if (!streams) return base;
  type StreamKey = "responseTime" | "cpuMemory" | "temperature" | "interfaces" | "lldp" | "storage" | "processes" | "eventLog";
  type StreamCells = {
    pollingField:        keyof MonitorTierSettings;
    credentialField:     keyof MonitorTierSettings;
    intervalField:       keyof MonitorTierSettings;
    timeoutField:        keyof MonitorTierSettings;
    mibField?:           keyof MonitorTierSettings;
    acceptsFailureField?: boolean;
  };
  const map: Record<StreamKey, StreamCells> = {
    responseTime: { pollingField: "responseTimePolling", credentialField: "responseTimeCredentialId", intervalField: "intervalSeconds",            timeoutField: "probeTimeoutMs",        mibField: "responseTimeMibId", acceptsFailureField: true },
    cpuMemory:    { pollingField: "cpuMemoryPolling",    credentialField: "cpuMemoryCredentialId",    intervalField: "cpuMemoryIntervalSeconds",   timeoutField: "cpuMemoryTimeoutMs",    mibField: "cpuMemoryMibId" },
    temperature:  { pollingField: "temperaturePolling",  credentialField: "temperatureCredentialId",  intervalField: "temperatureIntervalSeconds", timeoutField: "temperatureTimeoutMs",  mibField: "temperatureMibId" },
    interfaces:   { pollingField: "interfacesPolling",   credentialField: "interfacesCredentialId",   intervalField: "systemInfoIntervalSeconds",  timeoutField: "systemInfoTimeoutMs",   mibField: "interfacesMibId" },
    lldp:         { pollingField: "lldpPolling",         credentialField: "lldpCredentialId",         intervalField: "lldpIntervalSeconds",        timeoutField: "lldpTimeoutMs",         mibField: "lldpMibId" },
    storage:      { pollingField: "storagePolling",      credentialField: "interfacesCredentialId",   intervalField: "storageIntervalSeconds",     timeoutField: "storageTimeoutMs" },
    processes:    { pollingField: "processesPolling",    credentialField: "processesCredentialId",    intervalField: "processesIntervalSeconds",   timeoutField: "processesTimeoutMs",    mibField: "processesMibId" },
    eventLog:     { pollingField: "eventLogPolling",     credentialField: "eventLogCredentialId",     intervalField: "eventLogIntervalSeconds",    timeoutField: "eventLogTimeoutMs" },
  };
  for (const key of Object.keys(map) as StreamKey[]) {
    const stream = streams[key] as Record<string, unknown> | null | undefined;
    if (!stream || typeof stream !== "object") continue;
    const cells = map[key];
    if ("polling" in stream && isPollingMethod(stream.polling)) {
      (base as any)[cells.pollingField] = stream.polling;
    }
    if ("credentialId" in stream && typeof stream.credentialId === "string" && stream.credentialId.length > 0) {
      (base as any)[cells.credentialField] = stream.credentialId;
    }
    if ("intervalSeconds" in stream && typeof stream.intervalSeconds === "number" && stream.intervalSeconds > 0) {
      (base as any)[cells.intervalField] = stream.intervalSeconds;
    }
    if ("timeoutMs" in stream && typeof stream.timeoutMs === "number" && stream.timeoutMs > 0) {
      (base as any)[cells.timeoutField] = stream.timeoutMs;
    }
    if (cells.mibField && "mibId" in stream && typeof stream.mibId === "string" && stream.mibId.length > 0) {
      (base as any)[cells.mibField] = stream.mibId;
    }
    if (cells.acceptsFailureField && "failureThreshold" in stream && typeof stream.failureThreshold === "number" && stream.failureThreshold > 0) {
      base.failureThreshold = stream.failureThreshold;
    }
  }
  return base;
}

/**
 * Walk a per-class streams block and report which MonitorTierSettings fields
 * the block actually populates. Used by resolveMonitorSettingsWithProvenance
 * to label per-class-contributed fields as "integration-class" provenance.
 * Returns a partial map (field → true) — fields the block left null/missing
 * are absent from the result.
 */
function detectPerClassFieldOrigins(
  streams: Record<string, unknown>,
): Partial<Record<keyof MonitorTierSettings, true>> {
  const out: Partial<Record<keyof MonitorTierSettings, true>> = {};
  type StreamKey = "responseTime" | "cpuMemory" | "temperature" | "interfaces" | "lldp" | "storage" | "processes" | "eventLog";
  type StreamCellMap = {
    polling?:         keyof MonitorTierSettings;
    credentialId?:    keyof MonitorTierSettings;
    intervalSeconds?: keyof MonitorTierSettings;
    timeoutMs?:       keyof MonitorTierSettings;
    failureThreshold?: keyof MonitorTierSettings;
    mibId?:           keyof MonitorTierSettings;
  };
  const map: Record<StreamKey, StreamCellMap> = {
    responseTime: { polling: "responseTimePolling", credentialId: "responseTimeCredentialId", intervalSeconds: "intervalSeconds",            timeoutMs: "probeTimeoutMs",        failureThreshold: "failureThreshold", mibId: "responseTimeMibId" },
    cpuMemory:    { polling: "cpuMemoryPolling",    credentialId: "cpuMemoryCredentialId",    intervalSeconds: "cpuMemoryIntervalSeconds",   timeoutMs: "cpuMemoryTimeoutMs",                                       mibId: "cpuMemoryMibId" },
    temperature:  { polling: "temperaturePolling",  credentialId: "temperatureCredentialId",  intervalSeconds: "temperatureIntervalSeconds", timeoutMs: "temperatureTimeoutMs",                                     mibId: "temperatureMibId" },
    interfaces:   { polling: "interfacesPolling",   credentialId: "interfacesCredentialId",   intervalSeconds: "systemInfoIntervalSeconds",  timeoutMs: "systemInfoTimeoutMs",                                      mibId: "interfacesMibId" },
    lldp:         { polling: "lldpPolling",         credentialId: "lldpCredentialId",         intervalSeconds: "lldpIntervalSeconds",        timeoutMs: "lldpTimeoutMs",                                            mibId: "lldpMibId" },
    storage:      { polling: "storagePolling",      credentialId: "interfacesCredentialId",   intervalSeconds: "storageIntervalSeconds",     timeoutMs: "storageTimeoutMs" },
    processes:    { polling: "processesPolling",    credentialId: "processesCredentialId",    intervalSeconds: "processesIntervalSeconds",   timeoutMs: "processesTimeoutMs",                                       mibId: "processesMibId" },
    eventLog:     { polling: "eventLogPolling",     credentialId: "eventLogCredentialId",     intervalSeconds: "eventLogIntervalSeconds",    timeoutMs: "eventLogTimeoutMs" },
  };
  for (const key of Object.keys(map) as StreamKey[]) {
    const stream = streams[key] as Record<string, unknown> | null | undefined;
    if (!stream || typeof stream !== "object") continue;
    const cells = map[key];
    if (cells.polling          && "polling"          in stream && isPollingMethod(stream.polling))                                       out[cells.polling]          = true;
    if (cells.credentialId     && "credentialId"     in stream && typeof stream.credentialId === "string" && stream.credentialId.length) out[cells.credentialId]     = true;
    if (cells.intervalSeconds  && "intervalSeconds"  in stream && typeof stream.intervalSeconds === "number" && stream.intervalSeconds > 0) out[cells.intervalSeconds] = true;
    if (cells.timeoutMs        && "timeoutMs"        in stream && typeof stream.timeoutMs === "number" && stream.timeoutMs > 0)         out[cells.timeoutMs]        = true;
    if (cells.failureThreshold && "failureThreshold" in stream && typeof stream.failureThreshold === "number" && stream.failureThreshold > 0) out[cells.failureThreshold] = true;
    if (cells.mibId            && "mibId"            in stream && typeof stream.mibId === "string" && stream.mibId.length)             out[cells.mibId]            = true;
  }
  return out;
}

/**
 * Tier-3 loader. `assetType` selects which per-class streams block applies
 * on top of the flat `monitorSettings` baseline:
 *   - fortimanager / fortigate: firewall→fortigateMonitor.streams,
 *     switch→fortiswitchMonitor.streams, access_point→fortiapMonitor.streams.
 *     Other asset types (endpoint workstation / server / printer / router /
 *     other discovered via FortiGate DHCP) fall back to the flat baseline.
 *   - activedirectory / entraid / windowsserver: workstation→
 *     workstationMonitor.streams, server→serverMonitor.streams. Other types
 *     fall back to the flat baseline.
 *   - any other integration type: flat baseline only.
 * Cached keyed on `${integrationId}:${assetType}` so each (integration, class)
 * pair is computed at most once per process lifetime; writes route through
 * invalidateMonitorSettingsCache.
 */
async function loadIntegrationTierSettings(integrationId: string, assetType: string): Promise<MonitorTierSettings> {
  const cacheKey = `${integrationId}:${assetType}`;
  const cached = tierCache.get(cacheKey);
  if (cached) return cached;
  const integration = await prisma.integration.findUnique({
    where:  { id: integrationId },
    select: { config: true, pollInterval: true, type: true },
  });
  const cfg = (integration?.config as Record<string, unknown> | null) ?? {};
  const ms  = cfg.monitorSettings as Record<string, unknown> | undefined;
  let result: MonitorTierSettings;
  if (ms) {
    result = tierFromJson(ms);
  } else {
    // Transitional: fall back to the legacy global until the migration runs.
    result = (await loadLegacyGlobalAsTier()) ?? { ...HARDCODED_FLOOR };
  }
  // Per-class streams overlay. Phase 2: when the integration config carries a
  // class-specific streams block for this asset's assetType, its per-stream
  // values win over the flat baseline.
  const classStreams = pickClassStreamsBlock(integration?.type ?? null, cfg, assetType);
  applyClassStreamsOverlay(result, classStreams);
  // systemInfo cadence linkage: when the integration tier doesn't explicitly
  // set systemInfoIntervalSeconds, derive it from the integration's discovery
  // pollInterval. Keeps interface / LLDP / storage / IPsec collection on the
  // same schedule as discovery, slashing interface-sample volume by 24× at
  // the default 4h pollInterval. Explicit class / per-asset overrides still
  // win — this only affects the tier-3 baseline.
  //   - ms missing                → derive (tier-3 not yet seeded)
  //   - ms.systemInfoIntervalSeconds is number > 0  → respect operator value
  //   - ms.systemInfoIntervalSeconds is null / missing / non-positive → derive
  // Also respects an explicit per-class streams override — when the per-class
  // interfaces.intervalSeconds is set, the overlay above already moved the
  // value into result.systemInfoIntervalSeconds. We detect that by comparing
  // against the pre-overlay tier value.
  const classInterfacesInterval = (classStreams?.interfaces as Record<string, unknown> | undefined)?.intervalSeconds;
  const hasExplicitClassInterfaces = typeof classInterfacesInterval === "number" && classInterfacesInterval > 0;
  const rawSysInfo = ms ? (ms as Record<string, unknown>).systemInfoIntervalSeconds : undefined;
  const explicitTierSystemInfo = typeof rawSysInfo === "number" && rawSysInfo > 0;
  let systemInfoFromPollInterval = false;
  if (!hasExplicitClassInterfaces && !explicitTierSystemInfo && integration?.pollInterval != null && integration.pollInterval > 0) {
    const derived = Math.max(60, Math.min(86400, integration.pollInterval * 3600));
    result.systemInfoIntervalSeconds = derived;
    systemInfoFromPollInterval = true;
  }
  tierCache.set(cacheKey, result);
  tierSystemInfoFromPollIntervalCache.set(cacheKey, systemInfoFromPollInterval);
  return result;
}

async function loadManualTierSettings(): Promise<MonitorTierSettings> {
  // Manual tier has no per-class blocks — one Setting row covers every asset
  // class. Keep the legacy sentinel cache key so the existing
  // invalidateMonitorSettingsCache({integrationId: null}) clear stays
  // single-key (instead of the per-class prefix-walk it does for integrations).
  const cached = tierCache.get(MANUAL_TIER_CACHE_KEY);
  if (cached) return cached;
  const row = await prisma.setting.findUnique({ where: { key: MANUAL_SETTING_KEY } });
  let result: MonitorTierSettings;
  if (row?.value) {
    result = tierFromJson(row.value as Record<string, unknown>);
  } else {
    // Transitional: fall back to the legacy global until the migration runs.
    result = (await loadLegacyGlobalAsTier()) ?? { ...HARDCODED_FLOOR };
  }
  tierCache.set(MANUAL_TIER_CACHE_KEY, result);
  return result;
}

async function loadClassOverride(
  integrationId: string | null,
  assetType: string,
): Promise<MonitorOverrideSettings | null> {
  const key = classCacheKey(integrationId, assetType);
  if (classOverrideCache.has(key)) return classOverrideCache.get(key) ?? null;
  const row = await prisma.monitorClassOverride.findFirst({
    where: { integrationId, assetType },
    select: {
      intervalSeconds:            true,
      failureThreshold:           true,
      probeTimeoutMs:             true,
      cpuMemoryTimeoutMs:         true,
      temperatureTimeoutMs:       true,
      systemInfoTimeoutMs:        true,
      cpuMemoryIntervalSeconds:   true,
      temperatureIntervalSeconds: true,
      systemInfoIntervalSeconds:  true,
      sampleRetentionDays:        true,
      telemetryRetentionDays:     true,
      systemInfoRetentionDays:    true,
      responseTimePolling:        true,
      cpuMemoryPolling:           true,
      temperaturePolling:         true,
      interfacesPolling:          true,
      lldpPolling:                true,
      storagePolling:             true,
      processesPolling:           true,
      eventLogPolling:            true,
      responseTimeMibId:          true,
      cpuMemoryMibId:             true,
      temperatureMibId:           true,
      interfacesMibId:            true,
      lldpMibId:                  true,
      processesMibId:             true,
      responseTimeCredentialId:   true,
      cpuMemoryCredentialId:      true,
      temperatureCredentialId:    true,
      interfacesCredentialId:     true,
      lldpCredentialId:           true,
      processesCredentialId:      true,
      eventLogCredentialId:       true,
      processesIntervalSeconds:   true,
      eventLogIntervalSeconds:    true,
      processesTimeoutMs:         true,
      eventLogTimeoutMs:          true,
    },
  });
  let result: MonitorOverrideSettings | null = null;
  if (row) {
    result = {};
    if (row.intervalSeconds            != null) result.intervalSeconds            = row.intervalSeconds;
    if (row.failureThreshold           != null) result.failureThreshold           = row.failureThreshold;
    if (row.probeTimeoutMs             != null) result.probeTimeoutMs             = row.probeTimeoutMs;
    if (row.cpuMemoryTimeoutMs         != null) result.cpuMemoryTimeoutMs         = row.cpuMemoryTimeoutMs;
    if (row.temperatureTimeoutMs       != null) result.temperatureTimeoutMs       = row.temperatureTimeoutMs;
    if (row.systemInfoTimeoutMs        != null) result.systemInfoTimeoutMs        = row.systemInfoTimeoutMs;
    if (row.cpuMemoryIntervalSeconds   != null) result.cpuMemoryIntervalSeconds   = row.cpuMemoryIntervalSeconds;
    if (row.temperatureIntervalSeconds != null) result.temperatureIntervalSeconds = row.temperatureIntervalSeconds;
    if (row.systemInfoIntervalSeconds  != null) result.systemInfoIntervalSeconds  = row.systemInfoIntervalSeconds;
    if (row.sampleRetentionDays        != null) result.sampleRetentionDays        = row.sampleRetentionDays;
    if (row.telemetryRetentionDays     != null) result.telemetryRetentionDays     = row.telemetryRetentionDays;
    if (row.systemInfoRetentionDays    != null) result.systemInfoRetentionDays    = row.systemInfoRetentionDays;
    // Polling columns are nullable strings; only adopt them when they pass
    // the type guard so a stale legacy value (e.g. "rest") in the DB doesn't
    // smuggle through as a typed PollingMethod here. Bad values are silently
    // dropped — the resolver falls through to the next tier.
    if (isPollingMethod(row.responseTimePolling)) result.responseTimePolling = row.responseTimePolling;
    if (isPollingMethod(row.cpuMemoryPolling))    result.cpuMemoryPolling    = row.cpuMemoryPolling;
    if (isPollingMethod(row.temperaturePolling))  result.temperaturePolling  = row.temperaturePolling;
    if (isPollingMethod(row.interfacesPolling))   result.interfacesPolling   = row.interfacesPolling;
    if (isPollingMethod(row.lldpPolling))         result.lldpPolling         = row.lldpPolling;
    if (isPollingMethod(row.storagePolling))      result.storagePolling      = row.storagePolling;
    if (isPollingMethod(row.processesPolling))    result.processesPolling    = row.processesPolling;
    if (isPollingMethod(row.eventLogPolling))     result.eventLogPolling     = row.eventLogPolling;
    if (row.responseTimeMibId)                    result.responseTimeMibId   = row.responseTimeMibId;
    if (row.cpuMemoryMibId)                       result.cpuMemoryMibId      = row.cpuMemoryMibId;
    if (row.temperatureMibId)                     result.temperatureMibId    = row.temperatureMibId;
    if (row.interfacesMibId)                      result.interfacesMibId     = row.interfacesMibId;
    if (row.lldpMibId)                            result.lldpMibId           = row.lldpMibId;
    if (row.processesMibId)                       result.processesMibId      = row.processesMibId;
    if (row.responseTimeCredentialId)             result.responseTimeCredentialId  = row.responseTimeCredentialId;
    if (row.cpuMemoryCredentialId)                result.cpuMemoryCredentialId     = row.cpuMemoryCredentialId;
    if (row.temperatureCredentialId)              result.temperatureCredentialId   = row.temperatureCredentialId;
    if (row.interfacesCredentialId)               result.interfacesCredentialId    = row.interfacesCredentialId;
    if (row.lldpCredentialId)                     result.lldpCredentialId          = row.lldpCredentialId;
    if (row.processesCredentialId)                result.processesCredentialId     = row.processesCredentialId;
    if (row.eventLogCredentialId)                 result.eventLogCredentialId      = row.eventLogCredentialId;
    if (row.processesIntervalSeconds   != null)   result.processesIntervalSeconds  = row.processesIntervalSeconds;
    if (row.eventLogIntervalSeconds    != null)   result.eventLogIntervalSeconds   = row.eventLogIntervalSeconds;
    if (row.processesTimeoutMs         != null)   result.processesTimeoutMs        = row.processesTimeoutMs;
    if (row.eventLogTimeoutMs          != null)   result.eventLogTimeoutMs         = row.eventLogTimeoutMs;
  }
  classOverrideCache.set(key, result);
  return result;
}

/** Minimal asset shape the resolver needs. */
export interface AssetMonitorContext {
  assetType:                 string;
  discoveredByIntegrationId: string | null;
  /**
   * Type of the discovering integration. Drives the source-default
   * polling method and the compatibility matrix. Pass null/undefined for
   * orphan / manually-created assets — the resolver maps it to the
   * "manual" source kind.
   */
  discoveredByIntegrationType?: string | null;
  monitorIntervalSec:        number | null;
  cpuMemoryIntervalSec:      number | null;
  temperatureIntervalSec:    number | null;
  systemInfoIntervalSec:     number | null;
  /** Phase 2 — per-asset LLDP cadence override (sec). null = inherit. */
  lldpIntervalSec?:          number | null;
  /** Phase 2 — per-asset Storage cadence override (sec). null = inherit. */
  storageIntervalSec?:       number | null;
  /** Per-asset cross-transport cadence overrides (sec). null = inherit. */
  processesIntervalSec?:     number | null;
  eventLogIntervalSec?:      number | null;
  probeTimeoutMs:            number | null;
  /** Per-asset CPU+memory collector timeout override (ms). null = inherit. */
  cpuMemoryTimeoutMs?:       number | null;
  /** Per-asset temperature collector timeout override (ms). null = inherit. */
  temperatureTimeoutMs?:     number | null;
  /** Per-asset interface/storage/LLDP collector timeout override (ms). null = inherit. */
  systemInfoTimeoutMs?:      number | null;
  /** Per-asset cross-transport collector timeout overrides (ms). null = inherit. */
  processesTimeoutMs?:       number | null;
  eventLogTimeoutMs?:        number | null;
  // Per-stream polling overrides on the asset itself. null = inherit.
  // String? on disk so legacy values can sit alongside; resolver adopts
  // them only when they pass isPollingMethod().
  responseTimePolling?:      string | null;
  cpuMemoryPolling?:         string | null;
  temperaturePolling?:       string | null;
  interfacesPolling?:        string | null;
  lldpPolling?:              string | null;
  storagePolling?:           string | null;
  processesPolling?:         string | null;
  eventLogPolling?:          string | null;
  // Per-stream MIB id overrides on the asset itself. null = inherit.
  // Either `"std:<key>"` (UI hint only) or an uploaded MibFile UUID
  // (consumed by `collectCpuMemorySnmp` / `collectTemperatureSnmp` to override
  // vendor-profile selection).
  responseTimeMibId?:        string | null;
  cpuMemoryMibId?:           string | null;
  temperatureMibId?:         string | null;
  interfacesMibId?:          string | null;
  lldpMibId?:                string | null;
  processesMibId?:           string | null;
}

/**
 * Walk the four-tier monitor settings hierarchy and return the effective
 * values for one asset. Reads through the resolver caches; one cold call hits
 * 1-2 DB rows, every subsequent call for assets in the same tier/class group
 * is in-memory.
 *
 * Per-stream polling resolution:
 *   1. Source default (FMG/FortiGate→rest_api, AD/Entra/Win→icmp+null,
 *      manual→icmp+null) sets the baseline for each of the four streams.
 *   2. Tier-3 (integration or manual) value overrides if present AND
 *      compatible with the asset's source per
 *      utils/pollingCompatibility.isPollingMethodCompatible. Incompatible
 *      values are silently ignored — the resolver leaves the layer below
 *      in place.
 *   3. Class override applies the same compatible-or-skip rule.
 *   4. Per-asset value applies the same rule.
 */
export async function resolveMonitorSettings(asset: AssetMonitorContext): Promise<ResolvedMonitorSettings> {
  // Tier 3 (integration-tier or manual-tier). Per-class streams overlay is
  // applied inside loadIntegrationTierSettings when the integration carries
  // a matching `<klass>Monitor.streams` block for asset.assetType.
  const tier3 = asset.discoveredByIntegrationId
    ? await loadIntegrationTierSettings(asset.discoveredByIntegrationId, asset.assetType)
    : await loadManualTierSettings();

  // Tier 2 (class override scoped to the same tier-3 source).
  const classOverride = await loadClassOverride(
    asset.discoveredByIntegrationId,
    asset.assetType,
  );

  // Resolve the asset's source kind once — drives both the polling default
  // and the compatibility check at every layer.
  const sourceKind = assetSourceKindFromIntegrationType(asset.discoveredByIntegrationType ?? null);

  // Compose tier 3 → tier 2 for the cadence/retention fields. Polling fields
  // are resolved separately below with the compatibility-aware fallthrough.
  const merged: ResolvedMonitorSettings = { ...tier3 };
  if (classOverride) {
    if (classOverride.intervalSeconds            != null) merged.intervalSeconds            = classOverride.intervalSeconds;
    if (classOverride.failureThreshold           != null) merged.failureThreshold           = classOverride.failureThreshold;
    if (classOverride.probeTimeoutMs             != null) merged.probeTimeoutMs             = classOverride.probeTimeoutMs;
    if (classOverride.cpuMemoryTimeoutMs         != null) merged.cpuMemoryTimeoutMs         = classOverride.cpuMemoryTimeoutMs;
    if (classOverride.temperatureTimeoutMs       != null) merged.temperatureTimeoutMs       = classOverride.temperatureTimeoutMs;
    if (classOverride.systemInfoTimeoutMs        != null) merged.systemInfoTimeoutMs        = classOverride.systemInfoTimeoutMs;
    if (classOverride.cpuMemoryIntervalSeconds   != null) merged.cpuMemoryIntervalSeconds   = classOverride.cpuMemoryIntervalSeconds;
    if (classOverride.temperatureIntervalSeconds != null) merged.temperatureIntervalSeconds = classOverride.temperatureIntervalSeconds;
    if (classOverride.systemInfoIntervalSeconds  != null) merged.systemInfoIntervalSeconds  = classOverride.systemInfoIntervalSeconds;
    if (classOverride.sampleRetentionDays        != null) merged.sampleRetentionDays        = classOverride.sampleRetentionDays;
    if (classOverride.telemetryRetentionDays     != null) merged.telemetryRetentionDays     = classOverride.telemetryRetentionDays;
    if (classOverride.systemInfoRetentionDays    != null) merged.systemInfoRetentionDays    = classOverride.systemInfoRetentionDays;
  }

  // Tier 1 (per-asset cadence / timeout overrides).
  if (asset.monitorIntervalSec     != null) merged.intervalSeconds            = asset.monitorIntervalSec;
  if (asset.cpuMemoryIntervalSec   != null) merged.cpuMemoryIntervalSeconds   = asset.cpuMemoryIntervalSec;
  if (asset.temperatureIntervalSec != null) merged.temperatureIntervalSeconds = asset.temperatureIntervalSec;
  if (asset.systemInfoIntervalSec  != null) merged.systemInfoIntervalSeconds  = asset.systemInfoIntervalSec;
  if (asset.lldpIntervalSec        != null) merged.lldpIntervalSeconds        = asset.lldpIntervalSec;
  if (asset.storageIntervalSec     != null) merged.storageIntervalSeconds     = asset.storageIntervalSec;
  if (asset.probeTimeoutMs         != null) merged.probeTimeoutMs             = asset.probeTimeoutMs;
  if (asset.cpuMemoryTimeoutMs     != null) merged.cpuMemoryTimeoutMs         = asset.cpuMemoryTimeoutMs;
  if (asset.temperatureTimeoutMs   != null) merged.temperatureTimeoutMs       = asset.temperatureTimeoutMs;
  if (asset.systemInfoTimeoutMs    != null) merged.systemInfoTimeoutMs        = asset.systemInfoTimeoutMs;

  // Per-stream polling resolution — see header comment above for rules.
  function resolveStream(
    stream: Stream,
    tierVal: PollingMethod | null,
    classVal: PollingMethod | null | undefined,
    assetVal: string | null | undefined,
  ): PollingMethod | null {
    // A tier's method is adopted only when it's valid for BOTH the asset's
    // source (compatibility matrix) AND the stream (cross-transport streams
    // restrict the method set — e.g. eventLog can't ride SNMP, processes can't
    // ride REST). Incompatible values are silently skipped — the layer below
    // stays in place.
    const ok = (m: PollingMethod) => isPollingMethodCompatible(sourceKind, m) && isMethodValidForStream(stream, m);
    let resolved: PollingMethod | null = defaultPollingForSource(sourceKind, stream);
    if (tierVal && ok(tierVal)) {
      resolved = tierVal;
    }
    if (classVal && ok(classVal)) {
      resolved = classVal;
    }
    if (isPollingMethod(assetVal) && ok(assetVal)) {
      resolved = assetVal;
    }
    return resolved;
  }

  merged.responseTimePolling = resolveStream(
    "responseTime",
    tier3.responseTimePolling,
    classOverride?.responseTimePolling ?? null,
    asset.responseTimePolling,
  );
  merged.cpuMemoryPolling = resolveStream(
    "cpuMemory",
    tier3.cpuMemoryPolling,
    classOverride?.cpuMemoryPolling ?? null,
    asset.cpuMemoryPolling,
  );
  merged.temperaturePolling = resolveStream(
    "temperature",
    tier3.temperaturePolling,
    classOverride?.temperaturePolling ?? null,
    asset.temperaturePolling,
  );
  merged.interfacesPolling = resolveStream(
    "interfaces",
    tier3.interfacesPolling,
    classOverride?.interfacesPolling ?? null,
    asset.interfacesPolling,
  );
  merged.lldpPolling = resolveStream(
    "lldp",
    tier3.lldpPolling,
    classOverride?.lldpPolling ?? null,
    asset.lldpPolling,
  );
  merged.storagePolling = resolveStream(
    "storage",
    tier3.storagePolling,
    classOverride?.storagePolling ?? null,
    asset.storagePolling,
  );
  merged.processesPolling = resolveStream(
    "processes",
    tier3.processesPolling,
    classOverride?.processesPolling ?? null,
    asset.processesPolling,
  );
  merged.eventLogPolling = resolveStream(
    "eventLog",
    tier3.eventLogPolling,
    classOverride?.eventLogPolling ?? null,
    asset.eventLogPolling,
  );

  // Cross-transport cadences/timeouts: tier-3 baseline → class override →
  // per-asset, mirroring LLDP/Storage.
  if (classOverride?.processesIntervalSeconds != null) merged.processesIntervalSeconds = classOverride.processesIntervalSeconds;
  if (classOverride?.eventLogIntervalSeconds  != null) merged.eventLogIntervalSeconds  = classOverride.eventLogIntervalSeconds;
  if (classOverride?.processesTimeoutMs       != null) merged.processesTimeoutMs       = classOverride.processesTimeoutMs;
  if (classOverride?.eventLogTimeoutMs        != null) merged.eventLogTimeoutMs        = classOverride.eventLogTimeoutMs;
  if (asset.processesIntervalSec != null) merged.processesIntervalSeconds = asset.processesIntervalSec;
  if (asset.eventLogIntervalSec  != null) merged.eventLogIntervalSeconds  = asset.eventLogIntervalSec;
  if (asset.processesTimeoutMs   != null) merged.processesTimeoutMs       = asset.processesTimeoutMs;
  if (asset.eventLogTimeoutMs    != null) merged.eventLogTimeoutMs        = asset.eventLogTimeoutMs;

  // Per-stream MIB id resolution. Same tier order as polling, but no
  // compatibility check — the MIB id is a hint that gets consumed downstream
  // (collectCpuMemorySnmp / collectTemperatureSnmp look up the MibFile to
  // override profile selection).
  function resolveMibId(
    tier3Val: string | null,
    classVal: string | null | undefined,
    assetVal: string | null | undefined,
  ): string | null {
    let resolved: string | null = tier3Val ?? null;
    if (classVal) resolved = classVal;
    if (assetVal) resolved = assetVal;
    return resolved;
  }
  merged.responseTimeMibId = resolveMibId(tier3.responseTimeMibId, classOverride?.responseTimeMibId, asset.responseTimeMibId);
  merged.cpuMemoryMibId    = resolveMibId(tier3.cpuMemoryMibId,    classOverride?.cpuMemoryMibId,    asset.cpuMemoryMibId);
  merged.temperatureMibId  = resolveMibId(tier3.temperatureMibId,  classOverride?.temperatureMibId,  asset.temperatureMibId);
  merged.interfacesMibId   = resolveMibId(tier3.interfacesMibId,   classOverride?.interfacesMibId,   asset.interfacesMibId);
  merged.lldpMibId         = resolveMibId(tier3.lldpMibId,         classOverride?.lldpMibId,         asset.lldpMibId);
  merged.processesMibId    = resolveMibId(tier3.processesMibId,    classOverride?.processesMibId,    asset.processesMibId);

  // Per-stream credential IDs from the class override. Per-asset overrides
  // come from the Prisma `include` on each dispatcher, not the resolver.
  merged.responseTimeCredentialId = classOverride?.responseTimeCredentialId ?? null;
  merged.cpuMemoryCredentialId    = classOverride?.cpuMemoryCredentialId    ?? null;
  merged.temperatureCredentialId  = classOverride?.temperatureCredentialId  ?? null;
  merged.interfacesCredentialId   = classOverride?.interfacesCredentialId   ?? null;
  merged.lldpCredentialId         = classOverride?.lldpCredentialId         ?? null;
  merged.processesCredentialId    = classOverride?.processesCredentialId    ?? null;
  merged.eventLogCredentialId     = classOverride?.eventLogCredentialId     ?? null;

  return merged;
}

/**
 * Per-field "where did this value come from?" label. Drives the asset-modal
 * tier badges.
 *
 * `"integrationPollInterval"` is a sub-label of the integration tier used for
 * `systemInfoIntervalSeconds` only — it means the value was derived from the
 * integration's discovery `pollInterval` rather than read from an explicit
 * tier-3 JSON setting. The UI renders it as
 * `Inherit: 14400s (4h, from <integration> discovery cycle)` so operators see
 * why their interface scrape cadence matches discovery.
 */
/**
 * Provenance label tier names:
 *   - "asset"             — per-asset column on Asset
 *   - "class"             — MonitorClassOverride row
 *   - "integration"       — integration's flat `config.monitorSettings`
 *   - "integration-class" — integration's per-class streams block
 *                           (`config.<klass>Monitor.streams.<stream>`).
 *                           Phase 2 sub-label of the integration tier so the
 *                           asset modal can render "FortiSwitch subtab"
 *                           instead of generic "FortiManager".
 *   - "manual"            — manualMonitorSettings Setting
 *   - "integrationPollInterval" — systemInfoIntervalSeconds derived from the
 *                           integration's discovery pollInterval
 */
export type ProvenanceTier = "asset" | "class" | "integration" | "integration-class" | "manual" | "integrationPollInterval";

export interface ResolvedSettingsWithProvenance {
  resolved:        ResolvedMonitorSettings;
  /** One label per resolved field naming which tier provided the final value. */
  provenance:      Record<keyof MonitorTierSettings, ProvenanceTier>;
  /** Which tier-3 storage holds this asset's baseline. UI uses this to label the badge. */
  tier3Source:     "integration" | "manual";
  /** When a class override applies, the row id so the UI can deep-link to its edit form. */
  classOverrideId: string | null;
}

/**
 * Resolve effective settings for one asset AND report which tier supplied each
 * field. Slower than `resolveMonitorSettings` (one extra DB lookup for the
 * class-override row id when present) — intended for one-shot UI loads, not
 * the hot monitor loop.
 */
export async function resolveMonitorSettingsWithProvenance(
  asset: AssetMonitorContext,
): Promise<ResolvedSettingsWithProvenance> {
  const tier3Source: "integration" | "manual" = asset.discoveredByIntegrationId ? "integration" : "manual";
  const tier3 = asset.discoveredByIntegrationId
    ? await loadIntegrationTierSettings(asset.discoveredByIntegrationId, asset.assetType)
    : await loadManualTierSettings();

  // Per-class streams block detection (Phase 2). When this asset's integration
  // carries a per-class streams block for asset.assetType AND that block sets
  // a non-null value on a stream, the corresponding `tier3` field originated
  // at the class level rather than the flat baseline — provenance reports
  // "integration-class" so the asset modal can label the badge accordingly.
  // Cheap extra lookup (one integration row, already-cached config blob);
  // skipped for manual-tier assets which never have per-class streams.
  let perClassFieldOrigins: Partial<Record<keyof MonitorTierSettings, true>> = {};
  if (asset.discoveredByIntegrationId) {
    const intRow = await prisma.integration.findUnique({
      where:  { id: asset.discoveredByIntegrationId },
      select: { config: true, type: true },
    });
    const cfg = (intRow?.config as Record<string, unknown> | null) ?? {};
    const streams = pickClassStreamsBlock(intRow?.type ?? null, cfg, asset.assetType);
    if (streams) {
      perClassFieldOrigins = detectPerClassFieldOrigins(streams);
    }
  }

  const classOverride = await loadClassOverride(asset.discoveredByIntegrationId, asset.assetType);

  // Class-override row id (extra lookup; only needed by this provenance API).
  let classOverrideId: string | null = null;
  if (classOverride) {
    const row = await prisma.monitorClassOverride.findFirst({
      where:  { integrationId: asset.discoveredByIntegrationId, assetType: asset.assetType },
      select: { id: true },
    });
    classOverrideId = row?.id ?? null;
  }

  const resolved: ResolvedMonitorSettings = { ...tier3 };
  // systemInfoIntervalSeconds carries a sub-label: when the integration tier
  // derived the value from Integration.pollInterval (rather than an explicit
  // tier-3 JSON entry), provenance reads "integrationPollInterval" so the UI
  // can render a discovery-cycle-aware hint. Only applies to the integration
  // tier — manual-tier orphan assets always carry the literal "manual" label.
  const systemInfoTier3Label: ProvenanceTier =
    tier3Source === "integration"
      && asset.discoveredByIntegrationId != null
      && tierSystemInfoFromPollIntervalCache.get(`${asset.discoveredByIntegrationId}:${asset.assetType}`) === true
      ? "integrationPollInterval"
      : tier3Source;
  // Initialize provenance to tier3Source for every field; class/asset layers
  // overwrite below. Listing the keys explicitly keeps the type checker happy
  // (Record<keyof X, ...>) without an Object.fromEntries dance.
  const provenance: Record<keyof MonitorTierSettings, ProvenanceTier> = {
    intervalSeconds:            tier3Source,
    failureThreshold:           tier3Source,
    probeTimeoutMs:             tier3Source,
    cpuMemoryTimeoutMs:         tier3Source,
    temperatureTimeoutMs:       tier3Source,
    systemInfoTimeoutMs:        tier3Source,
    cpuMemoryIntervalSeconds:   tier3Source,
    temperatureIntervalSeconds: tier3Source,
    systemInfoIntervalSeconds:  systemInfoTier3Label,
    lldpIntervalSeconds:        tier3Source,
    lldpTimeoutMs:              tier3Source,
    storageIntervalSeconds:     tier3Source,
    storageTimeoutMs:           tier3Source,
    processesIntervalSeconds:   tier3Source,
    processesTimeoutMs:         tier3Source,
    eventLogIntervalSeconds:    tier3Source,
    eventLogTimeoutMs:          tier3Source,
    sampleRetentionDays:        tier3Source,
    telemetryRetentionDays:     tier3Source,
    systemInfoRetentionDays:    tier3Source,
    responseTimePolling:        tier3Source,
    cpuMemoryPolling:           tier3Source,
    temperaturePolling:         tier3Source,
    interfacesPolling:          tier3Source,
    lldpPolling:                tier3Source,
    storagePolling:             tier3Source,
    processesPolling:           tier3Source,
    eventLogPolling:            tier3Source,
    responseTimeMibId:          tier3Source,
    cpuMemoryMibId:             tier3Source,
    temperatureMibId:           tier3Source,
    interfacesMibId:            tier3Source,
    lldpMibId:                  tier3Source,
    processesMibId:             tier3Source,
    // Credential IDs are class-override only; UI badges treat the resolved
    // value as "class" when set, but the initial label tracks the tier-3
    // source for consistency. The dispatcher walks the same fallback chain.
    responseTimeCredentialId:   tier3Source,
    cpuMemoryCredentialId:      tier3Source,
    temperatureCredentialId:    tier3Source,
    interfacesCredentialId:     tier3Source,
    lldpCredentialId:           tier3Source,
    processesCredentialId:      tier3Source,
    eventLogCredentialId:       tier3Source,
  };

  // Stamp "integration-class" on every field the per-class streams block
  // contributed. Done BEFORE the classOverride layer so a real
  // MonitorClassOverride hit later still wins. Manual-tier orphan assets
  // keep the literal "manual" label since the perClassFieldOrigins map is
  // always empty for them.
  for (const field of Object.keys(perClassFieldOrigins) as Array<keyof MonitorTierSettings>) {
    provenance[field] = "integration-class";
  }

  if (classOverride) {
    // Field-by-field copy + provenance bump. The mixed value types (numbers
    // for cadence, PollingMethod for polling) make the previous loop hostile
    // to TypeScript's narrowing — listing each field explicitly keeps the
    // types straight without `as any`.
    if (classOverride.intervalSeconds            != null) { resolved.intervalSeconds            = classOverride.intervalSeconds;            provenance.intervalSeconds            = "class"; }
    if (classOverride.failureThreshold           != null) { resolved.failureThreshold           = classOverride.failureThreshold;           provenance.failureThreshold           = "class"; }
    if (classOverride.probeTimeoutMs             != null) { resolved.probeTimeoutMs             = classOverride.probeTimeoutMs;             provenance.probeTimeoutMs             = "class"; }
    if (classOverride.cpuMemoryTimeoutMs         != null) { resolved.cpuMemoryTimeoutMs         = classOverride.cpuMemoryTimeoutMs;         provenance.cpuMemoryTimeoutMs         = "class"; }
    if (classOverride.temperatureTimeoutMs       != null) { resolved.temperatureTimeoutMs       = classOverride.temperatureTimeoutMs;       provenance.temperatureTimeoutMs       = "class"; }
    if (classOverride.systemInfoTimeoutMs        != null) { resolved.systemInfoTimeoutMs        = classOverride.systemInfoTimeoutMs;        provenance.systemInfoTimeoutMs        = "class"; }
    if (classOverride.cpuMemoryIntervalSeconds   != null) { resolved.cpuMemoryIntervalSeconds   = classOverride.cpuMemoryIntervalSeconds;   provenance.cpuMemoryIntervalSeconds   = "class"; }
    if (classOverride.temperatureIntervalSeconds != null) { resolved.temperatureIntervalSeconds = classOverride.temperatureIntervalSeconds; provenance.temperatureIntervalSeconds = "class"; }
    if (classOverride.systemInfoIntervalSeconds  != null) { resolved.systemInfoIntervalSeconds  = classOverride.systemInfoIntervalSeconds;  provenance.systemInfoIntervalSeconds  = "class"; }
    if (classOverride.sampleRetentionDays        != null) { resolved.sampleRetentionDays        = classOverride.sampleRetentionDays;        provenance.sampleRetentionDays        = "class"; }
    if (classOverride.telemetryRetentionDays     != null) { resolved.telemetryRetentionDays     = classOverride.telemetryRetentionDays;     provenance.telemetryRetentionDays     = "class"; }
    if (classOverride.systemInfoRetentionDays    != null) { resolved.systemInfoRetentionDays    = classOverride.systemInfoRetentionDays;    provenance.systemInfoRetentionDays    = "class"; }
    if (classOverride.responseTimePolling)         { resolved.responseTimePolling = classOverride.responseTimePolling; provenance.responseTimePolling = "class"; }
    if (classOverride.cpuMemoryPolling)            { resolved.cpuMemoryPolling    = classOverride.cpuMemoryPolling;    provenance.cpuMemoryPolling    = "class"; }
    if (classOverride.temperaturePolling)          { resolved.temperaturePolling  = classOverride.temperaturePolling;  provenance.temperaturePolling  = "class"; }
    if (classOverride.interfacesPolling)           { resolved.interfacesPolling   = classOverride.interfacesPolling;   provenance.interfacesPolling   = "class"; }
    if (classOverride.lldpPolling)                 { resolved.lldpPolling         = classOverride.lldpPolling;         provenance.lldpPolling         = "class"; }
    if (classOverride.storagePolling)              { resolved.storagePolling      = classOverride.storagePolling;      provenance.storagePolling      = "class"; }
    if (classOverride.processesPolling)            { resolved.processesPolling    = classOverride.processesPolling;    provenance.processesPolling    = "class"; }
    if (classOverride.eventLogPolling)             { resolved.eventLogPolling     = classOverride.eventLogPolling;     provenance.eventLogPolling     = "class"; }
    if (classOverride.processesIntervalSeconds   != null) { resolved.processesIntervalSeconds = classOverride.processesIntervalSeconds; provenance.processesIntervalSeconds = "class"; }
    if (classOverride.eventLogIntervalSeconds    != null) { resolved.eventLogIntervalSeconds  = classOverride.eventLogIntervalSeconds;  provenance.eventLogIntervalSeconds  = "class"; }
    if (classOverride.processesTimeoutMs         != null) { resolved.processesTimeoutMs       = classOverride.processesTimeoutMs;       provenance.processesTimeoutMs       = "class"; }
    if (classOverride.eventLogTimeoutMs          != null) { resolved.eventLogTimeoutMs        = classOverride.eventLogTimeoutMs;        provenance.eventLogTimeoutMs        = "class"; }
    if (classOverride.responseTimeMibId)           { resolved.responseTimeMibId   = classOverride.responseTimeMibId;   provenance.responseTimeMibId   = "class"; }
    if (classOverride.cpuMemoryMibId)              { resolved.cpuMemoryMibId      = classOverride.cpuMemoryMibId;      provenance.cpuMemoryMibId      = "class"; }
    if (classOverride.temperatureMibId)            { resolved.temperatureMibId    = classOverride.temperatureMibId;    provenance.temperatureMibId    = "class"; }
    if (classOverride.interfacesMibId)             { resolved.interfacesMibId     = classOverride.interfacesMibId;     provenance.interfacesMibId     = "class"; }
    if (classOverride.lldpMibId)                   { resolved.lldpMibId           = classOverride.lldpMibId;           provenance.lldpMibId           = "class"; }
    if (classOverride.responseTimeCredentialId)    { resolved.responseTimeCredentialId  = classOverride.responseTimeCredentialId;  provenance.responseTimeCredentialId  = "class"; }
    if (classOverride.cpuMemoryCredentialId)       { resolved.cpuMemoryCredentialId     = classOverride.cpuMemoryCredentialId;     provenance.cpuMemoryCredentialId     = "class"; }
    if (classOverride.temperatureCredentialId)     { resolved.temperatureCredentialId   = classOverride.temperatureCredentialId;   provenance.temperatureCredentialId   = "class"; }
    if (classOverride.interfacesCredentialId)      { resolved.interfacesCredentialId    = classOverride.interfacesCredentialId;    provenance.interfacesCredentialId    = "class"; }
    if (classOverride.lldpCredentialId)            { resolved.lldpCredentialId          = classOverride.lldpCredentialId;          provenance.lldpCredentialId          = "class"; }
    if (classOverride.processesMibId)              { resolved.processesMibId            = classOverride.processesMibId;            provenance.processesMibId            = "class"; }
    if (classOverride.processesCredentialId)       { resolved.processesCredentialId     = classOverride.processesCredentialId;     provenance.processesCredentialId     = "class"; }
    if (classOverride.eventLogCredentialId)        { resolved.eventLogCredentialId      = classOverride.eventLogCredentialId;      provenance.eventLogCredentialId      = "class"; }
  }

  // Per-asset (only the cadence + timeout overrides).
  if (asset.monitorIntervalSec != null) {
    resolved.intervalSeconds = asset.monitorIntervalSec;
    provenance.intervalSeconds = "asset";
  }
  if (asset.cpuMemoryIntervalSec != null) {
    resolved.cpuMemoryIntervalSeconds = asset.cpuMemoryIntervalSec;
    provenance.cpuMemoryIntervalSeconds = "asset";
  }
  if (asset.temperatureIntervalSec != null) {
    resolved.temperatureIntervalSeconds = asset.temperatureIntervalSec;
    provenance.temperatureIntervalSeconds = "asset";
  }
  if (asset.systemInfoIntervalSec != null) {
    resolved.systemInfoIntervalSeconds = asset.systemInfoIntervalSec;
    provenance.systemInfoIntervalSeconds = "asset";
  }
  if (asset.lldpIntervalSec != null) {
    resolved.lldpIntervalSeconds = asset.lldpIntervalSec;
    provenance.lldpIntervalSeconds = "asset";
  }
  if (asset.storageIntervalSec != null) {
    resolved.storageIntervalSeconds = asset.storageIntervalSec;
    provenance.storageIntervalSeconds = "asset";
  }
  if (asset.probeTimeoutMs != null) {
    resolved.probeTimeoutMs = asset.probeTimeoutMs;
    provenance.probeTimeoutMs = "asset";
  }
  if (asset.cpuMemoryTimeoutMs != null) {
    resolved.cpuMemoryTimeoutMs = asset.cpuMemoryTimeoutMs;
    provenance.cpuMemoryTimeoutMs = "asset";
  }
  if (asset.temperatureTimeoutMs != null) {
    resolved.temperatureTimeoutMs = asset.temperatureTimeoutMs;
    provenance.temperatureTimeoutMs = "asset";
  }
  if (asset.systemInfoTimeoutMs != null) {
    resolved.systemInfoTimeoutMs = asset.systemInfoTimeoutMs;
    provenance.systemInfoTimeoutMs = "asset";
  }
  if (asset.processesIntervalSec != null) {
    resolved.processesIntervalSeconds = asset.processesIntervalSec;
    provenance.processesIntervalSeconds = "asset";
  }
  if (asset.eventLogIntervalSec != null) {
    resolved.eventLogIntervalSeconds = asset.eventLogIntervalSec;
    provenance.eventLogIntervalSeconds = "asset";
  }
  if (asset.processesTimeoutMs != null) {
    resolved.processesTimeoutMs = asset.processesTimeoutMs;
    provenance.processesTimeoutMs = "asset";
  }
  if (asset.eventLogTimeoutMs != null) {
    resolved.eventLogTimeoutMs = asset.eventLogTimeoutMs;
    provenance.eventLogTimeoutMs = "asset";
  }
  // Per-asset polling overrides — only adopted when they're a real
  // PollingMethod string AND valid for the asset's source AND the stream.
  // A stale legacy "rest" or an incompatible value silently falls through to
  // the class/tier value. The Stream name is derived from the field by
  // stripping the "Polling" suffix.
  const sourceKindForAsset = assetSourceKindFromIntegrationType(asset.discoveredByIntegrationType ?? null);
  function takeAssetPolling(field: keyof Pick<MonitorTierSettings, "responseTimePolling" | "cpuMemoryPolling" | "temperaturePolling" | "interfacesPolling" | "lldpPolling" | "storagePolling" | "processesPolling" | "eventLogPolling">, raw: string | null | undefined) {
    const streamName = field.replace(/Polling$/, "") as Stream;
    if (isPollingMethod(raw) && isPollingMethodCompatible(sourceKindForAsset, raw) && isMethodValidForStream(streamName, raw)) {
      resolved[field] = raw;
      provenance[field] = "asset";
    }
  }
  takeAssetPolling("responseTimePolling", asset.responseTimePolling);
  takeAssetPolling("cpuMemoryPolling",    asset.cpuMemoryPolling);
  takeAssetPolling("temperaturePolling",  asset.temperaturePolling);
  takeAssetPolling("interfacesPolling",   asset.interfacesPolling);
  takeAssetPolling("lldpPolling",         asset.lldpPolling);
  takeAssetPolling("storagePolling",      asset.storagePolling);
  takeAssetPolling("processesPolling",    asset.processesPolling);
  takeAssetPolling("eventLogPolling",     asset.eventLogPolling);

  // Per-asset MIB id overrides. Empty strings are treated as inherit; only
  // non-empty values take effect (matches the resolver's resolveMibId rule).
  function takeAssetMibId(stream: keyof Pick<MonitorTierSettings, "responseTimeMibId" | "cpuMemoryMibId" | "temperatureMibId" | "interfacesMibId" | "lldpMibId" | "processesMibId">, raw: string | null | undefined) {
    if (typeof raw === "string" && raw.trim().length > 0) {
      resolved[stream] = raw;
      provenance[stream] = "asset";
    }
  }
  takeAssetMibId("responseTimeMibId", asset.responseTimeMibId);
  takeAssetMibId("cpuMemoryMibId",    asset.cpuMemoryMibId);
  takeAssetMibId("temperatureMibId",  asset.temperatureMibId);
  takeAssetMibId("interfacesMibId",   asset.interfacesMibId);
  takeAssetMibId("lldpMibId",         asset.lldpMibId);
  takeAssetMibId("processesMibId",    asset.processesMibId);

  return { resolved, provenance, tier3Source, classOverrideId };
}

/**
 * Resolve the SNMP credential config to use when an FMG/FortiGate-typed asset
 * has a transport toggle flipped to "snmp". The `effectiveCred` is already the
 * resolved per-stream credential (stream-specific wins, then asset default);
 * here we only need to fall back to the integration's `monitorCredentialId`
 * when neither is an SNMP credential. Throws on missing/wrong-type credentials
 * so the caller can surface the reason in the System tab error toast.
 */
/**
 * Resolve the credential to use for one stream when the per-asset slot
 * didn't supply a usable one. Looks up the class-override-tier credential id
 * (resolved by `resolveMonitorSettings` onto the `*CredentialId` fields of
 * `ResolvedMonitorSettings`) and returns the matching Credential row when its
 * type matches what the polling method needs. Returns null otherwise so the
 * caller falls through to the integration-tier credential.
 */
async function loadClassOverrideStreamCredential(
  credentialId: string | null,
  expectedType: "snmp" | "winrm" | "ssh" | "restapi",
): Promise<{ type: string; config: unknown } | null> {
  if (!credentialId) return null;
  const cred = await prisma.credential.findUnique({ where: { id: credentialId } });
  if (!cred) return null;
  if (cred.type !== expectedType) return null;
  return cred;
}

async function loadSnmpCredentialConfigForFortinetAsset(
  effectiveCred: { type: string; config: unknown } | null | undefined,
  integration: { config?: unknown } | null | undefined,
): Promise<Record<string, unknown>> {
  if (effectiveCred && effectiveCred.type === "snmp") {
    return (effectiveCred.config as Record<string, unknown>) || {};
  }
  const intCfg = (integration?.config && typeof integration.config === "object")
    ? (integration.config as Record<string, unknown>)
    : {};
  const credId = typeof intCfg.monitorCredentialId === "string" ? intCfg.monitorCredentialId : null;
  if (!credId) throw new AppError(409, "Transport set to SNMP but no SNMP credential is configured on the asset or integration");
  const cred = await prisma.credential.findUnique({ where: { id: credId } });
  if (!cred) throw new AppError(404, "Integration's monitor credential not found");
  if (cred.type !== "snmp") throw new AppError(409, `Integration's monitor credential must be SNMP (got "${cred.type}")`);
  return (cred.config as Record<string, unknown>) || {};
}

/**
 * Pull only IPsec tunnels from FortiOS REST. Used when the interfaces
 * transport is "snmp" but we still want IPsec history on the System tab.
 * Best-effort: returns undefined on any failure so the SNMP-path system-info
 * still succeeds without IPsec.
 */
async function collectIpsecOnlyFortinetSafe(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  timeoutMs?: number,
): Promise<IpsecTunnelSample[] | undefined> {
  try {
    const fg = buildFortinetConfig(host, integration);
    if ("error" in fg) return undefined;
    return await collectIpsecTunnelsFortinet(fg, timeoutMs);
  } catch {
    return undefined;
  }
}

// ─── Probe entry point ──────────────────────────────────────────────────────

/**
 * Run a single probe against the asset (no DB writes — caller persists).
 * The probe always returns a result; thrown errors are caught and packaged
 * into `{ success: false, error }` so the monitor loop never aborts.
 *
 * Hot loop callers pass `out` to surface the loaded asset row to the
 * subsequent `recordProbeResult` call — that lets recordProbeResult skip
 * its own findUnique on the state-machine update path. The /probe-now
 * route doesn't bother (one operator-triggered request, savings don't
 * matter); leaves `out` undefined and pays the second read.
 */
export async function probeAsset(
  assetId: string,
  out?: { snapshot?: AssetMonitorSnapshot },
): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { monitorCredential: true, responseTimeCredential: true, discoveredByIntegration: true },
    });
    if (!asset) return finish(start, false, "Asset not found");
    // Surface the loaded asset to the caller so `recordProbeResult` can
    // skip its own findUnique. The fields in `AssetMonitorSnapshot` are a
    // subset of what this `include` already pulled — no extra DB cost.
    if (out) out.snapshot = asset;
    if (!asset.monitored) return finish(start, false, "Monitoring disabled");
    const effectiveRTCred = asset.responseTimeCredential ?? asset.monitorCredential;

    // Resolve effective settings (probeTimeoutMs + responseTimePolling) through
    // the four-tier hierarchy. The resolver's source-default fallback always
    // populates responseTimePolling — fortinet → "rest_api", everything else
    // → "icmp" — so dispatch never falls through to the legacy monitorType.
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    const timeoutMs = effective.probeTimeoutMs;
    const polling   = effective.responseTimePolling;
    if (!polling) return finish(start, false, "No response-time polling method configured");

    // Agent owns its own probe cadence and pushes samples directly via
    // POST /api/v1/agents/samples. The hot monitor loop must not call out
    // to the host; on-demand /probe-now is handled by agentChannelService
    // over the WebSocket. Return a synthetic success so the probeTotal
    // counter increments under transport="agent" but no DB write happens
    // (recordProbeResult below early-returns for agent-mode assets).
    if (polling === "agent") return finish(start, true);

    const integration  = asset.discoveredByIntegration ?? null;
    const sourceKind   = assetSourceKindFromIntegrationType(integration?.type ?? null);
    const isFortinetSrc = sourceKind === "fortimanager" || sourceKind === "fortigate";
    const isAdSrc       = sourceKind === "activedirectory";

    // REST-API probes for managed FortiSwitches/FortiAPs query the parent
    // FortiGate's controller-status table, not the asset itself — so they
    // don't need an asset IP and dispatch before the IP guard below.
    if (
      polling === "rest_api" &&
      isFortinetSrc &&
      integration &&
      (asset.assetType === "switch" || asset.assetType === "access_point")
    ) {
      return await probeFortinetController(asset, integration as any, start, timeoutMs);
    }

    // AD-discovered Windows hosts often have no IP yet (only dnsName/hostname),
    // and WinRM/SSH resolve FQDNs fine — fall back so the probe can still run
    // when the polling method is one that doesn't need an IPv4 literal.
    const adFallback = asset.dnsName || asset.hostname;
    const targetIp =
      asset.ipAddress ||
      ((polling === "winrm" || polling === "ssh") ? adFallback : null);
    if (!targetIp) return finish(start, false, "Asset has no IP address");

    if (polling === "icmp") {
      return await probeIcmp(targetIp, start, timeoutMs);
    }
    if (polling === "rest_api") {
      // Fortinet-discovered firewalls reuse the integration's stored API token.
      // (Managed FortiSwitches/FortiAPs are dispatched earlier, above, since
      // they query the parent FortiGate rather than the asset's own IP.)
      // Manual REST API targets pull from a stored "restapi"-typed credential.
      if (isFortinetSrc && integration) {
        const result = await probeFortinet(targetIp, integration as any, start, timeoutMs);
        // Proxy mode only: after a successful FortiGate probe, pre-warm the
        // switch + AP controller-inventory cache so children that fire within
        // the 30 s TTL window get a free cache hit instead of a separate FMG
        // proxy call. Fire-and-forget — don't add to the FortiGate's RTT.
        // Direct mode keeps children independent (no proxy bottleneck, and
        // per-device parallelism is up to 20).
        if (
          result.success &&
          integration.type === "fortimanager" &&
          (integration.config as Record<string, unknown>).useProxy !== false &&
          asset.hostname
        ) {
          void fetchFortinetControllerInventory(integration as any, asset.hostname, "switches", timeoutMs).catch(() => {});
          void fetchFortinetControllerInventory(integration as any, asset.hostname, "aps",     timeoutMs).catch(() => {});
        }
        return result;
      }
      if (effectiveRTCred?.type === "restapi") {
        return await probeRestApiCredential(effectiveRTCred.config as Record<string, unknown>, start, timeoutMs);
      }
      return finish(start, false, "REST API polling requires either a Fortinet integration or a REST API credential");
    }
    if (polling === "snmp") {
      // Per-stream asset credential wins, then asset default, then class-
      // override credential, then integration fallback.
      if (effectiveRTCred?.type === "snmp") {
        return await probeSnmp(targetIp, effectiveRTCred.config as Record<string, unknown>, start, timeoutMs);
      }
      const classCred = await loadClassOverrideStreamCredential(effective.responseTimeCredentialId, "snmp");
      if (classCred) {
        return await probeSnmp(targetIp, classCred.config as Record<string, unknown>, start, timeoutMs);
      }
      if (isFortinetSrc && integration) {
        try {
          const credConfig = await loadSnmpCredentialConfigForFortinetAsset(effectiveRTCred, integration);
          return await probeSnmp(targetIp, credConfig, start, timeoutMs);
        } catch (err: any) {
          return finish(start, false, err?.message || "SNMP credential lookup failed");
        }
      }
      return finish(start, false, "No SNMP credential selected");
    }
    if (polling === "winrm") {
      // Per-stream credential wins, then asset default, then AD bind fallback.
      if (effectiveRTCred?.type === "winrm") {
        return await probeWinRm(targetIp, effectiveRTCred.config as Record<string, unknown>, start, timeoutMs);
      }
      if (isAdSrc && integration) {
        const cfg      = (integration.config as Record<string, unknown>) || {};
        const username = String(cfg.bindDn || "");
        const password = String(cfg.bindPassword || "");
        if (!username || !password) return finish(start, false, "Active Directory bind credentials not configured");
        return await probeWinRm(targetIp, { username, password, useHttps: true, port: 5986 }, start, timeoutMs);
      }
      return finish(start, false, "No WinRM credential selected");
    }
    if (polling === "ssh") {
      // Per-stream credential wins, then asset default, then AD bind fallback.
      if (effectiveRTCred?.type === "ssh") {
        return await probeSsh(targetIp, effectiveRTCred.config as Record<string, unknown>, start, timeoutMs);
      }
      if (isAdSrc && integration) {
        const cfg      = (integration.config as Record<string, unknown>) || {};
        const username = String(cfg.bindDn || "");
        const password = String(cfg.bindPassword || "");
        if (!username || !password) return finish(start, false, "Active Directory bind credentials not configured");
        return await probeSsh(targetIp, { username, password, port: 22 }, start, timeoutMs);
      }
      return finish(start, false, "No SSH credential selected");
    }
    return finish(start, false, `Unknown polling method "${polling}"`);
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
  timeoutMs: number,
): Promise<ProbeResult> {
  const cfg = integration.config || {};

  // SNMP routing is handled by the dispatcher in probeAsset via the
  // resolved responseTimePolling field. By the time we get here the polling
  // method already resolved to "rest_api" — only Fortinet-discovered
  // firewalls hit this function.

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
    await fgRequest<unknown>(fgConfig, "GET", "/api/v2/monitor/system/status", { timeoutMs });
    return finish(start, true);
  } catch (err: any) {
    return finish(start, false, err?.message || "FortiOS request failed");
  }
}

// ─── Fortinet controller-status probe (managed switches & APs) ──────────────
//
// Managed FortiSwitches and FortiAPs aren't directly REST-able — they're
// proxied through the parent FortiGate's switch-controller / wireless-
// controller subsystems. The authoritative up/down signal for them is the
// controller's `managed-switch/status` or `wifi/managed_ap` table.
//
// The probe fetches the controller's full inventory in one call and looks
// up the asset by its serial number. Multiple switches/APs on the same
// controller share one inventory call within a short TTL window so the
// probe rate stays bounded by controller-count, not device-count — important
// for FMG proxy mode (concurrency = 1).

interface FortinetControllerEntry {
  /** True when the controller reports this device as currently online. */
  connected: boolean;
  /** Raw status string the controller reported, surfaced in failure errors. */
  status: string;
  /**
   * For `kind="aps"` rows only: telemetry snapshot parsed off the same
   * managed_ap row. Lets the AP telemetry + temperature collectors reuse
   * the controller-cache fetch instead of issuing their own /wifi/managed_ap
   * call. Undefined on switches and on AP rows where FortiOS didn't return
   * the relevant fields.
   */
  apTelemetry?: import("../utils/fortiapMonitorRow.js").FortiapTelemetrySnapshot;
}

interface FortinetControllerFetchResult {
  inventory: Map<string, FortinetControllerEntry>;
  /**
   * Wall-clock duration of the upstream call that produced this inventory.
   * Reported as the RTT for every probe that consumes this result — the
   * fresh fetcher, every concurrent in-flight waiter, and every cache hit
   * within the TTL window — so all switches/APs under one parent FortiGate
   * show a consistent RTT instead of the lead-worker eating ~650 ms while
   * its peers report a misleading ~2 ms (the in-process cache-lookup time).
   */
  fetchDurationMs: number;
}

interface FortinetControllerCacheEntry {
  fetchedAt: number;
  fetchDurationMs: number;
  inventory: Map<string, FortinetControllerEntry>;
}

const FORTINET_CONTROLLER_CACHE_TTL_MS = 30_000;
const fortinetControllerCache = new Map<string, FortinetControllerCacheEntry>();

// Cache of (integrationId::deviceName) → management IP for the parent FortiGate.
// Populated from Asset.ipAddress (set during discovery) so the probe path
// never needs to hit FMG's CMDB just to learn an IP we already know. TTL is
// intentionally long — management IPs change only when the operator
// reconfigures the device, and a stale entry self-heals on the next discovery
// run which re-stamps Asset.ipAddress. Falls back to resolveDeviceMgmtIpViaFmg
// only when the FortiGate asset hasn't been discovered yet or has no IP set.
const CONTROLLER_MGMT_IP_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
interface ControllerMgmtIpEntry { ip: string; cachedAt: number; }
const controllerMgmtIpCache = new Map<string, ControllerMgmtIpEntry>();

async function resolveControllerMgmtIp(
  integrationId: string,
  deviceName: string,
  fmgConfig: FortiManagerConfig,
): Promise<string | null> {
  const cacheKey = `${integrationId}::${deviceName}`;
  const cached = controllerMgmtIpCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CONTROLLER_MGMT_IP_CACHE_TTL_MS) {
    return cached.ip;
  }

  // Primary: look up the FortiGate's already-discovered Asset.ipAddress.
  // This is the same IP that discovery resolved via resolveDeviceMgmtIpViaFmg
  // and stamped on the asset — no need to hit FMG again. Use case-insensitive
  // hostname matching because FortiOS device names can be stored in different
  // case than what ends up in the topology blob's controllerFortigate field.
  // Try with the integration filter first for precision; fall back without it
  // in case the FortiGate's discoveredByIntegrationId was cleared (integration
  // delete+recreate) — hostname + assetType=firewall is specific enough.
  let fgAsset = await prisma.asset.findFirst({
    where: {
      hostname: { equals: deviceName, mode: "insensitive" },
      assetType: "firewall",
      discoveredByIntegrationId: integrationId,
    },
    select: { ipAddress: true },
  });
  if (!fgAsset?.ipAddress) {
    fgAsset = await prisma.asset.findFirst({
      where: {
        hostname: { equals: deviceName, mode: "insensitive" },
        assetType: "firewall",
        ipAddress: { not: null },
      },
      select: { ipAddress: true },
    });
  }
  if (fgAsset?.ipAddress) {
    controllerMgmtIpCache.set(cacheKey, { ip: fgAsset.ipAddress, cachedAt: Date.now() });
    return fgAsset.ipAddress;
  }

  // Fallback: FortiGate not yet discovered as an asset (or has no IP stamped).
  // Hit FMG CMDB the old way so fresh installs and edge cases still work.
  const ip = await resolveDeviceMgmtIpViaFmg(fmgConfig, deviceName, undefined, integrationId);
  if (ip) {
    controllerMgmtIpCache.set(cacheKey, { ip, cachedAt: Date.now() });
  }
  return ip;
}

// Coalesce concurrent inventory fetches against the same controller. Without
// this, every worker that wakes up on the same 60s tick races past the
// cache-miss check and fires its own fmgProxyRest call — N workers × 1
// upstream request, hammering FMG (which drops parallel sessions above
// ~1–2 at Rogers Group's deployment, surfacing as code -11 = "permission
// denied / session limit"). The promise-singleton pattern below funnels N
// concurrent callers into one upstream call; the cache then absorbs
// follow-on calls within the 30 s TTL.
const inflightControllerFetch = new Map<string, Promise<FortinetControllerFetchResult>>();

function controllerCacheKey(integrationId: string, deviceName: string, kind: "switches" | "aps"): string {
  return `${integrationId}::${deviceName}::${kind}`;
}

async function fetchFortinetControllerInventory(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  kind: "switches" | "aps",
  timeoutMs: number,
): Promise<FortinetControllerFetchResult> {
  const cacheKey = controllerCacheKey(integration.id, deviceName, kind);
  const cached = fortinetControllerCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FORTINET_CONTROLLER_CACHE_TTL_MS) {
    return { inventory: cached.inventory, fetchDurationMs: cached.fetchDurationMs };
  }
  // If another worker already kicked off the fetch for this controller +
  // kind, wait on its promise instead of firing our own. Critical at scale
  // — the alternative is N concurrent upstream calls per controller per
  // 60s tick. In proxy mode that hits FMG's parallel-session limit (code
  // -11 "invalid or expired API token"); in direct mode it hits the
  // FortiGate's REST-admin session limit (token lockouts). The promise-
  // singleton below funnels N concurrent callers into one outbound call
  // regardless of mode; the 30s cache absorbs follow-on calls.
  const inflight = inflightControllerFetch.get(cacheKey);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<FortinetControllerFetchResult> => {
    const fetchStartedAt = performance.now();
    try {
      const path = kind === "switches"
        ? "/api/v2/monitor/switch-controller/managed-switch/status"
        : "/api/v2/monitor/wifi/managed_ap";

      let rawRows: unknown;
      if (integration.type === "fortimanager") {
        const fmgConfig = integration.config as unknown as FortiManagerConfig;
        // Strict bypass: when useProxy=false the operator has explicitly
        // opted out of FMG proxy. Polaris will never silently fall back
        // — if the direct path can't be assembled (missing token / mgmt
        // interface / mgmt IP not resolvable in FMG) the probe fails
        // with a precondition-specific error so the operator sees what's
        // misconfigured. This matters at scale because a silent
        // fallback to proxy turns "I disabled proxy" into "I disabled
        // proxy except when something else is wrong, in which case it
        // silently re-enables itself and overruns FMG's session limit."
        if (fmgConfig.useProxy === false) {
          if (!fmgConfig.fortigateApiToken) {
            throw new AppError(
              409,
              "Direct mode is enabled (useProxy=false) but no FortiGate API token is configured on the integration. " +
              "Set fortigateApiToken on the integration's Settings tab, or re-enable proxy mode.",
            );
          }
          if (!fmgConfig.mgmtInterface?.trim()) {
            throw new AppError(
              409,
              "Direct mode is enabled (useProxy=false) but mgmtInterface is empty. " +
              "Set the FortiGate management interface name (e.g. \"mgmt\", \"port1\") on the integration's Settings tab.",
            );
          }
          const mgmtIp = await resolveControllerMgmtIp(integration.id, deviceName, fmgConfig);
          if (!mgmtIp) {
            throw new AppError(
              502,
              `Direct mode: could not resolve ${deviceName}'s management IP ` +
              `(not found in Polaris asset inventory or FMG CMDB interface "${fmgConfig.mgmtInterface || "mgmt"}").`,
            );
          }
          const directConfig: FortiGateConfig = {
            host: mgmtIp,
            port: 443,
            apiUser: fmgConfig.fortigateApiUser || "",
            apiToken: fmgConfig.fortigateApiToken,
            verifySsl: fmgConfig.fortigateVerifySsl === true,
          };
          rawRows = await fgRequest<unknown>(directConfig, "GET", path, { timeoutMs });
        } else {
          // Proxy mode (default) — wrap in /sys/proxy/json. fmgProxyRest unwraps
          // the FMG envelope + FortiOS envelope and returns the inner results.
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), timeoutMs);
          try {
            rawRows = await fmgProxyRest<unknown>(fmgConfig, deviceName, "GET", path, { signal: ac.signal, integrationId: integration.id });
          } finally {
            clearTimeout(timer);
          }
        }
      } else if (integration.type === "fortigate") {
        rawRows = await fgRequest<unknown>(integration.config as unknown as FortiGateConfig, "GET", path, { timeoutMs });
      } else {
        throw new AppError(500, `Unsupported integration type for Fortinet controller probe: ${integration.type}`);
      }

      const rows: unknown[] = Array.isArray(rawRows)
        ? rawRows
        : Array.isArray((rawRows as any)?.results) ? (rawRows as any).results : [];
      const inventory = new Map<string, FortinetControllerEntry>();
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const serial = String(r.serial || r.sn || r.wtp_id || "").trim();
        if (!serial) continue;
        const status = String(r.status || r.state || "");
        const connected = kind === "switches"
          // Managed switch reports `status: "Connected" | "Disconnected"`.
          ? status === "Connected"
          // Managed APs report `status: "online" | "offline" | "discovered" | ...`
          // — only "online"/"connected" count as up.
          : (status === "online" || status === "connected");
        const entry: FortinetControllerEntry = { connected, status };
        if (kind === "aps") {
          // Parse the AP-row telemetry snapshot once at fetch time so the
          // cache absorbs both probe + telemetry + temperature consumers.
          const snap = parseFortiapTelemetrySnapshot(r);
          if (snap.cpuPct !== undefined || snap.memTotalMb !== undefined || snap.sensorTemperatures) {
            entry.apTelemetry = snap;
          }
        }
        inventory.set(serial.toUpperCase(), entry);
      }

      const fetchDurationMs = Math.max(0, Math.round(performance.now() - fetchStartedAt));
      fortinetControllerCache.set(cacheKey, { fetchedAt: Date.now(), fetchDurationMs, inventory });
      return { inventory, fetchDurationMs };
    } finally {
      // Always clear the inflight entry — successful fetches are now in the
      // cache; failed fetches need a clean slate so the next call can retry
      // without waiting on a rejected promise.
      inflightControllerFetch.delete(cacheKey);
    }
  })();

  inflightControllerFetch.set(cacheKey, fetchPromise);
  return fetchPromise;
}

// ─── Wireless-station signal overlay ──────────────────────────────────────
//
// The SNMP fapStationTable carries no per-client RSSI — signal/noise live only
// on the WiFi controller (FortiGate), exposed at /api/v2/monitor/wifi/client.
// One call returns every client on the controller, so we cache it per
// (integration, controller) with the same 30s TTL + inflight-coalescing the
// inventory fetcher uses and let every AP on that controller share it. At 2000
// assets this is one REST call per controller per scrape window, not one per
// AP. Best-effort: any failure leaves signal/noise null and the SNMP-sourced
// station rows persist unchanged. Stations are matched by normalized client
// MAC (a client associates to one AP at a time, so MAC alone scopes correctly).

interface WifiClientSignal {
  signalStrength: number | null;
  noise: number | null;
}
// normalized client MAC (colon-uppercase) → signal
type WifiClientSignalMap = Map<string, WifiClientSignal>;

interface WifiClientCacheEntry {
  fetchedAt: number;
  clients: WifiClientSignalMap;
}

const fortinetWifiClientCache = new Map<string, WifiClientCacheEntry>();
const inflightWifiClientFetch = new Map<string, Promise<WifiClientSignalMap>>();

function wifiClientCacheKey(integrationId: string, deviceName: string): string {
  return `${integrationId}::${deviceName}::wifi-clients`;
}

function wifiClientNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

async function fetchFortinetWifiClients(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  timeoutMs: number,
): Promise<WifiClientSignalMap> {
  const cacheKey = wifiClientCacheKey(integration.id, deviceName);
  const cached = fortinetWifiClientCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FORTINET_CONTROLLER_CACHE_TTL_MS) {
    return cached.clients;
  }
  const inflight = inflightWifiClientFetch.get(cacheKey);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<WifiClientSignalMap> => {
    try {
      const path = "/api/v2/monitor/wifi/client";
      let rawRows: unknown;
      if (integration.type === "fortimanager") {
        const fmgConfig = integration.config as unknown as FortiManagerConfig;
        if (fmgConfig.useProxy === false) {
          if (!fmgConfig.fortigateApiToken || !fmgConfig.mgmtInterface?.trim()) {
            throw new AppError(409, "Direct-mode prerequisites missing for wifi/client fetch");
          }
          const mgmtIp = await resolveControllerMgmtIp(integration.id, deviceName, fmgConfig);
          if (!mgmtIp) throw new AppError(502, `Could not resolve ${deviceName}'s management IP`);
          const directConfig: FortiGateConfig = {
            host: mgmtIp,
            port: 443,
            apiUser: fmgConfig.fortigateApiUser || "",
            apiToken: fmgConfig.fortigateApiToken,
            verifySsl: fmgConfig.fortigateVerifySsl === true,
          };
          rawRows = await fgRequest<unknown>(directConfig, "GET", path, { timeoutMs });
        } else {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), timeoutMs);
          try {
            rawRows = await fmgProxyRest<unknown>(fmgConfig, deviceName, "GET", path, { signal: ac.signal, integrationId: integration.id });
          } finally {
            clearTimeout(timer);
          }
        }
      } else if (integration.type === "fortigate") {
        rawRows = await fgRequest<unknown>(integration.config as unknown as FortiGateConfig, "GET", path, { timeoutMs });
      } else {
        throw new AppError(500, `Unsupported integration type for wifi/client fetch: ${integration.type}`);
      }

      const rows: unknown[] = Array.isArray(rawRows)
        ? rawRows
        : Array.isArray((rawRows as any)?.results) ? (rawRows as any).results : [];
      const clients: WifiClientSignalMap = new Map();
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const macRaw = String(r.mac ?? r.sta_mac ?? r.station_mac ?? "").trim();
        if (!macRaw) continue;
        const mac = macRaw.toUpperCase().replace(/-/g, ":");
        if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) continue;
        clients.set(mac, {
          signalStrength: wifiClientNum(r.signal ?? r.signal_strength ?? r.rssi),
          noise:          wifiClientNum(r.noise),
        });
      }

      fortinetWifiClientCache.set(cacheKey, { fetchedAt: Date.now(), clients });
      return clients;
    } finally {
      inflightWifiClientFetch.delete(cacheKey);
    }
  })();

  inflightWifiClientFetch.set(cacheKey, fetchPromise);
  return fetchPromise;
}

// ─── FortiSwitch port VLAN overlay ────────────────────────────────────────
//
// Managed FortiSwitches expose interface counters via SNMP IF-MIB, but the
// per-port VLAN config (native PVID + tagged allow-list) lives only on the
// parent FortiGate's CMDB at /api/v2/cmdb/switch-controller/managed-switch.
// One CMDB call per controller carries every managed switch's ports, so we
// cache it per (integration, controller) with the same 30s TTL the inventory
// fetcher uses. Best-effort — overlay failures never break the interface
// scrape. SNMP-monitored non-Fortinet switches don't get VLAN data here
// (Q-BRIDGE-MIB would be the cross-vendor path; out of scope for v1).

interface FortiswitchPortVlan {
  nativeVlan: number | null;
  taggedVlans: number[];
  trunksAllVlans: boolean;
}

// Per-switch view of the controller's managed-switch CMDB: per-port VLAN
// config plus the trunk → physical-member-ports map. The trunk map is the
// authoritative equivalent of the FortiSwitch's own `config switch trunk`
// (auto-ISL FortiLink uplinks are auto-named after the switch serial and
// carry exactly one member); the controller exposes it on the same payload
// the VLAN overlay already reads, so it costs no extra query.
interface FortiswitchSwitchPorts {
  // portName → vlan config
  vlanByPort: Map<string, FortiswitchPortVlan>;
  // trunkName → physical member port names (in CMDB order)
  trunkMembers: Map<string, string[]>;
}

// switchSerialUpper → per-switch ports view
type FortiswitchControllerPortsMap = Map<string, FortiswitchSwitchPorts>;

interface FortiswitchControllerPortsCacheEntry {
  fetchedAt: number;
  ports: FortiswitchControllerPortsMap;
}

const fortiswitchControllerPortsCache = new Map<string, FortiswitchControllerPortsCacheEntry>();
const inflightFortiswitchPortsFetch = new Map<string, Promise<FortiswitchControllerPortsMap>>();

function fortiswitchPortsCacheKey(integrationId: string, deviceName: string): string {
  return `${integrationId}::${deviceName}::fsw-ports`;
}

// "all"-sentinel detector for FortiOS VLAN list fields. Older FortiOS
// versions return the literal string "all" instead of an empty array +
// sibling allowed-vlans-all="enable". Either form must map to "this port
// trunks every VLAN."
function isFortiosVlanListAll(raw: unknown): boolean {
  if (typeof raw === "string") return raw.trim().toLowerCase() === "all";
  return false;
}

// FortiOS reports allowed-vlans / untagged-vlans in several shapes depending
// on version + datasource flag: array of objects with vlan-id / id, array of
// raw numbers, or a comma-separated string with "10-20" ranges. The "all"
// sentinel is detected separately by `isFortiosVlanListAll` + the sibling
// `allowed-vlans-all` field (see fetchFortiswitchControllerPortsCmdb); here
// it's dropped to `[]` because we can't surface "every VLAN" as a finite
// int list.
function parseFortiosVlanList(raw: unknown): number[] {
  const out = new Set<number>();
  const push = (n: unknown): void => {
    const v = typeof n === "number" ? n : Number(n);
    if (Number.isFinite(v) && Number.isInteger(v) && v >= 1 && v <= 4094) out.add(v);
  };
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry == null) continue;
      if (typeof entry === "number" || typeof entry === "string") {
        push(entry);
        continue;
      }
      const obj = entry as Record<string, unknown>;
      const id = obj["vlan-id"] ?? obj.vlanid ?? obj.id ?? obj.vlan;
      if (id !== undefined) push(id);
    }
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s || s.toLowerCase() === "all") return [];
    for (const part of s.split(",")) {
      const p = part.trim();
      if (!p) continue;
      if (p.includes("-")) {
        const [a, b] = p.split("-").map((x) => Number(x.trim()));
        if (Number.isFinite(a) && Number.isFinite(b) && a <= b) {
          for (let i = a; i <= b; i++) push(i);
        }
      } else {
        push(p);
      }
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

async function fetchFortiswitchControllerPortsCmdb(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  timeoutMs: number,
): Promise<FortiswitchControllerPortsMap> {
  const cacheKey = fortiswitchPortsCacheKey(integration.id, deviceName);
  const cached = fortiswitchControllerPortsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FORTINET_CONTROLLER_CACHE_TTL_MS) {
    return cached.ports;
  }
  const inflight = inflightFortiswitchPortsFetch.get(cacheKey);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<FortiswitchControllerPortsMap> => {
    try {
      // datasource=1 expands range syntax in allowed-vlans / untagged-vlans
      // into individual {vlan-id} entries on the versions that support it;
      // older FortiOS ignores the flag and returns the raw string, which the
      // parser above handles too.
      const path = "/api/v2/cmdb/switch-controller/managed-switch?datasource=1";
      let rawRows: unknown;
      if (integration.type === "fortimanager") {
        const fmgConfig = integration.config as unknown as FortiManagerConfig;
        if (fmgConfig.useProxy === false) {
          if (!fmgConfig.fortigateApiToken || !fmgConfig.mgmtInterface?.trim()) {
            throw new AppError(409, "Direct-mode prerequisites missing for FortiSwitch CMDB ports fetch");
          }
          const mgmtIp = await resolveControllerMgmtIp(integration.id, deviceName, fmgConfig);
          if (!mgmtIp) throw new AppError(502, `Could not resolve ${deviceName}'s management IP`);
          const directConfig: FortiGateConfig = {
            host: mgmtIp,
            port: 443,
            apiUser: fmgConfig.fortigateApiUser || "",
            apiToken: fmgConfig.fortigateApiToken,
            verifySsl: fmgConfig.fortigateVerifySsl === true,
          };
          rawRows = await fgRequest<unknown>(directConfig, "GET", path, { timeoutMs });
        } else {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), timeoutMs);
          try {
            rawRows = await fmgProxyRest<unknown>(fmgConfig, deviceName, "GET", path, { signal: ac.signal, integrationId: integration.id });
          } finally {
            clearTimeout(timer);
          }
        }
      } else if (integration.type === "fortigate") {
        rawRows = await fgRequest<unknown>(integration.config as unknown as FortiGateConfig, "GET", path, { timeoutMs });
      } else {
        throw new AppError(500, `Unsupported integration type for FortiSwitch CMDB ports fetch: ${integration.type}`);
      }

      const rows: unknown[] = Array.isArray(rawRows)
        ? rawRows
        : Array.isArray((rawRows as any)?.results) ? (rawRows as any).results : [];
      const map: FortiswitchControllerPortsMap = new Map();
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const serial = String(r.sn || r["switch-id"] || r.name || "").trim();
        if (!serial) continue;
        const portsRaw = r.ports;
        if (!Array.isArray(portsRaw)) continue;
        const portMap = new Map<string, FortiswitchPortVlan>();
        for (const p of portsRaw) {
          const port = p as Record<string, unknown>;
          const portName = String(port["port-name"] ?? "").trim();
          if (!portName) continue;
          const nativeRaw = port.vlan;
          const native = typeof nativeRaw === "number" ? nativeRaw : Number(nativeRaw);
          const nativeVlan = Number.isFinite(native) && Number.isInteger(native) && native >= 1 && native <= 4094 ? native : null;
          const allowed   = parseFortiosVlanList(port["allowed-vlans"]);
          const untagged  = new Set(parseFortiosVlanList(port["untagged-vlans"]));
          const tagged    = allowed.filter((v) => !untagged.has(v));
          // Trunk-all detection: newer FortiOS exposes a sibling boolean
          // (`allowed-vlans-all: "enable"`), older versions stuff the
          // string `"all"` directly into `allowed-vlans`. Honor either.
          const trunksAllVlans =
            fortiosBool(port["allowed-vlans-all"]) ||
            isFortiosVlanListAll(port["allowed-vlans"]);
          portMap.set(portName, { nativeVlan, taggedVlans: tagged, trunksAllVlans });
        }
        // Trunk → physical-member map: operator LACP bundles (`members`) +
        // FortiLink auto-ISL uplinks (`isl-local-trunk-name` on each physical
        // member). The interface overlay uses this to back-fill ifParent so
        // the topology renderer swaps the opaque trunk name for the real
        // physical port. See buildFortiswitchTrunkMembers.
        const trunkMembers = buildFortiswitchTrunkMembers(portsRaw);
        map.set(serial.toUpperCase(), { vlanByPort: portMap, trunkMembers });
      }

      fortiswitchControllerPortsCache.set(cacheKey, { fetchedAt: Date.now(), ports: map });
      return map;
    } finally {
      inflightFortiswitchPortsFetch.delete(cacheKey);
    }
  })();

  inflightFortiswitchPortsFetch.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * Back-fill the trunk → physical-member relationship onto a managed
 * FortiSwitch's interface list, mirroring what `collectSystemInfoFortinet`
 * already does for FortiGate aggregates (the `set members "portN"` back-fill).
 *
 * SNMP IF-MIB surfaces the FortiLink uplink trunk and its physical member as
 * flat, unrelated rows — the parent/member edge lives only in the controller
 * CMDB. For each trunk we:
 *   - mark the trunk row `ifType="aggregate"` (only when SNMP left it null or
 *     guessed "physical" — never clobber a real aggregate type)
 *   - stamp `ifParent=<trunk>` + `ifType="physical"` on each member row,
 *     synthesizing the row when IF-MIB omitted the subordinate member port.
 *
 * Downstream, `interfaceTopologyService.preferPhysical` and the controller-
 * edge swap in `map.ts` render a single-member trunk as its physical port
 * (e.g. the serial-named FortiLink uplink → `port52`). Multi-member LACP
 * bundles keep the trunk name (no single physical port to show).
 *
 * Mutates `interfaces` in place; returns the number of member links stamped.
 */
export function overlayFortiswitchTrunkMembers(
  interfaces: InterfaceSample[],
  trunkMembers: Map<string, string[]>,
): number {
  if (trunkMembers.size === 0) return 0;
  const byName = new Map<string, InterfaceSample>();
  for (const i of interfaces) byName.set(i.ifName, i);
  let links = 0;
  for (const [trunkName, members] of trunkMembers) {
    if (members.length === 0) continue;
    const trunkRow = byName.get(trunkName);
    if (trunkRow && (!trunkRow.ifType || trunkRow.ifType === "physical")) {
      trunkRow.ifType = "aggregate";
    }
    for (const memberName of members) {
      const existing = byName.get(memberName);
      if (existing) {
        if (!existing.ifParent) existing.ifParent = trunkName;
        if (!existing.ifType) existing.ifType = "physical";
      } else {
        const synthetic: InterfaceSample = {
          ifName:   memberName,
          ifType:   "physical",
          ifParent: trunkName,
        };
        interfaces.push(synthetic);
        byName.set(memberName, synthetic);
      }
      links++;
    }
  }
  return links;
}

async function probeFortinetController(
  asset: {
    id: string;
    assetType: string;
    serialNumber: string | null;
    fortinetTopology: unknown;
  },
  integration: { id: string; type: string; config: Record<string, unknown> },
  start: number,
  timeoutMs: number,
): Promise<ProbeResult> {
  const serial = (asset.serialNumber || "").trim();
  if (!serial) {
    return finish(start, false, "Cannot probe via REST API — asset has no serial number recorded");
  }

  const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  let deviceName = typeof topology.controllerFortigate === "string" ? topology.controllerFortigate.trim() : "";
  // For standalone FortiGate integrations, the FortiGate IS the controller —
  // the integration's own host is the right target regardless of what's
  // recorded on the asset's topology blob.
  if (!deviceName && integration.type === "fortigate") {
    const cfg = integration.config as Record<string, unknown>;
    deviceName = String(cfg.host || "");
  }
  if (!deviceName) {
    return finish(start, false, "Cannot probe via REST API — asset has no controller FortiGate recorded");
  }

  const kind: "switches" | "aps" = asset.assetType === "access_point" ? "aps" : "switches";

  try {
    // Report the upstream controller call's duration as the asset's RTT —
    // not the locally-measured elapsed time from `start`. The cache + in-
    // flight coalescing means the worker servicing this asset may have done
    // either a fresh upstream call (~hundreds of ms over FMG/FortiOS REST),
    // a wait on a peer worker's in-flight call (same), or a pure cache hit
    // (sub-ms). Showing the local elapsed time produced jarringly different
    // RTTs across switches/APs sharing one parent FortiGate (e.g. 650 ms
    // for the lead worker, 2 ms for its peers). Surfacing the real upstream
    // duration on every consumer keeps RTT consistent across the fleet and
    // accurately reflects what FortiOS took to answer.
    const { inventory, fetchDurationMs } = await fetchFortinetControllerInventory(
      integration,
      deviceName,
      kind,
      timeoutMs,
    );
    const entry = inventory.get(serial.toUpperCase());
    if (!entry) {
      const label = kind === "switches" ? "managed-switch" : "managed-AP";
      return { success: false, responseTimeMs: fetchDurationMs, error: `Not present in ${deviceName}'s ${label} table` };
    }
    if (entry.connected) {
      return { success: true, responseTimeMs: fetchDurationMs };
    }
    const role = kind === "switches" ? "switch" : "AP";
    return {
      success: false,
      responseTimeMs: fetchDurationMs,
      error: `Controller reports ${role} status: ${entry.status || "Disconnected"}`,
    };
  } catch (err: any) {
    // Precondition failures and upstream errors don't have a meaningful
    // upstream duration; fall back to local elapsed time so the operator
    // still sees how long the failure took.
    return finish(start, false, err?.message || "Controller query failed");
  }
}

/**
 * REST-based CPU/memory collector for managed FortiAPs. The AP itself
 * isn't directly REST-able (no FortiOS REST server on the AP), so we
 * piggyback on the parent FortiGate's /api/v2/monitor/wifi/managed_ap
 * response — it carries `cpu_usage`, `mem_free`, and `mem_total` per
 * AP row. fetchFortinetControllerInventory has already parsed the
 * snapshot into entry.apTelemetry on the controller-cache hit path,
 * so all we do here is fetch (cache or upstream) and project the
 * snapshot into the TelemetrySample shape.
 *
 * Memory: FortiAP reports `mem_free` / `mem_total` in MB. We convert
 * to bytes for the AssetTelemetrySample columns and compute memUsedBytes
 * = (total − free) × 1024 × 1024. memPct is left null since the bytes
 * form is more useful for charts (a 256-MB AP at 90% looks the same as
 * a 1-GB AP at 90% otherwise).
 */
async function collectTelemetryFortiapRest(
  asset: { id: string; serialNumber: string | null; fortinetTopology: unknown },
  integration: { id: string; type: string; config: Record<string, unknown> },
  timeoutMs: number,
): Promise<CollectionResult<TelemetrySample>> {
  const serial = (asset.serialNumber || "").trim();
  if (!serial) return { supported: true, error: "FortiAP has no serial number recorded" };

  const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  let deviceName = typeof topology.controllerFortigate === "string" ? topology.controllerFortigate.trim() : "";
  if (!deviceName && integration.type === "fortigate") {
    deviceName = String((integration.config as Record<string, unknown>).host || "");
  }
  if (!deviceName) return { supported: true, error: "FortiAP has no controller FortiGate recorded" };

  try {
    const { inventory } = await fetchFortinetControllerInventory(integration, deviceName, "aps", timeoutMs);
    const entry = inventory.get(serial.toUpperCase());
    if (!entry) return { supported: true, error: `FortiAP not present in ${deviceName}'s managed-AP table` };
    const snap = entry.apTelemetry;
    if (!snap) {
      // Controller returned the AP row but with no cpu/mem fields — older
      // FortiOS or feature-licensed install. Caller surfaces this as a
      // collected-with-no-data condition rather than an outright failure.
      return { supported: true, data: { cpuPct: null, memPct: null, memUsedBytes: null, memTotalBytes: null } };
    }
    const memTotalBytes = snap.memTotalMb !== undefined ? snap.memTotalMb * 1024 * 1024 : null;
    const memFreeBytes  = snap.memFreeMb  !== undefined ? snap.memFreeMb  * 1024 * 1024 : null;
    const memUsedBytes  = (memTotalBytes !== null && memFreeBytes !== null) ? memTotalBytes - memFreeBytes : null;
    return {
      supported: true,
      data: {
        cpuPct:        snap.cpuPct ?? null,
        memPct:        null,
        memUsedBytes,
        memTotalBytes,
      },
    };
  } catch (err: any) {
    return { supported: true, error: err?.message || "FortiAP controller query failed" };
  }
}

/**
 * REST-based temperature collector for managed FortiAPs. Same controller-
 * cache as collectTelemetryFortiapRest — `sensors_temperatures` is parsed
 * off the same managed_ap row into entry.apTelemetry.sensorTemperatures.
 */
async function collectHardwareSensorsFortiapRest(
  asset: { id: string; serialNumber: string | null; fortinetTopology: unknown },
  integration: { id: string; type: string; config: Record<string, unknown> },
  timeoutMs: number,
): Promise<CollectionResult<HardwareSensorSample[]>> {
  const serial = (asset.serialNumber || "").trim();
  if (!serial) return { supported: true, error: "FortiAP has no serial number recorded" };

  const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  let deviceName = typeof topology.controllerFortigate === "string" ? topology.controllerFortigate.trim() : "";
  if (!deviceName && integration.type === "fortigate") {
    deviceName = String((integration.config as Record<string, unknown>).host || "");
  }
  if (!deviceName) return { supported: true, error: "FortiAP has no controller FortiGate recorded" };

  try {
    const { inventory } = await fetchFortinetControllerInventory(integration, deviceName, "aps", timeoutMs);
    const entry = inventory.get(serial.toUpperCase());
    if (!entry) return { supported: true, error: `FortiAP not present in ${deviceName}'s managed-AP table` };
    const sensors = entry.apTelemetry?.sensorTemperatures;
    if (!sensors || sensors.length === 0) {
      // No sensor fields on the row — FortiAP model that doesn't publish
      // temperatures (older indoor models). Return an empty data array so
      // the System tab shows "no sensors" rather than an error.
      return { supported: true, data: [] };
    }
    // The controller cache only exposes temperature sensors for FortiAPs.
    return {
      supported: true,
      data: sensors.map((s) => ({
        sensorName:  s.name,
        sensorClass: "temperature",
        value:       s.celsius,
        unit:        "°C",
        alarmStatus: null,
      })),
    };
  } catch (err: any) {
    return { supported: true, error: err?.message || "FortiAP controller query failed" };
  }
}

async function probeIcmp(host: string, start: number, timeoutMs: number): Promise<ProbeResult> {
  const r = await pingHost(host, timeoutMs);
  return finish(start, r.success, r.error);
}

function mapSnmpAuthProtocol(value: unknown): unknown {
  switch (value) {
    case "MD5":    return snmp.AuthProtocols.md5;
    case "SHA":    return snmp.AuthProtocols.sha;
    case "SHA224": return snmp.AuthProtocols.sha224;
    case "SHA256": return snmp.AuthProtocols.sha256;
    case "SHA384": return snmp.AuthProtocols.sha384;
    case "SHA512": return snmp.AuthProtocols.sha512;
    default: throw new AppError(400, `Unsupported SNMP v3 authProtocol "${String(value)}"`);
  }
}

function mapSnmpPrivProtocol(value: unknown): unknown {
  switch (value) {
    case "DES":     return snmp.PrivProtocols.des;
    case "AES":     return snmp.PrivProtocols.aes;
    case "AES256B": return snmp.PrivProtocols.aes256b;
    case "AES256R": return snmp.PrivProtocols.aes256r;
    default: throw new AppError(400, `Unsupported SNMP v3 privProtocol "${String(value)}"`);
  }
}

// Per-handler verbose-phase tracing. AsyncLocalStorage stashes the asset /
// cadence / verbose flag once at the cadence handler entry; every
// `startPhase(...)` call inside the async chain reads it without needing
// the flag plumbed through every collector signature. Used to diagnose
// where time goes inside a systemInfo handler that gets killed at the
// 300s pg-boss expireInSeconds cap — flip `verboseLogging` on the asset's
// originating integration and the next burst leaves a paper trail of which
// phase took 300s.
//
// `verbose: false` (the default) makes `startPhase` a no-op closure — zero
// per-tick allocation when the flag is off.
interface MonitorPhaseContext {
  assetId: string;
  cadence: "probe" | "telemetry" | "systemInfo" | "fastFiltered";
  verbose: boolean;
}
const monitorPhaseStorage = new AsyncLocalStorage<MonitorPhaseContext>();

/**
 * Open a phase span. Returns a closer that emits one `monitor.phase` log
 * with elapsed ms + any extras when called. No-op when verbose is off.
 *
 * Always pair `startPhase` with calling the returned closer in a finally
 * block so partial completion (throws mid-phase) still emits.
 */
function startPhase(name: string): (extras?: Record<string, unknown>) => void {
  const ctx = monitorPhaseStorage.getStore();
  if (!ctx?.verbose) return () => {};
  const startedAt = Date.now();
  const { assetId, cadence } = ctx;
  return (extras?: Record<string, unknown>) => {
    logger.info(
      { verbose: true, phase: name, assetId, cadence, elapsedMs: Date.now() - startedAt, ...(extras ?? {}) },
      "monitor.phase",
    );
  };
}

// Per-SNMP-target serialization gate. Many switch/AP SNMP agents are
// single-threaded — a heavy walk (IF-MIB + LLDP + storage) running in
// parallel with a cheap sysUpTime probe pins the agent's request queue
// and stretches the probe's response time from <50ms to several seconds,
// occasionally past the probe timeout (reads as "packet loss"). All
// SNMP entry points (probeSnmp / collectTelemetrySnmp / collectSystemInfoSnmp)
// run through `withSnmpGate(host, port, ...)` so probe, telemetry,
// systemInfo, and fastFiltered SNMP calls FIFO-serialize against the
// same agent within this Polaris process. FortiOS REST and FMG calls
// have their own concurrency models and aren't routed through this gate.
//
// Each waiter has a bounded wait via SNMP_GATE_WAIT_TIMEOUT_MS — when the
// currently-running collector wedges (e.g. 60s net-snmp timeout on a dead
// host), queued callers fail fast with a clear error instead of all
// waiting the full upstream duration. The wedged collector still holds
// its own slot until it returns; the timeout only bounds wait time for
// callers behind it. Default 30s — enough headroom for a legitimate
// heavy + telemetry back-to-back (~20s with default tier-3 timeouts),
// short enough to surface a hang.
type SnmpGateSlot = {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
  timer: NodeJS.Timeout | null;
  timedOut: boolean;
};
const snmpQueues = new Map<string, SnmpGateSlot[]>();
const snmpRunning = new Set<string>();

// Read per-call so tests can inject a small value via process.env without
// having to re-import the module (which is awkward inside a single-file test
// suite). Cost is negligible: one Number() coercion per gate entry, dwarfed
// by the upstream net-snmp call this serializes.
function snmpGateWaitTimeoutMs(): number {
  const raw = Number(process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

function processNextSnmpSlot(key: string): void {
  if (snmpRunning.has(key)) return;
  const queue = snmpQueues.get(key);
  if (!queue || queue.length === 0) {
    snmpQueues.delete(key);
    return;
  }
  // Skip past any slots that timed out while waiting; their rejection
  // already fired, but their queue entry remains until we drain it here.
  let slot: SnmpGateSlot | undefined;
  while ((slot = queue.shift())) {
    if (!slot.timedOut) break;
  }
  if (!slot || slot.timedOut) {
    snmpQueues.delete(key);
    return;
  }
  if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
  snmpRunning.add(key);
  const waitMs = Date.now() - slot.enqueuedAt;
  if (waitMs > 5000) {
    logger.warn({ host: key, waitMs }, "SNMP gate wait > 5s");
  }
  // Phase tracing for the current handler. Captures the wait portion
  // separately from the fn() runtime so the operator can tell at a
  // glance whether the time was spent queued (= upstream walk holding
  // the agent) or actively walking (= this asset's SNMP agent slow).
  const endPhase = startPhase("snmp.gate_wait");
  endPhase({ host: key, waitMs });
  // INTENTIONAL .then() chain — this is the per-host SNMP serialization gate's
  // slot runner: run fn(), settle the caller's promise, then release the gate
  // and pull the next queued slot. Do NOT rewrite to an async IIFE; the
  // run→settle→process-next ordering is the gate's contract.
  Promise.resolve()
    .then(() => slot.fn())
    .then(slot.resolve, slot.reject)
    .finally(() => {
      snmpRunning.delete(key);
      processNextSnmpSlot(key);
    });
}

// `waitTimeoutMs` overrides the env-derived gate wait for this one caller.
// Used by the operator snmp-walk path, whose deadline is the walk tab's
// 60s client countdown rather than the collectors' fail-fast budget.
export async function withSnmpGate<T>(host: string, port: number, fn: () => Promise<T>, waitTimeoutMs?: number): Promise<T> {
  const key = `${host}:${port}`;
  return new Promise<T>((resolve, reject) => {
    const slot: SnmpGateSlot = {
      fn: fn as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
      enqueuedAt: Date.now(),
      timer: null,
      timedOut: false,
    };
    const timeoutMs = (typeof waitTimeoutMs === "number" && waitTimeoutMs > 0)
      ? waitTimeoutMs
      : snmpGateWaitTimeoutMs();
    slot.timer = setTimeout(() => {
      if (slot.timedOut) return;
      slot.timedOut = true;
      slot.timer = null;
      const waitMs = Date.now() - slot.enqueuedAt;
      logger.warn(
        { host, port, waitMs, timeoutMs },
        "SNMP gate wait timeout — failing fast",
      );
      reject(new Error(`SNMP gate timeout for ${key} after ${waitMs}ms`));
    }, timeoutMs);
    let queue = snmpQueues.get(key);
    if (!queue) { queue = []; snmpQueues.set(key, queue); }
    queue.push(slot);
    processNextSnmpSlot(key);
  });
}

async function probeSnmp(host: string, config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
  const port = toPositiveInt(config.port, 161);
  const version = config.version === "v3" ? "v3" : "v2c";
  return withSnmpGate(host, port, () => new Promise<ProbeResult>((resolve) => {
    // Reset start INSIDE the gate so reported responseTimeMs reflects only
    // the device round-trip, not the FIFO wait behind a concurrent heavy
    // walk on the same (host, port). The caller's `start` is discarded.
    start = performance.now();
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      try { (session as any)?.close?.(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finishOnce(finish(start, false, "SNMP timed out")), timeoutMs);

    let session: any;
    try {
      if (version === "v2c") {
        session = snmp.createSession(host, String(config.community || ""), {
          port,
          version: snmp.Version2c,
          timeout: timeoutMs,
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
          timeout: timeoutMs,
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
        // sysUpTime is a TimeTicks (hundredths of a second since boot). Capture
        // it for reboot detection; a non-finite / negative value is ignored.
        const ok = finish(start, true);
        const ticks = Number(vb.value);
        if (Number.isFinite(ticks) && ticks >= 0) ok.uptimeSec = Math.floor(ticks / 100);
        finishOnce(ok);
      });
    } catch (err: any) {
      clearTimeout(timer);
      finishOnce(finish(start, false, err?.message || "SNMP setup failed"));
    }
  }));
}

async function probeWinRm(host: string, config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
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
      // WinRM Basic-auth sends credentials on the wire, so an unverified TLS
      // session lets a MITM capture them (2026-06-03 review, H1). Verify only
      // when the WinRM credential explicitly opts in (config.verifyTls === true);
      // legacy credentials with no flag keep their prior no-verify behavior so
      // existing self-signed-cert installs don't break. Operators flip it on per
      // credential in Server Settings → Credentials.
      rejectUnauthorized: config.verifyTls === true,
      timeout: timeoutMs,
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

async function probeSsh(host: string, config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
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
    const timer = setTimeout(() => finishOnce(finish(start, false, "SSH timed out")), timeoutMs);

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
        readyTimeout: timeoutMs,
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

/**
 * REST API credential test — issues an HTTPS GET to the credential's
 * baseUrl with `Authorization: Bearer <apiToken>` and treats 200/204/401
 * as a successful auth round-trip (401 means the URL is reachable but
 * the token's wrong; we surface that explicitly so operators know the
 * connection isn't the problem). Other status codes get bubbled up as
 * the error message.
 *
 * Doesn't take a `host` argument — the URL is in the credential, not the
 * asset. The probe runs against config.baseUrl directly.
 */
async function probeRestApiCredential(config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
  const baseUrl = String(config.baseUrl || "");
  const apiToken = String(config.apiToken || "");
  const verifyTls = config.verifyTls === true;
  if (!baseUrl) return finish(start, false, "REST API credential is missing baseUrl");
  if (!apiToken) return finish(start, false, "REST API credential is missing apiToken");
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { return finish(start, false, "REST API baseUrl is not a valid URL"); }
  const isHttps = url.protocol === "https:";
  const reqFn = isHttps ? httpsRequest : httpRequest;
  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };
    const req = reqFn({
      hostname: url.hostname,
      port:     url.port ? Number(url.port) : (isHttps ? 443 : 80),
      path:     url.pathname + (url.search || ""),
      method:   "GET",
      headers:  { "Authorization": "Bearer " + apiToken, "Accept": "application/json,*/*" },
      rejectUnauthorized: !!verifyTls,
      timeout:  timeoutMs,
    } as any, (res) => {
      // Drain so the socket releases.
      res.on("data", () => {});
      res.on("end", () => {
        const code = res.statusCode || 0;
        if (code === 200 || code === 204) return finishOnce(finish(start, true));
        if (code === 401 || code === 403) return finishOnce(finish(start, false, "REST API authentication failed (HTTP " + code + ")"));
        if (code === 0)                   return finishOnce(finish(start, false, "REST API request returned no status"));
        finishOnce(finish(start, false, "REST API HTTP " + code));
      });
    });
    req.on("timeout", () => { try { req.destroy(); } catch {}; finishOnce(finish(start, false, "REST API timed out")); });
    req.on("error",   (err) => finishOnce(finish(start, false, err.message || "REST API error")));
    req.end();
  });
}

/**
 * Run a one-shot probe against `host` with the given credential type + config,
 * without touching the asset row or writing samples. Used by the credential
 * Test Connection flow in Server Settings → Credentials, where the operator
 * picks an asset just to supply the host — the asset's stored monitor
 * settings are intentionally ignored. ICMP needs no credential.
 */
export async function probeCredentialAgainstHost(
  host: string,
  type: "snmp" | "winrm" | "ssh" | "icmp" | "restapi",
  config: Record<string, unknown>,
): Promise<ProbeResult> {
  const start = performance.now();
  // restapi uses config.baseUrl directly, so a missing host on the asset
  // isn't a deal-breaker for that type — the credential is tested against
  // the URL stored on the credential, not the asset.
  if (!host && type !== "restapi") return finish(start, false, "Host is required");
  // No asset context, so we use the hardcoded floor's probeTimeoutMs as the
  // default. Operator-driven credential test — they can re-trigger if the
  // host is genuinely slow.
  const timeoutMs = HARDCODED_FLOOR.probeTimeoutMs;
  try {
    if (type === "icmp")    return await probeIcmp(host, start, timeoutMs);
    if (type === "snmp")    return await probeSnmp(host, config, start, timeoutMs);
    if (type === "winrm")   return await probeWinRm(host, config, start, timeoutMs);
    if (type === "ssh")     return await probeSsh(host, config, start, timeoutMs);
    if (type === "restapi") return await probeRestApiCredential(config, start, timeoutMs);
    return finish(start, false, `Unsupported credential type "${type}"`);
  } catch (err: any) {
    return finish(start, false, err?.message || "Probe failed");
  }
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
  /** Untagged PVID for a switch port. Managed FortiSwitches only — overlaid from the parent FortiGate's `switch-controller/managed-switch` CMDB. */
  nativeVlan?:  number | null;
  /** Tagged VLAN set for a switch port (allowed-vlans minus untagged-vlans, expanded). Managed FortiSwitches only. */
  taggedVlans?: number[] | null;
  /** True when the port has `set allowed-vlans all` — trunks every VLAN. Takes precedence over `taggedVlans` for UI display. Managed FortiSwitches only. */
  trunksAllVlans?: boolean | null;
  /** Operator-set label that overrides ifName in the UI. FortiOS CMDB `alias`; SNMP ifAlias (1.3.6.1.2.1.31.1.1.1.18). */
  alias?:       string | null;
  /** Operator-set free-text comment. FortiOS CMDB `description`; SNMP has no equivalent. */
  description?: string | null;
  /** L3 addressing mode: "static" | "dhcp" | "pppoe". FortiOS CMDB `system/interface.mode`; SNMP / agent leave null. */
  addressingMode?: string | null;
}

export interface StorageSample {
  mountPath:   string;
  totalBytes?: number | null;
  usedBytes?:  number | null;
}

/** One row per hardware sensor reported by the device. `value` is the reading
 *  in `unit` (°C / RPM / V / …), null when the sensor is non-readable /
 *  not-present. `sensorClass` is the best-effort classification; `alarmStatus`
 *  is the device-reported health ("ok" / "alarm") when available. */
export interface HardwareSensorSample {
  sensorName:  string;
  sensorClass: string;
  value:       number | null;
  unit:        string | null;
  alarmStatus: string | null;
}

/**
 * One row per FortiOS phase-1 IPsec tunnel. `status` rolls phase-2 selectors up
 * to "up" / "down" / "partial". Bytes are summed across every phase-2 selector
 * under this phase-1 and are cumulative — FortiOS resets when phase-1 renegotiates.
 *
 * Dial-up server templates (CMDB `type: "dynamic"`) report status `"dynamic"`
 * regardless of phase-2 state — these are templates that accept connections
 * from dynamic peers, so a "down" rollup at scrape time is misleading.
 */
export interface IpsecTunnelSample {
  tunnelName:      string;
  /** Parent interface from `config vpn ipsec phase1-interface`; null when the CMDB lookup fails or the phase-1 isn't found. */
  parentInterface: string | null;
  remoteGateway:   string | null;
  status:          "up" | "down" | "partial" | "dynamic";
  incomingBytes:   number | null;
  outgoingBytes:   number | null;
  proxyIdCount:    number | null;
}

/**
 * One SD-WAN Performance SLA health-check reading for a single WAN member.
 * Read from /api/v2/monitor/virtual-wan/health-check. One sample per
 * (health-check, member link). latency/jitter/packetLoss are instantaneous
 * gauges (null when the member reported no value, e.g. link down).
 */
export interface PerfSlaSample {
  healthCheck: string;
  link:        string;
  // SD-WAN zone the member belongs to (CMDB members[].zone). Null when unknown.
  zone:        string | null;
  state:       "up" | "down";
  latencyMs:   number | null;
  jitterMs:    number | null;
  packetLoss:  number | null;
  // SLA target thresholds for the parent health-check (per-health-check config,
  // not per-member). Null when that metric has no configured threshold.
  latencyThresholdMs:  number | null;
  jitterThresholdMs:   number | null;
  packetLossThreshold: number | null;
}

/**
 * One SD-WAN service rule's selection state. Rule definition (name, mode,
 * candidate members) from /api/v2/cmdb/system/sdwan; `selectedMember` is the
 * runtime-active member when resolvable, else null (collector degrades
 * gracefully). One sample per (asset, rule); the detail series is the
 * failover timeline.
 */
export interface SdwanRuleSample {
  ruleName:         string;
  ruleId:           string | null;
  seq:              number | null;
  enabled:          boolean | null;
  mode:             string | null;
  criteria:         string | null;
  healthChecks:     string[];
  dst:              string[];
  status:           "up" | "down";
  selectedMember:   string | null;
  availableMembers: string[];
  // SD-WAN zone(s) the rule prefers, in priority order, when configured for
  // zone-based selection (`priority-zone`). Empty for interface-member rules.
  // When set, `availableMembers` is resolved from the member interfaces of
  // these zones so the UI can group them by zone.
  priorityZones:    string[];
}

/**
 * One LLDP neighbor seen on a local interface. Replaces (per-asset) on each
 * system-info pass that successfully queried LLDP. `localIfName` is the
 * interface on *this* asset that saw the neighbor; the chassis/port fields
 * describe the *remote* end. Capabilities is a list of tokens matching the
 * LLDP-MIB / FortiOS naming ("bridge", "router", "wlan-access-point", …).
 */
export interface LldpNeighborSample {
  localIfName:        string;
  chassisIdSubtype?:  string | null;
  chassisId?:         string | null;
  portIdSubtype?:     string | null;
  portId?:            string | null;
  portDescription?:   string | null;
  systemName?:        string | null;
  systemDescription?: string | null;
  managementIp?:      string | null;
  capabilities?:      string[];
}

/**
 * Wireless station seen connected to a FortiAP. Collected from SNMP
 * `fapStationTable` (1.3.6.1.4.1.12356.120.8.1.1) and persisted via the
 * system-info pass into AssetWirelessStation. MAC is normalized
 * colon-uppercase before persist; the persist layer resolves
 * `matchedAssetId` by MAC lookup against the endpoint inventory.
 */
export interface WirelessStationSample {
  staMacAddr:      string;
  staIpAddr?:      string | null;
  ssid?:           string | null;
  radioId?:        number | null;
  wlanId?:         number | null;
  band?:           string | null;
  vlanId?:         number | null;
  bssid?:          string | null;
  signalStrength?: number | null;
  noise?:          number | null;
  bandwidthTx?:    number | null;
  bandwidthRx?:    number | null;
  idleSeconds?:    number | null;
}

export interface SystemInfoSample {
  interfaces:    InterfaceSample[];
  storage:       StorageSample[];
  ipsecTunnels?: IpsecTunnelSample[];
  /**
   * SD-WAN Performance SLA health-check readings. `undefined` means the
   * collector didn't try (toggle off / fast-cadence skip); `[]` means the
   * device was queried and reported no health-check members.
   */
  perfSla?:      PerfSlaSample[];
  /**
   * SD-WAN service-rule selection snapshots. Same undefined/[] semantics as
   * perfSla. Gated by Integration.config.pullSdwan.
   */
  sdwanRules?:   SdwanRuleSample[];
  /**
   * LLDP neighbors observed during this scrape. `undefined` means the
   * collector didn't try (unsupported transport / fast-cadence skip);
   * `[]` means the device was queried but reported zero neighbors and the
   * persistence layer should treat that as "wipe all stored neighbors".
   */
  lldpNeighbors?: LldpNeighborSample[];
  /** Which transport produced lldpNeighbors. Stamped onto each persisted row for diagnostics. */
  lldpSource?:    "fortios" | "snmp";
  /**
   * Wireless stations connected to a FortiAP, observed during this
   * scrape. Same undefined/[] semantics as lldpNeighbors. Only populated
   * by the SNMP fapStationTable path on `assetType="access_point"`
   * assets; FortiOS-REST AP telemetry path stays undefined.
   */
  wirelessStations?: WirelessStationSample[];
  /**
   * FortiLink-enabled interface names (the fortilink-flagged interfaces + their
   * member ports) seen on this FortiGate, from CMDB `system/interface`. Used to
   * exclude FortiLink links from LLDP when the integration's
   * `excludeFortilinkLldp` toggle is on. Only populated by the FortiOS REST
   * path (which fetches CMDB); `[]` when CMDB returned no fortilink interfaces,
   * `undefined` when CMDB wasn't fetched (SNMP-interfaces path).
   */
  fortilinkInterfaces?: string[];
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
    include: { monitorCredential: true, cpuMemoryCredential: true, discoveredByIntegration: true },
  });
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };

  // Resolve the per-stream polling method. Source-default fallback gives us
  // a value (rest_api on Fortinet, null on AD/Entra/Win/Manual since the
  // telemetry stream isn't delivered there by default).
  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  // CPU/memory dispatch. Hardware sensors are collected separately by
  // `collectHardwareSensors` so operators can run CPU/memory over REST while
  // the hardware-sensor scrape uses SNMP (branch-class FortiGate workaround
  // when /api/v2/monitor/system/sensor-info is unreliable). The two streams
  // share the telemetry cadence today; an independent temperatureIntervalSeconds
  // timer can land in a follow-up.
  const polling = effective.cpuMemoryPolling;
  if (!polling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes telemetry via
  // POST /api/v1/agents/samples on its own schedule. Periodic puller stays
  // out of the way — `recordTelemetryResult` already no-ops on supported=false.
  if (polling === "agent") return { supported: false };
  const telemetryTimeout = effective.cpuMemoryTimeoutMs;

  // FQDN fallback for credentialed methods that resolve hostnames natively.
  const targetIp =
    asset.ipAddress ||
    ((polling === "winrm" || polling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration   = asset.discoveredByIntegration ?? null;
  const isFortinetSrc = integration?.type === "fortimanager" || integration?.type === "fortigate";

  try {
    if (polling === "rest_api") {
      // Telemetry over REST API is FortiOS-specific. Manual REST API
      // credentials don't yet have a telemetry shape — `{ supported: false }`
      // until that lands.
      if (!isFortinetSrc || !integration) return { supported: false };
      // Managed FortiSwitches aren't directly REST-able — they don't speak
      // FortiOS REST and the integration's API token isn't valid against
      // them. The probe path redirects to the parent FortiGate's
      // controller-status table, but there's no controller-side endpoint
      // that exposes CPU / memory for a managed switch. Operators who want
      // switch telemetry flip to SNMP. **Managed FortiAPs are different**:
      // /api/v2/monitor/wifi/managed_ap returns cpu_usage + mem_free +
      // mem_total + sensors_temperatures per AP, so the controller-cache
      // doubles as a telemetry source. See collectTelemetryFortiapRest.
      if (asset.assetType === "switch") return { supported: false };
      if (asset.assetType === "access_point") {
        return await collectTelemetryFortiapRest(asset, integration as any, telemetryTimeout);
      }
      const data = await collectTelemetryFortinet(targetIp, integration as any, telemetryTimeout);
      return { supported: true, data };
    }
    if (polling === "snmp") {
      // Per-stream asset credential wins, then asset default, then class-
      // override credential, then integration fallback. CPU/memory reads from
      // cpuMemoryCredential — hardware sensors have their own credential resolved
      // inside `collectHardwareSensors` so the two streams can authenticate
      // independently when an operator points each at a different community.
      const effectiveTelemetryCred = asset.cpuMemoryCredential ?? asset.monitorCredential;
      let snmpCfg: Record<string, unknown>;
      if (effectiveTelemetryCred?.type === "snmp") {
        snmpCfg = effectiveTelemetryCred.config as Record<string, unknown>;
      } else {
        const classCred = await loadClassOverrideStreamCredential(effective.cpuMemoryCredentialId, "snmp");
        if (classCred) {
          snmpCfg = classCred.config as Record<string, unknown>;
        } else if (isFortinetSrc && integration) {
          snmpCfg = await loadSnmpCredentialConfigForFortinetAsset(effectiveTelemetryCred, integration);
        } else {
          return { supported: true, error: "No SNMP credential selected" };
        }
      }
      const data = await collectTelemetrySnmp(
        targetIp,
        snmpCfg,
        asset.manufacturer,
        asset.model,
        asset.os,
        telemetryTimeout,
        effective.cpuMemoryMibId,
      );
      return { supported: true, data };
    }
    // winrm / ssh / icmp don't yet deliver telemetry. WinRM via WMI
    // Enumerate-over-WS-Management is tracked separately.
    return { supported: false };
  } catch (err: any) {
    return { supported: true, error: err?.message || "Telemetry collection failed" };
  }
}

/**
 * Temperature scrape for one asset. Dispatches on `temperaturePolling` —
 * deliberately separate from `cpuMemoryPolling` so an operator can run
 * CPU/memory over REST while temperature scrapes over SNMP (the common
 * branch-class FortiGate workaround when /api/v2/monitor/system/sensor-info
 * is unreliable on the platform's FortiOS build). Uses the temperature-
 * specific credential / MIB / timeout returned by the four-tier resolver.
 *
 * Cadence note: today temperature shares the telemetry cadence trigger
 * (cpuMemoryIntervalSeconds drives when `runTelemetryFor` fires both
 * streams). An independent temperatureIntervalSeconds timer is a future
 * follow-up — see `temperatureIntervalSec` on the schema.
 */
export async function collectHardwareSensors(assetId: string): Promise<CollectionResult<HardwareSensorSample[]>> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { monitorCredential: true, temperatureCredential: true, discoveredByIntegration: true },
  });
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };

  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  const polling = effective.temperaturePolling;
  if (!polling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes temperature samples
  // alongside its telemetry stream via POST /api/v1/agents/samples on its
  // own schedule. Periodic puller stays out of the way.
  if (polling === "agent") return { supported: false };
  const timeoutMs = effective.temperatureTimeoutMs;

  const targetIp =
    asset.ipAddress ||
    ((polling === "winrm" || polling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration         = asset.discoveredByIntegration ?? null;
  const isFortinetSrc       = integration?.type === "fortimanager" || integration?.type === "fortigate";

  try {
    if (polling === "rest_api") {
      // Temperature over REST API is FortiOS-specific (sensor-info endpoint).
      // Managed FortiSwitches aren't directly REST-able. Managed FortiAPs
      // expose temperatures via /api/v2/monitor/wifi/managed_ap → handled
      // by collectTemperaturesFortiapRest (controller cache).
      if (!isFortinetSrc || !integration) return { supported: false };
      if (asset.assetType === "switch")   return { supported: false };
      if (asset.assetType === "access_point") {
        return await collectHardwareSensorsFortiapRest(asset, integration as any, timeoutMs);
      }
      const fg = buildFortinetConfig(targetIp, integration as any);
      if ("error" in fg) throw new AppError(409, fg.error);
      const data = await collectHardwareSensorsFortinet(fg, timeoutMs);
      return { supported: true, data };
    }
    if (polling === "snmp") {
      // Per-stream asset credential wins, then asset default, then class-
      // override credential, then integration fallback. Same priority chain
      // as cpuMemoryCredential but resolved against the temperature-stream
      // columns so the two streams can authenticate independently.
      const effectiveTempCred = asset.temperatureCredential ?? asset.monitorCredential;
      let snmpCfg: Record<string, unknown>;
      if (effectiveTempCred?.type === "snmp") {
        snmpCfg = effectiveTempCred.config as Record<string, unknown>;
      } else {
        const classCred = await loadClassOverrideStreamCredential(effective.temperatureCredentialId, "snmp");
        if (classCred) {
          snmpCfg = classCred.config as Record<string, unknown>;
        } else if (isFortinetSrc && integration) {
          snmpCfg = await loadSnmpCredentialConfigForFortinetAsset(effectiveTempCred, integration);
        } else {
          return { supported: true, error: "No SNMP credential selected" };
        }
      }
      const data = await collectHardwareSensorsViaSnmpSession(
        targetIp,
        snmpCfg,
        asset.manufacturer,
        asset.model,
        asset.os,
        timeoutMs,
        effective.temperatureMibId,
      );
      return { supported: true, data };
    }
    // winrm / ssh / icmp don't deliver hardware-sensor data.
    return { supported: false };
  } catch (err: any) {
    return { supported: true, error: err?.message || "Hardware sensor collection failed" };
  }
}

/**
 * Open an SNMP session and run the collectHardwareSensorsSnmp walk inside it.
 * Mirrors collectTelemetrySnmp's MIB-pin pattern so that pinning an uploaded
 * MIB on the (temperature) stream feeds the right manufacturer / module-name /
 * model into pickVendorProfileMerged.
 */
async function collectHardwareSensorsViaSnmpSession(
  host: string,
  config: Record<string, unknown>,
  manufacturer?: string | null,
  model?: string | null,
  os?: string | null,
  timeoutMs?: number,
  temperatureMibId?: string | null,
): Promise<HardwareSensorSample[]> {
  await ensureRegistryLoaded();
  let profileManufacturer = manufacturer;
  let profileModel        = model;
  let profileOs           = os;
  if (temperatureMibId && !temperatureMibId.startsWith("std:")) {
    const mib = await prisma.mibFile.findUnique({
      where:  { id: temperatureMibId },
      select: { moduleName: true, manufacturer: true, model: true },
    }).catch(() => null);
    if (mib) {
      profileManufacturer = mib.manufacturer ?? manufacturer;
      profileModel        = mib.model        ?? model;
      profileOs           = mib.moduleName;
    }
  }
  const profile = pickVendorProfileMerged(profileManufacturer, profileOs, profileModel);
  const scope   = { manufacturer, model };
  return await withSnmpSession(host, config, async (session) => {
    return await collectHardwareSensorsSnmp(session, manufacturer, profile, scope);
  }, timeoutMs);
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
    include: { monitorCredential: true, interfacesCredential: true, discoveredByIntegration: true },
  });
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };
  const wantedIfaces  = (asset.monitoredInterfaces   || []) as string[];
  const wantedStorage = (asset.monitoredStorage      || []) as string[];
  const wantedTunnels = (asset.monitoredIpsecTunnels || []) as string[];
  if (wantedIfaces.length === 0 && wantedStorage.length === 0 && wantedTunnels.length === 0) {
    return { supported: false };
  }

  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  const polling = effective.interfacesPolling;
  if (!polling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes interface/storage/tunnel
  // samples on its own schedule via POST /api/v1/agents/samples.
  if (polling === "agent") return { supported: false };
  const sysInfoTimeout = effective.systemInfoTimeoutMs;

  const targetIp =
    asset.ipAddress ||
    ((polling === "winrm" || polling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration   = asset.discoveredByIntegration ?? null;
  const isFortinetSrc = integration?.type === "fortimanager" || integration?.type === "fortigate";
  const isManagedSwitchOrAp = asset.assetType === "switch" || asset.assetType === "access_point";

  try {
    let full: SystemInfoSample;
    if (polling === "rest_api") {
      if (!isFortinetSrc || !integration) return { supported: false };
      // Managed FortiSwitches / FortiAPs aren't directly REST-able; the
      // parent FortiGate's controller-status table doesn't expose per-port
      // counters or storage. Operators flip the integration's
      // FortiSwitches / FortiAPs subtab to direct SNMP polling to enable
      // this stream. Same guard as collectTelemetry.
      if (isManagedSwitchOrAp) return { supported: false };
      // Only ask FortiOS for IPsec when a tunnel is actually pinned —
      // /api/v2/monitor/vpn/ipsec is the slow endpoint we want to avoid on
      // the fast cadence. Fast cadence always skips LLDP — neighbors don't
      // change between full system-info passes often enough to merit
      // re-walking the table once a minute.
      full = await collectSystemInfoFortinet(targetIp, integration as any, {
        includeIpsec: wantedTunnels.length > 0,
        includeLldp:  false,
        timeoutMs:    sysInfoTimeout,
      });
    } else if (polling === "snmp") {
      const effectiveIfacesCred = asset.interfacesCredential ?? asset.monitorCredential;
      let snmpCfg: Record<string, unknown>;
      if (effectiveIfacesCred?.type === "snmp") {
        snmpCfg = effectiveIfacesCred.config as Record<string, unknown>;
      } else {
        const classCred = await loadClassOverrideStreamCredential(effective.interfacesCredentialId, "snmp");
        if (classCred) {
          snmpCfg = classCred.config as Record<string, unknown>;
        } else if (isFortinetSrc && integration) {
          snmpCfg = await loadSnmpCredentialConfigForFortinetAsset(effectiveIfacesCred, integration);
        } else {
          return { supported: true, error: "No SNMP credential selected" };
        }
      }
      // Wire-level filtered scrape: pulls only the columns/rows we actually
      // need (pinned ifNames + pinned mountPaths) instead of walking the full
      // IF-MIB / hrStorage subtrees. On a 48-port switch with one pinned
      // interface this is ~13 OIDs in one PDU vs. ~770 OID-fetches across 16
      // column walks under the legacy path — drops fast-cadence p90 from
      // multi-second to sub-second on busy fleets. See `collectFastFilteredSnmp`
      // for the three-phase rationale (discovery walks → multi-GET → assembly).
      full = await collectFastFilteredSnmp(targetIp, snmpCfg, {
        wantedIfaces:  wantedIfaces,
        wantedStorage: wantedStorage,
        timeoutMs:     sysInfoTimeout,
      });
      // Fortinet-discovered firewalls running SNMP still benefit from the
      // integration's interface filter (CMDB blocklist) and from the FortiOS
      // IPsec overlay — the two endpoints are independent of the SNMP path.
      // The CMDB filter is a no-op when the SNMP scrape already filtered to
      // the operator-pinned set (operators don't pin interfaces they've also
      // filtered out), but we keep the call to preserve the same defense-in-
      // depth behavior as the heavy cadence.
      if (isFortinetSrc && integration) {
        applyFortiInterfaceFilter(full.interfaces, integration as any);
        if (wantedTunnels.length > 0) {
          const ipsec = await collectIpsecOnlyFortinetSafe(targetIp, integration as any, sysInfoTimeout);
          if (ipsec !== undefined) full.ipsecTunnels = ipsec;
        }
      }
    } else {
      // winrm / ssh / icmp don't yet deliver interfaces / storage. Same
      // story as collectTelemetry.
      return { supported: false };
    }
    const wantIf = new Set(wantedIfaces);
    const wantSt = new Set(wantedStorage);
    const wantTn = new Set(wantedTunnels);
    const interfaces = wantedIfaces.length  ? full.interfaces.filter((i) => wantIf.has(i.ifName)) : [];
    // Storage is its own stream — drop pinned-storage scrapes when the resolved
    // storagePolling isn't SNMP. Same independence rule as the full systemInfo
    // pass above.
    const storage    = (wantedStorage.length && effective.storagePolling === "snmp")
      ? full.storage.filter((s) => wantSt.has(s.mountPath))
      : [];
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
    enqueueInterfaceSamples(
      d.interfaces.map((i) => ({
        assetId,
        timestamp: now,
        cadence:     "fast" as const,
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
        ifType:      null,
        ifParent:    null,
        vlanId:      null,
        nativeVlan:  i.nativeVlan ?? null,
        taggedVlans: i.taggedVlans ?? [],
        trunksAllVlans: i.trunksAllVlans === true,
        alias:       i.alias       ?? null,
        description: i.description ?? null,
        addressingMode: null,
      })),
    );
  }
  if (d.storage.length > 0) {
    enqueueStorageSamples(
      d.storage.map((s) => ({
        assetId,
        timestamp: now,
        cadence:    "fast" as const,
        mountPath:  s.mountPath,
        totalBytes: s.totalBytes != null ? BigInt(Math.round(s.totalBytes)) : null,
        usedBytes:  s.usedBytes  != null ? BigInt(Math.round(s.usedBytes))  : null,
      })),
    );
  }
  if (Array.isArray(d.ipsecTunnels) && d.ipsecTunnels.length > 0) {
    enqueueIpsecTunnelSamples(
      d.ipsecTunnels.map((t) => ({
        assetId,
        timestamp: now,
        cadence:         "fast" as const,
        tunnelName:      t.tunnelName,
        parentInterface: t.parentInterface,
        remoteGateway:   t.remoteGateway,
        status:          t.status,
        incomingBytes:   t.incomingBytes != null ? BigInt(Math.round(t.incomingBytes)) : null,
        outgoingBytes:   t.outgoingBytes != null ? BigInt(Math.round(t.outgoingBytes)) : null,
        proxyIdCount:    t.proxyIdCount,
      })),
    );
  }
}

export async function collectSystemInfo(assetId: string): Promise<CollectionResult<SystemInfoSample>> {
  const endLoad = startPhase("systeminfo.load_asset");
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { monitorCredential: true, interfacesCredential: true, lldpCredential: true, discoveredByIntegration: true },
  });
  endLoad({ found: !!asset });
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };

  const endResolve = startPhase("systeminfo.resolve_settings");
  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  endResolve();
  const interfacesPolling = effective.interfacesPolling;
  const lldpPolling       = effective.lldpPolling;
  // No interfaces stream → no system-info to collect. LLDP-only without an
  // interfaces context isn't meaningful (we'd have nothing to attach the
  // neighbors to in the System tab table).
  if (!interfacesPolling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes interface + storage +
  // LLDP samples on its own schedule. Periodic puller stays out of the way.
  if (interfacesPolling === "agent") return { supported: false };
  const sysInfoTimeout = effective.systemInfoTimeoutMs;

  const targetIp =
    asset.ipAddress ||
    ((interfacesPolling === "winrm" || interfacesPolling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration   = asset.discoveredByIntegration ?? null;
  const isFortinetSrc = integration?.type === "fortimanager" || integration?.type === "fortigate";
  const isManagedSwitchOrAp = asset.assetType === "switch" || asset.assetType === "access_point";

  try {
    if (interfacesPolling === "rest_api" || interfacesPolling === "snmp") {
      // Mixed-transport branch: interfaces and LLDP can independently be
      // REST or SNMP. Per-stream credential wins, then asset default, then
      // integration fallback. Pre-load credentials for whichever streams need SNMP.
      const effectiveIfacesCred = asset.interfacesCredential ?? asset.monitorCredential;
      const effectiveLldpCred   = asset.lldpCredential        ?? asset.monitorCredential;
      let snmpCfg: Record<string, unknown> | null = null;     // for the shared session (interfaces SNMP path)
      let lldpSnmpCfg: Record<string, unknown> | null = null; // for LLDP-only cross-transport overlay
      if (interfacesPolling === "snmp") {
        if (effectiveIfacesCred?.type === "snmp") {
          snmpCfg = effectiveIfacesCred.config as Record<string, unknown>;
        } else {
          const classCred = await loadClassOverrideStreamCredential(effective.interfacesCredentialId, "snmp");
          if (classCred) {
            snmpCfg = classCred.config as Record<string, unknown>;
          } else if (isFortinetSrc && integration) {
            snmpCfg = await loadSnmpCredentialConfigForFortinetAsset(effectiveIfacesCred, integration);
          } else {
            return { supported: true, error: "No SNMP credential selected" };
          }
        }
      }
      if (lldpPolling === "snmp") {
        if (interfacesPolling === "snmp") {
          // Same SNMP session covers LLDP; lldpSnmpCfg stays null (snmpCfg is used).
        } else {
          // Cross-transport: LLDP needs its own session with the LLDP credential.
          if (effectiveLldpCred?.type === "snmp") {
            lldpSnmpCfg = effectiveLldpCred.config as Record<string, unknown>;
          } else {
            const classCred = await loadClassOverrideStreamCredential(effective.lldpCredentialId, "snmp");
            if (classCred) {
              lldpSnmpCfg = classCred.config as Record<string, unknown>;
            } else if (isFortinetSrc && integration) {
              lldpSnmpCfg = await loadSnmpCredentialConfigForFortinetAsset(effectiveLldpCred, integration);
            } else {
              return { supported: true, error: "No SNMP credential selected for LLDP stream" };
            }
          }
        }
      }
      // REST API for interfaces requires a Fortinet integration.
      if (interfacesPolling === "rest_api" && (!isFortinetSrc || !integration)) {
        return { supported: false };
      }
      // Managed FortiSwitches / FortiAPs aren't directly REST-able. Same
      // guard as collectTelemetry / collectFastFiltered — operators flip the
      // integration's FortiSwitches / FortiAPs subtab to direct SNMP polling
      // (which sets interfacesPolling to "snmp" via the integration tier or
      // a class override) to enable this stream on those asset types.
      if (interfacesPolling === "rest_api" && isManagedSwitchOrAp) {
        return { supported: false };
      }

      let data: SystemInfoSample;
      if (interfacesPolling === "snmp") {
        // SNMP-path interfaces+storage. Fetch LLDP via the same session iff
        // the LLDP polling agrees; otherwise leave it out and overlay below.
        const endSnmp = startPhase("systeminfo.snmp.session");
        data = await collectSystemInfoSnmp(targetIp, snmpCfg!, {
          includeLldp:  lldpPolling === "snmp",
          timeoutMs:    sysInfoTimeout,
          manufacturer: asset.manufacturer,
          model:        asset.model,
          os:           asset.os,
          assetType:    asset.assetType,
        });
        endSnmp({ interfaces: data.interfaces.length, storage: data.storage.length, lldp: data.lldpNeighbors?.length ?? null });
        if (isFortinetSrc && integration) {
          applyFortiInterfaceFilter(data.interfaces, integration as any);
          // IPsec always via REST when the source is Fortinet — SNMP has no equivalent.
          const endIpsec = startPhase("systeminfo.snmp.ipsec_overlay_rest");
          const ipsec = await collectIpsecOnlyFortinetSafe(targetIp, integration as any, sysInfoTimeout);
          endIpsec({ tunnels: ipsec?.length ?? null });
          if (ipsec !== undefined) data.ipsecTunnels = ipsec;
          // FortiSwitch port-VLAN + trunk-member overlay. SNMP IF-MIB gives
          // us per-port counters but neither VLAN membership nor the
          // trunk→physical-member mapping; the parent FortiGate's
          // switch-controller CMDB carries both. One cached call per
          // controller per 30s, keyed by serial, joined onto the in-memory
          // InterfaceSample list by port-name == ifName. Best-effort: any
          // failure leaves the VLAN fields null on every row and the
          // interface scrape proceeds.
          if (asset.assetType === "switch" && asset.serialNumber) {
            const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
            let controllerName = typeof topology.controllerFortigate === "string"
              ? topology.controllerFortigate.trim()
              : "";
            if (!controllerName && integration.type === "fortigate") {
              controllerName = String((integration.config as Record<string, unknown>).host || "");
            }
            if (controllerName) {
              const endVlan = startPhase("systeminfo.snmp.fortiswitch_vlan_overlay");
              try {
                const portsMap = await fetchFortiswitchControllerPortsCmdb(
                  integration as any,
                  controllerName,
                  sysInfoTimeout,
                );
                const portsForSwitch = portsMap.get(asset.serialNumber.toUpperCase());
                if (portsForSwitch && portsForSwitch.vlanByPort.size > 0) {
                  let overlaid = 0;
                  for (const iface of data.interfaces) {
                    const cfg = portsForSwitch.vlanByPort.get(iface.ifName);
                    if (!cfg) continue;
                    iface.nativeVlan     = cfg.nativeVlan;
                    iface.taggedVlans    = cfg.taggedVlans;
                    iface.trunksAllVlans = cfg.trunksAllVlans;
                    overlaid++;
                  }
                  const trunkOverlaid = overlayFortiswitchTrunkMembers(
                    data.interfaces,
                    portsForSwitch.trunkMembers,
                  );
                  endVlan({ overlaid, total: data.interfaces.length, trunkLinks: trunkOverlaid });
                } else {
                  endVlan({ overlaid: 0, total: data.interfaces.length, reason: "switch_not_in_cmdb" });
                }
              } catch (err: any) {
                endVlan({ overlaid: 0, total: data.interfaces.length, error: err?.message || String(err) });
              }
            }
          }
          // FortiAP wireless-station signal overlay. fapStationTable (SNMP)
          // gives us the connected clients + band, but per-client RSSI lives
          // only on the controller's /api/v2/monitor/wifi/client. One cached
          // call per controller, joined onto the in-memory station list by
          // normalized MAC. Best-effort: any failure leaves signal/noise null.
          if (asset.assetType === "access_point" && Array.isArray(data.wirelessStations) && data.wirelessStations.length > 0) {
            const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
            let controllerName = typeof topology.controllerFortigate === "string"
              ? topology.controllerFortigate.trim()
              : "";
            if (!controllerName && integration.type === "fortigate") {
              controllerName = String((integration.config as Record<string, unknown>).host || "");
            }
            if (controllerName) {
              const endSignal = startPhase("systeminfo.snmp.wifi_signal_overlay_rest");
              try {
                const signals = await fetchFortinetWifiClients(integration as any, controllerName, sysInfoTimeout);
                let overlaid = 0;
                for (const st of data.wirelessStations) {
                  const sig = signals.get(st.staMacAddr.toUpperCase());
                  if (!sig) continue;
                  st.signalStrength = sig.signalStrength;
                  st.noise          = sig.noise;
                  overlaid++;
                }
                endSignal({ overlaid, total: data.wirelessStations.length });
              } catch (err: any) {
                endSignal({ overlaid: 0, total: data.wirelessStations.length, error: err?.message || String(err) });
              }
            }
          }
        }
      } else {
        // FortiOS REST path. Skip the FortiOS LLDP call when LLDP is on SNMP.
        const endRest = startPhase("systeminfo.rest.fortinet");
        data = await collectSystemInfoFortinet(targetIp, integration as any, {
          includeIpsec: true,
          includeLldp:  lldpPolling === "rest_api",
          includeSdwan: ((integration as any)?.config as any)?.pullSdwan === true,
          timeoutMs:    sysInfoTimeout,
        });
        endRest({ interfaces: data.interfaces.length, ipsec: data.ipsecTunnels?.length ?? null, lldp: data.lldpNeighbors?.length ?? null, perfSla: data.perfSla?.length ?? null, sdwanRules: data.sdwanRules?.length ?? null });
      }
      // Cross-transport LLDP overlay: when the chosen LLDP source differs
      // from the interfaces source we already used above.
      if (lldpPolling === "snmp" && interfacesPolling === "rest_api" && lldpSnmpCfg) {
        const endOverlay = startPhase("systeminfo.lldp_overlay_snmp");
        const neighbors = await collectLldpOnlySnmp(targetIp, lldpSnmpCfg, sysInfoTimeout).catch(() => undefined);
        endOverlay({ neighbors: neighbors?.length ?? null });
        if (neighbors !== undefined) {
          data.lldpNeighbors = neighbors;
          data.lldpSource    = "snmp";
        }
      } else if (lldpPolling === "rest_api" && interfacesPolling === "snmp" && isFortinetSrc && integration && !isManagedSwitchOrAp) {
        const endOverlay = startPhase("systeminfo.lldp_overlay_rest");
        const neighbors = await collectLldpOnlyFortinet(targetIp, integration as any, sysInfoTimeout).catch(() => undefined);
        endOverlay({ neighbors: neighbors?.length ?? null });
        if (neighbors !== undefined) {
          data.lldpNeighbors = neighbors;
          data.lldpSource    = "fortios";
        }
      }
      // Storage stream is independent of interfaces. Storage rows only come
      // from the SNMP path (HOST-RESOURCES-MIB + vendor disk fallback); when
      // the operator has storage routed anywhere but SNMP — including the
      // FMG/FortiGate source default of "disabled" — drop the rows the SNMP
      // walk produced as a side effect of the interfaces query.
      if (effective.storagePolling !== "snmp") {
        data.storage = [];
      }
      // FortiLink LLDP exclusion (opt-in per integration, default off). Drop
      // LLDP neighbors learned on FortiLink-enabled interfaces — the fortilink
      // aggregate + its member ports — so internal FortiGate↔FortiSwitch links
      // don't clutter the Neighbor column. Authoritative source is the CMDB
      // `fortilink` flag. FortiGate firewalls only (the CMDB query targets the
      // polled device; managed switches/APs carry no FortiGate CMDB here). The
      // REST-interfaces path already fetched CMDB (data.fortilinkInterfaces is
      // set, possibly []); the SNMP-interfaces path didn't, so we make one
      // gated CMDB call. Peer-inferred FortiLink rows are unaffected — they're
      // synthesized from topology, not LLDP.
      if (
        isFortinetSrc && integration && !isManagedSwitchOrAp &&
        ((integration as any).config as any)?.excludeFortilinkLldp === true &&
        Array.isArray(data.lldpNeighbors) && data.lldpNeighbors.length > 0
      ) {
        const endFl = startPhase("systeminfo.lldp_fortilink_exclude");
        let fortilinkSet: Set<string> | null =
          data.fortilinkInterfaces !== undefined ? new Set(data.fortilinkInterfaces) : null;
        if (fortilinkSet === null) {
          const fg = buildFortinetConfig(targetIp, integration as any);
          fortilinkSet = "error" in fg ? new Set() : await fetchFortilinkInterfaceSet(fg, sysInfoTimeout).catch(() => new Set<string>());
        }
        const before = data.lldpNeighbors.length;
        if (fortilinkSet.size > 0) {
          data.lldpNeighbors = data.lldpNeighbors.filter((n) => !fortilinkSet!.has(n.localIfName));
        }
        endFl({ excluded: before - data.lldpNeighbors.length, fortilinkIfs: fortilinkSet.size });
      }
      return { supported: true, data };
    }
    // winrm / ssh / icmp — no interfaces / storage / IPsec / LLDP support yet.
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

async function collectTelemetryFortinet(host: string, integration: { type: string; config: Record<string, unknown> }, timeoutMs?: number): Promise<TelemetrySample> {
  const fg = buildFortinetConfig(host, integration);
  if ("error" in fg) throw new AppError(409, fg.error);

  // /api/v2/monitor/system/resource/usage returns a `results` object keyed by
  // resource name (cpu, mem, disk, session, ...). Each entry can be either an
  // array of {interval, current, historical} samples or a single object,
  // depending on FortiOS version. Pull whatever's freshest.
  //
  // Hardware sensors are NOT pulled here — collectHardwareSensors dispatches on
  // its own polling method (which may resolve to SNMP even when CPU/memory is
  // on REST, e.g. when /api/v2/monitor/system/sensor-info is unreliable on the
  // branch-class FortiGate and the operator routes hardware sensors to SNMP).
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/resource/usage", { query: { scope: "global" }, timeoutMs });
  const cpuPct = pickFortinetUsage(res?.cpu);
  const memPct = pickFortinetUsage(res?.mem ?? res?.memory);
  return { cpuPct, memPct, memUsedBytes: null, memTotalBytes: null };
}

// FortiOS exposes temperature, fan, voltage, and power sensors at one endpoint.
// We keep EVERY sensor (not just temperature), classifying by the device's own
// `type` field when present (name heuristic otherwise) and capturing the alarm
// flag. Older FortiOS firmwares 404 this endpoint — caller swallows the failure.
async function collectHardwareSensorsFortinet(fg: FortiGateConfig, timeoutMs?: number): Promise<HardwareSensorSample[]> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/sensor-info", { timeoutMs });
  const list: HardwareSensorSample[] = [];
  const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
  for (const s of arr) {
    if (!s || typeof s !== "object") continue;
    const obj  = s as Record<string, unknown>;
    const name = String(obj.name || "").trim();
    if (!name) continue;
    const restType = obj.type != null ? String(obj.type) : null;
    const { sensorClass, unit } = classifyHardwareSensor(name, restType);
    const value = obj.value;
    const n = typeof value === "number" ? value : (typeof value === "string" ? Number(value) : NaN);
    list.push({
      sensorName:  name,
      sensorClass,
      value:       Number.isFinite(n) ? Math.round((n as number) * 1000) / 1000 : null,
      unit,
      alarmStatus: normalizeRestAlarmStatus(obj.alarm ?? obj.alarm_status ?? obj.status),
    });
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
  opts: { includeIpsec?: boolean; includeLldp?: boolean; includeSdwan?: boolean; timeoutMs?: number } = {},
): Promise<SystemInfoSample> {
  const fg = buildFortinetConfig(host, integration);
  if ("error" in fg) throw new AppError(409, fg.error);
  const timeoutMs = opts.timeoutMs;

  // Fan out every independent FortiOS REST call in parallel. The merge logic
  // (cmdb + monitor → interfaces[]) only depends on both responses being
  // available, not on serial ordering of the requests. Sequencing them used
  // to make a healthy host's collection 5× longer than necessary; on a
  // wedged host it stacked their 15s timeouts (~75s total) instead of
  // running them concurrently (~15s).
  //
  // Per-stream error handling is preserved: cmdb fetch returns null on any
  // failure (token without cmdb scope is the common case), ipsec and lldp
  // each have their own .catch fallback, and the monitor-interface error
  // is captured and only re-thrown if it would have ended up with an empty
  // interfaces[] (matching the prior behavior where monitor failure with
  // no interfaces threw, but partial success returned).
  const endCmdb = startPhase("systeminfo.rest.cmdb_interface");
  const cmdbInterfacePromise = fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/interface", { query: { vdom: "root" }, timeoutMs })
    .catch(() => null as any)
    .then((res) => { endCmdb({ ok: res != null }); return res; });
  const endMonitorIf = startPhase("systeminfo.rest.monitor_interface");
  const monitorInterfacePromise = fgRequest<any>(fg, "GET", "/api/v2/monitor/system/interface", {
    query: { scope: "vdom", include_vlan: "true", include_aggregate: "true" },
    timeoutMs,
  })
    .then((res) => { endMonitorIf({ ok: true }); return { ok: true as const, res }; })
    .catch((err) => { endMonitorIf({ ok: false }); return { ok: false as const, err }; });
  const ipsecPromise = opts.includeIpsec
    ? (() => {
        const endIpsec = startPhase("systeminfo.rest.ipsec");
        return collectIpsecTunnelsFortinet(fg, timeoutMs)
          .catch(() => [] as IpsecTunnelSample[])
          .then((tunnels) => { endIpsec({ tunnels: tunnels.length }); return tunnels; });
      })()
    : Promise.resolve<IpsecTunnelSample[] | undefined>(undefined);
  const lldpPromise = opts.includeLldp !== false
    ? (() => {
        const endLldp = startPhase("systeminfo.rest.lldp");
        return collectLldpNeighborsFortinet(fg, timeoutMs)
          .catch(() => undefined)
          .then((neighbors) => { endLldp({ neighbors: neighbors?.length ?? null }); return neighbors; });
      })()
    : Promise.resolve<LldpNeighborSample[] | undefined>(undefined);
  const sdwanPromise = opts.includeSdwan
    ? (() => {
        const endSdwan = startPhase("systeminfo.rest.sdwan");
        return collectSdwanFortinet(fg, timeoutMs)
          .catch(() => ({ perfSla: [] as PerfSlaSample[], sdwanRules: [] as SdwanRuleSample[] }))
          .then((sdwan) => { endSdwan({ perfSla: sdwan.perfSla.length, rules: sdwan.sdwanRules.length }); return sdwan; });
      })()
    : Promise.resolve<{ perfSla: PerfSlaSample[]; sdwanRules: SdwanRuleSample[] } | undefined>(undefined);

  const [cmdbRes, monitorOutcome, ipsecTunnels, lldpNeighbors, sdwan] = await Promise.all([
    cmdbInterfacePromise,
    monitorInterfacePromise,
    ipsecPromise,
    lldpPromise,
    sdwanPromise,
  ]);

  // Build cmdbByName from the CMDB response. Non-fatal failure → empty map
  // → falls back to monitor-only types (same as the original try/catch).
  const cmdbByName = new Map<string, { type: string | null; parent: string | null; vlanId: number | null; members: string[]; alias: string | null; description: string | null; addressingMode: string | null }>();
  // FortiLink-enabled interface set (fortilink-flagged interfaces + their member
  // ports) from the same CMDB response — fed back to the caller so the LLDP
  // exclusion filter can drop FortiLink links without a second CMDB fetch.
  const fortilinkInterfaces = [...fortilinkInterfaceNamesFromCmdb(cmdbRes)];
  if (cmdbRes) {
    const arr = Array.isArray(cmdbRes) ? cmdbRes : (Array.isArray(cmdbRes?.results) ? cmdbRes.results : []);
    for (const c of arr) {
      if (!c || typeof c !== "object" || typeof c.name !== "string") continue;
      const t = typeof c.type === "string" ? c.type : null;
      // CMDB `member` is an array of { "interface-name": "<port>" } entries on
      // aggregate and hard-switch / vap-switch interfaces. The FortiOS REST
      // envelope returns the key with a hyphen — the JS-friendly underscore
      // form (`interface_name`) doesn't exist, and accessing it would silently
      // yield undefined, collapsing the members list to empty. `q_origin_key`
      // duplicates the value for the table's primary key, so it's a reliable
      // fallback when a firmware variant drops `interface-name`.
      const members: string[] = Array.isArray(c.member)
        ? c.member.map((m: any) => {
            if (typeof m === "string") return m;
            if (m && typeof m === "object") {
              if (typeof m["interface-name"] === "string") return m["interface-name"];
              if (typeof m.q_origin_key  === "string") return m.q_origin_key;
              if (typeof m.interface_name === "string") return m.interface_name;
            }
            return null;
          }).filter(Boolean)
        : [];
      const alias       = typeof c.alias       === "string" && c.alias.trim()       ? c.alias.trim()       : null;
      const description = typeof c.description === "string" && c.description.trim() ? c.description.trim() : null;
      // L3 addressing mode — CMDB `mode` is "static" | "dhcp" | "pppoe". Keep
      // only known values so a firmware-specific surprise doesn't leak into the
      // UI; anything else (or absent) leaves addressingMode null.
      const rawMode = typeof c.mode === "string" ? c.mode.trim().toLowerCase() : "";
      const addressingMode = (rawMode === "static" || rawMode === "dhcp" || rawMode === "pppoe") ? rawMode : null;
      cmdbByName.set(c.name, {
        type:    t,
        parent:  t === "vlan" && typeof c.interface === "string" ? c.interface : null,
        vlanId:  t === "vlan" && typeof c.vlanid === "number" ? c.vlanid : null,
        members,
        alias,
        description,
        addressingMode,
      });
    }
  }

  const interfaces: InterfaceSample[] = [];
  if (monitorOutcome.ok) {
    const res = monitorOutcome.res;
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
        alias:       cmdbEntry?.alias       ?? null,
        description: cmdbEntry?.description ?? null,
        addressingMode: cmdbEntry?.addressingMode ?? null,
      });
    }
    // Back-fill ifParent on member ports of aggregate / hard-switch /
    // vap-switch interfaces. CMDB carries the canonical `member` array; we
    // also accept the monitor-side `member` array as a fallback.
    //
    // Member ports owned by an aggregate (the `set members "port15" "port16"`
    // ports under FortiLink) are typically *omitted* from the monitor
    // endpoint — FortiOS treats them as subordinate to the aggregate and
    // doesn't surface them as standalone interfaces. CMDB still lists them.
    // For those, synthesize a row from CMDB metadata so the System tab tree
    // can render them nested under their aggregate; runtime fields stay null
    // because the monitor endpoint never returned counters for them.
    const ifMap = new Map(interfaces.map((s) => [s.ifName, s]));
    for (const iface of interfaces.slice()) {
      if (iface.ifType !== "aggregate") continue;
      const cmdbEntry = cmdbByName.get(iface.ifName);
      const monitorEntry = obj[iface.ifName] as any;
      const members =
        cmdbEntry?.members.length ? cmdbEntry.members :
        Array.isArray(monitorEntry?.member) ? monitorEntry.member.map(String) : [];
      for (const memberName of members) {
        const memberStr = String(memberName);
        const existing = ifMap.get(memberStr);
        if (existing) {
          if (!existing.ifParent) existing.ifParent = iface.ifName;
          continue;
        }
        const memberCmdb = cmdbByName.get(memberStr);
        const synthetic: InterfaceSample = {
          ifName:      memberStr,
          adminStatus: null,
          operStatus:  null,
          speedBps:    null,
          ipAddress:   null,
          macAddress:  null,
          inOctets:    null,
          outOctets:   null,
          inErrors:    null,
          outErrors:   null,
          ifType:      memberCmdb?.type ? normalizeFortiIfType(memberCmdb.type) : "physical",
          ifParent:    iface.ifName,
          vlanId:      memberCmdb?.vlanId ?? null,
          alias:       memberCmdb?.alias ?? null,
          description: memberCmdb?.description ?? null,
        };
        interfaces.push(synthetic);
        ifMap.set(memberStr, synthetic);
      }
    }
  } else if (interfaces.length === 0) {
    // Monitor failed AND we have no interfaces from the (also-failing) cmdb
    // synthesis path — re-throw the original error to match the prior
    // semantics. Partial success returns whatever we managed to merge.
    throw monitorOutcome.err;
  }
  applyFortiInterfaceFilter(interfaces, integration);
  // ipsecTunnels: best-effort, already resolved above. Older FortiOS
  // firmwares 404 the endpoint and FortiGates without IPsec configured
  // return an empty list — either way the System tab just hides the
  // section. Skipped entirely on the fast (per-minute) cadence so we
  // don't hammer the endpoint.
  //
  // lldpNeighbors: also best-effort. FortiOS 6.4+ exposes the per-interface
  // neighbor list; older firmwares 404 it. An empty array is "queried
  // successfully, no neighbors" → persist layer wipes stale rows. A
  // genuine failure leaves `lldpNeighbors` undefined → persist layer
  // leaves existing rows alone. `includeLldp: false` lets the caller skip
  // this when the operator routed LLDP to SNMP; the caller overlays the
  // SNMP result onto the returned sample.
  return {
    interfaces, storage: [], ipsecTunnels, lldpNeighbors,
    lldpSource: opts.includeLldp !== false ? "fortios" : undefined,
    perfSla:    sdwan?.perfSla,
    sdwanRules: sdwan?.sdwanRules,
    fortilinkInterfaces,
  };
}

/**
 * Standalone FortiOS LLDP query for the cross-transport case (interfaces ride
 * SNMP but LLDP rides REST). Same wire format as collectLldpNeighborsFortinet
 * but builds its own FortiGateConfig from the integration so the caller
 * doesn't have to.
 */
export async function collectLldpOnlyFortinet(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  timeoutMs?: number,
): Promise<LldpNeighborSample[] | undefined> {
  const fg = buildFortinetConfig(host, integration);
  if ("error" in fg) throw new AppError(409, fg.error);
  return await collectLldpNeighborsFortinet(fg, timeoutMs).catch(() => undefined);
}

/**
 * FortiOS exposes LLDP neighbors at /api/v2/monitor/system/interface/lldp-neighbors.
 * The response shape is `{ results: [{ interface, chassis_id, port_id, ... }, …] }`.
 * Field names vary across versions (some firmwares use `local_intf` / `local_intf_name`
 * / `interface`; some use `port_desc` / `port_description`; capabilities show up
 * either as a CSV string or an array). Be defensive about every field.
 */
async function collectLldpNeighborsFortinet(fg: FortiGateConfig, timeoutMs?: number): Promise<LldpNeighborSample[]> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/interface/lldp-neighbors", { query: { vdom: "root" }, timeoutMs });
  const arr = Array.isArray(res?.results) ? res.results : (Array.isArray(res) ? res : []);
  const out: LldpNeighborSample[] = [];
  for (const n of arr) {
    if (!n || typeof n !== "object") continue;
    const r = n as Record<string, unknown>;
    const localIfName = pickFortiString(r["local_intf"], r["local_intf_name"], r["interface"], r["local_interface"]);
    if (!localIfName) continue;
    // Some FortiOS releases pack management addresses as an array, others as a
    // comma-separated string. Pull the first IPv4 we can find.
    let mgmt: string | null = null;
    const mgmtRaw = r["management_addresses"] ?? r["management_address"] ?? r["mgmt_addr"];
    if (Array.isArray(mgmtRaw)) {
      for (const m of mgmtRaw) {
        if (typeof m === "string" && m) { mgmt = m; break; }
        if (m && typeof m === "object") {
          const a = (m as any).address ?? (m as any).ip ?? (m as any).addr;
          if (typeof a === "string" && a) { mgmt = a; break; }
        }
      }
    } else if (typeof mgmtRaw === "string" && mgmtRaw) {
      mgmt = mgmtRaw.split(",")[0]!.trim() || null;
    }
    out.push({
      localIfName,
      chassisIdSubtype:  pickFortiString(r["chassis_id_subtype"], r["chassis_subtype"]),
      chassisId:         pickFortiString(r["chassis_id"]),
      portIdSubtype:     pickFortiString(r["port_id_subtype"], r["port_subtype"]),
      portId:            pickFortiString(r["port_id"]),
      portDescription:   pickFortiString(r["port_description"], r["port_desc"]),
      systemName:        pickFortiString(r["system_name"], r["sys_name"]),
      systemDescription: pickFortiString(r["system_description"], r["sys_desc"]),
      managementIp:      mgmt,
      capabilities:      pickFortiCapabilities(r["enabled_capabilities"] ?? r["system_capabilities"]),
    });
  }
  return out;
}

function pickFortiString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) return t;
    }
  }
  return null;
}

function pickFortiCapabilities(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim().toLowerCase()).filter((s) => s.length > 0);
  }
  if (typeof raw === "string") {
    return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  }
  return [];
}

/**
 * FortiLink-enabled interface names from a CMDB `/api/v2/cmdb/system/interface`
 * response: every interface whose `fortilink` setting is enabled, PLUS the
 * member ports of those interfaces (FortiLink is an aggregate; its members are
 * the physical ports — e.g. the `fortilink` aggregate and member `a`). This is
 * the authoritative definition of a "FortiLink interface" (the CMDB flag), not
 * a name heuristic. Used to exclude FortiLink links from LLDP collection when
 * the integration's `excludeFortilinkLldp` toggle is on. Pure + defensive about
 * the FortiOS member-array shape (same `interface-name` / `q_origin_key`
 * fallback chain collectSystemInfoFortinet uses).
 */
export function fortilinkInterfaceNamesFromCmdb(cmdbRes: unknown): Set<string> {
  const out = new Set<string>();
  const arr = Array.isArray(cmdbRes)
    ? cmdbRes
    : (Array.isArray((cmdbRes as any)?.results) ? (cmdbRes as any).results : []);
  for (const c of arr) {
    if (!c || typeof c !== "object" || typeof (c as any).name !== "string") continue;
    const fl = (c as any).fortilink;
    if (!(fl === "enable" || fl === true || fl === 1)) continue;
    out.add((c as any).name);
    const member = (c as any).member;
    if (Array.isArray(member)) {
      for (const m of member) {
        if (typeof m === "string") { if (m) out.add(m); continue; }
        if (m && typeof m === "object") {
          const v = (m as any)["interface-name"] ?? (m as any).q_origin_key ?? (m as any).interface_name;
          if (typeof v === "string" && v) out.add(v);
        }
      }
    }
  }
  return out;
}

/**
 * Fetch the FortiLink-enabled interface set directly from CMDB. Used on the
 * SNMP-interfaces path (which doesn't otherwise fetch CMDB) when the operator
 * has `excludeFortilinkLldp` on — one extra REST call, gated behind the toggle.
 * Returns an empty set on any failure (e.g. a token without CMDB scope), so a
 * failure degrades to "collect all LLDP" rather than dropping neighbors.
 */
async function fetchFortilinkInterfaceSet(fg: FortiGateConfig, timeoutMs?: number): Promise<Set<string>> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/interface", { query: { vdom: "root" }, timeoutMs })
    .catch(() => null as any);
  return fortilinkInterfaceNamesFromCmdb(res);
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
async function collectIpsecTunnelsFortinet(fg: FortiGateConfig, timeoutMs?: number): Promise<IpsecTunnelSample[]> {
  // Build a tunnel→{interface,type} map up front from the CMDB so each sample
  // can carry the parent interface (the FortiOS CLI `set interface` value
  // under `config vpn ipsec phase1-interface`) and the phase-1 type. The
  // System tab uses parentInterface to nest tunnel rows under their parent in
  // the Interfaces table; type lets dial-up server templates report status
  // "dynamic" instead of rolling phase-2 selectors up to "down" when no
  // client happens to be connected at scrape time. Best-effort: tokens
  // without cmdb scope just leave both null on every row.
  // CMDB phase1 + monitor /vpn/ipsec are independent on the wire — fire them
  // in parallel and merge below. CMDB failure (token without cmdb scope) is
  // non-fatal and just leaves phase1Map empty so parentInterface / type are
  // null on every row, matching the prior behavior.
  const [cmdbResult, res] = await Promise.all([
    fgRequest<any>(fg, "GET", "/api/v2/cmdb/vpn.ipsec/phase1-interface", { query: { vdom: "root" }, timeoutMs })
      .catch(() => null as any),
    fgRequest<any>(fg, "GET", "/api/v2/monitor/vpn/ipsec", { query: { scope: "vdom" }, timeoutMs }),
  ]);

  const phase1Map = new Map<string, { iface: string | null; type: string | null }>();
  if (cmdbResult) {
    const cmdbArr = Array.isArray(cmdbResult?.results) ? cmdbResult.results : (Array.isArray(cmdbResult) ? cmdbResult : []);
    for (const p of cmdbArr) {
      if (!p || typeof p !== "object") continue;
      const name  = typeof (p as any).name      === "string" ? (p as any).name.trim()      : "";
      const iface = typeof (p as any).interface === "string" ? (p as any).interface.trim() : "";
      const type  = typeof (p as any).type      === "string" ? (p as any).type.trim().toLowerCase() : "";
      if (name) phase1Map.set(name, { iface: iface || null, type: type || null });
    }
  }
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
    const phase1 = phase1Map.get(name) ?? null;
    let status: "up" | "down" | "partial" | "dynamic";
    if (phase1?.type === "dynamic") {
      // Dial-up server template — accepts connections from dynamic peers, so
      // "up/down" against a single rollup is misleading. Phase-2 children of
      // active sessions appear as separate entries with `parent` set and are
      // already filtered out above.
      status = "dynamic";
    } else if (proxyArr.length === 0) {
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
      tunnelName:      name,
      parentInterface: phase1?.iface ?? null,
      remoteGateway:   typeof rgwy === "string" && rgwy ? rgwy : null,
      status,
      incomingBytes:   anyBytes ? inBytes  : null,
      outgoingBytes:   anyBytes ? outBytes : null,
      proxyIdCount:    proxyArr.length || null,
    });
  }
  return out;
}

/** Normalize a FortiOS SD-WAN member liveness value to "up"/"down". FortiOS
 *  health-check members report "alive"/"dead" on some versions, "up"/"down"
 *  or a numeric/boolean flag on others. */
function normalizeSdwanState(v: unknown): "up" | "down" {
  if (typeof v === "number")  return v > 0 ? "up" : "down";
  if (typeof v === "boolean") return v ? "up" : "down";
  const s = String(v ?? "").trim().toLowerCase();
  return s === "up" || s === "alive" || s === "1" || s === "true" ? "up" : "down";
}

/**
 * SD-WAN collector (FortiOS only; gated by Integration.config.pullSdwan, rides
 * the system-info cadence). Pulls two things in parallel:
 *   - Performance SLA health-check readings (/api/v2/monitor/virtual-wan/health-check):
 *     one PerfSlaSample per (health-check, WAN member) with latency/jitter/
 *     packet-loss gauges + link state.
 *   - SD-WAN service rules (/api/v2/cmdb/system/sdwan → `service`): each rule's
 *     mode + configured candidate members in priority order (seq-nums resolved
 *     to interface names via the global `members` table).
 *
 * The runtime selected member is INFERRED best-effort: the first candidate (in
 * priority order) that is up per the health-check data. FortiOS exposes no clean
 * REST endpoint for per-rule member selection, so `selectedMember` is null when
 * it can't be resolved (no health-check data covering the candidates). This is
 * good enough for sla / priority modes; load-balance spreads traffic so the
 * inferred "selected" is only the top healthy member — the UI shows `mode` so
 * the operator has context.
 *
 * Each sub-fetch degrades independently (one failing → [] for that half), like
 * collectIpsecTunnelsFortinet's CMDB-optional handling. Older firmwares 404 the
 * endpoints → empty result → the SD-WAN tab just hides the section.
 *
 * NOTE (verify on a real FortiOS 7.x device): the health-check JSON shape, the
 * member-state field name (status vs state; "up"/"alive"/numeric), and the CMDB
 * service member-reference shape (members[].seq-num vs priority-members) vary by
 * version — the parsing here is defensive but should be confirmed.
 */
async function collectSdwanFortinet(
  fg: FortiGateConfig,
  timeoutMs?: number,
): Promise<{ perfSla: PerfSlaSample[]; sdwanRules: SdwanRuleSample[] }> {
  const [hcRes, sdwanRes] = await Promise.all([
    fgRequest<any>(fg, "GET", "/api/v2/monitor/virtual-wan/health-check", { query: { scope: "vdom" }, timeoutMs })
      .catch(() => null as any),
    fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/sdwan", { query: { vdom: "root" }, timeoutMs })
      .catch(() => null as any),
  ]);
  const thresholds = parseSdwanSlaThresholds(sdwanRes);
  const zones = parseSdwanMemberZones(sdwanRes);
  const { perfSla, memberUp } = parsePerfSlaHealthCheck(hcRes, thresholds, zones);
  const sdwanRules = parseSdwanRules(sdwanRes, memberUp, zones);
  return { perfSla, sdwanRules };
}

/**
 * Build a member-interface → SD-WAN zone map from the CMDB system/sdwan
 * `members[]` (each carries `interface` + `zone`, e.g. "virtual-wan-link" /
 * "overlay"). Used to label Performance-SLA members by zone. Exported for unit
 * testing; pure.
 */
export function parseSdwanMemberZones(sdwanRes: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const root = (sdwanRes && typeof sdwanRes === "object" && (sdwanRes as any).results && typeof (sdwanRes as any).results === "object")
    ? (sdwanRes as any).results
    : sdwanRes;
  if (!root || typeof root !== "object") return out;
  const members = Array.isArray((root as any).members) ? (root as any).members : [];
  for (const m of members) {
    if (!m || typeof m !== "object") continue;
    const iface = typeof (m as any).interface === "string" ? (m as any).interface.trim() : "";
    const zone  = typeof (m as any).zone === "string" ? (m as any).zone.trim() : "";
    if (iface && zone && !out.has(iface)) out.set(iface, zone);
  }
  return out;
}

export interface SlaThreshold { latencyMs: number | null; jitterMs: number | null; packetLoss: number | null; }

/**
 * Build a healthCheck-name → SLA threshold map from the CMDB system/sdwan
 * `health-check[].sla` targets. FortiOS allows multiple SLA rows per
 * health-check; we take the max configured threshold per metric (a member
 * passes the strictest target). A 0 / absent threshold means "unset" for that
 * metric → null (no chart line).
 *
 * Each SLA row carries thresholds for ALL three metrics regardless of which are
 * actually enforced — FortiOS keeps a default `jitter-threshold` of 5ms even
 * when jitter isn't part of the SLA. The `link-cost-factor` field on the SLA
 * row names the metrics the SLA actually measures (`latency` / `jitter` /
 * `packet-loss`); a threshold for a metric NOT listed there is a disabled SLA
 * and must not surface as a chart line. We only take a metric's threshold when
 * its link-cost-factor token is present. Older FortiOS that omits the field
 * (null/empty) falls back to "all metrics enabled" so existing installs are
 * unaffected. Exported for unit testing; pure.
 */
export function parseSdwanSlaThresholds(sdwanRes: unknown): Map<string, SlaThreshold> {
  const out = new Map<string, SlaThreshold>();
  const root = (sdwanRes && typeof sdwanRes === "object" && (sdwanRes as any).results && typeof (sdwanRes as any).results === "object")
    ? (sdwanRes as any).results
    : sdwanRes;
  if (!root || typeof root !== "object") return out;
  const hcs = Array.isArray((root as any)["health-check"]) ? (root as any)["health-check"] : [];
  for (const hc of hcs) {
    if (!hc || typeof hc !== "object") continue;
    const name = typeof (hc as any).name === "string" ? (hc as any).name.trim() : "";
    if (!name) continue;
    const slas = Array.isArray((hc as any).sla) ? (hc as any).sla : [];
    let lat: number | null = null, jit: number | null = null, loss: number | null = null;
    const take = (cur: number | null, raw: unknown): number | null => {
      const n = pickFiniteNumber(raw);
      if (n == null || n <= 0) return cur;
      return cur == null ? n : Math.max(cur, n);
    };
    for (const sla of slas) {
      if (!sla || typeof sla !== "object") continue;
      const factors = parseSlaLinkCostFactors((sla as any)["link-cost-factor"]);
      // factors == null → field absent/empty → treat all metrics as enabled.
      const on = (...names: string[]) => factors == null || names.some((n) => factors.has(n));
      if (on("latency"))                    lat  = take(lat,  (sla as any)["latency-threshold"]);
      if (on("jitter"))                     jit  = take(jit,  (sla as any)["jitter-threshold"]);
      if (on("packet-loss", "packetloss"))  loss = take(loss, (sla as any)["packetloss-threshold"]);
    }
    out.set(name, { latencyMs: lat, jitterMs: jit, packetLoss: loss });
  }
  return out;
}

/** Parse a FortiOS SLA-target `link-cost-factor` field into the set of metric
 *  tokens the SLA enforces. May arrive as a space/comma-separated string
 *  ("latency packet-loss") or an array of tokens. Returns null when the field
 *  is absent/empty so callers can fall back to "all metrics enabled" for older
 *  FortiOS that omits it. */
function parseSlaLinkCostFactors(raw: unknown): Set<string> | null {
  const tokens: string[] = [];
  if (Array.isArray(raw)) {
    for (const t of raw) if (typeof t === "string" && t.trim()) tokens.push(t.trim().toLowerCase());
  } else if (typeof raw === "string" && raw.trim()) {
    for (const t of raw.trim().toLowerCase().split(/[\s,]+/)) if (t) tokens.push(t);
  }
  return tokens.length ? new Set(tokens) : null;
}

/**
 * Parse a /api/v2/monitor/virtual-wan/health-check response into PerfSlaSamples.
 * Response shape: { results: { "<hc-name>": { "<member-iface>": { latency,
 * jitter, packet_loss, status, ... }, ... }, ... } } (also accepts the
 * un-enveloped object). Returns the samples plus a member-interface → up map
 * (true if the member is up in ANY health-check) used to infer rule selection.
 * Exported for unit testing; pure (no I/O).
 */
export function parsePerfSlaHealthCheck(
  hcRes: unknown,
  thresholds?: Map<string, SlaThreshold>,
  zones?: Map<string, string>,
): { perfSla: PerfSlaSample[]; memberUp: Map<string, boolean> } {
  const perfSla: PerfSlaSample[] = [];
  const memberUp = new Map<string, boolean>();
  const hcRoot = (hcRes && typeof hcRes === "object" && (hcRes as any).results && typeof (hcRes as any).results === "object")
    ? (hcRes as any).results
    : hcRes;
  if (hcRoot && typeof hcRoot === "object") {
    for (const [hcName, members] of Object.entries(hcRoot as Record<string, any>)) {
      if (!hcName || !members || typeof members !== "object") continue;
      const thr = thresholds?.get(hcName) ?? null;
      for (const [link, m] of Object.entries(members as Record<string, any>)) {
        if (!link || !m || typeof m !== "object") continue;
        const state = normalizeSdwanState((m as any).status ?? (m as any).state ?? (m as any).alive);
        const latencyMs  = pickFiniteNumber((m as any).latency);
        const jitterMs   = pickFiniteNumber((m as any).jitter);
        const packetLoss = pickFiniteNumber((m as any).packet_loss ?? (m as any).packetloss);
        perfSla.push({
          healthCheck: hcName, link, zone: zones?.get(link) ?? null, state, latencyMs, jitterMs, packetLoss,
          latencyThresholdMs:  thr?.latencyMs ?? null,
          jitterThresholdMs:   thr?.jitterMs ?? null,
          packetLossThreshold: thr?.packetLoss ?? null,
        });
        if (state === "up") memberUp.set(link, true);
        else if (!memberUp.has(link)) memberUp.set(link, false);
      }
    }
  }
  return { perfSla, memberUp };
}

/**
 * Parse a /api/v2/cmdb/system/sdwan response into SdwanRuleSamples. `config
 * system sdwan` is a single complex object carrying a global `members` array
 * (seq-num → interface) and a `service` array of the SD-WAN rules. The runtime
 * selected member is inferred from `memberUp` (first candidate in priority order
 * that is up); null when none resolvable. Rules configured for zone-based
 * selection (`priority-zone`) carry no interface members — their candidates are
 * resolved from `memberZones` (interface → zone, from parseSdwanMemberZones)
 * preserving global-member priority order. Exported for unit testing; pure.
 */
export function parseSdwanRules(
  sdwanRes: unknown,
  memberUp: Map<string, boolean>,
  memberZones?: Map<string, string>,
): SdwanRuleSample[] {
  const sdwanRules: SdwanRuleSample[] = [];
  const sdwanRoot = (sdwanRes && typeof sdwanRes === "object" && (sdwanRes as any).results && typeof (sdwanRes as any).results === "object")
    ? (sdwanRes as any).results
    : sdwanRes;
  if (!sdwanRoot || typeof sdwanRoot !== "object") return sdwanRules;
  const seqToIface = new Map<string, string>();
  // Ordered interface list in global-member (= priority) order, used to resolve
  // a zone into its member interfaces for zone-preference rules.
  const orderedIfaces: string[] = [];
  const globalMembers = Array.isArray((sdwanRoot as any).members) ? (sdwanRoot as any).members : [];
  for (const gm of globalMembers) {
    if (!gm || typeof gm !== "object") continue;
    const seq   = (gm as any)["seq-num"] ?? (gm as any).seq_num;
    const iface = typeof (gm as any).interface === "string" ? (gm as any).interface.trim() : "";
    if (seq != null && iface) seqToIface.set(String(seq), iface);
    if (iface && !orderedIfaces.includes(iface)) orderedIfaces.push(iface);
  }
  // zone → member interfaces in priority order (built from the interface→zone
  // map + global-member ordering above).
  const zoneToIfaces = new Map<string, string[]>();
  if (memberZones) {
    for (const iface of orderedIfaces) {
      const zone = memberZones.get(iface);
      if (!zone) continue;
      const list = zoneToIfaces.get(zone) ?? [];
      if (!list.includes(iface)) list.push(iface);
      zoneToIfaces.set(zone, list);
    }
  }
  const services = Array.isArray((sdwanRoot as any).service) ? (sdwanRoot as any).service : [];
  services.forEach((svc: any, seqIdx: number) => {
    if (!svc || typeof svc !== "object") return;
    const ruleName = typeof svc.name === "string" && svc.name.trim()
      ? svc.name.trim()
      : (svc.id != null ? `rule-${svc.id}` : "");
    if (!ruleName) return;
    const ruleId = svc.id != null ? String(svc.id) : null;
    const mode = typeof svc.mode === "string" && svc.mode.trim() ? svc.mode.trim() : null;
    const enabled = svc.status == null ? null : (String(svc.status).toLowerCase() === "enable" || svc.status === true);
    const criteria = deriveSdwanCriteria(svc);
    const healthChecks = collectSdwanNameList(svc["health-check"]);
    // Destination can come from address objects + Internet-Service (ISDB) +
    // application-control entries — gather names from all the common fields.
    const dst = ([] as string[]).concat(
      collectSdwanNameList(svc.dst),
      collectSdwanNameList(svc["internet-service-name"]),
      collectSdwanNameList(svc["internet-service-custom"]),
      collectSdwanNameList(svc["internet-service-app-ctrl"]),
      collectSdwanNameList(svc["internet-service-app-ctrl-group"]),
    ).filter((v, i, arr) => v && arr.indexOf(v) === i);
    // Candidate members in priority order. FortiOS uses `members` (array of
    // { seq-num }) on most versions; some use `priority-members`. Resolve each
    // seq-num to its interface via the global members table; accept a literal
    // interface string as a fallback.
    const rawMembers =
      Array.isArray(svc.members)            ? svc.members :
      Array.isArray(svc["priority-members"]) ? svc["priority-members"] : [];
    const availableMembers: string[] = [];
    for (const rm of rawMembers) {
      let iface: string | null = null;
      if (typeof rm === "string") iface = rm.trim() || null;
      else if (rm && typeof rm === "object") {
        const seq = (rm as any)["seq-num"] ?? (rm as any).seq_num;
        if (seq != null && seqToIface.has(String(seq))) iface = seqToIface.get(String(seq))!;
        else if (typeof (rm as any).interface === "string") iface = (rm as any).interface.trim() || null;
      }
      if (iface && !availableMembers.includes(iface)) availableMembers.push(iface);
    }
    // Zone-based selection: FortiOS puts the preference in `priority-zone`
    // (zone names in priority order) and leaves the interface-member arrays
    // empty. When that's the case, expand each preferred zone into its member
    // interfaces (global-member priority order) so the rule still reports
    // candidates — without this the Members column renders empty.
    const priorityZones = collectSdwanNameList(svc["priority-zone"]);
    if (availableMembers.length === 0 && priorityZones.length > 0) {
      for (const zone of priorityZones) {
        for (const iface of zoneToIfaces.get(zone) ?? []) {
          if (!availableMembers.includes(iface)) availableMembers.push(iface);
        }
      }
    }
    let selectedMember: string | null = null;
    for (const m of availableMembers) {
      if (memberUp.get(m) === true) { selectedMember = m; break; }
    }
    const status: "up" | "down" = selectedMember ? "up" : "down";
    sdwanRules.push({
      ruleName, ruleId, seq: seqIdx, enabled, mode, criteria, healthChecks, dst,
      status, selectedMember, availableMembers, priorityZones,
    });
  });
  return sdwanRules;
}

/** Collect a list of names from a FortiOS CMDB reference field, which may be
 *  an array of { name } objects, an array of strings, or a single string. */
function collectSdwanNameList(raw: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === "string" && v.trim()) out.push(v.trim()); };
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (typeof e === "string") push(e);
      else if (e && typeof e === "object") push((e as any).name ?? (e as any)["q_origin_key"]);
    }
  } else if (typeof raw === "string") {
    push(raw);
  }
  return out;
}

/** Best-effort operator-facing criteria label, mirroring the FortiGate GUI's
 *  "Criteria" column. Derived from the service rule's mode + link-cost-factor.
 *  FortiOS field shapes vary by version — verify on a real device. */
function deriveSdwanCriteria(svc: any): string | null {
  const lcf = typeof svc["link-cost-factor"] === "string" ? svc["link-cost-factor"].trim().toLowerCase() : "";
  const lcfLabel: Record<string, string> = {
    latency: "Latency",
    jitter: "Jitter",
    "packet-loss": "Packet Loss",
    inbandwidth: "Bandwidth (in)",
    outbandwidth: "Bandwidth (out)",
    bibandwidth: "Bandwidth",
    "custom-profile-1": "Customized Profile",
  };
  if (lcf && lcfLabel[lcf]) return lcfLabel[lcf];
  const mode = typeof svc.mode === "string" ? svc.mode.trim().toLowerCase() : "";
  if (mode === "load-balance") return "Source IP";
  if (mode === "manual")       return "Manual";
  if (mode === "priority")     return "Best Quality";
  if (mode === "sla")          return "SLA";
  return null;
}

function pickFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Wildcard match used by the FMG/FortiGate integration's interface filter.
 * Mirrors src/services/fortimanagerService.ts:matchesWildcard so the System
 * tab applies the exact rule discovery uses.
 */
/**
 * Apply the FMG/FortiGate integration's interfaceInclude / interfaceExclude
 * filter to a System-tab interface list, in-place. Same rule discovery uses
 * to decide which interfaces' IPs become reservations, so the System tab
 * mirrors discovery's scope on both REST and SNMP transports.
 *
 * VLAN sub-interfaces / aggregate members survive the filter when their
 * parent does — hiding the parent would orphan the children that do match.
 */
function applyFortiInterfaceFilter(
  interfaces: InterfaceSample[],
  integration: { config?: unknown } | null | undefined,
): void {
  const cfg = (integration?.config && typeof integration.config === "object")
    ? (integration.config as Record<string, unknown>)
    : {};
  const ifInclude = Array.isArray(cfg.interfaceInclude) ? (cfg.interfaceInclude as string[]) : [];
  const ifExclude = Array.isArray(cfg.interfaceExclude) ? (cfg.interfaceExclude as string[]) : [];
  if (ifInclude.length === 0 && ifExclude.length === 0) return;
  const allowed = (name: string): boolean => {
    if (ifInclude.length > 0) return ifInclude.some((p) => fortiInterfaceWildcardMatch(p, name));
    return !ifExclude.some((p) => fortiInterfaceWildcardMatch(p, name));
  };
  const survives = new Set<string>();
  for (const i of interfaces) if (allowed(i.ifName)) survives.add(i.ifName);
  for (const i of interfaces) {
    if (!survives.has(i.ifName) && i.ifParent && survives.has(i.ifParent)) survives.add(i.ifName);
  }
  for (let k = interfaces.length - 1; k >= 0; k--) {
    if (!survives.has(interfaces[k]!.ifName)) interfaces.splice(k, 1);
  }
}

function fortiInterfaceWildcardMatch(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return v.includes(p.slice(1, -1));
  if (p.startsWith("*")) return v.endsWith(p.slice(1));
  if (p.endsWith("*")) return v.startsWith(p.slice(0, -1));
  return v === p;
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
  ifAlias:        "1.3.6.1.2.1.31.1.1.1.18",
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
  // FORTINET-FORTIGATE-MIB::fgHwSensorTable. Branch-class FortiGates
  // (40F/60F/61F/91G/101F) don't populate ENTITY-SENSOR-MIB and 404 the
  // FortiOS REST sensor-info endpoint, but they do publish hardware sensors
  // here. The table mixes temperature, fan, voltage, and power sensors —
  // there is no type column, so callers classify by name. fgHwSensorEntValue
  // is a DisplayString carrying a decimal value (e.g. "44.5"); EntAlarmStatus
  // is an INTEGER (0 = no alarm, 1 = alarm).
  fgHwSensorEntName:        "1.3.6.1.4.1.12356.101.4.3.2.1.2",
  fgHwSensorEntValue:       "1.3.6.1.4.1.12356.101.4.3.2.1.3",
  fgHwSensorEntAlarmStatus: "1.3.6.1.4.1.12356.101.4.3.2.1.4",
  // LLDP-MIB (RFC 4957). lldpLocPortTable maps localPortNum → ifName/alias so
  // we can stitch lldpRemTable rows back to a real interface. lldpRemTable is
  // indexed by (timeMark, localPortNum, remIndex); we only care about the
  // last two halves, so callers strip the leading timeMark when keying. The
  // management-addr table is indexed by (timeMark, localPortNum, remIndex,
  // addrSubtype, addrLen, addr...) — same dance.
  lldpLocPortIdSubtype:    "1.0.8802.1.1.2.1.3.7.1.2",
  lldpLocPortId:           "1.0.8802.1.1.2.1.3.7.1.3",
  lldpLocPortDesc:         "1.0.8802.1.1.2.1.3.7.1.4",
  lldpRemChassisIdSubtype: "1.0.8802.1.1.2.1.4.1.1.4",
  lldpRemChassisId:        "1.0.8802.1.1.2.1.4.1.1.5",
  lldpRemPortIdSubtype:    "1.0.8802.1.1.2.1.4.1.1.6",
  lldpRemPortId:           "1.0.8802.1.1.2.1.4.1.1.7",
  lldpRemPortDesc:         "1.0.8802.1.1.2.1.4.1.1.8",
  lldpRemSysName:          "1.0.8802.1.1.2.1.4.1.1.9",
  lldpRemSysDesc:          "1.0.8802.1.1.2.1.4.1.1.10",
  lldpRemSysCapEnabled:    "1.0.8802.1.1.2.1.4.1.1.12",
  lldpRemManAddr:          "1.0.8802.1.1.2.1.4.2.1",
  // FORTINET-FORTIAP-MIB::fapStationTable — wireless clients connected to a
  // FortiAP. INDEX = { fapStaRadioId, fapStaWlanId, fapStaMacAddr } where the
  // MAC is encoded as length-prefixed 6 octets (SMIv2 default for OCTET
  // STRING in INDEX), so each row's suffix is 9 parts:
  //   <radioId>.<wlanId>.6.<b0>.<b1>.<b2>.<b3>.<b4>.<b5>
  // collectWirelessStationsSnmp walks fapStaSSID as the discriminator
  // (every row has it set), then looks up the parallel columns by the
  // identical suffix.
  fapStaBSSID:        "1.3.6.1.4.1.12356.120.8.1.1.4",
  fapStaVlanId:       "1.3.6.1.4.1.12356.120.8.1.1.5",
  fapStaIpAddr:       "1.3.6.1.4.1.12356.120.8.1.1.6",
  fapStaSSID:         "1.3.6.1.4.1.12356.120.8.1.1.7",
  // FORTINET-FORTIAP-MIB::fapRadioTable (1.3.6.1.4.1.12356.120.4.1.1), INDEX =
  // { fapRadioIndex }. There is no band column, so we derive band per radio
  // from fapRadioType + fapRadioChannelOper (see utils/fortiapRadioBand) and
  // join it onto stations by radioId == fapRadioIndex.
  fapRadioType:        "1.3.6.1.4.1.12356.120.4.1.1.6",
  fapRadioChannelOper: "1.3.6.1.4.1.12356.120.4.1.1.14",
};

function buildSnmpSession(host: string, config: Record<string, unknown>, timeoutMs?: number): any {
  const port = toPositiveInt(config.port, 161);
  const version = config.version === "v3" ? "v3" : "v2c";
  // Caller-supplied timeout (resolved from the per-stream tier hierarchy)
  // overrides the legacy floor — but only when positive. A 0 or negative
  // value would silently disable timeouts in net-snmp, so we treat anything
  // unreasonable as "use the floor".
  const effectiveTimeout = (typeof timeoutMs === "number" && timeoutMs > 0)
    ? timeoutMs
    : COLLECTOR_REQUEST_TIMEOUT_MS;
  if (version === "v2c") {
    return snmp.createSession(host, String(config.community || ""), {
      port,
      version: snmp.Version2c,
      timeout: effectiveTimeout,
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
    timeout: effectiveTimeout,
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
  if (Buffer.isBuffer(v)) return v.toString("utf8").replace(/\u0000+$/, "");
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

async function withSnmpSession<T>(host: string, config: Record<string, unknown>, fn: (s: any) => Promise<T>, timeoutMs?: number, gateWaitTimeoutMs?: number): Promise<T> {
  // Route every heavy SNMP collector (telemetry / systemInfo / LLDP overlay
  // / operator snmp-walk) through the per-host SNMP gate so a heavy walk
  // doesn't overlap with the cheap response-time probe on the same agent.
  // probeSnmp (which builds its own session for the sysUpTime get) also
  // acquires the same gate — both paths key on host:port so they FIFO.
  const port = toPositiveInt(config.port, 161);
  return withSnmpGate(host, port, async () => {
    const session = buildSnmpSession(host, config, timeoutMs);
    // net-snmp emits 'error' rather than throwing for socket/listener errors;
    // attach a no-op listener so a stray error doesn't kill the process. The
    // walk itself will still propagate the error through its callback.
    session.on?.("error", () => {});
    try {
      return await fn(session);
    } finally {
      try { session.close?.(); } catch {}
    }
  }, gateWaitTimeoutMs);
}

export interface SnmpWalkRow {
  oid: string;
  type: string;
  value: string;
}

export interface SnmpWalkResult {
  rows: SnmpWalkRow[];
  truncated: boolean;
  durationMs: number;
}

/**
 * Operator-facing snmpwalk for the asset details SNMP Walk tab.
 *
 * Unlike the internal `snmpWalk()` above (which keys results by index suffix
 * and discards type info), this returns the full OID, the symbolic ASN.1 type
 * name (Counter32, OctetString, OID, ...), and a printable value. Hard-capped
 * at SNMP_WALK_HARD_MAX rows so an accidental walk of a huge subtree on a
 * busy device can't run away.
 */
const SNMP_WALK_HARD_MAX = 5000;

// Gate-wait budget for operator walks. The walk tab's client-side countdown
// aborts the request at 60s, so let the walk wait up to 50s for the per-host
// gate (vs. the collectors' 30s fail-fast default) — a walk queued behind a
// long telemetry/systemInfo scrape on the same device gets the whole
// countdown window to start instead of dying at 30s with a gate timeout.
const SNMP_WALK_GATE_WAIT_MS = 50_000;

function snmpTypeName(t: unknown): string {
  if (typeof t !== "number") return "Unknown";
  return (snmp.ObjectType as Record<number, string>)[t] || `Type(${t})`;
}

function snmpVarbindToPrintable(vb: { type: number; value: unknown }): string {
  const t = vb.type;
  const v = vb.value;
  if (v == null) return "";
  // OctetString: try utf8, fall back to hex when it isn't printable.
  if (Buffer.isBuffer(v)) {
    if (t === snmp.ObjectType.IpAddress && v.length === 4) {
      return `${v[0]}.${v[1]}.${v[2]}.${v[3]}`;
    }
    const text = v.toString("utf8");
    // eslint-disable-next-line no-control-regex
    if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) return text.replace(/ +$/, "");
    return v.toString("hex").match(/.{1,2}/g)?.join(" ").toUpperCase() || "";
  }
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

export async function snmpWalkRaw(
  host: string,
  config: Record<string, unknown>,
  baseOid: string,
  maxRows: number,
): Promise<SnmpWalkResult> {
  const cap = Math.max(1, Math.min(maxRows | 0, SNMP_WALK_HARD_MAX));
  const start = Date.now();
  return await withSnmpSession(host, config, (session) => {
    return new Promise<SnmpWalkResult>((resolve, reject) => {
      const rows: SnmpWalkRow[] = [];
      let truncated = false;
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve({ rows, truncated, durationMs: Date.now() - start });
      };
      try {
        session.subtree(
          baseOid,
          20, // maxRepetitions
          (varbinds: any[]) => {
            for (const vb of varbinds) {
              if (snmp.isVarbindError(vb)) continue;
              if (typeof vb.oid !== "string") continue;
              rows.push({
                oid: vb.oid,
                type: snmpTypeName(vb.type),
                value: snmpVarbindToPrintable(vb),
              });
              if (rows.length >= cap) {
                truncated = true;
                return finish();
              }
            }
          },
          (err?: Error) => finish(err),
        );
      } catch (err: any) {
        finish(err);
      }
    });
  }, undefined, SNMP_WALK_GATE_WAIT_MS);
}

// Per-asset metric resolution from the editable Manufacturer Profile.
// Walks the profile's per-model overrides in `order` and picks the first whose
// `modelPattern` regex matches `Asset.model`; falls back to the metric row's
// defaults. Returns null when the DB has no opinion — the caller then uses
// the hardcoded `VENDOR_TELEMETRY_PROFILES` entry unchanged.
//
// `type="double_scalar"` carries TWO OIDs (`symbol` + `symbolB`) and a
// `transform` that is a CombinerKind; the caller decides how to map that
// onto the runtime probe shape (memory walks both OIDs and computes a
// percent via the combiner's semantics).
interface DbMetricPick {
  symbol:    string | null;
  symbolB:   string | null;
  type:      "scalar" | "double_scalar" | "table";
  transform: string | null; // TransformKind on scalar/table; CombinerKind on double_scalar
}
function resolveDbMetric(metric: MetricRow | undefined, model: string | null | undefined): DbMetricPick | null {
  if (!metric) return null;
  const modelStr = model ?? "";
  for (const o of (metric.overrides || [])) {
    try {
      if (new RegExp(o.modelPattern, "i").test(modelStr)) {
        return {
          symbol:    o.symbol || null,
          symbolB:   o.symbolB ?? null,
          type:      o.type,
          transform: o.transform ?? null,
        };
      }
    } catch { /* malformed regex; skip — write-path validates so this is defensive only */ }
  }
  if (metric.defaultSymbol || metric.defaultSymbolB) {
    return {
      symbol:    metric.defaultSymbol ?? null,
      symbolB:   metric.defaultSymbolB ?? null,
      type:      metric.defaultType,
      transform: metric.defaultTransform ?? null,
    };
  }
  return null;
}

// Layer the editable Manufacturer Profile on top of the hardcoded vendor
// profile. The DB owns operator-edited symbols + per-model exceptions; when
// the DB has a non-null choice we swap the primary symbol on a CLONE of the
// hardcoded profile so the rest of the probe shape (walk-avg mode for
// Cisco, etc.) survives unchanged.
//
// Memory supports a richer Shape: when the DB row is `type="double_scalar"`
// (replaces the legacy memory-only `composition` blob), the combiner tells
// us which multi-OID memory shape to emit:
//   transform="a_over_b_as_percent"        → { usedBytesSymbol, totalBytesSymbol }
//   transform="a_over_a_plus_b_as_percent" → { usedBytesSymbol, freeBytesSymbol }
// `collectMemoryVendor` then walks both OIDs and computes the percent —
// matching what the hardcoded FortiSwitch baseline already does. Scalar
// memory rows fall back to the single-symbol pctSymbol shape.
//
// Returns the hardcoded profile unchanged when the DB cache hasn't loaded yet
// OR no matching DB profile exists.
function pickVendorProfileMerged(
  manufacturer: string | null | undefined,
  os: string | null | undefined,
  model: string | null | undefined,
): VendorTelemetryProfile | null {
  const base = pickVendorProfile(manufacturer, os, model);
  const dbProfile = getDbManufacturerProfile(manufacturer);
  if (!dbProfile) return base;

  // Pluck the three metric rows we currently consult during telemetry probes.
  const cpuRow         = dbProfile.metrics.find((m) => m.metricKey === ("cpu" as MetricKey));
  const memoryRow      = dbProfile.metrics.find((m) => m.metricKey === ("memory" as MetricKey));
  const temperatureRow = dbProfile.metrics.find((m) => m.metricKey === ("temperature" as MetricKey));

  const cpuPick  = resolveDbMetric(cpuRow,         model);
  const memPick  = resolveDbMetric(memoryRow,      model);
  const tempPick = resolveDbMetric(temperatureRow, model);

  // Nothing operator-overridden? Skip the clone allocation entirely.
  if (!cpuPick && !memPick && !tempPick) return base;

  // Clone shallowly so we can swap fields without mutating the shared
  // VENDOR_TELEMETRY_PROFILES array entry.
  const merged: VendorTelemetryProfile = base
    ? { ...base, cpu: base.cpu && { ...base.cpu }, memory: base.memory && { ...base.memory }, temperature: base.temperature && { ...base.temperature } }
    : { vendor: dbProfile.manufacturer, match: /__db_profile__/, cpu: undefined, memory: undefined, temperature: undefined };

  if (cpuPick && cpuPick.symbol) {
    merged.cpu = { symbol: cpuPick.symbol, mode: cpuPick.type === "table" ? "walk-avg" : "scalar" };
  }
  if (memPick) {
    if (memPick.type === "double_scalar" && memPick.symbol && memPick.symbolB) {
      // Map combiner → runtime memory shape. The runtime collector walks
      // both OIDs identically; only the field name signals which pair we're
      // dealing with (used+total vs used+free).
      if (memPick.transform === "a_over_b_as_percent") {
        merged.memory = {
          usedBytesSymbol:  memPick.symbol,
          totalBytesSymbol: memPick.symbolB,
          walkSubtree:      false,
        };
      } else if (memPick.transform === "a_over_a_plus_b_as_percent") {
        merged.memory = {
          usedBytesSymbol: memPick.symbol,
          freeBytesSymbol: memPick.symbolB,
          walkSubtree:     false,
        };
      }
      // Other combiners aren't memory-meaningful; fall through to base.
    } else if (memPick.type === "scalar" && memPick.symbol) {
      // Single-symbol percent path. walkSubtree is on for vendors whose
      // pctSymbol comes from a walked table (Juniper jnxOperatingBuffer,
      // Cisco ciscoMemoryPool*Free, etc.) — we infer that from the
      // hardcoded baseline since the DB row no longer carries walkSubtree.
      const baseWalk = base?.memory?.walkSubtree === true;
      merged.memory = { pctSymbol: memPick.symbol, walkSubtree: baseWalk };
    }
  }
  if (tempPick && tempPick.symbol) {
    // `table` makes the SNMP hardware-sensor collector walk the named sensor
    // table (e.g. fgHwSensorTable) instead of a single scalar GET — the
    // operator-facing "Hardware Sensors" metric. `scalar` keeps the
    // single-reading path (FortiAP fapTemperature).
    merged.temperature = { symbol: tempPick.symbol, mode: tempPick.type === "table" ? "table" : "scalar" };
  }
  return merged;
}

async function collectTelemetrySnmp(
  host: string,
  config: Record<string, unknown>,
  manufacturer?: string | null,
  model?: string | null,
  os?: string | null,
  timeoutMs?: number,
  telemetryMibId?: string | null,
): Promise<TelemetrySample> {
  // Make sure the symbol table is populated before we try to resolve any
  // vendor symbols. ensureRegistryLoaded short-circuits after the first call.
  await ensureRegistryLoaded();

  // When the operator pinned an uploaded MIB on this asset's telemetry stream
  // (Asset / class-override / integration tier), look it up and feed its
  // module name + manufacturer + model into pickVendorProfile *instead of*
  // the asset's own identity. Lets operators redirect a misclassified asset
  // (e.g. a FortiSwitch whose discovery sources stamped manufacturer=Fortinet
  // with no model hint) into the right profile without renaming the asset.
  // `"std:<key>"` ids are UI hints only — they don't bias selection here.
  let profileManufacturer = manufacturer;
  let profileModel        = model;
  let profileOs           = os;
  if (telemetryMibId && !telemetryMibId.startsWith("std:")) {
    const mib = await prisma.mibFile.findUnique({
      where:  { id: telemetryMibId },
      select: { moduleName: true, manufacturer: true, model: true },
    }).catch(() => null);
    if (mib) {
      profileManufacturer = mib.manufacturer ?? manufacturer;
      profileModel        = mib.model        ?? model;
      // Stuff the MIB's module name into the `os` slot so the existing
      // haystack-based matcher can see it (e.g. "FORTINET-FORTISWITCH-MIB"
      // contains "FortiSwitch" which the FortiSwitch profile matches).
      profileOs           = mib.moduleName;
    }
  }
  const profile = pickVendorProfileMerged(profileManufacturer, profileOs, profileModel);
  // Scope still uses the *asset's* manufacturer/model so symbol resolution
  // through oidRegistry continues to pick up device-specific MIB overrides
  // for the actual asset, not the MIB pointed at by telemetryMibId.
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

    // Hardware sensors are collected separately by `collectHardwareSensors`,
    // which dispatches on temperaturePolling instead of cpuMemoryPolling so an
    // operator can run CPU/memory over REST and hardware sensors over SNMP (the
    // common branch-class FortiGate workaround for an unreliable
    // /api/v2/monitor/system/sensor-info).
    return { cpuPct, memPct, memUsedBytes, memTotalBytes };
  }, timeoutMs);
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

/**
 * Targeted multi-OID GET. Backs the wire-level filtered fast cadence: pulls
 * exactly the column values we need at known ifIndex / hrStorageIndex slots
 * instead of walking entire IF-MIB / hrStorage subtrees. Chunked to
 * SNMP_MULTI_GET_BATCH OIDs per request because most agents enforce a per-PDU
 * varbind limit (anywhere from ~50 to ~100 depending on vendor); 40 is safely
 * below the lowest commonly-seen cap.
 *
 * Returns a Map keyed by the input OID with the varbind value (or null on
 * varbindError / noSuchInstance — same as snmpGetScalar). Errors from the
 * SNMP layer (timeout, connection failure) reject the promise.
 */
const SNMP_MULTI_GET_BATCH = 40;
function snmpMultiGet(session: any, oids: string[]): Promise<Map<string, unknown>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, unknown>();
    if (oids.length === 0) return resolve(out);
    // Dedup + preserve order. Useful for callers that build OID lists across
    // many resolution steps and may accidentally repeat.
    const uniqueOids = Array.from(new Set(oids));
    const batches: string[][] = [];
    for (let i = 0; i < uniqueOids.length; i += SNMP_MULTI_GET_BATCH) {
      batches.push(uniqueOids.slice(i, i + SNMP_MULTI_GET_BATCH));
    }
    let remaining = batches.length;
    let aborted = false;
    const fail = (err: Error) => {
      if (aborted) return;
      aborted = true;
      reject(err);
    };
    for (const batch of batches) {
      try {
        session.get(batch, (err: Error | null, varbinds: any[]) => {
          if (aborted) return;
          if (err) return fail(err);
          for (let i = 0; i < batch.length; i++) {
            const vb = varbinds?.[i];
            if (!vb || snmp.isVarbindError(vb)) {
              out.set(batch[i] as string, null);
            } else {
              out.set(batch[i] as string, vb.value);
            }
          }
          remaining -= 1;
          if (remaining === 0) resolve(out);
        });
      } catch (err: any) {
        return fail(err);
      }
    }
  });
}

async function collectHardwareSensorsSnmp(
  session: any,
  manufacturer?: string | null,
  profile?: VendorTelemetryProfile | null,
  scope?: { manufacturer?: string | null; model?: string | null },
): Promise<HardwareSensorSample[]> {
  // 1. FORTINET-FORTIGATE-MIB fgHwSensorTable is the comprehensive source on
  //    FortiGates (temperature + fan + voltage + power + disk + alarm), so
  //    prefer it for Fortinet devices, or when the operator explicitly pointed
  //    the Hardware Sensors metric at a table (mode="table"). FortiSwitches /
  //    FortiAPs don't populate it → empty → fall through to the paths below.
  const wantTable =
    (!!manufacturer && /fortinet/i.test(manufacturer)) ||
    profile?.temperature?.mode === "table";
  if (wantTable) {
    const fgRows = await collectHardwareSensorsFortinetSnmp(session);
    if (fgRows.length > 0) return fgRows;
  }

  // 2. ENTITY-SENSOR-MIB (RFC 3433). Standard table on non-Fortinet gear (and
  //    FortiSwitch). We surface entPhySensorType=8 (celsius) rows as the
  //    `temperature` class. Non-temperature ENTITY classes (fan/volt) are a
  //    future enhancement — the FortiGate fleet uses path 1.
  const [types, values, scales, precisions, opers, descrs] = await Promise.all([
    snmpWalk(session, OID.entPhySensorType).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorValue).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorScale).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorPrecision).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorOperStatus).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalDescr).catch(() => new Map()),
  ]);
  const out: HardwareSensorSample[] = [];
  // Some agents (notably FortiSwitchOS) stamp entPhySensorType=8 (celsius) on
  // every row in the table — SFP optical readings, fan tachs, voltage rails —
  // not just real temperature sensors. Cross-check the entPhysicalDescr from
  // ENTITY-MIB to drop rows the descr identifies as something else.
  const NON_TEMP_DESCR = /\b(sfp|fan|rpm|voltage|bias)\b/i;
  for (const [idx, typeRaw] of types.entries()) {
    const t = snmpVbToNumber(typeRaw);
    if (t !== 8) continue; // RFC 3433: 8 = celsius
    const oper = snmpVbToNumber(opers.get(idx));
    // 1 = ok, 2 = unavailable, 3 = nonoperational. Skip non-ok rows.
    if (oper != null && oper !== 1) continue;
    const descr = snmpVbToString(descrs.get(idx));
    if (descr && NON_TEMP_DESCR.test(descr)) continue;
    const raw = snmpVbToNumber(values.get(idx));
    if (raw == null) continue;
    const scale = snmpVbToNumber(scales.get(idx));   // SI prefix code
    const prec  = snmpVbToNumber(precisions.get(idx)); // decimal-point shift
    const celsius = scaleEntitySensor(raw, scale, prec);
    out.push({
      sensorName:  descr || `sensor-${idx}`,
      sensorClass: "temperature",
      value:       Number.isFinite(celsius) ? Math.round(celsius * 10) / 10 : null,
      unit:        "°C",
      alarmStatus: null,
    });
  }
  if (out.length > 0) return out;

  // 3. Profile-driven scalar symbol. Used by vendors whose hardware publishes a
  //    single Celsius scalar rather than a sensor table — currently the FortiAP
  //    (fapTemperature @ 12356.120.3.44).
  if (profile?.temperature?.mode === "scalar") {
    const tempOid = resolveOidSync(profile.temperature.symbol, scope ?? {});
    if (tempOid) {
      const v = await snmpGetScalar(session, tempOid).catch(() => null);
      const n = snmpVbToNumber(v);
      if (n != null && Number.isFinite(n)) {
        out.push({
          sensorName:  profile.temperature.sensorName ?? "System",
          sensorClass: "temperature",
          value:       Math.round(n * 10) / 10,
          unit:        "°C",
          alarmStatus: null,
        });
      }
    } else {
      logger.debug(
        { vendor: profile.vendor, symbol: profile.temperature.symbol, scope },
        "vendor hardware-sensor symbol unresolved — upload its MIB to enable",
      );
    }
  }
  return out;
}

// FORTINET-FORTIGATE-MIB::fgHwSensorTable walk. The full hardware-sensor table:
// temperature, fan, voltage, power/PSU, disk. No type column, so each row is
// classified by name (classifyHardwareSensor); the value is a DisplayString
// decimal and the alarm column is 0/1. Branch FortiGates that don't implement
// ENTITY-SENSOR-MIB publish hardware sensors only here.
async function collectHardwareSensorsFortinetSnmp(session: any): Promise<HardwareSensorSample[]> {
  const [names, values, alarms] = await Promise.all([
    snmpWalk(session, OID.fgHwSensorEntName).catch(() => new Map()),
    snmpWalk(session, OID.fgHwSensorEntValue).catch(() => new Map()),
    snmpWalk(session, OID.fgHwSensorEntAlarmStatus).catch(() => new Map()),
  ]);
  const out: HardwareSensorSample[] = [];
  for (const [idx, nameRaw] of names.entries()) {
    const name = snmpVbToString(nameRaw).trim();
    if (!name) continue;
    const { sensorClass, unit } = classifyHardwareSensor(name);
    const valStr = snmpVbToString(values.get(idx)).trim();
    const n = Number(valStr);
    out.push({
      sensorName:  name,
      sensorClass,
      value:       Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null,
      unit,
      alarmStatus: normalizeFgAlarmStatus(snmpVbToNumber(alarms.get(idx))),
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

async function collectSystemInfoSnmp(
  host: string,
  config: Record<string, unknown>,
  opts: {
    includeLldp?:  boolean;
    timeoutMs?:    number;
    /** Asset manufacturer — used to pick the vendor disk fallback when HRM returns no disks. */
    manufacturer?: string | null;
    /** Asset model — same fallback path. */
    model?:        string | null;
    /** Asset OS — same fallback path. */
    os?:           string | null;
    /** Asset type — drives the fapStationTable walk for FortiAPs. */
    assetType?:    string | null;
  } = {},
): Promise<SystemInfoSample> {
  // Vendor profile is read once up-front so the disk fallback (below) can
  // consult it without re-deriving. Cheap — VENDOR_TELEMETRY_PROFILES is in
  // memory; ensureRegistryLoaded is called by the disk fallback when it runs.
  const vendorProfile = pickVendorProfileMerged(opts.manufacturer, opts.os, opts.model);
  const vendorScope   = { manufacturer: opts.manufacturer, model: opts.model };

  return await withSnmpSession(host, config, async (session) => {
    // Storage: walk hrStorage and pick rows tagged as fixed/removable disk.
    const storage: StorageSample[] = [];
    const endStorage = startPhase("systeminfo.snmp.storage_walk");
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
    endStorage({ disks: storage.length });

    // Vendor disk fallback: when HRM returned no disk rows (typical on
    // devices whose SNMP agents don't implement hrStorageTable — FortiSwitches,
    // some access points, etc.), consult the matched vendor profile for
    // proprietary used/total byte scalars and synthesize one StorageSample.
    if (storage.length === 0 && vendorProfile?.disk) {
      try {
        await ensureRegistryLoaded();
        const disk    = vendorProfile.disk;
        const usedOid = resolveOidSync(disk.usedBytesSymbol,  vendorScope);
        const totOid  = resolveOidSync(disk.totalBytesSymbol, vendorScope);
        if (usedOid && totOid) {
          const [usedVb, totVb] = await Promise.all([
            snmpGetScalar(session, usedOid).catch(() => null),
            snmpGetScalar(session, totOid).catch(() => null),
          ]);
          const usedBytes  = snmpVbToNumber(usedVb);
          const totalBytes = snmpVbToNumber(totVb);
          if (usedBytes != null || totalBytes != null) {
            storage.push({
              mountPath:  disk.mountPath || "system",
              usedBytes:  usedBytes  ?? null,
              totalBytes: totalBytes ?? null,
            });
          }
        }
      } catch { /* leave storage empty; HRM-empty is the same outcome as before */ }
    }

    // Interfaces: build a map keyed by ifIndex from IF-MIB columns. Prefer
    // ifName / ifHC*Octets / ifHighSpeed when present; otherwise fall back
    // to the legacy 32-bit columns.
    const interfaces: InterfaceSample[] = [];
    const endIfaces = startPhase("systeminfo.snmp.interfaces_walk");
    try {
      const [
        names, descrs, admin, oper, speeds, hiSpeeds, mac,
        in32, out32, inHC, outHC, ipMap, inErr, outErr, ifTypes, aliases,
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
        snmpWalk(session, OID.ifAlias).catch(() => new Map()),
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
        // Drop rows where IF-MIB advertises neither ifName nor ifDescr — on
        // FortiAPs these are ephemeral per-station / per-VAP virtual interfaces
        // that can't be meaningfully pinned (ifIndex churns as clients
        // associate) and just pollute AssetInterfaceSample + the auto-monitor
        // aggregate.
        const name = snmpVbToString(names.get(idx)) || snmpVbToString(descrs.get(idx));
        if (!name) continue;
        const speedHi = snmpVbToNumber(hiSpeeds.get(idx));
        const speed32 = snmpVbToNumber(speeds.get(idx));
        const speedBps = speedHi && speedHi > 0
          ? speedHi * 1_000_000
          : (speed32 != null ? speed32 : null);
        const inHi = snmpVbToNumber(inHC.get(idx));
        const outHi = snmpVbToNumber(outHC.get(idx));
        const aliasRaw = snmpVbToString(aliases.get(idx));
        const alias = aliasRaw && aliasRaw.trim() ? aliasRaw.trim() : null;
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
          alias,
        });
      }
    } catch { /* fall through */ }
    endIfaces({ interfaces: interfaces.length });

    // LLDP-MIB neighbors. Best-effort — devices without LLDP-MIB return empty
    // walks (we treat that as "unsupported" so we don't wipe stored rows on
    // every scrape). A device with LLDP enabled but zero current neighbors
    // returns lldpLocPortTable rows but an empty lldpRemTable, and we
    // correctly persist that as "queried, no neighbors" → wipe. `includeLldp`
    // false lets the caller skip this when the operator routed LLDP to REST.
    let lldpNeighbors: LldpNeighborSample[] | undefined;
    if (opts.includeLldp !== false) {
      const endLldp = startPhase("systeminfo.snmp.lldp_walk");
      try {
        lldpNeighbors = await collectLldpNeighborsSnmp(session);
      } catch { /* leave undefined; persist layer leaves stored rows alone */ }
      endLldp({ neighbors: lldpNeighbors?.length ?? null });
    }

    // Wireless stations — only attempted on FortiAP assets. fapStationTable
    // is FORTINET-FORTIAP-MIB-specific; firing it on every SNMP system-info
    // pass would burn worker time on devices that can't respond. Same
    // undefined/[] semantics as lldpNeighbors: undefined leaves stored rows
    // alone, [] wipes them.
    let wirelessStations: WirelessStationSample[] | undefined;
    if (opts.assetType === "access_point") {
      const endWireless = startPhase("systeminfo.snmp.wireless_walk");
      try {
        wirelessStations = await collectWirelessStationsSnmp(session);
      } catch { /* leave undefined */ }
      endWireless({ stations: wirelessStations?.length ?? null });
    }

    return {
      interfaces,
      storage,
      lldpNeighbors,
      lldpSource: opts.includeLldp !== false ? "snmp" : undefined,
      wirelessStations,
    };
  }, opts.timeoutMs);
}

/**
 * Wire-level filtered SNMP system-info scrape. Pulls only the columns/rows the
 * fast cadence actually needs — pinned interfaces and pinned storage — instead
 * of walking the full IF-MIB / hrStorage subtrees the way `collectSystemInfoSnmp`
 * does. The full pass at the heavy cadence still walks everything; this is
 * strictly an optimization for the per-minute scrape.
 *
 * Three phases:
 *
 *   1. Discovery — walk `ifName` + `ifDescr` (and `hrStorageDescr` when storage
 *      is pinned) to map the operator-supplied names back to their SNMP
 *      indexes. These walks are tiny (one varbind per port / disk) and finish
 *      in well under a second on most agents. We don't currently persist the
 *      name→index map; the heavy-cadence sample already records ifName but
 *      not ifIndex, and adding a column would mean a schema migration. The
 *      bounded walks here are the simpler path.
 *
 *   2. Multi-GET — pack every column-at-index OID we want into one `session.get`
 *      (chunked at SNMP_MULTI_GET_BATCH). On a 48-port switch with one pinned
 *      interface, that's 13 OIDs in a single PDU — vs. 16 full column walks
 *      under the legacy path (~770 OID-fetches). Latency is dominated by the
 *      network round-trip, so one PDU ≈ one round-trip ≈ ~50 ms regardless of
 *      varbind count.
 *
 *   3. Assembly — emit one `InterfaceSample` per matched name (skipping names
 *      that didn't resolve to an index, e.g. the operator pinned a port that
 *      no longer exists on the device). Speed/IP/MAC follow the same picker
 *      rules as the full walk: high-counter prefers `ifHC*Octets` over the
 *      legacy 32-bit columns, speed prefers `ifHighSpeed * 1e6` over
 *      `ifSpeed`, IP comes from inverting `ipAdEntIfIndex` for ipByIfIndex.
 *
 * IP resolution is the one gotcha: `ipAdEntIfIndex` is a small walk (one
 * varbind per IPv4 address on the device, not per interface) — we walk it once
 * here so the pinned interface gets its IP. On devices with many IPs (large
 * branches) this is the dominant cost; still tiny compared to the full pass.
 *
 * Returns the same `SystemInfoSample` shape as `collectSystemInfoSnmp` so
 * `recordSystemInfoResult` downstream is unchanged. LLDP and wireless are
 * always skipped on the fast cadence (LLDP rides the heavy cadence, wireless
 * isn't a fast-pin target today).
 */
async function collectFastFilteredSnmp(
  host: string,
  config: Record<string, unknown>,
  opts: {
    wantedIfaces:   string[];
    wantedStorage:  string[];
    timeoutMs?:     number;
  },
): Promise<SystemInfoSample> {
  const wantedIfaceSet  = new Set(opts.wantedIfaces);
  const wantedStorageSet = new Set(opts.wantedStorage);

  return await withSnmpSession(host, config, async (session) => {
    // ── Phase 1: discover ifIndex for each pinned ifName ──────────────────
    // Walk ifName + ifDescr in parallel; one full pass on a 48-port switch
    // is ~50 varbinds per column ≈ <500ms total. Resolve every pinned name
    // to its index; pinned-but-missing names are dropped silently (same
    // behavior as the full walk: the stored sample just doesn't include
    // that ifName on this tick).
    const ifIndexByName = new Map<string, string>();
    const endIfaceDiscovery = startPhase("fastfiltered.snmp.iface_discovery");
    try {
      const [names, descrs] = await Promise.all([
        snmpWalk(session, OID.ifName).catch(() => new Map()),
        snmpWalk(session, OID.ifDescr).catch(() => new Map()),
      ]);
      // ifName is preferred (modern devices); ifDescr fallback covers older
      // agents that don't populate ifName.
      const indexToName = new Map<string, string>();
      for (const [idx, vb] of names.entries()) {
        const n = snmpVbToString(vb);
        if (n) indexToName.set(idx, n);
      }
      for (const [idx, vb] of descrs.entries()) {
        if (indexToName.has(idx)) continue;
        const n = snmpVbToString(vb);
        if (n) indexToName.set(idx, n);
      }
      for (const [idx, name] of indexToName.entries()) {
        if (wantedIfaceSet.has(name)) ifIndexByName.set(name, idx);
      }
    } catch { /* leave ifIndexByName empty; sample will skip iface rows */ }
    endIfaceDiscovery({ resolved: ifIndexByName.size, wanted: wantedIfaceSet.size });

    // ── Phase 1b: discover hrStorageIndex for each pinned mountPath ───────
    // Storage column rows are also small (one per disk/partition); only walk
    // when at least one mountPath is pinned to avoid burning a round-trip
    // on iface-only fast pins.
    const storageIndexByMount = new Map<string, string>();
    if (wantedStorageSet.size > 0) {
      const endStorageDiscovery = startPhase("fastfiltered.snmp.storage_discovery");
      try {
        const descrs = await snmpWalk(session, OID.hrStorageDescr);
        for (const [idx, vb] of descrs.entries()) {
          const m = snmpVbToString(vb);
          if (m && wantedStorageSet.has(m)) storageIndexByMount.set(m, idx);
        }
      } catch { /* leave empty */ }
      endStorageDiscovery({ resolved: storageIndexByMount.size, wanted: wantedStorageSet.size });
    }

    // ── Phase 2: build the targeted OID list ──────────────────────────────
    // 13 columns per pinned interface, 3 per pinned storage row. Names are
    // resolved in Phase 1; missing names contribute no OIDs.
    const IFACE_COLS = [
      OID.ifName,         // re-pull so the assembly step has the authoritative ifName
      OID.ifAdminStatus,
      OID.ifOperStatus,
      OID.ifSpeed,
      OID.ifHighSpeed,
      OID.ifPhysAddress,
      OID.ifInOctets,
      OID.ifOutOctets,
      OID.ifHCInOctets,
      OID.ifHCOutOctets,
      OID.ifInErrors,
      OID.ifOutErrors,
      OID.ifType,
      OID.ifAlias,
    ];
    const STORAGE_COLS = [
      OID.hrStorageAllocationUnits,
      OID.hrStorageSize,
      OID.hrStorageUsed,
    ];
    const oids: string[] = [];
    for (const idx of ifIndexByName.values()) {
      for (const col of IFACE_COLS) oids.push(`${col}.${idx}`);
    }
    for (const idx of storageIndexByMount.values()) {
      for (const col of STORAGE_COLS) oids.push(`${col}.${idx}`);
    }

    // Also need ifIndex by IP for the pinned interfaces' ipAddress field.
    // ipAdEntIfIndex is indexed by the IP itself, not by ifIndex, so we have
    // to walk it. Tiny on most devices (one varbind per IPv4 address). Skip
    // when no interfaces are pinned (storage-only fast cadence is rare but
    // technically possible).
    const ipByIfIndex = new Map<string, string>();
    if (ifIndexByName.size > 0) {
      const endIpWalk = startPhase("fastfiltered.snmp.ip_walk");
      try {
        const ipMap = await snmpWalk(session, OID.ipAdEntIfIndex);
        for (const [ip, idxRaw] of ipMap.entries()) {
          const idx = String(snmpVbToNumber(idxRaw) ?? "");
          if (!idx) continue;
          if (!ipByIfIndex.has(idx)) ipByIfIndex.set(idx, ip);
        }
      } catch { /* leave empty */ }
      endIpWalk({ ipMappings: ipByIfIndex.size });
    }

    // ── Phase 3: one batched multi-GET, then assembly ─────────────────────
    const endMultiGet = startPhase("fastfiltered.snmp.multi_get");
    const vbByOid = oids.length > 0
      ? await snmpMultiGet(session, oids).catch(() => new Map<string, unknown>())
      : new Map<string, unknown>();
    endMultiGet({ oids: oids.length });

    const interfaces: InterfaceSample[] = [];
    for (const [pinnedName, idx] of ifIndexByName.entries()) {
      const name = snmpVbToString(vbByOid.get(`${OID.ifName}.${idx}`)) || pinnedName;
      const speedHi = snmpVbToNumber(vbByOid.get(`${OID.ifHighSpeed}.${idx}`));
      const speed32 = snmpVbToNumber(vbByOid.get(`${OID.ifSpeed}.${idx}`));
      const speedBps = speedHi && speedHi > 0
        ? speedHi * 1_000_000
        : (speed32 != null ? speed32 : null);
      const inHi = snmpVbToNumber(vbByOid.get(`${OID.ifHCInOctets}.${idx}`));
      const outHi = snmpVbToNumber(vbByOid.get(`${OID.ifHCOutOctets}.${idx}`));
      const aliasRaw = snmpVbToString(vbByOid.get(`${OID.ifAlias}.${idx}`));
      const alias = aliasRaw && aliasRaw.trim() ? aliasRaw.trim() : null;
      interfaces.push({
        ifName:      name,
        adminStatus: ifStatusLabel(snmpVbToNumber(vbByOid.get(`${OID.ifAdminStatus}.${idx}`))),
        operStatus:  ifStatusLabel(snmpVbToNumber(vbByOid.get(`${OID.ifOperStatus}.${idx}`))),
        speedBps,
        ipAddress:   ipByIfIndex.get(idx) || null,
        macAddress:  snmpMacFromBuffer(vbByOid.get(`${OID.ifPhysAddress}.${idx}`)),
        inOctets:    inHi != null  ? inHi  : snmpVbToNumber(vbByOid.get(`${OID.ifInOctets}.${idx}`)),
        outOctets:   outHi != null ? outHi : snmpVbToNumber(vbByOid.get(`${OID.ifOutOctets}.${idx}`)),
        inErrors:    snmpVbToNumber(vbByOid.get(`${OID.ifInErrors}.${idx}`)),
        outErrors:   snmpVbToNumber(vbByOid.get(`${OID.ifOutErrors}.${idx}`)),
        ifType:      snmpIfTypeLabel(snmpVbToNumber(vbByOid.get(`${OID.ifType}.${idx}`))),
        alias,
      });
    }

    const storage: StorageSample[] = [];
    for (const [mountPath, idx] of storageIndexByMount.entries()) {
      const u = snmpVbToNumber(vbByOid.get(`${OID.hrStorageAllocationUnits}.${idx}`)) ?? 1;
      const s = snmpVbToNumber(vbByOid.get(`${OID.hrStorageSize}.${idx}`));
      const ud = snmpVbToNumber(vbByOid.get(`${OID.hrStorageUsed}.${idx}`));
      storage.push({
        mountPath,
        totalBytes: s != null  ? s * u  : null,
        usedBytes:  ud != null ? ud * u : null,
      });
    }

    return {
      interfaces,
      storage,
      // LLDP intentionally omitted on the fast cadence — undefined preserves
      // stored rows from the last heavy pass instead of wiping them. Same
      // contract as `collectSystemInfoSnmp` with `includeLldp: false`.
      lldpNeighbors: undefined,
      wirelessStations: undefined,
    };
  }, opts.timeoutMs);
}

/**
 * Standalone LLDP-MIB walk for the cross-transport case. Used when the caller
 * has already pulled interfaces+storage via FortiOS REST but the operator
 * routed LLDP to SNMP. Opens its own SNMP session — cheap enough; LLDP walks
 * are normally ~6 columns and finish in a few hundred ms.
 */
export async function collectLldpOnlySnmp(
  host: string,
  config: Record<string, unknown>,
  timeoutMs?: number,
): Promise<LldpNeighborSample[] | undefined> {
  return await withSnmpSession(host, config, async (session) => {
    return await collectLldpNeighborsSnmp(session);
  }, timeoutMs);
}

/**
 * Walk LLDP-MIB and assemble one LldpNeighborSample per remote system seen.
 * Returns `undefined` when the local-port table is empty (suggesting LLDP-MIB
 * is unsupported); returns `[]` when the local table is populated but no
 * remote neighbors are present (so the caller wipes stored rows). Mapping
 * localPortNum → ifName comes from lldpLocPortTable: when the subtype is
 * interfaceName/interfaceAlias we trust lldpLocPortId; otherwise we fall back
 * to lldpLocPortDesc, which is always populated by spec-conformant agents.
 */
async function collectLldpNeighborsSnmp(session: any): Promise<LldpNeighborSample[] | undefined> {
  const [
    locSubtypes, locIds, locDescs,
    chSubtypes, chIds, ptSubtypes, ptIds, ptDescs,
    sysNames, sysDescs, capsEnabled, manAddrEnum,
    ifNames,
  ] = await Promise.all([
    snmpWalk(session, OID.lldpLocPortIdSubtype).catch(() => new Map()),
    snmpWalk(session, OID.lldpLocPortId).catch(() => new Map()),
    snmpWalk(session, OID.lldpLocPortDesc).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemChassisIdSubtype).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemChassisId).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemPortIdSubtype).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemPortId).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemPortDesc).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemSysName).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemSysDesc).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemSysCapEnabled).catch(() => new Map()),
    // Walking lldpRemManAddrIfSubtype just to enumerate the table indexes —
    // the actual address is encoded in the index suffix, not the column value.
    snmpWalk(session, OID.lldpRemManAddr + ".3").catch(() => new Map()),
    // IF-MIB ifName: fallback for the local port label when lldpLocPortTable
    // is empty. FortiOS uses ifIndex as lldpLocPortNum, so a "port-2" label
    // can be resolved to "internal1" / "wan2" / etc via the IF-MIB table that
    // every SNMP-monitored asset already exposes.
    snmpWalk(session, OID.ifName).catch(() => new Map()),
  ]);

  // No local LLDP ports AND no remote neighbors → device doesn't speak
  // LLDP-MIB. Signal "leave rows alone" so we don't wipe stored neighbors
  // on a transport that can't report. The previous guard returned here on
  // an empty local port table alone, but some FortiOS agents populate
  // lldpRemTable while leaving lldpLocPortTable empty — those reports are
  // authoritative for the remote side, and the per-row port label falls
  // back to "port-<num>" naturally below.
  if (locIds.size === 0 && locDescs.size === 0 && chIds.size === 0) return undefined;

  // localPortNum → friendly label. When the subtype is interfaceName(5) or
  // interfaceAlias(1), the id IS the ifName/alias and we want it. Otherwise
  // use the description — which is what most operators see in CLI output.
  const localPortLabel = new Map<string, string>();
  const allLocalKeys = new Set<string>([...locIds.keys(), ...locDescs.keys()]);
  for (const portNum of allLocalKeys) {
    const subtype = snmpVbToNumber(locSubtypes.get(portNum));
    const id      = parseLldpPortId(subtype, locIds.get(portNum));
    const desc    = snmpVbToString(locDescs.get(portNum)).trim();
    if ((subtype === 1 || subtype === 5) && id) {
      localPortLabel.set(portNum, id);
    } else if (desc) {
      localPortLabel.set(portNum, desc);
    } else if (id) {
      localPortLabel.set(portNum, id);
    } else {
      localPortLabel.set(portNum, `port-${portNum}`);
    }
  }
  // IF-MIB ifName fallback: rem-table-only agents (some FortiOS builds)
  // leave lldpLocPortTable empty but lldpRemLocalPortNum lines up with the
  // ifIndex of the physical port. Stamp any port number that the local-port
  // pass didn't cover so neighbors render as e.g. "internal1 → CKYSMA-148F-1"
  // instead of "port-2 → CKYSMA-148F-1".
  for (const [ifIndex, nameVb] of ifNames.entries()) {
    if (localPortLabel.has(ifIndex)) continue;
    const name = snmpVbToString(nameVb).trim();
    if (name) localPortLabel.set(ifIndex, name);
  }

  // (localPortNum, remIndex) → management IP. Decode the index suffix:
  // <timeMark>.<localPortNum>.<remIndex>.<addrSubtype>.<addrLen>.<addr-bytes…>
  // addrSubtype 1 = IPv4 (4 bytes), 2 = IPv6 (16 bytes); ignore others.
  const mgmtByKey = new Map<string, string>();
  for (const suffix of manAddrEnum.keys()) {
    const parts = String(suffix).split(".");
    if (parts.length < 6) continue;
    const localPortNum = parts[1]!;
    const remIndex     = parts[2]!;
    const addrSubtype  = parts[3]!;
    const addrLen      = parseInt(parts[4]!, 10);
    if (!Number.isFinite(addrLen)) continue;
    const addrBytes = parts.slice(5, 5 + addrLen);
    if (addrBytes.length !== addrLen) continue;
    let addr: string | null = null;
    if (addrSubtype === "1" && addrLen === 4) {
      addr = addrBytes.join(".");
    } else if (addrSubtype === "2" && addrLen === 16) {
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2) {
        const hi = parseInt(addrBytes[i]!, 10);
        const lo = parseInt(addrBytes[i + 1]!, 10);
        groups.push(((hi << 8) | lo).toString(16));
      }
      addr = groups.join(":");
    }
    if (!addr) continue;
    const key = `${localPortNum}|${remIndex}`;
    if (!mgmtByKey.has(key)) mgmtByKey.set(key, addr);
  }

  // Enumerate remote neighbors via lldpRemChassisId — always present. The
  // suffix here is `<timeMark>.<localPortNum>.<remIndex>`.
  const out: LldpNeighborSample[] = [];
  for (const [suffix, chRaw] of chIds.entries()) {
    const parts = String(suffix).split(".");
    if (parts.length < 3) continue;
    const localPortNum = parts[1]!;
    const remIndex     = parts[2]!;
    const localIfName  = localPortLabel.get(localPortNum) || `port-${localPortNum}`;
    const chSub  = snmpVbToNumber(chSubtypes.get(suffix));
    const ptSub  = snmpVbToNumber(ptSubtypes.get(suffix));
    out.push({
      localIfName,
      chassisIdSubtype:  lldpChassisSubtypeLabel(chSub),
      chassisId:         parseLldpChassisId(chSub, chRaw),
      portIdSubtype:     lldpPortSubtypeLabel(ptSub),
      portId:            parseLldpPortId(ptSub, ptIds.get(suffix)),
      portDescription:   snmpVbToString(ptDescs.get(suffix)).trim() || null,
      systemName:        snmpVbToString(sysNames.get(suffix)).trim() || null,
      systemDescription: snmpVbToString(sysDescs.get(suffix)).trim() || null,
      managementIp:      mgmtByKey.get(`${localPortNum}|${remIndex}`) ?? null,
      capabilities:      parseLldpCapabilities(capsEnabled.get(suffix)),
    });
  }
  return out;
}

function parseLldpChassisId(subtype: number | null, raw: unknown): string | null {
  if (raw == null) return null;
  // macAddress(4) → format as colon-separated MAC when length matches.
  if (subtype === 4) {
    const mac = snmpMacFromBuffer(raw);
    if (mac) return mac;
  }
  if (Buffer.isBuffer(raw)) {
    const printable = raw.toString("utf8");
    if (/^[\x20-\x7e]+$/.test(printable.trim())) return printable.trim();
    return Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join(":");
  }
  const s = String(raw).trim();
  return s || null;
}

/**
 * Walk FORTINET-FORTIAP-MIB::fapStationTable and return one
 * WirelessStationSample per connected wireless client. Returns `undefined`
 * when the table is absent (device doesn't implement FORTINET-FORTIAP-MIB
 * or no SSID column is populated) so the caller leaves stored rows alone;
 * returns `[]` when the device was queried but reported zero stations
 * (caller wipes stored rows).
 *
 * INDEX = { fapStaRadioId, fapStaWlanId, fapStaMacAddr (6|8 octets) }.
 * For 6-byte Ethernet MACs the SMIv2 default-encoded suffix has 9 parts:
 *   <radioId>.<wlanId>.6.<b0>.<b1>.<b2>.<b3>.<b4>.<b5>
 * Each parallel column walk lookup uses the same suffix string.
 */
async function collectWirelessStationsSnmp(session: any): Promise<WirelessStationSample[] | undefined> {
  const [ssids, bssids, vlans, ipAddrs, radioTypes, radioChannels] = await Promise.all([
    snmpWalk(session, OID.fapStaSSID).catch(() => new Map()),
    snmpWalk(session, OID.fapStaBSSID).catch(() => new Map()),
    snmpWalk(session, OID.fapStaVlanId).catch(() => new Map()),
    snmpWalk(session, OID.fapStaIpAddr).catch(() => new Map()),
    // fapRadioTable, indexed by fapRadioIndex — used to derive each station's
    // band. Best-effort: failures leave band null, stations still persist.
    snmpWalk(session, OID.fapRadioType).catch(() => new Map()),
    snmpWalk(session, OID.fapRadioChannelOper).catch(() => new Map()),
  ]);

  // radioIndex (string suffix) → derived band. fapRadioIndex is the single
  // index column, so the walk suffix is the bare radio index.
  const bandByRadio = new Map<string, string | null>();
  for (const suffix of new Set([...radioTypes.keys(), ...radioChannels.keys()])) {
    const type = radioTypes.has(suffix) ? snmpVbToString(radioTypes.get(suffix)).trim() : null;
    const channel = snmpVbToNumber(radioChannels.get(suffix));
    bandByRadio.set(String(suffix), deriveRadioBand(type, channel));
  }

  // Treat all-empty as "table unsupported" so we don't wipe stored rows on
  // a transport that can't report. A genuinely empty AP with the MIB in
  // place still returns at least one column with zero rows — the
  // collector sees an empty Map, suffix loop produces no rows, returns
  // []. The undefined return is reserved for "couldn't query at all."
  if (ssids.size === 0 && bssids.size === 0 && vlans.size === 0 && ipAddrs.size === 0) return undefined;

  // Decode the index suffix back into (radioId, wlanId, MAC). Skip rows
  // whose suffix doesn't match the expected 6-byte-MAC shape — 8-byte
  // forms (PhysAddress SIZE(6|8)) are valid per MIB but FortiAPs in the
  // field only emit 6-byte MACs; an 8-byte row would still decode but
  // wouldn't match anything in Polaris's endpoint inventory anyway. Drop
  // those silently rather than persist a malformed MAC.
  const out: WirelessStationSample[] = [];
  for (const suffix of ssids.keys()) {
    const parts = String(suffix).split(".");
    if (parts.length !== 9) continue;
    if (parts[2] !== "6") continue;
    const radioId = Number(parts[0]);
    const wlanId  = Number(parts[1]);
    const macBytes = parts.slice(3, 9).map((p) => Number(p));
    if (macBytes.some((b) => !Number.isFinite(b) || b < 0 || b > 255)) continue;
    const staMacAddr = macBytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");

    const ssid  = snmpVbToString(ssids.get(suffix)).trim() || null;
    const bssidRaw = bssids.get(suffix);
    const bssid = bssidRaw ? snmpMacFromBuffer(bssidRaw) : null;
    const vlanId = snmpVbToNumber(vlans.get(suffix));
    // fapStaIpAddr is IpAddress (4 bytes). snmpVbToString gives us dotted-quad on
    // most encodings; we fall through to null on the all-zero "unknown" case
    // so the row carries no IP rather than "0.0.0.0".
    let staIpAddr: string | null = null;
    const ipRaw = ipAddrs.get(suffix);
    if (ipRaw) {
      const s = snmpVbToString(ipRaw).trim();
      if (s && s !== "0.0.0.0") staIpAddr = s;
    }

    out.push({
      staMacAddr,
      staIpAddr,
      ssid,
      radioId: Number.isFinite(radioId) ? radioId : null,
      wlanId:  Number.isFinite(wlanId)  ? wlanId  : null,
      band:    Number.isFinite(radioId) ? (bandByRadio.get(String(radioId)) ?? null) : null,
      vlanId:  vlanId,
      bssid,
    });
  }
  return out;
}

function parseLldpPortId(subtype: number | null, raw: unknown): string | null {
  if (raw == null) return null;
  // macAddress(3) on lldpRemPortIdSubtype — same trick as chassis.
  if (subtype === 3) {
    const mac = snmpMacFromBuffer(raw);
    if (mac) return mac;
  }
  if (Buffer.isBuffer(raw)) {
    const printable = raw.toString("utf8");
    if (/^[\x20-\x7e]+$/.test(printable.trim())) return printable.trim();
    return Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join(":");
  }
  const s = String(raw).trim();
  return s || null;
}

function lldpChassisSubtypeLabel(n: number | null): string | null {
  switch (n) {
    case 1: return "chassisComponent";
    case 2: return "interfaceAlias";
    case 3: return "portComponent";
    case 4: return "macAddress";
    case 5: return "networkAddress";
    case 6: return "interfaceName";
    case 7: return "local";
    default: return null;
  }
}

function lldpPortSubtypeLabel(n: number | null): string | null {
  switch (n) {
    case 1: return "interfaceAlias";
    case 2: return "portComponent";
    case 3: return "macAddress";
    case 4: return "networkAddress";
    case 5: return "interfaceName";
    case 6: return "agentCircuitId";
    case 7: return "local";
    default: return null;
  }
}

// LldpSystemCapabilitiesMap is a 16-bit OctetString; bit 0 (MSB of byte 0)
// is `other`, bit 1 is `repeater`, etc. We only decode the eight defined
// IEEE 802.1AB-2009 capabilities; the rest are reserved.
function parseLldpCapabilities(raw: unknown): string[] {
  const labels = ["other", "repeater", "bridge", "wlan-access-point", "router", "telephone", "docsis-cable-device", "station-only"];
  const out: string[] = [];
  if (Buffer.isBuffer(raw) && raw.length >= 1) {
    const byte = raw[0]!;
    for (let i = 0; i < 8; i++) {
      if (byte & (1 << (7 - i))) out.push(labels[i]!);
    }
  }
  return out;
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
    enqueueTelemetrySample({
      assetId,
      timestamp: now,
      cpuPct:        d.cpuPct ?? null,
      memPct:        d.memPct ?? null,
      memUsedBytes:  d.memUsedBytes  != null ? BigInt(Math.round(d.memUsedBytes))  : null,
      memTotalBytes: d.memTotalBytes != null ? BigInt(Math.round(d.memTotalBytes)) : null,
    });
  }
  // Always advance the cadence stamp so a transient failure doesn't make us
  // hammer the device every 5 s.
  await prisma.asset.update({ where: { id: assetId }, data: { lastTelemetryAt: now } });
}

/**
 * Persist a hardware-sensor collection result. Unlike telemetry there is no
 * Asset.lastHardwareSensorAt column — the System tab derives the last-sample
 * timestamp from the latest AssetHardwareSensorSample row. If no samples were
 * written (device exposes no sensors, or the scrape failed), the System tab
 * keeps showing the prior timestamp and surfaces an amber "last successful
 * update X ago" badge once it falls behind the resolved cadence.
 */
export async function recordHardwareSensorResult(assetId: string, result: CollectionResult<HardwareSensorSample[]>): Promise<void> {
  if (!result.supported) return;
  if (Array.isArray(result.data) && result.data.length > 0) {
    // Sanity-filter ONLY temperature-class rows to a plausible operating range
    // — covers misinterpreted ENTITY-SENSOR-MIB scale/precision on some agents
    // (we've seen FortiSwitch sensors report 52000 / 34937). Other classes
    // (fan RPM, voltage, presence) have unbounded/different ranges and pass
    // through. Null value is preserved as the "couldn't read" signal.
    const filtered = result.data.filter(
      (s) =>
        s.sensorClass !== "temperature" ||
        s.value == null ||
        (Number.isFinite(s.value) && s.value >= -40 && s.value <= 200),
    );
    if (filtered.length === 0) return;
    const now = new Date();
    enqueueHardwareSensorSamples(
      filtered.map((s) => ({
        assetId,
        timestamp:   now,
        sensorName:  s.sensorName,
        sensorClass: s.sensorClass,
        value:       s.value,
        unit:        s.unit,
        alarmStatus: s.alarmStatus,
      })),
    );
  }
}

export async function recordSystemInfoResult(assetId: string, result: CollectionResult<SystemInfoSample>): Promise<void> {
  if (!result.supported) return;
  const now = new Date();
  if (result.data) {
    const d = result.data;
    // Selection-aware cadence: the full scrape covers every entity, so stamp
    // each row "fast" when its entity is operator-pinned (kept at full
    // retention + rolled up) and "slow" otherwise (kept 24h, never rolled up).
    // One indexed PK read per scrape on the slow (~10 min) cadence.
    const pinned = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { monitoredInterfaces: true, monitoredStorage: true, monitoredIpsecTunnels: true, ipAddress: true },
    });
    const pinnedIfaces  = new Set(pinned?.monitoredInterfaces ?? []);
    const pinnedStorage = new Set(pinned?.monitoredStorage ?? []);
    const pinnedTunnels = new Set(pinned?.monitoredIpsecTunnels ?? []);
    if (d.interfaces.length > 0) {
      enqueueInterfaceSamples(
        d.interfaces.map((i) => ({
          assetId,
          timestamp: now,
          cadence:     pinnedIfaces.has(i.ifName) ? ("fast" as const) : ("slow" as const),
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
          nativeVlan:  i.nativeVlan ?? null,
          taggedVlans: i.taggedVlans ?? [],
          trunksAllVlans: i.trunksAllVlans === true,
          alias:       i.alias       ?? null,
          description: i.description ?? null,
          addressingMode: i.addressingMode ?? null,
        })),
      );
      // Fold the MAC of each operator-pinned monitored interface into the
      // asset's Associated MACs list (AssetMacAddress). Additive-only — never
      // wipes rows owned by discovery/agent/manual sources; just inserts new
      // (assetId, mac) pairs and bumps lastSeen on existing ones. Gated on the
      // pinned-with-MAC set being non-empty so the no-pinned-interface common
      // case costs zero extra DB round-trips on the ~10-min slow cadence.
      const pinnedMacs = d.interfaces
        .filter((i) => pinnedIfaces.has(i.ifName) && i.macAddress)
        .map((i) => ({ mac: i.macAddress, source: "monitor-interface" }));
      if (pinnedMacs.length > 0) {
        const stopMacWrite = startSampleWriteTimer("asset_mac_addresses");
        const endMac = startPhase("systeminfo.persist.iface_macs");
        await addMacAddresses(assetId, pinnedMacs, now);
        endMac({ rows: pinnedMacs.length });
        stopMacWrite();
      }
    }
    if (d.storage.length > 0) {
      enqueueStorageSamples(
        d.storage.map((s) => ({
          assetId,
          timestamp: now,
          cadence:    pinnedStorage.has(s.mountPath) ? ("fast" as const) : ("slow" as const),
          mountPath:  s.mountPath,
          totalBytes: s.totalBytes != null ? BigInt(Math.round(s.totalBytes)) : null,
          usedBytes:  s.usedBytes  != null ? BigInt(Math.round(s.usedBytes))  : null,
        })),
      );
    }
    if (Array.isArray(d.ipsecTunnels) && d.ipsecTunnels.length > 0) {
      enqueueIpsecTunnelSamples(
        d.ipsecTunnels.map((t) => ({
          assetId,
          timestamp: now,
          cadence:         pinnedTunnels.has(t.tunnelName) ? ("fast" as const) : ("slow" as const),
          tunnelName:      t.tunnelName,
          parentInterface: t.parentInterface,
          remoteGateway:   t.remoteGateway,
          status:          t.status,
          incomingBytes:   t.incomingBytes != null ? BigInt(Math.round(t.incomingBytes)) : null,
          outgoingBytes:   t.outgoingBytes != null ? BigInt(Math.round(t.outgoingBytes)) : null,
          proxyIdCount:    t.proxyIdCount,
        })),
      );
    }
    // SD-WAN streams (gated by Integration.config.pullSdwan, only present when
    // collectSdwanFortinet ran on this heavy pass). No pinned-subset concept —
    // every row is stamped "fast" so the rollup (which filters cadence='fast')
    // includes it and prune treats them all uniformly.
    if (Array.isArray(d.perfSla) && d.perfSla.length > 0) {
      enqueuePerfSlaSamples(
        d.perfSla.map((p) => ({
          assetId,
          timestamp:   now,
          cadence:     "fast" as const,
          healthCheck: p.healthCheck,
          link:        p.link,
          zone:        p.zone,
          state:       p.state,
          latencyMs:   p.latencyMs,
          jitterMs:    p.jitterMs,
          packetLoss:  p.packetLoss,
          latencyThresholdMs:  p.latencyThresholdMs,
          jitterThresholdMs:   p.jitterThresholdMs,
          packetLossThreshold: p.packetLossThreshold,
        })),
      );
    }
    // SD-WAN rules are CURRENT-STATE (no history): replace the asset's rows on
    // every pass that collected SD-WAN data. `undefined` = collector didn't run
    // → leave existing rows alone; an array (even empty) = full-replace. Mirrors
    // the LLDP / wireless-station delete-replace pattern. (The SLA-metrics
    // stream above stays a time-series.)
    if (Array.isArray(d.sdwanRules)) {
      const stopWrite = startSampleWriteTimer("asset_sdwan_rules");
      const endSdwan = startPhase("systeminfo.persist.sdwan_rules");
      await persistSdwanRules(assetId, d.sdwanRules);
      endSdwan({ rules: d.sdwanRules.length });
      stopWrite();
    }
    // Mirror per-interface IPs+MACs into the asset_associated_ips side
    // table. Replaces the legacy JSONB read-modify-write pattern. Discovery
    // no longer populates interface IPs, so the System tab is the single
    // source for them once monitoring is on. Manual entries (source =
    // "manual") are preserved by deleting only the non-manual rows before
    // re-inserting the fresh monitor set.
    //
    // One $transaction so the delete + insert pair is atomic — a concurrent
    // reader will either see the old set or the new set, never an empty
    // intermediate. Skipped entirely when the scrape returned no interface
    // IPs (better to keep the previous list than wipe it on a transient
    // empty result, matching the prior null-return behavior).
    const monitorAssocEntries = buildMonitorAssocIpEntries(d.interfaces, now);
    if (monitorAssocEntries.length > 0) {
      const stopWrite = startSampleWriteTimer("asset_associated_ips");
      const endAssoc = startPhase("systeminfo.persist.assoc_ips_txn");
      // retryOnDeadlock: a concurrent system-info / probe-patch writer can
      // win a deadlock against this delete+insert pair (40P01). The op is
      // idempotent (full-replace of the asset's non-manual IPs), so re-run on
      // deadlock instead of crashing the whole system-info scrape.
      await retryOnDeadlock(() =>
        prisma.$transaction([
          prisma.assetAssociatedIp.deleteMany({
            where: { assetId, source: { not: "manual" } },
          }),
          prisma.assetAssociatedIp.createMany({
            data: monitorAssocEntries.map((e) => ({ ...e, assetId })),
            skipDuplicates: true,
          }),
        ]),
      );
      endAssoc({ rows: monitorAssocEntries.length });
      stopWrite();
      // Fold the asset's interface IPs into IP History so the timeline captures
      // every IP the device holds — including public WAN / secondary addresses,
      // which never become the primary `ipAddress` and so were previously absent
      // from the history. The primary IP is already recorded by the db.ts Prisma
      // extension; recordIpHistoryEntries skips it to avoid firstSeen churn on
      // the shared management address. Fire-and-forget — best-effort, never
      // blocks or fails the scrape.
      void recordIpHistoryEntries(
        assetId,
        monitorAssocEntries.map((e) => ({ ip: e.ip, source: e.source })),
        pinned?.ipAddress ?? null,
      );
    }
    // LLDP neighbors. `undefined` = the collector didn't run / unsupported
    // transport, so leave the existing rows alone. `[]` or a populated array
    // = queried successfully → replace the asset's neighbor set.
    if (Array.isArray(d.lldpNeighbors)) {
      const stopWrite = startSampleWriteTimer("asset_lldp_neighbors");
      const endLldp = startPhase("systeminfo.persist.lldp");
      await persistLldpNeighbors(assetId, d.lldpNeighbors, now, d.lldpSource ?? "fortios");
      endLldp({ neighbors: d.lldpNeighbors.length });
      stopWrite();
    }
    // Wireless stations (FortiAP only). Same undefined/[] semantics as LLDP —
    // undefined leaves rows alone, [] wipes them. Per-scrape full-replace
    // with NO 48h stickiness window: wireless clients are transient by
    // design and a missing station means the client roamed or disconnected.
    if (Array.isArray(d.wirelessStations)) {
      const stopWrite = startSampleWriteTimer("asset_wireless_stations");
      const endWireless = startPhase("systeminfo.persist.wireless");
      await persistWirelessStations(assetId, d.wirelessStations);
      endWireless({ stations: d.wirelessStations.length });
      stopWrite();
    }
    // Only bump lastSystemInfoAt when the scrape returned interfaces. The
    // /system-info GET endpoint anchors its interface query to this
    // timestamp, so bumping it on an empty interfaces[] silently empties the
    // System tab table — operators on REST API direct have seen FortiOS
    // return 200 OK with an empty results object (token without monitor
    // scope, VDOM weirdness, transient state) which used to slip past the
    // earlier "result.data is set" guard. Preserving the prior interface set
    // is strictly better than displaying nothing while the device is online.
    // The other streams (storage / ipsec / temperatures / lldp) read their
    // own latest-row timestamp and are written above unconditionally, so they
    // still refresh on every successful pull.
    if (d.interfaces.length > 0) {
      const endUpdate = startPhase("systeminfo.persist.update_asset");
      await prisma.asset.update({ where: { id: assetId }, data: { lastSystemInfoAt: now } });
      endUpdate();
    }
  }
}

/**
 * Replace the asset's SD-WAN rule rows with the latest scrape. CURRENT-STATE,
 * not a time-series: SD-WAN rules carry no history (only the SLA-metrics stream
 * does). Mirrors the LLDP / wireless-station delete-replace pattern — wipe the
 * asset's rows and re-insert the fresh set in one atomic transaction so a
 * concurrent reader sees either the old set or the new set, never an empty
 * intermediate. `asset_sdwan_rules` is a PLAIN table (not a hypertable), so the
 * delete-replace is compression-safe.
 */
async function persistSdwanRules(
  assetId: string,
  rules: SdwanRuleSample[],
): Promise<void> {
  const data = rules.map((r) => ({
    id:               randomUUID(),
    assetId,
    ruleName:         r.ruleName,
    ruleId:           r.ruleId,
    seq:              r.seq,
    enabled:          r.enabled,
    mode:             r.mode,
    criteria:         r.criteria,
    healthChecks:     r.healthChecks,
    dst:              r.dst,
    status:           r.status,
    selectedMember:   r.selectedMember,
    availableMembers: r.availableMembers,
    priorityZones:    r.priorityZones,
  }));
  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetSdwanRule.deleteMany({ where: { assetId } }),
      ...(data.length > 0
        ? [prisma.assetSdwanRule.createMany({ data, skipDuplicates: true })]
        : []),
    ]),
  );
}

/** One aggregated-by-name program row for the current-state process inventory. */
export interface AssetProcessInput {
  name:          string;
  instanceCount: number;
  cpuPct:        number | null;
  memRssBytes:   bigint | null;
  exePath:       string | null;
  username:      string | null;
  startedAt:     Date | null;
  serviceUnit:   string | null;
  controllable:  boolean;
}

/**
 * Current-state process inventory full-replace for one asset. Mirrors
 * persistSdwanRules: delete-then-insert in one $transaction (retryOnDeadlock),
 * so a reader sees either the old set or the new set, never an empty
 * intermediate. An empty `rows` is a valid delete-only scrape.
 */
export async function persistAssetProcesses(
  assetId: string,
  rows: AssetProcessInput[],
): Promise<void> {
  const data = rows.map((r) => ({
    id:            randomUUID(),
    assetId,
    name:          r.name,
    instanceCount: r.instanceCount,
    cpuPct:        r.cpuPct,
    memRssBytes:   r.memRssBytes,
    exePath:       r.exePath,
    username:      r.username,
    startedAt:     r.startedAt,
    serviceUnit:   r.serviceUnit,
    controllable:  r.controllable,
  }));
  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetProcess.deleteMany({ where: { assetId } }),
      ...(data.length > 0
        ? [prisma.assetProcess.createMany({ data, skipDuplicates: true })]
        : []),
    ]),
  );
}

/**
 * Replace the asset's LLDP neighbor rows with the latest scrape. Idempotent:
 * existing rows that match (assetId, localIfName, chassisId, portId) are
 * upserted in place so `firstSeen` survives across scrapes; rows in the table
 * that aren't in this scrape are deleted.
 *
 * `matchedAssetId` is resolved here by joining each neighbor against the asset
 * inventory by management IP, chassis MAC, and system name. The Device Map
 * topology endpoint reads this back to draw real edges to non-Fortinet gear
 * (LLDP catches what fortinetTopology can't see).
 */
async function persistLldpNeighbors(
  assetId: string,
  neighbors: LldpNeighborSample[],
  now: Date,
  defaultSource: "fortios" | "snmp" | string,
): Promise<void> {
  const endMatch = startPhase("systeminfo.persist.lldp_match_index");
  const matchIndex = await getLldpAssetMatchIndex();
  endMatch();
  const matchedFor = (n: LldpNeighborSample): string | null => {
    if (n.managementIp) {
      const m = matchIndex.byIp.get(n.managementIp);
      if (m && m !== assetId) return m;
    }
    if (n.chassisIdSubtype === "macAddress" && n.chassisId) {
      const mac = n.chassisId.toUpperCase();
      const m = matchIndex.byMac.get(mac);
      if (m && m !== assetId) return m;
    }
    // Workstation LLDP agents (Windows native, FortiClient, etc.) commonly
    // put the Ethernet MAC in portId(macAddress) rather than chassisId, so
    // the MAC arm above misses them. Try portId against the MAC index too.
    if (n.portIdSubtype === "macAddress" && n.portId) {
      const mac = n.portId.toUpperCase();
      const m = matchIndex.byMac.get(mac);
      if (m && m !== assetId) return m;
    }
    if (n.systemName) {
      const lower = n.systemName.toLowerCase();
      let m = matchIndex.byHostname.get(lower);
      // Belt-and-suspenders: if LLDP reports FQDN ("device.contoso.com")
      // and the index only has the short form, try the leftmost label too.
      // The index builder already adds short forms when it sees FQDNs, but
      // both directions defended.
      if (!m && lower.includes(".")) {
        m = matchIndex.byHostname.get(lower.split(".")[0]);
      }
      if (m && m !== assetId) return m;
    }
    // Some LLDP implementations leave systemName empty and put the hostname
    // in chassisId with subtype local(7) or chassisComponent(1). Treat any
    // non-MAC chassisId as a possible hostname when it looks printable.
    if (n.chassisId && n.chassisIdSubtype !== "macAddress") {
      const raw = String(n.chassisId).trim();
      // Skip values that look like MACs or contain whitespace — those won't
      // match a hostname index entry anyway, and we don't want to pollute
      // logs with bogus lookups.
      if (raw && !/\s/.test(raw) && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(raw)) {
        const lower = raw.toLowerCase();
        let m = matchIndex.byHostname.get(lower);
        if (!m && lower.includes(".")) {
          m = matchIndex.byHostname.get(lower.split(".")[0]);
        }
        if (m && m !== assetId) return m;
      }
    }
    return null;
  };

  // Existing rows for diffing. Keyed the same way the unique index is —
  // (localIfName, chassisId ?? "", portId ?? "") to handle Postgres-distinct nulls.
  const endFind = startPhase("systeminfo.persist.lldp_find_existing");
  const existing = await prisma.assetLldpNeighbor.findMany({ where: { assetId } });
  endFind({ rows: existing.length });
  const seen = new Set<string>();
  const keyOf = (li: string, ci: string | null | undefined, pi: string | null | undefined) =>
    `${li}\u0001${ci ?? ""}\u0001${pi ?? ""}`;
  const existingByKey = new Map<string, typeof existing[number]>();
  for (const e of existing) existingByKey.set(keyOf(e.localIfName, e.chassisId, e.portId), e);

  // Build a unified upsert list. Existing rows reuse their prior id (so the
  // ON CONFLICT (id) DO UPDATE branch fires and firstSeen survives); new rows
  // get a fresh randomUUID() so they don't collide and take the INSERT branch.
  // Both flow through one bulk statement — see bulkUpsertLldpNeighbors below
  // for why we target the PK instead of the (assetId, localIfName, chassisId,
  // portId) business key.
  const toUpsert: LldpUpsertRow[] = [];

  for (const n of neighbors) {
    const k = keyOf(n.localIfName, n.chassisId ?? null, n.portId ?? null);
    seen.add(k);
    const matched = matchedFor(n);
    const prior = existingByKey.get(k);
    toUpsert.push({
      id: prior?.id ?? randomUUID(),
      data: {
        localIfName:       n.localIfName,
        chassisIdSubtype:  n.chassisIdSubtype ?? null,
        chassisId:         n.chassisId ?? null,
        portIdSubtype:     n.portIdSubtype ?? null,
        portId:            n.portId ?? null,
        portDescription:   n.portDescription ?? null,
        systemName:        n.systemName ?? null,
        systemDescription: n.systemDescription ?? null,
        managementIp:      n.managementIp ?? null,
        capabilities:      n.capabilities ?? [],
        matchedAssetId:    matched,
        source:            defaultSource,
      },
    });
  }

  // Stickiness rule for stale rows. LLDP advertisements get missed
  // intermittently — a packet drops, a switch reboots, a peer briefly
  // unplugs — and a hard "delete on every scrape that doesn't see them"
  // rule made the operator-visible Neighbor column flap empty for those
  // gaps. Instead, keep the prior row for a 48-hour grace period UNLESS
  // a fresh scrape just learned a DIFFERENT neighbor on the same local
  // port (in which case the new value supersedes immediately — that's
  // a real topology change, not a missed advertisement).
  const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
  const portsWithFreshNeighbor = new Set<string>();
  for (const n of neighbors) portsWithFreshNeighbor.add(n.localIfName);
  const toDelete: string[] = [];
  for (const e of existing) {
    const k = keyOf(e.localIfName, e.chassisId, e.portId);
    if (seen.has(k)) continue; // refreshed by this scrape — keep
    // Same port saw a different neighbor → real change, drop the old.
    if (portsWithFreshNeighbor.has(e.localIfName)) {
      toDelete.push(e.id);
      continue;
    }
    // No fresh neighbor on this port; honor the 48h grace period before
    // declaring the row stale.
    const ageMs = now.getTime() - new Date(e.lastSeen).getTime();
    if (ageMs > STALE_AFTER_MS) {
      toDelete.push(e.id);
    }
  }
  // Single bulk upsert covers both creates and in-place updates — one SQL
  // round-trip instead of the legacy createMany + $transaction([per-row
  // updates]) pair (which held a connection for the duration of N pipelined
  // updates inside a BEGIN/COMMIT). On a switch with 40 LLDP neighbors that
  // collapses ~42 statements into 1.
  if (toUpsert.length > 0) {
    const endUpsert = startPhase("systeminfo.persist.lldp_upsert");
    await bulkUpsertLldpNeighbors(assetId, toUpsert, now);
    endUpsert({ rows: toUpsert.length });
  }
  if (toDelete.length > 0) {
    const endDelete = startPhase("systeminfo.persist.lldp_deleteMany");
    await retryOnDeadlock(() =>
      prisma.assetLldpNeighbor.deleteMany({ where: { id: { in: toDelete } } }),
    );
    endDelete({ rows: toDelete.length });
  }
}

type LldpUpsertRow = {
  id: string;
  data: {
    localIfName: string;
    chassisIdSubtype: string | null;
    chassisId: string | null;
    portIdSubtype: string | null;
    portId: string | null;
    portDescription: string | null;
    systemName: string | null;
    systemDescription: string | null;
    managementIp: string | null;
    capabilities: readonly string[];
    matchedAssetId: string | null;
    source: string;
  };
};

/**
 * Single-statement bulk upsert into asset_lldp_neighbors. Conflict target
 * is the primary key (id), NOT the (assetId, localIfName, chassisId, portId)
 * business-key unique constraint — Postgres treats NULL as distinct in
 * unique indexes, so a row with chassisId IS NULL would never match an
 * ON CONFLICT on the business key. The caller (persistLldpNeighbors) pre-
 * assigns ids by looking up prior rows in JS, so we know which inserts
 * should land as updates.
 *
 * `capabilities` (text[]) is encoded as an explicit ARRAY[$N,$N,$N]::text[]
 * expression per row rather than passing the JS array as a single bound
 * parameter — pg adapter behavior with array-typed parameters via
 * $executeRawUnsafe is undocumented in this codebase, so we stay on the
 * unambiguous path. For typical LLDP rows with 1-4 capability tokens this
 * adds a handful of extra parameter slots per row, well inside the 65535
 * parameter ceiling even for switches with hundreds of neighbors.
 */
async function bulkUpsertLldpNeighbors(
  assetId: string,
  rows: readonly LldpUpsertRow[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  const nowIso = now.toISOString();
  for (const r of rows) {
    const d = r.data;
    const capPlaceholders: string[] = [];
    for (const cap of d.capabilities) {
      params.push(cap);
      capPlaceholders.push(`$${p++}`);
    }
    const capExpr =
      capPlaceholders.length > 0
        ? `ARRAY[${capPlaceholders.join(",")}]::text[]`
        : `ARRAY[]::text[]`;
    const tupleParts = [
      `$${p++}::uuid`,            // id
      `$${p++}`,                  // assetId
      `$${p++}`,                  // localIfName
      `$${p++}`,                  // chassisIdSubtype
      `$${p++}`,                  // chassisId
      `$${p++}`,                  // portIdSubtype
      `$${p++}`,                  // portId
      `$${p++}`,                  // portDescription
      `$${p++}`,                  // systemName
      `$${p++}`,                  // systemDescription
      `$${p++}`,                  // managementIp
      capExpr,                    // capabilities
      `$${p++}`,                  // matchedAssetId
      `$${p++}`,                  // source
      `$${p++}::timestamp`,       // firstSeen
      `$${p++}::timestamp`,       // lastSeen
    ];
    tuples.push(`(${tupleParts.join(", ")})`);
    params.push(
      r.id,
      assetId,
      d.localIfName,
      d.chassisIdSubtype,
      d.chassisId,
      d.portIdSubtype,
      d.portId,
      d.portDescription,
      d.systemName,
      d.systemDescription,
      d.managementIp,
      d.matchedAssetId,
      d.source,
      nowIso,
      nowIso,
    );
  }
  const sql =
    `INSERT INTO "asset_lldp_neighbors" (` +
    `"id", "assetId", "localIfName", ` +
    `"chassisIdSubtype", "chassisId", "portIdSubtype", "portId", ` +
    `"portDescription", "systemName", "systemDescription", "managementIp", ` +
    `"capabilities", "matchedAssetId", "source", "firstSeen", "lastSeen"` +
    `) VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT ("id") DO UPDATE SET ` +
    `"chassisIdSubtype"  = EXCLUDED."chassisIdSubtype", ` +
    `"chassisId"         = EXCLUDED."chassisId", ` +
    `"portIdSubtype"     = EXCLUDED."portIdSubtype", ` +
    `"portId"            = EXCLUDED."portId", ` +
    `"portDescription"   = EXCLUDED."portDescription", ` +
    `"systemName"        = EXCLUDED."systemName", ` +
    `"systemDescription" = EXCLUDED."systemDescription", ` +
    `"managementIp"      = EXCLUDED."managementIp", ` +
    `"capabilities"      = EXCLUDED."capabilities", ` +
    `"matchedAssetId"    = EXCLUDED."matchedAssetId", ` +
    `"source"            = EXCLUDED."source", ` +
    `"lastSeen"          = EXCLUDED."lastSeen"`;
  await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
}

/**
 * Persist a fapStationTable scrape into `AssetWirelessStation`. Full-replace
 * semantics per (apAssetId, staMacAddr): every row that's in the fresh
 * scrape is upserted (timestamps + ssid/signal/etc bumped), every stored
 * row absent from the fresh scrape is deleted. **No 48h stickiness** —
 * wireless clients are transient by design; a station that roamed or
 * disconnected should drop from the table immediately.
 *
 * `matchedAssetId` is resolved by MAC lookup against the endpoint
 * inventory using the same cached index LLDP uses. When a match lands,
 * the endpoint's `Asset.lastSeenAp` is bumped to the AP's hostname so the
 * endpoint's asset details page shows which AP last saw it.
 */
async function persistWirelessStations(
  apAssetId: string,
  stations: WirelessStationSample[],
): Promise<void> {
  // Reuse the LLDP match index — same lookup shape (MAC → assetId) and the
  // 60 s TTL already covers the system-info cadence. Wireless rows only
  // match by MAC (the index also carries IP / hostname maps but those are
  // not relevant here — a station's MAC is the only stable identity in
  // the AP's view).
  const matchIndex = await getLldpAssetMatchIndex();

  // Look up the AP's hostname once so we can stamp every matched endpoint's
  // lastSeenAp without re-fetching per-station.
  const apRow = await prisma.asset.findUnique({
    where: { id: apAssetId },
    select: { hostname: true },
  });
  const apHostname = apRow?.hostname ?? null;

  // Existing rows for diffing. Keyed by MAC (the unique constraint half
  // that varies — apAssetId is fixed for this call).
  const existing = await prisma.assetWirelessStation.findMany({ where: { apAssetId } });
  const existingByMac = new Map<string, typeof existing[number]>();
  for (const e of existing) existingByMac.set(e.staMacAddr, e);

  const seen = new Set<string>();
  const toUpsert: WirelessUpsertRow[] = [];
  // Endpoint-side `lastSeenAp` stamps. One per matched station; deduplicated
  // by endpoint id so a single AP with N rooms-worth of clients still hits
  // each endpoint's row once.
  const endpointStamps = new Map<string, string>(); // assetId → apHostname

  for (const s of stations) {
    const mac = s.staMacAddr.toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) continue; // malformed; skip
    seen.add(mac);
    const matchedAssetId = matchIndex.byMac.get(mac) ?? null;
    if (matchedAssetId && matchedAssetId !== apAssetId && apHostname) {
      endpointStamps.set(matchedAssetId, apHostname);
    }
    const ex = existingByMac.get(mac);
    toUpsert.push({
      id: ex?.id ?? randomUUID(),
      data: {
        staMacAddr:     mac,
        staIpAddr:      s.staIpAddr ?? null,
        ssid:           s.ssid ?? null,
        radioId:        s.radioId ?? null,
        wlanId:         s.wlanId ?? null,
        band:           s.band ?? null,
        vlanId:         s.vlanId ?? null,
        bssid:          s.bssid ?? null,
        signalStrength: s.signalStrength ?? null,
        noise:          s.noise ?? null,
        bandwidthTx:    s.bandwidthTx ?? null,
        bandwidthRx:    s.bandwidthRx ?? null,
        idleSeconds:    s.idleSeconds ?? null,
        matchedAssetId,
        // Station identity comes from SNMP fapStationTable; signal/noise are an
        // optional FortiOS-REST overlay from the controller (wifi/client).
        source:         (s.signalStrength != null || s.noise != null) ? "snmp+rest" : "snmp",
      },
    });
  }

  // Anything stored but not in the fresh scrape → drop. Same semantics as
  // associatedIp's monitor-source rows: per-scrape full-replace, no grace
  // period.
  const toDelete: string[] = [];
  for (const e of existing) {
    if (!seen.has(e.staMacAddr)) toDelete.push(e.id);
  }

  if (toUpsert.length > 0) {
    await bulkUpsertWirelessStations(apAssetId, toUpsert, new Date());
  }
  if (toDelete.length > 0) {
    await retryOnDeadlock(() =>
      prisma.assetWirelessStation.deleteMany({ where: { id: { in: toDelete } } }),
    );
  }

  // Stamp each matched endpoint's lastSeenAp. Don't block the persist on
  // these — they're operator-visible breadcrumbs, not load-bearing data —
  // but await so the System tab sees the change on the next refresh.
  //
  // Deterministic lock ordering: sort the updates by asset id so EVERY
  // concurrent endpoint-stamp transaction acquires its `assets` row locks in
  // the same order. The PG deadlock log showed a 3-way cycle where all three
  // participants were exactly this lastSeenAp UPDATE — two/three APs whose
  // stations match an overlapping endpoint set were locking those rows in
  // different (Map-insertion) order. Sorting by id makes the cycle
  // impossible. `$transaction([...])` executes the array sequentially, so the
  // sort order IS the lock-acquisition order.
  //
  // retryOnDeadlock stays as a backstop for any residual collision (e.g. this
  // txn vs the probe-patch bulk Asset UPDATE, which locks in its own order).
  // The op is idempotent (last-write-wins stamp) so re-run is safe.
  if (endpointStamps.size > 0) {
    const orderedStamps = [...endpointStamps.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    await retryOnDeadlock(() =>
      prisma.$transaction(
        orderedStamps.map(([endpointId, ap]) =>
          prisma.asset.update({ where: { id: endpointId }, data: { lastSeenAp: ap } }),
        ),
      ),
    );
  }
}

type WirelessUpsertRow = {
  id: string;
  data: {
    staMacAddr: string;
    staIpAddr: string | null;
    ssid: string | null;
    radioId: number | null;
    wlanId: number | null;
    band: string | null;
    vlanId: number | null;
    bssid: string | null;
    signalStrength: number | null;
    noise: number | null;
    bandwidthTx: number | null;
    bandwidthRx: number | null;
    idleSeconds: number | null;
    matchedAssetId: string | null;
    source: string;
  };
};

/**
 * Single-statement bulk upsert into asset_wireless_stations. Same shape as
 * `bulkUpsertLldpNeighbors` — conflict target is the PK so callers control
 * insert-vs-update by pre-assigning ids. Replaces the legacy createMany +
 * $transaction([per-row updates]) pair (which held a connection across N
 * pipelined updates inside BEGIN/COMMIT). No text[] field to worry about,
 * so the per-row tuple is a straight parameter list.
 */
async function bulkUpsertWirelessStations(
  apAssetId: string,
  rows: readonly WirelessUpsertRow[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  const nowIso = now.toISOString();
  for (const r of rows) {
    const d = r.data;
    const tupleParts = [
      `$${p++}::uuid`,            // id
      `$${p++}`,                  // apAssetId
      `$${p++}`,                  // staMacAddr
      `$${p++}`,                  // staIpAddr
      `$${p++}`,                  // ssid
      `$${p++}`,                  // radioId
      `$${p++}`,                  // wlanId
      `$${p++}`,                  // band
      `$${p++}`,                  // vlanId
      `$${p++}`,                  // bssid
      `$${p++}`,                  // signalStrength
      `$${p++}`,                  // noise
      `$${p++}`,                  // bandwidthTx
      `$${p++}`,                  // bandwidthRx
      `$${p++}`,                  // idleSeconds
      `$${p++}`,                  // matchedAssetId
      `$${p++}`,                  // source
      `$${p++}::timestamp`,       // firstSeen
      `$${p++}::timestamp`,       // lastSeen
    ];
    tuples.push(`(${tupleParts.join(", ")})`);
    params.push(
      r.id,
      apAssetId,
      d.staMacAddr,
      d.staIpAddr,
      d.ssid,
      d.radioId,
      d.wlanId,
      d.band,
      d.vlanId,
      d.bssid,
      d.signalStrength,
      d.noise,
      d.bandwidthTx,
      d.bandwidthRx,
      d.idleSeconds,
      d.matchedAssetId,
      d.source,
      nowIso,
      nowIso,
    );
  }
  const sql =
    `INSERT INTO "asset_wireless_stations" (` +
    `"id", "apAssetId", "staMacAddr", ` +
    `"staIpAddr", "ssid", "radioId", "wlanId", "band", "vlanId", ` +
    `"bssid", "signalStrength", "noise", "bandwidthTx", "bandwidthRx", ` +
    `"idleSeconds", "matchedAssetId", "source", "firstSeen", "lastSeen"` +
    `) VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT ("id") DO UPDATE SET ` +
    `"staIpAddr"      = EXCLUDED."staIpAddr", ` +
    `"ssid"           = EXCLUDED."ssid", ` +
    `"radioId"        = EXCLUDED."radioId", ` +
    `"wlanId"         = EXCLUDED."wlanId", ` +
    `"band"           = EXCLUDED."band", ` +
    `"vlanId"         = EXCLUDED."vlanId", ` +
    `"bssid"          = EXCLUDED."bssid", ` +
    `"signalStrength" = EXCLUDED."signalStrength", ` +
    `"noise"          = EXCLUDED."noise", ` +
    `"bandwidthTx"    = EXCLUDED."bandwidthTx", ` +
    `"bandwidthRx"    = EXCLUDED."bandwidthRx", ` +
    `"idleSeconds"    = EXCLUDED."idleSeconds", ` +
    `"matchedAssetId" = EXCLUDED."matchedAssetId", ` +
    `"source"         = EXCLUDED."source", ` +
    `"lastSeen"       = EXCLUDED."lastSeen"`;
  await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
}

/**
 * Build a lookup table for asset-matching neighbors. One pass over the asset
 * table at persist time is cheaper than per-neighbor queries; the table is
 * kept in scope only for the duration of a single recordSystemInfoResult call.
 *
 * - byIp: ipAddress + every row in asset_associated_ips (manual + monitor-discovered)
 * - byMac: macAddress (uppercased) + every entry in macAddresses
 * - byHostname: hostname (lowercased) — first wins on duplicates
 */
// ─── LLDP match-index cache ───────────────────────────────────────────────
//
// `persistLldpNeighbors` used to call `buildLldpAssetMatchIndex` on every
// system-info pass — for each monitored asset that returned an LLDP scrape
// we'd findMany over EVERY asset row (plus its associated IP and MAC side
// tables) just to build the IP/MAC/hostname lookup maps. At 1700 monitored
// assets that's the heaviest single read in the monitor hot loop.
//
// Cache the index for 60 s. Asset hostnames / IPs / MACs change slowly
// enough that the worst-case stale-cache effect is one cycle of "LLDP
// neighbor resolved to the wrong asset" which corrects itself on the next
// scrape. Single-process module-level cache; no inter-process invalidation
// needed because the workers are all in one node process.
//
// Discovery code that materially changes the lookup keys (asset rename,
// IP change, MAC add/remove) can call `invalidateLldpMatchCache()` to drop
// the cache before its next read — but the TTL is short enough that
// explicit invalidation is optional, and most discovery writes don't need
// it. Currently nobody calls it; the TTL is the source of truth.
const LLDP_MATCH_CACHE_TTL_MS = 60_000;
interface LldpMatchIndex {
  byIp: Map<string, string>;
  byMac: Map<string, string>;
  byHostname: Map<string, string>;
}
let lldpMatchCache: LldpMatchIndex | null = null;
let lldpMatchCachedAt = 0;
let lldpMatchInflight: Promise<LldpMatchIndex> | null = null;

async function getLldpAssetMatchIndex(): Promise<LldpMatchIndex> {
  const now = Date.now();
  if (lldpMatchCache && now - lldpMatchCachedAt < LLDP_MATCH_CACHE_TTL_MS) {
    return lldpMatchCache;
  }
  // De-duplicate concurrent builders. Many parallel systemInfo workers can
  // hit this within the same TTL miss window — let only the first one issue
  // the findMany; the rest await the same promise.
  if (lldpMatchInflight) return lldpMatchInflight;
  lldpMatchInflight = buildLldpAssetMatchIndex().then((idx) => {
    lldpMatchCache = idx;
    lldpMatchCachedAt = Date.now();
    return idx;
  }).finally(() => {
    lldpMatchInflight = null;
  });
  return lldpMatchInflight;
}

/** Drop the cached LLDP match index so the next `persistLldpNeighbors`
 *  call rebuilds from a fresh findMany. Currently unused — discovery code
 *  relies on the 60 s TTL for refresh. Exported for tests and for future
 *  callers that want explicit control after a bulk asset write. */
export function invalidateLldpMatchCache(): void {
  lldpMatchCache = null;
  lldpMatchCachedAt = 0;
}

async function buildLldpAssetMatchIndex(): Promise<{
  byIp: Map<string, string>;
  byMac: Map<string, string>;
  byHostname: Map<string, string>;
}> {
  // Always-on logging around the full-fleet findMany: the rebuild fires at
  // most every 60 s on TTL miss, so log volume is bounded, and "the rebuild
  // wedged" is one of the leading hypotheses for systemInfo handler stalls
  // (every concurrent handler awaits the same inflight Promise — if it
  // never settles, every awaiter times out together). Pair of start +
  // complete lines gives the operator wall-clock for the rebuild itself.
  const startedAt = Date.now();
  logger.info({ phase: "lldp_match_index.rebuild_start" }, "LLDP match index rebuild started");
  const rows = await prisma.asset.findMany({
    select: {
      id: true, ipAddress: true, macAddress: true, hostname: true, dnsName: true,
      associatedIpRows: { select: { ip: true } },
      macAddressRows:   { select: { mac: true } },
    },
  });
  logger.info(
    { phase: "lldp_match_index.rebuild_complete", elapsedMs: Date.now() - startedAt, assets: rows.length },
    "LLDP match index rebuild complete",
  );
  const byIp = new Map<string, string>();
  const byMac = new Map<string, string>();
  const byHostname = new Map<string, string>();
  // Helper: index a hostname-shaped string under the asset id, including
  // the leftmost label when it's an FQDN. Symmetric coverage matters for
  // LLDP matching: a FortiGate's `Asset.hostname` is "PEORIA-61F-1" (short
  // form, set by the fortigate-firewall source) but the device advertises
  // itself via LLDP as "PEORIA-61F-1.rogersgroupinc.com" (FQDN). The
  // lookup side already lowercases; we just need both forms in the index.
  const idxHostname = (raw: string | null, assetId: string) => {
    if (!raw) return;
    const lower = raw.toLowerCase().trim();
    if (!lower) return;
    if (!byHostname.has(lower)) byHostname.set(lower, assetId);
    const dotIdx = lower.indexOf(".");
    if (dotIdx > 0) {
      const shortForm = lower.slice(0, dotIdx);
      if (!byHostname.has(shortForm)) byHostname.set(shortForm, assetId);
    }
  };
  for (const a of rows) {
    if (a.ipAddress && !byIp.has(a.ipAddress)) byIp.set(a.ipAddress, a.id);
    for (const row of a.associatedIpRows) {
      if (row.ip && !byIp.has(row.ip)) byIp.set(row.ip, a.id);
    }
    if (a.macAddress) {
      const mac = a.macAddress.toUpperCase();
      if (!byMac.has(mac)) byMac.set(mac, a.id);
    }
    for (const row of a.macAddressRows) {
      if (row.mac) {
        const mac = row.mac.toUpperCase();
        if (!byMac.has(mac)) byMac.set(mac, a.id);
      }
    }
    idxHostname(a.hostname, a.id);
    // Also index dnsName when set — covers AD-discovered hosts where the
    // FQDN lives on dnsName separately, and LLDP advertises the hostname
    // form which might differ.
    idxHostname(a.dnsName, a.id);
  }
  return { byIp, byMac, byHostname };
}

/**
 * Build the per-interface monitor-source rows for the asset_associated_ips
 * table from a fresh interface scrape. Pure: takes the interface samples,
 * returns rows ready for createMany. Caller (recordSystemInfoResult) does
 * the delete-and-replace transaction; manual entries are preserved by
 * filtering on source there.
 *
 * Empty result is meaningful — it tells the caller to skip the persist
 * entirely so a transient "scrape returned no interface IPs" doesn't wipe
 * an existing monitor-source set.
 */
function buildMonitorAssocIpEntries(
  interfaces: InterfaceSample[],
  now: Date,
): Array<{
  ip: string;
  source: string;
  interfaceName: string | null;
  mac: string | null;
  lastSeen: Date;
  firstSeen: Date;
}> {
  const out: Array<{
    ip: string; source: string; interfaceName: string | null;
    mac: string | null; lastSeen: Date; firstSeen: Date;
  }> = [];
  const seenIps = new Set<string>();
  for (const i of interfaces) {
    if (!i.ipAddress) continue;
    if (seenIps.has(i.ipAddress)) continue; // dedupe within a single scrape
    seenIps.add(i.ipAddress);
    out.push({
      ip:            i.ipAddress,
      source:        "monitor-system-info",
      interfaceName: i.ifName,
      mac:           i.macAddress ?? null,
      lastSeen:      now,
      firstSeen:     now,
    });
  }
  return out;
}

// ─── Persisting a probe result ──────────────────────────────────────────────

/**
 * Apply a probe result to the asset row + history. Updates
 * monitorStatus / consecutiveFailures, writes one AssetMonitorSample, and
 * fires a single monitor.status_changed Event on transition.
 */
export async function recordProbeResult(
  assetId: string,
  result: ProbeResult,
  /** Optional pre-loaded asset row. The cursor + pg-boss hot loop already
   *  loaded the asset inside probeAsset; passing it here skips a second
   *  findUnique per probe, cutting steady-state pool acquisitions at peak. */
  preloadedAsset?: AssetMonitorSnapshot | null,
  /** Set by the Polaris Agent /samples handler when the result came from
   *  the agent on the host (a real RTT, not the synthetic periodic-tick).
   *  Bypasses the agent-polling guard below so the agent's real samples
   *  drive the five-state machine. The default (periodic-loop callers
   *  leaving this false/undefined) keeps the guard active so the
   *  synthetic no-op probeAsset doesn't churn state. */
  opts?: { fromAgent?: boolean },
): Promise<void> {
  const loaded = preloadedAsset ?? await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      hostname: true,
      assetType: true,
      monitored: true,
      monitorStatus: true,
      lastUptimeSec: true,
      consecutiveFailures: true,
      consecutiveSuccesses: true,
      discoveredByIntegrationId: true,
      monitorIntervalSec: true,
      cpuMemoryIntervalSec: true,
      temperatureIntervalSec: true,
      systemInfoIntervalSec: true,
      probeTimeoutMs: true,
    },
  });
  if (!loaded) return;

  // Overlay any pending probe-patch buffer entry onto the loaded row so the
  // state machine reads its own writes within the flush window. Without this
  // overlay, two back-to-back failed probes inside the same 2 s window would
  // each see consecutiveFailures=0 on disk and each compute newCf=1; the
  // second probe's patch would overwrite the first and the failureThreshold
  // counter would never advance past 1. The overlay only touches the three
  // fields the state machine uses; everything else (hostname, assetType,
  // intervals, etc.) flows through unchanged from the DB read.
  const pending = getPendingProbePatch(assetId);
  const asset = pending
    ? {
        ...loaded,
        monitorStatus:        pending.monitorStatus,
        consecutiveFailures:  pending.consecutiveFailures,
        consecutiveSuccesses: pending.consecutiveSuccesses,
      }
    : loaded;

  // Resolve effective settings through the hierarchy. failureThreshold doubles
  // as the recovery threshold — we use it for both up→down and pending→up
  // transitions. Same number of confirmations either direction.
  const effective = await resolveMonitorSettings(asset);
  const threshold = effective.failureThreshold;

  // Agent-mode response-time: the Polaris Agent runs on the host and pushes
  // its own samples (with real RTTs) through POST /api/v1/agents/samples.
  // Periodic-tick probeAsset for these assets returns a synthetic success;
  // we MUST NOT let that synthetic result run the state machine or write
  // an AssetMonitorSample row — it would clobber the agent's real signal.
  // The /samples inbound handler calls this function with opts.fromAgent
  // so the agent's real samples DO drive the state machine.
  if (effective.responseTimePolling === "agent" && !opts?.fromAgent) return;

  const now = new Date();
  const previousStatus = asset.monitorStatus ?? "unknown";
  // Counter update: success path zeroes failures + bumps successes; failure
  // path zeroes successes + bumps failures. Either path resets the opposite
  // counter so the in-flight transition is unambiguous.
  const newCf = result.success ? 0                                        : (asset.consecutiveFailures  ?? 0) + 1;
  const newCs = result.success ? (asset.consecutiveSuccesses ?? 0) + 1     : 0;

  // Five-state machine. See CLAUDE.md "Monitor Settings Hierarchy" /
  // "Monitor status state machine" for the table.
  //
  //   unknown / down + success → recovering (until cs ≥ threshold → up)
  //   recovering        + success → up if cs ≥ threshold else stay recovering
  //   recovering        + failure → down if cf ≥ threshold else stay recovering
  //   up                + failure → warning (cf=1, count toward down)
  //   warning           + success → up if cs ≥ threshold else stay warning
  //   warning           + failure → down if cf ≥ threshold else stay warning
  //   unknown           + failure → warning (treat as fresh up that just failed)
  //
  // Down hosts that fail again stay down; the down→recovering arrow is the
  // only exit from down and requires at least one success. The previous name
  // for this state was "pending"; the migrateMonitorStatusRename startup job
  // bumps any leftover "pending" rows to "recovering".
  let nextStatus: "up" | "warning" | "recovering" | "down" | "unknown";
  if (result.success) {
    if (previousStatus === "up") {
      nextStatus = "up";
    } else if (previousStatus === "warning" || previousStatus === "recovering") {
      nextStatus = newCs >= threshold ? "up" : previousStatus;
    } else {
      // unknown / down → start the recovery counter at recovering.
      nextStatus = newCs >= threshold ? "up" : "recovering";
    }
  } else {
    if (newCf >= threshold) {
      nextStatus = "down";
    } else if (previousStatus === "up" || previousStatus === "unknown") {
      nextStatus = "warning";
    } else if (previousStatus === "warning" || previousStatus === "recovering" || previousStatus === "down") {
      // Stay in the current state and let the counter march toward "down".
      nextStatus = previousStatus as "warning" | "recovering" | "down";
    } else {
      nextStatus = "warning";
    }
  }

  // Buffer the sample row — the periodic flush in sampleWriteBuffer will
  // batch this with every other monitor sample seen in the same 2 s
  // window into one createMany. Cuts per-probe pool acquisitions from
  // (read + create + update) to (read + update); the sample inserts
  // collapse from N individual creates to one createMany per flush.
  // Reboot detection: the SNMP probe reads sysUpTime as its reachability OID;
  // a decrease vs. the last reading means the device rebooted between probes.
  // A small tolerance avoids false positives from counter wrap / clock skew on
  // a flat reading. Only meaningful when this probe carried an uptime value.
  const uptimeSec = result.success && typeof result.uptimeSec === "number" ? result.uptimeSec : null;
  const prevUptimeSec = asset.lastUptimeSec ?? null;
  const rebooted = uptimeSec !== null && prevUptimeSec !== null && uptimeSec < prevUptimeSec - 60;

  enqueueMonitorSample({
    assetId,
    timestamp: now,
    success: result.success,
    responseTimeMs: result.success ? result.responseTimeMs : null,
    error: result.success ? null : (result.error ?? null),
    uptimeSec,
  });

  // Buffer the state write — the periodic flush in probePatchBuffer collapses
  // every patch seen in the same 2 s window into one bulk UPDATE FROM VALUES
  // statement, cutting per-probe pool acquisitions from one prisma.asset.update
  // per asset to one bulk update per flush across the whole fleet. The
  // overlay above means the state machine still reads its own writes within
  // the window; the side effects below (Event log, propagate hook, retry
  // hook) all run synchronously on in-memory values so audit + latency-
  // optimization paths don't wait for the flush. Stamp monitorStatusChangedAt
  // on every state change (up↔warning↔recovering↔down, including
  // unknown→anything). The Event log fires on transitions into up / warning /
  // down (see below); this column is the source for the Dashboard Monitor
  // Alerts duration.
  enqueueProbePatch(assetId, {
    monitorStatus: nextStatus,
    lastMonitorAt: now,
    lastResponseTimeMs: result.success ? result.responseTimeMs : null,
    consecutiveFailures: newCf,
    consecutiveSuccesses: newCs,
    monitorStatusChangedAt: previousStatus !== nextStatus ? now : undefined,
    // Advance the stored uptime to this reading (undefined leaves it
    // untouched on non-SNMP probes — see the COALESCE in probePatchBuffer);
    // stamp the reboot timestamp only when a drop was detected this tick.
    lastUptimeSec: uptimeSec ?? undefined,
    lastRebootAt: rebooted ? now : undefined,
  });

  // Reboot is an edge-triggered audit event, like monitor.status_changed.
  // resourceName/details carry hostname + IP so the Recent Reboots widget can
  // render without re-reading the Asset.
  if (rebooted) {
    logEvent({
      action: "device.reboot",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: asset.hostname || undefined,
      level: "warning",
      message: `Reboot detected: ${asset.hostname || assetId} uptime ${prevUptimeSec}s → ${uptimeSec}s`,
      details: { hostname: asset.hostname ?? null, previousUptimeSec: prevUptimeSec, uptimeSec },
    });
  }

  // Edge-triggered audit events. We log on the transition INTO up / warning /
  // down — never per-poll (up→up, warning→warning, etc. don't fire because
  // previousStatus === nextStatus). This yields exactly: the first successful
  // poll (→up, including the back-up-after-down recovery), the first warning
  // (→warning), and the first down (→down). "recovering" and "unknown" are
  // intermediate and never logged. The propagate / retry side-effects below
  // stay gated to confirmed up/down only — a "warning" is not a confirmed
  // up/down edge for dependency suppression or queued-push retry.
  if (previousStatus !== nextStatus && (nextStatus === "up" || nextStatus === "warning" || nextStatus === "down")) {
    logEvent({
      action: "monitor.status_changed",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: asset.hostname || undefined,
      level: nextStatus === "up" ? "info" : "warning",
      message:
        `Monitor: ${asset.hostname || assetId} ${previousStatus} → ${nextStatus}` +
        (result.error ? ` (${result.error})` : ""),
      details: {
        previousStatus,
        nextStatus,
        responseTimeMs: result.success ? result.responseTimeMs : null,
        error: result.error ?? null,
        consecutiveFailures:  newCf,
        consecutiveSuccesses: newCs,
      },
    });
  }

  if (previousStatus !== nextStatus && (nextStatus === "up" || nextStatus === "down")) {
    // Fire-and-forget latency hook: propagate the confirmed-up / confirmed-down
    // edge into descendant `dependencySuppressed` state immediately so heavy
    // cadences pause within milliseconds of the parent flipping to "down"
    // (and resume the moment it recovers). The 60s reconciler is the source
    // of truth; this just shortens the worst-case lag from ~60s to one
    // probe-tick on the parent.
    void propagateAfterStatusChange(assetId);
    // When a firewall comes back up, kick the queued-reservation retry job
    // so pending DHCP reservations on its subnets push immediately instead
    // of waiting for the next 60s retryQueuedReservationPushes tick. The
    // helper short-circuits to zero work when nothing is queued, so this is
    // cheap even on every up-transition.
    if (nextStatus === "up") {
      void triggerRetryAfterStatusChange(assetId);
    }
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

export type MonitorCadence = "probe" | "telemetry" | "systemInfo" | "fastFiltered" | "lldp" | "storage";

/**
 * Per-cadence outcome tally returned by the runFooFor() functions. Used by
 * both runMonitorPass (rolls into RunStats) and the upcoming pg-boss workers
 * (logs only; pg-boss tracks job state independently). `crash` is reserved
 * for unexpected exceptions; `failure` covers expected sad-path returns
 * like "probe ran but credential failed" or "telemetry returned no data".
 */
export type CadenceOutcome = "success" | "failure" | "crash";

/**
 * Per-work-item label set, stamped onto the work-duration histogram +
 * outcome counter so operators can slice by device-class × transport to
 * find which combo is the bottleneck. Callers that already know these (the
 * monitorAssets publisher and runMonitorPass) pass them in to avoid a
 * second DB read on the worker side; legacy callers pass "unknown".
 */
export interface WorkItemLabels {
  /** Resolved per-cadence polling method (probe=responseTimePolling, telemetry=telemetryPolling, systemInfo+fastFiltered=interfacesPolling). */
  transport: string;
  /** Asset.assetType (one of the 8 AssetType enum values). */
  assetType: string;
  /**
   * Enable verbose per-phase timing logs for this work item. Forwarded from
   * the pg-boss job payload's `verboseDebug` flag (which is set by the
   * publisher when the asset's source integration has `config.verboseLogging`
   * on). Routed through `monitorPhaseStorage.run` at the runFooFor entry
   * point so every `startPhase` call inside the async chain emits a
   * `monitor.phase` log line. Never stamped into Prometheus labels —
   * cardinality stays bounded.
   */
  verbose?: boolean;
}

/**
 * Run a single response-time probe for one asset, write the sample, update
 * Asset row state (monitorStatus / lastMonitorAt / consecutiveFailures),
 * record metrics. `labels` stamp the work histogram + per-transport probe
 * histogram so operators can slice by asset_type × transport.
 */
export async function runProbeFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("probe", labels);
  const probeStart = Date.now();
  try {
    // probeAsset stashes its loaded asset row into `probeOut.snapshot` so
    // recordProbeResult can reuse it for the state-machine update — one
    // findUnique per probe instead of two.
    const probeOut: { snapshot?: AssetMonitorSnapshot } = {};
    const result = await probeAsset(assetId, probeOut);
    const probeMs = Date.now() - probeStart;
    await recordProbeResult(assetId, result, probeOut.snapshot ?? null);
    if (result.success) {
      recordProbe(labels.transport, probeMs / 1000, "success");
      recordWorkOutcome("probe", "success", labels);
      return "success";
    }
    recordProbe(labels.transport, probeMs / 1000, "failure");
    recordWorkOutcome("probe", "failure", labels);
    return "failure";
  } catch (err) {
    const probeMs = Date.now() - probeStart;
    logger.error({ err, assetId }, "Monitor probe crashed");
    recordProbe(labels.transport, probeMs / 1000, "failure");
    recordWorkOutcome("probe", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Telemetry pull (CPU/memory + hardware sensors) for one asset. The two
 * streams dispatch independently — cpuMemoryPolling drives CPU/memory while
 * temperaturePolling drives the hardware-sensor scrape — but they run together
 * on the telemetry cadence trigger. Returns `success` on a clean run
 * regardless of whether data was collected (supported=false is a normal
 * outcome for ICMP/SSH-monitored assets). `failure` means at least one
 * supported stream returned no data (timed-out, rejected, etc.).
 */
export async function runTelemetryFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("telemetry", labels);
  try {
    // Run CPU/memory and temperature in parallel — different transports
    // (possibly different credentials, MIBs, even different protocols), so
    // serializing would double the wall-time of a typical telemetry pass.
    // Each catch keeps a transport failure on one stream from poisoning the
    // other; thrown errors are packaged into the result shape.
    const [tr, temp] = await Promise.all([
      collectTelemetry(assetId).catch((err: unknown) => {
        logger.debug({ err, assetId }, "CPU/memory collection threw");
        return { supported: true, error: (err as Error)?.message || "Telemetry collection failed" } as CollectionResult<TelemetrySample>;
      }),
      collectHardwareSensors(assetId).catch((err: unknown) => {
        logger.debug({ err, assetId }, "Hardware sensor collection threw");
        return { supported: true, error: (err as Error)?.message || "Hardware sensor collection failed" } as CollectionResult<HardwareSensorSample[]>;
      }),
    ]);
    await Promise.all([
      recordTelemetryResult(assetId, tr),
      recordHardwareSensorResult(assetId, temp),
    ]);
    // Custom widgets ride the telemetry cadence (Slice 7b). Fire-and-forget
    // so a slow walk on one widget can't drag the telemetry tick — failures
    // log inside the helper without escalating to a cadence crash.
    void collectAndRecordCustomWidgets(assetId).catch((err) => {
      logger.debug({ err, assetId }, "Custom widget collection failed");
    });
    // Outcome aggregates both streams. Success when each stream either
    // delivered (data present, including empty array for a sensor-less
    // device) or wasn't supported on this transport in the first place;
    // failure when at least one supported stream came back with an error
    // and no data.
    const cpuMemOk = !tr.supported   || tr.data   !== undefined;
    const tempOk   = !temp.supported || temp.data !== undefined;
    if (cpuMemOk && tempOk) {
      recordWorkOutcome("telemetry", "success", labels);
      return "success";
    }
    recordWorkOutcome("telemetry", "failure", labels);
    return "failure";
  } catch (err) {
    logger.error({ err, assetId }, "Telemetry collection crashed");
    recordWorkOutcome("telemetry", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

// ─── Custom widget collector (Slice 7b) ──────────────────────────────────
// Walks each applicable ManufacturerCustomWidget against the asset via
// SNMP, persists results into AssetCustomWidgetSample, and bumps the
// asset's lastCustomWidgetAt timestamp. SNMP-only in v1 — operators who
// need FortiOS REST custom queries should define them as SNMP symbols via
// FORTINET-FORTIGATE-MIB equivalents (the editor's symbol picker doesn't
// distinguish today, but only SNMP symbols actually walk here).
//
// The collector reuses the asset's already-resolved customWidgetPolling /
// customWidgetCredential / customWidgetTimeoutMs settings; when polling
// resolves to "disabled" the pass is silently skipped so the
// Asset.lastCustomWidgetAt stays stale (the tab surfaces a banner).
async function collectAndRecordCustomWidgets(assetId: string): Promise<void> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: {
      monitorCredential:       true,
      cpuMemoryCredential:     true,
      customWidgetCredential:  true,
      discoveredByIntegration: true,
    },
  });
  if (!asset || !asset.monitored || !asset.manufacturer) return;

  const { getProfileFor } = await import("./manufacturerProfileService.js");
  const profile = getProfileFor(asset.manufacturer);
  if (!profile || profile.widgets.length === 0) return;

  // Per-model gating mirrors the read-endpoint filter.
  const modelStr = asset.model ?? "";
  const widgets = profile.widgets.filter((w) => {
    if (!w.modelPattern) return true;
    try { return new RegExp(w.modelPattern, "i").test(modelStr); }
    catch { return false; }
  });
  if (widgets.length === 0) return;

  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  // Custom-widget polling falls back to cpuMemoryPolling — same SNMP
  // transport is the usual setup, and operators who flipped the asset to
  // disabled telemetry probably don't want widget walks either. "disabled"
  // explicit on customWidgetPolling skips the pass outright.
  //
  // customWidgetPolling/customWidgetTimeoutMs aren't surfaced by the
  // resolver yet (they'd add columns to every tier); read the asset row's
  // own override directly and fall back to cpuMemory for transport choice
  // + timeout. The full per-tier hierarchy for these two fields can land
  // alongside a UI for editing them.
  const polling = (asset.customWidgetPolling ?? effective.cpuMemoryPolling) as string | null;
  if (!polling || polling === "disabled" || polling !== "snmp") return;

  const host = asset.ipAddress;
  if (!host) return;

  // Credential resolution mirrors the telemetry path: per-stream asset
  // credential wins, then the asset's generic monitor credential, then
  // FMG/FortiGate integration fallback. Custom widgets MUST have an SNMP
  // credential — there's no FortiOS REST equivalent in v1.
  let snmpCfg: Record<string, unknown> | null = null;
  const direct = asset.customWidgetCredential ?? asset.cpuMemoryCredential ?? asset.monitorCredential;
  if (direct?.type === "snmp") {
    snmpCfg = direct.config as Record<string, unknown>;
  } else if (asset.discoveredByIntegration?.type === "fortimanager" || asset.discoveredByIntegration?.type === "fortigate") {
    try {
      snmpCfg = await loadSnmpCredentialConfigForFortinetAsset(direct, asset.discoveredByIntegration);
    } catch { snmpCfg = null; }
  }
  if (!snmpCfg) return;

  await ensureRegistryLoaded();
  const scope = { manufacturer: asset.manufacturer, model: asset.model };
  const timeoutMs = asset.customWidgetTimeoutMs ?? effective.cpuMemoryTimeoutMs;

  const samples: Array<{ widgetId: string; kind: "scalar" | "table"; value: any }> = [];
  try {
    await withSnmpSession(host, snmpCfg, async (session) => {
      for (const w of widgets) {
        try {
          const oid = resolveOidSync(w.symbol, scope);
          if (!oid) continue;
          if (w.type === "scalar") {
            // Scalar: walk one OID, take first/only value as a number.
            const rows = await snmpWalk(session, oid);
            let val: number | null = null;
            for (const v of rows.values()) {
              const n = snmpVbToNumber(v);
              if (n != null) { val = n; break; }
            }
            if (val == null) continue;
            // Apply transform if one is configured on the widget.
            const { applyTransform } = await import("../utils/symbolTransforms.js");
            const transformed = applyTransform(val, w.transform);
            samples.push({ widgetId: w.id, kind: "scalar", value: transformed });
          } else {
            // Table: walk the whole subtree and serialize as one row per
            // OID-suffix with the raw value (operators decode further via
            // the widget's displayOptions at render time).
            const rows = await snmpWalk(session, oid);
            const arr: any[] = [];
            for (const [suffix, v] of rows.entries()) {
              const numeric = snmpVbToNumber(v);
              arr.push({
                index: suffix || ".0",
                value: numeric != null ? numeric : snmpVbToString(v),
              });
            }
            if (arr.length === 0) continue;
            samples.push({ widgetId: w.id, kind: "table", value: arr });
          }
        } catch (err) {
          logger.debug({ err, assetId, widgetId: w.id, symbol: w.symbol }, "Custom widget walk failed");
        }
      }
    }, timeoutMs);
  } catch (err) {
    // Session-level failure — log and move on; lastCustomWidgetAt stays stale.
    logger.debug({ err, assetId }, "Custom widget SNMP session failed");
    return;
  }

  if (samples.length === 0) return;
  try {
    await prisma.$transaction([
      prisma.assetCustomWidgetSample.createMany({
        data: samples.map((s) => ({
          assetId,
          widgetId: s.widgetId,
          kind:     s.kind,
          value:    s.value as any,
        })),
      }),
      prisma.asset.update({
        where: { id: assetId },
        data:  { lastCustomWidgetAt: new Date() },
      }),
    ]);
  } catch (err) {
    logger.warn({ err, assetId }, "Custom widget sample persistence failed");
  }
}

/**
 * Full system-info pass (interfaces + storage + IPsec + LLDP) for one
 * asset. Same supported / data / failure semantics as telemetry.
 */
export async function runSystemInfoFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  return monitorPhaseStorage.run(
    { assetId, cadence: "systemInfo", verbose: !!labels.verbose },
    async () => {
      const stopWork = startWorkTimer("systemInfo", labels);
      const endHandler = startPhase("systeminfo.handler");
      try {
        const endCollect = startPhase("systeminfo.collect");
        const sr = await collectSystemInfo(assetId);
        endCollect({ supported: sr.supported, hasData: !!sr.data, hasError: !!sr.error });
        const endPersist = startPhase("systeminfo.persist");
        await recordSystemInfoResult(assetId, sr);
        endPersist();
        if (sr.supported) {
          if (sr.data) {
            recordWorkOutcome("systemInfo", "success", labels);
            return "success";
          }
          recordWorkOutcome("systemInfo", "failure", labels);
          return "failure";
        }
        recordWorkOutcome("systemInfo", "success", labels);
        return "success";
      } catch (err) {
        logger.error({ err, assetId }, "System info collection crashed");
        recordWorkOutcome("systemInfo", "crash", labels);
        return "crash";
      } finally {
        endHandler();
        stopWork();
      }
    },
  );
}

/**
 * Fast-filtered scrape for the operator-pinned subset (interfaces + storage
 * + IPsec). Same supported / data / failure semantics as systemInfo.
 */
export async function runFastFilteredFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("fastFiltered", labels);
  try {
    const fr = await collectFastFiltered(assetId);
    await recordFastFilteredResult(assetId, fr);
    if (fr.supported) {
      if (fr.data) {
        recordWorkOutcome("fastFiltered", "success", labels);
        return "success";
      }
      recordWorkOutcome("fastFiltered", "failure", labels);
      return "failure";
    }
    recordWorkOutcome("fastFiltered", "success", labels);
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "Fast-cadence scrape crashed");
    recordWorkOutcome("fastFiltered", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Phase 2 carve-out: LLDP-only pass for one asset. Walks the LLDP-MIB
 * (`collectLldpOnlySnmp`) or hits `/api/v2/monitor/system/interface/lldp-neighbors`
 * (`collectLldpOnlyFortinet`) per the resolved `lldpPolling` and persists via
 * the same `persistLldpNeighbors` full-replace path the legacy
 * `collectSystemInfo` uses — so this is idempotent against any in-flight
 * systemInfo pass that also walked LLDP on a session-coalesced tick.
 *
 * Stamps `Asset.lastLldpAt` on every successful pass so the publisher in
 * `monitorAssets.ts` knows when the next LLDP job is due.
 */
export async function runLldpFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("lldp", labels);
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { monitorCredential: true, interfacesCredential: true, lldpCredential: true, discoveredByIntegration: true },
    });
    if (!asset || !asset.monitored) {
      recordWorkOutcome("lldp", "success", labels);
      return "success";
    }
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    const lldpPolling = effective.lldpPolling;
    if (!lldpPolling || lldpPolling === "disabled" || lldpPolling === "agent") {
      recordWorkOutcome("lldp", "success", labels);
      return "success";
    }
    const targetIp = asset.ipAddress || ((lldpPolling === "winrm" || lldpPolling === "ssh") ? (asset.dnsName || asset.hostname) : null);
    if (!targetIp) {
      recordWorkOutcome("lldp", "failure", labels);
      return "failure";
    }
    const integration = asset.discoveredByIntegration ?? null;
    const isFortinetSrc = integration?.type === "fortimanager" || integration?.type === "fortigate";
    const lldpTimeout   = effective.lldpTimeoutMs;
    let neighbors: LldpNeighborSample[] | undefined;
    let sourceLabel: "fortios" | "snmp" = "snmp";
    if (lldpPolling === "rest_api") {
      if (!isFortinetSrc || !integration) {
        recordWorkOutcome("lldp", "failure", labels);
        return "failure";
      }
      sourceLabel = "fortios";
      neighbors = await collectLldpOnlyFortinet(targetIp, integration as any, lldpTimeout).catch(() => undefined);
    } else if (lldpPolling === "snmp") {
      // Per-stream credential wins, then asset default, then integration fallback.
      const effectiveLldpCred = asset.lldpCredential ?? asset.monitorCredential;
      let snmpCfg: Record<string, unknown> | null = null;
      if (effectiveLldpCred?.type === "snmp") {
        snmpCfg = effectiveLldpCred.config as Record<string, unknown>;
      } else {
        const classCred = await loadClassOverrideStreamCredential(effective.lldpCredentialId, "snmp");
        if (classCred) {
          snmpCfg = classCred.config as Record<string, unknown>;
        } else if (isFortinetSrc && integration) {
          try { snmpCfg = await loadSnmpCredentialConfigForFortinetAsset(effectiveLldpCred, integration); }
          catch { snmpCfg = null; }
        }
      }
      if (!snmpCfg) {
        recordWorkOutcome("lldp", "failure", labels);
        return "failure";
      }
      sourceLabel = "snmp";
      neighbors = await collectLldpOnlySnmp(targetIp, snmpCfg, lldpTimeout).catch(() => undefined);
    } else {
      // winrm / ssh / icmp don't deliver LLDP today.
      recordWorkOutcome("lldp", "success", labels);
      return "success";
    }
    if (neighbors === undefined) {
      // Transport failure — don't wipe existing rows, don't bump lastLldpAt
      // (so the next tick retries promptly).
      recordWorkOutcome("lldp", "failure", labels);
      return "failure";
    }
    await persistLldpNeighbors(assetId, neighbors, new Date(), sourceLabel);
    await prisma.asset.update({ where: { id: assetId }, data: { lastLldpAt: new Date() } });
    recordWorkOutcome("lldp", "success", labels);
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "LLDP-only scrape crashed");
    recordWorkOutcome("lldp", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Phase 2 carve-out: Storage-only pass for one asset. SNMP-only — FortiOS
 * appliances expose no mountable storage and WinRM is not yet supported.
 * Walks HOST-RESOURCES-MIB hrStorageTable; falls back to the vendor disk
 * scalar pair (e.g. FortiSwitch `fsSysDiskUsage` / `fsSysDiskCapacity`) when
 * the table is empty.
 *
 * Stamps `Asset.lastStorageAt` on every successful pass.
 */
export async function runStorageFor(assetId: string, labels: WorkItemLabels): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("storage", labels);
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { monitorCredential: true, interfacesCredential: true, discoveredByIntegration: true },
    });
    if (!asset || !asset.monitored) {
      recordWorkOutcome("storage", "success", labels);
      return "success";
    }
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    const storagePolling = effective.storagePolling;
    if (storagePolling !== "snmp") {
      // Storage walk is SNMP-only when enabled.
      recordWorkOutcome("storage", "success", labels);
      return "success";
    }
    const targetIp = asset.ipAddress;
    if (!targetIp) {
      recordWorkOutcome("storage", "failure", labels);
      return "failure";
    }
    // Storage shares the interfaces credential at probe time — there's no
    // per-stream storage credential column. Per-stream interfaces credential
    // wins, then asset default, then class-override interfacesCredentialId,
    // then integration fallback.
    const effectiveIfacesCred = asset.interfacesCredential ?? asset.monitorCredential;
    const integration = asset.discoveredByIntegration ?? null;
    const isFortinetSrc = integration?.type === "fortimanager" || integration?.type === "fortigate";
    let snmpCfg: Record<string, unknown> | null = null;
    if (effectiveIfacesCred?.type === "snmp") {
      snmpCfg = effectiveIfacesCred.config as Record<string, unknown>;
    } else {
      const classCred = await loadClassOverrideStreamCredential(effective.interfacesCredentialId, "snmp");
      if (classCred) {
        snmpCfg = classCred.config as Record<string, unknown>;
      } else if (isFortinetSrc && integration) {
        try { snmpCfg = await loadSnmpCredentialConfigForFortinetAsset(effectiveIfacesCred, integration); }
        catch { snmpCfg = null; }
      }
    }
    if (!snmpCfg) {
      recordWorkOutcome("storage", "failure", labels);
      return "failure";
    }
    const storage = await collectStorageOnlySnmp(targetIp, snmpCfg, asset.manufacturer, asset.model, effective.storageTimeoutMs).catch(() => undefined);
    if (storage === undefined) {
      recordWorkOutcome("storage", "failure", labels);
      return "failure";
    }
    const now = new Date();
    // This dedicated SNMP storage stream walks ALL mountpaths, so stamp each
    // row by whether its mountPath is operator-pinned (monitoredStorage):
    // pinned → "fast" (full retention + rollups), unpinned → "slow" (24h).
    const pinnedStorage = new Set(asset.monitoredStorage ?? []);
    if (storage.length > 0) {
      enqueueStorageSamples(
        storage.map((s) => ({
          assetId,
          timestamp: now,
          cadence:    pinnedStorage.has(s.mountPath) ? ("fast" as const) : ("slow" as const),
          mountPath:  s.mountPath,
          totalBytes: s.totalBytes != null ? BigInt(Math.round(s.totalBytes)) : null,
          usedBytes:  s.usedBytes  != null ? BigInt(Math.round(s.usedBytes))  : null,
        })),
      );
    }
    await prisma.asset.update({ where: { id: assetId }, data: { lastStorageAt: now } });
    recordWorkOutcome("storage", "success", labels);
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "Storage-only scrape crashed");
    recordWorkOutcome("storage", "crash", labels);
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Storage-only SNMP walk. Same shape as the storage portion of
 * collectSystemInfoSnmp — hrStorageTable first, vendor disk scalar pair as
 * fallback. Used by `runStorageFor` to walk just the storage table without
 * incurring the full IF-MIB / LLDP-MIB session cost.
 */
export async function collectStorageOnlySnmp(
  host: string,
  config: Record<string, unknown>,
  manufacturer: string | null | undefined,
  model: string | null | undefined,
  timeoutMs?: number,
): Promise<StorageSample[]> {
  const vendorProfile = pickVendorProfileMerged(manufacturer ?? null, null, model ?? null);
  const vendorScope   = { manufacturer: manufacturer ?? null, model: model ?? null };
  return await withSnmpSession(host, config, async (session) => {
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
    } catch { /* fall through to vendor fallback */ }
    if (storage.length === 0 && vendorProfile?.disk) {
      try {
        await ensureRegistryLoaded();
        const disk    = vendorProfile.disk;
        const usedOid = resolveOidSync(disk.usedBytesSymbol,  vendorScope);
        const totOid  = resolveOidSync(disk.totalBytesSymbol, vendorScope);
        if (usedOid && totOid) {
          const [usedVb, totVb] = await Promise.all([
            snmpGetScalar(session, usedOid).catch(() => null),
            snmpGetScalar(session, totOid).catch(() => null),
          ]);
          const usedBytes  = snmpVbToNumber(usedVb);
          const totalBytes = snmpVbToNumber(totVb);
          if (usedBytes != null || totalBytes != null) {
            storage.push({
              mountPath:  disk.mountPath || "system",
              usedBytes:  usedBytes  ?? null,
              totalBytes: totalBytes ?? null,
            });
          }
        }
      } catch { /* leave storage empty */ }
    }
    return storage;
  }, timeoutMs);
}

/**
 * One iteration of the monitor job. Picks assets due for the requested
 * cadences and runs the due work in parallel. Each cadence has its own due
 * check + per-asset interval override (`monitorIntervalSec`,
 * `telemetryIntervalSec`, `systemInfoIntervalSec`).
 *
 * `cadences` selects which cadences this pass owns. The job layer
 * (`monitorAssets.ts`) splits the cadences across two independent ticking
 * loops — light (`probe` + `fastFiltered`) every 5s and heavy (`telemetry`
 * + `systemInfo`) every 30s — so a wedged systemInfo on dead hosts can't
 * hold up per-minute probe polling across ticks. Default is all four
 * cadences so call sites that don't care (e.g. `POST /assets/:id/probe-now`)
 * still see the legacy "do everything" behavior.
 *
 * Each cadence is its own queue item — workers pull single-cadence items
 * rather than the full per-asset pipeline. A 30s SNMP-walk timeout on one
 * host's systemInfo no longer holds up the cheap probe of the next asset:
 * any free worker can pick up that probe immediately. Probes are queued
 * first so when the worker pool is saturated, the lightweight cadence
 * drains before the heavy ones.
 */
export async function runMonitorPass(opts?: { concurrency?: number; cadences?: MonitorCadence[] }): Promise<RunStats> {
  const enabled = new Set<MonitorCadence>(
    opts?.cadences ?? ["probe", "fastFiltered", "telemetry", "systemInfo"],
  );
  const endPassTimer = startPassTimer();
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 8, 32));
  const now = new Date();

  const candidates = await prisma.asset.findMany({
    where: { monitored: true },
    select: {
      id: true,
      assetType: true,
      discoveredByIntegrationId: true,
      // Joined for the resolver — picks the source-default polling method
      // (rest_api for fortinet, icmp for everything else). Without this the
      // resolver maps every candidate to "manual" and the cadence calculation
      // silently drifts.
      discoveredByIntegration: { select: { type: true } },
      monitorStatus: true, consecutiveFailures: true,
      lastMonitorAt: true, monitorIntervalSec: true,
      lastTelemetryAt: true, cpuMemoryIntervalSec: true, temperatureIntervalSec: true,
      lastSystemInfoAt: true, systemInfoIntervalSec: true,
      probeTimeoutMs: true,
      responseTimePolling: true,
      cpuMemoryPolling:    true,
      temperaturePolling:  true,
      interfacesPolling:   true,
      lldpPolling:         true,
      storagePolling:      true,
      monitoredInterfaces: true,
      monitoredStorage: true,
      monitoredIpsecTunnels: true,
      dependencySuppressed: true,
    },
  });

  // Asset-count gauges. Set every pass so the Grafana view stays current
  // even when the fleet size changes between ticks.
  let upCount = 0, downCount = 0, unknownCount = 0;
  for (const a of candidates) {
    if (a.monitorStatus === "up") upCount++;
    else if (a.monitorStatus === "down") downCount++;
    else unknownCount++;
  }
  setMonitoredAssets(candidates.length, { up: upCount, down: downCount, unknown: unknownCount });

  // Per-asset resolved transport labels for the work-duration histogram and
  // per-probe histogram. Probe uses responseTimePolling; telemetry uses
  // telemetryPolling; systemInfo + fastFiltered use interfacesPolling.
  // Falls back to the integration-source default when the per-asset column
  // is null (full resolver fidelity would require the class-override +
  // tier-3 lookup but that's overkill for a metric label).
  //
  // Source defaults (from CLAUDE.md): fortimanager/fortigate → rest_api on
  // probe / telemetry / interfaces; everything else → icmp on probe and
  // null (= "not delivered") on the other streams. The publishDueWork +
  // canTelemetry/canSystemInfo gates already block work items whose stream
  // resolves to null, so in practice the non-fortinet null case here
  // doesn't reach a worker — the "not_delivered" label is a defensive
  // fallback only.
  function defaultProbeTransport(integrationType: string | null | undefined): string {
    return (integrationType === "fortimanager" || integrationType === "fortigate") ? "rest_api" : "icmp";
  }
  function defaultHeavyTransport(integrationType: string | null | undefined): string {
    return (integrationType === "fortimanager" || integrationType === "fortigate") ? "rest_api" : "not_delivered";
  }
  const transportByCadenceById = new Map<string, Record<MonitorCadence, string>>();
  const assetTypeById = new Map<string, string>();
  for (const a of candidates) {
    const integrationType = a.discoveredByIntegration?.type;
    const probeT = a.responseTimePolling || defaultProbeTransport(integrationType);
    const telT   = a.cpuMemoryPolling    || defaultHeavyTransport(integrationType);
    const ifT    = a.interfacesPolling   || defaultHeavyTransport(integrationType);
    transportByCadenceById.set(a.id, {
      probe:        probeT,
      telemetry:    telT,
      systemInfo:   ifT,
      fastFiltered: ifT,
      // Phase 2 carve-out: LLDP + Storage cadences are pg-boss-only and don't
      // dispatch through runMonitorPass in cursor mode. Fill the transport
      // labels anyway so the histogram label set is complete if a future
      // cursor-mode dispatcher needs them.
      lldp:         a.lldpPolling    || ifT,
      storage:      a.storagePolling || ifT,
    });
    assetTypeById.set(a.id, a.assetType ?? "unknown");
  }

  function isDue(last: Date | null, intervalSec: number): boolean {
    if (intervalSec <= 0) return false;
    if (!last) return true;
    return now.getTime() - last.getTime() >= intervalSec * 1000;
  }

  type WorkKind = "probe" | "telemetry" | "systemInfo" | "fastFiltered";
  type Work = { id: string; kind: WorkKind };
  const probes: Work[]       = [];
  const fastFiltereds: Work[] = [];
  const telemetries: Work[]  = [];
  const systemInfos: Work[]  = [];
  for (const a of candidates) {
    // Resolve effective settings through the four-tier hierarchy. Internally
    // memoized — first asset in a (integration|manual, assetType) bucket
    // pays for the DB read; everything else hits the in-memory cache.
    const eff = await resolveMonitorSettings({
      ...a,
      discoveredByIntegrationType: a.discoveredByIntegration?.type ?? null,
    });
    // Probe cadence is just the resolved intervalSeconds — no backoff for
    // down hosts. Down-host suppression below stops heavy cadences regardless;
    // the cheap response-time probe keeps firing at base cadence so recovery
    // is detected within one tick. EXCEPT when dependency suppression is
    // active (parent is down): the probe slows to 2× the configured interval
    // since the asset is unlikely to answer until the parent recovers, but
    // we still poll at half-rate to catch cases where it answers via a
    // redundant L3 path or out-of-band management. Disabled streams stay
    // disabled regardless of suppression — there's nothing to slow down.
    const probeIntervalSec =
      a.dependencySuppressed && eff.responseTimePolling !== "disabled"
        ? eff.intervalSeconds * 2
        : eff.intervalSeconds;
    const probe      = isDue(a.lastMonitorAt,    probeIntervalSec);
    // Pragmatic stream-split: the dispatcher tick treats CPU/memory's
    // cadence as the unified "telemetry due" trigger. collectTelemetry
    // still pulls temperature on the same session — operators who want a
    // shorter temperature cadence get the per-stream column today but the
    // independent timer lands in a follow-up commit when the collector
    // loop splits.
    const telemetry  = isDue(a.lastTelemetryAt,  eff.cpuMemoryIntervalSeconds);
    const systemInfo = isDue(a.lastSystemInfoAt, eff.systemInfoIntervalSeconds);
    const hasFastPin =
      (Array.isArray(a.monitoredInterfaces)   && a.monitoredInterfaces.length   > 0) ||
      (Array.isArray(a.monitoredStorage)      && a.monitoredStorage.length      > 0) ||
      (Array.isArray(a.monitoredIpsecTunnels) && a.monitoredIpsecTunnels.length > 0);

    // Pre-queue eligibility. collectTelemetry / collectSystemInfo return
    // {supported:false} immediately for these cases, which means
    // lastTelemetryAt / lastSystemInfoAt never advance and the asset sits in
    // the work queue on EVERY heavy tick — permanently inflating pass duration
    // and degrading the effective cadence for assets that DO produce data.
    //
    // Managed FortiSwitches / FortiAPs aren't directly REST-able: their
    // telemetry and system-info endpoints live on the parent FortiGate, not on
    // the asset's own IP. Operators who want telemetry on these devices flip
    // the integration's FortiSwitches/APs subtab to direct SNMP (which changes
    // the resolved telemetryPolling / interfacesPolling to "snmp").
    //
    // icmp / winrm / ssh don't deliver telemetry yet (collectTelemetry returns
    // {supported:false} for those methods regardless of assetType).
    const isManagedSwitchOrAp = a.assetType === "switch" || a.assetType === "access_point";
    // Managed FortiSwitches still have no REST telemetry path (the
    // controller-status table reports up/down only). Managed FortiAPs DO
    // have REST telemetry via collectTelemetryFortiapRest piggybacking on
    // /api/v2/monitor/wifi/managed_ap, so the rest_api gate excludes
    // switches only — APs are enqueued and dispatched.
    const canTelemetry =
      eff.cpuMemoryPolling !== null &&
      eff.cpuMemoryPolling !== "icmp"  &&
      eff.cpuMemoryPolling !== "winrm" &&
      eff.cpuMemoryPolling !== "ssh"   &&
      !(eff.cpuMemoryPolling === "rest_api" && a.assetType === "switch");
    // systemInfo is supported for winrm/ssh paths; only exclude the REST API
    // + managed-switch/AP combination that has no direct endpoint. Treat the
    // tick as runnable when ANY of the three streams it carries
    // (interfaces / lldp / storage) is enabled — collectSystemInfo gates
    // each stream internally (storage rows are dropped when storagePolling
    // isn't SNMP; LLDP / interface paths each check their own resolved
    // method). Today collectSystemInfo still bails when interfacesPolling
    // is null even if storage/lldp would otherwise pull, so the OR here
    // is forward-looking — fleets that want storage on SNMP also set
    // interfacesPolling=snmp in practice, which both source defaults
    // (FMG/FortiGate → rest_api, AD/Entra/manual → null + operator opt-in)
    // already converge to.
    const anySysInfoStream =
      eff.interfacesPolling !== null ||
      eff.lldpPolling       !== null ||
      eff.storagePolling    !== null;
    const canSystemInfo =
      anySysInfoStream &&
      !(eff.interfacesPolling === "rest_api" && isManagedSwitchOrAp);

    // Heavy-cadence suppression. Telemetry / systemInfo / fastFiltered run
    // ONLY while the asset is confirmed up AND not dependency-suppressed.
    // Every other state (warning / pending / down / unknown) suppresses
    // them, AND a confirmed-down upstream parent suppresses them too.
    // Rationale:
    //   - "down": stale by definition; full SNMP walks just burn worker
    //     time on a host that's about to time out three more times.
    //   - "warning": the asset has missed at least one probe; its data is
    //     in flux. Heavy cadences resume once a full recovery (cs reaches
    //     threshold) flips the asset back to "up".
    //   - "pending": brand-new or recovering; not yet confirmed up.
    //   - "unknown": never been probed; let the response-time probe alone
    //     establish a baseline before scheduling heavy walks.
    //   - dependencySuppressed: parent is confirmed down; if the asset's
    //     own probe still answers via a redundant path the response-time
    //     stream catches it; heavy walks against an unreachable upstream
    //     mostly time out and waste worker budget.
    // The cheap probe keeps firing in every state so recovery can be
    // detected within one tick of the resolved cadence.
    const isUp = a.monitorStatus === "up" && !a.dependencySuppressed;
    if (probe      && enabled.has("probe"))                                      probes.push({ id: a.id, kind: "probe" });
    if (telemetry  && canTelemetry  && enabled.has("telemetry")  && isUp)        telemetries.push({ id: a.id, kind: "telemetry" });
    if (systemInfo && canSystemInfo && enabled.has("systemInfo") && isUp)        systemInfos.push({ id: a.id, kind: "systemInfo" });
    // Fast-cadence pinned scrape rides the response-time cadence (default 60s).
    // Skip it when the full systemInfo pass is also due — they'd hit the same
    // OIDs twice and the full pass already covers the pinned subset. The
    // `systemInfo` boolean here reflects the asset's overall due state, not
    // whether THIS pass is going to handle systemInfo, so the gating works
    // correctly even when light + heavy passes run on different ticking
    // loops: when systemInfo is due, fast-filtered is skipped on this and
    // every following light tick until systemInfo runs successfully and
    // bumps lastSystemInfoAt.
    if (probe && hasFastPin && canSystemInfo && !systemInfo && isUp && enabled.has("fastFiltered")) {
      fastFiltereds.push({ id: a.id, kind: "fastFiltered" });
    }
  }
  // Order matters: probes first so a saturated worker pool drains the cheap
  // cadence ahead of the heavy walks. Fast-filtered scrapes ride the same
  // 60s cadence as probes and are still small relative to a full systemInfo
  // pass, so they queue right behind probes. Telemetry and systemInfo bring
  // up the rear — those are what actually time out on dead hosts, and they
  // shouldn't get to block per-minute polling for the rest of the fleet.
  const work: Work[] = [...probes, ...fastFiltereds, ...telemetries, ...systemInfos];

  setQueueDepth({
    probe: probes.length,
    fastFiltered: fastFiltereds.length,
    telemetry: telemetries.length,
    systemInfo: systemInfos.length,
  });

  const stats: RunStats = {
    probed: 0, succeeded: 0, failed: 0,
    telemetry:  { collected: 0, failed: 0 },
    systemInfo: { collected: 0, failed: 0 },
    fastFiltered: { collected: 0, failed: 0 },
  };
  if (work.length === 0) {
    endPassTimer();
    return stats;
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < work.length) {
      const idx = cursor++;
      const w = work[idx];
      const runWork = async () => {
        const assetType = assetTypeById.get(w.id) ?? "unknown";
        const transports = transportByCadenceById.get(w.id);
        const labelFor = (cadence: MonitorCadence): WorkItemLabels => ({
          assetType,
          transport: transports?.[cadence] ?? "unknown",
        });
        switch (w.kind) {
          case "probe": {
            const outcome = await runProbeFor(w.id, labelFor("probe"));
            stats.probed++;
            if (outcome === "success") stats.succeeded++; else stats.failed++;
            break;
          }
          case "telemetry": {
            const outcome = await runTelemetryFor(w.id, labelFor("telemetry"));
            if (outcome === "success") stats.telemetry.collected++;
            else stats.telemetry.failed++;
            break;
          }
          case "systemInfo": {
            const outcome = await runSystemInfoFor(w.id, labelFor("systemInfo"));
            if (outcome === "success") stats.systemInfo.collected++;
            else stats.systemInfo.failed++;
            break;
          }
          case "fastFiltered": {
            const outcome = await runFastFilteredFor(w.id, labelFor("fastFiltered"));
            if (outcome === "success") stats.fastFiltered.collected++;
            else stats.fastFiltered.failed++;
            break;
          }
        }
      };
      await runWork();
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, () => worker()));
  } finally {
    endPassTimer();
  }
  return stats;
}

// ─── Retention prune helpers ────────────────────────────────────────────────
//
// Retention is per-ENTITY (assets / cpuMem / hardware / interfaces /
// storage / ipsec) with a detail/hourly/daily tier each. Encoding per tier:
// positive = N days; 0 = tier off (prune everything); FOREVER (-1) = keep all.
//
// Selection split (interfaces / storage / ipsec only): the configured detail
// retention applies to SELECTED rows (cadence="fast" — operator-pinned). The
// UNSELECTED/bulk rows (cadence="slow" or legacy NULL) are kept only
// UNSELECTED_DETAIL_HOURS and are never rolled up. assets / cpuMem /
// hardware have no selection and prune uniformly.

type SamplePruneFn = (where: Record<string, unknown>) => Promise<{ count: number }>;

const DAY_MS = 24 * 3600 * 1000;

/**
 * Prune one tier with a single retention window (no selection split). Used for
 * assets / cpuMem / hardware (all tiers) and the hourly/daily rollup tiers
 * of every entity. `days`: >0 keep N days; 0 keep nothing; FOREVER keep all.
 *
 * When the table is a Timescale hypertable, drop whole chunks older than the
 * cutoff first (O(1), no seq-scan / lock contention). The residue inside the
 * chunk straddling the cutoff is then handled by `tieredPruneWindow`, which
 * keeps the row-DELETE strictly on the UNCOMPRESSED side of the compression
 * frontier — or skips it entirely when the whole delete set is past the
 * frontier (the common rollup case). A blanket `lt: cutoff` deleteMany here
 * would decompress chunks and bloat the heap (prod incidents 2026-06-08 and
 * 2026-06-17). No-op drop on plain Postgres.
 */
async function pruneTierByDays(
  fn: SamplePruneFn,
  days: number,
  timeColumn: "timestamp" | "bucketStart",
  hypertableName?: string,
): Promise<number> {
  if (days === FOREVER) return 0;
  const compressAfter = hypertableName ? getEffectiveCompressAfterDays(hypertableName) : 0;
  const win = tieredPruneWindow(Date.now(), days, compressAfter);
  // drop_chunks always runs at the retention cutoff — even when the row-DELETE
  // is skipped, whole aged chunks must still drop in O(1).
  if (hypertableName) await dropChunks(hypertableName, win.cutoff);
  if (win.skipRowDelete) return 0;
  const where = win.gte
    ? { [timeColumn]: { gte: win.gte, lt: win.cutoff } }
    : { [timeColumn]: { lt: win.cutoff } };
  const { count } = await fn(where);
  return count;
}

/**
 * Prune the DETAIL tier of a selection-aware entity (interfaces / storage /
 * ipsec). Selected rows (cadence="fast") keep `selectedDays`; unselected rows
 * (cadence="slow" OR legacy NULL) keep the fixed UNSELECTED_DETAIL_HOURS.
 *
 * drop_chunks uses the LONGER (selected) window so aged fast+slow chunks go in
 * O(1); the 24h slow trim then runs as a deleteMany on the (recent, ideally
 * uncompressed) residue — see the chunk-interval/compression tuning in
 * timescaleService for why recent chunks stay deletable.
 */
async function pruneSelectionAwareDetail(
  fn: SamplePruneFn,
  selectedDays: number,
  hypertableName: string,
): Promise<number> {
  const now = Date.now();
  let total = 0;
  if (selectedDays !== FOREVER) {
    const sel = selectedDays <= 0 ? new Date(now) : new Date(now - selectedDays * DAY_MS);
    await dropChunks(hypertableName, sel);
    total += (await fn({ cadence: "fast", timestamp: { lt: sel } })).count;
  }
  // Unselected = "slow" or legacy NULL. `{ not: "fast" }` excludes NULL in SQL,
  // so NULL is matched explicitly. Lower-bound the window at the compressed-
  // chunk frontier (getEffectiveCompressAfterDays) so this DELETE can never
  // match rows inside a compressed chunk — doing so would decompress the whole
  // chunk into its rowstore heap and leave un-truncatable low-density bloat
  // (prod incident 2026-06-08). Slow rows past the frontier ride compressed
  // until drop_chunks removes the whole chunk at the selected window above.
  const { gte, lt } = unselectedSlowPruneWindow(now, getEffectiveCompressAfterDays(hypertableName));
  total += (await fn({
    OR: [{ cadence: null }, { cadence: { not: "fast" } }],
    timestamp: gte ? { gte, lt } : { lt },
  })).count;
  return total;
}

/**
 * Trim every tier (detail / hourly / daily) for the monitor sample stream.
 * Each tier reads its own retention values from the global setting. 0 (or
 * negative) disables retention for that class within the tier.
 */
export async function pruneMonitorSamples(): Promise<number> {
  const r = (await getSampleRetention()).assets;
  const [detail, hourly, daily] = await Promise.all([
    pruneTierByDays((w) => prisma.assetMonitorSample.deleteMany({       where: w as any }), r.detail, "timestamp",   "asset_monitor_samples"),
    pruneTierByDays((w) => prisma.assetMonitorSampleHourly.deleteMany({ where: w as any }), r.hourly, "bucketStart", "asset_monitor_samples_hourly"),
    pruneTierByDays((w) => prisma.assetMonitorSampleDaily.deleteMany({  where: w as any }), r.daily,  "bucketStart", "asset_monitor_samples_daily"),
  ]);
  return detail + hourly + daily;
}

/**
 * Trim every tier of AssetTelemetrySample (cpuMem entity) +
 * AssetHardwareSensorSample (hardware entity). These have independent
 * per-entity retention — operators can keep hardware-sensor history longer
 * than CPU/mem (or vice versa) since they're separate rows in the Retention
 * card. Hardware sensors are gauges with no selection split, so they prune
 * uniformly like cpuMem.
 */
export async function pruneTelemetrySamples(): Promise<number> {
  const ret = await getSampleRetention();
  const cm = ret.cpuMem;
  const hw = ret.hardware;
  const pr = ret.process;
  const [tDetail, tHourly, tDaily, hwDetail, hwHourly, hwDaily, pDetail, pHourly, pDaily] = await Promise.all([
    pruneTierByDays((w) => prisma.assetTelemetrySample.deleteMany({            where: w as any }), cm.detail, "timestamp",   "asset_telemetry_samples"),
    pruneTierByDays((w) => prisma.assetTelemetrySampleHourly.deleteMany({      where: w as any }), cm.hourly, "bucketStart", "asset_telemetry_samples_hourly"),
    pruneTierByDays((w) => prisma.assetTelemetrySampleDaily.deleteMany({       where: w as any }), cm.daily,  "bucketStart", "asset_telemetry_samples_daily"),
    pruneTierByDays((w) => prisma.assetHardwareSensorSample.deleteMany({       where: w as any }), hw.detail, "timestamp",   "asset_hardware_sensor_samples"),
    pruneTierByDays((w) => prisma.assetHardwareSensorSampleHourly.deleteMany({ where: w as any }), hw.hourly, "bucketStart", "asset_hardware_sensor_samples_hourly"),
    pruneTierByDays((w) => prisma.assetHardwareSensorSampleDaily.deleteMany({  where: w as any }), hw.daily,  "bucketStart", "asset_hardware_sensor_samples_daily"),
    // Pinned-process CPU/RAM (gauge; not selection-aware — only pinned programs
    // are sampled, so every detail row is "fast").
    pruneTierByDays((w) => prisma.assetProcessSample.deleteMany({       where: w as any }), pr.detail, "timestamp",   "asset_process_samples"),
    pruneTierByDays((w) => prisma.assetProcessSampleHourly.deleteMany({ where: w as any }), pr.hourly, "bucketStart", "asset_process_samples_hourly"),
    pruneTierByDays((w) => prisma.assetProcessSampleDaily.deleteMany({  where: w as any }), pr.daily,  "bucketStart", "asset_process_samples_daily"),
  ]);
  return tDetail + tHourly + tDaily + hwDetail + hwHourly + hwDaily + pDetail + pHourly + pDaily;
}

/**
 * Trim every tier of AssetInterfaceSample + AssetStorageSample +
 * AssetIpsecTunnelSample, plus the AssetLldpNeighbor table that rides the
 * system-info cadence. LLDP rows use `lastSeen` rather than `timestamp` so
 * they're pruned by their own helper and only consume the DETAIL retention
 * tier (no rollups for LLDP — it's current-state, not time-series).
 */
export async function pruneSystemInfoSamples(): Promise<number> {
  const r = await getSampleRetention();
  const [
    iDetail, iHourly, iDaily, sDetail, sHourly, sDaily, ipDetail, ipHourly, ipDaily,
    psDetail, psHourly, psDaily, lldp, customWidget, processLog,
  ] = await Promise.all([
    // interfaces — detail is selection-aware (selected=configured, unselected=24h)
    pruneSelectionAwareDetail((w) => prisma.assetInterfaceSample.deleteMany({ where: w as any }), r.interfaces.detail, "asset_interface_samples"),
    pruneTierByDays((w) => prisma.assetInterfaceSampleHourly.deleteMany({ where: w as any }), r.interfaces.hourly, "bucketStart", "asset_interface_samples_hourly"),
    pruneTierByDays((w) => prisma.assetInterfaceSampleDaily.deleteMany({  where: w as any }), r.interfaces.daily,  "bucketStart", "asset_interface_samples_daily"),
    // storage
    pruneSelectionAwareDetail((w) => prisma.assetStorageSample.deleteMany({ where: w as any }), r.storage.detail, "asset_storage_samples"),
    pruneTierByDays((w) => prisma.assetStorageSampleHourly.deleteMany({ where: w as any }), r.storage.hourly, "bucketStart", "asset_storage_samples_hourly"),
    pruneTierByDays((w) => prisma.assetStorageSampleDaily.deleteMany({  where: w as any }), r.storage.daily,  "bucketStart", "asset_storage_samples_daily"),
    // ipsec
    pruneSelectionAwareDetail((w) => prisma.assetIpsecTunnelSample.deleteMany({ where: w as any }), r.ipsec.detail, "asset_ipsec_tunnel_samples"),
    pruneTierByDays((w) => prisma.assetIpsecTunnelSampleHourly.deleteMany({ where: w as any }), r.ipsec.hourly, "bucketStart", "asset_ipsec_tunnel_samples_hourly"),
    pruneTierByDays((w) => prisma.assetIpsecTunnelSampleDaily.deleteMany({  where: w as any }), r.ipsec.daily,  "bucketStart", "asset_ipsec_tunnel_samples_daily"),
    // SD-WAN perf-SLA — not selection-aware (no pin concept); every detail row
    // is stamped "fast" so the plain by-days prune is correct for all of them.
    pruneTierByDays((w) => prisma.assetPerfSlaSample.deleteMany({       where: w as any }), r.perfSla.detail, "timestamp",   "asset_perf_sla_samples"),
    pruneTierByDays((w) => prisma.assetPerfSlaSampleHourly.deleteMany({ where: w as any }), r.perfSla.hourly, "bucketStart", "asset_perf_sla_samples_hourly"),
    pruneTierByDays((w) => prisma.assetPerfSlaSampleDaily.deleteMany({  where: w as any }), r.perfSla.daily,  "bucketStart", "asset_perf_sla_samples_daily"),
    // SD-WAN service rules are now CURRENT-STATE (asset_sdwan_rules, a plain
    // table replaced per scrape by persistSdwanRules) — no retention prune,
    // same as LLDP / wireless-station current-state tables.
    // LLDP neighbors are current-state (per-asset, no rollup, no cadence) — prune
    // by the interfaces detail window as the system-info umbrella.
    pruneLldpNeighbors(r.interfaces.detail),
    // Custom-widget samples are a standalone detail-only hypertable (no rollup
    // tiers). Prune on the same interfaces detail umbrella window as LLDP via
    // the compression-safe drop_chunks + residue path.
    pruneTierByDays((w) => prisma.assetCustomWidgetSample.deleteMany({ where: w as any }), r.interfaces.detail, "timestamp", "asset_custom_widget_samples"),
    // Process logs are a standalone detail-only hypertable (no rollups) — prune
    // on the process entity's detail window via the same compression-safe path.
    pruneTierByDays((w) => prisma.assetProcessLogSample.deleteMany({ where: w as any }), r.process.detail, "timestamp", "asset_process_log_samples"),
  ]);
  return iDetail + iHourly + iDaily + sDetail + sHourly + sDaily + ipDetail + ipHourly + ipDaily
    + psDetail + psHourly + psDaily + lldp + customWidget + processLog;
}

async function pruneLldpNeighbors(days: number): Promise<number> {
  if (days === FOREVER) return 0;
  const cutoff = days <= 0 ? new Date() : new Date(Date.now() - days * DAY_MS);
  const { count } = await prisma.assetLldpNeighbor.deleteMany({ where: { lastSeen: { lt: cutoff } } });
  return count;
}

// ─── Coordinated retention prune (single-flight across the monitor fleet) ────
//
// The retention prune is a FLEET-WIDE maintenance task, not a per-process one:
// it trims global sample tables. In the split-role deployment every
// `polaris-monitor@N` replica runs the same heavy tick, so without
// coordination N replicas fire the same prune concurrently — N overlapping
// `deleteMany`s on the same rollup tables, serializing on tuple locks. Worse,
// the previous trigger (`lastPruneAt = 0` initialized in monitorAssets) fired
// the prune on the FIRST heavy tick after every process start, so a crash/
// restart loop re-issued the prune every ~30s. That cascade pinned the xmin
// horizon and pegged every core (prod incident 2026-06-17).
//
// Two coordination mechanisms close that gap:
//  1. A PERSISTED last-run timestamp (Setting row) — survives restarts, so a
//     frequently-cycled host prunes 24h after the last SUCCESSFUL prune, not
//     24h after each boot, and never on boot.
//  2. A Postgres session-level ADVISORY LOCK held on a dedicated side
//     connection (NOT a transaction — that would re-pin xmin for the whole
//     prune) so only one replica prunes at a time; the rest skip cheaply.
//
// The advisory-lock key is a fixed Polaris-reserved (classid, objid) pair,
// distinct from pg-boss's single-bigint keyspace.
const PRUNE_LOCK_CLASSID = 0x504c5253; // "PLRS"
const PRUNE_LOCK_OBJID = 1; // retention prune
const RETENTION_PRUNE_SETTING_KEY = "lastRetentionPruneAt";

/** Default cadence between retention prunes. Overridable by the caller. */
export const RETENTION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RetentionPruneResult {
  monitor: number;
  telemetry: number;
  systemInfo: number;
  /** true when this replica did NOT prune (not due, or another replica held the lock). */
  skipped: boolean;
  reason?: "not-due" | "lock-held";
}

async function getLastRetentionPruneAt(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: RETENTION_PRUNE_SETTING_KEY } });
  const v = row?.value as { at?: unknown } | null | undefined;
  return typeof v?.at === "number" ? v.at : 0;
}

async function setLastRetentionPruneAt(at: number): Promise<void> {
  await prisma.setting.upsert({
    where: { key: RETENTION_PRUNE_SETTING_KEY },
    update: { value: { at } },
    create: { key: RETENTION_PRUNE_SETTING_KEY, value: { at } },
  });
}

/**
 * Run `fn` while holding the prune advisory lock on a dedicated connection.
 * Returns `fn()`'s result, or `null` when another replica already holds the
 * lock (caller should treat that as "skipped"). The lock is session-level and
 * released on a `finally`, and the connection is always closed — so a crash
 * mid-prune drops the connection and the lock with it.
 */
async function withPruneLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const url = getDirectDatabaseUrl();
  // No URL (shouldn't happen in a running app) → run uncoordinated rather than
  // silently skip maintenance. Single-process dev has exactly one caller anyway.
  if (!url) return fn();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [PRUNE_LOCK_CLASSID, PRUNE_LOCK_OBJID],
    );
    if (!res.rows[0]?.locked) return null;
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [PRUNE_LOCK_CLASSID, PRUNE_LOCK_OBJID]);
    }
  } finally {
    await client.end();
  }
}

/**
 * Fleet-coordinated retention prune. Call this on every heavy tick; it decides
 * whether a prune is due (persisted timestamp) and, if so, takes the advisory
 * lock and runs the three prune passes exactly once across the fleet. Cheap and
 * safe to call every ~30s — the not-due path is a single indexed Setting read.
 */
export async function runRetentionPrune(
  intervalMs: number = RETENTION_PRUNE_INTERVAL_MS,
): Promise<RetentionPruneResult> {
  const zero: RetentionPruneResult = { monitor: 0, telemetry: 0, systemInfo: 0, skipped: true };
  if (Date.now() - (await getLastRetentionPruneAt()) < intervalMs) {
    return { ...zero, reason: "not-due" };
  }
  const result = await withPruneLock(async () => {
    // Re-check inside the lock: another replica may have just pruned and
    // bumped the timestamp while we waited to acquire.
    if (Date.now() - (await getLastRetentionPruneAt()) < intervalMs) return null;
    const [monitor, telemetry, systemInfo] = await Promise.all([
      pruneMonitorSamples(),
      pruneTelemetrySamples(),
      pruneSystemInfoSamples(),
    ]);
    await setLastRetentionPruneAt(Date.now());
    return { monitor, telemetry, systemInfo };
  });
  if (result === null) return { ...zero, reason: "lock-held" };
  return { ...result, skipped: false };
}
