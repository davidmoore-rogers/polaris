/**
 * src/api/middleware/auth.ts — Session-based authentication guard
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.userId) {
    return next();
  }
  next(new AppError(401, "Unauthorized — please log in"));
}
