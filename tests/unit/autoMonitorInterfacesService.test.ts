/**
 * tests/unit/autoMonitorInterfacesService.test.ts
 *
 * Pure-function coverage for the resolver + pattern compiler + legacy
 * coercion. No DB calls; the DB-bound functions (apply/preview/aggregate)
 * are exercised by the integration test suite.
 */

import { describe, it, expect } from "vitest";
import {
  compileWildcard,
  compilePattern,
  resolvePinnedInterfaces,
  coerceLegacySelection,
  mergeTunnelsIntoInterfaces,
  type ResolverInterface,
  type LldpByIfName,
  type AutoMonitorSelection,
  type TunnelObservation,
} from "../../src/services/autoMonitorInterfacesService.js";

function iface(name: string, type: string | null = "physical", up = true): ResolverInterface {
  return { ifName: name, ifType: type, operStatus: up ? "up" : "down" };
}

describe("compileWildcard", () => {
  it("matches simple * suffix", () => {
    const r = compileWildcard("wan*");
    expect(r.test("wan1")).toBe(true);
    expect(r.test("wan-uplink")).toBe(true);
    expect(r.test("lan1")).toBe(false);
  });

  it("matches single-character ?", () => {
    const r = compileWildcard("port?");
    expect(r.test("port1")).toBe(true);
    expect(r.test("port10")).toBe(false);
  });

  it("anchors the pattern", () => {
    const r = compileWildcard("wan");
    expect(r.test("wan")).toBe(true);
    expect(r.test("wan1")).toBe(false);
    expect(r.test("xwan")).toBe(false);
  });

  it("escapes regex metacharacters in the literal", () => {
    const r = compileWildcard("port[1]");
    expect(r.test("port[1]")).toBe(true);
    expect(r.test("port1")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(() => compileWildcard("")).toThrow();
  });
});

describe("compilePattern", () => {
  it("regex=false delegates to compileWildcard (anchored)", () => {
    const r = compilePattern("wan*", false);
    expect(r.test("wan1")).toBe(true);
    expect(r.test("xwan1")).toBe(false);
  });

  it("regex=true returns the raw regex anchor-free", () => {
    const r = compilePattern("wan", true);
    expect(r.test("wan")).toBe(true);
    expect(r.test("wan1")).toBe(true); // anchor-free: substring matches
    expect(r.test("xwan")).toBe(true);
  });

  it("regex=true respects explicit anchors", () => {
    const r = compilePattern("^wan\\d+$", true);
    expect(r.test("wan1")).toBe(true);
    expect(r.test("wan10")).toBe(true);
    expect(r.test("wan")).toBe(false);
    expect(r.test("xwan1")).toBe(false);
  });

  it("regex=true throws on invalid regex", () => {
    expect(() => compilePattern("(unclosed", true)).toThrow();
  });
});

describe("resolvePinnedInterfaces — null / empty inputs", () => {
  it("returns empty for null selection", () => {
    expect(resolvePinnedInterfaces(null, [iface("wan1")])).toEqual([]);
  });

  it("returns empty for empty interface list", () => {
    expect(resolvePinnedInterfaces({ byNames: { names: ["wan1"] } }, [])).toEqual([]);
  });

  it("returns empty for selection with all blocks empty/missing", () => {
    expect(resolvePinnedInterfaces({}, [iface("wan1")])).toEqual([]);
  });
});

describe("resolvePinnedInterfaces — byNames", () => {
  const ifs = [iface("wan1"), iface("wan2", "physical", false), iface("internal1")];

  it("returns only names that exist on the device", () => {
    const out = resolvePinnedInterfaces({ byNames: { names: ["wan1", "wan2", "wan3"] } }, ifs);
    expect(out.sort()).toEqual(["wan1", "wan2"]);
  });

  it("ignores up/down state — explicit names always pin", () => {
    const out = resolvePinnedInterfaces({ byNames: { names: ["wan2"] } }, ifs);
    expect(out).toEqual(["wan2"]);
  });

  it("returns empty when no name matches", () => {
    const out = resolvePinnedInterfaces({ byNames: { names: ["nonexistent"] } }, ifs);
    expect(out).toEqual([]);
  });
});

describe("resolvePinnedInterfaces — byPatterns", () => {
  const ifs = [
    iface("wan1"),
    iface("wan2", "physical", false),
    iface("internal1"),
    iface("port1", "physical", false),
  ];

  it("wildcard mode matches across all interfaces when onlyUp=false", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: ["wan*"], regex: false, onlyUp: false } }, ifs);
    expect(out.sort()).toEqual(["wan1", "wan2"]);
  });

  it("filters down interfaces when onlyUp=true", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: ["wan*"], regex: false, onlyUp: true } }, ifs);
    expect(out).toEqual(["wan1"]);
  });

  it("supports multiple patterns (OR semantics)", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: ["wan*", "internal?"], regex: false, onlyUp: false } }, ifs);
    expect(out.sort()).toEqual(["internal1", "wan1", "wan2"]);
  });

  it("regex mode honors anchor-free semantics", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: ["wan"], regex: true, onlyUp: false } }, ifs);
    expect(out.sort()).toEqual(["wan1", "wan2"]);
  });

  it("regex mode respects explicit ^$ anchors", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: ["^port1$"], regex: true, onlyUp: false } }, ifs);
    expect(out).toEqual(["port1"]);
  });

  it("returns empty for empty patterns array", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: [], regex: false, onlyUp: false } }, ifs);
    expect(out).toEqual([]);
  });
});

describe("resolvePinnedInterfaces — byTypes", () => {
  const ifs = [
    iface("wan1", "physical", true),
    iface("wan2", "physical", false),
    iface("vlan100", "vlan", true),
    iface("aggA", "aggregate", true),
    iface("ifNoType", null, true),
  ];

  it("returns names whose type is in the set", () => {
    const out = resolvePinnedInterfaces({ byTypes: { types: ["physical"], onlyUp: false } }, ifs);
    expect(out.sort()).toEqual(["wan1", "wan2"]);
  });

  it("filters down interfaces when onlyUp=true", () => {
    const out = resolvePinnedInterfaces({ byTypes: { types: ["physical"], onlyUp: true } }, ifs);
    expect(out).toEqual(["wan1"]);
  });

  it("supports multiple types", () => {
    const out = resolvePinnedInterfaces({ byTypes: { types: ["physical", "vlan"], onlyUp: false } }, ifs);
    expect(out.sort()).toEqual(["vlan100", "wan1", "wan2"]);
  });

  it("never matches an interface with ifType=null", () => {
    const out = resolvePinnedInterfaces({ byTypes: { types: ["physical", "aggregate", "vlan", "loopback", "tunnel"], onlyUp: false } }, ifs);
    expect(out).not.toContain("ifNoType");
  });
});

describe("resolvePinnedInterfaces — byTypes includeDownTunnels", () => {
  const ifs = [
    iface("wan1", "physical", true),
    iface("wan2", "physical", false),     // down physical
    iface("VPN_UP", "tunnel", true),
    iface("VPN_DOWN", "tunnel", false),   // down tunnel
  ];

  it("includes down tunnels when onlyUp=true and includeDownTunnels=true", () => {
    const out = resolvePinnedInterfaces(
      { byTypes: { types: ["tunnel"], onlyUp: true, includeDownTunnels: true } },
      ifs,
    );
    expect(out.sort()).toEqual(["VPN_DOWN", "VPN_UP"]);
  });

  it("still drops down tunnels when includeDownTunnels=false (default)", () => {
    const out = resolvePinnedInterfaces(
      { byTypes: { types: ["tunnel"], onlyUp: true } },
      ifs,
    );
    expect(out).toEqual(["VPN_UP"]);
  });

  it("does NOT rescue down non-tunnel interfaces", () => {
    // includeDownTunnels is tunnel-scoped: down physical wan2 stays filtered.
    const out = resolvePinnedInterfaces(
      { byTypes: { types: ["physical", "tunnel"], onlyUp: true, includeDownTunnels: true } },
      ifs,
    );
    expect(out.sort()).toEqual(["VPN_DOWN", "VPN_UP", "wan1"]);
  });

  it("is a no-op when onlyUp=false (down tunnels already pin)", () => {
    const withFlag = resolvePinnedInterfaces(
      { byTypes: { types: ["tunnel"], onlyUp: false, includeDownTunnels: true } },
      ifs,
    );
    const withoutFlag = resolvePinnedInterfaces(
      { byTypes: { types: ["tunnel"], onlyUp: false } },
      ifs,
    );
    expect(withFlag.sort()).toEqual(["VPN_DOWN", "VPN_UP"]);
    expect(withFlag.sort()).toEqual(withoutFlag.sort());
  });
});

describe("resolvePinnedInterfaces — byLldp", () => {
  const ifs = [
    iface("port1"),
    iface("port2"),
    iface("port3"),
  ];

  it("pins interfaces whose neighbor is a monitored asset of the chosen type", () => {
    const lldp: LldpByIfName = new Map([
      ["port1", [{ matchedAssetType: "switch",   matchedAssetMonitored: true  }]],
      ["port2", [{ matchedAssetType: "firewall", matchedAssetMonitored: true  }]],
      ["port3", [{ matchedAssetType: "switch",   matchedAssetMonitored: false }]],
    ]);
    const out = resolvePinnedInterfaces(
      { byLldp: { neighborTypes: ["switch", "firewall"] } },
      ifs,
      lldp,
    );
    expect(out.sort()).toEqual(["port1", "port2"]);
  });

  it("requires the neighbor's matched asset to be monitored=true", () => {
    const lldp: LldpByIfName = new Map([
      ["port1", [{ matchedAssetType: "switch", matchedAssetMonitored: false }]],
    ]);
    const out = resolvePinnedInterfaces({ byLldp: { neighborTypes: ["switch"] } }, ifs, lldp);
    expect(out).toEqual([]);
  });

  it("ignores interfaces with no LLDP neighbors", () => {
    const lldp: LldpByIfName = new Map();
    const out = resolvePinnedInterfaces({ byLldp: { neighborTypes: ["switch"] } }, ifs, lldp);
    expect(out).toEqual([]);
  });

  it("any neighbor matching is enough on shared media", () => {
    const lldp: LldpByIfName = new Map([
      ["port1", [
        { matchedAssetType: "workstation", matchedAssetMonitored: true },
        { matchedAssetType: "switch",      matchedAssetMonitored: true },
      ]],
    ]);
    const out = resolvePinnedInterfaces({ byLldp: { neighborTypes: ["switch"] } }, ifs, lldp);
    expect(out).toEqual(["port1"]);
  });

  it("returns empty when ctx is missing even though byLldp is set", () => {
    const out = resolvePinnedInterfaces({ byLldp: { neighborTypes: ["switch"] } }, ifs);
    expect(out).toEqual([]);
  });
});

describe("resolvePinnedInterfaces — multi-block union", () => {
  const ifs = [
    iface("wan1", "physical", true),
    iface("port1", "physical", true),
    iface("vlan100", "vlan", true),
    iface("uplink", "aggregate", true),
  ];

  it("unions across all enabled blocks (no duplicates)", () => {
    const lldp: LldpByIfName = new Map([
      ["uplink", [{ matchedAssetType: "switch", matchedAssetMonitored: true }]],
    ]);
    const sel: AutoMonitorSelection = {
      byNames:    { names: ["port1"] },
      byPatterns: { patterns: ["wan*"], regex: false, onlyUp: false },
      byTypes:    { types: ["vlan"], onlyUp: false },
      byLldp:     { neighborTypes: ["switch"] },
    };
    const out = resolvePinnedInterfaces(sel, ifs, lldp).sort();
    expect(out).toEqual(["port1", "uplink", "vlan100", "wan1"]);
  });

  it("overlapping blocks dedupe (port1 matched by both names and pattern)", () => {
    const sel: AutoMonitorSelection = {
      byNames:    { names: ["port1"] },
      byPatterns: { patterns: ["port*"], regex: false, onlyUp: false },
    };
    const out = resolvePinnedInterfaces(sel, ifs);
    expect(out).toEqual(["port1"]);
  });
});

describe("coerceLegacySelection", () => {
  it("returns null for null/empty input", () => {
    expect(coerceLegacySelection(null)).toBeNull();
    expect(coerceLegacySelection(undefined)).toBeNull();
    expect(coerceLegacySelection({})).toBeNull();
  });

  it("passes through new-shape selections unchanged", () => {
    const sel: AutoMonitorSelection = { byNames: { names: ["wan1"] } };
    expect(coerceLegacySelection(sel)).toBe(sel);
  });

  it("converts legacy names shape", () => {
    expect(coerceLegacySelection({ mode: "names", names: ["wan1", "wan2"] })).toEqual({
      byNames: { names: ["wan1", "wan2"] },
    });
  });

  it("converts legacy wildcard shape with regex=false default", () => {
    expect(coerceLegacySelection({ mode: "wildcard", patterns: ["wan*"], onlyUp: true })).toEqual({
      byPatterns: { patterns: ["wan*"], regex: false, onlyUp: true },
    });
  });

  it("converts legacy type shape with onlyUp default=true", () => {
    expect(coerceLegacySelection({ mode: "type", types: ["physical"] })).toEqual({
      byTypes: { types: ["physical"], onlyUp: true },
    });
  });
});

describe("mergeTunnelsIntoInterfaces", () => {
  function tn(name: string, status: string | null = "up"): TunnelObservation {
    return { tunnelName: name, status };
  }

  it("appends tunnels as synthetic tunnel-type interfaces", () => {
    const ifaces = new Map<string, ResolverInterface[]>([
      ["a1", [iface("wan1")]],
    ]);
    const tunnels = new Map<string, TunnelObservation[]>([
      ["a1", [tn("VPN_HQ"), tn("VPN_DR")]],
    ]);
    mergeTunnelsIntoInterfaces(ifaces, tunnels);
    const list = ifaces.get("a1")!;
    expect(list).toContainEqual({ ifName: "VPN_HQ", ifType: "tunnel", operStatus: "up" });
    expect(list).toContainEqual({ ifName: "VPN_DR", ifType: "tunnel", operStatus: "up" });
    expect(list).toHaveLength(3);
  });

  it("creates an interface list for an asset that had none", () => {
    const ifaces = new Map<string, ResolverInterface[]>();
    const tunnels = new Map<string, TunnelObservation[]>([["a1", [tn("VPN_HQ")]]]);
    mergeTunnelsIntoInterfaces(ifaces, tunnels);
    expect(ifaces.get("a1")).toEqual([{ ifName: "VPN_HQ", ifType: "tunnel", operStatus: "up" }]);
  });

  it("de-dupes against a tunnel SNMP already captured as a real interface", () => {
    const ifaces = new Map<string, ResolverInterface[]>([
      ["a1", [iface("VPN_HQ", "tunnel", false)]], // real IF-MIB row, down
    ]);
    const tunnels = new Map<string, TunnelObservation[]>([["a1", [tn("VPN_HQ", "up")]]]);
    mergeTunnelsIntoInterfaces(ifaces, tunnels);
    // No duplicate added; the existing real row is preserved as-is.
    expect(ifaces.get("a1")).toEqual([{ ifName: "VPN_HQ", ifType: "tunnel", operStatus: "down" }]);
  });

  it("maps only fully-down status to operStatus down; up/partial/dynamic → up", () => {
    const ifaces = new Map<string, ResolverInterface[]>([["a1", []]]);
    const tunnels = new Map<string, TunnelObservation[]>([[
      "a1",
      [tn("t_up", "up"), tn("t_part", "partial"), tn("t_dyn", "dynamic"), tn("t_down", "down"), tn("t_null", null)],
    ]]);
    mergeTunnelsIntoInterfaces(ifaces, tunnels);
    const byName = new Map(ifaces.get("a1")!.map((i) => [i.ifName, i.operStatus]));
    expect(byName.get("t_up")).toBe("up");
    expect(byName.get("t_part")).toBe("up");
    expect(byName.get("t_dyn")).toBe("up");
    expect(byName.get("t_null")).toBe("up");
    expect(byName.get("t_down")).toBe("down");
  });

  it("skips empty tunnel lists and blank tunnel names", () => {
    const ifaces = new Map<string, ResolverInterface[]>([["a1", [iface("wan1")]]]);
    const tunnels = new Map<string, TunnelObservation[]>([
      ["a1", []],
      ["a2", [tn("")]],
    ]);
    mergeTunnelsIntoInterfaces(ifaces, tunnels);
    expect(ifaces.get("a1")).toEqual([iface("wan1")]);
    expect(ifaces.get("a2")).toEqual([]); // a2 list created but blank name skipped
  });

  it("makes synthetic tunnels resolvable by name and by type", () => {
    const ifaces = new Map<string, ResolverInterface[]>([["a1", [iface("wan1")]]]);
    mergeTunnelsIntoInterfaces(ifaces, new Map([["a1", [tn("VPN_HQ"), tn("VPN_DR", "down")]]]));
    const list = ifaces.get("a1")!;
    expect(resolvePinnedInterfaces({ byNames: { names: ["VPN_HQ"] } }, list)).toEqual(["VPN_HQ"]);
    // By type with onlyUp drops the down tunnel.
    expect(
      resolvePinnedInterfaces({ byTypes: { types: ["tunnel"], onlyUp: true } }, list).sort(),
    ).toEqual(["VPN_HQ"]);
    // onlyUp=false keeps both.
    expect(
      resolvePinnedInterfaces({ byTypes: { types: ["tunnel"], onlyUp: false } }, list).sort(),
    ).toEqual(["VPN_DR", "VPN_HQ"]);
  });
});

describe("resolver is class-agnostic (workstation/server reuse)", () => {
  // AD/Entra workstation+server classes reuse this resolver against agent-
  // reported interfaces (no Fortinet ifTypes). Confirm byNames / byPatterns
  // work on generic Linux-style ifNames the same way.
  const wsIfaces: ResolverInterface[] = [
    { ifName: "eth0", ifType: null, operStatus: "up" },
    { ifName: "eth1", ifType: null, operStatus: "down" },
    { ifName: "lo", ifType: null, operStatus: "up" },
  ];
  it("byNames works without ifType data", () => {
    expect(resolvePinnedInterfaces({ byNames: { names: ["eth0", "eth1"] } }, wsIfaces).sort()).toEqual(["eth0", "eth1"]);
  });
  it("byPatterns wildcard works on generic ifNames", () => {
    expect(resolvePinnedInterfaces({ byPatterns: { patterns: ["eth*"], regex: false, onlyUp: false } }, wsIfaces).sort()).toEqual(["eth0", "eth1"]);
  });
  it("byPatterns onlyUp filters down interfaces", () => {
    expect(resolvePinnedInterfaces({ byPatterns: { patterns: ["eth*"], regex: false, onlyUp: true } }, wsIfaces)).toEqual(["eth0"]);
  });
});
