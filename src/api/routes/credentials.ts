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
import { requirePermission } from "../middleware/permissions.js";
import { logEvent } from "./events.js";
import { AppError } from "../../utils/errors.js";
import { probeCredentialAgainstHost } from "../../services/monitoringService.js";
import type { HttpProbeDiagnostics } from "../../utils/httpCheck.js";

const router = Router();

const CredentialTypeEnum = z.enum(["snmp", "winrm", "ssh", "restapi", "http"]);

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
router.get("/", requirePermission("credentials", "read"), async (_req, res, next) => {
  try {
    res.json(await credentialService.listCredentials());
  } catch (err) { next(err); }
});

// GET /credentials/usage — effective-usage asset count per credential, keyed by
// credential id. Drives the Assets column on the Stored Credentials table in
// one round-trip. Registered before /:id so "usage" isn't read as an id.
router.get("/usage", requirePermission("credentials", "read"), async (_req, res, next) => {
  try {
    res.json(await credentialService.getCredentialUsageCounts());
  } catch (err) { next(err); }
});

// GET /credentials/:id
router.get("/:id", requirePermission("credentials", "read"), async (req, res, next) => {
  try {
    res.json(await credentialService.getCredential(req.params.id as string));
  } catch (err) { next(err); }
});

// GET /credentials/:id/usage — full usage breakdown grouped by level
// (asset / class / integration) for the usage slide-in.
router.get("/:id/usage", requirePermission("credentials", "read"), async (req, res, next) => {
  try {
    res.json(await credentialService.getCredentialUsage(req.params.id as string));
  } catch (err) { next(err); }
});

// POST /credentials
router.post("/", requirePermission("credentials", "write"), async (req, res, next) => {
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
router.put("/:id", requirePermission("credentials", "write"), async (req, res, next) => {
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
router.post("/test", requirePermission("credentials", "write"), async (req, res, next) => {
  try {
    const input = TestSchema.parse(req.body);

    const asset = await credentialService.getTestAssetTarget(input.assetId);
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

    // `http` credentials get diagnostics back — the request line, status,
    // content-type and a body excerpt — because an HTTP check's whole point is
    // a string the operator has to pick OUT of the response, and pass/fail
    // alone gives them nothing to pick from. Nothing else fills this.
    const probeOut: { diag?: HttpProbeDiagnostics } = {};
    const result = await probeCredentialAgainstHost(host || "", input.type, config, probeOut);
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
      // The response BODY is deliberately not in the Event: it is arbitrary
      // device output of unbounded sensitivity, it would land in every pg_dump
      // and every syslog forward, and the operator who needs it is already
      // looking at it in the modal. Only the shape of the answer is audited.
      details: {
        assetId: input.assetId, host, type: input.type,
        ...(probeOut.diag
          ? { httpStatus: probeOut.diag.statusCode, httpUrl: probeOut.diag.url, httpMatched: probeOut.diag.matched }
          : {}),
      },
    });
    res.json({ ...result, host, ...(probeOut.diag ? { httpDiagnostics: probeOut.diag } : {}) });
  } catch (err) { next(err); }
});

// DELETE /credentials/:id
router.delete("/:id", requirePermission("credentials", "write"), async (req, res, next) => {
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
