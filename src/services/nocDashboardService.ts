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

export interface StatusSummary {
  statusCounts: { total: number; up: number; down: number; warning: number; unknown: number; recovering: number };
  uptimePercent: number | null;
  activeAlertCount: number;
}

/**
 * Feed 1 — status tiles. Two groupBys + one count, all backed by
 * @@index([monitored]). Constant query cost regardless of fleet size.
 */
export async function getStatusSummary(): Promise<StatusSummary> {
  const [byStatus, infraByStatus, activeAlertCount] = await Promise.all([
    prisma.asset.groupBy({
      by: ["monitorStatus"],
      _count: { _all: true },
      where: { monitored: true },
    }),
    prisma.asset.groupBy({
      by: ["monitorStatus"],
      _count: { _all: true },
      where: { monitored: true, assetType: { in: INFRA_ASSET_TYPES } },
    }),
    prisma.asset.count({ where: ALERT_WHERE }),
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
export async function getDownNodes(limit = 100): Promise<{ nodes: DownNode[]; total: number }> {
  const rows = await prisma.asset.findMany({
    where: { monitored: true, monitorStatus: "down", dependencySuppressed: false },
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

export interface TopNRow { id: string; hostname: string | null; ipAddress: string | null; value: number }

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
export async function getHighestCpu(limit = 10, sinceMinutes = 10): Promise<TopNRow[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; value: number }>>(
    `SELECT "assetId", value FROM (
       SELECT DISTINCT ON (s."assetId") s."assetId" AS "assetId", s."cpuPct" AS value
       FROM "asset_telemetry_samples" s
       WHERE s."timestamp" > now() - ($1 || ' minutes')::interval AND s."cpuPct" IS NOT NULL
       ORDER BY s."assetId", s."timestamp" DESC
     ) latest ORDER BY value DESC LIMIT $2`,
    String(sinceMinutes), limit,
  );
  return hydrateNames(rows.map((r) => ({ assetId: r.assetId, value: Math.round(r.value * 10) / 10 })));
}

/**
 * Feed 3b — highest memory. Prefers memPct; falls back to bytes ratio when
 * only absolute bytes were reported (same preference as sampleHistoryService).
 */
export async function getHighestMemory(limit = 10, sinceMinutes = 10): Promise<TopNRow[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; value: number }>>(
    `SELECT "assetId", value FROM (
       SELECT DISTINCT ON (s."assetId") s."assetId" AS "assetId",
              COALESCE(s."memPct", s."memUsedBytes"::float / NULLIF(s."memTotalBytes", 0) * 100) AS value
       FROM "asset_telemetry_samples" s
       WHERE s."timestamp" > now() - ($1 || ' minutes')::interval
         AND (s."memPct" IS NOT NULL OR (s."memUsedBytes" IS NOT NULL AND s."memTotalBytes" IS NOT NULL))
       ORDER BY s."assetId", s."timestamp" DESC
     ) latest WHERE value IS NOT NULL ORDER BY value DESC LIMIT $2`,
    String(sinceMinutes), limit,
  );
  return hydrateNames(rows.map((r) => ({ assetId: r.assetId, value: Math.round(r.value * 10) / 10 })));
}

/**
 * Feed 4 — slowest response. Reads the already-maintained
 * Asset.lastResponseTimeMs (stamped by recordProbeResult) — fresher and far
 * cheaper than scanning the monitor-sample hypertable.
 */
export async function getSlowestResponse(limit = 10): Promise<TopNRow[]> {
  const rows = await prisma.asset.findMany({
    where: { monitored: true, lastResponseTimeMs: { not: null } },
    select: { id: true, hostname: true, ipAddress: true, lastResponseTimeMs: true },
    orderBy: { lastResponseTimeMs: "desc" },
    take: limit,
  });
  return rows.map((a) => ({ id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, value: a.lastResponseTimeMs ?? 0 }));
}

/**
 * Feed 5 (data-gap Option A) — packet loss = failed-probe ratio over the
 * window. One windowed groupBy over asset_monitor_samples; no schema change.
 * (True per-probe loss% via multi-ping is a documented follow-up.)
 */
export async function getPacketLoss(limit = 10, sinceMinutes = 15): Promise<TopNRow[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; total: bigint; failed: bigint }>>(
    `SELECT "assetId", count(*) AS total, count(*) FILTER (WHERE NOT "success") AS failed
     FROM "asset_monitor_samples"
     WHERE "timestamp" > now() - ($1 || ' minutes')::interval
     GROUP BY "assetId"
     HAVING count(*) FILTER (WHERE NOT "success") > 0
     ORDER BY (count(*) FILTER (WHERE NOT "success"))::float / count(*) DESC
     LIMIT $2`,
    String(sinceMinutes), limit,
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
export async function getStalePolls(grace = 3, limit = 50): Promise<StalePoll[]> {
  // Coarse pre-filter: anything not polled within COARSE_FLOOR can't be fresh
  // for any realistic interval. Bounds Stage B's candidate set.
  const COARSE_FLOOR_MS = 5 * 60 * 1000; // 5 min — below the shortest sane cadence × grace
  const now = Date.now();
  const candidates = await prisma.asset.findMany({
    where: {
      monitored: true,
      OR: [{ lastMonitorAt: null }, { lastMonitorAt: { lt: new Date(now - COARSE_FLOOR_MS) } }],
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
export async function getRecentReboots(sinceHours = 72, limit = 20): Promise<RebootRow[]> {
  const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const events = await prisma.event.findMany({
    where: { action: "device.reboot", timestamp: { gte: cutoff } },
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
export async function getRecentAlerts(limit = 30): Promise<AlertRow[]> {
  const events = await prisma.event.findMany({
    where: { levelRank: { gte: 1 } },
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
export async function getSitesWithIssues(maxSites = 25): Promise<SiteWithIssues[]> {
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
     WHERE "monitored" = true AND "dependencySuppressed" = false
     GROUP BY 1
     HAVING count(*) FILTER (WHERE "monitorStatus" IN ('down', 'warning')) > 0
     ORDER BY down DESC, warning DESC
     LIMIT $1`,
    maxSites,
  );
  if (siteRows.length === 0) return [];

  // Pull the affected (down/warning) nodes for these sites in one query, then
  // bucket by site. Bounded by the issue set, not the whole fleet.
  const nodeRows = await prisma.asset.findMany({
    where: { monitored: true, dependencySuppressed: false, monitorStatus: { in: ["down", "warning"] } },
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
