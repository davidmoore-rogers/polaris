/**
 * src/services/notificationDeliveryService.ts
 *
 * Drains pending NotificationDelivery rows and dispatches each through its
 * configured NotificationChannel (email SMTP/M365 / webhook slack-teams /
 * pushbullet / web_push) — or, for transport "api_call", straight from the
 * row's meta (channelId is NULL by design there; the request spec was
 * rendered at fire time by automationActionService). Driven by the
 * deliverNotifications job (~15s).
 *   - pull a bounded batch of pending rows (attempts < MAX_ATTEMPTS),
 *   - resolve each row's channel + config (secrets live on the channel),
 *   - dispatch with bounded concurrency,
 *   - mark sent / failed (failed rows retry until MAX_ATTEMPTS),
 *   - a NULL channel (deleted/disabled) → permanent fail, EXCEPT api_call
 *     rows whose NULL channel is legitimate (normal retry path),
 *   - prune dead push subscriptions (HTTP 410/404),
 *   - write ONE summary audit Event per non-empty drain.
 */

import { chunkArray } from "../utils/chunk.js";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { notificationsPageUrl, pushDeepLinkUrl, ackUrlForEmail } from "../utils/notificationTemplate.js";
import { ackUrlFromMeta } from "./notificationRecipientService.js";
import { buildAlertCharts, chartTokensIn, substituteChartTokens, attachmentsFor } from "./alertChartService.js";
import { pruneEmptyChartSection, pruneEmptyTextLines } from "../utils/alertEmailTemplate.js";
import { logEvent } from "./eventLogService.js";
import { type ChannelType } from "./notificationTypes.js";
import { sendSmtpEmail, sendM365Email, type EmailMessage } from "./notificationChannels/emailChannel.js";
import { sendWebhook } from "./notificationChannels/webhookChannel.js";
import { sendPushbullet } from "./notificationChannels/pushbulletChannel.js";
import { sendWebPush, type WebPushError } from "./notificationChannels/webPushChannel.js";
import { sendApiCall } from "./notificationChannels/apiCallChannel.js";

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
    assetId: string | null;
    assetHostname: string | null;
    /** The sub-asset dimension this alert is about — for a hardware-sensor
     *  automation, the sensor name whose last hour the email charts. */
    dimension: string | null;
    /** The metric that fired — puts its chart first in the body. */
    metric: string | null;
    triggeredAt: Date;
  };
}

function titleFor(n: DeliveryRow["notification"]): string {
  const sev = n.severity.toUpperCase();
  return n.assetHostname ? `[${sev}] ${n.assetHostname}` : `[${sev}] Polaris notification`;
}

function cfgStr(config: Record<string, unknown>, key: string): string {
  const v = config[key];
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/**
 * Build the EmailMessage for an email-transport delivery row. Composed rows
 * (meta.composed — rule emailComposition / escalation tiers) carry the full
 * pre-rendered snapshot; legacy rows (including pre-upgrade pending rows) get
 * the byte-identical default subject/body.
 */
async function emailMessageFor(d: DeliveryRow, meta: Record<string, unknown>, url: string | null): Promise<EmailMessage | { error: string }> {
  if (meta.composed === true) {
    const to = asStringArray(meta.to);
    if (to.length === 0) return { error: "composed email delivery has no To recipients" };
    let text = typeof meta.text === "string" ? meta.text : d.notification.message;
    let html = typeof meta.html === "string" && meta.html ? meta.html : undefined;

    // Charts are built HERE, not at fire time: the drain is a queue off the
    // engine's hot path, and an escalation email at T+90min then shows the
    // last hour as of sending rather than re-rendering a frozen snapshot.
    let attachments: EmailMessage["attachments"];
    const wanted = chartTokensIn(text, html);
    if (wanted.size > 0) {
      const charts = d.notification.assetId
        ? await buildAlertCharts(d.notification.assetId, wanted, { sensorName: d.notification.dimension, metric: d.notification.metric })
        : new Map();
      // Charts render away individually (no samples) and collectively (an alert
      // about Polaris itself has no asset to chart), so both bodies get a tidy
      // pass afterwards: the HTML drops the "Last hour" heading left standing
      // over nothing, the text collapses the blank lines the removed tokens
      // left behind.
      text = pruneEmptyTextLines(substituteChartTokens(text, charts, { html: false }));
      if (html) {
        html = pruneEmptyChartSection(substituteChartTokens(html, charts, { html: true }));
        attachments = attachmentsFor(charts, html);
      }
    }

    return {
      to,
      cc: asStringArray(meta.cc),
      bcc: asStringArray(meta.bcc),
      subject: typeof meta.subject === "string" && meta.subject ? meta.subject : titleFor(d.notification),
      text,
      html,
      ...(attachments?.length ? { attachments } : {}),
    };
  }
  return {
    to: d.target,
    subject: titleFor(d.notification),
    text: appendAckLine(d.notification.message + (url ? `\n\nView: ${url}` : ""), ackUrlFromEmailMeta(meta)),
  };
}

/**
 * The acknowledge URL for an email row, or null when this recipient didn't
 * earn one (an address-book contact, a typed address, or an install with no
 * POLARIS_PUBLIC_URL — see notificationRecipientService.buildAddressOwnerMap).
 */
export function ackUrlFromEmailMeta(meta: Record<string, unknown>): string | null {
  const ack = meta.ack && typeof meta.ack === "object" ? (meta.ack as Record<string, unknown>) : null;
  return typeof ack?.token === "string" ? ackUrlForEmail(ack.token) : null;
}

/** Append the one-click acknowledge line to a plain-text body. Pure. */
export function appendAckLine(text: string, ackUrl: string | null): string {
  if (!ackUrl) return text;
  return `${text}\n\nAcknowledge this alert: ${ackUrl}`;
}

async function dispatch(d: DeliveryRow, channel: ChannelInfo | undefined): Promise<{ ok: true } | { ok: false; error: string; gone?: boolean }> {
  // api_call rows carry NO channel by design (channelId NULL — the whole
  // request spec lives in meta, rendered at fire time). Dispatch before the
  // channel checks so the null channel isn't treated as deleted.
  if (d.transport === "api_call") {
    const m = (d.meta && typeof d.meta === "object" ? d.meta : {}) as Record<string, unknown>;
    try {
      await sendApiCall({
        method: typeof m.method === "string" ? m.method : "POST",
        url: typeof m.url === "string" && m.url ? m.url : d.target,
        headers: m.headers && typeof m.headers === "object" ? (m.headers as Record<string, string>) : undefined,
        body: typeof m.body === "string" ? m.body : undefined,
        timeoutSec: typeof m.timeoutSec === "number" ? m.timeoutSec : undefined,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  }
  if (!channel) return { ok: false, error: "delivery channel was deleted" };
  if (!channel.enabled) return { ok: false, error: "delivery channel is disabled" };
  const url = notificationsPageUrl();
  const cfg = channel.config || {};
  const meta = (d.meta && typeof d.meta === "object" ? d.meta : {}) as Record<string, unknown>;
  const type = channel.type as ChannelType;
  try {
    if (type === "smtp" || type === "oauth_m365") {
      const msg = await emailMessageFor(d, meta, url);
      if ("error" in msg) return { ok: false, error: msg.error };
      if (type === "smtp") {
        await sendSmtpEmail(
          { host: cfgStr(cfg, "host"), port: Number(cfg.port) || 587, security: (cfgStr(cfg, "security") as any) || "starttls", username: cfgStr(cfg, "username"), password: cfgStr(cfg, "password"), from: cfgStr(cfg, "from") },
          msg,
        );
      } else {
        await sendM365Email(
          { tenantId: cfgStr(cfg, "tenantId"), clientId: cfgStr(cfg, "clientId"), clientSecret: cfgStr(cfg, "clientSecret"), fromUserId: cfgStr(cfg, "fromUserId") },
          msg,
        );
      }
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
      // Web push gets its OWN url, not the shared `url` the email/chat
      // transports use: the deep link depends on which surface enrolled the
      // subscription (snapshotted into meta at fan-out). It also never comes
      // back null — pushDeepLinkUrl falls back to a relative path when
      // POLARIS_PUBLIC_URL is unset, which the service worker resolves.
      await sendWebPush(
        { publicKey: cfgStr(cfg, "publicKey"), privateKey: cfgStr(cfg, "privateKey"), subject: cfgStr(cfg, "subject") },
        { endpoint: d.target, p256dh: String(meta.p256dh ?? ""), auth: String(meta.auth ?? "") },
        {
          title: titleFor(d.notification),
          body: d.notification.message,
          severity: d.notification.severity,
          url: pushDeepLinkUrl(meta.surface),
          notificationId: d.notification.id,
          // Present only for a recipient who may acknowledge; sw.js renders
          // the Acknowledge action button iff it arrives.
          ackUrl: ackUrlFromMeta(meta),
        },
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
/**
 * @param opts.notificationId Drain only ONE alert's rows. The wizard's test
 * buttons use this to dispatch immediately instead of waiting up to 15s for
 * the tick — extending the drain rather than cloning it, because this function
 * owns retries, permanent-fail classification, dead-push pruning and the
 * summary Event. The job itself calls it with no arguments, unchanged.
 */
export async function drainPendingDeliveries(
  opts: { notificationId?: string } = {},
): Promise<{ processed: number; sent: number; failed: number }> {
  const rows = (await prisma.notificationDelivery.findMany({
    where: {
      status: "pending",
      attempts: { lt: MAX_ATTEMPTS },
      ...(opts.notificationId ? { notificationId: opts.notificationId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      channelId: true,
      transport: true,
      target: true,
      meta: true,
      attempts: true,
      // assetId is what the last-hour charts query against — the hostname is a
      // fire-time snapshot and can't be joined back to sample rows.
      notification: { select: { id: true, message: true, severity: true, assetId: true, assetHostname: true, dimension: true, metric: true, triggeredAt: true } },
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

  for (const chunk of chunkArray(rows, CONCURRENCY)) {
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
    // A missing channel is permanent — fail immediately rather than burn
    // retries. api_call rows legitimately carry NO channel (spec in meta), so
    // their failures always take the normal retry path.
    const permanent = row.transport !== "api_call" && (!row.channelId || !channels.get(row.channelId));
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
