/**
 * src/services/notificationDeliveryService.ts
 *
 * Drains pending NotificationDelivery rows and dispatches each to its channel
 * (email / webhook / web_push). Driven by the deliverNotifications job (~15s).
 * Modeled on eventArchiveService's outbound drain:
 *   - pull a bounded batch of pending rows (attempts < MAX_ATTEMPTS),
 *   - dispatch with bounded concurrency,
 *   - mark sent / failed (failed rows retry next tick until MAX_ATTEMPTS),
 *   - prune dead push subscriptions (HTTP 410/404),
 *   - write ONE summary audit Event per non-empty drain.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { sendEmail } from "./notificationChannels/emailChannel.js";
import { sendWebhook, type WebhookKind } from "./notificationChannels/webhookChannel.js";
import { sendWebPush, type WebPushError } from "./notificationChannels/webPushChannel.js";

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 200;
const CONCURRENCY = 8;

interface DeliveryRow {
  id: string;
  channel: string;
  target: string;
  meta: unknown;
  attempts: number;
  notification: {
    id: string;
    message: string;
    severity: string;
    assetHostname: string | null;
    triggeredAt: Date;
  };
}

function notificationUrl(): string | null {
  const base = process.env.POLARIS_PUBLIC_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/notifications.html`;
}

function titleFor(n: DeliveryRow["notification"]): string {
  const sev = n.severity.toUpperCase();
  return n.assetHostname ? `[${sev}] ${n.assetHostname}` : `[${sev}] Polaris notification`;
}

async function dispatch(d: DeliveryRow): Promise<{ ok: true } | { ok: false; error: string; gone?: boolean }> {
  const url = notificationUrl();
  const meta = (d.meta && typeof d.meta === "object" ? d.meta : {}) as Record<string, unknown>;
  try {
    if (d.channel === "email") {
      await sendEmail(
        { to: d.target, subject: titleFor(d.notification), text: d.notification.message + (url ? `\n\nView: ${url}` : "") },
        meta.via === "m365" ? "m365" : meta.via === "smtp" ? "smtp" : undefined,
      );
    } else if (d.channel === "webhook") {
      await sendWebhook(d.target, (meta.kind as WebhookKind) ?? "generic", {
        title: titleFor(d.notification),
        message: d.notification.message,
        severity: d.notification.severity,
        assetHostname: d.notification.assetHostname,
        url,
        triggeredAt: d.notification.triggeredAt.toISOString(),
      });
    } else if (d.channel === "web_push") {
      await sendWebPush(
        { endpoint: d.target, p256dh: String(meta.p256dh ?? ""), auth: String(meta.auth ?? "") },
        { title: titleFor(d.notification), body: d.notification.message, severity: d.notification.severity, url, notificationId: d.notification.id },
      );
    } else {
      return { ok: false, error: `unknown channel "${d.channel}"` };
    }
    return { ok: true };
  } catch (err) {
    const e = err as WebPushError;
    return { ok: false, error: e?.message ?? String(err), gone: e?.gone };
  }
}

/** One drain pass. Returns counts. */
export async function drainPendingDeliveries(): Promise<{ processed: number; sent: number; failed: number }> {
  const rows = (await prisma.notificationDelivery.findMany({
    where: { status: "pending", attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      channel: true,
      target: true,
      meta: true,
      attempts: true,
      notification: { select: { id: true, message: true, severity: true, assetHostname: true, triggeredAt: true } },
    },
  })) as DeliveryRow[];

  if (rows.length === 0) return { processed: 0, sent: 0, failed: 0 };

  const sentIds: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const deadEndpoints: string[] = [];
  const now = new Date();

  // Bounded-concurrency dispatch (network I/O); chunk to cap parallel sends.
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async (d) => ({ d, r: await dispatch(d) })));
    for (const { d, r } of results) {
      if (r.ok) sentIds.push(d.id);
      else {
        failed.push({ id: d.id, error: r.error.slice(0, 500) });
        if (r.gone && d.channel === "web_push") deadEndpoints.push(d.target);
      }
    }
  }

  // Persist outcomes. sent → updateMany; failed → per-row (distinct errors).
  const ops: Promise<unknown>[] = [];
  if (sentIds.length > 0) {
    ops.push(prisma.notificationDelivery.updateMany({ where: { id: { in: sentIds } }, data: { status: "sent", lastAttemptAt: now } }));
  }
  for (const f of failed) {
    // Increment attempts; flip to "failed" only once MAX_ATTEMPTS is reached so
    // it stops being retried, otherwise leave "pending" for the next tick.
    const row = rows.find((r) => r.id === f.id)!;
    const nextAttempts = row.attempts + 1;
    ops.push(
      prisma.notificationDelivery.update({
        where: { id: f.id },
        data: { attempts: { increment: 1 }, lastAttemptAt: now, error: f.error, status: nextAttempts >= MAX_ATTEMPTS ? "failed" : "pending" },
      }),
    );
  }
  if (deadEndpoints.length > 0) {
    ops.push(prisma.pushSubscription.deleteMany({ where: { endpoint: { in: deadEndpoints } } }));
  }
  await Promise.all(ops);

  if (failed.length > 0 || sentIds.length > 0) {
    await logEvent({
      action: "notification.delivered",
      resourceType: "notification",
      actor: "system:notification-delivery",
      level: failed.length > 0 ? "warning" : "info",
      message: `Notification delivery: ${sentIds.length} sent, ${failed.length} failed`,
      details: { sent: sentIds.length, failed: failed.length, prunedSubscriptions: deadEndpoints.length },
    }).catch(() => {});
  }

  logger.debug({ processed: rows.length, sent: sentIds.length, failed: failed.length }, "notification delivery drain");
  return { processed: rows.length, sent: sentIds.length, failed: failed.length };
}
