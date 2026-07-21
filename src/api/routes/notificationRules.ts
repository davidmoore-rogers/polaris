/**
 * src/api/routes/notificationRules.ts — notification RULE CRUD (Manage tab).
 *
 * Mounted at /api/v1/notification-rules.
 *   GET  /         automationManagement:read       (list)
 *   GET  /schema   automationManagement:read       (builder vocabulary)
 *   POST /preview  automationManagement:fullwrite  (dry-run a draft)
 *   POST / PUT/:id / DELETE/:id   automationManagement:fullwrite  (CRUD)
 *
 * Validation via ruleInputSchema (notificationTypes); business logic in
 * notificationRuleService; preview/dry-run in notificationEngine.
 */

import { Router } from "express";
import { requirePermission } from "../middleware/permissions.js";
import { AppError } from "../../utils/errors.js";
import { ruleInputSchema, previewInputSchema, buildSchemaCatalog } from "../../services/notificationTypes.js";
import { listRules, createRule, updateRule, deleteRule } from "../../services/notificationRuleService.js";
import { previewRule } from "../../services/notificationEngine.js";
import { listRecipientUsers } from "../../services/notificationRecipientService.js";

export const notificationRulesRouter = Router();

notificationRulesRouter.get("/", requirePermission("automationManagement", "read"), async (_req, res, next) => {
  try {
    res.json({ rules: await listRules() });
  } catch (err) { next(err); }
});

// Static path BEFORE any "/:id" so it isn't captured as an id.
notificationRulesRouter.get("/schema", requirePermission("automationManagement", "read"), async (_req, res, next) => {
  try {
    res.json(buildSchemaCatalog());
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

notificationRulesRouter.post("/", requirePermission("automationManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = ruleInputSchema.parse(req.body);
    const rule = await createRule(input, req.session?.username);
    res.status(201).json({ rule });
  } catch (err) { next(err); }
});

notificationRulesRouter.put("/:id", requirePermission("automationManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = ruleInputSchema.parse(req.body);
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
