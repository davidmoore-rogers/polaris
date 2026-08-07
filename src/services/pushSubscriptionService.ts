/**
 * src/services/pushSubscriptionService.ts — per-user Web Push subscription store
 *
 * Owns the PushSubscription table writes made by the /push-subscriptions
 * routes. Readers live elsewhere: notificationRecipientService fans a
 * notification out to a user's endpoints, and the web_push delivery channel
 * prunes rows when a push endpoint answers 410/404.
 */

import { prisma } from "../db.js";

export interface SavePushSubscriptionInput {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  /** Enrolling surface: "desktop" | "mobile". Defaults to desktop. */
  surface?: string;
  /**
   * Set by the service worker's `pushsubscriptionchange` handler: the endpoint
   * the browser just rotated away from. A rotation mints a NEW endpoint (so
   * this is a create, with no row to inherit from), and the SW has no idea
   * which surface enrolled the original — without this the subscription would
   * silently demote to desktop deep links.
   */
  oldEndpoint?: string | null;
}

export async function savePushSubscription(input: SavePushSubscriptionInput): Promise<void> {
  const { userId, endpoint, p256dh, auth, userAgent, oldEndpoint } = input;
  const now = new Date();

  let surface = input.surface === "mobile" ? "mobile" : input.surface === "desktop" ? "desktop" : null;

  // Rotation: carry the retiring row's surface forward and retire it. Scoped
  // to the caller's own rows so one user can never read or delete another's
  // subscription by guessing an endpoint.
  if (oldEndpoint && oldEndpoint !== endpoint) {
    const prev = await prisma.pushSubscription.findFirst({
      where: { endpoint: oldEndpoint, userId },
      select: { surface: true },
    });
    if (prev) {
      if (surface === null) surface = prev.surface;
      await prisma.pushSubscription.deleteMany({ where: { endpoint: oldEndpoint, userId } });
    }
  }

  const resolved = surface ?? "desktop";
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh, auth, userAgent, surface: resolved, lastSeenAt: now },
    // Re-subscribe may move the endpoint to a different user (shared machine) —
    // re-own it and refresh the keys.
    update: { userId, p256dh, auth, userAgent, surface: resolved, lastSeenAt: now },
  });
}

/** Scoped to the owning user so one user can't unsubscribe another's endpoint. */
export async function deletePushSubscription(userId: string, endpoint: string): Promise<void> {
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
}
