/**
 * src/api/routes/networkScans.ts — saved network **Discovery** CRUD + runs.
 *
 * Mounted at /api/v1/network-scans behind a `networkScan:read` FLOOR on the
 * whole router, with per-route escalation above it. The floor is the `/map`
 * mount precedent: three of its read routes were auth-only until 2026-08, so
 * any session or token could enumerate every FortiGate's coordinates and
 * topology regardless of role. A Discovery's targets and results are the same
 * kind of recon material.
 *
 *   GET    /                    networkScan:read    (list + each one's newest run)
 *   POST   /preview-targets     networkScan:read    (pure IP math, no packets)
 *   GET    /runs/:runId         networkScan:read    (progress + hits)
 *   GET    /:id                 networkScan:read
 *   POST   /                    networkScan:write
 *   PUT    /:id                 networkScan:write
 *   DELETE /:id                 networkScan:write
 *   POST   /:id/run             networkScan:write   (202 + the run)
 *   POST   /runs/:runId/cancel  networkScan:write
 *   POST   /runs/:runId/adopt   networkScan:write + assets:write  (CHAINED)
 *
 * `/preview-targets` and `/runs/...` are declared BEFORE "/:id" so the literal
 * paths aren't captured as ids (the deliveryChannels `/web-push` precedent).
 *
 * **The chained gate on adopt is the point of the whole permission design**
 * (business rule 34a): running a Discovery creates nothing, so a role may be
 * allowed to find out what is on a range without being allowed to put it into
 * inventory. `integrations:write`-style blanket gates are exactly what that
 * separation would lose.
 *
 * `/preview-targets` is read-level deliberately: it resolves typed targets with
 * the pure `expandScanTargets` plus one indexed read, touches no network, and
 * gating it at write would block the wizard's target preview for a role that is
 * allowed to look at Discoveries.
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";
import {
  adoptHits,
  cancelRun,
  createScan,
  deleteScan,
  getRun,
  getScan,
  listScans,
  previewTargets,
  triggerScan,
  updateScan,
  MAX_ADOPT_PER_CALL,
  MAX_CREDENTIALS_PER_METHOD,
  MAX_SCAN_TARGET_ROWS,
  type SaveScanInput,
} from "../../services/networkScanService.js";
import { SCAN_METHODS } from "../../services/networkScanRunner.js";

const router = Router();

// ─── Schemas ────────────────────────────────────────────────────────────────
//
// Shape only. The SEMANTIC rules (a target that expands to nothing, ICMP with
// credentials, a per-method credential cap) live in
// networkScanService.validateScanInput, because an imported .discovery.json has
// to pass exactly the same checks and they are properties of the feature rather
// than of one HTTP body.

const targetSchema = z.object({
  kind: z.enum(["cidr", "range", "single"]),
  value: z.string().min(1).max(64),
});

const methodSchema = z.object({
  type: z.enum(SCAN_METHODS),
  credentialIds: z.array(z.string().uuid()).max(MAX_CREDENTIALS_PER_METHOD).optional().default([]),
});

/**
 * The auto-monitor selection blob, keyed by polling method.
 *
 * Passed through as `unknown` rather than re-declaring the
 * byNames/byPatterns/byTypes/byLldp union a third time (it already exists as
 * Zod in integrations.ts and as types in autoMonitorInterfacesService): the
 * pure resolvers ignore anything they don't recognize, so a malformed block
 * pins nothing rather than pinning the wrong thing. Duplicating the union here
 * is how the two would drift.
 */
const autoMonitorSchema = z.record(z.string(), z.unknown()).nullable().optional();

const saveSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  targets: z.array(targetSchema).min(1).max(MAX_SCAN_TARGET_ROWS),
  methods: z.array(methodSchema).min(1).max(SCAN_METHODS.length),
  autoMonitor: autoMonitorSchema,
});

const previewSchema = z.object({
  targets: z.array(targetSchema).max(MAX_SCAN_TARGET_ROWS),
  sampleSize: z.number().int().min(0).max(200).optional(),
});

const adoptSchema = z.object({
  addresses: z.array(z.string().min(1).max(45)).min(1).max(MAX_ADOPT_PER_CALL),
});

/** Router-wide floor. Every route needs at least this. */
router.use(requirePermission("networkScan", "read"));

// ─── Reads ──────────────────────────────────────────────────────────────────

router.get("/", async (_req, res, next) => {
  try {
    res.json({ scans: await listScans() });
  } catch (err) { next(err); }
});

router.post("/preview-targets", async (req, res, next) => {
  try {
    const body = previewSchema.parse(req.body ?? {});
    res.json(await previewTargets(body.targets, body.sampleSize));
  } catch (err) { next(err); }
});

router.get("/runs/:runId", async (req, res, next) => {
  try {
    res.json({ run: await getRun((req.params.runId as string)) });
  } catch (err) { next(err); }
});

// ─── Writes ─────────────────────────────────────────────────────────────────

router.post("/runs/:runId/cancel", requirePermission("networkScan", "write"), async (req, res, next) => {
  try {
    res.json({ run: await cancelRun((req.params.runId as string), requestActor(req)) });
  } catch (err) { next(err); }
});

/**
 * Adoption — the one route here that creates assets, and the only one carrying
 * a second key. Both gates run: `networkScan:write` (this is a Discovery
 * action) AND `assets:write` (it writes inventory).
 */
router.post(
  "/runs/:runId/adopt",
  requirePermission("networkScan", "write"),
  requirePermission("assets", "write"),
  async (req, res, next) => {
    try {
      const body = adoptSchema.parse(req.body ?? {});
      res.json(await adoptHits((req.params.runId as string), body.addresses, requestActor(req)));
    } catch (err) { next(err); }
  },
);

router.post("/", requirePermission("networkScan", "write"), async (req, res, next) => {
  try {
    const body = saveSchema.parse(req.body ?? {}) as SaveScanInput;
    res.status(201).json({ scan: await createScan(body, requestActor(req)) });
  } catch (err) { next(err); }
});

// Declared after the literal paths above so "preview-targets" / "runs" are
// never read as ids.
router.get("/:id", async (req, res, next) => {
  try {
    res.json({ scan: await getScan((req.params.id as string)) });
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("networkScan", "write"), async (req, res, next) => {
  try {
    const body = saveSchema.parse(req.body ?? {}) as SaveScanInput;
    res.json({ scan: await updateScan((req.params.id as string), body, requestActor(req)) });
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("networkScan", "write"), async (req, res, next) => {
  try {
    await deleteScan((req.params.id as string), requestActor(req));
    res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * Start a run. 202 rather than 200: the sweep takes minutes and the wizard
 * watches the returned run row rather than this response.
 */
router.post("/:id/run", requirePermission("networkScan", "write"), async (req, res, next) => {
  try {
    res.status(202).json({ run: await triggerScan((req.params.id as string), requestActor(req)) });
  } catch (err) { next(err); }
});

export default router;
