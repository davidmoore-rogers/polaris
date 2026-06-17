import { describe, it, expect } from "vitest";
import {
  unselectedSlowPruneWindow,
  tieredPruneWindow,
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

describe("tieredPruneWindow", () => {
  it("sets cutoff at now - retentionDays", () => {
    const { cutoff } = tieredPruneWindow(NOW, 30, 7);
    expect(cutoff.getTime()).toBe(NOW - 30 * DAY);
  });

  it("SKIPS the row-DELETE for the common rollup case (retention >> compress frontier)", () => {
    // The 2026-06-17 incident: 30-day hourly retention, 7-day compression.
    // Everything older than the 30d cutoff is deep in compressed territory, so
    // no row-DELETE may run — drop_chunks alone reclaims it.
    const { skipRowDelete, gte, cutoff } = tieredPruneWindow(NOW, 30, 7);
    expect(skipRowDelete).toBe(true);
    expect(gte).toBeNull();
    expect(cutoff.getTime()).toBe(NOW - 30 * DAY);
  });

  it("skips the row-DELETE for 365-day daily retention too", () => {
    expect(tieredPruneWindow(NOW, 365, 7).skipRowDelete).toBe(true);
  });

  it("skips when retention == compress-after (frontier coincides with cutoff)", () => {
    // e.g. asset_monitor_samples detail: 7d retention, 7d compress. The
    // straddling chunk's residue rides until drop_chunks removes it whole.
    const { skipRowDelete } = tieredPruneWindow(NOW, 7, 7);
    expect(skipRowDelete).toBe(true);
  });

  it("bounds the DELETE to [frontier, cutoff) when the cutoff is NEWER than the frontier", () => {
    // Short retention (1 day) under a 7-day compression frontier: there IS an
    // uncompressed window (1d..7d) to clean; older rows stay compressed.
    const { skipRowDelete, gte, cutoff } = tieredPruneWindow(NOW, 1, 7);
    expect(skipRowDelete).toBe(false);
    expect(gte).not.toBeNull();
    expect(gte!.getTime()).toBe(NOW - 7 * DAY);
    expect(cutoff.getTime()).toBe(NOW - 1 * DAY);
    expect(gte!.getTime()).toBeLessThan(cutoff.getTime());
  });

  it("does an unbounded residue DELETE when compression is disabled (0)", () => {
    const { skipRowDelete, gte, cutoff } = tieredPruneWindow(NOW, 30, 0);
    expect(skipRowDelete).toBe(false);
    expect(gte).toBeNull();
    expect(cutoff.getTime()).toBe(NOW - 30 * DAY);
  });

  it("keep-nothing (days<=0) deletes the uncompressed window up to now", () => {
    // cutoff = now; with compression, delete only [frontier, now); drop_chunks
    // (called at cutoff=now by the caller) sweeps the compressed chunks.
    const { skipRowDelete, gte, cutoff } = tieredPruneWindow(NOW, 0, 7);
    expect(skipRowDelete).toBe(false);
    expect(cutoff.getTime()).toBe(NOW);
    expect(gte!.getTime()).toBe(NOW - 7 * DAY);
  });
});
