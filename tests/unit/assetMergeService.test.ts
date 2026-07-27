/**
 * tests/unit/assetMergeService.test.ts
 *
 * Coverage for the operator-driven asset merge service, focused on the parts
 * that decide what the survivor ends up holding:
 *   - per-field winners: explicit "ghost" overwrites, blank-fill default,
 *     an empty winner never blanks a populated survivor field
 *   - lastSeen keeps the more recent value (+ its provenance label); tags union
 *   - `monitored` is OR-ed across the two rows, not "survivor wins" — and when
 *     the carry-over flips the survivor ON, the ghost's polling methods /
 *     credentials / cadences ride along, pin arrays union, monitor state
 *     resets, and monitorOverride is recomputed
 *   - business rule 10: a survivor whose merged status lands on
 *     decommissioned/disabled is never switched on
 *
 * Prisma is mocked so the choreography is exercised without a live DB (same
 * pattern as assetGhostMergeService.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => {
  const tx = {
    asset: { update: vi.fn(), delete: vi.fn() },
    assetMacAddress: { findMany: vi.fn(async () => []), update: vi.fn(), delete: vi.fn() },
    assetAssociatedIp: { findMany: vi.fn(async () => []), update: vi.fn(), delete: vi.fn() },
    assetIpHistory: { findMany: vi.fn(async () => []), update: vi.fn(), delete: vi.fn() },
    assetFortigateSighting: { findMany: vi.fn(async () => []), update: vi.fn(), delete: vi.fn() },
    assetSource: { updateMany: vi.fn(async () => ({ count: 0 })) },
    managedAgent: { update: vi.fn() },
  };
  return {
    prisma: {
      _tx: tx,
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      $executeRaw: vi.fn(async () => 0),
      asset: { findUnique: vi.fn() },
    },
  };
});

import { mergeAssets } from "../../src/services/assetMergeService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const tx = (prisma as unknown as { _tx: Record<string, Record<string, Mock>> })._tx;
const findUnique = prisma.asset.findUnique as unknown as Mock;
const executeRaw = (prisma as unknown as { $executeRaw: Mock }).$executeRaw;

const CANON = "canonical-id";
const GHOST = "ghost-id";

/** A minimally-populated asset row as ASSET_SELECT would return it. */
function assetRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    hostname: null,
    dnsName: null,
    ipAddress: null,
    macAddress: null,
    serialNumber: null,
    manufacturer: null,
    model: null,
    assetType: "other",
    status: "active",
    location: null,
    learnedLocation: null,
    department: null,
    assignedTo: null,
    os: null,
    osVersion: null,
    snmpLocation: null,
    learnedAddress: null,
    purchaseOrder: null,
    notes: null,
    acquiredAt: null,
    warrantyExpiry: null,
    lastSeen: null,
    lastSeenSource: null,
    tags: [] as string[],
    monitored: false,
    managedAgent: null,
    monitoredInterfaces: [] as string[],
    monitoredStorage: [] as string[],
    monitoredIpsecTunnels: [] as string[],
    monitoredProcesses: [] as string[],
    monitoredServices: [] as string[],
    mappedProcesses: [] as string[],
    mappedServices: [] as string[],
    ...over,
  };
}

function seed(canonical: Record<string, unknown>, ghost: Record<string, unknown>) {
  findUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === CANON ? assetRow(CANON, canonical) : assetRow(GHOST, ghost),
  );
}

/** The data object the survivor was updated with (empty when no update fired). */
function updateData(): Record<string, unknown> {
  const call = tx.asset.update.mock.calls[0];
  return call ? (call[0] as { data: Record<string, unknown> }).data : {};
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.assetMacAddress.findMany.mockResolvedValue([]);
  tx.assetAssociatedIp.findMany.mockResolvedValue([]);
  tx.assetIpHistory.findMany.mockResolvedValue([]);
  tx.assetFortigateSighting.findMany.mockResolvedValue([]);
  tx.assetSource.updateMany.mockResolvedValue({ count: 0 });
  executeRaw.mockResolvedValue(0);
});

describe("mergeAssets — field resolution", () => {
  it("refuses to merge an asset into itself", async () => {
    await expect(mergeAssets({ canonicalId: CANON, ghostId: CANON })).rejects.toThrow(/into itself/i);
  });

  it("blank-fills from the ghost by default but keeps a populated survivor field", async () => {
    seed({ hostname: "keep-me", model: null }, { hostname: "ghost-name", model: "PA-220" });
    const res = await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    const data = updateData();
    expect(data.model).toBe("PA-220");        // survivor empty → filled
    expect(data.hostname).toBeUndefined();     // survivor populated → untouched
    expect(res.appliedFields).toContain("model");
  });

  it("lets an explicit ghost winner overwrite, but never with an empty value", async () => {
    seed({ hostname: "old", location: "Rack 1" }, { hostname: "new", location: null });
    await mergeAssets({
      canonicalId: CANON,
      ghostId: GHOST,
      fieldWinners: { hostname: "ghost", location: "ghost" },
    });
    const data = updateData();
    expect(data.hostname).toBe("new");
    expect(data.location).toBeUndefined();     // empty winner can't blank the survivor
  });

  it("keeps the more recent lastSeen with its provenance, and unions tags", async () => {
    const older = new Date("2026-07-01T00:00:00Z");
    const newer = new Date("2026-07-20T00:00:00Z");
    seed(
      { lastSeen: older, lastSeenSource: "discovery", tags: ["site:a"] },
      { lastSeen: newer, lastSeenSource: "probe", tags: ["site:a", "role:db"] },
    );
    await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    const data = updateData();
    expect(data.lastSeen).toBe(newer);
    expect(data.lastSeenSource).toBe("probe");
    expect(data.tags).toEqual(["site:a", "role:db"]);
  });
});

describe("mergeAssets — monitoring carry-over", () => {
  it("switches the survivor on when only the absorbed asset was monitored", async () => {
    seed(
      { monitored: false },
      {
        monitored: true,
        responseTimePolling: "snmp",
        cpuMemoryPolling: "snmp",
        monitorCredentialId: "cred-1",
        monitorIntervalSec: 120,
      },
    );
    const res = await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    const data = updateData();
    expect(res.carriedMonitoring).toBe(true);
    expect(data.monitored).toBe(true);
    // Config the enabled monitoring needs to resolve a method comes with it.
    expect(data.responseTimePolling).toBe("snmp");
    expect(data.cpuMemoryPolling).toBe("snmp");
    expect(data.monitorCredentialId).toBe("cred-1");
    expect(data.monitorIntervalSec).toBe(120);
    expect(res.monitorFieldsAdopted).toEqual(
      expect.arrayContaining(["responseTimePolling", "monitorCredentialId", "monitorIntervalSec"]),
    );
    // Fresh monitor state — the ghost's samples are orphaned by the merge.
    expect(data.monitorStatus).toBeNull();
    expect(data.consecutiveFailures).toBe(0);
    expect(data.consecutiveSuccesses).toBe(0);
    // monitorOverride recompute ran for the survivor.
    expect(executeRaw).toHaveBeenCalled();
  });

  it("unions the operator pin arrays when carrying monitoring over", async () => {
    seed(
      { monitored: false, monitoredInterfaces: ["port1"], monitoredProcesses: [] },
      { monitored: true, monitoredInterfaces: ["port1", "port2"], monitoredProcesses: ["nginx"] },
    );
    const res = await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    const data = updateData();
    expect(data.monitoredInterfaces).toEqual(["port1", "port2"]);
    expect(data.monitoredProcesses).toEqual(["nginx"]);
    expect(res.monitorFieldsAdopted).toEqual(
      expect.arrayContaining(["monitoredInterfaces", "monitoredProcesses"]),
    );
  });

  it("leaves an already-monitored survivor's own configuration alone", async () => {
    seed(
      { monitored: true, responseTimePolling: "icmp", monitoredInterfaces: ["port1"] },
      { monitored: true, responseTimePolling: "snmp", monitoredInterfaces: ["port9"] },
    );
    const res = await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    const data = updateData();
    expect(res.carriedMonitoring).toBe(false);
    expect(data.responseTimePolling).toBeUndefined();
    expect(data.monitoredInterfaces).toBeUndefined();
    expect(data.monitored).toBeUndefined();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("never turns monitoring off — an unmonitored ghost leaves a monitored survivor alone", async () => {
    seed({ monitored: true }, { monitored: false, responseTimePolling: "snmp" });
    const res = await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    expect(res.carriedMonitoring).toBe(false);
    expect(updateData().monitored).toBeUndefined();
  });

  it("respects business rule 10 — a decommissioned survivor stays unmonitored", async () => {
    seed({ monitored: false, status: "decommissioned" }, { monitored: true, responseTimePolling: "snmp" });
    const res = await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    const data = updateData();
    expect(res.carriedMonitoring).toBe(false);
    expect(data.monitored).toBeUndefined();
    expect(data.responseTimePolling).toBeUndefined();
  });

  it("respects business rule 10 when the merge itself resolves status to disabled", async () => {
    seed({ monitored: false, status: "active" }, { monitored: true, status: "disabled" });
    const res = await mergeAssets({
      canonicalId: CANON,
      ghostId: GHOST,
      fieldWinners: { status: "ghost" },
    });
    expect(updateData().status).toBe("disabled");
    expect(res.carriedMonitoring).toBe(false);
  });
});

describe("mergeAssets — transfers", () => {
  it("re-binds the ghost's sources and deletes the ghost row", async () => {
    seed({}, {});
    tx.assetSource.updateMany.mockResolvedValue({ count: 3 });
    const res = await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    expect(tx.assetSource.updateMany).toHaveBeenCalledWith({
      where: { assetId: GHOST },
      data: { assetId: CANON },
    });
    expect(tx.asset.delete).toHaveBeenCalledWith({ where: { id: GHOST } });
    expect(res.movedSources).toBe(3);
  });

  it("re-binds the ghost's agent enrollment only when the survivor has none", async () => {
    seed({ managedAgent: null }, { managedAgent: { id: "ma-1" } });
    const res = await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    expect(res.movedManagedAgent).toBe(true);
    expect(tx.managedAgent.update).toHaveBeenCalledWith({
      where: { assetId: GHOST },
      data: { assetId: CANON },
    });

    vi.clearAllMocks();
    seed({ managedAgent: { id: "ma-keep" } }, { managedAgent: { id: "ma-1" } });
    const res2 = await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    expect(res2.movedManagedAgent).toBe(false);
    expect(tx.managedAgent.update).not.toHaveBeenCalled();
  });
});
