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
  ASSET_SCOPED_TRIGGER_TYPES,
  CHANGE_TYPE_ACTIONS,
  legacyMirrorOfV2,
  normalizeRuleToV2,
} from "./notificationTypes.js";
import { isBlockedOutboundHost } from "../utils/netGuard.js";

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

// Escalation is email-only until the escalation-v2 phase: every tier must
// reference an smtp/oauth_m365 channel. Validated at save so the sweep never
// has to guess intent.
const EMAIL_CHANNEL_TYPES = new Set(["smtp", "oauth_m365"]);

/**
 * Validate every reference a v2 rule's actions carry:
 *   - notify.channelId must exist (any channel type is legal in v2),
 *   - api_call.url host must pass the outbound SSRF guard (friendly 400 at
 *     save beats a silent fire-time failure),
 *   - script actions are refused until the script-registry phase lands,
 *   - legacy escalation tiers keep the email-channel check.
 */
async function assertActionRefs(input: RuleInput): Promise<void> {
  const notifyChannelIds = new Set<string>();
  for (const [i, action] of input.actions.entries()) {
    if (action.type === "notify") {
      notifyChannelIds.add(action.channelId);
    } else if (action.type === "api_call") {
      let host = "";
      try {
        host = new URL(action.url).hostname;
      } catch {
        throw new AppError(400, `Action ${i + 1}: api_call URL is not a valid URL`);
      }
      if (isBlockedOutboundHost(host)) {
        throw new AppError(400, `Action ${i + 1}: api_call host "${host}" is blocked (loopback/link-local/metadata addresses are not allowed)`);
      }
    } else if (action.type === "script") {
      // Placeholder until the AutomationScript registry phase: accepting a
      // scriptId that can't resolve would store a permanently-failing action.
      throw new AppError(400, `Action ${i + 1}: script actions are not available yet (the automation script registry has not been enabled)`);
    }
  }

  const escalation = input.escalation;
  const escalationIds = escalation ? escalation.tiers.map((t) => t.channelId) : [];
  const allIds = Array.from(new Set([...notifyChannelIds, ...escalationIds]));
  if (allIds.length === 0) return;
  const channels = await prisma.notificationChannel.findMany({
    where: { id: { in: allIds } },
    select: { id: true, name: true, type: true },
  });
  const byId = new Map(channels.map((c) => [c.id, c]));

  for (const id of notifyChannelIds) {
    if (!byId.has(id)) throw new AppError(400, "A notify action references a delivery channel that no longer exists");
  }
  if (escalation) {
    for (const [i, tier] of escalation.tiers.entries()) {
      const ch = byId.get(tier.channelId);
      if (!ch) throw new AppError(400, `Escalation tier ${i + 1} references a delivery channel that no longer exists`);
      if (!EMAIL_CHANNEL_TYPES.has(ch.type)) {
        throw new AppError(400, `Escalation tier ${i + 1} channel "${ch.name}" is ${ch.type} — escalation emails require an email channel (SMTP or Microsoft 365)`);
      }
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
  await assertActionRefs(input);
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
