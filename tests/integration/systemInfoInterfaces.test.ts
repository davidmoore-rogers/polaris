/**
 * tests/integration/systemInfoInterfaces.test.ts
 *
 * Pins the System tab's interface read after the current-state cutover.
 *
 * `GET /assets/:id/system-info` used to select interface rows by an exact
 * `timestamp = lastSystemInfoAt` match against the sample hypertable. It now
 * reads the current-state `AssetInterface` table. Three properties matter and
 * none of them were covered before:
 *
 *   1. UNPINNED interfaces still render. This is the whole point — once the
 *      sample table goes pinned-only, reading it here would show an operator
 *      only the ports they had already pinned, and the pin checkbox lives on
 *      this very table, so nothing new could ever be pinned.
 *   2. The response no longer depends on `lastSystemInfoAt`. The old anchor
 *      (and its clamp for the agent's independent interface/storage pushes)
 *      was a standing source of "System tab renders empty" bugs.
 *   3. The response SHAPE is unchanged, so the frontend needs no changes.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { persistInterfaces } from "../../src/services/interfaceInventoryService.js";

const d = dbDescribe;
const HOSTNAME = "sysinfo-iface-endpoint-test";

let assetId = "";

async function wipe(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: HOSTNAME } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await wipe();
});

afterAll(async () => {
  if (!dbReachable) return;
  await wipe();
  try { await prisma.$disconnect(); } catch { /* noop */ }
});

d("GET /assets/:id/system-info — interfaces from current state", () => {
  beforeEach(async () => {
    await wipe();
    const asset = await prisma.asset.create({
      data: {
        hostname: HOSTNAME,
        assetType: "switch",
        status: "active",
        // Only "port1" is pinned; port2/port3 are not.
        monitoredInterfaces: ["port1"],
      },
    });
    assetId = asset.id;
  });

  it("returns EVERY interface, pinned or not", async () => {
    await persistInterfaces(assetId, [
      { ifName: "port1", operStatus: "up", adminStatus: "up" },
      { ifName: "port2", operStatus: "down", adminStatus: "up" },
      { ifName: "port3", operStatus: "up", adminStatus: "down" },
    ]);

    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${assetId}/system-info`);
    expect(res.status).toBe(200);

    const names = (res.body.interfaces as Array<{ ifName: string }>).map((i) => i.ifName);
    expect(names).toEqual(["port1", "port2", "port3"]);
    // The pin list is still surfaced so the UI can render the checkboxes.
    expect(res.body.monitoredInterfaces).toEqual(["port1"]);
  });

  // The old read returned [] whenever lastSystemInfoAt was null, and returned
  // the wrong set whenever it disagreed with the sample rows' timestamp.
  it("renders interfaces even with lastSystemInfoAt unset", async () => {
    await persistInterfaces(assetId, [{ ifName: "port1" }, { ifName: "port2" }]);
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { lastSystemInfoAt: true },
    });
    expect(asset?.lastSystemInfoAt).toBeNull();

    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${assetId}/system-info`);
    expect(res.status).toBe(200);
    expect((res.body.interfaces as unknown[]).length).toBe(2);
  });

  it("keeps the response shape the frontend expects", async () => {
    await persistInterfaces(assetId, [
      {
        ifName: "port1",
        adminStatus: "up",
        operStatus: "up",
        speedBps: 1_000_000_000,
        ipAddress: "10.0.0.1",
        macAddress: "00:11:22:33:44:55",
        inOctets: 10,
        outOctets: 20,
        inErrors: 0,
        outErrors: 0,
        ifType: "physical",
        nativeVlan: 10,
        taggedVlans: [20],
        alias: "uplink",
        poeStatus: "delivering",
        poeClass: "class3",
      },
    ]);

    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${assetId}/system-info`);
    const iface = (res.body.interfaces as Array<Record<string, unknown>>)[0];

    // BigInt columns must still serialize as numbers, not strings/objects.
    expect(iface.speedBps).toBe(1_000_000_000);
    expect(iface.inOctets).toBe(10);
    expect(iface.ifName).toBe("port1");
    expect(iface.ifType).toBe("physical");
    expect(iface.taggedVlans).toEqual([20]);
    expect(iface.alias).toBe("uplink");
    expect(iface.poeStatus).toBe("delivering");
    // `timestamp` is now the current-state row's lastSeen; the frontend reads
    // this key, so it must still be present and parseable.
    expect(typeof iface.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(String(iface.timestamp)))).toBe(false);
  });

  it("reflects a full-replace: a removed interface disappears", async () => {
    await persistInterfaces(assetId, [{ ifName: "port1" }, { ifName: "port2" }]);
    await persistInterfaces(assetId, [{ ifName: "port1" }]);

    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${assetId}/system-info`);
    const names = (res.body.interfaces as Array<{ ifName: string }>).map((i) => i.ifName);
    expect(names).toEqual(["port1"]);
  });
});
