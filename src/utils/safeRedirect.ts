/**
 * src/utils/safeRedirect.ts
 *
 * Post-login redirect-target sanitization. Lives here rather than beside its
 * one caller (auth.ts's `/entra-proxy/login`) because it is the kind of
 * predicate that has to be pinned by tests: it stands between a query
 * parameter and `res.redirect`, and every regression in it is an open-redirect
 * phishing primitive against a page operators reach mid-authentication.
 */

/** Opaque base used only to parse a relative target — never a destination. */
const SAFE_NEXT_BASE = "http://localhost";

/**
 * Reduce an untrusted `?next=` value to a same-origin relative path, else "/".
 *
 * REBUILDS the path from parsed URL components rather than returning the input
 * after a series of prefix checks. Prefix checks were the previous approach and
 * were correct for the cases they named (protocol-relative "//evil",
 * backslash "/\evil", absolute URLs), but "return the attacker's own string
 * once it clears my blocklist" is only ever as good as the blocklist — and the
 * WHATWG parser has its own opinions about which bytes delimit an authority.
 * Parsing against a fixed base and keeping only pathname + search + hash means
 * no authority survives whatever the input was: anything that parsed off the
 * base origin is discarded wholesale rather than pattern-matched away.
 */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return "/";
  let parsed: URL;
  try {
    parsed = new URL(raw, SAFE_NEXT_BASE);
  } catch {
    return "/";
  }
  // A slash- or backslash-smuggled authority parses into `host`, moving the
  // result off the base origin — that is not a local path whatever it looks
  // like as a string.
  if (parsed.origin !== SAFE_NEXT_BASE) return "/";
  const path = parsed.pathname + parsed.search + parsed.hash;
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  // Landing back on the login page would read to the operator as a failed login.
  if (path === "/login.html" || path.startsWith("/login.html?")) return "/";
  return path;
}
