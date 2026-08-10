/**
 * src/services/notificationDimensionService.ts
 *
 * "What do THESE devices actually report?" for the automation builder's
 * dimensionFilter inputs (sensor class, interface, mount path, SD-WAN
 * health-check / member, IPsec tunnel).
 *
 * Why this exists: those inputs used to be free text, so an operator typed
 * "Temperature" (or "temp", or a sensor NAME) into a field the server validates
 * as the strict enum `temperature|fan|voltage|power|disk|other` — the save 400s,
 * or worse, a pattern field silently matches nothing and the automation never
 * fires. The picker reads back the values the DRAFT'S OWN device scope has
 * reported recently, so the offered options are always both spelled right and
 * present on the selected devices; an empty result is itself the answer ("these
 * devices report no hardware sensors").
 *
 * Scope resolution is `loadScopeAssetIds` from the engine — the same
 * loadScopeAssets the evaluation tick uses, so the picker can't offer a value
 * from a device the automation wouldn't evaluate.
 *
 * Scale (100 vs 2000 assets): this is an INTERACTIVE call on a hypertable, so
 * both axes are bounded — a short lookback window (`RECENT_WINDOW_HOURS`) and a
 * cap on how many scoped assets are queried (`ASSET_SAMPLE_CAP`), since the
 * default scope is "all assets". Every query is a Postgres-side GROUP BY over
 * `(value, assetId)` on an `(assetId, …, timestamp)` index — aggregate output
 * only, never per-sample rows. `sampledAssets` < `scopedAssets` tells the caller
 * the list came from a subset so it can say so.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { METRIC_DIMENSIONS, type RuleScope } from "./notificationTypes.js";
import { loadScopeAssetIds } from "./notificationEngine.js";

/** Lookback for "currently reported". Long enough to catch any realistic
 *  telemetry cadence (minutes; an hourly cadence still lands ≥3 samples),
 *  short enough that the scan stays interactive. */
const RECENT_WINDOW_HOURS = 3;
/** Widened retry used ONLY when the recent window found nothing at all, so the
 *  "these devices report no sensors" message can't be a cadence artifact. Paired
 *  with a tighter asset cap to keep the worst case bounded. */
const FALLBACK_WINDOW_HOURS = 48;
const FALLBACK_ASSET_CAP = 100;
/** Assets queried per call. The default scope is every asset, and the answer
 *  ("which classes exist here") saturates long before 250 devices. */
const ASSET_SAMPLE_CAP = 250;
/** Cap on distinct values returned — an interface list on a big switch stack is
 *  long, and the control is a picker, not an inventory. */
const MAX_VALUES = 300;

/** One reported value + how many of the sampled devices report it. */
export interface DimensionValueOption {
  value: string;
  assetCount: number;
}

export interface DimensionValuesResult {
  metric: string;
  dimension: string;
  /** True when the server validates this dimension as a closed enum, so the UI
   *  must offer a select rather than a free-text box with suggestions. */
  strict: boolean;
  /** What this dimension names, for the empty-state sentence ("no hardware
   *  sensors"). */
  noun: string;
  /** Tail describing the sibling narrowing applied (" of class temperature"),
   *  "" when none — so "reported no hardware sensors" can't be read as "none at
   *  all" when it really means "none of that class". */
  narrowLabel: string;
  values: DimensionValueOption[];
  /** Devices the draft's scope resolves to (before the sample cap). */
  scopedAssets: number;
  /** Devices actually queried — less than scopedAssets when the cap applied. */
  sampledAssets: number;
  /** Of the sampled devices, how many reported ANY value for this dimension.
   *  0 with scopedAssets > 0 is the "selected devices report none of these" case. */
  assetsWithData: number;
  windowHours: number;
}

type ValuePair = { value: string | null; assetId: string };

/**
 * Sibling dimension values already chosen on the same condition row, used to
 * narrow the list. A firewall reports temperature, fan AND voltage sensors, so
 * once the operator picks class=temperature the sensor-NAME list must not offer
 * "FAN1" — picking it would build a filter that matches nothing.
 */
export interface DimensionNarrow {
  sensorClass?: string;
  healthCheck?: string;
}

interface DimensionSource {
  /** Plural noun for operator-facing messaging. */
  noun: string;
  /** Closed value set (select-only) vs a substring/pattern field (suggestions). */
  strict: boolean;
  pairs: (ids: string[], since: Date, narrow: DimensionNarrow) => Promise<ValuePair[]>;
  /** Human tail describing the narrowing that was applied ("of class temperature"),
   *  so the empty-state message says WHICH slice came back empty. */
  narrowLabel?: (narrow: DimensionNarrow) => string;
}

/**
 * Per-dimension value source. Keys MUST match the dimensionFilter field names in
 * notificationTypes (METRIC_DIMENSIONS lists which apply per metric).
 *
 * `strict` mirrors the dimensionFilter Zod schema: sensorClass is the only
 * closed enum there — the rest are matched with `substringMatch`, so an operator
 * may legitimately type a partial ("port", "/var") and the picker only suggests.
 * Keep the two in lockstep: making a dimension an enum server-side without
 * flipping this leaves the UI offering a box that now rejects free text.
 *
 * `widgetId` is deliberately absent: its values are opaque registry UUIDs, not
 * something an operator recognizes in a list, and it stays a plain input.
 */
const DIMENSION_SOURCES: Record<string, DimensionSource> = {
  sensorClass: {
    noun: "hardware sensors",
    strict: true,
    pairs: async (ids, since) =>
      (await prisma.assetHardwareSensorSample.groupBy({
        by: ["sensorClass", "assetId"],
        where: { assetId: { in: ids }, timestamp: { gte: since } },
      })).map((r) => ({ value: r.sensorClass, assetId: r.assetId })),
  },
  // Individual named sensors ("CPU ON-DIE Temperature"), narrowed to the class
  // the row already filters on so a temperature condition isn't offered fan names.
  sensorNamePattern: {
    noun: "hardware sensors",
    strict: false,
    narrowLabel: (n) => (n.sensorClass ? ` of class ${n.sensorClass}` : ""),
    pairs: async (ids, since, narrow) =>
      (await prisma.assetHardwareSensorSample.groupBy({
        by: ["sensorName", "assetId"],
        where: {
          assetId: { in: ids },
          timestamp: { gte: since },
          ...(narrow.sensorClass ? { sensorClass: narrow.sensorClass } : {}),
        },
      })).map((r) => ({ value: r.sensorName, assetId: r.assetId })),
  },
  ifNamePattern: {
    noun: "interfaces",
    strict: false,
    pairs: async (ids, since) =>
      (await prisma.assetInterfaceSample.groupBy({
        by: ["ifName", "assetId"],
        where: { assetId: { in: ids }, timestamp: { gte: since } },
      })).map((r) => ({ value: r.ifName, assetId: r.assetId })),
  },
  mountPathPattern: {
    noun: "storage mounts",
    strict: false,
    pairs: async (ids, since) =>
      (await prisma.assetStorageSample.groupBy({
        by: ["mountPath", "assetId"],
        where: { assetId: { in: ids }, timestamp: { gte: since } },
      })).map((r) => ({ value: r.mountPath, assetId: r.assetId })),
  },
  healthCheck: {
    noun: "SD-WAN health checks",
    strict: false,
    pairs: async (ids, since) =>
      (await prisma.assetPerfSlaSample.groupBy({
        by: ["healthCheck", "assetId"],
        where: { assetId: { in: ids }, timestamp: { gte: since } },
      })).map((r) => ({ value: r.healthCheck, assetId: r.assetId })),
  },
  link: {
    noun: "SD-WAN WAN members",
    strict: false,
    narrowLabel: (n) => (n.healthCheck ? ` for health check ${n.healthCheck}` : ""),
    pairs: async (ids, since, narrow) =>
      (await prisma.assetPerfSlaSample.groupBy({
        by: ["link", "assetId"],
        where: {
          assetId: { in: ids },
          timestamp: { gte: since },
          // substringMatch semantics, mirroring how the engine filters it.
          ...(narrow.healthCheck ? { healthCheck: { contains: narrow.healthCheck, mode: "insensitive" as const } } : {}),
        },
      })).map((r) => ({ value: r.link, assetId: r.assetId })),
  },
  tunnelName: {
    noun: "IPsec tunnels",
    strict: false,
    pairs: async (ids, since) =>
      (await prisma.assetIpsecTunnelSample.groupBy({
        by: ["tunnelName", "assetId"],
        where: { assetId: { in: ids }, timestamp: { gte: since } },
      })).map((r) => ({ value: r.tunnelName, assetId: r.assetId })),
  },
};

/** Dimensions this service can populate — the wizard reads it off /schema so it
 *  knows which inputs become pickers without hardcoding the list. */
export function dimensionPickerMeta(): Record<string, { strict: boolean; noun: string }> {
  const out: Record<string, { strict: boolean; noun: string }> = {};
  for (const [dim, src] of Object.entries(DIMENSION_SOURCES)) {
    out[dim] = { strict: src.strict, noun: src.noun };
  }
  return out;
}

/** Fold (value, assetId) pairs into per-value device counts, most-reported
 *  first then alphabetical. Pure — unit-tested. */
export function foldValuePairs(pairs: ValuePair[]): { values: DimensionValueOption[]; assetsWithData: number } {
  const byValue = new Map<string, Set<string>>();
  const assets = new Set<string>();
  for (const p of pairs) {
    if (p.value == null || p.value === "") continue;
    assets.add(p.assetId);
    let set = byValue.get(p.value);
    if (!set) { set = new Set(); byValue.set(p.value, set); }
    set.add(p.assetId);
  }
  const values = Array.from(byValue, ([value, set]) => ({ value, assetCount: set.size }))
    .sort((a, b) => b.assetCount - a.assetCount || a.value.localeCompare(b.value))
    .slice(0, MAX_VALUES);
  return { values, assetsWithData: assets.size };
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3600_000);
}

/**
 * Values the draft's scoped devices have reported for one metric dimension.
 * Throws 400 when the dimension isn't one this metric takes (so a stale client
 * can't quietly get an empty list that reads as "no sensors").
 */
export async function listDimensionValues(
  metric: string,
  dimension: string,
  scope: RuleScope,
  narrow: DimensionNarrow = {},
): Promise<DimensionValuesResult> {
  const applicable = METRIC_DIMENSIONS[metric];
  if (!applicable?.includes(dimension)) {
    throw new AppError(400, `"${dimension}" is not a dimension of metric "${metric}"`);
  }
  const source = DIMENSION_SOURCES[dimension];
  if (!source) throw new AppError(400, `No value source for dimension "${dimension}"`);

  const scopedIds = await loadScopeAssetIds(scope);
  // Deterministic subset so repeated opens of the picker agree with each other.
  const sorted = [...scopedIds].sort();
  const base = {
    metric,
    dimension,
    strict: source.strict,
    noun: source.noun,
    narrowLabel: source.narrowLabel?.(narrow) || "",
    scopedAssets: scopedIds.length,
  };
  if (sorted.length === 0) {
    return { ...base, values: [], sampledAssets: 0, assetsWithData: 0, windowHours: RECENT_WINDOW_HOURS };
  }

  const ids = sorted.slice(0, ASSET_SAMPLE_CAP);
  const recent = foldValuePairs(await source.pairs(ids, hoursAgo(RECENT_WINDOW_HOURS), narrow));
  if (recent.values.length > 0) {
    return { ...base, ...recent, sampledAssets: ids.length, windowHours: RECENT_WINDOW_HOURS };
  }

  // Nothing in the recent window: widen once before telling the operator these
  // devices have none, so a slow cadence or a paused poller doesn't read as
  // "unsupported hardware".
  const fallbackIds = ids.slice(0, FALLBACK_ASSET_CAP);
  const older = foldValuePairs(await source.pairs(fallbackIds, hoursAgo(FALLBACK_WINDOW_HOURS), narrow));
  return {
    ...base,
    ...older,
    sampledAssets: fallbackIds.length,
    windowHours: FALLBACK_WINDOW_HOURS,
  };
}
