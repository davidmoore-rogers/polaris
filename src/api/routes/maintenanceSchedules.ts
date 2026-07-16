/**
 * src/api/routes/maintenanceSchedules.ts — maintenance-schedule CRUD
 * (Assets page → Maintenance modal).
 *
 * Mounted at /api/v1/maintenance-schedules.
 *   GET  /         maintenanceManagement:read       (list)
 *   POST /preview  maintenanceManagement:fullwrite  (dry-run the target filter
 *                  → capped device list + total; only monitored assets)
 *   POST / PUT/:id / DELETE/:id   maintenanceManagement:fullwrite  (CRUD)
 *
 * Zod validates the outer shape; the recurrence blob + criteria are validated
 * in maintenanceScheduleService (validateScheduleShape / normalizeCriteria).
 * Every mutation runs the maintenance reconcile inline, so an ad-hoc
 * now-starting one-shot (the status-pill "enter maintenance mode" path) takes
 * effect before the response returns.
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  previewTargets,
} from "../../services/maintenanceScheduleService.js";

const scheduleInputSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  criteria: z.unknown().optional(),
  assetIds: z.array(z.string()).max(500).optional(),
  schedule: z.unknown(),
  // In-window assets count as DOWN for child dependency suppression
  // (default true — omitting preserves launch behavior).
  suppressChildren: z.boolean().optional(),
});

const previewInputSchema = z.object({
  criteria: z.unknown().optional(),
  assetIds: z.array(z.string()).max(500).optional(),
});

export const maintenanceSchedulesRouter = Router();

maintenanceSchedulesRouter.get("/", requirePermission("maintenanceManagement", "read"), async (_req, res, next) => {
  try {
    res.json({ schedules: await listSchedules() });
  } catch (err) { next(err); }
});

// Static path BEFORE any "/:id" so it isn't captured as an id.
maintenanceSchedulesRouter.post("/preview", requirePermission("maintenanceManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = previewInputSchema.parse(req.body);
    res.json(await previewTargets(input));
  } catch (err) { next(err); }
});

maintenanceSchedulesRouter.post("/", requirePermission("maintenanceManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = scheduleInputSchema.parse(req.body);
    const schedule = await createSchedule(input, requestActor(req) ?? undefined);
    res.status(201).json({ schedule });
  } catch (err) { next(err); }
});

maintenanceSchedulesRouter.put("/:id", requirePermission("maintenanceManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = scheduleInputSchema.parse(req.body);
    const schedule = await updateSchedule(req.params.id as string, input, requestActor(req) ?? undefined);
    res.json({ schedule });
  } catch (err) { next(err); }
});

maintenanceSchedulesRouter.delete("/:id", requirePermission("maintenanceManagement", "fullwrite"), async (req, res, next) => {
  try {
    await deleteSchedule(req.params.id as string, requestActor(req) ?? undefined);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default maintenanceSchedulesRouter;
