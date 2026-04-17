/**
 * src/api/middleware/auth.ts — Session-based authentication guards
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.userId) {
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
