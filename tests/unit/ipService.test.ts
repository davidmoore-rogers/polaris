/**
 * tests/unit/ipService.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  assertValidIp,
  assertValidCidr,
  assertIpInSubnet,
} from "../../src/services/ipService.js";
import { AppError } from "../../src/utils/errors.js";

// Mock PrismaClient — DB-backed functions (isIpAvailable, subnetCapacity) are
// covered by integration tests.
vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(() => ({
    reservation: { findFirst: vi.fn(), count: vi.fn() },
  })),
}));

describe("assertValidIp", () => {
  it("does not throw for a valid IPv4 address", () => {
    expect(() => assertValidIp("10.0.0.1")).not.toThrow();
  });

  it("does not throw for a valid IPv6 address", () => {
    expect(() => assertValidIp("2001:db8::1")).not.toThrow();
  });

  it("throws AppError 400 for an invalid IP", () => {
    const call = () => assertValidIp("not-an-ip");
    expect(call).toThrowError(AppError);
    expect(call).toThrowError("Invalid IP address: not-an-ip");
  });
});

describe("assertValidCidr", () => {
  it("returns the normalized CIDR when input is valid", () => {
    expect(assertValidCidr("10.1.1.5/24")).toBe("10.1.1.0/24");
    expect(assertValidCidr("10.0.0.0/8")).toBe("10.0.0.0/8");
  });

  it("throws AppError 400 for an invalid CIDR", () => {
    expect(() => assertValidCidr("bad/cidr")).toThrowError(AppError);
    expect(() => assertValidCidr("10.0.0.0")).toThrowError(AppError);
  });
});

describe("assertIpInSubnet", () => {
  it("does not throw when IP is inside the subnet", () => {
    expect(() => assertIpInSubnet("10.0.1.50", "10.0.0.0/16")).not.toThrow();
    expect(() => assertIpInSubnet("10.0.0.1", "10.0.0.0/24")).not.toThrow();
  });

  it("throws AppError 400 when IP is outside the subnet", () => {
    expect(() => assertIpInSubnet("192.168.1.1", "10.0.0.0/8")).toThrowError(AppError);
    expect(() => assertIpInSubnet("10.1.0.1", "10.0.0.0/24")).toThrowError(AppError);
  });
});
