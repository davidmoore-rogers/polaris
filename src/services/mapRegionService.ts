/**
 * src/services/mapRegionService.ts
 *
 * Map regions — operator-drawn polygons on the Device Map. Each region has a
 * unique name; assets carry a `region:<name>` tag when they belong to it:
 *   - firewalls whose lat/lng falls inside the polygon,
 *   - the FortiSwitches / FortiAPs whose `fortinetTopology.controllerFortigate`
 *     matches an enclosed firewall's hostname, AND
 *   - any asset whose IP falls in a subnet served by an enclosed firewall
 *     (Subnet.fortigateDevice = the firewall hostname) — this is how servers /
 *     workstations / other non-geolocated assets inherit a region.
 *
 * **Subnets carry the tag too.** A `Subnet` served by an enclosed firewall
 * inherits `region:<name>` from that gate — the same match that propagates the
 * region to the subnet's assets, applied to the subnet row itself. Without it
 * the IPAM Networks list (whose Sources column IS `fortigateDevice`) had no way
 * to filter address space by region even though every asset inside it was
 * already tagged. Subnet tags follow the identical additive contract as asset
 * tags: added by membership, stripped only on rename/delete.
 *
 * Storage: single JSON blob in Setting under SETTING_KEY (mirrors the
 * allocationTemplateService pattern).
 *
 * Reconciler is **additive**: it adds region tags to in-polygon assets and
 * only strips a tag when the region is renamed or deleted. Manual operator
 * attachments (e.g. an endpoint server hand-tagged with `region:Atlanta`)
 * survive across runs. Manually *removing* a region tag from an in-polygon
 * asset will be re-added on the next reconcile — that direction is
 * authoritative by design so polygon membership always implies the tag.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { pointInPolygon, type LatLng } from "../utils/geo.js";
import { cidrContains } from "../utils/cidr.js";
import { controllerIdentityKeys, readFirewallDeviceName } from "../utils/fortinetParentKey.js";

const SETTING_KEY = "mapRegions";
const TAG_PREFIX = "region:";
const TAG_CATEGORY = "Map Regions";
const TAG_COLOR_PALETTE = [
  "#4fc3f7", "#4ade80", "#f59e0b", "#f472b6", "#a78bfa",
  "#fb923c", "#38bdf8", "#34d399", "#e879f9", "#facc15",
  "#f87171", "#2dd4bf", "#818cf8", "#c084fc",
];

function randomTagColor(): string {
  return TAG_COLOR_PALETTE[Math.floor(Math.random() * TAG_COLOR_PALETTE.length)]!;
}

export interface MapRegion {
  id: string;
  name: string;
  /** [[lat, lng], ...]; >=3 points, <=1000 vertices */
  polygon: LatLng[];
  /** Hex color "#rrggbb" used for the polygon stroke + fill on the map. */
  color: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveRegionInput {
  id?: string;
  name?: string;
  polygon?: LatLng[];
  color?: string;
  actor?: string | null;
}

export interface ReconcileSummary extends Record<string, unknown> {
  regionId?: string;
  /** Assets that gained the region tag. */
  added: number;
  /** Assets that lost it (rename / delete paths only). */
  removed: number;
  assetsTouched: number;
  /** Subnets that gained the region tag (inherited from their serving gate). */
  subnetsAdded: number;
  /** Subnets that lost it (rename / delete paths only). */
  subnetsRemoved: number;
  subnetsTouched: number;
}

// --- Persistence helpers ---

async function loadAll(): Promise<MapRegion[]> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row?.value) return [];
  const val = row.value as unknown;
  if (!Array.isArray(val)) return [];
  // Legacy regions pre-date the color field — back-fill at read time with a
  // random palette pick so the UI has something to render. Persist back on
  // the next write through updateRegion; we deliberately don't write here
  // (a read shouldn't mutate the Setting blob).
  return (val as Partial<MapRegion>[]).map((r) => ({
    ...(r as MapRegion),
    color: typeof r.color === "string" && HEX_COLOR_RE.test(r.color) ? r.color.toLowerCase() : randomTagColor(),
  }));
}

async function persistAll(regions: MapRegion[]): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: regions as any },
    create: { key: SETTING_KEY, value: regions as any },
  });
}

// --- Validation ---

const MAX_VERTICES = 1000;
const MAX_NAME = 64;
const CONTROL_CHARS = /\p{Cc}/u;

function validateName(name: unknown): string {
  if (typeof name !== "string") throw new AppError(400, "Region name is required");
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new AppError(400, "Region name is required");
  if (trimmed.length > MAX_NAME) {
    throw new AppError(400, `Region name must be ${MAX_NAME} characters or fewer`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new AppError(400, "Region name cannot contain control characters");
  }
  return trimmed;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validateColor(color: unknown): string {
  if (typeof color !== "string") throw new AppError(400, "Color must be a hex string");
  const trimmed = color.trim();
  if (!HEX_COLOR_RE.test(trimmed)) {
    throw new AppError(400, 'Color must be a 7-character hex string like "#4fc3f7"');
  }
  return trimmed.toLowerCase();
}

function validatePolygon(polygon: unknown): LatLng[] {
  if (!Array.isArray(polygon)) {
    throw new AppError(400, "Polygon must be an array of [lat, lng] pairs");
  }
  if (polygon.length < 3) throw new AppError(400, "Polygon must have at least 3 vertices");
  if (polygon.length > MAX_VERTICES) {
    throw new AppError(400, `Polygon cannot have more than ${MAX_VERTICES} vertices`);
  }
  const cleaned: LatLng[] = [];
  for (const pt of polygon) {
    if (!Array.isArray(pt) || pt.length !== 2) {
      throw new AppError(400, "Each polygon vertex must be a [lat, lng] pair");
    }
    const lat = Number(pt[0]);
    const lng = Number(pt[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new AppError(400, "Polygon vertex coordinates must be finite numbers");
    }
    if (lat < -90 || lat > 90) throw new AppError(400, "Latitude must be between -90 and 90");
    if (lng < -180 || lng > 180) throw new AppError(400, "Longitude must be between -180 and 180");
    cleaned.push([lat, lng]);
  }
  return cleaned;
}

// --- Tag helpers ---

function regionTag(name: string): string {
  return `${TAG_PREFIX}${name}`;
}

async function upsertTagRegistry(name: string): Promise<void> {
  const tagName = regionTag(name);
  try {
    // Pick a random palette color for new region tags so the operator sees a
    // varied default; existing tags keep whatever color was previously chosen.
    await prisma.tag.upsert({
      where: { name: tagName },
      update: {},
      create: { name: tagName, category: TAG_CATEGORY, color: randomTagColor() },
    });
  } catch (err: any) {
    logger.debug({ err: err?.message ?? String(err), tag: tagName }, "mapRegion: tag upsert failed (non-fatal)");
  }
}

async function deleteTagRegistry(name: string): Promise<void> {
  const tagName = regionTag(name);
  try {
    await prisma.tag.deleteMany({ where: { name: tagName } });
  } catch (err: any) {
    logger.debug({ err: err?.message ?? String(err), tag: tagName }, "mapRegion: tag delete failed (non-fatal)");
  }
}

// --- Membership computation ---

interface TopologyMeta {
  role?: "fortigate" | "fortiswitch" | "fortiap";
  controllerFortigate?: string | null;
  controllerSerial?: string | null;
}

function readTopology(raw: unknown): TopologyMeta {
  if (raw && typeof raw === "object") return raw as TopologyMeta;
  return {};
}

export interface RegionMembership {
  /** Asset IDs that should carry the region tag. */
  assetIds: Set<string>;
  /** Subnet IDs that should carry it — those served by an enclosed gate. */
  subnetIds: Set<string>;
}

/**
 * Compute what should currently carry the given region's tag: every firewall
 * whose pin is inside the polygon, every FortiSwitch / FortiAP whose
 * `fortinetTopology.controllerFortigate` matches one of those firewalls, every
 * subnet those firewalls serve, and every asset addressed out of one of those
 * subnets.
 */
async function computeMembership(region: MapRegion): Promise<RegionMembership> {
  const firewalls = await prisma.asset.findMany({
    where: {
      assetType: "firewall",
      latitude: { not: null },
      longitude: { not: null },
    },
    select: { id: true, hostname: true, serialNumber: true, fortinetTopology: true, latitude: true, longitude: true },
  });

  const enclosedFirewalls: Array<{ id: string; keys: string[]; serial: string | null }> = [];
  for (const fw of firewalls) {
    const lat = fw.latitude as unknown as number | null;
    const lng = fw.longitude as unknown as number | null;
    if (lat == null || lng == null) continue;
    if (pointInPolygon([lat, lng], region.polygon)) {
      // Every name this gate can be known by in a child's stamp or in
      // Subnet.fortigateDevice — serial, its FortiManager device name, and its
      // configured hostname. Matching on hostname ALONE (the pre-2026-08
      // behavior) silently dropped every switch/AP and every subnet-propagated
      // asset behind a gate whose FMG device name differs from its hostname.
      // See utils/fortinetParentKey.ts.
      enclosedFirewalls.push({
        id: fw.id,
        serial: fw.serialNumber,
        keys: controllerIdentityKeys({
          hostname: fw.hostname,
          serialNumber: fw.serialNumber,
          deviceName: readFirewallDeviceName(fw.fortinetTopology),
        }),
      });
    }
  }

  const memberIds = new Set<string>(enclosedFirewalls.map((f) => f.id));
  const enclosedKeys = new Set<string>(enclosedFirewalls.flatMap((f) => f.keys));
  const enclosedSerials = new Set<string>(
    enclosedFirewalls.map((f) => (f.serial || "").trim()).filter((s) => s.length > 0),
  );
  if (enclosedKeys.size === 0) return { assetIds: memberIds, subnetIds: new Set<string>() };

  const infra = await prisma.asset.findMany({
    where: {
      assetType: { in: ["switch", "access_point"] },
    },
    select: { id: true, fortinetTopology: true },
  });
  for (const a of infra) {
    const topo = readTopology(a.fortinetTopology);
    const ctrlSerial = (topo.controllerSerial || "").trim();
    if (ctrlSerial && enclosedSerials.has(ctrlSerial)) { memberIds.add(a.id); continue; }
    const ctrl = (topo.controllerFortigate || "").trim();
    if (ctrl && enclosedKeys.has(ctrl)) memberIds.add(a.id);
  }

  // Subnet propagation: the subnets an enclosed firewall serves inherit the
  // region themselves, and so does any asset whose IP falls inside one. The
  // subnet half is what gives the IPAM Networks list a region to filter on; the
  // asset half is how servers / workstations / standalone assets — which have
  // no coordinates — get a region.
  //
  // `Subnet.fortigateDevice` holds the discovery-time device NAME (FMG's name,
  // or the standalone gate's), NOT the gate's configured hostname — so the
  // pre-2026-08 `in: enclosedHostnames` comparison matched nothing on installs
  // where the two differ, and no non-Fortinet asset ever inherited a region.
  // `enclosedKeys` includes the device name.
  const regionSubnets = await prisma.subnet.findMany({
    where: { fortigateDevice: { in: Array.from(enclosedKeys) } },
    select: { id: true, cidr: true },
  });
  const subnetIds = new Set<string>(regionSubnets.map((s) => s.id));
  if (regionSubnets.length > 0) {
    const ipAssets = await prisma.asset.findMany({
      where: { ipAddress: { not: null } },
      select: { id: true, ipAddress: true },
    });
    for (const a of ipAssets) {
      if (memberIds.has(a.id)) continue;
      const ip = (a.ipAddress || "").split("/")[0].trim();
      if (!ip) continue;
      for (const sub of regionSubnets) {
        // cidrContains is IPv4 (Netmask) — IPv6 assets throw and are skipped.
        if (cidrContains(sub.cidr, ip + "/32")) { memberIds.add(a.id); break; }
      }
    }
  }
  return { assetIds: memberIds, subnetIds };
}

// --- Tag mutation primitives ---

async function addTagToAssets(assetIds: string[], tag: string): Promise<number> {
  if (assetIds.length === 0) return 0;
  const rows = await prisma.asset.findMany({
    where: { id: { in: assetIds } },
    select: { id: true, tags: true },
  });
  const updates: { id: string; tags: string[] }[] = [];
  for (const row of rows) {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    if (tags.includes(tag)) continue;
    updates.push({ id: row.id, tags: [...tags, tag] });
  }
  if (updates.length > 0) {
    await prisma.$transaction(
      updates.map((u) => prisma.asset.update({ where: { id: u.id }, data: { tags: u.tags } })),
    );
  }
  return updates.length;
}

async function addTagToSubnets(subnetIds: string[], tag: string): Promise<number> {
  if (subnetIds.length === 0) return 0;
  const rows = await prisma.subnet.findMany({
    where: { id: { in: subnetIds } },
    select: { id: true, tags: true },
  });
  const updates: { id: string; tags: string[] }[] = [];
  for (const row of rows) {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    if (tags.includes(tag)) continue;
    updates.push({ id: row.id, tags: [...tags, tag] });
  }
  if (updates.length > 0) {
    await prisma.$transaction(
      updates.map((u) => prisma.subnet.update({ where: { id: u.id }, data: { tags: u.tags } })),
    );
  }
  return updates.length;
}

async function removeTagFromAllSubnets(tag: string): Promise<number> {
  const rows = await prisma.subnet.findMany({
    where: { tags: { has: tag } },
    select: { id: true, tags: true },
  });
  if (rows.length === 0) return 0;
  await prisma.$transaction(
    rows.map((row) => {
      const tags = Array.isArray(row.tags) ? row.tags : [];
      return prisma.subnet.update({
        where: { id: row.id },
        data: { tags: tags.filter((t) => t !== tag) },
      });
    }),
  );
  return rows.length;
}

async function removeTagFromAllAssets(tag: string): Promise<number> {
  const rows = await prisma.asset.findMany({
    where: { tags: { has: tag } },
    select: { id: true, tags: true },
  });
  if (rows.length === 0) return 0;
  await prisma.$transaction(
    rows.map((row) => {
      const tags = Array.isArray(row.tags) ? row.tags : [];
      return prisma.asset.update({
        where: { id: row.id },
        data: { tags: tags.filter((t) => t !== tag) },
      });
    }),
  );
  return rows.length;
}

// --- Public API ---

export async function listRegions(): Promise<MapRegion[]> {
  const all = await loadAll();
  return all.slice().sort((a, b) => a.name.localeCompare(b.name));
}

export async function getRegion(id: string): Promise<MapRegion | null> {
  const all = await loadAll();
  return all.find((r) => r.id === id) ?? null;
}

export async function createRegion(input: SaveRegionInput): Promise<MapRegion> {
  const name = validateName(input.name);
  const polygon = validatePolygon(input.polygon);
  const color = input.color !== undefined ? validateColor(input.color) : randomTagColor();
  const all = await loadAll();
  if (all.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    throw new AppError(409, `A region named "${name}" already exists`);
  }
  const now = new Date().toISOString();
  const created: MapRegion = {
    id: randomUUID(),
    name,
    polygon,
    color,
    createdBy: input.actor ?? null,
    createdAt: now,
    updatedAt: now,
  };
  all.push(created);
  await persistAll(all);
  await upsertTagRegistry(name);
  return created;
}

export async function updateRegion(
  id: string,
  input: SaveRegionInput,
): Promise<{ region: MapRegion; previousName: string; renamed: boolean; polygonChanged: boolean }> {
  const all = await loadAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) throw new AppError(404, `Region ${id} not found`);
  const existing = all[idx]!;

  const name = input.name !== undefined ? validateName(input.name) : existing.name;
  const polygon = input.polygon !== undefined ? validatePolygon(input.polygon) : existing.polygon;
  const color = input.color !== undefined ? validateColor(input.color) : existing.color;

  const renamed = name.toLowerCase() !== existing.name.toLowerCase();
  if (renamed && all.some((r, i) => i !== idx && r.name.toLowerCase() === name.toLowerCase())) {
    throw new AppError(409, `A region named "${name}" already exists`);
  }

  const polygonChanged =
    input.polygon !== undefined && JSON.stringify(polygon) !== JSON.stringify(existing.polygon);

  const updated: MapRegion = {
    ...existing,
    name,
    polygon,
    color,
    updatedAt: new Date().toISOString(),
  };
  all[idx] = updated;
  await persistAll(all);

  if (renamed) {
    await deleteTagRegistry(existing.name);
    await upsertTagRegistry(name);
  }

  return { region: updated, previousName: existing.name, renamed, polygonChanged };
}

export async function deleteRegion(id: string): Promise<MapRegion> {
  const all = await loadAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) throw new AppError(404, `Region ${id} not found`);
  const removed = all[idx]!;
  const next = all.slice(0, idx).concat(all.slice(idx + 1));
  await persistAll(next);
  await deleteTagRegistry(removed.name);
  return removed;
}

// --- Reconciler ---

/**
 * Strip the old name's tag from every asset, then add-pass current membership.
 * Called inline from the rename branch of updateRegion (after persist).
 */
export async function applyRename(
  region: MapRegion,
  previousName: string,
): Promise<ReconcileSummary> {
  const oldTag = regionTag(previousName);
  const removed = await removeTagFromAllAssets(oldTag);
  const subnetsRemoved = await removeTagFromAllSubnets(oldTag);
  const members = await computeMembership(region);
  const added = await addTagToAssets(Array.from(members.assetIds), regionTag(region.name));
  const subnetsAdded = await addTagToSubnets(Array.from(members.subnetIds), regionTag(region.name));
  return {
    regionId: region.id,
    added,
    removed,
    assetsTouched: removed + added,
    subnetsAdded,
    subnetsRemoved,
    subnetsTouched: subnetsRemoved + subnetsAdded,
  };
}

/**
 * Strip the region's tag from every asset. Called from the DELETE path before
 * the final reconcile (which then doesn't need to add anything for this id).
 */
export async function applyDelete(region: MapRegion): Promise<ReconcileSummary> {
  const tag = regionTag(region.name);
  const removed = await removeTagFromAllAssets(tag);
  const subnetsRemoved = await removeTagFromAllSubnets(tag);
  return {
    regionId: region.id,
    added: 0,
    removed,
    assetsTouched: removed,
    subnetsAdded: 0,
    subnetsRemoved,
    subnetsTouched: subnetsRemoved,
  };
}

/**
 * Add-pass for one region: tag its current members, never strip. Used after
 * create and after polygon-only edits.
 */
export async function applyOneRegion(region: MapRegion): Promise<ReconcileSummary> {
  const tag = regionTag(region.name);
  const members = await computeMembership(region);
  const added = await addTagToAssets(Array.from(members.assetIds), tag);
  const subnetsAdded = await addTagToSubnets(Array.from(members.subnetIds), tag);
  return {
    regionId: region.id,
    added,
    removed: 0,
    assetsTouched: added,
    subnetsAdded,
    subnetsRemoved: 0,
    subnetsTouched: subnetsAdded,
  };
}

/**
 * Full reconcile pass over every region. Add-only — does NOT strip tags from
 * assets that have drifted out of the polygon (those become operator-owned).
 * Renames and deletes are handled by their dedicated CRUD paths, so by the
 * time this runs there are no stale region tags to clean up.
 *
 * Used by the periodic job and by the discovery-end hook.
 */
export async function reconcileMapRegions(): Promise<ReconcileSummary> {
  const regions = await listRegions();
  let added = 0;
  let touched = 0;
  let subnetsAdded = 0;
  let subnetsTouched = 0;
  for (const region of regions) {
    const summary = await applyOneRegion(region);
    added += summary.added;
    touched += summary.assetsTouched;
    subnetsAdded += summary.subnetsAdded;
    subnetsTouched += summary.subnetsTouched;
  }
  return { added, removed: 0, assetsTouched: touched, subnetsAdded, subnetsRemoved: 0, subnetsTouched };
}
