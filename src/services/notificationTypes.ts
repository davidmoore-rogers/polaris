/**
 * src/services/notificationTypes.ts
 *
 * Central vocabulary for the notification rules engine: the discriminated
 * `trigger` union, the asset `scope` selector, severities, clear behaviors,
 * and the operator/metric/field catalogs. Shared by the rule routes
 * (validation), the engine (evaluation), the rule service (scope match), and
 * the schema endpoint that drives the builder UI — so the vocabulary lives in
 * exactly one place and the frontend never hardcodes it.
 */

import { z } from "zod";
import { TEMPLATE_VARIABLES } from "../utils/notificationTemplate.js";

// Notification severity (rule.severity → notification.severity). Ordered
// least → most severe. NOTE: distinct from EVENT_LEVELS below — that's the
// audit-Event level vocabulary the `event` trigger's minLevel filters against.
export const SEVERITIES = ["notice", "informational", "warning", "serious", "critical"] as const;
// Audit-Event levels (logEvent), used only by the event-trigger minLevel filter.
export const EVENT_LEVELS = ["info", "warning", "error"] as const;
export const CLEAR_BEHAVIORS = ["manual", "auto", "timed"] as const;
export const COMPARATORS = [">", ">=", "<", "<=", "==", "!="] as const;
export const AGGREGATIONS = ["latest", "avg", "min", "max"] as const;

// ─── Asset-metric trigger ───────────────────────────────────────────────────
// Numeric thresholds over the telemetry / sample tables. `dimensionFilter`
// narrows multi-row streams (interfaces, sensors, mounts, SD-WAN members).
export const ASSET_METRICS = [
  "cpuPct", "memPct", "memUsedBytes", "sessionCount", "responseTimeMs", "uptimeSec",
  "hwSensorValue", "storageUsedPct", "storageUsedBytes",
  "ifInErrorRate", "ifOutErrorRate", "ifInBps", "ifOutBps",
  "sdwanLatencyMs", "sdwanJitterMs", "sdwanPacketLoss", "ipsecThroughputBps",
  "customWidgetValue",
] as const;

// ─── Asset-state trigger ────────────────────────────────────────────────────
// Current Asset (or current-state child row) field conditions.
export const ASSET_STATE_FIELDS = [
  "monitorStatus", "status", "consecutiveFailures", "dependencySuppressed", "quarantined",
  "ifOperStatus", "ifAdminStatus", "ipsecStatus", "sdwanRuleStatus", "sdwanSelectedMember",
] as const;

// ─── Host-metric trigger ────────────────────────────────────────────────────
// Polaris host health from HostMetricsSample.
export const HOST_METRICS = [
  "cpuPct", "memUsedPct", "memUsedBytes", "loadAvg1", "loadAvg5", "loadAvg15", "procRssBytes",
] as const;

// ─── Change trigger ─────────────────────────────────────────────────────────
// Sugar over emitted change-Events from the persist* functions.
export const CHANGE_TYPES = [
  "lldp_neighbor_added", "lldp_neighbor_removed",
  "process_started", "process_stopped",
  "sdwan_failover", "mclag_peer_lost", "wireless_station_connected",
] as const;

// Map a change type → the audit Event action the persist functions emit and
// the event path matches on. Single source of truth for both ends.
export const CHANGE_TYPE_ACTIONS: Record<(typeof CHANGE_TYPES)[number], string> = {
  lldp_neighbor_added: "change.lldp.neighbor_added",
  lldp_neighbor_removed: "change.lldp.neighbor_removed",
  process_started: "change.process.started",
  process_stopped: "change.process.stopped",
  sdwan_failover: "change.sdwan.failover",
  mclag_peer_lost: "change.mclag.peer_lost",
  wireless_station_connected: "change.wireless.station_connected",
};

const dimensionFilterSchema = z
  .object({
    ifNamePattern: z.string().max(200).optional(),
    sensorClass: z.enum(["temperature", "fan", "voltage", "power", "disk", "other"]).optional(),
    mountPathPattern: z.string().max(200).optional(),
    healthCheck: z.string().max(200).optional(),
    link: z.string().max(200).optional(),
    tunnelName: z.string().max(200).optional(),
    widgetId: z.string().max(200).optional(),
    processNamePattern: z.string().max(200).optional(),
  })
  .strict()
  .optional();

const assetMetricTrigger = z.object({
  type: z.literal("asset_metric"),
  metric: z.enum(ASSET_METRICS),
  aggregation: z.enum(AGGREGATIONS).default("latest"),
  windowSec: z.number().int().min(0).max(86400).default(0),
  operator: z.enum(COMPARATORS),
  threshold: z.number(),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
  dimensionFilter: dimensionFilterSchema,
});

const assetStateTrigger = z.object({
  type: z.literal("asset_state"),
  field: z.enum(ASSET_STATE_FIELDS),
  operator: z.enum(COMPARATORS),
  // string for enum-like fields (monitorStatus), number for counters, bool for flags
  value: z.union([z.string().max(200), z.number(), z.boolean()]),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
  dimensionFilter: dimensionFilterSchema,
});

const hostMetricTrigger = z.object({
  type: z.literal("host_metric"),
  metric: z.enum(HOST_METRICS),
  aggregation: z.enum(AGGREGATIONS).default("latest"),
  windowSec: z.number().int().min(0).max(86400).default(0),
  operator: z.enum(COMPARATORS),
  threshold: z.number(),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
});

const eventTrigger = z.object({
  type: z.literal("event"),
  actionPattern: z.string().min(1).max(200), // glob, e.g. "integration.test.*"
  resourceType: z.string().max(100).optional(),
  minLevel: z.enum(EVENT_LEVELS).optional(),
  detailsMatch: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const changeTrigger = z.object({
  type: z.literal("change"),
  changeType: z.enum(CHANGE_TYPES),
  dimensionFilter: dimensionFilterSchema,
});

export const triggerSchema = z.discriminatedUnion("type", [
  assetMetricTrigger,
  assetStateTrigger,
  hostMetricTrigger,
  eventTrigger,
  changeTrigger,
]);

export const scopeSchema = z
  .object({
    allAssets: z.boolean().optional(),
    assetTypes: z.array(z.string().max(100)).max(100).optional(),
    tags: z.array(z.string().max(100)).max(200).optional(),
    assetIds: z.array(z.string().max(100)).max(2000).optional(),
    integrationIds: z.array(z.string().max(100)).max(200).optional(),
  })
  .strict();

// ─── Delivery channels + targets ─────────────────────────────────────────────
// Channels are operator-configured delivery integrations (NotificationChannel
// registry, Notifications → Delivery tab). A rule's `targets[]` reference a
// channel by id. In-app is always implicit (every fire writes a Notification);
// targets route the same fire out through the configured channels.
//
// `transport` is the dispatch family the drain switches on; multiple channel
// `type`s can share one transport (slack + teams → webhook).
export const CHANNEL_TYPES = ["smtp", "oauth_m365", "pushbullet", "slack", "teams", "web_push"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const CHANNEL_TRANSPORT: Record<ChannelType, "email" | "webhook" | "web_push" | "pushbullet"> = {
  smtp: "email",
  oauth_m365: "email",
  pushbullet: "pushbullet",
  slack: "webhook",
  teams: "webhook",
  web_push: "web_push",
};
/** Channel types whose target routes to recipients (tags / addresses); the rest
 *  post to the channel's own fixed destination (URL / token). */
export const RECIPIENT_ROUTED_TYPES: ChannelType[] = ["smtp", "oauth_m365", "web_push"];

// Display metadata for the Delivery-tab add/edit modal: per-type label + the
// config fields (key, label, kind, whether it's a masked secret).
export interface ChannelFieldDef {
  key: string;
  label: string;
  kind: "text" | "number" | "password" | "select";
  secret?: boolean;
  options?: string[];
  placeholder?: string;
}
export const CHANNEL_TYPE_META: Record<ChannelType, { label: string; transport: string; singleton?: boolean; help?: string; fields: ChannelFieldDef[] }> = {
  smtp: {
    label: "Email — SMTP", transport: "email",
    fields: [
      { key: "host", label: "SMTP host", kind: "text", placeholder: "smtp.example.com" },
      // Security sits above Port: picking a security level auto-fills the
      // conventional port (none→25, starttls→587, ssl→465) in the UI.
      { key: "security", label: "Security", kind: "select", options: ["none", "starttls", "ssl"] },
      { key: "port", label: "Port", kind: "number" },
      { key: "username", label: "Username", kind: "text" },
      { key: "password", label: "Password", kind: "password", secret: true },
      { key: "from", label: "From address", kind: "text", placeholder: "polaris@example.com" },
    ],
  },
  oauth_m365: {
    label: "Email — Microsoft 365 (OAuth)", transport: "email",
    help: "Add the Mail.Send application permission to this app's Enterprise application in Azure (App registration → API permissions → Microsoft Graph → Application permissions → Mail.Send) and grant admin consent. The send-as user must be a licensed Exchange Online mailbox.",
    fields: [
      { key: "tenantId", label: "Tenant ID", kind: "text" },
      { key: "clientId", label: "Client ID", kind: "text" },
      { key: "clientSecret", label: "Client secret", kind: "password", secret: true },
      { key: "fromUserId", label: "Send-as user (UPN or object ID)", kind: "text", placeholder: "alerts@example.com" },
    ],
  },
  pushbullet: {
    label: "Pushbullet", transport: "pushbullet",
    fields: [
      { key: "accessToken", label: "Access token", kind: "password", secret: true },
    ],
  },
  slack: {
    label: "Slack", transport: "webhook",
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", kind: "password", secret: true, placeholder: "https://hooks.slack.com/services/…" },
    ],
  },
  teams: {
    label: "Microsoft Teams", transport: "webhook",
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", kind: "password", secret: true, placeholder: "https://outlook.office.com/webhook/…" },
    ],
  },
  web_push: {
    label: "Web Push (browser & mobile)", transport: "web_push", singleton: true,
    fields: [
      { key: "subject", label: "Contact subject (mailto: or https:)", kind: "text", placeholder: "mailto:admin@example.com" },
      // publicKey + privateKey are generated server-side, not free-typed.
    ],
  },
};

export const deliveryTargetSchema = z.object({
  channelId: z.string().min(1).max(100),
  // Recipient sources (combine freely; only meaningful for recipient-routed
  // channel types — email + web_push). Chat/Pushbullet ignore these.
  recipientUserIds: z.array(z.string().max(100)).max(500).optional(), // specific Polaris users → their email / push subs
  addresses: z.array(z.string().email().max(320)).max(100).optional(), // custom email addresses (email channels)
  recipientScopeRegion: z.boolean().optional(), // users whose region tags match the rule's scope region tag(s)
  recipientTags: z.array(z.string().max(100)).max(200).optional(), // legacy tag-routing (kept for back-compat)
});

// ─── Rule-level email composition + escalation ──────────────────────────────
// emailComposition customizes the OUTBOUND EMAIL a rule's email targets send
// (subject / text / HTML bodies + Cc/Bcc). Templates render through
// renderNotificationTemplate (src/utils/notificationTemplate.ts) — single-brace
// {token} vocabulary, cataloged in TEMPLATE_VARIABLES. When set, each email
// target sends ONE message (full To list + Cc + Bcc) instead of the default
// one-email-per-To-address fan-out. NULL = pre-feature default behavior.
// Email-only: chat/pushbullet/web_push channels ignore it.

const emailRecipientsSchema = z
  .object({
    recipientUserIds: z.array(z.string().max(100)).max(500).optional(), // Polaris users → their emails
    addresses: z.array(z.string().email().max(320)).max(100).optional(), // custom email addresses
  })
  .strict();

export const emailCompositionSchema = z
  .object({
    subjectTemplate: z.string().max(500).optional().nullable(),
    bodyTextTemplate: z.string().max(10000).optional().nullable(),
    bodyHtmlTemplate: z.string().max(20000).optional().nullable(),
    cc: emailRecipientsSchema.optional().nullable(),
    bcc: emailRecipientsSchema.optional().nullable(),
  })
  .strict();

// Escalation: ordered tiers of follow-up emails while the notification stays
// unhandled (stopOn: "acknowledge" stops on ack OR clear; "clear" ignores ack).
// Tier channels must be email-type (validated at rule save). Tier subject/body
// overrides fall back to the rule's emailComposition, then the defaults.
// Swept by the escalateNotifications job (60s).
export const escalationTierSchema = z
  .object({
    afterMin: z.number().int().min(1).max(10080), // ≤ 1 week
    channelId: z.string().min(1).max(100),
    to: emailRecipientsSchema.refine(
      (r) => (r.recipientUserIds?.length ?? 0) + (r.addresses?.length ?? 0) > 0,
      { message: "Escalation tier needs at least one To recipient" },
    ),
    cc: emailRecipientsSchema.optional().nullable(),
    bcc: emailRecipientsSchema.optional().nullable(),
    subjectTemplate: z.string().max(500).optional().nullable(),
    bodyTextTemplate: z.string().max(10000).optional().nullable(),
    bodyHtmlTemplate: z.string().max(20000).optional().nullable(),
    repeatEveryMin: z.number().int().min(5).max(1440).optional().nullable(),
    maxRepeats: z.number().int().min(1).max(20).optional().nullable(), // default 5 when repeating
  })
  .strict();

export const escalationSchema = z
  .object({
    stopOn: z.enum(["acknowledge", "clear"]).default("acknowledge"),
    tiers: z.array(escalationTierSchema).min(1).max(5),
  })
  .strict();

export const ruleInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  enabled: z.boolean().default(true),
  severity: z.enum(SEVERITIES).default("warning"),
  trigger: triggerSchema,
  scope: scopeSchema.default({}),
  clearBehavior: z.enum(CLEAR_BEHAVIORS).default("manual"),
  clearAfterSec: z.number().int().min(1).max(2592000).optional().nullable(),
  cooldownSec: z.number().int().min(0).max(2592000).optional().nullable(),
  messageTemplate: z.string().max(2000).optional().nullable(),
  channels: z.array(z.string().max(50)).default(["in_app"]),
  targets: z.array(deliveryTargetSchema).max(50).default([]),
  emailComposition: emailCompositionSchema.optional().nullable(),
  escalation: escalationSchema.optional().nullable(),
});

export type Trigger = z.infer<typeof triggerSchema>;
export type RuleScope = z.infer<typeof scopeSchema>;
export type RuleInput = z.infer<typeof ruleInputSchema>;
export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;
export type EmailRecipients = z.infer<typeof emailRecipientsSchema>;
export type EmailComposition = z.infer<typeof emailCompositionSchema>;
export type EscalationTier = z.infer<typeof escalationTierSchema>;
export type EscalationConfig = z.infer<typeof escalationSchema>;

/** Trigger categories that select assets via `scope` (vs. event/host). */
export const ASSET_SCOPED_TRIGGER_TYPES = ["asset_metric", "asset_state", "change"] as const;

// ─── Display metadata (builder UI only; engine validates via the Zod schemas) ──
// Human label + unit per metric, for both asset_metric and host_metric.
export const METRIC_META: Record<string, { label: string; unit: string }> = {
  // asset_metric
  cpuPct: { label: "CPU utilization", unit: "%" },
  memPct: { label: "Memory utilization", unit: "%" },
  memUsedBytes: { label: "Memory used", unit: "bytes" },
  sessionCount: { label: "Active sessions", unit: "" },
  responseTimeMs: { label: "Response time", unit: "ms" },
  uptimeSec: { label: "Uptime", unit: "sec" },
  hwSensorValue: { label: "Hardware sensor value", unit: "(sensor unit)" },
  storageUsedPct: { label: "Storage used", unit: "%" },
  storageUsedBytes: { label: "Storage used", unit: "bytes" },
  ifInErrorRate: { label: "Interface in-error rate", unit: "errors/s" },
  ifOutErrorRate: { label: "Interface out-error rate", unit: "errors/s" },
  ifInBps: { label: "Interface inbound", unit: "bps" },
  ifOutBps: { label: "Interface outbound", unit: "bps" },
  sdwanLatencyMs: { label: "SD-WAN latency", unit: "ms" },
  sdwanJitterMs: { label: "SD-WAN jitter", unit: "ms" },
  sdwanPacketLoss: { label: "SD-WAN packet loss", unit: "%" },
  ipsecThroughputBps: { label: "IPsec throughput", unit: "bps" },
  customWidgetValue: { label: "Custom widget value", unit: "" },
  // host_metric
  memUsedPct: { label: "Memory utilization", unit: "%" },
  loadAvg1: { label: "Load average (1m)", unit: "" },
  loadAvg5: { label: "Load average (5m)", unit: "" },
  loadAvg15: { label: "Load average (15m)", unit: "" },
  procRssBytes: { label: "Process RSS", unit: "bytes" },
};

// Asset-state field metadata: label + input kind + (for enum/bool) valid values.
export const FIELD_META: Record<string, { label: string; kind: "enum" | "bool" | "number" | "dynamic"; values?: string[] }> = {
  monitorStatus: { label: "Monitor status", kind: "enum", values: ["up", "warning", "recovering", "down", "unknown"] },
  status: { label: "Lifecycle status", kind: "enum", values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"] },
  consecutiveFailures: { label: "Consecutive probe failures", kind: "number" },
  dependencySuppressed: { label: "Dependency-suppressed", kind: "bool", values: ["true", "false"] },
  quarantined: { label: "Quarantined", kind: "bool", values: ["true", "false"] },
  ifOperStatus: { label: "Interface oper status", kind: "dynamic" },
  ifAdminStatus: { label: "Interface admin status", kind: "dynamic" },
  ipsecStatus: { label: "IPsec tunnel status", kind: "dynamic" },
  sdwanRuleStatus: { label: "SD-WAN rule status", kind: "dynamic" },
  sdwanSelectedMember: { label: "SD-WAN selected member", kind: "dynamic" },
};

export const CHANGE_TYPE_META: Record<string, string> = {
  lldp_neighbor_added: "LLDP neighbor appeared",
  lldp_neighbor_removed: "LLDP neighbor disappeared",
  process_started: "Process started",
  process_stopped: "Process stopped",
  sdwan_failover: "SD-WAN failover (member changed)",
  mclag_peer_lost: "MCLAG peer lost",
  wireless_station_connected: "Wireless station connected",
};

// Which dimensionFilter inputs are relevant per asset_metric metric, so the
// builder only shows the applicable ones.
export const METRIC_DIMENSIONS: Record<string, string[]> = {
  hwSensorValue: ["sensorClass"],
  storageUsedPct: ["mountPathPattern"],
  storageUsedBytes: ["mountPathPattern"],
  ifInErrorRate: ["ifNamePattern"],
  ifOutErrorRate: ["ifNamePattern"],
  ifInBps: ["ifNamePattern"],
  ifOutBps: ["ifNamePattern"],
  sdwanLatencyMs: ["healthCheck", "link"],
  sdwanJitterMs: ["healthCheck", "link"],
  sdwanPacketLoss: ["healthCheck", "link"],
  ipsecThroughputBps: ["tunnelName"],
  customWidgetValue: ["widgetId"],
};

/**
 * The catalog the builder UI reads from GET /notification-rules/schema, so the
 * frontend renders the right inputs per trigger type without hardcoding. The
 * `*Meta` maps add display labels / units / valid values / applicable dimension
 * filters; the engine ignores them (it validates via the Zod schemas above).
 */
export function buildSchemaCatalog() {
  return {
    severities: SEVERITIES,
    eventLevels: EVENT_LEVELS,
    clearBehaviors: CLEAR_BEHAVIORS,
    comparators: COMPARATORS,
    aggregations: AGGREGATIONS,
    metricMeta: METRIC_META,
    fieldMeta: FIELD_META,
    changeTypeMeta: CHANGE_TYPE_META,
    metricDimensions: METRIC_DIMENSIONS,
    channelTypes: CHANNEL_TYPE_META,
    recipientRoutedTypes: RECIPIENT_ROUTED_TYPES,
    templateVariables: TEMPLATE_VARIABLES,
    triggerTypes: [
      { type: "asset_metric", label: "Asset metric threshold", scoped: true, metrics: ASSET_METRICS },
      { type: "asset_state", label: "Asset state", scoped: true, fields: ASSET_STATE_FIELDS },
      { type: "host_metric", label: "Polaris host health", scoped: false, metrics: HOST_METRICS },
      { type: "event", label: "Audit event match", scoped: false },
      { type: "change", label: "Change detection", scoped: true, changeTypes: CHANGE_TYPES },
    ],
  };
}
