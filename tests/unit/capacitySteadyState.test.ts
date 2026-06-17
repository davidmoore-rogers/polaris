/**
 * tests/unit/capacitySteadyState.test.ts
 *
 * Guards the steady-state size projection against the 2026-06 capacity-card
 * bug, where it multiplied in a LIVE-MEASURED per-row size (relpages / pg_stat
 * tuples) that was wildly unreliable for compressed/bloated TimescaleDB
 * hypertables — producing phantom 14–218 TB steady-states that flip-flopped
 * between snapshots as autovacuum/ANALYZE churned the tuple estimates. The fix:
 * the projection uses the calibrated DEFAULT_BYTES_PER_ROW and ignores the
 * measured value, so it's a stable workload model.
 */

import { describe, it, expect, vi } from "vitest";

// capacityService imports prisma at module load; stub it so importing the pure
// projection helper doesn't open a DB connection.
vi.mock("../../src/db.js", () => ({
  prisma: { $queryRawUnsafe: vi.fn(), $queryRaw: vi.fn() },
  getDirectStatsPool: () => null,
}));

import { projectSteadyStateSize } from "../../src/services/capacityService.js";
import { defaultSampleRetention } from "../../src/services/sampleRetentionService.js";

const monitor = {
  intervalSeconds: 60,
  telemetryIntervalSeconds: 60,
  systemInfoIntervalSeconds: 600,
} as any;

const baseArgs = {
  currentDbBytes: 50_000_000_000, // 50 GB
  monitoredCount: 2000,
  telemetryEligibleCount: 2000,
  systemInfoEligibleCount: 2000,
  monitor,
  retention: defaultSampleRetention(),
};

// One real source table name + one rollup, with a SANE measured per-row size.
const saneTables = [
  { name: "asset_monitor_samples",        rows: 1000, bytes: 1_000_000, avgBytesPerRow: 310, deadTupRatio: 0, lastAutovacuum: null },
  { name: "asset_monitor_samples_hourly", rows: 1000, bytes: 1_000_000, avgBytesPerRow: 280, deadTupRatio: 0, lastAutovacuum: null },
];

// Same tables, but with the absurd measured per-row size the bug fed in
// (≈176 kB/row was observed in prod).
const absurdTables = saneTables.map((t) => ({ ...t, avgBytesPerRow: 200_000 }));

describe("projectSteadyStateSize — stable against measured per-row noise", () => {
  it("ignores the live-measured avgBytesPerRow entirely", () => {
    const sane = projectSteadyStateSize({ ...baseArgs, sampleTables: saneTables });
    const absurd = projectSteadyStateSize({ ...baseArgs, sampleTables: absurdTables });
    expect(absurd).toBe(sane);
  });

  it("projects a bounded, plausible steady-state (not TB-scale) for a 2000-asset fleet", () => {
    const projected = projectSteadyStateSize({ ...baseArgs, sampleTables: saneTables });
    // Must exceed the non-sample base but stay far below the absurd TB-scale
    // numbers the bug produced. With only 2 tables modeled here it's modest;
    // the ceiling is a sanity bound, not a tight assertion.
    expect(projected).toBeGreaterThan(baseArgs.currentDbBytes - 1_000_000); // ~base, minus subtracted sample bytes
    expect(projected).toBeLessThan(2_000_000_000_000); // < 2 TB — was 218 TB
  });

  it("uses the calibrated default for the per-row size (formula lock)", () => {
    // asset_monitor_samples: countKey "all" → monitoredCount; rate 86400/60;
    // retention detail 7d; default 310 bytes/row.
    const onlyDetail = [saneTables[0]];
    const projected = projectSteadyStateSize({ ...baseArgs, sampleTables: onlyDetail });
    const rowsPerDay = 86400 / 60;
    const expectedSample = 2000 * rowsPerDay * 7 * 310;
    const base = baseArgs.currentDbBytes - onlyDetail[0].bytes;
    expect(projected).toBe(base + expectedSample);
  });

  it("returns current size unchanged when nothing is monitored", () => {
    const projected = projectSteadyStateSize({ ...baseArgs, monitoredCount: 0, sampleTables: saneTables });
    expect(projected).toBe(baseArgs.currentDbBytes);
  });
});
