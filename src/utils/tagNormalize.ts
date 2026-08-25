/**
 * src/utils/tagNormalize.ts
 *
 * Shared normalization for the operator-typed tag dimensions carried by Role,
 * User, and GroupMapping: region tags and free-form ("other") tags. Trim, drop
 * empties, dedupe case-insensitively (first-seen casing wins), cap per-tag
 * length and total count. Extracted from roleService.normalizeRegionTags so
 * every tag writer (roleService, userService, groupMappingService) shares one
 * rule set.
 *
 * Neither dimension is FK'd to a registry: region names can be pre-assigned
 * before a map polygon is drawn, and "other" tags are intentionally free-form.
 */

import { AppError } from "./errors.js";

export const TAG_MAX_LEN = 64;
export const TAGS_MAX_COUNT = 64;

/**
 * The prefix an ASSET's region tag carries. `User`/`Role`/`GroupMapping`
 * `regionTags` store bare names, so anything comparing the two sides strips it
 * first.
 *
 * Lives in this leaf util rather than in `notificationService` (which still
 * re-exports it for its existing importers) because `regionHierarchyService`
 * needs it on the alert-routing path, and notificationService imports
 * notificationRuleService — importing it from there would have closed a
 * notificationRuleService → regionHierarchyService → notificationService →
 * notificationRuleService cycle.
 */
export const REGION_TAG_PREFIX = "region:";

/** Strip the `region:` prefix from a map-region tag (case-insensitive). */
export function stripRegionPrefix(tag: string): string {
  return tag.toLowerCase().startsWith(REGION_TAG_PREFIX)
    ? tag.slice(REGION_TAG_PREFIX.length)
    : tag;
}

/**
 * Validate + normalize a list of operator-typed tags. `label` only shapes the
 * error message (e.g. "region tag" → "Region tag ... exceeds 64 characters").
 */
export function normalizeTags(input: unknown, label = "tag"): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > TAG_MAX_LEN) {
      const pretty = label.charAt(0).toUpperCase() + label.slice(1);
      throw new AppError(400, `${pretty} "${trimmed.slice(0, 32)}..." exceeds ${TAG_MAX_LEN} characters`);
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  if (out.length > TAGS_MAX_COUNT) {
    throw new AppError(400, `At most ${TAGS_MAX_COUNT} ${label}s allowed`);
  }
  return out;
}

/**
 * Union one or more tag lists into a single deduped, case-insensitively unique,
 * sorted list. Used to compute a session's effective scope from the
 * role / user / group-derived sources at GET /auth/me. First-seen casing wins.
 */
export function unionTags(...lists: (readonly string[] | null | undefined)[]): string[] {
  const seen = new Map<string, string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) seen.set(key, trimmed);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}
