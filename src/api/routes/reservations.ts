/**
 * src/api/routes/reservations.ts
 *
 * Authorization:
 *   - admin / networkadmin: full CRUD on all reservations
 *   - user / assetsadmin: can create reservations and edit/delete only their own (createdBy match)
 *   - readonly: read-only
 */

import { Router } from "express";
import { z } from "zod";
import * as reservationService from "../../services/reservationService.js";
import { AppError } from "../../utils/errors.js";
import { requireUserOrAbove, isNetworkAdminOrAbove } from "../middleware/auth.js";
import { logEvent, buildChanges } from "./events.js";

const router = Router();

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const MacAddressSchema = z
  .string()
  .min(1)
  .refine(
    (s) => /^[0-9a-f]{12}$|^([0-9a-f]{2}[:\-]){5}[0-9a-f]{2}$|^([0-9a-f]{4}\.){2}[0-9a-f]{4}$/i.test(s),
    "MAC address must be 12 hex chars (with optional :, -, or . separators)",
  )
  .optional();

const CreateReservationSchema = z.object({
  subnetId: z.string().uuid(),
  ipAddress: z.string().optional(),
  hostname: z.string().min(1, "Hostname is required"),
  owner: z.string().optional(),
  projectRef: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
  macAddress: MacAddressSchema,
});

const NextAvailableSchema = z.object({
  subnetId: z.string().uuid(),
  hostname: z.string().min(1, "Hostname is required"),
  owner: z.string().optional(),
  projectRef: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
  macAddress: MacAddressSchema,
});

const UpdateReservationSchema = z.object({
  hostname: z.string().optional(),
  owner: z.string().min(1, "Owner is required").optional(),
  projectRef: z.string().min(1, "Project reference is required").optional(),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /reservations/next-available  (must come before /:id)
router.post("/next-available", requireUserOrAbove, async (req, res, next) => {
  try {
    const input = NextAvailableSchema.parse(req.body);
    const reservation = await reservationService.nextAvailableReservation({
      ...input,
      createdBy: req.session?.username,
    });
    const pushedSuffix = reservation.pushStatus === "synced"
      ? ` and pushed to FortiGate`
      : "";
    logEvent({ action: "reservation.created", resourceType: "reservation", resourceId: reservation.id, resourceName: reservation.hostname || reservation.ipAddress || undefined, actor: req.session?.username, message: `Reservation auto-allocated for ${reservation.ipAddress} (${input.owner || "no owner"})${pushedSuffix}` });
    res.status(201).json(reservation);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const { subnetId, owner, projectRef, status } = req.query as Record<string, string>;
    const limit = parseInt(req.query.limit as string, 10) || undefined;
    const offset = parseInt(req.query.offset as string, 10) || undefined;
    res.json(await reservationService.listReservations({
      subnetId,
      owner,
      projectRef,
      status: status as any,
      limit,
      offset,
    }));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json(await reservationService.getReservation(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireUserOrAbove, async (req, res, next) => {
  try {
    const input = CreateReservationSchema.parse(req.body);
    const reservation = await reservationService.createReservation({
      ...input,
      createdBy: req.session?.username,
    });
    const pushedSuffix = reservation.pushStatus === "synced"
      ? ` and pushed to FortiGate`
      : "";
    logEvent({ action: "reservation.created", resourceType: "reservation", resourceId: reservation.id, resourceName: input.hostname || input.ipAddress, actor: req.session?.username, message: `Reservation created for ${input.ipAddress || "subnet"} (${input.owner})${pushedSuffix}` });
    res.status(201).json(reservation);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireUserOrAbove, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const before = await reservationService.getReservation(id);
    if (!isNetworkAdminOrAbove(req) && before.createdBy !== req.session?.username) {
      throw new AppError(403, "Forbidden — you can only edit reservations you created");
    }
    const input = UpdateReservationSchema.parse(req.body);
    const reservation = await reservationService.updateReservation(id, input);
    const changes = buildChanges(
      { hostname: before.hostname, owner: before.owner, projectRef: before.projectRef, expiresAt: before.expiresAt, notes: before.notes },
      { hostname: reservation.hostname, owner: reservation.owner, projectRef: reservation.projectRef, expiresAt: reservation.expiresAt, notes: reservation.notes },
    );
    logEvent({ action: "reservation.updated", resourceType: "reservation", resourceId: id, resourceName: input.hostname, actor: req.session?.username, message: `Reservation updated`, details: changes ? { changes } : undefined });
    res.json(reservation);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireUserOrAbove, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    if (!isNetworkAdminOrAbove(req)) {
      const existing = await reservationService.getReservation(id);
      if (existing.createdBy !== req.session?.username) {
        throw new AppError(403, "Forbidden — you can only release reservations you created");
      }
    }
    await reservationService.releaseReservation(id);
    logEvent({ action: "reservation.released", resourceType: "reservation", resourceId: id, actor: req.session?.username, message: `Reservation released` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
