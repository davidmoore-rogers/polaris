/**
 * src/api/middleware/entraProxyHeaders.ts — strip untrusted identity headers
 *
 * Defense-in-depth for the Entra App Proxy header-SSO provider: the identity
 * headers are unsigned, so any request NOT arriving from an allowlisted
 * connector address must never be seen carrying them by anything downstream.
 * The login route independently re-validates trust — this strip is the second
 * layer, not the gate.
 *
 * Fail closed: while the feature is enabled, a settings read failure strips
 * the DEFAULT header names rather than passing headers through. While the
 * feature is disabled nothing reads the headers, so nothing is stripped.
 */

import type { Request, Response, NextFunction } from "express";
import {
  getEntraProxySettings,
  identityHeaderNames,
  defaultIdentityHeaderNames,
} from "../../services/entraProxyAuthService.js";
import { ipMatchesAllowlist } from "../../utils/ipAllowlist.js";

export async function stripUntrustedEntraProxyHeaders(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  let names: string[];
  try {
    const settings = await getEntraProxySettings();
    if (!settings.enabled) return next();
    if (ipMatchesAllowlist(req.ip, settings.trustedSourceIps)) return next();
    names = identityHeaderNames(settings);
  } catch {
    names = defaultIdentityHeaderNames();
  }
  for (const name of names) {
    delete req.headers[name];
  }
  next();
}
