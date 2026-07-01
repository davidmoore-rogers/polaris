/**
 * src/services/nocDashboardService.ts
 *
 * Fleet-wide aggregates backing the NOC dashboard widgets (the SolarWinds
 * wall-display recreation). Each function answers one widget's question over
 * the whole monitored fleet; the route layer (dashboard.ts /noc-summary)
 * fans them out in one Promise.all and permission-filters per section.
 *
 * Scale: every query here is designed to stay flat from 100 to 2000 monitored
 * assets — groupBy / count / one windowed raw aggregate / one bounded findMany,
 * never a per-row await loop. The sample tables (asset_telemetry_samples,
 * asset_monitor_samples) are TimescaleDB hypertables: we ONLY read them, and
 * the time-window predicate keeps each scan inside recent (chunk-excluded)
 * data.
 */

import { prisma } from "../db.js";
import { resolveMonitorSettings } from "./monitoringService.js";

// Asset types treated as "infrastructure" for the uptime % gauge — mirrors the
// SolarWinds Fortinet-only uptime tile. These are the built-in network-gear
// types; custom operator types fall outside the gauge by design.
const INFRA_ASSET_TYPES = ["firewall", "switch", "router", "access_point"];

// monitorAlerts (and therefore the active-alert count) is defined as monitored
// assets currently in warning/down that aren't dependency-suppressed — kept
// byte-identical to the /summary monitorAlerts where-clause so the tile count
// and the alert list never disagree.
const ALERT_WHERE = {
  monitored: true,
  monitorStatus: { in: ["warning", "down"] },
  dependencySuppressed: false,
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

export interface StatusSummary {
  statusCounts: { total: number; up: number; down: number; warning: number; unknown: number; recovering: number };
  uptimePercent: number | null;
  activeAlertCount: number;
}

/**
 * Feed 1 — status tiles. Two groupBys + one count, all backed by
 * @@index([monitored]). Constant query cost regardless of fleet size.
 */
export async function getStatusSummary(assetIds: string[] | null = null): Promise<StatusSummary> {
  const idf = idWhere(assetIds);
  const [byStatus, infraByStatus, activeAlertCount] = await Promise.all([
    prisma.asset.groupBy({
      by: ["monitorStatus"],
      _count: { _all: true },
      where: { monitored: true, ...idf },
    }),
    prisma.asset.groupBy({
      by: ["monitorStatus"],
      _count: { _all: true },
      where: { monitored: true, assetType: { in: INFRA_ASSET_TYPES }, ...idf },
    }),
    prisma.asset.count({ where: { ...ALERT_WHERE, ...idf } }),
  ]);

  const counts = { total: 0, up: 0, down: 0, warning: 0, unknown: 0, recovering: 0 };
  for (const row of byStatus) {
    const n = row._count._all;
    counts.total += n;
    const key = (row.monitorStatus ?? "unknown") as keyof typeof counts;
    if (key in counts && key !== "total") counts[key] += n;
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
}

function siteOf(a: { location: string | null; learnedLocation: string | null; snmpLocation: string | null }): string {
  return a.location || a.learnedLocation || a.snmpLocation || "(unknown)";
}

/**
 * Feed 2 — down nodes. One indexed findMany over the (small) down subset;
 * site coalesce done in JS because Prisma groupBy can't COALESCE three
 * nullable columns. dependencySuppressed:false so a down parent's suppressed
 * children don't show as independent outages.
 */
export async function getDownNodes(limit = 100, assetIds: string[] | null = null): Promise<{ nodes: DownNode[]; total: number }> {
  const rows = await prisma.asset.findMany({
    where: { monitored: true, monitorStatus: "down", dependencySuppressed: false, ...idWhere(assetIds) },
    select: {
      id: true, hostname: true, ipAddress: true, assetType: true,
      location: true, learnedLocation: true, snmpLocation: true,
      department: true, monitorStatus: true, monitorStatusChangedAt: true,
    },
    orderBy: [{ monitorStatusChangedAt: { sort: "asc", nulls: "last" } }],
    take: limit,
  });
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
  return { nodes, total: nodes.length };
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
 * grouped by the gate they live on. Two queries, flat at 2000 assets:
 *   1. ONE windowed single-pass CTE over asset_interface_samples: latest sample
 *      per (asset, ifName) via row_number(), plus each interface's last "up"
 *      timestamp via a filtered window aggregate (for the "down for" duration).
 *      The time window keeps the hypertable scan inside recent (chunk-excluded)
 *      data; interface samples only exist for interface-polled assets (a
 *      network-gear subset), so the scan stays small. The 4h default window
 *      comfortably contains the latest full interface scrape at the default
 *      600s systemInfo cadence even when an operator slows it.
 *   2. ONE findMany over the (small) set of assets that own a down interface,
 *      scoped to monitored + non-suppressed — an interface whose owning asset
 *      is unmonitored / suppressed / decommissioned drops out here (those assets
 *      stop being monitored, so only stale samples linger).
 */
export async function getDownInterfaces(limit = 100, sinceMinutes = 240, assetIds: string[] | null = null): Promise<DownInterface[]> {
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
       WHERE s."timestamp" > now() - ($1 || ' minutes')::interval${idClause}
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
    where: { id: { in: ids }, monitored: true, dependencySuppressed: false },
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
  return out;
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
}

/**
 * Feed 2c — down IPsec tunnels. Phase-1 tunnels whose every phase-2 selector is
 * down (status='down'), grouped by the gate they live on, each carrying the
 * parent physical interface the tunnel rides (the FortiOS phase1-interface WAN
 * port) so a NOC operator sees which uplink took the tunnel down. Same
 * shape/scale as getDownInterfaces: one windowed single-pass CTE over
 * asset_ipsec_tunnel_samples (latest-per-(asset,tunnelName) + last-up
 * timestamp) then a monitored/non-suppressed hydrate findMany. FortiGate-only
 * data; the 4h window covers the system-info scrape cadence. `partial`/`dynamic`
 * tunnels are intentionally excluded — only a fully-down tunnel is an outage.
 */
export async function getDownIpsecTunnels(limit = 100, sinceMinutes = 240, assetIds: string[] | null = null): Promise<DownIpsecTunnel[]> {
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
       WHERE s."timestamp" > now() - ($1 || ' minutes')::interval${idClause}
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
    where: { id: { in: ids }, monitored: true, dependencySuppressed: false },
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
  return out;
}

export interface TopNRow { id: string; hostname: string | null; ipAddress: string | null; value: number; detail?: string }

// Hydrate a list of assetIds (preserving the incoming order) with display
// names in ONE findMany — never a per-row lookup.
async function hydrateNames(ordered: Array<{ assetId: string; value: number }>): Promise<TopNRow[]> {
  if (ordered.length === 0) return [];
  const ids = ordered.map((r) => r.assetId);
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: { id: true, hostname: true, ipAddress: true },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  return ordered
    .map((r) => {
      const a = byId.get(r.assetId);
      if (!a) return null;
      return { id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, value: r.value };
    })
    .filter((r): r is TopNRow => r !== null);
}

/**
 * Feed 3a — highest CPU. DISTINCT ON latest-per-asset within the freshness
 * window, ordered desc, capped. The time predicate keeps the scan inside
 * recent Timescale chunks (~one telemetry sample per asset per cadence).
 * Pattern mirrors sampleHistoryService.readSdwanMembers.
 */
export async function getHighestCpu(limit = 100, sinceMinutes = 60, assetIds: string[] | null = null): Promise<TopNRow[]> {
  // Average of each asset's most-recent 10 CPU samples (smooths the single-spike
  // ranking the DISTINCT-ON latest-value version surfaced). 1h window keeps the
  // telemetry-hypertable scan chunk-excluded and comfortably contains 10 samples
  // at the cpuMemory cadence; row_number()<=10 takes the newest 10 per asset.
  const idClause = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; value: number }>>(
    `WITH recent AS (
       SELECT s."assetId" AS "assetId", s."cpuPct" AS v,
              row_number() OVER (PARTITION BY s."assetId" ORDER BY s."timestamp" DESC) AS rn
       FROM "asset_telemetry_samples" s
       WHERE s."timestamp" > now() - ($1 || ' minutes')::interval AND s."cpuPct" IS NOT NULL${idClause}
     )
     SELECT "assetId", avg(v)::float AS value
     FROM recent WHERE rn <= 10
     GROUP BY "assetId"
     ORDER BY value DESC LIMIT $2`,
    ...params,
  );
  return hydrateNames(rows.map((r) => ({ assetId: r.assetId, value: Math.round(r.value * 10) / 10 })));
}

/**
 * Feed 3b — highest memory, averaged over each asset's most-recent 10 samples
 * (same windowed pattern as CPU). Prefers memPct; falls back to bytes ratio
 * when only absolute bytes were reported (same preference as sampleHistoryService).
 */
export async function getHighestMemory(limit = 100, sinceMinutes = 60, assetIds: string[] | null = null): Promise<TopNRow[]> {
  const idClause = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; value: number }>>(
    `WITH recent AS (
       SELECT s."assetId" AS "assetId",
              COALESCE(s."memPct", s."memUsedBytes"::float / NULLIF(s."memTotalBytes", 0) * 100) AS v,
              row_number() OVER (PARTITION BY s."assetId" ORDER BY s."timestamp" DESC) AS rn
       FROM "asset_telemetry_samples" s
       WHERE s."timestamp" > now() - ($1 || ' minutes')::interval
         AND (s."memPct" IS NOT NULL OR (s."memUsedBytes" IS NOT NULL AND s."memTotalBytes" IS NOT NULL))${idClause}
     )
     SELECT "assetId", avg(v)::float AS value
     FROM recent WHERE rn <= 10 AND v IS NOT NULL
     GROUP BY "assetId"
     ORDER BY value DESC LIMIT $2`,
    ...params,
  );
  return hydrateNames(rows.map((r) => ({ assetId: r.assetId, value: Math.round(r.value * 10) / 10 })));
}

/**
 * Feed 4 — slowest response. Reads the already-maintained
 * Asset.lastResponseTimeMs (stamped by recordProbeResult) — fresher and far
 * cheaper than scanning the monitor-sample hypertable.
 */
export async function getSlowestResponse(limit = 100, assetIds: string[] | null = null, sinceMinutes = 360): Promise<TopNRow[]> {
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
       WHERE "timestamp" > now() - ($1 || ' minutes')::interval
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
  return hydrateNames(ordered);
}

/**
 * Feed 4b — highest disk usage, PER VOLUME (one row per (asset, mountPath) at
 * its latest sample's used %). Ranks the fullest filesystems across the fleet
 * so a NOC operator sees what's about to fill up. Each row's `detail` carries
 * the mount path (the bar widget shows it beside the hostname). DISTINCT-ON
 * latest-per-(asset,mount) over asset_storage_samples; the window is wide (48h
 * default) because the full storage scrape rides the 24h "slow" cadence.
 */
export async function getHighestDiskUsage(limit = 100, assetIds: string[] | null = null, sinceMinutes = 2880): Promise<TopNRow[]> {
  const idClause = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; mountPath: string; pct: number }>>(
    `SELECT "assetId", "mountPath", pct FROM (
       SELECT DISTINCT ON (s."assetId", s."mountPath")
              s."assetId" AS "assetId", s."mountPath" AS "mountPath",
              s."usedBytes"::float / s."totalBytes"::float * 100 AS pct
       FROM "asset_storage_samples" s
       WHERE s."timestamp" > now() - ($1 || ' minutes')::interval
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
    select: { id: true, hostname: true, ipAddress: true },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  return rows
    .map((r): TopNRow | null => {
      const a = byId.get(r.assetId);
      if (!a) return null;
      return { id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, value: Math.round(r.pct * 10) / 10, detail: r.mountPath };
    })
    .filter((r): r is TopNRow => r !== null);
}

/**
 * Feed 5 (data-gap Option A) — packet loss = failed-probe ratio over the
 * window. One windowed groupBy over asset_monitor_samples; no schema change.
 * (True per-probe loss% via multi-ping is a documented follow-up.)
 */
export async function getPacketLoss(limit = 100, sinceMinutes = 15, assetIds: string[] | null = null): Promise<TopNRow[]> {
  const idClause = assetIds ? ` AND "assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; total: bigint; failed: bigint }>>(
    `SELECT "assetId", count(*) AS total, count(*) FILTER (WHERE NOT "success") AS failed
     FROM "asset_monitor_samples"
     WHERE "timestamp" > now() - ($1 || ' minutes')::interval${idClause}
     GROUP BY "assetId"
     HAVING count(*) FILTER (WHERE NOT "success") > 0
     ORDER BY (count(*) FILTER (WHERE NOT "success"))::float / count(*) DESC
     LIMIT $2`,
    ...params,
  );
  const ordered = rows.map((r) => ({
    assetId: r.assetId,
    value: Math.round((Number(r.failed) / Number(r.total)) * 1000) / 10,
  }));
  return hydrateNames(ordered);
}

export interface StalePoll { id: string; hostname: string | null; ipAddress: string | null; lastPolledAt: Date | null; expectedIntervalSec: number }

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
export async function getStalePolls(grace = 3, limit = 50, assetIds: string[] | null = null): Promise<StalePoll[]> {
  // Coarse pre-filter: anything not polled within COARSE_FLOOR can't be fresh
  // for any realistic interval. Bounds Stage B's candidate set.
  const COARSE_FLOOR_MS = 5 * 60 * 1000; // 5 min — below the shortest sane cadence × grace
  const now = Date.now();
  const candidates = await prisma.asset.findMany({
    where: {
      monitored: true,
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
    take: 500,
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
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface RebootRow { id: string; hostname: string | null; ipAddress: string | null; rebootedAt: Date }

/**
 * Feed 7 — recent reboots. Reads device.reboot Events emitted by the probe
 * path when an asset's sysUptime drops (see monitoringService reboot
 * detection). Event-backed so the widget never scans the hypertable.
 */
export async function getRecentReboots(sinceHours = 72, limit = 20, assetIds: string[] | null = null): Promise<RebootRow[]> {
  const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const events = await prisma.event.findMany({
    where: {
      action: "device.reboot",
      timestamp: { gte: cutoff },
      // device.reboot events carry resourceId = assetId; scope to the filtered set.
      ...(assetIds ? { resourceId: { in: assetIds } } : {}),
    },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
  return events.map((e) => {
    const details = (e.details ?? {}) as Record<string, unknown>;
    return {
      id: e.resourceId ?? "",
      hostname: e.resourceName ?? (typeof details.hostname === "string" ? details.hostname : null),
      ipAddress: typeof details.ipAddress === "string" ? details.ipAddress : null,
      rebootedAt: e.timestamp,
    };
  });
}

export interface AlertRow { id: string; hostname: string | null; message: string; severity: string; raisedAt: Date }

/**
 * Feed 8 — active alerts. Recent warning/error Events (levelRank >= 1), newest
 * first. Backed by the [levelRank, timestamp] index; the 7-day Event retention
 * floors the scan automatically.
 */
export async function getRecentAlerts(limit = 30, assetIds: string[] | null = null): Promise<AlertRow[]> {
  const events = await prisma.event.findMany({
    where: {
      levelRank: { gte: 1 },
      // When filtered, scope to alerts about matching assets (resourceId =
      // assetId). Non-asset events (integration/system) drop out under a filter.
      ...(assetIds ? { resourceId: { in: assetIds } } : {}),
    },
    orderBy: { timestamp: "desc" },
    take: limit,
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
}

/**
 * Feed 9 — sites with issues. One raw COALESCE groupBy over the monitored set
 * for the per-site counts + avg coordinates, then ONE bounded findMany to
 * attach the affected nodes. Two queries total, flat at 2000 assets.
 */
export async function getSitesWithIssues(maxSites = 25, assetIds: string[] | null = null): Promise<SiteWithIssues[]> {
  const idClause = assetIds ? ` AND "id" = ANY($2::text[])` : "";
  const siteParams: unknown[] = [maxSites];
  if (assetIds) siteParams.push(assetIds);
  const siteRows = await prisma.$queryRawUnsafe<Array<{
    site: string; down: bigint; warning: bigint; total: bigint; lat: number | null; lng: number | null;
  }>>(
    `SELECT COALESCE(NULLIF("location", ''), NULLIF("learnedLocation", ''), NULLIF("snmpLocation", ''), '(unknown)') AS site,
            count(*) FILTER (WHERE "monitorStatus" = 'down')    AS down,
            count(*) FILTER (WHERE "monitorStatus" = 'warning') AS warning,
            count(*) AS total,
            round(avg("latitude")::numeric, 4)::float8  AS lat,
            round(avg("longitude")::numeric, 4)::float8 AS lng
     FROM "assets"
     WHERE "monitored" = true AND "dependencySuppressed" = false${idClause}
     GROUP BY 1
     HAVING count(*) FILTER (WHERE "monitorStatus" IN ('down', 'warning')) > 0
     ORDER BY down DESC, warning DESC
     LIMIT $1`,
    ...siteParams,
  );
  if (siteRows.length === 0) return [];

  // Pull the affected (down/warning) nodes for these sites in one query, then
  // bucket by site. Bounded by the issue set, not the whole fleet.
  const nodeRows = await prisma.asset.findMany({
    where: { monitored: true, dependencySuppressed: false, monitorStatus: { in: ["down", "warning"] }, ...idWhere(assetIds) },
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

  return siteRows.map((r) => ({
    site: r.site,
    division: divisionBySite.get(r.site) ?? null,
    downCount: Number(r.down),
    warningCount: Number(r.warning),
    total: Number(r.total),
    lat: r.lat,
    lng: r.lng,
    nodes: nodesBySite.get(r.site) ?? [],
  }));
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
 * Two cheap queries; safe for a dashboard:read token.
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
