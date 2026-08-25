/**
 * src/utils/httpCheck.ts
 *
 * Pure evaluation core for the "http" polling method — an HTTP GET against a
 * device that decides "up" from the STATUS CODE and, optionally, from a string
 * the response body must contain. Everything here is side-effect free so the
 * decision can be unit-tested without a socket; `probeHttp` in
 * monitoringService.ts owns the transport and calls `evaluateHttpCheck` with
 * what came back.
 *
 * ── Why a content check at all ────────────────────────────────────────────────
 * ICMP proves a NIC answers and SNMP/SSH prove a management plane answers.
 * Neither proves the thing the device exists to do still works: a web server
 * that has lost its backend still completes the TCP handshake and still
 * returns 200 — with an error page in the body. So the body match is the
 * load-bearing half of this method, and `failOnMismatch` (default TRUE) is what
 * makes it load-bearing: a 200 whose body doesn't match reads as DOWN, with the
 * reason naming the content that was missing rather than a generic failure.
 * Operators who want reachability-only semantics turn that toggle off and get
 * the mismatch recorded in the probe's error text while the probe still
 * succeeds — a deliberate middle state, not a no-op: it keeps the evidence
 * without alerting on it.
 *
 * ── Deliberate non-features ──────────────────────────────────────────────────
 * REDIRECTS ARE NOT FOLLOWED. A 302 to a login page is the single most common
 * way an HTTP health check reports "up" about a device that is not serving
 * anything — following it would fetch the login page, match nothing, and blame
 * the body. An operator who genuinely wants the redirect target points the path
 * at it, or sets `expectStatus` to the 3xx code they expect to see.
 *
 * NO POST / no request body / no custom method. This is a health check, not a
 * synthetic transaction: a probe that runs every 60s per asset must not be able
 * to mutate the device it is watching.
 *
 * BODY READING IS CAPPED at MAX_BODY_BYTES. A device that streams a log file at
 * the check path would otherwise buffer without bound on the monitor hot path,
 * once per asset per interval. The cap also bounds how much text an
 * operator-authored `regex` runs against — that regex is not analyzed for
 * backtracking behaviour (no static analysis can be), so the cap is what keeps
 * a pathological pattern from wedging a monitor worker rather than merely
 * slowing one probe. `contains` is the default for the same reason.
 */

/** Hard ceiling on how much of the response body is read and matched against. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * How much of the body the operator-driven Test Connection flow shows back.
 * Much smaller than the read cap: 64 KB of minified HTML in a modal is not
 * readable, and the point of the preview is to let someone pick a distinctive
 * string out of the response, not to mirror the whole document.
 */
export const MAX_EXCERPT_CHARS = 4 * 1024;

/** How `expectBody` is compared against the response body. */
export type HttpMatchMode = "contains" | "regex";

/**
 * The check definition. Stored on an `http`-typed Credential (so it is
 * selectable at the asset / class-override / integration tiers and its
 * `apiToken` / `password` are sealed at rest), except for `path`, which an
 * asset may override via `Asset.httpCheckPath` — one credential describes the
 * shape of the check, a per-device path handles the device whose health
 * endpoint sits somewhere else.
 */
/**
 * The AUTHENTICATION half — what an `http`-typed Credential stores, and all it
 * stores.
 *
 * Split out from the check definition in 2026-08, when the HTTP check moved
 * from a polling method to a manufacturer custom widget. The two halves vary on
 * different axes and belong to different owners: a login is per-vendor (or
 * per-site), while "which path, expecting what" is per-vendor-and-model. Keeping
 * them on one row meant a second path needed a second copy of the same
 * password, and changing the password meant editing every path.
 */
export interface HttpAuthConfig {
  /**
   * Which auth scheme to present. ABSENT is not "none" — it means the row
   * predates this field, and `resolveHttpAuthMode` infers the pre-existing
   * behaviour from whichever carrier is populated. See that function.
   */
  authMode?: HttpAuthMode;
  /** Sent as `Authorization: Bearer <token>`. Sealed at rest. */
  apiToken?: string;
  /** With `password`, sent as HTTP Basic or Digest per `authMode`. */
  username?: string;
  /** Sealed at rest. */
  password?: string;
}

/**
 * The CHECK definition — which request to make and what answer counts as
 * healthy. Owned by a `ManufacturerCustomWidget` with `widgetType: "http"`
 * (keyed by manufacturer + optional model), and accepted ad hoc by the
 * credential Test Connection flow so a check can be dialled in before it is
 * saved anywhere. `Asset.httpCheckPath` overrides just the path, for the one
 * device whose endpoint sits somewhere else.
 */
export interface HttpCheckConfig {
  /** https when true, http otherwise. Default false (plain HTTP). */
  useHttps?: boolean;
  /** Defaults to 443 when `useHttps`, else 80. */
  port?: number;
  /** Request path, leading slash optional on input. Default "/". */
  path?: string;
  /**
   * Exact status code that counts as up. Absent/null = any 2xx, which is the
   * useful default — a health endpoint answering 204 is as healthy as one
   * answering 200, and enumerating that per credential is busywork.
   */
  expectStatus?: number | null;
  /** Text the body must carry. Absent/empty = status code alone decides. */
  expectBody?: string;
  /** Default "contains". */
  matchMode?: HttpMatchMode;
  /** Default false — `contains` and `regex` both fold case unless this is on. */
  caseSensitive?: boolean;
  /** Default TRUE — a content mismatch fails the probe. See header note. */
  failOnMismatch?: boolean;
  /** Default false, matching the restapi credential (self-signed device certs). */
  verifyTls?: boolean;
}

/**
 * How the check authenticates.
 *
 * "digest" is the reason this is an explicit field rather than an inference:
 * Basic and Digest are carried by the same username/password pair, so once
 * Digest exists there is nothing in the stored config that could distinguish
 * them. Guessing — try Basic, fall back on a 401 — would send the password in
 * cleartext to any device that answers a Digest challenge, which is precisely
 * the exposure Digest exists to avoid.
 */
export type HttpAuthMode = "none" | "bearer" | "basic" | "digest";

/**
 * Modes an `http` CREDENTIAL may be saved with. "none" is deliberately absent:
 * a credential exists to authenticate, and a credential that authenticates
 * nothing is an empty row that reads as configuration. Unauthenticated checks
 * are expressed by a widget selecting NO credential at all, which is the same
 * outcome without the misleading artefact.
 */
export const HTTP_CREDENTIAL_AUTH_MODES: readonly HttpAuthMode[] = ["bearer", "basic", "digest"];

/**
 * Every mode the PROBE can execute. "none" stays here because it is the state
 * of a widget with no credential attached — the probe must be able to express
 * "send no Authorization header".
 */
export const HTTP_AUTH_MODES: readonly HttpAuthMode[] = ["none", "bearer", "basic", "digest"];

/**
 * Resolve the effective auth mode, defaulting a credential saved before the
 * field existed to exactly what it used to do: `apiToken` won over a
 * username/password pair, and neither meant unauthenticated. Every consumer
 * (validation, the probe, the Test Connection diagnostics) reads the mode
 * through here so a stored row cannot mean one thing to the validator and
 * another to the socket.
 */
export function resolveHttpAuthMode(config: HttpAuthConfig): HttpAuthMode {
  const declared = config.authMode;
  if (declared && (HTTP_AUTH_MODES as readonly string[]).includes(declared)) return declared;
  if (typeof config.apiToken === "string" && config.apiToken) return "bearer";
  if (typeof config.username === "string" && config.username &&
      typeof config.password === "string" && config.password) return "basic";
  return "none";
}

/**
 * Normalize a request path: default "/", force a leading slash, reject nothing
 * (a query string is legitimate on a health endpoint). Whitespace is trimmed
 * because an operator pasting a path out of a browser bar picks up a newline
 * often enough to matter, and a stray one would produce an invalid request
 * line rather than a readable error.
 */
export function normalizeHttpPath(path: string | null | undefined): string {
  const raw = typeof path === "string" ? path.trim() : "";
  if (!raw) return "/";
  return raw.startsWith("/") ? raw : "/" + raw;
}

/** Default port for the scheme. */
export function defaultHttpPort(useHttps: boolean | undefined): number {
  return useHttps ? 443 : 80;
}

export interface ResolvedHttpTarget {
  useHttps: boolean;
  port: number;
  path: string;
}

/**
 * Resolve the request line from the credential plus an optional per-asset path
 * override. The override wins ONLY when it is a non-empty string: a null or
 * blank `Asset.httpCheckPath` means "no override", so clearing the field on the
 * asset returns the device to the credential's path rather than to "/".
 */
export function resolveHttpTarget(
  config: HttpCheckConfig,
  pathOverride?: string | null,
): ResolvedHttpTarget {
  const useHttps = config.useHttps === true;
  const port = Number.isInteger(config.port) && (config.port as number) > 0
    ? (config.port as number)
    : defaultHttpPort(useHttps);
  const override = typeof pathOverride === "string" && pathOverride.trim() ? pathOverride : null;
  return { useHttps, port, path: normalizeHttpPath(override ?? config.path) };
}

/** True when the status code satisfies `expectStatus` (absent = any 2xx). */
export function statusAccepted(statusCode: number, expectStatus: number | null | undefined): boolean {
  if (expectStatus === null || expectStatus === undefined) {
    return statusCode >= 200 && statusCode < 300;
  }
  return statusCode === expectStatus;
}

/**
 * Compile the body expectation. Returns null when there is nothing to match,
 * so callers can distinguish "no expectation" from "expectation not met".
 * An invalid regex throws — credential validation rejects one at save time, so
 * reaching this with a bad pattern means the row predates validation, and a
 * thrown message naming the failure beats silently treating it as a miss.
 */
export function bodyMatches(body: string, config: HttpCheckConfig): boolean | null {
  const expect = typeof config.expectBody === "string" ? config.expectBody : "";
  if (!expect) return null;
  const caseSensitive = config.caseSensitive === true;
  if (config.matchMode === "regex") {
    const re = new RegExp(expect, caseSensitive ? "" : "i");
    return re.test(body);
  }
  return caseSensitive
    ? body.includes(expect)
    : body.toLowerCase().includes(expect.toLowerCase());
}

/**
 * What the operator-driven test reports back so the check can be TAILORED: the
 * request that actually went out, what came back, and whether the current
 * expectation hit. Produced ONLY on the Test Connection path — `probeHttp`
 * fills it when handed an out-param, so the monitor hot path allocates none of
 * this per probe per interval.
 *
 * Deliberately NOT the response headers. `content-type` is the one an operator
 * needs (it explains a body that reads as gibberish), whereas a full header dump
 * would put `Set-Cookie` — a live session token for whatever the check just
 * authenticated against — into a modal and into anything that later screenshots
 * or copies it.
 */
export interface HttpProbeDiagnostics {
  /** The request line as dialed, so "why did it 404" is answerable. */
  url: string;
  statusCode: number;
  contentType: string | null;
  /** Bytes actually read — capped at MAX_BODY_BYTES. */
  bytesRead: number;
  /** True when the device had more to send than the read cap allowed. */
  bodyTruncatedAtCap: boolean;
  excerpt: string;
  /** True when `excerpt` is shorter than what was read. */
  excerptTruncated: boolean;
  /** The current expectation's verdict; null when none is configured yet. */
  matched: boolean | null;
  /**
   * Auth schemes the device offered in `WWW-Authenticate`, when it challenged.
   * Null when it never did. This is the single most useful thing a failing
   * probe can report: "you configured Basic and it asked for Digest" is
   * otherwise indistinguishable from a wrong password, since both arrive as a
   * bare 401. Scheme names only — no realm, no nonce, nothing carrying a
   * credential.
   */
  authRequested: string[] | null;
  /** True when a Digest challenge was answered and the request re-sent. */
  digestNegotiated: boolean;
}

/** Trim a body down to what the test modal will show. Pure. */
export function bodyExcerpt(body: string): { text: string; truncated: boolean } {
  if (body.length <= MAX_EXCERPT_CHARS) return { text: body, truncated: false };
  return { text: body.slice(0, MAX_EXCERPT_CHARS), truncated: true };
}

/**
 * The request line as a display string. Built from the RESOLVED target, so what
 * the operator reads is what the socket dialed — including a path override and
 * a defaulted port, the two things a hand-written guess gets wrong.
 */
export function describeHttpTarget(host: string, target: ResolvedHttpTarget): string {
  const scheme = target.useHttps ? "https" : "http";
  // Print the port only when it isn't the scheme's default — a URL reading
  // "https://host:443/x" invites the reader to wonder what's special about it.
  const port = target.port === defaultHttpPort(target.useHttps) ? "" : ":" + target.port;
  return `${scheme}://${host}${port}${target.path}`;
}

export interface HttpCheckOutcome {
  /** Whether the probe counts as a success. */
  ok: boolean;
  /**
   * Populated whenever something was off — INCLUDING on `ok: true`, which is
   * the `failOnMismatch: false` content-mismatch case. The probe path surfaces
   * it as the probe's error text so the evidence survives without alerting.
   */
  error?: string;
  /** true/false when a body expectation existed, null when none did. */
  matched: boolean | null;
}

/**
 * Decide the probe outcome from what came back. Status is judged first: a 401
 * is a misconfigured credential, not missing content, and blaming the body
 * there sends the operator to the wrong field.
 */
export function evaluateHttpCheck(args: {
  statusCode: number;
  body: string;
  config: HttpCheckConfig;
  truncated?: boolean;
}): HttpCheckOutcome {
  const { statusCode, body, config } = args;
  if (!statusAccepted(statusCode, config.expectStatus)) {
    const wanted = config.expectStatus === null || config.expectStatus === undefined
      ? "any 2xx"
      : String(config.expectStatus);
    return { ok: false, error: `HTTP ${statusCode} (expected ${wanted})`, matched: null };
  }

  let matched: boolean | null;
  try {
    matched = bodyMatches(body, config);
  } catch (err: any) {
    return {
      ok: false,
      error: `Invalid ${config.matchMode === "regex" ? "regex" : "match"} pattern: ${err?.message || "unparseable"}`,
      matched: null,
    };
  }
  if (matched !== false) return { ok: true, matched };

  // Name the truncation when it happened — "not found in the first 64 KB" is a
  // materially different finding from "not found", and an operator whose match
  // string sits past the cap needs to know that rather than re-checking a
  // string that is genuinely present.
  const where = args.truncated
    ? `the first ${Math.floor(MAX_BODY_BYTES / 1024)} KB of the response body`
    : "the response body";
  const kind = config.matchMode === "regex" ? "pattern" : "text";
  const detail = `Expected ${kind} not found in ${where} (HTTP ${statusCode})`;
  // failOnMismatch defaults to true — an absent value is the strict reading.
  if (config.failOnMismatch === false) return { ok: true, error: detail, matched: false };
  return { ok: false, error: detail, matched: false };
}
