/**
 * src/api/routes/notificationRules.ts — notification RULE CRUD (Manage tab).
 *
 * Mounted at /api/v1/notification-rules.
 *   GET  /         notificationManagement:read       (list)
 *   GET  /schema   notificationManagement:read       (builder vocabulary)
 *   POST /preview  notificationManagement:fullwrite  (dry-run a draft)
 *   POST / PUT/:id / DELETE/:id   notificationManagement:fullwrite  (CRUD)
 *
 * Validation via ruleInputSchema (notificationTypes); business logic in
 * notificationRuleService; preview/dry-run in notificationEngine.
 */

import { Router } from "express";
import { requirePermission } from "../middleware/permissions.js";
import { AppError } from "../../utils/errors.js";
import { ruleInputSchema, buildSchemaCatalog } from "../../services/notificationTypes.js";
import { listRules, createRule, updateRule, deleteRule } from "../../services/notificationRuleService.js";
import { previewRule } from "../../services/notificationEngine.js";

export const notificationRulesRouter = Router();

notificationRulesRouter.get("/", requirePermission("notificationManagement", "read"), async (_req, res, next) => {
  try {
    res.json({ rules: await listRules() });
  } catch (err) { next(err); }
});

// Static path BEFORE any "/:id" so it isn't captured as an id.
notificationRulesRouter.get("/schema", requirePermission("notificationManagement", "read"), async (_req, res, next) => {
  try {
    res.json(buildSchemaCatalog());
  } catch (err) { next(err); }
});

notificationRulesRouter.post("/preview", requirePermission("notificationManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = ruleInputSchema.parse(req.body);
    res.json(await previewRule(input));
  } catch (err) { next(err); }
});

notificationRulesRouter.post("/", requirePermission("notificationManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = ruleInputSchema.parse(req.body);
    const rule = await createRule(input, req.session?.username);
    res.status(201).json({ rule });
  } catch (err) { next(err); }
});

notificationRulesRouter.put("/:id", requirePermission("notificationManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = ruleInputSchema.parse(req.body);
    const rule = await updateRule(req.params.id as string, input, req.session?.username);
    res.json({ rule });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2025") return next(new AppError(404, "Notification rule not found"));
    next(err);
  }
});

notificationRulesRouter.delete("/:id", requirePermission("notificationManagement", "fullwrite"), async (req, res, next) => {
  try {
    await deleteRule(req.params.id as string, req.session?.username);
    res.status(204).end();
  } catch (err) {
    if ((err as { code?: string })?.code === "P2025") return next(new AppError(404, "Notification rule not found"));
    next(err);
  }
});

export default notificationRulesRouter;
