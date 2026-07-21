/**
 * src/services/notificationEngine.ts
 *
 * The notification rule evaluator. Two paths, both driven by the
 * evaluateNotificationRules job:
 *
 *  1. Threshold / state path (asset_metric, asset_state, host_metric):
 *     batch-load in-scope assets + their latest sample readings, compare
 *     against the rule, and drive a per-(rule, asset, dimension) firing state
 *     machine (clear → pending → firing) with sustained-duration + debounce.
 *     Fires only on the clear→firing crossing; clears per the rule's
 *     clearBehavior (manual / auto / timed). Modeled on capacityWatch's
 *     transition guard — state writes happen only on transition, so the hot
 *     path is bounded by the number of *changes*, not the fleet size.
 *
 *  2. Event-tail path (event, change): consume new Event audit rows since a
 *     stored cursor and match them against event/change rules. Change rules
 *     are sugar over the change-Events the persist* functions emit.
 *
 * The engine WRITES notifications; notificationService is the read/lifecycle
 * side. previewRule() dry-runs a draft against current data with no writes
 * (the builder's Test button).
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { logEvent } from "./eventLogService.js";
import { REGION_TAG_PREFIX } from "./notificationService.js";
import {
  type Trigger,
  type RuleScope,
  type PreviewRuleInput,
  type DeliveryTarget,
  type EmailComposition,
  type EscalationConfig,
  type ResetConfig,
  type AutomationAction,
  CHANGE_TYPE_ACTIONS,
  actionsToTargets,
  normalizeRuleToV2,
} from "./notificationTypes.js";
import { expandDeliveries, scopeRegionTagsOf, type ComposedEmail } from "./notificationRecipientService.js";
import {
  buildTemplateContext,
  renderNotificationTemplate,
  templateNeedsAsset,
  notificationsPageUrl,
  type AssetTemplateDetail,
  type TemplateContextParts,
} from "../utils/notificationTemplate.js";

const LAST_EVENT_SETTING_KEY = "notificationEngine.lastEventCursor";
const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000; // window to find the "latest" sample

// ─── A rule as loaded from the DB (normalized to shape v2) ──────────────────
interface DbRule {
  id: string;
  name: string;
  description: string | null;
  severity: string;
  trigger: Trigger;
  scope: RuleScope;
  /** v2 reset semantics (legacy clearBehavior/clearAfterSec normalized in). */
  reset: ResetConfig;
  /** v2 unified action list (legacy targets normalized in). */
  actions: AutomationAction[];
  cooldownSec: number | null;
  messageTemplate: string | null;
  /** Legacy delivery view of `actions` (notify subset) — feeds expandDeliveries
   *  until the action-execution phase replaces the fan-out. */
  targets: DeliveryTarget[];
  emailComposition: EmailComposition | null;
  /** Stored (legacy) escalation shape — the sweep still consumes it directly. */
  escalation: EscalationConfig | null;
}

/** Best-effort outbound-delivery expansion — never breaks rule evaluation. */
async function expandDeliveriesSafe(notificationId: string, targets: DeliveryTarget[], scopeRegionTags?: string[], composedEmail?: ComposedEmail): Promise<void> {
  if (!targets || targets.length === 0) return;
  try {
    await expandDeliveries(notificationId, targets, scopeRegionTags, composedEmail);
  } catch (err) {
    await logEvent({
      action: "notification.delivery_expand_error",
      resourceType: "notification",
      resourceId: notificationId,
      actor: "system:notification-engine",
      level: "warning",
      message: "Failed to expand notification delivery targets",
      details: { err: (err as Error)?.message },
    }).catch(() => {});
  }
}

interface ScopeAssetRow {
  id: string;
  hostname: string | null;
  assetType: string | null;
  tags: string[];
  discoveredByIntegrationId: string | null;
  monitorStatus: string | null;
  status: string;
  consecutiveFailures: number;
  dependencySuppressed: boolean;
  quarantinedAt: Date | null;
}

/** A single evaluated reading for a (asset, dimension). */
interface Reading {
  assetId: string;
  hostname: string | null;
  tags: string[];
  dimKey: string;
  dimLabel: string;
  value: number | string | boolean | null;
}

// ─── Comparators ────────────────────────────────────────────────────────────

export function compareNum(value: number, op: string, threshold: number): boolean {
  switch (op) {
    case ">": return value > threshold;
    case ">=": return value >= threshold;
    case "<": return value < threshold;
    case "<=": return value <= threshold;
    case "==": return value === threshold;
    case "!=": return value !== threshold;
    default: return false;
  }
}

export function compareValue(value: number | string | boolean | null, op: string, target: number | string | boolean): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number" && typeof target === "number") return compareNum(value, op, target);
  // string / boolean: only equality comparisons are meaningful
  const a = String(value).toLowerCase();
  const b = String(target).toLowerCase();
  if (op === "==") return a === b;
  if (op === "!=") return a !== b;
  // allow numeric comparison if both coerce to numbers (e.g. consecutiveFailures)
  const na = Number(value);
  const nb = Number(target);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return compareNum(na, op, nb);
  return false;
}

// ─── Scope → assets ─────────────────────────────────────────────────────────

const SCOPE_SELECT = {
  id: true, hostname: true, assetType: true, tags: true, discoveredByIntegrationId: true,
  monitorStatus: true, status: true, consecutiveFailures: true, dependencySuppressed: true,
  quarantinedAt: true,
} as const;

/** Build a Prisma where from a scope, or null if the scope matches nothing. */
function scopeWhere(scope: RuleScope): Prisma.AssetWhereInput | null {
  if (scope.allAssets) return {};
  const and: Prisma.AssetWhereInput[] = [];
  if (scope.assetTypes?.length) and.push({ assetType: { in: scope.assetTypes } });
  if (scope.tags?.length) and.push({ tags: { hasSome: scope.tags } });
  if (scope.assetIds?.length) and.push({ id: { in: scope.assetIds } });
  if (scope.integrationIds?.length) and.push({ discoveredByIntegrationId: { in: scope.integrationIds } });
  if (and.length === 0) return null; // no dimensions + not allAssets ⇒ nothing
  return { AND: and };
}

async function loadScopeAssets(scope: RuleScope): Promise<ScopeAssetRow[]> {
  const where = scopeWhere(scope);
  if (!where) return [];
  return prisma.asset.findMany({ where, select: SCOPE_SELECT });
}

/**
 * Assets that must not trigger notifications right now:
 *  - status="maintenance" — inside a maintenance window (maintenanceScheduler);
 *    polling is paused so most readings would be stale anyway, and the window
 *    is announced downtime by definition.
 *  - dependencySuppressed — everything behind a down (or maintained) parent;
 *    silencing these keeps a switch's maintenance window from spraying "down"
 *    alerts for every device behind it.
 * Suppressed assets are dropped from rule evaluation; their `pending` state
 * rows reset to clear (a still-bad condition re-earns its full debounce after
 * the window) and `firing` rows are left frozen (no duplicate fire on exit —
 * recovery/timed clears still apply).
 */
export function isSuppressedForNotifications(a: { status: string; dependencySuppressed: boolean }): boolean {
  return String(a.status) === "maintenance" || a.dependencySuppressed === true;
}

function regionSnapshot(tags: string[]): string[] {
  return tags
    .filter((t) => t.toLowerCase().startsWith(REGION_TAG_PREFIX))
    .map((t) => t.slice(REGION_TAG_PREFIX.length))
    .filter(Boolean);
}

// ─── Reading resolvers ──────────────────────────────────────────────────────

function substringMatch(haystack: string | null, needle?: string): boolean {
  if (!needle) return true;
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

/** Reduce sample rows to the latest per dimension key, or aggregate over window. */
function reduceReadings(
  rows: Array<{ assetId: string; timestamp: Date }>,
  assetIndex: Map<string, ScopeAssetRow>,
  dimKeyFn: (row: any) => string,
  dimLabelFn: (row: any) => string,
  valueFn: (row: any) => number | null,
  aggregation: string,
): Reading[] {
  // group by assetId|dimKey
  const groups = new Map<string, { asset: ScopeAssetRow; dimKey: string; dimLabel: string; values: number[]; latest: { ts: number; v: number | null } }>();
  for (const row of rows) {
    const asset = assetIndex.get(row.assetId);
    if (!asset) continue;
    const dimKey = dimKeyFn(row);
    const key = `${row.assetId}|${dimKey}`;
    const v = valueFn(row);
    let g = groups.get(key);
    if (!g) {
      g = { asset, dimKey, dimLabel: dimLabelFn(row), values: [], latest: { ts: -1, v: null } };
      groups.set(key, g);
    }
    if (v !== null) g.values.push(v);
    const ts = row.timestamp.getTime();
    if (ts > g.latest.ts) g.latest = { ts, v };
  }
  const out: Reading[] = [];
  for (const g of groups.values()) {
    let value: number | null;
    if (aggregation === "avg") value = g.values.length ? g.values.reduce((a, b) => a + b, 0) / g.values.length : null;
    else if (aggregation === "min") value = g.values.length ? Math.min(...g.values) : null;
    else if (aggregation === "max") value = g.values.length ? Math.max(...g.values) : null;
    else value = g.latest.v; // latest
    out.push({ assetId: g.asset.id, hostname: g.asset.hostname, tags: g.asset.tags, dimKey: g.dimKey, dimLabel: g.dimLabel, value });
  }
  return out;
}

async function resolveAssetMetricReadings(trigger: Extract<Trigger, { type: "asset_metric" }>, assets: ScopeAssetRow[]): Promise<Reading[]> {
  const ids = assets.map((a) => a.id);
  if (ids.length === 0) return [];
  const index = new Map(assets.map((a) => [a.id, a]));
  const since = new Date(Date.now() - Math.max(trigger.windowSec * 1000, DEFAULT_LOOKBACK_MS));
  const df = trigger.dimensionFilter ?? {};
  const agg = trigger.aggregation;
  const num = (b: bigint | null | undefined): number | null => (b === null || b === undefined ? null : Number(b));

  switch (trigger.metric) {
    case "cpuPct": case "memPct": case "memUsedBytes": case "sessionCount": {
      const rows = await prisma.assetTelemetrySample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, cpuPct: true, memPct: true, memUsedBytes: true, sessionCount: true } });
      const pick = (r: any) => trigger.metric === "memUsedBytes" ? num(r.memUsedBytes) : (r[trigger.metric] ?? null);
      return reduceReadings(rows, index, () => "", () => "", pick, agg);
    }
    case "responseTimeMs": case "uptimeSec": {
      const rows = await prisma.assetMonitorSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, responseTimeMs: true, uptimeSec: true } });
      return reduceReadings(rows, index, () => "", () => "", (r) => r[trigger.metric] ?? null, agg);
    }
    case "hwSensorValue": {
      const rows = await prisma.assetHardwareSensorSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since }, ...(df.sensorClass ? { sensorClass: df.sensorClass } : {}) }, select: { assetId: true, timestamp: true, sensorName: true, sensorClass: true, value: true } });
      return reduceReadings(rows, index, (r) => r.sensorName, (r) => `${r.sensorName} (${r.sensorClass})`, (r) => r.value ?? null, agg);
    }
    case "storageUsedBytes": case "storageUsedPct": {
      const rows = await prisma.assetStorageSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, mountPath: true, usedBytes: true, totalBytes: true } });
      const filtered = rows.filter((r) => substringMatch(r.mountPath, df.mountPathPattern));
      const valueFn = (r: any) => {
        if (trigger.metric === "storageUsedBytes") return num(r.usedBytes);
        const used = num(r.usedBytes); const total = num(r.totalBytes);
        return used !== null && total ? (used / total) * 100 : null;
      };
      return reduceReadings(filtered, index, (r) => r.mountPath, (r) => r.mountPath, valueFn, agg);
    }
    case "sdwanLatencyMs": case "sdwanJitterMs": case "sdwanPacketLoss": {
      const col = trigger.metric === "sdwanLatencyMs" ? "latencyMs" : trigger.metric === "sdwanJitterMs" ? "jitterMs" : "packetLoss";
      const rows = await prisma.assetPerfSlaSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, healthCheck: true, link: true, latencyMs: true, jitterMs: true, packetLoss: true } });
      const filtered = rows.filter((r) => substringMatch(r.healthCheck, df.healthCheck) && substringMatch(r.link, df.link));
      return reduceReadings(filtered, index, (r) => `${r.healthCheck}|${r.link}`, (r) => `${r.healthCheck} / ${r.link}`, (r) => r[col] ?? null, agg);
    }
    case "customWidgetValue": {
      const rows = await prisma.assetCustomWidgetSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since }, kind: "scalar", ...(df.widgetId ? { widgetId: df.widgetId } : {}) }, select: { assetId: true, timestamp: true, widgetId: true, value: true } });
      return reduceReadings(rows, index, (r) => r.widgetId, (r) => r.widgetId, (r) => (typeof r.value === "number" ? r.value : Number(r.value)) || null, agg);
    }
    case "ifInBps": case "ifOutBps": case "ifInErrorRate": case "ifOutErrorRate": {
      const col = trigger.metric === "ifInBps" ? "inOctets" : trigger.metric === "ifOutBps" ? "outOctets" : trigger.metric === "ifInErrorRate" ? "inErrors" : "outErrors";
      const mult = trigger.metric === "ifInBps" || trigger.metric === "ifOutBps" ? 8 : 1; // octets→bits
      const rows = await prisma.assetInterfaceSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: { timestamp: "desc" }, select: { assetId: true, timestamp: true, ifName: true, inOctets: true, outOctets: true, inErrors: true, outErrors: true } });
      const filtered = rows.filter((r) => substringMatch(r.ifName, df.ifNamePattern));
      return rateReadings(filtered, index, (r) => r.ifName, (r) => r.ifName, (r) => num((r as any)[col]), mult);
    }
    case "ipsecThroughputBps": {
      const rows = await prisma.assetIpsecTunnelSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: { timestamp: "desc" }, select: { assetId: true, timestamp: true, tunnelName: true, incomingBytes: true, outgoingBytes: true } });
      const filtered = rows.filter((r) => substringMatch(r.tunnelName, df.tunnelName));
      return rateReadings(filtered, index, (r) => r.tunnelName, (r) => r.tunnelName, (r) => { const i = num(r.incomingBytes); const o = num(r.outgoingBytes); return i === null && o === null ? null : (i ?? 0) + (o ?? 0); }, 8);
    }
    default:
      return [];
  }
}

/** Compute a per-dimension rate (delta / dt) from the two latest counter samples. */
function rateReadings(
  rowsDesc: Array<{ assetId: string; timestamp: Date }>,
  assetIndex: Map<string, ScopeAssetRow>,
  dimKeyFn: (r: any) => string,
  dimLabelFn: (r: any) => string,
  counterFn: (r: any) => number | null,
  mult: number,
): Reading[] {
  const groups = new Map<string, any[]>();
  for (const row of rowsDesc) {
    const dimKey = dimKeyFn(row);
    const key = `${row.assetId}|${dimKey}`;
    const arr = groups.get(key) ?? [];
    if (arr.length < 2) { arr.push(row); groups.set(key, arr); }
  }
  const out: Reading[] = [];
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    const [newer, older] = arr; // desc order
    const asset = assetIndex.get(newer.assetId);
    if (!asset) continue;
    const cN = counterFn(newer); const cO = counterFn(older);
    const dt = (newer.timestamp.getTime() - older.timestamp.getTime()) / 1000;
    let value: number | null = null;
    if (cN !== null && cO !== null && dt > 0 && cN >= cO) value = ((cN - cO) * mult) / dt;
    out.push({ assetId: asset.id, hostname: asset.hostname, tags: asset.tags, dimKey: dimKeyFn(newer), dimLabel: dimLabelFn(newer), value });
  }
  return out;
}

async function resolveAssetStateReadings(trigger: Extract<Trigger, { type: "asset_state" }>, assets: ScopeAssetRow[]): Promise<Reading[]> {
  const index = new Map(assets.map((a) => [a.id, a]));
  const ids = assets.map((a) => a.id);
  const df = trigger.dimensionFilter ?? {};
  const mk = (a: ScopeAssetRow, dimKey: string, dimLabel: string, value: any): Reading => ({ assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey, dimLabel, value });

  switch (trigger.field) {
    case "monitorStatus": return assets.map((a) => mk(a, "", "", a.monitorStatus));
    case "status": return assets.map((a) => mk(a, "", "", a.status));
    case "consecutiveFailures": return assets.map((a) => mk(a, "", "", a.consecutiveFailures));
    case "dependencySuppressed": return assets.map((a) => mk(a, "", "", a.dependencySuppressed));
    case "quarantined": return assets.map((a) => mk(a, "", "", a.quarantinedAt !== null || a.status === "quarantined"));
    case "ifOperStatus": case "ifAdminStatus": {
      const col = trigger.field === "ifOperStatus" ? "operStatus" : "adminStatus";
      const since = new Date(Date.now() - DEFAULT_LOOKBACK_MS);
      const rows = await prisma.assetInterfaceSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: [{ assetId: "asc" }, { ifName: "asc" }, { timestamp: "desc" }], distinct: ["assetId", "ifName"], select: { assetId: true, ifName: true, operStatus: true, adminStatus: true } });
      return rows.filter((r) => substringMatch(r.ifName, df.ifNamePattern)).map((r) => { const a = index.get(r.assetId)!; return mk(a, r.ifName, r.ifName, (r as any)[col]); });
    }
    case "ipsecStatus": {
      const since = new Date(Date.now() - DEFAULT_LOOKBACK_MS);
      const rows = await prisma.assetIpsecTunnelSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: [{ assetId: "asc" }, { tunnelName: "asc" }, { timestamp: "desc" }], distinct: ["assetId", "tunnelName"], select: { assetId: true, tunnelName: true, status: true } });
      return rows.filter((r) => substringMatch(r.tunnelName, df.tunnelName)).map((r) => { const a = index.get(r.assetId)!; return mk(a, r.tunnelName, r.tunnelName, r.status); });
    }
    case "sdwanRuleStatus": case "sdwanSelectedMember": {
      const rows = await prisma.assetSdwanRule.findMany({ where: { assetId: { in: ids } }, select: { assetId: true, ruleName: true, status: true, selectedMember: true } });
      const col = trigger.field === "sdwanRuleStatus" ? "status" : "selectedMember";
      return rows.map((r) => { const a = index.get(r.assetId); if (!a) return null; return mk(a, r.ruleName, r.ruleName, (r as any)[col]); }).filter(Boolean) as Reading[];
    }
    default: return [];
  }
}

async function resolveHostMetricReading(trigger: Extract<Trigger, { type: "host_metric" }>): Promise<Reading | null> {
  const since = new Date(Date.now() - Math.max(trigger.windowSec * 1000, DEFAULT_LOOKBACK_MS));
  const rows = await prisma.hostMetricsSample.findMany({ where: { timestamp: { gte: since } }, orderBy: { timestamp: "desc" }, take: 2000 });
  if (rows.length === 0) return null;
  const num = (b: bigint) => Number(b);
  const valueOf = (r: any): number => {
    switch (trigger.metric) {
      case "cpuPct": return r.cpuPct;
      case "memUsedPct": return r.memUsedPct;
      case "memUsedBytes": return num(r.memUsedBytes);
      case "loadAvg1": return r.loadAvg1;
      case "loadAvg5": return r.loadAvg5;
      case "loadAvg15": return r.loadAvg15;
      case "procRssBytes": return num(r.procRssBytes);
      default: return NaN;
    }
  };
  let value: number;
  if (trigger.aggregation === "avg") value = rows.reduce((a, r) => a + valueOf(r), 0) / rows.length;
  else if (trigger.aggregation === "min") value = Math.min(...rows.map(valueOf));
  else if (trigger.aggregation === "max") value = Math.max(...rows.map(valueOf));
  else value = valueOf(rows[0]); // latest
  return { assetId: "", hostname: "Polaris host", tags: [], dimKey: "", dimLabel: "", value };
}

export function readingMeets(trigger: Trigger, value: number | string | boolean | null): boolean {
  if (value === null || value === undefined) return false;
  if (trigger.type === "asset_metric" || trigger.type === "host_metric") {
    return typeof value === "number" && compareNum(value, trigger.operator, trigger.threshold);
  }
  if (trigger.type === "asset_state") {
    return compareValue(value, trigger.operator, trigger.value);
  }
  return false;
}

/**
 * Has a FIRING condition recovered, honoring hysteresis? Without a
 * clearThreshold (or for non-numeric readings) recovery is simply !meets —
 * the legacy behavior. With one, recovery requires the value to cross the
 * CLEAR threshold: fire at `cpu >= 90` with clearThreshold 80 recovers only
 * below 80; between 80 and 90 is the dead band (neither meets nor recovered —
 * the alert stays firing so a value hovering at the line can't flap).
 * A null/absent reading counts as recovered (matches legacy: !meets).
 */
export function recoveredMeets(trigger: Trigger, reset: ResetConfig, value: number | string | boolean | null): boolean {
  const meets = readingMeets(trigger, value);
  if (reset.mode !== "auto" || reset.clearThreshold == null) return !meets;
  if ((trigger.type !== "asset_metric" && trigger.type !== "host_metric") || typeof value !== "number") return !meets;
  return !compareNum(value, trigger.operator, reset.clearThreshold);
}

// ─── Message + email templating ─────────────────────────────────────────────
// All interpolation goes through renderNotificationTemplate (single-brace
// {token} vocabulary from src/utils/notificationTemplate.ts) so the in-app
// messageTemplate, the email composition, and escalation overrides share one
// vocabulary. The built context is snapshotted onto Notification.templateCtx
// (when the rule has emailComposition/escalation) so escalation emails render
// later with fire-time values.

/** The reading-derived template parts (sans assetDetail/message, added by callers). */
function readingContextParts(rule: DbRule, reading: Reading, now: Date): TemplateContextParts {
  const trigger = rule.trigger;
  const metric = trigger.type === "asset_metric" || trigger.type === "host_metric" ? trigger.metric
    : trigger.type === "asset_state" ? trigger.field : trigger.type;
  const threshold = trigger.type === "asset_metric" || trigger.type === "host_metric" ? String(trigger.threshold)
    : trigger.type === "asset_state" ? String(trigger.value) : "";
  const valueStr = reading.value === null ? "n/a" : typeof reading.value === "number" ? round2(reading.value) : String(reading.value);
  return {
    asset: reading.hostname || reading.assetId || "host",
    metric: String(metric),
    value: valueStr,
    threshold,
    dimension: reading.dimLabel || "",
    severity: rule.severity,
    time: now,
    link: notificationsPageUrl(),
    ruleName: rule.name,
    ruleDescription: rule.description,
  };
}

/** Render the in-app message from a built context (default string when no template). */
function renderMessage(rule: DbRule, reading: Reading, ctx: Record<string, string>): string {
  if (rule.messageTemplate && rule.messageTemplate.trim()) {
    return renderNotificationTemplate(rule.messageTemplate, ctx);
  }
  const dim = reading.dimLabel ? ` [${reading.dimLabel}]` : "";
  return `${rule.name}: ${ctx["asset"]}${dim} — ${ctx["metric"]} = ${ctx["value"]} (threshold ${ctx["threshold"]})`;
}

function round2(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/** Does this rule need the fire-time template context (composition/escalation/asset tokens)? */
function ruleWantsContext(rule: DbRule): boolean {
  return !!(rule.emailComposition || rule.escalation);
}

function ruleWantsAssetDetail(rule: DbRule): boolean {
  const comp = rule.emailComposition;
  const tierTemplates = (rule.escalation?.tiers ?? []).flatMap((t) => [t.subjectTemplate, t.bodyTextTemplate, t.bodyHtmlTemplate]);
  return (
    ruleWantsContext(rule) ||
    templateNeedsAsset([rule.messageTemplate, comp?.subjectTemplate, comp?.bodyTextTemplate, comp?.bodyHtmlTemplate, ...tierTemplates])
  );
}

/**
 * Render the composed outbound email for a rule from a built context. Unset
 * pieces fall back to the pre-feature defaults (subject `[SEV] asset`, text =
 * message + View link). HTML body only when the operator provided one —
 * interpolated values are HTML-escaped there. cc/bcc pass through unresolved
 * (the recipient service resolves them at expansion time).
 * Exported for the escalation sweep + preview.
 */
export function buildComposedEmail(comp: EmailComposition, ctx: Record<string, string>): ComposedEmail {
  const link = ctx["link"] || "";
  const subject = comp.subjectTemplate && comp.subjectTemplate.trim()
    ? renderNotificationTemplate(comp.subjectTemplate, ctx)
    : `[${ctx["severity.upper"] || "NOTIFICATION"}] ${ctx["asset"] || "Polaris notification"}`;
  const text = comp.bodyTextTemplate && comp.bodyTextTemplate.trim()
    ? renderNotificationTemplate(comp.bodyTextTemplate, ctx)
    : (ctx["message"] || "") + (link ? `\n\nView: ${link}` : "");
  const html = comp.bodyHtmlTemplate && comp.bodyHtmlTemplate.trim()
    ? renderNotificationTemplate(comp.bodyHtmlTemplate, ctx, { html: true })
    : undefined;
  return { subject, text, html, cc: comp.cc ?? undefined, bcc: comp.bcc ?? undefined };
}

// ─── Threshold / state evaluation ───────────────────────────────────────────

async function evaluateThresholdRule(rule: DbRule): Promise<void> {
  const trigger = rule.trigger;
  let readings: Reading[] = [];
  // Assets silenced this tick (maintenance window / dependency-suppressed).
  const suppressedIds = new Set<string>();

  if (trigger.type === "host_metric") {
    const r = await resolveHostMetricReading(trigger);
    readings = r ? [r] : [];
  } else if (trigger.type === "asset_metric" || trigger.type === "asset_state") {
    const assets = await loadScopeAssets(rule.scope);
    const active: ScopeAssetRow[] = [];
    for (const a of assets) {
      if (isSuppressedForNotifications(a)) suppressedIds.add(a.id);
      else active.push(a);
    }
    readings = trigger.type === "asset_metric"
      ? await resolveAssetMetricReadings(trigger, active)
      : await resolveAssetStateReadings(trigger, active);
  } else {
    return;
  }

  // Existing firing/pending state for this rule.
  const states = await prisma.notificationRuleState.findMany({ where: { ruleId: rule.id } });
  const stateMap = new Map(states.map((s) => [`${s.assetId ?? ""}|${s.dimensionKey}`, s]));
  const now = new Date();
  const seen = new Set<string>();

  for (const reading of readings) {
    const key = `${reading.assetId || ""}|${reading.dimKey}`;
    seen.add(key);
    const meets = readingMeets(trigger, reading.value);
    const st = stateMap.get(key);
    const lastValue = typeof reading.value === "number" ? reading.value : null;

    if (meets) {
      if (!st || st.state === "clear") {
        if ((trigger as any).forDurationSec > 0) {
          // start the sustained-duration timer
          await upsertState(rule.id, reading, "pending", { conditionMetSince: now, lastValue });
        } else {
          await fire(rule, reading, lastValue, now);
        }
      } else if (st.state === "pending") {
        const since = st.conditionMetSince ?? now;
        if (now.getTime() - since.getTime() >= (trigger as any).forDurationSec * 1000) {
          await fire(rule, reading, lastValue, now);
        }
        // else keep pending
      } else if (st.state === "firing" && st.recoveredSince) {
        // Re-met mid-recovery: cancel the clear-sustain timer (transition-only
        // write — a steadily-firing condition costs nothing per tick).
        await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: null } });
      } // firing without a pending recovery → already active; suppress
    } else {
      // condition not met for this reading
      if (st && st.state === "pending") {
        await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null } });
      } else if (st && st.state === "firing") {
        if (rule.reset.mode !== "auto") {
          // manual re-arms the state; timed waits for its sweep — same as ever.
          await recover(rule, st);
        } else if (!recoveredMeets(trigger, rule.reset, reading.value)) {
          // Hysteresis dead band (below fire, above clear): stay firing.
          if (st.recoveredSince) {
            await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: null } });
          }
        } else {
          const sustainSec = rule.reset.sustainSec ?? 0;
          if (sustainSec <= 0) {
            await recover(rule, st);
          } else if (!st.recoveredSince) {
            // Recovery observed — start the clear-sustain timer.
            await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: now } });
          } else if (now.getTime() - st.recoveredSince.getTime() >= sustainSec * 1000) {
            await recover(rule, st);
          }
          // else: recovered but not sustained long enough yet — keep firing.
        }
      }
    }
  }

  // Suppressed assets produced no readings this tick. Reset their `pending`
  // rows (the debounce restarts from scratch after the window — a dropped
  // reading is not evidence either way) and leave `firing` rows frozen so
  // exiting maintenance can't double-fire an already-active notification.
  for (const st of states) {
    if (st.state === "pending" && st.assetId && suppressedIds.has(st.assetId)) {
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null },
      });
    }
  }

  // Timed auto-clear: firing states past their timer, even without an explicit
  // recovery reading (e.g. the asset stopped reporting).
  if (rule.reset.mode === "timed" && rule.reset.afterSec) {
    const afterSec = rule.reset.afterSec;
    for (const st of states) {
      if (st.state === "firing" && st.firedAt && now.getTime() - st.firedAt.getTime() >= afterSec * 1000) {
        await clearActiveNotification(st, "system:timed");
        await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null } });
      }
    }
  }
}

async function upsertState(
  ruleId: string,
  reading: Reading,
  state: string,
  extra: { conditionMetSince?: Date | null; firedAt?: Date | null; lastValue?: number | null; notificationId?: string | null },
) {
  await prisma.notificationRuleState.upsert({
    where: { ruleId_assetId_dimensionKey: { ruleId, assetId: reading.assetId, dimensionKey: reading.dimKey } },
    create: { ruleId, assetId: reading.assetId, dimensionKey: reading.dimKey, state, ...extra },
    update: { state, ...extra },
  });
}

async function fire(rule: DbRule, reading: Reading, lastValue: number | null, now: Date): Promise<void> {
  // Respect cooldown: if this (rule,asset,dim) fired within cooldownSec, skip.
  const existing = await prisma.notificationRuleState.findUnique({
    where: { ruleId_assetId_dimensionKey: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey } },
  });
  if (rule.cooldownSec && existing?.firedAt && now.getTime() - existing.firedAt.getTime() < rule.cooldownSec * 1000) {
    return;
  }
  // Fires are transition-guarded (rare), so the per-fire asset-detail lookup
  // is negligible even at 2000 assets — the hot evaluate path stays on the
  // tight SCOPE_SELECT.
  const detail = ruleWantsAssetDetail(rule) && reading.assetId ? await assetDetail(reading.assetId) : null;
  const ctx = buildTemplateContext({ ...readingContextParts(rule, reading, now), assetDetail: detail });
  const message = renderMessage(rule, reading, ctx);
  ctx["message"] = message;
  const notif = await prisma.notification.create({
    data: {
      ruleId: rule.id,
      assetId: reading.assetId || null,
      assetHostname: reading.hostname,
      severity: rule.severity,
      message,
      regionTags: regionSnapshot(reading.tags),
      ...(ruleWantsContext(rule) ? { templateCtx: ctx as any } : {}),
    },
  });
  await prisma.notificationRuleState.upsert({
    where: { ruleId_assetId_dimensionKey: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey } },
    create: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey, state: "firing", firedAt: now, lastValue, notificationId: notif.id },
    update: { state: "firing", firedAt: now, lastValue, notificationId: notif.id, conditionMetSince: null, recoveredSince: null },
  });
  const composed = rule.emailComposition ? buildComposedEmail(rule.emailComposition, ctx) : undefined;
  await expandDeliveriesSafe(notif.id, rule.targets, scopeRegionTagsOf(rule.scope), composed);
  await logEvent({
    action: "notification.triggered",
    resourceType: "notification",
    resourceId: notif.id,
    resourceName: rule.name,
    actor: "system:notification-engine",
    level: (rule.severity === "critical" || rule.severity === "serious") ? "error" : rule.severity === "warning" ? "warning" : "info",
    message: notif.message,
    details: { ruleId: rule.id, assetId: reading.assetId || null, dimension: reading.dimKey },
  });
}

async function recover(rule: DbRule, st: { id: string; notificationId: string | null }): Promise<void> {
  if (rule.reset.mode === "auto") {
    await clearActiveNotification(st, "system:auto-resolve");
    await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null } });
    await logEvent({
      action: "notification.auto_cleared",
      resourceType: "notification",
      resourceId: st.notificationId ?? undefined,
      resourceName: rule.name,
      actor: "system:notification-engine",
      message: `Auto-resolved: ${rule.name} condition recovered`,
      details: { ruleId: rule.id },
    });
  } else {
    // manual / timed: re-arm the state but leave the notification for a human
    // (timed is swept by the timer pass; manual stays until cleared).
    if (rule.reset.mode === "manual") {
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null } });
    }
  }
}

async function clearActiveNotification(st: { notificationId: string | null }, by: string): Promise<void> {
  if (!st.notificationId) return;
  await prisma.notification.updateMany({
    where: { id: st.notificationId, cleared: false },
    data: { cleared: true, clearedBy: by, clearedAt: new Date() },
  });
}

// ─── Event-tail evaluation ──────────────────────────────────────────────────

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

const LEVEL_RANK: Record<string, number> = { info: 0, warning: 1, error: 2 };

async function runEventTail(rules: DbRule[]): Promise<void> {
  const eventRules = rules.filter((r) => r.trigger.type === "event" || r.trigger.type === "change");
  if (eventRules.length === 0) return;

  const cursorRow = await prisma.setting.findUnique({ where: { key: LAST_EVENT_SETTING_KEY } });
  const cursorIso = (cursorRow?.value as any)?.lastTimestamp as string | undefined;
  const since = cursorIso ? new Date(cursorIso) : new Date(Date.now() - DEFAULT_LOOKBACK_MS);

  const events = await prisma.event.findMany({
    where: { timestamp: { gt: since } },
    orderBy: { timestamp: "asc" },
    take: 1000,
  });
  if (events.length === 0) return;

  // Precompile matchers. flatMap so non-event/change rules (shouldn't appear,
  // but the filter predicate isn't a type guard) are dropped and TS narrows.
  type CompiledMatcher = {
    rule: DbRule;
    re: RegExp;
    trigger: Extract<Trigger, { type: "event" }> | Extract<Trigger, { type: "change" }>;
  };
  const compiled: CompiledMatcher[] = eventRules.flatMap((r): CompiledMatcher[] => {
    if (r.trigger.type === "event") {
      return [{ rule: r, re: globToRegExp(r.trigger.actionPattern), trigger: r.trigger }];
    }
    if (r.trigger.type === "change") {
      const action = CHANGE_TYPE_ACTIONS[r.trigger.changeType];
      return [{ rule: r, re: globToRegExp(action), trigger: r.trigger }];
    }
    return [];
  });

  const toCreate: Prisma.NotificationCreateManyInput[] = [];
  // Notifications from rules with delivery targets get a client-generated id so
  // we can expand their deliveries after the batch insert (createMany returns
  // no ids). Rows without targets keep the DB default.
  const deliverAfter: { id: string; targets: DeliveryTarget[]; scopeRegionTags: string[]; composedEmail?: ComposedEmail }[] = [];
  for (const ev of events) {
    for (const c of compiled) {
      if (!c.re.test(ev.action)) continue;
      if (c.trigger.type === "event") {
        if (c.trigger.resourceType && ev.resourceType !== c.trigger.resourceType) continue;
        if (c.trigger.minLevel && (LEVEL_RANK[ev.level] ?? 0) < (LEVEL_RANK[c.trigger.minLevel] ?? 0)) continue;
        if (c.trigger.detailsMatch && !detailsMatch(ev.details, c.trigger.detailsMatch)) continue;
      }
      const assetId = ev.resourceType === "asset" ? ev.resourceId ?? null : null;
      const detail = assetId ? await assetDetail(assetId) : null;
      // Event/change rules honor the same silence as threshold rules: no
      // notifications for assets in a maintenance window or dependency-
      // suppressed behind one/an outage. (The event cursor still advances —
      // suppressed events are skipped, not deferred.)
      if (detail && isSuppressedForNotifications(detail)) continue;
      const tags = detail?.tags ?? [];
      // Event-path token mapping: {asset}=resourceName, {metric}=action,
      // {value}=event message; threshold/dimension are empty.
      const ctx = buildTemplateContext({
        asset: ev.resourceName ?? "",
        metric: ev.action,
        value: ev.message,
        threshold: "",
        dimension: "",
        severity: c.rule.severity,
        time: ev.timestamp,
        link: notificationsPageUrl(),
        ruleName: c.rule.name,
        ruleDescription: c.rule.description,
        assetDetail: detail,
      });
      const tmpl = c.rule.messageTemplate;
      const message = tmpl && tmpl.trim()
        ? renderNotificationTemplate(tmpl, ctx)
        : `${c.rule.name}: ${ev.message}`;
      ctx["message"] = message;
      const hasTargets = Array.isArray(c.rule.targets) && c.rule.targets.length > 0;
      const id = hasTargets ? randomUUID() : undefined;
      if (hasTargets && id) {
        deliverAfter.push({
          id,
          targets: c.rule.targets,
          scopeRegionTags: scopeRegionTagsOf(c.rule.scope),
          composedEmail: c.rule.emailComposition ? buildComposedEmail(c.rule.emailComposition, ctx) : undefined,
        });
      }
      toCreate.push({
        ...(id ? { id } : {}),
        ruleId: c.rule.id,
        assetId,
        assetHostname: ev.resourceName ?? null,
        severity: c.rule.severity,
        message,
        regionTags: regionSnapshot(tags),
        ...(ruleWantsContext(c.rule) ? { templateCtx: ctx } : {}),
      });
    }
  }

  if (toCreate.length > 0) {
    await prisma.notification.createMany({ data: toCreate });
  }
  for (const d of deliverAfter) {
    await expandDeliveriesSafe(d.id, d.targets, d.scopeRegionTags, d.composedEmail);
  }

  const newest = events[events.length - 1].timestamp.toISOString();
  await prisma.setting.upsert({
    where: { key: LAST_EVENT_SETTING_KEY },
    create: { key: LAST_EVENT_SETTING_KEY, value: { lastTimestamp: newest } },
    update: { value: { lastTimestamp: newest } },
  });
}

function detailsMatch(details: unknown, match: Record<string, string | number | boolean>): boolean {
  if (!details || typeof details !== "object") return false;
  const d = details as Record<string, unknown>;
  return Object.entries(match).every(([k, v]) => String(d[k]) === String(v));
}

// Per-tick asset-detail cache: fed by the per-fire lookups (composition /
// escalation / {asset.*} tokens) and the event-tail's tag reads, so a batch
// touching the same asset fetches once. Cleared each evaluate tick.
const ASSET_DETAIL_SELECT = {
  hostname: true, ipAddress: true, macAddress: true, assetType: true, status: true,
  location: true, learnedLocation: true, manufacturer: true, model: true,
  serialNumber: true, os: true, osVersion: true, department: true, assignedTo: true,
  tags: true, dependencySuppressed: true,
} as const;

type AssetDetailRow = AssetTemplateDetail & { hostname: string | null; status: string; tags: string[]; dependencySuppressed: boolean };

const _assetDetailCache = new Map<string, AssetDetailRow | null>();
export function clearAssetDetailCache(): void {
  _assetDetailCache.clear();
}
export async function assetDetail(assetId: string): Promise<AssetDetailRow | null> {
  if (_assetDetailCache.has(assetId)) return _assetDetailCache.get(assetId)!;
  const a = await prisma.asset.findUnique({ where: { id: assetId }, select: ASSET_DETAIL_SELECT });
  const row = a ? { ...a, status: String(a.status) } : null;
  _assetDetailCache.set(assetId, row);
  return row;
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function evaluateAllNotificationRules(): Promise<void> {
  const dbRules = await prisma.notificationRule.findMany({ where: { enabled: true } });
  const rules: DbRule[] = dbRules.map((r) => {
    // Shape-v2 normalization: legacy rows (clearBehavior/targets) and v2 rows
    // (reset/actions) evaluate identically through the v2 view.
    const v2 = normalizeRuleToV2(r);
    return {
      id: r.id, name: r.name, description: r.description, severity: r.severity,
      trigger: r.trigger as unknown as Trigger,
      scope: (r.scope ?? {}) as RuleScope,
      reset: v2.reset,
      actions: v2.actions,
      cooldownSec: r.cooldownSec,
      messageTemplate: r.messageTemplate,
      targets: actionsToTargets(v2.actions),
      emailComposition: (r.emailComposition ?? null) as EmailComposition | null,
      escalation: (r.escalation ?? null) as EscalationConfig | null,
    };
  });

  clearAssetDetailCache();

  for (const rule of rules) {
    try {
      if (rule.trigger.type === "asset_metric" || rule.trigger.type === "asset_state" || rule.trigger.type === "host_metric") {
        await evaluateThresholdRule(rule);
      }
    } catch (err) {
      await logEvent({ action: "notification.engine_error", actor: "system:notification-engine", level: "error", message: `Rule "${rule.name}" evaluation failed`, details: { ruleId: rule.id, err: (err as Error)?.message } }).catch(() => {});
    }
  }

  try {
    await runEventTail(rules);
  } catch (err) {
    await logEvent({ action: "notification.engine_error", actor: "system:notification-engine", level: "error", message: "Event-tail evaluation failed", details: { err: (err as Error)?.message } }).catch(() => {});
  }
}

// ─── Preview (builder Test button) ──────────────────────────────────────────

export interface PreviewMatch {
  assetId: string | null;
  hostname: string | null;
  dimension: string;
  value: number | string | boolean | null;
  meets: boolean;
  /** Hysteresis view (only when the draft has reset.mode=auto + clearThreshold):
   *  would a firing alert on this reading clear? A reading that neither meets
   *  nor clears sits in the dead band. */
  wouldClear?: boolean;
  inDeadBand?: boolean;
}

export interface PreviewResult {
  supported: boolean;
  note?: string;
  totalEvaluated: number;
  matches: PreviewMatch[];
  /** Rendered sample of the composed email (first match), when the draft has emailComposition. */
  emailPreview?: { subject: string; text: string; html?: string };
}

/** Dry-run a draft rule against current data with NO writes. A draft without
 *  a trigger is a SCOPE-ONLY preview: list the devices the scope matches
 *  (the wizard's asset-filtering step). */
export async function previewRule(input: PreviewRuleInput): Promise<PreviewResult> {
  const trigger = input.trigger;
  let readings: Reading[] = [];

  if (!trigger) {
    const assets = await loadScopeAssets(input.scope);
    return {
      supported: true,
      totalEvaluated: assets.length,
      matches: assets.slice(0, 200).map((a) => ({
        assetId: a.id,
        hostname: a.hostname,
        dimension: "",
        value: null,
        meets: true,
      })),
    };
  }

  if (trigger.type === "host_metric") {
    const r = await resolveHostMetricReading(trigger);
    readings = r ? [r] : [];
  } else if (trigger.type === "asset_metric") {
    const assets = await loadScopeAssets(input.scope);
    readings = await resolveAssetMetricReadings(trigger, assets);
  } else if (trigger.type === "asset_state") {
    const assets = await loadScopeAssets(input.scope);
    readings = await resolveAssetStateReadings(trigger, assets);
  } else {
    return { supported: false, note: "Event and change rules fire on new audit events; there's nothing to preview against current data.", totalEvaluated: 0, matches: [] };
  }

  const showHysteresis = input.reset.mode === "auto" && input.reset.clearThreshold != null;
  const matches: PreviewMatch[] = readings.map((r) => {
    const meets = readingMeets(trigger, r.value);
    if (!showHysteresis) {
      return { assetId: r.assetId || null, hostname: r.hostname, dimension: r.dimLabel, value: r.value, meets };
    }
    const wouldClear = recoveredMeets(trigger, input.reset, r.value);
    return {
      assetId: r.assetId || null,
      hostname: r.hostname,
      dimension: r.dimLabel,
      value: r.value,
      meets,
      wouldClear,
      inDeadBand: !meets && !wouldClear,
    };
  });
  matches.sort((a, b) => Number(b.meets) - Number(a.meets));

  // Rendered sample of the composed email against the best reading (first
  // matching, else first evaluated) — templates only, no recipient resolution.
  let emailPreview: PreviewResult["emailPreview"];
  if (input.emailComposition && readings.length > 0) {
    const draft: DbRule = {
      id: "", name: input.name, description: input.description ?? null, severity: input.severity,
      trigger, scope: input.scope,
      reset: input.reset, actions: input.actions, cooldownSec: input.cooldownSec ?? null,
      messageTemplate: input.messageTemplate ?? null, targets: [],
      emailComposition: input.emailComposition, escalation: input.escalation ?? null,
    };
    const sample = readings.find((r) => readingMeets(trigger, r.value)) ?? readings[0];
    // Direct fetch (not the per-tick cache — preview runs in the web process).
    const detail = sample.assetId
      ? await prisma.asset.findUnique({ where: { id: sample.assetId }, select: ASSET_DETAIL_SELECT })
      : null;
    const ctx = buildTemplateContext({
      ...readingContextParts(draft, sample, new Date()),
      assetDetail: detail ? { ...detail, status: String(detail.status) } : null,
    });
    ctx["message"] = renderMessage(draft, sample, ctx);
    const composed = buildComposedEmail(input.emailComposition, ctx);
    emailPreview = { subject: composed.subject, text: composed.text, html: composed.html };
  }

  return { supported: true, totalEvaluated: readings.length, matches: matches.slice(0, 200), emailPreview };
}
