/**
 * src/api/routes/conflicts.ts — Discovery conflict review and resolution
 *
 * Two entityType variants share this route and UI:
 *   • "reservation" — discovery proposes changes to a manually-created reservation.
 *     Accept applies the proposed values; reject dismisses.
 *   • "asset" — discovery proposes a new Entra/Intune-sourced asset whose hostname
 *     collides with an existing untagged asset. Accept adopts the existing asset
 *     (sets its assetTag to `entra:{deviceId}` and overlays Entra fields); reject
 *     creates a separate asset with the entra: tag (admin confirmed they're
 *     different devices).
 *
 * Role-based access:
 *   admin         — all conflicts
 *   networkadmin  — reservation conflicts only
 *   assetsadmin   — asset conflicts only
 *   others        — no access (empty list, 403 on resolve)
 */

import { Router } from "express";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { logEvent } from "./events.js";
import { clampAcquiredToLastSeen } from "../../utils/assetInvariants.js";

const router = Router();
router.use(requireAuth);

const ENTRA_ASSET_TAG_PREFIX = "entra:";

function visibleEntityTypes(role: string | undefined): ("reservation" | "asset")[] {
  if (role === "admin") return ["reservation", "asset"];
  if (role === "networkadmin") return ["reservation"];
  if (role === "assetsadmin") return ["asset"];
  return [];
}

function canResolve(role: string | undefined, entityType: string): boolean {
  if (role === "admin") return true;
  if (role === "networkadmin" && entityType === "reservation") return true;
  if (role === "assetsadmin" && entityType === "asset") return true;
  return false;
}

// GET /api/v1/conflicts — list conflicts visible to the current role
router.get("/", async (req, res, next) => {
  try {
    const status = (req.query.status as string) || "pending";
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 5000);
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const entityTypes = visibleEntityTypes(req.session?.role);
    if (entityTypes.length === 0) {
      res.json({ conflicts: [], total: 0, limit, offset });
      return;
    }

    const where: any = { entityType: { in: entityTypes } };
    if (status !== "all") where.status = status;

    const [conflicts, total] = await Promise.all([
      prisma.conflict.findMany({
        where,
        include: {
          reservation: { include: { subnet: { include: { block: true } } } },
          asset: true,
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

// GET /api/v1/conflicts/count — pending count for nav badge, scoped to role
router.get("/count", async (req, res, next) => {
  try {
    const entityTypes = visibleEntityTypes(req.session?.role);
    if (entityTypes.length === 0) {
      res.json({ count: 0 });
      return;
    }
    const count = await prisma.conflict.count({
      where: { status: "pending", entityType: { in: entityTypes } },
    });
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/accept
router.post("/:id/accept", async (req, res, next) => {
  try {
    const conflict = await prisma.conflict.findUnique({
      where: { id: req.params.id },
      include: { reservation: true, asset: true },
    });
    if (!conflict) throw new AppError(404, "Conflict not found");
    if (conflict.status !== "pending") throw new AppError(409, "Conflict is already resolved");
    if (!canResolve(req.session?.role, conflict.entityType)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    if (conflict.entityType === "asset") {
      await acceptAssetConflict(conflict, req.session?.username);
    } else {
      await acceptReservationConflict(conflict, req.session?.username);
    }

    await prisma.conflict.update({
      where: { id: conflict.id },
      data: { status: "accepted", resolvedBy: req.session?.username ?? null, resolvedAt: new Date() },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/reject
router.post("/:id/reject", async (req, res, next) => {
  try {
    const conflict = await prisma.conflict.findUnique({
      where: { id: req.params.id },
      include: { reservation: true, asset: true },
    });
    if (!conflict) throw new AppError(404, "Conflict not found");
    if (conflict.status !== "pending") throw new AppError(409, "Conflict is already resolved");
    if (!canResolve(req.session?.role, conflict.entityType)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    if (conflict.entityType === "asset") {
      await rejectAssetConflict(conflict, req.session?.username);
    } else {
      await rejectReservationConflict(conflict, req.session?.username);
    }

    await prisma.conflict.update({
      where: { id: conflict.id },
      data: { status: "rejected", resolvedBy: req.session?.username ?? null, resolvedAt: new Date() },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Handlers — Reservation ──────────────────────────────────────────────────

async function acceptReservationConflict(conflict: any, actor?: string) {
  if (!conflict.reservation || !conflict.reservationId) {
    throw new AppError(500, "Reservation conflict is missing its reservation link");
  }
  const updateData: Record<string, unknown> = {};
  for (const field of conflict.conflictFields as string[]) {
    if (field === "hostname") updateData.hostname = conflict.proposedHostname;
    if (field === "owner") updateData.owner = conflict.proposedOwner;
    if (field === "projectRef") updateData.projectRef = conflict.proposedProjectRef;
    if (field === "notes") updateData.notes = conflict.proposedNotes;
  }
  if (conflict.proposedSourceType) updateData.sourceType = conflict.proposedSourceType;

  await prisma.reservation.update({
    where: { id: conflict.reservationId },
    data: updateData,
  });

  logEvent({
    action: "conflict.accepted",
    resourceType: "reservation",
    resourceId: conflict.reservationId,
    resourceName: conflict.reservation.ipAddress ?? undefined,
    actor,
    message: `Conflict accepted for reservation ${conflict.reservation.ipAddress} — applied discovered values (${(conflict.conflictFields as string[]).join(", ")})`,
  });
}

async function rejectReservationConflict(conflict: any, actor?: string) {
  if (!conflict.reservation || !conflict.reservationId) return;
  logEvent({
    action: "conflict.rejected",
    resourceType: "reservation",
    resourceId: conflict.reservationId,
    resourceName: conflict.reservation.ipAddress ?? undefined,
    actor,
    message: `Conflict rejected for reservation ${conflict.reservation.ipAddress} — existing values kept`,
  });
}

// ─── Handlers — Asset ────────────────────────────────────────────────────────

async function acceptAssetConflict(conflict: any, actor?: string) {
  if (!conflict.asset || !conflict.assetId) {
    throw new AppError(500, "Asset conflict is missing its asset link");
  }
  const proposed = (conflict.proposedAssetFields || {}) as Record<string, any>;
  if (!conflict.proposedDeviceId) {
    throw new AppError(500, "Asset conflict is missing proposedDeviceId");
  }

  const existing = conflict.asset;
  // Overlay proposed fields onto the existing asset, but only where the existing
  // field is empty — respect any manually-entered data already on the record.
  const update: Record<string, unknown> = {
    assetTag: `${ENTRA_ASSET_TAG_PREFIX}${conflict.proposedDeviceId}`,
  };
  if (!existing.hostname && proposed.hostname) update.hostname = proposed.hostname;
  if (!existing.serialNumber && proposed.serialNumber) update.serialNumber = proposed.serialNumber;
  if (!existing.macAddress && proposed.macAddress) update.macAddress = proposed.macAddress;
  if (!existing.manufacturer && proposed.manufacturer) update.manufacturer = proposed.manufacturer;
  if (!existing.model && proposed.model) update.model = proposed.model;
  if (!existing.os && proposed.os) update.os = proposed.os;
  if (!existing.osVersion && proposed.osVersion) update.osVersion = proposed.osVersion;
  if (!existing.assignedTo && proposed.assignedTo) update.assignedTo = proposed.assignedTo;
  if (proposed.lastSeen) update.lastSeen = new Date(proposed.lastSeen);
  if (!existing.acquiredAt && proposed.registrationDateTime) {
    update.acquiredAt = new Date(proposed.registrationDateTime);
  }
  if (existing.assetType === "other" && proposed.assetType) update.assetType = proposed.assetType;

  // Merge tags — keep existing manual tags, add entra-source tags
  const entraTags: string[] = ["entraid", "auto-discovered"];
  if (proposed.trustType) entraTags.push(String(proposed.trustType).toLowerCase());
  if (proposed.complianceState) entraTags.push(`intune-${String(proposed.complianceState).toLowerCase()}`);
  const existingTags = (existing.tags as string[] | null) || [];
  const merged = [...existingTags];
  for (const t of entraTags) { if (!merged.includes(t)) merged.push(t); }
  update.tags = merged;

  clampAcquiredToLastSeen(update, existing);
  await prisma.asset.update({
    where: { id: existing.id },
    data: update,
  });

  logEvent({
    action: "conflict.accepted",
    resourceType: "asset",
    resourceId: existing.id,
    resourceName: existing.hostname ?? undefined,
    actor,
    message: `Asset conflict accepted — adopted existing asset ${existing.hostname || existing.id} as Entra device ${conflict.proposedDeviceId}`,
  });
}

async function rejectAssetConflict(conflict: any, actor?: string) {
  if (!conflict.proposedDeviceId) {
    throw new AppError(500, "Asset conflict is missing proposedDeviceId");
  }
  const proposed = (conflict.proposedAssetFields || {}) as Record<string, any>;

  // Create a separate asset with the entra: tag so the next discovery run finds
  // it by assetTag and doesn't re-fire the collision.
  const createData: Record<string, unknown> = {
    assetTag: `${ENTRA_ASSET_TAG_PREFIX}${conflict.proposedDeviceId}`,
    hostname: proposed.hostname || null,
    serialNumber: proposed.serialNumber || null,
    macAddress: proposed.macAddress || null,
    manufacturer: proposed.manufacturer || null,
    model: proposed.model || null,
    assetType: proposed.assetType || "workstation",
    status: "active",
    os: proposed.os || null,
    osVersion: proposed.osVersion || null,
    assignedTo: proposed.assignedTo || null,
    lastSeen: proposed.lastSeen ? new Date(proposed.lastSeen) : null,
    acquiredAt: proposed.registrationDateTime ? new Date(proposed.registrationDateTime) : null,
    notes: `Auto-created after hostname collision was rejected — Entra deviceId ${conflict.proposedDeviceId}`,
    tags: [
      "entraid",
      "auto-discovered",
      ...(proposed.trustType ? [String(proposed.trustType).toLowerCase()] : []),
      ...(proposed.complianceState ? [`intune-${String(proposed.complianceState).toLowerCase()}`] : []),
    ],
  };
  clampAcquiredToLastSeen(createData);
  const newAsset = await prisma.asset.create({ data: createData as any });

  logEvent({
    action: "conflict.rejected",
    resourceType: "asset",
    resourceId: newAsset.id,
    resourceName: newAsset.hostname ?? undefined,
    actor,
    message: `Asset conflict rejected — created separate asset ${newAsset.hostname || newAsset.id} for Entra device ${conflict.proposedDeviceId}`,
  });
}

export default router;
