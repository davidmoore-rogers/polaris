/**
 * src/utils/wildcard.ts — operator-supplied pattern compilation.
 *
 * Lived in autoMonitorInterfacesService until the contact device filter needed
 * the same `matches` semantics: the flat tag-criteria builder has always
 * offered a wildcard operator, and the condition tree gained one so a legacy
 * contact filter folds forward losslessly. A second copy of this compile is
 * exactly how "matches" would come to mean two things, so the interface
 * auto-monitor selection, tag criteria, the app-map discovery rules and the
 * condition tree all resolve one pattern the same way.
 *
 * A util rather than a service because notificationTypes evaluates the tree and
 * must not pull `db.js` in behind a pattern compile.
 */

import { AppError } from "./errors.js";

/**
 * Cap on an operator-supplied pattern. Every consumer matches SHORT strings
 * (ifNames, mount paths, hostnames, unit names), so no legitimate pattern comes
 * near this — it exists to bound what a single stored value can cost.
 *
 * On the raw-regex path this is a mitigation, not a cure: catastrophic
 * backtracking is exponential in INPUT length, so a length cap on the pattern
 * bounds the constant factor and nothing more. That is a deliberate call rather
 * than an oversight. Authoring a regex here requires `integrations:write` /
 * `applicationMap:write` / tag-management, and an operator holding any of those
 * can already run arbitrary code through the AutomationScript registry — so a
 * pathological regex costs them their own discovery loop, and does not cross a
 * privilege boundary. Removing the feature or taking a native linear-time
 * engine (re2) as a dependency would both cost more than the risk they retire.
 * The compile itself stays wrapped so a malformed pattern is a 400 at save
 * time, not a throw inside a discovery run.
 */
export const MAX_PATTERN_LENGTH = 512;

/**
 * Compile a shell-style wildcard ("port4*", "wan?") into an anchored regex.
 * Escapes regex metacharacters so e.g. "port[1]" matches the literal string,
 * not a character class.
 */
export function compileWildcard(pattern: string): RegExp {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new AppError(400, "Empty wildcard pattern");
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new AppError(400, `Wildcard pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
  }
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if ("^$.|+()[]{}\\".includes(ch)) out += "\\" + ch;
    else out += ch;
  }
  try {
    return new RegExp("^" + out + "$");
  } catch (err: any) {
    throw new AppError(400, `Invalid wildcard "${pattern}": ${err?.message || "regex compile failed"}`);
  }
}

/**
 * Compile an operator-supplied pattern, dispatching on the `regex` flag.
 * Wildcards are anchored (existing behavior). Regex is anchor-free — the
 * operator can include ^ and $ themselves if they want full-string match.
 * Either way the result is a usable RegExp that the resolver feeds ifNames to.
 */
export function compilePattern(pattern: string, regex: boolean): RegExp {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new AppError(400, "Empty pattern");
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new AppError(400, `Pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
  }
  if (!regex) return compileWildcard(pattern);
  try {
    return new RegExp(pattern);
  } catch (err: any) {
    throw new AppError(400, `Invalid regex "${pattern}": ${err?.message || "regex compile failed"}`);
  }
}
