/**
 * src/services/assetTypeService.ts
 *
 * CRUD + caching for the AssetTypeDef registry. The synchronous lookups live
 * in src/utils/assetTypes.ts so the Prisma extension in db.ts can validate
 * Asset.assetType writes without cycling through this service.
 *
 * Lifecycle:
 *   1. App boot calls refreshCache() once to populate the in-memory map.
 *   2. Every mutation (create / update / delete) re-runs refreshCache() so
 *      subsequent writes see the new state immediately.
 *   3. Built-in rows (seeded by the registry cutover migration with
 *      is_built_in=true AND is_protected=true) cannot be renamed or deleted.
 *      Code special-cases keyed on the literal names ("firewall", "switch",
 *      "access_point", etc.) remain stable across operator edits.
 *   4. Custom rows can be renamed in place. Renames are transactional:
 *      every Asset row holding the old name is rewritten to the new name in
 *      the same $transaction as the registry row update, so no Asset can
 *      hold a stale assetType value referencing a renamed type.
 *   5. Custom rows can be deleted only when no Asset.assetType row
 *      references them. Asset.assetType is a String (not a relation), so the
 *      service counts usage explicitly before issuing the delete.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import {
  setAssetTypeRegistry,
  validateAssetTypeName,
  validateAssetTypeLabel,
  normalizeAssetTypeName,
  BUILT_IN_ASSET_TYPES,
} from "../utils/assetTypes.js";

export interface AssetTypeRow {
  id: string;
  name: string;
  label: string;
  description: string | null;
  isBuiltIn: boolean;
  isProtected: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Live count of Assets currently using this type — included on list/get for UI use. */
  usageCount?: number;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function listAssetTypes(opts: { withUsage?: boolean } = {}): Promise<AssetTypeRow[]> {
  const rows = await prisma.assetTypeDef.findMany({
    orderBy: [{ isBuiltIn: "desc" }, { label: "asc" }],
  });
  if (!opts.withUsage) return rows;
  const counts = await prisma.asset.groupBy({
    by: ["assetType"],
    _count: { _all: true },
  });
  const byName = new Map(counts.map((c) => [c.assetType, c._count._all]));
  return rows.map((r) => ({ ...r, usageCount: byName.get(r.name) ?? 0 }));
}

export async function getAssetType(id: string): Promise<AssetTypeRow> {
  const row = await prisma.assetTypeDef.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Asset type not found");
  const usage = await prisma.asset.count({ where: { assetType: row.name } });
  return { ...row, usageCount: usage };
}

// ─── Writes ────────────────────────────────────────────────────────────────

export async function createAssetType(input: {
  name: string;
  label: string;
  description?: string | null;
  createdBy?: string | null;
}): Promise<AssetTypeRow> {
  const name = normalizeAssetTypeName(input.name);
  const nameError = validateAssetTypeName(input.name);
  if (nameError) throw new AppError(400, nameError);
  const labelError = validateAssetTypeLabel(input.label);
  if (labelError) throw new AppError(400, labelError);
  const existing = await prisma.assetTypeDef.findUnique({ where: { name } });
  if (existing) throw new AppError(409, `Asset type "${name}" already exists`);
  const row = await prisma.assetTypeDef.create({
    data: {
      name,
      label: input.label.trim(),
      description: input.description?.trim() || null,
      isBuiltIn: false,
      isProtected: false,
      createdBy: input.createdBy ?? null,
    },
  });
  await refreshCache();
  return row;
}

export async function updateAssetType(
  id: string,
  input: { name?: string; label?: string; description?: string | null },
): Promise<AssetTypeRow> {
  const current = await prisma.assetTypeDef.findUnique({ where: { id } });
  if (!current) throw new AppError(404, "Asset type not found");

  // Built-in rows are immutable. Blocks rename + label edit + description
  // edit alike — keeps the eight historical buckets stable so dashboards,
  // tags, and special-case code can rely on their identity.
  if (current.isProtected) {
    throw new AppError(403, "Built-in asset types cannot be edited.");
  }

  const data: { name?: string; label?: string; description?: string | null } = {};
  let nameChange: { from: string; to: string } | null = null;

  if (typeof input.name === "string" && input.name !== current.name) {
    const next = normalizeAssetTypeName(input.name);
    const err = validateAssetTypeName(input.name);
    if (err) throw new AppError(400, err);
    const collision = await prisma.assetTypeDef.findUnique({ where: { name: next } });
    if (collision && collision.id !== id) throw new AppError(409, `Asset type "${next}" already exists`);
    data.name = next;
    nameChange = { from: current.name, to: next };
  }

  if (typeof input.label === "string") {
    const err = validateAssetTypeLabel(input.label);
    if (err) throw new AppError(400, err);
    data.label = input.label.trim();
  }

  if (input.description !== undefined) {
    const desc = input.description?.trim() ?? "";
    data.description = desc ? desc : null;
  }

  if (Object.keys(data).length === 0) {
    return current;
  }

  let row: AssetTypeRow;
  if (nameChange) {
    // Rename in a single transaction: rewrite every Asset row holding the old
    // name to the new name FIRST, then update the registry row. If the Asset
    // rewrite fails for any reason the registry stays unchanged and the
    // cache stays consistent.
    [, row] = await prisma.$transaction([
      prisma.asset.updateMany({
        where: { assetType: nameChange.from },
        data: { assetType: nameChange.to },
      }),
      prisma.assetTypeDef.update({ where: { id }, data }),
    ]);
  } else {
    row = await prisma.assetTypeDef.update({ where: { id }, data });
  }
  await refreshCache();
  return row;
}

export async function deleteAssetType(id: string): Promise<void> {
  const current = await prisma.assetTypeDef.findUnique({ where: { id } });
  if (!current) throw new AppError(404, "Asset type not found");
  if (current.isProtected) {
    throw new AppError(403, "Built-in asset types cannot be deleted.");
  }
  const inUse = await prisma.asset.count({ where: { assetType: current.name } });
  if (inUse > 0) {
    throw new AppError(409, `Cannot delete asset type "${current.name}" — ${inUse} asset(s) still reference it. Reassign or delete those assets first.`);
  }
  await prisma.assetTypeDef.delete({ where: { id } });
  await refreshCache();
}

// ─── Cache + lifecycle ─────────────────────────────────────────────────────

/**
 * Reload the in-memory cache from the DB. Called at boot (after the
 * registry migration has had a chance to seed) and after every CRUD
 * mutation. Synchronous validation in src/utils/assetTypes.ts reads this
 * cache; the Prisma extension in db.ts uses it to reject Asset.assetType
 * writes pointing at a non-existent registry name.
 */
export async function refreshCache(): Promise<void> {
  const rows = await prisma.assetTypeDef.findMany({
    select: { name: true, label: true, isBuiltIn: true },
  });
  setAssetTypeRegistry(rows);
}

/**
 * Idempotent seed for the built-in types (eight historical + the two vCenter
 * types added by migration 20260709000000). The registry migrations are the
 * authoritative seed path; this helper exists so a manual
 * `npx prisma migrate reset` or a Docker volume nuke doesn't leave the
 * registry empty while the cache is being warmed. Safe to call on every
 * boot — existing rows are left untouched.
 */
const BUILT_IN_SEEDS: ReadonlyArray<{ name: string; label: string; description: string }> = [
  { name: "server",       label: "Server",       description: "Physical or virtual host running server workloads." },
  { name: "switch",       label: "Switch",       description: "Managed Layer-2/3 switch (FortiSwitch and other vendors)." },
  { name: "router",       label: "Router",       description: "Routing appliance (non-firewall)." },
  { name: "firewall",     label: "Firewall",     description: "Perimeter / branch firewall. FortiGates land here." },
  { name: "workstation",  label: "Workstation",  description: "Desktop / laptop endpoint." },
  { name: "printer",      label: "Printer",      description: "Network printer / multi-function device." },
  { name: "access_point", label: "Access Point", description: "Wireless access point (FortiAPs and other vendors)." },
  { name: "other",        label: "Other",        description: "Default bucket for assets that do not fit the built-in categories." },
  { name: "virtual_machine", label: "Virtual Machine", description: "vCenter-discovered virtual machine. Carries a VM→host dependency link and hypervisor-view telemetry." },
  { name: "hypervisor",      label: "Hypervisor",      description: "Virtualization host (ESXi). Parents its VMs in the dependency tree; datastores render on its details view." },
];

export async function seedBuiltInAssetTypes(): Promise<{ inserted: number }> {
  // Defense-in-depth in case the migration's INSERT was skipped (e.g. fresh
  // shadow database during prisma migrate dev or operator-restored backup).
  let inserted = 0;
  for (const seed of BUILT_IN_SEEDS) {
    if (!(BUILT_IN_ASSET_TYPES as readonly string[]).includes(seed.name)) continue;
    const existing = await prisma.assetTypeDef.findUnique({ where: { name: seed.name } });
    if (existing) continue;
    await prisma.assetTypeDef.create({
      data: {
        name: seed.name,
        label: seed.label,
        description: seed.description,
        isBuiltIn: true,
        isProtected: true,
      },
    });
    inserted++;
  }
  return { inserted };
}
