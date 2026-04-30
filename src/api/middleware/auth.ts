/**
 * src/api/middleware/auth.ts — Session + bearer-token authentication
 *
 * Two parallel auth surfaces:
 *   - Session (UI / browser): cookie-bearing requests, RBAC by `req.session.role`.
 *   - Bearer token (external): `Authorization: Bearer polaris_<...>` from a
 *     long-lived API token, scoped to a fixed list of capabilities.
 *
 * Most routes use the session-only guards (requireAuth, requireAdmin, etc.).
 * Routes that an external system needs to call use the hybrid guards
 * (requireSessionOrTokenScope) which accept either a qualifying session OR
 * a bearer token whose scopes include the required capability.
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";
import { verifyToken } from "../../services/apiTokenService.js";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.userId || req.apiToken) {
    return next();
  }
  next(new AppError(401, "Unauthorized — please log in"));
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.role === "admin") {
    return next();
  }
  next(new AppError(403, "Forbidden — admin access required"));
}

export function requireNetworkAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.role === "admin" || req.session?.role === "networkadmin") {
    return next();
  }
  next(new AppError(403, "Forbidden — network admin access required"));
}

export function requireAssetsAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.role === "admin" || req.session?.role === "assetsadmin") {
    return next();
  }
  next(new AppError(403, "Forbidden — assets admin access required"));
}

// Allows any authenticated role except `readonly`. Used on write routes that
// regular users are allowed to perform (create subnet/reservation, edit/delete
// their own records).
export function requireUserOrAbove(req: Request, _res: Response, next: NextFunction) {
  const role = req.session?.role;
  if (role === "admin" || role === "networkadmin" || role === "assetsadmin" || role === "user") {
    return next();
  }
  next(new AppError(403, "Forbidden — read-only users cannot modify data"));
}

// True when the caller may edit/delete any network resource regardless of
// ownership. Readers should fall back to ownership (createdBy) when this
// returns false.
export function isNetworkAdminOrAbove(req: Request): boolean {
  const role = req.session?.role;
  return role === "admin" || role === "networkadmin";
}

// ─── Bearer-token auth ────────────────────────────────────────────────

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== "string") return null;
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * Resolve a bearer token (if any) on the request and attach the
 * authenticated identity to `req.apiToken`. Always calls next() — does
 * not enforce auth on its own. Pair with `requireSessionOrTokenScope`
 * for the actual gate.
 *
 * Mounted globally on the API router below the session/CSRF middleware
 * so every downstream route can opt in via the hybrid guards.
 */
export async function attachApiToken(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = extractBearerToken(req);
    if (!raw) return next();
    const callerIp = (req.ip || req.socket.remoteAddress || null) ?? null;
    const token = await verifyToken(raw, callerIp);
    if (token) req.apiToken = token;
    next();
  } catch {
    // Swallow — invalid token is the same as no token. The downstream
    // guard returns 401/403 with a uniform message.
    next();
  }
}

/**
 * Hybrid guard: pass if either
 *   (a) the request has a session whose role is in `allowedRoles`, OR
 *   (b) the request has a bearer token whose scopes include `requiredScope`.
 *
 * 401 if neither is present; 403 if present but not authorized.
 */
export function requireSessionOrTokenScope(
  allowedRoles: string[],
  requiredScope: string,
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.session?.userId && req.session.role && allowedRoles.includes(req.session.role)) {
      return next();
    }
    if (req.apiToken) {
      if (req.apiToken.scopes.includes(requiredScope)) return next();
      return next(new AppError(403, `Forbidden — token "${req.apiToken.name}" lacks scope "${requiredScope}"`));
    }
    if (req.session?.userId) {
      return next(new AppError(403, "Forbidden — your role is not authorized for this action"));
    }
    next(new AppError(401, "Unauthorized — session login or bearer token required"));
  };
}
