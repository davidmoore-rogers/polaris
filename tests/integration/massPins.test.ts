/**
 * tests/integration/massPins.test.ts
 *
 * The Mass Pinning surface (Assets → Settings → Mass Pinning):
 *   GET  /assets/pin-filter-schema  — builder vocabulary, assets:read
 *   POST /assets/pin-inventory      — condition → matched ids → aggregated
 *                                     inventory with per-device pinned state
 *   POST /assets/mass-pins          — delta apply (pin + unpin), per-asset
 *                                     64-cap skip, one audit Event
 *
 * The load-bearing properties here are the ones a unit test can't reach: the
 * condition tree really resolves to the right assets, a >72h stale interface
 * row is really excluded from the checklist, and the delta merge really leaves
 * an unrelated hand-pin on a touched asset alone.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";

const d = dbDescribe;
const TAG = "masspin-test";
const HOST_A = "masspin-sw-a";
const HOST_B = "masspin-sw-b";
const HOST_OTHER = "masspin-other";

let admin: { agent: ReturnType<typeof request.agent>; csrf: string };
let idA = "";
let idB = "";
let idOther = "";

async function wipe(): Promise<void> {
  // asset_interfaces / asset_storage_samples key on assetId; the interface
  // table cascades with the Asset, storage samples are hypertable rows keyed
  // by assetId with no FK, so clear them explicitly.
  const rows = await prisma.asset.findMany({
    where: { hostname: { in: [HOST_A, HOST_B, HOST_OTHER] } },
    select: { id: true },
  });
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await prisma.assetStorageSample.deleteMany({ where: { assetId: { in: ids } } });
  }
  await prisma.asset.deleteMany({ where: { hostname: { in: [HOST_A, HOST_B, HOST_OTHER] } } });
  await prisma.event.deleteMany({ where: { action: "asset.pins.bulk_updated" } });
}

async function seed(): Promise<void> {
  const a = await prisma.asset.create({
    data: {
      hostname: HOST_A, assetType: "switch", status: "active", tags: [TAG],
      monitoredInterfaces: ["port1"],
    },
  });
  const b = await prisma.asset.create({
    data: {
      hostname: HOST_B, assetType: "switch", status: "active", tags: [TAG],
      monitoredInterfaces: [],
    },
  });
  // Same type, NOT tagged — proves the condition tree actually narrows.
  const o = await prisma.asset.create({
    data: { hostname: HOST_OTHER, assetType: "switch", status: "active", tags: [] },
  });
  idA = a.id; idB = b.id; idOther = o.id;

  const fresh = new Date();
  const stale = new Date(Date.now() - 100 * 60 * 60 * 1000); // >72h — must be excluded
  await prisma.assetInterface.createMany({
    data: [
      { assetId: idA, ifName: "port1", ifType: "physical", operStatus: "up", firstSeen: fresh, lastSeen: fresh },
      { assetId: idA, ifName: "port2", ifType: "physical", operStatus: "up", firstSeen: fresh, lastSeen: fresh },
      { assetId: idA, ifName: "port99", ifType: "physical", operStatus: "down", firstSeen: stale, lastSeen: stale },
      { assetId: idB, ifName: "port1", ifType: "physical", operStatus: "up", firstSeen: fresh, lastSeen: fresh },
      { assetId: idOther, ifName: "portX", ifType: "physical", operStatus: "up", firstSeen: fresh, lastSeen: fresh },
    ],
  });
  await prisma.assetStorageSample.createMany({
    data: [
      { assetId: idA, timestamp: fresh, mountPath: "/", totalBytes: BigInt(100), usedBytes: BigInt(10), cadence: "slow" },
      { assetId: idA, timestamp: fresh, mountPath: "/var", totalBytes: BigInt(100), usedBytes: BigInt(10), cadence: "slow" },
    ],
  });
}

/** The tagged-assets condition tree — the automations vocabulary. */
const TAG_CONDITION = { op: "and", children: [{ field: "tag", operator: "has", value: TAG }] };

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  admin = await authedAgent(app);
  await wipe();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await wipe();
  await seed();
});

afterAll(async () => {
  if (!dbReachable) return;
  await wipe();
});

d("GET /assets/pin-filter-schema", () => {
  it("returns the condition vocabulary + value options + the asset cap", async () => {
    const res = await admin.agent.get("/api/v1/assets/pin-filter-schema");
    expect(res.status).toBe(200);
    // Narrow (automations) field set — the wide DEVICE_FILTER-only fields are absent.
    const fields = (res.body.scopeCondition.fields || []).map((f: any) => f.field);
    expect(fields).toContain("tag");
    expect(fields).toContain("assetType");
    expect(fields).not.toContain("department");
    // assetTypes + tags ride the payload so the pickers work without assets-page
    // scoped extra calls.
    expect(Array.isArray(res.body.options.assetTypes)).toBe(true);
    expect(Array.isArray(res.body.options.tags)).toBe(true);
    expect(res.body.maxAssets).toBeGreaterThan(0);
  });
});

d("POST /assets/pin-inventory", () => {
  it("mode:count resolves the condition without building inventory", async () => {
    const res = await admin.agent
      .post("/api/v1/assets/pin-inventory")
      .set("X-CSRF-Token", admin.csrf)
      .send({ condition: TAG_CONDITION, facet: "interfaces", mode: "count" });
    expect(res.status).toBe(200);
    expect(res.body.matchedCount).toBe(2); // A + B, not OTHER
    expect(res.body.inventory).toBeUndefined();
  });

  it("aggregates interfaces by name with per-device pinned state, excluding stale rows", async () => {
    const res = await admin.agent
      .post("/api/v1/assets/pin-inventory")
      .set("X-CSRF-Token", admin.csrf)
      .send({ condition: TAG_CONDITION, facet: "interfaces", mode: "full" });
    expect(res.status).toBe(200);
    expect(res.body.overCap).toBe(false);
    const inv = res.body.inventory;
    expect(inv.assets).toHaveLength(2);

    const names = inv.rows.map((r: any) => r.name);
    expect(names).toContain("port1");
    expect(names).toContain("port2");
    // >72h lastSeen — off the checklist entirely.
    expect(names).not.toContain("port99");
    // Untagged asset's interface never appears.
    expect(names).not.toContain("portX");

    const port1 = inv.rows.find((r: any) => r.name === "port1");
    expect(port1.deviceCount).toBe(2);
    // A has port1 pinned, B does not → partial row.
    const pinnedFlags = port1.devices.map((dv: any) => dv.pinned).sort();
    expect(pinnedFlags).toEqual([false, true]);
    // Index encoding: every device entry points at a real assets[] slot.
    for (const dv of port1.devices) expect(inv.assets[dv.a]).toBeTruthy();
  });

  it("storage facet lists mounts from the sample table", async () => {
    const res = await admin.agent
      .post("/api/v1/assets/pin-inventory")
      .set("X-CSRF-Token", admin.csrf)
      .send({ condition: TAG_CONDITION, facet: "storage", mode: "full" });
    expect(res.status).toBe(200);
    const names = res.body.inventory.rows.map((r: any) => r.name).sort();
    expect(names).toEqual(["/", "/var"]);
  });

  it("rejects a scope with neither condition nor allAssets", async () => {
    const res = await admin.agent
      .post("/api/v1/assets/pin-inventory")
      .set("X-CSRF-Token", admin.csrf)
      .send({ facet: "interfaces", mode: "count" });
    expect(res.status).toBe(400);
  });
});

d("POST /assets/mass-pins", () => {
  it("applies pin + unpin deltas and writes one audit Event", async () => {
    const res = await admin.agent
      .post("/api/v1/assets/mass-pins")
      .set("X-CSRF-Token", admin.csrf)
      .send({
        pin:   [{ assetId: idB, name: "port1", field: "interfaces" }],
        unpin: [{ assetId: idA, name: "port1", field: "interfaces" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.updatedAssets).toBe(2);
    expect(res.body.pinsAdded).toBe(1);
    expect(res.body.pinsRemoved).toBe(1);
    expect(res.body.skipped).toEqual([]);

    const a = await prisma.asset.findUnique({ where: { id: idA }, select: { monitoredInterfaces: true } });
    const b = await prisma.asset.findUnique({ where: { id: idB }, select: { monitoredInterfaces: true } });
    expect(a!.monitoredInterfaces).toEqual([]);
    expect(b!.monitoredInterfaces).toEqual(["port1"]);

    expect(await waitForEventCount("asset.pins.bulk_updated", 1)).toBeGreaterThanOrEqual(1);
  });

  it("leaves an unrelated hand-pin on a touched asset alone (delta merge, not array replace)", async () => {
    await prisma.asset.update({
      where: { id: idA },
      data: { monitoredInterfaces: ["port1", "hand-pinned"], monitoredStorage: ["/opt"] },
    });
    const res = await admin.agent
      .post("/api/v1/assets/mass-pins")
      .set("X-CSRF-Token", admin.csrf)
      .send({ pin: [{ assetId: idA, name: "port2", field: "interfaces" }], unpin: [] });
    expect(res.status).toBe(200);
    const a = await prisma.asset.findUnique({
      where: { id: idA },
      select: { monitoredInterfaces: true, monitoredStorage: true },
    });
    expect(a!.monitoredInterfaces.sort()).toEqual(["hand-pinned", "port1", "port2"]);
    expect(a!.monitoredStorage).toEqual(["/opt"]); // untouched field preserved
  });

  it("skips an asset whose array would exceed the 64-pin cap, and applies the rest", async () => {
    await prisma.asset.update({
      where: { id: idA },
      data: { monitoredInterfaces: Array.from({ length: 64 }, (_, i) => "p" + i) },
    });
    const res = await admin.agent
      .post("/api/v1/assets/mass-pins")
      .set("X-CSRF-Token", admin.csrf)
      .send({
        pin: [
          { assetId: idA, name: "one-too-many", field: "interfaces" },
          { assetId: idB, name: "port1", field: "interfaces" },
        ],
        unpin: [],
      });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].assetId).toBe(idA);
    expect(res.body.skipped[0].reason).toMatch(/cap/i);
    // The other asset still landed — one chassis can't veto the batch.
    expect(res.body.updatedAssets).toBe(1);
    const b = await prisma.asset.findUnique({ where: { id: idB }, select: { monitoredInterfaces: true } });
    expect(b!.monitoredInterfaces).toEqual(["port1"]);
  });

  it("reports unknown asset ids as skipped rather than failing the batch", async () => {
    const res = await admin.agent
      .post("/api/v1/assets/mass-pins")
      .set("X-CSRF-Token", admin.csrf)
      .send({
        pin: [
          { assetId: "00000000-0000-4000-8000-000000000000", name: "portZ", field: "interfaces" },
          { assetId: idB, name: "port1", field: "interfaces" },
        ],
        unpin: [],
      });
    expect(res.status).toBe(200);
    expect(res.body.updatedAssets).toBe(1);
    expect(res.body.skipped.map((s: any) => s.reason)).toContain("Asset not found");
  });

  it("rejects an empty delta set", async () => {
    const res = await admin.agent
      .post("/api/v1/assets/mass-pins")
      .set("X-CSRF-Token", admin.csrf)
      .send({ pin: [], unpin: [] });
    expect(res.status).toBe(400);
  });
});
