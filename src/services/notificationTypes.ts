/**
 * src/services/notificationTypes.ts
 *
 * Central vocabulary for the notification rules engine: the discriminated
 * `trigger` union, the asset `scope` selector, severities, clear behaviors,
 * and the operator/metric/field catalogs. Shared by the rule routes
 * (validation), the engine (evaluation), the rule service (scope match), and
 * the schema endpoint that drives the builder UI — so the vocabulary lives in
 * exactly one place and the frontend never hardcodes it.
 */

import { z } from "zod";
import { isValidCidr, isValidIpAddress, ipInCidr } from "../utils/cidr.js";
import { TEMPLATE_VARIABLES } from "../utils/notificationTemplate.js";
import { SENSOR_CLASS_UNITS } from "../utils/hardwareSensors.js";

// Notification severity (rule.severity → notification.severity). Ordered
// least → most severe. NOTE: distinct from EVENT_LEVELS below — that's the
// audit-Event level vocabulary the `event` trigger's minLevel filters against.
export const SEVERITIES = ["notice", "informational", "warning", "serious", "critical"] as const;
// Audit-Event levels (logEvent), used only by the event-trigger minLevel filter.
export const EVENT_LEVELS = ["info", "warning", "error"] as const;
export const CLEAR_BEHAVIORS = ["manual", "auto", "timed"] as const;
export const COMPARATORS = [">", ">=", "<", "<=", "==", "!="] as const;
export const AGGREGATIONS = ["latest", "avg", "min", "max"] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Comparator = (typeof COMPARATORS)[number];

/** Rank of a severity (higher = more severe); -1 for an unknown string. */
export function severityRank(s: string): number {
  return (SEVERITIES as readonly string[]).indexOf(s);
}

// ─── Severity bands (value-driven severity escalation) ──────────────────────
// One automation can escalate severity by value: a base trigger threshold +
// severity (tier 0) plus higher tiers ("bands"). severityForValue walks the
// effective tiers [tier0, ...bands] and returns the MOST-severe tier a value
// satisfies (or null when it satisfies none — below tier 0 = not firing). Bands
// live at the rule level alongside actions/reset/escalation; each also carries
// its own actions + escalation (see severityBandSchema).

/** The value/severity part of a band tier that severityForValue reads. A full
 *  band (severityBandSchema) additionally carries actions + escalation. */
export interface SeverityTier {
  threshold: number;
  severity: Severity;
  /** Per-tier comparison operator (falls back to the base trigger's). */
  operator?: Comparator;
  /** Per-tier sustained duration (falls back to the base trigger's
   *  forDurationSec). See resolveTierLadder / sustainedSeverity. */
  forDurationSec?: number;
}

/**
 * THE six-way numeric comparator for automation thresholds. Exported so the
 * engine's trigger evaluation uses the SAME function as band evaluation
 * here — the two carried byte-identical private copies until the 2026-08
 * audit, and threshold semantics must never diverge between them.
 */
export function numMeets(value: number, operator: Comparator | string, threshold: number): boolean {
  switch (operator) {
    case ">": return value > threshold;
    case ">=": return value >= threshold;
    case "<": return value < threshold;
    case "<=": return value <= threshold;
    case "==": return value === threshold;
    case "!=": return value !== threshold;
    default: return false;
  }
}

/**
 * The severity a numeric value lands in. Effective tiers are the base
 * `{baseThreshold, baseSeverity}` plus `bands`; returns the most-severe tier the
 * value satisfies under `operator`, or null when it satisfies none. A no-band
 * trigger returns `baseSeverity` (when met) or null — identical to the pre-band
 * fire/clear decision.
 */
export function severityForValue(
  operator: Comparator,
  baseThreshold: number,
  baseSeverity: Severity,
  bands: SeverityTier[] | null | undefined,
  value: number | null | undefined,
): Severity | null {
  if (value == null || Number.isNaN(value)) return null;
  const tiers: SeverityTier[] = [{ threshold: baseThreshold, severity: baseSeverity }, ...(bands ?? [])];
  let best: Severity | null = null;
  let bestRank = -1;
  for (const tier of tiers) {
    const r = severityRank(tier.severity);
    // Tiers share the base sampling (aggregation/window/dimensionFilter) but may
    // carry their own comparison operator; fall back to the base operator.
    if (r > bestRank && numMeets(value, tier.operator ?? operator, tier.threshold)) {
      best = tier.severity;
      bestRank = r;
    }
  }
  return best;
}

// ─── Per-tier sustained durations ───────────────────────────────────────────
// "Sustained for" is per TIER, not per rule: warning may need 30 minutes while
// critical pages after 5. One shared conditionMetSince can't express that (a
// value that climbs from warning into critical has been critical for seconds
// but above the base threshold for half an hour), so the engine keeps a per-tier
// "continuously satisfied since" map on the state row and resolves the alert's
// severity from it. The three functions below are the whole decision, kept pure
// here beside severityForValue so the engine and the tests share them.

/** A tier with its comparison + sustain resolved (no inheritance left). */
export interface ResolvedTier {
  threshold: number;
  severity: Severity;
  operator: Comparator;
  forDurationSec: number;
}

/**
 * The effective tier ladder `[base, ...bands]` with each tier's operator and
 * sustained duration resolved. A band inherits the base trigger's operator /
 * `forDurationSec` when it carries none — which is exactly how rules authored
 * before per-band sustain existed keep behaving.
 */
export function resolveTierLadder(
  operator: Comparator,
  baseThreshold: number,
  baseSeverity: Severity,
  baseForDurationSec: number,
  bands: SeverityTier[] | null | undefined,
): ResolvedTier[] {
  const base: ResolvedTier = { threshold: baseThreshold, severity: baseSeverity, operator, forDurationSec: Math.max(0, baseForDurationSec || 0) };
  const rest = (bands ?? []).map((b) => ({
    threshold: b.threshold,
    severity: b.severity,
    operator: b.operator ?? operator,
    forDurationSec: Math.max(0, b.forDurationSec ?? baseForDurationSec ?? 0),
  }));
  return [base, ...rest];
}

/**
 * Roll the per-tier met-since map forward for one reading. A tier the value
 * satisfies KEEPS its existing timestamp (the run continues) or starts one at
 * `nowMs`; a tier it no longer satisfies drops out, so its next entry restarts
 * the clock. Severities are unique across the ladder (validateSeverityBands
 * enforces strictly-increasing tiers), so severity is a safe key.
 */
export function updateTierMetSince(
  prev: Record<string, number> | null | undefined,
  tiers: ResolvedTier[],
  value: number | null | undefined,
  nowMs: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  if (value == null || Number.isNaN(value)) return next;
  for (const tier of tiers) {
    if (!numMeets(value, tier.operator, tier.threshold)) continue;
    const since = prev?.[tier.severity];
    // A stored timestamp in the future (clock step) restarts rather than
    // locking the tier out forever.
    next[tier.severity] = typeof since === "number" && Number.isFinite(since) && since <= nowMs ? since : nowMs;
  }
  return next;
}

/**
 * The severity the alert should be at: the MOST-SEVERE tier whose own run has
 * lasted at least its own `forDurationSec`. Null = nothing has sustained yet
 * (the alert stays pending, or an already-firing alert holds its severity).
 */
export function sustainedSeverity(
  metSince: Record<string, number> | null | undefined,
  tiers: ResolvedTier[],
  nowMs: number,
): Severity | null {
  let best: Severity | null = null;
  let bestRank = -1;
  for (const tier of tiers) {
    const since = metSince?.[tier.severity];
    if (typeof since !== "number" || !Number.isFinite(since)) continue;
    if (nowMs - since < tier.forDurationSec * 1000) continue;
    const rank = severityRank(tier.severity);
    if (rank > bestRank) {
      best = tier.severity;
      bestRank = rank;
    }
  }
  return best;
}

/** Whether two met-since maps differ — the engine only writes the state row
 *  when they do, keeping the hot path transition-write-only. */
export function tierMetSinceChanged(
  a: Record<string, number> | null | undefined,
  b: Record<string, number> | null | undefined,
): boolean {
  const ak = Object.keys(a ?? {});
  const bk = Object.keys(b ?? {});
  if (ak.length !== bk.length) return true;
  return ak.some((k) => (a as Record<string, number>)[k] !== (b ?? {})[k]);
}

// ─── Asset-metric trigger ───────────────────────────────────────────────────
// Numeric thresholds over the telemetry / sample tables. `dimensionFilter`
// narrows multi-row streams (interfaces, sensors, mounts, SD-WAN members).
export const ASSET_METRICS = [
  "cpuPct", "memPct", "memUsedBytes", "sessionCount", "responseTimeMs", "uptimeSec", "probeLossPct",
  "hwSensorValue", "storageUsedPct", "storageUsedBytes", "storageDaysUntilFull",
  "ifInErrorRate", "ifOutErrorRate", "ifInBps", "ifOutBps",
  "sdwanLatencyMs", "sdwanJitterMs", "sdwanPacketLoss", "ipsecThroughputBps",
  "customWidgetValue",
] as const;

// ─── Asset-state trigger ────────────────────────────────────────────────────
// Current Asset (or current-state child row) field conditions.
export const ASSET_STATE_FIELDS = [
  "monitorStatus", "status", "consecutiveFailures", "dependencySuppressed", "quarantined",
  "ifOperStatus", "ifAdminStatus", "ipsecStatus", "sdwanRuleStatus", "sdwanSelectedMember",
] as const;

// ─── Host-metric trigger ────────────────────────────────────────────────────
// Polaris host health from HostMetricsSample.
export const HOST_METRICS = [
  "cpuPct", "memUsedPct", "memUsedBytes", "loadAvg1", "loadAvg5", "loadAvg15", "procRssBytes",
] as const;

// ─── Change trigger ─────────────────────────────────────────────────────────
// Sugar over emitted change-Events from the persist* functions.
export const CHANGE_TYPES = [
  "lldp_neighbor_added", "lldp_neighbor_removed",
  "process_started", "process_stopped",
  "sdwan_failover", "mclag_peer_lost", "wireless_station_connected",
] as const;

// Map a change type → the audit Event action the persist functions emit and
// the event path matches on. Single source of truth for both ends.
export const CHANGE_TYPE_ACTIONS: Record<(typeof CHANGE_TYPES)[number], string> = {
  lldp_neighbor_added: "change.lldp.neighbor_added",
  lldp_neighbor_removed: "change.lldp.neighbor_removed",
  process_started: "change.process.started",
  process_stopped: "change.process.stopped",
  sdwan_failover: "change.sdwan.failover",
  mclag_peer_lost: "change.mclag.peer_lost",
  wireless_station_connected: "change.wireless.station_connected",
};

const dimensionFilterSchema = z
  .object({
    ifNamePattern: z.string().max(200).optional(),
    sensorClass: z.enum(["temperature", "fan", "voltage", "power", "disk", "other"]).optional(),
    // One NAMED sensor rather than a whole class: a firewall reports a dozen
    // temperature sensors ("CPU ON-DIE Temperature", "TMP1 External
    // Temperature", per-PHY dies), and an operator alerting on the CPU die does
    // not want the PHYs alerting too. Substring-matched like the other
    // *Pattern dimensions, and ANDs with sensorClass when both are set.
    sensorNamePattern: z.string().max(200).optional(),
    mountPathPattern: z.string().max(200).optional(),
    healthCheck: z.string().max(200).optional(),
    link: z.string().max(200).optional(),
    tunnelName: z.string().max(200).optional(),
    widgetId: z.string().max(200).optional(),
    processNamePattern: z.string().max(200).optional(),
  })
  .strict()
  .optional();

const assetMetricTrigger = z.object({
  type: z.literal("asset_metric"),
  metric: z.enum(ASSET_METRICS),
  aggregation: z.enum(AGGREGATIONS).default("latest"),
  windowSec: z.number().int().min(0).max(86400).default(0),
  operator: z.enum(COMPARATORS),
  threshold: z.number(),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
  dimensionFilter: dimensionFilterSchema,
});

const assetStateTrigger = z.object({
  type: z.literal("asset_state"),
  field: z.enum(ASSET_STATE_FIELDS),
  operator: z.enum(COMPARATORS),
  // string for enum-like fields (monitorStatus), number for counters, bool for flags
  value: z.union([z.string().max(200), z.number(), z.boolean()]),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
  dimensionFilter: dimensionFilterSchema,
});

const hostMetricTrigger = z.object({
  type: z.literal("host_metric"),
  metric: z.enum(HOST_METRICS),
  aggregation: z.enum(AGGREGATIONS).default("latest"),
  windowSec: z.number().int().min(0).max(86400).default(0),
  operator: z.enum(COMPARATORS),
  threshold: z.number(),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
});

const eventTrigger = z.object({
  type: z.literal("event"),
  actionPattern: z.string().min(1).max(200), // glob, e.g. "integration.test.*"
  resourceType: z.string().max(100).optional(),
  minLevel: z.enum(EVENT_LEVELS).optional(),
  detailsMatch: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const changeTrigger = z.object({
  type: z.literal("change"),
  changeType: z.enum(CHANGE_TYPES),
  dimensionFilter: dimensionFilterSchema,
});

// ─── Composite trigger (nested AND/OR over metric/state leaves) ─────────────
// The wizard's multi-condition trigger: a tree of the threshold-ish leaf
// conditions above (event/change have no continuous reading to compose).
// Evaluated PER ASSET — a multi-dimension leaf (sensors, mounts, interfaces)
// counts as met when ANY of its dimensions meets, and the whole rule fires one
// alert per asset (dimensionKey "") instead of per dimension. Only and/or are
// allowed at group level: negation combinators would fire on missing data and
// on every healthy asset; single-condition negation is already expressible via
// the inverse comparator.
//
// Invariant (enforced by collapseCompositeTrigger in the input transforms):
// a stored composite always has ≥2 leaves — a single-leaf composite collapses
// to the legacy single trigger, keeping per-dimension alerting + hysteresis
// for the common case regardless of which client authored the rule.

export const TRIGGER_GROUP_OPS = ["and", "or"] as const;
export type TriggerGroupOp = (typeof TRIGGER_GROUP_OPS)[number];

// Leaves are the existing threshold conditions minus forDurationSec (the
// sustain applies to the whole composite, not per leaf).
const compositeAssetMetricLeaf = assetMetricTrigger.omit({ forDurationSec: true });
const compositeAssetStateLeaf = assetStateTrigger.omit({ forDurationSec: true });
const compositeHostMetricLeaf = hostMetricTrigger.omit({ forDurationSec: true });
export const compositeLeafSchema = z.discriminatedUnion("type", [
  compositeAssetMetricLeaf,
  compositeAssetStateLeaf,
  compositeHostMetricLeaf,
]);
export type CompositeLeaf = z.infer<typeof compositeLeafSchema>;

export interface TriggerConditionGroup {
  op: TriggerGroupOp;
  children: (TriggerConditionGroup | CompositeLeaf)[];
}

/** A tree node is a leaf iff it carries the discriminator (groups are strict
 *  {op, children} objects and never have `type`). */
export function isTriggerLeaf(node: TriggerConditionGroup | CompositeLeaf): node is CompositeLeaf {
  return "type" in node;
}

export const triggerConditionGroupSchema: z.ZodType<TriggerConditionGroup> = z.lazy(() =>
  z
    .object({
      op: z.enum(TRIGGER_GROUP_OPS),
      children: z.array(z.union([compositeLeafSchema, triggerConditionGroupSchema])).min(1).max(10),
    })
    .strict(),
) as z.ZodType<TriggerConditionGroup>;

// Plain ZodObject (no superRefine — discriminated-union members must be), so
// the depth/leaf/kind caps live in validateCompositeTrigger, called from
// validateRuleV2 on both the save and preview paths.
const compositeTrigger = z.object({
  type: z.literal("composite"),
  // asset = asset_metric/asset_state leaves (scope-selected devices);
  // host = host_metric leaves (the Polaris host). Never mixed.
  kind: z.enum(["asset", "host"]),
  op: z.enum(TRIGGER_GROUP_OPS),
  children: z.array(z.union([compositeLeafSchema, triggerConditionGroupSchema])).min(1).max(10),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
});

export const triggerSchema = z.discriminatedUnion("type", [
  assetMetricTrigger,
  assetStateTrigger,
  hostMetricTrigger,
  eventTrigger,
  changeTrigger,
  compositeTrigger,
]);
export type CompositeTrigger = z.infer<typeof compositeTrigger>;

/** Depth (root group = 1) + leaf count for a composite trigger tree. */
export function triggerConditionStats(node: { op: TriggerGroupOp; children: (TriggerConditionGroup | CompositeLeaf)[] }): {
  depth: number;
  leaves: number;
} {
  let leaves = 0;
  const depthOf = (g: { children: (TriggerConditionGroup | CompositeLeaf)[] }): number =>
    1 + Math.max(0, ...g.children.map((c) => {
      if (isTriggerLeaf(c)) { leaves++; return 0; }
      return depthOf(c);
    }));
  const depth = depthOf(node);
  return { depth, leaves };
}

/**
 * Canonicalize a composite trigger: unwrap single-child group wrappers, and
 * collapse a single-leaf tree to the legacy single trigger with forDurationSec
 * hoisted onto it. Applied in the input transforms so the "≥2 leaves ⇒
 * composite, 1 leaf ⇒ per-dimension legacy" invariant holds for every author
 * (wizard or raw API).
 */
export function collapseCompositeTrigger(trigger: Trigger): Trigger {
  if (trigger.type !== "composite") return trigger;
  let op = trigger.op;
  let children = trigger.children;
  while (children.length === 1 && !isTriggerLeaf(children[0])) {
    const g = children[0] as TriggerConditionGroup;
    op = g.op;
    children = g.children;
  }
  if (children.length === 1 && isTriggerLeaf(children[0])) {
    return { ...(children[0] as CompositeLeaf), forDurationSec: trigger.forDurationSec } as Trigger;
  }
  return { ...trigger, op, children };
}

const COMPOSITE_MAX_DEPTH = 3;
const COMPOSITE_MAX_LEAVES = 10;

/** Structural caps + kind coherence for a composite trigger (save + preview). */
export function validateCompositeTrigger(trigger: CompositeTrigger, ctx: z.RefinementCtx): void {
  const stats = triggerConditionStats(trigger);
  if (stats.depth > COMPOSITE_MAX_DEPTH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger"], message: `condition groups nest at most ${COMPOSITE_MAX_DEPTH} deep` });
  }
  if (stats.leaves > COMPOSITE_MAX_LEAVES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger"], message: `at most ${COMPOSITE_MAX_LEAVES} conditions per trigger` });
  }
  if (stats.leaves < 2) {
    // collapseCompositeTrigger should have folded this to a single trigger; a
    // composite reaching validation with <2 leaves means a raw caller bypassed
    // the transform — reject rather than store a degenerate tree.
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger"], message: "a composite trigger needs at least 2 conditions" });
  }
  const badLeaf = collectTriggerLeaves(trigger).find((l) =>
    trigger.kind === "host" ? l.type !== "host_metric" : l.type === "host_metric",
  );
  if (badLeaf) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger"],
      message:
        trigger.kind === "host"
          ? "host composite triggers may only contain Polaris-host metric conditions"
          : "device composite triggers may not contain Polaris-host metric conditions",
    });
  }
}

/** Flatten a composite tree's leaves in document order. */
export function collectTriggerLeaves(node: { children: (TriggerConditionGroup | CompositeLeaf)[] }): CompositeLeaf[] {
  const out: CompositeLeaf[] = [];
  for (const c of node.children) {
    if (isTriggerLeaf(c)) out.push(c);
    else out.push(...collectTriggerLeaves(c));
  }
  return out;
}

// ─── Scope condition tree (nested AND/OR device filtering) ──────────────────
// `scope.condition` is a nested group of per-field rules — the wizard's
// SolarWinds-style builder. Group combinators:
//   and    = all children must be satisfied
//   or     = at least one child must be satisfied
//   none   = all children must NOT be satisfied      (¬or)
//   notAll = at least one child must NOT be satisfied (¬and)
// Rules are (field, operator, value) over asset identity columns; evaluation
// is the pure `evaluateScopeCondition` below — used by the in-memory matcher
// AND the engine's post-SQL filter, so the semantics can't drift.

export const SCOPE_GROUP_OPS = ["and", "or", "none", "notAll"] as const;
export type ScopeGroupOp = (typeof SCOPE_GROUP_OPS)[number];

const STRING_OPS = ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"] as const;
export const SCOPE_FIELD_OPS: Record<string, readonly string[]> = {
  assetType: ["equals", "notEquals"],
  manufacturer: STRING_OPS,
  model: STRING_OPS,
  hostname: STRING_OPS,
  os: STRING_OPS,
  tag: ["has", "notHas"],
  subnet: ["inCidr", "notInCidr"],
  status: ["equals", "notEquals"],
  assetId: ["equals", "notEquals"],
};
export const SCOPE_FIELDS = Object.keys(SCOPE_FIELD_OPS);

export interface ScopeConditionRule {
  field: string;
  operator: string;
  value: string;
}
export interface ScopeConditionGroup {
  op: ScopeGroupOp;
  children: (ScopeConditionGroup | ScopeConditionRule)[];
}

const scopeConditionRuleSchema = z
  .object({
    field: z.enum(SCOPE_FIELDS as [string, ...string[]]),
    operator: z.string().min(1).max(30),
    value: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((r, ctx) => {
    const ops = SCOPE_FIELD_OPS[r.field] ?? [];
    if (!ops.includes(r.operator)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `operator "${r.operator}" is not valid for field "${r.field}"` });
    }
    if (r.field === "subnet" && !isValidCidr(r.value) && !isValidIpAddress(r.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${r.value}" must be a CIDR (e.g. 10.20.0.0/16) or an IP address` });
    }
  });

export const scopeConditionSchema: z.ZodType<ScopeConditionGroup> = z.lazy(() =>
  z
    .object({
      op: z.enum(SCOPE_GROUP_OPS),
      children: z.array(z.union([scopeConditionRuleSchema, scopeConditionSchema])).max(50),
    })
    .strict(),
) as z.ZodType<ScopeConditionGroup>;

/** Depth/size guard for a condition tree (defense against pathological input). */
export function scopeConditionStats(cond: ScopeConditionGroup): { depth: number; rules: number } {
  let rules = 0;
  const depthOf = (g: ScopeConditionGroup): number =>
    1 + Math.max(0, ...g.children.map((c) => {
      if ("op" in c) return depthOf(c as ScopeConditionGroup);
      rules++;
      return 0;
    }));
  const depth = depthOf(cond);
  return { depth, rules };
}

/** The asset fields the condition evaluator reads (matcher + engine select). */
export interface ScopeConditionAsset {
  id: string;
  assetType?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  hostname?: string | null;
  os?: string | null;
  tags?: string[];
  ipAddress?: string | null;
  status?: string | null;
}

function matchScopeRule(rule: ScopeConditionRule, asset: ScopeConditionAsset): boolean {
  const v = rule.value.toLowerCase();
  const str = (raw: string | null | undefined): string => (raw ?? "").toLowerCase();
  switch (rule.field) {
    case "assetType": {
      const eq = str(asset.assetType) === v;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "status": {
      const eq = str(asset.status) === v;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "assetId": {
      const eq = (asset.id ?? "") === rule.value;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "tag": {
      const has = (asset.tags ?? []).some((t) => t.toLowerCase() === v);
      return rule.operator === "notHas" ? !has : has;
    }
    case "subnet": {
      const ip = asset.ipAddress ?? "";
      let inside = false;
      if (ip) {
        try { inside = ipInCidr(ip, scopeCidrOf(rule.value)); } catch { inside = false; }
      }
      return rule.operator === "notInCidr" ? !inside : inside;
    }
    default: { // manufacturer / model / hostname / os — string ops
      const raw = str(
        rule.field === "manufacturer" ? asset.manufacturer
          : rule.field === "model" ? asset.model
            : rule.field === "hostname" ? asset.hostname
              : asset.os,
      );
      switch (rule.operator) {
        case "equals": return raw === v;
        case "notEquals": return raw !== v;
        case "contains": return raw.includes(v);
        case "notContains": return !raw.includes(v);
        case "startsWith": return raw.startsWith(v);
        case "endsWith": return raw.endsWith(v);
        default: return false;
      }
    }
  }
}

/**
 * Evaluate a condition tree against an asset. Empty-group semantics follow
 * boolean identities (and([])=true, or([])=false, none=¬or, notAll=¬and) —
 * the wizard converts an empty ROOT group to allAssets, so stored trees
 * always carry at least one rule.
 */
export function evaluateScopeCondition(cond: ScopeConditionGroup, asset: ScopeConditionAsset): boolean {
  const results = cond.children.map((c) =>
    "op" in c ? evaluateScopeCondition(c as ScopeConditionGroup, asset) : matchScopeRule(c as ScopeConditionRule, asset),
  );
  switch (cond.op) {
    case "and": return results.every(Boolean);
    case "or": return results.some(Boolean);
    case "none": return !results.some(Boolean);
    case "notAll": return !results.every(Boolean);
    default: return false;
  }
}

export const scopeSchema = z
  .object({
    allAssets: z.boolean().optional(),
    assetTypes: z.array(z.string().max(100)).max(100).optional(),
    tags: z.array(z.string().max(100)).max(200).optional(),
    assetIds: z.array(z.string().max(100)).max(2000).optional(),
    integrationIds: z.array(z.string().max(100)).max(200).optional(),
    // Case-insensitive CONTAINS match per entry ("Cisco" matches
    // "Cisco Systems, Inc."), OR within the list — same AND-across/OR-within
    // semantics as the other dimensions.
    manufacturers: z.array(z.string().min(1).max(100)).max(100).optional(),
    models: z.array(z.string().min(1).max(100)).max(100).optional(),
    // CIDRs (or bare IPs = /32, /128 for v6) the asset's primary IP must fall
    // inside. Validated at save; matched in memory (ipInCidr) after the SQL pass.
    subnetCidrs: z
      .array(
        z.string().min(1).max(100).refine((c) => isValidCidr(c) || isValidIpAddress(c), {
          message: "must be a CIDR (e.g. 10.20.0.0/16) or an IP address",
        }),
      )
      .max(100)
      .optional(),
    // Nested AND/OR condition tree (the wizard's device-filter builder).
    // Authoritative when present; the flat dimensions above remain for
    // API-written and pre-builder rules (both AND together if combined).
    condition: scopeConditionSchema.optional().nullable(),
  })
  .strict()
  .superRefine((sc, ctx) => {
    if (sc.condition) {
      const { depth, rules } = scopeConditionStats(sc.condition);
      if (depth > 5) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["condition"], message: "condition groups nest at most 5 deep" });
      if (rules > 100) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["condition"], message: "at most 100 rules per condition tree" });
    }
  });

/** Bare IP → host CIDR so scope subnet entries accept either form. */
export function scopeCidrOf(entry: string): string {
  return isValidIpAddress(entry) ? entry + (entry.includes(":") ? "/128" : "/32") : entry;
}


// ─── Delivery channels + targets ─────────────────────────────────────────────
// Channels are operator-configured delivery integrations (NotificationChannel
// registry, Notifications → Delivery tab). A rule's `targets[]` reference a
// channel by id. In-app is always implicit (every fire writes a Notification);
// targets route the same fire out through the configured channels.
//
// `transport` is the dispatch family the drain switches on; multiple channel
// `type`s can share one transport (slack + teams → webhook).
export const CHANNEL_TYPES = ["smtp", "oauth_m365", "pushbullet", "slack", "teams", "web_push"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const CHANNEL_TRANSPORT: Record<ChannelType, "email" | "webhook" | "web_push" | "pushbullet"> = {
  smtp: "email",
  oauth_m365: "email",
  pushbullet: "pushbullet",
  slack: "webhook",
  teams: "webhook",
  web_push: "web_push",
};
/** Channel types whose target routes to recipients (tags / addresses); the rest
 *  post to the channel's own fixed destination (URL / token). */
export const RECIPIENT_ROUTED_TYPES: ChannelType[] = ["smtp", "oauth_m365", "web_push"];

// Display metadata for the Delivery-tab add/edit modal: per-type label + the
// config fields (key, label, kind, whether it's a masked secret).
export interface ChannelFieldDef {
  key: string;
  label: string;
  kind: "text" | "number" | "password" | "select";
  secret?: boolean;
  options?: string[];
  placeholder?: string;
}
export const CHANNEL_TYPE_META: Record<ChannelType, { label: string; transport: string; singleton?: boolean; help?: string; fields: ChannelFieldDef[] }> = {
  smtp: {
    label: "Email — SMTP", transport: "email",
    fields: [
      { key: "host", label: "SMTP host", kind: "text", placeholder: "smtp.example.com" },
      // Security sits above Port: picking a security level auto-fills the
      // conventional port (none→25, starttls→587, ssl→465) in the UI.
      { key: "security", label: "Security", kind: "select", options: ["none", "starttls", "ssl"] },
      { key: "port", label: "Port", kind: "number" },
      { key: "username", label: "Username", kind: "text" },
      { key: "password", label: "Password", kind: "password", secret: true },
      { key: "from", label: "From address", kind: "text", placeholder: "polaris@example.com" },
    ],
  },
  oauth_m365: {
    label: "Email — Microsoft 365 (OAuth)", transport: "email",
    help: "Add the Mail.Send application permission to this app's Enterprise application in Azure (App registration → API permissions → Microsoft Graph → Application permissions → Mail.Send) and grant admin consent. The send-as user must be a licensed Exchange Online mailbox.",
    fields: [
      { key: "tenantId", label: "Tenant ID", kind: "text" },
      { key: "clientId", label: "Client ID", kind: "text" },
      { key: "clientSecret", label: "Client secret", kind: "password", secret: true },
      { key: "fromUserId", label: "Send-as user (UPN or object ID)", kind: "text", placeholder: "alerts@example.com" },
    ],
  },
  pushbullet: {
    label: "Pushbullet", transport: "pushbullet",
    fields: [
      { key: "accessToken", label: "Access token", kind: "password", secret: true },
    ],
  },
  slack: {
    label: "Slack", transport: "webhook",
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", kind: "password", secret: true, placeholder: "https://hooks.slack.com/services/…" },
    ],
  },
  teams: {
    label: "Microsoft Teams", transport: "webhook",
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", kind: "password", secret: true, placeholder: "https://outlook.office.com/webhook/…" },
    ],
  },
  web_push: {
    label: "Web Push (browser & mobile)", transport: "web_push", singleton: true,
    fields: [
      { key: "subject", label: "Contact subject (mailto: or https:)", kind: "text", placeholder: "mailto:admin@example.com" },
      // publicKey + privateKey are generated server-side, not free-typed.
    ],
  },
};

export const deliveryTargetSchema = z.object({
  channelId: z.string().min(1).max(100),
  // Recipient sources (combine freely; only meaningful for recipient-routed
  // channel types — email + web_push). Chat/Pushbullet ignore these.
  recipientUserIds: z.array(z.string().max(100)).max(500).optional(), // specific Polaris users → their email / push subs
  addresses: z.array(z.string().email().max(320)).max(100).optional(), // custom email addresses (email channels)
  recipientScopeRegion: z.boolean().optional(), // users whose region tags match the rule's scope region tag(s)
  recipientDeviceRegion: z.boolean().optional(), // users whose region tags match the TRIGGERING asset's region: tag(s)
  recipientAssetContacts: z.boolean().optional(), // address-book contacts owning the TRIGGERING asset (email only)
  // Every user holding one of these ROLES. Stored as role IDS, not names: a
  // role can be renamed, and User.roleId / ApiToken / GroupMapping all key on
  // the id already. Resolves to users, so it works on email AND web_push.
  recipientRoles: z.array(z.string().max(100)).max(50).optional(),
  // Broadcast modes — web_push only (rejected on other channel types at rule
  // save). recipientAllUsers = every user account; recipientAllRegions = every
  // user carrying at least one region tag; recipientRegions = users in the
  // NAMED regions. Names are stored BARE ("Atlanta"), matching how
  // User/Role/GroupMapping.regionTags are stored — the `region:` prefix only
  // exists on ASSET tags.
  recipientAllUsers: z.boolean().optional(),
  recipientAllRegions: z.boolean().optional(),
  recipientRegions: z.array(z.string().max(100)).max(200).optional(),
  recipientTags: z.array(z.string().max(100)).max(200).optional(), // legacy tag-routing (kept for back-compat)
});

// ─── Rule-level email composition + escalation ──────────────────────────────
// emailComposition customizes the OUTBOUND EMAIL a rule's email targets send
// (subject / text / HTML bodies + Cc/Bcc). Templates render through
// renderNotificationTemplate (src/utils/notificationTemplate.ts) — single-brace
// {token} vocabulary, cataloged in TEMPLATE_VARIABLES. When set, each email
// target sends ONE message (full To list + Cc + Bcc) instead of the default
// one-email-per-To-address fan-out. NULL = pre-feature default behavior.
// Email-only: chat/pushbullet/web_push channels ignore it.

const emailRecipientsSchema = z
  .object({
    recipientUserIds: z.array(z.string().max(100)).max(500).optional(), // Polaris users → their emails
    addresses: z.array(z.string().email().max(320)).max(100).optional(), // custom email addresses
    recipientRoles: z.array(z.string().max(100)).max(50).optional(), // Role IDS → every user holding them
  })
  .strict();

export const emailCompositionSchema = z
  .object({
    subjectTemplate: z.string().max(500).optional().nullable(),
    bodyTextTemplate: z.string().max(10000).optional().nullable(),
    bodyHtmlTemplate: z.string().max(20000).optional().nullable(),
    cc: emailRecipientsSchema.optional().nullable(),
    bcc: emailRecipientsSchema.optional().nullable(),
  })
  .strict();

// Escalation: ordered tiers of follow-up emails while the notification stays
// unhandled (stopOn: "acknowledge" stops on ack OR clear; "clear" ignores ack).
// Tier channels must be email-type (validated at rule save). Tier subject/body
// overrides fall back to the rule's emailComposition, then the defaults.
// Swept by the escalateNotifications job (60s).
export const escalationTierSchema = z
  .object({
    afterMin: z.number().int().min(1).max(10080), // ≤ 1 week
    channelId: z.string().min(1).max(100),
    to: emailRecipientsSchema.refine(
      (r) => (r.recipientUserIds?.length ?? 0) + (r.addresses?.length ?? 0) > 0,
      { message: "Escalation tier needs at least one To recipient" },
    ),
    cc: emailRecipientsSchema.optional().nullable(),
    bcc: emailRecipientsSchema.optional().nullable(),
    subjectTemplate: z.string().max(500).optional().nullable(),
    bodyTextTemplate: z.string().max(10000).optional().nullable(),
    bodyHtmlTemplate: z.string().max(20000).optional().nullable(),
    repeatEveryMin: z.number().int().min(5).max(1440).optional().nullable(),
    maxRepeats: z.number().int().min(1).max(20).optional().nullable(), // default 5 when repeating
  })
  .strict();

export const escalationSchema = z
  .object({
    stopOn: z.enum(["acknowledge", "clear"]).default("acknowledge"),
    tiers: z.array(escalationTierSchema).min(1).max(5),
  })
  .strict();

// ─── Rule shape v2: reset + unified actions (Automations redesign) ──────────
// `reset` supersedes clearBehavior/clearAfterSec (auto gains hysteresis +
// clear-sustain); `actions` supersedes `targets` as the unified fired-outcome
// list (notify | api_call | script). Legacy columns stay stored as a lossless
// mirror (legacyMirrorOfV2) and legacy INPUT stays accepted — the transform on
// ruleInputSchema folds old POST bodies into v2, so pre-rename API clients and
// the pre-wizard UI keep working against the alias paths.

export const RESET_MODES = ["manual", "auto", "timed", "condition"] as const;
export type ResetMode = (typeof RESET_MODES)[number];

export const resetSchema = z
  .object({
    mode: z.enum(RESET_MODES).default("manual"),
    // auto only — hysteresis: the alert recovers when the value no longer
    // meets `trigger.operator clearThreshold` (a fire at cpu >= 90 with
    // clearThreshold 80 clears at < 80). Omit = recover at the fire threshold.
    clearThreshold: z.number().optional().nullable(),
    // auto + condition — clear-sustain: the recovery must hold this long
    // before the alert auto-clears. 0/omit = clear on first recovered tick.
    sustainSec: z.number().int().min(0).max(86400).optional().nullable(),
    // timed only (the old clearAfterSec).
    afterSec: z.number().int().min(1).max(2592000).optional().nullable(),
    // condition only — a custom AND/OR reset tree (same leaf vocabulary as the
    // composite trigger). While the alert is firing, this tree is the sole
    // recovery authority. v1-restricted to composite triggers of the same
    // kind (validateRuleV2); per-dimension single triggers keep auto/hysteresis.
    condition: triggerConditionGroupSchema.optional().nullable(),
  })
  .strict();

export const API_CALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const SCRIPT_RUN_TARGETS = ["server", "agent"] as const;
// Interpreter vocabulary for the AutomationScript registry (owned here — the
// vocabulary file — so the catalog, the script service, and the routes never
// drift; the Go agent mirrors this list in scriptexec).
export const SCRIPT_INTERPRETERS = ["bash", "sh", "powershell", "cmd", "python3"] as const;
export type ScriptInterpreter = (typeof SCRIPT_INTERPRETERS)[number];

export const notifyActionSchema = z
  .object({
    type: z.literal("notify"),
    channelId: z.string().min(1).max(100),
    // Recipient sources — same semantics as deliveryTargetSchema (meaningful
    // for recipient-routed channel types only; chat/pushbullet ignore them).
    recipientUserIds: z.array(z.string().max(100)).max(500).optional(),
    addresses: z.array(z.string().email().max(320)).max(100).optional(),
    recipientScopeRegion: z.boolean().optional(),
    // Route to users whose region tags match the TRIGGERING asset's region:
    // tag(s) — works with any device filter (no region: tag needed on the
    // scope). The engine threads the asset's stripped region snapshot into
    // the expander (Notification.regionTags on the escalation sweep).
    recipientDeviceRegion: z.boolean().optional(),
    // Route to the address-book contacts RESPONSIBLE for the triggering asset
    // (Contact.assetCriteria ∪ Contact.assetIds). Same union semantics as
    // recipientDeviceRegion and works with any device filter — the difference
    // is that ownership is stated once on the contact instead of per rule.
    // Email transports only: a contact is an address, not an account, so there
    // is no push subscription to reach.
    recipientAssetContacts: z.boolean().optional(),
    // Every user holding one of these ROLES (role ids — see deliveryTargetSchema).
    recipientRoles: z.array(z.string().max(100)).max(50).optional(),
    // Broadcast modes — see deliveryTargetSchema. web_push only; validated at
    // rule save so the model can never hold a state the builder won't render.
    recipientAllUsers: z.boolean().optional(),
    recipientAllRegions: z.boolean().optional(),
    recipientRegions: z.array(z.string().max(100)).max(200).optional(),
    recipientTags: z.array(z.string().max(100)).max(200).optional(),
    // Per-action email composition override; falls back to the rule-level
    // emailComposition, then the pre-feature defaults. Email transports only.
    emailComposition: emailCompositionSchema.optional().nullable(),
  })
  .strict();

// SECURITY: headers are stored UNMASKED on the rule (and echoed onto delivery
// rows) — the catalog + docs tell operators never to put credentials here.
// The URL is static (no {token}s) so the SSRF host check at save time checks
// what actually gets fetched; only bodyTemplate takes template tokens.
export const apiCallActionSchema = z
  .object({
    type: z.literal("api_call"),
    method: z.enum(API_CALL_METHODS).default("POST"),
    url: z
      .string()
      .max(2000)
      .url()
      .refine((u) => /^https?:\/\//i.test(u), { message: "api_call URL must be http(s)" }),
    headers: z
      .record(z.string().max(1000))
      .refine((h) => Object.keys(h).length <= 20, { message: "at most 20 headers" })
      .refine((h) => Object.keys(h).every((k) => k.length >= 1 && k.length <= 100), {
        message: "header names must be 1–100 characters",
      })
      .optional(),
    bodyTemplate: z.string().max(10000).optional().nullable(), // {token} vocabulary
    timeoutSec: z.number().int().min(1).max(60).default(15),
  })
  .strict();

export const scriptActionSchema = z
  .object({
    type: z.literal("script"),
    scriptId: z.string().min(1).max(100), // AutomationScript registry id
    runOn: z.enum(SCRIPT_RUN_TARGETS),
    argsTemplate: z.string().max(2000).optional().nullable(), // {token} vocabulary
    timeoutSec: z.number().int().min(1).max(600).optional().nullable(), // overrides the script default
  })
  .strict();

// Write the `notification.triggered` audit Event on every fire. Present by
// default (a migration appended it to every pre-existing rule, and the legacy
// normalizer injects it) so nothing silently stops auditing; removing it is an
// explicit operator choice for a noisy automation.
//
// This does NOT govern the in-app Alert. The Notification row is structural —
// every NotificationDelivery hangs off its id, as do the escalation sweep,
// acknowledge/clear and the rule state machine — so a notify/api_call action
// could not exist without it. Only the audit Event is optional.
export const eventActionSchema = z
  .object({
    type: z.literal("event"),
  })
  .strict();

export const actionSchema = z.discriminatedUnion("type", [
  notifyActionSchema,
  apiCallActionSchema,
  scriptActionSchema,
  eventActionSchema,
]);

// Escalation v2: tiers of ACTIONS (any type), superseding the email-only tier
// shape. The stored/input escalation stays on the legacy schema until the
// escalation-v2 phase flips the sweep onto executeActions; the v2 schema +
// normalizeEscalationToV2 land now so the conversion is testable and shared.
export const escalationTierV2Schema = z
  .object({
    afterMin: z.number().int().min(1).max(10080),
    actions: z.array(actionSchema).min(1).max(10),
    repeatEveryMin: z.number().int().min(5).max(1440).optional().nullable(),
    maxRepeats: z.number().int().min(1).max(20).optional().nullable(),
  })
  .strict();

export const escalationV2Schema = z
  .object({
    stopOn: z.enum(["acknowledge", "clear"]).default("acknowledge"),
    tiers: z.array(escalationTierV2Schema).min(1).max(5),
  })
  .strict();

// ─── Per-action escalation (escalatable actions) ────────────────────────────
// A rule's top-level actions and each severity band's actions may carry their
// OWN escalation chain — "notify team A, and if unhandled 15 min later notify
// their manager" — instead of (or alongside) the rule/band-level chain. The
// chain shape is the same escalation config; accepts legacy email tiers too
// (readers normalize via normalizeEscalationToV2). ONE level only: actions
// INSIDE escalation tiers (and bandNotify.resolvedActions) stay on the bare
// actionSchema, so a nested `escalation` key fails .strict() parsing — no
// chains-of-chains. Escalation state keys are derived per chain:
// escalationTierStateKey("", j) = "j" (the rule/band-level chain — unchanged
// from pre-feature rows) and escalationTierStateKey("a<i>", j) = "a<i>:t<j>".
const perActionEscalation = z.union([escalationSchema, escalationV2Schema]).optional().nullable();

export const notifyActionEscalatableSchema = notifyActionSchema.extend({ escalation: perActionEscalation });
export const apiCallActionEscalatableSchema = apiCallActionSchema.extend({ escalation: perActionEscalation });
export const scriptActionEscalatableSchema = scriptActionSchema.extend({ escalation: perActionEscalation });

export const escalatableActionSchema = z.discriminatedUnion("type", [
  notifyActionEscalatableSchema,
  apiCallActionEscalatableSchema,
  scriptActionEscalatableSchema,
  // No per-action escalation: an audit Event is instantaneous, so there is
  // nothing to chase if it goes "unhandled".
  eventActionSchema,
]);
export type EscalatableAction = z.infer<typeof escalatableActionSchema>;

// ─── Severity bands (value-driven severity escalation) ──────────────────────
// Higher tiers stacked on the base trigger (tier 0 = rule.severity +
// trigger.threshold + rule.actions + rule.escalation). Each band carries its
// OWN actions (run when the alert enters that band) and its own time-based
// escalation (per-band, swept band-aware). Cross-field ordering (thresholds
// monotonic in the operator direction, severities strictly increasing above
// the base) is enforced in validateRuleV2 (discriminated-union members can't
// carry a superRefine, and the base severity lives on the rule).
export const severityBandSchema = z
  .object({
    threshold: z.number(),
    severity: z.enum(SEVERITIES),
    // Per-tier comparison operator (falls back to the trigger's). Tiers share
    // the trigger's sampling — aggregation / window / dimensionFilter — so only
    // the comparison + threshold + severity + sustain vary per tier.
    operator: z.enum(COMPARATORS).optional(),
    // Per-tier sustained duration: how long the value must hold IN THIS BAND
    // before the alert takes this severity. Omitted = inherit the base
    // trigger's forDurationSec (every pre-feature band); 0 = apply immediately.
    forDurationSec: z.number().int().min(0).max(86400).optional(),
    actions: z.array(escalatableActionSchema).max(20).default([]),
    // Per-band time escalation (same shape as rule-level; accepts legacy or v2).
    escalation: z.union([escalationSchema, escalationV2Schema]).optional().nullable(),
  })
  .strict();
export type SeverityBand = z.infer<typeof severityBandSchema>;

// Per-automation policy: which band transitions notify, and how a resolved
// (below tier 0) alert notifies. onIncrease/onResolved default on; onDecrease
// off (page when it worsens, not when it eases). resolvedMode picks whether the
// all-clear reuses the last-fired band's actions or a dedicated list.
export const bandNotifySchema = z
  .object({
    onIncrease: z.boolean().default(true),
    onDecrease: z.boolean().default(false),
    onResolved: z.boolean().default(true),
    resolvedMode: z.enum(["reuse", "dedicated"]).default("reuse"),
    resolvedActions: z.array(actionSchema).max(20).optional().nullable(),
  })
  .strict();
export type BandNotify = z.infer<typeof bandNotifySchema>;

export type Trigger = z.infer<typeof triggerSchema>;
export type RuleScope = z.infer<typeof scopeSchema>;
export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;
export type EmailRecipients = z.infer<typeof emailRecipientsSchema>;
export type EmailComposition = z.infer<typeof emailCompositionSchema>;
export type EscalationTier = z.infer<typeof escalationTierSchema>;
export type EscalationConfig = z.infer<typeof escalationSchema>;
export type ResetConfig = z.infer<typeof resetSchema>;
export type NotifyAction = z.infer<typeof notifyActionSchema>;
export type ApiCallAction = z.infer<typeof apiCallActionSchema>;
export type ScriptAction = z.infer<typeof scriptActionSchema>;
export type AutomationAction = z.infer<typeof actionSchema>;
export type EscalationTierV2 = z.infer<typeof escalationTierV2Schema>;
export type EscalationV2Config = z.infer<typeof escalationV2Schema>;

// ─── Specificity ranking (automation precedence / carve-out) ────────────────
// A more-specific automation carves the assets it covers out of a less-specific
// one that watches the SAME trigger (triggerSignature). Specificity = the
// most-specific scope dimension an automation positively constrains, on this
// ladder (least → most). Lifecycle status + asset id are deliberately absent —
// status is a state qualifier, not an identity dimension, and asset id is no
// longer offered in the builder.
export const SCOPE_RANK = {
  allAssets: 0,
  assetType: 1,
  os: 2,
  manufacturer: 3,
  model: 4,
  tag: 5,
  region: 6,
  subnet: 7,
  hostname: 8,
} as const;

/** Ladder for the wizard's "Specificity: …" indicator (least → most). */
export const SCOPE_RANK_LADDER: { key: keyof typeof SCOPE_RANK; label: string }[] = [
  { key: "allAssets", label: "All assets" },
  { key: "assetType", label: "Device type" },
  { key: "os", label: "Operating system" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "model", label: "Model" },
  { key: "tag", label: "Tag" },
  { key: "region", label: "Region" },
  { key: "subnet", label: "Subnet" },
  { key: "hostname", label: "Hostname" },
];

/** Human label for a numeric specificity rank (the ladder rung at or below it). */
export function scopeRankLabel(rank: number): string {
  let label = SCOPE_RANK_LADDER[0].label;
  for (const rung of SCOPE_RANK_LADDER) {
    if (SCOPE_RANK[rung.key] <= rank) label = rung.label;
  }
  return label;
}

// Condition-rule operators that POSITIVELY narrow to specific assets. Negative
// operators (notEquals/notHas/…) and none/notAll groups broaden rather than
// target, so they never raise specificity.
const POSITIVE_SCOPE_OPS = new Set(["equals", "contains", "startsWith", "endsWith", "has", "inCidr"]);

function isRegionTagValue(v: string): boolean {
  return v.trim().toLowerCase().startsWith("region:");
}

function conditionRuleRank(rule: ScopeConditionRule): number {
  if (!POSITIVE_SCOPE_OPS.has(rule.operator)) return 0;
  switch (rule.field) {
    case "assetType": return SCOPE_RANK.assetType;
    case "os": return SCOPE_RANK.os;
    case "manufacturer": return SCOPE_RANK.manufacturer;
    case "model": return SCOPE_RANK.model;
    case "tag": return isRegionTagValue(rule.value) ? SCOPE_RANK.region : SCOPE_RANK.tag;
    case "subnet": return SCOPE_RANK.subnet;
    case "hostname": return SCOPE_RANK.hostname;
    default: return 0; // status, assetId — not on the ladder
  }
}

function conditionTreeRank(group: ScopeConditionGroup): number {
  // Only AND/OR subtrees positively target; none/notAll invert to "must NOT".
  if (group.op !== "and" && group.op !== "or") return 0;
  let rank = 0;
  for (const child of group.children) {
    rank = Math.max(
      rank,
      "op" in child ? conditionTreeRank(child as ScopeConditionGroup) : conditionRuleRank(child as ScopeConditionRule),
    );
  }
  return rank;
}

/**
 * Specificity rank of a scope = the most-specific dimension it positively
 * constrains, across BOTH the flat dimensions and the condition tree. 0 =
 * all-assets / unconstrained.
 */
export function scopeRank(scope: RuleScope): number {
  let rank = 0;
  if (scope.assetTypes?.length) rank = Math.max(rank, SCOPE_RANK.assetType);
  if (scope.manufacturers?.length) rank = Math.max(rank, SCOPE_RANK.manufacturer);
  if (scope.models?.length) rank = Math.max(rank, SCOPE_RANK.model);
  if (scope.subnetCidrs?.length) rank = Math.max(rank, SCOPE_RANK.subnet);
  for (const t of scope.tags ?? []) {
    rank = Math.max(rank, isRegionTagValue(t) ? SCOPE_RANK.region : SCOPE_RANK.tag);
  }
  if (scope.condition) rank = Math.max(rank, conditionTreeRank(scope.condition));
  return rank;
}

// ─── Trigger signature (carve-out "same trigger" key) ───────────────────────
// Two automations carve-out only when they watch the SAME thing. The signature
// is the metric/field + its dimension filter (strict: a sensor-class filter and
// no filter are different things and never shadow each other — erring toward an
// extra alert over a wrongly-silenced one). Returns null for triggers that
// don't participate in carve-out (host has no asset scope; composite watches
// many things; event/change are per-event, not per-asset thresholds).
function stableDimFilter(df: Record<string, unknown> | undefined | null): string {
  if (!df) return "";
  const keys = Object.keys(df).filter((k) => df[k] !== undefined && df[k] !== null && df[k] !== "").sort();
  return keys.map((k) => `${k}=${String(df[k])}`).join(",");
}

export function triggerSignature(trigger: Trigger): string | null {
  if (trigger.type === "asset_metric") return `am:${trigger.metric}:${stableDimFilter(trigger.dimensionFilter)}`;
  if (trigger.type === "asset_state") return `as:${trigger.field}:${stableDimFilter(trigger.dimensionFilter)}`;
  return null;
}

// ─── Input schema (accepts v2 AND legacy bodies; canonical output is v2) ────

const ruleInputBaseSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  enabled: z.boolean().default(true),
  severity: z.enum(SEVERITIES).default("warning"),
  trigger: triggerSchema,
  scope: scopeSchema.default({}),
  // v2 canonical fields:
  reset: resetSchema.optional().nullable(),
  actions: z.array(escalatableActionSchema).max(20).optional(),
  // Legacy fields, folded into v2 by the transform (v2 wins when both given):
  clearBehavior: z.enum(CLEAR_BEHAVIORS).optional(),
  clearAfterSec: z.number().int().min(1).max(2592000).optional().nullable(),
  targets: z.array(deliveryTargetSchema).max(50).optional(),
  // Shared fields:
  cooldownSec: z.number().int().min(0).max(2592000).optional().nullable(),
  messageTemplate: z.string().max(2000).optional().nullable(),
  channels: z.array(z.string().max(50)).default(["in_app"]),
  emailComposition: emailCompositionSchema.optional().nullable(),
  // Accepts BOTH shapes: legacy email tiers (pre-wizard UI) and v2 tiers of
  // actions. Stored as given; every reader normalizes via
  // normalizeEscalationToV2 (part of normalizeRuleToV2).
  escalation: z.union([escalationSchema, escalationV2Schema]).optional().nullable(),
  // Severity bands + notify policy (value-driven severity escalation). Bands
  // are numeric-metric-trigger only (enforced in validateRuleV2).
  severityBands: z.array(severityBandSchema).max(4).optional().nullable(),
  bandNotify: bandNotifySchema.optional().nullable(),
});

type RuleInputRaw = z.infer<typeof ruleInputBaseSchema>;

/** Canonical (v2) rule input — what the service layer persists. */
export interface RuleInput {
  name: string;
  description: string | null;
  enabled: boolean;
  severity: (typeof SEVERITIES)[number];
  trigger: Trigger;
  scope: RuleScope;
  reset: ResetConfig;
  actions: EscalatableAction[];
  cooldownSec: number | null;
  messageTemplate: string | null;
  channels: string[];
  emailComposition: EmailComposition | null;
  /** As posted (legacy email tiers OR v2 tiers-of-actions) — stored verbatim;
   *  readers normalize through normalizeEscalationToV2. */
  escalation: EscalationConfig | EscalationV2Config | null;
  /** Severity bands (numeric triggers only); null = single-severity. */
  severityBands: SeverityBand[] | null;
  /** Band-transition notify policy; null = defaults. */
  bandNotify: BandNotify | null;
}

/** Preview input = RuleInput with trigger optional (scope-only preview mode).
 *  `id` (when editing) lets the carve-out preview exclude the rule itself. */
export type PreviewRuleInput = Omit<RuleInput, "trigger" | "name"> & {
  name: string;
  trigger?: Trigger;
  id?: string;
};

/** clearBehavior/clearAfterSec → v2 reset. Also sanitizes a provided reset:
 *  mode-irrelevant fields are stripped so stored shapes stay canonical. */
export function normalizeReset(
  reset: ResetConfig | null | undefined,
  clearBehavior?: string | null,
  clearAfterSec?: number | null,
): ResetConfig {
  if (reset) {
    if (reset.mode === "auto") {
      return { mode: "auto", clearThreshold: reset.clearThreshold ?? null, sustainSec: reset.sustainSec ?? null };
    }
    if (reset.mode === "condition") {
      return { mode: "condition", condition: reset.condition ?? null, sustainSec: reset.sustainSec ?? null };
    }
    if (reset.mode === "timed") return { mode: "timed", afterSec: reset.afterSec ?? null };
    return { mode: "manual" };
  }
  const mode: ResetMode = clearBehavior === "auto" || clearBehavior === "timed" ? clearBehavior : "manual";
  if (mode === "timed") return { mode: "timed", afterSec: clearAfterSec ?? null };
  return mode === "auto" ? { mode: "auto" } : { mode: "manual" };
}

/** Legacy delivery targets → notify actions. The rule-level emailComposition
 *  is copied onto every converted action (the executor applies it only on
 *  email transports — matching the legacy behavior where non-email channels
 *  ignored it). */
export function targetsToNotifyActions(
  targets: DeliveryTarget[] | null | undefined,
  emailComposition: EmailComposition | null,
): AutomationAction[] {
  return (targets ?? []).map((t) => ({
    type: "notify" as const,
    channelId: t.channelId,
    ...(t.recipientUserIds?.length ? { recipientUserIds: t.recipientUserIds } : {}),
    ...(t.addresses?.length ? { addresses: t.addresses } : {}),
    ...(t.recipientScopeRegion !== undefined ? { recipientScopeRegion: t.recipientScopeRegion } : {}),
    ...(t.recipientDeviceRegion !== undefined ? { recipientDeviceRegion: t.recipientDeviceRegion } : {}),
    ...(t.recipientAssetContacts !== undefined ? { recipientAssetContacts: t.recipientAssetContacts } : {}),
    ...(t.recipientRoles?.length ? { recipientRoles: t.recipientRoles } : {}),
    ...(t.recipientAllUsers !== undefined ? { recipientAllUsers: t.recipientAllUsers } : {}),
    ...(t.recipientAllRegions !== undefined ? { recipientAllRegions: t.recipientAllRegions } : {}),
    ...(t.recipientRegions?.length ? { recipientRegions: t.recipientRegions } : {}),
    ...(t.recipientTags?.length ? { recipientTags: t.recipientTags } : {}),
    emailComposition: emailComposition ?? null,
  }));
}

/** notify actions → legacy delivery targets (per-action emailComposition is
 *  dropped — it has no legacy representation; the rule-level column carries
 *  the shared composition). api_call/script actions have no legacy mirror. */
export function actionsToTargets(actions: AutomationAction[]): DeliveryTarget[] {
  return actions
    .filter((a): a is NotifyAction => a.type === "notify")
    .map((a) => ({
      channelId: a.channelId,
      ...(a.recipientUserIds?.length ? { recipientUserIds: a.recipientUserIds } : {}),
      ...(a.addresses?.length ? { addresses: a.addresses } : {}),
      ...(a.recipientScopeRegion !== undefined ? { recipientScopeRegion: a.recipientScopeRegion } : {}),
      ...(a.recipientDeviceRegion !== undefined ? { recipientDeviceRegion: a.recipientDeviceRegion } : {}),
      ...(a.recipientAssetContacts !== undefined ? { recipientAssetContacts: a.recipientAssetContacts } : {}),
      ...(a.recipientRoles?.length ? { recipientRoles: a.recipientRoles } : {}),
      ...(a.recipientAllUsers !== undefined ? { recipientAllUsers: a.recipientAllUsers } : {}),
      ...(a.recipientAllRegions !== undefined ? { recipientAllRegions: a.recipientAllRegions } : {}),
      ...(a.recipientRegions?.length ? { recipientRegions: a.recipientRegions } : {}),
      ...(a.recipientTags?.length ? { recipientTags: a.recipientTags } : {}),
    }));
}

/** The lossless legacy projection of a v2 rule, kept mirrored on the legacy
 *  columns at save time so pre-wizard UIs and restored backups stay coherent. */
export function legacyMirrorOfV2(
  reset: ResetConfig,
  actions: AutomationAction[],
): { clearBehavior: (typeof CLEAR_BEHAVIORS)[number]; clearAfterSec: number | null; targets: DeliveryTarget[] } {
  return {
    // "condition" has no legacy representation — "auto" is the closest
    // semantic (clears without operator action) for pre-wizard readers.
    clearBehavior: reset.mode === "condition" ? "auto" : reset.mode,
    clearAfterSec: reset.mode === "timed" ? (reset.afterSec ?? null) : null,
    targets: actionsToTargets(actions),
  };
}

function normalizeRuleInputCore(raw: Omit<RuleInputRaw, "trigger">): Omit<RuleInput, "trigger"> {
  return {
    name: raw.name,
    description: raw.description ?? null,
    enabled: raw.enabled,
    severity: raw.severity,
    scope: raw.scope,
    reset: normalizeReset(raw.reset, raw.clearBehavior, raw.clearAfterSec),
    // Legacy body (targets, no actions) folded forward. The audit-Event action
    // is added by withEventAction() at the call sites, which know the trigger.
    actions: raw.actions ?? targetsToNotifyActions(raw.targets, raw.emailComposition ?? null),
    cooldownSec: raw.cooldownSec ?? null,
    messageTemplate: raw.messageTemplate ?? null,
    channels: raw.channels,
    emailComposition: raw.emailComposition ?? null,
    escalation: raw.escalation ?? null,
    severityBands: raw.severityBands?.length ? raw.severityBands : null,
    bandNotify: raw.bandNotify ?? null,
  };
}

/** Cross-field validation over the NORMALIZED v2 shape. */
/** Severity-band cross-field validation: numeric ordered trigger only, band
 *  thresholds monotonic in the operator direction, severities strictly
 *  increasing above the base. */
function validateSeverityBands(
  v: { trigger?: Trigger; severity?: Severity; severityBands?: SeverityBand[] | null },
  ctx: z.RefinementCtx,
): void {
  const bands = v.severityBands;
  if (!bands || bands.length === 0) return;
  const t = v.trigger;
  if (!t || (t.type !== "asset_metric" && t.type !== "host_metric")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severityBands"], message: "severity bands apply only to numeric metric triggers (asset metric / Polaris host)" });
    return;
  }
  if (t.operator === "==" || t.operator === "!=") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severityBands"], message: "severity bands need an ordered operator (>, >=, <, <=)" });
    return;
  }
  // Severities must STRICTLY INCREASE tier-over-tier (the "only increase
  // severity" rule). Tiers may carry their own ordered operator (they share the
  // trigger's sampling); the value is compared to each tier and the most-severe
  // MET tier wins, so per-tier thresholds need not be monotonic.
  let prevRank = severityRank(v.severity ?? "warning");
  bands.forEach((b, i) => {
    const rank = severityRank(b.severity);
    if (rank <= prevRank) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severityBands", i, "severity"], message: "each added severity must be higher than the one before it" });
    }
    if (b.operator && (b.operator === "==" || b.operator === "!=")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severityBands", i, "operator"], message: "severity tiers need an ordered operator (>, >=, <, <=)" });
    }
    prevRank = rank;
  });
}

function validateRuleV2(
  v: { trigger?: Trigger; reset: ResetConfig; severity?: Severity; severityBands?: SeverityBand[] | null; bandNotify?: BandNotify | null },
  ctx: z.RefinementCtx,
): void {
  const { trigger, reset } = v;
  if (trigger?.type === "composite") validateCompositeTrigger(trigger, ctx);
  validateSeverityBands(v, ctx);
  if (reset.mode === "timed" && reset.afterSec == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "afterSec"], message: "timed reset requires afterSec" });
  }
  if (reset.mode === "condition") {
    if (!reset.condition) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "condition"], message: "condition reset requires a condition tree" });
    } else if (trigger && trigger.type !== "composite") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "condition"],
        message: "a custom reset condition requires a multi-condition (composite) trigger — single-condition automations use the automatic reset (optionally with a clear threshold)",
      });
    } else {
      const stats = triggerConditionStats(reset.condition);
      if (stats.depth > 3) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "condition"], message: "reset condition groups nest at most 3 deep" });
      }
      if (stats.leaves > 10) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "condition"], message: "at most 10 conditions per reset tree" });
      }
      if (trigger?.type === "composite") {
        const badLeaf = collectTriggerLeaves(reset.condition).find((l) =>
          trigger.kind === "host" ? l.type !== "host_metric" : l.type === "host_metric",
        );
        if (badLeaf) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["reset", "condition"],
            message: "reset conditions must match the trigger's kind (device vs Polaris-host conditions)",
          });
        }
      }
    }
  }
  if (reset.mode === "auto" && reset.clearThreshold != null && trigger) {
    if (trigger.type !== "asset_metric" && trigger.type !== "host_metric") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: "a clear threshold (hysteresis) only applies to numeric metric triggers",
      });
      return;
    }
    const op = trigger.operator;
    const t = trigger.threshold;
    const c = reset.clearThreshold;
    if (op === "==" || op === "!=") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: `a clear threshold cannot be combined with the ${op} operator`,
      });
    } else if ((op === ">" || op === ">=") && c > t) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: `clear threshold must be at or below the fire threshold (${t}) for operator ${op}`,
      });
    } else if ((op === "<" || op === "<=") && c < t) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: `clear threshold must be at or above the fire threshold (${t}) for operator ${op}`,
      });
    }
  }
}

/**
 * Re-add the audit-Event action to a body that arrived WITHOUT an actions array
 * — a legacy shape, or a minimal API create. Before the Event became an action
 * such a rule still wrote `notification.triggered`, so omitting it here would
 * silently drop auditing for those callers.
 *
 * An EXPLICIT `actions: []` is respected (`??` only fires on undefined), which
 * is how an API caller opts out. Skipped for event/change triggers, matching
 * migration 20260810120000_event_action: the event tail writes no Events, so
 * the action would be dead weight the builder then warns about.
 */
function withEventAction<T extends { actions: EscalatableAction[] }>(
  core: T,
  rawActions: unknown,
  trigger: unknown,
): T {
  if (rawActions !== undefined) return core;
  if (isEventDrivenTrigger(trigger)) return core;
  return { ...core, actions: [...core.actions, { type: "event" as const }] };
}

export const ruleInputSchema = ruleInputBaseSchema
  .transform((raw): RuleInput => ({
    trigger: collapseCompositeTrigger(raw.trigger),
    ...withEventAction(normalizeRuleInputCore(raw), raw.actions, raw.trigger),
  }))
  .superRefine(validateRuleV2);

// Preview accepts partial drafts: name defaulted, trigger optional (a
// scope-only body lists the matched devices — the wizard's Step-2 preview).
export const previewInputSchema = ruleInputBaseSchema
  .extend({
    name: z.string().min(1).max(200).default("Draft automation"),
    trigger: triggerSchema.optional(),
    // When editing, the rule's own id so the carve-out preview excludes itself.
    id: z.string().max(100).optional(),
  })
  .transform((raw): PreviewRuleInput => ({
    trigger: raw.trigger ? collapseCompositeTrigger(raw.trigger) : undefined,
    id: raw.id,
    ...withEventAction(normalizeRuleInputCore(raw), raw.actions, raw.trigger),
  }))
  .superRefine(validateRuleV2);

// ─── Read-path normalizer (DB row → v2 view) ────────────────────────────────

/** The v2 view of a stored rule row. */
export interface RuleV2View {
  reset: ResetConfig;
  actions: EscalatableAction[];
  /** Escalation as v2 tiers-of-actions (legacy tiers converted); null when unset. */
  escalation: EscalationV2Config | null;
  /** Severity bands (numeric triggers); null = single-severity. */
  severityBands: SeverityBand[] | null;
  /** Band-transition notify policy; null = defaults. */
  bandNotify: BandNotify | null;
}

/** Legacy escalation tier → v2 tier of one notify action. Tier-level template
 *  overrides become the action's emailComposition (only the fields the tier
 *  set — per-field fallback to the rule composition stays with the executor). */
export function normalizeEscalationToV2(escalation: unknown): EscalationV2Config | null {
  if (!escalation || typeof escalation !== "object") return null;
  const raw = escalation as { stopOn?: unknown; tiers?: unknown };
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) return null;
  // Already v2? (tiers carry actions[])
  if ((raw.tiers[0] as { actions?: unknown })?.actions !== undefined) {
    const parsed = escalationV2Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  const parsedLegacy = escalationSchema.safeParse(raw);
  if (!parsedLegacy.success) return null;
  return {
    stopOn: parsedLegacy.data.stopOn,
    tiers: parsedLegacy.data.tiers.map((t) => {
      const hasComposition =
        t.subjectTemplate != null || t.bodyTextTemplate != null || t.bodyHtmlTemplate != null || t.cc != null || t.bcc != null;
      return {
        afterMin: t.afterMin,
        repeatEveryMin: t.repeatEveryMin ?? null,
        maxRepeats: t.maxRepeats ?? null,
        actions: [
          {
            type: "notify" as const,
            channelId: t.channelId,
            ...(t.to.recipientUserIds?.length ? { recipientUserIds: t.to.recipientUserIds } : {}),
            ...(t.to.addresses?.length ? { addresses: t.to.addresses } : {}),
            emailComposition: hasComposition
              ? {
                  subjectTemplate: t.subjectTemplate ?? null,
                  bodyTextTemplate: t.bodyTextTemplate ?? null,
                  bodyHtmlTemplate: t.bodyHtmlTemplate ?? null,
                  cc: t.cc ?? null,
                  bcc: t.bcc ?? null,
                }
              : null,
          },
        ],
      };
    }),
  };
}

/**
 * Normalize a stored rule row to the v2 view. Prefers the persisted v2
 * columns; falls back to converting the legacy columns (pre-v2 rows, restored
 * backups). Every reader — engine, escalation sweep, routes — goes through
 * this so v1 and v2 rows behave identically.
 */
/** event/change triggers — the engine's event tail writes no audit Events. */
function isEventDrivenTrigger(trigger: unknown): boolean {
  const t = (trigger as { type?: string } | null | undefined)?.type;
  return t === "event" || t === "change";
}

export function normalizeRuleToV2(row: {
  clearBehavior?: string | null;
  clearAfterSec?: number | null;
  /** Read only to decide whether the injected audit-Event action belongs —
   *  the event tail writes no Events, so an event/change rule must not get one. */
  trigger?: unknown;
  targets?: unknown;
  emailComposition?: unknown;
  escalation?: unknown;
  reset?: unknown;
  actions?: unknown;
  severityBands?: unknown;
  bandNotify?: unknown;
}): RuleV2View {
  const storedReset = row.reset ? resetSchema.safeParse(row.reset) : null;
  const reset = storedReset?.success
    ? normalizeReset(storedReset.data)
    : normalizeReset(null, row.clearBehavior, row.clearAfterSec);

  const emailComposition = row.emailComposition
    ? (emailCompositionSchema.safeParse(row.emailComposition).success
        ? (row.emailComposition as EmailComposition)
        : null)
    : null;

  let actions: EscalatableAction[];
  if (Array.isArray(row.actions)) {
    actions = row.actions
      .map((a) => escalatableActionSchema.safeParse(a))
      .filter((r): r is { success: true; data: EscalatableAction } => r.success)
      .map((r) => r.data);
  } else {
    // Pre-v2 row (or a restored pre-upgrade backup): fold legacy targets
    // forward and re-add the audit Event the engine now gates on, so an
    // un-migrated row keeps behaving exactly as it did. Mirrors migration
    // 20260810120000_event_action, carve-out included — an event/change
    // automation is driven BY Events and the tail writes none.
    const targets = Array.isArray(row.targets) ? (row.targets as DeliveryTarget[]) : [];
    actions = targetsToNotifyActions(targets, emailComposition) as EscalatableAction[];
    if (!isEventDrivenTrigger(row.trigger)) actions = [...actions, { type: "event" as const }];
  }

  const bands = Array.isArray(row.severityBands)
    ? row.severityBands
        .map((b) => severityBandSchema.safeParse(b))
        .filter((r): r is { success: true; data: SeverityBand } => r.success)
        .map((r) => r.data)
    : [];
  const severityBands = bands.length ? bands : null;
  const bandNotify = row.bandNotify && bandNotifySchema.safeParse(row.bandNotify).success
    ? bandNotifySchema.parse(row.bandNotify)
    : null;

  return { reset, actions, escalation: normalizeEscalationToV2(row.escalation), severityBands, bandNotify };
}

// ─── Canonical action walk + escalation-chain selection ─────────────────────
// Actions live in seven places on a rule: top-level actions, each top-level
// action's escalation tiers, the rule-level escalation tiers, each severity
// band's actions, each band action's escalation tiers, each band-level
// escalation tiers, and bandNotify.resolvedActions. Every consumer that must
// see ALL of them (the automationScripts route gate, assertActionRefs'
// channel/SSRF/script checks, ruleWantsAssetDetail) walks through
// allRuleActionRefs so a new action location can't silently escape a gate.

/** The minimal rule shape the walk needs — RuleInput and normalized rows both fit. */
export interface RuleActionCarrier {
  actions?: EscalatableAction[] | null;
  escalation?: unknown;
  severityBands?: SeverityBand[] | null;
  bandNotify?: BandNotify | null;
}

/**
 * An action's own escalation chain, or undefined for types that can't carry
 * one. `event` has no `escalation` key at all (an audit Event is instantaneous
 * — nothing to chase if it goes unhandled), so the discriminated union makes a
 * bare `a.escalation` a type error. This is the single place that narrows.
 */
function actionEscalation(a: EscalatableAction): unknown {
  return "escalation" in a ? a.escalation : undefined;
}

export interface RuleActionRef {
  action: AutomationAction;
  /** Human label for save-time validation errors ("Action 2 escalation tier 1: …"). */
  label: string;
}

export function allRuleActionRefs(rule: RuleActionCarrier): RuleActionRef[] {
  const out: RuleActionRef[] = [];
  const addTiers = (esc: unknown, prefix: string) => {
    (normalizeEscalationToV2(esc)?.tiers ?? []).forEach((t, ti) => {
      t.actions.forEach((a) => out.push({ action: a, label: `${prefix} escalation tier ${ti + 1}` }));
    });
  };
  const addActions = (list: EscalatableAction[] | null | undefined, prefix: string) => {
    (list ?? []).forEach((a, i) => {
      out.push({ action: a, label: `${prefix} ${i + 1}` });
      addTiers(actionEscalation(a), `${prefix} ${i + 1}`);
    });
  };
  addActions(rule.actions, "Action");
  addTiers(rule.escalation, "Rule");
  for (const b of rule.severityBands ?? []) {
    addActions(b.actions, `${b.severity} band action`);
    addTiers(b.escalation, `${b.severity} band`);
  }
  (rule.bandNotify?.resolvedActions ?? []).forEach((a, i) => out.push({ action: a, label: `Resolved action ${i + 1}` }));
  return out;
}

/** Whether ANY escalation chain exists anywhere on the rule (rule-level,
 *  per-action, band-level, or band-per-action). Drives ruleWantsContext —
 *  a rule with any chain needs the templateCtx snapshot for the sweep. */
export function ruleHasAnyEscalation(rule: RuleActionCarrier): boolean {
  const has = (esc: unknown) => (normalizeEscalationToV2(esc)?.tiers.length ?? 0) > 0;
  if (has(rule.escalation)) return true;
  if ((rule.actions ?? []).some((a) => has(actionEscalation(a)))) return true;
  return (rule.severityBands ?? []).some((b) => has(b.escalation) || (b.actions ?? []).some((a) => has(actionEscalation(a))));
}

/** One due-sweepable escalation chain: the rule/band-LEVEL chain (key "") or a
 *  per-action chain (key "a<i>", i = index in the severity's effective action
 *  list). Tier state in Notification.escalationState.tiers is keyed by
 *  escalationTierStateKey(chain.key, tierIdx). */
export interface EscalationChain {
  key: string;
  escalation: EscalationV2Config;
}

/** Escalation-state key for a tier: the level chain keeps the bare numeric
 *  keys pre-feature rows already carry; per-action chains use "a<i>:t<j>". */
export function escalationTierStateKey(chainKey: string, tierIdx: number): string {
  return chainKey ? `${chainKey}:t${tierIdx}` : String(tierIdx);
}

/**
 * All escalation chains active at a given alert severity — mirrors the
 * engine's tierForSeverity band semantics: at a band severity, the band's
 * actions (else the base actions — the band fallback) carry the per-action
 * chains, and the band's own level chain (else the rule's) is the "" chain.
 * Shared by the escalation sweep; band transitions reset escalationState, so
 * per-action keys never collide across bands.
 */
export function escalationChainsForSeverity(
  rule: RuleActionCarrier & { severity: string },
  severity: string,
): EscalationChain[] {
  let effActions = rule.actions ?? [];
  let levelEsc = normalizeEscalationToV2(rule.escalation);
  if (severity !== rule.severity) {
    const band = (rule.severityBands ?? []).find((b) => b.severity === severity);
    if (band) {
      if (band.actions?.length) effActions = band.actions;
      const bandEsc = normalizeEscalationToV2(band.escalation);
      if (bandEsc?.tiers.length) levelEsc = bandEsc;
    }
  }
  const chains: EscalationChain[] = [];
  if (levelEsc?.tiers.length) chains.push({ key: "", escalation: levelEsc });
  effActions.forEach((a, i) => {
    const esc = normalizeEscalationToV2(actionEscalation(a));
    if (esc?.tiers.length) chains.push({ key: `a${i}`, escalation: esc });
  });
  return chains;
}

/** Trigger categories that select assets via `scope` (vs. event/host).
 *  Composite triggers are scoped iff kind="asset" — use isAssetScopedTrigger. */
export const ASSET_SCOPED_TRIGGER_TYPES = ["asset_metric", "asset_state", "change"] as const;

/** Whether a trigger selects devices via `scope` (composite depends on kind). */
export function isAssetScopedTrigger(trigger: Trigger): boolean {
  if (trigger.type === "composite") return trigger.kind === "asset";
  return (ASSET_SCOPED_TRIGGER_TYPES as readonly string[]).includes(trigger.type);
}

// ─── Display metadata (builder UI only; engine validates via the Zod schemas) ──
// Human label + unit per metric, for both asset_metric and host_metric.
export const METRIC_META: Record<string, { label: string; unit: string }> = {
  // asset_metric
  cpuPct: { label: "CPU utilization", unit: "%" },
  memPct: { label: "Memory utilization", unit: "%" },
  memUsedBytes: { label: "Memory used", unit: "bytes" },
  sessionCount: { label: "Active sessions", unit: "" },
  responseTimeMs: { label: "Response time", unit: "ms" },
  uptimeSec: { label: "Uptime", unit: "sec" },
  // Probe-failure ratio over the trigger window (failed probes / total probes),
  // the same computation as the dashboard Packet Loss widget — works for ANY
  // monitored asset (switch/AP/server), not just SD-WAN. Windowed ratio: the
  // window is the measurement interval, so aggregation doesn't apply. Alert
  // with ">", e.g. > 25%. Fully-down assets (no successful probe) produce no
  // reading — they're the asset-down condition, not packet loss.
  probeLossPct: { label: "Packet loss (probe)", unit: "%" },
  hwSensorValue: { label: "Hardware sensor value", unit: "(sensor unit)" },
  storageUsedPct: { label: "Storage used", unit: "%" },
  storageUsedBytes: { label: "Storage used", unit: "bytes" },
  // Forecast metric: projected days until each growing filesystem fills
  // (30-day trend, ≥7 daily points; non-growing mounts produce no reading —
  // see storageForecastService). Alert with "<=", e.g. ≤ 14 days.
  storageDaysUntilFull: { label: "Days until storage full", unit: "days" },
  ifInErrorRate: { label: "Interface in-error rate", unit: "errors/s" },
  ifOutErrorRate: { label: "Interface out-error rate", unit: "errors/s" },
  ifInBps: { label: "Interface inbound", unit: "bps" },
  ifOutBps: { label: "Interface outbound", unit: "bps" },
  sdwanLatencyMs: { label: "SD-WAN latency", unit: "ms" },
  sdwanJitterMs: { label: "SD-WAN jitter", unit: "ms" },
  sdwanPacketLoss: { label: "SD-WAN packet loss", unit: "%" },
  ipsecThroughputBps: { label: "IPsec throughput", unit: "bps" },
  customWidgetValue: { label: "Custom widget value", unit: "" },
  // host_metric
  memUsedPct: { label: "Memory utilization", unit: "%" },
  loadAvg1: { label: "Load average (1m)", unit: "" },
  loadAvg5: { label: "Load average (5m)", unit: "" },
  loadAvg15: { label: "Load average (15m)", unit: "" },
  procRssBytes: { label: "Process RSS", unit: "bytes" },
};

// Asset-state field metadata: label + input kind + (for enum/bool) valid values.
export const FIELD_META: Record<string, { label: string; kind: "enum" | "bool" | "number" | "dynamic"; values?: string[] }> = {
  monitorStatus: { label: "Monitor status", kind: "enum", values: ["up", "warning", "recovering", "down", "unknown"] },
  status: { label: "Lifecycle status", kind: "enum", values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"] },
  consecutiveFailures: { label: "Consecutive probe failures", kind: "number" },
  dependencySuppressed: { label: "Dependency-suppressed", kind: "bool", values: ["true", "false"] },
  quarantined: { label: "Quarantined", kind: "bool", values: ["true", "false"] },
  ifOperStatus: { label: "Interface oper status", kind: "dynamic" },
  ifAdminStatus: { label: "Interface admin status", kind: "dynamic" },
  ipsecStatus: { label: "IPsec tunnel status", kind: "dynamic" },
  sdwanRuleStatus: { label: "SD-WAN rule status", kind: "dynamic" },
  sdwanSelectedMember: { label: "SD-WAN selected member", kind: "dynamic" },
};

export const CHANGE_TYPE_META: Record<string, string> = {
  lldp_neighbor_added: "LLDP neighbor appeared",
  lldp_neighbor_removed: "LLDP neighbor disappeared",
  process_started: "Process started",
  process_stopped: "Process stopped",
  sdwan_failover: "SD-WAN failover (member changed)",
  mclag_peer_lost: "MCLAG peer lost",
  wireless_station_connected: "Wireless station connected",
};

// Which dimensionFilter inputs are relevant per asset_metric metric, so the
// builder only shows the applicable ones.
/** Case-insensitive substring test used by every `*Pattern` dimension filter.
 *  An unset needle matches everything (the filter is optional). */
export function dimensionSubstringMatch(haystack: string | null | undefined, needle?: string | null): boolean {
  if (!needle) return true;
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

/**
 * Does a hwSensorValue dimension filter select this sensor? Shared by the
 * engine's reading resolver AND the asset chart's severity-tier lookup — the
 * chart colors a line by the thresholds that would actually fire on it, so a
 * second, subtly different copy of this predicate would paint a sensor with
 * bands belonging to some other sensor.
 */
export function hwSensorFilterMatches(
  df: { sensorClass?: string; sensorNamePattern?: string } | null | undefined,
  sensor: { sensorName?: string | null; sensorClass?: string | null },
): boolean {
  if (!df) return true;
  if (df.sensorClass && df.sensorClass !== (sensor.sensorClass ?? "")) return false;
  return dimensionSubstringMatch(sensor.sensorName, df.sensorNamePattern);
}

export const METRIC_DIMENSIONS: Record<string, string[]> = {
  hwSensorValue: ["sensorClass", "sensorNamePattern"],
  storageUsedPct: ["mountPathPattern"],
  storageUsedBytes: ["mountPathPattern"],
  storageDaysUntilFull: ["mountPathPattern"],
  ifInErrorRate: ["ifNamePattern"],
  ifOutErrorRate: ["ifNamePattern"],
  ifInBps: ["ifNamePattern"],
  ifOutBps: ["ifNamePattern"],
  sdwanLatencyMs: ["healthCheck", "link"],
  sdwanJitterMs: ["healthCheck", "link"],
  sdwanPacketLoss: ["healthCheck", "link"],
  ipsecThroughputBps: ["tunnelName"],
  customWidgetValue: ["widgetId"],
};

/**
 * The catalog the builder UI reads from GET /notification-rules/schema, so the
 * frontend renders the right inputs per trigger type without hardcoding. The
 * `*Meta` maps add display labels / units / valid values / applicable dimension
 * filters; the engine ignores them (it validates via the Zod schemas above).
 */
export function buildSchemaCatalog() {
  return {
    // v2 capability marker — the wizard gates its data-driven surfaces on it.
    schemaVersion: 2,
    severities: SEVERITIES,
    eventLevels: EVENT_LEVELS,
    clearBehaviors: CLEAR_BEHAVIORS,
    comparators: COMPARATORS,
    aggregations: AGGREGATIONS,
    metricMeta: METRIC_META,
    fieldMeta: FIELD_META,
    changeTypeMeta: CHANGE_TYPE_META,
    metricDimensions: METRIC_DIMENSIONS,
    // hwSensorValue's unit depends on the sensor class in the dimension filter
    // (metricMeta carries the "(sensor unit)" placeholder). Class → display
    // unit, sourced from the same map the sample classifier writes with.
    sensorClassUnits: SENSOR_CLASS_UNITS,
    channelTypes: CHANNEL_TYPE_META,
    recipientRoutedTypes: RECIPIENT_ROUTED_TYPES,
    templateVariables: TEMPLATE_VARIABLES,
    triggerTypes: [
      { type: "asset_metric", label: "Asset metric threshold", scoped: true, metrics: ASSET_METRICS },
      { type: "asset_state", label: "Asset state", scoped: true, fields: ASSET_STATE_FIELDS },
      { type: "host_metric", label: "Polaris host health", scoped: false, metrics: HOST_METRICS },
      { type: "event", label: "Audit event match", scoped: false },
      { type: "change", label: "Change detection", scoped: true, changeTypes: CHANGE_TYPES },
      { type: "composite", label: "Multiple conditions (AND/OR)", scoped: true },
    ],
    // Composite-trigger builder vocabulary (the wizard's trigger tree).
    compositeMeta: {
      kinds: ["asset", "host"],
      groupOps: TRIGGER_GROUP_OPS,
      groupOpLabels: {
        and: "All conditions must be met (AND)",
        or: "At least one condition must be met (OR)",
      },
      maxDepth: 3,
      maxLeaves: 10,
      // Multi-dimension leaves (sensors, mounts, interfaces …) count as met
      // when ANY dimension crosses; composite automations alert once per
      // device, not per dimension.
      anyDimensionNote:
        "With multiple conditions, an automation alerts once per device; a per-sensor/per-interface condition counts as met when any of them crosses.",
    },
    // ── Rule-shape v2 vocabulary (reset + actions), wizard-facing ──────────
    resetModes: RESET_MODES,
    resetModeMeta: {
      auto: { label: "Automatically", help: "Clears when the condition recovers — optionally with a separate clear threshold (hysteresis) and a recovered-for duration." },
      condition: { label: "When custom conditions are met", help: "Clears when a separate AND/OR condition tree becomes true (multi-condition triggers only). While the alert is active, the reset conditions are the only recovery authority — set a re-notify cooldown if the trigger and reset conditions can both be true at once." },
      timed: { label: "After a fixed time", help: "Clears after the configured duration, even without a recovery reading." },
      manual: { label: "Manually only", help: "Stays active until someone clears it." },
    },
    // Which reset modes make sense per trigger type (event/change have no
    // continuous condition to auto-clear) + the wizard's default per type.
    resetModesByTriggerType: {
      asset_metric: ["auto", "timed", "manual"],
      asset_state: ["auto", "timed", "manual"],
      host_metric: ["auto", "timed", "manual"],
      event: ["timed", "manual"],
      change: ["timed", "manual"],
      composite: ["auto", "condition", "timed", "manual"],
    },
    resetDefaults: {
      asset_metric: { mode: "auto", sustainSec: 0 },
      asset_state: { mode: "auto" },
      host_metric: { mode: "auto", sustainSec: 0 },
      event: { mode: "timed", afterSec: 3600 },
      change: { mode: "timed", afterSec: 3600 },
      composite: { mode: "auto", sustainSec: 0 },
    },
    actionTypes: [
      { type: "notify", label: "Send a notification", requires: "channels", permission: null },
      { type: "api_call", label: "Call an API (HTTP request)", requires: null, permission: null },
      { type: "script", label: "Run a script", requires: "scripts", permission: "automationScripts" },
      { type: "event", label: "Create an Event", requires: null, permission: null },
    ],
    apiCallMeta: {
      allowedMethods: API_CALL_METHODS,
      urlSchemes: ["https", "http"],
      maxBodyBytes: 10000,
      maxHeaders: 20,
      maxTimeoutSec: 60,
      help: "Headers are stored unmasked on the automation — never paste API keys, tokens, or other credentials into them.",
    },
    scriptMeta: {
      runOnOptions: SCRIPT_RUN_TARGETS,
      maxTimeoutSec: 600,
      languages: SCRIPT_INTERPRETERS,
      help: "Scripts execute as the Polaris service account on the server, or as root/LocalSystem on the triggering asset's agent. A human must review every script before enabling it in production.",
    },
    // perAction: escalation chains attach to individual actions (top-level +
    // per-band); tier actions themselves can't nest another chain.
    escalationMeta: { maxTiers: 5, minRepeatEveryMin: 5, maxActionsPerTier: 10, perAction: true },
    // Severity-band vocabulary for the wizard's per-severity action sections.
    bandMeta: {
      maxBands: 4,
      maxActionsPerBand: 20,
      emptyBandNote: "A severity tier with no actions of its own runs the base actions when entered.",
      sustainNote: "Each severity level has its own “sustained for”: the value must hold in that band for that long before the alert takes the severity.",
    },
    // Sentence-builder vocabulary (server-owned wording; the wizard renders
    // the live plain-English trigger/reset summary from these).
    comparatorPhrases: {
      ">": "is above", ">=": "is at or above",
      "<": "is below", "<=": "is at or below",
      "==": "equals", "!=": "is not",
    },
    inverseComparators: { ">": "<=", ">=": "<", "<": ">=", "<=": ">", "==": "!=", "!=": "==" },
    aggregationPhrases: { latest: "", avg: "avg over", min: "min over", max: "max over" },
    dimensionPhrases: {
      sensorClass: "for sensors of class {value}",
      sensorNamePattern: "on sensors matching {value}",
      ifNamePattern: "on interfaces matching {value}",
      mountPathPattern: "on mounts matching {value}",
      healthCheck: "for health check {value}",
      link: "on member {value}",
      tunnelName: "on tunnel {value}",
      widgetId: "for widget {value}",
      processNamePattern: "for processes matching {value}",
    },
    // ── Scope condition-tree vocabulary (the device-filter builder) ────────
    scopeCondition: {
      groupOps: SCOPE_GROUP_OPS,
      groupOpLabels: {
        and: "All child conditions must be satisfied (AND)",
        or: "At least one child condition must be satisfied (OR)",
        none: "All child conditions must NOT be satisfied",
        notAll: "At least one child condition must NOT be satisfied",
      },
      operatorLabels: {
        equals: "is equal to",
        notEquals: "is not equal to",
        contains: "contains",
        notContains: "does not contain",
        startsWith: "starts with",
        endsWith: "ends with",
        has: "is applied",
        notHas: "is not applied",
        inCidr: "is in subnet",
        notInCidr: "is not in subnet",
      },
      // Per-field: label, valid operators, and which option list feeds the
      // value suggestions ("assetTypes" | "manufacturers" | "models" | "tags"
      // | "subnets" from /scope-options + the registry; null = free text).
      fields: [
        { field: "assetType", label: "Device type", ops: SCOPE_FIELD_OPS.assetType, optionsFrom: "assetTypes" },
        { field: "manufacturer", label: "Manufacturer", ops: SCOPE_FIELD_OPS.manufacturer, optionsFrom: "manufacturers" },
        { field: "model", label: "Model", ops: SCOPE_FIELD_OPS.model, optionsFrom: "models" },
        { field: "hostname", label: "Hostname", ops: SCOPE_FIELD_OPS.hostname, optionsFrom: null },
        { field: "os", label: "Operating system", ops: SCOPE_FIELD_OPS.os, optionsFrom: null },
        { field: "tag", label: "Tag", ops: SCOPE_FIELD_OPS.tag, optionsFrom: "tags" },
        { field: "subnet", label: "Subnet / IP", ops: SCOPE_FIELD_OPS.subnet, optionsFrom: "subnets" },
        { field: "status", label: "Lifecycle status", ops: SCOPE_FIELD_OPS.status, optionsFrom: null, values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"] },
        // NOTE: `assetId` remains a valid field for saved rules (SCOPE_FIELD_OPS
        // + matchScopeRule still handle it) but is intentionally not offered as
        // a new builder choice — a raw id targets one device with no precedence
        // meaning; use hostname instead.
      ],
      maxDepth: 5,
      maxRules: 100,
      // Precedence ladder (least → most specific). Drives the wizard's
      // "Specificity" indicator; the carve-out engine ranks scopes by it.
      specificity: SCOPE_RANK_LADDER,
    },
  };
}
