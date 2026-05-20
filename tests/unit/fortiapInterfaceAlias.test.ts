/**
 * tests/unit/fortiapInterfaceAlias.test.ts
 *
 * Pure-function coverage for the FortiAP `lan1` ↔ `eth0` aliasing.
 */

import { describe, it, expect } from "vitest";

import {
  fortiapInterfaceAliases,
  normalizeFortiapInterfaceName,
} from "../../src/utils/fortiapInterfaceAlias.js";

describe("fortiapInterfaceAliases", () => {
  it("maps lan1 → [lan1, eth0]", () => {
    expect(fortiapInterfaceAliases("lan1")).toEqual(["lan1", "eth0"]);
  });

  it("maps lan2 → [lan2, eth1]", () => {
    expect(fortiapInterfaceAliases("lan2")).toEqual(["lan2", "eth1"]);
  });

  it("maps eth0 → [eth0, lan1]", () => {
    expect(fortiapInterfaceAliases("eth0")).toEqual(["eth0", "lan1"]);
  });

  it("maps eth1 → [eth1, lan2]", () => {
    expect(fortiapInterfaceAliases("eth1")).toEqual(["eth1", "lan2"]);
  });

  it("passes wireless-bridge names through unchanged", () => {
    expect(fortiapInterfaceAliases("wbh0")).toEqual(["wbh0"]);
  });

  it("passes unrelated names through unchanged", () => {
    expect(fortiapInterfaceAliases("port1")).toEqual(["port1"]);
    expect(fortiapInterfaceAliases("wan")).toEqual(["wan"]);
  });

  it("rejects lan0 (no eth-1 equivalent)", () => {
    // lan numbering is 1-based; lan0 has no canonical alias mapping.
    // Implementation requires n >= 1 on the lan branch.
    expect(fortiapInterfaceAliases("lan0")).toEqual(["lan0"]);
  });

  it("handles empty input", () => {
    expect(fortiapInterfaceAliases("")).toEqual([""]);
  });
});

describe("normalizeFortiapInterfaceName", () => {
  it("prefers eth0 when both lan1 and eth0 are known", () => {
    const known = new Set(["lan1", "eth0", "wbh0"]);
    expect(normalizeFortiapInterfaceName("lan1", known)).toBe("eth0");
  });

  it("rewrites lan1 → eth0 when only eth0 is in the known set", () => {
    const known = new Set(["eth0", "wbh0"]);
    expect(normalizeFortiapInterfaceName("lan1", known)).toBe("eth0");
  });

  it("keeps lan1 when only lan1 is in the known set", () => {
    const known = new Set(["lan1", "wbh0"]);
    expect(normalizeFortiapInterfaceName("lan1", known)).toBe("lan1");
  });

  it("keeps the original when neither alias is known (no silent drop)", () => {
    const known = new Set(["wlan0", "wbh0"]);
    expect(normalizeFortiapInterfaceName("lan1", known)).toBe("lan1");
  });

  it("keeps eth0 when known set has only eth0", () => {
    const known = new Set(["eth0"]);
    expect(normalizeFortiapInterfaceName("eth0", known)).toBe("eth0");
  });

  it("rewrites eth0 → lan1 when only lan1 is known (lan-only AP)", () => {
    const known = new Set(["lan1", "wbh0"]);
    expect(normalizeFortiapInterfaceName("eth0", known)).toBe("lan1");
  });

  it("passes wbh0 through unchanged (no alias)", () => {
    const known = new Set(["wbh0", "eth0"]);
    expect(normalizeFortiapInterfaceName("wbh0", known)).toBe("wbh0");
  });
});
