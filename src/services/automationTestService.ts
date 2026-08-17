/**
 * src/services/automationTestService.ts — the wizard's "Test delivery" buttons.
 *
 * Authoring an automation used to be a blind flight: the only way to learn
 * whether the SMTP channel authenticates, whether Web Push reaches your phone,
 * or whether the audit Event lands was to save the rule and provoke a real
 * trigger. This fires ONE action of a draft — saved or not — through the exact
 * delivery path a real alert takes.
 *
 * Three safety properties, each of which is the whole reason for its code:
 *
 *  1. The test alert ALWAYS carries `ruleId: null` (and `testRun: true`), even
 *     when the draft is a saved rule. notificationEscalationService sweeps
 *     `{ cleared: false, ruleId: { in: enabledRuleIds } }`, so a test alert
 *     with a real ruleId would enter the escalation ladder and start paging
 *     people on the next 60s tick. No NotificationRuleState row is written
 *     either — the engine must not think this asset is firing.
 *  2. Only `notify` actions execute (plus the audit Event in event mode).
 *     A test button that runs a registry script is RCE-by-button, and an
 *     api_call test would open real tickets in PagerDuty or ServiceNow.
 *  3. "Send to me only" is a recipient REWRITE, not a flag read downstream:
 *     the action's recipients become the caller and every other recipient
 *     field — including emailComposition cc/bcc — is dropped, so the self path
 *     is structurally incapable of reaching anyone else.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { logger } from "../utils/logger.js";
import { executeActions } from "./automationActionService.js";
import { drainPendingDeliveries } from "./notificationDeliveryService.js";
import { sensorReadingDisplay } from "./alertChartService.js";
import { buildTemplateContext } from "../utils/notificationTemplate.js";
import { scopeRegionTagsOf } from "./notificationRecipientService.js";
import type { AutomationAction, PreviewRuleInput, Severity } from "./notificationTypes.js";
import { allRuleActionRefs } from "./notificationTypes.js";
import { previewRule } from "./notificationEngine.js";
import { triggerSummary } from "../utils/triggerSummary.js";

export type TestMode = "self" | "recipients";
export type TestTarget = "delivery" | "event";

/** Which action of the draft to test — an index into the canonical walk. */
export interface TestActionPath {
  index: number;
}

export interface SkippedAction {
  type: string;
  reason: string;
}

export interface TestDeliveryResult {
  ok: boolean;
  notificationId: string;
  message: string;
  deliveries: Array<{ transport: string; target: string; status: string; error: string | null }>;
  skipped: SkippedAction[];
  ackLinks: { minted: number; disabled: boolean; reason?: string };
  timedOut?: boolean;
}

/** A dead SMTP host must not pin an HTTP worker until its own timeout. */
const DISPATCH_BUDGET_MS = 20_000;

/**
 * PURE. Resolve the addressed action, drop what a test must never run, and in
 * self mode rewrite the recipients to the caller alone.
 */
export function selectTestActions(
  rule: Pick<PreviewRuleInput, "actions" | "severityBands" | "bandNotify" | "resetActions" | "escalation">,
  path: TestActionPath,
  mode: TestMode,
  callerUserId: string,
): { actions: AutomationAction[]; skipped: SkippedAction[] } {
  const refs = allRuleActionRefs(rule as never);
  const ref = refs[path.index];
  if (!ref) throw new AppError(400, "That action is no longer part of the automation");

  const action = ref.action;
  if (action.type === "script") {
    return { actions: [], skipped: [{ type: "script", reason: "scripts are never run by a test button" }] };
  }
  if (action.type === "api_call") {
    return { actions: [], skipped: [{ type: "api_call", reason: "an API call would act on a real system" }] };
  }
  if (action.type !== "notify") {
    return { actions: [], skipped: [{ type: action.type, reason: "nothing to deliver" }] };
  }

  if (mode === "recipients") return { actions: [action], skipped: [] };

  // Self mode: keep the channel and the message, drop every route to anyone
  // else. Listing the dropped fields explicitly (rather than deleting a
  // denylist) means a NEW recipient field can't silently survive a self-test.
  const comp = action.emailComposition
    ? { ...action.emailComposition, cc: null, bcc: null }
    : action.emailComposition;
  return {
    actions: [{
      type: "notify",
      channelId: action.channelId,
      recipientUserIds: [callerUserId],
      ...(comp ? { emailComposition: comp } : {}),
    }],
    skipped: [],
  };
}

/**
 * For a hardware-sensor draft, the sensor a test alert should be "about".
 *
 * Picks a sensor the device has actually reported in the last day AND that the
 * draft's own dimensionFilter would match — the same predicate the engine uses
 * (`hwSensorFilterMatches`), so the test can't chart a sensor the real
 * automation would never fire on. Null for every other trigger, which is what
 * makes the sensor chart render away in an ordinary test email.
 */
export interface TestReading {
  assetId: string | null;
  dimensionKey: string | null;
  dimensionLabel: string | null;
  value: number | string | boolean | null;
}

/**
 * A REAL current reading for the draft, so a test email says what a real one
 * would: which device, which sensor/interface/mount, and what the value is.
 *
 * This runs the engine's own `previewRule` — the same dry-run the wizard's
 * "Test against current data" uses — rather than re-deriving per-metric
 * queries here. Its matches come back sorted meets-first, so a test prefers a
 * device that would actually fire, and falls back to any device reporting the
 * metric at all. Null for event/change/composite drafts, which have no single
 * reading to quote.
 */
async function resolveTestReading(rule: PreviewRuleInput): Promise<TestReading | null> {
  const t = rule.trigger;
  if (!t || (t.type !== "asset_metric" && t.type !== "host_metric" && t.type !== "asset_state")) return null;
  try {
    const preview = await previewRule(rule);
    if (!preview.supported) return null;
    const best = preview.matches.find((m) => m.assetId) ?? preview.matches[0];
    if (!best) return null;
    return {
      assetId: best.assetId,
      dimensionKey: best.dimensionKey ?? null,
      dimensionLabel: best.dimension || null,
      value: best.value,
    };
  } catch (err) {
    // A test must still send when the dry-run can't resolve — it just won't be
    // able to quote a number.
    logger.warn({ err: (err as Error)?.message }, "test delivery: preview lookup failed");
    return null;
  }
}

/** The alert body a test produces — clearly a test, in the message itself. */
function testMessage(ruleName: string, hostname: string | null): string {
  return `[TEST] ${ruleName || "Automation"} — delivery test${hostname ? ` for ${hostname}` : ""}`;
}

export interface RunTestArgs {
  rule: PreviewRuleInput;
  path: TestActionPath;
  mode: TestMode;
  target: TestTarget;
  assetId?: string;
  actorUserId: string;
  actorUsername: string;
}

export async function runTestDelivery(args: RunTestArgs): Promise<TestDeliveryResult> {
  const { rule, mode, actorUserId, actorUsername } = args;

  // A real device makes the test email look like a real one (the facts table
  // and the last-hour charts all key off it). Any monitored asset will do when
  // the caller didn't name one.
  // The same fields the engine's ASSET_DETAIL_SELECT feeds a real fire: a test
  // email that lacked them would prune down to a bare shell and mislead the
  // operator about what a real alert looks like.
  const detailSelect = {
    id: true, hostname: true, tags: true, ipAddress: true, macAddress: true, assetType: true,
    status: true, location: true, learnedLocation: true, description: true, manufacturer: true, model: true,
    serialNumber: true, os: true, osVersion: true, department: true, assignedTo: true,
    lastSeenSwitch: true, lastSeenAp: true,
  } as const;
  // Prefer the device the draft would actually fire on: the test email then
  // carries a real value and the real sensor/interface, rather than the
  // alphabetically-first monitored asset that may report neither.
  const reading = await resolveTestReading(rule);
  const preferredId = args.assetId ?? reading?.assetId ?? null;
  const asset = preferredId
    ? await prisma.asset.findUnique({ where: { id: preferredId }, select: detailSelect })
    : await prisma.asset.findFirst({ where: { monitored: true }, select: detailSelect, orderBy: { hostname: "asc" } });

  const severity: Severity = rule.severity ?? "warning";
  const message = testMessage(rule.name, asset?.hostname ?? null);
  // A hardware-sensor automation's email charts the sensor it fired on, so a
  // TEST of one has to name a sensor too — otherwise the button can't show the
  // operator the very thing they're testing. Pick a real sensor the chosen
  // device reports that the draft's own filter would match.
  const dimension = reading?.dimensionKey ?? null;
  const metric = rule.trigger && (rule.trigger.type === "asset_metric" || rule.trigger.type === "host_metric")
    ? rule.trigger.metric
    : rule.trigger && rule.trigger.type === "asset_state" ? rule.trigger.field : null;
  // A sensor value is stated in the install's display unit, matching the chart
  // below it — see sensorReadingDisplay.
  const sensorShown = metric === "hwSensorValue" && asset && dimension
    ? await sensorReadingDisplay(asset.id, dimension, reading?.value ?? null)
    : null;

  const notif = await prisma.notification.create({
    data: {
      // ALWAYS null — see the header. A real ruleId would enlist this alert in
      // the escalation sweep.
      ruleId: null,
      testRun: true,
      assetId: asset?.id ?? null,
      assetHostname: asset?.hostname ?? null,
      severity,
      message,
      regionTags: [],
      dimension,
      metric,
    },
    select: { id: true },
  });

  if (args.target === "event") {
    await logEvent({
      action: "notification.triggered",
      resourceType: "notification",
      resourceId: notif.id,
      resourceName: rule.name,
      actor: actorUsername,
      level: severity === "critical" || severity === "serious" ? "error" : severity === "warning" ? "warning" : "info",
      message,
      details: { test: true, ruleId: null, assetId: asset?.id ?? null, severity },
    });
    return {
      ok: true,
      notificationId: notif.id,
      message: "Test Event written — look for notification.triggered in the Events tab.",
      deliveries: [],
      skipped: [],
      ackLinks: { minted: 0, disabled: true, reason: "an Event carries no acknowledge link" },
    };
  }

  const { actions, skipped } = selectTestActions(rule, args.path, mode, actorUserId);
  if (actions.length === 0) {
    return {
      ok: false,
      notificationId: notif.id,
      message: skipped[0]?.reason ?? "Nothing to deliver for that action",
      deliveries: [],
      skipped,
      ackLinks: { minted: 0, disabled: true },
    };
  }

  const ctx = buildTemplateContext({
    asset: asset?.hostname ?? "test device",
    severity,
    time: new Date(),
    ruleName: rule.name,
    ruleDescription: rule.description ?? null,
    message,
    metric: metric ?? "test",
    value: reading?.value == null ? "" : String(reading.value),
    dimension: reading?.dimensionLabel ?? "",
    // The same sentence a real fire produces, with the CURRENT reading in it —
    // otherwise a test is the one email that can't say what the automation is
    // actually about.
    triggerSummary: triggerSummary({
      trigger: rule.trigger as never,
      value: sensorShown?.value ?? reading?.value ?? null,
      dimensionLabel: reading?.dimensionLabel ?? null,
      sensorUnit: sensorShown?.unit ?? null,
    }),
    assetDetail: asset ? { ...asset, status: String(asset.status) } : null,
  });

  await executeActions(notif.id, actions, ctx, {
    scopeRegionTags: scopeRegionTagsOf(rule.scope as never),
    assetRegionTags: (asset?.tags ?? []).filter((t) => t.toLowerCase().startsWith("region:")).map((t) => t.slice(7)),
    assetId: asset?.id ?? null,
    ruleName: rule.name,
    ruleEmailComposition: rule.emailComposition ?? null,
    actor: actorUsername,
  });

  // Dispatch now rather than waiting up to 15s for the drain tick — but keep a
  // budget, because the drain talks SMTP/Graph synchronously.
  let timedOut = false;
  try {
    await Promise.race([
      drainPendingDeliveries({ notificationId: notif.id }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error("budget")), DISPATCH_BUDGET_MS)),
    ]);
  } catch (err) {
    timedOut = (err as Error)?.message === "budget";
    if (!timedOut) logger.warn({ err: (err as Error)?.message }, "test delivery dispatch failed");
  }

  const rows = await prisma.notificationDelivery.findMany({
    where: { notificationId: notif.id },
    select: { transport: true, target: true, status: true, error: true, meta: true },
  });
  const minted = rows.filter((r) => {
    const m = r.meta && typeof r.meta === "object" ? (r.meta as Record<string, unknown>) : null;
    return !!m?.ack;
  }).length;

  const sent = rows.filter((r) => r.status === "sent").length;
  const failed = rows.filter((r) => r.status === "failed");
  const ok = sent > 0 && failed.length === 0;

  await logEvent({
    action: "automation.test_delivery",
    resourceType: "notification",
    resourceId: notif.id,
    resourceName: rule.name,
    actor: actorUsername,
    // "recipients" mode reached real people — that belongs above info.
    level: mode === "recipients" ? "warning" : "info",
    message: `Delivery test for "${rule.name}": ${sent} sent, ${failed.length} failed (${mode === "self" ? "sender only" : "configured recipients"})`,
    details: { mode, rows: rows.length, sent, failed: failed.length, skipped, ackLinksMinted: minted },
  });

  const detail = failed.length ? ` — ${failed[0]!.error ?? "delivery failed"}` : "";
  const targets = rows.map((r) => r.target).filter(Boolean);
  return {
    ok,
    notificationId: notif.id,
    message: timedOut
      ? "Still sending — check the alert's deliveries in a moment."
      : sent > 0
        ? `Sent to ${targets.length ? targets.join(", ") : `${sent} destination(s)`}${detail}`
        : `Nothing was delivered${detail || " — the action resolved to no recipients"}`,
    deliveries: rows.map((r) => ({ transport: r.transport, target: r.target, status: r.status, error: r.error })),
    skipped,
    ackLinks: {
      minted,
      disabled: minted === 0,
      ...(minted === 0 && !process.env.POLARIS_PUBLIC_URL ? { reason: "POLARIS_PUBLIC_URL is not set, so no acknowledge links can be built" } : {}),
    },
    ...(timedOut ? { timedOut } : {}),
  };
}
