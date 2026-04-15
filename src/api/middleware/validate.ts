/**
 * src/api/middleware/validate.ts — Zod request validation middleware
 *
 * Usage (in a route file):
 *   import { validate } from '../middleware/validate.js';
 *   router.post('/', validate(CreateFooSchema), async (req, res, next) => { ... });
 */

import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";
import { AppError } from "../../utils/errors.js";

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return next(
          new AppError(400, `Validation failed: ${err.errors.map((e) => e.message).join(", ")}`)
        );
      }
      next(err);
    }
  };
}
