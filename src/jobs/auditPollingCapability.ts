/**
 * src/jobs/auditPollingCapability.ts
 *
 * Startup audit: which polling methods ALREADY STORED on this install have no
 * collector behind them?
 *
 * The write validators warn from now on and the UI no longer offers the dead
 * combinations, but neither helps an operator who configured one months ago.
 * Those settings are the worst kind of broken — the stream reports a healthy
 * tick every cycle (`runTelemetryFor` counts a `{supported:false}` result as
 * success) and simply never produces data, so nothing anywhere goes red. This
 * job is the one thing that says so out loud.
 *
 * Read-only. It changes NOTHING: an operator may have set SSH on a stream in
 * anticipation of the collector landing, and silently rewriting their intent
 * would be worse than the gap. It logs, and writes ONE summary Event so the
 * finding survives in the audit log and ships out through the syslog / SFTP
 * archivers to somewhere a person reads.
 *
 * Deliberately NOT marker-guarded — the answer changes as collectors land and
 * as operators edit settings, and re-running it is the point. Cost is three
 * small reads (assets with an override, class overrides, integrations).
 *
 * Import this module from src/app.ts to activate it:
 *   import "./jobs/auditPollingCapability.js";
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "../services/eventLogService.js";
import { runInstrumentedJob } from "./_metrics.js";
import {
  assetSourceKindFromIntegrationType,
  isPollingMethod,
  pollingMethodLabel,
  type AssetSourceKind,
  type PollingMethod,
  type Stream,
} from "../utils/pollingCompatibility.js";
import { collectorCapability } from "../utils/pollingCapability.js";

const POLLING_FIELDS = [
  "responseTimePolling",
  "cpuMemoryPolling",
  "temperaturePolling",
  "interfacesPolling",
  "lldpPolling",
  "storagePolling",
  "processesPolling",
  "eventLogPolling",
] as const;

interface DeadSetting {
  /** Where the value is stored, in operator terms. */
  scope: string;
  stream: Stream;
  method: PollingMethod;
  reason: string;
}

/**
 * Pure: walk one settings-ish object's polling fields and report the ones with
 * no collector. Exported for the unit test — the DB half is three findMany
 * calls and is not what needs pinning.
 */
export function auditPollingFields(
  scope: string,
  source: AssetSourceKind,
  settings: Record<string, unknown> | null | undefined,
  assetType?: string | null,
): DeadSetting[] {
  if (!settings) return [];
  const out: DeadSetting[] = [];
  for (const field of POLLING_FIELDS) {
    const raw = settings[field];
    if (!isPollingMethod(raw)) continue;
    const stream = field.replace(/Polling$/, "") as Stream;
    const cap = collectorCapability(source, stream, raw, { assetType });
    if (!cap.implemented) {
      out.push({ scope, stream, method: raw, reason: cap.reason || "no collector" });
    }
  }
  return out;
}

async function auditPollingCapability(): Promise<void> {
  try {
    await runInstrumentedJob("auditPollingCapability", async () => {
      const findings: DeadSetting[] = [];

      // 1. Per-asset overrides (tier 1). Only rows that actually set one.
      const assets = await prisma.asset.findMany({
        where: {
          OR: POLLING_FIELDS.map((f) => ({ [f]: { not: null } })),
        },
        select: {
          id: true, hostname: true, ipAddress: true, assetType: true,
          discoveredByIntegration: { select: { type: true } },
          responseTimePolling: true, cpuMemoryPolling: true, temperaturePolling: true,
          interfacesPolling: true, lldpPolling: true, storagePolling: true,
          processesPolling: true, eventLogPolling: true,
        },
        take: 5000,
      });
      for (const a of assets) {
        const source = assetSourceKindFromIntegrationType(a.discoveredByIntegration?.type ?? null);
        findings.push(
          ...auditPollingFields(
            `asset "${a.hostname || a.ipAddress || a.id}"`,
            source,
            a as unknown as Record<string, unknown>,
            a.assetType,
          ),
        );
      }

      // 2. Class overrides (tier 2). Scoped to a single assetType each.
      const overrides = await prisma.monitorClassOverride.findMany({
        select: { id: true, assetType: true, integrationId: true, ...Object.fromEntries(POLLING_FIELDS.map((f) => [f, true])) } as any,
      });
      for (const o of overrides as any[]) {
        findings.push(
          ...auditPollingFields(
            `class override for ${o.assetType}`,
            // Post-Phase-2 a class override is manual-scope only, so there is
            // no integration type to resolve a richer source kind from.
            "manual",
            o as Record<string, unknown>,
            o.assetType,
          ),
        );
      }

      // 3. Integration tier (tier 3) — the flat baseline plus each per-class
      //    streams block, which is where most of these actually live.
      const integrations = await prisma.integration.findMany({
        select: { id: true, name: true, type: true, config: true },
      });
      for (const i of integrations) {
        const cfg = (i.config as Record<string, unknown> | null) || {};
        const source = assetSourceKindFromIntegrationType(i.type);
        findings.push(
          ...auditPollingFields(
            `integration "${i.name}" (baseline)`,
            source,
            cfg.monitorSettings as Record<string, unknown> | undefined,
          ),
        );
      }

      if (findings.length === 0) {
        logger.debug("Polling-capability audit: every stored polling method has a collector");
        return;
      }

      for (const f of findings) {
        logger.warn(
          { scope: f.scope, stream: f.stream, method: f.method },
          `Stored polling method collects nothing: ${f.scope} — ${f.stream} via ${pollingMethodLabel(f.method)}. ${f.reason}`,
        );
      }

      // One Event, not one per finding: this is a standing configuration fact,
      // and N events per boot would bury the log it ships to. Details carry a
      // bounded sample; the full list is in the warnings above.
      logEvent({
        action: "monitor.polling_capability_gap",
        resourceType: "system",
        level: "warning",
        message:
          `${findings.length} stored polling setting(s) have no collector and are silently collecting nothing — ` +
          `e.g. ${findings.slice(0, 3).map((f) => `${f.scope}: ${f.stream} via ${pollingMethodLabel(f.method)}`).join("; ")}`,
        details: {
          count: findings.length,
          sample: findings.slice(0, 20).map((f) => ({
            scope: f.scope, stream: f.stream, method: f.method, reason: f.reason,
          })),
        },
      });
    });
  } catch (err) {
    // Never block boot for an advisory sweep.
    logger.error({ err }, "Polling-capability audit failed");
  }
}

void auditPollingCapability();
