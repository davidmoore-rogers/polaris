/**
 * src/services/activeDirectoryService.ts — On-premise Active Directory device discovery
 *
 * Authenticates to a domain controller via LDAP simple bind (LDAP or LDAPS)
 * and queries computer objects under a configured base DN. Produces assets
 * only — no subnets, reservations, or VIPs.
 *
 * Cross-links with the Entra ID integration via the on-prem SID: both sides
 * persist `sid:{SID}` in the asset tags array so hybrid-joined devices resolve
 * to a single asset regardless of which integration found them first.
 */

import { Client, type Entry, type SearchOptions } from "ldapts";
import { AppError } from "../utils/errors.js";

export interface ActiveDirectoryConfig {
  host: string;
  port?: number;
  useLdaps?: boolean;
  verifyTls?: boolean;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  searchScope?: "sub" | "one";
  ouInclude?: string[];   // Wildcards match against distinguishedName (e.g. *OU=Servers*)
  ouExclude?: string[];
  includeDisabled?: boolean;  // Default true — disabled accounts become `decommissioned` assets
}

export interface DiscoveredAdDevice {
  objectGuid: string;           // Lowercase hex (stable AD identifier → Asset.assetTag = "ad:{guid}")
  objectSid: string;            // String SID (cross-link to Entra's onPremisesSecurityIdentifier)
  cn: string;                   // Short hostname
  dnsHostName: string;          // FQDN (preferred for Asset.hostname if present)
  distinguishedName: string;
  operatingSystem: string;
  operatingSystemVersion: string;
  description: string;
  whenCreated?: string;         // ISO
  lastLogonTimestamp?: string;  // ISO (from Windows FILETIME); replicates only every ~14 days
  disabled: boolean;            // userAccountControl & 0x2 (ACCOUNTDISABLE)
  ouPath: string;               // Derived from DN, e.g. "OU=Workstations/OU=HQ"
}

export interface AdDiscoveryResult {
  devices: DiscoveredAdDevice[];
}

export type AdDiscoveryProgressCallback = (
  step: string,
  level: "info" | "error",
  message: string,
) => void;

// ─── Client construction ────────────────────────────────────────────────────

function buildUrl(config: ActiveDirectoryConfig): string {
  const useLdaps = config.useLdaps !== false;
  const defaultPort = useLdaps ? 636 : 389;
  const port = config.port && config.port > 0 ? config.port : defaultPort;
  const scheme = useLdaps ? "ldaps" : "ldap";
  return `${scheme}://${config.host}:${port}`;
}

function newClient(config: ActiveDirectoryConfig): Client {
  const useLdaps = config.useLdaps !== false;
  return new Client({
    url: buildUrl(config),
    timeout: 30_000,
    connectTimeout: 15_000,
    tlsOptions: useLdaps ? { rejectUnauthorized: !!config.verifyTls } : undefined,
  });
}

async function withBoundClient<T>(
  config: ActiveDirectoryConfig,
  signal: AbortSignal | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = newClient(config);
  const onAbort = () => { void client.unbind().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await client.bind(config.bindDn, config.bindPassword);
    return await fn(client);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { await client.unbind(); } catch { /* ignore */ }
  }
}

// ─── Connection test ────────────────────────────────────────────────────────

export async function testConnection(config: ActiveDirectoryConfig): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!config.host)         return { ok: false, message: "Host is required" };
  if (!config.bindDn)       return { ok: false, message: "Bind DN is required" };
  if (!config.bindPassword) return { ok: false, message: "Bind password is required" };
  if (!config.baseDn)       return { ok: false, message: "Base DN is required" };

  try {
    const count = await withBoundClient(config, undefined, async (client) => {
      const { searchEntries } = await client.search(config.baseDn, {
        scope: config.searchScope || "sub",
        filter: "(&(objectCategory=computer)(objectClass=computer))",
        attributes: ["cn"],
        sizeLimit: 1,
        timeLimit: 10,
      });
      return searchEntries.length;
    });
    return { ok: true, message: `Connected — bind succeeded, sample computer query returned ${count} entry(s)` };
  } catch (err: any) {
    return { ok: false, message: formatLdapError(err) };
  }
}

function formatLdapError(err: any): string {
  const name = err?.name || "";
  const msg = err?.message || "Unknown error";
  if (name === "InvalidCredentialsError") return "Invalid bind DN or password";
  if (name === "NoSuchObjectError")       return "Base DN not found";
  if (name === "InsufficientAccessError") return "Bind account has insufficient access to the base DN";
  if (err?.code === "ENOTFOUND")          return "Host not found — check DNS/hostname";
  if (err?.code === "ECONNREFUSED")       return "Connection refused — check port and firewall";
  if (err?.code === "ETIMEDOUT")          return "Connection timed out";
  if (err?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || err?.code === "SELF_SIGNED_CERT_IN_CHAIN" || err?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "TLS certificate verification failed — uncheck \"Verify TLS\" or install the DC's CA certificate";
  }
  return msg.split(/\r?\n/)[0];
}

// ─── Manual query (UI tool) ─────────────────────────────────────────────────

/**
 * Run an arbitrary LDAP search against the configured DC using stored
 * credentials. baseDn defaults to the integration's configured base.
 * Returns plain objects with Buffer attributes stringified where possible.
 */
export async function proxyQuery(
  config: ActiveDirectoryConfig,
  body: { filter?: string; baseDn?: string; scope?: "sub" | "one" | "base"; attributes?: string[]; sizeLimit?: number },
): Promise<unknown> {
  const filter = body.filter?.trim() || "(&(objectCategory=computer)(objectClass=computer))";
  const baseDn = body.baseDn?.trim() || config.baseDn;
  if (!baseDn) throw new AppError(400, "baseDn is required (either in the query or the integration config)");

  const size = Math.min(Math.max(body.sizeLimit || 50, 1), 500);
  const attrs = body.attributes && body.attributes.length > 0 ? body.attributes : undefined;

  return withBoundClient(config, undefined, async (client) => {
    const { searchEntries } = await client.search(baseDn, {
      scope: body.scope || "sub",
      filter,
      attributes: attrs,
      sizeLimit: size,
      timeLimit: 15,
    });
    return { entries: searchEntries.map(simplifyEntry) };
  });
}

function simplifyEntry(entry: Entry): Record<string, unknown> {
  const out: Record<string, unknown> = { dn: entry.dn };
  for (const key of Object.keys(entry)) {
    if (key === "dn") continue;
    const v = (entry as any)[key];
    if (Buffer.isBuffer(v)) {
      out[key] = v.toString("utf8");
    } else if (Array.isArray(v) && v.length > 0 && Buffer.isBuffer(v[0])) {
      out[key] = (v as Buffer[]).map((b) => b.toString("utf8"));
    } else {
      out[key] = v;
    }
  }
  return out;
}

// ─── Device discovery ───────────────────────────────────────────────────────

const DEVICES_HARD_CAP = 10_000;
const PAGE_SIZE = 1000;

const ATTRIBUTES = [
  "objectGUID",
  "objectSid",
  "cn",
  "dNSHostName",
  "distinguishedName",
  "operatingSystem",
  "operatingSystemVersion",
  "description",
  "whenCreated",
  "lastLogonTimestamp",
  "userAccountControl",
];

// Attributes that must come back as raw bytes so we can decode them ourselves.
const BUFFER_ATTRIBUTES = ["objectGUID", "objectSid"];

export async function discoverDevices(
  config: ActiveDirectoryConfig,
  signal?: AbortSignal,
  onProgress?: AdDiscoveryProgressCallback,
): Promise<AdDiscoveryResult> {
  const log = onProgress || (() => {});

  if (!config.host)         throw new AppError(400, "Host is required");
  if (!config.bindDn)       throw new AppError(400, "Bind DN is required");
  if (!config.bindPassword) throw new AppError(400, "Bind password is required");
  if (!config.baseDn)       throw new AppError(400, "Base DN is required");

  const devices: DiscoveredAdDevice[] = [];

  try {
    await withBoundClient(config, signal, async (client) => {
      const options: SearchOptions = {
        scope: config.searchScope || "sub",
        filter: "(&(objectCategory=computer)(objectClass=computer))",
        attributes: ATTRIBUTES,
        explicitBufferAttributes: BUFFER_ATTRIBUTES,
        paged: { pageSize: PAGE_SIZE },
        sizeLimit: DEVICES_HARD_CAP,
        timeLimit: 120,
      };
      const { searchEntries } = await client.search(config.baseDn, options);

      for (const entry of searchEntries) {
        if (signal?.aborted) break;
        const dev = parseEntry(entry);
        if (!dev) continue;
        devices.push(dev);
      }
    });
  } catch (err: any) {
    const msg = formatLdapError(err);
    log("discover.ad.search", "error", `Active Directory: search failed — ${msg}`);
    throw new AppError(502, `Active Directory search failed: ${msg}`);
  }

  log("discover.ad.search", "info", `Active Directory: retrieved ${devices.length} computer object(s)`);

  const filtered = filterDevices(devices, config.ouInclude, config.ouExclude);
  const dropped = devices.length - filtered.length;
  if (dropped > 0) {
    log("discover.filter", "info", `Device filter: ${filtered.length} included, ${dropped} excluded`);
  }

  if (config.includeDisabled === false) {
    const beforeDisabled = filtered.length;
    const active = filtered.filter((d) => !d.disabled);
    const disabledCount = beforeDisabled - active.length;
    if (disabledCount > 0) {
      log("discover.filter.disabled", "info", `Skipping ${disabledCount} disabled computer account(s) (includeDisabled=false)`);
    }
    return { devices: active };
  }

  return { devices: filtered };
}

// ─── Parsing helpers ────────────────────────────────────────────────────────

function parseEntry(entry: Entry): DiscoveredAdDevice | null {
  const guidRaw = entry.objectGUID;
  const sidRaw = entry.objectSid;
  const guid = Buffer.isBuffer(guidRaw) ? decodeObjectGuid(guidRaw) : "";
  const sid = Buffer.isBuffer(sidRaw) ? decodeObjectSid(sidRaw) : "";
  if (!guid) return null;

  const cn = readString(entry.cn);
  const dnsHostName = readString(entry.dNSHostName);
  const distinguishedName = entry.dn || readString(entry.distinguishedName);
  const os = readString(entry.operatingSystem);
  const osVersion = readString(entry.operatingSystemVersion);
  const description = readString(entry.description);
  const whenCreated = decodeGeneralizedTime(readString(entry.whenCreated));
  const lastLogon = decodeFileTime(readString(entry.lastLogonTimestamp));
  const uac = parseInt(readString(entry.userAccountControl) || "0", 10);
  const disabled = (uac & 0x2) === 0x2;
  const ouPath = deriveOuPath(distinguishedName);

  return {
    objectGuid: guid,
    objectSid: sid,
    cn,
    dnsHostName,
    distinguishedName,
    operatingSystem: os,
    operatingSystemVersion: osVersion,
    description,
    whenCreated,
    lastLogonTimestamp: lastLogon,
    disabled,
    ouPath,
  };
}

function readString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (Array.isArray(v)) return readString(v[0]);
  return String(v);
}

// Microsoft stores GUIDs in a mixed-endian layout. For identity-only use it's
// fine to treat the 16 bytes as an opaque lowercase hex string — we never
// convert back — but keep the canonical display-form conversion if we ever
// want to show it to the user.
function decodeObjectGuid(buf: Buffer): string {
  if (buf.length !== 16) return "";
  return buf.toString("hex").toLowerCase();
}

// objectSid is a binary SID structure. Decode to the standard S-1-<auth>-<sub>...
// string form.
function decodeObjectSid(buf: Buffer): string {
  if (buf.length < 8) return "";
  const revision = buf.readUInt8(0);
  const subAuthCount = buf.readUInt8(1);
  // identifierAuthority is a 48-bit big-endian integer
  const authority =
    buf.readUIntBE(2, 6); // safe for values up to 2^48
  const parts: string[] = [`S-${revision}-${authority}`];
  for (let i = 0; i < subAuthCount; i++) {
    const offset = 8 + i * 4;
    if (offset + 4 > buf.length) break;
    parts.push(String(buf.readUInt32LE(offset)));
  }
  return parts.join("-");
}

// AD Generalized Time: "YYYYMMDDHHMMSS.0Z" → ISO string
function decodeGeneralizedTime(s: string): string | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Windows FILETIME: 100-nanosecond intervals since 1601-01-01 UTC → ISO string.
// AD returns "0" for never-logged-on, which we treat as undefined.
function decodeFileTime(s: string): string | undefined {
  if (!s || s === "0") return undefined;
  // Use BigInt to preserve precision; epoch offset is 11644473600 seconds.
  let n: bigint;
  try { n = BigInt(s); } catch { return undefined; }
  if (n <= 0n) return undefined;
  const ms = Number(n / 10000n) - 11644473600000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

// "CN=FOO,OU=Workstations,OU=HQ,DC=corp,DC=local" → "OU=HQ/OU=Workstations"
// (outer→inner so a human reads the containment top-down).
function deriveOuPath(dn: string): string {
  if (!dn) return "";
  const parts = dn.split(/(?<!\\),/).map((p) => p.trim());
  const ous = parts.filter((p) => p.toUpperCase().startsWith("OU="));
  return ous.reverse().join("/");
}

function matchesWildcard(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return v.includes(p.slice(1, -1));
  if (p.startsWith("*")) return v.endsWith(p.slice(1));
  if (p.endsWith("*")) return v.startsWith(p.slice(0, -1));
  return v === p;
}

function filterDevices(
  devices: DiscoveredAdDevice[],
  include?: string[],
  exclude?: string[],
): DiscoveredAdDevice[] {
  if (include && include.length > 0) {
    return devices.filter((d) => include.some((p) => matchesWildcard(p, d.distinguishedName)));
  }
  if (exclude && exclude.length > 0) {
    return devices.filter((d) => !exclude.some((p) => matchesWildcard(p, d.distinguishedName)));
  }
  return devices;
}
