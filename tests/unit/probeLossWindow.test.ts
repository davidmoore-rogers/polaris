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
import { lossBucketMs } from "../../src/services/alertChartService.js";

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
