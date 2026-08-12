/**
 * Small numeric reducers shared by the notification engine's aggregation paths.
 *
 * `median` exists as a util (rather than inline in the engine) because the
 * engine aggregates in two structurally different places — per-dimension
 * asset_metric groups and the flat host_metric row set — and a duty-cycle-free
 * middle value is exactly the kind of thing that goes subtly wrong when it's
 * written twice (off-by-one on the even-length midpoint, forgetting to sort a
 * copy and mutating the caller's array).
 */

/**
 * Median of `values`; `null` for an empty set (mirrors how the engine treats an
 * empty window — no reading, not zero). Even-length sets average the two middle
 * values. Sorts a copy — never mutates the input.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
