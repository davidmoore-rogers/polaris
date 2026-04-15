/**
 * src/api/middleware/errorHandler.ts
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.httpStatus).json({ error: err.message });
  }

  logger.error(err, "Unhandled error");
  return res.status(500).json({ error: "Internal server error" });
}
