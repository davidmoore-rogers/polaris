/**
 * tests/unit/scanTargets.test.ts — `expandScanTargets` (src/utils/cidr.ts).
 *
 * Turns the handful of targets an operator types into the ordered address list
 * a Discovery actually probes. Everything interesting about it is a refusal:
 *
 *  - a CIDR drops its network and broadcast addresses. Probing them finds
 *    nothing, and the broadcast is the one address in the range that can
 *    provoke a reply from every host at once. /31 and /32 keep every address
 *    (RFC 3021), matching what usableHostCount already says about them;
 *  - loopback / link-local / multicast / unspecified are excluded REGARDLESS of
 *    what was typed. 169.254.169.254 is the load-bearing one: a cloud-hosted
 *    Polaris probing it is asking the hypervisor for credentials;
 *  - RFC1918 is emphatically NOT excluded — it is the whole point, so this is
 *    netGuard's blocklist minus its private-range allowance, not netGuard;
 *  - one mistyped row must not cost the other nine, so nothing throws: a bad
 *    target lands in perTarget[].error and droppedBy.invalid;
 *  - drops are COUNTED, never silent. Silent truncation reads as "the range is
 *    clean", which is the opposite of the truth (business rule 34c);
 *  - a duplicate is deduped, not "dropped" — the operator asked for it twice
 *    and gets it once, which is not a loss to report.
 */

import { describe, it, expect } from "vitest";
import { expandScanTargets, SCAN_MAX_TARGETS, type ScanTarget } from "../../src/utils/cidr.js";

const cidr = (value: string): ScanTarget => ({ kind: "cidr", value });
const range = (value: string): ScanTarget => ({ kind: "range", value });
const single = (value: string): ScanTarget => ({ kind: "single", value });

describe("expandScanTargets — CIDR", () => {
  it("drops the network and broadcast addresses of a /29", () => {
    const r = expandScanTargets([cidr("10.4.0.0/29")]);
    expect(r.addresses).toEqual([
      "10.4.0.1", "10.4.0.2", "10.4.0.3", "10.4.0.4", "10.4.0.5", "10.4.0.6",
    ]);
    expect(r.total).toBe(6);
    expect(r.dropped).toBe(0); // network/broadcast are not "dropped targets"
  });

  it("keeps both addresses of a /31 and the single address of a /32", () => {
    expect(expandScanTargets([cidr("10.4.0.4/31")]).addresses).toEqual(["10.4.0.4", "10.4.0.5"]);
    expect(expandScanTargets([cidr("10.4.0.9/32")]).addresses).toEqual(["10.4.0.9"]);
  });

  it("normalizes host bits rather than refusing them", () => {
    // "10.4.0.37/29" is how an operator types the network they are standing in.
    expect(expandScanTargets([cidr("10.4.0.37/29")]).addresses[0]).toBe("10.4.0.33");
  });

  it("expands a /24 to 254 hosts", () => {
    const r = expandScanTargets([cidr("192.168.50.0/24")]);
    expect(r.total).toBe(254);
    expect(r.addresses[0]).toBe("192.168.50.1");
    expect(r.addresses[253]).toBe("192.168.50.254");
  });

  it("refuses a CIDR wider than the cap instead of materializing it", () => {
    const r = expandScanTargets([cidr("10.0.0.0/8")]);
    expect(r.addresses).toEqual([]);
    expect(r.droppedBy.invalid).toBe(1);
    expect(r.perTarget[0].error).toMatch(/more than/);
  });

  it("refuses an IPv6 CIDR", () => {
    const r = expandScanTargets([cidr("2001:db8::/64")]);
    expect(r.addresses).toEqual([]);
    expect(r.perTarget[0].error).toMatch(/IPv4/);
  });
});

describe("expandScanTargets — range", () => {
  it("expands an inclusive range", () => {
    expect(expandScanTargets([range("10.4.0.10-10.4.0.13")]).addresses).toEqual([
      "10.4.0.10", "10.4.0.11", "10.4.0.12", "10.4.0.13",
    ]);
  });

  it("crosses an octet boundary", () => {
    const r = expandScanTargets([range("10.4.0.254-10.4.1.2")]);
    expect(r.addresses).toEqual(["10.4.0.254", "10.4.0.255", "10.4.1.0", "10.4.1.1", "10.4.1.2"]);
  });

  it("accepts a single-address range", () => {
    expect(expandScanTargets([range("10.4.0.7-10.4.0.7")]).addresses).toEqual(["10.4.0.7"]);
  });

  it("refuses a backwards range with a reason naming it", () => {
    const r = expandScanTargets([range("10.4.0.60-10.4.0.10")]);
    expect(r.addresses).toEqual([]);
    expect(r.perTarget[0].error).toMatch(/backwards/);
  });

  it("refuses a range over the cap before building the strings", () => {
    const r = expandScanTargets([range("10.0.0.1-10.255.255.254")]);
    expect(r.addresses).toEqual([]);
    expect(r.perTarget[0].error).toMatch(/more than/);
  });

  it("refuses a malformed range", () => {
    for (const bad of ["10.4.0.10", "10.4.0.10-", "-10.4.0.10", "10.4.0.10-x", "a-b"]) {
      const r = expandScanTargets([range(bad)]);
      expect(r.addresses, bad).toEqual([]);
      expect(r.droppedBy.invalid, bad).toBe(1);
    }
  });
});

describe("expandScanTargets — always-excluded addresses", () => {
  it("excludes the cloud-metadata address even when the range asks for it", () => {
    // A cloud-hosted Polaris probing 169.254.169.254 is asking the hypervisor
    // for credentials. This is why the exclusion is not the operator's choice.
    const r = expandScanTargets([range("169.254.169.250-169.254.169.254")]);
    expect(r.addresses).toEqual([]);
    expect(r.droppedBy.excluded).toBe(5);
    expect(r.dropped).toBe(5);
  });

  it("excludes loopback, multicast and 0.0.0.0/8", () => {
    const r = expandScanTargets([single("127.0.0.1"), single("224.0.0.1"), single("0.0.0.5")]);
    expect(r.addresses).toEqual([]);
    expect(r.droppedBy.excluded).toBe(3);
  });

  it("does NOT exclude RFC1918 — that is the point of a Discovery", () => {
    const r = expandScanTargets([single("10.4.0.7"), single("172.16.5.5"), single("192.168.1.1")]);
    expect(r.addresses).toEqual(["10.4.0.7", "172.16.5.5", "192.168.1.1"]);
    expect(r.dropped).toBe(0);
  });

  it("does not exclude routable public space either", () => {
    // An operator may legitimately own a public range; the guard is about
    // addresses that mean something special, not about who owns them.
    expect(expandScanTargets([single("8.8.8.8")]).addresses).toEqual(["8.8.8.8"]);
  });

  it("counts the excluded addresses inside a wider CIDR without failing it", () => {
    const r = expandScanTargets([cidr("169.254.0.0/29")]);
    expect(r.addresses).toEqual([]);
    expect(r.droppedBy.excluded).toBe(6); // the 6 hosts; network/broadcast were never candidates
    expect(r.droppedBy.invalid).toBe(0);  // the target itself was fine
  });
});

describe("expandScanTargets — ordering, dedup, and mixed input", () => {
  it("orders numerically, not by input order or lexically", () => {
    const r = expandScanTargets([single("10.4.0.100"), single("10.4.0.9"), single("10.4.0.20")]);
    // Lexical order would be .100, .20, .9 — the run must advance through the
    // network rather than jumping about.
    expect(r.addresses).toEqual(["10.4.0.9", "10.4.0.20", "10.4.0.100"]);
  });

  it("dedupes overlapping targets without counting them as dropped", () => {
    const r = expandScanTargets([cidr("10.4.0.0/29"), single("10.4.0.5"), range("10.4.0.1-10.4.0.2")]);
    expect(r.total).toBe(6);
    expect(r.dropped).toBe(0);
    // The overlap shows as a per-target count of 0 new addresses, so the
    // preview can say the row added nothing rather than implying it failed.
    expect(r.perTarget.map((p) => p.count)).toEqual([6, 0, 0]);
  });

  it("keeps going after a bad target", () => {
    const r = expandScanTargets([cidr("nonsense"), single("10.4.0.7"), range("bad")]);
    expect(r.addresses).toEqual(["10.4.0.7"]);
    expect(r.droppedBy.invalid).toBe(2);
    expect(r.perTarget[0].error).toBeTruthy();
    expect(r.perTarget[1].error).toBeUndefined();
    expect(r.perTarget[2].error).toBeTruthy();
  });

  it("reports one verdict per input target, in input order", () => {
    const targets = [single("10.4.0.7"), cidr("10.4.1.0/30"), range("bad")];
    const r = expandScanTargets(targets);
    expect(r.perTarget.map((p) => p.target)).toEqual(targets);
  });

  it("handles an empty or absent target list", () => {
    expect(expandScanTargets([])).toMatchObject({ addresses: [], total: 0, dropped: 0 });
    expect(expandScanTargets(undefined as unknown as ScanTarget[]).total).toBe(0);
  });
});

describe("expandScanTargets — the cap", () => {
  it("truncates at a caller-supplied cap and counts what it dropped", () => {
    const r = expandScanTargets([cidr("10.4.0.0/24")], 10);
    expect(r.total).toBe(10);
    expect(r.droppedBy.cap).toBe(244);
    expect(r.dropped).toBe(244);
    // Truncation keeps the LOW addresses of the range, so a partial scan is a
    // prefix of the full one rather than an arbitrary sample.
    expect(r.addresses[0]).toBe("10.4.0.1");
  });

  it("never exceeds SCAN_MAX_TARGETS however high the caller asks", () => {
    const r = expandScanTargets([cidr("10.4.0.0/24")], 1_000_000);
    expect(r.total).toBe(254);
    expect(SCAN_MAX_TARGETS).toBe(65536);
  });

  it("treats a zero or negative cap as one address rather than scanning nothing silently", () => {
    const r = expandScanTargets([cidr("10.4.0.0/24")], 0);
    expect(r.total).toBe(1);
    expect(r.droppedBy.cap).toBe(253);
  });

  it("applies the cap across targets, not per target", () => {
    const r = expandScanTargets([cidr("10.4.0.0/29"), cidr("10.4.1.0/29")], 8);
    expect(r.total).toBe(8);
    expect(r.droppedBy.cap).toBe(4);
    expect(r.perTarget.map((p) => p.count)).toEqual([6, 2]);
  });
});
