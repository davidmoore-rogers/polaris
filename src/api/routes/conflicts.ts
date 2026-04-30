/**
 * src/api/routes/conflicts.ts — Discovery conflict review and resolution
 *
 * Two entityType variants share this route and UI:
 *   • "reservation" — discovery proposes changes to a manually-created reservation.
 *     Accept applies the proposed values; reject dismisses.
 *   • "asset" — discovery proposes a new Entra/Intune- or AD-sourced asset
 *     whose hostname collides with another asset. Three flavours, distinguished
 *     by `proposedAssetFields.collisionReason`:
 *       - "untagged-collision"     — collides with an untagged asset
 *       - "duplicate-registration" — collides with another asset already
 *         tagged by the same source (different deviceId / objectGUID for the
 *         same hostname — re-enrol, re-image, dual-boot, re-domain-join)
 *     `proposedAssetFields.matchedVia` is "exact" or "netbios" (the latter
 *     when matching required truncating one side to the 15-char NetBIOS
 *     limit). Accept adopts the existing asset (sets assetTag to
 *     `entra:{deviceId}` / `ad:{guid}` and overlays empty fields; on a
 *     netbios match the longer canonical hostname replaces the truncated
 *     one); reject creates a separate asset (admin confirmed they're
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
const AD_ASSET_TAG_PREFIX = "ad:";
const AD_GUID_TAG_PREFIX = "ad-guid:";
const SID_TAG_PREFIX = "sid:";

function assetTagPrefixFor(proposed: Record<string, any>): string {
  // Newer conflicts carry the prefix explicitly; older Entra-only conflicts
  // predate the field and default to the Entra prefix.
  const explicit = typeof proposed.assetTagPrefix === "string" ? proposed.assetTagPrefix : "";
  if (explicit === AD_ASSET_TAG_PREFIX || explicit === ENTRA_ASSET_TAG_PREFIX) return explicit;
  return ENTRA_ASSET_TAG_PREFIX;
}

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
  const prefix = assetTagPrefixFor(proposed);
  const isAd = prefix === AD_ASSET_TAG_PREFIX;
  const sourceLabel = isAd ? "Active Directory computer" : "Entra device";

  // Overlay proposed fields onto the existing asset, but only where the existing
  // field is empty — respect any manually-entered data already on the record.
  const update: Record<string, unknown> = {
    assetTag: `${prefix}${conflict.proposedDeviceId}`,
  };
  // Hostname has one extra rule: when the conflict was raised via 15-char
  // NetBIOS truncation (e.g. AD `cn` = "GORDONSVILLE-PL" matched against
  // Entra displayName = "GORDONSVILLE-PLANT"), prefer the longer canonical
  // form even if the existing hostname is non-empty — the truncated form is
  // a quirk of the legacy NetBIOS limit, not a deliberate choice.
  const existingHostLower = (existing.hostname || "").toLowerCase();
  const proposedHostLower = (proposed.hostname || "").toLowerCase();
  const isNetbiosUpgrade =
    proposed.matchedVia === "netbios" &&
    proposedHostLower.length > existingHostLower.length &&
    existingHostLower.length > 0 &&
    proposedHostLower.startsWith(existingHostLower);
  if ((!existing.hostname && proposed.hostname) || isNetbiosUpgrade) {
    update.hostname = proposed.hostname;
  }
  if (!existing.serialNumber && proposed.serialNumber) update.serialNumber = proposed.serialNumber;
  if (!existing.macAddress && proposed.macAddress) update.macAddress = proposed.macAddress;
  if (!existing.manufacturer && proposed.manufacturer) update.manufacturer = proposed.manufacturer;
  if (!existing.model && proposed.model) update.model = proposed.model;
  if (!existing.os && proposed.os) update.os = proposed.os;
  if (!existing.osVersion && proposed.osVersion) update.osVersion = proposed.osVersion;
  if (!existing.assignedTo && proposed.assignedTo) update.assignedTo = proposed.assignedTo;
  if (!existing.dnsName && proposed.dnsName) update.dnsName = proposed.dnsName;
  if (!existing.location && !existing.learnedLocation && proposed.learnedLocation) update.learnedLocation = proposed.learnedLocation;
  if (!existing.notes && proposed.notes) update.notes = proposed.notes;
  if (proposed.lastSeen) update.lastSeen = new Date(proposed.lastSeen);
  if (!existing.acquiredAt && proposed.registrationDateTime) {
    update.acquiredAt = new Date(proposed.registrationDateTime);
  }
  if (existing.assetType === "other" && proposed.assetType) update.assetType = proposed.assetType;
  if (isAd && proposed.disabled === true) {
    update.status = "decommissioned";
    update.statusChangedAt = new Date();
    update.statusChangedBy = actor ?? "system";
  }

  // Merge tags — keep existing manual tags, add source-specific tags and
  // cross-integration identity tags (sid: for hybrid-join, ad-guid: for AD).
  const sourceTags: string[] = isAd ? ["activedirectory", "auto-discovered"] : ["entraid", "auto-discovered"];
  if (isAd) {
    sourceTags.push(`${AD_GUID_TAG_PREFIX}${String(conflict.proposedDeviceId).toLowerCase()}`);
    if (proposed.disabled === true) sourceTags.push("ad-disabled");
    if (proposed.objectSid) sourceTags.push(`${SID_TAG_PREFIX}${String(proposed.objectSid).toUpperCase()}`);
  } else {
    if (proposed.trustType) sourceTags.push(String(proposed.trustType).toLowerCase());
    if (proposed.complianceState) sourceTags.push(`intune-${String(proposed.complianceState).toLowerCase()}`);
    if (proposed.onPremisesSecurityIdentifier) sourceTags.push(`${SID_TAG_PREFIX}${String(proposed.onPremisesSecurityIdentifier).toUpperCase()}`);
  }
  // Breadcrumb: when the existing asset already has a source assetTag and we're
  // overwriting it with a new one (duplicate-registration merge — same hostname,
  // different deviceId/objectGUID), stash the prior assetTag as a `prev-…` tag
  // so the original ID stays findable in audit/search after the merge.
  const priorTag = existing.assetTag || "";
  if (priorTag && priorTag !== update.assetTag &&
      (priorTag.startsWith(ENTRA_ASSET_TAG_PREFIX) || priorTag.startsWith(AD_ASSET_TAG_PREFIX))) {
    sourceTags.push(`prev-${priorTag}`);
  }
  const existingTags = (existing.tags as string[] | null) || [];
  const merged = [...existingTags];
  for (const t of sourceTags) { if (!merged.includes(t)) merged.push(t); }
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
    message: `Asset conflict accepted — adopted existing asset ${existing.hostname || existing.id} as ${sourceLabel} ${conflict.proposedDeviceId}`,
  });
}

async function rejectAssetConflict(conflict: any, actor?: string) {
  if (!conflict.proposedDeviceId) {
    throw new AppError(500, "Asset conflict is missing proposedDeviceId");
  }
  const proposed = (conflict.proposedAssetFields || {}) as Record<string, any>;
  const prefix = assetTagPrefixFor(proposed);
  const isAd = prefix === AD_ASSET_TAG_PREFIX;
  const sourceLabel = isAd ? "AD computer" : "Entra device";

  const tags: string[] = isAd ? ["activedirectory", "auto-discovered"] : ["entraid", "auto-discovered"];
  if (isAd) {
    tags.push(`${AD_GUID_TAG_PREFIX}${String(conflict.proposedDeviceId).toLowerCase()}`);
    if (proposed.disabled === true) tags.push("ad-disabled");
    if (proposed.objectSid) tags.push(`${SID_TAG_PREFIX}${String(proposed.objectSid).toUpperCase()}`);
  } else {
    if (proposed.trustType) tags.push(String(proposed.trustType).toLowerCase());
    if (proposed.complianceState) tags.push(`intune-${String(proposed.complianceState).toLowerCase()}`);
    if (proposed.onPremisesSecurityIdentifier) tags.push(`${SID_TAG_PREFIX}${String(proposed.onPremisesSecurityIdentifier).toUpperCase()}`);
  }

  // Create a separate asset so the next discovery run finds it by assetTag/tag
  // and doesn't re-fire the collision.
  const defaultStatus: "active" | "decommissioned" = isAd && proposed.disabled === true ? "decommissioned" : "active";
  const createData: Record<string, unknown> = {
    assetTag: `${prefix}${conflict.proposedDeviceId}`,
    hostname: proposed.hostname || null,
    dnsName: proposed.dnsName || null,
    serialNumber: proposed.serialNumber || null,
    macAddress: proposed.macAddress || null,
    manufacturer: proposed.manufacturer || null,
    model: proposed.model || null,
    assetType: proposed.assetType || (isAd ? "other" : "workstation"),
    status: proposed.status || defaultStatus,
    statusChangedAt: new Date(),
    statusChangedBy: actor ?? "system",
    os: proposed.os || null,
    osVersion: proposed.osVersion || null,
    assignedTo: proposed.assignedTo || null,
    learnedLocation: proposed.learnedLocation || null,
    lastSeen: proposed.lastSeen ? new Date(proposed.lastSeen) : null,
    acquiredAt: proposed.registrationDateTime ? new Date(proposed.registrationDateTime) : null,
    notes: proposed.notes || `Auto-created after hostname collision was rejected — ${sourceLabel} ${conflict.proposedDeviceId}`,
    tags,
  };
  clampAcquiredToLastSeen(createData);
  const newAsset = await prisma.asset.create({ data: createData as any });

  logEvent({
    action: "conflict.rejected",
    resourceType: "asset",
    resourceId: newAsset.id,
    resourceName: newAsset.hostname ?? undefined,
    actor,
    message: `Asset conflict rejected — created separate asset ${newAsset.hostname || newAsset.id} for ${sourceLabel} ${conflict.proposedDeviceId}`,
  });
}

export default router;
