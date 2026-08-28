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
    // No success at all: every row is kept (the widget's includeFullyDown
    // semantics) so an asset-down alert's loss chart reads 100 %, not blank.
    const allFailed = probeLossSeriesFrom(probes(30, Array.from({ length: 30 }, (_, i) => i)), 2 * 60_000);
    expect(allFailed.ratioPct).toBe(100);
    expect(allFailed.points.length).toBeGreaterThan(0);
  });

  it("anchors at the first successful probe, so a recovered device doesn't read its outage back as loss", () => {
    // 40 minutes dark, then 20 clean: the engine discards the pre-recovery
    // samples (business rule 29b), so the RATIO must too or its caption would
    // say 66.7 % about a device that is now answering every probe.
    const rows = probes(60, Array.from({ length: 40 }, (_, i) => i));
    const s = probeLossSeriesFrom(rows, 2 * 60_000);
    expect(s.ratioPct).toBe(0);
    // The LINE keeps the outage (2026-08-28): trimming it too sent an email
    // whose loss chart started when the device came back, so the thing the
    // operator was paged about was missing from the graph explaining it.
    expect(s.points.some((p) => p.t < min(40).getTime() && p.v === 100)).toBe(true);
    expect(s.points[0]!.t).toBe(min(0).getTime());
    // ...and the caption's narrower span is marked rather than left implicit.
    expect(s.measuredFromMs).toBe(min(40).getTime());
  });

  it("anchors at the recovery when the outage STARTED mid-window (the first-success anchor's blind spot)", () => {
    // 10 clean minutes, 30 dark, then 20 clean again. The window's first
    // success is minute 0 — BEFORE the outage — so the first-success anchor is
    // inert and the ratio would read 50 % about a device that has been
    // answering every probe for 20 minutes. `recoveryMs` (Asset.
    // recoveryStartedAt) is the success that ended the outage, at minute 40.
    const rows = probes(60, Array.from({ length: 30 }, (_, i) => 10 + i));
    expect(probeLossSeriesFrom(rows, 2 * 60_000).ratioPct).toBe(50);
    const s = probeLossSeriesFrom(rows, 2 * 60_000, min(40).getTime());
    expect(s.ratioPct).toBe(0);
    // The outage is still drawn — between the clean start and the clean tail,
    // which is exactly the shape the recipient needs to see — and the marker
    // says where the 0 % is measured from.
    expect(s.points.some((p) => p.t >= min(10).getTime() && p.t < min(40).getTime() && p.v === 100)).toBe(true);
    expect(s.measuredFromMs).toBe(min(40).getTime());
  });

  it("takes the LATER of the two anchors, and a stale recovery stamp is inert", () => {
    const rows = probes(60, Array.from({ length: 40 }, (_, i) => i));
    // Recovery stamp older than the window (a device that recovered long ago
    // and has been flapping since): every row already sits after it, so the
    // first-success anchor decides — 0 %, as without the stamp.
    expect(probeLossSeriesFrom(rows, 2 * 60_000, T0 - 3_600_000).ratioPct).toBe(0);
    // Stamp inside the window but before the first success (cannot happen in
    // practice — the stamp IS a success — but the max() must not widen the
    // window backwards if it ever did).
    expect(probeLossSeriesFrom(rows, 2 * 60_000, min(10).getTime()).ratioPct).toBe(0);
  });

  it("keeps every row when nothing answered, whatever the recovery stamp says", () => {
    // includeFullyDown semantics: an asset-down alert's chart must read 100 %,
    // and a stamp from an earlier recovery must not trim it to nothing.
    const rows = probes(30, Array.from({ length: 30 }, (_, i) => i));
    const s = probeLossSeriesFrom(rows, 2 * 60_000, min(20).getTime());
    expect(s.ratioPct).toBe(100);
    expect(s.points.length).toBeGreaterThan(0);
    // Nothing was excluded, so there is nothing to mark.
    expect(s.measuredFromMs).toBeNull();
  });

  it("marks nothing on an ordinary clean window — the caption covers the whole picture", () => {
    expect(probeLossSeriesFrom(probes(30, []), 2 * 60_000).measuredFromMs).toBeNull();
    // A recovery stamp older than the window trims no rows either.
    expect(probeLossSeriesFrom(probes(30, [5]), 2 * 60_000, T0 - 3_600_000).measuredFromMs).toBeNull();
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
    expect(probeLossSeriesFrom([], 2 * 60_000)).toEqual({ points: [], ratioPct: null, measuredFromMs: null });
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
