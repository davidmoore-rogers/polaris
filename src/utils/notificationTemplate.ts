/**
 * src/utils/notificationTemplate.ts
 *
 * Shared variable-token vocabulary + renderer for notification templating:
 * the in-app messageTemplate, rule-level email composition (subject / text /
 * HTML bodies), and escalation-tier overrides all render through here so the
 * token vocabulary lives in exactly one place. Syntax is single-brace
 * `{token}` (consistent with the original messageTemplate tokens — NOT
 * `{{ }}`). Unknown tokens are left literal so a typo stays visible in the
 * delivered message instead of silently vanishing.
 *
 * The engine snapshots the built context onto Notification.templateCtx at
 * fire time (when the rule has emailComposition/escalation), so escalation
 * emails render at T+delay with the exact fire-time values even if the asset
 * has since been deleted.
 */

export interface TemplateVariable {
  token: string;
  label: string;
  description: string;
  group: "notification" | "rule" | "asset" | "escalation";
}

/**
 * The token catalog — single source of truth, surfaced to the rule-builder UI
 * via buildSchemaCatalog().templateVariables. Adding a token requires a
 * matching key in buildTemplateContext() (and, for asset-sourced tokens, the
 * asset-detail select in notificationEngine).
 *
 * ONE DELIBERATE EXCEPTION: `{ack}` has NO key in buildTemplateContext. Its
 * value is per-RECIPIENT (a single-use token bound to one user), while the
 * context is built once per fire and snapshotted onto Notification.templateCtx
 * — shared by every recipient and persisted. Giving it a context key would
 * render it to "" at compose time and leave nothing for the later pass to
 * substitute. It is filled instead by substituteAckToken() during delivery
 * expansion, which works precisely because unknown tokens are left literal.
 */
export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  { token: "{asset}", label: "Asset", description: "Asset hostname (or id / \"host\")", group: "notification" },
  { token: "{metric}", label: "Metric", description: "Metric / field / event action that triggered", group: "notification" },
  { token: "{value}", label: "Value", description: "Observed value at fire time", group: "notification" },
  { token: "{threshold}", label: "Threshold", description: "Configured threshold / comparison value", group: "notification" },
  { token: "{dimension}", label: "Dimension", description: "Sub-asset dimension (interface / mount / sensor / tunnel)", group: "notification" },
  { token: "{conditions}", label: "Conditions", description: "Multi-condition summary, e.g. \"2 of 3 conditions met\" (composite triggers; empty otherwise)", group: "notification" },
  { token: "{message}", label: "Message", description: "The rendered in-app notification message", group: "notification" },
  { token: "{severity}", label: "Severity", description: "Rule severity (e.g. warning)", group: "notification" },
  { token: "{severity.upper}", label: "SEVERITY", description: "Rule severity upper-cased (e.g. WARNING)", group: "notification" },
  { token: "{time}", label: "Time", description: "Trigger time (ISO-8601)", group: "notification" },
  { token: "{link}", label: "Link", description: "Notifications page URL (empty if POLARIS_PUBLIC_URL unset)", group: "notification" },
  { token: "{ack}", label: "Acknowledge link", description: "One-click acknowledge URL — resolved per recipient at send time. Empty for address-book/typed recipients (only Polaris users can acknowledge) and when POLARIS_PUBLIC_URL is unset", group: "notification" },
  { token: "{asset.link}", label: "Open asset", description: "URL that opens this device in Polaris (empty if POLARIS_PUBLIC_URL unset)", group: "asset" },
  { token: "{asset.connectedSwitch}", label: "Connected switch", description: "Switch/port the device was last seen on, e.g. FS-248E-01/port15", group: "asset" },
  { token: "{asset.connectedAp}", label: "Connected AP", description: "Access point the device was last seen on", group: "asset" },
  { token: "{rule}", label: "Rule name", description: "Name of the triggering rule", group: "rule" },
  { token: "{rule.description}", label: "Rule description", description: "Description of the triggering rule", group: "rule" },
  { token: "{asset.ip}", label: "Asset IP", description: "Primary IP address", group: "asset" },
  { token: "{asset.mac}", label: "Asset MAC", description: "MAC address", group: "asset" },
  { token: "{asset.type}", label: "Asset type", description: "Asset type (e.g. firewall)", group: "asset" },
  { token: "{asset.status}", label: "Asset status", description: "Lifecycle status (e.g. active)", group: "asset" },
  { token: "{asset.location}", label: "Asset location", description: "Location (operator-set, falling back to learned)", group: "asset" },
  { token: "{asset.manufacturer}", label: "Manufacturer", description: "Asset manufacturer", group: "asset" },
  { token: "{asset.model}", label: "Model", description: "Asset model", group: "asset" },
  { token: "{asset.serial}", label: "Serial", description: "Asset serial number", group: "asset" },
  { token: "{asset.os}", label: "OS", description: "Operating system", group: "asset" },
  { token: "{asset.osVersion}", label: "OS version", description: "Operating system version", group: "asset" },
  { token: "{asset.department}", label: "Department", description: "Asset department", group: "asset" },
  { token: "{asset.assignedTo}", label: "Assigned to", description: "Person the asset is assigned to", group: "asset" },
  { token: "{asset.tags}", label: "Asset tags", description: "Asset tags, comma-joined", group: "asset" },
  { token: "{escalation.tier}", label: "Escalation tier", description: "Escalation tier number (empty on the initial email)", group: "escalation" },
  { token: "{escalation.elapsed}", label: "Escalation elapsed", description: "Time since the notification fired (e.g. 1h 30m)", group: "escalation" },
];

/** Escape a string for safe embedding in HTML text/attribute content. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Asset fields the template context draws on (subset of the Asset row). */
export interface AssetTemplateDetail {
  /** Needed for {asset.link}; the rest are rendered directly. */
  id?: string | null;
  ipAddress?: string | null;
  macAddress?: string | null;
  /** "<switch>/port<N>" — where the device was last seen wired. */
  lastSeenSwitch?: string | null;
  /** The AP the device was last seen associated with. */
  lastSeenAp?: string | null;
  assetType?: string | null;
  status?: string | null;
  location?: string | null;
  learnedLocation?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  os?: string | null;
  osVersion?: string | null;
  department?: string | null;
  assignedTo?: string | null;
  tags?: string[] | null;
}

export interface TemplateContextParts {
  /** The `{asset}` label — hostname / assetId / "host". */
  asset?: string;
  metric?: string;
  value?: string;
  threshold?: string;
  dimension?: string;
  /** Composite triggers only — "k of n conditions met". */
  conditions?: string;
  message?: string;
  severity?: string;
  time?: Date | string;
  link?: string | null;
  ruleName?: string;
  ruleDescription?: string | null;
  assetDetail?: AssetTemplateDetail | null;
  escalationTier?: number;
  escalationElapsed?: string;
}

const str = (v: string | null | undefined): string => v ?? "";

/**
 * Flatten the fire-time parts into the token→string map the renderer consumes.
 * Every cataloged token gets a key (missing parts render as ""), so the map
 * serializes cleanly onto Notification.templateCtx.
 */
export function buildTemplateContext(parts: TemplateContextParts): Record<string, string> {
  const a = parts.assetDetail;
  const severity = str(parts.severity);
  const time = parts.time instanceof Date ? parts.time.toISOString() : str(parts.time);
  return {
    "asset": str(parts.asset),
    "metric": str(parts.metric),
    "value": str(parts.value),
    "threshold": str(parts.threshold),
    "dimension": str(parts.dimension),
    "conditions": str(parts.conditions),
    "message": str(parts.message),
    "severity": severity,
    "severity.upper": severity.toUpperCase(),
    "time": time,
    "link": str(parts.link),
    "rule": str(parts.ruleName),
    "rule.description": str(parts.ruleDescription),
    "asset.ip": str(a?.ipAddress),
    "asset.mac": str(a?.macAddress),
    "asset.type": str(a?.assetType),
    "asset.status": str(a?.status),
    "asset.location": str(a?.location ?? a?.learnedLocation),
    "asset.manufacturer": str(a?.manufacturer),
    "asset.model": str(a?.model),
    "asset.serial": str(a?.serialNumber),
    "asset.os": str(a?.os),
    "asset.osVersion": str(a?.osVersion),
    "asset.department": str(a?.department),
    "asset.assignedTo": str(a?.assignedTo),
    "asset.tags": (a?.tags ?? []).join(", "),
    "asset.connectedSwitch": str(a?.lastSeenSwitch),
    "asset.connectedAp": str(a?.lastSeenAp),
    "asset.link": a?.id ? (assetPageUrl(a.id) ?? "") : "",
    // NOTE: no "ack" key — see the TEMPLATE_VARIABLES comment. It is
    // substituted per recipient at delivery-expansion time.
    "escalation.tier": parts.escalationTier !== undefined ? String(parts.escalationTier) : "",
    "escalation.elapsed": str(parts.escalationElapsed),
  };
}

const TOKEN_RE = /\{([a-zA-Z][\w.]*)\}/g;

/**
 * Render a template against a context map. Single regex pass — substituted
 * values are never re-interpolated (a value containing "{threshold}" stays
 * literal). Unknown tokens are left as-is. With opts.html, interpolated
 * VALUES are HTML-escaped; the operator's own template markup is not.
 */
export function renderNotificationTemplate(
  template: string,
  ctx: Record<string, string>,
  opts?: { html?: boolean },
): string {
  return template.replace(TOKEN_RE, (match, name: string) => {
    if (!(name in ctx)) return match;
    const v = ctx[name];
    return opts?.html ? escapeHtml(v) : v;
  });
}

/** Do any of these templates reference an `{asset.*}` detail token? */
export function templateNeedsAsset(templates: Array<string | null | undefined>): boolean {
  return templates.some((t) => typeof t === "string" && /\{asset\.[\w.]*\}/.test(t));
}

/** Automations-page (Alerts tab) URL for the {link} token + the "View:" footer
 *  (null when POLARIS_PUBLIC_URL is unset). Renamed page; the server keeps a
 *  permanent /notifications.html redirect for links already delivered. */
export function notificationsPageUrl(): string | null {
  const base = process.env.POLARIS_PUBLIC_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/automations.html`;
}

/**
 * URL that opens ONE device in Polaris — the hash form app.js's
 * processSearchHash already understands, so an emailed link lands on the
 * asset's slide-over rather than a list the reader has to search.
 * Null when POLARIS_PUBLIC_URL is unset (a relative URL is useless in mail).
 */
export function assetPageUrl(assetId: string | null | undefined): string | null {
  const base = process.env.POLARIS_PUBLIC_URL;
  if (!base || !assetId) return null;
  return `${base.replace(/\/$/, "")}/assets.html#view=asset:${encodeURIComponent(assetId)}`;
}

/**
 * One-click acknowledge URL for an EMAIL recipient. Null without a public URL,
 * mirroring notificationsPageUrl: a relative link in a mail client resolves
 * against nothing.
 */
export function ackUrlForEmail(token: string): string | null {
  const base = process.env.POLARIS_PUBLIC_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/ack/${encodeURIComponent(token)}`;
}

/**
 * Same link for a WEB PUSH payload. Never null — like pushDeepLinkUrl it falls
 * back to a relative path, which the service worker resolves against its own
 * origin, so push acknowledgement keeps working on installs that never set a
 * public URL.
 */
export function ackUrlForPush(token: string): string {
  const base = process.env.POLARIS_PUBLIC_URL;
  const path = `/ack/${encodeURIComponent(token)}`;
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

const ACK_TOKEN_RE = /\{ack\}/g;

/**
 * Fill the deferred `{ack}` token once the recipient is known. Called at
 * delivery expansion, not at compose time — see the TEMPLATE_VARIABLES note.
 * A null url (recipient can't acknowledge, or no public URL) renders empty, so
 * a template that mentions {ack} degrades to a body without a link rather than
 * showing the literal token to a contact who could never use it.
 */
export function substituteAckToken(
  text: string,
  url: string | null,
  opts?: { html?: boolean },
): string {
  if (!text) return text;
  const value = url ?? "";
  return text.replace(ACK_TOKEN_RE, opts?.html ? escapeHtml(value) : value);
}

/** Where a push notification should land, per enrolling surface. */
export const PUSH_DEEP_LINK_PATHS = {
  desktop: "/automations.html",
  mobile: "/mobile.html#more/alerts",
} as const;

export type PushSurface = keyof typeof PUSH_DEEP_LINK_PATHS;

export function normalizePushSurface(value: unknown): PushSurface {
  return value === "mobile" ? "mobile" : "desktop";
}

/**
 * Deep link for a web-push payload. Unlike `notificationsPageUrl` this NEVER
 * returns null: when POLARIS_PUBLIC_URL is unset we emit a relative path,
 * which the service worker resolves fine via client.navigate()/openWindow().
 * That also removes the old failure mode where an unset public URL sent every
 * push to sw.js's hardcoded desktop fallback regardless of surface.
 */
export function pushDeepLinkUrl(surface: unknown): string {
  const path = PUSH_DEEP_LINK_PATHS[normalizePushSurface(surface)];
  const base = process.env.POLARIS_PUBLIC_URL;
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

/** "92m" → "1h 32m"-style elapsed formatting for {escalation.elapsed}. */
export function formatElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}
