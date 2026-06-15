/**
 * tests/integration/sampleRollup.test.ts
 *
 * Integration tests for src/services/sampleRollupService.ts —
 * `rollupHourly` / `rollupDaily`. The rollup writer is entirely DB-driven
 * (one INSERT...ON CONFLICT DO UPDATE per source per tier aggregating detail
 * samples into hourly buckets, then hourly into daily), so this exercises the
 * real SQL against a live Postgres rather than mocking.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 *
 * Coverage:
 *   - GAUGE table (asset_monitor_samples): sampleCount + success/failure split +
 *     avg/min/max over successful samples within one hour bucket.
 *   - COUNTER table (asset_ipsec_tunnel_samples): first/last byte counter
 *     endpoints + lastBucketSampleAt (the rate-derivation contract), status
 *     counts, and the cadence='fast' gate.
 *   - IDEMPOTENCY: re-running the same window rewrites buckets in place
 *     (ON CONFLICT DO UPDATE) — no duplicate rows.
 *   - rollupDaily reads from *_hourly (not detail) and aggregates a day bucket
 *     from seeded hourly rows.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { rollupHourly, rollupDaily } from "../../src/services/sampleRollupService.js";

const d = dbDescribe;

// A fixed asset id keeps the rollup GROUP BY deterministic. The sample tables
// carry assetId but no FK to Asset (TimescaleDB hypertables — see CLAUDE.md
// tiered-sample-retention), so we don't need a real Asset row.
const ASSET = "00000000-0000-0000-0000-0000000000aa";

// Anchor bucket: top of an hour, ~30 min ago, so it sits inside both the 2-hour
// hourly lookback and the 2-day daily lookback windows used by the service.
function recentHourBucket(): Date {
  const d = new Date(Date.now() - 30 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return d;
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  // Only the tables these tests touch. Detail + both rollup tiers, scoped to
  // our synthetic asset so we never collide with anything else in the DB.
  await prisma.assetMonitorSample.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetMonitorSampleHourly.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetMonitorSampleDaily.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetIpsecTunnelSample.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetIpsecTunnelSampleHourly.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetIpsecTunnelSampleDaily.deleteMany({ where: { assetId: ASSET } });
});

// ─── GAUGE: asset_monitor_samples → hourly ─────────────────────────────────────

d("rollupHourly — gauge table (asset_monitor_samples)", () => {
  it("aggregates sampleCount + success/failure + avg/min/max over successes", async () => {
    const bucket = recentHourBucket();
    // Four samples in one hour bucket: three successes (10/20/30ms) + one failure.
    // avg over successes = 20, min = 10, max = 30. The failure carries a
    // responseTimeMs that must be EXCLUDED from avg/min/max (success-only).
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 1 * 60_000), success: true,  responseTimeMs: 10 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 2 * 60_000), success: true,  responseTimeMs: 20 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 3 * 60_000), success: true,  responseTimeMs: 30 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 4 * 60_000), success: false, responseTimeMs: 9999 },
      ],
    });

    await rollupHourly();

    const rows = await prisma.assetMonitorSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.bucketStart.getTime()).toBe(bucket.getTime());
    expect(row.sampleCount).toBe(4);
    expect(row.successCount).toBe(3);
    expect(row.failureCount).toBe(1);
    expect(row.avgResponseTimeMs).toBeCloseTo(20, 6);
    expect(row.minResponseTimeMs).toBe(10); // failure's 9999 excluded
    expect(row.maxResponseTimeMs).toBe(30); // failure's 9999 excluded
  });

  it("is idempotent — re-running rewrites the bucket in place, no duplicate rows", async () => {
    const bucket = recentHourBucket();
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 1 * 60_000), success: true, responseTimeMs: 40 },
        { assetId: ASSET, timestamp: new Date(bucket.getTime() + 2 * 60_000), success: true, responseTimeMs: 60 },
      ],
    });

    await rollupHourly();
    const first = await prisma.assetMonitorSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(first).toHaveLength(1);
    const firstId = first[0].id;

    // Second run over the same window: ON CONFLICT DO UPDATE must rewrite the
    // same logical bucket — exactly one row, same aggregate values. (The id
    // column is gen_random_uuid() in the INSERT but ON CONFLICT keeps the
    // existing row's id, so the surviving row's id is unchanged.)
    await rollupHourly();
    const second = await prisma.assetMonitorSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(firstId);
    expect(second[0].sampleCount).toBe(2);
    expect(second[0].avgResponseTimeMs).toBeCloseTo(50, 6);
  });
});

// ─── COUNTER: asset_ipsec_tunnel_samples → hourly ──────────────────────────────

d("rollupHourly — counter table (asset_ipsec_tunnel_samples)", () => {
  it("captures first/last counter endpoints + lastBucketSampleAt + status counts", async () => {
    const bucket = recentHourBucket();
    const t1 = new Date(bucket.getTime() + 1 * 60_000);
    const t2 = new Date(bucket.getTime() + 2 * 60_000);
    const t3 = new Date(bucket.getTime() + 3 * 60_000); // last sample in bucket

    // Increasing cumulative byte counters across the bucket. first = earliest
    // (t1), last = latest (t3). cadence MUST be 'fast' — the rollup gates on it.
    await prisma.assetIpsecTunnelSample.createMany({
      data: [
        { assetId: ASSET, tunnelName: "tun0", timestamp: t1, status: "up",   incomingBytes: 1000n, outgoingBytes: 500n,  cadence: "fast" },
        { assetId: ASSET, tunnelName: "tun0", timestamp: t2, status: "up",   incomingBytes: 1500n, outgoingBytes: 750n,  cadence: "fast" },
        { assetId: ASSET, tunnelName: "tun0", timestamp: t3, status: "down", incomingBytes: 2000n, outgoingBytes: 1000n, cadence: "fast" },
      ],
    });

    await rollupHourly();

    const rows = await prisma.assetIpsecTunnelSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.tunnelName).toBe("tun0");
    expect(row.bucketStart.getTime()).toBe(bucket.getTime());
    expect(row.sampleCount).toBe(3);
    // Counter endpoints — first = earliest timestamp, last = latest timestamp.
    expect(row.firstIncomingBytes).toBe(1000n);
    expect(row.lastIncomingBytes).toBe(2000n);
    expect(row.firstOutgoingBytes).toBe(500n);
    expect(row.lastOutgoingBytes).toBe(1000n);
    // lastBucketSampleAt = MAX(timestamp) — the right edge for rate denominator.
    expect(row.lastBucketSampleAt.getTime()).toBe(t3.getTime());
    // Status counts: 2 up + 1 down.
    expect(row.statusUpCount).toBe(2);
    expect(row.statusDownCount).toBe(1);
  });

  it("ignores non-fast cadence rows (cadence gate)", async () => {
    const bucket = recentHourBucket();
    // All slow/null cadence → rollup gate excludes them → no hourly row.
    await prisma.assetIpsecTunnelSample.createMany({
      data: [
        { assetId: ASSET, tunnelName: "tun-slow", timestamp: new Date(bucket.getTime() + 1 * 60_000), status: "up", incomingBytes: 10n, cadence: "slow" },
        { assetId: ASSET, tunnelName: "tun-null", timestamp: new Date(bucket.getTime() + 2 * 60_000), status: "up", incomingBytes: 20n, cadence: null },
      ],
    });

    await rollupHourly();

    const rows = await prisma.assetIpsecTunnelSampleHourly.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(0);
  });
});

// ─── DAILY: reads from *_hourly, not detail ────────────────────────────────────

d("rollupDaily — builds the day bucket from seeded hourly rows", () => {
  it("monitor daily SUMs counts + weighted-avgs + MIN/MAX across hourly buckets", async () => {
    // Two hourly buckets on the same day. Seed the HOURLY tier directly — the
    // daily rollup must read these, not the (empty) detail table.
    const day = recentHourBucket();
    day.setUTCHours(0, 0, 0, 0); // start of the UTC day (date_trunc('day') is UTC)
    const h1 = new Date(day.getTime() + 1 * 3600_000);
    const h2 = new Date(day.getTime() + 2 * 3600_000);

    await prisma.assetMonitorSampleHourly.createMany({
      data: [
        // bucket h1: 3 samples, 3 successes, avg 10, min 5, max 15
        { assetId: ASSET, bucketStart: h1, sampleCount: 3, successCount: 3, failureCount: 0, avgResponseTimeMs: 10, minResponseTimeMs: 5, maxResponseTimeMs: 15 },
        // bucket h2: 1 sample, 1 success, avg 30, min 30, max 30
        { assetId: ASSET, bucketStart: h2, sampleCount: 1, successCount: 1, failureCount: 0, avgResponseTimeMs: 30, minResponseTimeMs: 30, maxResponseTimeMs: 30 },
      ],
    });

    await rollupDaily();

    const rows = await prisma.assetMonitorSampleDaily.findMany({ where: { assetId: ASSET } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.bucketStart.getTime()).toBe(day.getTime());
    expect(row.sampleCount).toBe(4);     // 3 + 1
    expect(row.successCount).toBe(4);
    expect(row.failureCount).toBe(0);
    // Weighted avg by successCount: (10*3 + 30*1) / 4 = 15.
    expect(row.avgResponseTimeMs).toBeCloseTo(15, 6);
    expect(row.minResponseTimeMs).toBe(5);  // MIN across buckets
    expect(row.maxResponseTimeMs).toBe(30); // MAX across buckets
  });

  it("is idempotent at the daily tier too", async () => {
    const day = recentHourBucket();
    day.setUTCHours(0, 0, 0, 0);
    const h1 = new Date(day.getTime() + 1 * 3600_000);
    await prisma.assetMonitorSampleHourly.create({
      data: { assetId: ASSET, bucketStart: h1, sampleCount: 2, successCount: 2, failureCount: 0, avgResponseTimeMs: 100, minResponseTimeMs: 50, maxResponseTimeMs: 150 },
    });

    await rollupDaily();
    const first = await prisma.assetMonitorSampleDaily.findMany({ where: { assetId: ASSET } });
    expect(first).toHaveLength(1);
    const firstId = first[0].id;

    await rollupDaily();
    const second = await prisma.assetMonitorSampleDaily.findMany({ where: { assetId: ASSET } });
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(firstId);
    expect(second[0].sampleCount).toBe(2);
    expect(second[0].avgResponseTimeMs).toBeCloseTo(100, 6);
  });
});
