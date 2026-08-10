/**
 * src/services/notificationEscalationService.ts
 *
 * The escalation sweep behind the escalateNotifications job (60s): while a
 * notification stays unhandled, run each of its rule's escalation tiers when
 * the tier's delay elapses (optionally repeating every repeatEveryMin up to
 * maxRepeats). "Unhandled" is per chain stopOn: "acknowledge" stops on
 * acknowledge OR clear; "clear" ignores acknowledgment and only stops on clear.
 *
 * PER-ACTION ESCALATION: chains live at the rule/band LEVEL (key "" — bare
 * numeric tier state keys, unchanged from pre-feature rows) and on individual
 * actions (key "a<i>" — state keys "a<i>:t<j>"). escalationChainsForSeverity
 * (notificationTypes) selects the chains active at the alert's current
 * severity: the band's level chain + its actions' chains, with the engine's
 * empty-band fallback to the base actions mirrored here.
 *
 * ESCALATION V2: a tier carries ACTIONS (notify / api_call / script), not just
 * an email — every due tier fans out through automationActionService.
 * executeActions with `exec.escalation` set. Legacy email tiers (pre-wizard
 * rules) normalize to single-notify-action tiers via normalizeEscalationToV2,
 * and the notify arm's escalation composition (per-FIELD tier→rule fallback,
 * always-composed, "[ESCALATION n]" default-subject prefix) reproduces the
 * pre-v2 emails byte-for-byte.
 *
 * Rendering context = the fire-time Notification.templateCtx snapshot (exact
 * fire-time metric/asset values, survives asset deletion) plus the live
 * {escalation.tier}/{escalation.elapsed} tokens. Per-tier progress lives on
 * Notification.escalationState — a tier counts as SENT only when at least one
 * of its actions executed (empty recipients / dead channels retry next sweep).
 */

import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { logger } from "../utils/logger.js";
import {
  buildTemplateContext,
  formatElapsed,
  notificationsPageUrl,
} from "../utils/notificationTemplate.js";
import { logEvent } from "./eventLogService.js";
import { isSuppressedForNotifications } from "./notificationEngine.js";
import { executeActions } from "./automationActionService.js";
import { scopeRegionTagsOf } from "./notificationRecipientService.js";
import {
  normalizeRuleToV2,
  normalizeEscalationToV2,
  escalationChainsForSeverity,
  escalationTierStateKey,
  type EmailComposition,
  type EscalationV2Config,
  type EscalatableAction,
  type SeverityBand,
  type RuleScope,
} from "./notificationTypes.js";

const DEFAULT_MAX_REPEATS = 5;

interface EscalationRule {
  id: string;
  name: string;
  description: string | null;
  scope: RuleScope;
  emailComposition: EmailComposition | null;
  /** Base severity (tier 0). */
  severity: string;
  /** v2 action list — actions may carry their own escalation chain. */
  actions: EscalatableAction[];
  /** Rule-level escalation chain, or null. */
  escalation: EscalationV2Config | null;
  /** Severity bands — band-level chains + per-band-action chains. */
  severityBands: SeverityBand[] | null;
}

/** Every escalation chain a rule can present — rule-level, per-action,
 *  band-level, and band-per-action — for rule inclusion + the minAfterMin
 *  candidate cutoff. */
function allEscalationsOf(rule: EscalationRule): EscalationV2Config[] {
  const out: EscalationV2Config[] = [];
  const add = (esc: unknown) => {
    const e = normalizeEscalationToV2(esc);
    if (e && e.tiers.length > 0) out.push(e);
  };
  add(rule.escalation);
  for (const a of rule.actions) if (a.type !== "event") add(a.escalation);
  for (const b of rule.severityBands ?? []) {
    add(b.escalation);
    for (const a of b.actions ?? []) if (a.type !== "event") add(a.escalation);
  }
  return out;
}

interface TierState {
  firstSentAt: string;
  lastSentAt: string;
  count: number;
}

// bandSince (severity bands): when the alert entered its current band, so a
// newly-entered band's escalation timers restart from band-entry rather than
// the original fire. Absent for single-severity alerts (timers run off
// triggeredAt). Stamped by the engine's applyBandTransition.
type EscalationState = { tiers: Record<string, TierState>; bandSince?: string };

function stateOf(raw: unknown): EscalationState {
  const o = raw && typeof raw === "object" ? (raw as any) : {};
  const tiers = o.tiers && typeof o.tiers === "object" ? o.tiers : {};
  return { tiers: { ...tiers }, ...(typeof o.bandSince === "string" ? { bandSince: o.bandSince } : {}) };
}

/** Is this tier due to run now? (first run after afterMin; repeats per
 *  repeatEveryMin up to maxRepeats.) Structural tier type so both the legacy
 *  and v2 tier shapes fit. */
export function tierIsDue(
  tier: { afterMin: number; repeatEveryMin?: number | null; maxRepeats?: number | null },
  triggeredAt: Date,
  tierState: TierState | undefined,
  now: Date,
): boolean {
  if (now.getTime() - triggeredAt.getTime() < tier.afterMin * 60_000) return false;
  if (!tierState) return true;
  if (!tier.repeatEveryMin) return false; // run-once tier already ran
  const max = tier.maxRepeats ?? DEFAULT_MAX_REPEATS;
  if (tierState.count >= max) return false;
  return now.getTime() - new Date(tierState.lastSentAt).getTime() >= tier.repeatEveryMin * 60_000;
}

/** One sweep pass. Returns the number of tier executions (tiers that ran ≥1 action). */
export async function runEscalationSweep(now = new Date()): Promise<number> {
  // Escalation rules are few — load enabled rules and filter in memory (same
  // posture as the engine's per-tick rule load). Normalize through the v2
  // view so legacy email tiers and v2 action tiers sweep identically.
  const dbRules = await prisma.notificationRule.findMany({
    where: { enabled: true },
    select: {
      id: true, name: true, description: true, scope: true, emailComposition: true, severity: true,
      escalation: true, targets: true, clearBehavior: true, clearAfterSec: true, reset: true, actions: true,
      severityBands: true,
    },
  });
  const rules = new Map<string, EscalationRule>();
  for (const r of dbRules) {
    const v2 = normalizeRuleToV2(r);
    const rule: EscalationRule = {
      id: r.id,
      name: r.name,
      description: r.description,
      scope: (r.scope ?? {}) as RuleScope,
      emailComposition: r.emailComposition as EmailComposition | null,
      severity: r.severity,
      actions: v2.actions,
      escalation: v2.escalation,
      severityBands: v2.severityBands,
    };
    // Include the rule if ANY chain exists (rule-level, per-action, or band).
    if (allEscalationsOf(rule).length > 0) rules.set(r.id, rule);
  }
  if (rules.size === 0) return 0;

  // Candidates: uncleared notifications of escalation rules past the earliest
  // tier delay (across tier 0 + every band). Bounded by the active-unhandled
  // set, not fleet size.
  const minAfterMin = Math.min(
    ...Array.from(rules.values()).flatMap((r) => allEscalationsOf(r).flatMap((e) => e.tiers.map((t) => t.afterMin))),
  );
  const notifs = await prisma.notification.findMany({
    where: {
      cleared: false,
      ruleId: { in: Array.from(rules.keys()) },
      triggeredAt: { lte: new Date(now.getTime() - minAfterMin * 60_000) },
    },
    select: {
      id: true, ruleId: true, assetId: true, assetHostname: true, severity: true, message: true,
      triggeredAt: true, acknowledged: true, templateCtx: true, escalationState: true,
      // The fire-time asset-region snapshot (already region:-stripped) —
      // recipientDeviceRegion routing; survives asset deletion.
      regionTags: true,
    },
  });
  if (notifs.length === 0) return 0;

  // Maintenance / dependency suppression: escalation pauses while the
  // notification's asset is silenced (tier timers keep running off
  // triggeredAt — a still-unhandled notification resumes escalating after
  // the window ends).
  const notifAssetIds = Array.from(new Set(notifs.map((n) => n.assetId).filter((id): id is string => !!id)));
  const suppressedAssetIds = new Set<string>();
  if (notifAssetIds.length > 0) {
    const assetRows = await prisma.asset.findMany({
      where: { id: { in: notifAssetIds } },
      select: { id: true, status: true, dependencySuppressed: true },
    });
    for (const a of assetRows) {
      if (isSuppressedForNotifications({ status: String(a.status), dependencySuppressed: a.dependencySuppressed })) {
        suppressedAssetIds.add(a.id);
      }
    }
  }

  const stateUpdates: { id: string; state: EscalationState }[] = [];
  let tierRuns = 0;

  for (const n of notifs) {
    const rule = rules.get(n.ruleId!);
    if (!rule) continue;
    // Value-driven escalation: the alert's CURRENT band (its severity) selects
    // which chains apply — the band's level chain + its actions' chains (empty
    // band → the base actions' chains, matching the engine's action fallback).
    // The engine resets escalationState on every band change, so a newly-
    // entered band's tiers start their timers fresh.
    const chains = escalationChainsForSeverity(rule, n.severity);
    if (chains.length === 0) continue;
    if (n.assetId && suppressedAssetIds.has(n.assetId)) continue; // silenced — resumes post-window

    const state = stateOf(n.escalationState);
    // Timers run from band-entry when banded (bandSince), else the fire time.
    const startAt = state.bandSince ? new Date(state.bandSince) : n.triggeredAt;
    let dirty = false;

    for (const chain of chains) {
      // stopOn is per chain: an acknowledged alert stops "acknowledge" chains
      // while its "clear" chains keep escalating until the alert clears.
      if (chain.escalation.stopOn !== "clear" && n.acknowledged) continue;

      for (const [idx, tier] of chain.escalation.tiers.entries()) {
        // Level chain ("") keeps the bare numeric keys pre-feature rows carry;
        // per-action chains key as "a<i>:t<j>".
        const tierKey = escalationTierStateKey(chain.key, idx);
        if (!tierIsDue(tier, startAt, state.tiers[tierKey], now)) continue;

        // Context: fire-time snapshot + live escalation tokens. Pre-feature
        // notifications (no templateCtx) get a minimal context from the row.
        const base = n.templateCtx && typeof n.templateCtx === "object"
          ? (n.templateCtx as Record<string, string>)
          : buildTemplateContext({
              asset: n.assetHostname ?? "",
              severity: n.severity,
              time: n.triggeredAt,
              link: notificationsPageUrl(),
              message: n.message,
              ruleName: rule.name,
              ruleDescription: rule.description,
            });
        const prev = state.tiers[tierKey];
        const attempt = (prev?.count ?? 0) + 1;
        const ctx: Record<string, string> = {
          ...base,
          "escalation.tier": String(idx + 1),
          "escalation.elapsed": formatElapsed(now.getTime() - n.triggeredAt.getTime()),
        };

        const { executed } = await executeActions(n.id, tier.actions, ctx, {
          scopeRegionTags: scopeRegionTagsOf(rule.scope),
          assetRegionTags: n.regionTags,
          assetId: n.assetId,
          ruleId: rule.id,
          ruleName: rule.name,
          ruleEmailComposition: rule.emailComposition,
          escalation: { tier: idx + 1, attempt },
          actor: "system:notification-escalation",
        });

        // A tier counts as sent only when something actually ran — a tier whose
        // recipients resolved empty / channel is disabled retries next sweep
        // (same behavior as the pre-v2 sweep).
        if (executed > 0) {
          state.tiers[tierKey] = {
            firstSentAt: prev?.firstSentAt ?? now.toISOString(),
            lastSentAt: now.toISOString(),
            count: attempt,
          };
          dirty = true;
          tierRuns++;
        }
      }
    }

    if (dirty) stateUpdates.push({ id: n.id, state });
  }

  if (tierRuns === 0) return 0;

  await prisma.$transaction(
    stateUpdates.map((u) =>
      prisma.notification.update({ where: { id: u.id }, data: { escalationState: u.state as unknown as Prisma.InputJsonValue } }),
    ),
  );

  await logEvent({
    action: "notification.escalated",
    resourceType: "notification",
    actor: "system:notification-escalation",
    level: "info",
    message: `Escalation: ${tierRuns} tier run(s) executed for ${stateUpdates.length} unhandled notification(s)`,
    details: { tierRuns, notifications: stateUpdates.length },
  }).catch(() => {});

  logger.debug({ tierRuns, notifications: stateUpdates.length }, "escalation sweep");
  return tierRuns;
}
