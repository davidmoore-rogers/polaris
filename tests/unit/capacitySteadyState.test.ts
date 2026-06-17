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

import { projectSteadyStateSize, projectDetailBytes } from "../../src/services/capacityService.js";
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

describe("projectDetailBytes — measured daily rate vs workload fallback", () => {
  const FALLBACK = 2_270_000_000;
  const DAILY = 12_000_000_000;

  it("uses measured daily × retention when retention ≤ compress-after (tier never compresses)", () => {
    expect(projectDetailBytes({ measuredDailyBytes: DAILY, retentionDays: 7, compressAfterDays: 7, workloadFallbackBytes: FALLBACK }))
      .toBe(DAILY * 7);
  });

  it("uses measured when compression is disabled (compressAfter 0)", () => {
    expect(projectDetailBytes({ measuredDailyBytes: DAILY, retentionDays: 30, compressAfterDays: 0, workloadFallbackBytes: FALLBACK }))
      .toBe(DAILY * 30);
  });

  it("falls back to the workload model when retention reaches PAST the compress frontier", () => {
    // retention 7 > compress 3 → part of the data is compressed; the
    // uncompressed daily rate would over-project, so use the fallback.
    expect(projectDetailBytes({ measuredDailyBytes: DAILY, retentionDays: 7, compressAfterDays: 3, workloadFallbackBytes: FALLBACK }))
      .toBe(FALLBACK);
  });

  it("falls back when there is no measurement (null / zero)", () => {
    expect(projectDetailBytes({ measuredDailyBytes: null, retentionDays: 7, compressAfterDays: 7, workloadFallbackBytes: FALLBACK })).toBe(FALLBACK);
    expect(projectDetailBytes({ measuredDailyBytes: 0, retentionDays: 7, compressAfterDays: 7, workloadFallbackBytes: FALLBACK })).toBe(FALLBACK);
  });
});

describe("projectSteadyStateSize — measured detail daily rate", () => {
  // One interface-detail table; default interfaces.detail retention is 7d.
  const ifaceTable = [
    { name: "asset_interface_samples", rows: 1000, bytes: 2_000_000, avgBytesPerRow: 395, deadTupRatio: 0, lastAutovacuum: null },
  ];

  it("projects measured uncompressed daily bytes × full retention (not the 24h-capped workload guess)", () => {
    const projected = projectSteadyStateSize({
      ...baseArgs,
      sampleTables: ifaceTable,
      measuredDetailDailyBytes: { asset_interface_samples: 12_000_000_000 },
      compressAfterByTable: { asset_interface_samples: 7 },
    });
    const base = baseArgs.currentDbBytes - 2_000_000;
    expect(projected).toBe(base + 12_000_000_000 * 7); // 84 GB of interface detail, matching reality
  });

  it("without a measurement, keeps the conservative 24h-capped workload model for selection-aware detail", () => {
    const projected = projectSteadyStateSize({ ...baseArgs, sampleTables: ifaceTable });
    const base = baseArgs.currentDbBytes - 2_000_000;
    // interface rowsPerAssetPerDay = (86400/600)*20 = 2880; selection-aware cap = 1 day; 395 B/row.
    const fallback = 2000 * 2880 * 1 * 395;
    expect(projected).toBe(base + fallback);
  });
});
