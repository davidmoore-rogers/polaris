/**
 * src/utils/loginRedirect.ts — "send me back where I was going" across a login.
 *
 * An emailed Acknowledge button points at /alert-ack.html?id=… (business rule
 * 25). A reader who isn't signed in gets bounced to the login page, and without
 * this they would sign in and land on the dashboard, with nothing left of the
 * alert they were asked to look at.
 *
 * WHY A COOKIE and not a `?next=` query parameter threaded through every
 * provider: there are five ways into Polaris (local, TOTP second step, SAML,
 * OIDC, Entra App Proxy) and three of them bounce through an identity provider
 * that hands the browser back on a URL Polaris does not control. Worse, the
 * SSO callbacks call `req.session.regenerate()` — a session-stashed target does
 * not survive that, which is the whole point of regenerating. A short-lived
 * cookie survives every one of those hops and needs no per-provider plumbing.
 *
 * It is NOT HttpOnly, because the local-login path reads it from login.js
 * after the fetch succeeds. That is safe by construction: `safeNextPath`
 * reduces whatever is in it to a same-origin PATH, so the worst a forged value
 * can do is land the operator on a different page of their own Polaris. It is
 * never a credential and never carries one.
 */

import type { Request, Response } from "express";
import { safeNextPath } from "./safeRedirect.js";

export const LOGIN_NEXT_COOKIE = "polaris_next";

/**
 * Ten minutes. Long enough for an SSO round trip with a password prompt and an
 * MFA push, short enough that a target abandoned mid-login doesn't ambush the
 * operator's NEXT login hours later with a page they no longer expect.
 */
const MAX_AGE_MS = 10 * 60 * 1000;

/** Remember where an unauthenticated request was headed, before bouncing it. */
export function rememberLoginTarget(req: Request, res: Response, target: string): void {
  const path = safeNextPath(target);
  // "/" is where login lands anyway — writing a cookie to say so is pure noise
  // and would keep overwriting a real target set moments earlier.
  if (path === "/") return;
  res.cookie(LOGIN_NEXT_COOKIE, path, {
    httpOnly: false, // login.js reads it — see the header note
    sameSite: "lax",
    secure: req.secure,
    path: "/",
    maxAge: MAX_AGE_MS,
  });
}

/**
 * Pull one cookie out of a raw Cookie header. Polaris runs no cookie-parser —
 * express-session reads its own — so this does the one lookup it needs rather
 * than adding a dependency and a middleware for a single value. Exported for
 * the tests; the header is attacker-controlled, so the result still goes
 * through safeNextPath.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed percent-escape is not a path we should be redirecting to.
      return null;
    }
  }
  return null;
}

/**
 * Read and CONSUME the remembered target. Always returns something safe to
 * redirect to, falling back to "/". Clearing is unconditional: a target that
 * failed to be honored must not be honored on the next login instead.
 */
export function takeLoginTarget(req: Request, res: Response): string {
  const raw = readCookie(req.get("cookie") ?? undefined, LOGIN_NEXT_COOKIE);
  res.clearCookie(LOGIN_NEXT_COOKIE, { path: "/" });
  return safeNextPath(raw ?? undefined);
}
