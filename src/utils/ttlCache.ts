/**
 * src/utils/ttlCache.ts
 *
 * Tiny promise-aware TTL memo for read-mostly aggregates (dashboard feeds).
 * getOrCompute() returns the cached promise while the entry is fresh — an
 * in-flight computation counts as fresh, so concurrent callers share ONE
 * upstream computation instead of stampeding. Rejected computations are
 * evicted immediately (errors are never cached). Entries are evicted
 * oldest-first past maxEntries so an unbounded key space (per-filter cache
 * keys) can't grow without limit.
 */

export interface TtlCache<T> {
  /** Return the fresh cached value for `key`, or compute + cache it. */
  getOrCompute(key: string, compute: () => Promise<T>): Promise<T>;
  /** Drop one key, or the whole cache when no key is given. */
  invalidate(key?: string): void;
  /** Number of live (possibly stale) entries — for tests/diagnostics. */
  size(): number;
}

interface Entry<T> {
  at: number;
  promise: Promise<T>;
}

export function createTtlCache<T>(opts: { ttlMs: number; maxEntries?: number }): TtlCache<T> {
  const { ttlMs } = opts;
  const maxEntries = opts.maxEntries ?? 256;
  const entries = new Map<string, Entry<T>>();

  return {
    getOrCompute(key: string, compute: () => Promise<T>): Promise<T> {
      const now = Date.now();
      const hit = entries.get(key);
      if (hit && now - hit.at < ttlMs) return hit.promise;

      const promise = compute();
      // Delete-then-set so a refreshed key moves to the end of the Map's
      // insertion order (oldest-first eviction stays correct).
      entries.delete(key);
      entries.set(key, { at: now, promise });
      // Never cache a rejection — the next caller retries. Guard on identity
      // so a slow failure can't evict a newer entry for the same key.
      promise.catch(() => {
        const cur = entries.get(key);
        if (cur && cur.promise === promise) entries.delete(key);
      });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return promise;
    },
    invalidate(key?: string): void {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
    size(): number {
      return entries.size;
    },
  };
}
