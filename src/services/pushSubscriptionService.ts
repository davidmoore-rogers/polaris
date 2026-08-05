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
}

export async function savePushSubscription(input: SavePushSubscriptionInput): Promise<void> {
  const { userId, endpoint, p256dh, auth, userAgent } = input;
  const now = new Date();
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh, auth, userAgent, lastSeenAt: now },
    // Re-subscribe may move the endpoint to a different user (shared machine) —
    // re-own it and refresh the keys.
    update: { userId, p256dh, auth, userAgent, lastSeenAt: now },
  });
}

/** Scoped to the owning user so one user can't unsubscribe another's endpoint. */
export async function deletePushSubscription(userId: string, endpoint: string): Promise<void> {
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
}
