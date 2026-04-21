/**
 * src/api/routes/conflicts.ts — Discovery conflict review and resolution
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requireNetworkAdmin } from "../middleware/auth.js";
import { logEvent } from "./events.js";

const router = Router();

router.use(requireNetworkAdmin);

// GET /api/v1/conflicts — list conflicts
router.get("/", async (req, res, next) => {
  try {
    const status = (req.query.status as string) || "pending";
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const where = status === "all" ? {} : { status: status as any };

    const [conflicts, total] = await Promise.all([
      prisma.conflict.findMany({
        where,
        include: {
          reservation: {
            include: { subnet: { include: { block: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.conflict.count({ where }),
    ]);

    res.json({ conflicts, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/conflicts/count — quick pending count for badge
router.get("/count", async (_req, res, next) => {
  try {
    const count = await prisma.conflict.count({ where: { status: "pending" } });
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/accept — apply proposed values to the reservation
router.post("/:id/accept", async (req, res, next) => {
  try {
    const conflict = await prisma.conflict.findUnique({
      where: { id: req.params.id },
      include: { reservation: true },
    });
    if (!conflict) throw new AppError(404, "Conflict not found");
    if (conflict.status !== "pending") throw new AppError(409, "Conflict is already resolved");

    const updateData: Record<string, unknown> = {};
    for (const field of conflict.conflictFields) {
      if (field === "hostname") updateData.hostname = conflict.proposedHostname;
      if (field === "owner") updateData.owner = conflict.proposedOwner;
      if (field === "projectRef") updateData.projectRef = conflict.proposedProjectRef;
      if (field === "notes") updateData.notes = conflict.proposedNotes;
    }
    // Apply the discovered sourceType so the reservation is no longer "manual"
    updateData.sourceType = conflict.proposedSourceType;

    await prisma.reservation.update({
      where: { id: conflict.reservationId },
      data: updateData,
    });

    await prisma.conflict.update({
      where: { id: conflict.id },
      data: { status: "accepted", resolvedBy: req.session?.username ?? null, resolvedAt: new Date() },
    });

    logEvent({
      action: "conflict.accepted",
      resourceType: "reservation",
      resourceId: conflict.reservationId,
      resourceName: conflict.reservation.ipAddress ?? undefined,
      actor: req.session?.username,
      message: `Conflict accepted for reservation ${conflict.reservation.ipAddress} — applied discovered values (${conflict.conflictFields.join(", ")})`,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/reject — keep existing reservation, dismiss conflict
router.post("/:id/reject", async (req, res, next) => {
  try {
    const conflict = await prisma.conflict.findUnique({
      where: { id: req.params.id },
      include: { reservation: true },
    });
    if (!conflict) throw new AppError(404, "Conflict not found");
    if (conflict.status !== "pending") throw new AppError(409, "Conflict is already resolved");

    await prisma.conflict.update({
      where: { id: conflict.id },
      data: { status: "rejected", resolvedBy: req.session?.username ?? null, resolvedAt: new Date() },
    });

    logEvent({
      action: "conflict.rejected",
      resourceType: "reservation",
      resourceId: conflict.reservationId,
      resourceName: conflict.reservation.ipAddress ?? undefined,
      actor: req.session?.username,
      message: `Conflict rejected for reservation ${conflict.reservation.ipAddress} — existing values kept`,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
