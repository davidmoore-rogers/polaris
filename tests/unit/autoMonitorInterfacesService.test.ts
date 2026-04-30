/**
 * tests/unit/autoMonitorInterfacesService.test.ts
 *
 * Pure-function coverage for the resolver + wildcard compiler. No DB calls;
 * the DB-bound functions (apply/preview/aggregate) are exercised by the
 * integration test suite.
 */

import { describe, it, expect } from "vitest";
import {
  compileWildcard,
  resolvePinnedInterfaces,
  type ResolverInterface,
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
    expect(r.test("port9")).toBe(true);
    expect(r.test("port10")).toBe(false);
    expect(r.test("port")).toBe(false);
  });

  it("matches double-? for two chars", () => {
    const r = compileWildcard("port??");
    expect(r.test("port10")).toBe(true);
    expect(r.test("port1")).toBe(false);
  });

  it("anchors the pattern (no partial matches)", () => {
    const r = compileWildcard("wan");
    expect(r.test("wan")).toBe(true);
    expect(r.test("wan1")).toBe(false);
    expect(r.test("xwan")).toBe(false);
  });

  it("escapes regex metacharacters in the literal", () => {
    // Square brackets must NOT be interpreted as a character class — the
    // pattern should match the literal string "port[1]".
    const r = compileWildcard("port[1]");
    expect(r.test("port[1]")).toBe(true);
    expect(r.test("port1")).toBe(false);
  });

  it("escapes dots", () => {
    const r = compileWildcard("port.1");
    expect(r.test("port.1")).toBe(true);
    expect(r.test("portx1")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(() => compileWildcard("")).toThrow();
  });
});

describe("resolvePinnedInterfaces", () => {
  it("returns empty for null selection", () => {
    expect(resolvePinnedInterfaces(null, [iface("wan1")])).toEqual([]);
  });

  it("returns empty for empty interface list (every mode)", () => {
    expect(resolvePinnedInterfaces({ mode: "names", names: ["wan1"] }, [])).toEqual([]);
    expect(resolvePinnedInterfaces({ mode: "wildcard", patterns: ["wan*"], onlyUp: false }, [])).toEqual([]);
    expect(resolvePinnedInterfaces({ mode: "type", types: ["physical"], onlyUp: true }, [])).toEqual([]);
  });

  describe("mode=names", () => {
    const ifs = [iface("wan1"), iface("wan2", "physical", false), iface("internal1")];

    it("returns only names that exist on the device", () => {
      const out = resolvePinnedInterfaces({ mode: "names", names: ["wan1", "wan2", "wan3"] }, ifs);
      expect(out.sort()).toEqual(["wan1", "wan2"]);
    });

    it("ignores up/down state — explicit names always pin", () => {
      const out = resolvePinnedInterfaces({ mode: "names", names: ["wan2"] }, ifs);
      expect(out).toEqual(["wan2"]); // wan2 is down but still selected
    });

    it("returns empty when no name matches", () => {
      const out = resolvePinnedInterfaces({ mode: "names", names: ["nonexistent"] }, ifs);
      expect(out).toEqual([]);
    });
  });

  describe("mode=wildcard", () => {
    const ifs = [
      iface("wan1"),
      iface("wan2", "physical", false),
      iface("internal1"),
      iface("port1", "physical", false),
    ];

    it("matches across all interfaces when onlyUp=false", () => {
      const out = resolvePinnedInterfaces({ mode: "wildcard", patterns: ["wan*"], onlyUp: false }, ifs);
      expect(out.sort()).toEqual(["wan1", "wan2"]);
    });

    it("filters down interfaces when onlyUp=true", () => {
      const out = resolvePinnedInterfaces({ mode: "wildcard", patterns: ["wan*"], onlyUp: true }, ifs);
      expect(out).toEqual(["wan1"]); // wan2 is down
    });

    it("supports multiple patterns (OR semantics)", () => {
      const out = resolvePinnedInterfaces({ mode: "wildcard", patterns: ["wan*", "internal?"], onlyUp: false }, ifs);
      expect(out.sort()).toEqual(["internal1", "wan1", "wan2"]);
    });

    it("returns empty for empty patterns array", () => {
      const out = resolvePinnedInterfaces({ mode: "wildcard", patterns: [], onlyUp: false }, ifs);
      expect(out).toEqual([]);
    });
  });

  describe("mode=type", () => {
    const ifs = [
      iface("wan1", "physical", true),
      iface("wan2", "physical", false),
      iface("vlan100", "vlan", true),
      iface("aggA", "aggregate", true),
      iface("ifNoType", null, true),
    ];

    it("returns names whose type is in the set", () => {
      const out = resolvePinnedInterfaces({ mode: "type", types: ["physical"], onlyUp: false }, ifs);
      expect(out.sort()).toEqual(["wan1", "wan2"]);
    });

    it("filters down interfaces when onlyUp=true (default)", () => {
      const out = resolvePinnedInterfaces({ mode: "type", types: ["physical"], onlyUp: true }, ifs);
      expect(out).toEqual(["wan1"]);
    });

    it("supports multiple types", () => {
      const out = resolvePinnedInterfaces({ mode: "type", types: ["physical", "vlan"], onlyUp: false }, ifs);
      expect(out.sort()).toEqual(["vlan100", "wan1", "wan2"]);
    });

    it("never matches an interface with ifType=null", () => {
      const out = resolvePinnedInterfaces({ mode: "type", types: ["physical", "aggregate", "vlan", "loopback", "tunnel"], onlyUp: false }, ifs);
      expect(out).not.toContain("ifNoType");
    });

    it("returns empty for empty types array", () => {
      const out = resolvePinnedInterfaces({ mode: "type", types: [], onlyUp: false }, ifs);
      expect(out).toEqual([]);
    });
  });
});
