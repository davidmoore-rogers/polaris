/**
 * tests/unit/ipScope.test.ts
 *
 * The shared source-IP scope resolver behind BOTH the Dash wallboard gate and
 * the local-login gate. The properties tested here are the ones a second copy
 * of this logic would quietly lose: v4-mapped IPv6 unwrapping, an empty custom
 * list failing CLOSED rather than open, and a real IPv6 source never matching
 * a v4 allow-list entry.
 */

import { describe, it, expect } from "vitest";
import { ipInScope, isIpScope, describeIpScope } from "../../src/utils/ipScope.js";

describe("isIpScope", () => {
  it("accepts the four known scopes", () => {
    expect(isIpScope("rfc1918")).toBe(true);
    expect(isIpScope("all")).toBe(true);
    expect(isIpScope("custom")).toBe(true);
    expect(isIpScope("loopback")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const v of ["", "RFC1918", "private", null, undefined, 0, {}]) {
      expect(isIpScope(v)).toBe(false);
    }
  });
});

describe("ipInScope — all", () => {
  it("admits every source, including garbage", () => {
    expect(ipInScope("8.8.8.8", "all", [])).toBe(true);
    expect(ipInScope("", "all", [])).toBe(true);
  });
});

describe("ipInScope — rfc1918", () => {
  it("admits private + loopback", () => {
    for (const ip of ["10.0.0.1", "172.16.5.9", "192.168.1.20", "127.0.0.1"]) {
      expect(ipInScope(ip, "rfc1918", [])).toBe(true);
    }
  });

  it("refuses public addresses", () => {
    for (const ip of ["8.8.8.8", "203.0.113.5", "172.32.0.1"]) {
      expect(ipInScope(ip, "rfc1918", [])).toBe(false);
    }
  });

  it("unwraps ::ffff: v4-mapped sources — Node reports these behind some stacks", () => {
    expect(ipInScope("::ffff:10.1.2.3", "rfc1918", [])).toBe(true);
    expect(ipInScope("::ffff:8.8.8.8", "rfc1918", [])).toBe(false);
  });
});

describe("ipInScope — loopback", () => {
  it("admits only loopback sources, in every form Node reports them", () => {
    expect(ipInScope("127.0.0.1", "loopback", [])).toBe(true);
    expect(ipInScope("127.4.5.6", "loopback", [])).toBe(true);
    expect(ipInScope("::1", "loopback", [])).toBe(true);
    expect(ipInScope("::ffff:127.0.0.1", "loopback", [])).toBe(true);
  });

  it("refuses private and public sources alike", () => {
    for (const ip of ["10.0.0.1", "192.168.1.20", "172.16.5.9", "8.8.8.8", ""]) {
      expect(ipInScope(ip, "loopback", [])).toBe(false);
    }
  });

  it("ignores allowedCidrs — a loopback scope has no list", () => {
    expect(ipInScope("10.0.0.1", "loopback", ["10.0.0.0/8"])).toBe(false);
  });
});

describe("ipInScope — custom", () => {
  it("admits only addresses inside a listed network", () => {
    expect(ipInScope("10.5.0.7", "custom", ["10.5.0.0/24"])).toBe(true);
    expect(ipInScope("10.5.1.7", "custom", ["10.5.0.0/24"])).toBe(false);
  });

  it("matches a bare /32 entry", () => {
    expect(ipInScope("203.0.113.5", "custom", ["203.0.113.5/32"])).toBe(true);
    expect(ipInScope("203.0.113.6", "custom", ["203.0.113.5/32"])).toBe(false);
  });

  it("fails CLOSED on an empty list — an unconfigured custom scope must not admit everyone", () => {
    expect(ipInScope("10.0.0.1", "custom", [])).toBe(false);
  });

  it("never matches a real IPv6 source against a v4 entry", () => {
    expect(ipInScope("2001:db8::1", "custom", ["10.0.0.0/8"])).toBe(false);
  });

  it("unwraps v4-mapped sources against v4 entries", () => {
    expect(ipInScope("::ffff:10.5.0.7", "custom", ["10.5.0.0/24"])).toBe(true);
  });
});

describe("describeIpScope", () => {
  it("names each posture for the audit trail", () => {
    expect(describeIpScope("all", [])).toBe("ALL source IPs");
    expect(describeIpScope("rfc1918", [])).toBe("RFC1918 + loopback sources only");
    expect(describeIpScope("loopback", [])).toBe("loopback (this host) only");
    expect(describeIpScope("custom", ["10.0.0.0/8", "192.168.1.0/24"])).toBe(
      "custom source IPs: 10.0.0.0/8, 192.168.1.0/24",
    );
  });

  it("says (none) rather than trailing empty for an empty custom list", () => {
    expect(describeIpScope("custom", [])).toBe("custom source IPs: (none)");
  });
});
