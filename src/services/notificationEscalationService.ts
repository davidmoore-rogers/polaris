/**
 * src/services/notificationEscalationService.ts
 *
 * The escalation sweep behind the escalateNotifications job (60s): while a
 * notification stays unhandled, send each of its rule's escalation tiers when
 * the tier's delay elapses (optionally repeating every repeatEveryMin up to
 * maxRepeats). "Unhandled" is per the rule's stopOn: "acknowledge" stops on
 * acknowledge OR clear; "clear" ignores acknowledgment and only stops on clear.
 *
 * Escalation emails render from the fire-time Notification.templateCtx
 * snapshot (exact fire-time metric/asset values, survives asset deletion) plus
 * the live {escalation.tier}/{escalation.elapsed} tokens. Tier subject/body
 * overrides fall back to the rule's emailComposition, then to a default
 * subject prefixed "[ESCALATION n]". Sends are NotificationDelivery rows with
 * the composed-meta snapshot — the existing deliverNotifications drain
 * dispatches them unchanged. Per-tier progress lives on
 * Notification.escalationState; writes are batched, no per-row await loops.
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
import { buildComposedEmail } from "./notificationEngine.js";
import { dedupeEmailRecipients, resolveEmailRecipients } from "./notificationRecipientService.js";
import type { EmailComposition, EscalationConfig, EscalationTier } from "./notificationTypes.js";

const DEFAULT_MAX_REPEATS = 5;
const EMAIL_CHANNEL_TYPES = new Set(["smtp", "oauth_m365"]);

interface EscalationRule {
  id: string;
  name: string;
  description: string | null;
  emailComposition: EmailComposition | null;
  escalation: EscalationConfig;
}

interface TierState {
  firstSentAt: string;
  lastSentAt: string;
  count: number;
}

type EscalationState = { tiers: Record<string, TierState> };

function stateOf(raw: unknown): EscalationState {
  const tiers = raw && typeof raw === "object" && (raw as any).tiers && typeof (raw as any).tiers === "object" ? (raw as any).tiers : {};
  return { tiers: { ...tiers } };
}

/** Is this tier due to send now? (first send after afterMin; repeats per repeatEveryMin up to maxRepeats.) */
export function tierIsDue(tier: EscalationTier, triggeredAt: Date, tierState: TierState | undefined, now: Date): boolean {
  if (now.getTime() - triggeredAt.getTime() < tier.afterMin * 60_000) return false;
  if (!tierState) return true;
  if (!tier.repeatEveryMin) return false; // send-once tier already sent
  const max = tier.maxRepeats ?? DEFAULT_MAX_REPEATS;
  if (tierState.count >= max) return false;
  return now.getTime() - new Date(tierState.lastSentAt).getTime() >= tier.repeatEveryMin * 60_000;
}

/** One sweep pass. Returns the number of escalation emails queued. */
export async function runEscalationSweep(now = new Date()): Promise<number> {
  // Escalation rules are few — load enabled rules and filter in memory (same
  // posture as the engine's per-tick rule load).
  const dbRules = await prisma.notificationRule.findMany({
    where: { enabled: true },
    select: { id: true, name: true, description: true, emailComposition: true, escalation: true },
  });
  const rules = new Map<string, EscalationRule>();
  for (const r of dbRules) {
    const esc = r.escalation as EscalationConfig | null;
    if (esc && Array.isArray(esc.tiers) && esc.tiers.length > 0) {
      rules.set(r.id, { id: r.id, name: r.name, description: r.description, emailComposition: r.emailComposition as EmailComposition | null, escalation: esc });
    }
  }
  if (rules.size === 0) return 0;

  // Candidates: uncleared notifications of escalation rules past the earliest
  // tier delay. Bounded by the active-unhandled set, not fleet size.
  const minAfterMin = Math.min(...Array.from(rules.values()).flatMap((r) => r.escalation.tiers.map((t) => t.afterMin)));
  const notifs = await prisma.notification.findMany({
    where: {
      cleared: false,
      ruleId: { in: Array.from(rules.keys()) },
      triggeredAt: { lte: new Date(now.getTime() - minAfterMin * 60_000) },
    },
    select: {
      id: true, ruleId: true, assetHostname: true, severity: true, message: true,
      triggeredAt: true, acknowledged: true, templateCtx: true, escalationState: true,
    },
  });
  if (notifs.length === 0) return 0;

  // Resolve every referenced tier channel once (skip deleted/disabled/non-email).
  const channelIds = Array.from(new Set(Array.from(rules.values()).flatMap((r) => r.escalation.tiers.map((t) => t.channelId))));
  const channels = await prisma.notificationChannel.findMany({
    where: { id: { in: channelIds } },
    select: { id: true, type: true, enabled: true },
  });
  const channelOk = new Set(channels.filter((c) => c.enabled && EMAIL_CHANNEL_TYPES.has(c.type)).map((c) => c.id));

  // Tier recipients resolve once per (rule, tier) per sweep, not per notification.
  const recipientCache = new Map<string, { to: string[]; cc: string[]; bcc: string[] }>();
  const tierRecipients = async (ruleId: string, tierIdx: number, tier: EscalationTier) => {
    const key = `${ruleId}|${tierIdx}`;
    let r = recipientCache.get(key);
    if (!r) {
      r = {
        to: await resolveEmailRecipients(tier.to),
        cc: await resolveEmailRecipients(tier.cc),
        bcc: await resolveEmailRecipients(tier.bcc),
      };
      recipientCache.set(key, r);
    }
    return r;
  };

  const deliveryRows: Prisma.NotificationDeliveryCreateManyInput[] = [];
  const stateUpdates: { id: string; state: EscalationState }[] = [];
  let skippedChannels = 0;

  for (const n of notifs) {
    const rule = rules.get(n.ruleId!);
    if (!rule) continue;
    if (rule.escalation.stopOn !== "clear" && n.acknowledged) continue; // "acknowledge" stops on ack

    const state = stateOf(n.escalationState);
    let dirty = false;

    for (const [idx, tier] of rule.escalation.tiers.entries()) {
      const tierKey = String(idx);
      if (!tierIsDue(tier, n.triggeredAt, state.tiers[tierKey], now)) continue;
      if (!channelOk.has(tier.channelId)) { skippedChannels++; continue; }

      const { to, cc, bcc } = await tierRecipients(rule.id, idx, tier);
      if (to.length === 0) continue;
      const deduped = dedupeEmailRecipients(to, cc, bcc);

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
      const ctx: Record<string, string> = {
        ...base,
        "escalation.tier": String(idx + 1),
        "escalation.elapsed": formatElapsed(now.getTime() - n.triggeredAt.getTime()),
      };

      // Tier overrides → rule composition → defaults; with no subject template
      // at either level, prefix the default subject with the escalation marker.
      const comp: EmailComposition = {
        subjectTemplate: tier.subjectTemplate ?? rule.emailComposition?.subjectTemplate ?? null,
        bodyTextTemplate: tier.bodyTextTemplate ?? rule.emailComposition?.bodyTextTemplate ?? null,
        bodyHtmlTemplate: tier.bodyHtmlTemplate ?? rule.emailComposition?.bodyHtmlTemplate ?? null,
      };
      const composed = buildComposedEmail(comp, ctx);
      if (!comp.subjectTemplate || !comp.subjectTemplate.trim()) {
        composed.subject = `[ESCALATION ${idx + 1}] ${composed.subject}`;
      }

      const prev = state.tiers[tierKey];
      deliveryRows.push({
        notificationId: n.id,
        channelId: tier.channelId,
        transport: "email",
        target: to.join(", "),
        meta: {
          composed: true,
          escalation: { tier: idx + 1, attempt: (prev?.count ?? 0) + 1 },
          to,
          cc: deduped.cc,
          bcc: deduped.bcc,
          subject: composed.subject,
          text: composed.text,
          ...(composed.html ? { html: composed.html } : {}),
        },
      });
      state.tiers[tierKey] = {
        firstSentAt: prev?.firstSentAt ?? now.toISOString(),
        lastSentAt: now.toISOString(),
        count: (prev?.count ?? 0) + 1,
      };
      dirty = true;
    }

    if (dirty) stateUpdates.push({ id: n.id, state });
  }

  if (deliveryRows.length === 0) {
    if (skippedChannels > 0) logger.debug({ skippedChannels }, "escalation sweep: tiers skipped (channel deleted/disabled/non-email)");
    return 0;
  }

  await prisma.notificationDelivery.createMany({ data: deliveryRows });
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
    message: `Escalation: ${deliveryRows.length} email(s) queued for ${stateUpdates.length} unhandled notification(s)`,
    details: { queued: deliveryRows.length, notifications: stateUpdates.length, skippedChannels },
  }).catch(() => {});

  return deliveryRows.length;
}
