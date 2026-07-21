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

// ─── Rule shape v2: reset + unified actions (Automations redesign) ──────────
// `reset` supersedes clearBehavior/clearAfterSec (auto gains hysteresis +
// clear-sustain); `actions` supersedes `targets` as the unified fired-outcome
// list (notify | api_call | script). Legacy columns stay stored as a lossless
// mirror (legacyMirrorOfV2) and legacy INPUT stays accepted — the transform on
// ruleInputSchema folds old POST bodies into v2, so pre-rename API clients and
// the pre-wizard UI keep working against the alias paths.

export const RESET_MODES = ["manual", "auto", "timed"] as const;
export type ResetMode = (typeof RESET_MODES)[number];

export const resetSchema = z
  .object({
    mode: z.enum(RESET_MODES).default("manual"),
    // auto only — hysteresis: the alert recovers when the value no longer
    // meets `trigger.operator clearThreshold` (a fire at cpu >= 90 with
    // clearThreshold 80 clears at < 80). Omit = recover at the fire threshold.
    clearThreshold: z.number().optional().nullable(),
    // auto only — clear-sustain: the condition must stay recovered this long
    // before the alert auto-clears. 0/omit = clear on first recovered reading.
    sustainSec: z.number().int().min(0).max(86400).optional().nullable(),
    // timed only (the old clearAfterSec).
    afterSec: z.number().int().min(1).max(2592000).optional().nullable(),
  })
  .strict();

export const API_CALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const SCRIPT_RUN_TARGETS = ["server", "agent"] as const;
// Interpreter vocabulary for the AutomationScript registry (owned here — the
// vocabulary file — so the catalog, the script service, and the routes never
// drift; the Go agent mirrors this list in scriptexec).
export const SCRIPT_INTERPRETERS = ["bash", "sh", "powershell", "cmd", "python3"] as const;
export type ScriptInterpreter = (typeof SCRIPT_INTERPRETERS)[number];

export const notifyActionSchema = z
  .object({
    type: z.literal("notify"),
    channelId: z.string().min(1).max(100),
    // Recipient sources — same semantics as deliveryTargetSchema (meaningful
    // for recipient-routed channel types only; chat/pushbullet ignore them).
    recipientUserIds: z.array(z.string().max(100)).max(500).optional(),
    addresses: z.array(z.string().email().max(320)).max(100).optional(),
    recipientScopeRegion: z.boolean().optional(),
    recipientTags: z.array(z.string().max(100)).max(200).optional(),
    // Per-action email composition override; falls back to the rule-level
    // emailComposition, then the pre-feature defaults. Email transports only.
    emailComposition: emailCompositionSchema.optional().nullable(),
  })
  .strict();

// SECURITY: headers are stored UNMASKED on the rule (and echoed onto delivery
// rows) — the catalog + docs tell operators never to put credentials here.
// The URL is static (no {token}s) so the SSRF host check at save time checks
// what actually gets fetched; only bodyTemplate takes template tokens.
export const apiCallActionSchema = z
  .object({
    type: z.literal("api_call"),
    method: z.enum(API_CALL_METHODS).default("POST"),
    url: z
      .string()
      .max(2000)
      .url()
      .refine((u) => /^https?:\/\//i.test(u), { message: "api_call URL must be http(s)" }),
    headers: z
      .record(z.string().max(1000))
      .refine((h) => Object.keys(h).length <= 20, { message: "at most 20 headers" })
      .refine((h) => Object.keys(h).every((k) => k.length >= 1 && k.length <= 100), {
        message: "header names must be 1–100 characters",
      })
      .optional(),
    bodyTemplate: z.string().max(10000).optional().nullable(), // {token} vocabulary
    timeoutSec: z.number().int().min(1).max(60).default(15),
  })
  .strict();

export const scriptActionSchema = z
  .object({
    type: z.literal("script"),
    scriptId: z.string().min(1).max(100), // AutomationScript registry id
    runOn: z.enum(SCRIPT_RUN_TARGETS),
    argsTemplate: z.string().max(2000).optional().nullable(), // {token} vocabulary
    timeoutSec: z.number().int().min(1).max(600).optional().nullable(), // overrides the script default
  })
  .strict();

export const actionSchema = z.discriminatedUnion("type", [
  notifyActionSchema,
  apiCallActionSchema,
  scriptActionSchema,
]);

// Escalation v2: tiers of ACTIONS (any type), superseding the email-only tier
// shape. The stored/input escalation stays on the legacy schema until the
// escalation-v2 phase flips the sweep onto executeActions; the v2 schema +
// normalizeEscalationToV2 land now so the conversion is testable and shared.
export const escalationTierV2Schema = z
  .object({
    afterMin: z.number().int().min(1).max(10080),
    actions: z.array(actionSchema).min(1).max(10),
    repeatEveryMin: z.number().int().min(5).max(1440).optional().nullable(),
    maxRepeats: z.number().int().min(1).max(20).optional().nullable(),
  })
  .strict();

export const escalationV2Schema = z
  .object({
    stopOn: z.enum(["acknowledge", "clear"]).default("acknowledge"),
    tiers: z.array(escalationTierV2Schema).min(1).max(5),
  })
  .strict();

export type Trigger = z.infer<typeof triggerSchema>;
export type RuleScope = z.infer<typeof scopeSchema>;
export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;
export type EmailRecipients = z.infer<typeof emailRecipientsSchema>;
export type EmailComposition = z.infer<typeof emailCompositionSchema>;
export type EscalationTier = z.infer<typeof escalationTierSchema>;
export type EscalationConfig = z.infer<typeof escalationSchema>;
export type ResetConfig = z.infer<typeof resetSchema>;
export type NotifyAction = z.infer<typeof notifyActionSchema>;
export type ApiCallAction = z.infer<typeof apiCallActionSchema>;
export type ScriptAction = z.infer<typeof scriptActionSchema>;
export type AutomationAction = z.infer<typeof actionSchema>;
export type EscalationTierV2 = z.infer<typeof escalationTierV2Schema>;
export type EscalationV2Config = z.infer<typeof escalationV2Schema>;

// ─── Input schema (accepts v2 AND legacy bodies; canonical output is v2) ────

const ruleInputBaseSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  enabled: z.boolean().default(true),
  severity: z.enum(SEVERITIES).default("warning"),
  trigger: triggerSchema,
  scope: scopeSchema.default({}),
  // v2 canonical fields:
  reset: resetSchema.optional().nullable(),
  actions: z.array(actionSchema).max(20).optional(),
  // Legacy fields, folded into v2 by the transform (v2 wins when both given):
  clearBehavior: z.enum(CLEAR_BEHAVIORS).optional(),
  clearAfterSec: z.number().int().min(1).max(2592000).optional().nullable(),
  targets: z.array(deliveryTargetSchema).max(50).optional(),
  // Shared fields:
  cooldownSec: z.number().int().min(0).max(2592000).optional().nullable(),
  messageTemplate: z.string().max(2000).optional().nullable(),
  channels: z.array(z.string().max(50)).default(["in_app"]),
  emailComposition: emailCompositionSchema.optional().nullable(),
  // Accepts BOTH shapes: legacy email tiers (pre-wizard UI) and v2 tiers of
  // actions. Stored as given; every reader normalizes via
  // normalizeEscalationToV2 (part of normalizeRuleToV2).
  escalation: z.union([escalationSchema, escalationV2Schema]).optional().nullable(),
});

type RuleInputRaw = z.infer<typeof ruleInputBaseSchema>;

/** Canonical (v2) rule input — what the service layer persists. */
export interface RuleInput {
  name: string;
  description: string | null;
  enabled: boolean;
  severity: (typeof SEVERITIES)[number];
  trigger: Trigger;
  scope: RuleScope;
  reset: ResetConfig;
  actions: AutomationAction[];
  cooldownSec: number | null;
  messageTemplate: string | null;
  channels: string[];
  emailComposition: EmailComposition | null;
  /** As posted (legacy email tiers OR v2 tiers-of-actions) — stored verbatim;
   *  readers normalize through normalizeEscalationToV2. */
  escalation: EscalationConfig | EscalationV2Config | null;
}

/** Preview input = RuleInput with trigger optional (scope-only preview mode). */
export type PreviewRuleInput = Omit<RuleInput, "trigger" | "name"> & {
  name: string;
  trigger?: Trigger;
};

/** clearBehavior/clearAfterSec → v2 reset. Also sanitizes a provided reset:
 *  mode-irrelevant fields are stripped so stored shapes stay canonical. */
export function normalizeReset(
  reset: ResetConfig | null | undefined,
  clearBehavior?: string | null,
  clearAfterSec?: number | null,
): ResetConfig {
  if (reset) {
    if (reset.mode === "auto") {
      return { mode: "auto", clearThreshold: reset.clearThreshold ?? null, sustainSec: reset.sustainSec ?? null };
    }
    if (reset.mode === "timed") return { mode: "timed", afterSec: reset.afterSec ?? null };
    return { mode: "manual" };
  }
  const mode: ResetMode = clearBehavior === "auto" || clearBehavior === "timed" ? clearBehavior : "manual";
  if (mode === "timed") return { mode: "timed", afterSec: clearAfterSec ?? null };
  return mode === "auto" ? { mode: "auto" } : { mode: "manual" };
}

/** Legacy delivery targets → notify actions. The rule-level emailComposition
 *  is copied onto every converted action (the executor applies it only on
 *  email transports — matching the legacy behavior where non-email channels
 *  ignored it). */
export function targetsToNotifyActions(
  targets: DeliveryTarget[] | null | undefined,
  emailComposition: EmailComposition | null,
): AutomationAction[] {
  return (targets ?? []).map((t) => ({
    type: "notify" as const,
    channelId: t.channelId,
    ...(t.recipientUserIds?.length ? { recipientUserIds: t.recipientUserIds } : {}),
    ...(t.addresses?.length ? { addresses: t.addresses } : {}),
    ...(t.recipientScopeRegion !== undefined ? { recipientScopeRegion: t.recipientScopeRegion } : {}),
    ...(t.recipientTags?.length ? { recipientTags: t.recipientTags } : {}),
    emailComposition: emailComposition ?? null,
  }));
}

/** notify actions → legacy delivery targets (per-action emailComposition is
 *  dropped — it has no legacy representation; the rule-level column carries
 *  the shared composition). api_call/script actions have no legacy mirror. */
export function actionsToTargets(actions: AutomationAction[]): DeliveryTarget[] {
  return actions
    .filter((a): a is NotifyAction => a.type === "notify")
    .map((a) => ({
      channelId: a.channelId,
      ...(a.recipientUserIds?.length ? { recipientUserIds: a.recipientUserIds } : {}),
      ...(a.addresses?.length ? { addresses: a.addresses } : {}),
      ...(a.recipientScopeRegion !== undefined ? { recipientScopeRegion: a.recipientScopeRegion } : {}),
      ...(a.recipientTags?.length ? { recipientTags: a.recipientTags } : {}),
    }));
}

/** The lossless legacy projection of a v2 rule, kept mirrored on the legacy
 *  columns at save time so pre-wizard UIs and restored backups stay coherent. */
export function legacyMirrorOfV2(
  reset: ResetConfig,
  actions: AutomationAction[],
): { clearBehavior: (typeof CLEAR_BEHAVIORS)[number]; clearAfterSec: number | null; targets: DeliveryTarget[] } {
  return {
    clearBehavior: reset.mode,
    clearAfterSec: reset.mode === "timed" ? (reset.afterSec ?? null) : null,
    targets: actionsToTargets(actions),
  };
}

function normalizeRuleInputCore(raw: Omit<RuleInputRaw, "trigger">): Omit<RuleInput, "trigger"> {
  return {
    name: raw.name,
    description: raw.description ?? null,
    enabled: raw.enabled,
    severity: raw.severity,
    scope: raw.scope,
    reset: normalizeReset(raw.reset, raw.clearBehavior, raw.clearAfterSec),
    actions: raw.actions ?? targetsToNotifyActions(raw.targets, raw.emailComposition ?? null),
    cooldownSec: raw.cooldownSec ?? null,
    messageTemplate: raw.messageTemplate ?? null,
    channels: raw.channels,
    emailComposition: raw.emailComposition ?? null,
    escalation: raw.escalation ?? null,
  };
}

/** Cross-field validation over the NORMALIZED v2 shape. */
function validateRuleV2(v: { trigger?: Trigger; reset: ResetConfig }, ctx: z.RefinementCtx): void {
  const { trigger, reset } = v;
  if (reset.mode === "timed" && reset.afterSec == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "afterSec"], message: "timed reset requires afterSec" });
  }
  if (reset.mode === "auto" && reset.clearThreshold != null && trigger) {
    if (trigger.type !== "asset_metric" && trigger.type !== "host_metric") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: "a clear threshold (hysteresis) only applies to numeric metric triggers",
      });
      return;
    }
    const op = trigger.operator;
    const t = trigger.threshold;
    const c = reset.clearThreshold;
    if (op === "==" || op === "!=") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: `a clear threshold cannot be combined with the ${op} operator`,
      });
    } else if ((op === ">" || op === ">=") && c > t) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: `clear threshold must be at or below the fire threshold (${t}) for operator ${op}`,
      });
    } else if ((op === "<" || op === "<=") && c < t) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: `clear threshold must be at or above the fire threshold (${t}) for operator ${op}`,
      });
    }
  }
}

export const ruleInputSchema = ruleInputBaseSchema
  .transform((raw): RuleInput => ({ trigger: raw.trigger, ...normalizeRuleInputCore(raw) }))
  .superRefine(validateRuleV2);

// Preview accepts partial drafts: name defaulted, trigger optional (a
// scope-only body lists the matched devices — the wizard's Step-2 preview).
export const previewInputSchema = ruleInputBaseSchema
  .extend({
    name: z.string().min(1).max(200).default("Draft automation"),
    trigger: triggerSchema.optional(),
  })
  .transform((raw): PreviewRuleInput => ({ trigger: raw.trigger, ...normalizeRuleInputCore(raw) }))
  .superRefine(validateRuleV2);

// ─── Read-path normalizer (DB row → v2 view) ────────────────────────────────

/** The v2 view of a stored rule row. */
export interface RuleV2View {
  reset: ResetConfig;
  actions: AutomationAction[];
  /** Escalation as v2 tiers-of-actions (legacy tiers converted); null when unset. */
  escalation: EscalationV2Config | null;
}

/** Legacy escalation tier → v2 tier of one notify action. Tier-level template
 *  overrides become the action's emailComposition (only the fields the tier
 *  set — per-field fallback to the rule composition stays with the executor). */
export function normalizeEscalationToV2(escalation: unknown): EscalationV2Config | null {
  if (!escalation || typeof escalation !== "object") return null;
  const raw = escalation as { stopOn?: unknown; tiers?: unknown };
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) return null;
  // Already v2? (tiers carry actions[])
  if ((raw.tiers[0] as { actions?: unknown })?.actions !== undefined) {
    const parsed = escalationV2Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  const parsedLegacy = escalationSchema.safeParse(raw);
  if (!parsedLegacy.success) return null;
  return {
    stopOn: parsedLegacy.data.stopOn,
    tiers: parsedLegacy.data.tiers.map((t) => {
      const hasComposition =
        t.subjectTemplate != null || t.bodyTextTemplate != null || t.bodyHtmlTemplate != null || t.cc != null || t.bcc != null;
      return {
        afterMin: t.afterMin,
        repeatEveryMin: t.repeatEveryMin ?? null,
        maxRepeats: t.maxRepeats ?? null,
        actions: [
          {
            type: "notify" as const,
            channelId: t.channelId,
            ...(t.to.recipientUserIds?.length ? { recipientUserIds: t.to.recipientUserIds } : {}),
            ...(t.to.addresses?.length ? { addresses: t.to.addresses } : {}),
            emailComposition: hasComposition
              ? {
                  subjectTemplate: t.subjectTemplate ?? null,
                  bodyTextTemplate: t.bodyTextTemplate ?? null,
                  bodyHtmlTemplate: t.bodyHtmlTemplate ?? null,
                  cc: t.cc ?? null,
                  bcc: t.bcc ?? null,
                }
              : null,
          },
        ],
      };
    }),
  };
}

/**
 * Normalize a stored rule row to the v2 view. Prefers the persisted v2
 * columns; falls back to converting the legacy columns (pre-v2 rows, restored
 * backups). Every reader — engine, escalation sweep, routes — goes through
 * this so v1 and v2 rows behave identically.
 */
export function normalizeRuleToV2(row: {
  clearBehavior?: string | null;
  clearAfterSec?: number | null;
  targets?: unknown;
  emailComposition?: unknown;
  escalation?: unknown;
  reset?: unknown;
  actions?: unknown;
}): RuleV2View {
  const storedReset = row.reset ? resetSchema.safeParse(row.reset) : null;
  const reset = storedReset?.success
    ? normalizeReset(storedReset.data)
    : normalizeReset(null, row.clearBehavior, row.clearAfterSec);

  const emailComposition = row.emailComposition
    ? (emailCompositionSchema.safeParse(row.emailComposition).success
        ? (row.emailComposition as EmailComposition)
        : null)
    : null;

  let actions: AutomationAction[];
  if (Array.isArray(row.actions)) {
    actions = row.actions
      .map((a) => actionSchema.safeParse(a))
      .filter((r): r is { success: true; data: AutomationAction } => r.success)
      .map((r) => r.data);
  } else {
    const targets = Array.isArray(row.targets) ? (row.targets as DeliveryTarget[]) : [];
    actions = targetsToNotifyActions(targets, emailComposition);
  }

  return { reset, actions, escalation: normalizeEscalationToV2(row.escalation) };
}

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
    // v2 capability marker — the wizard gates its data-driven surfaces on it.
    schemaVersion: 2,
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
    // ── Rule-shape v2 vocabulary (reset + actions), wizard-facing ──────────
    resetModes: RESET_MODES,
    resetModeMeta: {
      auto: { label: "Automatically", help: "Clears when the condition recovers — optionally with a separate clear threshold (hysteresis) and a recovered-for duration." },
      timed: { label: "After a fixed time", help: "Clears after the configured duration, even without a recovery reading." },
      manual: { label: "Manually only", help: "Stays active until someone clears it." },
    },
    // Which reset modes make sense per trigger type (event/change have no
    // continuous condition to auto-clear) + the wizard's default per type.
    resetModesByTriggerType: {
      asset_metric: ["auto", "timed", "manual"],
      asset_state: ["auto", "timed", "manual"],
      host_metric: ["auto", "timed", "manual"],
      event: ["timed", "manual"],
      change: ["timed", "manual"],
    },
    resetDefaults: {
      asset_metric: { mode: "auto", sustainSec: 0 },
      asset_state: { mode: "auto" },
      host_metric: { mode: "auto", sustainSec: 0 },
      event: { mode: "timed", afterSec: 3600 },
      change: { mode: "timed", afterSec: 3600 },
    },
    actionTypes: [
      { type: "notify", label: "Send a notification", requires: "channels", permission: null },
      { type: "api_call", label: "Call an API (HTTP request)", requires: null, permission: null },
      { type: "script", label: "Run a script", requires: "scripts", permission: "automationScripts" },
    ],
    apiCallMeta: {
      allowedMethods: API_CALL_METHODS,
      urlSchemes: ["https", "http"],
      maxBodyBytes: 10000,
      maxHeaders: 20,
      maxTimeoutSec: 60,
      help: "Headers are stored unmasked on the automation — never paste API keys, tokens, or other credentials into them.",
    },
    scriptMeta: {
      runOnOptions: SCRIPT_RUN_TARGETS,
      maxTimeoutSec: 600,
      languages: SCRIPT_INTERPRETERS,
      help: "Scripts execute as the Polaris service account on the server, or as root/LocalSystem on the triggering asset's agent. A human must review every script before enabling it in production.",
    },
    escalationMeta: { maxTiers: 5, minRepeatEveryMin: 5, maxActionsPerTier: 10 },
    // Sentence-builder vocabulary (server-owned wording; the wizard renders
    // the live plain-English trigger/reset summary from these).
    comparatorPhrases: {
      ">": "is above", ">=": "is at or above",
      "<": "is below", "<=": "is at or below",
      "==": "equals", "!=": "is not",
    },
    inverseComparators: { ">": "<=", ">=": "<", "<": ">=", "<=": ">", "==": "!=", "!=": "==" },
    aggregationPhrases: { latest: "", avg: "avg over", min: "min over", max: "max over" },
    dimensionPhrases: {
      sensorClass: "for sensors of class {value}",
      ifNamePattern: "on interfaces matching {value}",
      mountPathPattern: "on mounts matching {value}",
      healthCheck: "for health check {value}",
      link: "on member {value}",
      tunnelName: "on tunnel {value}",
      widgetId: "for widget {value}",
      processNamePattern: "for processes matching {value}",
    },
  };
}
