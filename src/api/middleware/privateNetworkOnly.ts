/**
 * src/api/middleware/privateNetworkOnly.ts
 *
 * Source-IP gate for the Dash wallboard: 403 unless `req.ip` is RFC 1918 or
 * loopback. `req.ip` honors X-Forwarded-For only per the app's `trust proxy`
 * setting (nginx mode trusts the first hop; direct mode ignores the header
 * entirely) — so the gate is exactly as trustworthy as the deployment's
 * proxy-trust posture. Widening TRUST_PROXY weakens this gate; that caveat
 * is documented in .env.example.
 */

import type { NextFunction, Request, Response } from "express";
import { isPrivateOrLoopbackIp } from "../../utils/cidr.js";
import { AppError } from "../../utils/errors.js";

export function privateNetworkOnly(req: Request, _res: Response, next: NextFunction): void {
  if (!isPrivateOrLoopbackIp(req.ip ?? "")) {
    next(new AppError(403, "Forbidden — the Dash wallboard is reachable from private networks only"));
    return;
  }
  next();
}
