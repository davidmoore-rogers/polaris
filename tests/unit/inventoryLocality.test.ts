/**
 * tests/unit/inventoryLocality.test.ts
 *
 * The locality gate on FortiOS device-inventory sightings: a ZTNA access
 * proxy session creates an inventory entry on the gate the user connects
 * THROUGH, so an entry may only LOCATE a device on positive local evidence —
 * FortiSwitch/FortiAP attribution on the row, or an ARP binding for the same
 * MAC on the same gate this cycle.
 */

import { describe, it, expect } from "vitest";
import {
  buildArpMacDeviceIndex,
  inventorySightingIsLocal,
  inventorySwitchAttribution,
  INVENTORY_QUERY_FORMAT,
} from "../../src/utils/inventoryLocality.js";

describe("buildArpMacDeviceIndex", () => {
  it("keys on normalized MAC + lowercased device", () => {
    const idx = buildArpMacDeviceIndex([
      { fortigateDevice: "METRO-1801F-1", mac: "68-34-21-b7-70-d7" },
    ]);
    expect(idx.has("68:34:21:B7:70:D7|metro-1801f-1")).toBe(true);
  });

  it("skips rows missing either half, and tolerates null/undefined input", () => {
    const idx = buildArpMacDeviceIndex([
      { fortigateDevice: "GATE-1", mac: null },
      { fortigateDevice: null, mac: "AA:BB:CC:DD:EE:FF" },
    ]);
    expect(idx.size).toBe(0);
    expect(buildArpMacDeviceIndex(null).size).toBe(0);
    expect(buildArpMacDeviceIndex(undefined).size).toBe(0);
  });
});

describe("inventorySightingIsLocal", () => {
  const empty = new Set<string>();

  it("FortiSwitch attribution is local by definition", () => {
    expect(inventorySightingIsLocal(
      { device: "GATE-1", macAddress: "AA:BB:CC:DD:EE:FF", switchName: "CKYSMA-148F-1", apName: "" },
      empty,
    )).toBe(true);
  });

  it("FortiAP attribution is local by definition", () => {
    expect(inventorySightingIsLocal(
      { device: "GATE-1", macAddress: "AA:BB:CC:DD:EE:FF", switchName: "", apName: "METRO3RD-431F-3" },
      empty,
    )).toBe(true);
  });

  it("an ARP binding on the SAME gate makes a bare row local", () => {
    const idx = buildArpMacDeviceIndex([
      { fortigateDevice: "Metro-1801F-1", mac: "aa:bb:cc:dd:ee:ff" },
    ]);
    expect(inventorySightingIsLocal(
      { device: "METRO-1801F-1", macAddress: "AA-BB-CC-DD-EE-FF", switchName: "", apName: "" },
      idx,
    )).toBe(true);
  });

  it("an ARP binding on a DIFFERENT gate does not vouch for this one", () => {
    const idx = buildArpMacDeviceIndex([
      { fortigateDevice: "METRO-1801F-1", mac: "AA:BB:CC:DD:EE:FF" },
    ]);
    // The ZTNA shape: fresh entry, no switch/AP, no ARP on the reporting gate.
    expect(inventorySightingIsLocal(
      { device: "JAMESTOWNSTONE-61F-1", macAddress: "AA:BB:CC:DD:EE:FF", switchName: "", apName: "" },
      idx,
    )).toBe(false);
  });

  it("a bare row with no MAC or no device can never prove locality", () => {
    expect(inventorySightingIsLocal({ device: "GATE-1", macAddress: "", switchName: "", apName: "" }, empty)).toBe(false);
    expect(inventorySightingIsLocal({ device: "", macAddress: "AA:BB:CC:DD:EE:FF", switchName: "", apName: "" }, empty)).toBe(false);
  });
});

describe("inventorySwitchAttribution", () => {
  it("reads the legacy field names", () => {
    expect(inventorySwitchAttribution({ switch_fortilink: "SW-1", switch_port: 7 }))
      .toEqual({ switchName: "SW-1", switchPort: "7" });
    expect(inventorySwitchAttribution({ fortiswitch: "SW-2", switch_port: "12" }))
      .toEqual({ switchName: "SW-2", switchPort: "12" });
  });

  it("reads the 7.x fortiswitch_* field names", () => {
    expect(inventorySwitchAttribution({
      fortiswitch_id: "CKYSMA-148F-1",
      fortiswitch_port_id: 43,
      fortiswitch_port_name: "port43",
    })).toEqual({ switchName: "CKYSMA-148F-1", switchPort: "43" });
  });

  it("strips a port_name's own 'port' prefix so the render can't double it", () => {
    expect(inventorySwitchAttribution({ fortiswitch_id: "SW-3", fortiswitch_port_name: "port43" }))
      .toEqual({ switchName: "SW-3", switchPort: "43" });
  });

  it("empty when the row carries no switch attribution", () => {
    expect(inventorySwitchAttribution({})).toEqual({ switchName: "", switchPort: "" });
  });

  it("the shared format list requests every field the fallback chains read", () => {
    for (const f of [
      "switch_fortilink", "fortiswitch", "fortiswitch_id",
      "switch_port", "fortiswitch_port_id", "fortiswitch_port_name",
      "ap_name", "fortiap", "is_online", "last_seen",
    ]) {
      expect(INVENTORY_QUERY_FORMAT.split("|")).toContain(f);
    }
  });
});
