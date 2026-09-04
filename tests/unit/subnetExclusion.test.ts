/**
 * tests/unit/subnetExclusion.test.ts
 *
 * The pure half of business rule 42. The one thing worth pinning here is the
 * ASYMMETRY: an exclusion covers CIDRs equal to or narrower than itself and
 * deliberately not wider ones, while the allocator's taken-space question uses
 * plain overlap in both directions. Collapsing the two would either let an
 * excluded /24 swallow a discovered /8 or let a template pack an entry into
 * space the operator excluded.
 */

import { describe, it, expect } from "vitest";
import {
  findCoveringExclusion,
  isCidrExcluded,
  exclusionsOverlapping,
} from "../../src/utils/subnetExclusion.js";

const mgmt = { cidr: "10.255.0.0/24", name: "Site Management VLAN" };
const oob = { cidr: "192.168.100.0/22", name: "Out-of-band" };

describe("findCoveringExclusion", () => {
  it("matches the exclusion's own CIDR", () => {
    expect(findCoveringExclusion("10.255.0.0/24", [mgmt])).toBe(mgmt);
    expect(isCidrExcluded("10.255.0.0/24", [mgmt])).toBe(true);
  });

  it("covers a CIDR inside the exclusion", () => {
    expect(findCoveringExclusion("192.168.101.0/24", [oob])).toBe(oob);
    expect(findCoveringExclusion("192.168.100.16/28", [oob])).toBe(oob);
  });

  it("does NOT cover a CIDR that merely contains the exclusion", () => {
    // Excluding one /24 must not silently take a whole /8 out of the list —
    // that would remove far more address space than the operator named.
    expect(findCoveringExclusion("10.0.0.0/8", [mgmt])).toBeNull();
    expect(isCidrExcluded("10.0.0.0/8", [mgmt])).toBe(false);
  });

  it("does not cover a neighbour that only touches the same block", () => {
    expect(findCoveringExclusion("10.255.1.0/24", [mgmt])).toBeNull();
    expect(findCoveringExclusion("192.168.104.0/24", [oob])).toBeNull();
  });

  it("returns the MOST SPECIFIC exclusion when several cover the CIDR", () => {
    // The message an operator reads should name the row they would delete to
    // let the subnet through.
    const wide = { cidr: "10.0.0.0/8", name: "All of ten" };
    const narrow = { cidr: "10.255.0.0/16", name: "Management space" };
    expect(findCoveringExclusion("10.255.0.0/24", [wide, narrow, mgmt])).toBe(mgmt);
    expect(findCoveringExclusion("10.255.9.0/24", [wide, narrow])).toBe(narrow);
    expect(findCoveringExclusion("10.9.9.0/24", [wide, narrow])).toBe(wide);
  });

  it("is empty-set and garbage safe", () => {
    expect(findCoveringExclusion("10.255.0.0/24", [])).toBeNull();
    expect(findCoveringExclusion("not-a-cidr", [mgmt])).toBeNull();
    expect(findCoveringExclusion("10.255.0.0/24", [{ cidr: "nonsense" }])).toBeNull();
    // v6 has no netmask math here; it must read as "not excluded", never throw.
    expect(findCoveringExclusion("2001:db8::/64", [mgmt])).toBeNull();
  });
});

describe("exclusionsOverlapping", () => {
  it("returns exclusions that intersect the scope in EITHER direction", () => {
    const inside = { cidr: "10.1.5.0/24", name: "inside" };
    const wider = { cidr: "10.0.0.0/8", name: "wider" };
    const elsewhere = { cidr: "172.16.0.0/16", name: "elsewhere" };
    const hits = exclusionsOverlapping("10.1.0.0/16", [inside, wider, elsewhere]);
    // The wider one counts: an allocator inside 10.1.0.0/16 is entirely inside
    // excluded space, and handing out any of it would defeat the exclusion.
    expect(hits.map((h) => h.name).sort()).toEqual(["inside", "wider"]);
  });

  it("returns nothing when no exclusion touches the scope", () => {
    expect(exclusionsOverlapping("10.1.0.0/16", [{ cidr: "10.2.0.0/16" }])).toEqual([]);
    expect(exclusionsOverlapping("10.1.0.0/16", [])).toEqual([]);
  });
});
