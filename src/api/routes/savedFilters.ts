/**
 * src/api/routes/savedFilters.ts — saved table filters (list-page presets).
 *
 * Mounted at /api/v1/saved-filters (after the global requireAuth in
 * router.ts). Every route resolves the caller's access from the SCOPE in the
 * request — each scope rides the RBAC function key that already gates its page
 * (SAVED_FILTER_SCOPES in savedFilterService.ts), so there is no new function
 * key and no role migration:
 *
 *   GET    /?scope=assets   — own + public presets            <key>:read
 *   POST   /                — create/overwrite own preset     <key>:read
 *                             (visibility "public" also needs <key>:write)
 *   PUT    /:id             — edit own preset                 same as POST
 *   DELETE /:id             — delete own preset               <key>:read
 *                             (someone else's needs           <key>:fullwrite)
 *
 * The gate is resolved per-request rather than via requirePermission(key,…) at
 * the mount because the key depends on the body/query's scope.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { assertScopeAccess, sessionUser } from "../middleware/scopeAccess.js";
import {
  createSavedFilter,
  deleteSavedFilter,
  getSavedFilter,
  listSavedFilters,
  normalizeName,
  sanitizeFilterState,
  updateSavedFilter,
  MAX_NAME_LEN,
  type SavedFilterVisibility,
} from "../../services/savedFilterService.js";

const router = Router();

const BodySchema = z.object({
  scope:      z.string().min(1).max(64),
  name:       z.string().min(1).max(MAX_NAME_LEN),
  visibility: z.enum(["private", "public"]),
  // Shape-validated by sanitizeFilterState (which is also the unit-tested
  // contract); Zod only guarantees it's an object here.
  state:      z.record(z.unknown()),
});

router.get("/", async (req, res, next) => {
  try {
    const scope = String(req.query.scope || "");
    const user = sessionUser(req);
    await assertScopeAccess(req, scope, "read");
    res.json({ filters: await listSavedFilters(scope, user.id) });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const user = sessionUser(req);
    // Reading the page is enough to keep a private preset; PUBLISHING one to
    // every other operator is a write to shared state.
    await assertScopeAccess(req, body.scope, body.visibility === "public" ? "write" : "read");
    const saved = await createSavedFilter(
      {
        scope:      body.scope,
        name:       normalizeName(body.name),
        visibility: body.visibility as SavedFilterVisibility,
        state:      sanitizeFilterState(body.state),
      },
      user,
    );
    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const user = sessionUser(req);
    const row = await getSavedFilter(req.params.id);
    if (row.ownerId !== user.id) {
      throw new AppError(403, "Forbidden — you can only edit saved filters you created");
    }
    if (body.scope !== row.scope) throw new AppError(400, "scope cannot be changed");
    await assertScopeAccess(req, row.scope, body.visibility === "public" ? "write" : "read");
    const saved = await updateSavedFilter(
      row.id,
      {
        scope:      row.scope,
        name:       normalizeName(body.name),
        visibility: body.visibility as SavedFilterVisibility,
        state:      sanitizeFilterState(body.state),
      },
      user,
    );
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const user = sessionUser(req);
    const row = await getSavedFilter(req.params.id);
    const own = row.ownerId === user.id;
    // Someone else's preset (including an orphan left by a deleted account) is
    // housekeeping — fullwrite on the scope's key.
    await assertScopeAccess(req, row.scope, own ? "read" : "fullwrite");
    await deleteSavedFilter(row.id, user.username);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
