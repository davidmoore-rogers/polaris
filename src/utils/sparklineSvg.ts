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
   * Epoch ms where the caption's number STARTS measuring, when that is later
   * than the plotted window's start. Drawn as a dashed vertical rule labelled
   * "measured".
   *
   * The packet-loss chart is the one caller: it plots the whole window but
   * captions the ANCHORED ratio the automation fired on (business rule 29b),
   * so without this the outage on the left of the picture reads as a
   * contradiction of the number on the right instead of what it is — the part
   * deliberately outside the measurement.
   */
  measuredFrom?: number | null;
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
   * Spans (epoch ms) where the device's polls FAILED. Rendered as the DIVE:
   * the line drops to the chart baseline in red across the span and climbs
   * back out, each transition fading between the series color and red, with a
   * red dot on every failure point. This is the one missed-poll treatment —
   * UI-GUIDE section 15 — shared with the in-app and phone charts, so an
   * outage looks the same in an alert email as it does on the device page.
   *
   * Deliberately NOT a red band. Bands mean "the gap is explained" (the in-app
   * charts shade maintenance windows purple), and a missed poll is the
   * opposite: the thing the operator is looking for. `alarmSpans` keeps its
   * band because a sensor's own alarm bit is a different claim about a reading
   * that is still arriving.
   *
   * A span still open at the last point rides to the right edge, because a
   * device that is down as the email sends is down up to "now".
   *
   * `kind` picks the colour, not the shape: "outage" dives RED (nobody knows
   * why the device stopped answering), "dependency" dives GREY (it was
   * dependency-suppressed — its parent was dark, so the miss is accounted for
   * and the device itself is not being accused of anything). Both still dive,
   * because in neither case was anything measured. Omitted = "outage", which
   * keeps every existing caller's behaviour.
   */
  failSpans?: Array<{ from: number; to: number; kind?: "outage" | "dependency" }>;
}

/** The missed-poll red. Shared with the in-app charts' _CHART_FAIL_COLOR so
 *  one outage is one color across email, desktop and phone. Distinct from the
 *  #dc2626 used for alarm bands and the threshold line, which are different
 *  claims. */
const FAIL_COLOR = "#d32f2f";

/** The dependency-down grey. Same dive, drained of alarm: the upstream is what
 *  broke, and this device is only reporting that it sits behind it. Shared with
 *  the in-app charts' _CHART_DEP_COLOR. */
const DEP_COLOR = "#9aa0a6";

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

  // Alarm bands sit BEHIND everything (drawn first) so the line stays readable
  // over them. Clamped to the plot, and a zero-width span still gets ~2px so a
  // single alarming sample is visible rather than invisible. Failed polls do
  // NOT get a band — see failSpans below.
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

  const baseY = PAD_T + plotH;

  // Failed polls plot AT the baseline with no value of their own, so an outage
  // reads as the line diving to zero (UI-GUIDE section 15) instead of bridging
  // the hole or hiding behind a shaded band. One marker at each end of a span
  // so the line drops and climbs back; a span narrower than that collapses to
  // a single point, which is what one missed poll is.
  //
  // A window the series has DATA inside is skipped whole. An agent pushes on
  // its own schedule and is not gated on monitorStatus, so an agent host can
  // keep reporting CPU straight through an outage of the server-side probe
  // transport; diving a line that has data would misreport what we hold. Same
  // rule, same half-median-cadence guard, as _outageMarkers in the browser.
  const sampleTimes = points.map((p) => p.t);
  const cadences: number[] = [];
  for (let i = 1; i < sampleTimes.length; i++) {
    const dt = sampleTimes[i]! - sampleTimes[i - 1]!;
    if (dt > 0) cadences.push(dt);
  }
  cadences.sort((a, b) => a - b);
  const guardMs = cadences.length >= 2 ? cadences[Math.floor(cadences.length / 2)]! / 2 : 0;
  // The whole window is skipped when the series has data anywhere in it
  // (padded by the guard), not merely at its edges: dropping only the end
  // markers would leave any interior samples in place and the line would dive,
  // climb back for each of them, and dive again.
  const hasData = (a: number, b: number) =>
    guardMs > 0 && sampleTimes.some((st) => st > a - guardMs && st < b + guardMs);

  const failTimes: Array<{ t: number; dep: boolean }> = [];
  for (const sp of failSpans) {
    const a = Math.max(sp.from, from);
    const b = Math.min(sp.to, to);
    if (hasData(a, b)) continue;
    const dep = sp.kind === "dependency";
    failTimes.push({ t: a, dep });
    if (b > a) failTimes.push({ t: b, dep });
  }

  type PlotPoint = { t: number; py: number; ok: boolean; dep?: boolean };
  const plot: PlotPoint[] = [
    ...points.map((p) => ({ t: p.t, py: y(p.v), ok: true })),
    ...failTimes.map((f) => ({ t: f.t, py: baseY, ok: false, dep: f.dep })),
  ].sort((a, b) => a.t - b.t);
  // One colour rule for every stroke, dot and gradient stop below, so a
  // dependency dive can never come out half grey and half red.
  const colorOf = (p: PlotPoint): string => (p.ok ? color : p.dep ? DEP_COLOR : FAIL_COLOR);

  const defs: string[] = [];
  // Gradients are local defs, not external references — resvg resolves them
  // in-document. Stops are in user space so the fade tracks the segment's own
  // geometry.
  const fadeSegment = (a: PlotPoint, b: PlotPoint): string => {
    const x1 = x(a.t), x2 = x(b.t);
    const id = `polaris-fade-${defs.length}`;
    defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1.toFixed(1)}" y1="${a.py.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${b.py.toFixed(1)}">` +
        `<stop offset="0" stop-color="${colorOf(a)}"/>` +
        `<stop offset="1" stop-color="${colorOf(b)}"/>` +
      `</linearGradient>`,
    );
    return `<line x1="${x1.toFixed(1)}" y1="${a.py.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${b.py.toFixed(1)}" stroke="url(#${id})" stroke-width="2" stroke-linecap="round"/>`;
  };

  // Runs of same-state points collapse into one polyline rather than a <line>
  // per segment the way the desktop chart emits them: a FortiGate can land
  // thousands of points in an hour, and per-segment elements would balloon the
  // PNG. Same divergence, same reason, as the phone port.
  // Grouped by COLOUR, not by ok-ness: a red outage that runs straight into a
  // grey dependency stretch (the parent went down part-way through) has to
  // break into two runs, or the whole thing takes the first run's stroke.
  const runs: PlotPoint[][] = [];
  for (const p of plot) {
    const cur = runs[runs.length - 1];
    if (cur && colorOf(cur[0]!) === colorOf(p)) cur.push(p);
    else runs.push([p]);
  }

  const lineParts: string[] = [];
  const areaParts: string[] = [];
  const dotParts: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const stroke = colorOf(run[0]!);
    const rp = run.map((p) => `${x(p.t).toFixed(1)},${p.py.toFixed(1)}`);
    if (run.length === 1) {
      // A lone point has no line to draw — mark it so it isn't invisible.
      // Failures get the bigger dot below either way.
      if (run[0]!.ok) dotParts.push(`<circle cx="${x(run[0]!.t).toFixed(1)}" cy="${run[0]!.py.toFixed(1)}" r="3" fill="${color}"/>`);
    } else {
      lineParts.push(
        `<polyline fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${rp.join(" ")}"/>`,
      );
      // Only the OK runs carry the area fill: a failure run sits ON the
      // baseline, so filling it would paint a zero-height sliver for nothing,
      // and filling ACROSS the outage is the interpolation we're avoiding.
      if (run[0]!.ok) {
        areaParts.push(
          `<polygon fill="${color}" fill-opacity="0.10" points="${x(run[0]!.t).toFixed(1)},${baseY} ${rp.join(" ")} ${x(run[run.length - 1]!.t).toFixed(1)},${baseY}"/>`,
        );
      }
    }
    // Each OK<->fail transition fades between the two colors instead of
    // jumping, so the dive reads as one line rather than two.
    if (i > 0) {
      const prev = runs[i - 1]!;
      lineParts.push(fadeSegment(prev[prev.length - 1]!, run[0]!));
    }
  }
  // Every failure also carries a dot — bigger than the 1.5px series dots on
  // the in-app chart, scaled here for the smaller plot — so a lone miss is
  // visible and not a hairline notch. Grey when the miss was explained.
  for (const p of plot) {
    if (!p.ok) dotParts.push(`<circle cx="${x(p.t).toFixed(1)}" cy="${p.py.toFixed(1)}" r="3" fill="${colorOf(p)}"/>`);
  }
  const defsBlock = defs.length ? `<defs>${defs.join("")}</defs>` : "";
  const line = lineParts.join("");
  const area = areaParts.join("");
  const dot = dotParts.join("");

  // The measurement's starting edge, when the caption covers less of the
  // window than the picture does. Drawn behind the line; the label flips to the
  // rule's left when the rule sits too close to the right edge to fit beside it.
  let measuredMark = "";
  if (opts.measuredFrom != null && opts.measuredFrom > from && opts.measuredFrom < to) {
    const mx = x(opts.measuredFrom);
    const nearRight = mx > width - PAD_R - 62;
    measuredMark =
      `<line x1="${mx.toFixed(1)}" y1="${PAD_T}" x2="${mx.toFixed(1)}" y2="${(PAD_T + plotH).toFixed(1)}" stroke="#6b7280" stroke-width="1" stroke-dasharray="3 3"/>` +
      `<text x="${(nearRight ? mx - 3 : mx + 3).toFixed(1)}" y="${PAD_T + 9}"${nearRight ? ' text-anchor="end"' : ""} ` +
      `font-family="Helvetica,Arial,sans-serif" font-size="9" fill="#6b7280">${nearRight ? "measured &#8594;" : "&#8594; measured"}</text>`;
  }

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

  return head + defsBlock + alarmBands + grid + measuredMark + area + line + dot + thresholdLine + axis + xLabels + caption + `</svg>`;
}
