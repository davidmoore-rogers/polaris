/**
 * src/api/routes/ack.ts — the public one-click acknowledge page.
 *
 * Reached from the Acknowledge link in an alert email and from the
 * Acknowledge action button on a web push. The token in the URL is the entire
 * credential: it is single-use, expires, and grants exactly "acknowledge this
 * one alert as this one user" (see services/notificationAckService.ts).
 *
 * Four invariants this file must keep:
 *
 *  1. GET IS INERT. Outlook Safe Links, Proofpoint and every other mail
 *     gateway fetches links before a human sees them, so a GET that
 *     acknowledged would auto-acknowledge on scan. The GET renders; only the
 *     POST redeems.
 *  2. NO INLINE <script>. The CSP (utils/securityHeaders.ts) bans inline
 *     script but allows inline style and form-action 'self', so the confirm
 *     control is a plain self-posting form — which also means the page works
 *     with scripting disabled, as some mail-client browsers do.
 *  3. NEVER call next(err). The shared errorHandler always answers JSON; this
 *     surface owns HTML for every outcome including failure.
 *  4. Mounted ABOVE session/CSRF in app.ts. Not just for the missing cookie:
 *     csrfMiddleware writes req.session.csrfToken on any request carrying a
 *     session, which dirties an uninitialized session and makes
 *     connect-pg-simple persist a row — so mounted below it, every scanner
 *     GET of an ack link would mint a session row without bound.
 */

import { Router } from "express";
import { z } from "zod";
import { inspectAckToken, redeemAckToken, type AckOutcome } from "../../services/notificationAckService.js";
import { getBranding } from "../../services/brandingService.js";
import { escapeHtml } from "../../utils/notificationTemplate.js";
import { severityCss } from "../../utils/severityStyle.js";
import { logger } from "../../utils/logger.js";

export const ackRouter = Router();

const noteSchema = z.object({ note: z.string().max(2000).optional() });

/** Where "open in Polaris" should land, when a public URL is configured. */
function appLink(alert: AckOutcome["alert"]): string | null {
  const base = process.env.POLARIS_PUBLIC_URL;
  if (!base) return null;
  const root = base.replace(/\/$/, "");
  return alert?.assetId
    ? `${root}/assets.html#view=asset:${encodeURIComponent(alert.assetId)}`
    : `${root}/automations.html`;
}

function fmtTime(d: Date | null | undefined): string {
  if (!d) return "";
  // Server-local wall clock, spelled out — the reader may be anywhere and has
  // no page script to localize it.
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

interface PageParts {
  title: string;
  /** Optional lead line under the title. */
  lead?: string;
  /** The alert card, when there is one to show. */
  alert?: AckOutcome["alert"];
  /** Rendered inside the card, after the facts. */
  action?: string;
  tone: "ok" | "info" | "warn";
}

function renderPage(appName: string, p: PageParts): string {
  const a = p.alert;
  const accent = a ? severityCss(a.severity) : p.tone === "ok" ? "#16a34a" : "#6b7280";
  const link = appLink(a);
  const facts = a
    ? [
        a.assetHostname ? ["Device", a.assetHostname] : null,
        ["Severity", a.severity],
        ["Raised", fmtTime(a.triggeredAt)],
        a.acknowledgedBy ? ["Acknowledged by", `${a.acknowledgedBy}${a.acknowledgedAt ? ` · ${fmtTime(a.acknowledgedAt)}` : ""}`] : null,
      ].filter(Boolean) as string[][]
    : [];

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(p.title)} · ${escapeHtml(appName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:24px 16px; background:#f5f6f8; color:#1f2430;
         font:15px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width:520px; margin:0 auto; }
  .brand { font-size:13px; letter-spacing:.08em; text-transform:uppercase; color:#6b7280; margin:0 0 10px; }
  .card { background:#fff; border:1px solid #e5e7eb; border-top:4px solid ${accent};
          border-radius:10px; padding:20px; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  h1 { font-size:19px; margin:0 0 6px; }
  .lead { color:#4b5563; margin:0 0 14px; }
  .msg { font-size:15px; margin:0 0 14px; }
  table.facts { border-collapse:collapse; width:100%; margin:0 0 16px; font-size:14px; }
  table.facts th { text-align:left; color:#6b7280; font-weight:500; padding:4px 12px 4px 0; white-space:nowrap; vertical-align:top; }
  table.facts td { padding:4px 0; }
  .test { display:inline-block; font-size:12px; font-weight:600; color:#3730a3;
          background:#eef2ff; border-radius:4px; padding:2px 7px; margin:0 0 10px; }
  label { display:block; font-size:13px; color:#4b5563; margin:0 0 4px; }
  textarea { width:100%; box-sizing:border-box; font:inherit; font-size:14px; padding:8px;
             border:1px solid #d1d5db; border-radius:6px; resize:vertical; }
  button { margin-top:12px; background:${accent}; color:#fff; border:0; border-radius:6px;
           padding:11px 18px; font:inherit; font-weight:600; cursor:pointer; }
  .after { margin:16px 0 0; font-size:14px; }
  a { color:#2563eb; }
  .foot { color:#9ca3af; font-size:12px; margin:18px 0 0; text-align:center; }
  @media (prefers-color-scheme: dark) {
    body { background:#14161a; color:#e5e7eb; }
    .card { background:#1c1f26; border-color:#2b3039; }
    .lead, table.facts th { color:#9ca3af; }
    textarea { background:#14161a; color:#e5e7eb; border-color:#3a4150; }
    .test { background:#312e81; color:#e0e7ff; }
  }
</style>
</head><body><div class="wrap">
<p class="brand">${escapeHtml(appName)}</p>
<div class="card">
  ${a?.testRun ? '<span class="test">TEST ALERT</span>' : ""}
  <h1>${escapeHtml(p.title)}</h1>
  ${p.lead ? `<p class="lead">${escapeHtml(p.lead)}</p>` : ""}
  ${a ? `<p class="msg">${escapeHtml(a.message)}</p>` : ""}
  ${facts.length ? `<table class="facts">${facts
    .map((f) => `<tr><th>${escapeHtml(f[0]!)}</th><td>${escapeHtml(f[1]!)}</td></tr>`)
    .join("")}</table>` : ""}
  ${p.action ?? ""}
  ${link ? `<p class="after"><a href="${escapeHtml(link)}">Open in ${escapeHtml(appName)}</a></p>` : ""}
</div>
<p class="foot">This link works once and only for the alert above.</p>
</div></body></html>`;
}

/** Confirm form — the only state-changing control, and it POSTs. */
function confirmForm(token: string, username: string): string {
  return `<form method="post" action="/ack/${encodeURIComponent(token)}">
  <input type="hidden" name="confirm" value="1">
  <label for="note">Add a note (optional)</label>
  <textarea id="note" name="note" rows="2" maxlength="2000" placeholder="e.g. investigating — switch stack rebooting"></textarea>
  <button type="submit">Acknowledge as ${escapeHtml(username)}</button>
</form>`;
}

function pageFor(outcome: AckOutcome, appName: string, token: string, justAcked: boolean): PageParts {
  const a = outcome.alert;
  switch (outcome.kind) {
    case "valid":
      return justAcked
        ? { title: "Acknowledged", lead: `Recorded as ${outcome.username}. The alert stays visible in Polaris until it clears.`, alert: a, tone: "ok" }
        : { title: "Acknowledge this alert?", alert: a, action: confirmForm(token, outcome.username ?? "you"), tone: "info" };
    case "already":
      return {
        title: "Already acknowledged",
        lead: a?.acknowledgedBy ? `${a.acknowledgedBy} got here first — nothing more to do.` : "Someone already acknowledged this one.",
        alert: a, tone: "ok",
      };
    case "used":
      return { title: "This link has already been used", lead: "Each acknowledge link works once. Open Polaris if you need to change anything.", alert: a, tone: "info" };
    case "expired":
      return { title: "This link has expired", lead: "Acknowledge links stop working after 30 days. Open Polaris to acknowledge it there.", alert: a, tone: "info" };
    case "cleared":
      return { title: "This alert already cleared", lead: "It resolved on its own or someone cleared it, so there is nothing to acknowledge.", alert: a, tone: "ok" };
    case "forbidden":
      return { title: "Your account can't acknowledge alerts", lead: "Your Polaris role no longer includes acknowledging alerts. Ask an administrator if that's unexpected.", alert: a, tone: "warn" };
    default:
      // Deliberately vague: an unknown token is the one case a stranger can
      // reach, and it should learn nothing about whether alerts exist.
      return { title: "This link is no longer valid", lead: "It may have expired, been used already, or belong to an alert that no longer exists.", tone: "info" };
  }
}

function statusFor(kind: AckOutcome["kind"]): number {
  if (kind === "unknown") return 404;
  if (kind === "forbidden") return 403;
  if (kind === "expired" || kind === "used") return 410;
  return 200;
}

function send(res: import("express").Response, status: number, html: string): void {
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      // The token is in the path; keep it out of any onward Referer.
      "Referrer-Policy": "no-referrer",
    })
    .send(html);
}

async function appName(): Promise<string> {
  try {
    return (await getBranding()).appName;
  } catch {
    return "Polaris";
  }
}

ackRouter.get("/:token", async (req, res) => {
  const name = await appName();
  try {
    const token = String(req.params.token ?? "");
    const outcome = await inspectAckToken(token);
    send(res, statusFor(outcome.kind), renderPage(name, pageFor(outcome, name, token, false)));
  } catch (err) {
    logger.error({ err }, "ack link inspect failed");
    send(res, 500, renderPage(name, { title: "Something went wrong", lead: "Polaris couldn't read this link just now. Try again in a moment.", tone: "warn" }));
  }
});

ackRouter.post("/:token", async (req, res) => {
  const name = await appName();
  const wantsJson = String(req.get("accept") ?? "").includes("application/json");
  try {
    const token = String(req.params.token ?? "");
    const { note } = noteSchema.parse(req.body ?? {});
    const outcome = await redeemAckToken(token, note);
    const acked = outcome.kind === "valid" || outcome.kind === "already";
    if (wantsJson) {
      // The service worker's Acknowledge button posts this way.
      res.status(statusFor(outcome.kind)).set("Cache-Control", "no-store").json({
        ok: acked,
        state: outcome.kind,
        acknowledgedBy: outcome.alert?.acknowledgedBy ?? null,
      });
      return;
    }
    send(res, statusFor(outcome.kind), renderPage(name, pageFor(outcome, name, token, true)));
  } catch (err) {
    logger.error({ err }, "ack link redeem failed");
    if (wantsJson) {
      res.status(500).json({ ok: false, state: "error" });
      return;
    }
    send(res, 500, renderPage(name, { title: "Something went wrong", lead: "Polaris couldn't record that just now. Try again in a moment.", tone: "warn" }));
  }
});

export default ackRouter;
