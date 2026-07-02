/**
 * src/api/routes/apiTokens.ts — CRUD for bearer-token API access.
 *
 * Mounted at /api/v1/api-tokens with `requirePermission("apiTokens","read")`
 * at router.ts; writes here escalate to `apiTokens=write`. Each token is
 * bound to a Role at mint time — it acts with that role's permission matrix
 * everywhere requirePermission gates. The raw token value is shown ONCE on
 * creation and never recoverable.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import {
  createToken,
  deleteToken,
  listTokens,
  revokeToken,
} from "../../services/apiTokenService.js";
import { logEvent } from "./events.js";
import {
  requirePermission,
  normalizePermissions,
  isAdminEquivalentPermissions,
} from "../middleware/permissions.js";

const router = Router();

const CreateTokenSchema = z.object({
  name: z.string().min(1).max(80),
  roleId: z.string().min(1),
  integrationIds: z.array(z.string().uuid()).optional(),
  expiresAt: z.string().datetime().optional(),
});

router.get("/", async (_req, res, next) => {
  try {
    // Surface the FMG/FortiGate integrations along with each one's enabled
    // flag and pushQuarantine-config flag so the API Tokens UI can render the
    // per-integration picker + the "push disabled" alert without making a
    // second authenticated round-trip to /integrations.
    const rows = await prisma.integration.findMany({
      where: { type: { in: ["fortimanager", "fortigate"] } },
      select: { id: true, name: true, type: true, enabled: true, config: true },
      orderBy: { name: "asc" },
    });
    const quarantineIntegrations = rows.map((r) => {
      const cfg = (r.config ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        enabled: r.enabled,
        pushQuarantineEnabled: cfg.pushQuarantine === true,
      };
    });
    // Role catalogue for the "acts as role" dropdown. Embedded here (rather
    // than the UI calling /api/v1/roles) so the tab renders for any caller
    // holding apiTokens=read regardless of their roles-function access.
    // grantsQuarantineWrite drives the integration-picker toggle;
    // adminEquivalent drives the "full control" warning banner.
    const roles = (await prisma.role.findMany({ orderBy: { name: "asc" } })).map((r) => {
      const perms = normalizePermissions(r.permissions);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        grantsQuarantineWrite:
          perms.assetsQuarantine === "write" || perms.assetsQuarantine === "fullwrite",
        adminEquivalent: isAdminEquivalentPermissions(perms),
      };
    });
    res.json({
      tokens: await listTokens(),
      roles,
      quarantineIntegrations,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("apiTokens", "write"), async (req, res, next) => {
  try {
    const input = CreateTokenSchema.parse(req.body);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, "expiresAt must be in the future");
    }
    const result = await createToken({
      name: input.name,
      roleId: input.roleId,
      integrationIds: input.integrationIds,
      expiresAt,
      createdBy: req.session?.username || "unknown",
    });
    logEvent({
      action: "api_token.created",
      resourceType: "api_token",
      resourceId: result.token.id,
      resourceName: result.token.name,
      actor: req.session?.username,
      message: `API token "${result.token.name}" created with role "${result.token.roleName}"`,
    });
    // The raw token field is the ONLY time the caller sees the value.
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/revoke", requirePermission("apiTokens", "write"), async (req, res, next) => {
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

router.delete("/:id", requirePermission("apiTokens", "write"), async (req, res, next) => {
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
