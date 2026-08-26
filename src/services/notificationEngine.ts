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
import { triggerSummary } from "../utils/triggerSummary.js";
import { eventSubjectLabel } from "../utils/alertSubject.js";
import { sensorReadingDisplay } from "./alertChartService.js";
import { REGION_TAG_PREFIX } from "./notificationService.js";
import {
  type Trigger,
  type RuleScope,
  type PreviewRuleInput,
  type EmailComposition,
  type EscalationV2Config,
  type ResetConfig,
  type RepeatConfig,
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
  probeLossWindowSec,
  DEVICE_FILTER_DIMENSIONS,
  deviceFilterMatch,
  type DeviceFilterAsset,
} from "./notificationTypes.js";
import { scopeMatchesAsset, type ScopeAsset } from "./notificationRuleService.js";
import { ipInCidr } from "../utils/cidr.js";
import { computeStorageForecast } from "./storageForecastService.js";
import { buildComposedEmail, scopeRegionTagsOf } from "./notificationRecipientService.js";
import { executeActions, type ActionExecContext } from "./automationActionService.js";
import { queryProbeLossRatios } from "./probeLossQuery.js";
import { alarmStatusToFlag } from "../utils/hardwareSensors.js";
import { median } from "../utils/stats.js";
import {
  buildTemplateContext,
  renderNotificationTemplate,
  templateNeedsAsset,
  setRecoverySentence,
  notificationsPageUrl,
  type AssetTemplateDetail,
  type TemplateContextParts,
} from "../utils/notificationTemplate.js";

const LAST_EVENT_SETTING_KEY = "notificationEngine.lastEventCursor";
const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000; // window to find the "latest" sample

// probeLossPct is a windowed RATIO, so its window is the measurement rather than
// a lookback (business rule 29). The resolution (configured window floored at 5
// min, defaulted to 15) lives in notificationTypes as `probeLossWindowSec`,
// SHARED with the alert-email loss chart so the chart's window can never
// disagree with the window the alert was measured over.

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
  /** Actions to run when the alert ENDS; null = nothing happens on reset. */
  resetActions: AutomationAction[] | null;
  /** Re-send while unhandled; null = never repeats. Read by ruleWantsContext —
   *  a repeat-only rule still needs its templateCtx snapshot. */
  repeat: RepeatConfig | null;
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
  // Read by the device-identifier dimension filters (applyDeviceFilters).
  macAddress?: string | null;
  // Read by every interface resolver — state trio AND counter metrics — for
  // the pinned-interface gate (interfaceIsPinned).
  monitoredInterfaces?: string[];
  // Read by both IPsec resolvers (ipsecStatus / ipsecThroughputBps) for the
  // pinned-tunnel gate (tunnelIsPinned).
  monitoredIpsecTunnels?: string[];
  // Read ONLY by the builder's device-list preview (optional so the pseudo-host
  // row can omit it). The engine never filters on it — see SCOPE_SELECT.
  monitored?: boolean;
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
  // string columns, still a tight select at 2000 assets. macAddress feeds the
  // device-identifier dimension filters (applyDeviceFilters) alongside
  // hostname / ipAddress / manufacturer / model.
  manufacturer: true, model: true, os: true, macAddress: true,
  // Every interface reading is restricted to PINNED interfaces.
  monitoredInterfaces: true,
  // Every IPsec tunnel reading is restricted to PINNED tunnels (tunnelIsPinned).
  monitoredIpsecTunnels: true,
  // Read by the BUILDER's device preview only, which reports monitored devices
  // separately from the unmonitored remainder. The engine never FILTERS on it:
  // event and change triggers fire on unmonitored devices by design, and a
  // contact still owns a device nobody polls.
  monitored: true,
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

/**
 * Is the device currently ANSWERING us? — the gate on packet-loss alerting
 * (business rule 29). Reads the five-state monitor machine, which is driven by
 * consecutiveFailures/Successes against `failureThreshold` (default 3):
 *
 *   up         → answering. Alerts.
 *   warning    → answering, with 1..threshold-1 failures behind it. ALERTS, and
 *                deliberately so: intermittent loss on a device that still
 *                replies IS the thing packet loss is meant to catch, and it is
 *                the state a lossy-but-alive device sits in (an alternating
 *                pass/fail device never reaches `down`). Gating on `up` alone
 *                would silence the feature's whole reason for existing.
 *   down       → not answering. The outage is asset-down's alert, not a second
 *                one about the probes it swallowed.
 *   recovering → came back but hasn't held for threshold successes; asset-down
 *                is still live, so this is the tail of that same outage.
 *   unknown    → never probed (UI "Pending") — nothing measured yet.
 *   passive    → no down-detection automation covers the device, so Polaris
 *                renders no verdict about it. NOT answering, for the reason
 *                this gate exists: a dark passive device sits at 100% loss
 *                indefinitely and there is no asset-down alert to supersede
 *                the loss alert (that is precisely what is missing), so
 *                admitting it would park a permanently-firing, never-clearing
 *                alert on every device an operator just told Polaris to stop
 *                judging. "Stop judging these" must not quietly become "judge
 *                them by a different metric".
 *
 * A null status is treated as not answering: it means the same thing `unknown`
 * does on a row written before the column existed.
 */
export function assetIsAnsweringProbes(a: { monitorStatus: string | null }): boolean {
  return a.monitorStatus === "up" || a.monitorStatus === "warning";
}

/**
 * Metrics whose readings only mean something while the device answers, so a
 * non-answering device produces none. Just `probeLossPct` today: its INPUT is
 * failed probes, which is what makes it the one metric that can fire about an
 * outage the asset-down alert already owns. Every other metric is derived from
 * SUCCESSFUL polls, so a dark device simply stops producing readings and its
 * alerts freeze rather than newly firing.
 */
const ANSWERING_ONLY_METRICS = new Set<string>(["probeLossPct"]);

/** Does this trigger's metric need an answering device (see above)? */
function triggerNeedsAnsweringDevice(trigger: Trigger): boolean {
  return trigger.type === "asset_metric" && ANSWERING_ONLY_METRICS.has(trigger.metric);
}

/**
 * An interface alert only ever concerns a MONITORED interface — the pin set in
 * `Asset.monitoredInterfaces` (the same join the Down Interfaces widget uses).
 * A device reports every port it has, most of them idle or unplugged, so an
 * ungated interface rule turns one switch into a page of alerts about ports
 * nobody selected. The pin IS the operator's statement of which ports matter,
 * so it is the default and there is no opt-out: an interface an operator cares
 * about enough to alert on is one they pinned, and un-pinning is how alerting
 * stops (the vanished-state sweep then clears the alert).
 *
 * The interface STATE trio (ifOperStatus / ifAdminStatus / poeStatus) has
 * always gated here. The four COUNTER metrics did not: they read
 * `AssetInterfaceSample`, which became pinned-only in the 2026-08 cutover, so
 * they were gated incidentally by what the sampler writes rather than by any
 * rule of their own — which leaves the window between un-pinning an interface
 * and its last rows aging out (plus every pre-cutover row still inside the
 * lookback) able to fire an alert about a port that is no longer monitored.
 * Gating explicitly closes that and makes the rule one thing rather than a
 * property of a storage decision that could change again.
 */
export function interfaceIsPinned(asset: { monitoredInterfaces?: string[] } | undefined, ifName: string): boolean {
  return asset?.monitoredInterfaces?.includes(ifName) ?? false;
}

/**
 * The IPsec analogue of interfaceIsPinned: only tunnels the operator PINNED
 * (`Asset.monitoredIpsecTunnels`) may produce readings. Unlike interfaces,
 * whose sample table became pinned-only in the 2026-08 cutover, the IPsec
 * stream still writes every tunnel the gate reports on the full system-info
 * scrape (`cadence:"slow"`, 24h retention) — so without this gate an
 * `ipsecStatus`/`ipsecThroughputBps` rule fires on tunnels nobody selected
 * for monitoring, always, because those slow rows are refreshed every scrape
 * and never age past the engine's lookback. The pin is the operator's
 * statement of which tunnels may alert, same as ports. A tunnel that leaves
 * the pin set stops producing readings; the vanished-state sweep clears its
 * alert (`system:out-of-scope`).
 */
export function tunnelIsPinned(asset: { monitoredIpsecTunnels?: string[] } | undefined, tunnelName: string): boolean {
  return asset?.monitoredIpsecTunnels?.includes(tunnelName) ?? false;
}

/**
 * The pin test for a trigger whose dimensions are PIN-gated (interfaces /
 * IPsec tunnels), or null when they aren't. The vanished-state sweep uses it
 * to tell a configuration edge from a collection gap: an unpinned dimension
 * produces no readings BY THE OPERATOR'S OWN HAND, so its firing row may
 * clear even on a tick where the asset reported nothing at all — without
 * this, unpinning a device's only alerting interface stranded the alert
 * forever, because the no-readings freeze (which exists for genuine scrape
 * gaps) also swallowed the unpin.
 */
function pinTestForTrigger(trigger: Trigger): ((asset: ScopeAssetRow, dimKey: string) => boolean) | null {
  if (trigger.type === "asset_metric") {
    if (trigger.metric === "ifInBps" || trigger.metric === "ifOutBps" || trigger.metric === "ifInErrorRate" || trigger.metric === "ifOutErrorRate") return interfaceIsPinned;
    if (trigger.metric === "ipsecThroughputBps") return tunnelIsPinned;
  } else if (trigger.type === "asset_state") {
    if (trigger.field === "ifOperStatus" || trigger.field === "ifAdminStatus" || trigger.field === "poeStatus") return interfaceIsPinned;
    if (trigger.field === "ipsecStatus") return tunnelIsPinned;
  }
  return null;
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

/**
 * The device-identifier dimensions (hostname / IP / MAC / manufacturer /
 * model — DEVICE_FILTER_DIMENSIONS): narrow the ASSET SET before any sample
 * query runs. Every asset_metric and asset_state trigger takes them — they
 * name the device rather than a sub-asset, and they exist so a composite tree
 * can mix device-specific branches in one automation. The predicate itself is
 * notificationTypes.deviceFilterMatch, shared with getMetricSeverityTiers so
 * chart shading can't disagree with what evaluates. No patterns set = no
 * filtering (skipped without allocating). Exported for unit tests.
 */
export function applyDeviceFilters<T extends DeviceFilterAsset>(
  assets: T[],
  df: Parameters<typeof deviceFilterMatch>[0],
): T[] {
  if (!df) return assets;
  const rec = df as Record<string, string | undefined>;
  if (!DEVICE_FILTER_DIMENSIONS.some((d) => rec[d])) return assets;
  return assets.filter((a) => deviceFilterMatch(df, a));
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
    else if (aggregation === "median") value = median(g.values);
    else if (aggregation === "min") value = g.values.length ? Math.min(...g.values) : null;
    else if (aggregation === "max") value = g.values.length ? Math.max(...g.values) : null;
    else value = g.latest.v; // latest
    out.push({ assetId: g.asset.id, hostname: g.asset.hostname, tags: g.asset.tags, dimKey: g.dimKey, dimLabel: g.dimLabel, value });
  }
  return out;
}

async function resolveAssetMetricReadings(trigger: Extract<Trigger, { type: "asset_metric" }>, assets: ScopeAssetRow[]): Promise<Reading[]> {
  const df = trigger.dimensionFilter ?? {};
  // The device-identifier dimensions narrow the ASSET set before any sample
  // query — every metric takes them (they name the device rather than a
  // sub-asset), which is what lets a composite tree mix device-specific branches.
  assets = applyDeviceFilters(assets, df);
  const ids = assets.map((a) => a.id);
  if (ids.length === 0) return [];
  const index = new Map(assets.map((a) => [a.id, a]));
  const since = new Date(Date.now() - Math.max(trigger.windowSec * 1000, DEFAULT_LOOKBACK_MS));
  const agg = trigger.aggregation;
  const num = (b: bigint | null | undefined): number | null => (b === null || b === undefined ? null : Number(b));

  switch (trigger.metric) {
    case "cpuPct": case "memPct": case "memUsedBytes": case "sessionCount": {
      const rows = await prisma.assetTelemetrySample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, cpuPct: true, memPct: true, memUsedBytes: true, sessionCount: true } });
      const pick = (r: any) => trigger.metric === "memUsedBytes" ? num(r.memUsedBytes) : (r[trigger.metric] ?? null);
      return reduceReadings(rows, index, () => "", () => "", pick, agg);
    }
    case "responseTimeMs": case "uptimeSec": {
      // Response-time poll only (probeKind): the ICMP loss sampler writes a
      // NULL responseTimeMs and never reads uptime, so its rows would only add
      // scan cost — and an automation on response time must never see another
      // transport's timing.
      const rows = await prisma.assetMonitorSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since }, OR: [{ probeKind: null }, { probeKind: "primary" }] }, select: { assetId: true, timestamp: true, responseTimeMs: true, uptimeSec: true } });
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
      // ONLY devices that are currently answering (up / warning) produce a loss
      // reading — a down or recovering device's failures are its outage, and
      // asset-down alerts on that (business rule 29, assetIsAnsweringProbes).
      // Filtered here rather than at the caller so the composite-trigger path
      // gets the same gate from the same place; evaluateThresholdRule
      // separately clears any live loss alert on the assets this drops.
      const answering = assets.filter(assetIsAnsweringProbes).map((a) => a.id);
      if (answering.length === 0) return [];
      // `windowSec` IS the measurement period here (the wizard calls it History),
      // so the 15-minute DEFAULT_LOOKBACK floor every other metric needs — to be
      // sure a `latest` reading finds a recent sample — must NOT apply: it would
      // silently measure a 5-minute History over 15. Use the configured window
      // exactly, floored only at PROBE_LOSS_MIN_WINDOW_SEC so a ratio always has
      // a few probes behind it, and defaulted when the trigger carries none
      // (pre-History rules, where the minutes went to forDurationSec instead,
      // and hand-written ones).
      const lossWindowSec = probeLossWindowSec(trigger.windowSec);
      const sinceMinutes = lossWindowSec / 60;
      const rows = await queryProbeLossRatios({ sinceMinutes, assetIds: answering });
      // Emit the true ratio for every asset with at least one successful probe,
      // INCLUDING 0% (no failures) so an auto-clear/hysteresis rule recovers.
      // Fully-down assets (0 successes) are dropped by the shared query —
      // asset-down owns them, matching the widget. The ratio is measured from
      // the later of that asset's FIRST SUCCESSFUL probe in the window and the
      // end of its last outage (Asset.recoveryStartedAt) rather than the
      // window's edge (see probeLossQuery's header), so a device recovering
      // from an outage reads 0% on its first clean probe instead of reading the
      // outage back as loss for a whole window's worth of ticks — whether the
      // outage was still running at the window's edge or started inside it.
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
    case "hwSensorAlarm": {
      // The device's OWN alarm bit, read off the column the hardware-sensor
      // collectors already populate — no extra walk, no operator configuration,
      // and it works on every transport that fills it (FortiOS REST sensor-info
      // and the SNMP fgHwSensorTable alike). Same per-sensor dimension and the
      // same dimensionFilter predicate as hwSensorValue, so a rule can target one
      // named sensor or a whole class.
      const rows = await prisma.assetHardwareSensorSample.findMany({
        where: {
          assetId: { in: ids },
          timestamp: { gte: since },
          ...(df.sensorClass ? { sensorClass: df.sensorClass } : {}),
          // Sources that publish no alarm bit (ENTITY-SENSOR-MIB, the FortiAP
          // controller path) leave this NULL. Excluded in SQL so those sensors
          // produce no readings at all rather than being mapped to a value —
          // see alarmStatusToFlag's contract.
          alarmStatus: { not: null },
        },
        select: { assetId: true, timestamp: true, sensorName: true, sensorClass: true, alarmStatus: true },
      });
      const filtered = df.sensorNamePattern ? rows.filter((r) => hwSensorFilterMatches(df, r)) : rows;
      return reduceReadings(
        filtered,
        index,
        (r) => r.sensorName,
        (r) => `${r.sensorName} (${r.sensorClass})`,
        (r) => alarmStatusToFlag(r.alarmStatus),
        agg,
      );
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
      // `|| null` here would map a legitimate reading of 0 to "no reading",
      // which silently breaks both directions of any rule about zero: a
      // "== 0" / "<= 0" condition could never fire, and an auto-reset rule
      // could never clear because the recovery value is the one being dropped.
      // Only genuinely non-numeric JSON becomes null.
      return reduceReadings(rows, index, (r) => r.widgetId, (r) => r.widgetId, (r) => {
        const n = typeof r.value === "number" ? r.value : Number(r.value);
        return Number.isFinite(n) ? n : null;
      }, agg);
    }
    case "customStateValue": {
      // 0/1 state-probe readings (utils/stateProbes). One dimension per probe
      // ROW, so every sensor / PSU / fan tray carries its own firing state and
      // its own alert — keyed on rowKey (the stable OID index) while the LABEL
      // is what the operator filters and reads, so renaming a row keeps its
      // alert. probeId is an exact match (a registry key), the row pattern is
      // substring-matched like every other *Pattern dimension.
      const rows = await prisma.assetStateSample.findMany({
        where: {
          assetId: { in: ids },
          timestamp: { gte: since },
          ...(df.stateProbeId ? { probeId: df.stateProbeId } : {}),
        },
        select: { assetId: true, timestamp: true, probeId: true, rowKey: true, rowLabel: true, value: true },
      });
      const filtered = df.stateRowPattern ? rows.filter((r) => substringMatch(r.rowLabel, df.stateRowPattern)) : rows;
      return reduceReadings(
        filtered,
        index,
        (r) => `${r.probeId}|${r.rowKey}`,
        (r) => r.rowLabel,
        (r) => (r.value === 0 || r.value === 1 ? r.value : null),
        agg,
      );
    }
    case "ifInBps": case "ifOutBps": case "ifInErrorRate": case "ifOutErrorRate": {
      const col = trigger.metric === "ifInBps" ? "inOctets" : trigger.metric === "ifOutBps" ? "outOctets" : trigger.metric === "ifInErrorRate" ? "inErrors" : "outErrors";
      const mult = trigger.metric === "ifInBps" || trigger.metric === "ifOutBps" ? 8 : 1; // octets→bits
      const rows = await prisma.assetInterfaceSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: { timestamp: "desc" }, select: { assetId: true, timestamp: true, ifName: true, inOctets: true, outOctets: true, inErrors: true, outErrors: true } });
      // Pinned interfaces only (interfaceIsPinned) — the same default the
      // ifOperStatus/ifAdminStatus/poeStatus resolvers apply. See its header for
      // why the pinned-only sample table isn't a gate by itself.
      const filtered = rows.filter((r) => interfaceIsPinned(index.get(r.assetId), r.ifName) && substringMatch(r.ifName, df.ifNamePattern));
      return rateReadings(filtered, index, (r) => r.ifName, (r) => r.ifName, (r) => num((r as any)[col]), mult);
    }
    case "ipsecThroughputBps": {
      const rows = await prisma.assetIpsecTunnelSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: { timestamp: "desc" }, select: { assetId: true, timestamp: true, tunnelName: true, incomingBytes: true, outgoingBytes: true } });
      // Pinned tunnels only (tunnelIsPinned) — the sample table carries every
      // tunnel the gate reports (unpinned rows ride cadence="slow"), so the
      // gate has to live here, same as the interface resolvers.
      const filtered = rows.filter((r) => tunnelIsPinned(index.get(r.assetId), r.tunnelName) && substringMatch(r.tunnelName, df.tunnelName));
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
  const df = trigger.dimensionFilter ?? {};
  assets = applyDeviceFilters(assets, df); // same asset-set narrowing as the metric resolver
  const index = new Map(assets.map((a) => [a.id, a]));
  const ids = assets.map((a) => a.id);
  const mk = (a: ScopeAssetRow, dimKey: string, dimLabel: string, value: any): Reading => ({ assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey, dimLabel, value });

  switch (trigger.field) {
    case "monitorStatus": return assets.map((a) => mk(a, "", "", a.monitorStatus));
    case "status": return assets.map((a) => mk(a, "", "", a.status));
    case "consecutiveFailures": return assets.map((a) => mk(a, "", "", a.consecutiveFailures));
    case "dependencySuppressed": return assets.map((a) => mk(a, "", "", a.dependencySuppressed));
    case "quarantined": return assets.map((a) => mk(a, "", "", a.quarantinedAt !== null || a.status === "quarantined"));
    case "ifOperStatus": case "ifAdminStatus": case "poeStatus": {
      const col = trigger.field === "ifOperStatus" ? "operStatus"
        : trigger.field === "ifAdminStatus" ? "adminStatus"
        : "poeStatus";
      const since = new Date(Date.now() - DEFAULT_LOOKBACK_MS);
      const rows = await prisma.assetInterfaceSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: [{ assetId: "asc" }, { ifName: "asc" }, { timestamp: "desc" }], distinct: ["assetId", "ifName"], select: { assetId: true, ifName: true, operStatus: true, adminStatus: true, poeStatus: true } });
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
        if (!interfaceIsPinned(a, r.ifName)) return false;
        if (trigger.field === "ifOperStatus" && r.adminStatus !== "up") return false;
        // A port with no PSE reports nothing — a null is "not a PoE port",
        // not "PoE is off", and a rule like `poeStatus is-not delivering`
        // would otherwise fire on every uplink and SVI on the switch.
        if (trigger.field === "poeStatus" && r.poeStatus == null) return false;
        // "disabled" is an operator's choice, the PoE analogue of the
        // admin-up gate above. Excluding it keeps a not-delivering rule from
        // alerting on ports PoE was deliberately turned off for. A fault rule
        // is unaffected: a disabled port reports "disabled", never "fault".
        if (trigger.field === "poeStatus" && r.poeStatus === "disabled") return false;
        return substringMatch(r.ifName, df.ifNamePattern);
      }).map((r) => { const a = index.get(r.assetId)!; return mk(a, r.ifName, r.ifName, (r as any)[col]); });
    }
    case "ipsecStatus": {
      const since = new Date(Date.now() - DEFAULT_LOOKBACK_MS);
      const rows = await prisma.assetIpsecTunnelSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: [{ assetId: "asc" }, { tunnelName: "asc" }, { timestamp: "desc" }], distinct: ["assetId", "tunnelName"], select: { assetId: true, tunnelName: true, status: true } });
      // Only PINNED tunnels produce readings (Asset.monitoredIpsecTunnels) —
      // the full system-info scrape samples every tunnel the gate reports, and
      // an unpinned tunnel is one nobody selected for monitoring, so a "tunnel
      // down" rule must not alert on it. See tunnelIsPinned.
      return rows.filter((r) => tunnelIsPinned(index.get(r.assetId), r.tunnelName) && substringMatch(r.tunnelName, df.tunnelName)).map((r) => { const a = index.get(r.assetId)!; return mk(a, r.tunnelName, r.tunnelName, r.status); });
    }
    case "sdwanRuleStatus": case "sdwanSelectedMember": {
      const rows = await prisma.assetSdwanRule.findMany({ where: { assetId: { in: ids } }, select: { assetId: true, ruleName: true, status: true, selectedMember: true } });
      const col = trigger.field === "sdwanRuleStatus" ? "status" : "selectedMember";
      // sdwanRulePattern narrows to the named rule(s) — without it every rule
      // on the gate is its own alerting dimension, which is the default.
      return rows.filter((r) => substringMatch(r.ruleName, df.sdwanRulePattern)).map((r) => { const a = index.get(r.assetId); if (!a) return null; return mk(a, r.ruleName, r.ruleName, (r as any)[col]); }).filter(Boolean) as Reading[];
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
  else if (trigger.aggregation === "median") value = median(rows.map(valueOf)) ?? NaN;
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
    // "Response time (median over 5 minutes) is 760 ms" — the wizard's own
    // "When should it fire?" wording with the observed value in it, so the
    // alert email says what the number means instead of "responseTimeMs = 760".
    triggerSummary: triggerSummary({
      trigger: trigger as never,
      value: reading.value,
      dimensionLabel: reading.dimLabel || null,
    }),
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
  // `repeat` is in here for a reason that is easy to miss: the sweep renders a
  // reminder from Notification.templateCtx, and without this a repeat-only
  // automation snapshots nothing — so every reminder would fall back to the
  // minimal context built from the row and silently lose {value}, {threshold},
  // {trigger.summary} and every {asset.*} token. The reminder would not look
  // like the email it is reminding you about.
  return !!(rule.emailComposition || ruleHasAnyEscalation(rule) || rule.repeat);
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
  const refs = allRuleActionRefs(rule);
  const actionTemplates = refs.flatMap((r) => templatesOf(r.action));
  // Any notify action can end up on an email channel, and the DEFAULT alert
  // body quotes the device (IP, connected switch/AP, location, model) without
  // the operator typing a single {asset.*} token — so template-sniffing alone
  // would mail blank facts for every automation that never customized
  // anything. Channel types aren't visible here, so this deliberately
  // over-fetches for a push- or chat-only rule: the lookup is per FIRE (which
  // is transition-guarded and rare) and served from the per-tick cache.
  const hasNotify = refs.some((r) => r.action.type === "notify");
  return (
    hasNotify ||
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

/**
 * Does a peer rule genuinely COVER this asset — i.e. could it produce a reading
 * for it at all? Scope alone is not the whole answer: a trigger's device
 * filter (hostname / IP / MAC / manufacturer / model) narrows the asset set
 * just as scope does, so a peer scoped to all assets but filtered to
 * `hostname matches "core-"` covers only the core switches.
 *
 * This used to be scope-only, which was safe while `triggerSignature` pinned
 * the dimensionFilter — two differently-filtered rules were in different
 * signature groups and never compared. Now that monitorStatus rules group by
 * value instead (so down automations with different device filters CAN carve
 * each other out), the filter has to be tested here or a filtered peer would
 * shadow every asset in its scope, including ones it can never fire on.
 *
 * For asset_metric this is a no-op: peers in a signature group have identical
 * filters by construction, so the predicate short-circuits in applyDeviceFilters'
 * "no patterns set" check.
 */
function peerCoversAsset(peer: DbRule, asset: ScopeAsset): boolean {
  if (!scopeMatchesAsset(peer.scope, asset)) return false;
  const df = (peer.trigger as { dimensionFilter?: Parameters<typeof deviceFilterMatch>[0] }).dimensionFilter;
  if (!df) return true;
  const rec = df as Record<string, string | undefined>;
  if (!DEVICE_FILTER_DIMENSIONS.some((d) => rec[d])) return true;
  return deviceFilterMatch(df, asset);
}

/** Does a higher-rank same-signature rule also cover this asset? */
export function isAssetShadowed(index: ShadowIndex, rule: DbRule, sig: string, rank: number, asset: ScopeAsset): boolean {
  const group = index.bySig.get(sig);
  if (!group) return false;
  for (const other of group) {
    if (other.rule.id === rule.id) continue;
    if (other.rank > rank && peerCoversAsset(other.rule, asset)) return true;
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
 * collection gap is not evidence of recovery). The no-readings freeze has one
 * carve-out: a PIN-gated dimension (interface / IPsec tunnel) whose pin is
 * gone clears anyway — the operator unpinning it is a configuration edge,
 * not a collection gap, and without the carve-out unpinning a device's ONLY
 * alerting interface left its alert firing forever (the asset then produces
 * zero readings for the rule, so the freeze swallowed the unpin). Zero extra
 * queries on the steady-state tick — the scope re-check only runs when
 * orphans exist.
 */
async function clearVanishedStates(
  rule: DbRule,
  states: SweepStateRow[],
  seenKeys: Set<string>,
  scopeIds: Set<string>,
  handledIds: Set<string>,
  assetsWithReadings: Set<string>,
  assetIndex: Map<string, ScopeAssetRow>,
): Promise<void> {
  const pinTest = pinTestForTrigger(rule.trigger);
  const vanished: Array<{ st: SweepStateRow; reason: "scope" | "dimension" }> = [];
  const scopeChecks: SweepStateRow[] = [];
  for (const st of states) {
    if (!st.assetId) continue; // host/global rows have no scope to leave
    if (st.state !== "firing" && st.state !== "pending") continue;
    if (seenKeys.has(`${st.assetId}|${st.dimensionKey}`)) continue;
    if (handledIds.has(st.assetId)) continue; // suppressed freeze / carve-out handoff own these
    if (scopeIds.has(st.assetId)) {
      const a = assetIndex.get(st.assetId);
      if (pinTest && st.dimensionKey && a && !pinTest(a, st.dimensionKey)) {
        vanished.push({ st, reason: "dimension" }); // unpinned — config edge, clear even with no readings
      } else if (assetsWithReadings.has(st.assetId)) {
        vanished.push({ st, reason: "dimension" });
      }
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
  // Assets whose device isn't answering, on a rule whose metric needs it to be
  // (packet loss — business rule 29). Handed off to asset-down alerting.
  const notAnsweringIds = new Set<string>();
  // Every asset the scope resolved this tick (incl. suppressed/shadowed);
  // null for host rules, which have no asset scope to leave.
  let scopeIds: Set<string> | null = null;
  // The assets this tick actually evaluated (scope minus suppressed / carved
  // out / not-answering). Hoisted out of the branch below because a custom
  // reset condition resolves its own leaves against them.
  let activeAssets: ScopeAssetRow[] = [];

  if (trigger.type === "host_metric") {
    const r = await resolveHostMetricReading(trigger);
    readings = r ? [r] : [];
    activeAssets = [HOST_PSEUDO_ASSET];
  } else if (trigger.type === "asset_metric" || trigger.type === "asset_state") {
    const assets = await loadScopeAssets(rule.scope);
    scopeIds = new Set(assets.map((a) => a.id));
    // Precedence: only worth checking when this rule isn't already the most
    // specific in its signature group (and the group has a higher-rank peer).
    const sig = shadowIndex ? triggerSignature(rule.trigger) : null;
    const rank = sig ? scopeRank(rule.scope) : 0;
    const shadowable = !!(sig && shadowIndex && (shadowIndex.maxRankBySig.get(sig) ?? 0) > rank);
    const needsAnswering = triggerNeedsAnsweringDevice(trigger);
    const active: ScopeAssetRow[] = [];
    for (const a of assets) {
      if (isSuppressedForNotifications(a)) suppressedIds.add(a.id);
      else if (shadowable && isAssetShadowed(shadowIndex!, rule, sig!, rank, a)) shadowedIds.add(a.id);
      else if (needsAnswering && !assetIsAnsweringProbes(a)) notAnsweringIds.add(a.id);
      else active.push(a);
    }
    activeAssets = active;
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
  // Custom reset conditions: while an alert is firing, this tree is the SOLE
  // recovery authority — the trigger going false does not clear it and the
  // trigger re-meeting does not cancel its sustain timer. Owned by the
  // dedicated pass after this loop, which is why the firing branches below
  // hand recovery off rather than acting on the trigger's own reading.
  const resetTree = rule.reset.mode === "condition" ? (rule.reset.condition ?? null) : null;

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
          // Under a custom reset condition `recoveredSince` is the RESET tree's
          // sustain timer, not this trigger's, so the trigger re-meeting must
          // not cancel it (parity with the composite path's same contract).
          const data: Prisma.NotificationRuleStateUpdateInput = resetTree ? {} : { recoveredSince: null };
          if (hasBands) data.bandMetSince = metSinceJson(metSince);
          if (Object.keys(data).length) await prisma.notificationRuleState.update({ where: { id: st.id }, data });
        } // same band / firing without a pending recovery → already active; suppress
      }
    } else {
      // condition not met for this reading
      if (st && st.state === "pending") {
        await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, bandMetSince: Prisma.DbNull } });
      } else if (st && st.state === "firing") {
        if (resetTree) {
          // The reset tree owns recovery — the trigger falling away is not
          // itself evidence the alert should clear. Handled after this loop.
        } else if (rule.reset.mode !== "auto") {
          // manual re-arms the state; timed waits for its sweep — same as ever.
          await recover(rule, st, reading, now);
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
            await recover(rule, st, reading, now);
          } else if (!st.recoveredSince) {
            // Recovery observed — start the clear-sustain timer.
            await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: now } });
          } else if (now.getTime() - st.recoveredSince.getTime() >= sustainSec * 1000) {
            if (hasBands) await fireResolved(rule, reading, st, now);
            await recover(rule, st, reading, now);
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

  // Devices that stopped answering, on a rule that needs them to (packet loss):
  // a handoff to asset-down alerting, so — like the carve-out and unlike
  // maintenance — the live alert CLEARS rather than freezing. Freezing is what
  // used to leave a packet-loss alert sitting next to the asset-down alert for
  // the whole outage, which is the duplicate operators were seeing.
  //
  // Deliberately no reset actions (matching the carve-out): the alert isn't
  // recovering, and mailing "packet loss resolved" about a device that just went
  // dark would be worse than saying nothing. The Event is the audit trail.
  for (const st of states) {
    if (!st.assetId || !notAnsweringIds.has(st.assetId)) continue;
    if (st.state === "firing") {
      await clearActiveNotification(st, "system:device-down");
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull },
      });
      await logEvent({
        action: "notification.superseded",
        resourceType: "notification",
        resourceId: st.notificationId ?? undefined,
        resourceName: rule.name,
        actor: "system:notification-engine",
        message: `Cleared: ${rule.name} — the device is no longer answering, so its outage is the asset-down alert`,
        details: { ruleId: rule.id, assetId: st.assetId, reason: "device-down" },
      }).catch(() => {});
    } else if (st.state === "pending") {
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null, bandMetSince: Prisma.DbNull },
      });
    }
  }

  // Vanished states: assets that left the scope or dimensions that stopped
  // being reported — the readings loop never sees them, so clear them here
  // (suppressed assets stay frozen, in-scope assets with no readings at all
  // stay frozen; see clearVanishedStates).
  if (scopeIds) {
    const handled = new Set([...suppressedIds, ...shadowedIds, ...notAnsweringIds]);
    const assetsWithReadings = new Set(readings.map((r) => r.assetId).filter(Boolean));
    // activeAssets suffices as the pin-test index: any state row that passes
    // the handled/scope checks belongs to an active asset by construction.
    await clearVanishedStates(rule, states, seen, scopeIds, handled, assetsWithReadings, new Map(activeAssets.map((a) => [a.id, a])));
  }

  // ── Custom reset conditions ──────────────────────────────────────────────
  // Recovery for a condition-reset rule is decided HERE rather than in the
  // readings loop, because the reset tree is the sole authority and its leaves
  // need not be the trigger's metric at all: a firing alert whose trigger
  // stopped reporting entirely must still be able to clear.
  //
  // Firing rows are re-read from the DB rather than taken from `states`, which
  // is a pre-loop snapshot the sweeps above have since invalidated — a row this
  // tick cleared as superseded / out-of-scope must not then be "recovered", and
  // a row that only just fired must not be recovered in the same tick it fired.
  if (resetTree) {
    const firing = (await prisma.notificationRuleState.findMany({ where: { ruleId: rule.id, state: "firing" } }))
      // A suppressed asset (maintenance / dependency-down) is frozen, not
      // recovering — same contract as every other path.
      .filter((st) => !(st.assetId && suppressedIds.has(st.assetId)));
    // Resolve the tree against the FIRING assets only — usually a handful out of
    // the whole scope, and the leaves are separate queries per sample table, so
    // handing them 2000 asset ids to answer a question about three alerts is the
    // difference between a free pass and a fleet-wide scan every 60s. (Same
    // narrowing the composite path does.)
    const firingAssetIds = new Set(firing.map((st) => st.assetId ?? ""));
    const resetAssets = trigger.type === "host_metric"
      ? activeAssets // the host pseudo-asset; host leaf resolvers ignore the list anyway
      : activeAssets.filter((a) => firingAssetIds.has(a.id));
    if (firing.length > 0 && resetAssets.length > 0) {
      const resetLeaves = collectLeafRefs(resetTree);
      const truthAt = await resolveResetTruths(resetLeaves, resetAssets);
      const readingByKey = new Map(readings.map((r) => [`${r.assetId || ""}|${r.dimKey}`, r]));
      for (const st of firing) {
        const assetId = st.assetId ?? "";
        const recovered = evalTriggerTree(resetTree, (leafId) => truthAt(leafId, assetId, st.dimensionKey));
        // The trigger's own reading when there is one (it carries hostname/tags
        // for the reset actions' template), else a reading rebuilt from the row.
        const reading = readingByKey.get(`${assetId}|${st.dimensionKey}`) ?? readingFromState(st);
        await applySustainedRecovery(rule, st, recovered, now, reading, { fireResolvedFirst: hasBands });
      }
    }
  }

  // Timed auto-clear: firing states past their timer, even without an explicit
  // recovery reading (e.g. the asset stopped reporting).
  if (rule.reset.mode === "timed" && rule.reset.afterSec) {
    const afterSec = rule.reset.afterSec;
    for (const st of states) {
      if (st.state === "firing" && st.firedAt && now.getTime() - st.firedAt.getTime() >= afterSec * 1000) {
        // A timed clear may have no reading at all (the asset stopped
        // reporting), so the reset context is built from the state row.
        await fireReset(rule, readingFromState(st), st, "alert timed out", now);
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

/** Per-(asset, dimension) truths — one entry per reading, no ANY fold. The
 *  dimension-aware half of a reset tree's lookup (see resolveResetTruths). */
function leafTruthByAssetDim(leaf: CompositeLeaf, readings: Reading[]): Map<string, LeafTruth> {
  const out = new Map<string, LeafTruth>();
  const leafTrigger = leaf as unknown as Trigger;
  for (const r of readings) {
    const key = `${r.assetId || ""}|${r.dimKey}`;
    if (out.has(key)) continue; // a resolver yields at most one reading per (asset, dimension)
    const met = readingMeets(leafTrigger, r.value);
    out.set(key, {
      met,
      witness: met ? { dimLabel: r.dimLabel, value: r.value } : null,
      sample: { dimLabel: r.dimLabel, value: r.value },
      hasReading: true,
    });
  }
  return out;
}

/**
 * A reset tree's truths, resolved DIMENSION-FIRST with a per-asset fallback.
 *
 * A composite trigger alerts once per device, so its leaves only ever need the
 * per-asset ANY fold. A reset tree can sit on a PER-DIMENSION single trigger,
 * where the firing alert belongs to one interface / sensor / mount — and the
 * seeded reset (the trigger inverted) is a leaf on that same dimension space.
 * Reading it per-asset would clear every pinned port on a switch the moment one
 * of them recovered, so the lookup tries the firing row's own dimension first.
 *
 * The fallback is what makes a MIXED tree work: a leaf on another dimension
 * space (CPU, whose dimKey is "") reports nothing at `assetId|port2`, so it
 * falls through to the ANY fold and contributes its device-wide truth. So
 * "clear port2 when port2's error rate drops AND the box's CPU is under 70"
 * evaluates each half where that half actually lives.
 *
 * One query pass, folded twice — identical leaves still share their resolver.
 */
async function resolveResetTruths(
  leaves: LeafRef[],
  assets: ScopeAssetRow[],
): Promise<(leafId: string, assetId: string, dimKey: string) => LeafTruth | undefined> {
  const byResolverKey = new Map<string, Promise<Reading[]>>();
  const byAsset = new Map<string, Map<string, LeafTruth>>();
  const byAssetDim = new Map<string, Map<string, LeafTruth>>();
  for (const { leafId, leaf } of leaves) {
    const key = JSON.stringify(leaf);
    let p = byResolverKey.get(key);
    if (!p) {
      p = resolveOneLeafReadings(leaf, assets);
      byResolverKey.set(key, p);
    }
    const readings = await p;
    byAsset.set(leafId, leafTruthByAsset(leaf, readings));
    byAssetDim.set(leafId, leafTruthByAssetDim(leaf, readings));
  }
  return (leafId, assetId, dimKey) =>
    byAssetDim.get(leafId)?.get(`${assetId}|${dimKey}`) ?? byAsset.get(leafId)?.get(assetId);
}

/** Where a tree walk gets each leaf's truth. Keyed by tree-path leafId so the
 *  same walker serves the per-asset fold (composite triggers) and the
 *  dimension-aware fold (a reset tree over a per-dimension single trigger). */
type LeafTruthLookup = (leafId: string) => LeafTruth | undefined;

function evalTriggerTree(
  node: { op: "and" | "or"; children: (TriggerConditionGroup | CompositeLeaf)[] },
  lookup: LeafTruthLookup,
  prefix = "",
): boolean {
  const results = node.children.map((c, i) => {
    const id = prefix ? `${prefix}.${i}` : String(i);
    if (isTriggerLeaf(c)) return lookup(id)?.met === true; // no reading ⇒ false (never fire on absent evidence)
    return evalTriggerTree(c as TriggerConditionGroup, lookup, id);
  });
  return node.op === "and" ? results.every(Boolean) : results.some(Boolean);
}

function evalTriggerTreeForAsset(
  node: { op: "and" | "or"; children: (TriggerConditionGroup | CompositeLeaf)[] },
  assetId: string,
  truths: Map<string, Map<string, LeafTruth>>,
  prefix = "",
): boolean {
  return evalTriggerTree(node, (leafId) => truths.get(leafId)?.get(assetId), prefix);
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
  st: { id: string; notificationId: string | null; recoveredSince: Date | null; firingSeverity?: string | null },
  recovered: boolean,
  now: Date,
  /** Carried purely so the reset actions have a device to talk about. */
  reading?: Reading,
  /** `fireResolvedFirst`: run the severity-band resolved actions before the
   *  clear, exactly as the auto path does. Only meaningful on a banded rule
   *  (bands need a numeric single trigger, so composites never set it). */
  opts?: { fireResolvedFirst?: boolean },
): Promise<void> {
  if (!recovered) {
    if (st.recoveredSince) {
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: null } });
    }
    return;
  }
  const clear = async (): Promise<void> => {
    if (opts?.fireResolvedFirst && reading) {
      await fireResolved(rule, reading, { ...st, firingSeverity: st.firingSeverity ?? null }, now);
    }
    await recover(rule, st, reading, now);
  };
  const sustainSec = rule.reset.sustainSec ?? 0;
  if (sustainSec <= 0) {
    await clear();
  } else if (!st.recoveredSince) {
    await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: now } });
  } else if (now.getTime() - st.recoveredSince.getTime() >= sustainSec * 1000) {
    await clear();
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
        await applySustainedRecovery(rule, st, recovered, now, reading);
      } else if (outcome.meets) {
        if (st.recoveredSince) {
          // Re-met mid-recovery under auto: cancel the clear-sustain timer.
          await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: null } });
        }
      } else if (rule.reset.mode !== "auto") {
        await recover(rule, st, reading, now); // manual re-arms the state; timed waits for its sweep
      } else {
        // auto for composites = the tree is no longer true (no hysteresis
        // dead band — clearThreshold is rejected at save for composites).
        await applySustainedRecovery(rule, st, true, now, reading);
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
      // Composite state has no dimensionKey, so the pin-test carve-out never
      // applies here (pinTestForTrigger is null for composite triggers anyway).
      new Map(scopeAssets.map((a) => [a.id, a])),
    );
  }

  // Timed auto-clear sweep (identical to the legacy path; orphan rows already
  // deleted above are excluded by the dimensionKey guard).
  if (rule.reset.mode === "timed" && rule.reset.afterSec) {
    const afterSec = rule.reset.afterSec;
    for (const st of states) {
      if (st.dimensionKey === "" && st.state === "firing" && st.firedAt && now.getTime() - st.firedAt.getTime() >= afterSec * 1000) {
        // A timed clear may have no reading at all (the asset stopped
        // reporting), so the reset context is built from the state row.
        await fireReset(rule, readingFromState(st), st, "alert timed out", now);
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
  // State a sensor reading in the install's display unit, so the sentence
  // agrees with the chart drawn underneath it in the email.
  await applySensorUnitToSummary(rule, reading, ctx);
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
      // The dimension this alert is ABOUT — the same key the state row uses.
      // For a hardware-sensor automation that's the bare sensor name, which is
      // what lets the alert email chart THAT sensor at delivery time, long
      // after this reading is gone. "" for whole-device and composite fires.
      dimension: reading.dimKey || null,
      // Which metric fired — the email leads with the chart that explains THIS
      // alert (alertChartService.chartTokenForMetric).
      metric: rule.trigger.type === "asset_metric" || rule.trigger.type === "host_metric"
        ? rule.trigger.metric
        // A state alert fires on a FIELD; same column, same purpose — it is
        // what the email leads with (monitorStatus → the probe history).
        : rule.trigger.type === "asset_state" ? rule.trigger.field : null,
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
  // State a sensor reading in the install's display unit, so the sentence
  // agrees with the chart drawn underneath it in the email.
  await applySensorUnitToSummary(rule, reading, ctx);
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
  setRecoverySentence(ctx, `Resolved: ${rule.name} — ${ctx["asset"] ?? reading.hostname ?? ""} recovered`);
  await enqueueAlertActions(st.notificationId, actions, ctx, rule, reading);
}

/**
 * Run the automation's RESET actions — "the alert ended, tell someone".
 *
 * Called BEFORE the notification is cleared, exactly like fireResolved: the
 * actions attach to the still-live notification id, so their delivery rows
 * (and the acknowledge tokens minted for them) hang off the alert they are
 * about rather than orphaning.
 *
 * `reason` names how it ended — the recovery message says so, because "it's
 * back" and "someone gave up and cleared it" are different facts.
 */
/**
 * A minimal Reading for a reset that has no live reading behind it — a timed
 * clear fires precisely because the condition stopped being observed, and the
 * asset may have gone silent entirely. `lastValue` is the last thing we saw,
 * which is the honest value for a recovery message.
 */
function readingFromState(st: { assetId: string | null; dimensionKey: string; lastValue?: number | null }): Reading {
  return {
    assetId: st.assetId ?? "",
    hostname: null,
    tags: [],
    dimKey: st.dimensionKey,
    dimLabel: st.dimensionKey,
    value: st.lastValue ?? null,
  };
}

async function fireReset(
  rule: DbRule,
  reading: Reading,
  st: { notificationId: string | null },
  reason: string,
  now: Date,
): Promise<void> {
  const actions = rule.resetActions;
  if (!actions?.length || !st.notificationId) return;
  const detail = ruleWantsAssetDetail(rule) && reading.assetId ? await assetDetail(reading.assetId) : null;
  const parts = readingContextParts(rule, reading, now);
  // "resolved" is a pseudo-severity (not in SEVERITIES) that colours the email
  // green and reads correctly in a subject line — the same one fireResolved
  // uses for a severity-band recovery.
  parts.severity = "resolved";
  const ctx = buildTemplateContext({ ...parts, assetDetail: detail });
  setRecoverySentence(ctx, `Resolved: ${rule.name} — ${ctx["asset"] || reading.hostname || "device"} ${reason}`);
  await enqueueAlertActions(st.notificationId, actions, ctx, rule, reading);
}

/**
 * Re-render `{trigger.summary}` for a hardware-sensor reading with the sensor's
 * own unit, converted to the install's display unit. Sensor readings are the
 * one metric whose unit isn't knowable from the metric alone (a "hardware
 * sensor value" is °C on one row and RPM on the next), and the email states the
 * value right above a chart that already converts.
 *
 * Best-effort: any failure leaves the unit-less sentence the context already
 * has.
 */
async function applySensorUnitToSummary(
  rule: DbRule,
  reading: Reading,
  ctx: Record<string, string>,
): Promise<void> {
  const t = rule.trigger;
  if (t.type !== "asset_metric" || t.metric !== "hwSensorValue") return;
  if (!reading.assetId || !reading.dimKey) return;
  const shown = await sensorReadingDisplay(reading.assetId, reading.dimKey, reading.value);
  ctx["trigger.summary"] = triggerSummary({
    trigger: t as never,
    value: shown.value,
    dimensionLabel: reading.dimLabel || null,
    sensorUnit: shown.unit,
  });
  if (shown.value !== null && shown.value !== undefined) ctx["value"] = String(shown.value);
}

async function recover(
  rule: DbRule,
  st: { id: string; notificationId: string | null },
  reading?: Reading,
  now?: Date,
): Promise<void> {
  // "condition" recovers like "auto": the reset tree (or trigger negation)
  // observed a real recovery, so clear the notification + stamp the event.
  if (rule.reset.mode === "auto" || rule.reset.mode === "condition") {
    // Reset actions run BEFORE the clear, while the notification id is still
    // live for their delivery rows to hang off. The manual/timed branch below
    // deliberately doesn't: manual leaves the alert standing for a human, and
    // timed fires its own reset from the sweep that actually clears it.
    if (reading && now) await fireReset(rule, reading, st, "recovered", now);
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
    // Reset actions need the alerts THEMSELVES, not a count — an action is
    // per-alert (its deliveries hang off a notification id). Select first when
    // the rule has any, then clear; without reset actions this stays the
    // single bulk update it always was.
    const doomed = rule.resetActions?.length
      ? await prisma.notification.findMany({
          where: { ruleId: rule.id, cleared: false, triggeredAt: { lte: cutoff } },
          select: { id: true, assetId: true, assetHostname: true },
          take: 500,
        })
      : [];
    for (const n of doomed) {
      await fireReset(
        rule,
        { assetId: n.assetId ?? "", hostname: n.assetHostname, tags: [], dimKey: "", dimLabel: "", value: null },
        { notificationId: n.id },
        "alert timed out",
        now,
      );
    }
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
      // What this alert is ABOUT, as a label. A system-scoped Event (capacity,
      // backups, updates) names no resource because the resource IS this
      // install, so without the fallback the alert had no subject at all. Used
      // for every field that has to agree on it: {asset}, the stored
      // assetHostname, and the cooldown key below.
      const subjectLabel = eventSubjectLabel(ev.resourceType, ev.resourceName);
      const detail = assetId ? await assetDetail(assetId) : null;
      // Event/change rules honor the same silence as threshold rules: no
      // notifications for assets in a maintenance window or dependency-
      // suppressed behind one/an outage. (The event cursor still advances —
      // suppressed events are skipped, not deferred.)
      if (detail && isSuppressedForNotifications(detail)) continue;
      // Cooldown: skip when this (rule, asset/resource) fired within
      // cooldownSec — and stamp the map so later events in this batch dedupe.
      if (c.rule.cooldownSec) {
        const cdKey = `${c.rule.id}|${assetId ?? subjectLabel}`;
        const last = lastFired.get(cdKey);
        const evT = ev.timestamp.getTime();
        if (last !== undefined && evT - last < c.rule.cooldownSec * 1000) continue;
        lastFired.set(cdKey, evT);
      }
      const tags = detail?.tags ?? [];
      // Event-path token mapping: {asset}=resourceName, {metric}=action,
      // {value}=event message; threshold/dimension are empty.
      const ctx = buildTemplateContext({
        asset: subjectLabel,
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
        // The EVENT's own identity. Most event automations fire on things that
        // aren't assets at all (an integration, a user, the host), so the
        // device facts prune away and this is the only thing the email can say
        // about what happened. Composed at fire time — the Event row is in
        // hand here and gone by delivery.
        event: {
          action: ev.action,
          level: ev.level,
          resourceType: ev.resourceType,
          resourceName: ev.resourceName,
          actor: ev.actor,
          // Why it happened, as its own token: the email prints it as a facts
          // row, so the reason survives whatever the rule's messageTemplate
          // says (the 12 seeded event automations use "{value}" to surface
          // exactly this text, and the body no longer relies on that).
          message: ev.message,
        },
        triggerSummary: triggerSummary({
          trigger: c.rule.trigger as never,
          eventAction: ev.action,
          // "… on Polaris server" for a system-scoped event, where the bare
          // resourceType ("system") named nothing a reader recognizes.
          eventResource: subjectLabel || ev.resourceType || null,
        }),
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
        // The in-app / mobile alert lists render this as the alert's subject —
        // blank for a system-scoped event before the label existed.
        assetHostname: subjectLabel || null,
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
  // `id` backs {asset.link}; lastSeenSwitch/lastSeenAp back
  // {asset.connectedSwitch}/{asset.connectedAp} — precomputed scalars on the
  // asset row (discovery + persistWirelessStations maintain them), so the
  // alert email can say WHERE the device hangs for the cost of nothing.
  id: true,
  hostname: true, ipAddress: true, macAddress: true, assetType: true, status: true,
  location: true, learnedLocation: true, description: true, manufacturer: true, model: true,
  serialNumber: true, os: true, osVersion: true, department: true, assignedTo: true,
  tags: true, dependencySuppressed: true, lastSeenSwitch: true, lastSeenAp: true,
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
      resetActions: v2.resetActions,
      repeat: v2.repeat,
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
  /** Display label, e.g. "CPU ON-DIE Temperature (temperature)". */
  dimension: string;
  /** The RAW dimension key the engine keys state on (a bare sensor name, an
   *  interface, a mount) — usable as a query argument without parsing the
   *  label apart. */
  dimensionKey?: string;
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
  /** Scope matches that are NOT monitored — counted, never listed. Only the
   *  device-list preview sets it; a metric preview has no readings for them. */
  unmonitoredCount?: number;
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
  /** The peer trigger's device filter, when it has one. Coverage is scope AND
   *  filter — see peerCoversAsset. Optional so existing callers/tests that
   *  build unfiltered peers stay valid. */
  dimensionFilter?: Parameters<typeof deviceFilterMatch>[0];
}

/** Coverage test for a carve-out peer — the CarveOutPeer twin of
 *  peerCoversAsset, kept beside it so the preview and the engine agree. */
function carveOutPeerCovers(peer: CarveOutPeer, asset: ScopeAsset): boolean {
  if (!scopeMatchesAsset(peer.scope, asset)) return false;
  if (!peer.dimensionFilter) return true;
  const rec = peer.dimensionFilter as Record<string, string | undefined>;
  if (!DEVICE_FILTER_DIMENSIONS.some((d) => rec[d])) return true;
  return deviceFilterMatch(peer.dimensionFilter, asset);
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
      if (carveOutPeerCovers(o, a) && (!best || o.rank > best.rank)) best = o;
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
    const hit = scopeAssets.filter((a) => carveOutPeerCovers(o, a));
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
    .map((o) => ({
      id: o.id,
      name: o.name,
      scope: (o.scope ?? {}) as RuleScope,
      rank: scopeRank((o.scope ?? {}) as RuleScope),
      // A monitorStatus signature no longer pins the device filter, so peers in
      // this group may be filtered differently from the draft — carry it so
      // coverage is tested rather than assumed.
      dimensionFilter: (o.trigger as { dimensionFilter?: Parameters<typeof deviceFilterMatch>[0] } | null)?.dimensionFilter,
    }));
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
    trigger, scope: input.scope, resetActions: input.resetActions ?? null, repeat: input.repeat ?? null,
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
    // Device-list preview: MONITORED devices are what the operator is choosing
    // between, so they're what the list and the count report. The unmonitored
    // remainder is stated rather than hidden — the filter still selects those
    // devices, and an event or change automation does fire on them.
    const all = await loadScopeAssets(input.scope);
    const assets = all.filter((a) => a.monitored);
    return {
      supported: true,
      totalEvaluated: assets.length,
      totalAssets: assets.length,
      unmonitoredCount: all.length - assets.length,
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
    const base: PreviewMatch = { assetId: r.assetId || null, hostname: r.hostname, dimension: r.dimLabel, dimensionKey: r.dimKey, value: r.value, meets };
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
  // Composition or not: every email notify action now renders through the
  // shared default template, so a draft that customized nothing still has a
  // real email worth previewing.
  if (readings.length > 0) {
    const draft = draftRuleForPreview(input, trigger);
    const sample = readings.find((r) => readingMeets(trigger, r.value)) ?? readings[0];
    emailPreview = await renderPreviewEmail(draft, input.emailComposition ?? {}, sample);
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
