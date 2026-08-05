/**
 * src/utils/chunk.ts — array batching for chunked DB writes / paced fan-outs.
 *
 * Replaces the hand-rolled `for (let i = 0; i < xs.length; i += N)` +
 * `xs.slice(i, i + N)` loops scattered across services (2026-08 audit).
 * Error semantics stay with the caller — this only owns the slicing.
 */

/** Split items into consecutive chunks of at most `size` (last may be short). */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isFinite(size) || size < 1) throw new RangeError(`chunkArray: size must be >= 1 (got ${size})`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
