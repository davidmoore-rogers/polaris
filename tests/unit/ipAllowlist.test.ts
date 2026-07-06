import { describe, it, expect } from "vitest";
import { ipMatchesAllowlist, isValidAllowlistEntry } from "../../src/utils/ipAllowlist.js";

describe("ipMatchesAllowlist", () => {
  it("matches an exact IPv4 address", () => {
    expect(ipMatchesAllowlist("10.0.0.42", ["10.0.0.42"])).toBe(true);
    expect(ipMatchesAllowlist("10.0.0.43", ["10.0.0.42"])).toBe(false);
  });

  it("matches IPv4 CIDR containment", () => {
    expect(ipMatchesAllowlist("10.1.2.3", ["10.1.2.0/24"])).toBe(true);
    expect(ipMatchesAllowlist("10.1.3.3", ["10.1.2.0/24"])).toBe(false);
    expect(ipMatchesAllowlist("172.16.99.1", ["10.0.0.1", "172.16.0.0/12"])).toBe(true);
  });

  it("matches an exact IPv6 address across notations", () => {
    expect(ipMatchesAllowlist("2001:db8::1", ["2001:0db8:0000:0000:0000:0000:0000:0001"])).toBe(true);
    expect(ipMatchesAllowlist("2001:DB8::1", ["2001:db8::1"])).toBe(true);
    expect(ipMatchesAllowlist("2001:db8::2", ["2001:db8::1"])).toBe(false);
  });

  it("matches IPv6 CIDR containment", () => {
    expect(ipMatchesAllowlist("2001:db8:abcd::5", ["2001:db8::/32"])).toBe(true);
    expect(ipMatchesAllowlist("2001:db9::5", ["2001:db8::/32"])).toBe(false);
    expect(ipMatchesAllowlist("::1", ["::1/128"])).toBe(true);
  });

  it("unwraps IPv6-mapped IPv4 candidates", () => {
    expect(ipMatchesAllowlist("::ffff:192.168.5.10", ["192.168.5.10"])).toBe(true);
    expect(ipMatchesAllowlist("::ffff:192.168.5.10", ["192.168.5.0/24"])).toBe(true);
    expect(ipMatchesAllowlist("::ffff:192.168.6.10", ["192.168.5.0/24"])).toBe(false);
  });

  it("unwraps IPv6-mapped IPv4 allowlist entries", () => {
    expect(ipMatchesAllowlist("192.168.5.10", ["::ffff:192.168.5.10"])).toBe(true);
  });

  it("fails closed on an empty allowlist", () => {
    expect(ipMatchesAllowlist("10.0.0.1", [])).toBe(false);
  });

  it("fails closed on an empty or missing candidate ip", () => {
    expect(ipMatchesAllowlist("", ["10.0.0.1"])).toBe(false);
    expect(ipMatchesAllowlist(undefined, ["10.0.0.1"])).toBe(false);
  });

  it("ignores invalid allowlist entries instead of matching everything", () => {
    expect(ipMatchesAllowlist("10.0.0.1", ["not-an-ip", "999.1.1.1", "10.0.0.0/99"])).toBe(false);
    expect(ipMatchesAllowlist("10.0.0.1", ["garbage", "10.0.0.1"])).toBe(true);
  });

  it("never cross-matches address families", () => {
    expect(ipMatchesAllowlist("2001:db8::1", ["10.0.0.0/8"])).toBe(false);
    expect(ipMatchesAllowlist("10.0.0.1", ["2001:db8::/32"])).toBe(false);
  });
});

describe("isValidAllowlistEntry", () => {
  it("accepts bare addresses and CIDRs of both families", () => {
    expect(isValidAllowlistEntry("10.0.0.1")).toBe(true);
    expect(isValidAllowlistEntry("10.0.0.0/24")).toBe(true);
    expect(isValidAllowlistEntry("2001:db8::1")).toBe(true);
    expect(isValidAllowlistEntry("2001:db8::/32")).toBe(true);
  });

  it("rejects blanks and malformed entries", () => {
    expect(isValidAllowlistEntry("")).toBe(false);
    expect(isValidAllowlistEntry("   ")).toBe(false);
    expect(isValidAllowlistEntry("connector-host")).toBe(false);
    expect(isValidAllowlistEntry("300.1.1.1")).toBe(false);
    expect(isValidAllowlistEntry("10.0.0.0/40")).toBe(false);
  });
});
