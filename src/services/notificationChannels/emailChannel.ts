/**
 * src/services/notificationChannels/emailChannel.ts
 *
 * Outbound email for notification delivery. Two transports:
 *   - SMTP via nodemailer (notificationSmtp config)
 *   - Microsoft 365 / Graph sendMail via OAuth client-credentials
 *     (notificationM365 config; needs the Mail.Send application permission)
 *
 * sendEmail() picks SMTP when enabled+configured, else M365. A per-delivery
 * `via` (in the delivery meta) can force one. Throws on failure so the
 * delivery job records `failed` + retries.
 */

import nodemailer from "nodemailer";
import { AppError } from "../../utils/errors.js";
import {
  getSmtpConfig,
  getM365Config,
  type SmtpConfig,
  type M365Config,
} from "../notificationConfigService.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

async function sendViaSmtp(cfg: SmtpConfig, msg: EmailMessage): Promise<void> {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === "ssl", // 465 implicit TLS; 587 upgrades via STARTTLS
    requireTLS: cfg.security === "starttls",
    auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
  });
  await transport.sendMail({
    from: cfg.from || cfg.username,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}

// Minimal Graph client-credentials token fetch (independent of entraIdService's
// EntraIdConfig so the notification M365 config stays self-contained).
async function m365Token(cfg: M365Config): Promise<string> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const p = JSON.parse(text);
        msg = String(p.error_description || p.error || msg).split(/\r?\n/)[0];
      } catch { /* ignore */ }
      throw new AppError(502, `Microsoft 365 token request failed: ${msg}`);
    }
    const parsed = JSON.parse(text) as { access_token?: string };
    if (!parsed.access_token) throw new AppError(502, "Microsoft 365 token response missing access_token");
    return parsed.access_token;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendViaM365(cfg: M365Config, msg: EmailMessage): Promise<void> {
  const token = await m365Token(cfg);
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.fromUserId)}/sendMail`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: msg.subject,
          body: { contentType: msg.html ? "HTML" : "Text", content: msg.html ?? msg.text },
          toRecipients: [{ emailAddress: { address: msg.to } }],
        },
        saveToSentItems: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = `HTTP ${res.status}`;
      try {
        const p = JSON.parse(text);
        if (p?.error?.message) detail = String(p.error.message).split(/\r?\n/)[0];
      } catch { /* ignore */ }
      throw new AppError(502, `Microsoft 365 sendMail failed: ${detail}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Send one email via whichever email transport is configured (or `via`). */
export async function sendEmail(msg: EmailMessage, via?: "smtp" | "m365"): Promise<void> {
  const [smtp, m365] = await Promise.all([getSmtpConfig(), getM365Config()]);
  const smtpReady = smtp.enabled && !!smtp.host;
  const m365Ready = m365.enabled && !!m365.tenantId && !!m365.clientId && !!m365.fromUserId;

  const choice = via ?? (smtpReady ? "smtp" : m365Ready ? "m365" : null);
  if (choice === "smtp") {
    if (!smtpReady) throw new AppError(400, "SMTP is not configured");
    return sendViaSmtp(smtp, msg);
  }
  if (choice === "m365") {
    if (!m365Ready) throw new AppError(400, "Microsoft 365 is not configured");
    return sendViaM365(m365, msg);
  }
  throw new AppError(400, "No email channel is configured (enable SMTP or Microsoft 365)");
}
