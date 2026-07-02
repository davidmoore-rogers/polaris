/**
 * src/api/routes/dashboard.ts
 *
 * Single endpoint that backs the new Dashboard home page in one round-trip:
 *   - blockUtilization:  per-block address allocation (reused from utilizationService)
 *   - recentReservations: most recent 10 manual (user-created) reservations
 *   - assetTypeCounts:   counts per AssetType excluding decommissioned/disabled
 *   - monitorAlerts:     monitored assets currently in warning/down state,
 *                         oldest transition first, capped at 50
 */

import { Router } from "express";
import { prisma } from "../../db.js";
import * as utilizationService from "../../services/utilizationService.js";
import * as nocDashboardService from "../../services/nocDashboardService.js";
import { ensureSessionRoleSnapshot, hasPermission } from "../middleware/permissions.js";

const router = Router();

const MONITOR_ALERT_CAP = 50;

// Recognized reservation source types — the same enum the Reservation
// model carries. Anything in the query that isn't one of these is dropped
// silently so a typo doesn't error out the whole summary.
const RESERVATION_SOURCE_TYPES = new Set([
  "manual",
  "dhcp_reservation",
  "dhcp_lease",
  "interface_ip",
  "vip",
  "fortiswitch",
  "fortinap",
  "fortimanager",
  "fortigate",
  "dns_resolved",
]);

function parseSourceTypesParam(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const validated = parts.filter((s) => RESERVATION_SOURCE_TYPES.has(s));
  // Caller asked for a filter but every value was unrecognized — match the
  // server-side empty-array convention (= no filter) so the widget still
  // gets data rather than 0 rows.
  return validated.length === 0 ? [] : validated;
}

router.get("/summary", async (req, res, next) => {
  try {
    // Filter, don't 403: the dashboard is the redirect target for users
    // bounced off gated pages, so it must render for every role. Each widget
    // section is gated on the read access of the function that owns its data;
    // denied sections come back as empty arrays with the response shape
    // unchanged. Bearer-token callers have no role snapshot → all-empty.
    await ensureSessionRoleSnapshot(req);
    const canBlocks       = hasPermission(req, "ipBlocks", "read");
    const canReservations = hasPermission(req, "reservations", "read");
    const canAssets       = hasPermission(req, "assets", "read");

    const sourceTypes = parseSourceTypesParam(req.query.recentSourceTypes);
    // recentReservations row cap: absent → default 10; "0" → null (No Limit,
    // server sends everything); any other positive int → that cap.
    const recentLimit = parseRecentLimitParam(req.query.recentLimit);
    const emptyAssetRows: never[] = [];
    const [global, recentReservations, assetTypeCountsRaw, monitorAlertsRaw] = await Promise.all([
      canBlocks
        ? utilizationService.getGlobalUtilization()
        : Promise.resolve({ blockUtilization: [] }),
      canReservations
        ? utilizationService.getRecentManualReservations(recentLimit, sourceTypes)
        : Promise.resolve([]),
      canAssets ? prisma.asset.groupBy({
        by: ["assetType"],
        _count: { _all: true },
        where: { status: { notIn: ["decommissioned", "disabled"] } },
      }) : Promise.resolve(emptyAssetRows),
      canAssets ? prisma.asset.findMany({
        where: {
          monitored: true,
          monitorStatus: { in: ["warning", "down"] },
          dependencySuppressed: false,
        },
        select: {
          id: true,
          hostname: true,
          ipAddress: true,
          assetType: true,
          monitorStatus: true,
          monitorStatusChangedAt: true,
          discoveredByIntegration: { select: { name: true, type: true } },
        },
        // Newest transitions first; nulls (unknown transition time, typically
        // pre-backfill assets) sink to the bottom.
        orderBy: [{ monitorStatusChangedAt: { sort: "desc", nulls: "last" } }],
        take: MONITOR_ALERT_CAP + 1,
      }) : Promise.resolve(emptyAssetRows),
    ]);

    const overflow = monitorAlertsRaw.length > MONITOR_ALERT_CAP;
    const monitorAlerts = overflow ? monitorAlertsRaw.slice(0, MONITOR_ALERT_CAP) : monitorAlertsRaw;

    res.json({
      blockUtilization:    global.blockUtilization,
      recentReservations,
      assetTypeCounts:     assetTypeCountsRaw.map((row) => ({
        assetType: row.assetType,
        count:     row._count._all,
      })),
      monitorAlerts,
      monitorAlertsOverflow: overflow,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /noc-summary — one round-trip feed for the SolarWinds-style NOC widgets.
 * Same filter-don't-403 contract as /summary: asset-sourced sections gate on
 * assets:read, Event-sourced sections (active alerts, recent reboots) gate on
 * events:read; denied sections return empty/zero with the shape unchanged.
 */
function parseCsvParam(raw: unknown): string[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

// Row cap for the summary's recentReservations feed. Absent/invalid → default
// 10; otherwise the requested count clamped to the 1000-row ceiling.
function parseRecentLimitParam(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return 10;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return 10;
  return Math.min(n, 1000);
}

router.get("/noc-summary", async (req, res, next) => {
  try {
    await ensureSessionRoleSnapshot(req);
    // A bearer token carrying `dashboard:read` is the no-login NOC kiosk. It has
    // no role snapshot, so grant it both asset- and event-sourced sections here
    // (this feed is read-only fleet aggregates). Session callers still gate per
    // function. Same filter-don't-403 contract: no scope/role → empty sections.
    const tokenNoc = req.apiToken?.scopes.includes("dashboard:read") ?? false;
    const canAssets = tokenNoc || hasPermission(req, "assets", "read");
    const canEvents = tokenNoc || hasPermission(req, "events", "read");

    // Per-widget filters (optional): ?assetTypes=server,switch,... (the ENABLED
    // built-in types) and ?regionTags=East,West (the caller's "My regions"
    // names). resolveFilteredAssetIds returns null when neither narrows the set
    // — the default unfiltered, shared-payload path. The frontend memoizes per
    // (assetTypes, regionTags) so each distinct filter fetches once.
    const assetTypes = parseCsvParam(req.query.assetTypes);
    const regionNames = parseCsvParam(req.query.regionTags);
    const assetIds = (canAssets || canEvents)
      ? await nocDashboardService.resolveFilteredAssetIds({ assetTypes, regionNames })
      : null;

    // A widget wanting more than the default payload (the 1000-row option) sends
    // ?limit=N; that caps EVERY feed in this (filter-keyed) payload at N, clamped
    // to a 1000 ceiling. Absent → each feed keeps its own default and widgets
    // clip client-side. L(n) picks the requested cap or the per-feed default.
    const reqLimit = parseInt(String(req.query.limit ?? ""), 10);
    const capLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? Math.min(reqLimit, 1000) : null;
    const L = (n: number): number => capLimit ?? n;

    const emptyStatus = {
      statusCounts: { total: 0, up: 0, down: 0, warning: 0, unknown: 0, recovering: 0 },
      uptimePercent: null as number | null,
      activeAlertCount: 0,
    };

    const [
      status, downNodes, downInterfaces, downIpsecTunnels, topCpu, topMemory, slowestResponse, packetLoss, diskUsage, stalePolls, sitesWithIssues,
      recentReboots, activeAlerts,
    ] = await Promise.all([
      canAssets ? nocDashboardService.getStatusSummary(assetIds)        : Promise.resolve(emptyStatus),
      canAssets ? nocDashboardService.getDownNodes(L(100), assetIds)    : Promise.resolve({ nodes: [], total: 0 }),
      canAssets ? nocDashboardService.getDownInterfaces(L(100), 240, assetIds) : Promise.resolve([]),
      canAssets ? nocDashboardService.getDownIpsecTunnels(L(100), 240, assetIds) : Promise.resolve([]),
      canAssets ? nocDashboardService.getHighestCpu(L(100), 60, assetIds)  : Promise.resolve([]),
      canAssets ? nocDashboardService.getHighestMemory(L(100), 60, assetIds) : Promise.resolve([]),
      canAssets ? nocDashboardService.getSlowestResponse(L(100), assetIds) : Promise.resolve([]),
      canAssets ? nocDashboardService.getPacketLoss(L(100), 15, assetIds)  : Promise.resolve([]),
      canAssets ? nocDashboardService.getHighestDiskUsage(L(100), assetIds) : Promise.resolve([]),
      canAssets ? nocDashboardService.getStalePolls(3, L(50), assetIds)    : Promise.resolve([]),
      canAssets ? nocDashboardService.getSitesWithIssues(L(25), assetIds)  : Promise.resolve([]),
      canEvents ? nocDashboardService.getRecentReboots(72, L(20), assetIds) : Promise.resolve([]),
      canEvents ? nocDashboardService.getRecentAlerts(L(30), assetIds)     : Promise.resolve([]),
    ]);

    res.json({
      statusCounts:     status.statusCounts,
      uptimePercent:    status.uptimePercent,
      activeAlertCount: status.activeAlertCount,
      downNodes:        downNodes.nodes,
      downInterfaces,
      downIpsecTunnels,
      topCpu,
      topMemory,
      slowestResponse,
      packetLoss,
      diskUsage,
      stalePolls,
      recentReboots,
      activeAlerts,
      sitesWithIssues,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /filter-options — available asset types + region tags for the NOC
 * dashboard's global filter dropdowns. Same dashboard:read-token / assets:read-
 * session gate as /noc-summary; callers without access get empty lists (not 403).
 */
router.get("/filter-options", async (req, res, next) => {
  try {
    await ensureSessionRoleSnapshot(req);
    const tokenNoc = req.apiToken?.scopes.includes("dashboard:read") ?? false;
    const canAssets = tokenNoc || hasPermission(req, "assets", "read");
    if (!canAssets) {
      res.json({ assetTypes: [], regions: [] });
      return;
    }
    res.json(await nocDashboardService.getFilterOptions());
  } catch (err) {
    next(err);
  }
});

export default router;
