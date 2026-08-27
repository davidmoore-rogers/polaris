/**
 * src/utils/severityStyle.ts — one severity → colour map for every surface
 * that paints an alert OUTSIDE the browser: Teams cards and alert emails.
 * (In-browser surfaces use the `.badge-level-*` / `.sev-*` CSS classes in
 * styles.css, which stay the source of truth there — including the acknowledge
 * page, which is an ordinary logged-in page since business rule 25 and so
 * reads the same tokens the in-app badges do.)
 *
 * Pure. Kept apart from the notification services so the email builder can use
 * it without dragging Prisma in.
 */

/** Hex WITHOUT a leading "#" — the shape Teams MessageCard themeColor wants. */
const SEVERITY_HEX: Record<string, string> = {
  // current notification severities
  notice: "6b7280",
  informational: "2563eb",
  warning: "d97706",
  serious: "ea580c",
  critical: "dc2626",
  // the engine's pseudo-severity for a recovery
  resolved: "16a34a",
  // legacy audit-event levels (pre-migration rows / event payloads)
  info: "2563eb",
  error: "dc2626",
};

const FALLBACK_HEX = "808080";

export function severityHex(severity: string | null | undefined): string {
  return SEVERITY_HEX[String(severity ?? "")] ?? FALLBACK_HEX;
}

/** Same colour, CSS-ready. */
export function severityCss(severity: string | null | undefined): string {
  return `#${severityHex(severity)}`;
}
