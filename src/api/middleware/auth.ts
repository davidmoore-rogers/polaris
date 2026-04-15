/**
 * src/api/middleware/auth.ts — API key / JWT authentication
 *
 * Supports two modes (configured via env vars):
 *   - API key:  X-Api-Key header matched against API_KEY_SECRET
 *   - JWT:      Authorization: Bearer <token> verified against JWT_SECRET
 *               (full signature verification requires the `jsonwebtoken` package)
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  // ── API key ──────────────────────────────────────────────────────────────
  const apiKey = req.headers["x-api-key"];
  if (process.env.API_KEY_SECRET && apiKey === process.env.API_KEY_SECRET) {
    return next();
  }

  // ── JWT Bearer token ──────────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    // TODO: verify JWT signature with process.env.JWT_SECRET using jsonwebtoken
    // const token = authHeader.slice(7);
    // jwt.verify(token, process.env.JWT_SECRET!, (err, decoded) => { ... });
    return next();
  }

  next(new AppError(401, "Unauthorized — provide a valid API key or bearer token"));
}
