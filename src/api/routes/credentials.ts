/**
 * src/api/routes/credentials.ts
 *
 * CRUD for the named-credential store used by monitoring probes.
 * Write operations are admin-only (Server Settings → Credentials);
 * read is open to any authenticated session so the Asset Monitoring
 * tab can populate its credential picker and label.
 */

import { Router } from "express";
import { z } from "zod";
import * as credentialService from "../../services/credentialService.js";
import { requireAdmin } from "../middleware/auth.js";
import { logEvent } from "./events.js";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { probeCredentialAgainstHost } from "../../services/monitoringService.js";

const router = Router();

const CredentialTypeEnum = z.enum(["snmp", "winrm", "ssh", "restapi"]);

const CreateSchema = z.object({
  name:   z.string().min(1),
  type:   CredentialTypeEnum,
  config: z.record(z.unknown()),
});

const UpdateSchema = z.object({
  name:   z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
});

// Body for POST /credentials/test. Drives the Test Connection button on the
// add/edit credential modal. The operator picks an asset for its host (the
// asset's monitor settings are intentionally ignored — this exercises the
// credential as configured in the form, not what the asset would normally
// use). When `id` is set, masked secrets in `config` are filled in from the
// stored credential so editing without retyping the password still works.
const TestSchema = z.object({
  assetId: z.string().uuid("assetId must be a UUID"),
  type:    CredentialTypeEnum,
  config:  z.record(z.unknown()),
  id:      z.string().uuid().optional(),
});

// GET /credentials — any authenticated session may list (secrets masked)
router.get("/", async (_req, res, next) => {
  try {
    res.json(await credentialService.listCredentials());
  } catch (err) { next(err); }
});

// GET /credentials/:id
router.get("/:id", async (req, res, next) => {
  try {
    res.json(await credentialService.getCredential(req.params.id as string));
  } catch (err) { next(err); }
});

// POST /credentials
router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const input = CreateSchema.parse(req.body);
    const saved = await credentialService.createCredential({
      name: input.name,
      type: input.type,
      config: input.config,
    });
    logEvent({
      action: "credential.created",
      resourceType: "credential",
      resourceId: saved.id,
      resourceName: saved.name,
      actor: req.session?.username,
      message: `Credential "${saved.name}" (${saved.type}) created`,
    });
    res.status(201).json(saved);
  } catch (err) { next(err); }
});

// PUT /credentials/:id
router.put("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const input = UpdateSchema.parse(req.body);
    const saved = await credentialService.updateCredential(id, {
      name: input.name,
      config: input.config,
    });
    logEvent({
      action: "credential.updated",
      resourceType: "credential",
      resourceId: saved.id,
      resourceName: saved.name,
      actor: req.session?.username,
      message: `Credential "${saved.name}" updated`,
    });
    res.json(saved);
  } catch (err) { next(err); }
});

// POST /credentials/test — exercise a credential against a chosen asset's IP
// without persisting anything. Body { assetId, type, config, id? }. When `id`
// is set, masked secrets in `config` are merged from the stored credential so
// the operator doesn't have to retype the password on edit. Returns the same
// shape as a probe: { success, responseTimeMs, error?, host }.
router.post("/test", requireAdmin, async (req, res, next) => {
  try {
    const input = TestSchema.parse(req.body);

    const asset = await prisma.asset.findUnique({
      where: { id: input.assetId },
      select: { id: true, hostname: true, ipAddress: true, dnsName: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    const host = asset.ipAddress || asset.dnsName || asset.hostname;
    // restapi credentials carry their own baseUrl, so a host on the asset is
    // optional — the credential is tested against its own URL. Every other
    // type still needs a routable target.
    if (!host && input.type !== "restapi") {
      throw new AppError(400, "Asset has no IP, DNS name, or hostname to test against");
    }

    let config = input.config || {};
    if (input.id) {
      const existing = await credentialService.getCredential(input.id, { revealSecrets: true });
      if (existing.type !== input.type) {
        throw new AppError(400, `Credential "${existing.name}" is type "${existing.type}", but the form sent "${input.type}"`);
      }
      config = credentialService.mergeConfigPreservingSecrets(
        input.type,
        (existing.config as Record<string, unknown>) || {},
        config,
      );
    }

    try {
      credentialService.validateConfig(input.type, config);
    } catch (err: any) {
      // Surface validation errors as the test result rather than a 4xx so
      // the modal renders them inline like a probe failure.
      res.json({
        success: false,
        responseTimeMs: 0,
        error: err?.message || "Credential config is invalid",
        host,
      });
      return;
    }

    const result = await probeCredentialAgainstHost(host || "", input.type, config);
    const label = asset.hostname || asset.ipAddress || asset.id;
    logEvent({
      action: "credential.tested",
      resourceType: "credential",
      resourceId: input.id,
      actor: req.session?.username,
      level: result.success ? "info" : "warning",
      message: result.success
        ? `Credential test succeeded against ${label} (${result.responseTimeMs} ms)`
        : `Credential test failed against ${label}: ${result.error || "unknown error"}`,
      details: { assetId: input.assetId, host, type: input.type },
    });
    res.json({ ...result, host });
  } catch (err) { next(err); }
});

// DELETE /credentials/:id
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await credentialService.getCredential(id);
    await credentialService.deleteCredential(id);
    logEvent({
      action: "credential.deleted",
      resourceType: "credential",
      resourceId: id,
      resourceName: existing.name,
      actor: req.session?.username,
      message: `Credential "${existing.name}" deleted`,
    });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
