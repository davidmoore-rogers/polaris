/**
 * src/utils/alertSubject.ts — what an alert is ABOUT, as a label.
 *
 * Most alerts are about a device and the subject is its hostname. Event-
 * triggered alerts are the exception: an event automation fires on whatever the
 * audit Event happened to (an integration, a user, a backup) and plenty of the
 * seeded ones fire on `resourceType: "system"` — Polaris itself. Those Events
 * carry NO resourceName (there is nothing to name; it's this install), so the
 * subject came out empty and the email led with a blank line: no headline, a
 * subject line reading "[WARNING]  — Capacity severity escalated", and nothing
 * anywhere in the body saying the alert was about the Polaris server rather
 * than about somebody's switch.
 *
 * Naming it here rather than at the one call site keeps the label identical
 * across the fields that have to agree — the template context's {asset}, the
 * Notification.assetHostname the in-app and mobile lists render, and the
 * event-path cooldown key, which dedupes on assetId-or-hostname and would stop
 * matching across ticks if the stored row and the in-batch key disagreed.
 */

/**
 * The Polaris install itself, as an alert subject.
 *
 * "server" and not the "Polaris host" wording of `triggerSubject` /  the wizard
 * ("the Polaris host's CPU utilization"): that phrase reads naturally as a
 * possessive mid-sentence, but as a standalone subject line in an inbox
 * "Polaris host" invites reading it as a monitored machine named Polaris. This
 * label's whole job is to be unmistakable at a glance.
 */
export const POLARIS_SELF_LABEL = "Polaris server";

/** Audit resourceTypes that mean "Polaris itself", not a thing Polaris tracks. */
const SELF_RESOURCE_TYPES = new Set(["system"]);

/**
 * The subject label for an event-triggered alert: the resource's own name when
 * the Event named one, the Polaris-self label for a system-scoped Event, and ""
 * otherwise — an unnamed resource of a known type has nothing honest to say, so
 * the header line and facts row prune away rather than inventing a subject.
 */
export function eventSubjectLabel(
  resourceType: string | null | undefined,
  resourceName: string | null | undefined,
): string {
  const name = resourceName?.trim();
  if (name) return name;
  return SELF_RESOURCE_TYPES.has((resourceType ?? "").trim()) ? POLARIS_SELF_LABEL : "";
}
