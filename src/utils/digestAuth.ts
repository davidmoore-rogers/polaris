/**
 * src/utils/digestAuth.ts
 *
 * HTTP Digest Access Authentication (RFC 7616, superseding RFC 2617) for the
 * "http" polling method. Pure except for `newCnonce`, so the hash arithmetic —
 * the part that is either exactly right or silently produces a 401 forever —
 * is unit-testable without a socket.
 *
 * ── Why this exists rather than a dependency ─────────────────────────────────
 * Nothing in the dependency set speaks Digest (undici included), and the
 * `node:https` call sites in monitoringService issue requests directly. Digest
 * is ~150 lines of hashing against a well-specified RFC, so a hand-rolled pure
 * module is cheaper than a transitive dependency on the monitor hot path.
 *
 * It exists at all because Digest is what a camera or an embedded appliance
 * actually offers: Axis OS answers VAPIX with `WWW-Authenticate: Digest` and
 * newer firmware disables Basic by default, so a Bearer/Basic-only client can
 * fail to authenticate against a device it is otherwise perfectly able to reach.
 *
 * ── Digest is a HANDSHAKE, not a header ──────────────────────────────────────
 * Unlike Basic and Bearer, the client cannot construct the credential up front:
 * the response hash is keyed on a server-issued `nonce`. So the first request
 * goes out unauthenticated, the server answers 401 with a challenge, and the
 * client re-sends with the computed response. `probeHttp` re-fires exactly ONCE
 * — never a loop, because a server that rejects a correctly-computed response
 * will reject it again, and a probe that retries on every 401 turns a bad
 * password into an unbounded request amplifier against the device.
 *
 * The cost is two requests per probe instead of one. That is accepted rather
 * than cached: a nonce cache keyed by (host, realm) would cut it to one in the
 * steady state, but it has to carry a strictly-increasing `nc` counter per
 * nonce, and a stale or raced counter reads to the server as a replay — i.e. it
 * trades a cheap doubling of a cheap request for an auth failure mode that only
 * appears under concurrency. At one probe per asset per interval the doubling
 * is not the bottleneck; if it ever is, the cache belongs here, not in the
 * transport.
 *
 * ── Deliberate non-support ───────────────────────────────────────────────────
 * `qop=auth-int` hashes the entity body into HA2. This client only ever issues
 * GET with no body (see httpCheck.ts — no POST by design), so auth-int is
 * computable, but a server offering ONLY auth-int is rare enough that guessing
 * at it is more likely to produce a wrong hash than a working probe. It is
 * refused by name so the operator reads "auth-int is not supported" rather than
 * a bare 401.
 *
 * `userhash` (RFC 7616 §3.4.4) is not implemented; a server requesting it will
 * simply not match, which is the same outcome as not supporting it.
 */

import { createHash, randomBytes } from "node:crypto";

/** Parsed `WWW-Authenticate: Digest ...` parameters. */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  /** Server-offered qop values, lowercased. Empty when the header omitted qop (RFC 2069 mode). */
  qop: string[];
  /** Echoed back verbatim when present. */
  opaque?: string;
  /** As sent by the server, e.g. "MD5", "SHA-256", "MD5-sess". Absent = MD5. */
  algorithm?: string;
  /** True when the server says the nonce aged out but the credentials were fine. */
  stale: boolean;
}

/**
 * Split a header on commas that sit outside quoted strings. `WWW-Authenticate`
 * routinely carries commas inside `qop="auth,auth-int"`, so a naive split
 * shreds the challenge into unparseable fragments.
 */
function splitTopLevel(header: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (inQuotes && ch === "\\" && i + 1 < header.length) {
      // Keep the escape intact; unquoting happens later, per value.
      buf += ch + header[i + 1];
      i++;
      continue;
    }
    if (ch === '"') { inQuotes = !inQuotes; buf += ch; continue; }
    if (ch === "," && !inQuotes) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Strip surrounding quotes and unescape, leaving an unquoted token untouched. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return v;
}

/**
 * A comma-separated part either starts a new scheme ("Digest realm=x", or a
 * bare "Negotiate") or continues the current one ("nonce=y"). The distinction
 * is whether a bare token precedes the first "=", which is what separates
 * `Digest realm="x"` from `qop="auth"`.
 */
function schemeNameOf(part: string): string | null {
  const bare = /^([A-Za-z][A-Za-z0-9._-]*)$/.exec(part);
  if (bare) return bare[1];
  const eq = part.indexOf("=");
  const sp = part.search(/\s/);
  if (sp === -1) return null;                 // "key=value", no scheme token
  if (eq !== -1 && eq < sp) return null;      // "key = value", still a parameter
  const head = /^([A-Za-z][A-Za-z0-9._-]*)\s/.exec(part);
  return head ? head[1] : null;
}

/** The parameter text of a part that introduced a scheme ("Digest realm=x" → "realm=x"). */
function paramsAfterScheme(part: string): string {
  const sp = part.search(/\s/);
  return sp === -1 ? "" : part.slice(sp + 1).trim();
}

function readParam(text: string, into: Map<string, string>): void {
  const kv = /^([A-Za-z0-9._-]+)\s*=\s*([\s\S]*)$/.exec(text.trim());
  if (kv) into.set(kv[1].toLowerCase(), unquote(kv[2]));
}

/**
 * Every auth scheme the header offers, in order, with original casing —
 * e.g. ["Digest"] or ["Basic", "Digest"]. Surfaced as a diagnostic so a probe
 * that 401s can say what the device actually asked for, which is the whole
 * difference between "wrong password" and "you configured Basic and it wants
 * Digest".
 */
export function authSchemesOffered(header: string | null | undefined): string[] {
  if (!header) return [];
  const schemes: string[] = [];
  for (const part of splitTopLevel(header)) {
    const name = schemeNameOf(part);
    if (name) schemes.push(name);
  }
  return schemes;
}

/**
 * Parse the Digest challenge out of a `WWW-Authenticate` header, ignoring any
 * other schemes offered alongside it. Returns null when the header carries no
 * Digest challenge or the challenge is missing a field the computation needs
 * (`realm` and `nonce` are both load-bearing — a challenge without them cannot
 * produce a response, and defaulting either would send a hash that can only
 * ever be wrong).
 */
export function parseDigestChallenge(header: string | null | undefined): DigestChallenge | null {
  if (!header) return null;
  const params = new Map<string, string>();
  let inDigest = false;
  let sawDigest = false;

  for (const part of splitTopLevel(header)) {
    const name = schemeNameOf(part);
    if (name) {
      inDigest = name.toLowerCase() === "digest";
      if (inDigest) sawDigest = true;
      const rest = paramsAfterScheme(part);
      if (inDigest && rest) readParam(rest, params);
      continue;
    }
    if (inDigest) readParam(part, params);
  }

  if (!sawDigest) return null;
  const realm = params.get("realm");
  const nonce = params.get("nonce");
  if (realm === undefined || !nonce) return null;

  const qopRaw = params.get("qop") || "";
  return {
    realm,
    nonce,
    qop: qopRaw.split(",").map((q) => q.trim().toLowerCase()).filter(Boolean),
    opaque: params.get("opaque"),
    algorithm: params.get("algorithm"),
    stale: (params.get("stale") || "").toLowerCase() === "true",
  };
}

/** Node hash name + whether the algorithm is a `-sess` variant. */
function resolveAlgorithm(algorithm: string | undefined): { hash: string; sess: boolean; label: string } {
  const label = (algorithm || "MD5").trim();
  const upper = label.toUpperCase();
  const sess = upper.endsWith("-SESS");
  const base = sess ? upper.slice(0, -5) : upper;
  const hash =
    base === "MD5"         ? "md5" :
    base === "SHA-256"     ? "sha256" :
    base === "SHA-512-256" ? "sha512-256" :
    "";
  if (!hash) throw new Error(`Unsupported digest algorithm "${label}"`);
  return { hash, sess, label };
}

export interface DigestAuthArgs {
  challenge: DigestChallenge;
  username: string;
  password: string;
  /** Uppercase HTTP method, e.g. "GET". */
  method: string;
  /** Request-URI exactly as it appears on the request line, including any query. */
  uri: string;
  /** Client nonce. Injected rather than generated so the computation stays pure. */
  cnonce: string;
  /** Nonce count for this (nonce, cnonce) pair. 1 for a fresh challenge. */
  nc?: number;
}

/**
 * Build the `Authorization: Digest ...` header value for a challenge.
 *
 * Throws on an algorithm or qop this client cannot compute, rather than
 * emitting a header that is syntactically fine and cryptographically wrong —
 * the failure then names the cause instead of arriving as an opaque second 401.
 */
export function buildDigestAuthorization(args: DigestAuthArgs): string {
  const { challenge, username, password, method, uri, cnonce } = args;
  const nc = Math.max(1, Math.floor(args.nc ?? 1));
  const { hash, sess, label } = resolveAlgorithm(challenge.algorithm);
  const H = (s: string) => createHash(hash).update(s, "utf8").digest("hex");

  // qop selection: prefer "auth". An "auth-int"-only server is refused by name
  // — see the header note.
  let qop: string | null = null;
  if (challenge.qop.length > 0) {
    if (challenge.qop.includes("auth")) qop = "auth";
    else if (challenge.qop.includes("auth-int")) {
      throw new Error('Digest qop="auth-int" is not supported');
    } else {
      throw new Error(`Unsupported digest qop "${challenge.qop.join(",")}"`);
    }
  }

  let ha1 = H(`${username}:${challenge.realm}:${password}`);
  // A "-sess" algorithm re-keys HA1 with the nonce pair so the password hash is
  // not reusable across sessions.
  if (sess) ha1 = H(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = H(`${method.toUpperCase()}:${uri}`);

  const ncHex = nc.toString(16).padStart(8, "0");
  const response = qop
    ? H(`${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    // No qop offered — RFC 2069 legacy form, still what some embedded servers do.
    : H(`${ha1}:${challenge.nonce}:${ha2}`);

  // RFC 7616 quoted-string: a backslash escapes the NEXT character, so the
  // backslash itself has to be escaped FIRST. Escaping only the quote left a
  // value ending in `\` turning our own closing delimiter into an escaped one
  // and corrupting every field after it — and `realm` / `nonce` / `opaque` are
  // echoed straight back from the SERVER's challenge, so the malformed value
  // need not be ours.
  const quoted = (k: string, v: string) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const fields = [
    quoted("username", username),
    quoted("realm", challenge.realm),
    quoted("nonce", challenge.nonce),
    quoted("uri", uri),
    quoted("response", response),
  ];
  // Echo algorithm only when the server named one: an unsolicited
  // `algorithm=MD5` is legal but some embedded servers are stricter than the
  // RFC about fields they did not offer.
  if (challenge.algorithm) fields.push(`algorithm=${label}`);
  if (qop) {
    fields.push(`qop=${qop}`, `nc=${ncHex}`, quoted("cnonce", cnonce));
  }
  if (challenge.opaque !== undefined) fields.push(quoted("opaque", challenge.opaque));
  return "Digest " + fields.join(", ");
}

/** Fresh client nonce. Separate from the computation so that stays pure. */
export function newCnonce(): string {
  return randomBytes(16).toString("hex");
}
