/**
 * tests/integration/interfaceInventory.test.ts
 *
 * Coverage for the CURRENT-STATE interface inventory (`asset_interfaces`) —
 * the delete-replace contract, firstSeen preservation, and the properties the
 * System tab and the auto-monitor pin picker depend on.
 *
 * This table is what lets asset_interface_samples carry only operator-pinned
 * interfaces, so its correctness is load-bearing: a wrong wipe here empties the
 * System tab, and a missing row hides a port from the pin picker (which is the
 * only way an operator can ever start collecting history for it).
 */

import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import {
  persistInterfaces,
  INTERFACE_ROW_CAP,
} from "../../src/services/interfaceInventoryService.js";
import type { InterfaceSample } from "../../src/services/monitoringService.js";

const d = dbDescribe;
const HOSTNAME = "iface-inventory-test";

let assetId = "";

async function wipe(): Promise<void> {
  // asset_interfaces cascades with the Asset, so deleting the asset is enough.
  await prisma.asset.deleteMany({ where: { hostname: HOSTNAME } });
}

function sample(ifName: string, over: Partial<InterfaceSample> = {}): InterfaceSample {
  return { ifName, adminStatus: "up", operStatus: "up", ...over };
}

async function stored() {
  return prisma.assetInterface.findMany({
    where: { assetId },
    orderBy: { ifName: "asc" },
  });
}

d("interface inventory (current-state)", () => {
  beforeAll(async () => {
    await wipe();
  });

  beforeEach(async () => {
    await wipe();
    const asset = await prisma.asset.create({
      data: { hostname: HOSTNAME, assetType: "switch", status: "active" },
    });
    assetId = asset.id;
  });

  afterAll(async () => {
    await wipe();
  });

  it("writes one row per interface with the full column set", async () => {
    await persistInterfaces(assetId, [
      sample("port1", {
        speedBps: 1_000_000_000,
        ipAddress: "10.0.0.1",
        macAddress: "00:11:22:33:44:55",
        inOctets: 123,
        outOctets: 456,
        inErrors: 1,
        outErrors: 2,
        ifType: "physical",
        nativeVlan: 10,
        taggedVlans: [20, 30],
        trunksAllVlans: false,
        alias: "uplink",
        description: "to core",
        addressingMode: "static",
        poeStatus: "delivering",
        poeClass: "class3",
      }),
    ]);

    const rows = await stored();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.ifName).toBe("port1");
    expect(r.speedBps).toBe(1_000_000_000n);
    expect(r.ipAddress).toBe("10.0.0.1");
    expect(r.inOctets).toBe(123n);
    expect(r.outErrors).toBe(2n);
    expect(r.ifType).toBe("physical");
    expect(r.nativeVlan).toBe(10);
    expect(r.taggedVlans).toEqual([20, 30]);
    expect(r.alias).toBe("uplink");
    expect(r.poeStatus).toBe("delivering");
  });

  it("full-replaces: an interface absent from the new scrape is removed", async () => {
    await persistInterfaces(assetId, [sample("port1"), sample("port2"), sample("port3")]);
    expect((await stored()).map((r) => r.ifName)).toEqual(["port1", "port2", "port3"]);

    await persistInterfaces(assetId, [sample("port1"), sample("port3")]);
    expect((await stored()).map((r) => r.ifName)).toEqual(["port1", "port3"]);
  });

  it("updates a changed field in place rather than accumulating rows", async () => {
    await persistInterfaces(assetId, [sample("port1", { operStatus: "up" })]);
    await persistInterfaces(assetId, [sample("port1", { operStatus: "down" })]);

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].operStatus).toBe("down");
  });

  it("an empty array wipes the asset's rows", async () => {
    await persistInterfaces(assetId, [sample("port1")]);
    await persistInterfaces(assetId, []);
    expect(await stored()).toHaveLength(0);
  });

  // "This port has existed since March" has to survive a re-scrape, or the
  // column says nothing.
  it("preserves firstSeen for an interface still present, and advances lastSeen", async () => {
    const t0 = new Date(Date.now() - 60 * 60 * 1000);
    await persistInterfaces(assetId, [sample("port1")], t0);
    const first = (await stored())[0];

    const t1 = new Date();
    await persistInterfaces(assetId, [sample("port1")], t1);
    const second = (await stored())[0];

    expect(second.firstSeen.getTime()).toBe(first.firstSeen.getTime());
    expect(second.lastSeen.getTime()).toBeGreaterThan(first.lastSeen.getTime());
  });

  it("resets firstSeen when an interface disappears and later returns", async () => {
    const t0 = new Date(Date.now() - 60 * 60 * 1000);
    await persistInterfaces(assetId, [sample("port1")], t0);
    const first = (await stored())[0];

    await persistInterfaces(assetId, [sample("port2")], new Date(Date.now() - 30 * 60 * 1000));

    const t2 = new Date();
    await persistInterfaces(assetId, [sample("port1")], t2);
    const back = (await stored())[0];

    expect(back.ifName).toBe("port1");
    expect(back.firstSeen.getTime()).toBeGreaterThan(first.firstSeen.getTime());
  });

  it("scopes the replace to one asset", async () => {
    const other = await prisma.asset.create({
      data: { hostname: `${HOSTNAME}-other`, assetType: "switch", status: "active" },
    });
    try {
      await persistInterfaces(other.id, [sample("otherPort")]);
      await persistInterfaces(assetId, [sample("port1")]);

      const otherRows = await prisma.assetInterface.findMany({ where: { assetId: other.id } });
      expect(otherRows.map((r) => r.ifName)).toEqual(["otherPort"]);
    } finally {
      await prisma.asset.delete({ where: { id: other.id } });
    }
  });

  // A duplicate ifName would violate the unique index and abort the whole
  // transaction, losing a scrape that was otherwise fine.
  it("survives a scrape that reports the same ifName twice", async () => {
    await persistInterfaces(assetId, [
      sample("port1", { operStatus: "up" }),
      sample("port1", { operStatus: "down" }),
      sample("port2"),
    ]);
    const rows = await stored();
    expect(rows.map((r) => r.ifName)).toEqual(["port1", "port2"]);
    expect(rows[0].operStatus).toBe("up");
  });

  it("caps a runaway interface list", async () => {
    const many = Array.from({ length: INTERFACE_ROW_CAP + 10 }, (_, n) => sample(`port${n}`));
    await persistInterfaces(assetId, many);
    expect(await prisma.assetInterface.count({ where: { assetId } })).toBe(INTERFACE_ROW_CAP);
  });

  it("cascades with the asset", async () => {
    await persistInterfaces(assetId, [sample("port1")]);
    await prisma.asset.delete({ where: { id: assetId } });
    expect(await prisma.assetInterface.count({ where: { assetId } })).toBe(0);
  });
});
