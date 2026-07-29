/**
 * src/services/appMapDiscoveryService.ts
 *
 * "Discovery" for the Application Map: named MAP RULES that pin process programs
 * and service units onto the assets an operator chose — the ones that exist now
 * and the ones discovered later.
 *
 * Why rules rather than a bulk action: pinning is per-asset (Asset.mappedProcesses
 * / Asset.mappedServices, one Services-tab checkbox at a time), so "map nginx on
 * the truckscale hosts" was N clicks that a newly-built host silently missed. A
 * rule is stored once and re-applied by the reconcileAppMapAutoMap job, so a host
 * that installs an agent tomorrow picks up the same pins.
 *
 * Why MANY rules rather than one selection: a single fleet-wide selection could
 * only express "every asset that reports this program", which over-pins — an
 * operator who wants truckscale.service mapped on the three truckscale hosts does
 * not want it on every host that happens to run it. Each rule carries its own
 * asset scope, so the same unit can be mapped in one part of the fleet and left
 * alone in another. (The pre-rules single-selection shape folds forward into one
 * rule at read time — see normalizeConfig.)
 *
 * Structure is modeled on autoMonitorStorageService (aggregate → preview →
 * additive apply), with the periodic-reconciler entry point borrowed from
 * tagAssignmentService/reconcileTagAssignments. Two deliberate differences:
 *
 *   - Scope is per-rule asset CRITERIA, not per-integration. These pins are
 *     agent-fed, and an agent host's discovering integration says nothing about
 *     whether its nginx belongs on the map. The criteria vocabulary is
 *     tagAssignmentService's rather than a second one.
 *
 *   - Apply is STRICTLY ADDITIVE and never strips. `mappedProcesses` /
 *     `mappedServices` are operator-owned — someone may have pinned a program by
 *     hand on one host — so removing an item from a rule (or disabling the rule)
 *     stops FUTURE auto-pinning rather than retroactively unpinning.
 *     `unmapEverywhere` is the explicit, separately-invoked strip.
 *
 * Scale: the aggregates are bounded GROUP BY queries regardless of fleet size.
 * Never load per-asset AssetProcess rows to count them in memory — at 2000 hosts
 * that is ~400k rows on a modal open. Apply resolves each rule's scope once, then
 * loads the inventory for the UNION of in-scope assets a single time and evaluates
 * every rule against it in memory.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { compilePattern } from "./autoMonitorInterfacesService.js";
import {
  normalizeCriteria,
  resolveMatchingAssetIds,
  type TagCriteria,
} from "./tagAssignmentService.js";

export const SETTING_KEY = "appMapAutoMap";

/** Cap on rows returned per aggregate — a busy fleet has a long tail of
 *  one-host-only programs and the modal is a picker, not a report. */
const AGGREGATE_LIMIT = 2000;
/** Same per-array ceiling the assets PUT enforces on the pin fields. */
const MAX_SELECTION_ENTRIES = 64;
/** Enough for real fleet segmentation without turning the list into a page. */
const MAX_RULES = 50;
const MAX_NAME_LEN = 64;
const BATCH_SIZE = 50;

// ─── Rule shape ─────────────────────────────────────────────────────────────

export interface AutoMapNameBlock {
  /** Explicit names/units ticked in the wizard. */
  names: string[];
  /** Wildcard (or regex, per `regex`) patterns. */
  patterns: string[];
  regex: boolean;
}

export interface AppMapRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Asset criteria. null = every monitored asset. */
  scope: TagCriteria | null;
  processes: AutoMapNameBlock;
  services: AutoMapNameBlock;
}

export interface AppMapAutoMapConfig {
  version: 2;
  rules: AppMapRule[];
}

function emptyBlock(): AutoMapNameBlock {
  return { names: [], patterns: [], regex: false };
}

export function emptyConfig(): AppMapAutoMapConfig {
  return { version: 2, rules: [] };
}

/** True when a rule would pin nothing (no items selected). A scope alone pins
 *  nothing — it only narrows what the item lists apply to. */
export function isRuleEmpty(r: AppMapRule): boolean {
  const dead = (b: AutoMapNameBlock) => b.names.length === 0 && b.patterns.length === 0;
  return dead(r.processes) && dead(r.services);
}

function blockHasItems(b: AutoMapNameBlock): boolean {
  return b.names.length > 0 || b.patterns.length > 0;
}

// ─── Validation / normalization ─────────────────────────────────────────────

function normalizeStrings(raw: unknown, label: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new AppError(400, `${label} must be an array of strings`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") throw new AppError(400, `${label} must be an array of strings`);
    const t = v.trim();
    if (!t) continue;
    // Case-insensitive dedup, but the FIRST spelling is what we keep: pins are
    // matched against inventory case-sensitively, so we must not fold case.
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  if (out.length > MAX_SELECTION_ENTRIES) {
    throw new AppError(400, `${label} may not exceed ${MAX_SELECTION_ENTRIES} entries`);
  }
  return out;
}

function normalizeBlock(raw: unknown, label: string): AutoMapNameBlock {
  if (raw == null) return emptyBlock();
  if (typeof raw !== "object") throw new AppError(400, `${label} must be an object`);
  const r = raw as Record<string, unknown>;
  const regex = r.regex === true;
  const patterns = normalizeStrings(r.patterns, `${label}.patterns`);
  // Compile up front so a bad pattern is a 400 on save rather than a silent
  // no-match on every reconcile tick.
  for (const p of patterns) compilePattern(p, regex);
  return { names: normalizeStrings(r.names, `${label}.names`), patterns, regex };
}

/** Validate + normalize one posted rule. Throws AppError(400) on bad input. */
export function normalizeRule(raw: unknown): AppMapRule {
  if (raw == null || typeof raw !== "object") throw new AppError(400, "Rule must be an object");
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) throw new AppError(400, "Rule name is required");
  if (name.length > MAX_NAME_LEN) throw new AppError(400, `Rule name may not exceed ${MAX_NAME_LEN} characters`);
  return {
    id: typeof r.id === "string" && r.id.trim() ? r.id.trim() : randomUUID(),
    name,
    enabled: r.enabled !== false,
    // normalizeCriteria returns null when there are no usable rules, which is
    // exactly "no scope" — an empty tree must not mean "match nothing".
    scope: r.scope == null ? null : normalizeCriteria(r.scope),
    processes: normalizeBlock(r.processes, "processes"),
    services:  normalizeBlock(r.services,  "services"),
  };
}

/**
 * Validate + normalize a whole rule set. Also folds the PRE-RULES single
 * selection shape (`{version:1, processes, services, scope}`) forward into one
 * rule so an install that configured the old modal doesn't silently lose its
 * pins — done here at read time rather than in a migration job, same trick as
 * the flat retention default.
 */
export function normalizeConfig(raw: unknown): AppMapAutoMapConfig {
  if (raw == null) return emptyConfig();
  if (typeof raw !== "object") throw new AppError(400, "Config must be an object");
  const r = raw as Record<string, unknown>;

  if (!Array.isArray(r.rules) && (r.processes != null || r.services != null)) {
    const folded = normalizeRule({
      name: "Imported selection",
      enabled: true,
      scope: r.scope ?? null,
      processes: r.processes,
      services: r.services,
    });
    return { version: 2, rules: isRuleEmpty(folded) ? [] : [folded] };
  }

  const rulesIn = Array.isArray(r.rules) ? r.rules : [];
  if (rulesIn.length > MAX_RULES) throw new AppError(400, `At most ${MAX_RULES} rules are supported`);
  const rules = rulesIn.map(normalizeRule);

  // Names are how operators refer to these in conversation and in Events, so
  // keep them unambiguous. Ids must be unique too or edits would fan out.
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const rule of rules) {
    const key = rule.name.toLowerCase();
    if (names.has(key)) throw new AppError(409, `Duplicate rule name "${rule.name}"`);
    names.add(key);
    if (ids.has(rule.id)) throw new AppError(400, "Duplicate rule id");
    ids.add(rule.id);
  }
  return { version: 2, rules };
}

// ─── Persistence ────────────────────────────────────────────────────────────

export async function getConfig(): Promise<AppMapAutoMapConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row?.value) return emptyConfig();
  try {
    return normalizeConfig(row.value);
  } catch {
    // A stored blob that no longer validates (hand-edited, or written by a newer
    // version) must not brick the modal — fall back to "no rules".
    return emptyConfig();
  }
}

export async function saveConfig(cfg: AppMapAutoMapConfig): Promise<void> {
  await prisma.setting.upsert({
    where:  { key: SETTING_KEY },
    update: { value: cfg as any },
    create: { key: SETTING_KEY, value: cfg as any },
  });
}

// ─── Pure resolver ──────────────────────────────────────────────────────────

/**
 * Which of `available` names one block selects. Pure: no DB, no I/O. UNION of the
 * explicit names and the patterns; an empty block selects nothing. The caller
 * unions the result with the asset's existing pins.
 */
export function resolveBlockPins(block: AutoMapNameBlock, available: string[]): string[] {
  if (!block || available.length === 0) return [];
  if (block.names.length === 0 && block.patterns.length === 0) return [];
  const picked = new Set<string>();

  if (block.names.length > 0) {
    const want = new Set(block.names);
    for (const n of available) if (want.has(n)) picked.add(n);
  }
  if (block.patterns.length > 0) {
    const regexes = block.patterns.map((p) => compilePattern(p, block.regex));
    for (const n of available) if (regexes.some((rx) => rx.test(n))) picked.add(n);
  }
  return [...picked];
}

// ─── Aggregates (power the wizard's item picker) ─────────────────────────────

export interface AggregateRow {
  /** Program name (processes) or unit name (services). */
  name: string;
  /** Distinct in-scope monitored hosts reporting it. */
  deviceCount: number;
  /** Distinct hosts that already carry it as a map pin (fleet-wide). */
  mappedCount: number;
  /** systemd / windows — services only. */
  platform?: string | null;
  displayName?: string | null;
}

type CountRow = { name: string; count: number };

/** Hosts already pinning each name, from the pin arrays themselves. Fleet-wide
 *  on purpose: it answers "is this already on the map anywhere", which is what
 *  makes the Unmap-everywhere affordance meaningful. */
async function pinnedCounts(column: "mappedProcesses" | "mappedServices"): Promise<Map<string, number>> {
  // unnest + GROUP BY keeps this one bounded round-trip instead of reading every
  // asset's array into memory.
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(
    `SELECT x."name" AS "name", COUNT(*)::int AS "count"
       FROM "assets" a, unnest(a."${column}") AS x("name")
      WHERE a."monitored" = true
      GROUP BY 1`,
  );
  return new Map(rows.map((r) => [r.name, Number(r.count)]));
}

/**
 * Asset ids a scope selects, or null for "no scope" (caller skips the filter).
 * Always intersected with monitored=true, matching the Application Map's own
 * filter — pinning a host the map won't render is wasted work.
 */
async function scopedAssetIds(scope: TagCriteria | null): Promise<Set<string> | null> {
  if (!scope) return null;
  return resolveMatchingAssetIds(scope);
}

/**
 * Aggregate the programs / units reported by the assets a scope selects. The
 * wizard calls this with the scope from its asset-selection step, so the item
 * picker lists what THOSE hosts actually run instead of the whole fleet's
 * inventory — that's the granularity the flat fleet-wide picker couldn't express.
 */
export async function getInventoryAggregate(
  scope: TagCriteria | null,
): Promise<{ processes: AggregateRow[]; services: AggregateRow[] }> {
  const allowed = await scopedAssetIds(scope);
  if (allowed && allowed.size === 0) return { processes: [], services: [] };
  const ids = allowed ? [...allowed] : null;

  const [procRows, svcRows, procPinned, svcPinned] = await Promise.all([
    ids
      ? prisma.$queryRaw<CountRow[]>`
          SELECT p."name" AS "name", COUNT(DISTINCT p."assetId")::int AS "count"
            FROM "asset_processes" p
            JOIN "assets" a ON a."id" = p."assetId"
           WHERE a."monitored" = true AND p."assetId" = ANY(${ids}::text[])
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${AGGREGATE_LIMIT}`
      : prisma.$queryRaw<CountRow[]>`
          SELECT p."name" AS "name", COUNT(DISTINCT p."assetId")::int AS "count"
            FROM "asset_processes" p
            JOIN "assets" a ON a."id" = p."assetId"
           WHERE a."monitored" = true
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${AGGREGATE_LIMIT}`,
    ids
      ? prisma.$queryRaw<Array<CountRow & { platform: string | null; displayName: string | null }>>`
          SELECT s."unit" AS "name", COUNT(DISTINCT s."assetId")::int AS "count",
                 MIN(s."platform") AS "platform", MIN(s."displayName") AS "displayName"
            FROM "asset_services" s
            JOIN "assets" a ON a."id" = s."assetId"
           WHERE a."monitored" = true AND s."assetId" = ANY(${ids}::text[])
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${AGGREGATE_LIMIT}`
      : prisma.$queryRaw<Array<CountRow & { platform: string | null; displayName: string | null }>>`
          SELECT s."unit" AS "name", COUNT(DISTINCT s."assetId")::int AS "count",
                 MIN(s."platform") AS "platform", MIN(s."displayName") AS "displayName"
            FROM "asset_services" s
            JOIN "assets" a ON a."id" = s."assetId"
           WHERE a."monitored" = true
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${AGGREGATE_LIMIT}`,
    pinnedCounts("mappedProcesses"),
    pinnedCounts("mappedServices"),
  ]);

  return {
    processes: procRows.map((r) => ({
      name: r.name, deviceCount: Number(r.count), mappedCount: procPinned.get(r.name) ?? 0,
    })),
    services: svcRows.map((r) => ({
      name: r.name, deviceCount: Number(r.count), mappedCount: svcPinned.get(r.name) ?? 0,
      platform: r.platform, displayName: r.displayName,
    })),
  };
}

// ─── Candidate assets + their reported inventory ────────────────────────────

interface CandidateAsset {
  id: string;
  hostname: string | null;
  mappedProcesses: string[];
  mappedServices: string[];
}

/** Every monitored asset, once. Rule scopes are applied in memory against this
 *  so a 10-rule config doesn't re-query the asset table 10 times. */
async function loadMonitoredAssets(): Promise<CandidateAsset[]> {
  return prisma.asset.findMany({
    where: { monitored: true },
    select: { id: true, hostname: true, mappedProcesses: true, mappedServices: true },
  });
}

/** assetId → reported names, for whichever inventories the rules need. */
async function loadInventories(
  assetIds: string[],
  needProcesses: boolean,
  needServices: boolean,
): Promise<{ processes: Map<string, string[]>; services: Map<string, string[]> }> {
  const processes = new Map<string, string[]>();
  const services = new Map<string, string[]>();
  if (assetIds.length === 0) return { processes, services };

  const push = (m: Map<string, string[]>, key: string, v: string) => {
    const cur = m.get(key);
    if (cur) cur.push(v);
    else m.set(key, [v]);
  };

  await Promise.all([
    needProcesses
      ? prisma.assetProcess
          .findMany({ where: { assetId: { in: assetIds } }, select: { assetId: true, name: true } })
          .then((rows) => { for (const r of rows) push(processes, r.assetId, r.name); })
      : Promise.resolve(),
    needServices
      ? prisma.assetService
          .findMany({ where: { assetId: { in: assetIds } }, select: { assetId: true, unit: true } })
          .then((rows) => { for (const r of rows) push(services, r.assetId, r.unit); })
      : Promise.resolve(),
  ]);
  return { processes, services };
}

interface PendingUpdate {
  assetId: string;
  hostname: string | null;
  freshProcesses: string[];
  freshServices: string[];
  nextProcesses: string[];
  nextServices: string[];
}

/**
 * Everything a rule set WOULD add, computed in memory. Shared by preview and
 * apply so the two can never disagree.
 *
 * One asset can be matched by several rules; the pins union per asset, which is
 * why this can't just loop rules independently.
 */
async function computePending(rules: AppMapRule[]): Promise<PendingUpdate[]> {
  const live = rules.filter((r) => r.enabled && !isRuleEmpty(r));
  if (live.length === 0) return [];

  const assets = await loadMonitoredAssets();
  if (assets.length === 0) return [];
  const byId = new Map(assets.map((a) => [a.id, a]));

  // Resolve each distinct scope once.
  const scopeSets = await Promise.all(live.map((r) => scopedAssetIds(r.scope)));

  // Which assets any rule touches, and what each needs loaded.
  const touched = new Set<string>();
  let needProcesses = false;
  let needServices = false;
  live.forEach((rule, i) => {
    const allowed = scopeSets[i];
    if (blockHasItems(rule.processes)) needProcesses = true;
    if (blockHasItems(rule.services)) needServices = true;
    for (const a of assets) {
      if (allowed && !allowed.has(a.id)) continue;
      touched.add(a.id);
    }
  });
  if (touched.size === 0) return [];

  const inv = await loadInventories([...touched], needProcesses, needServices);

  // Union the pins each rule contributes, per asset.
  const wantProc = new Map<string, Set<string>>();
  const wantSvc = new Map<string, Set<string>>();
  const addAll = (m: Map<string, Set<string>>, id: string, vals: string[]) => {
    if (vals.length === 0) return;
    let s = m.get(id);
    if (!s) { s = new Set(); m.set(id, s); }
    for (const v of vals) s.add(v);
  };
  live.forEach((rule, i) => {
    const allowed = scopeSets[i];
    for (const a of assets) {
      if (allowed && !allowed.has(a.id)) continue;
      if (blockHasItems(rule.processes)) {
        addAll(wantProc, a.id, resolveBlockPins(rule.processes, inv.processes.get(a.id) ?? []));
      }
      if (blockHasItems(rule.services)) {
        addAll(wantSvc, a.id, resolveBlockPins(rule.services, inv.services.get(a.id) ?? []));
      }
    }
  });

  const pending: PendingUpdate[] = [];
  for (const id of touched) {
    const a = byId.get(id);
    if (!a) continue;
    const haveProc = new Set(a.mappedProcesses);
    const haveSvc = new Set(a.mappedServices);
    const freshProcesses = [...(wantProc.get(id) ?? [])].filter((n) => !haveProc.has(n));
    const freshServices  = [...(wantSvc.get(id)  ?? [])].filter((n) => !haveSvc.has(n));
    if (freshProcesses.length === 0 && freshServices.length === 0) continue;
    pending.push({
      assetId: a.id,
      hostname: a.hostname,
      freshProcesses,
      freshServices,
      nextProcesses: [...a.mappedProcesses, ...freshProcesses],
      nextServices:  [...a.mappedServices,  ...freshServices],
    });
  }
  return pending;
}

// ─── Preview (writes nothing) ───────────────────────────────────────────────

export interface AutoMapPreview {
  deviceCount: number;
  processPins: number;
  servicePins: number;
  sampleDevices: Array<{ assetId: string; hostname: string | null; processes: string[]; services: string[] }>;
}

function summarize(pending: PendingUpdate[]): AutoMapPreview {
  return {
    deviceCount: pending.length,
    processPins: pending.reduce((n, p) => n + p.freshProcesses.length, 0),
    servicePins: pending.reduce((n, p) => n + p.freshServices.length, 0),
    sampleDevices: pending.slice(0, 10).map((p) => ({
      assetId: p.assetId,
      hostname: p.hostname,
      processes: p.freshProcesses,
      services: p.freshServices,
    })),
  };
}

/** What ONE rule would add right now (the wizard's review step). */
export async function previewRule(rule: AppMapRule): Promise<AutoMapPreview> {
  return summarize(await computePending([rule]));
}

/**
 * Assets a scope selects, for the wizard's asset-selection step. Reports the
 * count plus a sample so the operator can see they picked the hosts they meant.
 */
export interface ScopePreview {
  total: number;
  assets: Array<{ id: string; hostname: string | null; ipAddress: string | null; assetType: string | null }>;
}

export async function previewScope(scope: TagCriteria | null): Promise<ScopePreview> {
  const allowed = await scopedAssetIds(scope);
  const rows = await prisma.asset.findMany({
    where: {
      monitored: true,
      ...(allowed ? { id: { in: [...allowed] } } : {}),
    },
    select: { id: true, hostname: true, ipAddress: true, assetType: true },
    orderBy: [{ hostname: "asc" }],
  });
  return { total: rows.length, assets: rows.slice(0, 100) };
}

// ─── Apply (additive) ───────────────────────────────────────────────────────

export interface AutoMapApplyResult {
  devices: number;
  processPins: number;
  servicePins: number;
  sampleDevices: Array<{ assetId: string; hostname: string | null; processes: string[]; services: string[] }>;
}

/**
 * Pin everything the enabled rules resolve to. Strictly additive — pins are the
 * union of existing and computed, and an asset with nothing fresh is skipped
 * entirely so a back-to-back reconcile is silent. Chunked Promise.allSettled so a
 * 2000-host fleet doesn't serialize a thousand updates behind the request (or the
 * job tick). Idempotent: a half-landed batch yields the same final set on re-run.
 */
export async function applyRules(rules: AppMapRule[]): Promise<AutoMapApplyResult> {
  const empty: AutoMapApplyResult = { devices: 0, processPins: 0, servicePins: 0, sampleDevices: [] };
  const pending = await computePending(rules);
  if (pending.length === 0) return empty;

  let devices = 0;
  let processPins = 0;
  let servicePins = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      chunk.map((p) =>
        prisma.asset.update({
          where: { id: p.assetId },
          data: {
            ...(p.freshProcesses.length ? { mappedProcesses: p.nextProcesses } : {}),
            ...(p.freshServices.length  ? { mappedServices:  p.nextServices  } : {}),
          },
        }),
      ),
    );
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      const p = chunk[k];
      if (!r || !p || r.status !== "fulfilled") continue;
      devices += 1;
      processPins += p.freshProcesses.length;
      servicePins += p.freshServices.length;
    }
  }

  return { ...summarize(pending), devices, processPins, servicePins };
}

// ─── Explicit un-map (the only subtractive path) ────────────────────────────

export interface UnmapResult {
  devices: number;
  connectionRowsDeleted: number;
}

/**
 * Remove one name from every asset's map pins and delete its connection rows —
 * the same cleanup the per-asset PUT does when a pin is un-ticked, applied fleet-
 * wide. Separate from apply on purpose: additive apply can never un-map, so
 * "actually take this off the map everywhere" has to be its own deliberate action.
 *
 * Also drops the name from EVERY rule, otherwise the next reconcile would put it
 * straight back.
 */
export async function unmapEverywhere(kind: "process" | "service", name: string): Promise<UnmapResult> {
  const target = String(name ?? "").trim();
  if (!target) throw new AppError(400, "Name is required");
  const isProc = kind === "process";
  const column = isProc ? "mappedProcesses" : "mappedServices";

  const assets = await prisma.asset.findMany({
    where: { [column]: { has: target } } as any,
    select: { id: true, mappedProcesses: true, mappedServices: true },
  });

  let devices = 0;
  let connectionRowsDeleted = 0;
  for (let i = 0; i < assets.length; i += BATCH_SIZE) {
    const chunk = assets.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(chunk.map(async (a) => {
      const next = (isProc ? a.mappedProcesses : a.mappedServices).filter((n) => n !== target);
      await prisma.asset.update({
        where: { id: a.id },
        data: isProc ? { mappedProcesses: next } : { mappedServices: next },
      });
      const { count } = await prisma.assetProcessConnection.deleteMany({
        where: isProc ? { assetId: a.id, processName: target } : { assetId: a.id, unit: target },
      });
      return count;
    }));
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      devices += 1;
      connectionRowsDeleted += r.value;
    }
  }

  // Stop the reconciler from re-pinning what was just removed.
  const cfg = await getConfig();
  let changed = false;
  for (const rule of cfg.rules) {
    const block = isProc ? rule.processes : rule.services;
    const before = block.names.length;
    block.names = block.names.filter((n) => n !== target);
    if (block.names.length !== before) changed = true;
  }
  if (changed) await saveConfig(cfg);

  return { devices, connectionRowsDeleted };
}

// ─── Reconcile entry point (periodic job + inline on save) ──────────────────

export interface AutoMapReconcileSummary extends Record<string, unknown> {
  devices: number;
  processPins: number;
  servicePins: number;
}

/** Re-apply every enabled rule. The "future assets" mechanism: a host that
 *  installs an agent and reports its inventory picks up its pins on the next
 *  tick. No-op (and silent) when nothing is configured or nothing is missing. */
export async function reconcileAutoMap(): Promise<AutoMapReconcileSummary> {
  const cfg = await getConfig();
  const r = await applyRules(cfg.rules);
  return { devices: r.devices, processPins: r.processPins, servicePins: r.servicePins };
}
