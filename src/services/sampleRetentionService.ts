/**
 * src/services/sampleRetentionService.ts
 *
 * Global sample-retention policy, edited from the Server Settings → Retention
 * card and stored in `Setting("sampleRetention")`.
 *
 * Why global: retention is a storage concern, not a per-device concern —
 * operators tune it because disk fills up, which is a fleet-wide question. The
 * tiered model (detail / hourly / daily) is uniform across the fleet so the
 * rollup writer produces one set of *_hourly / *_daily rows every consumer reads.
 *
 * Axis: per-ENTITY, not per-asset-class. The volume driver is the kind of thing
 * being sampled (interfaces, with per-port cardinality, dwarf per-asset data),
 * not whether the asset is a switch vs an AP. The configurable entities are:
 *
 *   assets       — asset_monitor_samples        (per-asset response-time probe)
 *   cpuMem       — asset_telemetry_samples       (per-asset CPU / memory)
 *   temperature  — asset_temperature_samples     (per-asset sensor)
 *   interfaces   — asset_interface_samples        (per-interface)
 *   storage      — asset_storage_samples          (per-volume)
 *   ipsec        — asset_ipsec_tunnel_samples     (per-tunnel)
 *
 * Selection split: for interfaces / storage / ipsec the configured retention
 * applies to OPERATOR-SELECTED (monitored) entities only — their samples are
 * stamped `cadence="fast"` and kept at full retention with rollups. UNSELECTED
 * (bulk) samples (`cadence="slow"` / legacy NULL) are kept for a FIXED
 * `UNSELECTED_DETAIL_HOURS` and never rolled up; that 24h is a property of being
 * unselected, not a configurable cell. assets / cpuMem / temperature have no
 * selection concept — their retention applies to every row.
 *
 * Encoding (per tier): positive = N days; 0 = tier OFF (pruned away — do not
 * keep this tier); FOREVER (-1) = keep forever. NOTE: this flips the legacy
 * meaning of 0 (which meant "keep forever"); the one-shot migration translates
 * legacy 0 → FOREVER. See migrateSampleRetentionToEntities.
 *
 * Defaults: 7 days detail / 30 days hourly / 365 days daily, uniform across
 * entities. Operators tune from the Retention card.
 *
 * In-process cache with a 5-second TTL: prune reads this once per nightly tick,
 * but chart history endpoints resolve retention on every request, so the cache
 * avoids a DB roundtrip per chart open. Invalidated on every write.
 */

import { prisma } from "../db.js";

export const SETTING_KEY = "sampleRetention";

/** Sentinel: keep this tier forever (never prune). */
export const FOREVER = -1;

/** Fixed retention for UNSELECTED (bulk) interface / storage / ipsec samples.
 *  Not operator-configurable — a property of being unselected. No rollup. */
export const UNSELECTED_DETAIL_HOURS = 24;

export type RetentionEntity =
  | "assets"
  | "cpuMem"
  | "temperature"
  | "interfaces"
  | "storage"
  | "ipsec";
export type RetentionTier = "detail" | "hourly" | "daily";

export const RETENTION_ENTITIES: RetentionEntity[] = [
  "assets",
  "cpuMem",
  "temperature",
  "interfaces",
  "storage",
  "ipsec",
];

/** Entities whose configured retention applies to SELECTED rows only
 *  (unselected rows are fixed at UNSELECTED_DETAIL_HOURS, no rollup). */
export const SELECTION_AWARE_ENTITIES: RetentionEntity[] = ["interfaces", "storage", "ipsec"];

export interface TierRetention {
  detail: number;
  hourly: number;
  daily: number;
}

export type SampleRetention = Record<RetentionEntity, TierRetention>;

// SolarWinds-style defaults. Operators tune from the Retention card.
const DEFAULT_DETAIL_DAYS = 7;
const DEFAULT_HOURLY_DAYS = 30;
const DEFAULT_DAILY_DAYS = 365;

function defaultTier(): TierRetention {
  return { detail: DEFAULT_DETAIL_DAYS, hourly: DEFAULT_HOURLY_DAYS, daily: DEFAULT_DAILY_DAYS };
}

export function defaultSampleRetention(): SampleRetention {
  return {
    assets:      defaultTier(),
    cpuMem:      defaultTier(),
    temperature: defaultTier(),
    interfaces:  defaultTier(),
    storage:     defaultTier(),
    ipsec:       defaultTier(),
  };
}

// In-process cache. Short TTL so an admin PUT is visible to chart queries
// within a few seconds, but a hot path (every chart request) doesn't hit the DB.
const CACHE_TTL_MS = 5000;
let cache: { value: SampleRetention; fetchedAt: number } | null = null;

export function invalidateSampleRetentionCache(): void {
  cache = null;
}

/** Accept positive (N days), 0 (tier off), or FOREVER (-1). Anything else
 *  (NaN, < -1) falls back. */
function toRetentionDays(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < FOREVER) return fallback;
  return Math.trunc(n);
}

function parseTier(raw: unknown, fallback: TierRetention): TierRetention {
  if (raw == null || typeof raw !== "object") return { ...fallback };
  const r = raw as Record<string, unknown>;
  return {
    detail: toRetentionDays(r.detail, fallback.detail),
    hourly: toRetentionDays(r.hourly, fallback.hourly),
    daily:  toRetentionDays(r.daily,  fallback.daily),
  };
}

function parseSampleRetention(raw: unknown): SampleRetention {
  const fallback = defaultSampleRetention();
  if (raw == null || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  const out = {} as SampleRetention;
  for (const e of RETENTION_ENTITIES) out[e] = parseTier(r[e], fallback[e]);
  return out;
}

export async function getSampleRetention(): Promise<SampleRetention> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const value = parseSampleRetention(row?.value);
  cache = { value, fetchedAt: now };
  return value;
}

function mergeTier(current: TierRetention, input: unknown): TierRetention {
  if (input == null || typeof input !== "object") return { ...current };
  const i = input as Record<string, unknown>;
  return {
    detail: i.detail == null ? current.detail : toRetentionDays(i.detail, current.detail),
    hourly: i.hourly == null ? current.hourly : toRetentionDays(i.hourly, current.hourly),
    daily:  i.daily  == null ? current.daily  : toRetentionDays(i.daily,  current.daily),
  };
}

function mergeRetention(
  current: SampleRetention,
  input: Partial<SampleRetention> | Record<string, unknown>,
): SampleRetention {
  const i = input as Record<string, unknown>;
  const out = {} as SampleRetention;
  for (const e of RETENTION_ENTITIES) out[e] = i[e] == null ? { ...current[e] } : mergeTier(current[e], i[e]);
  return out;
}

/**
 * Replace the stored retention. Missing fields inherit from the current stored
 * value (partial PUT merges cleanly). Each numeric is validated to a day count,
 * 0 (off), or FOREVER (-1); out-of-range / non-numeric values keep the existing
 * stored value.
 */
export async function updateSampleRetention(
  input: Partial<SampleRetention> | Record<string, unknown>,
): Promise<SampleRetention> {
  const current = await getSampleRetention();
  const merged = mergeRetention(current, input);
  await prisma.setting.upsert({
    where:  { key: SETTING_KEY },
    update: { value: merged as any },
    create: { key: SETTING_KEY, value: merged as any },
  });
  invalidateSampleRetentionCache();
  return merged;
}

/** Retention days for one (entity, tier). Returns 0 (tier off) or FOREVER (-1)
 *  as stored. */
export function getRetentionDays(
  retention: SampleRetention,
  entity: RetentionEntity,
  tier: RetentionTier,
): number {
  return retention[entity][tier];
}
