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
import { isValidCidr, isValidIpAddress, ipInCidr } from "../utils/cidr.js";
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
  "cpuPct", "memPct", "memUsedBytes", "sessionCount", "responseTimeMs", "uptimeSec", "probeLossPct",
  "hwSensorValue", "storageUsedPct", "storageUsedBytes", "storageDaysUntilFull",
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

// ─── Composite trigger (nested AND/OR over metric/state leaves) ─────────────
// The wizard's multi-condition trigger: a tree of the threshold-ish leaf
// conditions above (event/change have no continuous reading to compose).
// Evaluated PER ASSET — a multi-dimension leaf (sensors, mounts, interfaces)
// counts as met when ANY of its dimensions meets, and the whole rule fires one
// alert per asset (dimensionKey "") instead of per dimension. Only and/or are
// allowed at group level: negation combinators would fire on missing data and
// on every healthy asset; single-condition negation is already expressible via
// the inverse comparator.
//
// Invariant (enforced by collapseCompositeTrigger in the input transforms):
// a stored composite always has ≥2 leaves — a single-leaf composite collapses
// to the legacy single trigger, keeping per-dimension alerting + hysteresis
// for the common case regardless of which client authored the rule.

export const TRIGGER_GROUP_OPS = ["and", "or"] as const;
export type TriggerGroupOp = (typeof TRIGGER_GROUP_OPS)[number];

// Leaves are the existing threshold conditions minus forDurationSec (the
// sustain applies to the whole composite, not per leaf).
const compositeAssetMetricLeaf = assetMetricTrigger.omit({ forDurationSec: true });
const compositeAssetStateLeaf = assetStateTrigger.omit({ forDurationSec: true });
const compositeHostMetricLeaf = hostMetricTrigger.omit({ forDurationSec: true });
export const compositeLeafSchema = z.discriminatedUnion("type", [
  compositeAssetMetricLeaf,
  compositeAssetStateLeaf,
  compositeHostMetricLeaf,
]);
export type CompositeLeaf = z.infer<typeof compositeLeafSchema>;

export interface TriggerConditionGroup {
  op: TriggerGroupOp;
  children: (TriggerConditionGroup | CompositeLeaf)[];
}

/** A tree node is a leaf iff it carries the discriminator (groups are strict
 *  {op, children} objects and never have `type`). */
export function isTriggerLeaf(node: TriggerConditionGroup | CompositeLeaf): node is CompositeLeaf {
  return "type" in node;
}

export const triggerConditionGroupSchema: z.ZodType<TriggerConditionGroup> = z.lazy(() =>
  z
    .object({
      op: z.enum(TRIGGER_GROUP_OPS),
      children: z.array(z.union([compositeLeafSchema, triggerConditionGroupSchema])).min(1).max(10),
    })
    .strict(),
) as z.ZodType<TriggerConditionGroup>;

// Plain ZodObject (no superRefine — discriminated-union members must be), so
// the depth/leaf/kind caps live in validateCompositeTrigger, called from
// validateRuleV2 on both the save and preview paths.
const compositeTrigger = z.object({
  type: z.literal("composite"),
  // asset = asset_metric/asset_state leaves (scope-selected devices);
  // host = host_metric leaves (the Polaris host). Never mixed.
  kind: z.enum(["asset", "host"]),
  op: z.enum(TRIGGER_GROUP_OPS),
  children: z.array(z.union([compositeLeafSchema, triggerConditionGroupSchema])).min(1).max(10),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
});

export const triggerSchema = z.discriminatedUnion("type", [
  assetMetricTrigger,
  assetStateTrigger,
  hostMetricTrigger,
  eventTrigger,
  changeTrigger,
  compositeTrigger,
]);
export type CompositeTrigger = z.infer<typeof compositeTrigger>;

/** Depth (root group = 1) + leaf count for a composite trigger tree. */
export function triggerConditionStats(node: { op: TriggerGroupOp; children: (TriggerConditionGroup | CompositeLeaf)[] }): {
  depth: number;
  leaves: number;
} {
  let leaves = 0;
  const depthOf = (g: { children: (TriggerConditionGroup | CompositeLeaf)[] }): number =>
    1 + Math.max(0, ...g.children.map((c) => {
      if (isTriggerLeaf(c)) { leaves++; return 0; }
      return depthOf(c);
    }));
  const depth = depthOf(node);
  return { depth, leaves };
}

/**
 * Canonicalize a composite trigger: unwrap single-child group wrappers, and
 * collapse a single-leaf tree to the legacy single trigger with forDurationSec
 * hoisted onto it. Applied in the input transforms so the "≥2 leaves ⇒
 * composite, 1 leaf ⇒ per-dimension legacy" invariant holds for every author
 * (wizard or raw API).
 */
export function collapseCompositeTrigger(trigger: Trigger): Trigger {
  if (trigger.type !== "composite") return trigger;
  let op = trigger.op;
  let children = trigger.children;
  while (children.length === 1 && !isTriggerLeaf(children[0])) {
    const g = children[0] as TriggerConditionGroup;
    op = g.op;
    children = g.children;
  }
  if (children.length === 1 && isTriggerLeaf(children[0])) {
    return { ...(children[0] as CompositeLeaf), forDurationSec: trigger.forDurationSec } as Trigger;
  }
  return { ...trigger, op, children };
}

const COMPOSITE_MAX_DEPTH = 3;
const COMPOSITE_MAX_LEAVES = 10;

/** Structural caps + kind coherence for a composite trigger (save + preview). */
export function validateCompositeTrigger(trigger: CompositeTrigger, ctx: z.RefinementCtx): void {
  const stats = triggerConditionStats(trigger);
  if (stats.depth > COMPOSITE_MAX_DEPTH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger"], message: `condition groups nest at most ${COMPOSITE_MAX_DEPTH} deep` });
  }
  if (stats.leaves > COMPOSITE_MAX_LEAVES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger"], message: `at most ${COMPOSITE_MAX_LEAVES} conditions per trigger` });
  }
  if (stats.leaves < 2) {
    // collapseCompositeTrigger should have folded this to a single trigger; a
    // composite reaching validation with <2 leaves means a raw caller bypassed
    // the transform — reject rather than store a degenerate tree.
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger"], message: "a composite trigger needs at least 2 conditions" });
  }
  const badLeaf = collectTriggerLeaves(trigger).find((l) =>
    trigger.kind === "host" ? l.type !== "host_metric" : l.type === "host_metric",
  );
  if (badLeaf) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger"],
      message:
        trigger.kind === "host"
          ? "host composite triggers may only contain Polaris-host metric conditions"
          : "device composite triggers may not contain Polaris-host metric conditions",
    });
  }
}

/** Flatten a composite tree's leaves in document order. */
export function collectTriggerLeaves(node: { children: (TriggerConditionGroup | CompositeLeaf)[] }): CompositeLeaf[] {
  const out: CompositeLeaf[] = [];
  for (const c of node.children) {
    if (isTriggerLeaf(c)) out.push(c);
    else out.push(...collectTriggerLeaves(c));
  }
  return out;
}

// ─── Scope condition tree (nested AND/OR device filtering) ──────────────────
// `scope.condition` is a nested group of per-field rules — the wizard's
// SolarWinds-style builder. Group combinators:
//   and    = all children must be satisfied
//   or     = at least one child must be satisfied
//   none   = all children must NOT be satisfied      (¬or)
//   notAll = at least one child must NOT be satisfied (¬and)
// Rules are (field, operator, value) over asset identity columns; evaluation
// is the pure `evaluateScopeCondition` below — used by the in-memory matcher
// AND the engine's post-SQL filter, so the semantics can't drift.

export const SCOPE_GROUP_OPS = ["and", "or", "none", "notAll"] as const;
export type ScopeGroupOp = (typeof SCOPE_GROUP_OPS)[number];

const STRING_OPS = ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"] as const;
export const SCOPE_FIELD_OPS: Record<string, readonly string[]> = {
  assetType: ["equals", "notEquals"],
  manufacturer: STRING_OPS,
  model: STRING_OPS,
  hostname: STRING_OPS,
  os: STRING_OPS,
  tag: ["has", "notHas"],
  subnet: ["inCidr", "notInCidr"],
  status: ["equals", "notEquals"],
  assetId: ["equals", "notEquals"],
};
export const SCOPE_FIELDS = Object.keys(SCOPE_FIELD_OPS);

export interface ScopeConditionRule {
  field: string;
  operator: string;
  value: string;
}
export interface ScopeConditionGroup {
  op: ScopeGroupOp;
  children: (ScopeConditionGroup | ScopeConditionRule)[];
}

const scopeConditionRuleSchema = z
  .object({
    field: z.enum(SCOPE_FIELDS as [string, ...string[]]),
    operator: z.string().min(1).max(30),
    value: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((r, ctx) => {
    const ops = SCOPE_FIELD_OPS[r.field] ?? [];
    if (!ops.includes(r.operator)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `operator "${r.operator}" is not valid for field "${r.field}"` });
    }
    if (r.field === "subnet" && !isValidCidr(r.value) && !isValidIpAddress(r.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${r.value}" must be a CIDR (e.g. 10.20.0.0/16) or an IP address` });
    }
  });

export const scopeConditionSchema: z.ZodType<ScopeConditionGroup> = z.lazy(() =>
  z
    .object({
      op: z.enum(SCOPE_GROUP_OPS),
      children: z.array(z.union([scopeConditionRuleSchema, scopeConditionSchema])).max(50),
    })
    .strict(),
) as z.ZodType<ScopeConditionGroup>;

/** Depth/size guard for a condition tree (defense against pathological input). */
export function scopeConditionStats(cond: ScopeConditionGroup): { depth: number; rules: number } {
  let rules = 0;
  const depthOf = (g: ScopeConditionGroup): number =>
    1 + Math.max(0, ...g.children.map((c) => {
      if ("op" in c) return depthOf(c as ScopeConditionGroup);
      rules++;
      return 0;
    }));
  const depth = depthOf(cond);
  return { depth, rules };
}

/** The asset fields the condition evaluator reads (matcher + engine select). */
export interface ScopeConditionAsset {
  id: string;
  assetType?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  hostname?: string | null;
  os?: string | null;
  tags?: string[];
  ipAddress?: string | null;
  status?: string | null;
}

function matchScopeRule(rule: ScopeConditionRule, asset: ScopeConditionAsset): boolean {
  const v = rule.value.toLowerCase();
  const str = (raw: string | null | undefined): string => (raw ?? "").toLowerCase();
  switch (rule.field) {
    case "assetType": {
      const eq = str(asset.assetType) === v;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "status": {
      const eq = str(asset.status) === v;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "assetId": {
      const eq = (asset.id ?? "") === rule.value;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "tag": {
      const has = (asset.tags ?? []).some((t) => t.toLowerCase() === v);
      return rule.operator === "notHas" ? !has : has;
    }
    case "subnet": {
      const ip = asset.ipAddress ?? "";
      let inside = false;
      if (ip) {
        try { inside = ipInCidr(ip, scopeCidrOf(rule.value)); } catch { inside = false; }
      }
      return rule.operator === "notInCidr" ? !inside : inside;
    }
    default: { // manufacturer / model / hostname / os — string ops
      const raw = str(
        rule.field === "manufacturer" ? asset.manufacturer
          : rule.field === "model" ? asset.model
            : rule.field === "hostname" ? asset.hostname
              : asset.os,
      );
      switch (rule.operator) {
        case "equals": return raw === v;
        case "notEquals": return raw !== v;
        case "contains": return raw.includes(v);
        case "notContains": return !raw.includes(v);
        case "startsWith": return raw.startsWith(v);
        case "endsWith": return raw.endsWith(v);
        default: return false;
      }
    }
  }
}

/**
 * Evaluate a condition tree against an asset. Empty-group semantics follow
 * boolean identities (and([])=true, or([])=false, none=¬or, notAll=¬and) —
 * the wizard converts an empty ROOT group to allAssets, so stored trees
 * always carry at least one rule.
 */
export function evaluateScopeCondition(cond: ScopeConditionGroup, asset: ScopeConditionAsset): boolean {
  const results = cond.children.map((c) =>
    "op" in c ? evaluateScopeCondition(c as ScopeConditionGroup, asset) : matchScopeRule(c as ScopeConditionRule, asset),
  );
  switch (cond.op) {
    case "and": return results.every(Boolean);
    case "or": return results.some(Boolean);
    case "none": return !results.some(Boolean);
    case "notAll": return !results.every(Boolean);
    default: return false;
  }
}

export const scopeSchema = z
  .object({
    allAssets: z.boolean().optional(),
    assetTypes: z.array(z.string().max(100)).max(100).optional(),
    tags: z.array(z.string().max(100)).max(200).optional(),
    assetIds: z.array(z.string().max(100)).max(2000).optional(),
    integrationIds: z.array(z.string().max(100)).max(200).optional(),
    // Case-insensitive CONTAINS match per entry ("Cisco" matches
    // "Cisco Systems, Inc."), OR within the list — same AND-across/OR-within
    // semantics as the other dimensions.
    manufacturers: z.array(z.string().min(1).max(100)).max(100).optional(),
    models: z.array(z.string().min(1).max(100)).max(100).optional(),
    // CIDRs (or bare IPs = /32, /128 for v6) the asset's primary IP must fall
    // inside. Validated at save; matched in memory (ipInCidr) after the SQL pass.
    subnetCidrs: z
      .array(
        z.string().min(1).max(100).refine((c) => isValidCidr(c) || isValidIpAddress(c), {
          message: "must be a CIDR (e.g. 10.20.0.0/16) or an IP address",
        }),
      )
      .max(100)
      .optional(),
    // Nested AND/OR condition tree (the wizard's device-filter builder).
    // Authoritative when present; the flat dimensions above remain for
    // API-written and pre-builder rules (both AND together if combined).
    condition: scopeConditionSchema.optional().nullable(),
  })
  .strict()
  .superRefine((sc, ctx) => {
    if (sc.condition) {
      const { depth, rules } = scopeConditionStats(sc.condition);
      if (depth > 5) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["condition"], message: "condition groups nest at most 5 deep" });
      if (rules > 100) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["condition"], message: "at most 100 rules per condition tree" });
    }
  });

/** Bare IP → host CIDR so scope subnet entries accept either form. */
export function scopeCidrOf(entry: string): string {
  return isValidIpAddress(entry) ? entry + (entry.includes(":") ? "/128" : "/32") : entry;
}


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

export const RESET_MODES = ["manual", "auto", "timed", "condition"] as const;
export type ResetMode = (typeof RESET_MODES)[number];

export const resetSchema = z
  .object({
    mode: z.enum(RESET_MODES).default("manual"),
    // auto only — hysteresis: the alert recovers when the value no longer
    // meets `trigger.operator clearThreshold` (a fire at cpu >= 90 with
    // clearThreshold 80 clears at < 80). Omit = recover at the fire threshold.
    clearThreshold: z.number().optional().nullable(),
    // auto + condition — clear-sustain: the recovery must hold this long
    // before the alert auto-clears. 0/omit = clear on first recovered tick.
    sustainSec: z.number().int().min(0).max(86400).optional().nullable(),
    // timed only (the old clearAfterSec).
    afterSec: z.number().int().min(1).max(2592000).optional().nullable(),
    // condition only — a custom AND/OR reset tree (same leaf vocabulary as the
    // composite trigger). While the alert is firing, this tree is the sole
    // recovery authority. v1-restricted to composite triggers of the same
    // kind (validateRuleV2); per-dimension single triggers keep auto/hysteresis.
    condition: triggerConditionGroupSchema.optional().nullable(),
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
    if (reset.mode === "condition") {
      return { mode: "condition", condition: reset.condition ?? null, sustainSec: reset.sustainSec ?? null };
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
    // "condition" has no legacy representation — "auto" is the closest
    // semantic (clears without operator action) for pre-wizard readers.
    clearBehavior: reset.mode === "condition" ? "auto" : reset.mode,
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
  if (trigger?.type === "composite") validateCompositeTrigger(trigger, ctx);
  if (reset.mode === "timed" && reset.afterSec == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "afterSec"], message: "timed reset requires afterSec" });
  }
  if (reset.mode === "condition") {
    if (!reset.condition) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "condition"], message: "condition reset requires a condition tree" });
    } else if (trigger && trigger.type !== "composite") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "condition"],
        message: "a custom reset condition requires a multi-condition (composite) trigger — single-condition automations use the automatic reset (optionally with a clear threshold)",
      });
    } else {
      const stats = triggerConditionStats(reset.condition);
      if (stats.depth > 3) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "condition"], message: "reset condition groups nest at most 3 deep" });
      }
      if (stats.leaves > 10) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "condition"], message: "at most 10 conditions per reset tree" });
      }
      if (trigger?.type === "composite") {
        const badLeaf = collectTriggerLeaves(reset.condition).find((l) =>
          trigger.kind === "host" ? l.type !== "host_metric" : l.type === "host_metric",
        );
        if (badLeaf) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["reset", "condition"],
            message: "reset conditions must match the trigger's kind (device vs Polaris-host conditions)",
          });
        }
      }
    }
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
  .transform((raw): RuleInput => ({ trigger: collapseCompositeTrigger(raw.trigger), ...normalizeRuleInputCore(raw) }))
  .superRefine(validateRuleV2);

// Preview accepts partial drafts: name defaulted, trigger optional (a
// scope-only body lists the matched devices — the wizard's Step-2 preview).
export const previewInputSchema = ruleInputBaseSchema
  .extend({
    name: z.string().min(1).max(200).default("Draft automation"),
    trigger: triggerSchema.optional(),
  })
  .transform((raw): PreviewRuleInput => ({
    trigger: raw.trigger ? collapseCompositeTrigger(raw.trigger) : undefined,
    ...normalizeRuleInputCore(raw),
  }))
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

/** Trigger categories that select assets via `scope` (vs. event/host).
 *  Composite triggers are scoped iff kind="asset" — use isAssetScopedTrigger. */
export const ASSET_SCOPED_TRIGGER_TYPES = ["asset_metric", "asset_state", "change"] as const;

/** Whether a trigger selects devices via `scope` (composite depends on kind). */
export function isAssetScopedTrigger(trigger: Trigger): boolean {
  if (trigger.type === "composite") return trigger.kind === "asset";
  return (ASSET_SCOPED_TRIGGER_TYPES as readonly string[]).includes(trigger.type);
}

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
  // Probe-failure ratio over the trigger window (failed probes / total probes),
  // the same computation as the dashboard Packet Loss widget — works for ANY
  // monitored asset (switch/AP/server), not just SD-WAN. Windowed ratio: the
  // window is the measurement interval, so aggregation doesn't apply. Alert
  // with ">", e.g. > 25%. Fully-down assets (no successful probe) produce no
  // reading — they're the asset-down condition, not packet loss.
  probeLossPct: { label: "Packet loss (probe)", unit: "%" },
  hwSensorValue: { label: "Hardware sensor value", unit: "(sensor unit)" },
  storageUsedPct: { label: "Storage used", unit: "%" },
  storageUsedBytes: { label: "Storage used", unit: "bytes" },
  // Forecast metric: projected days until each growing filesystem fills
  // (30-day trend, ≥7 daily points; non-growing mounts produce no reading —
  // see storageForecastService). Alert with "<=", e.g. ≤ 14 days.
  storageDaysUntilFull: { label: "Days until storage full", unit: "days" },
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
  storageDaysUntilFull: ["mountPathPattern"],
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
      { type: "composite", label: "Multiple conditions (AND/OR)", scoped: true },
    ],
    // Composite-trigger builder vocabulary (the wizard's trigger tree).
    compositeMeta: {
      kinds: ["asset", "host"],
      groupOps: TRIGGER_GROUP_OPS,
      groupOpLabels: {
        and: "All conditions must be met (AND)",
        or: "At least one condition must be met (OR)",
      },
      maxDepth: 3,
      maxLeaves: 10,
      // Multi-dimension leaves (sensors, mounts, interfaces …) count as met
      // when ANY dimension crosses; composite automations alert once per
      // device, not per dimension.
      anyDimensionNote:
        "With multiple conditions, an automation alerts once per device; a per-sensor/per-interface condition counts as met when any of them crosses.",
    },
    // ── Rule-shape v2 vocabulary (reset + actions), wizard-facing ──────────
    resetModes: RESET_MODES,
    resetModeMeta: {
      auto: { label: "Automatically", help: "Clears when the condition recovers — optionally with a separate clear threshold (hysteresis) and a recovered-for duration." },
      condition: { label: "When custom conditions are met", help: "Clears when a separate AND/OR condition tree becomes true (multi-condition triggers only). While the alert is active, the reset conditions are the only recovery authority — set a re-notify cooldown if the trigger and reset conditions can both be true at once." },
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
      composite: ["auto", "condition", "timed", "manual"],
    },
    resetDefaults: {
      asset_metric: { mode: "auto", sustainSec: 0 },
      asset_state: { mode: "auto" },
      host_metric: { mode: "auto", sustainSec: 0 },
      event: { mode: "timed", afterSec: 3600 },
      change: { mode: "timed", afterSec: 3600 },
      composite: { mode: "auto", sustainSec: 0 },
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
    // ── Scope condition-tree vocabulary (the device-filter builder) ────────
    scopeCondition: {
      groupOps: SCOPE_GROUP_OPS,
      groupOpLabels: {
        and: "All child conditions must be satisfied (AND)",
        or: "At least one child condition must be satisfied (OR)",
        none: "All child conditions must NOT be satisfied",
        notAll: "At least one child condition must NOT be satisfied",
      },
      operatorLabels: {
        equals: "is equal to",
        notEquals: "is not equal to",
        contains: "contains",
        notContains: "does not contain",
        startsWith: "starts with",
        endsWith: "ends with",
        has: "is applied",
        notHas: "is not applied",
        inCidr: "is in subnet",
        notInCidr: "is not in subnet",
      },
      // Per-field: label, valid operators, and which option list feeds the
      // value suggestions ("assetTypes" | "manufacturers" | "models" | "tags"
      // | "subnets" from /scope-options + the registry; null = free text).
      fields: [
        { field: "assetType", label: "Device type", ops: SCOPE_FIELD_OPS.assetType, optionsFrom: "assetTypes" },
        { field: "manufacturer", label: "Manufacturer", ops: SCOPE_FIELD_OPS.manufacturer, optionsFrom: "manufacturers" },
        { field: "model", label: "Model", ops: SCOPE_FIELD_OPS.model, optionsFrom: "models" },
        { field: "hostname", label: "Hostname", ops: SCOPE_FIELD_OPS.hostname, optionsFrom: null },
        { field: "os", label: "Operating system", ops: SCOPE_FIELD_OPS.os, optionsFrom: null },
        { field: "tag", label: "Tag", ops: SCOPE_FIELD_OPS.tag, optionsFrom: "tags" },
        { field: "subnet", label: "Subnet / IP", ops: SCOPE_FIELD_OPS.subnet, optionsFrom: "subnets" },
        { field: "status", label: "Lifecycle status", ops: SCOPE_FIELD_OPS.status, optionsFrom: null, values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"] },
        { field: "assetId", label: "Asset ID", ops: SCOPE_FIELD_OPS.assetId, optionsFrom: null },
      ],
      maxDepth: 5,
      maxRules: 100,
    },
  };
}
