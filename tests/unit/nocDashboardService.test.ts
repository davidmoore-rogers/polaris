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
    const r = await noc.getDownNodes();
    expect(r.nodes.map((n) => n.site)).toEqual(["HQ", "Site-B", "(unknown)"]);
    expect(r.total).toBe(3);
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
