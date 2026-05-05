/**
 * src/jobs/migrateAssetPollingMethods.ts
 *
 * One-shot startup migration projecting the legacy polling-method shape
 * (Asset.monitorType + the four Asset.monitor*Source toggles) into the new
 * per-stream polling columns (responseTimePolling / telemetryPolling /
 * interfacesPolling / lldpPolling) added in step 3b of the polling-method
 * redesign.
 *
 * Same shape on the integration tier — `Integration.config.monitor*Source`
 * top-level keys get projected into `Integration.config.monitorSettings
 * .polling.{responseTime, telemetry, interfaces, lldp}`.
 *
 * Once this job has run (per-asset and per-integration), the resolver in
 * monitoringService can read the new fields exclusively. Step 3j drops the
 * legacy columns + top-level Integration.config keys after a release of
 * shadow operation confirms nothing reads them anymore.
 *
 * Idempotency:
 *   - Marker key "assetPollingMethodsMigratedAt" in the Setting table.
 *     Subsequent boots no-op.
 *   - Per-asset projection only writes when ALL four new columns are still
 *     null on that row, so a manual re-run after deleting the marker is
 *     safe — already-projected rows are skipped.
 *   - Per-integration projection only writes when monitorSettings.polling
 *     is absent or empty.
 *
 * Recovery: delete the marker (`DELETE FROM "settings" WHERE key =
 * 'assetPollingMethodsMigratedAt'`) and restart.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { invalidateMonitorSettingsCache } from "../services/monitoringService.js";
import { getAdMonitorProtocol } from "../services/monitoringService.js";

const MIGRATED_KEY = "assetPollingMethodsMigratedAt";

type LegacySource = string | null | undefined;
type PollingMethod = "rest_api" | "snmp" | "winrm" | "ssh" | "icmp";

/**
 * Project a single asset's legacy values into a 4-stream polling shape.
 *
 *   - For FMG/FortiGate-discovered firewalls, monitor*Source carries the
 *     binary REST/SNMP toggle per stream. "rest" maps to "rest_api"; "snmp"
 *     maps to "snmp". When the toggle is null, the integration default is
 *     REST API so each stream defaults to "rest_api".
 *   - For other monitorType values, only the response-time stream is
 *     supported; the other three project null. The asset's monitorType
 *     directly determines responseTime: snmp→snmp, winrm→winrm, ssh→ssh,
 *     icmp→icmp, activedirectory→winrm/ssh based on OS.
 *   - When monitorType is null (manual asset that operator hasn't
 *     configured yet), all four streams project null and the operator
 *     picks values later through the new UI.
 */
function projectAsset(
  monitorType: string | null | undefined,
  os: string | null | undefined,
  responseTimeSource: LegacySource,
  telemetrySource: LegacySource,
  interfacesSource: LegacySource,
  lldpSource: LegacySource,
): {
  responseTimePolling: PollingMethod | null;
  telemetryPolling:    PollingMethod | null;
  interfacesPolling:   PollingMethod | null;
  lldpPolling:         PollingMethod | null;
} {
  function fromSource(s: LegacySource, fallback: PollingMethod | null): PollingMethod | null {
    if (s === "rest") return "rest_api";
    if (s === "snmp") return "snmp";
    return fallback;
  }
  if (monitorType === "fortimanager" || monitorType === "fortigate") {
    return {
      responseTimePolling: fromSource(responseTimeSource, "rest_api"),
      telemetryPolling:    fromSource(telemetrySource,    "rest_api"),
      interfacesPolling:   fromSource(interfacesSource,   "rest_api"),
      lldpPolling:         fromSource(lldpSource,         "rest_api"),
    };
  }
  if (monitorType === "snmp")  return { responseTimePolling: "snmp",  telemetryPolling: null, interfacesPolling: null, lldpPolling: null };
  if (monitorType === "winrm") return { responseTimePolling: "winrm", telemetryPolling: null, interfacesPolling: null, lldpPolling: null };
  if (monitorType === "ssh")   return { responseTimePolling: "ssh",   telemetryPolling: null, interfacesPolling: null, lldpPolling: null };
  if (monitorType === "icmp")  return { responseTimePolling: "icmp",  telemetryPolling: null, interfacesPolling: null, lldpPolling: null };
  if (monitorType === "activedirectory") {
    const protocol = getAdMonitorProtocol(os);
    if (protocol === "winrm") return { responseTimePolling: "winrm", telemetryPolling: null, interfacesPolling: null, lldpPolling: null };
    if (protocol === "ssh")   return { responseTimePolling: "ssh",   telemetryPolling: null, interfacesPolling: null, lldpPolling: null };
    return { responseTimePolling: null, telemetryPolling: null, interfacesPolling: null, lldpPolling: null };
  }
  return { responseTimePolling: null, telemetryPolling: null, interfacesPolling: null, lldpPolling: null };
}

(async () => {
  try {
    const migratedRow = await prisma.setting.findUnique({ where: { key: MIGRATED_KEY } });
    if (migratedRow) return;

    let assetsTouched = 0;
    let integrationsTouched = 0;

    // ── Asset projection ────────────────────────────────────────────────
    // Pull every monitored row + every row with any non-null legacy value
    // OR any non-null new column. The "any non-null new column" half guards
    // against re-projecting rows the operator has already configured under
    // the new model — those are skipped below.
    const candidates = await prisma.asset.findMany({
      where: {
        OR: [
          { monitorType:               { not: null } },
          { monitorResponseTimeSource: { not: null } },
          { monitorTelemetrySource:    { not: null } },
          { monitorInterfacesSource:   { not: null } },
          { monitorLldpSource:         { not: null } },
        ],
      },
      select: {
        id: true,
        os: true,
        monitorType: true,
        monitorResponseTimeSource: true,
        monitorTelemetrySource:    true,
        monitorInterfacesSource:   true,
        monitorLldpSource:         true,
        responseTimePolling: true,
        telemetryPolling:    true,
        interfacesPolling:   true,
        lldpPolling:         true,
      },
    });
    for (const a of candidates) {
      // Skip rows where ANY new polling column is already populated — the
      // operator (or a prior partial run) has touched them under the new
      // model and we don't want to overwrite their work.
      if (a.responseTimePolling !== null || a.telemetryPolling !== null || a.interfacesPolling !== null || a.lldpPolling !== null) continue;
      const projected = projectAsset(
        a.monitorType,
        a.os,
        a.monitorResponseTimeSource,
        a.monitorTelemetrySource,
        a.monitorInterfacesSource,
        a.monitorLldpSource,
      );
      // No-op when the projection produced all-null (e.g. monitorType=null,
      // no source toggles set) — saves a write.
      if (
        projected.responseTimePolling === null
        && projected.telemetryPolling === null
        && projected.interfacesPolling === null
        && projected.lldpPolling === null
      ) continue;
      await prisma.asset.update({
        where: { id: a.id },
        data: {
          responseTimePolling: projected.responseTimePolling,
          telemetryPolling:    projected.telemetryPolling,
          interfacesPolling:   projected.interfacesPolling,
          lldpPolling:         projected.lldpPolling,
        },
      });
      assetsTouched++;
    }

    // ── Integration projection ─────────────────────────────────────────
    // Move Integration.config.monitor*Source toggles into
    // Integration.config.monitorSettings.polling. Top-level keys are left
    // alongside for now; 3j cleans them up after the resolver shows zero
    // legacy reads.
    const integrations = await prisma.integration.findMany({
      where: { type: { in: ["fortimanager", "fortigate"] } },
      select: { id: true, name: true, config: true },
    });
    for (const integ of integrations) {
      const cfg = (integ.config && typeof integ.config === "object" ? integ.config : {}) as Record<string, unknown>;
      const ms  = (cfg.monitorSettings && typeof cfg.monitorSettings === "object" ? cfg.monitorSettings : {}) as Record<string, unknown>;
      const existingPolling = (ms.polling && typeof ms.polling === "object" ? ms.polling : {}) as Record<string, unknown>;
      // Skip when the new polling block already has any field set.
      const alreadyMigrated =
        typeof existingPolling.responseTime === "string"
        || typeof existingPolling.telemetry    === "string"
        || typeof existingPolling.interfaces   === "string"
        || typeof existingPolling.lldp         === "string";
      if (alreadyMigrated) continue;

      function fromSource(s: unknown, fallback: PollingMethod): PollingMethod {
        if (s === "rest") return "rest_api";
        if (s === "snmp") return "snmp";
        return fallback;
      }
      const polling = {
        responseTime: fromSource(cfg.monitorResponseTimeSource, "rest_api"),
        telemetry:    fromSource(cfg.monitorTelemetrySource,    "rest_api"),
        interfaces:   fromSource(cfg.monitorInterfacesSource,   "rest_api"),
        lldp:         fromSource(cfg.monitorLldpSource,         "rest_api"),
      };
      const newCfg = { ...cfg, monitorSettings: { ...ms, polling } };
      await prisma.integration.update({ where: { id: integ.id }, data: { config: newCfg as any } });
      integrationsTouched++;
    }

    // Stamp the marker.
    await prisma.setting.create({
      data: {
        key:   MIGRATED_KEY,
        value: { migratedAt: new Date().toISOString(), assetsTouched, integrationsTouched } as any,
      },
    });

    // Drop the resolver cache so the next monitor pass reads fresh.
    invalidateMonitorSettingsCache();

    if (assetsTouched > 0 || integrationsTouched > 0) {
      logger.info(
        { assetsTouched, integrationsTouched },
        "Asset polling-method migration complete",
      );
    }
  } catch (err) {
    logger.error(
      { err },
      "Asset polling-method startup migration failed — recovery: delete the assetPollingMethodsMigratedAt Setting and restart",
    );
  }
})();
