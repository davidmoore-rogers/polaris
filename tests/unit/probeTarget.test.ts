/**
 * tests/unit/probeTarget.test.ts
 *
 * Validation of a hand-typed credential-test target. The interesting half is
 * what gets REFUSED: the natural operator gesture is pasting a URL out of a
 * browser bar, and salvaging a host out of it would dial a different scheme,
 * port and path than the one on screen while attributing the result to the
 * credential.
 */

import { describe, it, expect } from "vitest";
import { normalizeProbeTarget, isValidHostname } from "../../src/utils/probeTarget.js";

describe("normalizeProbeTarget — accepted", () => {
  it("accepts an IPv4 address", () => {
    expect(normalizeProbeTarget("10.20.30.40")).toEqual({ host: "10.20.30.40" });
  });
  it("accepts loopback, which is the whole point of a local stub test", () => {
    expect(normalizeProbeTarget("127.0.0.1")).toEqual({ host: "127.0.0.1" });
  });
  it("trims surrounding whitespace from a paste", () => {
    expect(normalizeProbeTarget("  10.20.30.40 \n")).toEqual({ host: "10.20.30.40" });
  });
  it("accepts a bare hostname", () => {
    expect(normalizeProbeTarget("camera-01")).toEqual({ host: "camera-01" });
  });
  it("accepts an FQDN", () => {
    expect(normalizeProbeTarget("cam01.plant.example.com").host).toBe("cam01.plant.example.com");
  });
  it("tolerates the fully-qualified trailing dot", () => {
    expect(normalizeProbeTarget("cam01.example.com.").host).toBe("cam01.example.com.");
  });
  it("accepts an IPv6 address", () => {
    expect(normalizeProbeTarget("fe80::1").host).toBe("fe80::1");
  });
  it("unwraps a bracketed IPv6 literal", () => {
    expect(normalizeProbeTarget("[2001:db8::5]").host).toBe("2001:db8::5");
  });
  it("accepts a hostname with digits and hyphens", () => {
    expect(normalizeProbeTarget("ap-3f-north-02").host).toBe("ap-3f-north-02");
  });
});

describe("normalizeProbeTarget — refused, with a reason naming the owning field", () => {
  it("refuses a URL rather than trimming it to a host", () => {
    const r = normalizeProbeTarget("https://10.1.2.3:8443/healthz");
    expect(r.host).toBeUndefined();
    expect(r.error).toMatch(/not a URL/);
  });
  it("refuses an http:// URL too", () => {
    expect(normalizeProbeTarget("http://camera-01/").error).toMatch(/not a URL/);
  });
  it("refuses a host:port pair — the port belongs to the credential", () => {
    const r = normalizeProbeTarget("10.1.2.3:8443");
    expect(r.error).toMatch(/without a port/);
  });
  it("refuses a bare path", () => {
    expect(normalizeProbeTarget("10.1.2.3/axis-cgi").error).toMatch(/without a path/);
  });
  it("refuses embedded credentials", () => {
    expect(normalizeProbeTarget("root@10.1.2.3").error).toMatch(/credentials come from the form/);
  });
  it("refuses a query string", () => {
    expect(normalizeProbeTarget("10.1.2.3?a=b").error).toMatch(/without a query string/);
  });
  it("refuses whitespace inside the value", () => {
    expect(normalizeProbeTarget("10.1.2.3 10.1.2.4").error).toMatch(/cannot contain spaces/);
  });
  it("refuses empty / absent input with an actionable message", () => {
    expect(normalizeProbeTarget("").error).toMatch(/Enter an IP address or hostname/);
    expect(normalizeProbeTarget(null).error).toMatch(/Enter an IP address or hostname/);
    expect(normalizeProbeTarget(undefined).error).toMatch(/Enter an IP address or hostname/);
  });
  it("refuses a hostname with an illegal character", () => {
    expect(normalizeProbeTarget("cam_01!").error).toMatch(/not a valid IP address or hostname/);
  });
  it("refuses an over-long name", () => {
    expect(normalizeProbeTarget("a".repeat(254)).error).toMatch(/not a valid IP address or hostname/);
  });

  // An IPv6 address is the one legal use of a colon, so the port check must not
  // swallow it — and a malformed one must still be refused as invalid rather
  // than mis-reported as carrying a port.
  it("does not mistake IPv6 for a port, but still rejects a malformed one", () => {
    const r = normalizeProbeTarget("fe80::zz::1");
    expect(r.error).toMatch(/not a valid IP address or hostname/);
    expect(r.error).not.toMatch(/port/);
  });
});

describe("isValidHostname", () => {
  it("rejects a label starting or ending with a hyphen", () => {
    expect(isValidHostname("-cam")).toBe(false);
    expect(isValidHostname("cam-")).toBe(false);
  });
  it("rejects an empty label from a doubled dot", () => {
    expect(isValidHostname("cam..example.com")).toBe(false);
  });
  it("rejects a label over 63 characters", () => {
    expect(isValidHostname("a".repeat(64) + ".example.com")).toBe(false);
    expect(isValidHostname("a".repeat(63) + ".example.com")).toBe(true);
  });
});
