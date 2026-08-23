/**
 * src/services/notificationService.ts
 *
 * Read + lifecycle for triggered notifications (the View tab + asset-details
 * tab). Region-scoped listing, batch acknowledge/clear (no per-row awaits),
 * and the per-asset bundle. The engine writes notifications; this module is
 * the operator-facing read/lifecycle side.
 */

import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { findRulesMatchingAsset } from "./notificationRuleService.js";

export const REGION_TAG_PREFIX = "region:";

/** Strip the `region:` prefix from a map-region tag (case-insensitive). */
export function stripRegionPrefix(tag: string): string {
  return tag.toLowerCase().startsWith(REGION_TAG_PREFIX)
    ? tag.slice(REGION_TAG_PREFIX.length)
    : tag;
}

export interface ListFilters {
  severity?: string[];
  acknowledged?: boolean;
  assetId?: string;
  region?: string[];
  search?: string;
  includeCleared?: boolean;
}

export interface ListParams {
  /** Viewer effective region tags. Empty = unrestricted (see everything). */
  viewerRegionTags: string[];
  filters?: ListFilters;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

const SORTABLE = new Set(["triggeredAt", "severity", "assetHostname", "acknowledged", "message"]);

/**
 * Build the region-scope `where` fragment. A viewer with no region tags is
 * unrestricted. Otherwise they see notifications whose snapshotted regionTags
 * intersect their tags, PLUS unscoped notifications (empty regionTags — system
 * alerts not tied to a region, which can't be region-filtered).
 */
function regionScopeWhere(viewerRegionTags: string[]): Prisma.NotificationWhereInput | undefined {
  if (!viewerRegionTags || viewerRegionTags.length === 0) return undefined;
  return {
    OR: [
      { regionTags: { isEmpty: true } },
      { regionTags: { hasSome: viewerRegionTags } },
    ],
  };
}

/**
 * Include + flatten for the automation's acknowledge-note policy.
 *
 * Every list surface has to know whether acknowledging a row needs a note
 * BEFORE the operator clicks (the modal marks the field required, the phone
 * opens a note sheet instead of one-tapping), so it rides each row as a plain
 * boolean rather than making the client fetch the automation. Rule-less rows
 * — test alerts, and rows whose automation was deleted (ruleId is SetNull) —
 * read false: there is no policy left to enforce, and refusing to let anyone
 * close them out would be worse than a missing note.
 */
const ACK_POLICY_INCLUDE = { rule: { select: { requireAckNote: true } } } as const;

type RowWithRulePolicy = { rule?: { requireAckNote: boolean } | null };

export function withAckPolicy<T extends RowWithRulePolicy>(row: T): Omit<T, "rule"> & { requireAckNote: boolean } {
  const { rule, ...rest } = row;
  return { ...rest, requireAckNote: rule?.requireAckNote === true };
}

/**
 * Does this batch need a note that wasn't supplied? Pure so the rule can be
 * tested without a database — the count comes from one indexed query.
 *
 * A batch is refused WHOLE rather than partially applied: the route takes one
 * shared note for every id, so "acknowledge the ones that don't need a note"
 * would silently leave the important half of a selection open while reporting
 * success.
 */
export function ackNoteProblem(needyCount: number, batchSize: number, note: string): string | null {
  if (note.trim().length > 0 || needyCount <= 0) return null;
  return needyCount === 1 && batchSize === 1
    ? "This alert's automation requires a note when acknowledging — say what the problem is and what the fix was."
    : `${needyCount} of these alerts come from automations that require a note when acknowledging.`;
}

export async function listNotifications(params: ListParams) {
  const { viewerRegionTags, filters = {}, sortBy = "triggeredAt", sortDir = "desc" } = params;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);

  const and: Prisma.NotificationWhereInput[] = [];
  if (!filters.includeCleared) and.push({ cleared: false });
  if (filters.severity && filters.severity.length > 0) and.push({ severity: { in: filters.severity } });
  if (typeof filters.acknowledged === "boolean") and.push({ acknowledged: filters.acknowledged });
  if (filters.assetId) and.push({ assetId: filters.assetId });
  if (filters.region && filters.region.length > 0) and.push({ regionTags: { hasSome: filters.region } });
  if (filters.search) {
    and.push({
      OR: [
        { message: { contains: filters.search, mode: "insensitive" } },
        { assetHostname: { contains: filters.search, mode: "insensitive" } },
      ],
    });
  }
  const region = regionScopeWhere(viewerRegionTags);
  if (region) and.push(region);

  const where: Prisma.NotificationWhereInput = and.length > 0 ? { AND: and } : {};
  const orderField = SORTABLE.has(sortBy) ? sortBy : "triggeredAt";

  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { [orderField]: sortDir === "asc" ? "asc" : "desc" },
      take: limit,
      skip: offset,
      include: ACK_POLICY_INCLUDE,
    }),
    prisma.notification.count({ where }),
  ]);

  return { notifications: rows.map(withAckPolicy), total, limit, offset };
}

/**
 * Run each alert's automation reset actions before an OPERATOR clear.
 *
 * Lives here rather than in the engine because the engine owns the paths where
 * a condition recovered; this is the human one. Only alerts that are still
 * open and whose rule actually defines reset actions do any work, so the
 * common case is one extra indexed read.
 */
async function runResetActionsForCleared(ids: string[], actor: string): Promise<void> {
  const rows = await prisma.notification.findMany({
    where: { id: { in: ids }, cleared: false, ruleId: { not: null } },
    select: {
      id: true, message: true, severity: true, assetId: true, assetHostname: true,
      rule: { select: { id: true, name: true, scope: true, emailComposition: true, resetActions: true } },
    },
    take: 200,
  });
  const withActions = rows.filter((r) => Array.isArray(r.rule?.resetActions) && (r.rule!.resetActions as unknown[]).length > 0);
  if (withActions.length === 0) return;

  // Imported lazily: notificationService is imported BY the recipient service
  // (stripRegionPrefix), so a top-level import here would close the cycle.
  const [{ executeActions }, { buildTemplateContext, setRecoverySentence }, { scopeRegionTagsOf }] = await Promise.all([
    import("./automationActionService.js"),
    import("../utils/notificationTemplate.js"),
    import("./notificationRecipientService.js"),
  ]);

  for (const n of withActions) {
    const rule = n.rule!;
    const ctx = buildTemplateContext({
      asset: n.assetHostname ?? "",
      severity: "resolved",
      time: new Date(),
      ruleName: rule.name,
    });
    // Headline AND {message}: this context has no reading behind it, so without
    // the headline the email would state the severity and the hostname and
    // nothing about what happened.
    setRecoverySentence(ctx, `Resolved: ${rule.name} — ${n.assetHostname ?? "alert"} cleared by ${actor}`);
    await executeActions(n.id, rule.resetActions as never, ctx, {
      scopeRegionTags: scopeRegionTagsOf(rule.scope as never),
      assetId: n.assetId,
      ruleId: rule.id,
      ruleName: rule.name,
      ruleEmailComposition: (rule.emailComposition ?? null) as never,
      actor,
    }).catch(() => { /* one bad alert must not stop the rest of the batch */ });
  }
}

/** How an acknowledgement reached us — audit detail only, never a gate. */
export type AckSource = "ui" | "ack_link" | "web_push_action";

/**
 * Acknowledge a batch of notifications, stamping a shared optional note.
 * Skips rows already acknowledged. One updateMany; one audit Event.
 *
 * `acknowledgedBy` stays the plain actor string the Alerts surfaces render;
 * provenance rides the Event's details instead, so an emailed one-click
 * acknowledgement is distinguishable in the audit log without changing what
 * every existing reader of the column sees.
 */
export async function acknowledgeNotifications(
  ids: string[],
  actor: string,
  note?: string,
  opts?: { source?: AckSource },
): Promise<number> {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError(400, "No notification ids provided");
  }
  const trimmed = (note ?? "").trim();
  // The note policy lives on the automation, so it has to be enforced HERE
  // rather than in the modal: this one function backs the Alerts tab, the
  // mobile list, the emailed one-click link and the web-push action button,
  // and three of those four can acknowledge without ever rendering a form.
  // One indexed count, and only when no note was given.
  if (trimmed.length === 0) {
    const needy = await prisma.notification.count({
      where: { id: { in: ids }, acknowledged: false, rule: { requireAckNote: true } },
    });
    const problem = ackNoteProblem(needy, ids.length, trimmed);
    if (problem) throw new AppError(400, problem);
  }
  const res = await prisma.notification.updateMany({
    where: { id: { in: ids }, acknowledged: false },
    data: {
      acknowledged: true,
      acknowledgedBy: actor,
      acknowledgedAt: new Date(),
      acknowledgeNote: trimmed.length > 0 ? trimmed : null,
    },
  });
  await logEvent({
    action: "notification.acknowledged",
    resourceType: "notification",
    actor,
    message: `Acknowledged ${res.count} notification${res.count === 1 ? "" : "s"}`,
    details: { ids, count: res.count, hasNote: trimmed.length > 0, source: opts?.source ?? "ui" },
  });
  return res.count;
}

/** Soft-clear a batch (cleared=true → filtered from the default list). */
export async function clearNotifications(ids: string[], actor: string): Promise<number> {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError(400, "No notification ids provided");
  }
  // An operator clearing an alert IS the alert ending, so the automation's
  // reset actions run — the recovery message names who ended it, since "it
  // recovered" and "someone closed it out" are different facts. Best-effort
  // and before the write, so the actions' deliveries attach to a live
  // notification; a failure here must never block the clear.
  await runResetActionsForCleared(ids, actor).catch(() => {});
  const res = await prisma.notification.updateMany({
    where: { id: { in: ids }, cleared: false },
    data: { cleared: true, clearedBy: actor, clearedAt: new Date() },
  });
  await logEvent({
    action: "notification.cleared",
    resourceType: "notification",
    actor,
    message: `Cleared ${res.count} notification${res.count === 1 ? "" : "s"}`,
    details: { ids, count: res.count },
  });
  return res.count;
}

/**
 * The asset-details Notifications tab bundle: active (non-cleared)
 * notifications for the asset + the enabled rules whose scope matches it.
 */
export async function getAssetNotifications(assetId: string) {
  const [active, matchingRules] = await Promise.all([
    prisma.notification.findMany({
      where: { assetId, cleared: false },
      orderBy: { triggeredAt: "desc" },
      take: 200,
      include: ACK_POLICY_INCLUDE,
    }),
    findRulesMatchingAsset(assetId),
  ]);
  return { active: active.map(withAckPolicy), matchingRules };
}
