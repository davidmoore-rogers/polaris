/**
 * src/services/nocDashboardService.ts
 *
 * Fleet-wide aggregates backing the NOC dashboard widgets (the SolarWinds
 * wall-display recreation). Each function answers one widget's question over
 * the whole monitored fleet. The route layer (dashboard.ts /noc-summary) goes
 * through getNocSummaryPayload(), which resolves the requested feed subset
 * (?feeds=a,b — widgets fetch individually so each renders as soon as its own
 * data exists), permission-filters per section, and serves every feed through
 * a short per-feed TTL cache so N widgets / browsers / kiosk walls don't
 * recompute the same hypertable scans.
 *
 * Scale: every query here is designed to stay flat from 100 to 2000 monitored
 * assets — groupBy / count / one windowed raw aggregate / one bounded findMany,
 * never a per-row await loop. The sample tables (asset_telemetry_samples,
 * asset_monitor_samples) are TimescaleDB hypertables: we ONLY read them, and
 * the time-window predicate keeps each scan inside recent (chunk-excluded)
 * data.
 *
 * TIMEZONE RULE for raw window predicates: Prisma maps DateTime to
 * `timestamp` WITHOUT time zone and stores UTC wall-clock values. Comparing
 * that naive column against bare `now()` (a timestamptz) makes Postgres
 * interpret the stored values in the SERVER's TimeZone — on a RHEL-native
 * install that defaults to the system zone (e.g. America/Chicago), which
 * silently shifts every "last N minutes" window by the UTC offset (a
 * 15-minute packet-loss window becomes ~5¼ hours and counts a long-recovered
 * outage; positive-offset zones would instead make windows match nothing).
 * Always write `(now() AT TIME ZONE 'UTC')` — naive-UTC vs naive-UTC — in
 * raw SQL against Prisma-written timestamp columns. Prisma-bound Date
 * parameters are unaffected.
 */

import { prisma } from "../db.js";
import { resolveMonitorSettings } from "./monitoringService.js";
import { createTtlCache } from "../utils/ttlCache.js";

// Asset types treated as "infrastructure" for the uptime % gauge — mirrors the
// SolarWinds Fortinet-only uptime tile. These are the built-in network-gear
// types; custom operator types fall outside the gauge by design.
const INFRA_ASSET_TYPES = ["firewall", "switch", "router", "access_point"];

// An asset inside a maintenance window (scheduler-held status="maintenance")
// has its polling paused and monitorStatus FROZEN at whatever it was on window
// entry — a device taken down for planned work stays monitorStatus="down" for
// the whole window. Every down/warning/stale surface here must exclude the
// maintenance set or planned downtime reads as an outage (the Status Map
// widget paints these purple for the same reason). Spread into asset wheres;
// mirrored as `AND "status" <> 'maintenance'` in the raw-SQL feeds.
const NOT_IN_MAINTENANCE = { status: { not: "maintenance" as const } };

// monitorAlerts (and therefore the active-alert count) is defined as monitored
// assets currently in warning/down that aren't dependency-suppressed — kept
// byte-identical to the /summary monitorAlerts where-clause so the tile count
// and the alert list never disagree.
const ALERT_WHERE = {
  monitored: true,
  monitorStatus: { in: ["warning", "down"] },
  dependencySuppressed: false,
  ...NOT_IN_MAINTENANCE,
};

// The eight built-in asset types the per-widget asset-type filter toggles.
const BUILTIN_ASSET_TYPES = ["server", "switch", "router", "firewall", "workstation", "printer", "access_point", "other"];

/**
 * Resolve a per-widget filter into the set of matching asset ids, or null when
 * no filter is active (callers then skip the constraint entirely — the default
 * unfiltered path). Two dimensions:
 *   - assetTypes: the ENABLED built-in types. Hidden = built-ins NOT enabled;
 *     we exclude those (`assetType NOT IN hidden`) so unchecked types disappear
 *     while custom (non-built-in) types always remain visible.
 *   - regionNames: the user's region names ("My regions"). An asset matches if
 *     it carries the `region:<name>` tag for any of them. Empty = all regions.
 * Returns [] (not null) when a filter is active but nothing matches — feeds
 * then correctly show nothing.
 */
export async function resolveFilteredAssetIds(opts: {
  assetTypes?: string[] | null;
  regionNames?: string[] | null;
}): Promise<string[] | null> {
  const where: Record<string, unknown> = {};
  let active = false;
  if (Array.isArray(opts.assetTypes)) {
    const hidden = BUILTIN_ASSET_TYPES.filter((t) => !opts.assetTypes!.includes(t));
    if (hidden.length > 0) { where.assetType = { notIn: hidden }; active = true; }
  }
  const regionNames = (opts.regionNames || []).filter(Boolean);
  if (regionNames.length > 0) {
    where.tags = { hasSome: regionNames.map((n) => "region:" + n) };
    active = true;
  }
  if (!active) return null;
  const rows = await prisma.asset.findMany({ where, select: { id: true } });
  return rows.map((r) => r.id);
}

// Spread into a Prisma asset `where` to constrain by the resolved id set.
// null → no constraint (default unfiltered path).
function idWhere(assetIds: string[] | null): Record<string, unknown> {
  return assetIds ? { id: { in: assetIds } } : {};
}

// ─── Active-alert severity join ──────────────────────────────────────────────
// Widgets sort SEVERITY-FIRST: a row whose asset carries an active (uncleared)
// automation alert floats above unalerted rows, ordered by the alert's
// severity; within the same severity each feed keeps its own order (value /
// outage recency / overdue-ness — the sorts below are stable). Rank map covers
// the current 5-level vocabulary plus the legacy info/error values on
// pre-redesign notifications.
export const ALERT_SEVERITY_RANK: Record<string, number> = {
  notice: 1, informational: 2, info: 2, warning: 3, serious: 4, error: 5, critical: 5,
};

/** Highest active-alert severity per asset (one bounded findMany over the
 *  uncleared notifications; covered by @@index([assetId]) + [cleared, ...]). */
export async function activeAlertSeverityByAsset(assetIds: string[] | null): Promise<Map<string, { severity: string; rank: number }>> {
  const rows = await prisma.notification.findMany({
    where: { cleared: false, assetId: assetIds ? { in: assetIds } : { not: null } },
    select: { assetId: true, severity: true },
  });
  const out = new Map<string, { severity: string; rank: number }>();
  for (const r of rows) {
    if (!r.assetId) continue;
    const rank = ALERT_SEVERITY_RANK[r.severity] ?? 0;
    const cur = out.get(r.assetId);
    if (!cur || rank > cur.rank) out.set(r.assetId, { severity: r.severity, rank });
  }
  return out;
}

/** Decorate feed rows with the owning asset's highest active-alert severity.
 *  One severity fetch bounded to the rows' own asset ids (feeds are capped,
 *  so this stays small at 2000 assets). */
async function attachAlertSeverity<T extends object>(
  rows: T[],
  idOf: (r: T) => string | null | undefined,
): Promise<Array<T & { alertSeverity?: string; alertRank: number }>> {
  const ids = Array.from(new Set(rows.map(idOf).filter((x): x is string => !!x)));
  if (ids.length === 0) return rows.map((r) => ({ ...r, alertRank: 0 }));
  const sev = await activeAlertSeverityByAsset(ids);
  return rows.map((r) => {
    const id = idOf(r);
    const s = id ? sev.get(id) : undefined;
    return { ...r, ...(s ? { alertSeverity: s.severity } : {}), alertRank: s?.rank ?? 0 };
  });
}

/** Stable severity-first sort — equal ranks keep the feed's own order. */
function severityFirst<T extends { alertRank: number }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => b.alertRank - a.alertRank);
}

async function topNWithSeverity(rows: TopNRow[]): Promise<TopNRow[]> {
  return severityFirst(await attachAlertSeverity(rows, (r) => r.id));
}

export interface StatusSummary {
  statusCounts: { total: number; up: number; down: number; warning: number; unknown: number; recovering: number; maintenance: number };
  uptimePercent: number | null;
  activeAlertCount: number;
}

/**
 * Feed 1 — status tiles. Two groupBys + two counts, all backed by
 * @@index([monitored]). Constant query cost regardless of fleet size.
 * Maintenance-window assets get their own bucket (they still count into
 * `total`): their frozen monitorStatus must not feed the Up/Down/Warning
 * tiles or the uptime gauge.
 */
export async function getStatusSummary(assetIds: string[] | null = null): Promise<StatusSummary> {
  const idf = idWhere(assetIds);
  const [byStatus, infraByStatus, activeAlertCount, maintenanceCount] = await Promise.all([
    prisma.asset.groupBy({
      by: ["monitorStatus"],
      _count: { _all: true },
      where: { monitored: true, ...NOT_IN_MAINTENANCE, ...idf },
    }),
    prisma.asset.groupBy({
      by: ["monitorStatus"],
      _count: { _all: true },
      where: { monitored: true, assetType: { in: INFRA_ASSET_TYPES }, ...NOT_IN_MAINTENANCE, ...idf },
    }),
    prisma.asset.count({ where: { ...ALERT_WHERE, ...idf } }),
    prisma.asset.count({ where: { monitored: true, status: "maintenance", ...idf } }),
  ]);

  const counts = { total: maintenanceCount, up: 0, down: 0, warning: 0, unknown: 0, recovering: 0, maintenance: maintenanceCount };
  for (const row of byStatus) {
    const n = row._count._all;
    counts.total += n;
    const key = (row.monitorStatus ?? "unknown") as keyof typeof counts;
    if (key in counts && key !== "total" && key !== "maintenance") counts[key] += n;
    else counts.unknown += n;
  }

  // Uptime % over the infra subset: up / (up + down). Excludes warning /
  // recovering / unknown so the gauge reflects hard reachability, matching the
  // SolarWinds infra uptime tile. Null when there's no infra to measure.
  let infraUp = 0;
  let infraDown = 0;
  for (const row of infraByStatus) {
    if (row.monitorStatus === "up") infraUp += row._count._all;
    else if (row.monitorStatus === "down") infraDown += row._count._all;
  }
  const denom = infraUp + infraDown;
  const uptimePercent = denom === 0 ? null : Math.round((infraUp / denom) * 1000) / 10;

  return { statusCounts: counts, uptimePercent, activeAlertCount };
}

export interface DownNode {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string;
  site: string;
  division: string | null;
  monitorStatus: string | null;
  monitorStatusChangedAt: Date | null;
  alertSeverity?: string;
  alertRank?: number;
}

function siteOf(a: { location: string | null; learnedLocation: string | null; snmpLocation: string | null }): string {
  return a.location || a.learnedLocation || a.snmpLocation || "(unknown)";
}

/**
 * Feed 2 — down nodes. One indexed findMany over the (small) down subset;
 * site coalesce done in JS because Prisma groupBy can't COALESCE three
 * nullable columns. dependencySuppressed:false so a down parent's suppressed
 * children don't show as independent outages. Ordered youngest outage first
 * (monitorStatusChangedAt desc) — the freshest state change is the one a NOC
 * operator needs to react to; nulls (unknown transition time) sink to the
 * bottom. The order matters at the cap too: when >limit nodes are down, the
 * newest outages are the ones kept.
 */
export async function getDownNodes(limit: number | null = 100, assetIds: string[] | null = null): Promise<{ nodes: DownNode[]; total: number }> {
  const where = { monitored: true, monitorStatus: "down", dependencySuppressed: false, ...NOT_IN_MAINTENANCE, ...idWhere(assetIds) };
  // `total` is the TRUE down count (indexed count over the same where), not
  // rows.length — the findMany is capped by `limit`, and the widget's header
  // pill must show the overall number even when the list is clipped.
  const [rows, total] = await Promise.all([
    prisma.asset.findMany({
      where,
      select: {
        id: true, hostname: true, ipAddress: true, assetType: true,
        location: true, learnedLocation: true, snmpLocation: true,
        department: true, monitorStatus: true, monitorStatusChangedAt: true,
      },
      orderBy: [{ monitorStatusChangedAt: { sort: "desc", nulls: "last" } }],
      take: limit ?? undefined,
    }),
    prisma.asset.count({ where }),
  ]);
  const nodes: DownNode[] = rows.map((a) => ({
    id: a.id,
    hostname: a.hostname,
    ipAddress: a.ipAddress,
    assetType: a.assetType,
    site: siteOf(a),
    division: a.department,
    monitorStatus: a.monitorStatus,
    monitorStatusChangedAt: a.monitorStatusChangedAt,
  }));
  // Severity-first: alerted nodes float to the top; within a severity (and for
  // unalerted nodes) the youngest-outage order above holds (stable sort).
  return { nodes: severityFirst(await attachAlertSeverity(nodes, (n) => n.id)), total };
}

export interface DownInterface {
  assetId: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string;
  ifName: string;
  ifLabel: string | null;
  gate: string;
  lastUpAt: Date | null;
  alertSeverity?: string;
  alertRank?: number;
}

/**
 * The "gate" an interface lives on. For a FortiGate firewall the interface is
 * physically on the device itself → its hostname. For a managed FortiSwitch /
 * FortiAP (and other discovered gear) `learnedLocation` carries the parent
 * FortiGate device name — the same field the Down Nodes site grouping surfaces
 * as the gate. Fall back to the remaining site fields, then "(unknown)".
 */
function gateOf(a: { assetType: string; hostname: string | null; learnedLocation: string | null; location: string | null; snmpLocation: string | null }): string {
  if (a.assetType === "firewall") return a.hostname || a.learnedLocation || a.location || a.snmpLocation || "(unknown)";
  return a.learnedLocation || a.hostname || a.location || a.snmpLocation || "(unknown)";
}

/**
 * Feed 2b — down interfaces. Interfaces that are administratively UP but
 * operationally DOWN (a real link fault, not an operator-disabled port),
 * restricted to interfaces SELECTED FOR MONITORING (the asset's pinned
 * `monitoredInterfaces` list — the full system-info scrape samples every
 * interface, so without the pin filter every idle unpinned port would show as
 * an outage), grouped by the gate they live on. Two queries, flat at 2000
 * assets:
 *   1. ONE windowed single-pass CTE over asset_interface_samples joined to
 *      assets on `ifName = ANY(monitoredInterfaces)` (the pin filter runs
 *      BEFORE the window + LIMIT so pinned-down rows can't be crowded out by
 *      unpinned noise): latest sample per (asset, ifName) via row_number(),
 *      plus each interface's last "up" timestamp via a filtered window
 *      aggregate (for the "down for" duration). The time window keeps the
 *      hypertable scan inside recent (chunk-excluded) data; interface samples
 *      only exist for interface-polled assets (a network-gear subset), so the
 *      scan stays small. The 4h default window comfortably contains the latest
 *      full interface scrape at the default 600s systemInfo cadence even when
 *      an operator slows it.
 *   2. ONE findMany over the (small) set of assets that own a down interface,
 *      scoped to monitored + non-suppressed — an interface whose owning asset
 *      is unmonitored / suppressed / decommissioned drops out here (those assets
 *      stop being monitored, so only stale samples linger).
 */
export async function getDownInterfaces(limit: number | null = 100, sinceMinutes = 240, assetIds: string[] | null = null): Promise<DownInterface[]> {
  const idClause = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; ifName: string; ifLabel: string | null; lastUpAt: Date | null }>>(
    `WITH win AS (
       SELECT s."assetId" AS "assetId", s."ifName" AS "ifName",
              COALESCE(NULLIF(s."alias", ''), NULLIF(s."description", '')) AS "ifLabel",
              s."operStatus" AS "operStatus", s."adminStatus" AS "adminStatus",
              row_number() OVER (PARTITION BY s."assetId", s."ifName" ORDER BY s."timestamp" DESC) AS rn,
              max(s."timestamp") FILTER (WHERE s."operStatus" = 'up')
                OVER (PARTITION BY s."assetId", s."ifName") AS "lastUpAt"
       FROM "asset_interface_samples" s
       JOIN "assets" a ON a."id" = s."assetId" AND s."ifName" = ANY(a."monitoredInterfaces")
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval${idClause}
     )
     SELECT "assetId", "ifName", "ifLabel", "lastUpAt"
     FROM win
     WHERE rn = 1 AND "operStatus" = 'down' AND "adminStatus" = 'up'
     ORDER BY "lastUpAt" ASC NULLS FIRST
     LIMIT $2`,
    ...params,
  );
  if (rows.length === 0) return [];
  const ids = Array.from(new Set(rows.map((r) => r.assetId)));
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids }, monitored: true, dependencySuppressed: false, ...NOT_IN_MAINTENANCE },
    select: {
      id: true, hostname: true, ipAddress: true, assetType: true,
      location: true, learnedLocation: true, snmpLocation: true,
    },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out: DownInterface[] = [];
  for (const r of rows) {
    const a = byId.get(r.assetId);
    if (!a) continue;
    out.push({
      assetId: a.id,
      hostname: a.hostname,
      ipAddress: a.ipAddress,
      assetType: a.assetType,
      ifName: r.ifName,
      ifLabel: r.ifLabel,
      gate: gateOf(a),
      lastUpAt: r.lastUpAt,
    });
  }
  return severityFirst(await attachAlertSeverity(out, (r) => r.assetId));
}

export interface DownIpsecTunnel {
  assetId: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string;
  tunnelName: string;
  parentInterface: string | null;
  remoteGateway: string | null;
  gate: string;
  lastUpAt: Date | null;
  alertSeverity?: string;
  alertRank?: number;
}

/**
 * Feed 2c — down IPsec tunnels. Phase-1 tunnels whose every phase-2 selector is
 * down (status='down'), restricted to tunnels SELECTED FOR MONITORING (the
 * asset's pinned `monitoredIpsecTunnels` list — same rationale and same SQL
 * shape as getDownInterfaces' pin filter: the scrape samples every configured
 * tunnel, including CMDB-synthesized rows for tunnels whose parent link is
 * dead, so without the pin gate an unpinned expected-down tunnel shows as an
 * outage forever), grouped by the gate they live on, each carrying the
 * parent physical interface the tunnel rides (the FortiOS phase1-interface WAN
 * port) so a NOC operator sees which uplink took the tunnel down. Same
 * shape/scale as getDownInterfaces: one windowed single-pass CTE over
 * asset_ipsec_tunnel_samples joined to assets on
 * `tunnelName = ANY(monitoredIpsecTunnels)` (pin filter BEFORE the window +
 * LIMIT), then a monitored/non-suppressed hydrate findMany. FortiGate-only
 * data; the 4h window covers the system-info scrape cadence. `partial`/`dynamic`
 * tunnels are intentionally excluded — only a fully-down tunnel is an outage.
 */
export async function getDownIpsecTunnels(limit: number | null = 100, sinceMinutes = 240, assetIds: string[] | null = null): Promise<DownIpsecTunnel[]> {
  const idClause = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; tunnelName: string; parentInterface: string | null; remoteGateway: string | null; lastUpAt: Date | null }>>(
    `WITH win AS (
       SELECT s."assetId" AS "assetId", s."tunnelName" AS "tunnelName",
              s."parentInterface" AS "parentInterface", s."remoteGateway" AS "remoteGateway",
              s."status" AS "status",
              row_number() OVER (PARTITION BY s."assetId", s."tunnelName" ORDER BY s."timestamp" DESC) AS rn,
              max(s."timestamp") FILTER (WHERE s."status" = 'up')
                OVER (PARTITION BY s."assetId", s."tunnelName") AS "lastUpAt"
       FROM "asset_ipsec_tunnel_samples" s
       JOIN "assets" a ON a."id" = s."assetId" AND s."tunnelName" = ANY(a."monitoredIpsecTunnels")
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval${idClause}
     )
     SELECT "assetId", "tunnelName", "parentInterface", "remoteGateway", "lastUpAt"
     FROM win
     WHERE rn = 1 AND "status" = 'down'
     ORDER BY "lastUpAt" ASC NULLS FIRST
     LIMIT $2`,
    ...params,
  );
  if (rows.length === 0) return [];
  const ids = Array.from(new Set(rows.map((r) => r.assetId)));
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids }, monitored: true, dependencySuppressed: false, ...NOT_IN_MAINTENANCE },
    select: {
      id: true, hostname: true, ipAddress: true, assetType: true,
      location: true, learnedLocation: true, snmpLocation: true,
    },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out: DownIpsecTunnel[] = [];
  for (const r of rows) {
    const a = byId.get(r.assetId);
    if (!a) continue;
    out.push({
      assetId: a.id,
      hostname: a.hostname,
      ipAddress: a.ipAddress,
      assetType: a.assetType,
      tunnelName: r.tunnelName,
      parentInterface: r.parentInterface,
      remoteGateway: r.remoteGateway,
      gate: gateOf(a),
      lastUpAt: r.lastUpAt,
    });
  }
  return severityFirst(await attachAlertSeverity(out, (r) => r.assetId));
}

export interface TopNRow { id: string; hostname: string | null; ipAddress: string | null; value: number; detail?: string; site?: string; alertSeverity?: string; alertRank?: number }

// Hydrate a list of assetIds (preserving the incoming order) with display
// names in ONE findMany — never a per-row lookup. `site` uses the same
// location > learnedLocation > snmpLocation coalesce as Down Nodes so the
// top-N widgets' "Group by: Site" buckets match across widgets.
async function hydrateNames(ordered: Array<{ assetId: string; value: number }>): Promise<TopNRow[]> {
  if (ordered.length === 0) return [];
  const ids = ordered.map((r) => r.assetId);
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: { id: true, hostname: true, ipAddress: true, location: true, learnedLocation: true, snmpLocation: true },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  return ordered
    .map((r): TopNRow | null => {
      const a = byId.get(r.assetId);
      if (!a) return null;
      return { id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, value: r.value, site: siteOf(a) };
    })
    .filter((r): r is TopNRow => r !== null);
}

// Default per-asset sample count the top-N averages smooth over. The widgets'
// "Average over" gear control overrides it per request (?samples=, 1..MAX).
export const DEFAULT_TOPN_SAMPLE_COUNT = 10;
export const MAX_TOPN_SAMPLE_COUNT = 100;

// The averaging window must comfortably contain sampleCount samples at any
// realistic cpuMemory cadence, while staying tight enough for TimescaleDB
// chunk exclusion. The historical 1h-for-10-samples budget = 6 min/sample.
function topNWindowMinutes(baseMinutes: number, sampleCount: number): number {
  return Math.max(baseMinutes, sampleCount * 6);
}

function clampSampleCount(n: number | null | undefined): number {
  if (!Number.isFinite(n as number) || (n as number) <= 0) return DEFAULT_TOPN_SAMPLE_COUNT;
  return Math.min(Math.trunc(n as number), MAX_TOPN_SAMPLE_COUNT);
}

/**
 * Feed 3a — highest CPU, averaged over each asset's most-recent `sampleCount`
 * samples (default 10 — smooths the single-spike ranking the DISTINCT-ON
 * latest-value version surfaced; 1 = rank on the latest sample only). The time
 * predicate keeps the scan inside recent Timescale chunks (~one telemetry
 * sample per asset per cadence); row_number()<=N takes the newest N per asset.
 */
export async function getHighestCpu(limit: number | null = 100, sinceMinutes = 60, assetIds: string[] | null = null, sampleCount: number = DEFAULT_TOPN_SAMPLE_COUNT): Promise<TopNRow[]> {
  const samples = clampSampleCount(sampleCount);
  const idClause = assetIds ? ` AND s."assetId" = ANY($4::text[])` : "";
  const params: unknown[] = [String(topNWindowMinutes(sinceMinutes, samples)), limit, samples];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; value: number }>>(
    `WITH recent AS (
       SELECT s."assetId" AS "assetId", s."cpuPct" AS v,
              row_number() OVER (PARTITION BY s."assetId" ORDER BY s."timestamp" DESC) AS rn
       FROM "asset_telemetry_samples" s
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval AND s."cpuPct" IS NOT NULL${idClause}
     )
     SELECT "assetId", avg(v)::float AS value
     FROM recent WHERE rn <= $3
     GROUP BY "assetId"
     ORDER BY value DESC LIMIT $2`,
    ...params,
  );
  return topNWithSeverity(await hydrateNames(rows.map((r) => ({ assetId: r.assetId, value: Math.round(r.value * 10) / 10 }))));
}

/**
 * Feed 3b — highest memory, averaged over each asset's most-recent
 * `sampleCount` samples (same windowed pattern as CPU). Prefers memPct; falls
 * back to bytes ratio when only absolute bytes were reported (same preference
 * as sampleHistoryService).
 */
export async function getHighestMemory(limit: number | null = 100, sinceMinutes = 60, assetIds: string[] | null = null, sampleCount: number = DEFAULT_TOPN_SAMPLE_COUNT): Promise<TopNRow[]> {
  const samples = clampSampleCount(sampleCount);
  const idClause = assetIds ? ` AND s."assetId" = ANY($4::text[])` : "";
  const params: unknown[] = [String(topNWindowMinutes(sinceMinutes, samples)), limit, samples];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; value: number }>>(
    `WITH recent AS (
       SELECT s."assetId" AS "assetId",
              COALESCE(s."memPct", s."memUsedBytes"::float / NULLIF(s."memTotalBytes", 0) * 100) AS v,
              row_number() OVER (PARTITION BY s."assetId" ORDER BY s."timestamp" DESC) AS rn
       FROM "asset_telemetry_samples" s
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval
         AND (s."memPct" IS NOT NULL OR (s."memUsedBytes" IS NOT NULL AND s."memTotalBytes" IS NOT NULL))${idClause}
     )
     SELECT "assetId", avg(v)::float AS value
     FROM recent WHERE rn <= $3 AND v IS NOT NULL
     GROUP BY "assetId"
     ORDER BY value DESC LIMIT $2`,
    ...params,
  );
  return topNWithSeverity(await hydrateNames(rows.map((r) => ({ assetId: r.assetId, value: Math.round(r.value * 10) / 10 }))));
}

/**
 * Feed 4 — slowest response. Reads the already-maintained
 * Asset.lastResponseTimeMs (stamped by recordProbeResult) — fresher and far
 * cheaper than scanning the monitor-sample hypertable.
 */
export async function getSlowestResponse(limit: number | null = 100, assetIds: string[] | null = null, sinceMinutes = 360): Promise<TopNRow[]> {
  // Average of each asset's most-recent 10 response times (smooths the single-
  // probe spikes the instantaneous lastResponseTimeMs ranking surfaced). The
  // time window bounds the hypertable scan to recent chunks (TimescaleDB chunk
  // exclusion) so this stays cheap at 2000 assets; 6h comfortably contains 10
  // probes for any realistic cadence, and row_number()<=10 takes the newest 10.
  const idClause = assetIds ? ` AND "assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; avg_ms: number }>>(
    `WITH recent AS (
       SELECT "assetId", "responseTimeMs",
              row_number() OVER (PARTITION BY "assetId" ORDER BY "timestamp" DESC) AS rn
       FROM "asset_monitor_samples"
       WHERE "timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval
         AND "responseTimeMs" IS NOT NULL${idClause}
     )
     SELECT "assetId", avg("responseTimeMs")::float AS avg_ms
     FROM recent
     WHERE rn <= 10
     GROUP BY "assetId"
     ORDER BY avg_ms DESC
     LIMIT $2`,
    ...params,
  );
  const ordered = rows.map((r) => ({ assetId: r.assetId, value: Math.round(Number(r.avg_ms) * 10) / 10 }));
  return topNWithSeverity(await hydrateNames(ordered));
}

/**
 * Feed 4b — highest disk usage, PER VOLUME (one row per (asset, mountPath) at
 * its latest sample's used %). Ranks the fullest filesystems across the fleet
 * so a NOC operator sees what's about to fill up. Each row's `detail` carries
 * the mount path (the bar widget shows it beside the hostname). DISTINCT-ON
 * latest-per-(asset,mount) over asset_storage_samples; the window is wide (48h
 * default) because the full storage scrape rides the 24h "slow" cadence.
 */
export async function getHighestDiskUsage(limit: number | null = 100, assetIds: string[] | null = null, sinceMinutes = 2880): Promise<TopNRow[]> {
  const idClause = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; mountPath: string; pct: number }>>(
    `SELECT "assetId", "mountPath", pct FROM (
       SELECT DISTINCT ON (s."assetId", s."mountPath")
              s."assetId" AS "assetId", s."mountPath" AS "mountPath",
              s."usedBytes"::float / s."totalBytes"::float * 100 AS pct
       FROM "asset_storage_samples" s
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval
         AND s."usedBytes" IS NOT NULL AND s."totalBytes" IS NOT NULL AND s."totalBytes" > 0${idClause}
       ORDER BY s."assetId", s."mountPath", s."timestamp" DESC
     ) latest ORDER BY pct DESC LIMIT $2`,
    ...params,
  );
  if (rows.length === 0) return [];
  // Hydrate names in ONE findMany (an asset appears once per volume, so dedupe
  // the id set for the lookup), then attach hostname + mount-path detail.
  const ids = Array.from(new Set(rows.map((r) => r.assetId)));
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: { id: true, hostname: true, ipAddress: true, location: true, learnedLocation: true, snmpLocation: true },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out = rows
    .map((r): TopNRow | null => {
      const a = byId.get(r.assetId);
      if (!a) return null;
      return { id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, value: Math.round(r.pct * 10) / 10, detail: r.mountPath, site: siteOf(a) };
    })
    .filter((r): r is TopNRow => r !== null);
  return topNWithSeverity(out);
}

/**
 * Feed 4c — highest temperature, PER SENSOR (one row per (asset, sensorName) at
 * its latest sample's reading). Ranks the hottest hardware sensors across the
 * fleet; each row's `detail` carries the sensor name. DISTINCT-ON latest-per-
 * (asset,sensor) over asset_hardware_sensor_samples scoped to
 * sensorClass='temperature' — that class is always °C (classifyHardwareSensor),
 * so values compare directly. The 4h window comfortably contains the latest
 * scrape at the default temperature-stream cadence even when an operator
 * slows it, while keeping the hypertable scan chunk-excluded.
 */
export async function getHighestTemperature(limit: number | null = 100, assetIds: string[] | null = null, sinceMinutes = 240): Promise<TopNRow[]> {
  const idClause = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; sensorName: string; value: number }>>(
    `SELECT "assetId", "sensorName", value FROM (
       SELECT DISTINCT ON (s."assetId", s."sensorName")
              s."assetId" AS "assetId", s."sensorName" AS "sensorName", s."value" AS value
       FROM "asset_hardware_sensor_samples" s
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval
         AND s."sensorClass" = 'temperature' AND s."value" IS NOT NULL${idClause}
       ORDER BY s."assetId", s."sensorName", s."timestamp" DESC
     ) latest ORDER BY value DESC LIMIT $2`,
    ...params,
  );
  if (rows.length === 0) return [];
  // Hydrate names in ONE findMany (an asset appears once per sensor, so dedupe
  // the id set for the lookup), then attach hostname + sensor-name detail.
  const ids = Array.from(new Set(rows.map((r) => r.assetId)));
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: { id: true, hostname: true, ipAddress: true, location: true, learnedLocation: true, snmpLocation: true },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out = rows
    .map((r): TopNRow | null => {
      const a = byId.get(r.assetId);
      if (!a) return null;
      return { id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, value: Math.round(r.value * 10) / 10, detail: r.sensorName, site: siteOf(a) };
    })
    .filter((r): r is TopNRow => r !== null);
  return topNWithSeverity(out);
}

/**
 * Feed 5 (data-gap Option A) — packet loss = failed-probe ratio over the
 * window. One windowed groupBy over asset_monitor_samples; no schema change.
 * (True per-probe loss% via multi-ping is a documented follow-up.)
 *
 * Assets at 100% loss (zero successful probes in the window) are excluded —
 * that's a hard-down node, already surfaced by the Down Nodes widget, and
 * listing it here as "packet loss" is redundant noise. The HAVING requires
 * at least one failure AND at least one success, so only genuinely lossy
 * (intermittent) assets qualify.
 */
export async function getPacketLoss(limit: number | null = 100, sinceMinutes = 15, assetIds: string[] | null = null): Promise<TopNRow[]> {
  const idClause = assetIds ? ` AND "assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; total: bigint; failed: bigint }>>(
    `SELECT "assetId", count(*) AS total, count(*) FILTER (WHERE NOT "success") AS failed
     FROM "asset_monitor_samples"
     WHERE "timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval${idClause}
     GROUP BY "assetId"
     HAVING count(*) FILTER (WHERE NOT "success") > 0
        AND count(*) FILTER (WHERE "success") > 0
     ORDER BY (count(*) FILTER (WHERE NOT "success"))::float / count(*) DESC
     LIMIT $2`,
    ...params,
  );
  const ordered = rows.map((r) => ({
    assetId: r.assetId,
    value: Math.round((Number(r.failed) / Number(r.total)) * 1000) / 10,
  }));
  return topNWithSeverity(await hydrateNames(ordered));
}

export interface StalePoll { id: string; hostname: string | null; ipAddress: string | null; lastPolledAt: Date | null; expectedIntervalSec: number; alertSeverity?: string; alertRank?: number }

/**
 * Feed 6 — stale polls (overdue for their next response-time probe). Two-stage:
 * Stage A is an indexed findMany over candidates that are clearly stale by a
 * coarse floor (uses @@index([monitored, lastMonitorAt])); Stage B resolves
 * the exact per-asset cadence via resolveMonitorSettings (its tier loaders are
 * cached, so the candidate set's few distinct integration×type combos cost
 * almost nothing) and keeps only the genuinely overdue ones.
 *
 * @param grace multiplier on the resolved interval before "stale" (default 3×)
 */
export async function getStalePolls(grace = 3, limit: number | null = 50, assetIds: string[] | null = null): Promise<StalePoll[]> {
  // Coarse pre-filter: anything not polled within COARSE_FLOOR can't be fresh
  // for any realistic interval. Bounds Stage B's candidate set.
  const COARSE_FLOOR_MS = 5 * 60 * 1000; // 5 min — below the shortest sane cadence × grace
  const now = Date.now();
  const candidates = await prisma.asset.findMany({
    where: {
      monitored: true,
      // Maintenance windows pause polling entirely — without this exclusion
      // every in-window asset drifts into "stale polls" once past the grace.
      ...NOT_IN_MAINTENANCE,
      OR: [{ lastMonitorAt: null }, { lastMonitorAt: { lt: new Date(now - COARSE_FLOOR_MS) } }],
      ...idWhere(assetIds),
    },
    select: {
      id: true, hostname: true, ipAddress: true, lastMonitorAt: true,
      assetType: true, discoveredByIntegrationId: true,
      discoveredByIntegration: { select: { type: true } },
      monitorIntervalSec: true, cpuMemoryIntervalSec: true, temperatureIntervalSec: true,
      systemInfoIntervalSec: true, lldpIntervalSec: true, storageIntervalSec: true,
      probeTimeoutMs: true, dependencySuppressed: true,
    },
    orderBy: { lastMonitorAt: { sort: "asc", nulls: "first" } },
    take: limit == null ? undefined : 500,
  });

  const out: StalePoll[] = [];
  for (const a of candidates) {
    const eff = await resolveMonitorSettings({
      assetType: a.assetType,
      discoveredByIntegrationId: a.discoveredByIntegrationId,
      discoveredByIntegrationType: a.discoveredByIntegration?.type ?? null,
      monitorIntervalSec: a.monitorIntervalSec,
      cpuMemoryIntervalSec: a.cpuMemoryIntervalSec,
      temperatureIntervalSec: a.temperatureIntervalSec,
      systemInfoIntervalSec: a.systemInfoIntervalSec,
      lldpIntervalSec: a.lldpIntervalSec,
      storageIntervalSec: a.storageIntervalSec,
      probeTimeoutMs: a.probeTimeoutMs,
    });
    // Suppressed assets probe at 2× their interval (same rule as monitorAssets).
    const intervalSec = eff.intervalSeconds * (a.dependencySuppressed ? 2 : 1);
    const overdueMs = grace * intervalSec * 1000;
    const last = a.lastMonitorAt ? a.lastMonitorAt.getTime() : null;
    if (last === null || now - last >= overdueMs) {
      out.push({ id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, lastPolledAt: a.lastMonitorAt, expectedIntervalSec: intervalSec });
      if (limit != null && out.length >= limit) break;
    }
  }
  return severityFirst(await attachAlertSeverity(out, (r) => r.id));
}

export interface RebootRow { id: string; hostname: string | null; ipAddress: string | null; rebootedAt: Date; alertSeverity?: string; alertRank?: number }

/**
 * Feed 7 — recent reboots. Reads device.reboot Events emitted by the probe
 * path when an asset's sysUptime drops (see monitoringService reboot
 * detection). Event-backed so the widget never scans the hypertable.
 */
export async function getRecentReboots(sinceHours = 72, limit: number | null = 20, assetIds: string[] | null = null): Promise<RebootRow[]> {
  const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const events = await prisma.event.findMany({
    where: {
      action: "device.reboot",
      timestamp: { gte: cutoff },
      // device.reboot events carry resourceId = assetId; scope to the filtered set.
      ...(assetIds ? { resourceId: { in: assetIds } } : {}),
    },
    orderBy: { timestamp: "desc" },
    take: limit ?? undefined,
  });
  const out: RebootRow[] = events.map((e) => {
    const details = (e.details ?? {}) as Record<string, unknown>;
    return {
      id: e.resourceId ?? "",
      hostname: e.resourceName ?? (typeof details.hostname === "string" ? details.hostname : null),
      ipAddress: typeof details.ipAddress === "string" ? details.ipAddress : null,
      rebootedAt: e.timestamp,
    };
  });
  return severityFirst(await attachAlertSeverity(out, (r) => r.id || null));
}

export interface AlertRow { id: string; hostname: string | null; message: string; severity: string; raisedAt: Date }

/**
 * Feed 8 — active alerts. Recent warning/error Events (levelRank >= 1),
 * SEVERITY-FIRST (levelRank desc — errors above warnings), newest first within
 * a level. Backed by the [levelRank, timestamp] index; the 7-day Event
 * retention floors the scan automatically.
 */
export async function getRecentAlerts(limit: number | null = 30, assetIds: string[] | null = null): Promise<AlertRow[]> {
  const events = await prisma.event.findMany({
    where: {
      levelRank: { gte: 1 },
      // When filtered, scope to alerts about matching assets (resourceId =
      // assetId). Non-asset events (integration/system) drop out under a filter.
      ...(assetIds ? { resourceId: { in: assetIds } } : {}),
    },
    orderBy: [{ levelRank: "desc" }, { timestamp: "desc" }],
    take: limit ?? undefined,
  });
  return events.map((e) => ({
    id: e.id,
    hostname: e.resourceName ?? null,
    message: e.message ?? e.action,
    severity: e.level,
    raisedAt: e.timestamp,
  }));
}

export interface SiteWithIssues {
  site: string;
  division: string | null;
  downCount: number;
  warningCount: number;
  total: number;
  lat: number | null;
  lng: number | null;
  nodes: Array<{ id: string; hostname: string | null; monitorStatus: string | null }>;
  alertSeverity?: string;
  alertRank?: number;
}

/**
 * Feed 9 — sites with issues. One raw COALESCE groupBy over the monitored set
 * for the per-site counts + avg coordinates, then ONE bounded findMany to
 * attach the affected nodes. Two queries total, flat at 2000 assets.
 */
export async function getSitesWithIssues(maxSites: number | null = 25, assetIds: string[] | null = null): Promise<SiteWithIssues[]> {
  const idClause = assetIds ? ` AND "id" = ANY($2::text[])` : "";
  const siteParams: unknown[] = [maxSites];
  if (assetIds) siteParams.push(assetIds);
  const siteRows = await prisma.$queryRawUnsafe<Array<{
    site: string; down: bigint; warning: bigint; total: bigint; lat: number | null; lng: number | null;
  }>>(
    `SELECT COALESCE(NULLIF("location", ''), NULLIF("learnedLocation", ''), NULLIF("snmpLocation", ''), '(unknown)') AS site,
            count(*) FILTER (WHERE "monitorStatus" = 'down'    AND "status" <> 'maintenance') AS down,
            count(*) FILTER (WHERE "monitorStatus" = 'warning' AND "status" <> 'maintenance') AS warning,
            count(*) AS total,
            round(avg("latitude")::numeric, 4)::float8  AS lat,
            round(avg("longitude")::numeric, 4)::float8 AS lng
     FROM "assets"
     WHERE "monitored" = true AND "dependencySuppressed" = false${idClause}
     GROUP BY 1
     HAVING count(*) FILTER (WHERE "monitorStatus" IN ('down', 'warning') AND "status" <> 'maintenance') > 0
     ORDER BY down DESC, warning DESC
     LIMIT $1`,
    ...siteParams,
  );
  if (siteRows.length === 0) return [];

  // Pull the affected (down/warning) nodes for these sites in one query, then
  // bucket by site. Bounded by the issue set, not the whole fleet.
  const nodeRows = await prisma.asset.findMany({
    where: { monitored: true, dependencySuppressed: false, monitorStatus: { in: ["down", "warning"] }, ...NOT_IN_MAINTENANCE, ...idWhere(assetIds) },
    select: {
      id: true, hostname: true, monitorStatus: true,
      location: true, learnedLocation: true, snmpLocation: true, department: true,
    },
  });
  const nodesBySite = new Map<string, SiteWithIssues["nodes"]>();
  const divisionBySite = new Map<string, string | null>();
  for (const n of nodeRows) {
    const s = siteOf(n);
    if (!nodesBySite.has(s)) { nodesBySite.set(s, []); divisionBySite.set(s, n.department); }
    nodesBySite.get(s)!.push({ id: n.id, hostname: n.hostname, monitorStatus: n.monitorStatus });
  }

  const sites: SiteWithIssues[] = siteRows.map((r) => ({
    site: r.site,
    division: divisionBySite.get(r.site) ?? null,
    downCount: Number(r.down),
    warningCount: Number(r.warning),
    total: Number(r.total),
    lat: r.lat,
    lng: r.lng,
    nodes: nodesBySite.get(r.site) ?? [],
  }));
  // Per-site severity = the highest active alert across the site's affected
  // nodes; sites with alerted nodes lead, then the down/warning ordering holds.
  const sev = await activeAlertSeverityByAsset(nodeRows.map((n) => n.id));
  for (const s of sites) {
    let best: { severity: string; rank: number } | null = null;
    for (const n of s.nodes) {
      const x = sev.get(n.id);
      if (x && (!best || x.rank > best.rank)) best = x;
    }
    if (best) { s.alertSeverity = best.severity; s.alertRank = best.rank; }
    else s.alertRank = 0;
  }
  return sites.slice().sort((a, b) => (b.alertRank ?? 0) - (a.alertRank ?? 0));
}

export interface FilterOptions {
  assetTypes: string[];
  regions: string[];
}

/**
 * Options for the NOC dashboard's global filters:
 *   - assetTypes: the built-in asset types actually present in the fleet, in
 *     the canonical built-in order. Only built-ins are returned because the
 *     per-widget `assetTypes` filter (resolveFilteredAssetIds) toggles built-ins
 *     — custom types are always shown and aren't meaningful filter entries.
 *   - regions: distinct `region:<name>` tag values across the live fleet, the
 *     same tags the `regionTags` filter matches. Sorted.
 * Two cheap queries; safe for a read-only NOC kiosk token.
 */
export async function getFilterOptions(): Promise<FilterOptions> {
  const [typeRows, regionRows] = await Promise.all([
    prisma.asset.findMany({
      where: { status: { notIn: ["decommissioned", "disabled"] } },
      select: { assetType: true },
      distinct: ["assetType"],
    }),
    prisma.$queryRaw<Array<{ region: string }>>`
      SELECT DISTINCT substring(t from 8) AS region
      FROM "assets", unnest("tags") AS t
      WHERE t LIKE 'region:%'
        AND "status" NOT IN ('decommissioned', 'disabled')
      ORDER BY region`,
  ]);
  const present = new Set(typeRows.map((r) => r.assetType));
  return {
    assetTypes: BUILTIN_ASSET_TYPES.filter((t) => present.has(t)),
    regions: regionRows.map((r) => r.region).filter(Boolean),
  };
}

// ─── Per-feed payload assembly + short-TTL cache ─────────────────────────────

export const NOC_FEED_NAMES = [
  "status", "downNodes", "downInterfaces", "downIpsecTunnels",
  "topCpu", "topMemory", "slowestResponse", "packetLoss", "diskUsage", "temperature",
  "stalePolls", "sitesWithIssues", "recentReboots", "activeAlerts",
] as const;
export type NocFeedName = (typeof NOC_FEED_NAMES)[number];

const EMPTY_STATUS: StatusSummary = {
  statusCounts: { total: 0, up: 0, down: 0, warning: 0, unknown: 0, recovering: 0, maintenance: 0 },
  uptimePercent: null,
  activeAlertCount: 0,
};

/**
 * Feed registry. Per feed:
 *   gate    — which read permission covers it (asset- vs Event-sourced)
 *   empty   — the value a denied caller gets (filter-don't-403 contract)
 *   run     — compute the response value; L(n) resolves the caller's row cap
 *             (?limit=N clamped by the route) against the feed's default;
 *             `samples` is the caller's per-asset averaging count (?samples=,
 *             default DEFAULT_TOPN_SAMPLE_COUNT) — only the usesSamples feeds
 *             consume it (and only those include it in their cache key)
 *   flatten — map the feed value onto response keys. Default is {[feed]: v};
 *             `status` fans out to three top-level keys and `downNodes`
 *             unwraps `.nodes`, both preserved from the pre-feeds response
 *             shape so existing consumers (and the kiosk token) see no change.
 */
const NOC_FEEDS: Record<NocFeedName, {
  gate: "assets" | "events";
  empty: unknown;
  usesSamples?: true;
  run: (L: (n: number) => number | null, assetIds: string[] | null, samples: number) => Promise<unknown>;
  flatten?: (value: unknown) => Record<string, unknown>;
}> = {
  status: {
    gate: "assets",
    empty: EMPTY_STATUS,
    run: (_L, ids) => getStatusSummary(ids),
    flatten: (v) => {
      const s = v as StatusSummary;
      return { statusCounts: s.statusCounts, uptimePercent: s.uptimePercent, activeAlertCount: s.activeAlertCount };
    },
  },
  downNodes: {
    gate: "assets",
    empty: { nodes: [], total: 0 },
    run: (L, ids) => getDownNodes(L(100), ids),
    // downNodesTotal is the TRUE down count (uncapped) for the widget's
    // header pill; downNodes[] stays the capped list (legacy key unchanged).
    flatten: (v) => {
      const d = v as { nodes: DownNode[]; total: number };
      return { downNodes: d.nodes, downNodesTotal: d.total };
    },
  },
  downInterfaces:   { gate: "assets", empty: [], run: (L, ids) => getDownInterfaces(L(100), 240, ids) },
  downIpsecTunnels: { gate: "assets", empty: [], run: (L, ids) => getDownIpsecTunnels(L(100), 240, ids) },
  topCpu:           { gate: "assets", empty: [], usesSamples: true, run: (L, ids, samples) => getHighestCpu(L(100), 60, ids, samples) },
  topMemory:        { gate: "assets", empty: [], usesSamples: true, run: (L, ids, samples) => getHighestMemory(L(100), 60, ids, samples) },
  slowestResponse:  { gate: "assets", empty: [], run: (L, ids) => getSlowestResponse(L(100), ids) },
  packetLoss:       { gate: "assets", empty: [], run: (L, ids) => getPacketLoss(L(100), 15, ids) },
  diskUsage:        { gate: "assets", empty: [], run: (L, ids) => getHighestDiskUsage(L(100), ids) },
  temperature:      { gate: "assets", empty: [], run: (L, ids) => getHighestTemperature(L(100), ids) },
  stalePolls:       { gate: "assets", empty: [], run: (L, ids) => getStalePolls(3, L(50), ids) },
  sitesWithIssues:  { gate: "assets", empty: [], run: (L, ids) => getSitesWithIssues(L(25), ids) },
  recentReboots:    { gate: "events", empty: [], run: (L, ids) => getRecentReboots(72, L(20), ids) },
  activeAlerts:     { gate: "events", empty: [], run: (L, ids) => getRecentAlerts(L(30), ids) },
};

// 10s: below the frontend's 15s memo, so a widget's own refresh timer never
// sees data older than ~25s, while every concurrent viewer (multiple NOC
// walls / operator tabs) shares one computation of each hypertable scan.
export const NOC_FEED_CACHE_TTL_MS = 10_000;
const nocFeedCache = createTtlCache<unknown>({ ttlMs: NOC_FEED_CACHE_TTL_MS, maxEntries: 512 });

/** Test hook — drop every cached feed/filter entry. */
export function clearNocFeedCache(): void {
  nocFeedCache.invalidate();
}

function filterCacheKey(assetTypes: string[] | null, regionNames: string[] | null): string {
  const t = (assetTypes ?? []).slice().sort().join(",");
  const r = (regionNames ?? []).slice().sort().join(",");
  return t + "|" + r;
}

/**
 * Assemble the /noc-summary response. `feeds` narrows to the named subset
 * (unknown names are dropped silently, mirroring the source-type param
 * convention); null = every feed (the pre-feeds full payload, byte-identical
 * shape). Permission-denied feeds come back as their empty value, never 403.
 * Each (feed, filter, cap[, samples]) computation goes through the shared TTL
 * cache, as does the filter→assetIds resolution.
 */
export async function getNocSummaryPayload(opts: {
  feeds: string[] | null;
  canAssets: boolean;
  canEvents: boolean;
  assetTypes: string[] | null;
  regionNames: string[] | null;
  capLimit: number | null;
  sampleCount?: number | null;
}): Promise<Record<string, unknown>> {
  const requested: NocFeedName[] = opts.feeds === null
    ? [...NOC_FEED_NAMES]
    : opts.feeds.filter((f): f is NocFeedName => Object.prototype.hasOwnProperty.call(NOC_FEEDS, f));

  const fKey = filterCacheKey(opts.assetTypes, opts.regionNames);
  const allowed = (gate: "assets" | "events") => (gate === "assets" ? opts.canAssets : opts.canEvents);

  // Resolve the per-widget filter to asset ids once (cached — the id set backs
  // every feed sharing the filter). Skipped when no feed will run.
  let assetIds: string[] | null = null;
  if (requested.some((f) => allowed(NOC_FEEDS[f].gate))) {
    assetIds = (await nocFeedCache.getOrCompute("ids|" + fKey, () =>
      resolveFilteredAssetIds({ assetTypes: opts.assetTypes, regionNames: opts.regionNames }),
    )) as string[] | null;
  }

  const L = (n: number): number | null => opts.capLimit ?? n;
  const samples = clampSampleCount(opts.sampleCount);
  const out: Record<string, unknown> = {};
  await Promise.all(requested.map(async (feed) => {
    const def = NOC_FEEDS[feed];
    // Only sample-averaged feeds key on `samples`, so a ?samples= request
    // doesn't fragment the cache for feeds the param can't affect.
    const key = feed + "|" + (opts.capLimit ?? "") + "|" + (def.usesSamples ? samples : "") + "|" + fKey;
    const value = allowed(def.gate)
      ? await nocFeedCache.getOrCompute(key, () => def.run(L, assetIds, samples))
      : def.empty;
    Object.assign(out, def.flatten ? def.flatten(value) : { [feed]: value });
  }));
  return out;
}
