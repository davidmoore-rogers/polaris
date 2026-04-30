/**
 * src/api/routes/apiTokens.ts — Admin CRUD for bearer-token API access.
 *
 * Mounted at /api/v1/api-tokens with `requireAdmin` applied at router.ts.
 * Tokens grant scoped access to specific endpoints (e.g. quarantine);
 * the raw token value is shown ONCE on creation and never recoverable.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import {
  KNOWN_SCOPES,
  createToken,
  deleteToken,
  listTokens,
  revokeToken,
} from "../../services/apiTokenService.js";
import { logEvent } from "./events.js";

const router = Router();

const ScopeEnum = z.enum(KNOWN_SCOPES as unknown as [string, ...string[]]);

const CreateTokenSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(ScopeEnum).min(1),
  expiresAt: z.string().datetime().optional(),
});

router.get("/", async (_req, res, next) => {
  try {
    res.json({ tokens: await listTokens(), knownScopes: KNOWN_SCOPES });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const input = CreateTokenSchema.parse(req.body);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, "expiresAt must be in the future");
    }
    const result = await createToken({
      name: input.name,
      scopes: input.scopes,
      expiresAt,
      createdBy: req.session?.username || "unknown",
    });
    logEvent({
      action: "api_token.created",
      resourceType: "api_token",
      resourceId: result.token.id,
      resourceName: result.token.name,
      actor: req.session?.username,
      message: `API token "${result.token.name}" created with scopes ${result.token.scopes.join(", ")}`,
    });
    // The raw token field is the ONLY time the caller sees the value.
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/revoke", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await revokeToken(id, req.session?.username || "unknown");
    logEvent({
      action: "api_token.revoked",
      resourceType: "api_token",
      resourceId: id,
      actor: req.session?.username,
      level: "warning",
      message: `API token ${id} revoked`,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await deleteToken(id);
    logEvent({
      action: "api_token.deleted",
      resourceType: "api_token",
      resourceId: id,
      actor: req.session?.username,
      level: "warning",
      message: `API token ${id} deleted`,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
