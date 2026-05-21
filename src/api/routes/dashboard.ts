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
    const sourceTypes = parseSourceTypesParam(req.query.recentSourceTypes);
    const [global, recentReservations, assetTypeCountsRaw, monitorAlertsRaw] = await Promise.all([
      utilizationService.getGlobalUtilization(),
      utilizationService.getRecentManualReservations(10, sourceTypes),
      prisma.asset.groupBy({
        by: ["assetType"],
        _count: { _all: true },
        where: { status: { notIn: ["decommissioned", "disabled"] } },
      }),
      prisma.asset.findMany({
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
      }),
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

export default router;
