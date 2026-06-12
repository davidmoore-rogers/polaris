/**
 * src/services/eventLogService.ts — shared audit-event writer
 *
 * Extracted from src/api/routes/events.ts (2026-06 review): the event writer
 * is consumed by ~42 modules across services, jobs, and routes, and services
 * should not import from the route layer to write audit rows. events.ts
 * re-exports everything here for back-compat, so existing route-layer
 * imports keep working; new service-layer callers should import from here.
 *
 * logEvent never throws — event logging must never break the operation it
 * audits. Rows below the operator-configured minimum level are dropped
 * (cached read via eventArchiveService.getCachedRetentionSettings).
 */

import { prisma } from "../db.js";
import { getCachedRetentionSettings } from "./eventArchiveService.js";

const LEVEL_ORDER: Record<string, number> = { info: 0, warning: 1, error: 2 };

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
    const level = input.level || "info";
    await prisma.event.create({
      data: {
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        resourceName: input.resourceName,
        actor: input.actor,
        message: input.message,
        level,
        // Numeric severity stamped at write time. The list endpoint's
        // sortBy=level dispatches to orderBy: { levelRank } so the operator
        // sees severity order, not alphabetical. Falls back to 0 (info) for
        // any unknown level string.
        levelRank: LEVEL_ORDER[level] ?? 0,
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
