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
import type { InlineAttachment } from "./notificationChannels/emailChannel.js";

/** Template token → what it draws. The token vocabulary lives in notificationTemplate. */
export const CHART_TOKENS = ["chart.cpu", "chart.memory", "chart.responseTime"] as const;
export type ChartToken = (typeof CHART_TOKENS)[number];

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
  "chart.cpu": { label: "CPU", unit: "%", color: "#2563eb", percent: true },
  "chart.memory": { label: "Memory", unit: "%", color: "#7c3aed", percent: true },
  "chart.responseTime": { label: "Response time", unit: " ms", color: "#0891b2", percent: false },
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

async function loadResponseTimes(assetId: string, since: Date): Promise<SparkPoint[]> {
  const rows = await prisma.assetMonitorSample.findMany({
    where: { assetId, timestamp: { gte: since }, success: true, responseTimeMs: { not: null } },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, responseTimeMs: true },
  });
  // Failed probes are excluded deliberately: they have no response time, and
  // plotting them as 0 would draw a fast device instead of an unreachable one.
  return thin(rows.map((r) => ({ t: r.timestamp.getTime(), v: r.responseTimeMs! })));
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
  opts?: { now?: Date; thresholds?: Partial<Record<ChartToken, number | null>> },
): Promise<Map<ChartToken, RenderedChart>> {
  const wanted = new Set(tokens);
  const out = new Map<ChartToken, RenderedChart>();
  if (wanted.size === 0) return out;

  const now = opts?.now ?? new Date();
  const since = new Date(now.getTime() - CHART_WINDOW_MS);

  let cpu: SparkPoint[] = [];
  let mem: SparkPoint[] = [];
  let rt: SparkPoint[] = [];
  try {
    const needTelemetry = wanted.has("chart.cpu") || wanted.has("chart.memory");
    const [tel, rtRows] = await Promise.all([
      needTelemetry ? loadTelemetry(assetId, since) : Promise.resolve({ cpu: [], mem: [] }),
      wanted.has("chart.responseTime") ? loadResponseTimes(assetId, since) : Promise.resolve([]),
    ]);
    cpu = tel.cpu;
    mem = tel.mem;
    rt = rtRows;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, assetId }, "alert chart sample load failed — sending without charts");
  }

  const series: Record<ChartToken, SparkPoint[]> = {
    "chart.cpu": cpu,
    "chart.memory": mem,
    "chart.responseTime": rt,
  };

  for (const token of wanted) {
    const meta = META[token];
    const points = series[token] ?? [];
    const svg = sparklineSvg(points, {
      label: meta.label,
      unit: meta.unit,
      color: meta.color,
      ...(meta.percent ? { yMin: 0, yMax: 100 } : {}),
      threshold: opts?.thresholds?.[token] ?? null,
      from: since.getTime(),
      to: now.getTime(),
    });
    const png = points.length > 0 ? await rasterize(svg) : null;
    const cid = `polaris-${token.replace(".", "-")}@polaris`;
    out.set(token, {
      token,
      cid,
      hasData: points.length > 0,
      summary: summaryLine(meta.label, meta.unit, points),
      attachment: png
        ? { cid, filename: `${token.replace(".", "-")}.png`, contentType: "image/png", content: png }
        : null,
    });
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
  for (const token of CHART_TOKENS) {
    const re = new RegExp(`\\{${token.replace(".", "\\.")}\\}`, "g");
    const chart = charts.get(token);
    if (!chart) {
      out = out.replace(re, "");
      continue;
    }
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
