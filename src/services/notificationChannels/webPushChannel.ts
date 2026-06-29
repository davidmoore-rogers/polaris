/**
 * src/services/notificationChannels/webPushChannel.ts
 *
 * Browser / PWA Web Push delivery via the `web-push` library, signed with the
 * server VAPID keypair (notificationWebPush config). The service worker
 * (public/sw.js) receives the push and calls showNotification.
 *
 * A 404/410 from the push service means the subscription is dead — sendWebPush
 * throws an error carrying `gone: true` so the delivery job prunes the
 * PushSubscription row.
 */

import webpush from "web-push";
import { AppError } from "../../utils/errors.js";
import { getWebPushConfig } from "../notificationConfigService.js";

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
}

export interface WebPushError extends Error {
  gone?: boolean;
  statusCode?: number;
}

// Re-reads config each send (cheap; web_push deliveries are infrequent) so a
// key regeneration / enable-toggle takes effect immediately.
async function ensureVapid(): Promise<void> {
  const cfg = await getWebPushConfig();
  if (!cfg.enabled || !cfg.publicKey || !cfg.privateKey) {
    throw new AppError(400, "Web push is not configured (generate VAPID keys and enable it)");
  }
  // subject must be a mailto: or https: URI per the VAPID spec; fall back to a
  // placeholder mailto so a missing subject doesn't hard-fail every send.
  const subject = cfg.subject && /^(mailto:|https:)/.test(cfg.subject) ? cfg.subject : "mailto:polaris@localhost";
  webpush.setVapidDetails(subject, cfg.publicKey, cfg.privateKey);
}

export async function sendWebPush(target: WebPushTarget, payload: WebPushPayload): Promise<void> {
  await ensureVapid();
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

/** Generate a fresh VAPID keypair (Server Settings → Notifications → Web push). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
