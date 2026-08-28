/**
 * tests/integration/ssidDeviceFilter.test.ts
 *
 * The "Broadcast SSID" device-filter condition field, end to end against a real
 * database: `resolveDeviceFilterAssetIds` → `decorateRelationLeafHits` → one
 * GROUP BY over AssetApVap → the in-memory tree evaluator.
 *
 * The unit test (tests/unit/scopeRelationIndex.test.ts) mocks Prisma and pins
 * the predicate; this pins the half a mock cannot: that the query the module
 * builds actually selects the right assets, including the two cases most
 * likely to be got wrong — a negative operator over an AP broadcasting several
 * SSIDs, and an AP with no radio inventory at all.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { resolveDeviceFilterAssetIds } from "../../src/services/deviceFilterService.js";
import { listScopeOptions } from "../../src/services/notificationRuleService.js";
import type { ScopeConditionGroup } from "../../src/services/notificationTypes.js";

const d = dbDescribe;
const HOST_PREFIX = "ssid-filter-test-";

const ids: Record<string, string> = {};

/** One AP broadcasting the given SSIDs (one VAP row each, radio 1). */
async function makeAp(name: string, ssids: string[], monitored = true): Promise<string> {
  const ap = await prisma.asset.create({
    data: { hostname: HOST_PREFIX + name, assetType: "access_point", status: "active", monitored },
  });
  for (let i = 0; i < ssids.length; i++) {
    await prisma.assetApVap.create({
      data: { assetId: ap.id, radioIndex: 1, vapName: `${ssids[i]}-vap`, ssid: ssids[i], source: "fortios" },
    });
  }
  return ap.id;
}

const tree = (operator: string, value: string): ScopeConditionGroup =>
  ({ op: "and", children: [{ field: "ssid", operator, value }] }) as ScopeConditionGroup;

/** Only the fixtures — the dev DB carries other assets. */
function mine(got: Set<string>): string[] {
  return Object.entries(ids)
    .filter(([, id]) => got.has(id))
    .map(([name]) => name)
    .sort();
}

d("Broadcast SSID device filter", () => {
  beforeEach(async () => {
    await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST_PREFIX } } });
    ids.corpGuest = await makeAp("corp-guest", ["CORP", "GUEST"]);
    ids.corpOnly = await makeAp("corp-only", ["CORP"]);
    ids.guestOnly = await makeAp("guest-only", ["GUEST"]);
    // Discovery has never reached this one: no VAP rows at all.
    ids.noRadios = await makeAp("no-radios", []);
  });

  afterAll(async () => {
    await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST_PREFIX } } });
  });

  it("selects the APs broadcasting an SSID", async () => {
    expect(mine(await resolveDeviceFilterAssetIds(tree("equals", "GUEST")))).toEqual(["corpGuest", "guestOnly"]);
  });

  it("matches case-insensitively, the way every other string field does", async () => {
    expect(mine(await resolveDeviceFilterAssetIds(tree("equals", "guest")))).toEqual(["corpGuest", "guestOnly"]);
  });

  // The case worth a real database: notEquals has to hold for EVERY SSID the AP
  // carries, so an AP on both CORP and GUEST must NOT come back for "not GUEST"
  // just because it is also on CORP.
  it("excludes an AP that carries the SSID among others", async () => {
    expect(mine(await resolveDeviceFilterAssetIds(tree("notEquals", "GUEST")))).toEqual(["corpOnly", "noRadios"]);
  });

  it("reads an AP with no radio inventory as broadcasting nothing", async () => {
    const positive = await resolveDeviceFilterAssetIds(tree("equals", "CORP"));
    expect(positive.has(ids.noRadios!)).toBe(false);
    const negative = await resolveDeviceFilterAssetIds(tree("notEquals", "CORP"));
    expect(negative.has(ids.noRadios!)).toBe(true);
  });

  it("supports contains and the wildcard operator", async () => {
    expect(mine(await resolveDeviceFilterAssetIds(tree("contains", "ues")))).toEqual(["corpGuest", "guestOnly"]);
    expect(mine(await resolveDeviceFilterAssetIds(tree("matches", "GU*T")))).toEqual(["corpGuest", "guestOnly"]);
  });

  it("combines with a scalar field in one tree", async () => {
    const both: ScopeConditionGroup = {
      op: "and",
      children: [
        { field: "ssid", operator: "equals", value: "CORP" },
        { field: "hostname", operator: "contains", value: "corp-only" },
      ],
    } as ScopeConditionGroup;
    expect(mine(await resolveDeviceFilterAssetIds(both))).toEqual(["corpOnly"]);
  });

  it("offers the monitored fleet's SSIDs to the picker, and only those", async () => {
    const hidden = await makeAp("unmonitored", ["SECRET-LAB"], false);
    ids.unmonitored = hidden;
    const { ssids } = await listScopeOptions();
    expect(ssids).toContain("CORP");
    expect(ssids).toContain("GUEST");
    // An SSID only an unmonitored AP carries can't produce an alert, so it is
    // not offered — the same rule the manufacturer/model/interface lists use.
    expect(ssids).not.toContain("SECRET-LAB");
  });

  it("cascades the VAP rows away with the AP", async () => {
    await prisma.asset.delete({ where: { id: ids.corpGuest! } });
    expect(await prisma.assetApVap.count({ where: { assetId: ids.corpGuest! } })).toBe(0);
  });
});
