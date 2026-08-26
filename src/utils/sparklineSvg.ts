/**
 * src/utils/sparklineSvg.ts — the small time-series charts embedded in alert
 * emails (last-hour CPU, memory, response time).
 *
 * Pure: points in, SVG string out. The caller rasterizes with @resvg/resvg-js
 * (already a dependency, used by appIconService) and attaches the PNG inline,
 * because an SVG in an email body is not renderable anywhere that matters —
 * Gmail strips it, Outlook's Word engine never supported it.
 *
 * Everything is drawn with explicit geometry and no text measurement: resvg
 * ships no system fonts in this context, so labels are drawn at fixed
 * positions in a generic family and kept short enough that clipping is
 * impossible rather than merely unlikely.
 */

export interface SparkPoint {
  /** Epoch ms. */
  t: number;
  /** The reading. Nulls are omitted by the caller, not passed as gaps. */
  v: number;
}

export interface SparklineOptions {
  /** Chart title, drawn top-left (e.g. "CPU"). */
  label: string;
  /** Appended to every rendered number (e.g. "%", " ms"). */
  unit?: string;
  /** Line + fill colour. */
  color?: string;
  width?: number;
  height?: number;
  /**
   * Force the y-axis top. CPU/memory pass 100 so a quiet hour doesn't render
   * a 3% blip as a dramatic climb — the shape of a percentage chart has to be
   * comparable between messages. Response time leaves it off (no natural max).
   */
  yMax?: number;
  /** Force the y-axis floor. Percentages pass 0 for the same reason. */
  yMin?: number;
  /** Drawn as a dashed horizontal rule — the automation's threshold. */
  threshold?: number | null;
  /** Window start/end in epoch ms, so the x-axis is the WINDOW, not the data. */
  from?: number;
  to?: number;
  /**
   * Replace the caption's "avg" with a pre-computed one.
   *
   * For the packet-loss chart the plotted points are per-bucket RATIOS, and the
   * mean of ratios is not the ratio over the window: a short burst of total
   * loss among many quiet buckets averages far below the fraction of probes
   * that actually failed — and that fraction is what the automation compared to
   * its threshold, so an alert would state one number over a chart captioned
   * another (prod 2026-08-20: "18.3 %" over "avg 6.7 %"). Charts whose points
   * are already the quantity itself (CPU, memory, latency) leave this unset.
   */
  avgOverride?: number | null;
  /**
   * Spans (epoch ms) to shade red behind the plot — where a hardware sensor's
   * own alarm bit was set. An alarm-triggered alert charts the sensor's VALUE,
   * and this is what ties the two together: it shows whether the device raised
   * its alarm because the reading moved, or while the reading sat still (a
   * failed fan reads 0 RPM either way, but a PSU can alarm at a value that
   * never changes).
   */
  alarmSpans?: Array<{ from: number; to: number }>;
  /**
   * Spans (epoch ms) where the device's polls FAILED. Shaded red like
   * alarmSpans, and — the part that matters — the line is BROKEN across each
   * span: the segment bridging a failure fades out and back in instead of
   * interpolating a healthy-looking straight line through the exact period
   * nothing answered. A span still open at the last point fades the line out
   * to the right rather than just stopping it.
   */
  failSpans?: Array<{ from: number; to: number }>;
}

const W = 520;
const H = 120;
const PAD_L = 40;
const PAD_R = 12;
const PAD_T = 22;
const PAD_B = 18;

const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * Round up to the next 1 / 2 / 5 × 10ⁿ, so an auto-scaled axis is labelled
 * "200 ms" rather than "200.1 ms" — the extra digit reads as precision the
 * chart doesn't have.
 */
export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return v;
  const mag = 10 ** Math.floor(Math.log10(v));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/**
 * The x-axis window as an operator reads it: "60 min" up to 90 minutes, then
 * hours ("2 h", "1.5 h") so a 24-hour loss History doesn't print "-1440 min".
 * The left axis label was a hardcoded "-60 min" until the loss chart's window
 * started following the automation's History (2026-08); every chart now labels
 * whatever span it was actually given.
 */
export function timeAxisLabel(spanMs: number): string {
  const mins = Math.round(spanMs / 60_000);
  if (mins < 90) return `${mins} min`;
  const hours = Math.round((mins / 60) * 10) / 10;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)} h`;
}

/** Trim to 1 decimal, then drop a trailing ".0" — "97" reads better than "97.0". */
export function formatReading(v: number, unit = ""): string {
  const rounded = Math.round(v * 10) / 10;
  const s = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${s}${unit}`;
}

export interface SeriesStats {
  min: number;
  max: number;
  avg: number;
  last: number;
  count: number;
}

/** Summary numbers for the chart caption AND the plain-text email fallback. */
export function seriesStats(points: SparkPoint[]): SeriesStats | null {
  if (points.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
    sum += p.v;
  }
  return { min, max, avg: sum / points.length, last: points[points.length - 1]!.v, count: points.length };
}

/**
 * One line chart, ~520×120, self-contained (no external fonts, no CSS).
 * Returns a placeholder card when there is nothing to plot — an email that
 * says "no data in the last hour" is more useful than a missing image the
 * reader assumes their client blocked.
 */
export function sparklineSvg(points: SparkPoint[], opts: SparklineOptions): string {
  const width = opts.width ?? W;
  const height = opts.height ?? H;
  const color = opts.color ?? "#2563eb";
  const unit = opts.unit ?? "";
  const plotW = width - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;

  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>` +
    `<text x="4" y="14" font-family="Helvetica,Arial,sans-serif" font-size="12" font-weight="bold" fill="#1f2430">${esc(opts.label)}</text>`;

  const stats = seriesStats(points);
  if (!stats) {
    return (
      head +
      `<text x="${width / 2}" y="${height / 2 + 4}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#9ca3af">no data in this window</text>` +
      `</svg>`
    );
  }

  // Axis range. Percentages pin 0–100 so two messages are comparable; an
  // open-ended metric gets 10% headroom, and a flat line still gets a band so
  // it renders as a line rather than sitting on the axis.
  let yMin = opts.yMin ?? Math.min(stats.min, opts.threshold ?? Infinity);
  let yMax = opts.yMax ?? Math.max(stats.max, opts.threshold ?? -Infinity);
  if (opts.yMin === undefined && opts.yMax === undefined) {
    const span = yMax - yMin;
    if (span <= 0) {
      yMin = Math.max(0, yMin - 1);
      yMax = yMax + 1;
    } else {
      yMin = Math.max(0, yMin - span * 0.1);
      // Round the top to a readable number. Without this the 10% headroom
      // prints axis labels like "200.1 ms", which reads as precision that
      // isn't there.
      yMax = niceCeil(yMax + span * 0.1);
    }
  }
  const ySpan = yMax - yMin || 1;

  const from = opts.from ?? points[0]!.t;
  const to = opts.to ?? points[points.length - 1]!.t;
  const tSpan = to - from || 1;

  const x = (t: number) => PAD_L + ((t - from) / tSpan) * plotW;
  const y = (v: number) => PAD_T + plotH - ((v - yMin) / ySpan) * plotH;

  // Gridlines + y labels at the range ends and the midpoint.
  const gridVals = [yMax, (yMax + yMin) / 2, yMin];
  const grid = gridVals
    .map((v) => {
      const gy = y(v).toFixed(1);
      return (
        `<line x1="${PAD_L}" y1="${gy}" x2="${width - PAD_R}" y2="${gy}" stroke="#e5e7eb" stroke-width="1"/>` +
        `<text x="${PAD_L - 4}" y="${(Number(gy) + 3).toFixed(1)}" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="9" fill="#9ca3af">${esc(formatReading(v))}</text>`
      );
    })
    .join("");

  // Red bands sit BEHIND everything (drawn first) so the line stays readable
  // over them. Clamped to the plot, and a zero-width span still gets ~2px so a
  // single alarming/failed sample is visible rather than invisible.
  const bandRects = (spans: Array<{ from: number; to: number }>, opacity: string): string =>
    spans
      .map((s) => {
        const x1 = Math.max(PAD_L, Math.min(x(s.from), PAD_L + plotW));
        const x2 = Math.max(PAD_L, Math.min(x(s.to), PAD_L + plotW));
        const w = Math.max(2, x2 - x1);
        return `<rect x="${x1.toFixed(1)}" y="${PAD_T}" width="${w.toFixed(1)}" height="${plotH}" fill="#dc2626" fill-opacity="${opacity}"/>`;
      })
      .join("");
  const failSpans = (opts.failSpans ?? []).filter((s) => s.to > from && s.from < to).sort((a, b) => a.from - b.from);
  const alarmBands = bandRects(opts.alarmSpans ?? [], "0.13");
  const failBands = bandRects(failSpans, "0.10");

  // Failure spans break the line into runs: interpolating straight across an
  // outage draws a healthy-looking reading through the exact period nothing
  // answered. Each gap is bridged by a gradient stroke that fades out and back
  // in instead.
  const gapBetween = (a: SparkPoint, b: SparkPoint) => failSpans.some((s) => s.to > a.t && s.from < b.t);
  const runs: SparkPoint[][] = [];
  for (const p of points) {
    const cur = runs[runs.length - 1];
    if (cur && !gapBetween(cur[cur.length - 1]!, p)) cur.push(p);
    else runs.push([p]);
  }

  const baseY = `${PAD_T + plotH}`;
  const defs: string[] = [];
  // Gradients are local defs, not external references — resvg resolves them
  // in-document. Stops are in user space so the fade tracks the gap's own x.
  const fadeLine = (x1: number, y1: number, x2: number, y2: number, kind: "bridge" | "out" | "in"): string => {
    if (x2 - x1 < 1) return "";
    const id = `polaris-fade-${defs.length}`;
    const stops =
      kind === "bridge"
        ? `<stop offset="0" stop-color="${color}" stop-opacity="0.9"/><stop offset="0.5" stop-color="${color}" stop-opacity="0.05"/><stop offset="1" stop-color="${color}" stop-opacity="0.9"/>`
        : kind === "out"
          ? `<stop offset="0" stop-color="${color}" stop-opacity="0.9"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>`
          : `<stop offset="0" stop-color="${color}" stop-opacity="0"/><stop offset="1" stop-color="${color}" stop-opacity="0.9"/>`;
    defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}">${stops}</linearGradient>`,
    );
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="url(#${id})" stroke-width="2" stroke-linecap="round"/>`;
  };

  const lineParts: string[] = [];
  const areaParts: string[] = [];
  const dotParts: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const rp = run.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
    if (run.length === 1) {
      // A single sample has no line to draw — mark it so it isn't invisible.
      dotParts.push(`<circle cx="${x(run[0]!.t).toFixed(1)}" cy="${y(run[0]!.v).toFixed(1)}" r="3" fill="${color}"/>`);
    } else {
      lineParts.push(
        `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${rp.join(" ")}"/>`,
      );
      // The fill closes vertically at the run's own extent, so an outage gap
      // isn't filled and a series that ends mid-window doesn't ramp to the
      // corner.
      areaParts.push(
        `<polygon fill="${color}" fill-opacity="0.10" points="${x(run[0]!.t).toFixed(1)},${baseY} ${rp.join(" ")} ${x(run[run.length - 1]!.t).toFixed(1)},${baseY}"/>`,
      );
    }
    if (i > 0) {
      const prev = runs[i - 1]!;
      const a = prev[prev.length - 1]!;
      const b = run[0]!;
      lineParts.push(fadeLine(x(a.t), y(a.v), x(b.t), y(b.v), "bridge"));
    }
  }
  // A failure open past the last point (still down as the email sends) fades
  // the line out to the right; one open before the first point fades it in.
  if (runs.length > 0) {
    const first = runs[0]![0]!;
    const lastRun = runs[runs.length - 1]!;
    const last = lastRun[lastRun.length - 1]!;
    const leadFroms = failSpans.filter((s) => s.from < first.t).map((s) => Math.max(s.from, from));
    if (leadFroms.length) lineParts.push(fadeLine(x(Math.min(...leadFroms)), y(first.v), x(first.t), y(first.v), "in"));
    const trailTos = failSpans.filter((s) => s.to > last.t).map((s) => Math.min(s.to, to));
    if (trailTos.length) lineParts.push(fadeLine(x(last.t), y(last.v), x(Math.max(...trailTos)), y(last.v), "out"));
  }
  const defsBlock = defs.length ? `<defs>${defs.join("")}</defs>` : "";
  const line = lineParts.join("");
  const area = areaParts.join("");
  const dot = dotParts.join("");

  const thresholdLine =
    opts.threshold != null && opts.threshold >= yMin && opts.threshold <= yMax
      ? `<line x1="${PAD_L}" y1="${y(opts.threshold).toFixed(1)}" x2="${width - PAD_R}" y2="${y(opts.threshold).toFixed(1)}" stroke="#dc2626" stroke-width="1" stroke-dasharray="4 3"/>`
      : "";

  const captionAvg = opts.avgOverride ?? stats.avg;
  const caption =
    `<text x="${width - PAD_R}" y="14" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="11" fill="#4b5563">` +
    `now ${esc(formatReading(stats.last, unit))} · avg ${esc(formatReading(captionAvg, unit))} · peak ${esc(formatReading(stats.max, unit))}</text>`;

  const axis = `<line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${width - PAD_R}" y2="${PAD_T + plotH}" stroke="#d1d5db" stroke-width="1"/>`;
  const xLabels =
    `<text x="${PAD_L}" y="${height - 5}" font-family="Helvetica,Arial,sans-serif" font-size="9" fill="#9ca3af">-${esc(timeAxisLabel(tSpan))}</text>` +
    `<text x="${width - PAD_R}" y="${height - 5}" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="9" fill="#9ca3af">now</text>`;

  return head + defsBlock + alarmBands + failBands + grid + area + line + dot + thresholdLine + axis + xLabels + caption + `</svg>`;
}
