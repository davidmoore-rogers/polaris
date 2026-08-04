/**
 * src/utils/text.ts — tiny shared string/param helpers that were each
 * re-implemented in multiple route/service files (2026-08 audit).
 */

/**
 * Truncate to `max` characters with a trailing ellipsis. The ellipsis is
 * appended (historical behavior of the three private copies this replaces)
 * so the result can be max+1 chars — display-only helper, not a validator.
 */
export function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/**
 * Parse a comma-separated query param into a trimmed, non-empty string
 * array, or undefined when the param is absent/blank/all-empty. Canonical
 * for the route-file csv splitters (events/assets csvToArray, dashboard's
 * null-returning wrapper); the variants with different contracts
 * (notifications' []-on-all-empty, map's []-default, dashboard's
 * validating parseSourceTypesParam) deliberately keep their own shapes.
 */
export function csvParam(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}
