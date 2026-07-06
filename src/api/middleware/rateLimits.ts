/**
 * src/api/middleware/rateLimits.ts — shared per-route rate limiters.
 *
 * The login limiter in app.ts predates this file and stays there. These
 * factories cover the remaining surfaces CodeQL flagged as missing rate
 * limiting (2026-06-11 alert sweep): unauthenticated setup-wizard routes,
 * auth-sensitive TOTP code submission, admin maintenance/backup routes, and
 * the agent-facing routers.
 *
 * Ceilings are deliberately generous for machine-facing endpoints — at 2000
 * monitored assets every agent and SIEM caller hits the web role from its own
 * source IP, so per-IP limits only need to bound a single misbehaving (or
 * hostile) client, not the fleet aggregate. express-rate-limit's default
 * in-memory store is per-process, which is fine: the web role is a single
 * replica (see L2 in docs/security/review-2026-06-03.md).
 */

import rateLimit from "express-rate-limit";

export function makeRateLimiter(opts: { windowMs: number; max: number; message: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: opts.message },
  });
}

/** Auth-code guessing surfaces (TOTP confirm/disable): mirror the login limiter. */
export const totpCodeLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many code attempts. Please try again in 15 minutes.",
});

/** Unauthenticated SSO entry redirect (OIDC login kick-off). */
export const ssoEntryLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many login attempts. Please try again in 15 minutes.",
});

/**
 * Entra App Proxy header login. ALL App Proxy users arrive from the shared
 * connector IP(s), so the strict per-IP login limiter (10/15min) would lock
 * out the whole external population behind one address. There is no
 * guessable-credential surface here — requests either carry trusted headers
 * or are refused — so a generous ceiling only needs to bound a runaway loop.
 */
export const entraProxyLoginLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: "Too many login attempts — retry shortly.",
});

/** Admin maintenance surfaces (backup/restore/logo) — human-driven, low cadence. */
export const maintenanceLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: "Too many maintenance requests — slow down and retry shortly.",
});

/** Machine-facing API surfaces (SIEM quarantine verify): generous burst headroom. */
export const machineApiLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 300,
  message: "Rate limit exceeded — retry shortly.",
});

/**
 * Polaris Agent bearer router. An agent posts samples/heartbeats every few
 * seconds at most; 4 req/s sustained per source IP is far above any healthy
 * agent and still bounds a runaway one.
 */
export const agentApiLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 1200,
  message: "Rate limit exceeded — retry shortly.",
});

/** Agent binary downloads — one per agent per upgrade; bounds scraping. */
export const agentBinaryLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: "Rate limit exceeded — retry shortly.",
});
