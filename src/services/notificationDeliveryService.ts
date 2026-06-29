/**
 * src/services/notificationDeliveryService.ts
 *
 * Drains pending NotificationDelivery rows and dispatches each through its
 * configured NotificationChannel (email SMTP/M365 / webhook slack-teams /
 * pushbullet / web_push). Driven by the deliverNotifications job (~15s).
 *   - pull a bounded batch of pending rows (attempts < MAX_ATTEMPTS),
 *   - resolve each row's channel + config (secrets live on the channel),
 *   - dispatch with bounded concurrency,
 *   - mark sent / failed (failed rows retry until MAX_ATTEMPTS),
 *   - a NULL channel (deleted/disabled) → permanent fail,
 *   - prune dead push subscriptions (HTTP 410/404),
 *   - write ONE summary audit Event per non-empty drain.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { type ChannelType } from "./notificationTypes.js";
import { sendSmtpEmail, sendM365Email } from "./notificationChannels/emailChannel.js";
import { sendWebhook } from "./notificationChannels/webhookChannel.js";
import { sendPushbullet } from "./notificationChannels/pushbulletChannel.js";
import { sendWebPush, type WebPushError } from "./notificationChannels/webPushChannel.js";

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 200;
const CONCURRENCY = 8;

interface ChannelInfo {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

interface DeliveryRow {
  id: string;
  channelId: string | null;
  transport: string;
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

function cfgStr(config: Record<string, unknown>, key: string): string {
  const v = config[key];
  return typeof v === "string" ? v : "";
}

async function dispatch(d: DeliveryRow, channel: ChannelInfo | undefined): Promise<{ ok: true } | { ok: false; error: string; gone?: boolean }> {
  if (!channel) return { ok: false, error: "delivery channel was deleted" };
  if (!channel.enabled) return { ok: false, error: "delivery channel is disabled" };
  const url = notificationUrl();
  const cfg = channel.config || {};
  const meta = (d.meta && typeof d.meta === "object" ? d.meta : {}) as Record<string, unknown>;
  const type = channel.type as ChannelType;
  try {
    if (type === "smtp") {
      await sendSmtpEmail(
        { host: cfgStr(cfg, "host"), port: Number(cfg.port) || 587, security: (cfgStr(cfg, "security") as any) || "starttls", username: cfgStr(cfg, "username"), password: cfgStr(cfg, "password"), from: cfgStr(cfg, "from") },
        { to: d.target, subject: titleFor(d.notification), text: d.notification.message + (url ? `\n\nView: ${url}` : "") },
      );
    } else if (type === "oauth_m365") {
      await sendM365Email(
        { tenantId: cfgStr(cfg, "tenantId"), clientId: cfgStr(cfg, "clientId"), clientSecret: cfgStr(cfg, "clientSecret"), fromUserId: cfgStr(cfg, "fromUserId") },
        { to: d.target, subject: titleFor(d.notification), text: d.notification.message + (url ? `\n\nView: ${url}` : "") },
      );
    } else if (type === "slack" || type === "teams") {
      const webhookUrl = cfgStr(cfg, "webhookUrl");
      if (!webhookUrl) return { ok: false, error: `${type} channel has no webhook URL` };
      await sendWebhook(webhookUrl, type, {
        title: titleFor(d.notification),
        message: d.notification.message,
        severity: d.notification.severity,
        assetHostname: d.notification.assetHostname,
        url,
        triggeredAt: d.notification.triggeredAt.toISOString(),
      });
    } else if (type === "pushbullet") {
      await sendPushbullet({ accessToken: cfgStr(cfg, "accessToken") }, { title: titleFor(d.notification), body: d.notification.message });
    } else if (type === "web_push") {
      await sendWebPush(
        { publicKey: cfgStr(cfg, "publicKey"), privateKey: cfgStr(cfg, "privateKey"), subject: cfgStr(cfg, "subject") },
        { endpoint: d.target, p256dh: String(meta.p256dh ?? ""), auth: String(meta.auth ?? "") },
        { title: titleFor(d.notification), body: d.notification.message, severity: d.notification.severity, url, notificationId: d.notification.id },
      );
    } else {
      return { ok: false, error: `unknown channel type "${channel.type}"` };
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
      channelId: true,
      transport: true,
      target: true,
      meta: true,
      attempts: true,
      notification: { select: { id: true, message: true, severity: true, assetHostname: true, triggeredAt: true } },
    },
  })) as DeliveryRow[];

  if (rows.length === 0) return { processed: 0, sent: 0, failed: 0 };

  // Resolve the referenced channels once (config carries the secrets).
  const channelIds = Array.from(new Set(rows.map((r) => r.channelId).filter((x): x is string => !!x)));
  const channelList = channelIds.length
    ? await prisma.notificationChannel.findMany({ where: { id: { in: channelIds } }, select: { id: true, type: true, enabled: true, config: true } })
    : [];
  const channels = new Map<string, ChannelInfo>(
    channelList.map((c) => [c.id, { id: c.id, type: c.type, enabled: c.enabled, config: (c.config && typeof c.config === "object" ? c.config : {}) as Record<string, unknown> }]),
  );

  const sentIds: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const deadEndpoints: string[] = [];
  const now = new Date();

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async (d) => ({ d, r: await dispatch(d, d.channelId ? channels.get(d.channelId) : undefined) })));
    for (const { d, r } of results) {
      if (r.ok) sentIds.push(d.id);
      else {
        failed.push({ id: d.id, error: r.error.slice(0, 500) });
        if (r.gone && d.transport === "web_push") deadEndpoints.push(d.target);
      }
    }
  }

  const ops: Promise<unknown>[] = [];
  if (sentIds.length > 0) {
    ops.push(prisma.notificationDelivery.updateMany({ where: { id: { in: sentIds } }, data: { status: "sent", lastAttemptAt: now } }));
  }
  for (const f of failed) {
    const row = rows.find((r) => r.id === f.id)!;
    // A missing channel is permanent — fail immediately rather than burn retries.
    const permanent = !row.channelId || !channels.get(row.channelId);
    const nextAttempts = row.attempts + 1;
    ops.push(
      prisma.notificationDelivery.update({
        where: { id: f.id },
        data: { attempts: { increment: 1 }, lastAttemptAt: now, error: f.error, status: permanent || nextAttempts >= MAX_ATTEMPTS ? "failed" : "pending" },
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
