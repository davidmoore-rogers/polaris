/**
 * src/services/notificationPreferenceService.ts
 *
 * Per-user notification preference — which delivery method an account wants
 * its alerts on: "email" (the default), "push", or "any" (both).
 *
 * Two halves, deliberately kept apart:
 *
 *   The STORED preference (User.notificationPreference) is the account's
 *   answer, and it lives server-side rather than per browser because it has to
 *   survive a sign-in on a device that has never seen it. Every client reads it
 *   at boot and enrolls or unsubscribes THAT browser to match, which is what
 *   makes "prefer push" mean push on every device the operator signs in on
 *   instead of only the one they clicked it on.
 *
 *   The ROUTING half is `preferenceAllowsTransport` — pure, and deliberately
 *   permissive: it is asked once per recipient per notify action, and only
 *   after the caller has decided the action is eligible at all (business rule
 *   39). Anything it doesn't recognize resolves to "deliver": a preference
 *   column holding a value this build doesn't know must never silently
 *   un-address an alert.
 *
 * A write bumps the recipient index (notificationRecipientService caches user
 * tag scopes for 30s and now carries the preference alongside them), so the
 * new choice applies to the next alert rather than up to half a minute later.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { bumpRecipientIndex } from "./notificationRecipientService.js";
import { logEvent } from "./eventLogService.js";

export const NOTIFICATION_PREFERENCES = ["email", "push", "any"] as const;
export type NotificationPreference = (typeof NOTIFICATION_PREFERENCES)[number];

export const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = "email";

/** Operator-facing labels — shared by the desktop account menu and the mobile
 *  More tab so the two surfaces can't word the same choice differently. */
export const NOTIFICATION_PREFERENCE_LABELS: Record<NotificationPreference, string> = {
  email: "Email",
  push: "Push",
  any: "Email and push",
};

/**
 * Normalize a stored / submitted value. Unknown input resolves to the default
 * rather than throwing: this is read on the alerting hot path from a plain
 * TEXT column, and a row holding something unexpected must degrade to "email"
 * (which reaches everyone with an address) rather than fail a send.
 */
export function normalizeNotificationPreference(v: unknown): NotificationPreference {
  return (NOTIFICATION_PREFERENCES as readonly string[]).includes(v as string)
    ? (v as NotificationPreference)
    : DEFAULT_NOTIFICATION_PREFERENCE;
}

/**
 * Does this preference accept a delivery on `transport`?
 *
 * Only the two recipient-routed transports an account can actually express a
 * preference between are answerable — a Slack/Teams webhook or a Pushbullet
 * channel posts to ONE configured destination and has no per-user recipients
 * at all, so it is always allowed and the caller never asks about it.
 *
 * Pure — exported for the tests, because the failure mode is silent: getting
 * this backwards drops recipients from an alert instead of erroring.
 */
export function preferenceAllowsTransport(pref: unknown, transport: string): boolean {
  if (transport !== "email" && transport !== "web_push") return true;
  const p = normalizeNotificationPreference(pref);
  if (p === "any") return true;
  return transport === "email" ? p === "email" : p === "push";
}

export async function getNotificationPreference(userId: string): Promise<NotificationPreference> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreference: true },
  });
  if (!row) throw new AppError(404, "User not found");
  return normalizeNotificationPreference(row.notificationPreference);
}

/**
 * Set the caller's own preference. Audited: it changes who an alert reaches,
 * so "I never got paged" has to be answerable from the Events tab. Actor is
 * the username, since this is always a self-service write.
 */
export async function setNotificationPreference(
  userId: string,
  username: string,
  pref: NotificationPreference,
): Promise<NotificationPreference> {
  const before = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreference: true },
  });
  if (!before) throw new AppError(404, "User not found");
  const previous = normalizeNotificationPreference(before.notificationPreference);
  if (previous === pref) return pref;

  await prisma.user.update({ where: { id: userId }, data: { notificationPreference: pref } });
  // The recipient index caches the preference alongside each user's tag scope;
  // without this the change takes up to the 30s TTL to reach the engine.
  bumpRecipientIndex();

  await logEvent({
    action: "user.notification_preference.changed",
    resourceType: "user",
    resourceId: userId,
    resourceName: username,
    actor: username,
    level: "info",
    message: `Notification preference changed from ${NOTIFICATION_PREFERENCE_LABELS[previous]} to ${NOTIFICATION_PREFERENCE_LABELS[pref]}`,
    details: { from: previous, to: pref },
  }).catch(() => {});

  return pref;
}
