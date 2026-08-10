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
import { Prisma } from "../generated/prisma/client.js";
import { logEvent } from "./eventLogService.js";
import { REGION_TAG_PREFIX } from "./notificationService.js";
import {
  type Trigger,
  type RuleScope,
  type PreviewRuleInput,
  type EmailComposition,
  type EscalationV2Config,
  type ResetConfig,
  type AutomationAction,
  type EscalatableAction,
  ruleHasAnyEscalation,
  allRuleActionRefs,
  type CompositeTrigger,
  type CompositeLeaf,
  type TriggerConditionGroup,
  type SeverityBand,
  type BandNotify,
  type Severity,
  severityForValue,
  severityRank,
  type ResolvedTier,
  resolveTierLadder,
  updateTierMetSince,
  sustainedSeverity,
  tierMetSinceChanged,
  CHANGE_TYPE_ACTIONS,
  hwSensorFilterMatches,
  METRIC_META,
  FIELD_META,
  isTriggerLeaf,
  normalizeRuleToV2,
  normalizeEscalationToV2,
  scopeCidrOf,
  evaluateScopeCondition,
  triggerSignature,
  scopeRank,
  scopeRankLabel,
  numMeets,
} from "./notificationTypes.js";
import { scopeMatchesAsset, type ScopeAsset } from "./notificationRuleService.js";
import { ipInCidr } from "../utils/cidr.js";
import { computeStorageForecast } from "./storageForecastService.js";
import { buildComposedEmail, scopeRegionTagsOf } from "./notificationRecipientService.js";
import { executeActions, type ActionExecContext } from "./automationActionService.js";
import { queryProbeLossRatios } from "./probeLossQuery.js";
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
  /** v2 unified action list (legacy targets normalized in); actions may carry
   *  their own escalation chain (per-action escalation). */
  actions: EscalatableAction[];
  cooldownSec: number | null;
  messageTemplate: string | null;
  emailComposition: EmailComposition | null;
  /** Escalation as v2 tiers-of-actions (legacy tiers converted by the normalizer). */
  escalation: EscalationV2Config | null;
  /** Severity bands (numeric triggers only); null = single-severity. */
  severityBands: SeverityBand[] | null;
  /** Band-transition notify policy; null = defaults (increase + resolved/reuse). */
  bandNotify: BandNotify | null;
}

/** Best-effort action fan-out — never breaks rule evaluation. (executeActions
 *  is already best-effort per action; this guards the fan-out itself.) */
async function executeActionsSafe(notificationId: string, actions: AutomationAction[], ctx: Record<string, string>, exec: ActionExecContext): Promise<void> {
  if (!actions || actions.length === 0) return;
  try {
    await executeActions(notificationId, actions, ctx, exec);
  } catch (err) {
    await logEvent({
      action: "notification.delivery_expand_error",
      resourceType: "notification",
      resourceId: notificationId,
      actor: "system:notification-engine",
      level: "warning",
      message: "Failed to execute automation actions",
      details: { err: (err as Error)?.message },
    }).catch(() => {});
  }
}

// Extends ScopeAsset (which extends notificationTypes.ScopeConditionAsset), so
// the condition-tree fields (manufacturer/model/os — SCOPE_SELECT populates
// them; optional so the pseudo-host row can omit them) are inherited and the
// three layers can't drift.
interface ScopeAssetRow extends ScopeAsset {
  hostname: string | null;
  monitorStatus: string | null;
  status: string;
  consecutiveFailures: number;
  dependencySuppressed: boolean;
  quarantinedAt: Date | null;
  ipAddress: string | null;
  // Read by the ifOperStatus/ifAdminStatus resolvers (pinned-interface gate).
  monitoredInterfaces?: string[];
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
// Delegates to notificationTypes.numMeets — trigger evaluation and severity-
// band evaluation must share one comparator.

export const compareNum = numMeets;

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
  quarantinedAt: true, ipAddress: true,
  // condition-tree evaluation reads these (manufacturer/model/os); small
  // string columns, still a tight select at 2000 assets.
  manufacturer: true, model: true, os: true,
  // ifOperStatus/ifAdminStatus readings are restricted to PINNED interfaces.
  monitoredInterfaces: true,
} as const;

/** Build a Prisma where from a scope, or null if the scope matches nothing.
 *  subnetCidrs can't be expressed in SQL (CIDR math over a string column) —
 *  it narrows to ipAddress-present here and match happens in loadScopeAssets. */
function scopeWhere(scope: RuleScope): Prisma.AssetWhereInput | null {
  if (scope.allAssets) return {};
  const and: Prisma.AssetWhereInput[] = [];
  if (scope.assetTypes?.length) and.push({ assetType: { in: scope.assetTypes } });
  if (scope.tags?.length) and.push({ tags: { hasSome: scope.tags } });
  if (scope.assetIds?.length) and.push({ id: { in: scope.assetIds } });
  if (scope.integrationIds?.length) and.push({ discoveredByIntegrationId: { in: scope.integrationIds } });
  // manufacturer / model: case-insensitive contains, OR within the list.
  if (scope.manufacturers?.length) {
    and.push({ OR: scope.manufacturers.map((m) => ({ manufacturer: { contains: m, mode: "insensitive" as const } })) });
  }
  if (scope.models?.length) {
    and.push({ OR: scope.models.map((m) => ({ model: { contains: m, mode: "insensitive" as const } })) });
  }
  if (scope.subnetCidrs?.length) and.push({ ipAddress: { not: null } });
  // A condition tree can't be expressed in SQL — it counts as a dimension
  // (so a condition-only scope loads all assets) and filters in memory below.
  if (scope.condition) and.push({});
  if (and.length === 0) return null; // no dimensions + not allAssets ⇒ nothing
  return { AND: and };
}

async function loadScopeAssets(scope: RuleScope): Promise<ScopeAssetRow[]> {
  const where = scopeWhere(scope);
  if (!where) return [];
  let rows = await prisma.asset.findMany({ where, select: SCOPE_SELECT });
  if (scope.subnetCidrs?.length) {
    const cidrs = scope.subnetCidrs.map(scopeCidrOf);
    rows = rows.filter((a) => a.ipAddress && cidrs.some((c) => {
      try { return ipInCidr(a.ipAddress!, c); } catch { return false; }
    }));
  }
  if (scope.condition) {
    rows = rows.filter((a) => evaluateScopeCondition(scope.condition!, a));
  }
  return rows;
}

/** The asset ids a rule scope resolves to, for surfaces that need the scope's
 *  DEVICE SET without the reading machinery around it (the builder's
 *  dimension-value picker asks "what do these devices actually report?").
 *  Shares loadScopeAssets so the picker can't disagree with what the engine
 *  would evaluate. */
export async function loadScopeAssetIds(scope: RuleScope): Promise<string[]> {
  return (await loadScopeAssets(scope)).map((a) => a.id);
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
    case "probeLossPct": {
      // Probe-failure ratio over the window — the same shared query the
      // dashboard Packet Loss widget uses (probeLossQuery.queryProbeLossRatios;
      // the widget runs it in onlyLossy mode), so it works for ANY monitored
      // asset (switch/AP/server), not just SD-WAN. A windowed ratio:
      // `aggregation` doesn't apply (the window IS the measurement interval).
      // One grouped aggregate (1 row per asset), not a fetch-all — stays cheap
      // at 2000 assets on the 60s engine tick. The window is windowSec,
      // floored at DEFAULT_LOOKBACK (15m) — the widget's window.
      const sinceMinutes = Math.max(trigger.windowSec, DEFAULT_LOOKBACK_MS / 1000) / 60;
      const rows = await queryProbeLossRatios({ sinceMinutes, assetIds: ids });
      // Emit the true ratio for every asset with at least one successful probe,
      // INCLUDING 0% (no failures) so an auto-clear/hysteresis rule recovers.
      // Fully-down assets (0 successes) are dropped by the HAVING — asset-down
      // owns them, matching the widget.
      return rows.map((r): Reading | null => {
        const a = index.get(r.assetId);
        if (!a) return null;
        const total = Number(r.total); const failed = Number(r.failed);
        const value = total > 0 ? Math.round((failed / total) * 1000) / 10 : null;
        return { assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey: "", dimLabel: "", value };
      }).filter((r): r is Reading => r !== null);
    }
    case "hwSensorValue": {
      const rows = await prisma.assetHardwareSensorSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since }, ...(df.sensorClass ? { sensorClass: df.sensorClass } : {}) }, select: { assetId: true, timestamp: true, sensorName: true, sensorClass: true, value: true } });
      // sensorNamePattern narrows to ONE named sensor (or a family of them) —
      // ANDed with the class filter above (already applied in SQL), substring-
      // matched like the other *Pattern dimensions. Uses the shared predicate so
      // the asset chart's tier lookup can't drift from what actually fires.
      const filtered = df.sensorNamePattern ? rows.filter((r) => hwSensorFilterMatches(df, r)) : rows;
      return reduceReadings(filtered, index, (r) => r.sensorName, (r) => `${r.sensorName} (${r.sensorClass})`, (r) => r.value ?? null, agg);
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
    case "storageDaysUntilFull": {
      // Forecast metric: the shared 30-day trend (storageForecastService).
      // aggregation/windowSec don't apply — the trend already smooths; a mount
      // that isn't growing (or has <7 daily points) produces NO reading, so
      // "days <= N" rules stay silent for healthy filesystems.
      const fc = await computeStorageForecast(ids);
      return fc
        .filter((r) => index.has(r.assetId) && substringMatch(r.mountPath, df.mountPathPattern))
        .map((r) => {
          const a = index.get(r.assetId)!;
          return { assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey: r.mountPath, dimLabel: r.mountPath, value: r.daysUntilFull };
        });
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
      // Only PINNED interfaces produce readings (Asset.monitoredInterfaces —
      // the same join the Down Interfaces widget uses): the interfaces stream
      // samples every port a device reports, and an unpinned port is usually
      // just unplugged — a 8-port switch must not raise 8 "interface down"
      // alerts. ifOperStatus additionally requires admin-up (an admin-downed
      // port is deliberately down, not an outage — the widget's adminStatus
      // gate). An interface that leaves the pin set (or gets admin-downed)
      // stops producing readings; the vanished-state sweep clears its alert.
      return rows.filter((r) => {
        const a = index.get(r.assetId);
        if (!a?.monitoredInterfaces?.includes(r.ifName)) return false;
        if (trigger.field === "ifOperStatus" && r.adminStatus !== "up") return false;
        return substringMatch(r.ifName, df.ifNamePattern);
      }).map((r) => { const a = index.get(r.assetId)!; return mk(a, r.ifName, r.ifName, (r as any)[col]); });
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

/** Fire-time detail for a composite trigger: what the message/tokens render. */
interface CompositeFireInfo {
  /** Met-conditions summary with witness dims, e.g. "CPU utilization ≥ 90 (95) and Storage used ≥ 80 (/var = 94)". */
  summary: string;
  /** "k of n conditions met". */
  conditions: string;
}

/** The reading-derived template parts (sans assetDetail/message, added by callers). */
function readingContextParts(rule: DbRule, reading: Reading, now: Date, composite?: CompositeFireInfo): TemplateContextParts {
  const trigger = rule.trigger;
  const base = {
    asset: reading.hostname || reading.assetId || "host",
    dimension: reading.dimLabel || "",
    severity: rule.severity,
    time: now,
    link: notificationsPageUrl(),
    ruleName: rule.name,
    ruleDescription: rule.description,
  };
  if (trigger.type === "composite") {
    // No single metric/value/threshold exists — {metric} carries the
    // met-conditions summary, {conditions} the "k of n" count.
    return { ...base, metric: composite?.summary ?? "conditions met", value: "", threshold: "", conditions: composite?.conditions ?? "" };
  }
  const metric = trigger.type === "asset_metric" || trigger.type === "host_metric" ? trigger.metric
    : trigger.type === "asset_state" ? trigger.field : trigger.type;
  const threshold = trigger.type === "asset_metric" || trigger.type === "host_metric" ? String(trigger.threshold)
    : trigger.type === "asset_state" ? String(trigger.value) : "";
  const valueStr = reading.value === null ? "n/a" : typeof reading.value === "number" ? round2(reading.value) : String(reading.value);
  return { ...base, metric: String(metric), value: valueStr, threshold };
}

/** Render the in-app message from a built context (default string when no template). */
function renderMessage(rule: DbRule, reading: Reading, ctx: Record<string, string>): string {
  if (rule.messageTemplate && rule.messageTemplate.trim()) {
    return renderNotificationTemplate(rule.messageTemplate, ctx);
  }
  const dim = reading.dimLabel ? ` [${reading.dimLabel}]` : "";
  if (rule.trigger.type === "composite") {
    // {metric} holds the met-conditions summary — no "= (threshold )" artifacts.
    const count = ctx["conditions"] ? ` (${ctx["conditions"]})` : "";
    return `${rule.name}: ${ctx["asset"]} — ${ctx["metric"]}${count}`;
  }
  return `${rule.name}: ${ctx["asset"]}${dim} — ${ctx["metric"]} = ${ctx["value"]} (threshold ${ctx["threshold"]})`;
}

function round2(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/** Does this rule need the fire-time template context (composition/escalation/asset tokens)?
 *  ANY escalation chain counts — rule-level, per-action, band-level, or
 *  band-per-action — since the sweep renders from the templateCtx snapshot. */
function ruleWantsContext(rule: DbRule): boolean {
  return !!(rule.emailComposition || ruleHasAnyEscalation(rule));
}

function ruleWantsAssetDetail(rule: DbRule): boolean {
  const comp = rule.emailComposition;
  // Action-level templates can reference {asset.*} too: per-action email
  // composition, api_call bodies, script args — walked over EVERY place
  // actions live (top-level + per-action tiers + rule tiers + band actions +
  // band tiers + resolved actions) via the canonical allRuleActionRefs.
  const templatesOf = (a: AutomationAction) =>
    a.type === "notify"
      ? [a.emailComposition?.subjectTemplate, a.emailComposition?.bodyTextTemplate, a.emailComposition?.bodyHtmlTemplate]
      : a.type === "api_call"
        ? [a.bodyTemplate]
        : a.type === "script"
          ? [a.argsTemplate]
          : []; // event — no templates of its own
  const actionTemplates = allRuleActionRefs(rule).flatMap((r) => templatesOf(r.action));
  return (
    ruleWantsContext(rule) ||
    templateNeedsAsset([rule.messageTemplate, comp?.subjectTemplate, comp?.bodyTextTemplate, comp?.bodyHtmlTemplate, ...actionTemplates])
  );
}

// buildComposedEmail moved to notificationRecipientService (the action layer
// composes per-action emails and importing it from here would be circular);
// re-exported so the escalation sweep + tests keep their import path.
export { buildComposedEmail };

// ─── Specificity precedence / carve-out ─────────────────────────────────────
// A more-specific automation "carves" the assets it covers out of a
// less-specific one that watches the SAME trigger (triggerSignature): those
// assets drop their readings, any active alert on the general rule clears
// (superseded), and its pending debounce resets. Same-rank ties both fire.
// Built once per engine tick over the enabled rule set; only asset_metric /
// asset_state rules (non-null signature) participate.

interface ShadowMember {
  rule: DbRule;
  rank: number;
}
interface ShadowIndex {
  /** signature → participating rules (with precomputed scopeRank). */
  bySig: Map<string, ShadowMember[]>;
  /** signature → highest rank present (skip the per-asset check for max-rank rules). */
  maxRankBySig: Map<string, number>;
}

export function buildShadowIndex(rules: DbRule[]): ShadowIndex {
  const bySig = new Map<string, ShadowMember[]>();
  const maxRankBySig = new Map<string, number>();
  for (const rule of rules) {
    const sig = triggerSignature(rule.trigger);
    if (!sig) continue;
    const rank = scopeRank(rule.scope);
    const arr = bySig.get(sig);
    if (arr) arr.push({ rule, rank });
    else bySig.set(sig, [{ rule, rank }]);
    maxRankBySig.set(sig, Math.max(maxRankBySig.get(sig) ?? 0, rank));
  }
  return { bySig, maxRankBySig };
}

/** Does a higher-rank same-signature rule also cover this asset? */
export function isAssetShadowed(index: ShadowIndex, rule: DbRule, sig: string, rank: number, asset: ScopeAsset): boolean {
  const group = index.bySig.get(sig);
  if (!group) return false;
  for (const other of group) {
    if (other.rule.id === rule.id) continue;
    if (other.rank > rank && scopeMatchesAsset(other.rule.scope, asset)) return true;
  }
  return false;
}

// ─── Threshold / state evaluation ───────────────────────────────────────────

/** The rule-state subset the vanished-state sweep needs. */
interface SweepStateRow {
  id: string;
  assetId: string | null;
  dimensionKey: string;
  state: string;
  notificationId: string | null;
}

/**
 * Clear firing/pending state rows the readings loop can no longer SEE — the
 * asset left the rule's scope (scope edit, tag drift, asset deleted or
 * unmonitored) or its dimension stopped being covered (interface unpinned or
 * admin-downed, mount/tunnel gone, dimensionFilter edit). Without this they
 * sit firing forever: the loop only re-evaluates keys that produce readings.
 * Two deliberate freezes stay frozen: suppressed assets (maintenance /
 * dependency — business rule 16; re-checked here for assets whose scope
 * condition drops them WHILE suppressed, e.g. a `status = active` condition)
 * and in-scope assets that produced no readings at all this tick (a
 * collection gap is not evidence of recovery). Zero extra queries on the
 * steady-state tick — the scope re-check only runs when orphans exist.
 */
async function clearVanishedStates(
  rule: DbRule,
  states: SweepStateRow[],
  seenKeys: Set<string>,
  scopeIds: Set<string>,
  handledIds: Set<string>,
  assetsWithReadings: Set<string>,
): Promise<void> {
  const vanished: Array<{ st: SweepStateRow; reason: "scope" | "dimension" }> = [];
  const scopeChecks: SweepStateRow[] = [];
  for (const st of states) {
    if (!st.assetId) continue; // host/global rows have no scope to leave
    if (st.state !== "firing" && st.state !== "pending") continue;
    if (seenKeys.has(`${st.assetId}|${st.dimensionKey}`)) continue;
    if (handledIds.has(st.assetId)) continue; // suppressed freeze / carve-out handoff own these
    if (scopeIds.has(st.assetId)) {
      if (assetsWithReadings.has(st.assetId)) vanished.push({ st, reason: "dimension" });
      // else: the asset reported nothing this tick — stay frozen
    } else {
      scopeChecks.push(st);
    }
  }
  if (scopeChecks.length > 0) {
    const ids = Array.from(new Set(scopeChecks.map((s) => s.assetId as string)));
    const rows = await prisma.asset.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, dependencySuppressed: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const st of scopeChecks) {
      const a = byId.get(st.assetId as string);
      if (a && isSuppressedForNotifications(a)) continue; // rule-16 freeze wins over scope drift
      vanished.push({ st, reason: "scope" });
    }
  }
  for (const { st, reason } of vanished) {
    if (st.state === "firing") {
      await clearActiveNotification(st, "system:out-of-scope");
      await logEvent({
        action: "notification.out_of_scope",
        resourceType: "notification",
        resourceId: st.notificationId ?? undefined,
        resourceName: rule.name,
        actor: "system:notification-engine",
        message: reason === "scope"
          ? `Cleared: ${rule.name} — asset is no longer covered by this automation's scope`
          : `Cleared: ${rule.name} — ${st.dimensionKey || "the dimension"} is no longer reported or monitored`,
        details: { ruleId: rule.id, assetId: st.assetId, dimension: st.dimensionKey, reason },
      }).catch(() => {});
    }
    await prisma.notificationRuleState.update({
      where: { id: st.id },
      data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null },
    });
  }
}

async function evaluateThresholdRule(rule: DbRule, shadowIndex?: ShadowIndex): Promise<void> {
  const trigger = rule.trigger;
  let readings: Reading[] = [];
  // Assets silenced this tick (maintenance window / dependency-suppressed).
  const suppressedIds = new Set<string>();
  // Assets carved out this tick by a more-specific same-signature automation.
  const shadowedIds = new Set<string>();
  // Every asset the scope resolved this tick (incl. suppressed/shadowed);
  // null for host rules, which have no asset scope to leave.
  let scopeIds: Set<string> | null = null;

  if (trigger.type === "host_metric") {
    const r = await resolveHostMetricReading(trigger);
    readings = r ? [r] : [];
  } else if (trigger.type === "asset_metric" || trigger.type === "asset_state") {
    const assets = await loadScopeAssets(rule.scope);
    scopeIds = new Set(assets.map((a) => a.id));
    // Precedence: only worth checking when this rule isn't already the most
    // specific in its signature group (and the group has a higher-rank peer).
    const sig = shadowIndex ? triggerSignature(rule.trigger) : null;
    const rank = sig ? scopeRank(rule.scope) : 0;
    const shadowable = !!(sig && shadowIndex && (shadowIndex.maxRankBySig.get(sig) ?? 0) > rank);
    const active: ScopeAssetRow[] = [];
    for (const a of assets) {
      if (isSuppressedForNotifications(a)) suppressedIds.add(a.id);
      else if (shadowable && isAssetShadowed(shadowIndex!, rule, sig!, rank, a)) shadowedIds.add(a.id);
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
  const hasBands = ruleHasBands(rule);
  // Per-tier sustained durations: every severity (base + each band) carries its
  // own "sustained for", so the tier ladder + the state row's per-tier
  // met-since map — not one shared conditionMetSince — decide which severity
  // has actually earned its time. Null for non-banded rules (unchanged path).
  const tiers = hasBands ? tierLadderFor(rule) : null;

  for (const reading of readings) {
    const key = `${reading.assetId || ""}|${reading.dimKey}`;
    seen.add(key);
    const lastValue = typeof reading.value === "number" ? reading.value : null;
    const st = stateMap.get(key);
    // Banded rules fire/clear by the resolved band severity (null = below tier
    // 0); non-banded rules use the single-threshold decision unchanged.
    const bandSev = hasBands ? bandSeverityFor(rule, lastValue) : null;
    const meets = hasBands ? bandSev !== null : readingMeets(trigger, reading.value);
    // Roll each tier's run forward, then resolve the most-severe tier whose OWN
    // duration has elapsed. null = nothing has sustained yet (stay pending, or
    // hold the firing alert's current severity).
    const prevMetSince = tiers ? metSinceOf(st) : null;
    const metSince = tiers ? updateTierMetSince(prevMetSince, tiers, meets ? lastValue : null, now.getTime()) : null;
    const sustainedSev = tiers ? sustainedSeverity(metSince, tiers, now.getTime()) : null;
    const metSinceChanged = !!tiers && tierMetSinceChanged(prevMetSince, metSince);
    const fireOpts = sustainedSev ? { severity: sustainedSev, actions: tierForSeverity(rule, sustainedSev).actions } : undefined;

    if (meets) {
      if (!st || st.state === "clear") {
        if (hasBands) {
          // A tier whose sustain is 0 fires on the first reading; otherwise the
          // per-tier timer starts here and the row sits pending.
          if (sustainedSev) await fire(rule, reading, lastValue, now, undefined, fireOpts, metSince);
          else await upsertState(rule.id, reading, "pending", { conditionMetSince: now, lastValue, bandMetSince: metSince });
        } else if ((trigger as any).forDurationSec > 0) {
          // start the sustained-duration timer
          await upsertState(rule.id, reading, "pending", { conditionMetSince: now, lastValue });
        } else {
          await fire(rule, reading, lastValue, now, undefined, fireOpts);
        }
      } else if (st.state === "pending") {
        if (hasBands) {
          if (sustainedSev) await fire(rule, reading, lastValue, now, undefined, fireOpts, metSince);
          else if (metSinceChanged) {
            // A tier entered or dropped out while pending — persist the runs.
            await prisma.notificationRuleState.update({ where: { id: st.id }, data: { bandMetSince: metSinceJson(metSince), lastValue } });
          }
        } else {
          const since = st.conditionMetSince ?? now;
          if (now.getTime() - since.getTime() >= (trigger as any).forDurationSec * 1000) {
            await fire(rule, reading, lastValue, now, undefined, fireOpts);
          }
          // else keep pending
        }
      } else if (st.state === "firing") {
        if (hasBands && sustainedSev && sustainedSev !== (st.firingSeverity ?? rule.severity)) {
          // Crossed into a band that has now held for its own duration —
          // escalate/de-escalate the live alert.
          await applyBandTransition(rule, reading, st, sustainedSev, now, metSince);
        } else if (st.recoveredSince || metSinceChanged) {
          // Re-met mid-recovery: cancel the clear-sustain timer (transition-only
          // write — a steadily-firing condition costs nothing per tick). Also
          // where a climbing-but-not-yet-sustained tier's run is persisted.
          await prisma.notificationRuleState.update({
            where: { id: st.id },
            data: { recoveredSince: null, ...(hasBands ? { bandMetSince: metSinceJson(metSince) } : {}) },
          });
        } // same band / firing without a pending recovery → already active; suppress
      }
    } else {
      // condition not met for this reading
      if (st && st.state === "pending") {
        await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, bandMetSince: Prisma.DbNull } });
      } else if (st && st.state === "firing") {
        if (rule.reset.mode !== "auto") {
          // manual re-arms the state; timed waits for its sweep — same as ever.
          await recover(rule, st);
        } else if (!recoveredMeets(trigger, rule.reset, reading.value)) {
          // Hysteresis dead band (below fire, above clear): stay firing — but
          // a BANDED alert eases to the base severity here. The value is out
          // of every band (only anti-flap keeps the alert active), and a CPU
          // that crashes from the critical band straight into the dead band
          // in one tick never passes through the lower bands — parked at the
          // old band it would read critical indefinitely.
          if (hasBands && (st.firingSeverity ?? rule.severity) !== rule.severity) {
            await applyBandTransition(rule, reading, st, rule.severity, now, metSince);
          } else if (st.recoveredSince || metSinceChanged) {
            await prisma.notificationRuleState.update({
              where: { id: st.id },
              data: { recoveredSince: null, ...(hasBands ? { bandMetSince: metSinceJson(metSince) } : {}) },
            });
          }
        } else {
          const sustainSec = rule.reset.sustainSec ?? 0;
          if (sustainSec <= 0) {
            if (hasBands) await fireResolved(rule, reading, st, now);
            await recover(rule, st);
          } else if (!st.recoveredSince) {
            // Recovery observed — start the clear-sustain timer.
            await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: now } });
          } else if (now.getTime() - st.recoveredSince.getTime() >= sustainSec * 1000) {
            if (hasBands) await fireResolved(rule, reading, st, now);
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

  // Carved-out assets: a more-specific same-signature automation has taken them
  // over. Unlike maintenance suppression (which freezes firing rows), the
  // takeover is a real handoff — clear any active alert (superseded) and reset
  // pending debounce so the general rule no longer alerts for these assets.
  for (const st of states) {
    if (!st.assetId || !shadowedIds.has(st.assetId)) continue;
    if (st.state === "firing") {
      await clearActiveNotification(st, "system:superseded");
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null },
      });
      await logEvent({
        action: "notification.superseded",
        resourceType: "notification",
        resourceId: st.notificationId ?? undefined,
        resourceName: rule.name,
        actor: "system:notification-engine",
        message: `Cleared: ${rule.name} superseded by a more-specific automation`,
        details: { ruleId: rule.id, assetId: st.assetId },
      }).catch(() => {});
    } else if (st.state === "pending") {
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null },
      });
    }
  }

  // Vanished states: assets that left the scope or dimensions that stopped
  // being reported — the readings loop never sees them, so clear them here
  // (suppressed assets stay frozen, in-scope assets with no readings at all
  // stay frozen; see clearVanishedStates).
  if (scopeIds) {
    const handled = new Set([...suppressedIds, ...shadowedIds]);
    const assetsWithReadings = new Set(readings.map((r) => r.assetId).filter(Boolean));
    await clearVanishedStates(rule, states, seen, scopeIds, handled, assetsWithReadings);
  }

  // Timed auto-clear: firing states past their timer, even without an explicit
  // recovery reading (e.g. the asset stopped reporting).
  if (rule.reset.mode === "timed" && rule.reset.afterSec) {
    const afterSec = rule.reset.afterSec;
    for (const st of states) {
      if (st.state === "firing" && st.firedAt && now.getTime() - st.firedAt.getTime() >= afterSec * 1000) {
        await clearActiveNotification(st, "system:timed");
        await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull } });
      }
    }
  }
}

// ─── Composite trigger evaluation ───────────────────────────────────────────
// Composite rules evaluate PER ASSET: every metric/state leaf resolves its
// readings through the UNCHANGED single-trigger resolvers (one query per
// DISTINCT leaf shape), a multi-dimension leaf counts as met when ANY of its
// dimensions meets, and the AND/OR tree folds leaf truths into one outcome
// per asset. The state machine runs at dimensionKey "" — one alert per
// device. A deliberately separate path from evaluateThresholdRule (sharing
// only the fire/recover/upsertState write layer) so the legacy per-dimension
// path stays byte-identical.

interface LeafRef {
  /** Tree-path id ("0", "1.2") — stable across trigger and preview so the
   *  wizard can highlight its builder rows. */
  leafId: string;
  leaf: CompositeLeaf;
}

function collectLeafRefs(node: { children: (TriggerConditionGroup | CompositeLeaf)[] }, prefix = ""): LeafRef[] {
  const out: LeafRef[] = [];
  node.children.forEach((c, i) => {
    const id = prefix ? `${prefix}.${i}` : String(i);
    if (isTriggerLeaf(c)) out.push({ leafId: id, leaf: c });
    else out.push(...collectLeafRefs(c, id));
  });
  return out;
}

interface LeafTruth {
  met: boolean;
  /** The first meeting dimension — names the sensor/mount/interface in the alert. */
  witness: { dimLabel: string; value: number | string | boolean | null } | null;
  /** A representative reading regardless of met (preview shows current values). */
  sample: { dimLabel: string; value: number | string | boolean | null } | null;
  hasReading: boolean;
}

async function resolveOneLeafReadings(leaf: CompositeLeaf, assets: ScopeAssetRow[]): Promise<Reading[]> {
  if (leaf.type === "asset_metric") return resolveAssetMetricReadings({ ...leaf, forDurationSec: 0 }, assets);
  if (leaf.type === "asset_state") return resolveAssetStateReadings({ ...leaf, forDurationSec: 0 }, assets);
  const r = await resolveHostMetricReading({ ...leaf, forDurationSec: 0 });
  return r ? [r] : [];
}

/** Resolve every leaf's readings (identical leaves share one query) and fold
 *  them to per-asset truths. Host leaves land on the pseudo-asset id "". */
async function resolveLeafTruths(leaves: LeafRef[], assets: ScopeAssetRow[]): Promise<Map<string, Map<string, LeafTruth>>> {
  const byResolverKey = new Map<string, Promise<Reading[]>>();
  const out = new Map<string, Map<string, LeafTruth>>();
  for (const { leafId, leaf } of leaves) {
    const key = JSON.stringify(leaf);
    let p = byResolverKey.get(key);
    if (!p) {
      p = resolveOneLeafReadings(leaf, assets);
      byResolverKey.set(key, p);
    }
    out.set(leafId, leafTruthByAsset(leaf, await p));
  }
  return out;
}

/** ANY-dimension fold: a leaf is met for an asset when any of its readings meets. */
function leafTruthByAsset(leaf: CompositeLeaf, readings: Reading[]): Map<string, LeafTruth> {
  const out = new Map<string, LeafTruth>();
  const leafTrigger = leaf as unknown as Trigger; // readingMeets reads type/operator/threshold|value only
  for (const r of readings) {
    const id = r.assetId || "";
    let t = out.get(id);
    if (!t) {
      t = { met: false, witness: null, sample: null, hasReading: true };
      out.set(id, t);
    }
    if (!t.sample) t.sample = { dimLabel: r.dimLabel, value: r.value };
    if (!t.met && readingMeets(leafTrigger, r.value)) {
      t.met = true;
      t.witness = { dimLabel: r.dimLabel, value: r.value };
    }
  }
  return out;
}

function evalTriggerTreeForAsset(
  node: { op: "and" | "or"; children: (TriggerConditionGroup | CompositeLeaf)[] },
  assetId: string,
  truths: Map<string, Map<string, LeafTruth>>,
  prefix = "",
): boolean {
  const results = node.children.map((c, i) => {
    const id = prefix ? `${prefix}.${i}` : String(i);
    if (isTriggerLeaf(c)) return truths.get(id)?.get(assetId)?.met === true; // no reading ⇒ false (never fire on absent evidence)
    return evalTriggerTreeForAsset(c as TriggerConditionGroup, assetId, truths, id);
  });
  return node.op === "and" ? results.every(Boolean) : results.some(Boolean);
}

interface CompositeOutcome {
  meets: boolean;
  /** False when NO leaf produced a reading for this asset — the asset is
   *  skipped entirely (state frozen), matching the per-reading path's
   *  no-reading behavior. */
  hasAnyReading: boolean;
  metLeaves: Array<{ leafId: string; leaf: CompositeLeaf; witness: LeafTruth["witness"] }>;
  totalLeaves: number;
}

function compositeOutcomeForAsset(
  tree: { op: "and" | "or"; children: (TriggerConditionGroup | CompositeLeaf)[] },
  assetId: string,
  leaves: LeafRef[],
  truths: Map<string, Map<string, LeafTruth>>,
): CompositeOutcome {
  const metLeaves: CompositeOutcome["metLeaves"] = [];
  let hasAnyReading = false;
  for (const { leafId, leaf } of leaves) {
    const t = truths.get(leafId)?.get(assetId);
    if (t?.hasReading) hasAnyReading = true;
    if (t?.met) metLeaves.push({ leafId, leaf, witness: t.witness });
  }
  return { meets: evalTriggerTreeForAsset(tree, assetId, truths), hasAnyReading, metLeaves, totalLeaves: leaves.length };
}

/** Human label for a leaf condition ("CPU utilization >= 90"). */
function leafConditionLabel(leaf: CompositeLeaf): string {
  if (leaf.type === "asset_state") {
    return `${FIELD_META[leaf.field]?.label ?? leaf.field} ${leaf.operator} ${leaf.value}`;
  }
  return `${METRIC_META[leaf.metric]?.label ?? leaf.metric} ${leaf.operator} ${leaf.threshold}`;
}

function compositeFireInfo(outcome: CompositeOutcome): CompositeFireInfo {
  const parts = outcome.metLeaves.map(({ leaf, witness }) => {
    const base = leafConditionLabel(leaf);
    if (!witness) return base;
    const v = typeof witness.value === "number" ? round2(witness.value) : String(witness.value ?? "");
    return witness.dimLabel ? `${base} (${witness.dimLabel} = ${v})` : `${base} (${v})`;
  });
  return {
    summary: parts.join(" and ") || "conditions met",
    conditions: `${outcome.metLeaves.length} of ${outcome.totalLeaves} conditions met`,
  };
}

const HOST_PSEUDO_ASSET: ScopeAssetRow = {
  id: "", hostname: "Polaris host", assetType: null, tags: [], discoveredByIntegrationId: null,
  monitorStatus: null, status: "active", consecutiveFailures: 0, dependencySuppressed: false,
  quarantinedAt: null, ipAddress: null,
};

/** The auto/condition clear-sustain ladder — shared by both recovery signals
 *  (auto: !triggerTree; condition: the reset tree). Mirrors the legacy
 *  per-reading sustain block exactly. */
async function applySustainedRecovery(
  rule: DbRule,
  st: { id: string; notificationId: string | null; recoveredSince: Date | null },
  recovered: boolean,
  now: Date,
): Promise<void> {
  if (!recovered) {
    if (st.recoveredSince) {
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: null } });
    }
    return;
  }
  const sustainSec = rule.reset.sustainSec ?? 0;
  if (sustainSec <= 0) {
    await recover(rule, st);
  } else if (!st.recoveredSince) {
    await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: now } });
  } else if (now.getTime() - st.recoveredSince.getTime() >= sustainSec * 1000) {
    await recover(rule, st);
  }
  // else: recovered but not sustained long enough yet — keep firing.
}

async function evaluateCompositeRule(rule: DbRule): Promise<void> {
  const trigger = rule.trigger as CompositeTrigger;
  const suppressedIds = new Set<string>();
  let scopeAssets: ScopeAssetRow[] = [];
  let activeAssets: ScopeAssetRow[];
  if (trigger.kind === "host") {
    activeAssets = [HOST_PSEUDO_ASSET];
  } else {
    scopeAssets = await loadScopeAssets(rule.scope);
    activeAssets = [];
    for (const a of scopeAssets) {
      if (isSuppressedForNotifications(a)) suppressedIds.add(a.id);
      else activeAssets.push(a);
    }
  }

  const leaves = collectLeafRefs(trigger);
  const truths = await resolveLeafTruths(leaves, activeAssets);

  const states = await prisma.notificationRuleState.findMany({ where: { ruleId: rule.id } });
  const now = new Date();

  // Orphan sweep: composite state lives at dimensionKey "" only. Rows at any
  // other key are stale BY CONSTRUCTION (a single→composite trigger edit that
  // bypassed the service cleanup — raw API, restored backup): clear their
  // notifications and delete the rows so they can't linger firing forever.
  for (const st of states) {
    if (st.dimensionKey !== "") {
      await clearActiveNotification(st, "system:rule-edited");
      await prisma.notificationRuleState.delete({ where: { id: st.id } });
    }
  }
  const stateMap = new Map(states.filter((s) => s.dimensionKey === "").map((s) => [s.assetId ?? "", s]));

  // Condition-mode reset: resolve the reset tree ONLY against assets that are
  // actually firing — usually zero extra queries.
  const resetTree = rule.reset.mode === "condition" ? (rule.reset.condition ?? null) : null;
  let resetOutcomeFor: (assetId: string) => CompositeOutcome | null = () => null;
  if (resetTree) {
    const firingAssets = activeAssets.filter((a) => stateMap.get(a.id)?.state === "firing");
    if (firingAssets.length > 0) {
      const resetLeaves = collectLeafRefs(resetTree);
      const resetTruths = await resolveLeafTruths(resetLeaves, firingAssets);
      resetOutcomeFor = (assetId) => compositeOutcomeForAsset(resetTree, assetId, resetLeaves, resetTruths);
    }
  }

  // Assets actually evaluated this tick (≥1 leaf reading) — the composite
  // analogue of the per-reading path's `seen` set, for the vanished sweep.
  const evaluatedIds = new Set<string>();

  for (const a of activeAssets) {
    const outcome = compositeOutcomeForAsset(trigger, a.id, leaves, truths);
    if (!outcome.hasAnyReading) continue; // no evidence either way — state frozen (parity with the per-reading path)
    evaluatedIds.add(a.id);
    const st = stateMap.get(a.id);
    const reading: Reading = { assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey: "", dimLabel: "", value: null };

    if (st?.state === "firing") {
      if (rule.reset.mode === "condition") {
        // While firing, the reset tree is the SOLE recovery authority — the
        // trigger re-meeting does not independently cancel the sustain timer.
        // No reset reading ⇒ not recovered (never clear on absent evidence).
        const recovered = resetOutcomeFor(a.id)?.meets === true;
        await applySustainedRecovery(rule, st, recovered, now);
      } else if (outcome.meets) {
        if (st.recoveredSince) {
          // Re-met mid-recovery under auto: cancel the clear-sustain timer.
          await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: null } });
        }
      } else if (rule.reset.mode !== "auto") {
        await recover(rule, st); // manual re-arms the state; timed waits for its sweep
      } else {
        // auto for composites = the tree is no longer true (no hysteresis
        // dead band — clearThreshold is rejected at save for composites).
        await applySustainedRecovery(rule, st, true, now);
      }
      continue;
    }

    if (outcome.meets) {
      if (!st || st.state === "clear") {
        if (trigger.forDurationSec > 0) {
          await upsertState(rule.id, reading, "pending", { conditionMetSince: now, lastValue: null });
        } else {
          await fire(rule, reading, null, now, compositeFireInfo(outcome));
        }
      } else if (st.state === "pending") {
        const since = st.conditionMetSince ?? now;
        if (now.getTime() - since.getTime() >= trigger.forDurationSec * 1000) {
          await fire(rule, reading, null, now, compositeFireInfo(outcome));
        }
        // else keep pending
      }
    } else if (st?.state === "pending") {
      // Partial-missing under AND lands here too (missing leaf ⇒ false) — the
      // debounce restarts; accepted semantics (readings smooth over 15 min).
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null } });
    }
  }

  // Suppressed assets: reset pending rows (the debounce restarts after the
  // window), leave firing rows frozen — same contract as the legacy path.
  for (const st of states) {
    if (st.dimensionKey === "" && st.state === "pending" && st.assetId && suppressedIds.has(st.assetId)) {
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null } });
    }
  }

  // Vanished states: assets that left the rule's scope (composite state lives
  // at dimensionKey "", so only the scope reason applies here — an evaluated
  // asset is always `seen`). Same freeze contracts as the legacy path.
  if (trigger.kind !== "host") {
    await clearVanishedStates(
      rule,
      states.filter((s) => s.dimensionKey === ""),
      new Set(Array.from(evaluatedIds, (id) => `${id}|`)),
      new Set(scopeAssets.map((a) => a.id)),
      suppressedIds,
      evaluatedIds,
    );
  }

  // Timed auto-clear sweep (identical to the legacy path; orphan rows already
  // deleted above are excluded by the dimensionKey guard).
  if (rule.reset.mode === "timed" && rule.reset.afterSec) {
    const afterSec = rule.reset.afterSec;
    for (const st of states) {
      if (st.dimensionKey === "" && st.state === "firing" && st.firedAt && now.getTime() - st.firedAt.getTime() >= afterSec * 1000) {
        await clearActiveNotification(st, "system:timed");
        await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull } });
      }
    }
  }
}

async function upsertState(
  ruleId: string,
  reading: Reading,
  state: string,
  extra: {
    conditionMetSince?: Date | null;
    firedAt?: Date | null;
    lastValue?: number | null;
    notificationId?: string | null;
    /** Per-tier met-since runs (banded rules only); undefined leaves it alone. */
    bandMetSince?: Record<string, number> | null;
  },
) {
  const { bandMetSince, ...rest } = extra;
  const data = { ...rest, ...(bandMetSince !== undefined ? { bandMetSince: metSinceJson(bandMetSince) } : {}) };
  await prisma.notificationRuleState.upsert({
    where: { ruleId_assetId_dimensionKey: { ruleId, assetId: reading.assetId, dimensionKey: reading.dimKey } },
    create: { ruleId, assetId: reading.assetId, dimensionKey: reading.dimKey, state, ...data },
    update: { state, ...data },
  });
}

// ─── Severity bands (value-driven severity escalation) ──────────────────────
// Tier 0 = rule.severity + trigger.threshold + rule.actions/escalation; bands
// stack higher tiers on top. The alert is ONE row per (rule,asset,dim); its
// severity climbs with the value (re-notifying per bandNotify) and clears below
// tier 0. See notificationTypes.severityForValue.

interface EffectiveTier {
  severity: string;
  actions: AutomationAction[];
  escalation: EscalationV2Config | null;
}

/** Whether this rule uses value-driven severity bands (numeric trigger only). */
function ruleHasBands(rule: DbRule): boolean {
  return !!(rule.severityBands && rule.severityBands.length) &&
    (rule.trigger.type === "asset_metric" || rule.trigger.type === "host_metric");
}

/** The band severity for a numeric reading (null = below tier 0 / not firing).
 *  INSTANTANEOUS — ignores per-tier sustain; used for the "is the rule firing
 *  at all" decision (tier 0 membership). The severity the alert actually takes
 *  comes from sustainedSeverity over the tier ladder. */
function bandSeverityFor(rule: DbRule, value: number | null): string | null {
  const t = rule.trigger;
  if (t.type !== "asset_metric" && t.type !== "host_metric") return null;
  return severityForValue(t.operator, t.threshold, rule.severity as Severity, rule.severityBands as SeverityBand[] | null, value);
}

/** The rule's effective tier ladder (base + bands), each tier's operator and
 *  sustained duration resolved. Built once per rule per tick. */
function tierLadderFor(rule: DbRule): ResolvedTier[] | null {
  const t = rule.trigger;
  if (t.type !== "asset_metric" && t.type !== "host_metric") return null;
  return resolveTierLadder(
    t.operator,
    t.threshold,
    rule.severity as Severity,
    t.forDurationSec ?? 0,
    rule.severityBands as SeverityBand[] | null,
  );
}

/** Per-tier met-since map → the Json column value (empty map stores as SQL
 *  NULL so a cleared row reads the same as a pre-feature one). */
function metSinceJson(map: Record<string, number> | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return map && Object.keys(map).length ? (map as Prisma.InputJsonValue) : Prisma.DbNull;
}

/** The stored per-tier met-since map on a state row (Json column). */
function metSinceOf(st: { bandMetSince?: unknown } | undefined | null): Record<string, number> | null {
  const raw = st?.bandMetSince;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** The actions + escalation for a resolved severity. A band uses its OWN
 *  actions/escalation when it carries any, else falls back to the base tier's
 *  (severity tiers usually carry none — the alert re-notifies with the base
 *  Actions-step actions + base escalation at the tier's severity). */
export function tierForSeverity(rule: DbRule, severity: string): EffectiveTier {
  if (severity !== rule.severity) {
    const band = (rule.severityBands ?? []).find((b) => b.severity === severity);
    if (band) {
      const bandEsc = normalizeEscalationToV2(band.escalation);
      return {
        severity,
        actions: band.actions && band.actions.length ? band.actions : rule.actions,
        escalation: bandEsc ?? rule.escalation,
      };
    }
  }
  return { severity: rule.severity, actions: rule.actions, escalation: rule.escalation };
}

/** Normalized band-notify policy with defaults. */
export function bandNotifyOf(rule: DbRule): { onIncrease: boolean; onDecrease: boolean; onResolved: boolean; resolvedMode: "reuse" | "dedicated"; resolvedActions: AutomationAction[] } {
  const b: BandNotify | null = rule.bandNotify;
  return {
    onIncrease: b?.onIncrease ?? true,
    onDecrease: b?.onDecrease ?? false,
    onResolved: b?.onResolved ?? true,
    resolvedMode: b?.resolvedMode ?? "reuse",
    resolvedActions: b?.resolvedActions ?? [],
  };
}

function severityLevel(severity: string): "error" | "warning" | "info" {
  return severity === "critical" || severity === "serious" ? "error" : severity === "warning" ? "warning" : "info";
}

/** Fan the alert's actions out to the delivery pipeline (shared by initial fire
 *  + band escalation/de-escalation + resolved). */
async function enqueueAlertActions(notifId: string, actions: AutomationAction[], ctx: Record<string, string>, rule: DbRule, reading: Reading): Promise<void> {
  await executeActionsSafe(notifId, actions, ctx, {
    scopeRegionTags: scopeRegionTagsOf(rule.scope),
    // The triggering asset's own region tags (stripped) — recipientDeviceRegion
    // routing. Same snapshot fire() writes to Notification.regionTags.
    assetRegionTags: regionSnapshot(reading.tags),
    assetId: reading.assetId || null,
    ruleId: rule.id,
    ruleName: rule.name,
    ruleEmailComposition: rule.emailComposition,
    actor: "system:notification-engine",
  });
}

async function fire(
  rule: DbRule,
  reading: Reading,
  lastValue: number | null,
  now: Date,
  composite?: CompositeFireInfo,
  opts?: { severity?: string; actions?: AutomationAction[] },
  /** Per-tier met-since runs to carry onto the firing row (banded rules). */
  bandMetSince?: Record<string, number> | null,
): Promise<void> {
  // Respect cooldown: if this (rule,asset,dim) fired within cooldownSec, skip.
  const existing = await prisma.notificationRuleState.findUnique({
    where: { ruleId_assetId_dimensionKey: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey } },
  });
  if (rule.cooldownSec && existing?.firedAt && now.getTime() - existing.firedAt.getTime() < rule.cooldownSec * 1000) {
    return;
  }
  const severity = opts?.severity ?? rule.severity;
  const actions = opts?.actions ?? rule.actions;
  // Fires are transition-guarded (rare), so the per-fire asset-detail lookup
  // is negligible even at 2000 assets — the hot evaluate path stays on the
  // tight SCOPE_SELECT.
  const detail = ruleWantsAssetDetail(rule) && reading.assetId ? await assetDetail(reading.assetId) : null;
  const parts = readingContextParts(rule, reading, now, composite);
  parts.severity = severity; // band-resolved severity for the {severity} token
  const ctx = buildTemplateContext({ ...parts, assetDetail: detail });
  const message = renderMessage(rule, reading, ctx);
  ctx["message"] = message;
  const notif = await prisma.notification.create({
    data: {
      ruleId: rule.id,
      assetId: reading.assetId || null,
      assetHostname: reading.hostname,
      severity,
      message,
      regionTags: regionSnapshot(reading.tags),
      ...(ruleWantsContext(rule) ? { templateCtx: ctx as any } : {}),
    },
  });
  await prisma.notificationRuleState.upsert({
    where: { ruleId_assetId_dimensionKey: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey } },
    create: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey, state: "firing", firedAt: now, lastValue, notificationId: notif.id, firingSeverity: severity, bandMetSince: metSinceJson(bandMetSince) },
    update: { state: "firing", firedAt: now, lastValue, notificationId: notif.id, conditionMetSince: null, recoveredSince: null, firingSeverity: severity, bandMetSince: metSinceJson(bandMetSince) },
  });
  await enqueueAlertActions(notif.id, actions, ctx, rule, reading);
  // The audit Event is an ACTION now — present by default, removable for a
  // deliberately noisy automation. The in-app alert above is not: every
  // NotificationDelivery hangs off notif.id, as do the escalation sweep,
  // acknowledge/clear and the state machine.
  if (wantsEventAction(actions)) {
    await logEvent({
      action: "notification.triggered",
      resourceType: "notification",
      resourceId: notif.id,
      resourceName: rule.name,
      actor: "system:notification-engine",
      level: severityLevel(severity),
      message: notif.message,
      details: { ruleId: rule.id, assetId: reading.assetId || null, dimension: reading.dimKey, severity },
    });
  }
}

/** Does this severity's effective action list ask for the audit Event? */
function wantsEventAction(actions: AutomationAction[] | null | undefined): boolean {
  return (actions ?? []).some((a) => a.type === "event");
}

/** A firing alert crossed into a different band. Update its severity + message,
 *  re-notify per policy (increase always if onIncrease; decrease if onDecrease),
 *  and reset the escalation timer so the new band's escalation starts fresh. */
async function applyBandTransition(
  rule: DbRule,
  reading: Reading,
  st: { id: string; notificationId: string | null; firingSeverity: string | null },
  newSeverity: string,
  now: Date,
  /** Per-tier met-since runs as of this tick (banded rules). */
  bandMetSince?: Record<string, number> | null,
): Promise<void> {
  const prevRank = severityRank(st.firingSeverity ?? rule.severity);
  const increased = severityRank(newSeverity) > prevRank;
  const policy = bandNotifyOf(rule);
  const tier = tierForSeverity(rule, newSeverity);

  const detail = ruleWantsAssetDetail(rule) && reading.assetId ? await assetDetail(reading.assetId) : null;
  const parts = readingContextParts(rule, reading, now);
  parts.severity = newSeverity;
  const ctx = buildTemplateContext({ ...parts, assetDetail: detail });
  const message = renderMessage(rule, reading, ctx);
  ctx["message"] = message;

  // Update the live alert in place (one alert per asset). Reset the escalation
  // progress and stamp bandSince so the new band's escalation timers restart
  // from band-entry (the sweep measures tier delays from bandSince ?? triggeredAt).
  if (st.notificationId) {
    await prisma.notification.updateMany({
      where: { id: st.notificationId, cleared: false },
      data: { severity: newSeverity, message, escalationState: { tiers: {}, bandSince: now.toISOString() } as any, ...(ruleWantsContext(rule) ? { templateCtx: ctx as any } : {}) },
    });
  }
  await prisma.notificationRuleState.update({
    where: { id: st.id },
    data: {
      firingSeverity: newSeverity,
      lastValue: typeof reading.value === "number" ? reading.value : null,
      recoveredSince: null,
      ...(bandMetSince !== undefined ? { bandMetSince: metSinceJson(bandMetSince) } : {}),
    },
  });

  if ((increased && policy.onIncrease) || (!increased && policy.onDecrease)) {
    if (st.notificationId) await enqueueAlertActions(st.notificationId, tier.actions, ctx, rule, reading);
    await logEvent({
      action: increased ? "notification.escalated" : "notification.deescalated",
      resourceType: "notification",
      resourceId: st.notificationId ?? undefined,
      resourceName: rule.name,
      actor: "system:notification-engine",
      level: severityLevel(newSeverity),
      message,
      details: { ruleId: rule.id, assetId: reading.assetId || null, dimension: reading.dimKey, severity: newSeverity, from: st.firingSeverity },
    }).catch(() => {});
  }
}

/** Resolved (below tier 0): optionally send an all-clear before recovering. */
async function fireResolved(
  rule: DbRule,
  reading: Reading,
  st: { id: string; notificationId: string | null; firingSeverity: string | null },
  now: Date,
): Promise<void> {
  const policy = bandNotifyOf(rule);
  if (!policy.onResolved || !st.notificationId) return;
  const actions = policy.resolvedMode === "dedicated" ? policy.resolvedActions : tierForSeverity(rule, st.firingSeverity ?? rule.severity).actions;
  if (!actions.length) return;
  const detail = ruleWantsAssetDetail(rule) && reading.assetId ? await assetDetail(reading.assetId) : null;
  const parts = readingContextParts(rule, reading, now);
  parts.severity = "resolved";
  const ctx = buildTemplateContext({ ...parts, assetDetail: detail });
  ctx["message"] = `Resolved: ${rule.name} — ${ctx["asset"] ?? reading.hostname ?? ""} recovered`;
  await enqueueAlertActions(st.notificationId, actions, ctx, rule, reading);
}

async function recover(rule: DbRule, st: { id: string; notificationId: string | null }): Promise<void> {
  // "condition" recovers like "auto": the reset tree (or trigger negation)
  // observed a real recovery, so clear the notification + stamp the event.
  if (rule.reset.mode === "auto" || rule.reset.mode === "condition") {
    await clearActiveNotification(st, "system:auto-resolve");
    await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull } });
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
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull } });
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

/**
 * Timed reset for event/change rules. The two timed sweeps walk
 * NotificationRuleState rows, but the event tail never creates state rows —
 * so without this pass a timed event rule's notifications stayed uncleared
 * forever (and `timed` is the wizard DEFAULT for event triggers). One
 * updateMany per timed event rule per tick — independent of fleet size.
 */
export async function runEventRuleTimedClear(rules: DbRule[], now = new Date()): Promise<number> {
  const timedRules = rules.filter(
    (r) =>
      (r.trigger.type === "event" || r.trigger.type === "change") &&
      r.reset.mode === "timed" &&
      r.reset.afterSec != null,
  );
  let cleared = 0;
  for (const rule of timedRules) {
    const cutoff = new Date(now.getTime() - (rule.reset.afterSec as number) * 1000);
    const res = await prisma.notification.updateMany({
      where: { ruleId: rule.id, cleared: false, triggeredAt: { lte: cutoff } },
      data: { cleared: true, clearedBy: "system:timed", clearedAt: now },
    });
    if (res.count > 0) {
      cleared += res.count;
      await logEvent({
        action: "notification.auto_cleared",
        resourceType: "notification",
        resourceName: rule.name,
        actor: "system:notification-engine",
        message: `Timed reset: cleared ${res.count} alert(s) of "${rule.name}" older than ${rule.reset.afterSec}s`,
        details: { ruleId: rule.id, count: res.count, afterSec: rule.reset.afterSec },
      }).catch(() => {});
    }
  }
  return cleared;
}

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

  // Cooldown pre-pass: the event tail has no per-(rule,asset) state rows, so
  // cooldownSec is enforced against the recent Notification rows themselves —
  // one query for all cooldown-bearing event rules, keyed by the same
  // (rule, assetId-or-resourceName) identity the notifications store. The map
  // updates in-loop so a single 1000-event batch also self-dedupes.
  const cooldownRules = eventRules.filter((r) => r.cooldownSec && r.cooldownSec > 0);
  const lastFired = new Map<string, number>();
  if (cooldownRules.length > 0) {
    const maxCooldownMs = Math.max(...cooldownRules.map((r) => (r.cooldownSec as number) * 1000));
    const recent = await prisma.notification.findMany({
      where: {
        ruleId: { in: cooldownRules.map((r) => r.id) },
        triggeredAt: { gte: new Date(Date.now() - maxCooldownMs) },
      },
      select: { ruleId: true, assetId: true, assetHostname: true, triggeredAt: true },
    });
    for (const n of recent) {
      const key = `${n.ruleId}|${n.assetId ?? n.assetHostname ?? ""}`;
      const t = n.triggeredAt.getTime();
      if ((lastFired.get(key) ?? 0) < t) lastFired.set(key, t);
    }
  }

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
  // Notifications from rules with actions get a client-generated id so we can
  // execute their actions after the batch insert (createMany returns no ids).
  // The fire-time template context rides along — api_call bodies render from it.
  const deliverAfter: { id: string; rule: DbRule; assetId: string | null; ctx: Record<string, string>; assetRegionTags: string[] }[] = [];
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
      // Cooldown: skip when this (rule, asset/resource) fired within
      // cooldownSec — and stamp the map so later events in this batch dedupe.
      if (c.rule.cooldownSec) {
        const cdKey = `${c.rule.id}|${assetId ?? ev.resourceName ?? ""}`;
        const last = lastFired.get(cdKey);
        const evT = ev.timestamp.getTime();
        if (last !== undefined && evT - last < c.rule.cooldownSec * 1000) continue;
        lastFired.set(cdKey, evT);
      }
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
      const hasActions = c.rule.actions.length > 0;
      const id = hasActions ? randomUUID() : undefined;
      if (hasActions && id) {
        deliverAfter.push({ id, rule: c.rule, assetId, ctx, assetRegionTags: regionSnapshot(tags) });
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
    await executeActionsSafe(d.id, d.rule.actions, d.ctx, {
      scopeRegionTags: scopeRegionTagsOf(d.rule.scope),
      assetRegionTags: d.assetRegionTags,
      assetId: d.assetId,
      ruleId: d.rule.id,
      ruleName: d.rule.name,
      ruleEmailComposition: d.rule.emailComposition,
      actor: "system:notification-engine",
    });
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
      emailComposition: (r.emailComposition ?? null) as EmailComposition | null,
      escalation: v2.escalation,
      severityBands: v2.severityBands,
      bandNotify: v2.bandNotify,
    };
  });

  clearAssetDetailCache();

  // Precedence index: which asset_metric/asset_state rules can carve assets out
  // of which (same trigger signature, higher scope specificity). Built once.
  const shadowIndex = buildShadowIndex(rules);

  for (const rule of rules) {
    try {
      if (rule.trigger.type === "composite") {
        await evaluateCompositeRule(rule);
      } else if (rule.trigger.type === "asset_metric" || rule.trigger.type === "asset_state" || rule.trigger.type === "host_metric") {
        await evaluateThresholdRule(rule, shadowIndex);
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

  try {
    await runEventRuleTimedClear(rules);
  } catch (err) {
    await logEvent({ action: "notification.engine_error", actor: "system:notification-engine", level: "error", message: "Event-rule timed clear failed", details: { err: (err as Error)?.message } }).catch(() => {});
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
  /** Composite drafts only — per-condition breakdown, one row per asset.
   *  leafId is the trigger-tree path ("0", "1.2") so the wizard can highlight
   *  its builder rows; noData marks "false because absent", not measured. */
  leaves?: Array<{
    leafId: string;
    label: string;
    met: boolean;
    value: number | string | boolean | null;
    dimension: string;
    noData: boolean;
  }>;
  /** Composite drafts only — "k of n conditions met". */
  conditionsSummary?: string;
  /** Severity bands: the severity this value lands in (null = below tier 0). */
  severity?: string | null;
  /** Precedence: a more-specific same-trigger automation already covers this
   *  asset, so the draft won't alert on it. */
  excludedBy?: { ruleId: string; ruleName: string };
}

/** Precedence carve-out summary for a draft (both authoring directions). */
export interface CarveOutSummary {
  /** Direction 1 — assets carved OUT of this (more-general) draft by existing
   *  higher-rank same-trigger automations. */
  carvedOut?: { count: number; byRule: { ruleId: string; ruleName: string; count: number }[] };
  /** Direction 2 — existing lower-rank same-trigger automations this (more-
   *  specific) draft will remove assets FROM. */
  carvesFrom?: { ruleId: string; ruleName: string; count: number; sampleHostnames: string[] }[];
}

export interface PreviewResult {
  supported: boolean;
  note?: string;
  totalEvaluated: number;
  /** DISTINCT devices behind `totalEvaluated`. A per-dimension metric yields one
   *  reading per sensor / interface / mount, so a fleet of 8 firewalls with 6
   *  temperature sensors each evaluates 48 readings across 8 devices — the
   *  wizard must not report that as "48 devices". Absent for host-only drafts
   *  (no asset scope) and for the unsupported event/change note. */
  totalAssets?: number;
  matches: PreviewMatch[];
  /** Rendered sample of the composed email (first match), when the draft has emailComposition. */
  emailPreview?: { subject: string; text: string; html?: string };
  /** Precedence carve-out (present only for asset_metric/asset_state drafts). */
  carveOut?: CarveOutSummary;
  /** Draft scope specificity (asset-scoped drafts) — drives the wizard's
   *  "Specificity" indicator + explains carve-out ranking. */
  specificity?: { rank: number; label: string };
}

/** A same-signature peer rule for carve-out computation. */
export interface CarveOutPeer {
  id: string;
  name: string;
  scope: RuleScope;
  rank: number;
}

/** Pure carve-out aggregation: given the draft's rank, the assets its scope
 *  matches, and the same-signature peer rules, compute per-asset excludedBy
 *  (direction 1) + the summary (dir 1 + dir 2). No DB access — unit-testable. */
export function carveOutAggregate(
  draftRank: number,
  scopeAssets: ScopeAsset[],
  peers: CarveOutPeer[],
): { excludedBy: Map<string, { ruleId: string; ruleName: string }>; summary: CarveOutSummary } {
  const excludedBy = new Map<string, { ruleId: string; ruleName: string }>();
  const higher = peers.filter((o) => o.rank > draftRank);
  const lower = peers.filter((o) => o.rank < draftRank);

  // Direction 1: assets a higher-rank same-signature rule already covers — the
  // draft won't alert on them. Attribute each to its highest-rank coverer.
  const byRule = new Map<string, { ruleName: string; count: number }>();
  for (const a of scopeAssets) {
    let best: CarveOutPeer | null = null;
    for (const o of higher) {
      if (scopeMatchesAsset(o.scope, a) && (!best || o.rank > best.rank)) best = o;
    }
    if (best) {
      excludedBy.set(a.id, { ruleId: best.id, ruleName: best.name });
      const e = byRule.get(best.id) ?? { ruleName: best.name, count: 0 };
      e.count++;
      byRule.set(best.id, e);
    }
  }

  // Direction 2: lower-rank rules this (more-specific) draft will carve assets
  // from — the authoring warning "creating this removes N devices from X".
  const carvesFrom: NonNullable<CarveOutSummary["carvesFrom"]> = [];
  for (const o of lower) {
    const hit = scopeAssets.filter((a) => scopeMatchesAsset(o.scope, a));
    if (hit.length) {
      carvesFrom.push({ ruleId: o.id, ruleName: o.name, count: hit.length, sampleHostnames: hit.slice(0, 5).map((a) => a.hostname ?? a.id) });
    }
  }

  const summary: CarveOutSummary = {};
  if (excludedBy.size) {
    summary.carvedOut = { count: excludedBy.size, byRule: Array.from(byRule.entries()).map(([ruleId, v]) => ({ ruleId, ruleName: v.ruleName, count: v.count })) };
  }
  if (carvesFrom.length) summary.carvesFrom = carvesFrom;
  return { excludedBy, summary };
}

/** Compute the precedence carve-out for a draft against the other enabled
 *  same-signature rules (both authoring directions): fetch peers, delegate to
 *  the pure carveOutAggregate. */
async function computeCarveOut(
  input: PreviewRuleInput,
  scopeAssets: ScopeAssetRow[],
): Promise<{ excludedBy: Map<string, { ruleId: string; ruleName: string }>; summary: CarveOutSummary }> {
  const sig = input.trigger ? triggerSignature(input.trigger) : null;
  if (!sig || scopeAssets.length === 0) return { excludedBy: new Map(), summary: {} };

  const others = await prisma.notificationRule.findMany({
    where: { enabled: true, ...(input.id ? { id: { not: input.id } } : {}) },
    select: { id: true, name: true, trigger: true, scope: true },
  });
  const peers: CarveOutPeer[] = others
    .filter((o) => triggerSignature(o.trigger as unknown as Trigger) === sig)
    .map((o) => ({ id: o.id, name: o.name, scope: (o.scope ?? {}) as RuleScope, rank: scopeRank((o.scope ?? {}) as RuleScope) }));
  if (peers.length === 0) return { excludedBy: new Map(), summary: {} };

  return carveOutAggregate(scopeRank(input.scope), scopeAssets, peers);
}

/** Dry-run a draft rule against current data with NO writes. A draft without
 *  a trigger is a SCOPE-ONLY preview: list the devices the scope matches
 *  (the wizard's asset-filtering step). */
/** Draft DbRule assembled from a preview input — what both preview paths render templates against. */
function draftRuleForPreview(input: PreviewRuleInput, trigger: DbRule["trigger"]): DbRule {
  return {
    id: "", name: input.name, description: input.description ?? null, severity: input.severity,
    trigger, scope: input.scope,
    reset: input.reset, actions: input.actions, cooldownSec: input.cooldownSec ?? null,
    messageTemplate: input.messageTemplate ?? null,
    emailComposition: input.emailComposition, escalation: normalizeEscalationToV2(input.escalation),
    severityBands: input.severityBands, bandNotify: input.bandNotify,
  };
}

/**
 * Rendered composed-email sample for a preview — templates only, no recipient
 * resolution. Direct asset fetch (not the per-tick cache — preview runs in
 * the web process).
 */
async function renderPreviewEmail(
  draft: DbRule,
  composition: NonNullable<PreviewRuleInput["emailComposition"]>,
  sample: Reading,
  fireInfo?: CompositeFireInfo,
): Promise<NonNullable<PreviewResult["emailPreview"]>> {
  const detail = sample.assetId
    ? await prisma.asset.findUnique({ where: { id: sample.assetId }, select: ASSET_DETAIL_SELECT })
    : null;
  const ctx = buildTemplateContext({
    ...readingContextParts(draft, sample, new Date(), fireInfo),
    assetDetail: detail ? { ...detail, status: String(detail.status) } : null,
  });
  ctx["message"] = renderMessage(draft, sample, ctx);
  const composed = buildComposedEmail(composition, ctx);
  return { subject: composed.subject, text: composed.text, html: composed.html };
}

export async function previewRule(input: PreviewRuleInput): Promise<PreviewResult> {
  const trigger = input.trigger;
  let readings: Reading[] = [];

  if (!trigger) {
    const assets = await loadScopeAssets(input.scope);
    return {
      supported: true,
      totalEvaluated: assets.length,
      totalAssets: assets.length,
      matches: assets.slice(0, 200).map((a) => ({
        assetId: a.id,
        hostname: a.hostname,
        dimension: "",
        value: null,
        meets: true,
      })),
    };
  }

  if (trigger.type === "composite") {
    return previewCompositeRule(trigger, input);
  }

  let scopeAssets: ScopeAssetRow[] = [];
  if (trigger.type === "host_metric") {
    const r = await resolveHostMetricReading(trigger);
    readings = r ? [r] : [];
  } else if (trigger.type === "asset_metric") {
    scopeAssets = await loadScopeAssets(input.scope);
    readings = await resolveAssetMetricReadings(trigger, scopeAssets);
  } else if (trigger.type === "asset_state") {
    scopeAssets = await loadScopeAssets(input.scope);
    readings = await resolveAssetStateReadings(trigger, scopeAssets);
  } else {
    return { supported: false, note: "Event and change rules fire on new audit events; there's nothing to preview against current data.", totalEvaluated: 0, matches: [] };
  }

  // Severity bands: the tier a value lands in (numeric triggers only).
  const banded = !!(input.severityBands && input.severityBands.length) && (trigger.type === "asset_metric" || trigger.type === "host_metric");
  const bandSevOf = (v: number | string | boolean | null): string | null =>
    banded && (trigger.type === "asset_metric" || trigger.type === "host_metric")
      ? severityForValue(trigger.operator, trigger.threshold, input.severity as Severity, input.severityBands as SeverityBand[], typeof v === "number" ? v : null)
      : null;

  const showHysteresis = input.reset.mode === "auto" && input.reset.clearThreshold != null;
  const matches: PreviewMatch[] = readings.map((r) => {
    const meets = readingMeets(trigger, r.value);
    const base: PreviewMatch = { assetId: r.assetId || null, hostname: r.hostname, dimension: r.dimLabel, value: r.value, meets };
    if (banded) base.severity = bandSevOf(r.value);
    if (showHysteresis) {
      const wouldClear = recoveredMeets(trigger, input.reset, r.value);
      base.wouldClear = wouldClear;
      base.inDeadBand = !meets && !wouldClear;
    }
    return base;
  });
  matches.sort((a, b) => Number(b.meets) - Number(a.meets));

  // Precedence carve-out (both authoring directions) for asset-scoped drafts.
  const { excludedBy, summary: carveOut } = await computeCarveOut(input, scopeAssets);
  if (excludedBy.size) {
    for (const m of matches) {
      if (m.assetId && excludedBy.has(m.assetId)) m.excludedBy = excludedBy.get(m.assetId);
    }
  }

  // Rendered sample of the composed email against the best reading (first
  // matching, else first evaluated) — templates only, no recipient resolution.
  let emailPreview: PreviewResult["emailPreview"];
  if (input.emailComposition && readings.length > 0) {
    const draft = draftRuleForPreview(input, trigger);
    const sample = readings.find((r) => readingMeets(trigger, r.value)) ?? readings[0];
    emailPreview = await renderPreviewEmail(draft, input.emailComposition, sample);
  }

  return {
    supported: true,
    totalEvaluated: readings.length,
    // Per-dimension metrics fan out to several readings per device; the device
    // count is what the wizard headlines. Host drafts have no asset scope.
    ...(trigger.type === "host_metric"
      ? {}
      : { totalAssets: new Set(readings.map((r) => r.assetId).filter(Boolean)).size }),
    matches: matches.slice(0, 200),
    emailPreview,
    ...(carveOut.carvedOut || carveOut.carvesFrom ? { carveOut } : {}),
    ...(trigger.type === "asset_metric" || trigger.type === "asset_state"
      ? { specificity: { rank: scopeRank(input.scope), label: scopeRankLabel(scopeRank(input.scope)) } }
      : {}),
  };
}

/** Composite dry-run: one PreviewMatch per asset with a per-leaf breakdown
 *  (met / measured-false / noData) in tree order. Suppression is NOT applied —
 *  preview answers "would this fire on current data", not "is it silenced". */
async function previewCompositeRule(trigger: CompositeTrigger, input: PreviewRuleInput): Promise<PreviewResult> {
  const assets = trigger.kind === "host" ? [HOST_PSEUDO_ASSET] : await loadScopeAssets(input.scope);
  const leaves = collectLeafRefs(trigger);
  const truths = await resolveLeafTruths(leaves, assets);

  const matches: PreviewMatch[] = [];
  let evaluated = 0;
  const outcomes = new Map<string, CompositeOutcome>();
  for (const a of assets) {
    const outcome = compositeOutcomeForAsset(trigger, a.id, leaves, truths);
    if (!outcome.hasAnyReading) continue; // nothing measured — not evaluated
    outcomes.set(a.id, outcome);
    evaluated++;
    matches.push({
      assetId: a.id || null,
      hostname: a.hostname,
      dimension: "",
      value: null,
      meets: outcome.meets,
      leaves: leaves.map(({ leafId, leaf }) => {
        const t = truths.get(leafId)?.get(a.id);
        const src = t?.witness ?? t?.sample ?? null;
        return {
          leafId,
          label: leafConditionLabel(leaf),
          met: t?.met === true,
          value: src?.value ?? null,
          dimension: src?.dimLabel ?? "",
          noData: !t?.hasReading,
        };
      }),
      conditionsSummary: `${outcome.metLeaves.length} of ${outcome.totalLeaves} conditions met`,
    });
  }
  matches.sort((a, b) => Number(b.meets) - Number(a.meets));

  let emailPreview: PreviewResult["emailPreview"];
  if (input.emailComposition && matches.length > 0) {
    const draft = draftRuleForPreview(input, trigger);
    const best = matches[0];
    const outcome = outcomes.get(best.assetId ?? "")!;
    const sample: Reading = { assetId: best.assetId ?? "", hostname: best.hostname, tags: [], dimKey: "", dimLabel: "", value: null };
    emailPreview = await renderPreviewEmail(draft, input.emailComposition, sample, compositeFireInfo(outcome));
  }

  // Composite drafts already evaluate ONE row per asset, so the two counts agree.
  return {
    supported: true,
    totalEvaluated: evaluated,
    ...(trigger.kind === "host" ? {} : { totalAssets: evaluated }),
    matches: matches.slice(0, 200),
    emailPreview,
  };
}
