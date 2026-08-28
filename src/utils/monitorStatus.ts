/**
 * src/utils/monitorStatus.ts
 *
 * The monitor state vocabulary and the pure predicates that read it. Lives in
 * utils (like probeLossAnchor) so the state machine, the probe-patch buffer,
 * the two due-set builders and the tests can all share ONE definition — the
 * union used to be spelled out in three places, which is how a sixth state gets
 * added to two of them.
 *
 * The six states:
 *
 *   up          — answering, and it has answered `failureThreshold` times in a row
 *   warning     — answering intermittently: 1..threshold-1 consecutive misses.
 *                 Operator-facing label is "Missed" (MONITOR_STATUS_LABELS) —
 *                 "Warning" collided with the alert severity of the same name,
 *                 so a pill reading Warning looked like a fired alert rather
 *                 than a missed poll. The stored value is unchanged.
 *   down        — `missedPolls` consecutive misses, per the covering automation
 *   recovering  — answering again after an outage, not yet back to `up`
 *   unknown     — nothing measured yet
 *   passive     — NOT a probe outcome. No down-detection automation covers this
 *                 device, so Polaris renders no verdict about it. It is still
 *                 polled and still charted; the counters still advance. See
 *                 downDetectionService.
 */

export type MonitorStatus = "up" | "warning" | "recovering" | "down" | "unknown" | "passive";

/** The states reachable by probing — i.e. everything except the config state. */
export const PROBE_MONITOR_STATUSES: readonly MonitorStatus[] = ["up", "warning", "recovering", "down", "unknown"];

/**
 * Operator-facing label for each state. ONE map so the assets pill, the search
 * hit pill, the alert-email trigger summary and the dashboard status tiles can
 * never disagree about what a state is called.
 *
 * `warning` reads "Missed" and `unknown` reads "Pending": both names describe
 * what the device did rather than the enum value, and "Warning" in particular
 * had to go — it is also an alert severity, so operators read the pill as
 * "an alert fired" when it only ever meant "a poll was missed".
 */
export const MONITOR_STATUS_LABELS: Record<MonitorStatus, string> = {
  up: "Up",
  warning: "Missed",
  recovering: "Recovering",
  down: "Down",
  unknown: "Pending",
  passive: "Passive",
};

/** Label for a raw status string; unrecognized values pass through unchanged. */
export function monitorStatusLabel(status: string | null | undefined): string {
  if (!status) return MONITOR_STATUS_LABELS.unknown;
  return (MONITOR_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

/**
 * Should the heavy cadences (telemetry / system info / interfaces / storage /
 * LLDP / processes) run for this asset?
 *
 * "up" is positive evidence the device is reachable, and that has always been
 * the gate. A PASSIVE device has no verdict to consult — but it is still being
 * polled, and its charts are supposed to keep filling, so falling back to the
 * raw signal we do have keeps the data flowing without pointing full SNMP walks
 * at a passive host that is currently dark.
 *
 * That raw signal is `consecutiveFailures === 0`, which since the leaky-bucket
 * change (business rule 30) reads "no missed polls outstanding" rather than
 * "the last probe succeeded" — a strictly stronger claim, and the right one
 * here: a device three misses deep that has answered once is still not somewhere
 * to point a full walk.
 *
 * Shared by the cursor pass (monitoringService.loadMonitorPassCandidates) and
 * the pg-boss publisher (jobs/monitorAssets) — two implementations that are
 * documented to stay in lockstep, which is exactly why this predicate is one
 * function rather than two copies of an `=== "up"` comparison.
 */
export function runsHeavyCadences(a: {
  monitorStatus: string | null;
  consecutiveFailures?: number | null;
  dependencySuppressed: boolean;
}): boolean {
  if (a.dependencySuppressed) return false;
  if (a.monitorStatus === "up") return true;
  return a.monitorStatus === "passive" && (a.consecutiveFailures ?? 0) === 0;
}

/**
 * Is entering or leaving this pair of states a CONFIGURATION edge rather than a
 * device edge? Passive is entered and left when an operator saves, rescopes or
 * deletes a down-detection automation — never because the device did anything.
 *
 * The distinction is load-bearing: one rule edit can move thousands of assets
 * across that line at once, and treating it as a device transition would burst
 * one `monitor.status_changed` Event and one dependency propagation per asset.
 * The rule-CRUD audit trail already records the cause.
 */
export function isConfigStatusEdge(previous: string | null, next: MonitorStatus): boolean {
  return previous === "passive" || next === "passive";
}
