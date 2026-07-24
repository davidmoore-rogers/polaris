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
import type { RuleScope, Trigger, RuleInput } from "./notificationTypes.js";
import {
  isAssetScopedTrigger,
  CHANGE_TYPE_ACTIONS,
  legacyMirrorOfV2,
  normalizeRuleToV2,
  normalizeEscalationToV2,
  evaluateScopeCondition,
} from "./notificationTypes.js";
import { isBlockedOutboundHost } from "../utils/netGuard.js";
import { ipInCidr } from "../utils/cidr.js";
import { scopeCidrOf } from "./notificationTypes.js";

/** Minimal asset shape needed to evaluate scope membership. */
export interface ScopeAsset {
  id: string;
  assetType: string | null;
  tags: string[];
  discoveredByIntegrationId: string | null;
  manufacturer?: string | null;
  model?: string | null;
  ipAddress?: string | null;
  hostname?: string | null;
  os?: string | null;
  status?: string | null;
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
 * asset-details Notifications tab's "rules that could trigger for this asset"
 * table. One findMany + in-memory filter (rule counts are small).
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

  return rules.filter((r) => {
    const trigger = r.trigger as unknown as Trigger;
    if (!isAssetScopedTrigger(trigger)) return false;
    return scopeMatchesAsset((r.scope ?? {}) as RuleScope, asset);
  });
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
}> {
  const [mfrRows, modelRows, subnets] = await Promise.all([
    prisma.asset.findMany({
      select: { manufacturer: true },
      distinct: ["manufacturer"],
      where: { manufacturer: { not: null } },
      orderBy: { manufacturer: "asc" },
    }),
    prisma.asset.findMany({
      select: { model: true },
      distinct: ["model"],
      where: { model: { not: null } },
      orderBy: { model: "asc" },
    }),
    prisma.subnet.findMany({
      select: { id: true, name: true, cidr: true },
      where: { status: { not: "deprecated" } },
      orderBy: { cidr: "asc" },
    }),
  ]);
  return {
    manufacturers: mfrRows.map((r) => r.manufacturer).filter((m): m is string => !!m && m.trim() !== ""),
    models: modelRows.map((r) => r.model).filter((m): m is string => !!m && m.trim() !== ""),
    subnets,
  };
}

// ─── Change-type subscription cache ─────────────────────────────────────────
// The persist* functions only diff + emit change-Events when at least one
// enabled `change` rule subscribes to that change type — zero overhead
// otherwise. Refreshed lazily (TTL) and on every rule write via
// bumpChangeSubscriptions().

let _subscribedChangeActions: Set<string> | null = null;
let _subscribedLoadedAt = 0;
const SUBSCRIPTION_TTL_MS = 60_000;

export function bumpChangeSubscriptions(): void {
  _subscribedChangeActions = null;
}

export async function getSubscribedChangeActions(): Promise<Set<string>> {
  const now = Date.now();
  if (_subscribedChangeActions && now - _subscribedLoadedAt < SUBSCRIPTION_TTL_MS) {
    return _subscribedChangeActions;
  }
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
  _subscribedChangeActions = actions;
  _subscribedLoadedAt = now;
  return actions;
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
  const tierActions = (normalizeEscalationToV2(input.escalation)?.tiers ?? []).flatMap((t, ti) =>
    t.actions.map((a) => ({ action: a, label: `Escalation tier ${ti + 1}` })),
  );
  // Severity-band actions + each band's own time-escalation tiers, plus the
  // dedicated resolved actions — all subject to the same channel/script ref +
  // SSRF checks as the base actions.
  const bandActions = (input.severityBands ?? []).flatMap((b) => [
    ...b.actions.map((a, i) => ({ action: a, label: `${b.severity} band action ${i + 1}` })),
    ...(normalizeEscalationToV2(b.escalation)?.tiers ?? []).flatMap((t, ti) =>
      t.actions.map((a) => ({ action: a, label: `${b.severity} band escalation tier ${ti + 1}` })),
    ),
  ]);
  const resolvedActions = (input.bandNotify?.resolvedActions ?? []).map((a, i) => ({ action: a, label: `Resolved action ${i + 1}` }));
  const all = [
    ...input.actions.map((a, i) => ({ action: a, label: `Action ${i + 1}` })),
    ...tierActions,
    ...bandActions,
    ...resolvedActions,
  ];

  const notifyRefs: { label: string; channelId: string }[] = [];
  const scriptRefs: { label: string; scriptId: string; runOn: string }[] = [];
  for (const { action, label } of all) {
    if (action.type === "notify") {
      notifyRefs.push({ label, channelId: action.channelId });
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
    } else {
      scriptRefs.push({ label, scriptId: action.scriptId, runOn: action.runOn });
    }
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
    select: { id: true },
  });
  const known = new Set(channels.map((c) => c.id));
  for (const ref of notifyRefs) {
    if (!known.has(ref.channelId)) {
      throw new AppError(400, `${ref.label}: references a delivery channel that no longer exists`);
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
    },
  });
  // The trigger now describes a different condition — the old state rows (and
  // their active alerts) are about something that no longer exists. Clear the
  // alerts + drop the rows so nothing lingers firing under a stale key; the
  // next tick re-evaluates from scratch (cooldown restarts — an edited
  // trigger is a new condition).
  if (identityChanged) {
    const states = await prisma.notificationRuleState.findMany({
      where: { ruleId: id },
      select: { notificationId: true },
    });
    const notifIds = states.map((s) => s.notificationId).filter((n): n is string => !!n);
    if (notifIds.length > 0) {
      await prisma.notification.updateMany({
        where: { id: { in: notifIds }, cleared: false },
        data: { cleared: true, clearedBy: "system:rule-edited", clearedAt: new Date() },
      });
    }
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
