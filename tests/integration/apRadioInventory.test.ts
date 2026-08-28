/**
 * tests/integration/apRadioInventory.test.ts
 *
 * persistApRadioInventory — the write half of the FortiAP radio → SSID →
 * station tree.
 *
 * The behaviour worth pinning is the two-source merge: the controller
 * (source "fortios") knows the SSIDs, the BSSIDs and a power PERCENTAGE; the
 * AP's own MIB (source "snmp") knows the power in dBm plus the floor and
 * ceiling. Neither may erase what the other established, and neither may
 * leave a radio or an SSID behind once the device stops reporting it.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import {
  persistApRadioInventory,
  getApRadioInventory,
} from "../../src/services/apRadioService.js";
import type { ApRadioSample } from "../../src/utils/fortiapMonitorRow.js";

const d = dbDescribe;

let apId = "";

/** A radio sample with every column null unless the caller says otherwise. */
function radio(partial: Partial<ApRadioSample> & { radioIndex: number }): ApRadioSample {
  return {
    radioType: null, band: null, mode: null, channel: null, bandwidthMhz: null,
    txPowerPct: null, txPowerDbm: null, txPowerMinDbm: null, txPowerMaxDbm: null,
    txPowerMode: null, baseBssid: null, clientCount: null, countryCode: null,
    ...partial,
  };
}

d("persistApRadioInventory", () => {
  beforeEach(async () => {
    await prisma.asset.deleteMany({ where: { hostname: "test-ap-radios" } });
    const ap = await prisma.asset.create({
      data: { hostname: "test-ap-radios", assetType: "access_point", status: "active" },
    });
    apId = ap.id;
  });

  afterAll(async () => {
    await prisma.asset.deleteMany({ where: { hostname: "test-ap-radios" } });
  });

  it("stores radios with the SSIDs each one broadcasts", async () => {
    await persistApRadioInventory(apId, [
      radio({
        radioIndex: 1, band: "2.4GHz", channel: 6, bandwidthMhz: 20, txPowerPct: 70,
        vaps: [{ vapName: "corp-2g", ssid: "CORP", bssid: "AA:BB:CC:00:00:01", vlanId: 10, clientCount: 3 }],
      }),
      radio({
        radioIndex: 2, band: "5GHz", channel: 149, bandwidthMhz: 80,
        vaps: [
          { vapName: "corp-5g", ssid: "CORP", bssid: "AA:BB:CC:00:00:02", vlanId: 10, clientCount: 9 },
          { vapName: "guest-5g", ssid: "GUEST", bssid: "AA:BB:CC:00:00:03", vlanId: 20, clientCount: 0 },
        ],
      }),
    ], "fortios");

    const tree = await getApRadioInventory(apId);
    expect(tree.map((r) => r.radioIndex)).toEqual([1, 2]);
    expect(tree[0].channel).toBe(6);
    expect(tree[0].vaps.map((v) => v.ssid)).toEqual(["CORP"]);
    expect(tree[1].bandwidthMhz).toBe(80);
    expect(tree[1].vaps.map((v) => v.vapName)).toEqual(["corp-5g", "guest-5g"]);
  });

  it("merges the two sources per column instead of overwriting the row", async () => {
    // The controller half: SSIDs + a power percentage.
    await persistApRadioInventory(apId, [
      radio({ radioIndex: 1, channel: 6, txPowerPct: 70, vaps: [{ vapName: "corp", ssid: "CORP", bssid: null, vlanId: null, clientCount: null }] }),
    ], "fortios");

    // The MIB half: dBm + the floor/ceiling, and it knows nothing about VAPs.
    await persistApRadioInventory(apId, [
      radio({ radioIndex: 1, channel: 6, txPowerDbm: 17, txPowerMinDbm: 1, txPowerMaxDbm: 20 }),
    ], "snmp");

    const [r] = await getApRadioInventory(apId);
    // Neither source's contribution was lost.
    expect(r.txPowerPct).toBe(70);
    expect(r.txPowerDbm).toBe(17);
    expect(r.txPowerMinDbm).toBe(1);
    expect(r.txPowerMaxDbm).toBe(20);
    // A source that publishes no VAP list must not wipe the SSIDs.
    expect(r.vaps.map((v) => v.ssid)).toEqual(["CORP"]);
    expect(r.source).toBe("snmp");
  });

  it("takes a changed reading from either source", async () => {
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, channel: 6, txPowerPct: 70 })], "fortios");
    // DFS moved the radio and DARRP dropped the power.
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, channel: 11, txPowerPct: 40 })], "fortios");
    const [r] = await getApRadioInventory(apId);
    expect(r.channel).toBe(11);
    expect(r.txPowerPct).toBe(40);
  });

  it("drops a radio that stopped being reported, and its SSIDs with it", async () => {
    await persistApRadioInventory(apId, [
      radio({ radioIndex: 1, vaps: [{ vapName: "corp-2g", ssid: "CORP", bssid: null, vlanId: null, clientCount: null }] }),
      radio({ radioIndex: 2, vaps: [{ vapName: "corp-5g", ssid: "CORP", bssid: null, vlanId: null, clientCount: null }] }),
    ], "fortios");
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [] })], "fortios");

    const tree = await getApRadioInventory(apId);
    expect(tree.map((r) => r.radioIndex)).toEqual([1]);
    // Radio 1 answered "broadcasting nothing"; radio 2 is gone entirely. The
    // VAP rows hang off (assetId, radioIndex) with no FK to cascade from, so
    // this is the check that they are cleaned up explicitly.
    expect(tree[0].vaps).toEqual([]);
    expect(await prisma.assetApVap.count({ where: { assetId: apId } })).toBe(0);
  });

  it("drops one SSID without disturbing the others on the same radio", async () => {
    await persistApRadioInventory(apId, [
      radio({ radioIndex: 1, vaps: [
        { vapName: "corp", ssid: "CORP", bssid: null, vlanId: null, clientCount: null },
        { vapName: "guest", ssid: "GUEST", bssid: null, vlanId: null, clientCount: null },
      ] }),
    ], "fortios");
    await persistApRadioInventory(apId, [
      radio({ radioIndex: 1, vaps: [{ vapName: "corp", ssid: "CORP", bssid: null, vlanId: null, clientCount: null }] }),
    ], "fortios");

    const [r] = await getApRadioInventory(apId);
    expect(r.vaps.map((v) => v.vapName)).toEqual(["corp"]);
  });

  it("keeps firstSeen across re-scrapes and advances lastSeen", async () => {
    const t0 = new Date(Date.now() - 60_000);
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, channel: 6 })], "fortios", t0);
    const before = await prisma.assetApRadio.findFirstOrThrow({ where: { assetId: apId } });

    const t1 = new Date();
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, channel: 6 })], "fortios", t1);
    const after = await prisma.assetApRadio.findFirstOrThrow({ where: { assetId: apId } });

    expect(after.id).toBe(before.id);
    expect(after.firstSeen.getTime()).toBe(before.firstSeen.getTime());
    expect(after.lastSeen.getTime()).toBeGreaterThan(before.lastSeen.getTime());
  });

  it("returns nothing for an asset with no radio inventory", async () => {
    expect(await getApRadioInventory(apId)).toEqual([]);
  });

  it("cascades away with the asset", async () => {
    await persistApRadioInventory(apId, [
      radio({ radioIndex: 1, vaps: [{ vapName: "corp", ssid: "CORP", bssid: null, vlanId: null, clientCount: null }] }),
    ], "fortios");
    await prisma.asset.delete({ where: { id: apId } });
    expect(await prisma.assetApRadio.count({ where: { assetId: apId } })).toBe(0);
    expect(await prisma.assetApVap.count({ where: { assetId: apId } })).toBe(0);
  });
});
