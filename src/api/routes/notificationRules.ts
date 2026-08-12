/**
 * src/api/routes/notificationRules.ts — notification RULE CRUD (Manage tab).
 *
 * Mounted at /api/v1/notification-rules.
 *   GET  /         automationManagement:read       (list)
 *   GET  /schema   automationManagement:read       (builder vocabulary)
 *   POST /dimension-values  automationManagement:read  (values the draft's
 *        devices report for a metric dimension — the sensor-class picker)
 *   POST /preview  automationManagement:fullwrite  (dry-run a draft)
 *   POST / PUT/:id / DELETE/:id   automationManagement:fullwrite  (CRUD)
 *
 * Validation via ruleInputSchema (notificationTypes); business logic in
 * notificationRuleService; preview/dry-run in notificationEngine.
 */

import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { requirePermission, hasPermission } from "../middleware/permissions.js";
import { AppError } from "../../utils/errors.js";
import { ruleInputSchema, previewInputSchema, buildSchemaCatalog, allRuleActionRefs, scopeSchema, type RuleInput } from "../../services/notificationTypes.js";
import { listRules, createRule, updateRule, deleteRule, listScopeOptions } from "../../services/notificationRuleService.js";
import { previewRule } from "../../services/notificationEngine.js";
import { listDimensionValues, dimensionPickerMeta } from "../../services/notificationDimensionService.js";
import { listRecipientUsers } from "../../services/notificationRecipientService.js";
import { listStateProbes } from "../../services/manufacturerProfileService.js";
import { runTestDelivery } from "../../services/automationTestService.js";

export const notificationRulesRouter = Router();

notificationRulesRouter.get("/", requirePermission("automationManagement", "read"), async (_req, res, next) => {
  try {
    res.json({ rules: await listRules() });
  } catch (err) { next(err); }
});

// Static path BEFORE any "/:id" so it isn't captured as an id.
// `dimensionPickers` is merged in here rather than inside buildSchemaCatalog so
// notificationTypes doesn't have to import the dimension service (which imports
// the engine, which imports notificationTypes — a cycle).
// `stateProbes` rides along for the same reason: the builder needs each state
// probe's NAME (its dimension value is a registry UUID) and its two state LABELS
// ("Alarm" / "OK"), so the 0/1 value control and the trigger sentence read in the
// operator's own words instead of "== 1". Sourced from the profile cache.
notificationRulesRouter.get("/schema", requirePermission("automationManagement", "read"), async (_req, res, next) => {
  try {
    res.json({
      ...buildSchemaCatalog(),
      dimensionPickers: dimensionPickerMeta(),
      stateProbes: listStateProbes(),
    });
  } catch (err) { next(err); }
});

// Scope-picker option lists for the wizard's device-filtering step: distinct
// manufacturers/models actually present in the inventory + the defined IPAM
// subnets (name + cidr, non-deprecated). Types come from /asset-types.
notificationRulesRouter.get("/scope-options", requirePermission("automationManagement", "read"), async (_req, res, next) => {
  try {
    res.json(await listScopeOptions());
  } catch (err) { next(err); }
});

// Users for the rule-builder recipient picker (individual-account targets).
// Gated by automationManagement (a rule editor needs it) rather than
// users:read, since those are distinct permissions.
notificationRulesRouter.get("/recipient-users", requirePermission("automationManagement", "read"), async (_req, res, next) => {
  try {
    res.json({ users: await listRecipientUsers() });
  } catch (err) { next(err); }
});

// Preview accepts partial drafts: `{scope}`-only (wizard Step 2 device list)
// and `{trigger, scope}` (Step 3 current-values check) — name is defaulted.
notificationRulesRouter.post("/preview", requirePermission("automationManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = previewInputSchema.parse(req.body);
    res.json(await previewRule(input));
  } catch (err) { next(err); }
});

/**
 * Fire ONE action of a draft for real, so an operator can see the delivery
 * work before saving. Creates a genuine (test-flagged) alert and dispatches
 * immediately — see automationTestService for the three safety properties
 * (ruleId always null, notify-only, self-mode recipient rewrite).
 *
 * Session callers only: "send to me" resolves the CALLER, and a bearer token
 * has no user to be.
 */
const testDeliverySchema = z.object({
  rule: previewInputSchema,
  path: z.object({ index: z.number().int().min(0).max(199) }),
  mode: z.enum(["self", "recipients"]).default("self"),
  target: z.enum(["delivery", "event"]).default("delivery"),
  assetId: z.string().max(100).optional(),
});

notificationRulesRouter.post("/test-delivery", requirePermission("automationManagement", "fullwrite"), async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    const username = req.session?.username;
    if (!userId || !username) throw new AppError(401, "Sign in to send a test");
    const body = testDeliverySchema.parse(req.body);
    res.json(await runTestDelivery({
      rule: body.rule,
      path: body.path,
      mode: body.mode,
      target: body.target,
      assetId: body.assetId,
      actorUserId: userId,
      actorUsername: username,
    }));
  } catch (err) { next(err); }
});

/**
 * Values the draft's OWN devices currently report for one metric dimension, so
 * the builder can offer a picker instead of a free-text box an operator has to
 * spell exactly (sensorClass is a closed enum server-side — a typo 400s; the
 * pattern dimensions silently match nothing, which is worse). Read-level like
 * /scope-options: it's an option list for the same surface.
 *
 * POST (not GET) because the body carries the draft's whole scope — including a
 * condition tree — which doesn't belong in a query string.
 */
const dimensionValuesSchema = z.object({
  metric: z.string().min(1).max(100),
  dimension: z.string().min(1).max(100),
  scope: scopeSchema.default({}),
  // Sibling dimension values already set on the same condition row — narrows the
  // list (sensor NAMES for the chosen class, WAN members for the chosen
  // health-check) so the picker can't offer a value that matches nothing.
  narrow: z.object({
    sensorClass: z.string().max(100).optional(),
    healthCheck: z.string().max(200).optional(),
    // State-probe rows belong to one probe (the row list for "PSU alarm" is not
    // the row list for "fan tray OK").
    stateProbeId: z.string().max(200).optional(),
  }).optional(),
});

notificationRulesRouter.post("/dimension-values", requirePermission("automationManagement", "read"), async (req, res, next) => {
  try {
    const { metric, dimension, scope, narrow } = dimensionValuesSchema.parse(req.body);
    res.json(await listDimensionValues(metric, dimension, scope, narrow ?? {}));
  } catch (err) { next(err); }
});

/**
 * Script actions are RCE-equivalent, so saving a rule that carries any
 * (top-level or in an escalation tier) requires automationScripts=fullwrite
 * ON TOP of automationManagement=fullwrite. Editing a rule without script
 * actions never needs the key — including edits that REMOVE script actions.
 */
function assertScriptActionPermission(req: Request, input: RuleInput): void {
  // allRuleActionRefs is the canonical walk over every place actions live —
  // top-level (+ per-action escalation tiers), rule-level escalation tiers,
  // severity-band actions (+ their tiers), band-level tiers, resolved actions.
  const hasScript = allRuleActionRefs(input).some((r) => r.action.type === "script");
  if (hasScript && !hasPermission(req, "automationScripts", "fullwrite")) {
    throw new AppError(403, "Attaching script actions requires Full Read-Write on Automation Scripts (automationScripts)");
  }
}

notificationRulesRouter.post("/", requirePermission("automationManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = ruleInputSchema.parse(req.body);
    assertScriptActionPermission(req, input);
    const rule = await createRule(input, req.session?.username);
    res.status(201).json({ rule });
  } catch (err) { next(err); }
});

notificationRulesRouter.put("/:id", requirePermission("automationManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = ruleInputSchema.parse(req.body);
    assertScriptActionPermission(req, input);
    const rule = await updateRule(req.params.id as string, input, req.session?.username);
    res.json({ rule });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2025") return next(new AppError(404, "Notification rule not found"));
    next(err);
  }
});

notificationRulesRouter.delete("/:id", requirePermission("automationManagement", "fullwrite"), async (req, res, next) => {
  try {
    await deleteRule(req.params.id as string, req.session?.username);
    res.status(204).end();
  } catch (err) {
    if ((err as { code?: string })?.code === "P2025") return next(new AppError(404, "Notification rule not found"));
    next(err);
  }
});

export default notificationRulesRouter;
