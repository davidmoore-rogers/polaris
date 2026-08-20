/**
 * tests/integration/arpTable.test.ts
 *
 * The FortiGate ARP Table feature end to end against a real database: the
 * writer's delete-replace scoping and firstSeen carry-forward against the real
 * unique constraint, and what GET /assets/:id/arp-table hands the tab.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { persistFortigateArpTables } from "../../src/services/arpTableService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const GATE_A_SERIAL = "FG100FTK20000001";
const GATE_B_SERIAL = "FG100FTK20000002";

let integrationId = "";
let gateA = "";
let gateB = "";
let endpoint = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.assetArpEntry.deleteMany();
  await prisma.assetSource.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.integration.deleteMany();

  const integration = await prisma.integration.create({
    data: { name: "FMG-Test", type: "fortimanager", config: {} as any, enabled: true },
  });
  integrationId = integration.id;

  const mk = async (hostname: string, assetType: string) =>
    (await prisma.asset.create({ data: { hostname, assetType, status: "active" } })).id;

  gateA    = await mk("FGT-A", "firewall");
  gateB    = await mk("FGT-B", "firewall");
  endpoint = await mk("PRINTER-4", "printer");

  // The `fortigate-firewall` AssetSource row is the serial → assetId hop the
  // writer resolves through; without it a gate is "unresolved" by design.
  for (const [assetId, externalId] of [[gateA, GATE_A_SERIAL], [gateB, GATE_B_SERIAL]] as const) {
    await prisma.assetSource.create({
      data: { assetId, sourceKind: "fortigate-firewall", externalId, integrationId, observed: {} as any },
    });
  }
});

const serials = () => new Map([["FGT-A", GATE_A_SERIAL], ["FGT-B", GATE_B_SERIAL]]);
const row = (device: string, ip: string, mac: string, iface = "internal1", age?: number) =>
  ({ fortigateDevice: device, ip, mac, interface: iface, age });
const persist = (rows: any[], answered: string[], matchByMac: (m: string) => string | null = () => null) =>
  persistFortigateArpTables({
    integrationId, rows, answeredDevices: answered, deviceSerials: serials(), matchAssetByMac: matchByMac,
  });

d("persistFortigateArpTables (real DB)", () => {
  it("writes one gate's table and leaves a silent gate's rows untouched", async () => {
    await persist([
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"),
      row("FGT-B", "10.1.0.1", "AA:BB:CC:DD:EE:02"),
    ], ["FGT-A", "FGT-B"]);
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateA } })).toBe(1);
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateB } })).toBe(1);

    // Next cycle: only A answers, and it answers with nothing.
    const result = await persist([], ["FGT-A"]);
    expect(result.assetsWritten).toBe(1);
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateA } })).toBe(0);
    // B did not answer, so B keeps what it had — the whole point of the scoping.
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateB } })).toBe(1);
  });

  it("survives a duplicate binding in one payload rather than aborting the gate", async () => {
    // Two identical rows would violate the unique index if the writer did not
    // dedupe before createMany — and would take the whole transaction with them.
    const result = await persist([
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", 300),
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", 12),
    ], ["FGT-A"]);
    expect(result.entriesWritten).toBe(1);
    const stored = await prisma.assetArpEntry.findFirst({ where: { assetId: gateA } });
    expect(stored?.ageSec).toBe(12);
  });

  it("carries firstSeen forward across a re-write of the same binding", async () => {
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")], ["FGT-A"]);
    const first = await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA } });

    await persist([
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"),
      row("FGT-A", "10.0.0.9", "AA:BB:CC:DD:EE:09"),
    ], ["FGT-A"]);
    const again = await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA, ipAddress: "10.0.0.1" } });
    const fresh = await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA, ipAddress: "10.0.0.9" } });

    expect(again.firstSeen.getTime()).toBe(first.firstSeen.getTime());
    expect(again.lastSeen.getTime()).toBeGreaterThanOrEqual(first.lastSeen.getTime());
    expect(fresh.firstSeen.getTime()).toBeGreaterThanOrEqual(first.firstSeen.getTime());
  });

  it("stores a NULL ifName for an unattributed row and keeps it addressable", async () => {
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "")], ["FGT-A"]);
    const stored = await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA } });
    expect(stored.ifName).toBeNull();
    // The NULL row must survive its own re-write — the unique index cannot
    // catch it (Postgres NULLs are distinct), so the writer's dedupe is what
    // keeps the delete-replace from doubling it.
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "")], ["FGT-A"]);
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateA } })).toBe(1);
  });

  it("links matchedAssetId and lets the endpoint be deleted without taking the row", async () => {
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")], ["FGT-A"], () => endpoint);
    expect((await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA } })).matchedAssetId).toBe(endpoint);

    await prisma.asset.delete({ where: { id: endpoint } });
    const orphan = await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA } });
    expect(orphan.matchedAssetId).toBeNull();
  });

  it("cascades away with the FortiGate asset", async () => {
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")], ["FGT-A"]);
    await prisma.asset.delete({ where: { id: gateA } });
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateA } })).toBe(0);
  });
});

d("GET /assets/:id/arp-table", () => {
  it("returns the entries, per-interface counts, and one collection timestamp", async () => {
    await persist([
      row("FGT-A", "10.0.0.2",  "AA:BB:CC:DD:EE:02", "internal1", 30),
      row("FGT-A", "10.0.0.10", "AA:BB:CC:DD:EE:0A", "internal1"),
      row("FGT-A", "10.9.0.1",  "AA:BB:CC:DD:EE:09", "wan1"),
    ], ["FGT-A"], (mac) => (mac === "AA:BB:CC:DD:EE:02" ? endpoint : null));

    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${gateA}/arp-table`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.interfaceCounts).toEqual({ internal1: 2, wan1: 1 });
    expect(res.body.collectedAt).toBeTruthy();

    const matched = res.body.entries.find((e: any) => e.ipAddress === "10.0.0.2");
    expect(matched.matchedAsset.hostname).toBe("PRINTER-4");
    expect(matched.ageSec).toBe(30);
    // A row the firmware gave no age for reports null, never 0.
    expect(res.body.entries.find((e: any) => e.ipAddress === "10.0.0.10").ageSec).toBeNull();
  });

  it("answers empty rather than 404 for a gate that has never been read", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${gateB}/arp-table`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 0, entries: [], interfaceCounts: {}, collectedAt: null });
  });

  it("requires authentication", async () => {
    const request = (await import("supertest")).default;
    const res = await request(app).get(`/api/v1/assets/${gateA}/arp-table`);
    expect(res.status).toBe(401);
  });
});
