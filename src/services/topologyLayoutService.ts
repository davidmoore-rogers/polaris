/**
 * src/services/topologyLayoutService.ts
 *
 * Shared Device Map topology layouts — the server-persisted counterpart of
 * the browser's old localStorage-only node positions. One TopologyLayout row
 * per (siteId, view): siteId is the FortiGate Asset id the topology graph is
 * rooted on; view is "flat" or a floor-view key from computeFloorViews
 * ("b|<area>|<building>" / "f|<area>|<building>|<floor>"). `positions` is
 * { [nodeId]: { x, y } } in pixel model coordinates — the exact shape
 * map.js saves/loads, so the client can treat server and localStorage
 * layouts interchangeably (server wins, localStorage is the per-browser
 * fallback for non-writers).
 *
 * Full-replace semantics per (site, view): each save overwrites the whole
 * blob, so nodeIds that left the topology age out on the next save and
 * concurrent editors are last-write-wins (updatedBy/updatedAt are stored
 * for a future conditional write).
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import type { Prisma } from "../generated/prisma/client.js";

export interface TopologyNodePosition {
  x: number;
  y: number;
}

export type TopologyPositions = Record<string, TopologyNodePosition>;

export interface TopologyLayoutDto {
  view: string;
  positions: TopologyPositions;
  updatedBy: string | null;
  updatedAt: string;
}

/** Hard cap on nodes per layout blob — far above any real site's node count. */
export const MAX_LAYOUT_NODES = 3000;
/** View-key length cap (floor-view keys embed operator location-code text). */
export const MAX_VIEW_KEY_LEN = 200;
/** Node-id key length cap (real ids are UUIDs; leave slack for synthetics). */
export const MAX_NODE_ID_LEN = 300;
/** Coordinate magnitude cap — pixel model coords; nothing sane approaches this. */
export const MAX_COORD = 1e7;

// Control characters (C0 range + DEL) are never legitimate in a view key —
// keys derive from operator-typed location codes, which locKey() has already
// whitespace-collapsed.
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]");

/**
 * A view key is "flat" (the default whole-site view) or a building/floor
 * view key produced by computeFloorViews in topology-render.js:
 * "b|<area>|<building>" or "f|<area>|<building>|<floor>".
 */
export function isValidViewKey(view: unknown): view is string {
  if (typeof view !== "string") return false;
  if (view.length === 0 || view.length > MAX_VIEW_KEY_LEN) return false;
  if (CONTROL_CHARS_RE.test(view)) return false;
  return view === "flat" || /^[bf]\|/.test(view);
}

/**
 * Validate + normalize a positions blob. Throws AppError(400) on anything
 * malformed rather than silently dropping entries — the client always sends
 * a blob it just built from live Cytoscape positions, so a bad shape is a
 * caller bug, not operator data to be repaired.
 */
export function sanitizePositions(raw: unknown): TopologyPositions {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "positions must be an object of { nodeId: { x, y } }");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_LAYOUT_NODES) {
    throw new AppError(400, `positions exceeds the ${MAX_LAYOUT_NODES}-node cap`);
  }
  const out: TopologyPositions = {};
  for (const [id, value] of entries) {
    if (id.length === 0 || id.length > MAX_NODE_ID_LEN) {
      throw new AppError(400, "positions contains an invalid node id");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AppError(400, `position for "${id}" must be { x, y }`);
    }
    const { x, y } = value as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new AppError(400, `position for "${id}" must have finite numeric x and y`);
    }
    if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
      throw new AppError(400, `position for "${id}" is out of range`);
    }
    out[id] = { x, y };
  }
  return out;
}

function toDto(row: { view: string; positions: Prisma.JsonValue; updatedBy: string | null; updatedAt: Date }): TopologyLayoutDto {
  return {
    view: row.view,
    positions: row.positions as unknown as TopologyPositions,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * All saved layouts for a site, keyed by view — embedded into the
 * GET /map/sites/:id/topology payload as `savedLayouts` so the modal has
 * every view's layout in one round-trip.
 */
export async function getLayoutsForSite(siteId: string): Promise<Record<string, TopologyLayoutDto>> {
  const rows = await prisma.topologyLayout.findMany({ where: { siteId } });
  const out: Record<string, TopologyLayoutDto> = {};
  for (const row of rows) out[row.view] = toDto(row);
  return out;
}

/** Ensure the site exists and is a firewall (topology roots are FortiGates). */
async function assertTopologySite(siteId: string): Promise<void> {
  const site = await prisma.asset.findUnique({ where: { id: siteId }, select: { assetType: true } });
  if (!site || site.assetType !== "firewall") {
    throw new AppError(404, "Site not found");
  }
}

/**
 * Full-replace upsert of one (site, view) layout. `positions` must already
 * be validated (route Zod + sanitizePositions).
 */
export async function saveLayout(
  siteId: string,
  view: string,
  positions: TopologyPositions,
  actor: string | null,
): Promise<TopologyLayoutDto> {
  if (!isValidViewKey(view)) throw new AppError(400, "Invalid view key");
  await assertTopologySite(siteId);
  const json = positions as unknown as Prisma.InputJsonValue;
  const row = await prisma.topologyLayout.upsert({
    where:  { siteId_view: { siteId, view } },
    create: { siteId, view, positions: json, updatedBy: actor },
    update: { positions: json, updatedBy: actor },
  });
  return toDto(row);
}

/**
 * Delete one (site, view) layout. Returns true when a row was removed —
 * idempotent for the client's unconditional reset flow.
 */
export async function deleteLayout(siteId: string, view: string): Promise<boolean> {
  if (!isValidViewKey(view)) throw new AppError(400, "Invalid view key");
  const res = await prisma.topologyLayout.deleteMany({ where: { siteId, view } });
  return res.count > 0;
}
