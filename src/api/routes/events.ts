/**
 * src/api/routes/events.ts — Event log read endpoints + shared logger
 */

import { Router } from "express";
import { prisma } from "../../db.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  getArchiveSettings,
  updateArchiveSettings,
  testConnection,
  getSyslogSettings,
  updateSyslogSettings,
  testSyslogConnection,
  getRetentionSettings,
  updateRetentionSettings,
  getCachedRetentionSettings,
  getAssetDecommissionSettings,
  updateAssetDecommissionSettings,
} from "../../services/eventArchiveService.js";

const LEVEL_ORDER: Record<string, number> = { info: 0, warning: 1, error: 2 };

const router = Router();

// GET /api/v1/events — list events (newest first, paginated)
router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const level = req.query.level as string | undefined;
    const action = req.query.action as string | undefined;
    const resourceType = req.query.resourceType as string | undefined;
    const resourceId = req.query.resourceId as string | undefined;
    const message = req.query.message as string | undefined;
    const since = req.query.since as string | undefined;
    const until = req.query.until as string | undefined;

    const { retentionDays } = await getRetentionSettings();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    // Caller-supplied since narrows the window; the retention cutoff is the
    // floor regardless. until is optional and unbounded by default.
    const tsFilter: Record<string, Date> = { gte: cutoff };
    if (since) {
      const sinceD = new Date(since);
      if (!isNaN(+sinceD) && +sinceD > +cutoff) tsFilter.gte = sinceD;
    }
    if (until) {
      const untilD = new Date(until);
      if (!isNaN(+untilD)) tsFilter.lte = untilD;
    }
    const where: Record<string, unknown> = { timestamp: tsFilter };
    if (level) where.level = level;
    if (action) where.action = { contains: action };
    if (resourceType) where.resourceType = resourceType;
    if (resourceId) where.resourceId = resourceId;
    if (message) where.message = { contains: message, mode: "insensitive" };

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.event.count({ where }),
    ]);

    res.json({ events, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/archive-settings — get archive export settings
// Reveals SSH host/username/path; admin-only even with password masked.
router.get("/archive-settings", requireAdmin, async (_req, res, next) => {
  try {
    const settings = await getArchiveSettings();
    // Strip password from response
    const safe = { ...settings };
    if (safe.password) safe.password = "••••••••";
    res.json(safe);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/events/archive-settings — update archive export settings
router.put("/archive-settings", requireAdmin, async (req, res, next) => {
  try {
    const body = req.body;
    // Don't overwrite password if placeholder was sent back
    if (body.password === "••••••••") delete body.password;
    const updated = await updateArchiveSettings(body);
    const safe = { ...updated };
    if (safe.password) safe.password = "••••••••";
    res.json(safe);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/events/archive-test — test SFTP/SCP connection
router.post("/archive-test", requireAdmin, async (req, res, next) => {
  try {
    const settings = req.body;
    // If password is placeholder, fetch the real one
    if (settings.password === "••••••••") {
      const current = await getArchiveSettings();
      settings.password = current.password;
    }
    const result = await testConnection(settings);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/syslog-settings — get syslog forwarding settings
// Reveals host/port/TLS paths; admin-only.
router.get("/syslog-settings", requireAdmin, async (_req, res, next) => {
  try {
    const settings = await getSyslogSettings();
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/events/syslog-settings — update syslog forwarding settings
router.put("/syslog-settings", requireAdmin, async (req, res, next) => {
  try {
    const updated = await updateSyslogSettings(req.body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/events/syslog-test — test syslog connection
router.post("/syslog-test", requireAdmin, async (req, res, next) => {
  try {
    const result = await testSyslogConnection(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/retention-settings
router.get("/retention-settings", async (_req, res, next) => {
  try {
    res.json(await getRetentionSettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/events/retention-settings
router.put("/retention-settings", requireAdmin, async (req, res, next) => {
  try {
    res.json(await updateRetentionSettings(req.body));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/asset-decommission-settings
router.get("/asset-decommission-settings", async (_req, res, next) => {
  try {
    res.json(await getAssetDecommissionSettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/events/asset-decommission-settings
router.put("/asset-decommission-settings", requireAdmin, async (req, res, next) => {
  try {
    res.json(await updateAssetDecommissionSettings(req.body));
  } catch (err) {
    next(err);
  }
});

export default router;

// ─── Shared Event Logger ────────────────────────────────────────────────────

export interface LogEventInput {
  action: string;
  resourceType?: string;
  resourceId?: string;
  resourceName?: string;
  actor?: string;
  message: string;
  level?: "info" | "warning" | "error";
  details?: Record<string, unknown>;
}

export async function logEvent(input: LogEventInput): Promise<void> {
  try {
    const { minLevel } = await getCachedRetentionSettings();
    if ((LEVEL_ORDER[input.level ?? "info"] ?? 0) < (LEVEL_ORDER[minLevel] ?? 0)) return;
    await prisma.event.create({
      data: {
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        resourceName: input.resourceName,
        actor: input.actor,
        message: input.message,
        level: input.level || "info",
        details: input.details as any,
      },
    });
  } catch {
    // Never let event logging break the main request
  }
}

export function buildChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> | undefined {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    const aStr = JSON.stringify(a ?? null);
    const bStr = JSON.stringify(b ?? null);
    if (aStr !== bStr) changes[key] = { from: a ?? null, to: b ?? null };
  }
  return Object.keys(changes).length ? changes : undefined;
}
