/**
 * tests/unit/arpNeighbors.test.ts — decoding the IP-MIB neighbour cache.
 *
 * The load-bearing cases are the INDEX decoders: on ipNetToPhysicalTable the
 * address exists nowhere but the OID, so a decoder that is wrong about the
 * RFC 4001 length prefix invents addresses rather than failing.
 */

import { describe, it, expect } from "vitest";
import {
  parsePhysicalIndex,
  parseMediaIndex,
  ipv6FromBytes,
  buildArpNeighbors,
  ageFromLastUpdated,
} from "../../src/utils/arpNeighbors.js";

const toNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const mac = (...bytes: number[]) => new Uint8Array(bytes);

describe("parsePhysicalIndex", () => {
  it("decodes an IPv4 row: ifIndex, type 1, length 4, then the octets", () => {
    expect(parsePhysicalIndex("7.1.4.10.4.12.63")).toEqual({ ifIndex: 7, address: "10.4.12.63" });
  });

  it("decodes an IPv6 row", () => {
    const bytes = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    expect(parsePhysicalIndex(`3.2.16.${bytes.join(".")}`)).toEqual({ ifIndex: 3, address: "2001:db8::1" });
  });

  it("handles a multi-digit ifIndex", () => {
    expect(parsePhysicalIndex("1057.1.4.192.168.1.1")?.ifIndex).toBe(1057);
  });

  it("rejects a length prefix that disagrees with the byte count", () => {
    // Says 4 bytes, supplies 3 — the exact shape an off-by-one decoder produces.
    expect(parsePhysicalIndex("7.1.4.10.4.12")).toBeNull();
  });

  it("rejects an address type it cannot represent as a neighbour", () => {
    // addressType 16 = dns(16) in InetAddressType — not an address on the wire.
    expect(parsePhysicalIndex("7.16.4.10.4.12.63")).toBeNull();
  });

  it("rejects an IPv4 row whose length is not 4", () => {
    expect(parsePhysicalIndex("7.1.6.10.4.12.63.1.2")).toBeNull();
  });

  it("rejects a truncated or non-numeric suffix", () => {
    expect(parsePhysicalIndex("7.1")).toBeNull();
    expect(parsePhysicalIndex("")).toBeNull();
    expect(parsePhysicalIndex("a.1.4.10.4.12.63")).toBeNull();
  });

  it("rejects an octet above 255", () => {
    expect(parsePhysicalIndex("7.1.4.10.4.12.300")).toBeNull();
  });
});

describe("parseMediaIndex", () => {
  it("decodes the legacy IPv4-only shape with no length prefix", () => {
    expect(parseMediaIndex("7.10.4.12.63")).toEqual({ ifIndex: 7, address: "10.4.12.63" });
  });

  it("rejects anything that is not exactly ifIndex + four octets", () => {
    expect(parseMediaIndex("7.1.4.10.4.12.63")).toBeNull();
    expect(parseMediaIndex("7.10.4.12")).toBeNull();
  });

  it("does not accept a physical-table suffix by mistake", () => {
    // 5 components, but they mean {ifIndex, type, len, b, b} — the guard that
    // matters is the octet range, since a length prefix of 4 looks like an octet.
    expect(parseMediaIndex("7.1.4.256.1")).toBeNull();
  });
});

describe("ipv6FromBytes", () => {
  it("collapses the longest zero run", () => {
    expect(ipv6FromBytes([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])).toBe("2001:db8::1");
  });

  it("leaves a single zero group uncollapsed, per RFC 5952", () => {
    const b = [0x20, 0x01, 0, 0, 0x0d, 0xb8, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5];
    expect(ipv6FromBytes(b)).toBe("2001:0:db8:1:2:3:4:5");
  });

  it("renders the unspecified address", () => {
    expect(ipv6FromBytes(new Array(16).fill(0))).toBe("::");
  });

  it("renders a link-local address", () => {
    const b = [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0x02, 0x1a, 0x2b, 0xff, 0xfe, 0x3c, 0x4d, 0x5e];
    expect(ipv6FromBytes(b)).toBe("fe80::21a:2bff:fe3c:4d5e");
  });
});

describe("ageFromLastUpdated", () => {
  it("turns a sysUpTime stamp into seconds since refresh", () => {
    // TimeTicks are hundredths: 500 ticks after the stamp = 5 s.
    expect(ageFromLastUpdated(100_000, 100_500)).toBe(5);
  });

  it("returns null, not 0, when either value is missing", () => {
    expect(ageFromLastUpdated(null, 100_500)).toBeNull();
    expect(ageFromLastUpdated(100_000, null)).toBeNull();
  });

  it("returns null for the documented never-updated value", () => {
    expect(ageFromLastUpdated(0, 100_500)).toBeNull();
  });

  it("returns null for a stamp in the future rather than a negative age", () => {
    // sysUpTime wrapped, or the two reads straddled an agent restart.
    expect(ageFromLastUpdated(200_000, 100_000)).toBeNull();
  });
});

describe("buildArpNeighbors", () => {
  const ifNameByIndex = new Map([[7, "internal3"], [3, "wan1"]]);

  const physical = (over: Partial<Parameters<typeof buildArpNeighbors>[0]> = {}) =>
    buildArpNeighbors({
      physAddress: new Map([["7.1.4.10.4.12.63", mac(0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x01)]]),
      ifNameByIndex, variant: "physical", toNumber, ...over,
    });

  it("assembles a row with the interface joined through ifIndex", () => {
    expect(physical()).toEqual([
      { ipAddress: "10.4.12.63", macAddress: "AA:BB:CC:DD:EE:01", ifName: "internal3", ageSec: null },
    ]);
  });

  it("keeps the row with a null ifName when the ifIndex does not resolve", () => {
    expect(physical({ ifNameByIndex: new Map() })[0].ifName).toBeNull();
  });

  it("drops a row whose MAC does not decode", () => {
    expect(physical({ physAddress: new Map([["7.1.4.10.4.12.63", new Uint8Array([1, 2, 3])]]) })).toEqual([]);
  });

  it("drops a row whose index does not decode", () => {
    expect(physical({ physAddress: new Map([["garbage", mac(1, 2, 3, 4, 5, 6)]]) })).toEqual([]);
  });

  it("drops an invalid type", () => {
    expect(physical({ type: new Map([["7.1.4.10.4.12.63", 2]]) })).toEqual([]);
  });

  it("drops invalid and incomplete states", () => {
    expect(physical({ state: new Map([["7.1.4.10.4.12.63", 5]]) })).toEqual([]);
    expect(physical({ state: new Map([["7.1.4.10.4.12.63", 7]]) })).toEqual([]);
  });

  it("keeps a stale entry — stale is still a binding the device holds", () => {
    expect(physical({ state: new Map([["7.1.4.10.4.12.63", 2]]) })).toHaveLength(1);
  });

  it("keeps a local(5) row — the gate's own address on the segment", () => {
    expect(physical({ type: new Map([["7.1.4.10.4.12.63", 5]]) })).toHaveLength(1);
  });

  it("keeps every row when the optional columns were not walked", () => {
    expect(physical({ type: undefined, state: undefined })).toHaveLength(1);
  });

  it("computes the age from LastUpdated against sysUpTime", () => {
    const rows = physical({
      lastUpdated:    new Map([["7.1.4.10.4.12.63", 90_000]]),
      sysUpTimeTicks: 96_000,
    });
    expect(rows[0].ageSec).toBe(60);
  });

  it("decodes the legacy table through the media index", () => {
    const rows = buildArpNeighbors({
      physAddress: new Map([["7.10.4.12.63", mac(0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x01)]]),
      type:        new Map([["7.10.4.12.63", 3]]),
      ifNameByIndex, variant: "media", toNumber,
    });
    expect(rows).toEqual([
      { ipAddress: "10.4.12.63", macAddress: "AA:BB:CC:DD:EE:01", ifName: "internal3", ageSec: null },
    ]);
  });

  it("carries an IPv6 neighbour through, which the REST endpoint cannot supply", () => {
    const bytes = [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0x02, 0x1a, 0x2b, 0xff, 0xfe, 0x3c, 0x4d, 0x5e];
    const rows = physical({
      physAddress: new Map([[`3.2.16.${bytes.join(".")}`, mac(0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e)]]),
    });
    expect(rows[0]).toMatchObject({ ipAddress: "fe80::21a:2bff:fe3c:4d5e", ifName: "wan1" });
  });
});
