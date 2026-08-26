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
  // asset_interfaces cascades with the Asset, so deleting the assets is enough.
  // startsWith covers the per-test peer/other assets too — a leaked peer would
  // carry its serial into the next test's trunk-preservation matching.
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOSTNAME } } });
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

  // ── FortiLink trunk preservation ──────────────────────────────────────────
  // FortiSwitchOS removes a FortiLink trunk aggregate from the ifTable while
  // the link is down, so a downed inter-switch trunk vanished from the
  // inventory (and the System tab, and the pin picker) at exactly the moment
  // the down alert about it fired. A dropped row whose name resolves to a
  // still-present peer switch that reciprocates survives the delete-replace,
  // marked down.

  const SERIAL_A = "S1TESTAAAA000001";
  const SERIAL_B = "S1TESTBBBB000002";
  // The trunk name is the peer serial + "-0", left-truncated to 15 chars.
  const TRUNK_ON_A = "ESTBBBB000002-0"; // A's interface toward B
  const TRUNK_ON_B = "ESTAAAA000001-0"; // B's interface toward A

  async function createPeer(over: Record<string, unknown> = {}): Promise<string> {
    const peer = await prisma.asset.create({
      data: {
        hostname: `${HOSTNAME}-peer`,
        assetType: "switch",
        status: "active",
        serialNumber: SERIAL_B,
        ...over,
      },
    });
    return peer.id;
  }

  async function stampSelfSerial(): Promise<void> {
    await prisma.asset.update({ where: { id: assetId }, data: { serialNumber: SERIAL_A } });
  }

  it("preserves a trunk interface whose peer is active and reciprocates, marked down", async () => {
    await stampSelfSerial();
    const peerId = await createPeer();
    await persistInterfaces(peerId, [sample(TRUNK_ON_B)]);

    await persistInterfaces(assetId, [sample("port1"), sample(TRUNK_ON_A, { operStatus: "up" })]);
    // Trunk goes down → it leaves the ifTable → next scrape omits it.
    await persistInterfaces(assetId, [sample("port1")]);

    const rows = await stored();
    expect(rows.map((r) => r.ifName)).toEqual([TRUNK_ON_A, "port1"]);
    const trunk = rows.find((r) => r.ifName === TRUNK_ON_A)!;
    expect(trunk.operStatus).toBe("down");
  });

  it("keeps firstSeen across the outage and refreshes the row when the trunk returns", async () => {
    await stampSelfSerial();
    const peerId = await createPeer();
    await persistInterfaces(peerId, [sample(TRUNK_ON_B)]);

    const t0 = new Date(Date.now() - 60 * 60 * 1000);
    await persistInterfaces(assetId, [sample(TRUNK_ON_A)], t0);
    const before = (await stored())[0];

    await persistInterfaces(assetId, [sample("port1")], new Date(Date.now() - 30 * 60 * 1000));

    const t2 = new Date();
    await persistInterfaces(assetId, [sample("port1"), sample(TRUNK_ON_A, { operStatus: "up" })], t2);
    const after = (await stored()).find((r) => r.ifName === TRUNK_ON_A)!;

    expect(after.firstSeen.getTime()).toBe(before.firstSeen.getTime());
    expect(after.operStatus).toBe("up");
    expect(after.lastSeen.getTime()).toBe(t2.getTime());
  });

  it("preservation holds when BOTH ends drop the trunk (reciprocal preserved rows vouch for each other)", async () => {
    await stampSelfSerial();
    const peerId = await createPeer();
    await persistInterfaces(assetId, [sample(TRUNK_ON_A)]);
    await persistInterfaces(peerId, [sample(TRUNK_ON_B)]);

    // Link down: both sides' next full scrape omits the trunk. Whichever side
    // scrapes first still sees the other's stored row; after that each side's
    // preserved row satisfies the other's reciprocity check.
    await persistInterfaces(assetId, [sample("port1")]);
    await persistInterfaces(peerId, [sample("port9")]);
    await persistInterfaces(assetId, [sample("port1")]);

    expect((await stored()).map((r) => r.ifName)).toContain(TRUNK_ON_A);
    const peerRows = await prisma.assetInterface.findMany({ where: { assetId: peerId } });
    expect(peerRows.map((r) => r.ifName)).toContain(TRUNK_ON_B);
  });

  it("removes the trunk when the peer is decommissioned", async () => {
    await stampSelfSerial();
    const peerId = await createPeer({ status: "decommissioned" });
    await persistInterfaces(peerId, [sample(TRUNK_ON_B)]);

    await persistInterfaces(assetId, [sample(TRUNK_ON_A)]);
    await persistInterfaces(assetId, [sample("port1")]);

    expect((await stored()).map((r) => r.ifName)).toEqual(["port1"]);
  });

  it("removes the trunk when the peer has no reciprocal interface", async () => {
    await stampSelfSerial();
    const peerId = await createPeer();
    await persistInterfaces(peerId, [sample("port5")]); // no trunk toward A

    await persistInterfaces(assetId, [sample(TRUNK_ON_A)]);
    await persistInterfaces(assetId, [sample("port1")]);

    expect((await stored()).map((r) => r.ifName)).toEqual(["port1"]);
  });

  it("removes the trunk when its name matches no asset serial", async () => {
    await stampSelfSerial();
    await persistInterfaces(assetId, [sample("NOSUCHPEER0001-0")]);
    await persistInterfaces(assetId, [sample("port1")]);

    expect((await stored()).map((r) => r.ifName)).toEqual(["port1"]);
  });

  it("removes the trunk when this asset has no serial for the peer to reciprocate against", async () => {
    const peerId = await createPeer();
    await persistInterfaces(peerId, [sample(TRUNK_ON_B)]);

    await persistInterfaces(assetId, [sample(TRUNK_ON_A)]);
    await persistInterfaces(assetId, [sample("port1")]);

    expect((await stored()).map((r) => r.ifName)).toEqual(["port1"]);
  });
});
