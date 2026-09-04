/**
 * src/services/savedDashboardService.ts — saved dashboards (named canvases).
 *
 * A SavedDashboard is a named snapshot of ONE dashboard canvas (its column
 * stack), stored server-side so it follows the operator across browsers AND
 * can be shared: a `public` dashboard is offered to every caller who can read
 * the registry, a `private` one only to its owner.
 *
 * This is savedFilterService's model applied to the dashboard, with one
 * consequence that has no parallel there: **a public dashboard is also what the
 * unauthenticated Dash wallboard can load** (src/dash/dashServer.ts mounts the
 * list + read routes, GET-only, and passes no session). So:
 *
 *   list (own u public) / create + edit + delete YOUR OWN  -> savedDashboards:read
 *   create or edit a PUBLIC one (publishing to everyone,
 *   the wallboard included)                                -> savedDashboards:write
 *   delete SOMEONE ELSE'S (housekeeping)                   -> savedDashboards:fullwrite
 *   list from the wallboard (no session at all)            -> public rows ONLY
 *
 * It gets its OWN function key rather than riding a page's gate the way
 * SAVED_FILTER_SCOPES does, because the Dashboard page has no function key to
 * inherit — it is gated per WIDGET (PolarisWidgets.getAllowed()), which is also
 * what keeps a loaded dashboard honest: a widget the viewer may not read is
 * dropped at render on their side, so a published layout can't disclose
 * anything its reader couldn't already fetch.
 *
 * The stored blob is another operator's browser input replayed into yours, so
 * `sanitizeDashboardLayout` accepts only the column/widget shape
 * utils/dashboardLayout.ts defines — the same one /me/dashboard stores.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { ColumnsSchema, type DashboardColumnInput } from "../utils/dashboardLayout.js";
// One definition of "an operator-typed preset name" — trim + collapse
// whitespace, reject control characters (the name is rendered into every other
// operator's menu), 60-char ceiling. Shared with saved filters deliberately:
// two name rules for two lists of named presets is a difference operators feel.
import { normalizeName } from "./savedFilterService.js";
import type { Prisma } from "../generated/prisma/client.js";

export { normalizeName };

/** Dashboards one user may own — a bound on list-render cost. */
export const MAX_SAVED_DASHBOARDS_PER_USER = 50;

export type SavedDashboardVisibility = "private" | "public";

/** What a saved dashboard stores: one canvas, no id/name of its own. */
export interface SavedDashboardLayout {
  columns: DashboardColumnInput[];
}

export interface SavedDashboardDto {
  id: string;
  name: string;
  visibility: SavedDashboardVisibility;
  ownerId: string | null;
  ownerName: string;
  /** True when the CALLER owns it (drives the UI's edit/delete affordances). */
  isOwner: boolean;
  /** Widget count — the menu labels a row without parsing the layout. */
  widgetCount: number;
  layout: SavedDashboardLayout;
  createdAt: string;
  updatedAt: string;
}

/**
 * Validate + normalize a layout blob into exactly the column stack the
 * dashboard renderer consumes. Zod's failure is folded into an AppError so
 * every throw out of this file is the one error type the routes expect.
 */
export function sanitizeDashboardLayout(raw: unknown): SavedDashboardLayout {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "layout must be an object");
  }
  const columns = (raw as { columns?: unknown }).columns ?? [];
  const parsed = ColumnsSchema.safeParse(columns);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(400, `layout.columns is invalid: ${first ? first.message : "unrecognized shape"}`);
  }
  // An EMPTY canvas is a legitimate thing to store (a placeholder screen), so
  // it isn't refused here — the UI is where "save nothing?" is a question.
  return { columns: parsed.data as DashboardColumnInput[] };
}

export function countWidgets(layout: SavedDashboardLayout): number {
  return layout.columns.reduce((n, c) => n + c.widgets.length, 0);
}

type Row = {
  id: string;
  name: string;
  ownerId: string | null;
  ownerName: string;
  visibility: string;
  layout: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(row: Row, viewerId: string | null): SavedDashboardDto {
  const stored = (row.layout as unknown as SavedDashboardLayout) || { columns: [] };
  const columns = Array.isArray(stored.columns) ? stored.columns : [];
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility === "public" ? "public" : "private",
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    isOwner: row.ownerId != null && viewerId != null && row.ownerId === viewerId,
    widgetCount: countWidgets({ columns }),
    layout: { columns },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Dashboards visible to one caller: everything they own (private and public)
 * plus every OTHER user's public one. `viewerId === null` is the wallboard —
 * no session, so public rows ONLY, and nothing reads as owned.
 */
export async function listSavedDashboards(viewerId: string | null): Promise<SavedDashboardDto[]> {
  const rows = await prisma.savedDashboard.findMany({
    where: viewerId ? { OR: [{ ownerId: viewerId }, { visibility: "public" }] } : { visibility: "public" },
    orderBy: [{ name: "asc" }],
  });
  return rows.map((r) => toDto(r, viewerId));
}

async function load(id: string): Promise<Row> {
  const row = await prisma.savedDashboard.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Saved dashboard not found");
  return row;
}

/** Load one row for the route's ownership check. */
export async function getSavedDashboard(id: string): Promise<Row> {
  return load(id);
}

/**
 * One saved dashboard by id, as a DTO — the wallboard's re-read of the screen
 * it is pinned to, and the Dashboard page's refresh of a loaded tab. A PRIVATE
 * row answers 404, not 403, to a caller who can't see it (the GET /alerts/:id
 * posture): that an id exists is itself something an anonymous viewer shouldn't
 * learn.
 */
export async function readSavedDashboard(id: string, viewerId: string | null): Promise<SavedDashboardDto> {
  const row = await load(id);
  const own = row.ownerId != null && viewerId != null && row.ownerId === viewerId;
  if (row.visibility !== "public" && !own) throw new AppError(404, "Saved dashboard not found");
  return toDto(row, viewerId);
}

export interface SaveDashboardInput {
  name: string;
  visibility: SavedDashboardVisibility;
  layout: SavedDashboardLayout;
}

/**
 * Create one owned by `user`. A same-(owner, name) row is UPDATED instead of
 * duplicated — the UI's "save over an existing name" flow — so the caller never
 * has to choose between POST and PUT.
 */
export async function createSavedDashboard(
  input: SaveDashboardInput,
  user: { id: string; username: string },
): Promise<SavedDashboardDto> {
  const existing = await prisma.savedDashboard.findFirst({ where: { ownerId: user.id, name: input.name } });
  if (existing) return updateSavedDashboard(existing.id, input, user);

  const count = await prisma.savedDashboard.count({ where: { ownerId: user.id } });
  if (count >= MAX_SAVED_DASHBOARDS_PER_USER) {
    throw new AppError(
      400,
      `You already have ${MAX_SAVED_DASHBOARDS_PER_USER} saved dashboards — delete one first`,
    );
  }

  const row = await prisma.savedDashboard.create({
    data: {
      name: input.name,
      ownerId: user.id,
      ownerName: user.username,
      visibility: input.visibility,
      layout: input.layout as unknown as Prisma.InputJsonValue,
    },
  });
  void logEvent({
    action: "saved_dashboard.created",
    resourceType: "saved_dashboard",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    message: `Saved ${row.visibility} dashboard "${row.name}"`,
    details: { visibility: row.visibility, widgetCount: countWidgets(input.layout) },
  });
  return toDto(row, user.id);
}

/** Update one. Ownership is enforced by the route (owner only). */
export async function updateSavedDashboard(
  id: string,
  input: SaveDashboardInput,
  user: { id: string; username: string },
): Promise<SavedDashboardDto> {
  const before = await load(id);
  const row = await prisma.savedDashboard.update({
    where: { id },
    data: {
      name: input.name,
      visibility: input.visibility,
      layout: input.layout as unknown as Prisma.InputJsonValue,
    },
  });
  void logEvent({
    action: "saved_dashboard.updated",
    resourceType: "saved_dashboard",
    resourceId: row.id,
    resourceName: row.name,
    actor: user.username,
    message: `Updated ${row.visibility} dashboard "${row.name}"`,
    details: {
      visibility: row.visibility,
      widgetCount: countWidgets(input.layout),
      previousName: before.name !== row.name ? before.name : undefined,
      previousVisibility: before.visibility !== row.visibility ? before.visibility : undefined,
    },
  });
  return toDto(row, user.id);
}

/** Delete one. Ownership / admin override is enforced by the route. */
export async function deleteSavedDashboard(id: string, actor: string): Promise<void> {
  const row = await load(id);
  await prisma.savedDashboard.delete({ where: { id } });
  void logEvent({
    action: "saved_dashboard.deleted",
    resourceType: "saved_dashboard",
    resourceId: row.id,
    resourceName: row.name,
    actor,
    message: `Deleted ${row.visibility} dashboard "${row.name}"`,
    details: { visibility: row.visibility, owner: row.ownerName },
  });
}
