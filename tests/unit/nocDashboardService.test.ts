/**
 * tests/unit/nocDashboardService.test.ts
 *
 * Unit coverage for the NOC dashboard aggregates. Prisma + the monitor-settings
 * resolver are mocked so the tests assert the JS transformation logic (status
 * grouping, uptime math, packet-loss ratio, stale-poll grace, site bucketing,
 * top-N hydration ordering) without a live DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    event: { findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock("../../src/services/monitoringService.js", () => ({
  resolveMonitorSettings: vi.fn(),
}));

import * as noc from "../../src/services/nocDashboardService.js";
import { prisma } from "../../src/db.js";
import { resolveMonitorSettings } from "../../src/services/monitoringService.js";

const groupBy = prisma.asset.groupBy as unknown as ReturnType<typeof vi.fn>;
const count = prisma.asset.count as unknown as ReturnType<typeof vi.fn>;
const findMany = prisma.asset.findMany as unknown as ReturnType<typeof vi.fn>;
const eventFindMany = prisma.event.findMany as unknown as ReturnType<typeof vi.fn>;
const rawUnsafe = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;
const rawQuery = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const resolve = resolveMonitorSettings as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getStatusSummary", () => {
  it("maps null monitorStatus to unknown, totals every state, and computes infra uptime%", async () => {
    groupBy
      // 1st call: all monitored, by status
      .mockResolvedValueOnce([
        { monitorStatus: "up", _count: { _all: 10 } },
        { monitorStatus: "down", _count: { _all: 2 } },
        { monitorStatus: "warning", _count: { _all: 1 } },
        { monitorStatus: null, _count: { _all: 3 } }, // null -> unknown
      ])
      // 2nd call: infra subset by status
      .mockResolvedValueOnce([
        { monitorStatus: "up", _count: { _all: 7 } },
        { monitorStatus: "down", _count: { _all: 1 } },
        { monitorStatus: "warning", _count: { _all: 5 } }, // excluded from uptime denom
      ]);
    count.mockResolvedValueOnce(3);

    const r = await noc.getStatusSummary();
    expect(r.statusCounts).toEqual({ total: 16, up: 10, down: 2, warning: 1, unknown: 3, recovering: 0 });
    // 7 / (7 + 1) = 87.5
    expect(r.uptimePercent).toBe(87.5);
    expect(r.activeAlertCount).toBe(3);
  });

  it("returns null uptime when there is no infra up/down to measure", async () => {
    groupBy.mockResolvedValueOnce([{ monitorStatus: "up", _count: { _all: 4 } }]).mockResolvedValueOnce([]);
    count.mockResolvedValueOnce(0);
    const r = await noc.getStatusSummary();
    expect(r.uptimePercent).toBeNull();
    expect(r.statusCounts.total).toBe(4);
  });
});

describe("getDownNodes", () => {
  it("coalesces the site label by location > learnedLocation > snmpLocation > (unknown)", async () => {
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "a", ipAddress: null, assetType: "switch", location: "HQ", learnedLocation: "x", snmpLocation: null, department: "NetEng", monitorStatus: "down", monitorStatusChangedAt: null },
      { id: "b", hostname: "b", ipAddress: null, assetType: "switch", location: null, learnedLocation: "Site-B", snmpLocation: "raw", department: null, monitorStatus: "down", monitorStatusChangedAt: null },
      { id: "c", hostname: "c", ipAddress: null, assetType: "switch", location: null, learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null },
    ]);
    count.mockResolvedValueOnce(3);
    const r = await noc.getDownNodes();
    expect(r.nodes.map((n) => n.site)).toEqual(["HQ", "Site-B", "(unknown)"]);
    expect(r.total).toBe(3);
  });

  it("total is the TRUE down count, not the capped row count", async () => {
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "a", ipAddress: null, assetType: "switch", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null },
    ]);
    count.mockResolvedValueOnce(5); // 4 more down beyond the limit-capped list
    const r = await noc.getDownNodes(1);
    expect(r.nodes).toHaveLength(1);
    expect(r.total).toBe(5);
  });

  it("orders youngest outage first (monitorStatusChangedAt desc, nulls last)", async () => {
    findMany.mockResolvedValueOnce([]);
    count.mockResolvedValueOnce(0);
    await noc.getDownNodes();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ monitorStatusChangedAt: { sort: "desc", nulls: "last" } }],
    }));
  });
});

describe("getDownInterfaces", () => {
  it("resolves the gate (firewall→hostname, else learnedLocation), keeps SQL order, drops unmonitored owners", async () => {
    const t = new Date("2026-06-30T00:00:00Z");
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "sw", ifName: "port12", ifLabel: "AP uplink", lastUpAt: t },
      { assetId: "fw", ifName: "wan2", ifLabel: null, lastUpAt: null },
      { assetId: "gone", ifName: "port3", ifLabel: null, lastUpAt: t }, // owner not monitored → dropped
    ]);
    findMany.mockResolvedValueOnce([
      { id: "sw", hostname: "fs-aisle-3", ipAddress: "10.1.2.5", assetType: "switch", location: null, learnedLocation: "fgt-plant-a", snmpLocation: null },
      { id: "fw", hostname: "fgt-dc-west", ipAddress: "10.9.0.1", assetType: "firewall", location: null, learnedLocation: "fmg-01", snmpLocation: null },
    ]);
    const r = await noc.getDownInterfaces();
    expect(r.map((x) => [x.assetId, x.ifName, x.gate])).toEqual([
      ["sw", "port12", "fgt-plant-a"], // switch → parent learnedLocation
      ["fw", "wan2", "fgt-dc-west"],   // firewall → own hostname, not learnedLocation
    ]);
    expect(r[0].lastUpAt).toBe(t);
    expect(r[1].ifLabel).toBeNull();
  });

  it("restricts to interfaces selected for monitoring (pin filter inside the SQL, before the LIMIT)", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    await noc.getDownInterfaces();
    const sql = rawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain(`s."ifName" = ANY(a."monitoredInterfaces")`);
  });

  it("returns empty without hitting findMany when no interface is down", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    const r = await noc.getDownInterfaces();
    expect(r).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("getDownIpsecTunnels", () => {
  it("returns down tunnels with parent interface + gate, keeps SQL order, drops unmonitored owners", async () => {
    const t = new Date("2026-06-30T00:00:00Z");
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "fw", tunnelName: "vpn-hq", parentInterface: "wan1", remoteGateway: "203.0.113.7", lastUpAt: t },
      { assetId: "fw", tunnelName: "vpn-dr", parentInterface: null, remoteGateway: null, lastUpAt: null },
      { assetId: "gone", tunnelName: "vpn-x", parentInterface: "wan2", remoteGateway: null, lastUpAt: t }, // owner not monitored → dropped
    ]);
    findMany.mockResolvedValueOnce([
      { id: "fw", hostname: "fgt-dc-west", ipAddress: "10.9.0.1", assetType: "firewall", location: null, learnedLocation: "fmg-01", snmpLocation: null },
    ]);
    const r = await noc.getDownIpsecTunnels();
    expect(r.map((x) => [x.tunnelName, x.parentInterface, x.gate])).toEqual([
      ["vpn-hq", "wan1", "fgt-dc-west"], // firewall gate = own hostname, not learnedLocation
      ["vpn-dr", null, "fgt-dc-west"],
    ]);
    expect(r[0].remoteGateway).toBe("203.0.113.7");
  });

  it("restricts to tunnels selected for monitoring (pin filter inside the SQL, before the LIMIT)", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    await noc.getDownIpsecTunnels();
    const sql = rawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain(`s."tunnelName" = ANY(a."monitoredIpsecTunnels")`);
  });

  it("returns empty without hitting findMany when no tunnel is down", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    const r = await noc.getDownIpsecTunnels();
    expect(r).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("getHighestCpu", () => {
  it("preserves the SQL order, rounds to 0.1, and drops ids with no asset row", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "a", value: 91.27 },
      { assetId: "gone", value: 80 },
      { assetId: "b", value: 70.0 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "b", hostname: "host-b", ipAddress: "10.0.0.2" },
      { id: "a", hostname: "host-a", ipAddress: "10.0.0.1" },
    ]);
    const r = await noc.getHighestCpu();
    expect(r.map((x) => x.id)).toEqual(["a", "b"]); // 'gone' filtered, order kept
    expect(r[0].value).toBe(91.3);
  });
});

describe("getPacketLoss", () => {
  it("computes failed/total as a percentage rounded to 0.1", async () => {
    rawUnsafe.mockResolvedValueOnce([{ assetId: "a", total: 8n, failed: 1n }]);
    findMany.mockResolvedValueOnce([{ id: "a", hostname: "h", ipAddress: "1.2.3.4" }]);
    const r = await noc.getPacketLoss();
    expect(r[0].value).toBe(12.5); // 1/8
  });

  it("excludes 100%-loss assets in the SQL (hard-down = Down Nodes, not packet loss)", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    await noc.getPacketLoss();
    const sql = rawUnsafe.mock.calls[0][0] as string;
    // At least one failure AND at least one success — a window with zero
    // successful probes is a down node, not a lossy one.
    expect(sql).toContain(`count(*) FILTER (WHERE NOT "success") > 0`);
    expect(sql).toContain(`count(*) FILTER (WHERE "success") > 0`);
  });
});

describe("getStalePolls", () => {
  it("keeps assets overdue past grace*interval and doubles the window for suppressed assets", async () => {
    const now = Date.now();
    findMany.mockResolvedValueOnce([
      // last polled 10 min ago, interval 60s, grace 3 -> overdue (10min >> 3min)
      { id: "stale", hostname: "s", ipAddress: null, lastMonitorAt: new Date(now - 10 * 60_000), assetType: "switch", discoveredByIntegrationId: null, discoveredByIntegration: null, monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, lldpIntervalSec: null, storageIntervalSec: null, probeTimeoutMs: null, dependencySuppressed: false },
      // last polled 6 min ago, suppressed -> window = 3*60*2 = 6 min, 6min is not > 6min boundary unless ==; use 5min to stay fresh
      { id: "fresh-suppressed", hostname: "f", ipAddress: null, lastMonitorAt: new Date(now - 5 * 60_000), assetType: "switch", discoveredByIntegrationId: null, discoveredByIntegration: null, monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, lldpIntervalSec: null, storageIntervalSec: null, probeTimeoutMs: null, dependencySuppressed: true },
    ]);
    resolve.mockResolvedValue({ intervalSeconds: 60 });
    const r = await noc.getStalePolls(3);
    expect(r.map((x) => x.id)).toEqual(["stale"]);
    expect(r[0].expectedIntervalSec).toBe(60);
  });

  it("treats a never-polled asset as stale", async () => {
    findMany.mockResolvedValueOnce([
      { id: "never", hostname: "n", ipAddress: null, lastMonitorAt: null, assetType: "switch", discoveredByIntegrationId: null, discoveredByIntegration: null, monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, lldpIntervalSec: null, storageIntervalSec: null, probeTimeoutMs: null, dependencySuppressed: false },
    ]);
    resolve.mockResolvedValue({ intervalSeconds: 60 });
    const r = await noc.getStalePolls();
    expect(r.map((x) => x.id)).toEqual(["never"]);
  });
});

describe("getRecentReboots", () => {
  it("maps device.reboot events, pulling hostname/ip from resourceName + details", async () => {
    const t = new Date("2026-06-20T00:00:00Z");
    eventFindMany.mockResolvedValueOnce([
      { id: "e1", resourceId: "asset-1", resourceName: "fw-1", timestamp: t, details: { ipAddress: "10.0.0.5" } },
      { id: "e2", resourceId: "asset-2", resourceName: null, timestamp: t, details: { hostname: "sw-2", ipAddress: null } },
    ]);
    const r = await noc.getRecentReboots();
    expect(r[0]).toMatchObject({ id: "asset-1", hostname: "fw-1", ipAddress: "10.0.0.5" });
    expect(r[1]).toMatchObject({ id: "asset-2", hostname: "sw-2" });
  });
});

describe("getRecentAlerts", () => {
  it("maps events to {hostname, message, severity, raisedAt}", async () => {
    const t = new Date("2026-06-20T00:00:00Z");
    eventFindMany.mockResolvedValueOnce([
      { id: "e1", resourceName: "fw-1", message: "down", level: "warning", action: "monitor.status_changed", timestamp: t },
    ]);
    const r = await noc.getRecentAlerts();
    expect(r[0]).toEqual({ id: "e1", hostname: "fw-1", message: "down", severity: "warning", raisedAt: t });
  });
});

describe("getSitesWithIssues", () => {
  it("joins per-site counts with affected nodes bucketed by the same coalesced site key", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { site: "HQ", down: 2n, warning: 1n, total: 9n, lat: 36.1, lng: -86.7 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "n1", hostname: "n1", monitorStatus: "down", location: "HQ", learnedLocation: null, snmpLocation: null, department: "NetEng" },
      { id: "n2", hostname: "n2", monitorStatus: "warning", location: "HQ", learnedLocation: null, snmpLocation: null, department: "NetEng" },
    ]);
    const r = await noc.getSitesWithIssues();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ site: "HQ", downCount: 2, warningCount: 1, total: 9, division: "NetEng" });
    expect(r[0].nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("short-circuits to empty when no site has issues", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    const r = await noc.getSitesWithIssues();
    expect(r).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("getSlowestResponse", () => {
  it("returns the server-side averaged response times, hydrates names, preserves order, rounds to 0.1", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "a", avg_ms: 642.37 },
      { assetId: "gone", avg_ms: 300 },
      { assetId: "b", avg_ms: 120 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "b", hostname: "hb", ipAddress: "10.0.0.2" },
      { id: "a", hostname: "ha", ipAddress: "10.0.0.1" },
    ]);
    const r = await noc.getSlowestResponse();
    expect(r.map((x) => x.id)).toEqual(["a", "b"]); // 'gone' dropped, SQL order kept
    expect(r[0].value).toBe(642.4);
  });
});

describe("getHighestDiskUsage", () => {
  it("hydrates per-volume rows with hostname + mount-path detail, preserves SQL order, dedupes the id lookup", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "a", mountPath: "/var", pct: 96.27 },
      { assetId: "a", mountPath: "/", pct: 71.4 },   // same asset, second volume
      { assetId: "gone", mountPath: "/data", pct: 88 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "db-04", ipAddress: "10.0.0.1" },
    ]);
    const r = await noc.getHighestDiskUsage();
    // 'gone' has no asset row → dropped; both of 'a's volumes kept, order preserved
    expect(r.map((x) => [x.id, x.detail, x.value])).toEqual([
      ["a", "/var", 96.3],
      ["a", "/", 71.4],
    ]);
    // id lookup deduped to the distinct asset set
    expect((findMany.mock.calls[0][0] as { where: { id: { in: string[] } } }).where.id.in).toEqual(["a", "gone"]);
  });

  it("returns empty without hitting findMany when there are no samples", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    const r = await noc.getHighestDiskUsage();
    expect(r).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("getHighestTemperature", () => {
  it("hydrates per-sensor rows with hostname + sensor-name detail, preserves SQL order, dedupes the id lookup", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "a", sensorName: "CPU Temp", value: 84.27 },
      { assetId: "a", sensorName: "Intake", value: 51.9 },  // same asset, second sensor
      { assetId: "gone", sensorName: "PS1 Temp", value: 70 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "fgt-plant-a", ipAddress: "10.0.0.1" },
    ]);
    const r = await noc.getHighestTemperature();
    // 'gone' has no asset row → dropped; both of 'a's sensors kept, order preserved
    expect(r.map((x) => [x.id, x.detail, x.value])).toEqual([
      ["a", "CPU Temp", 84.3],
      ["a", "Intake", 51.9],
    ]);
    // id lookup deduped to the distinct asset set
    expect((findMany.mock.calls[0][0] as { where: { id: { in: string[] } } }).where.id.in).toEqual(["a", "gone"]);
  });

  it("returns empty without hitting findMany when there are no samples", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    const r = await noc.getHighestTemperature();
    expect(r).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("getFilterOptions", () => {
  it("returns built-in types present (canonical order, custom dropped) and distinct region tags", async () => {
    findMany.mockResolvedValueOnce([
      { assetType: "firewall" }, { assetType: "server" }, { assetType: "acme-widget" },
    ]);
    rawQuery.mockResolvedValueOnce([{ region: "East" }, { region: "West" }]);
    const r = await noc.getFilterOptions();
    expect(r.assetTypes).toEqual(["server", "firewall"]); // builtin order; custom 'acme-widget' dropped
    expect(r.regions).toEqual(["East", "West"]);
  });
});

describe("getNocSummaryPayload", () => {
  beforeEach(() => {
    noc.clearNocFeedCache();
  });

  function grantAll() {
    return { canAssets: true, canEvents: true, assetTypes: null, regionNames: null, capLimit: null };
  }

  it("returns only the requested feeds, flattened to the legacy response keys", async () => {
    groupBy
      .mockResolvedValueOnce([{ monitorStatus: "up", _count: { _all: 3 } }]) // status: all monitored
      .mockResolvedValueOnce([]);                                            // status: infra subset
    count.mockResolvedValue(1); // status activeAlertCount + downNodes total (concurrent)
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "fw", ipAddress: null, assetType: "firewall", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null },
    ]);

    const r = await noc.getNocSummaryPayload({ feeds: ["status", "downNodes"], ...grantAll() });
    expect(Object.keys(r).sort()).toEqual(["activeAlertCount", "downNodes", "downNodesTotal", "statusCounts", "uptimePercent"]);
    expect((r.statusCounts as { total: number }).total).toBe(3);
    expect((r.downNodes as Array<{ id: string }>).map((n) => n.id)).toEqual(["a"]);
    expect(r.downNodesTotal).toBe(1);
  });

  it("null feeds returns the full payload shape", async () => {
    groupBy.mockResolvedValue([]);
    count.mockResolvedValue(0);
    findMany.mockResolvedValue([]);
    eventFindMany.mockResolvedValue([]);
    rawUnsafe.mockResolvedValue([]);
    resolve.mockResolvedValue({ intervalSeconds: 60 });

    const r = await noc.getNocSummaryPayload({ feeds: null, ...grantAll() });
    expect(Object.keys(r).sort()).toEqual([
      "activeAlertCount", "activeAlerts", "diskUsage", "downInterfaces", "downIpsecTunnels",
      "downNodes", "downNodesTotal", "packetLoss", "recentReboots", "sitesWithIssues",
      "slowestResponse", "stalePolls", "statusCounts", "temperature", "topCpu", "topMemory",
      "uptimePercent",
    ]);
  });

  it("permission-denied feeds return their empty value without touching the DB", async () => {
    const r = await noc.getNocSummaryPayload({
      feeds: null, canAssets: false, canEvents: false, assetTypes: null, regionNames: null, capLimit: null,
    });
    expect(r.statusCounts).toEqual({ total: 0, up: 0, down: 0, warning: 0, unknown: 0, recovering: 0 });
    expect(r.downNodes).toEqual([]);
    expect(r.downNodesTotal).toBe(0);
    expect(r.activeAlerts).toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(eventFindMany).not.toHaveBeenCalled();
    expect(rawUnsafe).not.toHaveBeenCalled();
  });

  it("drops unknown feed names silently", async () => {
    const r = await noc.getNocSummaryPayload({ feeds: ["bogus"], ...grantAll() });
    expect(r).toEqual({});
    expect(rawUnsafe).not.toHaveBeenCalled();
  });

  it("serves repeat requests for the same (feed, filter, cap) from the TTL cache", async () => {
    rawUnsafe.mockResolvedValue([{ assetId: "a", value: 50 }]);
    findMany.mockResolvedValue([{ id: "a", hostname: "h", ipAddress: null }]);

    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll() });
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll() });
    expect(rawUnsafe).toHaveBeenCalledTimes(1); // second call was a cache hit

    // A different row cap is a different cache entry.
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll(), capLimit: 1000 });
    expect(rawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("applies the caller's capLimit to the feed query", async () => {
    rawUnsafe.mockResolvedValue([]);
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll(), capLimit: 1000 });
    // getHighestCpu binds LIMIT as the 2nd parameter.
    expect(rawUnsafe.mock.calls[0][2]).toBe(1000);
  });
});

describe("resolveFilteredAssetIds", () => {
  it("returns null (no narrowing) when neither asset types nor regions filter", async () => {
    const r = await noc.resolveFilteredAssetIds({ assetTypes: null, regionNames: null });
    expect(r).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns null when every built-in type is enabled and there is no region filter", async () => {
    const all = ["server", "switch", "router", "firewall", "workstation", "printer", "access_point", "other"];
    const r = await noc.resolveFilteredAssetIds({ assetTypes: all, regionNames: [] });
    expect(r).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("filters by hidden built-in types (notIn) and region tags (hasSome region:<name>)", async () => {
    findMany.mockResolvedValueOnce([{ id: "x" }, { id: "y" }]);
    const r = await noc.resolveFilteredAssetIds({ assetTypes: ["server", "switch"], regionNames: ["East"] });
    expect(r).toEqual(["x", "y"]);
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.assetType).toEqual({ notIn: ["router", "firewall", "workstation", "printer", "access_point", "other"] });
    expect(where.tags).toEqual({ hasSome: ["region:East"] });
  });
});
