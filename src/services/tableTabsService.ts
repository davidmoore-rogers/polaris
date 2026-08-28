/**
 * src/services/tableTabsService.ts — per-user list-page tabs.
 *
 * A tab is one open VIEW on a table: a name plus the same filter/sort state a
 * SavedTableFilter stores. The two are deliberately different things:
 *
 *   SavedTableFilter — durable, named, optionally SHARED. The artifact.
 *   UserTableTabs    — this operator's working set of open views. Private,
 *                      never shared, cascades with the user.
 *
 * A tab opened from a preset keeps only a REFERENCE (`savedFilterId` +
 * `savedFilterName`) for its label and tooltip. Editing that tab's filters
 * never writes back to the preset — the preset may belong to someone else, and
 * a tab is scratch space.
 *
 * A tab may additionally pin one preset as its BASE filter (`defaultFilterId` +
 * `defaultFilterName` + `defaultState`): the view the tab returns to, so the
 * operator can narrow further on top of it and get back with one click ("Reset
 * Filter" replaces "Clear Filters" on the page-controls row while a base is
 * set). `defaultState` is a SNAPSHOT and is what Reset actually applies — the
 * id/name are labels, and like `savedFilterId` they may dangle, so a preset
 * someone else deleted can never take a tab's base away from it. The client
 * refreshes the snapshot from the live preset whenever it lists them, which is
 * what makes an edit to the preset reach the tabs based on it.
 *
 * Whole-blob read/replace per (user, scope), like userDashboardService: the
 * client owns tab order + active tab and PUTs the full set. `sanitizeTabs` is
 * pure and unit-tested; it delegates per-tab state validation to
 * savedFilterService.sanitizeFilterState so a tab and a preset can never
 * disagree about what a filter blob may contain.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { sanitizeFilterState, type SavedFilterState } from "./savedFilterService.js";
import type { Prisma } from "../generated/prisma/client.js";

/** Open views per table. Above this the strip stops being navigable anyway. */
export const MAX_TABS = 20;
export const MAX_TAB_NAME_LEN = 40;
export const MAX_TAB_ID_LEN = 64;

export interface TableTab {
  id: string;
  name: string;
  state: SavedFilterState;
  /** Set when the tab was opened from a saved preset — reference only. */
  savedFilterId: string | null;
  savedFilterName: string | null;
  /**
   * The tab's BASE filter, pinned from a preset. `defaultState` is the one
   * that matters (it is what Reset applies); the id + name label it and may
   * dangle. All three are null together — see sanitizeTabs.
   */
  defaultFilterId: string | null;
  defaultFilterName: string | null;
  defaultState: SavedFilterState | null;
}

export interface TableTabsLayout {
  version: 1;
  tabs: TableTab[];
  /** "" when there are no tabs; otherwise always one of tabs[].id. */
  activeId: string;
}

export const EMPTY_LAYOUT: TableTabsLayout = { version: 1, tabs: [], activeId: "" };

// C0 range + DEL — a tab name is rendered into the strip.
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]");

function shortString(value: unknown, where: string, max: number): string {
  if (typeof value !== "string") throw new AppError(400, `${where} must be a string`);
  if (value.length > max) throw new AppError(400, `${where} exceeds ${max} characters`);
  return value;
}

/**
 * Validate + normalize a whole tab layout. Throws AppError(400) on anything
 * malformed rather than repairing it: the client always PUTs a blob it just
 * built from live state, so a bad shape is a caller bug.
 */
export function sanitizeTabs(raw: unknown): TableTabsLayout {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "tabs must be an object");
  }
  const input = raw as { tabs?: unknown; activeId?: unknown };
  if (!Array.isArray(input.tabs)) throw new AppError(400, "tabs.tabs must be an array");
  if (input.tabs.length > MAX_TABS) throw new AppError(400, `too many tabs (max ${MAX_TABS})`);

  const seen = new Set<string>();
  const tabs: TableTab[] = input.tabs.map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AppError(400, `tabs[${i}] must be an object`);
    }
    const t = entry as Record<string, unknown>;
    const id = shortString(t.id, `tabs[${i}].id`, MAX_TAB_ID_LEN);
    if (!id) throw new AppError(400, `tabs[${i}].id is required`);
    if (seen.has(id)) throw new AppError(400, "tab ids must be unique");
    seen.add(id);

    const name = shortString(t.name, `tabs[${i}].name`, MAX_TAB_NAME_LEN).trim();
    if (!name) throw new AppError(400, `tabs[${i}].name is required`);
    if (CONTROL_CHARS_RE.test(name)) throw new AppError(400, `tabs[${i}].name contains control characters`);

    // The snapshot is the single truth for "this tab has a base": with no
    // state to return to, a leftover id/name would label a Reset button that
    // could do nothing, so the three are normalized together.
    const defaultState = t.defaultState == null ? null : sanitizeFilterState(t.defaultState);

    return {
      id,
      name,
      state: sanitizeFilterState(t.state ?? {}),
      // A dangling savedFilterId (preset deleted, or someone else's private
      // one) is harmless — it only labels the tab — so it is NOT resolved here.
      savedFilterId:   t.savedFilterId   == null ? null : shortString(t.savedFilterId, `tabs[${i}].savedFilterId`, MAX_TAB_ID_LEN),
      savedFilterName: t.savedFilterName == null ? null : shortString(t.savedFilterName, `tabs[${i}].savedFilterName`, MAX_TAB_NAME_LEN),
      defaultFilterId:   defaultState && t.defaultFilterId   != null ? shortString(t.defaultFilterId, `tabs[${i}].defaultFilterId`, MAX_TAB_ID_LEN) : null,
      defaultFilterName: defaultState && t.defaultFilterName != null ? shortString(t.defaultFilterName, `tabs[${i}].defaultFilterName`, MAX_TAB_NAME_LEN) : null,
      defaultState,
    };
  });

  const activeRaw = input.activeId == null ? "" : shortString(input.activeId, "tabs.activeId", MAX_TAB_ID_LEN);
  if (tabs.length === 0) return { version: 1, tabs, activeId: "" };
  // Fall back to the first tab rather than 400-ing: an activeId that no longer
  // matches is a stale client, and losing the whole layout over it is worse.
  const activeId = tabs.some((t) => t.id === activeRaw) ? activeRaw : tabs[0]!.id;
  return { version: 1, tabs, activeId };
}

/** The caller's tabs for one table; EMPTY_LAYOUT when they have none yet. */
export async function getTabsForUser(userId: string, scope: string): Promise<TableTabsLayout> {
  const row = await prisma.userTableTabs.findUnique({ where: { userId_scope: { userId, scope } } });
  if (!row) return EMPTY_LAYOUT;
  return row.tabs as unknown as TableTabsLayout;
}

/** Full-replace upsert of one (user, scope) layout. `layout` must be sanitized. */
export async function saveTabsForUser(
  userId: string,
  scope: string,
  layout: TableTabsLayout,
): Promise<TableTabsLayout> {
  const json = layout as unknown as Prisma.InputJsonValue;
  const row = await prisma.userTableTabs.upsert({
    where:  { userId_scope: { userId, scope } },
    create: { userId, scope, tabs: json },
    update: { tabs: json },
  });
  return row.tabs as unknown as TableTabsLayout;
}
