/**
 * src/utils/manufacturerNormalize.ts
 *
 * Pure (no DB imports) cache + synchronous normalize() for manufacturer
 * strings. Lives in utils/ so the Prisma extension in db.ts can import it
 * without creating a cycle through the alias service.
 *
 * The cache is loaded by manufacturerAliasService.refreshAliasCache() at
 * startup and after every CRUD mutation. Until the cache is loaded,
 * normalizeManufacturer() falls back to the trimmed input — early writes
 * during boot are never lost.
 */

let _aliasMap: Map<string, string> | null = null;

/**
 * Replace the in-memory alias map. Called by the alias service after every
 * load/refresh. Keys are stored lowercased+trimmed; the canonical value is
 * preserved as-typed by the admin.
 */
export function setAliasMap(entries: Iterable<[string, string]>): void {
  const next = new Map<string, string>();
  for (const [alias, canonical] of entries) {
    const key = alias.trim().toLowerCase();
    if (!key) continue;
    next.set(key, canonical);
  }
  _aliasMap = next;
}

/**
 * Normalize a manufacturer string. Returns null/undefined unchanged so callers
 * can pass-through Prisma update fields where the field isn't being touched.
 *   - Trims whitespace.
 *   - Looks up the lowercased trimmed form in the alias map.
 *   - Returns the canonical value if matched, otherwise the trimmed input.
 *   - Empty/whitespace input → null.
 */
export function normalizeManufacturer(input: string): string;
export function normalizeManufacturer(input: null): null;
export function normalizeManufacturer(input: undefined): undefined;
export function normalizeManufacturer(input: string | null): string | null;
export function normalizeManufacturer(
  input: string | null | undefined,
): string | null | undefined;
export function normalizeManufacturer(
  input: string | null | undefined,
): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const map = _aliasMap;
  if (!map) return trimmed;
  return map.get(trimmed.toLowerCase()) ?? trimmed;
}

/** Test helper: clear the cache so the next normalize() falls through. */
export function _resetAliasMap(): void {
  _aliasMap = null;
}
