/**
 * tests/unit/arpTableService.test.ts
 *
 * The three decisions in `persistFortigateArpTables` that a wrong answer would
 * make invisible rather than loud: which gates get wiped, which asset a gate
 * resolves to, and what `matchedAssetId` is allowed to join on.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above the module graph, so the spies have to be created in
// a hoisted block too.
const { sourceFindMany, arpFindMany, arpDeleteMany, arpCreateMany, transaction } = vi.hoisted(() => ({
  sourceFindMany: vi.fn(),
  arpFindMany:    vi.fn(),
  arpDeleteMany:  vi.fn(),
  arpCreateMany:  vi.fn(),
  transaction:    vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
  prisma: {
    assetSource:   { findMany: sourceFindMany },
    assetArpEntry: { findMany: arpFindMany, deleteMany: arpDeleteMany, createMany: arpCreateMany },
    $transaction:  transaction,
  },
}));
vi.mock("../../src/utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { persistFortigateArpTables } from "../../src/services/arpTableService.js";

const row = (device: string, ip: string, mac: string, iface = "internal1", age?: number) =>
  ({ fortigateDevice: device, ip, mac, interface: iface, age });

// The delete/createMany stubs return marker objects; $transaction just resolves
// the array it is handed, so the assertions read the calls the writer made.
function resetPrisma() {
  sourceFindMany.mockReset().mockResolvedValue([{ assetId: "asset-gate-a", externalId: "FG100F0001" }]);
  arpFindMany.mockReset().mockResolvedValue([]);
  arpDeleteMany.mockReset().mockImplementation((args: unknown) => ({ op: "delete", args }));
  arpCreateMany.mockReset().mockImplementation((args: unknown) => ({ op: "create", args }));
  transaction.mockReset().mockImplementation(async (ops: unknown[]) => ops);
}

/** Every row handed to createMany across all chunks/gates. */
function createdRows(): any[] {
  return arpCreateMany.mock.calls.flatMap((c) => (c[0] as any).data);
}

const baseOpts = {
  integrationId: "int-1",
  deviceSerials: new Map([["FGT-A", "FG100F0001"]]),
  matchAssetByMac: () => null,
};

beforeEach(resetPrisma);

describe("persistFortigateArpTables — which gates get wiped", () => {
  it("does nothing at all when no gate answered", async () => {
    const result = await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: [],
    });
    expect(result.assetsWritten).toBe(0);
    expect(sourceFindMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("REPLACES an answering gate that reported zero rows — empty is a real cache", async () => {
    const result = await persistFortigateArpTables({
      ...baseOpts,
      rows: [],
      answeredDevices: ["FGT-A"],
    });
    expect(result.assetsWritten).toBe(1);
    expect(result.entriesWritten).toBe(0);
    expect(arpDeleteMany).toHaveBeenCalledWith({ where: { assetId: "asset-gate-a" } });
    expect(arpCreateMany).not.toHaveBeenCalled();
  });

  it("leaves a non-answering gate's table alone even when other gates answered", async () => {
    sourceFindMany.mockResolvedValue([
      { assetId: "asset-gate-a", externalId: "FG100F0001" },
      { assetId: "asset-gate-b", externalId: "FG100F0002" },
    ]);
    await persistFortigateArpTables({
      ...baseOpts,
      deviceSerials: new Map([["FGT-A", "FG100F0001"], ["FGT-B", "FG100F0002"]]),
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"), row("FGT-B", "10.1.0.1", "AA:BB:CC:DD:EE:02")],
      answeredDevices: ["FGT-A"],
    });
    const deleted = arpDeleteMany.mock.calls.map((c) => (c[0] as any).where.assetId);
    expect(deleted).toEqual(["asset-gate-a"]);
    // ...and B's row is not smuggled into A's table.
    expect(createdRows().map((r) => r.ipAddress)).toEqual(["10.0.0.1"]);
  });

  it("matches the answering device case-insensitively", async () => {
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("fgt-a", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
    });
    expect(createdRows()).toHaveLength(1);
  });
});

describe("persistFortigateArpTables — resolving the gate to an asset", () => {
  it("goes name -> serial -> assetId, and queries the fortigate-firewall source kind", async () => {
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
    });
    expect(sourceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        integrationId: "int-1",
        sourceKind: "fortigate-firewall",
        externalId: { in: ["FG100F0001"] },
      }),
    }));
    expect(createdRows()[0].assetId).toBe("asset-gate-a");
  });

  it("reports a gate with no firewall asset instead of writing anything for it", async () => {
    sourceFindMany.mockResolvedValue([]);
    const result = await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
    });
    expect(result.assetsWritten).toBe(0);
    expect(result.unresolvedDevices).toEqual(["fgt-a"]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("reports a gate whose name never resolved to a serial", async () => {
    const result = await persistFortigateArpTables({
      ...baseOpts,
      deviceSerials: new Map(),
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
    });
    expect(result.unresolvedDevices).toEqual(["fgt-a"]);
    expect(sourceFindMany).not.toHaveBeenCalled();
  });
});

describe("persistFortigateArpTables — row content", () => {
  it("resolves matchedAssetId from the MAC and passes the normalized value", async () => {
    const seen: string[] = [];
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "aa-bb-cc-dd-ee-01")],
      answeredDevices: ["FGT-A"],
      matchAssetByMac: (mac) => { seen.push(mac); return "asset-endpoint"; },
    });
    expect(seen).toEqual(["AA:BB:CC:DD:EE:01"]);
    expect(createdRows()[0].matchedAssetId).toBe("asset-endpoint");
  });

  it("stores null rather than undefined for an unmatched MAC", async () => {
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
      matchAssetByMac: () => undefined,
    });
    expect(createdRows()[0].matchedAssetId).toBeNull();
  });

  it("carries firstSeen forward for a binding that is still there", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    arpFindMany.mockResolvedValue([
      { assetId: "asset-gate-a", ipAddress: "10.0.0.1", macAddress: "AA:BB:CC:DD:EE:01", ifName: "internal1", firstSeen: old },
    ]);
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [
        row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"),
        row("FGT-A", "10.0.0.2", "AA:BB:CC:DD:EE:02"),
      ],
      answeredDevices: ["FGT-A"],
    });
    const rows = createdRows();
    expect(rows.find((r) => r.ipAddress === "10.0.0.1").firstSeen).toEqual(old);
    // A binding seen for the first time starts its own clock.
    expect(rows.find((r) => r.ipAddress === "10.0.0.2").firstSeen).not.toEqual(old);
  });

  it("does not carry firstSeen across a change of interface — that is a different binding", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    arpFindMany.mockResolvedValue([
      { assetId: "asset-gate-a", ipAddress: "10.0.0.1", macAddress: "AA:BB:CC:DD:EE:01", ifName: "internal1", firstSeen: old },
    ]);
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "internal2")],
      answeredDevices: ["FGT-A"],
    });
    expect(createdRows()[0].firstSeen).not.toEqual(old);
  });

  it("gives every row of one write the same lastSeen — the table has one collection time", async () => {
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [
        row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"),
        row("FGT-A", "10.0.0.2", "AA:BB:CC:DD:EE:02"),
      ],
      answeredDevices: ["FGT-A"],
    });
    const stamps = new Set(createdRows().map((r) => r.lastSeen.getTime()));
    expect(stamps.size).toBe(1);
  });

  it("puts the delete and the inserts in ONE transaction, delete first", async () => {
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    const ops = transaction.mock.calls[0][0] as any[];
    expect(ops[0].op).toBe("delete");
    expect(ops[1].op).toBe("create");
  });
});

describe("persistFortigateArpTables — failure isolation", () => {
  it("keeps going after one gate's write throws, and reports only what landed", async () => {
    sourceFindMany.mockResolvedValue([
      { assetId: "asset-gate-a", externalId: "FG100F0001" },
      { assetId: "asset-gate-b", externalId: "FG100F0002" },
    ]);
    let call = 0;
    transaction.mockImplementation(async (ops: unknown[]) => {
      call++;
      if (call === 1) throw new Error("deadlock detected");
      return ops;
    });
    const result = await persistFortigateArpTables({
      ...baseOpts,
      deviceSerials: new Map([["FGT-A", "FG100F0001"], ["FGT-B", "FG100F0002"]]),
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"), row("FGT-B", "10.1.0.1", "AA:BB:CC:DD:EE:02")],
      answeredDevices: ["FGT-A", "FGT-B"],
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(result.assetsWritten).toBe(1);
    expect(result.entriesWritten).toBe(1);
  });

  it("logs a warning-level line when a gate's table is truncated", async () => {
    const log = vi.fn();
    const many = Array.from({ length: 4100 }, (_, i) =>
      row("FGT-A", `10.${Math.floor(i / 254)}.0.${(i % 254) + 1}`, `AA:BB:CC:${String(i).padStart(6, "0").slice(0, 2)}:00:${String(i % 100).padStart(2, "0")}`, "internal1"),
    );
    const result = await persistFortigateArpTables({
      ...baseOpts, rows: many, answeredDevices: ["FGT-A"], log,
    });
    expect(result.truncated).toBeGreaterThan(0);
    expect(log).toHaveBeenCalledWith("warning", expect.stringContaining("dropped"));
  });
});
