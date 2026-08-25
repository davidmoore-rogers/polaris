/**
 * src/utils/probeTarget.ts
 *
 * Validation for an operator-TYPED probe target — the "enter an IP or hostname"
 * half of the credential Test Connection flow, as opposed to picking an asset
 * and borrowing its address.
 *
 * Pure and separate from cidr.ts because this is not IP math: it accepts
 * hostnames too, and its job is deciding whether a hand-typed string is a
 * usable host for a probe socket. (The IP branch still defers to cidr.ts —
 * `isValidIpAddress` — because that IS IP math and the project rule is that it
 * lives in one place.)
 *
 * ── Why this REJECTS rather than salvages ────────────────────────────────────
 * Operators paste `https://10.1.2.3:8443/healthz` out of a browser bar, and the
 * tempting behaviour is to strip it down to `10.1.2.3`. That would be wrong
 * here, because the discarded parts are exactly the parts that are configured
 * ELSEWHERE and would silently disagree: the scheme and port come from the
 * `http` credential's own `useHttps`/`port` (or from the transport's default —
 * 161 for SNMP, 22 for SSH, 5985/5986 for WinRM), and the path comes from the
 * credential too. Quietly accepting a URL would show a test that dialed
 * something other than what the operator typed, and then attribute the result
 * to the credential. So a URL, an embedded port, or a path is refused with a
 * message naming which field already owns that value.
 *
 * IPv6 is the one place a colon is legal, so the port check has to be able to
 * tell `fe80::1` from `10.0.0.5:8443` — see `looksLikeIpv6`.
 */

import { isValidIpAddress } from "./cidr.js";

/** RFC 1123 hostname label: alphanumeric, inner hyphens, 1–63 chars. */
const LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * A bracketed literal, or something with 2+ colons — enough to distinguish an
 * IPv6 address from a `host:port` pair, which is the only decision this makes.
 * Whether it is a VALID address is then `isValidIpAddress`'s call.
 */
function looksLikeIpv6(value: string): boolean {
  if (value.startsWith("[")) return true;
  return (value.match(/:/g) || []).length >= 2;
}

/** True when every dot-separated label is a legal hostname label. */
export function isValidHostname(value: string): boolean {
  if (!value || value.length > 253) return false;
  // A single trailing dot is legal in DNS (the fully-qualified form) and
  // harmless to a resolver, so tolerate it rather than failing a paste.
  const bare = value.endsWith(".") ? value.slice(0, -1) : value;
  if (!bare) return false;
  return bare.split(".").every((label) => LABEL.test(label));
}

export interface ProbeTargetResult {
  /** The host to dial, when valid. */
  host?: string;
  /** Why it was refused, phrased for the operator, when not. */
  error?: string;
}

/**
 * Normalize and validate a hand-typed probe target. Returns either a host to
 * dial or an operator-facing reason — never throws, so the caller can render
 * the reason inline like a probe failure rather than as a 4xx.
 */
export function normalizeProbeTarget(raw: string | null | undefined): ProbeTargetResult {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { error: "Enter an IP address or hostname to test against" };

  if (/\s/.test(value)) {
    return { error: "A host cannot contain spaces" };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    return {
      error: "Enter just the host, not a URL — the scheme, port and path come from the credential itself",
    };
  }
  if (value.includes("/")) {
    return { error: "Enter just the host, without a path — the path is part of the credential" };
  }
  if (value.includes("@")) {
    return { error: "Enter just the host — credentials come from the form above, not the host field" };
  }
  if (value.includes("?") || value.includes("#")) {
    return { error: "Enter just the host, without a query string" };
  }

  // Strip IPv6 brackets before validating the address itself.
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;

  if (!looksLikeIpv6(value) && value.includes(":")) {
    return { error: "Enter just the host, without a port — the port comes from the credential" };
  }

  if (isValidIpAddress(unbracketed)) return { host: unbracketed };
  if (isValidHostname(value)) return { host: value };

  return { error: `"${value}" is not a valid IP address or hostname` };
}
