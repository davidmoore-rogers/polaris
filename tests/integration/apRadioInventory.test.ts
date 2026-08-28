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
    txPowerPct: null, txPowerOper: null, txPowerConfig: null, txPowerMax: null,
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
      radio({ radioIndex: 1, channel: 6, txPowerOper: 17, txPowerConfig: 1, txPowerMax: 20 }),
    ], "snmp");

    const [r] = await getApRadioInventory(apId);
    // Neither source's contribution was lost.
    expect(r.txPowerPct).toBe(70);
    expect(r.txPowerOper).toBe(17);
    expect(r.txPowerConfig).toBe(1);
    expect(r.txPowerMax).toBe(20);
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

// ─── Two sources, one VAP ───────────────────────────────────────────────────
//
// The controller names a VAP by its FortiOS object ("corp-2g"); the AP's own
// MIB publishes no name at all, only the SSID ("CORP"). Keyed on the name
// alone, each source would insert its own row and delete the other's on every
// pass. These pin the BSSID reconciliation that stops that.

d("VAP identity across sources", () => {
  beforeEach(async () => {
    await prisma.asset.deleteMany({ where: { hostname: "test-ap-radios-2src" } });
    const ap = await prisma.asset.create({
      data: { hostname: "test-ap-radios-2src", assetType: "access_point", status: "active" },
    });
    apId = ap.id;
  });

  afterAll(async () => {
    await prisma.asset.deleteMany({ where: { hostname: "test-ap-radios-2src" } });
  });

  const controllerVap = { vapName: "corp-2g", ssid: "CORP", bssid: "AA:BB:CC:00:00:01", vlanId: 10, clientCount: 2 };
  const mibVap = { vapName: "CORP", ssid: "CORP", bssid: "AA:BB:CC:00:00:01", vlanId: null, clientCount: 3 };

  it("keeps ONE row when both sources describe the same VAP", async () => {
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [controllerVap] })], "fortios");
    const first = await prisma.assetApVap.findFirstOrThrow({ where: { assetId: apId } });

    await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [mibVap] })], "snmp");

    const rows = await prisma.assetApVap.findMany({ where: { assetId: apId } });
    expect(rows).toHaveLength(1);
    // Same row — not deleted and re-created, so firstSeen survives.
    expect(rows[0]!.id).toBe(first.id);
    expect(rows[0]!.firstSeen.getTime()).toBe(first.firstSeen.getTime());
    // The controller's name stands; the MIB only ever had the SSID to offer.
    expect(rows[0]!.vapName).toBe("corp-2g");
    // And the MIB's contribution landed.
    expect(rows[0]!.clientCount).toBe(3);
    // While the controller's VLAN was not erased by a source that has none.
    expect(rows[0]!.vlanId).toBe(10);
  });

  it("adopts the controller's name for a row the MIB created first", async () => {
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [mibVap] })], "snmp");
    expect((await prisma.assetApVap.findFirstOrThrow({ where: { assetId: apId } })).vapName).toBe("CORP");

    await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [controllerVap] })], "fortios");
    const rows = await prisma.assetApVap.findMany({ where: { assetId: apId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vapName).toBe("corp-2g");
  });

  it("does not flip-flop when the sources alternate", async () => {
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [controllerVap] })], "fortios");
    const id = (await prisma.assetApVap.findFirstOrThrow({ where: { assetId: apId } })).id;
    for (let i = 0; i < 3; i++) {
      await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [mibVap] })], "snmp");
      await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [controllerVap] })], "fortios");
    }
    const rows = await prisma.assetApVap.findMany({ where: { assetId: apId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
  });

  // Without a BSSID there is nothing to reconcile on. The rows do NOT pile up
  // — each pass full-replaces the radio's VAP set — but the row is deleted
  // and re-created under the other source's name every pass, so `firstSeen`
  // resets and the name alternates. Pinned so that limit is known rather than
  // discovered on a fleet where a firmware omits the BSSID.
  it("cannot reconcile two names when neither side publishes a BSSID", async () => {
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [{ ...controllerVap, bssid: null }] })], "fortios");
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [{ ...mibVap, bssid: null }] })], "snmp");
    const rows = await prisma.assetApVap.findMany({ where: { assetId: apId }, orderBy: { vapName: "asc" } });
    expect(rows.map((r) => r.vapName)).toEqual(["CORP"]);
  });

  it("refuses a rename that another VAP on the radio already answers to", async () => {
    // Two VAPs, and the controller wants to call the second one by the first's
    // name — the unique constraint is (asset, radio, vapName).
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [
      { vapName: "CORP", ssid: "CORP", bssid: "AA:BB:CC:00:00:01", vlanId: null, clientCount: null },
      { vapName: "GUEST", ssid: "GUEST", bssid: "AA:BB:CC:00:00:02", vlanId: null, clientCount: null },
    ] })], "snmp");
    await persistApRadioInventory(apId, [radio({ radioIndex: 1, vaps: [
      { vapName: "CORP", ssid: "CORP", bssid: "AA:BB:CC:00:00:01", vlanId: null, clientCount: null },
      { vapName: "CORP", ssid: "GUEST", bssid: "AA:BB:CC:00:00:02", vlanId: null, clientCount: null },
    ] })], "fortios");

    const rows = await prisma.assetApVap.findMany({ where: { assetId: apId }, orderBy: { vapName: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.vapName).sort()).toEqual(["CORP", "GUEST"]);
  });
});
