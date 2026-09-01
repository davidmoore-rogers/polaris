/**
 * tests/unit/probeLossWindow.test.ts
 *
 * The probe-loss History window as ONE resolution shared by the engine and the
 * alert-email loss chart (2026-08-20): the engine measures the ratio over it,
 * and the chart in the email spans the same period — before this the chart was
 * a fixed last hour, so an alert reading "18.3% over 60 minutes" sat over a
 * graph averaging a different span. Also pins the chart's bucket scaling: ~30
 * plotted points whatever the window, floored at 2 minutes so a bucket never
 * undercuts the probe cadence.
 */

import { describe, it, expect } from "vitest";
import {
  probeLossWindowSec,
  probeLossWindowSecFromTrigger,
  PROBE_LOSS_DEFAULT_WINDOW_SEC,
  PROBE_LOSS_MIN_WINDOW_SEC,
  readingAtOrAboveCeiling,
  DEFAULT_READING_CEILING_PCT,
} from "../../src/services/notificationTypes.js";
import { lossBucketMs, probeLossSeriesFrom } from "../../src/services/alertChartService.js";

describe("probeLossWindowSec", () => {
  it("uses the configured window exactly", () => {
    expect(probeLossWindowSec(3600)).toBe(3600);
    expect(probeLossWindowSec(900)).toBe(900);
  });

  it("floors at the 5-minute minimum — a ratio needs a few probes behind it", () => {
    expect(probeLossWindowSec(60)).toBe(PROBE_LOSS_MIN_WINDOW_SEC);
  });

  it("defaults when the trigger carries none (pre-History rules, hand-written ones)", () => {
    expect(probeLossWindowSec(0)).toBe(PROBE_LOSS_DEFAULT_WINDOW_SEC);
    expect(probeLossWindowSec(null)).toBe(PROBE_LOSS_DEFAULT_WINDOW_SEC);
    expect(probeLossWindowSec(undefined)).toBe(PROBE_LOSS_DEFAULT_WINDOW_SEC);
  });
});

describe("probeLossWindowSecFromTrigger", () => {
  it("reads a flat probeLossPct trigger's window", () => {
    expect(probeLossWindowSecFromTrigger({ type: "asset_metric", metric: "probeLossPct", windowSec: 3600 })).toBe(3600);
  });

  it("resolves a legacy trigger (no window) to the engine's default — what the alert was actually measured over", () => {
    expect(probeLossWindowSecFromTrigger({ type: "asset_metric", metric: "probeLossPct", windowSec: 0, forDurationSec: 3600 }))
      .toBe(PROBE_LOSS_DEFAULT_WINDOW_SEC);
  });

  it("finds a loss leaf inside a composite tree, nested groups included", () => {
    const trigger = {
      type: "composite", kind: "asset", op: "and",
      children: [
        { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0 },
        { op: "or", children: [{ type: "asset_metric", metric: "probeLossPct", windowSec: 1800 }] },
      ],
    };
    expect(probeLossWindowSecFromTrigger(trigger)).toBe(1800);
  });

  it("is null when the trigger has no loss condition — the chart keeps its default window", () => {
    expect(probeLossWindowSecFromTrigger({ type: "asset_metric", metric: "cpuPct", windowSec: 300 })).toBeNull();
    expect(probeLossWindowSecFromTrigger({ type: "event", actionPattern: "x.*" })).toBeNull();
    expect(probeLossWindowSecFromTrigger(null)).toBeNull();
    expect(probeLossWindowSecFromTrigger("garbage")).toBeNull();
  });
});

describe("probeLossSeriesFrom", () => {
  const T0 = Date.parse("2026-08-20T06:00:00Z");
  const min = (m: number) => new Date(T0 + m * 60_000);
  /** One probe a minute for `n` minutes, failing on the listed minutes. */
  const probes = (n: number, failAt: number[]) =>
    Array.from({ length: n }, (_, i) => ({ timestamp: min(i), success: !failAt.includes(i) }));

  it("captions the PROBE ratio, which diverges from the bucket mean when buckets hold unequal counts", () => {
    // THE CASE THAT MADE THIS NECESSARY (prod, 2026-08-20): sampling is not
    // uniform, so buckets hold different numbers of probes. Here one bucket
    // holds 10 failing probes (what the ICMP loss sampler did during a run —
    // it fired every 10s precisely BECAUSE probes were failing) and nine hold
    // one clean probe each.
    //
    //   probe ratio  = 10 failed / 20 total    = 50 %   <- what the engine compares
    //   bucket mean  = (0 + 100 + 0×9) / 11    ≈ 9 %    <- what the caption used to print
    //
    // An unweighted mean of ratios treats a 10-probe bucket and a 1-probe
    // bucket as equals, so the caption drifted from the alert's own reading.
    const rows = [
      { timestamp: min(0), success: true }, // anchor: the window's first success
      // Ten failures packed into minute 2's bucket, 6s apart.
      ...Array.from({ length: 10 }, (_, i) => ({ timestamp: new Date(min(2).getTime() + i * 6_000), success: false })),
      ...Array.from({ length: 9 }, (_, i) => ({ timestamp: min(4 + i * 2), success: true })),
    ];
    const s = probeLossSeriesFrom(rows, 2 * 60_000);
    expect(s.ratioPct).toBe(50);
    const bucketMean = s.points.reduce((a, p) => a + p.v, 0) / s.points.length;
    expect(Math.round(bucketMean)).toBe(9);
    // The line keeps the burst's SHAPE (that bucket is 100 % lost) while the
    // caption states the window's real loss — the two answer different
    // questions, which is why avgOverride exists rather than a reshaped series.
    expect(Math.max(...s.points.map((p) => p.v))).toBe(100);
  });

  it("agrees with the bucket mean when the cadence IS uniform — the sampler-off case", () => {
    // Worth pinning: with one probe a minute and every bucket equally full, the
    // mean of bucket ratios and the probe ratio coincide (11 failures / 60
    // probes = 18.3 % either way). That is why disabling the ICMP sampler
    // shrank the discrepancy, and why it does not remove the need for the
    // override — a polling gap, the anchor trimming a partial bucket, or a
    // suppressed asset's 2× interval all re-introduce unequal counts.
    const s = probeLossSeriesFrom(probes(60, Array.from({ length: 11 }, (_, i) => 20 + i)), 2 * 60_000);
    expect(s.ratioPct).toBe(18.3);
    const bucketMean = s.points.reduce((a, p) => a + p.v, 0) / s.points.length;
    expect(Math.round(bucketMean * 10) / 10).toBe(18.3);
  });

  it("is 0 % for a clean window and 100 % when every probe failed", () => {
    expect(probeLossSeriesFrom(probes(30, []), 2 * 60_000).ratioPct).toBe(0);
    // No success at all reads 100 %, not blank — an asset-down alert embeds a
    // loss chart too, and an empty one would say "no loss".
    const allFailed = probeLossSeriesFrom(probes(30, Array.from({ length: 30 }, (_, i) => i)), 2 * 60_000);
    expect(allFailed.ratioPct).toBe(100);
    expect(allFailed.points.length).toBeGreaterThan(0);
  });

  it("counts the outage that preceded recovery — the anchor is gone", () => {
    // 40 minutes dark, then 20 clean. The first-success anchor made the CAPTION
    // read 0% over a line that plainly showed an outage; both halves now cover
    // the same window and agree at 66.7%.
    const rows = probes(60, Array.from({ length: 40 }, (_, i) => i));
    const s = probeLossSeriesFrom(rows, 2 * 60_000);
    expect(s.ratioPct).toBe(66.7);
    // The line always kept the outage; that has not changed.
    expect(s.points.some((p) => p.t < min(40).getTime() && p.v === 100)).toBe(true);
    expect(s.points[0]!.t).toBe(min(0).getTime());
  });

  it("counts an outage that started mid-window", () => {
    // 10 clean, 30 dark, 20 clean. The old recovery anchor read this as 0%
    // about a device that had lost half its probes in the last hour.
    const rows = probes(60, Array.from({ length: 30 }, (_, i) => 10 + i));
    expect(probeLossSeriesFrom(rows, 2 * 60_000).ratioPct).toBe(50);
  });

  it("weights a burst row by its PACKETS, not as one outcome", () => {
    // Mirrors probeLossQuery: a 5-echo burst that got 1 reply back is an
    // 80%-lossy reading, and counting the row once would call it a success.
    const rows = [
      { timestamp: min(0), success: true, packetsSent: 5, packetsReceived: 1 },
      { timestamp: min(1), success: true, packetsSent: 5, packetsReceived: 1 },
    ];
    expect(probeLossSeriesFrom(rows, 2 * 60_000).ratioPct).toBe(80);
  });

  it("treats a row with no packet columns as one probe, never as zero sent", () => {
    // The response-time poll leaves them NULL. Reading NULL as 0 sent would
    // drop those rows out of the denominator entirely.
    const mixed = [
      { timestamp: min(0), success: false },
      { timestamp: min(1), success: true, packetsSent: 4, packetsReceived: 4 },
    ];
    // 1 lost of 5 sent — the bare row contributed a denominator of 1.
    expect(probeLossSeriesFrom(mixed, 2 * 60_000).ratioPct).toBe(20);
  });

  it("clamps a received count above sent rather than yielding negative loss", () => {
    const rows = [{ timestamp: min(0), success: true, packetsSent: 3, packetsReceived: 9 }];
    expect(probeLossSeriesFrom(rows, 2 * 60_000).ratioPct).toBe(0);
  });
  it("skips empty buckets rather than plotting a polling gap as perfect health", () => {
    const rows = [
      { timestamp: min(0), success: true },
      { timestamp: min(1), success: false },
      // ...30-minute gap...
      { timestamp: min(31), success: true },
    ];
    const s = probeLossSeriesFrom(rows, 2 * 60_000);
    expect(s.points).toHaveLength(2);
    expect(s.ratioPct).toBe(33.3);
  });

  it("has no ratio for an empty window", () => {
    expect(probeLossSeriesFrom([], 2 * 60_000)).toEqual({ points: [], ratioPct: null });
  });
});

describe("lossBucketMs", () => {
  it("keeps the 2-minute floor for an hour or less", () => {
    expect(lossBucketMs(60 * 60_000)).toBe(2 * 60_000);
    expect(lossBucketMs(15 * 60_000)).toBe(2 * 60_000);
    expect(lossBucketMs(5 * 60_000)).toBe(2 * 60_000);
  });

  it("scales up so a long History still plots ~30 points", () => {
    expect(lossBucketMs(4 * 60 * 60_000)).toBe(8 * 60_000);
    expect(lossBucketMs(24 * 60 * 60_000)).toBe(48 * 60_000);
  });
});

describe("readingAtOrAboveCeiling", () => {
  const loss = (ignoreAtOrAbove?: number) => ({
    type: "asset_metric", metric: "probeLossPct",
    ...(ignoreAtOrAbove === undefined ? {} : { ignoreAtOrAbove }),
  });

  it("defaults to 100, so only a total outage is suppressed", () => {
    expect(DEFAULT_READING_CEILING_PCT).toBe(100);
    expect(readingAtOrAboveCeiling(loss(), 100)).toBe(true);
    expect(readingAtOrAboveCeiling(loss(), 99.9)).toBe(false);
    // Which is what leaves every rule authored before the control unchanged.
    expect(readingAtOrAboveCeiling(loss(), 92)).toBe(false);
  });

  it("is inclusive at the stated ceiling", () => {
    // The control reads "ignore at or above". Were it exclusive, a ceiling of
    // 100 would suppress nothing and the default would be inert.
    expect(readingAtOrAboveCeiling(loss(90), 90)).toBe(true);
    expect(readingAtOrAboveCeiling(loss(90), 89.9)).toBe(false);
  });

  it("suppresses the post-outage reading an operator sets it for", () => {
    // A device back from a 55-minute outage reads ~92% for the rest of a
    // 60-minute window now that the loss anchor is gone.
    expect(readingAtOrAboveCeiling(loss(90), 92)).toBe(true);
  });

  it("treats a non-numeric reading as unmeasurable, not saturated", () => {
    expect(readingAtOrAboveCeiling(loss(90), null)).toBe(false);
    expect(readingAtOrAboveCeiling(loss(90), Number.NaN)).toBe(false);
  });

  it("ignores a non-numeric ceiling rather than suppressing everything", () => {
    // A hand-written or corrupted rule must not silence the metric outright.
    expect(readingAtOrAboveCeiling({ ...loss(), ignoreAtOrAbove: "90" }, 95)).toBe(false);
    expect(readingAtOrAboveCeiling({ ...loss(), ignoreAtOrAbove: null }, 95)).toBe(false);
  });

  it("applies only to asset_metric triggers", () => {
    expect(readingAtOrAboveCeiling({ type: "asset_state", ignoreAtOrAbove: 50 }, 100)).toBe(false);
    expect(readingAtOrAboveCeiling({ type: "host_metric" }, 100)).toBe(false);
    expect(readingAtOrAboveCeiling(null, 100)).toBe(false);
  });

  it("allows a ceiling of 0 to mean suppress everything", () => {
    // Degenerate but well-defined: 0 is a real value, not "unset".
    expect(readingAtOrAboveCeiling(loss(0), 0)).toBe(true);
  });
});
