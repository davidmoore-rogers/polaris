/**
 * tests/unit/discoveryDurationService.test.ts
 *
 * Covers the pure threshold math. Storage-backed functions (recordSample /
 * getBaseline) hit Prisma and are exercised via integration tests.
 */

import { describe, it, expect } from "vitest";
import { computeBaseline } from "../../src/services/discoveryDurationService.js";

describe("computeBaseline", () => {
  it("returns null with fewer than 3 samples", () => {
    expect(computeBaseline([])).toBeNull();
    expect(computeBaseline([5_000])).toBeNull();
    expect(computeBaseline([5_000, 6_000])).toBeNull();
  });

  it("computes avg and stddev across samples", () => {
    const bl = computeBaseline([1_000, 2_000, 3_000])!;
    expect(bl.sampleCount).toBe(3);
    expect(bl.avgMs).toBe(2_000);
    // Population stddev of 1000,2000,3000 = sqrt((1e6+0+1e6)/3) ≈ 816.5
    expect(bl.stddevMs).toBeCloseTo(816.497, 1);
  });

  it("threshold is never below avg + 60s floor", () => {
    // Tight cluster: stddev near 0, avg * 1.5 = 1500 ms, floor wins.
    const bl = computeBaseline([1_000, 1_000, 1_000])!;
    expect(bl.stddevMs).toBe(0);
    expect(bl.thresholdMs).toBe(1_000 + 60_000);
  });

  it("threshold uses multiplier when it beats floor and stddev", () => {
    // avg = 200_000, stddev small, avg*1.5 = 300_000, avg+60s = 260_000.
    const bl = computeBaseline([200_000, 200_000, 200_000])!;
    expect(bl.thresholdMs).toBe(300_000);
  });

  it("threshold uses avg + 2σ when stddev dominates", () => {
    // Highly variable: avg=100s, stddev large enough that avg+2σ > avg*1.5 and > avg+60s.
    const samples = [10_000, 100_000, 190_000];
    const bl = computeBaseline(samples)!;
    expect(bl.avgMs).toBe(100_000);
    // Population stddev = sqrt(((90_000)^2 + 0 + (90_000)^2)/3) ≈ 73_485
    expect(bl.stddevMs).toBeCloseTo(73_484.7, 1);
    const twoSigma = bl.avgMs + 2 * bl.stddevMs; // ≈ 246_970
    const mult = bl.avgMs * 1.5;                 // 150_000
    const floor = bl.avgMs + 60_000;             // 160_000
    expect(bl.thresholdMs).toBeCloseTo(Math.max(twoSigma, mult, floor), 1);
    expect(bl.thresholdMs).toBeCloseTo(twoSigma, 1);
  });

  it("threshold is always strictly greater than avg", () => {
    // Floor of 60 s guarantees this even for zero-variance samples.
    for (const s of [[1], [1_000_000, 1_000_000, 1_000_000], [5, 5, 5]]) {
      const bl = computeBaseline(s);
      if (bl) expect(bl.thresholdMs).toBeGreaterThan(bl.avgMs);
    }
  });
});
