import { describe, it, expect } from "vitest";
import {
  unselectedSlowPruneWindow,
  UNSELECTED_DETAIL_HOURS,
} from "../../src/services/sampleRetentionService.js";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// Fixed reference instant so the test is deterministic (no Date.now()).
const NOW = Date.UTC(2026, 5, 8, 12, 0, 0); // 2026-06-08T12:00:00Z

describe("unselectedSlowPruneWindow", () => {
  it("always sets the upper bound (lt) at now - UNSELECTED_DETAIL_HOURS", () => {
    const { lt } = unselectedSlowPruneWindow(NOW, 7);
    expect(lt.getTime()).toBe(NOW - UNSELECTED_DETAIL_HOURS * HOUR);
  });

  it("lower-bounds at the compress frontier for the default 7-day window", () => {
    const { gte, lt } = unselectedSlowPruneWindow(NOW, 7);
    expect(gte).not.toBeNull();
    expect(gte!.getTime()).toBe(NOW - 7 * DAY);
    // Window is non-empty and ordered: frontier (7d back) < cutoff (24h back).
    expect(gte!.getTime()).toBeLessThan(lt.getTime());
  });

  it("lower-bounds at the 2-day selection-aware floor", () => {
    const { gte, lt } = unselectedSlowPruneWindow(NOW, 2);
    expect(gte!.getTime()).toBe(NOW - 2 * DAY);
    expect(gte!.getTime()).toBeLessThan(lt.getTime());
  });

  it("returns gte=null when compression is disabled (0) — legacy unbounded prune", () => {
    const { gte, lt } = unselectedSlowPruneWindow(NOW, 0);
    expect(gte).toBeNull();
    expect(lt.getTime()).toBe(NOW - UNSELECTED_DETAIL_HOURS * HOUR);
  });

  it("returns gte=null when the frontier is not strictly older than the 24h cutoff", () => {
    // compressAfterDays = 1 → frontier at now-24h == cutoff (not strictly <),
    // which would make the window empty; fall back to unbounded so slow rows
    // still prune.
    expect(unselectedSlowPruneWindow(NOW, 1).gte).toBeNull();
  });

  it("never produces an empty window when gte is set", () => {
    for (const days of [2, 3, 7, 14, 30]) {
      const { gte, lt } = unselectedSlowPruneWindow(NOW, days);
      expect(gte!.getTime()).toBeLessThan(lt.getTime());
    }
  });
});
