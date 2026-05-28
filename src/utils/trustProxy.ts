/**
 * src/utils/trustProxy.ts — centralized resolution of the Express
 * `trust proxy` setting.
 *
 * Express's `req.ip` (used by the login rate limiter) and `req.secure` (used
 * by the session + CSRF cookie Secure flag) only honor `X-Forwarded-*`
 * headers when `app.set("trust proxy", ...)` is configured. With Polaris
 * fronted by nginx, that's exactly what we need — but we must NOT silently
 * mutate `process.env.TRUST_PROXY`. Operators may set subnet-scoped trust
 * (e.g. `TRUST_PROXY=10.0.0.0/8`) and we have to respect their override.
 *
 * Resolution precedence:
 *   1. `TRUST_PROXY` env var (operator-set) — wins always.
 *   2. Proxy mode auto-default: `"1"` (trust the first proxy hop only).
 *   3. Otherwise: undefined (no setting — Express defaults to off, which is
 *      the right behavior for direct-to-internet single-process deployments
 *      where any X-Forwarded-For is attacker-supplied and must be ignored).
 *
 * Return type matches `app.set("trust proxy", value)` — see
 * https://expressjs.com/en/guide/behind-proxies.html for the full set.
 */

import { isProxyMode } from "./proxyMode.js";

export function resolveTrustProxy(): string | number | undefined {
  if (process.env.TRUST_PROXY) return process.env.TRUST_PROXY;
  if (isProxyMode()) return "1";
  return undefined;
}
