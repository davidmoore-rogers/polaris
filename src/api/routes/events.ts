/**
 * src/api/routes/events.ts — Event log read endpoints + shared logger
 */

import { Router } from "express";
import { prisma } from "../../db.js";
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

    const { retentionDays } = await getRetentionSettings();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const where: Record<string, unknown> = { timestamp: { gte: cutoff } };
    if (level) where.level = level;
    if (action) where.action = { contains: action };
    if (resourceType) where.resourceType = resourceType;

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
router.get("/archive-settings", async (_req, res, next) => {
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
router.put("/archive-settings", async (req, res, next) => {
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
router.post("/archive-test", async (req, res, next) => {
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
router.get("/syslog-settings", async (_req, res, next) => {
  try {
    const settings = await getSyslogSettings();
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/events/syslog-settings — update syslog forwarding settings
router.put("/syslog-settings", async (req, res, next) => {
  try {
    const updated = await updateSyslogSettings(req.body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/events/syslog-test — test syslog connection
router.post("/syslog-test", async (req, res, next) => {
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
router.put("/retention-settings", async (req, res, next) => {
  try {
    res.json(await updateRetentionSettings(req.body));
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
