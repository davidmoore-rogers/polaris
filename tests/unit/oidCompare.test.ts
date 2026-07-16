/**
 * tests/unit/oidCompare.test.ts
 *
 * Numeric OID comparison + the monotonic-walk guard that protects both SNMP
 * walk paths (internal collector snmpWalk + operator snmpWalkRaw) from an
 * agent that returns a non-increasing OID on GETNEXT/GETBULK — the
 * ControlByWeb X-4xx echo-loop failure mode. Key invariants:
 *
 *  - Comparison is numeric per component, not lexicographic ("...9" < "...10")
 *  - A strict prefix sorts before its extensions (SNMP OID ordering)
 *  - The guard trips on an EQUAL OID (the echo loop net-snmp's own
 *    backwardsGetNexts strict mode misses) and on a backwards OID
 *  - The guard keeps state per instance and reports the last accepted OID
 */

import { describe, it, expect } from "vitest";
import { compareOids, makeOidMonotonicGuard } from "../../src/utils/oidCompare.js";

describe("compareOids", () => {
  it("returns 0 for equal OIDs", () => {
    expect(compareOids("1.3.6.1.4.1.30586.50", "1.3.6.1.4.1.30586.50")).toBe(0);
  });

  it("orders by numeric component value", () => {
    expect(compareOids("1.3.6.1.2.1.1", "1.3.6.1.2.1.2")).toBeLessThan(0);
    expect(compareOids("1.3.6.1.2.1.2", "1.3.6.1.2.1.1")).toBeGreaterThan(0);
  });

  it("compares numerically, not lexicographically", () => {
    // String comparison would put "10" before "9"
    expect(compareOids("1.3.6.1.9", "1.3.6.1.10")).toBeLessThan(0);
    expect(compareOids("1.3.6.1.10", "1.3.6.1.9")).toBeGreaterThan(0);
  });

  it("sorts a strict prefix before its extensions", () => {
    expect(compareOids("1.3.6", "1.3.6.1")).toBeLessThan(0);
    expect(compareOids("1.3.6.1", "1.3.6")).toBeGreaterThan(0);
  });

  it("orders on the first differing component even when lengths differ", () => {
    expect(compareOids("1.3.7", "1.3.6.1.4.1")).toBeGreaterThan(0);
    expect(compareOids("1.3.5.9.9.9", "1.3.6")).toBeLessThan(0);
  });

  it("handles multi-digit components at every depth", () => {
    expect(compareOids("1.3.6.1.4.1.30586.50", "1.3.6.1.4.1.30586.50.0.1")).toBeLessThan(0);
    expect(compareOids("1.3.6.1.4.1.30586.50.0.2", "1.3.6.1.4.1.30586.50.0.10")).toBeLessThan(0);
  });
});

describe("makeOidMonotonicGuard", () => {
  it("accepts a strictly increasing walk", () => {
    const guard = makeOidMonotonicGuard();
    expect(guard.advance("1.3.6.1.2.1.1.1.0")).toBe(true);
    expect(guard.advance("1.3.6.1.2.1.1.2.0")).toBe(true);
    expect(guard.advance("1.3.6.1.2.1.1.10.0")).toBe(true);
    expect(guard.last()).toBe("1.3.6.1.2.1.1.10.0");
  });

  it("trips on an equal OID (agent echo loop)", () => {
    const guard = makeOidMonotonicGuard();
    expect(guard.advance("1.3.6.1.4.1.30586.50")).toBe(true);
    expect(guard.advance("1.3.6.1.4.1.30586.50")).toBe(false);
    // last() still reports the last ACCEPTED oid for the error message
    expect(guard.last()).toBe("1.3.6.1.4.1.30586.50");
  });

  it("trips on a backwards OID", () => {
    const guard = makeOidMonotonicGuard();
    expect(guard.advance("1.3.6.1.2.1.2.2.1.2.1")).toBe(true);
    expect(guard.advance("1.3.6.1.2.1.2.2.1.1.9")).toBe(false);
  });

  it("accepts the very first OID unconditionally", () => {
    const guard = makeOidMonotonicGuard();
    expect(guard.advance("0.0")).toBe(true);
  });

  it("keeps state per instance", () => {
    const a = makeOidMonotonicGuard();
    const b = makeOidMonotonicGuard();
    expect(a.advance("1.3.6.1.2.1.5")).toBe(true);
    // A fresh guard is unaffected by another walk's history
    expect(b.advance("1.3.6.1.2.1.1")).toBe(true);
    expect(a.advance("1.3.6.1.2.1.1")).toBe(false);
  });
});
