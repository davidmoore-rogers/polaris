/**
 * src/services/automationActionService.ts
 *
 * The single fan-out point between a fired alert (Notification row) and its
 * automation's `actions[]` — called by the engine on fire (threshold + event
 * tail) and, in the escalation-v2 phase, by the escalation sweep per due tier.
 *
 * Per action type:
 *   notify   → the existing recipient/delivery pipeline: the action converts
 *              to a DeliveryTarget and expandDeliveries creates the rows; the
 *              composed email is the ACTION's emailComposition, falling back
 *              to the rule-level one (byte-identical to the legacy path for
 *              converted rules, where the conversion copied the rule-level
 *              composition onto every action).
 *   api_call → ONE NotificationDelivery row, transport "api_call",
 *              channelId NULL (there is no channel — the destination lives on
 *              the action). meta carries {method, url, headers, body, timeoutSec}
 *              with the body rendered from the fire-time template context.
 *              The deliverNotifications drain dispatches it with retries.
 *              SECURITY: headers were typed by the operator and are stored
 *              unmasked — save-time docs/catalog warn against secrets; the
 *              URL was SSRF-checked at save and is re-checked at send.
 *   script   → refused until the AutomationScript registry phase (recorded as
 *              a failed action, warning Event) — assertActionRefs also blocks
 *              script actions at save, so reaching this arm means a stale rule.
 *
 * Execution is best-effort PER ACTION: one bad action never blocks the
 * others; each failure writes an `automation.action_error` warning Event.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { renderNotificationTemplate } from "../utils/notificationTemplate.js";
import {
  expandDeliveries,
  buildComposedEmail,
  type ComposedEmail,
} from "./notificationRecipientService.js";
import {
  actionsToTargets,
  type AutomationAction,
  type ApiCallAction,
  type EmailComposition,
} from "./notificationTypes.js";

export interface ActionExecContext {
  /** region: tags from the rule's scope (recipientScopeRegion routing). */
  scopeRegionTags?: string[];
  /** The triggering asset, when the alert has one (script actions target it). */
  assetId?: string | null;
  ruleId?: string;
  ruleName?: string;
  /** Rule-level emailComposition — the per-action fallback for notify actions. */
  ruleEmailComposition?: EmailComposition | null;
  /** Set by the escalation sweep: stamps delivery meta + audit details. */
  escalation?: { tier: number; attempt: number };
  /** Audit actor; defaults to "system:automation". */
  actor?: string;
}

/**
 * Fan a fired alert's actions out to their execution paths. Never throws for
 * a single action's failure — failures are recorded as warning Events and the
 * remaining actions still run.
 */
export async function executeActions(
  notificationId: string,
  actions: AutomationAction[],
  ctx: Record<string, string>,
  exec: ActionExecContext,
): Promise<void> {
  for (const [index, action] of actions.entries()) {
    try {
      if (action.type === "notify") {
        const comp = action.emailComposition ?? exec.ruleEmailComposition ?? null;
        const composed: ComposedEmail | undefined = comp ? buildComposedEmail(comp, ctx) : undefined;
        await expandDeliveries(notificationId, actionsToTargets([action]), exec.scopeRegionTags, composed);
      } else if (action.type === "api_call") {
        await enqueueApiCall(notificationId, action, ctx, exec);
      } else {
        // script — registry phase pending; save-time validation blocks these,
        // so a stored one is stale. Fail loudly rather than silently dropping.
        throw new Error("script actions are not executable yet (automation script registry pending)");
      }
    } catch (err) {
      await logEvent({
        action: "automation.action_error",
        resourceType: "notification",
        resourceId: notificationId,
        resourceName: exec.ruleName,
        actor: exec.actor ?? "system:automation",
        level: "warning",
        message: `Automation action ${index + 1} (${action.type}) failed: ${(err as Error)?.message}`,
        details: {
          actionIndex: index,
          actionType: action.type,
          ruleId: exec.ruleId ?? null,
          assetId: exec.assetId ?? null,
          ...(exec.escalation ? { escalation: exec.escalation } : {}),
          err: (err as Error)?.message,
        },
      }).catch(() => {});
    }
  }
}

/**
 * Queue an api_call action as a NotificationDelivery row (transport
 * "api_call", channelId NULL — no channel involved; the drain gives us the
 * retry/attempts/status machinery for free). The body template renders NOW,
 * from the fire-time context, so the drain never needs the rule.
 */
async function enqueueApiCall(
  notificationId: string,
  action: ApiCallAction,
  ctx: Record<string, string>,
  exec: ActionExecContext,
): Promise<void> {
  const body = action.bodyTemplate && action.bodyTemplate.trim()
    ? renderNotificationTemplate(action.bodyTemplate, ctx)
    : undefined;
  await prisma.notificationDelivery.create({
    data: {
      notificationId,
      channelId: null,
      transport: "api_call",
      target: action.url,
      meta: {
        apiCall: true,
        method: action.method,
        url: action.url,
        ...(action.headers && Object.keys(action.headers).length > 0 ? { headers: action.headers } : {}),
        ...(body !== undefined ? { body } : {}),
        timeoutSec: action.timeoutSec,
        ...(exec.escalation ? { escalation: exec.escalation } : {}),
      },
    },
  });
}
