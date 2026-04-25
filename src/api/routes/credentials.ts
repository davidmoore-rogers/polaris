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

const router = Router();

const CredentialTypeEnum = z.enum(["snmp", "winrm", "ssh"]);

const CreateSchema = z.object({
  name:   z.string().min(1),
  type:   CredentialTypeEnum,
  config: z.record(z.unknown()),
});

const UpdateSchema = z.object({
  name:   z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
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
