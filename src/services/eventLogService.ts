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

/**
 * Batch variant of logEvent — writes many audit rows in ONE `createMany`
 * instead of N awaited `create`s. Applies the same min-level drop + `levelRank`
 * stamping as logEvent. Use for high-fan-in audit sources (e.g. agent/poller OS
 * event-log ingest) where a per-row await would be a scale anti-pattern. Never
 * throws — a write failure is swallowed like logEvent. Returns the number of
 * rows actually written (after the min-level filter).
 */
export async function logEventsBatch(inputs: LogEventInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  try {
    const { minLevel } = await getCachedRetentionSettings();
    const floor = LEVEL_ORDER[minLevel] ?? 0;
    const rows = inputs
      .filter((i) => (LEVEL_ORDER[i.level ?? "info"] ?? 0) >= floor)
      .map((i) => {
        const level = i.level || "info";
        return {
          action: i.action,
          resourceType: i.resourceType,
          resourceId: i.resourceId,
          resourceName: i.resourceName,
          actor: i.actor,
          message: i.message,
          level,
          levelRank: LEVEL_ORDER[level] ?? 0,
          details: i.details as any,
        };
      });
    if (rows.length === 0) return 0;
    await prisma.event.createMany({ data: rows });
    return rows.length;
  } catch {
    return 0;
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

// ─── Discovery per-asset audit events ────────────────────────────────────────
//
// Discovery historically logged only run-level `integration.discover.*` events
// (resourceType=integration). The asset details slide-over's Events tab filters
// strictly on resourceType=asset + resourceId, so a specific asset's discovery
// history was invisible there. These helpers emit per-asset events from the
// discovery sync paths (FMG/FortiGate firewall/switch/AP, Entra/Intune, AD) so
// "what did discovery do to THIS asset" shows up alongside monitor-status
// changes and manual edits.
//
// MATERIAL fields only. A discovery cycle bumps lastSeen / *FetchedAt / monitor
// stamp / topology / discoveredByIntegrationId on essentially every asset every
// pass — diffing those would write an event per asset per cycle and flood the
// 7-day Event table at 2000 assets. The whitelist below is the identity /
// classification / location surface an operator actually wants an audit trail
// for; an unchanged pass produces NO event. See CLAUDE.md scale-check rule.
const MATERIAL_ASSET_FIELDS = [
  "hostname",
  "ipAddress",
  "macAddress",
  "serialNumber",
  "manufacturer",
  "model",
  "os",
  "osVersion",
  "assetType",
  "status",
  "learnedLocation",
  "learnedAddress",
] as const;

export interface DiscoveryAuditContext {
  integrationName: string;
  integrationId?: string;
  // AssetSource kind that drove the write — "fortigate-firewall" | "fortiswitch"
  // | "fortiap" | "entra" | "ad". Surfaced in the event message + details.
  sourceKind?: string;
  // Discovery actor (username for an operator-triggered run, undefined for the
  // scheduler). Defaults to "system:discovery" when absent so the row isn't
  // attributed to a person.
  actor?: string;
}

// Snapshot the material fields from an in-memory asset row BEFORE the discovery
// branch mutates it in place (several paths set existingAsset.assetType /
// .macAddresses / .status before the prisma.asset.update). Pass the result as
// `before` to logDiscoveryAssetUpdated after the write succeeds.
export function snapshotMaterialAssetFields(asset: Record<string, unknown>): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const f of MATERIAL_ASSET_FIELDS) snap[f] = (asset as any)[f] ?? null;
  return snap;
}

export function logDiscoveryAssetCreated(
  assetId: string,
  name: string | null | undefined,
  ctx: DiscoveryAuditContext,
): void {
  const label = name || assetId;
  const via = ctx.sourceKind ? ` (${ctx.sourceKind})` : "";
  void logEvent({
    action: "asset.discovered",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: name || undefined,
    actor: ctx.actor || "system:discovery",
    message: `Asset "${label}" discovered by ${ctx.integrationName}${via}`,
    details: { integrationId: ctx.integrationId, integrationName: ctx.integrationName, sourceKind: ctx.sourceKind },
  });
}

// Pure diff over the material-field whitelist. `after` is the partial
// updateData object passed to prisma.asset.update — only keys present in it are
// considered (discovery writes a field only when it has an opinion), each
// compared against the pre-write `before` snapshot. Returns undefined when
// nothing material changed. Extracted as a pure function so the gating logic is
// unit-testable without touching Prisma.
export function computeMaterialAssetChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> | undefined {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of MATERIAL_ASSET_FIELDS) {
    if (!(f in after)) continue; // discovery didn't touch this field this write
    const a = (before as any)[f] ?? null;
    const b = (after as any)[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[f] = { from: a, to: b };
  }
  return Object.keys(changes).length ? changes : undefined;
}

// Emits `asset.discovery_updated` only when a MATERIAL field actually changed.
export function logDiscoveryAssetUpdated(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  assetId: string,
  name: string | null | undefined,
  ctx: DiscoveryAuditContext,
): void {
  const changes = computeMaterialAssetChanges(before, after);
  if (!changes) return; // nothing material changed → no event
  const label = name || assetId;
  const via = ctx.sourceKind ? ` (${ctx.sourceKind})` : "";
  void logEvent({
    action: "asset.discovery_updated",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: name || undefined,
    actor: ctx.actor || "system:discovery",
    // Status changes are the one material diff worth surfacing above info.
    level: "status" in changes ? "warning" : "info",
    message: `Asset "${label}" updated by ${ctx.integrationName} discovery${via}`,
    details: { changes, integrationId: ctx.integrationId, integrationName: ctx.integrationName, sourceKind: ctx.sourceKind },
  });
}
