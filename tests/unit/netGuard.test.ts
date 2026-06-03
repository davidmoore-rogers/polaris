/**
 * tests/unit/netGuard.test.ts
 */

import { describe, it, expect } from "vitest";
import { isBlockedOutboundHost, assertOutboundHostAllowed } from "../../src/utils/netGuard.js";

describe("isBlockedOutboundHost — blocked ranges", () => {
  it("blocks IPv4 loopback", () => {
    expect(isBlockedOutboundHost("127.0.0.1")).toBe(true);
    expect(isBlockedOutboundHost("127.255.255.254")).toBe(true);
  });

  it("blocks the cloud metadata / link-local range", () => {
    expect(isBlockedOutboundHost("169.254.169.254")).toBe(true); // AWS/GCP/Azure metadata
    expect(isBlockedOutboundHost("169.254.0.1")).toBe(true);
  });

  it("blocks unspecified and multicast", () => {
    expect(isBlockedOutboundHost("0.0.0.0")).toBe(true);
    expect(isBlockedOutboundHost("224.0.0.1")).toBe(true);
    expect(isBlockedOutboundHost("239.255.255.250")).toBe(true);
  });

  it("blocks the localhost hostname (and subdomains)", () => {
    expect(isBlockedOutboundHost("localhost")).toBe(true);
    expect(isBlockedOutboundHost("LOCALHOST")).toBe(true);
    expect(isBlockedOutboundHost("foo.localhost")).toBe(true);
  });

  it("blocks IPv6 loopback / unspecified / link-local / multicast", () => {
    expect(isBlockedOutboundHost("::1")).toBe(true);
    expect(isBlockedOutboundHost("::")).toBe(true);
    expect(isBlockedOutboundHost("fe80::1")).toBe(true);
    expect(isBlockedOutboundHost("ff02::1")).toBe(true);
    expect(isBlockedOutboundHost("[::1]")).toBe(true);          // bracketed
    expect(isBlockedOutboundHost("fe80::1%eth0")).toBe(true);   // with zone id
  });

  it("blocks IPv4-mapped IPv6 pointing at a blocked v4", () => {
    expect(isBlockedOutboundHost("::ffff:169.254.169.254")).toBe(true);
  });
});

describe("isBlockedOutboundHost — allowed targets (must NOT break real deployments)", () => {
  it("allows RFC1918 private LAN ranges — the normal case", () => {
    expect(isBlockedOutboundHost("10.0.0.1")).toBe(false);
    expect(isBlockedOutboundHost("172.16.5.10")).toBe(false);
    expect(isBlockedOutboundHost("192.168.1.99")).toBe(false);
  });

  it("allows public addresses", () => {
    expect(isBlockedOutboundHost("8.8.8.8")).toBe(false);
    expect(isBlockedOutboundHost("1.1.1.1")).toBe(false);
  });

  it("allows ULA IPv6", () => {
    expect(isBlockedOutboundHost("fc00::1")).toBe(false);
    expect(isBlockedOutboundHost("fd12:3456::1")).toBe(false);
  });

  it("allows ordinary hostnames (literal check only; not our DNS concern)", () => {
    expect(isBlockedOutboundHost("fortigate.corp.example.com")).toBe(false);
    expect(isBlockedOutboundHost("dc01.ad.internal")).toBe(false);
  });

  it("treats empty input as allowed (the schema's required check owns emptiness)", () => {
    expect(isBlockedOutboundHost("")).toBe(false);
    expect(isBlockedOutboundHost("   ")).toBe(false);
  });
});

describe("assertOutboundHostAllowed", () => {
  it("throws BLOCKED_HOST for blocked hosts", () => {
    expect(() => assertOutboundHostAllowed("169.254.169.254")).toThrowError(/blocked range/);
    try {
      assertOutboundHostAllowed("127.0.0.1");
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.code).toBe("BLOCKED_HOST");
    }
  });

  it("is a no-op for allowed hosts", () => {
    expect(() => assertOutboundHostAllowed("10.1.2.3")).not.toThrow();
    expect(() => assertOutboundHostAllowed("")).not.toThrow();
  });
});
