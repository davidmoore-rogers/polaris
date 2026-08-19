/**
 * src/services/alertChartService.ts — the last-hour charts in an alert email.
 *
 * A packet-loss alert that says only "93.8%" tells you something is wrong; the
 * same alert with the last hour of CPU, memory and response time next to it
 * tells you whether the device is sick or the path to it is. This builds those
 * three charts for one alert, as inline PNGs.
 *
 * Two deliberate choices:
 *
 *  - Built at DELIVERY time, not fire time. The drain is a queue, off the
 *    engine's hot path, so a per-alert sample query costs the alerting loop
 *    nothing — and an escalation email at T+90min gets a chart of the last
 *    hour rather than a re-render of a frozen snapshot.
 *  - Rendered to PNG (via @resvg/resvg-js, already a dependency) and attached
 *    inline. SVG in email is unrenderable in Gmail and Outlook, and data: URIs
 *    are stripped by both.
 *
 * Everything here is best-effort: no samples, an unreadable asset, or a
 * rasterizer failure degrades to the text summary the plain-text body carries
 * anyway. An alert must never fail to send because a chart didn't draw.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { sparklineSvg, seriesStats, formatReading, type SparkPoint } from "../utils/sparklineSvg.js";
import { alarmStatusToFlag, convertSensorForDisplay, sensorDisplayUnit } from "../utils/hardwareSensors.js";
import { getBranding } from "./brandingService.js";
import type { InlineAttachment } from "./notificationChannels/emailChannel.js";

/**
 * Template token → what it draws. The token vocabulary lives in
 * notificationTemplate.
 *
 * `chart.trigger` is an ALIAS, not a fourth series: it renders whichever of the
 * others the automation actually fired on, so the graph an operator opened the
 * email for is the first one they see. A chart emitted through it is skipped
 * when its own token comes up later, so the body never repeats one.
 */
export const CHART_TOKENS = ["chart.trigger", "chart.sensor", "chart.probeLoss", "chart.cpu", "chart.memory", "chart.responseTime"] as const;
export type ChartToken = (typeof CHART_TOKENS)[number];

/** The metric an automation triggers on → the chart that explains it. */
export function chartTokenForMetric(metric: string | null | undefined): ChartToken | null {
  switch (metric) {
    case "hwSensorValue":
    case "hwSensorAlarm":
      return "chart.sensor";
    case "cpuPct":
      return "chart.cpu";
    case "memPct":
    case "memUsedBytes":
      return "chart.memory";
    case "responseTimeMs":
      return "chart.responseTime";
    case "probeLossPct":
      return "chart.probeLoss";
    // asset_state FIELDS land here too — Notification.metric records whatever
    // fired, and for a state alert that is the field. A device that stopped
    // answering is best explained by its probe history: the latency climbing,
    // then the gap where the answers stop.
    case "monitorStatus":
    case "consecutiveFailures":
      return "chart.responseTime";
    default:
      // Storage, interface counters, SD-WAN … have no chart of their own yet,
      // so the trigger token renders away and the generic charts below it
      // still tell the device's story.
      return null;
  }
}

/**
 * Metrics whose alert is about ONE PORT, not the device — and which therefore
 * get NO charts at all.
 *
 * A switch with a dead port is answering probes: that is how Polaris knows the
 * port is down. So its CPU, memory, response-time and packet-loss graphs are
 * all flat and healthy, and printing four of them under "Interface oper status
 * on port2 is down" says nothing about the fault while burying the facts that
 * do — the port's LLDP neighbour, which alertInterfaceService supplies in the
 * charts' place.
 *
 * Only the STATE trio is here, deliberately, not every interface-dimensioned
 * metric: a port that is DOWN is not a device condition, but a port erroring or
 * saturating plausibly correlates with the device's own load, so an
 * `ifInErrorRate` alert keeps its graphs.
 */
const PORT_SCOPED_METRICS: ReadonlySet<string> = new Set(["ifOperStatus", "ifAdminStatus", "poeStatus"]);

export function isPortScopedAlert(metric: string | null | undefined): boolean {
  return !!metric && PORT_SCOPED_METRICS.has(metric);
}

export const CHART_WINDOW_MS = 60 * 60 * 1000;

/** Cap the plotted points: an agent host reports per-minute, but a busy
 *  FortiGate can land far more, and 3000 polyline points is a big PNG for no
 *  extra information at 520px wide. */
const MAX_POINTS = 240;

export interface RenderedChart {
  token: ChartToken;
  /** cid: reference used from the HTML body. */
  cid: string;
  attachment: InlineAttachment | null;
  /** "CPU (last hour): now 62%, avg 40%, peak 97%" — the text-body fallback
   *  and the <img> alt text, so the numbers survive image blocking. */
  summary: string;
  /** False when the window held no samples at all. */
  hasData: boolean;
}

const META: Record<ChartToken, { label: string; unit: string; color: string; percent: boolean }> = {
  // Never rendered from these — the alias resolves to another token's chart.
  "chart.trigger": { label: "", unit: "", color: "#ea580c", percent: false },
  // The sensor chart's label and unit come from the sensor itself, so these are
  // only the fallbacks used when the alert isn't about one.
  "chart.sensor": { label: "Sensor", unit: "", color: "#ea580c", percent: false },
  "chart.cpu": { label: "CPU", unit: "%", color: "#2563eb", percent: true },
  "chart.memory": { label: "Memory", unit: "%", color: "#7c3aed", percent: true },
  "chart.responseTime": { label: "Response time", unit: " ms", color: "#0891b2", percent: false },
  "chart.probeLoss": { label: "Packet loss", unit: "%", color: "#dc2626", percent: true },
};

/** Even-ish downsample that always keeps the newest point (the alerting one). */
function thin(points: SparkPoint[]): SparkPoint[] {
  if (points.length <= MAX_POINTS) return points;
  const step = Math.ceil(points.length / MAX_POINTS);
  const out: SparkPoint[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]!);
  const last = points[points.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

async function loadTelemetry(assetId: string, since: Date): Promise<{ cpu: SparkPoint[]; mem: SparkPoint[] }> {
  const rows = await prisma.assetTelemetrySample.findMany({
    where: { assetId, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, cpuPct: true, memPct: true, memUsedBytes: true, memTotalBytes: true },
  });
  const cpu: SparkPoint[] = [];
  const mem: SparkPoint[] = [];
  for (const r of rows) {
    const t = r.timestamp.getTime();
    if (r.cpuPct != null) cpu.push({ t, v: r.cpuPct });
    // FortiOS reports a percentage; SNMP HOST-RESOURCES / WMI report bytes.
    // Same COALESCE the dashboard's memory widget uses.
    if (r.memPct != null) {
      mem.push({ t, v: r.memPct });
    } else if (r.memUsedBytes != null && r.memTotalBytes != null && Number(r.memTotalBytes) > 0) {
      mem.push({ t, v: (Number(r.memUsedBytes) / Number(r.memTotalBytes)) * 100 });
    }
  }
  return { cpu: thin(cpu), mem: thin(mem) };
}

export interface SensorSeries {
  points: SparkPoint[];
  /** Spans where the device's own alarm bit was set. */
  alarmSpans: Array<{ from: number; to: number }>;
  /** The unit to LABEL the axis with, after the display-unit swap. */
  unit: string;
  sensorClass: string | null;
}

/**
 * One hardware sensor's last hour, as the alert email charts it.
 *
 * The alert's `dimension` IS the sensor name — the engine keys both
 * hwSensorValue and hwSensorAlarm state rows on the bare `sensorName` — so it
 * drops straight into the query with no parsing.
 *
 * Values are converted for DISPLAY only (Celsius → Fahrenheit when the install
 * prefers it), gated on each reading's own stored unit, never on its class:
 * a fan's RPM and a rail's volts pass through untouched. Storage, rollups and
 * automation thresholds all stay Celsius.
 */
export async function loadSensorSeries(
  assetId: string,
  sensorName: string,
  since: Date,
  displayUnit: "c" | "f",
): Promise<SensorSeries> {
  const rows = await prisma.assetHardwareSensorSample.findMany({
    where: { assetId, sensorName, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, value: true, unit: true, alarmStatus: true, sensorClass: true },
  });

  const points: SparkPoint[] = [];
  const alarmSpans: Array<{ from: number; to: number }> = [];
  let storedUnit: string | null = null;
  let sensorClass: string | null = null;
  let openAlarm: { from: number; to: number } | null = null;

  for (const r of rows) {
    const t = r.timestamp.getTime();
    if (storedUnit === null && r.unit) storedUnit = r.unit;
    if (sensorClass === null && r.sensorClass) sensorClass = r.sensorClass;
    const v = convertSensorForDisplay(r.value, r.unit, displayUnit);
    if (v !== null) points.push({ t, v });

    // Merge consecutive alarming samples into one band rather than drawing a
    // sliver per sample.
    if (alarmStatusToFlag(r.alarmStatus) === 1) {
      if (openAlarm) openAlarm.to = t;
      else openAlarm = { from: t, to: t };
    } else if (openAlarm) {
      alarmSpans.push(openAlarm);
      openAlarm = null;
    }
  }
  if (openAlarm) alarmSpans.push(openAlarm);

  return {
    points: thin(points),
    alarmSpans,
    unit: sensorDisplayUnit(storedUnit, displayUnit),
    sensorClass,
  };
}

/**
 * One sensor reading as it should READ to an operator: the install's display
 * unit, and the value converted to match.
 *
 * The chart already does this, and the sentence above it has to agree — an
 * email that says "is 90.4 °C" over a chart drawn in °F is worse than either
 * on its own. Costs one branding read plus one indexed row, on the fire path
 * only (which is transition-guarded, so rare) and only for sensor metrics.
 */
export async function sensorReadingDisplay(
  assetId: string,
  sensorName: string,
  rawValue: number | string | boolean | null,
): Promise<{ value: number | string | boolean | null; unit: string }> {
  try {
    const [row, branding] = await Promise.all([
      prisma.assetHardwareSensorSample.findFirst({
        where: { assetId, sensorName },
        orderBy: { timestamp: "desc" },
        select: { unit: true },
      }),
      getBranding(),
    ]);
    const stored = row?.unit ?? null;
    const displayUnit = branding.temperatureUnit;
    const value = typeof rawValue === "number" ? convertSensorForDisplay(rawValue, stored, displayUnit) : rawValue;
    return { value, unit: sensorDisplayUnit(stored, displayUnit) };
  } catch {
    // Never block an alert on a unit lookup.
    return { value: rawValue, unit: "" };
  }
}

async function loadResponseTimes(assetId: string, since: Date): Promise<SparkPoint[]> {
  const rows = await prisma.assetMonitorSample.findMany({
    // Response-time poll only. The NULL responseTimeMs on ICMP loss-sampler
    // rows already excludes them here; the explicit probeKind filter is the
    // stated contract rather than a side effect of that.
    where: { assetId, timestamp: { gte: since }, success: true, responseTimeMs: { not: null }, OR: [{ probeKind: null }, { probeKind: "primary" }] },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, responseTimeMs: true },
  });
  // Failed probes are excluded deliberately: they have no response time, and
  // plotting them as 0 would draw a fast device instead of an unreachable one.
  return thin(rows.map((r) => ({ t: r.timestamp.getTime(), v: r.responseTimeMs! })));
}

/** Bucket width for the packet-loss series — 30 points across the hour. */
const LOSS_BUCKET_MS = 2 * 60 * 1000;

/**
 * Probe loss as a percentage over time: failed probes / total probes per
 * bucket, the same ratio the engine's `probeLossPct` metric and the dashboard
 * widget compute, just windowed for a chart instead of collapsed to one number.
 *
 * Bucketed in JS rather than SQL because an hour of one asset's probes is ~120
 * rows — a grouped query would cost more to write than it saves, and this
 * keeps the loader shaped like its neighbours. Empty buckets are skipped
 * rather than plotted as 0%: no probes is not the same as no loss.
 */
async function loadProbeLoss(assetId: string, since: Date): Promise<SparkPoint[]> {
  const rows = await prisma.assetMonitorSample.findMany({
    // EVERY probeKind, deliberately — this is a loss chart, and the ICMP
    // sampler exists to give it resolution through the warning/recovering
    // windows. One of only three all-kinds readers (with probeLossQuery's two
    // modes); everything else is response-time-poll only.
    where: { assetId, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, success: true },
  });
  const buckets = new Map<number, { total: number; failed: number }>();
  for (const r of rows) {
    const key = Math.floor(r.timestamp.getTime() / LOSS_BUCKET_MS) * LOSS_BUCKET_MS;
    const b = buckets.get(key) ?? { total: 0, failed: 0 };
    b.total++;
    if (!r.success) b.failed++;
    buckets.set(key, b);
  }
  return thin(
    Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([t, b]) => ({ t, v: Math.round((b.failed / b.total) * 1000) / 10 })),
  );
}

async function rasterize(svg: string): Promise<Buffer | null> {
  try {
    // Lazy import: resvg resolves a per-platform native binding, and an alert
    // must still send on a host where that binding is unavailable.
    const { Resvg } = await import("@resvg/resvg-js");
    return Buffer.from(new Resvg(svg).render().asPng());
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "alert chart rasterization failed — falling back to text");
    return null;
  }
}

function summaryLine(label: string, unit: string, points: SparkPoint[]): string {
  const s = seriesStats(points);
  if (!s) return `${label} (last hour): no data`;
  return `${label} (last hour): now ${formatReading(s.last, unit)}, avg ${formatReading(s.avg, unit)}, peak ${formatReading(s.max, unit)}`;
}

/**
 * Build the requested charts for one alert. `threshold` draws the automation's
 * own line on the chart of the metric it watches, when that metric is one of
 * these three.
 */
export async function buildAlertCharts(
  assetId: string,
  tokens: Iterable<ChartToken>,
  opts?: {
    now?: Date;
    thresholds?: Partial<Record<ChartToken, number | null>>;
    /**
     * The hardware sensor this alert is about — `Notification.dimension`, which
     * for hwSensorValue AND hwSensorAlarm automations is the bare sensor name.
     * Absent (a whole-device alert, an interface alert, an event rule) means
     * the sensor chart is skipped entirely: no query, and the token renders
     * away rather than drawing an empty box.
     */
    sensorName?: string | null;
    /**
     * The metric the automation fired on (`Notification.metric`). Resolves the
     * `chart.trigger` alias so the graph that explains THIS alert leads the
     * email — a response-time automation shows response time first.
     */
    metric?: string | null;
  },
): Promise<Map<ChartToken, RenderedChart>> {
  const wanted = new Set(tokens);
  // Resolve the alias up front: from here on it's an ordinary token request,
  // and the alias entry is filled in at the end from whatever it points at.
  const primary = chartTokenForMetric(opts?.metric);
  const aliasWanted = wanted.delete("chart.trigger");
  if (aliasWanted && primary) wanted.add(primary);
  const out = new Map<ChartToken, RenderedChart>();
  // An alert about one port draws nothing — see PORT_SCOPED_METRICS. Returning
  // the empty map (rather than filtering the token list) is what makes every
  // chart token render away and `pruneEmptyChartSection` drop the "Last hour"
  // heading with them, and it skips all four sample queries.
  if (isPortScopedAlert(opts?.metric)) return out;
  // A sensor chart with no sensor has nothing to draw. Dropping it here (rather
  // than rendering "no data") is what keeps the token invisible on the ~all
  // alerts that aren't about a hardware sensor.
  if (!opts?.sensorName) wanted.delete("chart.sensor");
  if (wanted.size === 0) return out;

  const now = opts?.now ?? new Date();
  const since = new Date(now.getTime() - CHART_WINDOW_MS);

  let cpu: SparkPoint[] = [];
  let mem: SparkPoint[] = [];
  let rt: SparkPoint[] = [];
  let loss: SparkPoint[] = [];
  let sensor: SensorSeries = { points: [], alarmSpans: [], unit: "", sensorClass: null };
  try {
    const needTelemetry = wanted.has("chart.cpu") || wanted.has("chart.memory");
    // The display unit is install-wide branding, not per-user: an alert email
    // has no session behind it. Read once, only when a sensor is charted.
    const displayUnit = wanted.has("chart.sensor")
      ? await getBranding().then((b) => b.temperatureUnit).catch(() => "c" as const)
      : ("c" as const);
    const [tel, rtRows, sensorRows, lossRows] = await Promise.all([
      needTelemetry ? loadTelemetry(assetId, since) : Promise.resolve({ cpu: [], mem: [] }),
      wanted.has("chart.responseTime") ? loadResponseTimes(assetId, since) : Promise.resolve([]),
      wanted.has("chart.sensor")
        ? loadSensorSeries(assetId, opts!.sensorName!, since, displayUnit)
        : Promise.resolve(sensor),
      wanted.has("chart.probeLoss") ? loadProbeLoss(assetId, since) : Promise.resolve([]),
    ]);
    cpu = tel.cpu;
    mem = tel.mem;
    rt = rtRows;
    sensor = sensorRows;
    loss = lossRows;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, assetId }, "alert chart sample load failed — sending without charts");
  }

  const series: Record<ChartToken, SparkPoint[]> = {
    // The alias never renders from here — it was resolved to a real token
    // above and is filled in from that token's result at the end.
    "chart.trigger": [],
    "chart.sensor": sensor.points,
    "chart.probeLoss": loss,
    "chart.cpu": cpu,
    "chart.memory": mem,
    "chart.responseTime": rt,
  };

  for (const token of wanted) {
    const meta = META[token];
    const points = series[token] ?? [];
    // The sensor chart labels itself from the sensor: its name (which is what
    // the operator picked in the automation) and the unit the device reported,
    // after the display-unit swap.
    const isSensor = token === "chart.sensor";
    const label = isSensor ? opts!.sensorName! : meta.label;
    const unit = isSensor ? (sensor.unit ? ` ${sensor.unit}` : "") : meta.unit;
    const svg = sparklineSvg(points, {
      label,
      unit,
      color: meta.color,
      ...(meta.percent ? { yMin: 0, yMax: 100 } : {}),
      threshold: opts?.thresholds?.[token] ?? null,
      ...(isSensor && sensor.alarmSpans.length ? { alarmSpans: sensor.alarmSpans } : {}),
      from: since.getTime(),
      to: now.getTime(),
    });
    const png = points.length > 0 ? await rasterize(svg) : null;
    const cid = `polaris-${token.replace(".", "-")}@polaris`;
    out.set(token, {
      token,
      cid,
      hasData: points.length > 0,
      summary: summaryLine(label, unit, points) +
        // An alarm-triggered alert charts the VALUE; the bit itself is what the
        // automation fired on, so the text has to carry it too — image blocking
        // is on by default in plenty of clients.
        (isSensor && sensor.alarmSpans.length ? " — the device raised its own alarm during this window" : ""),
      attachment: png
        ? { cid, filename: `${token.replace(".", "-")}.png`, contentType: "image/png", content: png }
        : null,
    });
  }
  // The alias points at the primary chart's rendering — same cid, so the body
  // references one attachment however many times it mentions the chart.
  if (aliasWanted && primary && out.has(primary)) {
    out.set("chart.trigger", { ...out.get(primary)!, token: "chart.trigger" });
  }
  return out;
}

/** Which chart tokens does this body actually reference? */
export function chartTokensIn(...templates: Array<string | null | undefined>): Set<ChartToken> {
  const found = new Set<ChartToken>();
  for (const t of templates) {
    if (!t) continue;
    for (const token of CHART_TOKENS) {
      if (t.includes(`{${token}}`)) found.add(token);
    }
  }
  return found;
}

/**
 * Replace `{chart.*}` with an inline <img> (HTML) or the summary line (text).
 * A chart with no data — or one whose PNG failed to render — degrades to the
 * same summary line in both, because a missing image reads to the recipient
 * as "my client blocked something", not "the device reported nothing".
 */
export function substituteChartTokens(
  body: string,
  charts: Map<ChartToken, RenderedChart>,
  opts: { html: boolean },
): string {
  let out = body;
  // Whatever the alias already drew must not be drawn again when its own token
  // comes up — the default body lists {chart.trigger} first AND every specific
  // chart after it, so without this a response-time alert would show the same
  // graph twice.
  const emittedCids = new Set<string>();
  for (const token of CHART_TOKENS) {
    const re = new RegExp(`\\{${token.replace(".", "\\.")}\\}`, "g");
    const chart = charts.get(token);
    if (chart && emittedCids.has(chart.cid)) {
      out = out.replace(re, "");
      continue;
    }
    // Nothing built for this token, or the metric produced no samples at all:
    // drop it. "Memory (last hour): no data" three times over is noise in an
    // alert about a firewall's temperature sensor — the device simply doesn't
    // report those, and the asset page is where you go to ask why.
    //
    // NOT the same case as a chart that HAS data but whose PNG failed to
    // rasterize: that one still prints its numbers below, because a missing
    // image reads to the recipient as "my client blocked something".
    if (!chart || !chart.hasData) {
      out = out.replace(re, "");
      continue;
    }
    emittedCids.add(chart.cid);
    if (!opts.html) {
      out = out.replace(re, chart.summary);
      continue;
    }
    const replacement = chart.attachment
      ? `<img src="cid:${chart.cid}" width="520" alt="${escapeAttr(chart.summary)}" ` +
        `style="display:block;width:100%;max-width:520px;height:auto;border:1px solid #e5e7eb;border-radius:6px;margin:10px 0">`
      : `<p style="margin:8px 0;color:#6b7280;font-size:13px">${escapeAttr(chart.summary)}</p>`;
    out = out.replace(re, replacement);
  }
  return out;
}

function escapeAttr(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The attachments the substituted HTML actually references. */
export function attachmentsFor(charts: Map<ChartToken, RenderedChart>, body: string): InlineAttachment[] {
  const out: InlineAttachment[] = [];
  for (const chart of charts.values()) {
    if (chart.attachment && body.includes(`cid:${chart.cid}`)) out.push(chart.attachment);
  }
  return out;
}
