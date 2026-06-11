/**
 * tests/unit/fortiswitchTrunkMembers.test.ts
 *
 * Pure-function coverage for the FortiSwitch trunk → physical-member overlay.
 * SNMP IF-MIB surfaces a managed switch's FortiLink uplink trunk and its
 * member ports as flat, unrelated rows; the controller's managed-switch CMDB
 * is the only source of the parent/member edge. `parseFortiosMemberList`
 * normalizes the CMDB member shapes, and `overlayFortiswitchTrunkMembers`
 * back-fills `ifParent` so the topology layer can swap a single-member trunk
 * (e.g. the serial-named uplink → port52) for its physical port.
 */

import { describe, it, expect } from "vitest";
import {
  parseFortiosMemberList,
  overlayFortiswitchTrunkMembers,
  type InterfaceSample,
} from "../../src/services/monitoringService.js";

describe("parseFortiosMemberList", () => {
  it("reads an array of { member-name } objects", () => {
    expect(parseFortiosMemberList([{ "member-name": "port52" }, { "member-name": "port53" }]))
      .toEqual(["port52", "port53"]);
  });

  it("falls back to q_origin_key / name / interface-name keys", () => {
    expect(parseFortiosMemberList([{ q_origin_key: "port1" }, { name: "port2" }, { "interface-name": "port3" }]))
      .toEqual(["port1", "port2", "port3"]);
  });

  it("reads an array of bare strings", () => {
    expect(parseFortiosMemberList(["port52", "port53"])).toEqual(["port52", "port53"]);
  });

  it("splits a space- or comma-separated string", () => {
    expect(parseFortiosMemberList("port52 port53")).toEqual(["port52", "port53"]);
    expect(parseFortiosMemberList("port52,port53")).toEqual(["port52", "port53"]);
  });

  it("de-dupes and drops blanks", () => {
    expect(parseFortiosMemberList(["port52", "", "port52", { "member-name": "  " }])).toEqual(["port52"]);
  });

  it("is null/garbage tolerant", () => {
    expect(parseFortiosMemberList(null)).toEqual([]);
    expect(parseFortiosMemberList(undefined)).toEqual([]);
    expect(parseFortiosMemberList(42)).toEqual([]);
    expect(parseFortiosMemberList([null, {}, 7])).toEqual([]);
  });
});

describe("overlayFortiswitchTrunkMembers", () => {
  const mk = (ifName: string, extra: Partial<InterfaceSample> = {}): InterfaceSample => ({
    ifName,
    ifType: "physical",
    operStatus: "up",
    ...extra,
  });

  it("stamps ifParent on the member and marks the trunk an aggregate", () => {
    const ifaces: InterfaceSample[] = [
      mk("G101FTK23018814", { ifType: null }), // the serial-named uplink trunk
      mk("port52"),
    ];
    const links = overlayFortiswitchTrunkMembers(ifaces, new Map([["G101FTK23018814", ["port52"]]]));
    expect(links).toBe(1);
    expect(ifaces.find((i) => i.ifName === "G101FTK23018814")!.ifType).toBe("aggregate");
    const member = ifaces.find((i) => i.ifName === "port52")!;
    expect(member.ifParent).toBe("G101FTK23018814");
    expect(member.ifType).toBe("physical");
  });

  it("synthesizes a member row when IF-MIB omitted the subordinate port", () => {
    const ifaces: InterfaceSample[] = [mk("trunkA", { ifType: "aggregate" })];
    const links = overlayFortiswitchTrunkMembers(ifaces, new Map([["trunkA", ["port9"]]]));
    expect(links).toBe(1);
    const synth = ifaces.find((i) => i.ifName === "port9");
    expect(synth).toBeDefined();
    expect(synth!.ifParent).toBe("trunkA");
    expect(synth!.ifType).toBe("physical");
    expect(synth!.operStatus ?? null).toBeNull();
  });

  it("never clobbers an existing ifParent or a real aggregate type", () => {
    const ifaces: InterfaceSample[] = [
      mk("trunkA", { ifType: "aggregate" }),
      mk("port5", { ifParent: "preexisting" }),
    ];
    overlayFortiswitchTrunkMembers(ifaces, new Map([["trunkA", ["port5"]]]));
    expect(ifaces.find((i) => i.ifName === "port5")!.ifParent).toBe("preexisting");
    expect(ifaces.find((i) => i.ifName === "trunkA")!.ifType).toBe("aggregate");
  });

  it("handles multi-member LACP bundles (all members linked)", () => {
    const ifaces: InterfaceSample[] = [mk("lag1", { ifType: "aggregate" }), mk("port1"), mk("port2")];
    const links = overlayFortiswitchTrunkMembers(ifaces, new Map([["lag1", ["port1", "port2"]]]));
    expect(links).toBe(2);
    expect(ifaces.find((i) => i.ifName === "port1")!.ifParent).toBe("lag1");
    expect(ifaces.find((i) => i.ifName === "port2")!.ifParent).toBe("lag1");
  });

  it("is a no-op for an empty trunk map", () => {
    const ifaces: InterfaceSample[] = [mk("port1")];
    expect(overlayFortiswitchTrunkMembers(ifaces, new Map())).toBe(0);
    expect(ifaces).toHaveLength(1);
  });
});
