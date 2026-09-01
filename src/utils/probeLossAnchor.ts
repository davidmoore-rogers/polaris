/**
 * src/utils/probeLossAnchor.ts
 *
 * The WRITER half of what used to be the packet-loss recovery anchor: does this
 * probe end an outage, i.e. stamp `Asset.recoveryStartedAt`?
 *
 * THE READER HALF IS GONE (2026-09-01). Until then the loss ratio started at
 * GREATEST(first success in window, recoveryStartedAt), discarding any outage
 * inside the window so a device coming back from one did not read ~92% and
 * alert because it had recovered. That trim also silenced a device flapping to
 * `down` every cycle — each recovery re-stamped the column, collapsing the
 * window to the last few probes and reporting ~0% loss forever — so the
 * measurement is now plainly failed/total over the whole window, and the false
 * alert it prevented is handled in the engine instead, by the answering gate
 * and the `ignoreAtOrAbove` ceiling (business rule 29).
 *
 * `Asset.recoveryStartedAt` is therefore DORMANT: still stamped here, because it
 * records a genuine fact for one field on a patch the probe path already writes,
 * and read by nothing. Kept rather than ripped out on the `cooldownSec`
 * precedent — with the difference that makes keeping it safe: a dormant
 * timestamp cannot change behaviour, where a dormant cooldown silenced alerts.
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
