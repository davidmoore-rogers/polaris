/**
 * src/services/notificationRuleService.ts
 *
 * Notification RULE business logic: scope matching (which assets a rule
 * applies to), the "rules matching this asset" lookup behind the asset-details
 * Notifications tab, and (Stage 4) rule CRUD + the change-type subscription
 * cache. Scope matching is shared by the asset tab and the builder's preview
 * so they can't drift.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { createTtlCache } from "../utils/ttlCache.js";
import type { RuleScope, Trigger, RuleInput, Severity, CompositeLeaf, TriggerConditionGroup } from "./notificationTypes.js";
import {
  isAssetScopedTrigger,
  isTriggerLeaf,
  resolveTierLadder,
  severityRank,
  hwSensorFilterMatches,
  dimensionSubstringMatch,
  CHANGE_TYPE_ACTIONS,
  legacyMirrorOfV2,
  normalizeRuleToV2,
  normalizeEscalationToV2,
  allRuleActionRefs,
  evaluateScopeCondition,
} from "./notificationTypes.js";
import { isBlockedOutboundHost } from "../utils/netGuard.js";
import { listRegions } from "./mapRegionService.js";
import { ipInCidr } from "../utils/cidr.js";
import { scopeCidrOf, type ScopeConditionAsset } from "./notificationTypes.js";

/**
 * Minimal asset shape needed to evaluate scope membership. Extends the
 * condition-evaluator's field vocabulary (notificationTypes.ScopeConditionAsset)
 * so the flat-scope matcher and the condition tree can never drift apart —
 * this layer just requires the dimensions the flat matcher always reads.
 */
export interface ScopeAsset extends ScopeConditionAsset {
  assetType: string | null;
  tags: string[];
  discoveredByIntegrationId: string | null;
}

/**
 * Does `scope` select `asset`? AND across the provided dimensions, OR within
 * each list. `allAssets` short-circuits true. A scope with no dimensions and
 * allAssets unset matches NOTHING (the builder requires an explicit selection).
 * KEEP IN LOCKSTEP with the engine's SQL `scopeWhere` + loadScopeAssets
 * subnet post-filter (notificationEngine.ts) — this is the in-memory twin.
 */
export function scopeMatchesAsset(scope: RuleScope, asset: ScopeAsset): boolean {
  if (scope.allAssets) return true;
  let anyDimension = false;

  if (scope.assetTypes && scope.assetTypes.length > 0) {
    anyDimension = true;
    if (!scope.assetTypes.includes(asset.assetType ?? "")) return false;
  }
  if (scope.tags && scope.tags.length > 0) {
    anyDimension = true;
    const set = new Set(asset.tags.map((t) => t.toLowerCase()));
    if (!scope.tags.some((t) => set.has(t.toLowerCase()))) return false;
  }
  if (scope.assetIds && scope.assetIds.length > 0) {
    anyDimension = true;
    if (!scope.assetIds.includes(asset.id)) return false;
  }
  if (scope.integrationIds && scope.integrationIds.length > 0) {
    anyDimension = true;
    if (!scope.integrationIds.includes(asset.discoveredByIntegrationId ?? "")) return false;
  }
  if (scope.manufacturers && scope.manufacturers.length > 0) {
    anyDimension = true;
    const mfr = (asset.manufacturer ?? "").toLowerCase();
    if (!mfr || !scope.manufacturers.some((m) => mfr.includes(m.toLowerCase()))) return false;
  }
  if (scope.models && scope.models.length > 0) {
    anyDimension = true;
    const model = (asset.model ?? "").toLowerCase();
    if (!model || !scope.models.some((m) => model.includes(m.toLowerCase()))) return false;
  }
  if (scope.subnetCidrs && scope.subnetCidrs.length > 0) {
    anyDimension = true;
    const ip = asset.ipAddress ?? "";
    if (!ip) return false;
    const inAny = scope.subnetCidrs.some((c) => {
      try { return ipInCidr(ip, scopeCidrOf(c)); } catch { return false; }
    });
    if (!inAny) return false;
  }
  // Nested condition tree (the wizard's builder). ANDs with any flat
  // dimensions above when both are present.
  if (scope.condition) {
    anyDimension = true;
    if (!evaluateScopeCondition(scope.condition, asset)) return false;
  }
  return anyDimension;
}

/**
 * Enabled, asset-scoped rules whose scope matches the given asset. Backs the
 * asset-details Alerts tab's "automations that can trigger for this asset"
 * table. One findMany + in-memory filter (rule counts are small).
 *
 * Rows go out through `withV2` like every other read path: clicking a name in
 * that table opens the SAME edit wizard the Automations page uses, and a
 * pre-v2 row handed over with NULL reset/actions would open with its actions
 * missing and save them away.
 */
export async function findRulesMatchingAsset(assetId: string) {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, assetType: true, tags: true, discoveredByIntegrationId: true, manufacturer: true, model: true, ipAddress: true, hostname: true, os: true, status: true },
  });
  if (!asset) return [];

  const rules = await prisma.notificationRule.findMany({
    where: { enabled: true },
    orderBy: { name: "asc" },
  });

  return rules
    .filter((r) => {
      const trigger = r.trigger as unknown as Trigger;
      if (!isAssetScopedTrigger(trigger)) return false;
      return scopeMatchesAsset((r.scope ?? {}) as RuleScope, asset);
    })
    .map(withV2);
}

/** One severity threshold that applies to a charted metric on one asset. */
export interface MetricSeverityTier {
  severity: Severity;
  /** Ordered comparator — ">"/">=" color ABOVE the threshold, "<"/"<=" BELOW. */
  operator: ">" | ">=" | "<" | "<=";
  threshold: number;
  ruleId: string;
  ruleName: string;
}

/** Ordered comparators only: an `==`/`!=` trigger has no "worse in this
 *  direction" reading, so there is nothing to shade on a chart. */
function orderedOperator(op: string): MetricSeverityTier["operator"] | null {
  return op === ">" || op === ">=" || op === "<" || op === "<=" ? op : null;
}

/**
 * The severity thresholds that would fire on ONE asset's charted metric, so the
 * asset-detail chart can shade its line with the same numbers the engine
 * evaluates instead of a second copy of them.
 *
 * Sources, per enabled scope-matching automation (`findRulesMatchingAsset`):
 *  - a numeric single trigger on `metric` → its `resolveTierLadder` (tier 0 =
 *    the rule's own severity/threshold, plus every severity band on top);
 *  - a COMPOSITE trigger → each leaf on `metric` at the rule's severity (bands
 *    aren't valid on composites, so there's no ladder to resolve).
 *
 * `dimension` is the concrete thing being charted (a sensor's name + class);
 * a rule whose dimensionFilter doesn't select it is skipped — shading a fan's
 * chart with a temperature automation's 35 °C would be a lie. When two
 * automations set the same severity at different thresholds the MORE SENSITIVE
 * one wins (lowest for `>=`, highest for `<=`) — that's where that severity
 * first appears, which is what the shading is showing.
 *
 * Deliberately does NOT apply the rule-18 carve-out: precedence decides which
 * automation NOTIFIES, and a carved-out asset still crosses the same value. The
 * chart answers "what does this reading mean", not "which rule pages someone".
 */
export async function getMetricSeverityTiers(
  assetId: string,
  metric: string,
  dimension?: { sensorName?: string; sensorClass?: string },
): Promise<MetricSeverityTier[]> {
  const rules = await findRulesMatchingAsset(assetId);
  const collected: MetricSeverityTier[] = [];
  // A trigger carrying hostnamePattern only evaluates devices it matches —
  // shading this asset's chart with a rule that filters it out would paint
  // thresholds that can never fire here. Fetched once; rules is often empty
  // but the extra findUnique is one indexed row.
  const asset = rules.length
    ? await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } })
    : null;
  const hostnameSelects = (df: { hostnamePattern?: string } | null | undefined): boolean =>
    dimensionSubstringMatch(asset?.hostname, df?.hostnamePattern);

  for (const row of rules) {
    const v2 = normalizeRuleToV2(row as Parameters<typeof normalizeRuleToV2>[0]);
    const trigger = row.trigger as unknown as Trigger;
    const ruleSeverity = String(row.severity) as Severity;
    const push = (op: string, threshold: unknown, severity: Severity) => {
      const operator = orderedOperator(op);
      if (!operator || typeof threshold !== "number" || !Number.isFinite(threshold)) return;
      collected.push({ severity, operator, threshold, ruleId: row.id, ruleName: row.name });
    };

    if (trigger.type === "asset_metric" && trigger.metric === metric) {
      if (!hostnameSelects(trigger.dimensionFilter)) continue;
      if (metric === "hwSensorValue" && dimension && !hwSensorFilterMatches(trigger.dimensionFilter, dimension)) continue;
      for (const tier of resolveTierLadder(trigger.operator, trigger.threshold, ruleSeverity, trigger.forDurationSec ?? 0, v2.severityBands)) {
        push(tier.operator, tier.threshold, tier.severity as Severity);
      }
      continue;
    }

    if (trigger.type === "composite") {
      for (const leaf of collectCompositeMetricLeaves(trigger)) {
        if (leaf.type !== "asset_metric" || leaf.metric !== metric) continue;
        if (!hostnameSelects(leaf.dimensionFilter)) continue;
        if (metric === "hwSensorValue" && dimension && !hwSensorFilterMatches(leaf.dimensionFilter, dimension)) continue;
        push(leaf.operator, leaf.threshold, ruleSeverity);
      }
    }
  }

  // One tier per severity: keep the most sensitive threshold in its direction.
  const bySeverity = new Map<string, MetricSeverityTier>();
  for (const t of collected) {
    const key = `${t.severity}|${t.operator === ">" || t.operator === ">=" ? "up" : "down"}`;
    const prev = bySeverity.get(key);
    if (!prev) { bySeverity.set(key, t); continue; }
    const moreSensitive = key.endsWith("up") ? t.threshold < prev.threshold : t.threshold > prev.threshold;
    if (moreSensitive) bySeverity.set(key, t);
  }
  return Array.from(bySeverity.values()).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

/** Flatten a composite trigger's tree to its leaves (groups nest ≤3 deep).
 *  Starts from `children`, NOT the trigger itself: `isTriggerLeaf` is a
 *  `"type" in node` test and the composite root carries `type: "composite"`, so
 *  walking from the root would classify the whole tree as one leaf. */
function collectCompositeMetricLeaves(trigger: Extract<Trigger, { type: "composite" }>): CompositeLeaf[] {
  const out: CompositeLeaf[] = [];
  const walk = (node: TriggerConditionGroup | CompositeLeaf): void => {
    if (isTriggerLeaf(node)) { out.push(node); return; }
    for (const child of node.children ?? []) walk(child);
  };
  for (const child of trigger.children ?? []) walk(child);
  return out;
}

/**
 * Option lists for the wizard's device-filtering pickers: distinct
 * manufacturers/models present in the inventory + the defined (non-deprecated)
 * IPAM subnets. Distinct queries only — cheap at 2000 assets.
 */
export async function listScopeOptions(): Promise<{
  manufacturers: string[];
  models: string[];
  subnets: { id: string; name: string; cidr: string }[];
  regions: string[];
  roles: { id: string; name: string }[];
}> {
  // MONITORED devices only. These lists exist to be picked from, and a
  // manufacturer or model that only unmonitored inventory reports is a choice
  // that can't produce a metric alert — offering it is how an operator builds a
  // filter, sees it match nothing, and distrusts the picker. Deliberately NOT
  // applied to matching: `scopeWhere` still selects unmonitored devices, because
  // event and change triggers fire on them. The subnet list is IPAM, not
  // inventory, so it is unfiltered by the same reasoning.
  const monitoredOnly = { monitored: true } as const;
  const [mfrRows, modelRows, subnets, regions, roles] = await Promise.all([
    prisma.asset.findMany({
      select: { manufacturer: true },
      distinct: ["manufacturer"],
      where: { ...monitoredOnly, manufacturer: { not: null } },
      orderBy: { manufacturer: "asc" },
    }),
    prisma.asset.findMany({
      select: { model: true },
      distinct: ["model"],
      where: { ...monitoredOnly, model: { not: null } },
      orderBy: { model: "asc" },
    }),
    prisma.subnet.findMany({
      select: { id: true, name: true, cidr: true },
      where: { status: { not: "deprecated" } },
      orderBy: { cidr: "asc" },
    }),
    // The map-region catalogue rides THIS payload rather than being fetched
    // from GET /map/regions, which is gated `mapRegions:read` — an operator who
    // can build an automation may not hold that key, and the region picker
    // would silently degrade to free text. This endpoint is already behind
    // automationManagement:read, which the wizard has by definition.
    listRegions().catch(() => []),
    // Roles for the recipient picker's role tokens. Ids, not names: a rename
    // must never silently reroute an automation. Rides this payload for the
    // same reason regions do — GET /roles is gated `roles:read`, which an
    // automation editor may not hold.
    prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }).catch(() => []),
  ]);
  return {
    manufacturers: mfrRows.map((r) => r.manufacturer).filter((m): m is string => !!m && m.trim() !== ""),
    models: modelRows.map((r) => r.model).filter((m): m is string => !!m && m.trim() !== ""),
    subnets,
    // Bare names — how User/Role/GroupMapping.regionTags store them. The
    // `region:` prefix exists only on ASSET tags.
    regions: regions.map((r) => r.name).filter((n) => !!n && n.trim() !== "").sort(),
    roles,
  };
}

// ─── Change-type subscription cache ─────────────────────────────────────────
// The persist* functions only diff + emit change-Events when at least one
// enabled `change` rule subscribes to that change type — zero overhead
// otherwise. Refreshed lazily (TTL) and on every rule write via
// bumpChangeSubscriptions().

// createTtlCache (2026-08 audit) replaces the hand-rolled value+timestamp
// pair — same TTL/invalidation semantics plus in-flight coalescing.
const SUBSCRIPTION_TTL_MS = 60_000;
const _subscriptionCache = createTtlCache<Set<string>>({ ttlMs: SUBSCRIPTION_TTL_MS, maxEntries: 1 });

export function bumpChangeSubscriptions(): void {
  _subscriptionCache.invalidate();
}

export function getSubscribedChangeActions(): Promise<Set<string>> {
  return _subscriptionCache.getOrCompute("", async () => {
    const rules = await prisma.notificationRule.findMany({
      where: { enabled: true },
      select: { trigger: true },
    });
    const actions = new Set<string>();
    for (const r of rules) {
      const t = r.trigger as unknown as Trigger;
      if (t.type === "change") {
        const action = CHANGE_TYPE_ACTIONS[t.changeType];
        if (action) actions.add(action);
      }
    }
    return actions;
  });
}

/** Is any enabled change-rule subscribed to this change action? */
export async function isChangeActionSubscribed(action: string): Promise<boolean> {
  const actions = await getSubscribedChangeActions();
  return actions.has(action);
}

// ─── Rule CRUD ──────────────────────────────────────────────────────────────

/**
 * Validate every reference a v2 rule's actions carry — TOP-LEVEL actions and
 * escalation-tier actions alike (tiers normalize through
 * normalizeEscalationToV2, so legacy email tiers validate as their converted
 * notify actions; the email-only tier restriction is gone — escalation v2
 * tiers take any action type):
 *   - notify.channelId must exist (any channel type),
 *   - api_call.url host must pass the outbound SSRF guard (friendly 400 at
 *     save beats a silent fire-time failure),
 *   - script.scriptId must resolve to an ENABLED registry script whose
 *     runTarget is compatible with the action's runOn.
 * (The automationScripts=fullwrite gate on rules carrying script actions is
 * enforced at the route layer — permissions are not a service concern.)
 */
async function assertActionRefs(input: RuleInput): Promise<void> {
  // Canonical walk over EVERY place actions live — top-level (+ their
  // per-action escalation tiers), rule-level escalation tiers, severity-band
  // actions (+ their per-action tiers), band-level tiers, and the dedicated
  // resolved actions — so a new action location can't escape these checks.
  const all = allRuleActionRefs(input);

  const notifyRefs: { label: string; channelId: string; broadcast: boolean }[] = [];
  const scriptRefs: { label: string; scriptId: string; runOn: string }[] = [];
  for (const { action, label } of all) {
    if (action.type === "notify") {
      notifyRefs.push({
        label,
        channelId: action.channelId,
        // The two BROADCAST modes are Web-Push-only; flagged here so the
        // channel-type check below can reject them without a second walk.
        // `recipientRegions` is deliberately NOT in this set any more: naming
        // specific regions is now a recipient TOKEN the address-book picker
        // offers on every routed channel, so an email rule holding one is a
        // state the builder renders and can edit back out — which was the whole
        // reason for the restriction.
        broadcast: !!(action.recipientAllUsers || action.recipientAllRegions),
      });
    } else if (action.type === "api_call") {
      let host = "";
      try {
        host = new URL(action.url).hostname;
      } catch {
        throw new AppError(400, `${label}: api_call URL is not a valid URL`);
      }
      if (isBlockedOutboundHost(host)) {
        throw new AppError(400, `${label}: api_call host "${host}" is blocked (loopback/link-local/metadata addresses are not allowed)`);
      }
    } else if (action.type === "script") {
      scriptRefs.push({ label, scriptId: action.scriptId, runOn: action.runOn });
    }
    // `event` references nothing — no channel, script or URL to validate.
  }

  if (scriptRefs.length > 0) {
    const scripts = await prisma.automationScript.findMany({
      where: { id: { in: Array.from(new Set(scriptRefs.map((s) => s.scriptId))) } },
      select: { id: true, name: true, enabled: true, runTarget: true },
    });
    const scriptById = new Map(scripts.map((s) => [s.id, s]));
    for (const ref of scriptRefs) {
      const script = scriptById.get(ref.scriptId);
      if (!script) throw new AppError(400, `${ref.label}: references a script that no longer exists in the registry`);
      if (!script.enabled) throw new AppError(400, `${ref.label}: script "${script.name}" is disabled`);
      if (script.runTarget !== "either" && script.runTarget !== ref.runOn) {
        throw new AppError(400, `${ref.label}: script "${script.name}" only runs on ${script.runTarget}, but the action requests ${ref.runOn}`);
      }
    }
  }

  const channelIds = Array.from(new Set(notifyRefs.map((r) => r.channelId)));
  if (channelIds.length === 0) return;
  const channels = await prisma.notificationChannel.findMany({
    where: { id: { in: channelIds } },
    select: { id: true, type: true },
  });
  const known = new Map(channels.map((c) => [c.id, c.type]));
  for (const ref of notifyRefs) {
    if (!known.has(ref.channelId)) {
      throw new AppError(400, `${ref.label}: references a delivery channel that no longer exists`);
    }
    // Keep the stored shape renderable: the builder only offers the broadcast
    // modes on Web Push, so a rule holding them on an email/chat channel would
    // be a state no UI can show or edit back out.
    if (ref.broadcast && known.get(ref.channelId) !== "web_push") {
      throw new AppError(
        400,
        `${ref.label}: "all users" / "all regions" broadcast is only available on a Web Push channel — pick recipients (people, roles or named regions) explicitly for email and chat channels`,
      );
    }
  }
}

/** Attach the v2 view to a stored row: rows written before the v2 cutover
 *  (or restored from pre-upgrade backups) carry NULL reset/actions — fill
 *  them from the normalizer so API consumers always see the v2 shape. */
function withV2<T extends { reset: unknown; actions: unknown }>(row: T): T {
  if (row.reset && Array.isArray(row.actions)) return row;
  const v2 = normalizeRuleToV2(row as Parameters<typeof normalizeRuleToV2>[0]);
  return { ...row, reset: v2.reset, actions: v2.actions };
}

export async function listRules() {
  const rows = await prisma.notificationRule.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(withV2);
}

export async function getRule(id: string) {
  const rule = await prisma.notificationRule.findUnique({ where: { id } });
  if (!rule) throw new AppError(404, "Notification rule not found");
  return withV2(rule);
}

export async function createRule(input: RuleInput, actor?: string) {
  await assertActionRefs(input);
  const mirror = legacyMirrorOfV2(input.reset, input.actions);
  const rule = await prisma.notificationRule.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled,
      severity: input.severity,
      trigger: input.trigger as any,
      scope: input.scope as any,
      reset: input.reset as any,
      actions: input.actions as any,
      // Lossless legacy mirror — keeps the pre-wizard UI + pre-upgrade
      // backups coherent. Derived, never authoritative (readers prefer v2).
      clearBehavior: mirror.clearBehavior,
      clearAfterSec: mirror.clearAfterSec,
      targets: mirror.targets as any,
      cooldownSec: input.cooldownSec ?? null,
      messageTemplate: input.messageTemplate ?? null,
      channels: input.channels,
      emailComposition: (input.emailComposition ?? undefined) as any,
      escalation: (input.escalation ?? undefined) as any,
      severityBands: (input.severityBands ?? undefined) as any,
      bandNotify: (input.bandNotify ?? undefined) as any,
      resetActions: (input.resetActions ?? undefined) as any,
      createdBy: actor ?? null,
    },
  });
  bumpChangeSubscriptions();
  await logEvent({
    action: "notification_rule.created",
    resourceType: "notification-rule",
    resourceId: rule.id,
    resourceName: rule.name,
    actor,
    message: `Notification rule "${rule.name}" created (${input.trigger.type})`,
    details: { triggerType: input.trigger.type, severity: input.severity },
  });
  return rule;
}

/** What makes two triggers "the same condition" for state-row continuity.
 *  A changed identity (type/kind/metric/field/changeType) means the stored
 *  NotificationRuleState rows describe a DIFFERENT condition — left in place
 *  they linger firing forever (per-dimension rows under a now-composite rule,
 *  a cpu row under a now-temperature rule). Threshold/operator/tree edits keep
 *  the identity: the state keys stay meaningful and re-evaluate next tick. */
function triggerIdentityOf(trigger: Trigger): string {
  switch (trigger.type) {
    case "asset_metric": case "host_metric": return `${trigger.type}:${trigger.metric}`;
    case "asset_state": return `asset_state:${trigger.field}`;
    case "composite": return `composite:${trigger.kind}`;
    case "change": return `change:${trigger.changeType}`;
    default: return trigger.type;
  }
}

export async function updateRule(id: string, input: RuleInput, actor?: string) {
  const existing = await getRule(id); // 404 if missing
  await assertActionRefs(input);
  const identityChanged =
    triggerIdentityOf(existing.trigger as unknown as Trigger) !== triggerIdentityOf(input.trigger);
  const mirror = legacyMirrorOfV2(input.reset, input.actions);
  // Nullable-Json semantics: undefined (field absent) leaves the stored value
  // unchanged; explicit null clears it (Prisma.DbNull).
  const jsonOrClear = (v: unknown) => (v === undefined ? undefined : v === null ? Prisma.DbNull : (v as any));
  const rule = await prisma.notificationRule.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled,
      severity: input.severity,
      trigger: input.trigger as any,
      scope: input.scope as any,
      reset: input.reset as any,
      actions: input.actions as any,
      clearBehavior: mirror.clearBehavior,
      clearAfterSec: mirror.clearAfterSec,
      targets: mirror.targets as any,
      cooldownSec: input.cooldownSec ?? null,
      messageTemplate: input.messageTemplate ?? null,
      channels: input.channels,
      emailComposition: jsonOrClear(input.emailComposition),
      escalation: jsonOrClear(input.escalation),
      severityBands: jsonOrClear(input.severityBands),
      bandNotify: jsonOrClear(input.bandNotify),
      resetActions: jsonOrClear(input.resetActions),
    },
  });
  // The trigger now describes a different condition — the old state rows (and
  // their active alerts) are about something that no longer exists. Clear the
  // alerts + drop the rows so nothing lingers firing under a stale key; the
  // next tick re-evaluates from scratch (cooldown restarts — an edited
  // trigger is a new condition). DISABLING gets the same cleanup: the engine
  // only evaluates enabled rules, so a disabled rule's active alerts would
  // otherwise sit uncleared forever (still counted by every widget). Clearing
  // by ruleId (not via state-row notificationIds) also catches stragglers.
  const disabling = existing.enabled && input.enabled === false;
  if (identityChanged || disabling) {
    await prisma.notification.updateMany({
      where: { ruleId: id, cleared: false },
      data: { cleared: true, clearedBy: identityChanged ? "system:rule-edited" : "system:rule-disabled", clearedAt: new Date() },
    });
    await prisma.notificationRuleState.deleteMany({ where: { ruleId: id } });
  }
  bumpChangeSubscriptions();
  await logEvent({
    action: "notification_rule.updated",
    resourceType: "notification-rule",
    resourceId: rule.id,
    resourceName: rule.name,
    actor,
    message: `Notification rule "${rule.name}" updated`,
    details: { triggerType: input.trigger.type, enabled: input.enabled, ...(identityChanged ? { triggerIdentityChanged: true } : {}) },
  });
  return rule;
}

export async function deleteRule(id: string, actor?: string) {
  const rule = await getRule(id);
  // Clear the rule's ACTIVE alerts first: the cascade drops the state rows,
  // so nothing could ever auto-clear them after the delete — they'd sit in
  // every active-alert feed forever. Soft-clear keeps them as history.
  await prisma.notification.updateMany({
    where: { ruleId: id, cleared: false },
    data: { cleared: true, clearedBy: "system:rule-deleted", clearedAt: new Date() },
  });
  // Cascade drops NotificationRuleState; existing notifications keep ruleId
  // set to null (onDelete: SetNull) so history survives.
  await prisma.notificationRule.delete({ where: { id } });
  bumpChangeSubscriptions();
  await logEvent({
    action: "notification_rule.deleted",
    resourceType: "notification-rule",
    resourceId: id,
    resourceName: rule.name,
    actor,
    message: `Notification rule "${rule.name}" deleted`,
  });
}
