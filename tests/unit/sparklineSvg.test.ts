/**
 * tests/unit/sparklineSvg.test.ts
 *
 * The last-hour charts embedded in alert emails. Pure geometry, so the things
 * worth pinning are the ones that silently produce a misleading picture: a
 * percentage chart that rescales itself per message, a flat line collapsing
 * onto the axis, and an empty window rendering as a blank box the reader
 * mistakes for a blocked image.
 */

import { describe, it, expect } from "vitest";
import { sparklineSvg, seriesStats, formatReading, niceCeil, timeAxisLabel, type SparkPoint } from "../../src/utils/sparklineSvg.js";

const T0 = Date.parse("2026-08-12T10:00:00Z");
const series = (vals: number[]): SparkPoint[] => vals.map((v, i) => ({ t: T0 + i * 60_000, v }));

describe("formatReading", () => {
  it("drops a pointless decimal but keeps a meaningful one", () => {
    expect(formatReading(97)).toBe("97");
    expect(formatReading(97.04)).toBe("97");
    expect(formatReading(97.25, "%")).toBe("97.3%");
    expect(formatReading(12.5, " ms")).toBe("12.5 ms");
  });
});

describe("niceCeil", () => {
  it("rounds an auto-scaled axis top to a readable number", () => {
    // 183ms + 10% headroom = 200.1, which printed as "200.1 ms" on the axis —
    // a decimal that reads as precision the chart doesn't have.
    expect(niceCeil(200.1)).toBe(500);
    expect(niceCeil(183)).toBe(200);
    expect(niceCeil(42)).toBe(50);
    expect(niceCeil(7.3)).toBe(10);
    expect(niceCeil(1)).toBe(1);
  });

  it("leaves nothing to round alone", () => {
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(-5)).toBe(-5);
  });
});

describe("timeAxisLabel", () => {
  it("labels the window the chart was actually given, minutes up to 90 then hours", () => {
    // The left axis label was a hardcoded "-60 min" until the loss chart's
    // window started following the automation's History.
    expect(timeAxisLabel(60 * 60_000)).toBe("60 min");
    expect(timeAxisLabel(15 * 60_000)).toBe("15 min");
    expect(timeAxisLabel(89 * 60_000)).toBe("89 min");
    expect(timeAxisLabel(90 * 60_000)).toBe("1.5 h");
    expect(timeAxisLabel(120 * 60_000)).toBe("2 h");
    // A 24-hour History must not print "-1440 min".
    expect(timeAxisLabel(24 * 60 * 60_000)).toBe("24 h");
  });

  it("rides the rendered SVG's x-axis", () => {
    const hour = sparklineSvg(series([10, 50, 90]), { label: "CPU", unit: "%", from: T0, to: T0 + 60 * 60_000 });
    expect(hour).toContain(">-60 min<");
    const quarter = sparklineSvg(series([10, 50, 90]), { label: "Loss", unit: "%", from: T0, to: T0 + 15 * 60_000 });
    expect(quarter).toContain(">-15 min<");
  });
});

describe("seriesStats", () => {
  it("summarizes what the caption and the text fallback both quote", () => {
    expect(seriesStats(series([10, 30, 20]))).toEqual({ min: 10, max: 30, avg: 20, last: 20, count: 3 });
  });

  it("is null for an empty window, so callers can say so instead of drawing zero", () => {
    expect(seriesStats([])).toBeNull();
  });
});

describe("sparklineSvg", () => {
  it("renders a self-contained SVG with no external references", () => {
    const svg = sparklineSvg(series([10, 50, 90]), { label: "CPU", unit: "%", yMin: 0, yMax: 100 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    // Nothing to fetch: an email client would block it, and resvg has no
    // network access anyway.
    expect(svg).not.toMatch(/href=|url\(|<image/);
    expect(svg).toContain("<polyline");
  });

  it("says so when the window is empty rather than drawing an empty box", () => {
    const svg = sparklineSvg([], { label: "CPU" });
    expect(svg).toContain("no data in this window");
    expect(svg).not.toContain("<polyline");
  });

  it("pins a percentage axis to 0-100 so two messages are comparable", () => {
    // A quiet hour (2-4%) must not be rescaled into a dramatic climb.
    const quiet = sparklineSvg(series([2, 3, 4]), { label: "CPU", yMin: 0, yMax: 100 });
    const busy = sparklineSvg(series([80, 90, 95]), { label: "CPU", yMin: 0, yMax: 100 });
    // Same axis labels in both → same scale.
    expect(quiet).toContain(">100<");
    expect(busy).toContain(">100<");
    // The quiet series sits near the bottom of the plot in absolute coords.
    const quietY = Number(/points="[^"]*?,(\d+\.\d)/.exec(quiet)![1]);
    const busyY = Number(/points="[^"]*?,(\d+\.\d)/.exec(busy)![1]);
    expect(quietY).toBeGreaterThan(busyY);
  });

  it("gives an open-ended metric headroom instead of clipping its peak", () => {
    const svg = sparklineSvg(series([10, 400, 30]), { label: "Response", unit: " ms" });
    // The peak is inside the plot, not on the frame.
    const ys = Array.from(svg.matchAll(/(\d+\.\d),(\d+\.\d)/g)).map((m) => Number(m[2]));
    expect(Math.min(...ys)).toBeGreaterThan(20); // below the title band, not at y=0
  });

  it("keeps a flat line off the axis", () => {
    const svg = sparklineSvg(series([50, 50, 50]), { label: "CPU", unit: "%" });
    expect(svg).toContain("<polyline");
    // A zero span would divide by zero and stack every point at one y.
    expect(svg).not.toContain("NaN");
  });

  it("marks a single sample, which has no line to draw", () => {
    const svg = sparklineSvg(series([42]), { label: "CPU" });
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("NaN");
  });

  it("draws the automation's threshold as a dashed rule when it's in range", () => {
    const inRange = sparklineSvg(series([10, 90]), { label: "CPU", yMin: 0, yMax: 100, threshold: 80 });
    expect(inRange).toContain("stroke-dasharray");
    // Out of range it is omitted rather than clamped onto the frame, where it
    // would read as a threshold the device is sitting exactly at.
    const outOfRange = sparklineSvg(series([10, 20]), { label: "CPU", yMin: 0, yMax: 100, threshold: 400 });
    expect(outOfRange).not.toContain("stroke-dasharray");
  });

  it("spans the WINDOW on x, not just the samples that exist", () => {
    // One sample at the start of an hour must not stretch across the chart.
    const from = T0;
    const to = T0 + 3_600_000;
    const svg = sparklineSvg([{ t: T0 + 60_000, v: 5 }], { label: "CPU", from, to });
    const cx = Number(/<circle cx="([\d.]+)"/.exec(svg)![1]);
    expect(cx).toBeLessThan(100); // near the left edge of a 520-wide chart
  });

  it("escapes a label rather than letting it break the document", () => {
    const svg = sparklineSvg(series([1]), { label: 'CPU <script>&"' });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("quotes now / avg / peak in the caption", () => {
    const svg = sparklineSvg(series([10, 90, 50]), { label: "CPU", unit: "%" });
    expect(svg).toContain("now 50%");
    expect(svg).toContain("avg 50%");
    expect(svg).toContain("peak 90%");
  });
});
