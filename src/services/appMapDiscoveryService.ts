/**
 * src/services/appMapDiscoveryService.ts
 *
 * "Discovery" for the Application Map: an aggregated, fleet-wide view of every
 * process program and service unit the agents have reported, plus a persistent
 * SELECTION that pins the operator's picks onto matching assets — the ones that
 * exist now and the ones discovered later.
 *
 * Why a rule rather than a bulk action: pinning is per-asset (Asset.mappedProcesses
 * / Asset.mappedServices, one Services-tab checkbox at a time), so "map nginx
 * everywhere" was previously N clicks that a newly-built host silently missed.
 * The selection is stored once and re-applied by the reconcileAppMapAutoMap job,
 * so a host that installs an agent tomorrow picks up the same pins.
 *
 * Structure is modeled on autoMonitorStorageService (aggregate → preview →
 * additive apply), with the periodic-reconciler entry point borrowed from
 * tagAssignmentService/reconcileTagAssignments. Two deliberate differences:
 *
 *   - Scope is FLEET-WIDE, not per-integration. These pins are agent-fed, and an
 *     agent host's discovering integration is irrelevant to whether its nginx
 *     should be on the map. An optional `scope` narrows by asset criteria,
 *     reusing the tagAssignmentService vocabulary rather than a second one.
 *
 *   - Apply is STRICTLY ADDITIVE and never strips. `mappedProcesses` /
 *     `mappedServices` are operator-owned — someone may have pinned a program by
 *     hand on one host — so un-ticking a row in the modal stops FUTURE
 *     auto-pinning rather than retroactively unpinning. `unmapEverywhere` is the
 *     explicit, separately-invoked strip for "actually take this off the map".
 *
 * Scale: the aggregates are four bounded GROUP BY queries regardless of fleet
 * size. Never load per-asset AssetProcess rows to count them in memory — at 2000
 * hosts that is ~400k rows on a modal open.
 */

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
const BATCH_SIZE = 50;

// ─── Selection shape ────────────────────────────────────────────────────────

export interface AutoMapNameBlock {
  /** Explicit names/units ticked in the modal. */
  names: string[];
  /** Wildcard (or regex, per `regex`) patterns. */
  patterns: string[];
  regex: boolean;
}

export interface AppMapAutoMapSelection {
  version: 1;
  processes: AutoMapNameBlock;
  services: AutoMapNameBlock;
  /** Optional asset filter. Absent/null = every monitored host. */
  scope: TagCriteria | null;
}

function emptyBlock(): AutoMapNameBlock {
  return { names: [], patterns: [], regex: false };
}

export function emptySelection(): AppMapAutoMapSelection {
  return { version: 1, processes: emptyBlock(), services: emptyBlock(), scope: null };
}

/** True when the selection would pin nothing at all (so callers can skip work). */
export function isSelectionEmpty(s: AppMapAutoMapSelection): boolean {
  const dead = (b: AutoMapNameBlock) => b.names.length === 0 && b.patterns.length === 0;
  return dead(s.processes) && dead(s.services);
}

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

/** Validate + normalize a posted selection. Throws AppError(400) on bad input. */
export function normalizeSelection(raw: unknown): AppMapAutoMapSelection {
  if (raw == null) return emptySelection();
  if (typeof raw !== "object") throw new AppError(400, "Selection must be an object");
  const r = raw as Record<string, unknown>;
  return {
    version: 1,
    processes: normalizeBlock(r.processes, "processes"),
    services:  normalizeBlock(r.services,  "services"),
    // normalizeCriteria returns null when there are no usable rules, which is
    // exactly "no scope" — an empty tree must not mean "match nothing".
    scope: r.scope == null ? null : normalizeCriteria(r.scope),
  };
}

// ─── Persistence ────────────────────────────────────────────────────────────

export async function getSelection(): Promise<AppMapAutoMapSelection> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row?.value) return emptySelection();
  try {
    return normalizeSelection(row.value);
  } catch {
    // A stored blob that no longer validates (hand-edited, or written by a newer
    // version) must not brick the modal — fall back to "nothing selected".
    return emptySelection();
  }
}

export async function saveSelection(selection: AppMapAutoMapSelection): Promise<void> {
  await prisma.setting.upsert({
    where:  { key: SETTING_KEY },
    update: { value: selection as any },
    create: { key: SETTING_KEY, value: selection as any },
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
    for (const n of available) if (regexes.some((r) => r.test(n))) picked.add(n);
  }
  return [...picked];
}

// ─── Aggregates (power the modal's picker) ──────────────────────────────────

export interface AggregateRow {
  /** Program name (processes) or unit name (services). */
  name: string;
  /** Distinct monitored hosts reporting it. */
  deviceCount: number;
  /** Distinct hosts that already carry it as a map pin. */
  mappedCount: number;
  /** systemd / windows — services only. */
  platform?: string | null;
  displayName?: string | null;
}

type CountRow = { name: string; count: number };

/** Hosts already pinning each name, from the pin arrays themselves. */
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

export async function getFleetProcessAggregate(): Promise<AggregateRow[]> {
  const [rows, pinned] = await Promise.all([
    prisma.$queryRaw<CountRow[]>`
      SELECT p."name" AS "name", COUNT(DISTINCT p."assetId")::int AS "count"
        FROM "asset_processes" p
        JOIN "assets" a ON a."id" = p."assetId"
       WHERE a."monitored" = true
       GROUP BY 1
       ORDER BY 2 DESC, 1 ASC
       LIMIT ${AGGREGATE_LIMIT}
    `,
    pinnedCounts("mappedProcesses"),
  ]);
  return rows.map((r) => ({
    name: r.name,
    deviceCount: Number(r.count),
    mappedCount: pinned.get(r.name) ?? 0,
  }));
}

export async function getFleetServiceAggregate(): Promise<AggregateRow[]> {
  const [rows, pinned] = await Promise.all([
    prisma.$queryRaw<Array<CountRow & { platform: string | null; displayName: string | null }>>`
      SELECT s."unit" AS "name",
             COUNT(DISTINCT s."assetId")::int AS "count",
             MIN(s."platform")    AS "platform",
             MIN(s."displayName") AS "displayName"
        FROM "asset_services" s
        JOIN "assets" a ON a."id" = s."assetId"
       WHERE a."monitored" = true
       GROUP BY 1
       ORDER BY 2 DESC, 1 ASC
       LIMIT ${AGGREGATE_LIMIT}
    `,
    pinnedCounts("mappedServices"),
  ]);
  return rows.map((r) => ({
    name: r.name,
    deviceCount: Number(r.count),
    mappedCount: pinned.get(r.name) ?? 0,
    platform: r.platform,
    displayName: r.displayName,
  }));
}

// ─── Candidate assets + their reported inventory ────────────────────────────

interface CandidateAsset {
  id: string;
  hostname: string | null;
  mappedProcesses: string[];
  mappedServices: string[];
}

/**
 * Monitored assets in scope. `monitored: true` matches the Application Map's own
 * filter — pinning a host the map won't render is pointless work.
 */
async function loadCandidates(selection: AppMapAutoMapSelection): Promise<CandidateAsset[]> {
  const assets = await prisma.asset.findMany({
    where: { monitored: true },
    select: { id: true, hostname: true, mappedProcesses: true, mappedServices: true },
  });
  if (!selection.scope) return assets;
  const allowed = await resolveMatchingAssetIds(selection.scope);
  return assets.filter((a) => allowed.has(a.id));
}

/** assetId → reported names, for whichever inventories the selection needs. */
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

/** Everything the selection WOULD add, computed in memory. Shared by preview and
 *  apply so the two can never disagree. */
async function computePending(selection: AppMapAutoMapSelection): Promise<PendingUpdate[]> {
  if (isSelectionEmpty(selection)) return [];
  const assets = await loadCandidates(selection);
  if (assets.length === 0) return [];

  const needProcesses = !(selection.processes.names.length === 0 && selection.processes.patterns.length === 0);
  const needServices  = !(selection.services.names.length  === 0 && selection.services.patterns.length  === 0);
  const inv = await loadInventories(assets.map((a) => a.id), needProcesses, needServices);

  const pending: PendingUpdate[] = [];
  for (const a of assets) {
    const wantProc = needProcesses ? resolveBlockPins(selection.processes, inv.processes.get(a.id) ?? []) : [];
    const wantSvc  = needServices  ? resolveBlockPins(selection.services,  inv.services.get(a.id)  ?? []) : [];
    const haveProc = new Set(a.mappedProcesses);
    const haveSvc  = new Set(a.mappedServices);
    const freshProcesses = wantProc.filter((n) => !haveProc.has(n));
    const freshServices  = wantSvc.filter((n) => !haveSvc.has(n));
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

export async function previewAutoMap(selection: AppMapAutoMapSelection): Promise<AutoMapPreview> {
  const pending = await computePending(selection);
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

// ─── Apply (additive) ───────────────────────────────────────────────────────

export interface AutoMapApplyResult {
  devices: number;
  processPins: number;
  servicePins: number;
  sampleDevices: Array<{ assetId: string; hostname: string | null; processes: string[]; services: string[] }>;
}

/**
 * Pin everything the selection resolves to, across every in-scope asset.
 * Strictly additive — pins are the union of existing and computed, and an asset
 * with nothing fresh is skipped entirely so a back-to-back reconcile is silent.
 * Chunked Promise.allSettled so a 2000-host fleet doesn't serialize a thousand
 * updates behind the request (or the job tick). Idempotent: a half-landed batch
 * yields the same final set on re-run.
 */
export async function applyAutoMap(selection: AppMapAutoMapSelection): Promise<AutoMapApplyResult> {
  const empty: AutoMapApplyResult = { devices: 0, processPins: 0, servicePins: 0, sampleDevices: [] };
  const pending = await computePending(selection);
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

  return {
    devices,
    processPins,
    servicePins,
    sampleDevices: pending.slice(0, 10).map((p) => ({
      assetId: p.assetId,
      hostname: p.hostname,
      processes: p.freshProcesses,
      services: p.freshServices,
    })),
  };
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
 * Also drops the name from the stored selection, otherwise the next reconcile
 * would put it straight back.
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
  const selection = await getSelection();
  const block = isProc ? selection.processes : selection.services;
  const before = block.names.length;
  block.names = block.names.filter((n) => n !== target);
  if (block.names.length !== before) await saveSelection(selection);

  return { devices, connectionRowsDeleted };
}

// ─── Reconcile entry point (periodic job + inline on save) ──────────────────

export interface AutoMapReconcileSummary extends Record<string, unknown> {
  devices: number;
  processPins: number;
  servicePins: number;
}

/** Re-apply the stored selection. The "future assets" mechanism: a host that
 *  installs an agent and reports its inventory picks up its pins on the next
 *  tick. No-op (and silent) when nothing is selected or nothing is missing. */
export async function reconcileAutoMap(): Promise<AutoMapReconcileSummary> {
  const selection = await getSelection();
  if (isSelectionEmpty(selection)) return { devices: 0, processPins: 0, servicePins: 0 };
  const r = await applyAutoMap(selection);
  return { devices: r.devices, processPins: r.processPins, servicePins: r.servicePins };
}
