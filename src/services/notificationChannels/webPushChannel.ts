/**
 * src/services/notificationChannels/webPushChannel.ts
 *
 * Browser / PWA Web Push delivery via the `web-push` library, signed with a
 * VAPID keypair passed in by the caller (the web_push NotificationChannel's
 * config). The service worker (public/sw.js) receives the push and calls
 * showNotification.
 *
 * A 404/410 from the push service means the subscription is dead — sendWebPush
 * throws an error carrying `gone: true` so the delivery job prunes the
 * PushSubscription row.
 */

import webpush from "web-push";
import { AppError } from "../../utils/errors.js";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string; // mailto: or https: contact, per the VAPID spec
}

export interface WebPushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface WebPushPayload {
  title: string;
  body: string;
  severity: string;
  url: string | null;
  notificationId: string;
  /**
   * One-click acknowledge URL for THIS recipient, or null/absent when they
   * can't acknowledge. sw.js renders the "Acknowledge" action button only when
   * it arrives, so an unentitled recipient simply gets the plain notification.
   */
  ackUrl?: string | null;
}

export interface WebPushError extends Error {
  gone?: boolean;
  statusCode?: number;
}

export async function sendWebPush(vapid: VapidConfig, target: WebPushTarget, payload: WebPushPayload): Promise<void> {
  if (!vapid.publicKey || !vapid.privateKey) {
    throw new AppError(400, "Web Push channel has no VAPID keypair (generate one)");
  }
  // subject must be a mailto:/https: URI per the VAPID spec; fall back so a
  // missing subject doesn't hard-fail every send.
  const subject = vapid.subject && /^(mailto:|https:)/.test(vapid.subject) ? vapid.subject : "mailto:polaris@localhost";
  webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
    );
  } catch (err: any) {
    const statusCode = err?.statusCode as number | undefined;
    const e: WebPushError = new Error(`Web push failed${statusCode ? ` (HTTP ${statusCode})` : ""}: ${err?.body || err?.message || "unknown"}`);
    e.statusCode = statusCode;
    e.gone = statusCode === 404 || statusCode === 410;
    throw e;
  }
}

/** Generate a fresh VAPID keypair (Delivery tab → Web Push channel). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
