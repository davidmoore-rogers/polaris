/**
 * src/services/entraProxyAuthService.ts — Entra Application Proxy header SSO
 *
 * Login provider for installs published through Microsoft Entra Application
 * Proxy with Entra ID pre-authentication + header-based SSO: Entra maps claims
 * (UPN, object ID, group object-ID GUIDs) into operator-named HTTP headers that
 * the on-prem connector forwards to Polaris.
 *
 * SECURITY MODEL — the headers are UNSIGNED. There is no token to validate;
 * Microsoft's documented protection is purely network-level ("restrict access
 * to traffic from the connector"). Polaris therefore only honors the identity
 * headers when the request's source address (`req.ip`, trust-proxy resolved —
 * behind nginx that is the address nginx saw) matches the operator-configured
 * connector allowlist. Everything fails closed: no allowlist → no header auth,
 * untrusted source → headers ignored (and stripped by the middleware in
 * src/api/middleware/entraProxyHeaders.ts as defense in depth).
 *
 * Settings live in the `entraProxy` Setting row. No secrets — nothing to mask.
 *
 * External identity keys on `azureOid` (the Entra directory object ID), shared
 * with the Azure SAML provider on purpose — see the convergence note in
 * ssoProvisioning.ts.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { ipMatchesAllowlist, isValidAllowlistEntry } from "../utils/ipAllowlist.js";
import { provisionExternalUser } from "./ssoProvisioning.js";

export interface EntraProxySettings {
  enabled: boolean;
  /** Connector host IPs/CIDRs as seen by Polaris (`req.ip`). EMPTY = header auth refused. */
  trustedSourceIps: string[];
  /** Header carrying the Entra user object ID (GUID). Required. */
  objectIdHeader: string;
  /** Header carrying the UPN / username. Required. */
  usernameHeader: string;
  /** Optional headers ("" = unused). */
  emailHeader: string;
  displayNameHeader: string;
  /** Comma/semicolon-separated Entra group object-ID GUIDs. Optional. */
  groupsHeader: string;
}

const ENTRA_PROXY_DEFAULTS: EntraProxySettings = {
  enabled: false,
  trustedSourceIps: [],
  objectIdHeader: "x-entra-object-id",
  usernameHeader: "x-entra-upn",
  emailHeader: "x-entra-email",
  displayNameHeader: "x-entra-display-name",
  groupsHeader: "x-entra-groups",
};

// Node lowercases incoming header names; enforce the same on config so lookups
// and the strip middleware can never miss on case.
const HEADER_NAME_RE = /^[a-z0-9-]{1,64}$/;

// Headers the strip middleware must never be configurable to delete —
// infrastructure headers whose removal would break routing, auth, or the
// trust-proxy IP resolution this feature's own gate depends on.
const HEADER_NAME_DENYLIST = new Set([
  "host",
  "authorization",
  "cookie",
  "content-length",
  "content-type",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "upgrade",
  "connection",
]);

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ALLOWLIST_ENTRIES = 64;

/** Minimal request shape so unit tests don't need an Express app. */
export interface HeaderCarrier {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

let _cache: { value: EntraProxySettings; expiry: number } | null = null;

export async function getEntraProxySettings(): Promise<EntraProxySettings> {
  if (_cache && Date.now() < _cache.expiry) return _cache.value;
  const row = await prisma.setting.findUnique({ where: { key: "entraProxy" } });
  const value = row?.value
    ? { ...ENTRA_PROXY_DEFAULTS, ...(row.value as Record<string, any>) }
    : { ...ENTRA_PROXY_DEFAULTS };
  _cache = { value, expiry: Date.now() + 30000 };
  return value;
}

/** Test hook — drop the settings cache so the next read hits the DB. */
export function clearEntraProxySettingsCache(): void {
  _cache = null;
}

function normalizeHeaderName(raw: unknown, field: string, required: boolean): string {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!name) {
    if (required) throw new AppError(400, `${field} header name is required`);
    return "";
  }
  if (!HEADER_NAME_RE.test(name)) {
    throw new AppError(400, `${field} header name must match [a-z0-9-] (got "${name}")`);
  }
  if (HEADER_NAME_DENYLIST.has(name)) {
    throw new AppError(400, `${field} header name "${name}" is a reserved infrastructure header`);
  }
  return name;
}

function normalizeTrustedSourceIps(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AppError(400, "trustedSourceIps must be an array");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = String(item ?? "").trim();
    if (!entry) continue;
    if (!isValidAllowlistEntry(entry)) {
      throw new AppError(400, `Invalid trusted source entry "${entry}" — must be an IP address or CIDR`);
    }
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length > MAX_ALLOWLIST_ENTRIES) {
      throw new AppError(400, `At most ${MAX_ALLOWLIST_ENTRIES} trusted source entries are supported`);
    }
  }
  return out;
}

export async function updateEntraProxySettings(input: Record<string, any>): Promise<EntraProxySettings> {
  const cur = await getEntraProxySettings();
  const value: EntraProxySettings = {
    enabled: !!input.enabled,
    trustedSourceIps: normalizeTrustedSourceIps(input.trustedSourceIps ?? cur.trustedSourceIps),
    objectIdHeader: normalizeHeaderName(input.objectIdHeader ?? cur.objectIdHeader, "Object ID", true),
    usernameHeader: normalizeHeaderName(input.usernameHeader ?? cur.usernameHeader, "Username", true),
    emailHeader: normalizeHeaderName(input.emailHeader ?? cur.emailHeader, "Email", false),
    displayNameHeader: normalizeHeaderName(input.displayNameHeader ?? cur.displayNameHeader, "Display name", false),
    groupsHeader: normalizeHeaderName(input.groupsHeader ?? cur.groupsHeader, "Groups", false),
  };
  if (value.enabled && value.trustedSourceIps.length === 0) {
    throw new AppError(400, "At least one trusted source IP/CIDR (the App Proxy connector host) is required to enable header login");
  }
  await prisma.setting.upsert({
    where: { key: "entraProxy" },
    update: { value: value as any },
    create: { key: "entraProxy", value: value as any },
  });
  _cache = { value, expiry: Date.now() + 30000 };
  return value;
}

/** Enabled AND minimally configured AND has a non-empty allowlist (fail closed). */
export async function isEntraProxyEnabled(): Promise<boolean> {
  const s = await getEntraProxySettings();
  return !!(s.enabled && s.objectIdHeader && s.usernameHeader && s.trustedSourceIps.length > 0);
}

/** True when the (trust-proxy resolved) source address is an allowlisted connector. */
export async function isTrustedEntraProxySource(ip: string | undefined): Promise<boolean> {
  const s = await getEntraProxySettings();
  if (!s.enabled) return false;
  return ipMatchesAllowlist(ip, s.trustedSourceIps);
}

/**
 * True when THIS request could complete a header login right now: feature
 * enabled + configured, source allowlisted, and the object-id header present
 * (single-valued). Drives both the app.ts silent auto-login redirect and the
 * public /auth/entra-proxy/config `available` flag — internal users (no
 * headers / untrusted source) get false and see nothing.
 */
export async function isEntraProxyLoginAvailable(req: HeaderCarrier): Promise<boolean> {
  const s = await getEntraProxySettings();
  if (!s.enabled || !s.objectIdHeader || !s.usernameHeader || s.trustedSourceIps.length === 0) return false;
  if (!ipMatchesAllowlist(req.ip, s.trustedSourceIps)) return false;
  const val = req.headers[s.objectIdHeader];
  return val !== undefined && !Array.isArray(val);
}

/** The non-empty configured identity header names (for the strip middleware). */
export function identityHeaderNames(settings: EntraProxySettings): string[] {
  return [
    settings.objectIdHeader,
    settings.usernameHeader,
    settings.emailHeader,
    settings.displayNameHeader,
    settings.groupsHeader,
  ].filter(Boolean);
}

/** Default header names — the fail-closed strip set when settings can't be read. */
export function defaultIdentityHeaderNames(): string[] {
  return identityHeaderNames(ENTRA_PROXY_DEFAULTS);
}

export interface EntraProxyIdentity {
  objectId: string; // lowercased GUID
  upn: string;
  email: string;
  displayName: string;
  groups: string[]; // raw group ids as sent; normalized downstream
}

/**
 * Read the identity from the configured headers. Returns null when the
 * required headers are absent; throws AppError on malformed values (present
 * but not what App Proxy would send — likely mis-mapped headers).
 * Identity is read from HEADERS ONLY, never query/body. Array-valued headers
 * (duplicate header smuggling) are rejected outright.
 */
export async function extractEntraProxyIdentity(req: HeaderCarrier): Promise<EntraProxyIdentity | null> {
  const s = await getEntraProxySettings();

  const single = (name: string): string => {
    if (!name) return "";
    const val = req.headers[name];
    if (val === undefined) return "";
    if (Array.isArray(val)) {
      throw new AppError(400, `Duplicate "${name}" header — refusing ambiguous identity`);
    }
    return String(val).trim();
  };

  const rawObjectId = single(s.objectIdHeader);
  const upn = single(s.usernameHeader);
  if (!rawObjectId && !upn) return null;

  const objectId = rawObjectId.toLowerCase();
  if (!GUID_RE.test(objectId)) {
    throw new AppError(400, `Header "${s.objectIdHeader}" does not carry a valid Entra object ID GUID`);
  }
  if (!upn) {
    throw new AppError(400, `Header "${s.usernameHeader}" is missing — check the App Proxy header mappings`);
  }

  const groups = single(s.groupsHeader)
    .split(/[,;]/)
    .map((g) => g.trim())
    .filter(Boolean);

  return {
    objectId,
    upn,
    email: single(s.emailHeader),
    displayName: single(s.displayNameHeader),
    groups,
  };
}

export async function findOrProvisionEntraProxyUser(identity: EntraProxyIdentity) {
  return provisionExternalUser({
    provider: "entra-proxy",
    externalIdField: "azureOid",
    externalId: identity.objectId,
    usernameHint: identity.upn,
    displayName: identity.displayName || null,
    email: identity.email || null,
    groups: identity.groups,
  });
}

/**
 * Admin "Test" button — reports what THIS request looks like to the trust
 * gate. Header names only, never values (an untrusted admin path must not
 * echo spoofable identity content back as if meaningful).
 */
export async function testEntraProxyRequest(req: HeaderCarrier): Promise<{
  ok: boolean;
  message: string;
  details: Record<string, unknown>;
}> {
  const s = await getEntraProxySettings();
  const trusted = ipMatchesAllowlist(req.ip, s.trustedSourceIps);
  const headersPresent = identityHeaderNames(s).filter((name) => req.headers[name] !== undefined);
  const allowlistEmpty = s.trustedSourceIps.length === 0;

  let message: string;
  if (allowlistEmpty) {
    message = "No trusted source IPs configured — header login is disabled until the App Proxy connector address is added.";
  } else if (trusted) {
    message = headersPresent.length
      ? "This request arrived from a trusted source and carries identity headers — header login would proceed."
      : "This request arrived from a trusted source but carries no identity headers. Traffic through App Proxy (with header SSO configured) will carry them.";
  } else {
    message = `This request arrived from ${req.ip || "an unknown address"}, which is not in the trusted list. That is EXPECTED when testing from the internal network — only App Proxy connector traffic needs to match. Add this address only if it is the connector.`;
  }

  return {
    ok: !allowlistEmpty,
    message,
    details: {
      requestIp: req.ip || "",
      trusted,
      headersPresent,
      allowlistEmpty,
      enabled: s.enabled,
    },
  };
}
