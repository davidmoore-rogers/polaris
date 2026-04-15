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
