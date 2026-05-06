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
import {
  fmgProxyRest,
  resolveDeviceMgmtIpViaFmg,
  type FortiManagerConfig,
} from "./fortimanagerService.js";
import { logEvent } from "../api/routes/events.js";
import { logger } from "../utils/logger.js";
import { resolveOidSync, ensureRegistryLoaded } from "./oidRegistry.js";
import {
  pickVendorProfile,
  type VendorTelemetryProfile,
} from "./vendorTelemetryProfiles.js";
import {
  startPassTimer,
  startWorkTimer,
  recordWorkOutcome,
  recordProbe,
  setMonitoredAssets,
  setQueueDepth,
} from "../metrics.js";
import { dropChunks } from "./timescaleService.js";
import {
  type PollingMethod,
  type AssetSourceKind,
  isPollingMethod,
  isPollingMethodCompatible,
  assetSourceKindFromIntegrationType,
} from "../utils/pollingCompatibility.js";

export interface ProbeResult {
  success: boolean;
  /** Wall-clock duration of the probe, rounded to integer ms. */
  responseTimeMs: number;
  /** Short human-readable reason on failure; null on success. */
  error?: string;
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
  telemetryIntervalSeconds:  number;
  systemInfoIntervalSeconds: number;
  sampleRetentionDays:       number;
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
  telemetryPolling:          PollingMethod | null;
  interfacesPolling:         PollingMethod | null;
  lldpPolling:               PollingMethod | null;
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
  telemetryIntervalSeconds:  60,
  systemInfoIntervalSeconds: 600,
  sampleRetentionDays:       30,
  telemetryRetentionDays:    30,
  systemInfoRetentionDays:   30,
  // Polling fields default to null at every tier. Source-aware defaults
  // (FMG/FortiGate -> rest_api, AD/Entra/Win -> icmp, manual -> icmp for
  // responseTime + null for the other streams) are applied by the resolver
  // via defaultPollingForSource().
  responseTimePolling:       null,
  telemetryPolling:          null,
  interfacesPolling:         null,
  lldpPolling:               null,
};

// ─── Legacy global-tier types (transitional, scheduled for removal) ────────
//
// The old single-row `monitorSettings` Setting + per-class fortiswitch/fortiap
// blocks. Kept alive temporarily so the prune helpers and capacityService
// continue working while the migration job (step 5) seeds the new tiers.
// After that migration runs, the legacy row is deleted and these types stop
// being read at all — at which point they get removed in a follow-up pass.

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
  fortiswitch: MonitorClassSettings;
  fortiap:     MonitorClassSettings;
}

const SETTING_KEY = "monitorSettings";
const MANUAL_SETTING_KEY = "manualMonitorSettings";

const DEFAULT_CLASS_SETTINGS: MonitorClassSettings = { ...HARDCODED_FLOOR };

const DEFAULT_SETTINGS: MonitorSettings = {
  ...DEFAULT_CLASS_SETTINGS,
  fortiswitch: { ...DEFAULT_CLASS_SETTINGS },
  fortiap:     { ...DEFAULT_CLASS_SETTINGS },
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
  const fsRaw = (v.fortiswitch as Record<string, unknown> | undefined) || undefined;
  const faRaw = (v.fortiap     as Record<string, unknown> | undefined) || undefined;
  return {
    ...base,
    fortiswitch: readClassFromJson(fsRaw, base),
    fortiap:     readClassFromJson(faRaw, base),
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
  fortiswitch?: Partial<MonitorClassSettings>;
  fortiap?:     Partial<MonitorClassSettings>;
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
    fortiswitch: mergeClassUpdate(current.fortiswitch, input.fortiswitch),
    fortiap:     mergeClassUpdate(current.fortiap,     input.fortiap),
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
    return;
  }
  const tierKey = scope.integrationId === null ? MANUAL_TIER_CACHE_KEY : scope.integrationId;
  if (tierKey != null) {
    tierCache.delete(tierKey);
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
  // Per-stream polling lives in a nested `polling: { responseTime, telemetry,
  // interfaces, lldp }` block on the tier-3 JSON. Each stream is optional;
  // a missing or non-PollingMethod value reads as null and the resolver
  // falls back to the source default.
  const pollingBlock = (o.polling as Record<string, unknown> | undefined) ?? undefined;
  return {
    intervalSeconds:           toPositiveInt(o.intervalSeconds,           HARDCODED_FLOOR.intervalSeconds),
    failureThreshold:          toPositiveInt(o.failureThreshold,          HARDCODED_FLOOR.failureThreshold),
    probeTimeoutMs:            toPositiveInt(o.probeTimeoutMs,            HARDCODED_FLOOR.probeTimeoutMs),
    telemetryIntervalSeconds:  toPositiveInt(o.telemetryIntervalSeconds,  HARDCODED_FLOOR.telemetryIntervalSeconds),
    systemInfoIntervalSeconds: toPositiveInt(o.systemInfoIntervalSeconds, HARDCODED_FLOOR.systemInfoIntervalSeconds),
    sampleRetentionDays:       toPositiveInt(o.sampleRetentionDays,       HARDCODED_FLOOR.sampleRetentionDays),
    telemetryRetentionDays:    toPositiveInt(o.telemetryRetentionDays,    HARDCODED_FLOOR.telemetryRetentionDays),
    systemInfoRetentionDays:   toPositiveInt(o.systemInfoRetentionDays,   HARDCODED_FLOOR.systemInfoRetentionDays),
    responseTimePolling:       readPollingFromJson(pollingBlock, "responseTime"),
    telemetryPolling:          readPollingFromJson(pollingBlock, "telemetry"),
    interfacesPolling:         readPollingFromJson(pollingBlock, "interfaces"),
    lldpPolling:               readPollingFromJson(pollingBlock, "lldp"),
  };
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
  stream: "responseTime" | "telemetry" | "interfaces" | "lldp",
): PollingMethod | null {
  if (source === "fortimanager" || source === "fortigate") return "rest_api";
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

async function loadIntegrationTierSettings(integrationId: string): Promise<MonitorTierSettings> {
  const cached = tierCache.get(integrationId);
  if (cached) return cached;
  const integration = await prisma.integration.findUnique({
    where:  { id: integrationId },
    select: { config: true },
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
  tierCache.set(integrationId, result);
  return result;
}

async function loadManualTierSettings(): Promise<MonitorTierSettings> {
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
      intervalSeconds:           true,
      failureThreshold:          true,
      probeTimeoutMs:            true,
      telemetryIntervalSeconds:  true,
      systemInfoIntervalSeconds: true,
      sampleRetentionDays:       true,
      telemetryRetentionDays:    true,
      systemInfoRetentionDays:   true,
      responseTimePolling:       true,
      telemetryPolling:          true,
      interfacesPolling:         true,
      lldpPolling:               true,
    },
  });
  let result: MonitorOverrideSettings | null = null;
  if (row) {
    result = {};
    if (row.intervalSeconds           != null) result.intervalSeconds           = row.intervalSeconds;
    if (row.failureThreshold          != null) result.failureThreshold          = row.failureThreshold;
    if (row.probeTimeoutMs            != null) result.probeTimeoutMs            = row.probeTimeoutMs;
    if (row.telemetryIntervalSeconds  != null) result.telemetryIntervalSeconds  = row.telemetryIntervalSeconds;
    if (row.systemInfoIntervalSeconds != null) result.systemInfoIntervalSeconds = row.systemInfoIntervalSeconds;
    if (row.sampleRetentionDays       != null) result.sampleRetentionDays       = row.sampleRetentionDays;
    if (row.telemetryRetentionDays    != null) result.telemetryRetentionDays    = row.telemetryRetentionDays;
    if (row.systemInfoRetentionDays   != null) result.systemInfoRetentionDays   = row.systemInfoRetentionDays;
    // Polling columns are nullable strings; only adopt them when they pass
    // the type guard so a stale legacy value (e.g. "rest") in the DB doesn't
    // smuggle through as a typed PollingMethod here. Bad values are silently
    // dropped — the resolver falls through to the next tier.
    if (isPollingMethod(row.responseTimePolling)) result.responseTimePolling = row.responseTimePolling;
    if (isPollingMethod(row.telemetryPolling))    result.telemetryPolling    = row.telemetryPolling;
    if (isPollingMethod(row.interfacesPolling))   result.interfacesPolling   = row.interfacesPolling;
    if (isPollingMethod(row.lldpPolling))         result.lldpPolling         = row.lldpPolling;
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
  telemetryIntervalSec:      number | null;
  systemInfoIntervalSec:     number | null;
  probeTimeoutMs:            number | null;
  // Per-stream polling overrides on the asset itself. null = inherit.
  // String? on disk so legacy values can sit alongside; resolver adopts
  // them only when they pass isPollingMethod().
  responseTimePolling?:      string | null;
  telemetryPolling?:         string | null;
  interfacesPolling?:        string | null;
  lldpPolling?:              string | null;
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
  // Tier 3 (integration-tier or manual-tier).
  const tier3 = asset.discoveredByIntegrationId
    ? await loadIntegrationTierSettings(asset.discoveredByIntegrationId)
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
    if (classOverride.intervalSeconds           != null) merged.intervalSeconds           = classOverride.intervalSeconds;
    if (classOverride.failureThreshold          != null) merged.failureThreshold          = classOverride.failureThreshold;
    if (classOverride.probeTimeoutMs            != null) merged.probeTimeoutMs            = classOverride.probeTimeoutMs;
    if (classOverride.telemetryIntervalSeconds  != null) merged.telemetryIntervalSeconds  = classOverride.telemetryIntervalSeconds;
    if (classOverride.systemInfoIntervalSeconds != null) merged.systemInfoIntervalSeconds = classOverride.systemInfoIntervalSeconds;
    if (classOverride.sampleRetentionDays       != null) merged.sampleRetentionDays       = classOverride.sampleRetentionDays;
    if (classOverride.telemetryRetentionDays    != null) merged.telemetryRetentionDays    = classOverride.telemetryRetentionDays;
    if (classOverride.systemInfoRetentionDays   != null) merged.systemInfoRetentionDays   = classOverride.systemInfoRetentionDays;
  }

  // Tier 1 (per-asset cadence / timeout overrides).
  if (asset.monitorIntervalSec    != null) merged.intervalSeconds           = asset.monitorIntervalSec;
  if (asset.telemetryIntervalSec  != null) merged.telemetryIntervalSeconds  = asset.telemetryIntervalSec;
  if (asset.systemInfoIntervalSec != null) merged.systemInfoIntervalSeconds = asset.systemInfoIntervalSec;
  if (asset.probeTimeoutMs        != null) merged.probeTimeoutMs            = asset.probeTimeoutMs;

  // Per-stream polling resolution — see header comment above for rules.
  function resolveStream(
    stream: "responseTime" | "telemetry" | "interfaces" | "lldp",
    tierVal: PollingMethod | null,
    classVal: PollingMethod | null | undefined,
    assetVal: string | null | undefined,
  ): PollingMethod | null {
    let resolved: PollingMethod | null = defaultPollingForSource(sourceKind, stream);
    if (tierVal && isPollingMethodCompatible(sourceKind, tierVal)) {
      resolved = tierVal;
    }
    if (classVal && isPollingMethodCompatible(sourceKind, classVal)) {
      resolved = classVal;
    }
    if (isPollingMethod(assetVal) && isPollingMethodCompatible(sourceKind, assetVal)) {
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
  merged.telemetryPolling = resolveStream(
    "telemetry",
    tier3.telemetryPolling,
    classOverride?.telemetryPolling ?? null,
    asset.telemetryPolling,
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

  return merged;
}

/** Per-field "where did this value come from?" label. Drives the asset-modal tier badges. */
export type ProvenanceTier = "asset" | "class" | "integration" | "manual";

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
    ? await loadIntegrationTierSettings(asset.discoveredByIntegrationId)
    : await loadManualTierSettings();

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
  // Initialize provenance to tier3Source for every field; class/asset layers
  // overwrite below. Listing the keys explicitly keeps the type checker happy
  // (Record<keyof X, ...>) without an Object.fromEntries dance.
  const provenance: Record<keyof MonitorTierSettings, ProvenanceTier> = {
    intervalSeconds:           tier3Source,
    failureThreshold:          tier3Source,
    probeTimeoutMs:            tier3Source,
    telemetryIntervalSeconds:  tier3Source,
    systemInfoIntervalSeconds: tier3Source,
    sampleRetentionDays:       tier3Source,
    telemetryRetentionDays:    tier3Source,
    systemInfoRetentionDays:   tier3Source,
    responseTimePolling:       tier3Source,
    telemetryPolling:          tier3Source,
    interfacesPolling:         tier3Source,
    lldpPolling:               tier3Source,
  };

  if (classOverride) {
    // Field-by-field copy + provenance bump. The mixed value types (numbers
    // for cadence, PollingMethod for polling) make the previous loop hostile
    // to TypeScript's narrowing — listing each field explicitly keeps the
    // types straight without `as any`.
    if (classOverride.intervalSeconds           != null) { resolved.intervalSeconds           = classOverride.intervalSeconds;           provenance.intervalSeconds           = "class"; }
    if (classOverride.failureThreshold          != null) { resolved.failureThreshold          = classOverride.failureThreshold;          provenance.failureThreshold          = "class"; }
    if (classOverride.probeTimeoutMs            != null) { resolved.probeTimeoutMs            = classOverride.probeTimeoutMs;            provenance.probeTimeoutMs            = "class"; }
    if (classOverride.telemetryIntervalSeconds  != null) { resolved.telemetryIntervalSeconds  = classOverride.telemetryIntervalSeconds;  provenance.telemetryIntervalSeconds  = "class"; }
    if (classOverride.systemInfoIntervalSeconds != null) { resolved.systemInfoIntervalSeconds = classOverride.systemInfoIntervalSeconds; provenance.systemInfoIntervalSeconds = "class"; }
    if (classOverride.sampleRetentionDays       != null) { resolved.sampleRetentionDays       = classOverride.sampleRetentionDays;       provenance.sampleRetentionDays       = "class"; }
    if (classOverride.telemetryRetentionDays    != null) { resolved.telemetryRetentionDays    = classOverride.telemetryRetentionDays;    provenance.telemetryRetentionDays    = "class"; }
    if (classOverride.systemInfoRetentionDays   != null) { resolved.systemInfoRetentionDays   = classOverride.systemInfoRetentionDays;   provenance.systemInfoRetentionDays   = "class"; }
    if (classOverride.responseTimePolling)        { resolved.responseTimePolling = classOverride.responseTimePolling; provenance.responseTimePolling = "class"; }
    if (classOverride.telemetryPolling)           { resolved.telemetryPolling    = classOverride.telemetryPolling;    provenance.telemetryPolling    = "class"; }
    if (classOverride.interfacesPolling)          { resolved.interfacesPolling   = classOverride.interfacesPolling;   provenance.interfacesPolling   = "class"; }
    if (classOverride.lldpPolling)                { resolved.lldpPolling         = classOverride.lldpPolling;         provenance.lldpPolling         = "class"; }
  }

  // Per-asset (only the four overridable fields).
  if (asset.monitorIntervalSec != null) {
    resolved.intervalSeconds = asset.monitorIntervalSec;
    provenance.intervalSeconds = "asset";
  }
  if (asset.telemetryIntervalSec != null) {
    resolved.telemetryIntervalSeconds = asset.telemetryIntervalSec;
    provenance.telemetryIntervalSeconds = "asset";
  }
  if (asset.systemInfoIntervalSec != null) {
    resolved.systemInfoIntervalSeconds = asset.systemInfoIntervalSec;
    provenance.systemInfoIntervalSeconds = "asset";
  }
  if (asset.probeTimeoutMs != null) {
    resolved.probeTimeoutMs = asset.probeTimeoutMs;
    provenance.probeTimeoutMs = "asset";
  }
  // Per-asset polling overrides — only adopted when they're a real
  // PollingMethod string. Compatibility check happens here too: a stale
  // legacy "rest" or an incompatible value silently falls through to the
  // class/tier value.
  const sourceKindForAsset = assetSourceKindFromIntegrationType(asset.discoveredByIntegrationType ?? null);
  function takeAssetPolling(stream: keyof Pick<MonitorTierSettings, "responseTimePolling" | "telemetryPolling" | "interfacesPolling" | "lldpPolling">, raw: string | null | undefined) {
    if (isPollingMethod(raw) && isPollingMethodCompatible(sourceKindForAsset, raw)) {
      resolved[stream] = raw;
      provenance[stream] = "asset";
    }
  }
  takeAssetPolling("responseTimePolling", asset.responseTimePolling);
  takeAssetPolling("telemetryPolling",    asset.telemetryPolling);
  takeAssetPolling("interfacesPolling",   asset.interfacesPolling);
  takeAssetPolling("lldpPolling",         asset.lldpPolling);

  return { resolved, provenance, tier3Source, classOverrideId };
}

/**
 * Resolve the SNMP credential config to use when an FMG/FortiGate-typed asset
 * has a transport toggle flipped to "snmp". Asset's own monitorCredential wins
 * if it's an SNMP credential; otherwise we fall back to the integration's
 * `monitorCredentialId`. Throws on missing/wrong-type credentials so the
 * caller can surface the reason in the System tab error toast.
 */
async function loadSnmpCredentialConfigForFortinetAsset(
  asset: { monitorCredential?: { type: string; config: unknown } | null },
  integration: { config?: unknown } | null | undefined,
): Promise<Record<string, unknown>> {
  if (asset.monitorCredential && asset.monitorCredential.type === "snmp") {
    return (asset.monitorCredential.config as Record<string, unknown>) || {};
  }
  const intCfg = (integration?.config && typeof integration.config === "object")
    ? (integration.config as Record<string, unknown>)
    : {};
  const credId = typeof intCfg.monitorCredentialId === "string" ? intCfg.monitorCredentialId : null;
  if (!credId) throw new Error("Transport set to SNMP but no SNMP credential is configured on the asset or integration");
  const cred = await prisma.credential.findUnique({ where: { id: credId } });
  if (!cred) throw new Error("Integration's monitor credential not found");
  if (cred.type !== "snmp") throw new Error(`Integration's monitor credential must be SNMP (got "${cred.type}")`);
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
): Promise<IpsecTunnelSample[] | undefined> {
  try {
    const fg = buildFortinetConfig(host, integration);
    if ("error" in fg) return undefined;
    return await collectIpsecTunnelsFortinet(fg);
  } catch {
    return undefined;
  }
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
        return await probeFortinet(targetIp, integration as any, start, timeoutMs);
      }
      if (asset.monitorCredential?.type === "restapi") {
        return await probeRestApiCredential(asset.monitorCredential.config as Record<string, unknown>, start, timeoutMs);
      }
      return finish(start, false, "REST API polling requires either a Fortinet integration or a REST API credential");
    }
    if (polling === "snmp") {
      // Asset's own SNMP credential wins. Fortinet-discovered firewalls fall
      // back to the integration's monitorCredentialId so an operator who set
      // the integration tier to SNMP doesn't need to attach a credential to
      // every firewall.
      if (asset.monitorCredential?.type === "snmp") {
        return await probeSnmp(targetIp, asset.monitorCredential.config as Record<string, unknown>, start, timeoutMs);
      }
      if (isFortinetSrc && integration) {
        try {
          const credConfig = await loadSnmpCredentialConfigForFortinetAsset(asset, integration);
          return await probeSnmp(targetIp, credConfig, start, timeoutMs);
        } catch (err: any) {
          return finish(start, false, err?.message || "SNMP credential lookup failed");
        }
      }
      return finish(start, false, "No SNMP credential selected");
    }
    if (polling === "winrm") {
      // Asset's own WinRM credential wins. AD-discovered hosts fall back to
      // the integration's bind credentials over HTTPS/5986.
      if (asset.monitorCredential?.type === "winrm") {
        return await probeWinRm(targetIp, asset.monitorCredential.config as Record<string, unknown>, start, timeoutMs);
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
      // Same shape as WinRM — asset credential first, AD bind fallback second.
      if (asset.monitorCredential?.type === "ssh") {
        return await probeSsh(targetIp, asset.monitorCredential.config as Record<string, unknown>, start, timeoutMs);
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
}

interface FortinetControllerCacheEntry {
  fetchedAt: number;
  inventory: Map<string, FortinetControllerEntry>;
}

const FORTINET_CONTROLLER_CACHE_TTL_MS = 30_000;
const fortinetControllerCache = new Map<string, FortinetControllerCacheEntry>();

function controllerCacheKey(integrationId: string, deviceName: string, kind: "switches" | "aps"): string {
  return `${integrationId}::${deviceName}::${kind}`;
}

/**
 * Build the directly-callable FortiGateConfig for a managed device behind
 * an FMG integration in direct mode. Resolves the device's mgmt IP via FMG
 * (one CMDB lookup; cheap and parallelizable). Returns null when the
 * integration isn't configured for direct mode.
 */
async function fmgDirectFortiGateConfig(
  fmgConfig: FortiManagerConfig,
  deviceName: string,
): Promise<FortiGateConfig | null> {
  if (fmgConfig.useProxy !== false) return null;
  if (!fmgConfig.fortigateApiToken || !fmgConfig.mgmtInterface?.trim()) return null;
  const mgmtIp = await resolveDeviceMgmtIpViaFmg(fmgConfig, deviceName);
  if (!mgmtIp) return null;
  return {
    host: mgmtIp,
    port: 443,
    apiUser: fmgConfig.fortigateApiUser || "",
    apiToken: fmgConfig.fortigateApiToken,
    verifySsl: fmgConfig.fortigateVerifySsl === true,
  };
}

async function fetchFortinetControllerInventory(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  kind: "switches" | "aps",
  timeoutMs: number,
): Promise<Map<string, FortinetControllerEntry>> {
  const cacheKey = controllerCacheKey(integration.id, deviceName, kind);
  const cached = fortinetControllerCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FORTINET_CONTROLLER_CACHE_TTL_MS) {
    return cached.inventory;
  }

  const path = kind === "switches"
    ? "/api/v2/monitor/switch-controller/managed-switch/status"
    : "/api/v2/monitor/wifi/managed_ap";

  let rawRows: unknown;
  if (integration.type === "fortimanager") {
    const fmgConfig = integration.config as unknown as FortiManagerConfig;
    const direct = await fmgDirectFortiGateConfig(fmgConfig, deviceName);
    if (direct) {
      rawRows = await fgRequest<unknown>(direct, "GET", path, { timeoutMs });
    } else {
      // Proxy mode (default) — wrap in /sys/proxy/json. fmgProxyRest unwraps
      // the FMG envelope + FortiOS envelope and returns the inner results.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        rawRows = await fmgProxyRest<unknown>(fmgConfig, deviceName, "GET", path, { signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
    }
  } else if (integration.type === "fortigate") {
    rawRows = await fgRequest<unknown>(integration.config as unknown as FortiGateConfig, "GET", path, { timeoutMs });
  } else {
    throw new Error(`Unsupported integration type for Fortinet controller probe: ${integration.type}`);
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
    inventory.set(serial.toUpperCase(), { connected, status });
  }

  fortinetControllerCache.set(cacheKey, { fetchedAt: Date.now(), inventory });
  return inventory;
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
    const inventory = await fetchFortinetControllerInventory(integration, deviceName, kind, timeoutMs);
    const entry = inventory.get(serial.toUpperCase());
    if (!entry) {
      const label = kind === "switches" ? "managed-switch" : "managed-AP";
      return finish(start, false, `Not present in ${deviceName}'s ${label} table`);
    }
    if (entry.connected) {
      return finish(start, true);
    }
    const role = kind === "switches" ? "switch" : "AP";
    return finish(start, false, `Controller reports ${role} status: ${entry.status || "Disconnected"}`);
  } catch (err: any) {
    return finish(start, false, err?.message || "Controller query failed");
  }
}

async function probeIcmp(host: string, start: number, timeoutMs: number): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolve) => {
    const isWindows = process.platform === "win32";
    const args = isWindows
      ? ["-n", "1", "-w", String(timeoutMs), host]
      : ["-c", "1", "-W", String(Math.ceil(timeoutMs / 1000)), host];
    const child = spawn("ping", args, { stdio: ["ignore", "pipe", "pipe"] });
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch {}
      resolve(finish(start, false, "ping timed out"));
    }, timeoutMs + 2_000);
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

async function probeSnmp(host: string, config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
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
        finishOnce(finish(start, true));
      });
    } catch (err: any) {
      clearTimeout(timer);
      finishOnce(finish(start, false, err?.message || "SNMP setup failed"));
    }
  });
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
      rejectUnauthorized: false,
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
  /** Operator-set label that overrides ifName in the UI. FortiOS CMDB `alias`; SNMP ifAlias (1.3.6.1.2.1.31.1.1.1.18). */
  alias?:       string | null;
  /** Operator-set free-text comment. FortiOS CMDB `description`; SNMP has no equivalent. */
  description?: string | null;
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

export interface SystemInfoSample {
  interfaces:    InterfaceSample[];
  storage:       StorageSample[];
  ipsecTunnels?: IpsecTunnelSample[];
  /**
   * LLDP neighbors observed during this scrape. `undefined` means the
   * collector didn't try (unsupported transport / fast-cadence skip);
   * `[]` means the device was queried but reported zero neighbors and the
   * persistence layer should treat that as "wipe all stored neighbors".
   */
  lldpNeighbors?: LldpNeighborSample[];
  /** Which transport produced lldpNeighbors. Stamped onto each persisted row for diagnostics. */
  lldpSource?:    "fortios" | "snmp";
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

  // Resolve the per-stream polling method. Source-default fallback gives us
  // a value (rest_api on Fortinet, null on AD/Entra/Win/Manual since the
  // telemetry stream isn't delivered there by default).
  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  const polling = effective.telemetryPolling;
  if (!polling) return { supported: false };

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
      const data = await collectTelemetryFortinet(targetIp, integration as any);
      return { supported: true, data };
    }
    if (polling === "snmp") {
      // Asset's own SNMP credential wins; Fortinet-discovered firewalls fall
      // back to the integration's monitorCredentialId (matches probe and
      // collectSystemInfo).
      let snmpCfg: Record<string, unknown>;
      if (asset.monitorCredential?.type === "snmp") {
        snmpCfg = asset.monitorCredential.config as Record<string, unknown>;
      } else if (isFortinetSrc && integration) {
        snmpCfg = await loadSnmpCredentialConfigForFortinetAsset(asset, integration);
      } else {
        return { supported: true, error: "No SNMP credential selected" };
      }
      const data = await collectTelemetrySnmp(targetIp, snmpCfg, asset.manufacturer, asset.model, asset.os);
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

  const targetIp =
    asset.ipAddress ||
    ((polling === "winrm" || polling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration   = asset.discoveredByIntegration ?? null;
  const isFortinetSrc = integration?.type === "fortimanager" || integration?.type === "fortigate";

  try {
    let full: SystemInfoSample;
    if (polling === "rest_api") {
      if (!isFortinetSrc || !integration) return { supported: false };
      // Only ask FortiOS for IPsec when a tunnel is actually pinned —
      // /api/v2/monitor/vpn/ipsec is the slow endpoint we want to avoid on
      // the fast cadence. Fast cadence always skips LLDP — neighbors don't
      // change between full system-info passes often enough to merit
      // re-walking the table once a minute.
      full = await collectSystemInfoFortinet(targetIp, integration as any, {
        includeIpsec: wantedTunnels.length > 0,
        includeLldp:  false,
      });
    } else if (polling === "snmp") {
      let snmpCfg: Record<string, unknown>;
      if (asset.monitorCredential?.type === "snmp") {
        snmpCfg = asset.monitorCredential.config as Record<string, unknown>;
      } else if (isFortinetSrc && integration) {
        snmpCfg = await loadSnmpCredentialConfigForFortinetAsset(asset, integration);
      } else {
        return { supported: true, error: "No SNMP credential selected" };
      }
      full = await collectSystemInfoSnmp(targetIp, snmpCfg, { includeLldp: false });
      // Fortinet-discovered firewalls running SNMP still benefit from the
      // integration's interface filter (CMDB blocklist) and from the FortiOS
      // IPsec overlay — the two endpoints are independent of the SNMP path.
      if (isFortinetSrc && integration) {
        applyFortiInterfaceFilter(full.interfaces, integration as any);
        if (wantedTunnels.length > 0) {
          const ipsec = await collectIpsecOnlyFortinetSafe(targetIp, integration as any);
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
        alias:       i.alias       ?? null,
        description: i.description ?? null,
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
        tunnelName:      t.tunnelName,
        parentInterface: t.parentInterface,
        remoteGateway:   t.remoteGateway,
        status:          t.status,
        incomingBytes:   t.incomingBytes != null ? BigInt(Math.round(t.incomingBytes)) : null,
        outgoingBytes:   t.outgoingBytes != null ? BigInt(Math.round(t.outgoingBytes)) : null,
        proxyIdCount:    t.proxyIdCount,
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

  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  const interfacesPolling = effective.interfacesPolling;
  const lldpPolling       = effective.lldpPolling;
  // No interfaces stream → no system-info to collect. LLDP-only without an
  // interfaces context isn't meaningful (we'd have nothing to attach the
  // neighbors to in the System tab table).
  if (!interfacesPolling) return { supported: false };

  const targetIp =
    asset.ipAddress ||
    ((interfacesPolling === "winrm" || interfacesPolling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration   = asset.discoveredByIntegration ?? null;
  const isFortinetSrc = integration?.type === "fortimanager" || integration?.type === "fortigate";

  try {
    if (interfacesPolling === "rest_api" || interfacesPolling === "snmp") {
      // Mixed-transport branch: interfaces and LLDP can independently be
      // REST or SNMP. Pre-load the SNMP credential only if at least one
      // stream needs it.
      let snmpCfg: Record<string, unknown> | null = null;
      const needSnmp = interfacesPolling === "snmp" || lldpPolling === "snmp";
      if (needSnmp) {
        if (asset.monitorCredential?.type === "snmp") {
          snmpCfg = asset.monitorCredential.config as Record<string, unknown>;
        } else if (isFortinetSrc && integration) {
          snmpCfg = await loadSnmpCredentialConfigForFortinetAsset(asset, integration);
        } else {
          return { supported: true, error: "No SNMP credential selected" };
        }
      }
      // REST API for interfaces requires a Fortinet integration.
      if (interfacesPolling === "rest_api" && (!isFortinetSrc || !integration)) {
        return { supported: false };
      }

      let data: SystemInfoSample;
      if (interfacesPolling === "snmp") {
        // SNMP-path interfaces+storage. Fetch LLDP via the same session iff
        // the LLDP polling agrees; otherwise leave it out and overlay below.
        data = await collectSystemInfoSnmp(targetIp, snmpCfg!, { includeLldp: lldpPolling === "snmp" });
        if (isFortinetSrc && integration) {
          applyFortiInterfaceFilter(data.interfaces, integration as any);
          // IPsec always via REST when the source is Fortinet — SNMP has no equivalent.
          const ipsec = await collectIpsecOnlyFortinetSafe(targetIp, integration as any);
          if (ipsec !== undefined) data.ipsecTunnels = ipsec;
        }
      } else {
        // FortiOS REST path. Skip the FortiOS LLDP call when LLDP is on SNMP.
        data = await collectSystemInfoFortinet(targetIp, integration as any, {
          includeIpsec: true,
          includeLldp:  lldpPolling === "rest_api",
        });
      }
      // Cross-transport LLDP overlay: when the chosen LLDP source differs
      // from the interfaces source we already used above.
      if (lldpPolling === "snmp" && interfacesPolling === "rest_api" && snmpCfg) {
        const neighbors = await collectLldpOnlySnmp(targetIp, snmpCfg).catch(() => undefined);
        if (neighbors !== undefined) {
          data.lldpNeighbors = neighbors;
          data.lldpSource    = "snmp";
        }
      } else if (lldpPolling === "rest_api" && interfacesPolling === "snmp" && isFortinetSrc && integration) {
        const neighbors = await collectLldpOnlyFortinet(targetIp, integration as any).catch(() => undefined);
        if (neighbors !== undefined) {
          data.lldpNeighbors = neighbors;
          data.lldpSource    = "fortios";
        }
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
  opts: { includeIpsec?: boolean; includeLldp?: boolean } = {},
): Promise<SystemInfoSample> {
  const fg = buildFortinetConfig(host, integration);
  if ("error" in fg) throw new Error(fg.error);

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
  const cmdbInterfacePromise = fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/interface", { query: { vdom: "root" } })
    .catch(() => null as any);
  const monitorInterfacePromise = fgRequest<any>(fg, "GET", "/api/v2/monitor/system/interface", {
    query: { scope: "vdom", include_vlan: "true", include_aggregate: "true" },
  })
    .then((res) => ({ ok: true as const, res }))
    .catch((err) => ({ ok: false as const, err }));
  const ipsecPromise = opts.includeIpsec
    ? collectIpsecTunnelsFortinet(fg).catch(() => [] as IpsecTunnelSample[])
    : Promise.resolve<IpsecTunnelSample[] | undefined>(undefined);
  const lldpPromise = opts.includeLldp !== false
    ? collectLldpNeighborsFortinet(fg).catch(() => undefined)
    : Promise.resolve<LldpNeighborSample[] | undefined>(undefined);

  const [cmdbRes, monitorOutcome, ipsecTunnels, lldpNeighbors] = await Promise.all([
    cmdbInterfacePromise,
    monitorInterfacePromise,
    ipsecPromise,
    lldpPromise,
  ]);

  // Build cmdbByName from the CMDB response. Non-fatal failure → empty map
  // → falls back to monitor-only types (same as the original try/catch).
  const cmdbByName = new Map<string, { type: string | null; parent: string | null; vlanId: number | null; members: string[]; alias: string | null; description: string | null }>();
  if (cmdbRes) {
    const arr = Array.isArray(cmdbRes) ? cmdbRes : (Array.isArray(cmdbRes?.results) ? cmdbRes.results : []);
    for (const c of arr) {
      if (!c || typeof c !== "object" || typeof c.name !== "string") continue;
      const t = typeof c.type === "string" ? c.type : null;
      // CMDB `member` is an array of { interface_name } entries on aggregate
      // and hard-switch / vap-switch interfaces.
      const members: string[] = Array.isArray(c.member)
        ? c.member.map((m: any) => (typeof m === "string" ? m : (typeof m?.interface_name === "string" ? m.interface_name : null))).filter(Boolean)
        : [];
      const alias       = typeof c.alias       === "string" && c.alias.trim()       ? c.alias.trim()       : null;
      const description = typeof c.description === "string" && c.description.trim() ? c.description.trim() : null;
      cmdbByName.set(c.name, {
        type:    t,
        parent:  t === "vlan" && typeof c.interface === "string" ? c.interface : null,
        vlanId:  t === "vlan" && typeof c.vlanid === "number" ? c.vlanid : null,
        members,
        alias,
        description,
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
  return { interfaces, storage: [], ipsecTunnels, lldpNeighbors, lldpSource: opts.includeLldp !== false ? "fortios" : undefined };
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
): Promise<LldpNeighborSample[] | undefined> {
  const fg = buildFortinetConfig(host, integration);
  if ("error" in fg) throw new Error(fg.error);
  return await collectLldpNeighborsFortinet(fg).catch(() => undefined);
}

/**
 * FortiOS exposes LLDP neighbors at /api/v2/monitor/system/interface/lldp-neighbors.
 * The response shape is `{ results: [{ interface, chassis_id, port_id, ... }, …] }`.
 * Field names vary across versions (some firmwares use `local_intf` / `local_intf_name`
 * / `interface`; some use `port_desc` / `port_description`; capabilities show up
 * either as a CSV string or an array). Be defensive about every field.
 */
async function collectLldpNeighborsFortinet(fg: FortiGateConfig): Promise<LldpNeighborSample[]> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/interface/lldp-neighbors", { query: { vdom: "root" } });
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
    fgRequest<any>(fg, "GET", "/api/v2/cmdb/vpn.ipsec/phase1-interface", { query: { vdom: "root" } })
      .catch(() => null as any),
    fgRequest<any>(fg, "GET", "/api/v2/monitor/vpn/ipsec", { query: { scope: "vdom" } }),
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
  // here. The table mixes temperature, fan, and voltage sensors — there is
  // no type column, so callers must filter by name. fgHwSensorEntValue is a
  // DisplayString carrying a decimal value (e.g. "44.5").
  fgHwSensorEntName:  "1.3.6.1.4.1.12356.101.4.3.2.1.2",
  fgHwSensorEntValue: "1.3.6.1.4.1.12356.101.4.3.2.1.3",
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
};

function buildSnmpSession(host: string, config: Record<string, unknown>): any {
  const port = toPositiveInt(config.port, 161);
  const version = config.version === "v3" ? "v3" : "v2c";
  if (version === "v2c") {
    return snmp.createSession(host, String(config.community || ""), {
      port,
      version: snmp.Version2c,
      timeout: COLLECTOR_REQUEST_TIMEOUT_MS,
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
    timeout: COLLECTOR_REQUEST_TIMEOUT_MS,
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
  });
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
    const temperatures = await collectTemperaturesSnmp(session, manufacturer).catch(() => [] as TemperatureSample[]);

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

async function collectTemperaturesSnmp(session: any, manufacturer?: string | null): Promise<TemperatureSample[]> {
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
  if (out.length === 0 && manufacturer && /fortinet/i.test(manufacturer)) {
    return await collectTemperaturesFortinetSnmp(session);
  }
  return out;
}

// FORTINET-FORTIGATE-MIB::fgHwSensorTable fallback for branch FortiGates that
// don't implement ENTITY-SENSOR-MIB. The table has no sensor-type column, so
// we keep rows whose name looks like a temperature sensor and whose value
// parses to a plausible Celsius reading. Common temp sensor names: "DTS CPU0",
// "ADT7490 ...", "LM75 ...", "MB Temp", "CPU Temp"; we exclude obvious
// fan/voltage/power rows.
async function collectTemperaturesFortinetSnmp(session: any): Promise<TemperatureSample[]> {
  const [names, values] = await Promise.all([
    snmpWalk(session, OID.fgHwSensorEntName).catch(() => new Map()),
    snmpWalk(session, OID.fgHwSensorEntValue).catch(() => new Map()),
  ]);
  const out: TemperatureSample[] = [];
  const TEMP_NAME = /temp|dts|adt\d|lm7\d|tmp\d|°c|thermal/i;
  const NON_TEMP  = /\bfan\b|rpm|\bvolt|^[+-]?\d+(\.\d+)?\s*v\b|vcc|vdd|vrm|psu|power|current|amp/i;
  for (const [idx, nameRaw] of names.entries()) {
    const name = snmpVbToString(nameRaw).trim();
    if (!name) continue;
    if (NON_TEMP.test(name)) continue;
    if (!TEMP_NAME.test(name)) continue;
    const valStr = snmpVbToString(values.get(idx)).trim();
    const n = Number(valStr);
    if (!Number.isFinite(n)) continue;
    if (n < -40 || n > 200) continue; // sane Celsius range; rejects RPM/voltage caught by name
    out.push({
      sensorName: name,
      celsius:    Math.round(n * 10) / 10,
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
  opts: { includeLldp?: boolean } = {},
): Promise<SystemInfoSample> {
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
        const name = snmpVbToString(names.get(idx)) || snmpVbToString(descrs.get(idx)) || `if-${idx}`;
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

    // LLDP-MIB neighbors. Best-effort — devices without LLDP-MIB return empty
    // walks (we treat that as "unsupported" so we don't wipe stored rows on
    // every scrape). A device with LLDP enabled but zero current neighbors
    // returns lldpLocPortTable rows but an empty lldpRemTable, and we
    // correctly persist that as "queried, no neighbors" → wipe. `includeLldp`
    // false lets the caller skip this when the operator routed LLDP to REST.
    let lldpNeighbors: LldpNeighborSample[] | undefined;
    if (opts.includeLldp !== false) {
      try {
        lldpNeighbors = await collectLldpNeighborsSnmp(session);
      } catch { /* leave undefined; persist layer leaves stored rows alone */ }
    }

    return {
      interfaces,
      storage,
      lldpNeighbors,
      lldpSource: opts.includeLldp !== false ? "snmp" : undefined,
    };
  });
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
): Promise<LldpNeighborSample[] | undefined> {
  return await withSnmpSession(host, config, async (session) => {
    return await collectLldpNeighborsSnmp(session);
  });
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
  ]);

  // No local LLDP ports → device doesn't speak LLDP-MIB. Signal "leave rows
  // alone" so we don't wipe stored neighbors on a transport that can't report.
  if (locIds.size === 0 && locDescs.size === 0) return undefined;

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
          alias:       i.alias       ?? null,
          description: i.description ?? null,
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
          tunnelName:      t.tunnelName,
          parentInterface: t.parentInterface,
          remoteGateway:   t.remoteGateway,
          status:          t.status,
          incomingBytes:   t.incomingBytes != null ? BigInt(Math.round(t.incomingBytes)) : null,
          outgoingBytes:   t.outgoingBytes != null ? BigInt(Math.round(t.outgoingBytes)) : null,
          proxyIdCount:    t.proxyIdCount,
        })),
      });
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
      await prisma.$transaction([
        prisma.assetAssociatedIp.deleteMany({
          where: { assetId, source: { not: "manual" } },
        }),
        prisma.assetAssociatedIp.createMany({
          data: monitorAssocEntries.map((e) => ({ ...e, assetId })),
          skipDuplicates: true,
        }),
      ]);
    }
    // LLDP neighbors. `undefined` = the collector didn't run / unsupported
    // transport, so leave the existing rows alone. `[]` or a populated array
    // = queried successfully → replace the asset's neighbor set.
    if (Array.isArray(d.lldpNeighbors)) {
      await persistLldpNeighbors(assetId, d.lldpNeighbors, now, d.lldpSource ?? "fortios");
    }
    // Only bump lastSystemInfoAt on a successful pass. The /system-info GET
    // endpoint anchors its interface query to this timestamp so it can render
    // every interface (including unpinned ones the fast cadence doesn't
    // touch) — bumping it on a transport failure where no rows were inserted
    // would point the query at a moment with zero samples and silently empty
    // the Interfaces table on the System tab while the device is offline.
    await prisma.asset.update({ where: { id: assetId }, data: { lastSystemInfoAt: now } });
  }
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
  const matchIndex = await buildLldpAssetMatchIndex();
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
    return null;
  };

  // Existing rows for diffing. Keyed the same way the unique index is —
  // (localIfName, chassisId ?? "", portId ?? "") to handle Postgres-distinct nulls.
  const existing = await prisma.assetLldpNeighbor.findMany({ where: { assetId } });
  const seen = new Set<string>();
  const keyOf = (li: string, ci: string | null | undefined, pi: string | null | undefined) =>
    `${li}${ci ?? ""}${pi ?? ""}`;
  const existingByKey = new Map<string, typeof existing[number]>();
  for (const e of existing) existingByKey.set(keyOf(e.localIfName, e.chassisId, e.portId), e);

  // Partition fresh neighbors into to-create and to-update so each side can
  // hit the DB in a single batched call instead of N per-neighbor round-trips.
  // For a switch with 40 LLDP neighbors this collapses 40 DB calls into 2
  // (one createMany for new, one $transaction for updates).
  const toCreate: Array<Record<string, unknown>> = [];
  const toUpdate: Array<{ id: string; data: Record<string, unknown> }> = [];

  for (const n of neighbors) {
    const k = keyOf(n.localIfName, n.chassisId ?? null, n.portId ?? null);
    seen.add(k);
    const matched = matchedFor(n);
    const data = {
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
    };
    const prior = existingByKey.get(k);
    if (prior) {
      toUpdate.push({ id: prior.id, data: { ...data, lastSeen: now } });
    } else {
      toCreate.push({ ...data, assetId, firstSeen: now, lastSeen: now });
    }
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
  // Batched writes. createMany is a single statement; the $transaction wraps
  // all per-row updates into one round-trip pipelined over the connection.
  // Order: creates first so a brand-new neighbor is visible before stale
  // siblings on the same port get deleted.
  if (toCreate.length > 0) {
    await prisma.assetLldpNeighbor.createMany({ data: toCreate as any });
  }
  if (toUpdate.length > 0) {
    await prisma.$transaction(
      toUpdate.map((u) =>
        prisma.assetLldpNeighbor.update({ where: { id: u.id }, data: u.data as any }),
      ),
    );
  }
  if (toDelete.length > 0) {
    await prisma.assetLldpNeighbor.deleteMany({ where: { id: { in: toDelete } } });
  }
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
async function buildLldpAssetMatchIndex(): Promise<{
  byIp: Map<string, string>;
  byMac: Map<string, string>;
  byHostname: Map<string, string>;
}> {
  const rows = await prisma.asset.findMany({
    select: {
      id: true, ipAddress: true, macAddress: true, hostname: true, dnsName: true,
      associatedIpRows: { select: { ip: true } },
      macAddressRows:   { select: { mac: true } },
    },
  });
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
export async function recordProbeResult(assetId: string, result: ProbeResult): Promise<void> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      hostname: true,
      assetType: true,
      monitored: true,
      monitorStatus: true,
      consecutiveFailures: true,
      consecutiveSuccesses: true,
      discoveredByIntegrationId: true,
      monitorIntervalSec: true,
      telemetryIntervalSec: true,
      systemInfoIntervalSec: true,
      probeTimeoutMs: true,
    },
  });
  if (!asset) return;

  // Resolve effective settings through the hierarchy. failureThreshold doubles
  // as the recovery threshold — we use it for both up→down and pending→up
  // transitions. Same number of confirmations either direction.
  const effective = await resolveMonitorSettings(asset);
  const threshold = effective.failureThreshold;

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
  //   unknown / down + success → pending (until cs ≥ threshold → up)
  //   pending          + success → up if cs ≥ threshold else stay pending
  //   pending          + failure → down if cf ≥ threshold else stay pending
  //   up               + failure → warning (cf=1, count toward down)
  //   warning          + success → up if cs ≥ threshold else stay warning
  //   warning          + failure → down if cf ≥ threshold else stay warning
  //   unknown          + failure → warning (treat as fresh up that just failed)
  //
  // Down hosts that fail again stay down; the down→pending arrow is the only
  // exit from down and requires at least one success.
  let nextStatus: "up" | "warning" | "pending" | "down" | "unknown";
  if (result.success) {
    if (previousStatus === "up") {
      nextStatus = "up";
    } else if (previousStatus === "warning" || previousStatus === "pending") {
      nextStatus = newCs >= threshold ? "up" : previousStatus;
    } else {
      // unknown / down → start the recovery counter at pending.
      nextStatus = newCs >= threshold ? "up" : "pending";
    }
  } else {
    if (newCf >= threshold) {
      nextStatus = "down";
    } else if (previousStatus === "up" || previousStatus === "unknown") {
      nextStatus = "warning";
    } else if (previousStatus === "warning" || previousStatus === "pending" || previousStatus === "down") {
      // Stay in the current state and let the counter march toward "down".
      nextStatus = previousStatus;
    } else {
      nextStatus = "warning";
    }
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
      consecutiveFailures: newCf,
      consecutiveSuccesses: newCs,
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
        consecutiveFailures:  newCf,
        consecutiveSuccesses: newCs,
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

export type MonitorCadence = "probe" | "telemetry" | "systemInfo" | "fastFiltered";

/**
 * Per-cadence outcome tally returned by the runFooFor() functions. Used by
 * both runMonitorPass (rolls into RunStats) and the upcoming pg-boss workers
 * (logs only; pg-boss tracks job state independently). `crash` is reserved
 * for unexpected exceptions; `failure` covers expected sad-path returns
 * like "probe ran but credential failed" or "telemetry returned no data".
 */
export type CadenceOutcome = "success" | "failure" | "crash";

/**
 * Run a single response-time probe for one asset, write the sample, update
 * Asset row state (monitorStatus / lastMonitorAt / consecutiveFailures),
 * record metrics. `transport` labels the per-transport histogram + counter
 * — callers that already know the asset's monitorType (e.g. runMonitorPass
 * has it from the candidate query) pass it in to avoid a second DB read.
 */
export async function runProbeFor(assetId: string, transport: string): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("probe");
  const probeStart = Date.now();
  try {
    const result = await probeAsset(assetId);
    const probeMs = Date.now() - probeStart;
    await recordProbeResult(assetId, result);
    if (result.success) {
      recordProbe(transport, probeMs / 1000, "success");
      recordWorkOutcome("probe", "success");
      return "success";
    }
    recordProbe(transport, probeMs / 1000, "failure");
    recordWorkOutcome("probe", "failure");
    return "failure";
  } catch (err) {
    const probeMs = Date.now() - probeStart;
    logger.error({ err, assetId }, "Monitor probe crashed");
    recordProbe(transport, probeMs / 1000, "failure");
    recordWorkOutcome("probe", "crash");
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Telemetry pull (CPU + memory + temperatures) for one asset. Returns
 * `success` on a clean run regardless of whether data was collected —
 * `supported=false` is a normal outcome for ICMP/SSH-monitored assets.
 * `failure` means the transport is supported but the call returned no
 * data (timed-out, rejected, etc.).
 */
export async function runTelemetryFor(assetId: string): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("telemetry");
  try {
    const tr = await collectTelemetry(assetId);
    await recordTelemetryResult(assetId, tr);
    if (tr.supported) {
      if (tr.data) {
        recordWorkOutcome("telemetry", "success");
        return "success";
      }
      recordWorkOutcome("telemetry", "failure");
      return "failure";
    }
    recordWorkOutcome("telemetry", "success");
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "Telemetry collection crashed");
    recordWorkOutcome("telemetry", "crash");
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Full system-info pass (interfaces + storage + IPsec + LLDP) for one
 * asset. Same supported / data / failure semantics as telemetry.
 */
export async function runSystemInfoFor(assetId: string): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("systemInfo");
  try {
    const sr = await collectSystemInfo(assetId);
    await recordSystemInfoResult(assetId, sr);
    if (sr.supported) {
      if (sr.data) {
        recordWorkOutcome("systemInfo", "success");
        return "success";
      }
      recordWorkOutcome("systemInfo", "failure");
      return "failure";
    }
    recordWorkOutcome("systemInfo", "success");
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "System info collection crashed");
    recordWorkOutcome("systemInfo", "crash");
    return "crash";
  } finally {
    stopWork();
  }
}

/**
 * Fast-filtered scrape for the operator-pinned subset (interfaces + storage
 * + IPsec). Same supported / data / failure semantics as systemInfo.
 */
export async function runFastFilteredFor(assetId: string): Promise<CadenceOutcome> {
  const stopWork = startWorkTimer("fastFiltered");
  try {
    const fr = await collectFastFiltered(assetId);
    await recordFastFilteredResult(assetId, fr);
    if (fr.supported) {
      if (fr.data) {
        recordWorkOutcome("fastFiltered", "success");
        return "success";
      }
      recordWorkOutcome("fastFiltered", "failure");
      return "failure";
    }
    recordWorkOutcome("fastFiltered", "success");
    return "success";
  } catch (err) {
    logger.error({ err, assetId }, "Fast-cadence scrape crashed");
    recordWorkOutcome("fastFiltered", "crash");
    return "crash";
  } finally {
    stopWork();
  }
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
      lastTelemetryAt: true, telemetryIntervalSec: true,
      lastSystemInfoAt: true, systemInfoIntervalSec: true,
      probeTimeoutMs: true,
      responseTimePolling: true,
      telemetryPolling:    true,
      interfacesPolling:   true,
      lldpPolling:         true,
      monitoredInterfaces: true,
      monitoredStorage: true,
      monitoredIpsecTunnels: true,
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

  // Map (assetId → resolved transport label) for the per-probe metrics.
  // Pre-3j we labeled by Asset.monitorType; now we use the resolved
  // responseTimePolling, falling back through the hierarchy to the source
  // default. Computed from the candidate row's per-asset polling override
  // first, then the integration-source default — full resolver fidelity
  // would require the class-override + tier-3 lookup but that's overkill
  // for a metric label.
  const transportById = new Map<string, string>();
  for (const a of candidates) {
    let label: string = a.responseTimePolling || "";
    if (!label) {
      const t = a.discoveredByIntegration?.type;
      label = (t === "fortimanager" || t === "fortigate") ? "rest_api" : "icmp";
    }
    transportById.set(a.id, label);
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
    // is detected within one tick.
    const probe      = isDue(a.lastMonitorAt,    eff.intervalSeconds);
    const telemetry  = isDue(a.lastTelemetryAt,  eff.telemetryIntervalSeconds);
    const systemInfo = isDue(a.lastSystemInfoAt, eff.systemInfoIntervalSeconds);
    const hasFastPin =
      (Array.isArray(a.monitoredInterfaces)   && a.monitoredInterfaces.length   > 0) ||
      (Array.isArray(a.monitoredStorage)      && a.monitoredStorage.length      > 0) ||
      (Array.isArray(a.monitoredIpsecTunnels) && a.monitoredIpsecTunnels.length > 0);
    // Heavy-cadence suppression. Telemetry / systemInfo / fastFiltered run
    // ONLY while the asset is confirmed up — every other state (warning /
    // pending / down / unknown) suppresses them. Rationale:
    //   - "down": stale by definition; full SNMP walks just burn worker
    //     time on a host that's about to time out three more times.
    //   - "warning": the asset has missed at least one probe; its data is
    //     in flux. Heavy cadences resume once a full recovery (cs reaches
    //     threshold) flips the asset back to "up".
    //   - "pending": brand-new or recovering; not yet confirmed up.
    //   - "unknown": never been probed; let the response-time probe alone
    //     establish a baseline before scheduling heavy walks.
    // The cheap probe keeps firing in every state so recovery can be
    // detected within one tick of the resolved cadence.
    const isUp = a.monitorStatus === "up";
    if (probe      && enabled.has("probe"))                probes.push({ id: a.id, kind: "probe" });
    if (telemetry  && enabled.has("telemetry")  && isUp)   telemetries.push({ id: a.id, kind: "telemetry" });
    if (systemInfo && enabled.has("systemInfo") && isUp)   systemInfos.push({ id: a.id, kind: "systemInfo" });
    // Fast-cadence pinned scrape rides the response-time cadence (default 60s).
    // Skip it when the full systemInfo pass is also due — they'd hit the same
    // OIDs twice and the full pass already covers the pinned subset. The
    // `systemInfo` boolean here reflects the asset's overall due state, not
    // whether THIS pass is going to handle systemInfo, so the gating works
    // correctly even when light + heavy passes run on different ticking
    // loops: when systemInfo is due, fast-filtered is skipped on this and
    // every following light tick until systemInfo runs successfully and
    // bumps lastSystemInfoAt.
    if (probe && hasFastPin && !systemInfo && isUp && enabled.has("fastFiltered")) {
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
      switch (w.kind) {
        case "probe": {
          const transport = transportById.get(w.id) ?? "unknown";
          const outcome = await runProbeFor(w.id, transport);
          stats.probed++;
          if (outcome === "success") stats.succeeded++; else stats.failed++;
          break;
        }
        case "telemetry": {
          const outcome = await runTelemetryFor(w.id);
          if (outcome === "success") stats.telemetry.collected++;
          else stats.telemetry.failed++;
          break;
        }
        case "systemInfo": {
          const outcome = await runSystemInfoFor(w.id);
          if (outcome === "success") stats.systemInfo.collected++;
          else stats.systemInfo.failed++;
          break;
        }
        case "fastFiltered": {
          const outcome = await runFastFilteredFor(w.id);
          if (outcome === "success") stats.fastFiltered.collected++;
          else stats.fastFiltered.failed++;
          break;
        }
      }
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
// Retention is per-class (default / fortiswitch / fortiap), so each prune
// query runs three buckets: Fortinet switches with the fortiswitch retention,
// Fortinet APs with the fortiap retention, and everything else with the
// top-level retention. Any class with retentionDays <= 0 is skipped (= keep
// forever for that bucket).

async function getFortinetClassAssetIds(): Promise<{ swIds: string[]; apIds: string[] }> {
  const rows = await prisma.asset.findMany({
    where:  { manufacturer: { equals: "Fortinet", mode: "insensitive" }, assetType: { in: ["switch", "access_point"] } },
    select: { id: true, assetType: true },
  });
  const swIds: string[] = [];
  const apIds: string[] = [];
  for (const r of rows) {
    if (r.assetType === "switch")       swIds.push(r.id);
    else if (r.assetType === "access_point") apIds.push(r.id);
  }
  return { swIds, apIds };
}

type SamplePruneFn = (where: Record<string, unknown>) => Promise<{ count: number }>;

async function pruneOneTable(
  fn: SamplePruneFn,
  retentionDays: { default: number; fortiswitch: number; fortiap: number },
  classIds: { swIds: string[]; apIds: string[] },
  hypertableName?: string,
): Promise<number> {
  const nowMs = Date.now();
  const fortinetClassIds = [...classIds.swIds, ...classIds.apIds];

  // Phase 1 (hypertable fast path). When this table is a Timescale hypertable,
  // drop whole chunks older than the LONGEST configured retention. drop_chunks
  // is chunk-granular and constant-time per chunk — no seq-scan, no row lock
  // contention with normal writes — so we use it to peel off everything
  // beyond every class's retention window in O(1). Per-class trimming inside
  // the retention window then runs as a deleteMany on the residue.
  //
  // No-op when the table is plain Postgres (`dropChunks` returns immediately).
  if (hypertableName) {
    const longest = Math.max(retentionDays.default, retentionDays.fortiswitch, retentionDays.fortiap);
    if (longest > 0) {
      await dropChunks(hypertableName, new Date(nowMs - longest * 24 * 3600 * 1000));
    }
  }

  let total = 0;
  // Phase 2 (per-class deleteMany). On hypertables this only touches chunks
  // already inside the retention window — no point hitting the dropped-chunk
  // bytes again. On plain tables this is the only deletion path.
  if (retentionDays.default > 0) {
    const cutoff = new Date(nowMs - retentionDays.default * 24 * 3600 * 1000);
    const where: Record<string, unknown> = { timestamp: { lt: cutoff } };
    if (fortinetClassIds.length > 0) where.assetId = { notIn: fortinetClassIds };
    const { count } = await fn(where);
    total += count;
  }
  if (retentionDays.fortiswitch > 0 && classIds.swIds.length > 0) {
    const cutoff = new Date(nowMs - retentionDays.fortiswitch * 24 * 3600 * 1000);
    const { count } = await fn({ assetId: { in: classIds.swIds }, timestamp: { lt: cutoff } });
    total += count;
  }
  if (retentionDays.fortiap > 0 && classIds.apIds.length > 0) {
    const cutoff = new Date(nowMs - retentionDays.fortiap * 24 * 3600 * 1000);
    const { count } = await fn({ assetId: { in: classIds.apIds }, timestamp: { lt: cutoff } });
    total += count;
  }
  return total;
}

/**
 * Trim AssetMonitorSample rows older than the configured retention window.
 * 0 (or negative) disables retention for that class.
 */
export async function pruneMonitorSamples(): Promise<number> {
  const settings = await getMonitorSettings();
  const ids = await getFortinetClassAssetIds();
  return pruneOneTable(
    (where) => prisma.assetMonitorSample.deleteMany({ where: where as any }),
    {
      default:     settings.sampleRetentionDays,
      fortiswitch: settings.fortiswitch.sampleRetentionDays,
      fortiap:     settings.fortiap.sampleRetentionDays,
    },
    ids,
    "asset_monitor_samples",
  );
}

/**
 * Trim AssetTelemetrySample + AssetTemperatureSample rows older than the
 * telemetry retention window. Temperatures share telemetry's retention because
 * they're collected on the same cadence and we never want one to outlive the
 * other when stitching them onto the same chart.
 */
export async function pruneTelemetrySamples(): Promise<number> {
  const settings = await getMonitorSettings();
  const ids = await getFortinetClassAssetIds();
  const r = {
    default:     settings.telemetryRetentionDays,
    fortiswitch: settings.fortiswitch.telemetryRetentionDays,
    fortiap:     settings.fortiap.telemetryRetentionDays,
  };
  const [tel, temps] = await Promise.all([
    pruneOneTable((where) => prisma.assetTelemetrySample.deleteMany({   where: where as any }), r, ids, "asset_telemetry_samples"),
    pruneOneTable((where) => prisma.assetTemperatureSample.deleteMany({ where: where as any }), r, ids, "asset_temperature_samples"),
  ]);
  return tel + temps;
}

/**
 * Trim AssetInterfaceSample + AssetStorageSample + AssetIpsecTunnelSample +
 * AssetLldpNeighbor rows older than the system info retention window. Returns
 * total rows removed. LLDP shares system-info retention because it's collected
 * on the same cadence; the per-scrape full-replace already drops neighbors
 * that have gone away, so this only catches rows for assets that have stopped
 * scraping entirely (monitor disabled, asset unreachable, etc.). LLDP rows
 * use `lastSeen` rather than `timestamp` so they're pruned by their own helper.
 */
export async function pruneSystemInfoSamples(): Promise<number> {
  const settings = await getMonitorSettings();
  const ids = await getFortinetClassAssetIds();
  const r = {
    default:     settings.systemInfoRetentionDays,
    fortiswitch: settings.fortiswitch.systemInfoRetentionDays,
    fortiap:     settings.fortiap.systemInfoRetentionDays,
  };
  const [ifaces, storage, ipsec, lldp] = await Promise.all([
    pruneOneTable((where) => prisma.assetInterfaceSample.deleteMany({    where: where as any }), r, ids, "asset_interface_samples"),
    pruneOneTable((where) => prisma.assetStorageSample.deleteMany({      where: where as any }), r, ids, "asset_storage_samples"),
    pruneOneTable((where) => prisma.assetIpsecTunnelSample.deleteMany({  where: where as any }), r, ids, "asset_ipsec_tunnel_samples"),
    pruneLldpNeighbors(r, ids),
  ]);
  return ifaces + storage + ipsec + lldp;
}

async function pruneLldpNeighbors(
  retention: { default: number; fortiswitch: number; fortiap: number },
  ids: { swIds: string[]; apIds: string[] },
): Promise<number> {
  const now = Date.now();
  const cutoff = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);
  const [d, fs, fa] = await Promise.all([
    prisma.assetLldpNeighbor.deleteMany({
      where: {
        lastSeen: { lt: cutoff(retention.default) },
        assetId:  { notIn: [...ids.swIds, ...ids.apIds] },
      },
    }),
    ids.swIds.length === 0
      ? Promise.resolve({ count: 0 })
      : prisma.assetLldpNeighbor.deleteMany({
          where: { assetId: { in: ids.swIds }, lastSeen: { lt: cutoff(retention.fortiswitch) } },
        }),
    ids.apIds.length === 0
      ? Promise.resolve({ count: 0 })
      : prisma.assetLldpNeighbor.deleteMany({
          where: { assetId: { in: ids.apIds }, lastSeen: { lt: cutoff(retention.fortiap) } },
        }),
  ]);
  return d.count + fs.count + fa.count;
}
