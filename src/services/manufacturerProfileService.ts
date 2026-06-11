/**
 * src/services/manufacturerProfileService.ts
 *
 * CRUD + cached resolver for the editable `ManufacturerProfile` data model.
 * Replaces the hardcoded VENDOR_TELEMETRY_PROFILES constant at runtime in a
 * follow-up commit; this commit only owns the persistence + read paths.
 *
 * The cache is module-local and refreshed on every write. The hot probe
 * path (Slice 6c) will call `getProfileFor(manufacturer)` which is sync
 * after the boot warm-up — same shape as oidRegistry's API.
 */

import { prisma } from "../db.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import {
  isTransformKind,
  isCombinerKind,
  type TransformKind,
  type CombinerKind,
} from "../utils/symbolTransforms.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export type MetricKey =
  | "cpu"
  | "memory"
  | "temperature"
  | "interfaces"
  | "lldp"
  | "storage"
  | "wirelessStations";

export const METRIC_KEYS: MetricKey[] = [
  "cpu", "memory", "temperature", "interfaces", "lldp", "storage", "wirelessStations",
];

// Allowed display-only standard-MIB hints an operator can pin on a profile
// metric or override. Must stay in sync with the frontend `_SNMP_STANDARD_MIBS`
// table in `public/js/assets.js` (the SNMP Walk dropdown) — the keys are
// shared so the same labels render in both surfaces.
export const STD_MIB_KEYS = new Set<string>([
  "std:system",
  "std:interfaces",
  "std:if-ext",
  "std:host-resources",
  "std:entity",
  "std:entity-sensor",
  "std:lldp",
]);

function asStdMibKeyOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new AppError(400, "MIB std key must be a string");
  }
  if (!STD_MIB_KEYS.has(value)) {
    throw new AppError(400, `Unknown standard MIB key: ${value}`);
  }
  return value;
}

// Metric-row Type values. `scalar` is the original single-OID shape; `table`
// is a single OID returning multiple rows; `double_scalar` is the
// generalized multi-OID shape that replaced the memory-only `composition`
// blob — the resolver fetches `symbol` AND `symbolB` and combines them via
// the `transform` field (which carries a CombinerKind in this case rather
// than the usual unary TransformKind).
export type MetricRowType = "scalar" | "double_scalar" | "table";

export interface MetricOverrideRow {
  id:           string;
  modelPattern: string;
  symbol:       string;
  symbolB:      string | null;
  mibId:        string | null;
  mibStdKey:    string | null;
  type:         MetricRowType;
  transform:    TransformKind | CombinerKind | null;
  order:        number;
}

export interface MetricRow {
  id:               string;
  metricKey:        MetricKey;
  defaultSymbol:    string | null;
  defaultSymbolB:   string | null;
  defaultMibId:     string | null;
  defaultMibStdKey: string | null;
  defaultType:      MetricRowType;
  defaultTransform: TransformKind | CombinerKind | null;
  overrides:        MetricOverrideRow[];
}

export interface CustomWidgetRow {
  id:             string;
  name:           string;
  symbol:         string;
  mibId:          string;
  type:           "scalar" | "table";
  widgetType:     "gauge" | "line" | "table";
  transform:      TransformKind | null;
  displayOptions: Record<string, unknown>;
  order:          number;
  modelPattern:   string | null;
}

export interface ProfileSummary {
  id:                 string;
  manufacturer:       string;
  metricCount:        number;
  overrideCount:      number;
  widgetCount:        number;
  scopedMibCount:     number;
  createdAt:          string;
  updatedAt:          string;
}

export interface ProfileFull {
  id:           string;
  manufacturer: string;
  createdBy:    string | null;
  createdAt:    string;
  updatedAt:    string;
  metrics:      MetricRow[];
  widgets:      CustomWidgetRow[];
}

const profileCache = new Map<string, ProfileFull>();
let cacheLoaded = false;

function asMetricKey(value: unknown): MetricKey {
  if (typeof value !== "string" || !(METRIC_KEYS as string[]).includes(value)) {
    throw new AppError(400, "Invalid metricKey");
  }
  return value as MetricKey;
}

function asMetricRowType(value: unknown): MetricRowType {
  if (value === "scalar" || value === "double_scalar" || value === "table") return value;
  throw new AppError(400, "Invalid type — expected 'scalar' | 'double_scalar' | 'table'");
}

// Custom widgets still only support scalar/table — double_scalar applies to
// metric rows where the resolver knows how to combine the two readings; the
// widget renderer doesn't.
function asWidgetType(value: unknown): "gauge" | "line" | "table" {
  if (value === "gauge" || value === "line" || value === "table") return value;
  throw new AppError(400, "Invalid widgetType — expected gauge | line | table");
}

function asWidgetSymbolType(value: unknown): "scalar" | "table" {
  if (value === "scalar" || value === "table") return value;
  throw new AppError(400, "Invalid widget symbol type — expected 'scalar' or 'table'");
}

// For scalar / table types `transform` is a unary TransformKind (or null).
// For double_scalar `transform` is a binary CombinerKind. The validator is
// type-aware so a typo (combiner on a scalar row, transform on a double row)
// errors at write time instead of silently being persisted.
function asTransformForType(value: unknown, type: MetricRowType): TransformKind | CombinerKind | null {
  if (value === null || value === undefined || value === "") {
    // double_scalar requires a combiner to be useful, but we accept null at
    // write time so the operator can save a partially-configured row and
    // come back to it. The resolver treats double_scalar with no combiner
    // as a no-op.
    return null;
  }
  if (type === "double_scalar") {
    if (isCombinerKind(value)) return value;
    throw new AppError(400, `Invalid combiner for double_scalar type: ${String(value)}`);
  }
  // scalar / table
  if (isTransformKind(value)) return value;
  throw new AppError(400, `Invalid transform: ${String(value)}`);
}

// Reads a stored transform from the DB without knowing the row's type — used
// only in the shapeProfile path. Tries both registries; returns null if the
// value matches neither. The DB always stores values written through
// asTransformForType, so this only sees legitimate values.
function readStoredTransform(value: unknown): TransformKind | CombinerKind | null {
  if (value === null || value === undefined || value === "") return null;
  if (isTransformKind(value)) return value;
  if (isCombinerKind(value)) return value;
  return null;
}

// modelPattern is an operator-authored regex by design (matched against
// device model strings). Validate it compiles and cap its length so a
// pathological pattern can't be stored — the 2026-06-11 CodeQL sweep
// dismissed the js/regex-injection alerts on these sites as intended
// behavior (admin-gated feature) with this cap as hardening.
function assertValidModelPattern(pattern: string): void {
  if (pattern.length > 512) {
    throw new AppError(400, "modelPattern is too long (max 512 characters)");
  }
  try {
    new RegExp(pattern);
  } catch {
    throw new AppError(400, "modelPattern must be a valid regex");
  }
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

// Validate that the per-row shape is internally consistent:
//   scalar:        symbol required, symbolB must be null
//   double_scalar: symbol + symbolB both required
//   table:         symbol required, symbolB must be null, transform must be null
// Caller passes the EFFECTIVE values (after merging input with the stored
// row for update paths) so partial updates that leave a row invalid are
// rejected before the DB write lands.
//
// Empty-row exception: a metric row with symbol+symbolB+transform all null
// is the legitimate "use built-in seed for this metric" state. It passes
// validation regardless of type (which defaults to "scalar"). Override
// rows always require a symbol because their whole purpose is to override
// the parent metric row's defaults.
function validateMetricRowShape(args: {
  type:      MetricRowType;
  symbol:    string | null;
  symbolB:   string | null;
  transform: TransformKind | CombinerKind | null;
  // "metric" or "override" — used in error messages AND to gate the
  // empty-row exception (only metric rows can be unconfigured).
  label:     "metric" | "override";
}): void {
  const { type, symbol, symbolB, transform, label } = args;
  if (label === "metric" && !symbol && !symbolB && !transform) {
    return; // unconfigured metric row = "use built-in seed"
  }
  if (type === "table") {
    if (!symbol) throw new AppError(400, `${label}: symbol is required`);
    if (symbolB) throw new AppError(400, `${label}: symbolB must be null on type="table"`);
    if (transform) throw new AppError(400, `${label}: transform must be null on type="table"`);
    return;
  }
  if (type === "scalar") {
    if (!symbol) throw new AppError(400, `${label}: symbol is required`);
    if (symbolB) throw new AppError(400, `${label}: symbolB must be null on type="scalar"`);
    return;
  }
  // double_scalar
  if (!symbol)  throw new AppError(400, `${label}: symbol (A) is required for type="double_scalar"`);
  if (!symbolB) throw new AppError(400, `${label}: symbolB (B) is required for type="double_scalar"`);
}

function shapeProfile(row: any): ProfileFull {
  const metrics: MetricRow[] = (row.metrics || []).map((m: any) => ({
    id:               m.id,
    metricKey:        asMetricKey(m.metricKey),
    defaultSymbol:    m.defaultSymbol ?? null,
    defaultSymbolB:   m.defaultSymbolB ?? null,
    defaultMibId:     m.defaultMibId ?? null,
    defaultMibStdKey: m.defaultMibStdKey ?? null,
    defaultType:      asMetricRowType(m.defaultType),
    defaultTransform: readStoredTransform(m.defaultTransform),
    overrides: (m.overrides || []).map((o: any) => ({
      id:           o.id,
      modelPattern: o.modelPattern,
      symbol:       o.symbol,
      symbolB:      o.symbolB ?? null,
      mibId:        o.mibId ?? null,
      mibStdKey:    o.mibStdKey ?? null,
      type:         asMetricRowType(o.type),
      transform:    readStoredTransform(o.transform),
      order:        o.order,
    })),
  }));
  const widgets: CustomWidgetRow[] = (row.widgets || []).map((w: any) => ({
    id:             w.id,
    name:           w.name,
    symbol:         w.symbol,
    mibId:          w.mibId,
    type:           asWidgetSymbolType(w.type),
    widgetType:     asWidgetType(w.widgetType),
    transform:      w.transform && isTransformKind(w.transform) ? (w.transform as TransformKind) : null,
    displayOptions: (w.displayOptions ?? {}) as Record<string, unknown>,
    order:          w.order,
    modelPattern:   w.modelPattern ?? null,
  }));
  return {
    id:           row.id,
    manufacturer: row.manufacturer,
    createdBy:    row.createdBy ?? null,
    createdAt:    row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt:    row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    metrics,
    widgets,
  };
}

export async function refreshProfileCache(): Promise<void> {
  const rows = await (prisma as any).manufacturerProfile.findMany({
    include: {
      metrics: { include: { overrides: { orderBy: { order: "asc" } } } },
      widgets: { orderBy: { order: "asc" } },
    },
  });
  profileCache.clear();
  for (const row of rows) {
    const shaped = shapeProfile(row);
    profileCache.set(shaped.manufacturer.toLowerCase(), shaped);
  }
  cacheLoaded = true;
}

/**
 * Sync getter for the hot probe path. Returns null when the cache hasn't
 * loaded yet OR no profile exists for the given manufacturer. The Slice 6c
 * resolver swap will call this; for now it's exposed for future use and
 * unit-test convenience.
 */
export function getProfileFor(manufacturer: string | null | undefined): ProfileFull | null {
  if (!cacheLoaded || !manufacturer) return null;
  const canonical = normalizeManufacturer(manufacturer);
  if (!canonical) return null;
  return profileCache.get(canonical.toLowerCase()) ?? null;
}

export async function listProfiles(): Promise<ProfileSummary[]> {
  const rows = await (prisma as any).manufacturerProfile.findMany({
    include: {
      metrics: { include: { overrides: true } },
      widgets: true,
    },
    orderBy: { manufacturer: "asc" },
  });
  // Scoped MIB counts — joined separately so the count matches the
  // operator's mental model: "MIBs uploaded under this manufacturer."
  const mibCounts = new Map<string, number>();
  for (const row of rows) {
    const cnt = await (prisma as any).mibFile.count({ where: { manufacturer: row.manufacturer } });
    mibCounts.set(row.id, cnt);
  }
  return rows.map((row: any): ProfileSummary => {
    const overrideCount = (row.metrics || []).reduce(
      (acc: number, m: any) => acc + ((m.overrides || []).length || 0),
      0,
    );
    return {
      id:             row.id,
      manufacturer:   row.manufacturer,
      metricCount:    row.metrics?.length ?? 0,
      overrideCount,
      widgetCount:    row.widgets?.length ?? 0,
      scopedMibCount: mibCounts.get(row.id) ?? 0,
      createdAt:      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt:      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    };
  });
}

export async function getProfile(id: string): Promise<ProfileFull | null> {
  const row = await (prisma as any).manufacturerProfile.findUnique({
    where: { id },
    include: {
      metrics: { include: { overrides: { orderBy: { order: "asc" } } } },
      widgets: { orderBy: { order: "asc" } },
    },
  });
  return row ? shapeProfile(row) : null;
}

export async function createProfile(input: {
  manufacturer: string;
  createdBy?:   string | null;
}): Promise<ProfileFull> {
  const canonical = normalizeManufacturer(input.manufacturer);
  if (!canonical) throw new AppError(400, "Manufacturer is required");

  // Pre-populate one empty metric row per metric key so the operator's
  // first encounter with the modal shows the full canvas. defaultSymbol
  // null = "use built-in seed for this metric" — i.e. no change yet.
  const id = (await import("crypto")).randomUUID();
  await prisma.$transaction([
    (prisma as any).manufacturerProfile.create({
      data: {
        id,
        manufacturer: canonical,
        createdBy:    input.createdBy ?? null,
      },
    }),
    ...METRIC_KEYS.map((mk) =>
      (prisma as any).manufacturerProfileMetric.create({
        data: {
          profileId:   id,
          metricKey:   mk,
          defaultType: "scalar",
        },
      }),
    ),
  ]).catch((err: any) => {
    if (err && err.code === "P2002") {
      throw new AppError(409, `A profile for "${canonical}" already exists`);
    }
    throw err;
  });

  await refreshProfileCache();
  const created = await getProfile(id);
  if (!created) throw new AppError(500, "Profile creation failed");
  return created;
}

export async function updateMetricRow(
  profileId: string,
  metricKey: string,
  input: {
    defaultSymbol?:    string | null;
    defaultSymbolB?:   string | null;
    defaultMibId?:     string | null;
    defaultMibStdKey?: string | null;
    defaultType?:      string;
    defaultTransform?: string | null;
  },
): Promise<MetricRow> {
  const mk = asMetricKey(metricKey);
  const row = await (prisma as any).manufacturerProfileMetric.findUnique({
    where: { profileId_metricKey: { profileId, metricKey: mk } },
  });
  if (!row) throw new AppError(404, "Metric row not found for this profile");

  // Mutual exclusion: a metric row points at AT MOST one MIB source —
  // either an uploaded MibFile (defaultMibId) or a built-in standard MIB
  // hint (defaultMibStdKey). The UI surfaces both via a single dropdown so
  // selecting one clears the other; reject on the wire if a caller sends
  // both as non-null in the same request.
  const nextMibId  = input.defaultMibId     === undefined ? row.defaultMibId     : (input.defaultMibId  ?? null);
  const nextStdKey = input.defaultMibStdKey === undefined
    ? row.defaultMibStdKey
    : asStdMibKeyOrNull(input.defaultMibStdKey);
  if (nextMibId && nextStdKey) {
    throw new AppError(400, "defaultMibId and defaultMibStdKey are mutually exclusive");
  }

  // Resolve effective values (merge input with existing row) so the shape
  // validator sees the post-write state and can reject invalid combos
  // (e.g. flipping to double_scalar without supplying symbolB).
  const nextType      = input.defaultType      === undefined ? asMetricRowType(row.defaultType) : asMetricRowType(input.defaultType);
  const nextSymbol    = input.defaultSymbol    === undefined ? (row.defaultSymbol ?? null)      : trimOrNull(input.defaultSymbol);
  const nextSymbolB   = input.defaultSymbolB   === undefined ? (row.defaultSymbolB ?? null)     : trimOrNull(input.defaultSymbolB);
  const nextTransform = input.defaultTransform === undefined
    ? readStoredTransform(row.defaultTransform)
    : asTransformForType(input.defaultTransform, nextType);

  validateMetricRowShape({
    type:      nextType,
    symbol:    nextSymbol,
    symbolB:   nextSymbolB,
    transform: nextTransform,
    label:     "metric",
  });

  const updated = await (prisma as any).manufacturerProfileMetric.update({
    where: { id: row.id },
    data: {
      defaultSymbol:    input.defaultSymbol    === undefined ? undefined : (nextSymbol ?? null),
      // When type is not double_scalar, force symbolB null at write time
      // so accidental leftovers from an earlier double_scalar config don't
      // get re-promoted later.
      defaultSymbolB:   nextType === "double_scalar" ? (nextSymbolB ?? null) : null,
      defaultMibId:     input.defaultMibId     === undefined ? undefined : (input.defaultMibId ?? null),
      defaultMibStdKey: input.defaultMibStdKey === undefined ? undefined : nextStdKey,
      defaultType:      input.defaultType      === undefined ? undefined : nextType,
      defaultTransform: input.defaultTransform === undefined ? undefined : (nextTransform ?? null),
    },
    include: { overrides: { orderBy: { order: "asc" } } },
  });
  await touchProfile(profileId);
  await refreshProfileCache();
  return {
    id:               updated.id,
    metricKey:        mk,
    defaultSymbol:    updated.defaultSymbol ?? null,
    defaultSymbolB:   updated.defaultSymbolB ?? null,
    defaultMibId:     updated.defaultMibId ?? null,
    defaultMibStdKey: updated.defaultMibStdKey ?? null,
    defaultType:      asMetricRowType(updated.defaultType),
    defaultTransform: readStoredTransform(updated.defaultTransform),
    overrides: (updated.overrides || []).map((o: any) => ({
      id:           o.id,
      modelPattern: o.modelPattern,
      symbol:       o.symbol,
      symbolB:      o.symbolB ?? null,
      mibId:        o.mibId ?? null,
      mibStdKey:    o.mibStdKey ?? null,
      type:         asMetricRowType(o.type),
      transform:    readStoredTransform(o.transform),
      order:        o.order,
    })),
  };
}

export async function createOverride(
  profileId: string,
  metricKey: string,
  input: {
    modelPattern: string;
    symbol?:      string;
    symbolB?:     string | null;
    mibId?:       string | null;
    mibStdKey?:   string | null;
    type?:        string;
    transform?:   string | null;
    order?:       number;
  },
): Promise<MetricOverrideRow> {
  const mk = asMetricKey(metricKey);
  const row = await (prisma as any).manufacturerProfileMetric.findUnique({
    where: { profileId_metricKey: { profileId, metricKey: mk } },
  });
  if (!row) throw new AppError(404, "Metric row not found for this profile");
  if (!input.modelPattern || !input.modelPattern.trim()) {
    throw new AppError(400, "modelPattern is required");
  }
  assertValidModelPattern(input.modelPattern);
  const stdKey = asStdMibKeyOrNull(input.mibStdKey ?? null);
  if (input.mibId && stdKey) {
    throw new AppError(400, "mibId and mibStdKey are mutually exclusive");
  }

  const type      = asMetricRowType(input.type ?? "scalar");
  const symbol    = trimOrNull(input.symbol);
  const symbolB   = trimOrNull(input.symbolB);
  const transform = asTransformForType(input.transform ?? null, type);
  validateMetricRowShape({ type, symbol, symbolB, transform, label: "override" });

  const created = await (prisma as any).manufacturerProfileMetricOverride.create({
    data: {
      metricRowId:  row.id,
      modelPattern: input.modelPattern,
      symbol:       symbol ?? "",
      symbolB:      type === "double_scalar" ? (symbolB ?? null) : null,
      mibId:        input.mibId ?? null,
      mibStdKey:    stdKey,
      type,
      transform:    transform ?? null,
      order:        Number.isFinite(input.order) ? Number(input.order) : 0,
    },
  });
  await touchProfile(profileId);
  await refreshProfileCache();
  return {
    id:           created.id,
    modelPattern: created.modelPattern,
    symbol:       created.symbol,
    symbolB:      created.symbolB ?? null,
    mibId:        created.mibId ?? null,
    mibStdKey:    created.mibStdKey ?? null,
    type:         asMetricRowType(created.type),
    transform:    readStoredTransform(created.transform),
    order:        created.order,
  };
}

export async function updateOverride(
  overrideId: string,
  input: {
    modelPattern?: string;
    symbol?:       string;
    symbolB?:      string | null;
    mibId?:        string | null;
    mibStdKey?:    string | null;
    type?:         string;
    transform?:    string | null;
    order?:        number;
  },
): Promise<MetricOverrideRow> {
  const existing = await (prisma as any).manufacturerProfileMetricOverride.findUnique({
    where: { id: overrideId },
    include: { metricRow: true },
  });
  if (!existing) throw new AppError(404, "Override not found");

  // Mutual exclusion: an override row points at AT MOST one MIB source.
  const nextMibId  = input.mibId     === undefined ? existing.mibId     : (input.mibId  ?? null);
  const nextStdKey = input.mibStdKey === undefined
    ? existing.mibStdKey
    : asStdMibKeyOrNull(input.mibStdKey);
  if (nextMibId && nextStdKey) {
    throw new AppError(400, "mibId and mibStdKey are mutually exclusive");
  }
  if (input.modelPattern !== undefined) {
    if (!input.modelPattern.trim()) throw new AppError(400, "modelPattern is required");
    assertValidModelPattern(input.modelPattern);
  }

  const nextType      = input.type      === undefined ? asMetricRowType(existing.type) : asMetricRowType(input.type);
  const nextSymbol    = input.symbol    === undefined ? (existing.symbol ?? null)     : trimOrNull(input.symbol);
  const nextSymbolB   = input.symbolB   === undefined ? (existing.symbolB ?? null)    : trimOrNull(input.symbolB);
  const nextTransform = input.transform === undefined
    ? readStoredTransform(existing.transform)
    : asTransformForType(input.transform, nextType);

  validateMetricRowShape({
    type:      nextType,
    symbol:    nextSymbol,
    symbolB:   nextSymbolB,
    transform: nextTransform,
    label:     "override",
  });

  const updated = await (prisma as any).manufacturerProfileMetricOverride.update({
    where: { id: overrideId },
    data: {
      modelPattern: input.modelPattern === undefined ? undefined : input.modelPattern,
      symbol:       input.symbol       === undefined ? undefined : (nextSymbol ?? ""),
      symbolB:      nextType === "double_scalar" ? (nextSymbolB ?? null) : null,
      mibId:        input.mibId        === undefined ? undefined : (input.mibId ?? null),
      mibStdKey:    input.mibStdKey    === undefined ? undefined : nextStdKey,
      type:         input.type         === undefined ? undefined : nextType,
      transform:    input.transform    === undefined ? undefined : (nextTransform ?? null),
      order:        input.order        === undefined ? undefined : Number(input.order),
    },
  });
  await touchProfile(existing.metricRow.profileId);
  await refreshProfileCache();
  return {
    id:           updated.id,
    modelPattern: updated.modelPattern,
    symbol:       updated.symbol,
    symbolB:      updated.symbolB ?? null,
    mibId:        updated.mibId ?? null,
    mibStdKey:    updated.mibStdKey ?? null,
    type:         asMetricRowType(updated.type),
    transform:    readStoredTransform(updated.transform),
    order:        updated.order,
  };
}

export async function deleteOverride(overrideId: string): Promise<void> {
  const existing = await (prisma as any).manufacturerProfileMetricOverride.findUnique({
    where: { id: overrideId },
    include: { metricRow: true },
  });
  if (!existing) return;
  await (prisma as any).manufacturerProfileMetricOverride.delete({ where: { id: overrideId } });
  await touchProfile(existing.metricRow.profileId);
  await refreshProfileCache();
}

export async function createWidget(
  profileId: string,
  input: {
    name:           string;
    symbol:         string;
    mibId:          string;
    type?:          string;
    widgetType:     string;
    transform?:     string | null;
    displayOptions?: Record<string, unknown>;
    order?:         number;
    modelPattern?:  string | null;
    createdBy?:     string | null;
  },
): Promise<CustomWidgetRow> {
  if (!input.name || !input.name.trim()) throw new AppError(400, "Widget name is required");
  if (!input.symbol || !input.symbol.trim()) throw new AppError(400, "symbol is required");
  if (!input.mibId) throw new AppError(400, "mibId is required for custom widgets");
  if (input.modelPattern) {
    assertValidModelPattern(input.modelPattern);
  }
  const created = await (prisma as any).manufacturerCustomWidget.create({
    data: {
      profileId,
      name:           input.name.trim(),
      symbol:         input.symbol.trim(),
      mibId:          input.mibId,
      type:           asWidgetSymbolType(input.type ?? "scalar"),
      widgetType:     asWidgetType(input.widgetType),
      transform:      asTransformForType(input.transform ?? null, "scalar") as TransformKind | null,
      displayOptions: input.displayOptions ?? {},
      order:          Number.isFinite(input.order) ? Number(input.order) : 0,
      modelPattern:   input.modelPattern ?? null,
      createdBy:      input.createdBy ?? null,
    },
  });
  await touchProfile(profileId);
  await refreshProfileCache();
  return shapeWidget(created);
}

export async function updateWidget(
  widgetId: string,
  input: {
    name?:          string;
    symbol?:        string;
    mibId?:         string;
    type?:          string;
    widgetType?:    string;
    transform?:     string | null;
    displayOptions?: Record<string, unknown>;
    order?:         number;
    modelPattern?:  string | null;
  },
): Promise<CustomWidgetRow> {
  const existing = await (prisma as any).manufacturerCustomWidget.findUnique({ where: { id: widgetId } });
  if (!existing) throw new AppError(404, "Widget not found");
  if (input.modelPattern) {
    assertValidModelPattern(input.modelPattern);
  }
  const updated = await (prisma as any).manufacturerCustomWidget.update({
    where: { id: widgetId },
    data: {
      name:           input.name === undefined           ? undefined : input.name.trim(),
      symbol:         input.symbol === undefined         ? undefined : input.symbol.trim(),
      mibId:          input.mibId === undefined          ? undefined : input.mibId,
      type:           input.type === undefined           ? undefined : asWidgetSymbolType(input.type),
      widgetType:     input.widgetType === undefined     ? undefined : asWidgetType(input.widgetType),
      transform:      input.transform === undefined      ? undefined : (asTransformForType(input.transform, "scalar") as TransformKind | null ?? null),
      displayOptions: input.displayOptions === undefined ? undefined : (input.displayOptions ?? {}),
      order:          input.order === undefined          ? undefined : Number(input.order),
      modelPattern:   input.modelPattern === undefined   ? undefined : (input.modelPattern ?? null),
    },
  });
  await touchProfile(existing.profileId);
  await refreshProfileCache();
  return shapeWidget(updated);
}

export async function deleteWidget(widgetId: string): Promise<void> {
  const existing = await (prisma as any).manufacturerCustomWidget.findUnique({ where: { id: widgetId } });
  if (!existing) return;
  await (prisma as any).manufacturerCustomWidget.delete({ where: { id: widgetId } });
  await touchProfile(existing.profileId);
  await refreshProfileCache();
}

export async function deleteProfile(profileId: string): Promise<void> {
  // No usage-count refusal here yet — the resolver swap (Slice 6c) is the
  // commit that introduces dependency. Today deleting a profile is purely
  // additive removal since monitoring still consults the hardcoded constant.
  await (prisma as any).manufacturerProfile.delete({ where: { id: profileId } });
  await refreshProfileCache();
}

function shapeWidget(w: any): CustomWidgetRow {
  return {
    id:             w.id,
    name:           w.name,
    symbol:         w.symbol,
    mibId:          w.mibId,
    type:           asWidgetSymbolType(w.type),
    widgetType:     asWidgetType(w.widgetType),
    transform:      w.transform && isTransformKind(w.transform) ? (w.transform as TransformKind) : null,
    displayOptions: (w.displayOptions ?? {}) as Record<string, unknown>,
    order:          w.order,
    modelPattern:   w.modelPattern ?? null,
  };
}

async function touchProfile(profileId: string): Promise<void> {
  try {
    await (prisma as any).manufacturerProfile.update({
      where: { id: profileId },
      data:  { updatedAt: new Date() },
    });
  } catch (err) {
    logger.debug({ err, profileId }, "Failed to bump manufacturer profile updatedAt");
  }
}
