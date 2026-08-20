/**
 * tests/unit/massPinService.test.ts
 *
 * Pure-function coverage for the Mass Pinning service: the inventory
 * aggregation (buildPinInventory) and the per-asset delta merge
 * (computeFinalPinArrays). No DB calls; the DB-bound wrappers
 * (getPinInventoryForAssets / applyMassPins) are exercised by
 * tests/integration/massPins.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  buildPinInventory,
  computeFinalPinArrays,
  MASS_PIN_ARRAY_CAP,
  type InventoryItem,
  type MassPinAssetState,
  type PinField,
} from "../../src/services/massPinService.js";

function asset(id: string, over: Partial<MassPinAssetState> = {}): MassPinAssetState {
  return {
    id,
    hostname: "host-" + id,
    ipAddress: "10.0.0." + id,
    monitoredInterfaces: [],
    monitoredStorage: [],
    monitoredIpsecTunnels: [],
    ...over,
  };
}

describe("buildPinInventory", () => {
  it("groups items by name across assets and index-encodes devices", () => {
    const a1 = asset("1", { monitoredInterfaces: ["port1"] });
    const a2 = asset("2");
    const items = new Map<string, InventoryItem[]>([
      ["1", [{ name: "port1", ifType: "physical" }, { name: "port2", ifType: "physical" }]],
      ["2", [{ name: "port1", ifType: "physical" }]],
    ]);
    const inv = buildPinInventory([a1, a2], items, "interfaces");

    expect(inv.assets.map((a) => a.id)).toEqual(["1", "2"]);
    expect(inv.rows.map((r) => r.name)).toEqual(["port1", "port2"]); // count desc, then name
    const port1 = inv.rows[0]!;
    expect(port1.deviceCount).toBe(2);
    // Index-encoded: entries reference assets[] by position, pinned per asset.
    expect(port1.devices).toEqual([
      { a: 0, pinned: true },
      { a: 1, pinned: false },
    ]);
  });

  it("stamps pinned from the provenance-correct array", () => {
    const a = asset("1", {
      monitoredInterfaces: ["vpn-hq"], // same NAME pinned as an interface...
      monitoredIpsecTunnels: [],       // ...but NOT as a tunnel
    });
    const items = new Map<string, InventoryItem[]>([
      ["1", [{ name: "vpn-hq", ifType: "tunnel", isIpsecTunnel: true }]],
    ]);
    const inv = buildPinInventory([a], items, "interfaces");
    // Tunnel provenance reads monitoredIpsecTunnels — the interface pin of the
    // same name must not count.
    expect(inv.rows[0]!.isIpsecTunnel).toBe(true);
    expect(inv.rows[0]!.devices[0]!.pinned).toBe(false);
  });

  it("storage facet reads monitoredStorage", () => {
    const a = asset("1", { monitoredStorage: ["/var"] });
    const items = new Map<string, InventoryItem[]>([
      ["1", [{ name: "/var" }, { name: "/home" }]],
    ]);
    const inv = buildPinInventory([a], items, "storage");
    const byName = new Map(inv.rows.map((r) => [r.name, r]));
    expect(byName.get("/var")!.devices[0]!.pinned).toBe(true);
    expect(byName.get("/home")!.devices[0]!.pinned).toBe(false);
  });

  it("keeps assets with no items in assets[] but contributes no rows for them", () => {
    const inv = buildPinInventory([asset("1"), asset("2")], new Map([["1", [{ name: "port1" }]]]), "interfaces");
    expect(inv.assets).toHaveLength(2);
    expect(inv.rows).toHaveLength(1);
    expect(inv.rows[0]!.deviceCount).toBe(1);
  });

  it("dedupes a duplicate item name within one asset", () => {
    const items = new Map<string, InventoryItem[]>([
      ["1", [{ name: "port1" }, { name: "port1" }]],
    ]);
    const inv = buildPinInventory([asset("1")], items, "interfaces");
    expect(inv.rows[0]!.deviceCount).toBe(1);
    expect(inv.rows[0]!.devices).toHaveLength(1);
  });

  it("prefers a non-null ifType and lets any tunnel sighting mark the row", () => {
    const items = new Map<string, InventoryItem[]>([
      ["1", [{ name: "x", ifType: null }]],
      ["2", [{ name: "x", ifType: "tunnel", isIpsecTunnel: true }]],
    ]);
    const inv = buildPinInventory([asset("1"), asset("2")], items, "interfaces");
    expect(inv.rows[0]!.ifType).toBe("tunnel");
    expect(inv.rows[0]!.isIpsecTunnel).toBe(true);
  });

  it("empty inputs produce an empty inventory", () => {
    const inv = buildPinInventory([], new Map(), "interfaces");
    expect(inv.assets).toEqual([]);
    expect(inv.rows).toEqual([]);
  });
});

describe("computeFinalPinArrays", () => {
  const current = () => ({
    monitoredInterfaces: ["port1", "port2"],
    monitoredStorage: ["/var"],
    monitoredIpsecTunnels: ["vpn-hq"],
  });

  it("pins dedupe against the existing array", () => {
    const r = computeFinalPinArrays(current(), [{ name: "port1", field: "interfaces" }], []);
    expect(r.changed).toBe(false);
    expect(r.added).toBe(0);
    expect(r.data.monitoredInterfaces).toEqual(["port1", "port2"]);
  });

  it("adds new pins to the field the delta names", () => {
    const r = computeFinalPinArrays(current(), [
      { name: "port9", field: "interfaces" },
      { name: "/home", field: "storage" },
      { name: "vpn-dr", field: "ipsecTunnels" },
    ], []);
    expect(r.changed).toBe(true);
    expect(r.added).toBe(3);
    expect(r.data.monitoredInterfaces).toContain("port9");
    expect(r.data.monitoredStorage).toContain("/home");
    expect(r.data.monitoredIpsecTunnels).toContain("vpn-dr");
  });

  it("an interface-family unpin removes the name from BOTH interface arrays", () => {
    const cur = {
      monitoredInterfaces: ["vpn-hq"],
      monitoredStorage: [],
      monitoredIpsecTunnels: ["vpn-hq"],
    };
    const r = computeFinalPinArrays(cur, [], [{ name: "vpn-hq", field: "ipsecTunnels" }]);
    expect(r.data.monitoredInterfaces).toEqual([]);
    expect(r.data.monitoredIpsecTunnels).toEqual([]);
    // One removal of one NAME, even though it lived in two arrays.
    expect(r.removed).toBe(1);
  });

  it("a storage unpin never touches the interface arrays", () => {
    const cur = {
      monitoredInterfaces: ["/var"], // pathological same-name pin
      monitoredStorage: ["/var"],
      monitoredIpsecTunnels: [],
    };
    const r = computeFinalPinArrays(cur, [], [{ name: "/var", field: "storage" }]);
    expect(r.data.monitoredStorage).toEqual([]);
    expect(r.data.monitoredInterfaces).toEqual(["/var"]);
  });

  it("a contradictory pin+unpin of the same name nets to the pin", () => {
    const r = computeFinalPinArrays(current(),
      [{ name: "port1", field: "interfaces" }],
      [{ name: "port1", field: "interfaces" }]);
    expect(r.data.monitoredInterfaces).toContain("port1");
  });

  it("no-op deltas report changed:false", () => {
    const r = computeFinalPinArrays(current(), [], [{ name: "nope", field: "storage" }]);
    expect(r.changed).toBe(false);
    expect(r.removed).toBe(0);
  });

  it("enforces the per-array cap: exactly at the cap passes, one over marks capField", () => {
    const base = { monitoredInterfaces: [] as string[], monitoredStorage: [], monitoredIpsecTunnels: [] };
    const pinsAt = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: "p" + i, field: "interfaces" as PinField }));
    expect(computeFinalPinArrays(base, pinsAt(MASS_PIN_ARRAY_CAP), []).capField).toBeNull();
    const over = computeFinalPinArrays(base, pinsAt(MASS_PIN_ARRAY_CAP + 1), []);
    expect(over.capField).toBe("interfaces");
  });

  it("unpins can bring an over-cap batch back under the cap", () => {
    const cur = {
      monitoredInterfaces: Array.from({ length: MASS_PIN_ARRAY_CAP }, (_, i) => "p" + i),
      monitoredStorage: [],
      monitoredIpsecTunnels: [],
    };
    const r = computeFinalPinArrays(cur,
      [{ name: "new1", field: "interfaces" }],
      [{ name: "p0", field: "interfaces" }]);
    expect(r.capField).toBeNull();
    expect(r.data.monitoredInterfaces).toHaveLength(MASS_PIN_ARRAY_CAP);
  });
});
