import { describe, it, expect } from "vitest";
import {
  basePortToIfName,
  fdbStatusIsUsable,
  inferDirectAttachments,
  fdbStatusLabel,
  macCountsByPort,
  macFromOidParts,
  parseFdbIndex,
  type FdbEntry,
} from "../../src/utils/macForwarding.js";

describe("fdbStatusLabel / fdbStatusIsUsable", () => {
  it("decodes the RFC status enum", () => {
    expect(fdbStatusLabel(1)).toBe("other");
    expect(fdbStatusLabel(2)).toBe("invalid");
    expect(fdbStatusLabel(3)).toBe("learned");
    expect(fdbStatusLabel(4)).toBe("self");
    expect(fdbStatusLabel(5)).toBe("mgmt");
    expect(fdbStatusLabel(null)).toBe("other");
  });

  // invalid(2) is an aged-out entry the agent hasn't reaped. Keeping it would
  // put MACs on ports they have already left.
  it("drops invalid entries and keeps the real ones", () => {
    expect(fdbStatusIsUsable("invalid")).toBe(false);
    expect(fdbStatusIsUsable("other")).toBe(false);
    expect(fdbStatusIsUsable("learned")).toBe(true);
    expect(fdbStatusIsUsable("self")).toBe(true);
    expect(fdbStatusIsUsable("mgmt")).toBe(true);
  });
});

describe("macFromOidParts", () => {
  it("decodes six decimal octets to colon-uppercase", () => {
    expect(macFromOidParts(["0", "12", "41", "170", "187", "204"])).toBe("00:0C:29:AA:BB:CC");
  });

  it("zero-pads single-hex-digit octets", () => {
    expect(macFromOidParts(["1", "2", "3", "4", "5", "6"])).toBe("01:02:03:04:05:06");
  });

  it("rejects wrong lengths and out-of-range octets", () => {
    expect(macFromOidParts(["1", "2", "3"])).toBeNull();
    expect(macFromOidParts(["1", "2", "3", "4", "5", "6", "7"])).toBeNull();
    expect(macFromOidParts(["1", "2", "3", "4", "5", "256"])).toBeNull();
    expect(macFromOidParts(["1", "2", "3", "4", "5", "x"])).toBeNull();
  });
});

describe("parseFdbIndex", () => {
  // The component COUNT is what distinguishes the two tables, which is why the
  // collector doesn't have to tell the parser which one a row came from.
  it("reads the VLAN-aware Q-BRIDGE index (fdbId + MAC)", () => {
    expect(parseFdbIndex("10.0.12.41.170.187.204")).toEqual({
      fdbId: 10,
      macAddress: "00:0C:29:AA:BB:CC",
    });
  });

  it("reads the BRIDGE-MIB index (MAC alone) with no VLAN", () => {
    expect(parseFdbIndex("0.12.41.170.187.204")).toEqual({
      fdbId: null,
      macAddress: "00:0C:29:AA:BB:CC",
    });
  });

  it("rejects suffixes that are neither shape", () => {
    expect(parseFdbIndex("")).toBeNull();
    expect(parseFdbIndex("1.2.3")).toBeNull();
    expect(parseFdbIndex("1.2.3.4.5.6.7.8")).toBeNull();
  });
});

describe("basePortToIfName", () => {
  // Both FDB tables report a dot1dBasePort, NOT an ifIndex. Skipping this
  // composition attributes every MAC to whatever interface happens to sit at
  // that ifIndex — reliably wrong on any switch where the two numbering
  // schemes differ.
  it("composes basePort → ifIndex → ifName", () => {
    const basePortToIfIndex = new Map<string, number>([["1", 101], ["2", 102]]);
    const ifNameByIndex = new Map<string, string>([["101", "port1"], ["102", "port2"]]);
    const out = basePortToIfName(basePortToIfIndex, ifNameByIndex);
    expect(out.get(1)).toBe("port1");
    expect(out.get(2)).toBe("port2");
  });

  it("omits a basePort whose ifIndex has no name rather than guessing", () => {
    const out = basePortToIfName(
      new Map([["1", 101], ["2", 999]]),
      new Map([["101", "port1"]]),
    );
    expect(out.get(1)).toBe("port1");
    expect(out.has(2)).toBe(false);
  });
});

describe("macCountsByPort", () => {
  const entries: FdbEntry[] = [
    { macAddress: "AA:AA:AA:AA:AA:01", vlanId: 1, basePort: 1, ifName: "port1", status: "learned" },
    { macAddress: "AA:AA:AA:AA:AA:02", vlanId: 1, basePort: 2, ifName: "port2", status: "learned" },
    { macAddress: "AA:AA:AA:AA:AA:03", vlanId: 1, basePort: 2, ifName: "port2", status: "learned" },
    { macAddress: "AA:AA:AA:AA:AA:04", vlanId: 1, basePort: 2, ifName: "port2", status: "learned" },
    // The switch's own address — says nothing about what is reachable via the port.
    { macAddress: "BB:BB:BB:BB:BB:BB", vlanId: 1, basePort: 1, ifName: "port1", status: "self" },
    { macAddress: "CC:CC:CC:CC:CC:CC", vlanId: 1, basePort: null, ifName: null, status: "learned" },
  ];

  it("counts learned entries per port", () => {
    const counts = macCountsByPort(entries);
    expect(counts.get("port1")).toBe(1);
    expect(counts.get("port2")).toBe(3);
  });

  it("excludes self entries and unresolved ports", () => {
    const counts = macCountsByPort(entries);
    // port1 has a self row too — it must not be counted.
    expect(counts.get("port1")).toBe(1);
    expect(counts.size).toBe(2);
  });

  // This is the number the access-vs-uplink distinction rests on.
  it("separates a single-endpoint access port from a multi-MAC uplink", () => {
    const counts = macCountsByPort(entries);
    expect(counts.get("port1")).toBe(1);
    expect((counts.get("port2") ?? 0) > 1).toBe(true);
  });
});

describe("inferDirectAttachments", () => {
  const mk = (ifName: string | null, mac: string, matchedAssetId: string | null, status = "learned") =>
    ({ macAddress: mac, vlanId: 1, basePort: 1, ifName, status, matchedAssetId });

  it("claims a port with exactly one learned, matched MAC", () => {
    expect(inferDirectAttachments([mk("port5", "AA:AA:AA:AA:AA:01", "asset-1")]))
      .toEqual([{ ifName: "port5", assetId: "asset-1" }]);
  });

  // The core restriction: many MACs means the far end is a switch with a
  // network behind it. Picking one would be a guess dressed as a fact.
  it("claims nothing on a multi-MAC uplink", () => {
    const out = inferDirectAttachments([
      mk("port49", "AA:AA:AA:AA:AA:01", "asset-1"),
      mk("port49", "AA:AA:AA:AA:AA:02", "asset-2"),
    ]);
    expect(out).toEqual([]);
  });

  // An IP phone with a PC behind it. The port genuinely is not one device.
  it("claims nothing on a phone+PC daisy chain", () => {
    const out = inferDirectAttachments([
      mk("port3", "AA:AA:AA:AA:AA:0A", "phone-1"),
      mk("port3", "AA:AA:AA:AA:AA:0B", "pc-1"),
    ]);
    expect(out).toEqual([]);
  });

  it("ignores unmatched MACs — a lone unknown device names nothing", () => {
    expect(inferDirectAttachments([mk("port7", "AA:AA:AA:AA:AA:07", null)])).toEqual([]);
  });

  it("ignores self and mgmt rows", () => {
    const out = inferDirectAttachments([
      mk("port1", "BB:BB:BB:BB:BB:BB", "sw-1", "self"),
      mk("port2", "CC:CC:CC:CC:CC:CC", "srv-1", "mgmt"),
    ]);
    expect(out).toEqual([]);
  });

  // A self row alongside the single learned row must not make the port look
  // ambiguous — it is excluded before the count is taken.
  it("still claims a port whose only other row is self", () => {
    const out = inferDirectAttachments([
      mk("port5", "AA:AA:AA:AA:AA:01", "asset-1"),
      mk("port5", "BB:BB:BB:BB:BB:BB", "sw-1", "self"),
    ]);
    expect(out).toEqual([{ ifName: "port5", assetId: "asset-1" }]);
  });

  it("ignores rows whose port never resolved", () => {
    expect(inferDirectAttachments([mk(null, "AA:AA:AA:AA:AA:01", "asset-1")])).toEqual([]);
  });
});
