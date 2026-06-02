/**
 * src/services/capacityDbIo.ts
 *
 * Pure disk-read-pressure rate math, split out from capacityService.ts so it
 * can be unit-tested without dragging in the service's heavy import graph
 * (prisma, queueService → pg-boss optional dep, etc.).
 *
 * The signal: PostgreSQL's `pg_stat_database.blk_read_time` is the cumulative
 * time spent inside read() syscalls. We sample it between successive capacity
 * snapshots and turn the delta into a rate. Measuring *time* (not block count)
 * is what makes this medium-aware for free — a cache miss costs ~5-10ms on a
 * spinning disk, ~0.02ms on NVMe, and ~0ms when the page is in the OS page
 * cache — so the signal is high only when reads are both frequent AND slow.
 *
 * blk_read_time is only populated when `track_io_timing = on`; callers handle
 * the off case separately (they can't measure, so they nudge the operator to
 * enable it rather than guessing).
 */

/** Raw cumulative-since-reset counters from pg_stat_database for the DB. */
export interface DbIoReading {
  /** Wall-clock ms (DB-side clock_timestamp) when the counters were read. */
  nowMs: number;
  blksRead: number;
  blksHit: number;
  /** Cumulative ms spent in read() syscalls (0 when track_io_timing is off). */
  blkReadTime: number;
  trackIoTiming: boolean;
}

/** Derived rate verdict computed from two readings. */
export interface DbIoVerdict {
  /** False on first call, too-short a window, or a stats reset — don't alarm. */
  measured: boolean;
  /** Δblk_read_time(ms) / Δelapsed(ms): avg connections continuously blocked
   *  on storage reads over the window. Null when not measured. */
  avgBackendsBlockedOnDisk: number | null;
  windowSeconds: number | null;
}

// Below this window the rate is too noisy to trust (cold start, or a Maintenance
// tab refresh moments after a capacityWatch tick).
export const MIN_IO_WINDOW_MS = 30_000;
// How long a measured verdict stays usable for sub-window calls (Maintenance
// tab refreshes between the 10-min capacityWatch ticks) before we treat the
// reading as stale and report unmeasured.
export const IO_VERDICT_STALE_MS = 20 * 60_000;
// Watch when, on average, at least half a connection was continuously blocked
// on storage reads across the window; warning at two. Tunable here only.
export const DB_IO_WATCH_BACKENDS = 0.5;
export const DB_IO_WARNING_BACKENDS = 2.0;

/**
 * Pure rate computation. Returns measured:false (so callers won't alarm) on the
 * first reading, a too-short window, or a counter reset (current < prev, i.e.
 * `pg_stat_reset` / crash recovery), in which case the caller rebases its
 * previous reading to the current one.
 */
export function deriveDbIoVerdict(prev: DbIoReading | null, current: DbIoReading): DbIoVerdict {
  const unmeasured: DbIoVerdict = { measured: false, avgBackendsBlockedOnDisk: null, windowSeconds: null };
  if (!prev) return unmeasured;
  const elapsedMs = current.nowMs - prev.nowMs;
  if (elapsedMs < MIN_IO_WINDOW_MS) return unmeasured;
  // Stats reset / counter rollback — any going backwards invalidates the delta.
  if (
    current.blkReadTime < prev.blkReadTime ||
    current.blksRead < prev.blksRead ||
    current.blksHit < prev.blksHit
  ) {
    return unmeasured;
  }
  const deltaReadTimeMs = current.blkReadTime - prev.blkReadTime;
  return {
    measured: true,
    avgBackendsBlockedOnDisk: deltaReadTimeMs / elapsedMs,
    windowSeconds: elapsedMs / 1000,
  };
}
