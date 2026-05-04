/**
 * tests/unit/probeBackoff.test.ts
 *
 * Coverage for `probeIntervalWithBackoff` — the pure helper that decides
 * how often to probe a confirmed-down asset. Lives separately from any
 * DB-touching test so it stays fast.
 */

import { describe, it, expect } from "vitest";
import { probeIntervalWithBackoff } from "../../src/services/monitoringService.js";

const MIN = 60;

describe("probeIntervalWithBackoff — non-down assets are unaffected", () => {
  it("returns base interval when status is up", () => {
    expect(probeIntervalWithBackoff(60, "up", 0)).toBe(60);
    expect(probeIntervalWithBackoff(60, "up", 50)).toBe(60); // even with stale failures
  });
  it("returns base interval when status is unknown (never probed)", () => {
    expect(probeIntervalWithBackoff(60, "unknown", 0)).toBe(60);
  });
  it("returns base interval when status is null", () => {
    expect(probeIntervalWithBackoff(60, null, 0)).toBe(60);
  });
});

describe("probeIntervalWithBackoff — down assets get bucketed backoff", () => {
  it("fresh outage (cf <= 10) bumps to 5 min", () => {
    expect(probeIntervalWithBackoff(60, "down", 4)).toBe(5 * MIN);
    expect(probeIntervalWithBackoff(60, "down", 10)).toBe(5 * MIN);
  });
  it("sustained outage (10 < cf <= 30) bumps to 15 min", () => {
    expect(probeIntervalWithBackoff(60, "down", 11)).toBe(15 * MIN);
    expect(probeIntervalWithBackoff(60, "down", 30)).toBe(15 * MIN);
  });
  it("chronic / decommissioned (cf > 30) caps at 30 min", () => {
    expect(probeIntervalWithBackoff(60, "down", 31)).toBe(30 * MIN);
    expect(probeIntervalWithBackoff(60, "down", 1000)).toBe(30 * MIN);
  });
});

describe("probeIntervalWithBackoff — never probes faster than base", () => {
  it("base 600s + cf=10 stays at 600s, not 5 min", () => {
    // Operator deliberately set 10-min cadence; backoff shouldn't speed it up
    expect(probeIntervalWithBackoff(600, "down", 10)).toBe(600);
  });
  it("base 1800s + cf=11 stays at 1800s, not 15 min", () => {
    expect(probeIntervalWithBackoff(1800, "down", 11)).toBe(1800);
  });
  it("base 3600s + cf=100 stays at 3600s, not 30 min cap", () => {
    expect(probeIntervalWithBackoff(3600, "down", 100)).toBe(3600);
  });
});

describe("probeIntervalWithBackoff — bucket boundaries", () => {
  it("cf=0 (just probed successfully) returns base regardless of status", () => {
    // Note: status=down with cf=0 is unusual but defensively handled
    expect(probeIntervalWithBackoff(60, "down", 0)).toBe(5 * MIN);
  });
  it("transitions from 5min to 15min at cf=11", () => {
    expect(probeIntervalWithBackoff(60, "down", 10)).toBe(5 * MIN);
    expect(probeIntervalWithBackoff(60, "down", 11)).toBe(15 * MIN);
  });
  it("transitions from 15min to 30min at cf=31", () => {
    expect(probeIntervalWithBackoff(60, "down", 30)).toBe(15 * MIN);
    expect(probeIntervalWithBackoff(60, "down", 31)).toBe(30 * MIN);
  });
});
