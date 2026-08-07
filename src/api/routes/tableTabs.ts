/**
 * src/api/routes/tableTabs.ts — per-user list-page tabs.
 *
 * Mounted at /api/v1/me/table-tabs (after the global requireAuth in
 * router.ts), alongside /me/dashboard which it deliberately mirrors: strictly
 * per-caller, no admin override, no Event audit (UI preference, not
 * security-relevant).
 *
 *   GET /me/table-tabs?scope=assets — the caller's tabs, or the empty layout
 *   PUT /me/table-tabs?scope=assets — full-replace { tabs, activeId }
 *
 * Both need only READ on the function key that gates the scope's page (see
 * middleware/scopeAccess.ts): a tab is the operator's own view of data they can
 * already see, so a readonly user gets tabs too. Session callers only — tabs
 * belong to a person.
 */

import { Router } from "express";
import { z } from "zod";
import { assertScopeAccess, sessionUser } from "../middleware/scopeAccess.js";
import {
  getTabsForUser,
  sanitizeTabs,
  saveTabsForUser,
  MAX_TABS,
  MAX_TAB_NAME_LEN,
} from "../../services/tableTabsService.js";

const router = Router();

// Shape-validated by sanitizeTabs (the unit-tested contract, shared with
// savedFilterService.sanitizeFilterState for the per-tab state); Zod bounds the
// envelope so an absurd body is rejected before the deeper walk.
const BodySchema = z.object({
  tabs: z
    .array(
      z.object({
        id:              z.string().min(1).max(64),
        name:            z.string().min(1).max(MAX_TAB_NAME_LEN),
        state:           z.record(z.unknown()).optional(),
        savedFilterId:   z.string().max(64).nullish(),
        savedFilterName: z.string().max(MAX_TAB_NAME_LEN).nullish(),
      }),
    )
    .max(MAX_TABS),
  activeId: z.string().max(64).optional(),
});

router.get("/", async (req, res, next) => {
  try {
    const scope = String(req.query.scope || "");
    const user = sessionUser(req);
    await assertScopeAccess(req, scope, "read");
    res.json(await getTabsForUser(user.id, scope));
  } catch (err) {
    next(err);
  }
});

router.put("/", async (req, res, next) => {
  try {
    const scope = String(req.query.scope || "");
    const user = sessionUser(req);
    await assertScopeAccess(req, scope, "read");
    const layout = sanitizeTabs(BodySchema.parse(req.body));
    res.json(await saveTabsForUser(user.id, scope, layout));
  } catch (err) {
    next(err);
  }
});

export default router;
