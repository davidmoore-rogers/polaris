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
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import type { RuleScope, Trigger, RuleInput } from "./notificationTypes.js";
import { ASSET_SCOPED_TRIGGER_TYPES, CHANGE_TYPE_ACTIONS } from "./notificationTypes.js";

/** Minimal asset shape needed to evaluate scope membership. */
export interface ScopeAsset {
  id: string;
  assetType: string | null;
  tags: string[];
  discoveredByIntegrationId: string | null;
}

/**
 * Does `scope` select `asset`? AND across the provided dimensions, OR within
 * each list. `allAssets` short-circuits true. A scope with no dimensions and
 * allAssets unset matches NOTHING (the builder requires an explicit selection).
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
    select: { id: true, assetType: true, tags: true, discoveredByIntegrationId: true },
  });
  if (!asset) return [];

  const rules = await prisma.notificationRule.findMany({
    where: { enabled: true },
    orderBy: { name: "asc" },
  });

  return rules.filter((r) => {
    const trigger = r.trigger as unknown as Trigger;
    if (!ASSET_SCOPED_TRIGGER_TYPES.includes(trigger.type as any)) return false;
    return scopeMatchesAsset((r.scope ?? {}) as RuleScope, asset);
  });
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

export async function listRules() {
  return prisma.notificationRule.findMany({ orderBy: { createdAt: "desc" } });
}

export async function getRule(id: string) {
  const rule = await prisma.notificationRule.findUnique({ where: { id } });
  if (!rule) throw new AppError(404, "Notification rule not found");
  return rule;
}

export async function createRule(input: RuleInput, actor?: string) {
  const rule = await prisma.notificationRule.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled,
      severity: input.severity,
      trigger: input.trigger as any,
      scope: input.scope as any,
      clearBehavior: input.clearBehavior,
      clearAfterSec: input.clearAfterSec ?? null,
      cooldownSec: input.cooldownSec ?? null,
      messageTemplate: input.messageTemplate ?? null,
      channels: input.channels,
      targets: input.targets as any,
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

export async function updateRule(id: string, input: RuleInput, actor?: string) {
  await getRule(id); // 404 if missing
  const rule = await prisma.notificationRule.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled,
      severity: input.severity,
      trigger: input.trigger as any,
      scope: input.scope as any,
      clearBehavior: input.clearBehavior,
      clearAfterSec: input.clearAfterSec ?? null,
      cooldownSec: input.cooldownSec ?? null,
      messageTemplate: input.messageTemplate ?? null,
      channels: input.channels,
      targets: input.targets as any,
    },
  });
  bumpChangeSubscriptions();
  await logEvent({
    action: "notification_rule.updated",
    resourceType: "notification-rule",
    resourceId: rule.id,
    resourceName: rule.name,
    actor,
    message: `Notification rule "${rule.name}" updated`,
    details: { triggerType: input.trigger.type, enabled: input.enabled },
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
