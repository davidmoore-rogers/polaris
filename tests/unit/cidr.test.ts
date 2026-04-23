/**
 * tests/unit/cidr.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  normalizeCidr,
  isValidCidr,
  isValidIpAddress,
  cidrContains,
  cidrOverlaps,
  ipInCidr,
  usableHostCount,
  findNextAvailableSubnet,
  detectIpVersion,
  packTemplateEntries,
  packIntoAnchor,
} from "../../src/utils/cidr.js";

describe("normalizeCidr", () => {
  it("zeroes host bits", () => {
    expect(normalizeCidr("10.1.1.5/24")).toBe("10.1.1.0/24");
    expect(normalizeCidr("192.168.100.200/16")).toBe("192.168.0.0/16");
  });

  it("is a no-op when already normalized", () => {
    expect(normalizeCidr("10.0.0.0/8")).toBe("10.0.0.0/8");
  });
});

describe("isValidCidr", () => {
  it("accepts valid IPv4 CIDRs", () => {
    expect(isValidCidr("10.0.0.0/8")).toBe(true);
    expect(isValidCidr("192.168.1.0/24")).toBe(true);
    expect(isValidCidr("172.16.0.0/12")).toBe(true);
  });

  it("rejects invalid CIDRs", () => {
    expect(isValidCidr("not-an-ip")).toBe(false);
    expect(isValidCidr("10.0.0.0")).toBe(false); // missing prefix
    expect(isValidCidr("10.0.0.0/33")).toBe(false); // prefix out of range
  });
});

describe("detectIpVersion", () => {
  it("detects v4", () => expect(detectIpVersion("10.0.0.0/8")).toBe("v4"));
  it("detects v6", () => expect(detectIpVersion("2001:db8::/32")).toBe("v6"));
});

describe("cidrContains", () => {
  it("returns true when inner is inside outer", () => {
    expect(cidrContains("10.0.0.0/8", "10.1.0.0/24")).toBe(true);
  });

  it("returns false when inner is outside outer", () => {
    expect(cidrContains("10.0.0.0/8", "192.168.1.0/24")).toBe(false);
  });

  it("returns true for identical CIDRs", () => {
    expect(cidrContains("10.0.0.0/8", "10.0.0.0/8")).toBe(true);
  });
});

describe("cidrOverlaps", () => {
  it("detects overlap when one contains another", () => {
    expect(cidrOverlaps("10.0.0.0/16", "10.0.1.0/24")).toBe(true);
  });

  it("returns false for non-overlapping blocks", () => {
    expect(cidrOverlaps("10.0.0.0/24", "10.0.1.0/24")).toBe(false);
  });
});

describe("ipInCidr", () => {
  it("returns true for an IP inside the range", () => {
    expect(ipInCidr("10.0.1.50", "10.0.0.0/16")).toBe(true);
  });

  it("returns false for an IP outside the range", () => {
    expect(ipInCidr("192.168.1.1", "10.0.0.0/8")).toBe(false);
  });
});

describe("usableHostCount", () => {
  it("calculates /24 correctly", () => expect(usableHostCount("10.0.0.0/24")).toBe(254));
  it("calculates /32 as 1", () => expect(usableHostCount("10.0.0.1/32")).toBe(1));
  it("calculates /31 as 2", () => expect(usableHostCount("10.0.0.0/31")).toBe(2));
  it("calculates /16 correctly", () => expect(usableHostCount("10.0.0.0/16")).toBe(65534));
});

describe("findNextAvailableSubnet", () => {
  it("returns the first block when nothing is allocated", () => {
    expect(findNextAvailableSubnet("10.0.0.0/8", [], 24)).toBe("10.0.0.0/24");
  });

  it("skips allocated blocks", () => {
    const allocated = ["10.0.0.0/24", "10.0.1.0/24"];
    expect(findNextAvailableSubnet("10.0.0.0/16", allocated, 24)).toBe("10.0.2.0/24");
  });

  it("returns null when no space remains", () => {
    const allocated = ["10.0.0.0/24"];
    expect(findNextAvailableSubnet("10.0.0.0/24", allocated, 24)).toBeNull();
  });
});

describe("packTemplateEntries", () => {
  it("packs the Jefferson template into a /23 span", () => {
    const result = packTemplateEntries([
      { prefixLength: 25 }, // RGIHardware 128
      { prefixLength: 25 }, // RGIUsers    128
      { prefixLength: 26 }, // RGIVoice     64
      { prefixLength: 26 }, // fortilink    64
      { prefixLength: 26 }, // RGIPlant     64
    ]);
    expect(result.packed.map((p) => p.offset)).toEqual([0, 128, 256, 320, 384]);
    expect(result.totalSpan).toBe(448);
    expect(result.containingPrefix).toBe(23); // 512 addrs
  });

  it("pads offsets when a larger subnet follows a smaller one", () => {
    const result = packTemplateEntries([
      { prefixLength: 26 }, // size 64 at offset 0
      { prefixLength: 25 }, // size 128 needs /25 alignment -> skips to 128
    ]);
    expect(result.packed.map((p) => p.offset)).toEqual([0, 128]);
    expect(result.totalSpan).toBe(256);
  });
});

describe("packIntoAnchor (bulk allocation)", () => {
  const jefferson = [
    { name: "RGIHardware", prefixLength: 25 },
    { name: "RGIUsers",    prefixLength: 25 },
    { name: "RGIVoice",    prefixLength: 26 },
    { name: "fortilink",   prefixLength: 26 },
    { name: "RGIPlant",    prefixLength: 26 },
  ];

  it("places the first site at the start of the block", () => {
    const result = packIntoAnchor("172.23.0.0/16", [], jefferson, 24);
    expect(result).not.toBeNull();
    expect(result!.effectiveAnchorPrefix).toBe(23); // template needs /23
    expect(result!.anchorCidr).toBe("172.23.0.0/23");
    expect(result!.assignments.map((a) => a.cidr)).toEqual([
      "172.23.0.0/25",
      "172.23.0.128/25",
      "172.23.1.0/26",
      "172.23.1.64/26",
      "172.23.1.128/26",
    ]);
  });

  it("skips past an earlier Jefferson-shaped allocation to the next /23", () => {
    // Jefferson occupies 172.23.0.0/23 (with a stray /26 hole at .1.64).
    // Smith should land in the next /23, not fill Jefferson's gap.
    const existing = [
      "172.23.0.0/25",
      "172.23.0.128/25",
      "172.23.1.0/26",
      "172.23.1.128/26",
      "172.23.1.192/26",
    ];
    const result = packIntoAnchor("172.23.0.0/16", existing, jefferson, 24);
    expect(result).not.toBeNull();
    expect(result!.anchorCidr).toBe("172.23.2.0/23");
    expect(result!.assignments[0].cidr).toBe("172.23.2.0/25");
    expect(result!.assignments[4].cidr).toBe("172.23.3.128/26");
  });

  it("honors a larger user anchor when the template would fit in less space", () => {
    // One /26 entry would only need /26, but user asks for /24 alignment.
    const result = packIntoAnchor(
      "10.0.0.0/16",
      [],
      [{ name: "voice", prefixLength: 26 }],
      24
    );
    expect(result!.effectiveAnchorPrefix).toBe(24);
    expect(result!.anchorCidr).toBe("10.0.0.0/24");
    expect(result!.assignments[0].cidr).toBe("10.0.0.0/26");
  });

  it("uses a larger effective anchor when the template exceeds the requested one", () => {
    // User asks for /24 anchor but template needs /23.
    const result = packIntoAnchor("10.0.0.0/16", [], jefferson, 24);
    expect(result!.effectiveAnchorPrefix).toBe(23);
  });

  it("returns null when no anchor-aligned region is free", () => {
    // Fill 10.0.0.0/24 so a /24 anchor can't fit.
    const result = packIntoAnchor(
      "10.0.0.0/24",
      ["10.0.0.0/25", "10.0.0.128/25"],
      [{ name: "x", prefixLength: 26 }],
      24
    );
    expect(result).toBeNull();
  });
});
