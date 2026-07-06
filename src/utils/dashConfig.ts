/**
 * src/utils/dashConfig.ts — listener config for the Dash wallboard process
 * (POLARIS_ROLE=dash; also boots in-process under role "all" for dev).
 *
 * Mirrors the metricsServer env-var conventions. Port and bind are read
 * lazily on every call (no module-load snapshot) for the same reasons as
 * proxyMode.ts: per-test env flips and arbitrary boot order.
 */

import { isProxyMode } from "./proxyMode.js";

export const DEFAULT_DASH_PORT = 3001;

/** POLARIS_DASH_PORT, defaulting to 3001. Non-numeric/out-of-range → default. */
export function resolveDashPort(): number {
  const raw = (process.env.POLARIS_DASH_PORT || "").trim();
  if (!raw) return DEFAULT_DASH_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_DASH_PORT;
  return n;
}

/**
 * Bind address for the dash listener. In proxy mode (nginx fronting) the
 * listener is forced onto loopback — nginx is the only intended caller and
 * the RFC1918 gate depends on X-Forwarded-For from a trusted hop. Outside
 * proxy mode (dev / single-process direct), POLARIS_DASH_BIND wins, else
 * all interfaces so LAN wallboards can reach it directly; the app-level IP
 * gate is the real access control there.
 */
export function resolveDashBind(): string {
  if (isProxyMode()) return "127.0.0.1";
  const raw = (process.env.POLARIS_DASH_BIND || "").trim();
  return raw || "0.0.0.0";
}
