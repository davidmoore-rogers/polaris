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
    // absorbAssetRelations resolves agent presence from the table itself
    // (it's shared with the conflict path, which has no pre-loaded row).
    managedAgent: { findMany: vi.fn(async () => []), update: vi.fn() },
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

import {
  mergeAssets,
  absorbAssetRelations,
  resolveMonitoringCarry,
} from "../../src/services/assetMergeService.js";
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

/** Which asset ids the ManagedAgent table holds an enrollment for. */
function seedAgents(...assetIds: string[]) {
  tx.managedAgent.findMany.mockResolvedValue(assetIds.map((assetId) => ({ assetId })));
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
  tx.managedAgent.findMany.mockResolvedValue([]);
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
    seed({}, {});
    seedAgents(GHOST);
    const res = await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    expect(res.movedManagedAgent).toBe(true);
    expect(tx.managedAgent.update).toHaveBeenCalledWith({
      where: { assetId: GHOST },
      data: { assetId: CANON },
    });

    vi.clearAllMocks();
    seed({}, {});
    seedAgents(GHOST, CANON);
    const res2 = await mergeAssets({ canonicalId: CANON, ghostId: GHOST });
    expect(res2.movedManagedAgent).toBe(false);
    expect(tx.managedAgent.update).not.toHaveBeenCalled();
  });
});

// The absorb mechanics are shared with acceptAssetConflict's sibling-conflict
// ghost path (api/routes/conflicts.ts), which used to let the ghost delete
// cascade its AssetSource rows away — dropping discovery provenance (entra /
// intune / fortigate-endpoint) the survivor never had. These assert the
// contract that path now relies on.
describe("absorbAssetRelations", () => {
  it("re-points every source row and never deletes one", async () => {
    tx.assetSource.updateMany.mockResolvedValue({ count: 4 });
    const counts = await absorbAssetRelations(tx as any, GHOST, CANON);
    expect(tx.assetSource.updateMany).toHaveBeenCalledWith({
      where: { assetId: GHOST },
      data: { assetId: CANON },
    });
    expect(counts.movedSources).toBe(4);
    expect((tx.assetSource as Record<string, Mock>).deleteMany).toBeUndefined();
  });

  it("transfers the four side tables, keeping the survivor's row on a collision", async () => {
    // Survivor already holds this MAC; the absorbed row collides and is dropped
    // rather than re-pointed (the unique (assetId, mac) key forbids both).
    tx.assetMacAddress.findMany
      .mockResolvedValueOnce([{ mac: "AA:BB:CC:DD:EE:FF" }])
      .mockResolvedValueOnce([
        { id: "dup", mac: "AA:BB:CC:DD:EE:FF" },
        { id: "new", mac: "11:22:33:44:55:66" },
      ]);
    const counts = await absorbAssetRelations(tx as any, GHOST, CANON);
    expect(tx.assetMacAddress.delete).toHaveBeenCalledWith({ where: { id: "dup" } });
    expect(tx.assetMacAddress.update).toHaveBeenCalledWith({
      where: { id: "new" },
      data: { assetId: CANON },
    });
    expect(counts.movedMacs).toBe(1);
  });

  it("leaves the survivor's own agent enrollment in place", async () => {
    seedAgents(CANON);
    const counts = await absorbAssetRelations(tx as any, GHOST, CANON);
    expect(counts.movedManagedAgent).toBe(false);
    expect(tx.managedAgent.update).not.toHaveBeenCalled();
  });
});

describe("resolveMonitoringCarry", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    status: "active",
    monitored: false,
    cpuMemoryPolling: null,
    monitoredInterfaces: [] as string[],
    ...over,
  });

  it("flips the survivor on and adopts the absorbed row's config", async () => {
    const update: Record<string, unknown> = {};
    const res = resolveMonitoringCarry(
      update,
      row(),
      row({ monitored: true, cpuMemoryPolling: "snmp", monitoredInterfaces: ["port1"] }),
    );
    expect(res.carried).toBe(true);
    expect(update.monitored).toBe(true);
    expect(update.cpuMemoryPolling).toBe("snmp");
    expect(update.monitoredInterfaces).toEqual(["port1"]);
    // Monitor state resets — the survivor has no history under this config.
    expect(update.monitorStatus).toBeNull();
    expect(res.adopted).toContain("cpuMemoryPolling");
  });

  it("is a no-op when the survivor is already monitored", async () => {
    const update: Record<string, unknown> = {};
    const res = resolveMonitoringCarry(
      update,
      row({ monitored: true, cpuMemoryPolling: "agent" }),
      row({ monitored: true, cpuMemoryPolling: "snmp" }),
    );
    expect(res.carried).toBe(false);
    expect(update).toEqual({});
  });

  it("never turns monitoring off", async () => {
    const update: Record<string, unknown> = {};
    resolveMonitoringCarry(update, row({ monitored: true }), row({ monitored: false }));
    expect(update.monitored).toBeUndefined();
  });

  it("respects business rule 10 — a staged decommission blocks the carry-over", async () => {
    const update: Record<string, unknown> = { status: "decommissioned" };
    const res = resolveMonitoringCarry(update, row(), row({ monitored: true }));
    expect(res.carried).toBe(false);
    expect(update.monitored).toBeUndefined();
  });
});
