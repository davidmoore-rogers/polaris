/**
 * tests/unit/capacityDbIo.test.ts
 *
 * Coverage for the pure disk-read-pressure rate math in capacityDbIo.ts — the
 * replacement for the old size-based `ram_insufficient` heuristic. No DB; the
 * function is fed synthetic pg_stat_database readings.
 */

import { describe, it, expect } from "vitest";
import {
  deriveDbIoVerdict,
  MIN_IO_WINDOW_MS,
  DB_IO_WATCH_BACKENDS,
  DB_IO_WARNING_BACKENDS,
  type DbIoReading,
} from "../../src/services/capacityDbIo.js";

function reading(over: Partial<DbIoReading> = {}): DbIoReading {
  return {
    nowMs: 1_000_000,
    blksRead: 1000,
    blksHit: 100_000,
    blkReadTime: 5000,
    trackIoTiming: true,
    ...over,
  };
}

describe("deriveDbIoVerdict", () => {
  it("returns unmeasured when there is no previous reading (first call)", () => {
    const v = deriveDbIoVerdict(null, reading());
    expect(v.measured).toBe(false);
    expect(v.avgBackendsBlockedOnDisk).toBeNull();
    expect(v.windowSeconds).toBeNull();
  });

  it("returns unmeasured when the window is shorter than the minimum", () => {
    const prev = reading({ nowMs: 0, blkReadTime: 0 });
    const cur = reading({ nowMs: MIN_IO_WINDOW_MS - 1, blkReadTime: 999_999 });
    expect(deriveDbIoVerdict(prev, cur).measured).toBe(false);
  });

  it("returns unmeasured on a counter reset (any counter goes backwards)", () => {
    const prev = reading({ nowMs: 0, blksRead: 5000, blksHit: 500_000, blkReadTime: 9000 });
    // 60s later but blk_read_time dropped — pg_stat_reset / crash recovery.
    const cur = reading({ nowMs: 60_000, blksRead: 10, blksHit: 10, blkReadTime: 1 });
    expect(deriveDbIoVerdict(prev, cur).measured).toBe(false);
  });

  it("computes avgBackendsBlockedOnDisk = Δblk_read_time / Δelapsed over the window", () => {
    // 600s window, +300_000ms of read time => 0.5 backends continuously blocked.
    const prev = reading({ nowMs: 0, blkReadTime: 0 });
    const cur = reading({ nowMs: 600_000, blkReadTime: 300_000 });
    const v = deriveDbIoVerdict(prev, cur);
    expect(v.measured).toBe(true);
    expect(v.avgBackendsBlockedOnDisk).toBeCloseTo(0.5, 6);
    expect(v.windowSeconds).toBe(600);
  });

  it("reports ~0 read-wait when storage is fast / served from cache (NVMe-like)", () => {
    // Same 600s window, only 60ms of read time across all backends.
    const prev = reading({ nowMs: 0, blkReadTime: 1000 });
    const cur = reading({ nowMs: 600_000, blkReadTime: 1060 });
    const v = deriveDbIoVerdict(prev, cur);
    expect(v.measured).toBe(true);
    expect(v.avgBackendsBlockedOnDisk!).toBeLessThan(DB_IO_WATCH_BACKENDS);
  });

  it("crosses the watch and warning thresholds as read-wait climbs", () => {
    const prev = reading({ nowMs: 0, blkReadTime: 0 });
    // 100s window. 0.5 → watch boundary; 2.0 → warning boundary.
    const atWatch = deriveDbIoVerdict(prev, reading({ nowMs: 100_000, blkReadTime: 0.5 * 100_000 }));
    const atWarning = deriveDbIoVerdict(prev, reading({ nowMs: 100_000, blkReadTime: 2.0 * 100_000 }));
    expect(atWatch.avgBackendsBlockedOnDisk).toBeCloseTo(DB_IO_WATCH_BACKENDS, 6);
    expect(atWarning.avgBackendsBlockedOnDisk).toBeCloseTo(DB_IO_WARNING_BACKENDS, 6);
  });
});
