import { describe, it, expect } from "vitest";
import {
  decodePortList,
  derivePortVlans,
  isVlanId,
  type VlanMembership,
} from "../../src/utils/portVlans.js";

describe("decodePortList", () => {
  // RFC 4363 PortList: octet 0's MSB is dot1dBasePort 1. Decoding LSB-first
  // produces a plausible-looking wrong port set, so pin the bit order hard.
  it("reads octet 0's most-significant bit as port 1", () => {
    expect(decodePortList(Buffer.from([0x80]))).toEqual([1]);
    expect(decodePortList(Buffer.from([0x01]))).toEqual([8]);
    expect(decodePortList(Buffer.from([0x00, 0x80]))).toEqual([9]);
  });

  it("decodes a multi-octet bitmap across byte boundaries", () => {
    // 0xA0 = ports 1,3 · 0x00 = none · 0x03 = ports 23,24
    expect(decodePortList(Buffer.from([0xa0, 0x00, 0x03]))).toEqual([1, 3, 23, 24]);
  });

  it("returns ports in ascending order", () => {
    const ports = decodePortList(Buffer.from([0xff, 0xff]));
    expect(ports).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it("treats an all-zero or empty bitmap as naming no ports", () => {
    expect(decodePortList(Buffer.from([0x00, 0x00]))).toEqual([]);
    expect(decodePortList(Buffer.alloc(0))).toEqual([]);
  });

  it("accepts a Uint8Array and a raw byte string, refuses anything else", () => {
    expect(decodePortList(new Uint8Array([0x40]))).toEqual([2]);
    expect(decodePortList(String.fromCharCode(0x40))).toEqual([2]);
    expect(decodePortList(null)).toEqual([]);
    expect(decodePortList(undefined)).toEqual([]);
    expect(decodePortList(42)).toEqual([]);
    expect(decodePortList("")).toEqual([]);
  });
});

describe("isVlanId", () => {
  it("accepts 1..4094 and nothing else", () => {
    expect(isVlanId(1)).toBe(true);
    expect(isVlanId(4094)).toBe(true);
    expect(isVlanId(0)).toBe(false);
    expect(isVlanId(4095)).toBe(false);
    expect(isVlanId(1.5)).toBe(false);
    expect(isVlanId("10")).toBe(false);
    expect(isVlanId(null)).toBe(false);
  });
});

describe("derivePortVlans", () => {
  it("takes nativeVlan from the PVID, never from membership", () => {
    const out = derivePortVlans(new Map([[1, 10], [2, 20]]), []);
    expect(out.get(1)).toEqual({ nativeVlan: 10, taggedVlans: [] });
    expect(out.get(2)).toEqual({ nativeVlan: 20, taggedVlans: [] });
  });

  it("rejects an out-of-range PVID rather than storing it", () => {
    const out = derivePortVlans(new Map([[1, 0], [2, 4095]]), []);
    expect(out.get(1)!.nativeVlan).toBeNull();
    expect(out.get(2)!.nativeVlan).toBeNull();
  });

  // The honest agent: untagged is a strict subset of egress, so it is believed.
  it("believes a strict-subset untagged column", () => {
    const memberships: VlanMembership[] = [
      { vlanId: 10, egress: [1, 2, 24], untagged: [1] },
      { vlanId: 20, egress: [2, 24], untagged: [2] },
    ];
    const out = derivePortVlans(new Map([[1, 10], [2, 20], [24, 1]]), memberships);
    expect(out.get(1)).toEqual({ nativeVlan: 10, taggedVlans: [] });
    expect(out.get(2)).toEqual({ nativeVlan: 20, taggedVlans: [10] });
    // The uplink carries both tagged.
    expect(out.get(24)).toEqual({ nativeVlan: 1, taggedVlans: [10, 20] });
  });

  // The FortiSwitch case (prod 2026-08): untagged is a verbatim copy of egress.
  // Believing it would leave every port with an empty tagged set.
  it("ignores an untagged column that merely echoes egress, falling back to the PVID", () => {
    const memberships: VlanMembership[] = [
      { vlanId: 10, egress: [1, 24], untagged: [1, 24] },
      { vlanId: 20, egress: [2, 24], untagged: [2, 24] },
    ];
    const out = derivePortVlans(new Map([[1, 10], [2, 20], [24, 1]]), memberships);
    expect(out.get(1)).toEqual({ nativeVlan: 10, taggedVlans: [] });
    expect(out.get(2)).toEqual({ nativeVlan: 20, taggedVlans: [] });
    expect(out.get(24)).toEqual({ nativeVlan: 1, taggedVlans: [10, 20] });
  });

  it("ignores an untagged column carrying ports that aren't egress members", () => {
    const memberships: VlanMembership[] = [
      // untagged is the same SIZE as a strict subset would be but names a
      // non-member, so it isn't a subset and can't be believed.
      { vlanId: 10, egress: [1, 2], untagged: [99] },
    ];
    const out = derivePortVlans(new Map([[1, 10], [2, 1]]), memberships);
    expect(out.get(1)!.taggedVlans).toEqual([]);   // excluded by its own PVID
    expect(out.get(2)!.taggedVlans).toEqual([10]);
  });

  it("never lists a port's own native VLAN as tagged, even when untagged is believed", () => {
    const memberships: VlanMembership[] = [
      // A contradictory agent: port 1's PVID is 10, but it isn't in VLAN 10's
      // untagged list. The PVID wins — a port is untagged in its native VLAN.
      { vlanId: 10, egress: [1, 2], untagged: [2] },
    ];
    const out = derivePortVlans(new Map([[1, 10]]), memberships);
    expect(out.get(1)!.taggedVlans).toEqual([]);
  });

  it("returns sorted tagged VLANs regardless of walk order", () => {
    const memberships: VlanMembership[] = [
      { vlanId: 300, egress: [1], untagged: [] },
      { vlanId: 20, egress: [1], untagged: [] },
      { vlanId: 100, egress: [1], untagged: [] },
    ];
    const out = derivePortVlans(new Map([[1, 1]]), memberships);
    expect(out.get(1)!.taggedVlans).toEqual([20, 100, 300]);
  });

  // dot1qVlanCurrentTable is indexed by { timeMark, vlanId }, so one VLAN can
  // legally appear more than once in the walk.
  it("de-duplicates a VLAN that appears in the walk twice", () => {
    const out = derivePortVlans(new Map([[1, 1]]), [
      { vlanId: 10, egress: [1], untagged: [] },
      { vlanId: 10, egress: [1], untagged: [] },
    ]);
    expect(out.get(1)!.taggedVlans).toEqual([10]);
  });

  it("includes a port known only from a bitmap, with a null native VLAN", () => {
    const out = derivePortVlans(new Map(), [{ vlanId: 10, egress: [7], untagged: [] }]);
    expect(out.get(7)).toEqual({ nativeVlan: null, taggedVlans: [10] });
  });

  it("omits ports nothing reported, so 'no VLAN data' stays distinguishable", () => {
    const out = derivePortVlans(new Map(), []);
    expect(out.size).toBe(0);
  });

  it("skips out-of-range VLAN ids and empty egress sets", () => {
    const memberships: VlanMembership[] = [
      { vlanId: 4095, egress: [1], untagged: [] },
      { vlanId: 0, egress: [1], untagged: [] },
      { vlanId: 30, egress: [], untagged: [] },
    ];
    const out = derivePortVlans(new Map([[1, 1]]), memberships);
    expect(out.get(1)!.taggedVlans).toEqual([]);
  });
});
