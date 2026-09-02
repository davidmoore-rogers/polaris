/**
 * src/utils/ipScope.ts — the shared source-IP scope resolver.
 *
 * Three surfaces gate on the caller's source IP with the same vocabulary: the
 * Dash wallboard (`dashConfig`, an unauthenticated read-only surface), local
 * login access (`loginAccessConfig`, the /login.html form + the password
 * endpoints), and the API documentation page (`apiDocsConfig`, the
 * unauthenticated /api docs). They resolve identically —
 *
 *   "all"      → no gate.
 *   "custom"   → must match one of the operator's allow-list CIDRs.
 *   "rfc1918"  → private (RFC1918) or loopback only.
 *   "loopback" → loopback only (this host).
 *
 * — so the decision lives here rather than being written twice. A second copy
 * is exactly how one surface would quietly stop unwrapping ::ffff: v4-mapped
 * sources, or start treating an empty allow-list as "everyone".
 *
 * Not every surface offers every value: dash and login-access accept only
 * all/custom/rfc1918 at their route Zod layer, and the API docs accept only
 * loopback/rfc1918/custom (no "all" — it is a private-network-only surface).
 * Each surface narrows at its own edge; the resolver stays whole.
 *
 * IMPORTANT: every caller's `ip` must be Express's `req.ip`, which is only the
 * real client when `trust proxy` is set correctly for the deployment's hop
 * count (see src/utils/trustProxy.ts). Behind two proxies with a one-hop trust
 * setting, `req.ip` is the INNER proxy's address — which, being RFC1918, makes
 * a "rfc1918" scope allow the entire internet while looking enforced. Surfaces
 * that expose this to operators should show them the IP Polaris actually sees.
 */

import { isLoopbackIp, isPrivateOrLoopbackIp } from "./cidr.js";
import { ipMatchesAllowlist } from "./ipAllowlist.js";

export type IpScope = "rfc1918" | "all" | "custom" | "loopback";

export function isIpScope(v: unknown): v is IpScope {
  return v === "rfc1918" || v === "all" || v === "custom" || v === "loopback";
}

/**
 * Is this source IP inside the scope? `allowedCidrs` are consulted only for
 * the "custom" scope and are expected to be save-time-normalized (see
 * normalizeAllowlistCidr); ipMatchesAllowlist fails closed on an empty or
 * invalid list, so a misconfigured custom scope denies rather than admits.
 */
export function ipInScope(ip: string, scope: IpScope, allowedCidrs: string[]): boolean {
  if (scope === "all") return true;
  if (scope === "custom") return ipMatchesAllowlist(ip, allowedCidrs);
  if (scope === "loopback") return isLoopbackIp(ip);
  return isPrivateOrLoopbackIp(ip);
}

/** Operator-facing one-liner for audit Event messages. */
export function describeIpScope(scope: IpScope, allowedCidrs: string[]): string {
  if (scope === "all") return "ALL source IPs";
  if (scope === "custom") return `custom source IPs: ${allowedCidrs.join(", ") || "(none)"}`;
  if (scope === "loopback") return "loopback (this host) only";
  return "RFC1918 + loopback sources only";
}
