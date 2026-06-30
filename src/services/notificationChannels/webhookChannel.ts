/**
 * src/services/notificationChannels/webhookChannel.ts
 *
 * Outbound generic webhook delivery. `kind` shapes the POST body:
 *   - slack   → { text }
 *   - teams   → an Office 365 connector MessageCard
 *   - generic → the full notification JSON
 *
 * SSRF guard: the URL host is checked against netGuard's blocked-range list
 * (loopback / link-local / metadata) before any request. Throws on a non-2xx
 * response so the delivery job records `failed` + retries.
 */

import { AppError } from "../../utils/errors.js";
import { assertOutboundHostAllowed } from "../../utils/netGuard.js";

export type WebhookKind = "generic" | "slack" | "teams";

export interface WebhookPayload {
  title: string;
  message: string;
  severity: string; // info | warning | error
  assetHostname: string | null;
  url: string | null; // deep link to the notification, when POLARIS_PUBLIC_URL is set
  triggeredAt: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  // current notification severities
  notice: "6b7280", informational: "2563eb", warning: "d97706", serious: "ea580c", critical: "dc2626",
  // legacy audit-event levels (pre-migration rows / event payloads)
  info: "2563eb", error: "dc2626",
};

export function formatBody(kind: WebhookKind, p: WebhookPayload): unknown {
  if (kind === "slack") {
    const link = p.url ? ` <${p.url}|View>` : "";
    return { text: `*${p.title}*\n${p.message}${link}` };
  }
  if (kind === "teams") {
    return {
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      themeColor: SEVERITY_COLOR[p.severity] ?? "808080",
      summary: p.title,
      title: p.title,
      text: p.message,
      potentialAction: p.url
        ? [{ "@type": "OpenUri", name: "View in Polaris", targets: [{ os: "default", uri: p.url }] }]
        : undefined,
    };
  }
  // generic
  return {
    source: "polaris",
    title: p.title,
    message: p.message,
    severity: p.severity,
    asset: p.assetHostname,
    url: p.url,
    triggeredAt: p.triggeredAt,
  };
}

export async function sendWebhook(rawUrl: string, kind: WebhookKind, payload: WebhookPayload): Promise<void> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    throw new AppError(400, `Invalid webhook URL: ${rawUrl}`);
  }
  assertOutboundHostAllowed(host); // throws BLOCKED_HOST for internal/metadata ranges

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(rawUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formatBody(kind, payload)),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new AppError(502, `Webhook POST failed: HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
