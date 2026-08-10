/**
 * tests/unit/mobileChartsFailureFade.test.ts — pins the missed-poll rendering
 * in the mobile SPA's chart helper (`public/js/mobile/charts.js`).
 *
 * The mobile charts used to filter valueless samples out and let the polyline
 * bridge straight over the hole, so an outage was invisible on a phone. Now a
 * failed poll sits at the baseline in red with a gradient transition segment,
 * matching the desktop response-time chart. Two feeds have to keep working:
 * explicit `ok:false` points (monitor stream) and inferred gaps (`gapFade`, for
 * the telemetry stream, which has no per-sample success flag).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

type Point = { ts: string | number; v: number | null; ok?: boolean };
type Series = { values: Point[]; color?: string; fill?: boolean; gapFade?: boolean };
type Prepared = { s: Series; pts: { ts: number; v: number | null; ok: boolean }[] };
type Charts = {
  lineChart: (opts: Record<string, unknown>) => string;
  _pollGapMarkers: (ts: number[]) => number[];
  _seriesPoints: (s: Series) => { ts: number; v: number | null; ok: boolean }[];
  _applySharedGapMarkers: (prepared: Prepared[]) => number[];
};

const FAIL = "#d32f2f";
let charts: Charts;

beforeAll(() => {
  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  const src = readFileSync(resolve(__dirname, "../../public/js/mobile/charts.js"), "utf8");
  (0, eval)(src);
  charts = (win as unknown as { PolarisCharts: Charts }).PolarisCharts;
});

/** Minute-cadence timestamps starting at a fixed epoch. */
function minutes(count: number, startMs = 1_800_000_000_000, stepMin = 1): number[] {
  return Array.from({ length: count }, (_, i) => startMs + i * stepMin * 60_000);
}

function okSeries(ts: number[], v = 10): Series {
  return { values: ts.map((t) => ({ ts: t, v })) };
}

describe("pollGapMarkers", () => {
  it("returns nothing for a steady cadence", () => {
    expect(charts._pollGapMarkers(minutes(10))).toEqual([]);
  });

  it("needs at least three samples to have a median cadence", () => {
    const [a, b] = minutes(2);
    expect(charts._pollGapMarkers([a, b + 3_600_000])).toEqual([]);
  });

  it("brackets a gap with a marker one cadence inside each edge", () => {
    const ts = minutes(5);
    // drop the middle: ...t2, then jump 30 minutes to t3
    const withGap = [ts[0], ts[1], ts[2], ts[2] + 30 * 60_000, ts[2] + 31 * 60_000];
    const markers = charts._pollGapMarkers(withGap);
    expect(markers).toEqual([ts[2] + 60_000, ts[2] + 29 * 60_000]);
  });

  it("keeps every marker strictly inside the hole it marks", () => {
    const ts = minutes(4);
    // 3× the median — the narrowest gap that clears the 2.5× threshold
    const withGap = [ts[0], ts[1], ts[2], ts[2] + 3 * 60_000];
    const markers = charts._pollGapMarkers(withGap);
    expect(markers.length).toBeGreaterThan(0);
    markers.forEach((m) => {
      expect(m).toBeGreaterThan(ts[2]);
      expect(m).toBeLessThan(ts[2] + 3 * 60_000);
    });
  });

  it("ignores a gap inside the 2.5× cadence tolerance", () => {
    const ts = minutes(4);
    expect(charts._pollGapMarkers([ts[0], ts[1], ts[2], ts[2] + 2 * 60_000])).toEqual([]);
  });
});

describe("seriesPoints", () => {
  it("keeps explicit failures as valueless baseline points", () => {
    const ts = minutes(3);
    const pts = charts._seriesPoints({
      values: [{ ts: ts[0], v: 5 }, { ts: ts[1], v: null, ok: false }, { ts: ts[2], v: 7 }],
    });
    expect(pts.map((p) => p.ok)).toEqual([true, false, true]);
    expect(pts[1].v).toBeNull();
  });

  it("drops valueless points that are not flagged as failures", () => {
    const ts = minutes(2);
    const pts = charts._seriesPoints({ values: [{ ts: ts[0], v: null }, { ts: ts[1], v: 3 }] });
    expect(pts).toHaveLength(1);
    expect(pts[0].v).toBe(3);
  });

  it("sorts out-of-order input and rejects unparseable timestamps", () => {
    const ts = minutes(3);
    const pts = charts._seriesPoints({
      values: [{ ts: ts[2], v: 3 }, { ts: "not-a-date", v: 9 }, { ts: ts[0], v: 1 }],
    });
    expect(pts.map((p) => p.ts)).toEqual([ts[0], ts[2]]);
  });

  it("does not infer gaps on its own — that is the shared pass's job", () => {
    const ts = minutes(3);
    const withGap = [ts[0], ts[1], ts[2], ts[2] + 30 * 60_000, ts[2] + 31 * 60_000];
    expect(charts._seriesPoints({ ...okSeries(withGap), gapFade: true }).every((p) => p.ok)).toBe(true);
  });
});

describe("applySharedGapMarkers", () => {
  const ts = minutes(3);
  const withGap = [ts[0], ts[1], ts[2], ts[2] + 30 * 60_000, ts[2] + 31 * 60_000];

  function prep(list: Series[]) {
    const prepared = list.map((s) => ({ s, pts: charts._seriesPoints(s) }));
    const marks = charts._applySharedGapMarkers(prepared);
    return { prepared, marks };
  }

  it("leaves unflagged series alone", () => {
    const { prepared, marks } = prep([okSeries(withGap)]);
    expect(marks).toEqual([]);
    expect(prepared[0].pts.every((p) => p.ok)).toBe(true);
  });

  it("injects the markers into a flagged series", () => {
    const { prepared, marks } = prep([{ ...okSeries(withGap), gapFade: true }]);
    expect(marks).toHaveLength(2);
    expect(prepared[0].pts.filter((p) => !p.ok)).toHaveLength(2);
    // still time-ordered after injection
    const order = prepared[0].pts.map((p) => p.ts);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("derives one marker set from the union, so both series dive at the same x", () => {
    // memory reports only the first three samples; CPU spans the gap
    const { prepared, marks } = prep([
      { ...okSeries(withGap), gapFade: true },
      { ...okSeries(withGap.slice(0, 3)), gapFade: true },
    ]);
    const cpuMarks = prepared[0].pts.filter((p) => !p.ok).map((p) => p.ts);
    const memMarks = prepared[1].pts.filter((p) => !p.ok).map((p) => p.ts);
    expect(cpuMarks).toEqual(marks);
    expect(memMarks).toEqual(marks);
  });

  it("a series absent from a stretch the other covers does not invent an outage", () => {
    // No real gap in the union — memory just stops reporting partway through.
    const full = minutes(8);
    const { marks } = prep([
      { ...okSeries(full), gapFade: true },
      { ...okSeries(full.slice(0, 4)), gapFade: true },
    ]);
    expect(marks).toEqual([]);
  });
});

describe("lineChart missed-poll rendering", () => {
  it("draws no red at all for a fully successful series", () => {
    const svg = charts.lineChart({ series: [okSeries(minutes(6))] });
    expect(svg).not.toContain(FAIL);
    expect(svg).not.toContain("linearGradient");
  });

  it("fades into and out of red across an explicit failure", () => {
    const ts = minutes(4);
    const svg = charts.lineChart({
      series: [{
        color: "var(--md-primary)",
        values: [
          { ts: ts[0], v: 10 }, { ts: ts[1], v: 12 },
          { ts: ts[2], v: null, ok: false },
          { ts: ts[3], v: 11 },
        ],
      }],
    });
    // one gradient per OK↔fail transition — in and back out
    expect(svg.match(/<linearGradient /g)).toHaveLength(2);
    // each gradient runs between the series color and the failure color
    expect(svg).toContain('stop-color="var(--md-primary)"');
    expect(svg).toContain('stop-color="' + FAIL + '"');
    // and the failure gets its own baseline dot
    expect(svg).toContain('stroke-width="4"');
  });

  it("collapses runs of same-state points instead of emitting per-sample lines", () => {
    const ts = minutes(12);
    const values: Point[] = ts.map((t, i) => (i >= 4 && i <= 6 ? { ts: t, v: null, ok: false } : { ts: t, v: 20 }));
    const svg = charts.lineChart({ series: [{ values }] });
    // two OK runs + one failure run = 3 polylines, 2 gradient transition lines
    expect(svg.match(/<polyline /g)).toHaveLength(3);
    expect(svg.match(/<linearGradient /g)).toHaveLength(2);
    expect(svg.match(/<line [^>]*stroke="url\(#/g)).toHaveLength(2);
  });

  it("puts failures on the plot baseline, below every real value", () => {
    const ts = minutes(3);
    const svg = charts.lineChart({
      series: [{ values: [{ ts: ts[0], v: 50 }, { ts: ts[1], v: null, ok: false }, { ts: ts[2], v: 50 }] }],
      yMin: 0, yMax: 100, height: 120,
    });
    // plot height = 120 - TOP_GUTTER(4) - BOTTOM_GUTTER(18) = 98; baseline = 98 - pad(2)
    expect(svg).toContain('stroke-width="4"');
    const dot = /<line x1="[\d.]+" y1="([\d.]+)"[^>]*stroke-width="4"/.exec(svg);
    expect(dot).not.toBeNull();
    expect(Number(dot![1])).toBeCloseTo(96, 1);
  });

  it("renders a red baseline instead of 'No data' when every poll failed", () => {
    const svg = charts.lineChart({
      series: [{ values: minutes(5).map((t) => ({ ts: t, v: null, ok: false })) }],
    });
    expect(svg).not.toContain("No data");
    expect(svg).toContain('stroke="' + FAIL + '"');
  });

  it("fades a gapFade series across an inferred hole, and leaves a plain one bridging", () => {
    const ts = minutes(3);
    const withGap = [ts[0], ts[1], ts[2], ts[2] + 30 * 60_000, ts[2] + 31 * 60_000];
    const faded = charts.lineChart({ series: [{ ...okSeries(withGap, 30), gapFade: true }], yMin: 0, yMax: 100 });
    expect(faded).toContain(FAIL);
    expect(faded.match(/<linearGradient /g)).toHaveLength(2);

    const plain = charts.lineChart({ series: [okSeries(withGap, 30)], yMin: 0, yMax: 100 });
    expect(plain).not.toContain(FAIL);
  });

  it("still shows the empty state when there are no points at all", () => {
    expect(charts.lineChart({ series: [{ values: [] }] })).toContain("No data");
  });

  it("gives each chart and series its own gradient ids", () => {
    const failing: Series = {
      values: [{ ts: minutes(3)[0], v: 5 }, { ts: minutes(3)[1], v: null, ok: false }, { ts: minutes(3)[2], v: 5 }],
    };
    const a = charts.lineChart({ series: [failing, { ...failing, color: "red" }] });
    const b = charts.lineChart({ series: [failing] });
    const ids = (s: string) => (s.match(/<linearGradient id="([^"]+)"/g) || []).map((m) => m);
    const all = [...ids(a), ...ids(b)];
    expect(new Set(all).size).toBe(all.length);
  });

  it("dips the filled area to the baseline over an outage", () => {
    const ts = minutes(3);
    const svg = charts.lineChart({
      series: [{
        fill: true,
        values: [{ ts: ts[0], v: 40 }, { ts: ts[1], v: null, ok: false }, { ts: ts[2], v: 40 }],
      }],
      yMin: 0, yMax: 100, height: 120,
    });
    const poly = /<polygon points="([^"]+)"/.exec(svg);
    expect(poly).not.toBeNull();
    // the middle vertex sits on the baseline, not interpolated between the peaks
    expect(poly![1].split(" ")[1]).toMatch(/,96\.0$/);
  });
});
