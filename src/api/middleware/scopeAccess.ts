/**
 * src/api/middleware/scopeAccess.ts
 *
 * Shared guards for the "table scope" surfaces — saved filter presets
 * (`/saved-filters`) and per-user list-page tabs (`/me/table-tabs`). Both are
 * per-TABLE features whose RBAC key isn't known until the request body/query is
 * read, so neither can use `requirePermission(key, level)` at the mount: the
 * scope ("assets") maps to the function key that already gates that page
 * (savedFilterService.SAVED_FILTER_SCOPES). Resolving it per request is what
 * lets these features exist without their own function key + role migration.
 */

import type { Request } from "express";
import { AppError } from "../../utils/errors.js";
import { ensureRoleSnapshot, hasPermission, type AccessLevel } from "./permissions.js";
import { functionKeyForScope } from "../../services/savedFilterService.js";

/**
 * Assert the caller has `level` on the function key gating `scope`. Refreshes
 * the role snapshot first so a permission change lands without a re-login —
 * the same contract as requirePermission. Returns the resolved key.
 */
export async function assertScopeAccess(req: Request, scope: string, level: AccessLevel): Promise<string> {
  const key = functionKeyForScope(scope);
  await ensureRoleSnapshot(req);
  if (!hasPermission(req, key, level)) {
    throw new AppError(403, `Forbidden — requires ${key}:${level}`);
  }
  return key;
}

/**
 * The signed-in user behind the request. Both surfaces are owned per USER
 * (a preset has an author, tabs are someone's workspace), and a bearer token
 * has no user identity — so token callers are refused here rather than
 * silently sharing one anonymous bucket.
 */
export function sessionUser(req: Request): { id: string; username: string } {
  const id = req.session?.userId;
  const username = req.session?.username;
  if (!id || !username) {
    throw new AppError(401, "This endpoint requires a signed-in user");
  }
  return { id, username };
}
