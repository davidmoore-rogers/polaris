/**
 * src/api/routes/reservations.ts
 *
 * Authorization:
 *   - admin / networkadmin: full CRUD on all reservations
 *   - user: can create reservations and edit/delete only their own (createdBy match)
 *   - assetsadmin / readonly: read-only
 */

import { Router } from "express";
import { z } from "zod";
import * as reservationService from "../../services/reservationService.js";
import { AppError } from "../../utils/errors.js";
import { logEvent, buildChanges } from "./events.js";

const router = Router();

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const CreateReservationSchema = z.object({
  subnetId: z.string().uuid(),
  ipAddress: z.string().optional(),
  hostname: z.string().optional(),
  owner: z.string().min(1),
  projectRef: z.string().min(1),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
});

const UpdateReservationSchema = z.object({
  hostname: z.string().optional(),
  owner: z.string().min(1).optional(),
  projectRef: z.string().min(1).optional(),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function canWriteReservations(req: any): boolean {
  const role = req.session?.role;
  return role === "admin" || role === "networkadmin" || role === "user" || role === "assetsadmin";
}

function canWriteAny(req: any): boolean {
  const role = req.session?.role;
  return role === "admin" || role === "networkadmin";
}

// ─── Routes ───────────────────────────────────────────────────────────────────

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

router.post("/", async (req, res, next) => {
  try {
    if (!canWriteReservations(req)) {
      throw new AppError(403, "Forbidden — you do not have permission to create reservations");
    }
    const input = CreateReservationSchema.parse(req.body);
    const reservation = await reservationService.createReservation({
      ...input,
      createdBy: req.session?.username,
    });
    logEvent({ action: "reservation.created", resourceType: "reservation", resourceId: reservation.id, resourceName: input.hostname || input.ipAddress, actor: req.session?.username, message: `Reservation created for ${input.ipAddress || "subnet"} (${input.owner})` });
    res.status(201).json(reservation);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    if (!canWriteReservations(req)) {
      throw new AppError(403, "Forbidden — you do not have permission to edit reservations");
    }
    const before = await reservationService.getReservation(req.params.id);
    // User role can only edit their own reservations
    if (!canWriteAny(req)) {
      if (before.createdBy !== req.session?.username) {
        throw new AppError(403, "Forbidden — you can only edit reservations you created");
      }
    }
    const input = UpdateReservationSchema.parse(req.body);
    const reservation = await reservationService.updateReservation(req.params.id, input);
    const changes = buildChanges(
      { hostname: before.hostname, owner: before.owner, projectRef: before.projectRef, expiresAt: before.expiresAt, notes: before.notes },
      { hostname: reservation.hostname, owner: reservation.owner, projectRef: reservation.projectRef, expiresAt: reservation.expiresAt, notes: reservation.notes },
    );
    logEvent({ action: "reservation.updated", resourceType: "reservation", resourceId: req.params.id, resourceName: input.hostname, actor: req.session?.username, message: `Reservation updated`, details: changes ? { changes } : undefined });
    res.json(reservation);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    if (!canWriteReservations(req)) {
      throw new AppError(403, "Forbidden — you do not have permission to release reservations");
    }
    // User role can only release their own reservations
    if (!canWriteAny(req)) {
      const existing = await reservationService.getReservation(req.params.id);
      if (existing.createdBy !== req.session?.username) {
        throw new AppError(403, "Forbidden — you can only release reservations you created");
      }
    }
    await reservationService.releaseReservation(req.params.id);
    logEvent({ action: "reservation.released", resourceType: "reservation", resourceId: req.params.id, actor: req.session?.username, message: `Reservation released` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
