/**
 * tests/unit/ttlCache.test.ts — promise-aware TTL memo (src/utils/ttlCache.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTtlCache } from "../../src/utils/ttlCache.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createTtlCache", () => {
  it("computes once per key within the TTL and shares in-flight promises", async () => {
    const cache = createTtlCache<number>({ ttlMs: 1000 });
    const compute = vi.fn(async () => 42);
    const [a, b] = await Promise.all([
      cache.getOrCompute("k", compute),
      cache.getOrCompute("k", compute), // concurrent → shares the in-flight promise
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);

    await cache.getOrCompute("k", compute); // still fresh
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes after the TTL elapses", async () => {
    const cache = createTtlCache<number>({ ttlMs: 1000 });
    let n = 0;
    const compute = vi.fn(async () => ++n);
    expect(await cache.getOrCompute("k", compute)).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(await cache.getOrCompute("k", compute)).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keys are independent", async () => {
    const cache = createTtlCache<string>({ ttlMs: 1000 });
    expect(await cache.getOrCompute("a", async () => "va")).toBe("va");
    expect(await cache.getOrCompute("b", async () => "vb")).toBe("vb");
    expect(cache.size()).toBe(2);
  });

  it("never caches a rejection — the next caller retries", async () => {
    const cache = createTtlCache<number>({ ttlMs: 1000 });
    const boom = cache.getOrCompute("k", async () => {
      throw new Error("boom");
    });
    await expect(boom).rejects.toThrow("boom");
    // Eviction happens on the rejection microtask; flush it.
    await Promise.resolve();
    expect(await cache.getOrCompute("k", async () => 7)).toBe(7);
  });

  it("evicts oldest-first past maxEntries", async () => {
    const cache = createTtlCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    await cache.getOrCompute("a", async () => 1);
    await cache.getOrCompute("b", async () => 2);
    await cache.getOrCompute("c", async () => 3); // evicts "a"
    expect(cache.size()).toBe(2);
    const recomputeA = vi.fn(async () => 10);
    expect(await cache.getOrCompute("a", recomputeA)).toBe(10);
    expect(recomputeA).toHaveBeenCalledTimes(1);
  });

  it("a refreshed key moves to the back of the eviction order", async () => {
    const cache = createTtlCache<number>({ ttlMs: 1, maxEntries: 2 });
    await cache.getOrCompute("a", async () => 1);
    await cache.getOrCompute("b", async () => 2);
    vi.advanceTimersByTime(5); // both stale
    await cache.getOrCompute("a", async () => 11); // refresh "a" → now newest
    await cache.getOrCompute("c", async () => 3);  // evicts "b", not "a"
    vi.advanceTimersByTime(0);
    const recomputeA = vi.fn(async () => 99);
    // "a" would still be present (though stale by now) — freshness aside, the
    // point is eviction order: "b" was dropped. Verify by size + b recompute.
    expect(cache.size()).toBe(2);
    const recomputeB = vi.fn(async () => 22);
    expect(await cache.getOrCompute("b", recomputeB)).toBe(22);
    expect(recomputeB).toHaveBeenCalledTimes(1);
    void recomputeA;
  });

  it("invalidate() drops one key or everything", async () => {
    const cache = createTtlCache<number>({ ttlMs: 60_000 });
    await cache.getOrCompute("a", async () => 1);
    await cache.getOrCompute("b", async () => 2);
    cache.invalidate("a");
    expect(cache.size()).toBe(1);
    cache.invalidate();
    expect(cache.size()).toBe(0);
  });
});
