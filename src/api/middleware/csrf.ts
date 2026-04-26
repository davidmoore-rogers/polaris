/**
 * src/api/middleware/csrf.ts — Synchronizer-token CSRF protection
 *
 * Pattern: a random token is generated per session and stored in the session
 * store (HttpOnly). The same value is exposed in a readable cookie so
 * same-origin JavaScript in our own pages can echo it in an `X-CSRF-Token`
 * header on state-changing requests. A cross-origin attacker can forge a
 * POST to Polaris but has no way to read the token cookie (Same-Origin
 * Policy) and therefore can't put a valid value in the header.
 *
 * This is defense-in-depth on top of `SameSite=Lax` + strict JSON content
 * types, not a replacement for them.
 */

import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { AppError } from "../../utils/errors.js";

const COOKIE_NAME = "shelob_csrf";
const HEADER_NAME = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Paths that must bypass the token check. All other mutating requests
// (including /auth/logout, /auth/totp/*, /users/*, uploads, etc.) are
// protected.
const EXEMPT_PATH_PREFIXES = [
  "/api/v1/auth/login",        // pre-session; rate limiter is the defense
  "/api/v1/auth/azure/",       // SAML flow is cross-origin by design; signed assertion + RelayState are the CSRF guarantee
  "/api/setup/",               // first-run wizard runs on a separate server without sessions
];

export function csrfMiddleware(req: Request, res: Response, next: NextFunction) {
  // Always ensure the cookie reflects the current session's token — the
  // browser needs it to be set *before* the first mutating request. We
  // defer generation until there's actually a session to bind it to.
  if (req.session) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = randomBytes(32).toString("hex");
    }
    res.cookie(COOKIE_NAME, req.session.csrfToken, {
      httpOnly: false,       // frontend JS must read this
      sameSite: "lax",
      secure: req.secure,
      path: "/",
    });
  }

  if (SAFE_METHODS.has(req.method)) return next();
  if (EXEMPT_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();

  const fromHeader = req.get(HEADER_NAME);
  const fromSession = req.session?.csrfToken;
  if (!fromHeader || !fromSession || fromHeader !== fromSession) {
    return next(new AppError(403, "CSRF token missing or invalid"));
  }
  next();
}
