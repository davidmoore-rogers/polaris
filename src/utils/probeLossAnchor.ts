/**
 * src/utils/probeLossAnchor.ts
 *
 * The two halves of the packet-loss ratio's RECOVERY anchor (business rule
 * 29b), as pure functions: the WRITER's predicate (does this probe end an
 * outage, i.e. stamp `Asset.recoveryStartedAt`?) and the READER's anchor
 * arithmetic (which sample does the measurement start at?).
 *
 * They live together because they are one decision seen from two sides, and
 * they are extracted at all because each is a one-liner whose failure mode is
 * silent. Stamp on the wrong transition and a flapping device's window
 * collapses to its last few probes, reporting ~0% loss forever; take the wrong
 * side of the anchor and the alert email's chart contradicts the reading that
 * fired it.
 *
 * The SQL half of the reader lives in `services/probeLossQuery.ts` as
 * `GREATEST("firstOk", "recoveredAt")` — Postgres's GREATEST ignores NULLs,
 * which is exactly what `effectiveLossAnchorMs` reproduces.
 */

/**
 * Does a probe with this outcome, arriving in this state, end an outage?
 *
 * True only for a success out of `down` or `unknown` — the states a device
 * leaves without having been answering. That covers both shapes of a recovery:
 * the usual one into `recovering`, and the `failureThreshold === 1` case that
 * goes straight to `up`.
 *
 * Deliberately FALSE for a success out of `warning`: warning means the device
 * is still answering some probes, so its failures are loss rather than an
 * outage — and a lossy device passes through warning constantly, so stamping
 * there would restart the loss window every few probes and read ~0% forever.
 */
export function stampsRecoveryAnchor(
  previousStatus: string | null | undefined,
  success: boolean,
): boolean {
  if (!success) return false;
  return previousStatus === "down" || previousStatus === "unknown" || previousStatus == null;
}

/**
 * Where the measurement starts, in epoch ms: the LATER of the window's first
 * successful probe and the end of the last outage. Null when nothing answered
 * in the window — the caller decides what that means (the engine drops the
 * asset, display paths keep every row and read 100%).
 *
 * A recovery stamp older than the window is inert (every sample already sits
 * after it), which is what makes this a no-op for a device that has not
 * recovered recently. The `max` also means a stamp that somehow predates the
 * first success can never widen the window backwards.
 */
export function effectiveLossAnchorMs(
  firstOkMs: number | null,
  recoveryMs: number | null,
): number | null {
  if (firstOkMs === null) return null;
  return recoveryMs === null ? firstOkMs : Math.max(firstOkMs, recoveryMs);
}
