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

import { Router, type Request } from "express";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { hasPermission } from "../middleware/permissions.js";
import { logEvent } from "./events.js";
import { clampAcquiredToLastSeen, bumpLastSeen } from "../../utils/assetInvariants.js";
import { normalizeManufacturer } from "../../utils/manufacturerNormalize.js";
import { MAC_ROW_SELECT, reconcileMacAddresses, shapeMacRows } from "../../utils/macAddresses.js";

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

// Per-entity-type visibility. Built-in non-admin roles keep the historical
// split (networkadmin sees reservation conflicts; assetsadmin sees asset
// conflicts). Custom roles with discoveryConflicts permission see both
// types — admins who create a custom role can scope to a single entity
// type via the matrix description if they want, since the role-name
// partition only applies to the two seeded built-ins.
function visibleEntityTypes(req: Request): ("reservation" | "asset")[] {
  if (!hasPermission(req, "discoveryConflicts", "read")) return [];
  const roleName = req.session?.role;
  if (roleName === "networkadmin") return ["reservation"];
  if (roleName === "assetsadmin") return ["asset"];
  return ["reservation", "asset"];
}

function canResolve(req: Request, entityType: string): boolean {
  if (!hasPermission(req, "discoveryConflicts", "write")) return false;
  const roleName = req.session?.role;
  if (roleName === "networkadmin") return entityType === "reservation";
  if (roleName === "assetsadmin") return entityType === "asset";
  return true;
}

// GET /api/v1/conflicts — list conflicts visible to the current role
router.get("/", async (req, res, next) => {
  try {
    const status = (req.query.status as string) || "pending";
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 5000);
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const entityTypes = visibleEntityTypes(req);
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

    for (const c of conflicts) {
      if (c.entityType !== "asset") continue;
      const proposed = c.proposedAssetFields as Record<string, any> | null;
      const raw = proposed?.manufacturer;
      if (typeof raw === "string") {
        const normalized = normalizeManufacturer(raw);
        if (normalized && normalized !== raw) proposed!.manufacturer = normalized;
      }
    }

    res.json({ conflicts, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/conflicts/count — pending count for nav badge, scoped to role
router.get("/count", async (req, res, next) => {
  try {
    const entityTypes = visibleEntityTypes(req);
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
      include: { reservation: true, asset: { include: { macAddressRows: { select: MAC_ROW_SELECT } } } },
    });
    if (!conflict) throw new AppError(404, "Conflict not found");
    if (conflict.status !== "pending") throw new AppError(409, "Conflict is already resolved");
    if (!canResolve(req, conflict.entityType)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    if (conflict.entityType === "asset") {
      await acceptAssetConflict(conflict, req.session?.username, {});
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

// POST /api/v1/conflicts/:id/merge — asset conflicts only; per-field winner
// selection. Body: { fieldWinners: { hostname: "existing"|"proposed", ... } }.
// Fields not present in fieldWinners fall back to the default accept logic
// (today's behavior — blank-fill for most, always-overwrite for os/osVersion,
// NetBIOS upgrade for hostname). Resolves the conflict the same way Accept
// does: stamps the AssetSource row, absorbs ghost assets, marks status accepted.
router.post("/:id/merge", async (req, res, next) => {
  try {
    const conflict = await prisma.conflict.findUnique({
      where: { id: req.params.id },
      include: { reservation: true, asset: { include: { macAddressRows: { select: MAC_ROW_SELECT } } } },
    });
    if (!conflict) throw new AppError(404, "Conflict not found");
    if (conflict.status !== "pending") throw new AppError(409, "Conflict is already resolved");
    if (conflict.entityType !== "asset") {
      throw new AppError(400, "Merge with per-field selection is only supported for asset conflicts");
    }
    if (!canResolve(req, conflict.entityType)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    const raw = (req.body && req.body.fieldWinners) || {};
    const fieldWinners: Record<string, "existing" | "proposed"> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === "existing" || v === "proposed") fieldWinners[k] = v;
    }

    await acceptAssetConflict(conflict, req.session?.username, fieldWinners);

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
      include: { reservation: true, asset: { include: { macAddressRows: { select: MAC_ROW_SELECT } } } },
    });
    if (!conflict) throw new AppError(404, "Conflict not found");
    if (conflict.status !== "pending") throw new AppError(409, "Conflict is already resolved");
    if (!canResolve(req, conflict.entityType)) {
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
  const existing = conflict.reservation;
  // Merge mode: VIP + DHCP collision (neither side is a manual reservation).
  // Final sourceType is "vip" (load-bearing FortiGate config). Existing fields
  // that are non-empty are preserved; blanks get filled from the proposed
  // values. vipInfo + macAddress were already populated by discovery before
  // the conflict was raised, so we don't touch them here.
  const isMergeMode = existing.sourceType !== "manual";
  const updateData: Record<string, unknown> = {};

  if (isMergeMode) {
    if (!existing.hostname && conflict.proposedHostname) updateData.hostname = conflict.proposedHostname;
    if (!existing.owner && conflict.proposedOwner) updateData.owner = conflict.proposedOwner;
    if (!existing.projectRef && conflict.proposedProjectRef) updateData.projectRef = conflict.proposedProjectRef;
    if (!existing.notes && conflict.proposedNotes) updateData.notes = conflict.proposedNotes;
    if (existing.sourceType !== "vip") updateData.sourceType = "vip";
  } else {
    for (const field of conflict.conflictFields as string[]) {
      if (field === "hostname") updateData.hostname = conflict.proposedHostname;
      if (field === "owner") updateData.owner = conflict.proposedOwner;
      if (field === "projectRef") updateData.projectRef = conflict.proposedProjectRef;
      if (field === "notes") updateData.notes = conflict.proposedNotes;
    }
    if (conflict.proposedSourceType) updateData.sourceType = conflict.proposedSourceType;
  }

  if (Object.keys(updateData).length > 0) {
    await prisma.reservation.update({
      where: { id: conflict.reservationId },
      data: updateData,
    });
  }

  logEvent({
    action: "conflict.accepted",
    resourceType: "reservation",
    resourceId: conflict.reservationId,
    resourceName: existing.ipAddress ?? undefined,
    actor,
    message: isMergeMode
      ? `Conflict merged for reservation ${existing.ipAddress} — folded ${conflict.proposedSourceType || "discovered"} metadata into VIP record`
      : `Conflict accepted for reservation ${existing.ipAddress} — applied discovered values (${(conflict.conflictFields as string[]).join(", ")})`,
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

async function acceptAssetConflict(
  conflict: any,
  actor?: string,
  fieldWinners: Record<string, "existing" | "proposed"> = {},
) {
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

  // Per-field merge. fieldWinners (from POST /:id/merge) overrides the default
  // logic per field: "proposed" = write proposed value, "existing" = keep
  // current. Fields not present in fieldWinners fall back to today's behavior
  // (blank-fill for most, always-overwrite for os/osVersion, NetBIOS upgrade
  // for hostname). Phase 4d: assetTag is no longer the source-of-truth
  // identity link; AssetSource (sourceKind+externalId) is. The AssetSource
  // row is upserted at the end of this function regardless of fieldWinners.
  const update: Record<string, unknown> = {};
  // Hostname default: NetBIOS-upgrade rule — when the conflict was raised via
  // 15-char NetBIOS truncation, prefer the longer canonical form even if the
  // existing hostname is non-empty.
  const existingHostLower = (existing.hostname || "").toLowerCase();
  const proposedHostLower = (proposed.hostname || "").toLowerCase();
  const isNetbiosUpgrade =
    proposed.matchedVia === "netbios" &&
    proposedHostLower.length > existingHostLower.length &&
    existingHostLower.length > 0 &&
    proposedHostLower.startsWith(existingHostLower);
  const hostnameWinner = fieldWinners.hostname
    ?? ((!existing.hostname && proposed.hostname) || isNetbiosUpgrade ? "proposed" : "existing");
  if (hostnameWinner === "proposed" && proposed.hostname) update.hostname = proposed.hostname;

  const blankFill = (field: string) => {
    const winner = fieldWinners[field] ?? (!existing[field] && proposed[field] ? "proposed" : "existing");
    if (winner === "proposed" && proposed[field]) update[field] = proposed[field];
  };
  blankFill("serialNumber");
  blankFill("macAddress");
  blankFill("manufacturer");
  blankFill("model");
  blankFill("assignedTo");
  // os/osVersion default to always-overwrite (proposed wins) — auto-discovered
  // from Entra/AD, not user-entered, so the source is normally authoritative.
  // The picker can still flip them to "existing" to opt out.
  const osWinner = fieldWinners.os ?? "proposed";
  if (osWinner === "proposed" && proposed.os) update.os = proposed.os;
  const osVersionWinner = fieldWinners.osVersion ?? "proposed";
  if (osVersionWinner === "proposed" && proposed.osVersion) update.osVersion = proposed.osVersion;
  if (!existing.dnsName && proposed.dnsName) update.dnsName = proposed.dnsName;
  if (!existing.location && !existing.learnedLocation && proposed.learnedLocation) update.learnedLocation = proposed.learnedLocation;
  if (!existing.notes && proposed.notes) update.notes = proposed.notes;
  if (proposed.lastSeen) bumpLastSeen(update, existing, new Date(proposed.lastSeen), "conflict-accept");
  if (!existing.acquiredAt && proposed.registrationDateTime) {
    update.acquiredAt = new Date(proposed.registrationDateTime);
  }
  if (existing.assetType === "other" && proposed.assetType) update.assetType = proposed.assetType;
  if (isAd && proposed.disabled === true) {
    update.status = "decommissioned";
    update.statusChangedAt = new Date();
    update.statusChangedBy = actor ?? "system";
  }

  // Merge tags — keep existing manual tags, add source-specific descriptive
  // tags. Phase 4b retired the cross-integration identity tags
  // (sid:* / ad-guid:*); identity now lives on AssetSource. Phase 4e
  // retired the prev-* breadcrumb tags here too — there is no longer a
  // prior assetTag to breadcrumb against, since accept doesn't write
  // assetTag.
  const sourceTags: string[] = isAd ? ["activedirectory", "auto-discovered"] : ["entraid", "auto-discovered"];
  if (isAd) {
    if (proposed.disabled === true) sourceTags.push("ad-disabled");
  } else {
    if (proposed.trustType) sourceTags.push(String(proposed.trustType).toLowerCase());
    if (proposed.complianceState) sourceTags.push(`intune-${String(proposed.complianceState).toLowerCase()}`);
  }
  const existingTags = (existing.tags as string[] | null) || [];
  const merged = [...existingTags];
  for (const t of sourceTags) { if (!merged.includes(t)) merged.push(t); }
  update.tags = merged;

  // When the sibling-check path fires (both devices already have their own
  // Polaris assets), there will be a "ghost" asset carrying the proposed
  // source's AssetSource row. Two assets can't both own a row with the
  // same (sourceKind, externalId) because of the unique constraint —
  // before we upsert at the bottom, find the ghost (if any), merge its
  // non-empty fields into the accept target, then delete it so the
  // accept target becomes the single canonical record.
  const sourceKind = isAd ? "ad" : "entra";
  const externalId = String(conflict.proposedDeviceId).toLowerCase();
  const existingSourceForId = await prisma.assetSource.findUnique({
    where: { sourceKind_externalId: { sourceKind, externalId } },
    include: { asset: { include: { macAddressRows: { select: MAC_ROW_SELECT } } } },
  });
  const ghost: any = (existingSourceForId && existingSourceForId.assetId !== existing.id)
    ? existingSourceForId.asset
    : null;
  let mergedMacsForReconcile: ReturnType<typeof shapeMacRows> | null = null;
  if (ghost) {
    // Absorb any fields from the ghost that the accept target is still missing.
    if (!update.serialNumber && !existing.serialNumber && ghost.serialNumber) update.serialNumber = ghost.serialNumber;
    if (!update.macAddress && !existing.macAddress && ghost.macAddress) update.macAddress = ghost.macAddress;
    if (!update.manufacturer && !existing.manufacturer && ghost.manufacturer) update.manufacturer = ghost.manufacturer;
    if (!update.model && !existing.model && ghost.model) update.model = ghost.model;
    if (!update.os && ghost.os) update.os = ghost.os;
    if (!update.osVersion && ghost.osVersion) update.osVersion = ghost.osVersion;
    if (!update.assignedTo && !existing.assignedTo && ghost.assignedTo) update.assignedTo = ghost.assignedTo;
    if (!update.notes && !existing.notes && ghost.notes) update.notes = ghost.notes;
    if (!update.lastSeen && !existing.lastSeen && ghost.lastSeen) {
      update.lastSeen = ghost.lastSeen;
      if (ghost.lastSeenSource) update.lastSeenSource = ghost.lastSeenSource;
    }
    // Merge ghost's MAC history into the accept target. Side-table reconcile
    // happens AFTER the asset.update below — assembling the merged shape
    // here so we can run a single reconcile call.
    const ghostMacs = shapeMacRows(ghost.macAddressRows);
    const existingMacs = shapeMacRows(existing.macAddressRows);
    if (ghostMacs.length > 0) {
      const merged = [...existingMacs];
      for (const m of ghostMacs) {
        const key = (m.mac || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
        if (key && !merged.some((x) => (x.mac || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase() === key)) {
          merged.push(m);
        }
      }
      if (merged.length > existingMacs.length) {
        mergedMacsForReconcile = merged;
      }
    }
    // Delete the ghost. Cascade rule on AssetMacAddress.assetId removes the
    // ghost's MAC rows automatically — no separate cleanup needed.
    await prisma.asset.delete({ where: { id: ghost.id } });
  }

  clampAcquiredToLastSeen(update, existing);
  await prisma.asset.update({
    where: { id: existing.id },
    data: update,
  });
  if (mergedMacsForReconcile) {
    await reconcileMacAddresses(existing.id, mergedMacsForReconcile);
  }

  // Stamp the AssetSource row that ties this asset to the conflict's
  // entra/ad identity. This replaces the legacy `assetTag = entra:<id>`
  // marker — discovery's re-discovery uses AssetSource.externalId as the
  // primary key (see buildEntraSyncIndex / buildAdSyncIndex), so writing
  // the source row here is what makes the asset findable on the next
  // sync. The observed blob is built from the conflict's snapshot;
  // the next discovery run replaces it with a richer canonical version.
  await upsertConflictAssetSource(existing.id, conflict, proposed, prefix);

  const ghostNote = ghost ? ` (absorbed and removed ghost asset ${ghost.id})` : "";
  const winnerEntries = Object.entries(fieldWinners);
  const mergeNote = winnerEntries.length > 0
    ? ` (merged with selections: ${winnerEntries.map(([k, v]) => `${k}=${v}`).join(", ")})`
    : "";
  logEvent({
    action: "conflict.accepted",
    resourceType: "asset",
    resourceId: existing.id,
    resourceName: existing.hostname ?? undefined,
    actor,
    message: `Asset conflict accepted — adopted existing asset ${existing.hostname || existing.id} as ${sourceLabel} ${conflict.proposedDeviceId}${ghostNote}${mergeNote}`,
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

  // Phase 4b/4d: cross-integration identity tags (sid:* / ad-guid:*) and
  // the assetTag identity marker are no longer written here. The new
  // asset becomes findable on the next discovery run via the
  // AssetSource row we upsert below.
  const tags: string[] = isAd ? ["activedirectory", "auto-discovered"] : ["entraid", "auto-discovered"];
  if (isAd) {
    if (proposed.disabled === true) tags.push("ad-disabled");
  } else {
    if (proposed.trustType) tags.push(String(proposed.trustType).toLowerCase());
    if (proposed.complianceState) tags.push(`intune-${String(proposed.complianceState).toLowerCase()}`);
  }

  // Create a separate asset so the next discovery run finds it by its
  // AssetSource row and doesn't re-fire the collision.
  const defaultStatus: "active" | "decommissioned" = isAd && proposed.disabled === true ? "decommissioned" : "active";
  const createData: Record<string, unknown> = {
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
    ...(proposed.lastSeen ? { lastSeenSource: "conflict-reject" } : {}),
    acquiredAt: proposed.registrationDateTime ? new Date(proposed.registrationDateTime) : null,
    notes: proposed.notes || `Auto-created after hostname collision was rejected — ${sourceLabel} ${conflict.proposedDeviceId}`,
    tags,
  };
  clampAcquiredToLastSeen(createData);
  const newAsset = await prisma.asset.create({ data: createData as any });

  // Stamp the AssetSource row that ties the new asset to the rejected
  // source's identity. Same role the legacy `assetTag = entra:<id>` /
  // `ad:<guid>` write used to play — it's what makes the next discovery
  // run match the existing asset instead of re-firing the conflict.
  await upsertConflictAssetSource(newAsset.id, conflict, proposed, prefix);

  logEvent({
    action: "conflict.rejected",
    resourceType: "asset",
    resourceId: newAsset.id,
    resourceName: newAsset.hostname ?? undefined,
    actor,
    message: `Asset conflict rejected — created separate asset ${newAsset.hostname || newAsset.id} for ${sourceLabel} ${conflict.proposedDeviceId}`,
  });
}

// Build and upsert the entra/ad AssetSource row for an asset accepted or
// created via the conflict-resolution flow. Replaces the legacy
// `Asset.assetTag = entra:<id> / ad:<guid>` write — discovery's
// re-discovery uses (sourceKind, externalId) on AssetSource as the
// primary lookup, so this row is what makes the asset findable on the
// next sync. The observed blob is built from the conflict's snapshot;
// the next real discovery run replaces it with the canonical version.
async function upsertConflictAssetSource(
  assetId: string,
  conflict: any,
  proposed: Record<string, any>,
  prefix: string,
): Promise<void> {
  const isAd = prefix === AD_ASSET_TAG_PREFIX;
  const externalId = String(conflict.proposedDeviceId).toLowerCase();
  const sourceKind = isAd ? "ad" : "entra";
  const observed: Record<string, unknown> = isAd
    ? {
        objectGuid: externalId,
        cn: proposed.hostname ?? null,
        dnsHostName: proposed.dnsHostName ?? null,
        operatingSystem: proposed.os ?? null,
        operatingSystemVersion: proposed.osVersion ?? null,
        objectSid: proposed.objectSid ?? null,
        accountDisabled: proposed.disabled === true,
      }
    : {
        deviceId: externalId,
        displayName: proposed.hostname ?? null,
        operatingSystem: proposed.os ?? null,
        operatingSystemVersion: proposed.osVersion ?? null,
        accountEnabled: proposed.status !== "disabled" && proposed.status !== "decommissioned",
        trustType: proposed.trustType ?? null,
        onPremisesSecurityIdentifier: proposed.onPremisesSecurityIdentifier ?? null,
      };
  const lastSeen = proposed.lastSeen ? new Date(proposed.lastSeen) : new Date();
  const now = new Date();
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind, externalId } },
    create: {
      assetId,
      sourceKind,
      externalId,
      integrationId: conflict.integrationId ?? null,
      observed: observed as any,
      inferred: false,
      syncedAt: now,
      firstSeen: lastSeen,
      lastSeen,
    },
    update: {
      assetId,
      integrationId: conflict.integrationId ?? null,
      syncedAt: now,
      lastSeen,
    },
  });
}

export default router;
