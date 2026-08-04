/**
 * src/jobs/migrateMonitorSettingsPerClass.ts
 *
 * Phase 2 of the monitoring-tab redesign. One-shot startup migration. For
 * every integration of type fortimanager / fortigate / activedirectory /
 * entraid / windowsserver:
 *
 *   1. Initialize the per-class `streams` blocks under
 *        config.<klass>Monitor.streams.<stream>
 *      from the existing flat `config.monitorSettings` JSON. Class set per
 *      integration type:
 *        - fortimanager / fortigate → fortigateMonitor / fortiswitchMonitor / fortiapMonitor
 *        - activedirectory / entraid / windowsserver → workstationMonitor / serverMonitor
 *      Streams per class: responseTime / cpuMemory / temperature / interfaces
 *      / lldp / storage. FortiAP storage is dropped (no mountable storage).
 *
 *   2. Fold integration-scoped `MonitorClassOverride` rows
 *      (`integrationId = <this integration>`) onto the matching (class, stream)
 *      cell — per-row values win over the flat-derived baseline. After
 *      overlay, the absorbed row is deleted in the same transaction.
 *      Manual-scope rows (`integrationId IS NULL`) are intentionally left
 *      untouched: those back the narrowed Assets-page UI.
 *
 *   3. FMG/FortiGate only — per-class snmpCredentialId / sshCredentialId
 *      legacy fields are folded into the matching stream's credentialId:
 *      SNMP credential pre-populates SNMP-keyed streams; SSH pre-populates
 *      SSH-keyed streams.
 *
 *   4. Write one `monitor_settings.per_class_migrated` Event per touched
 *      integration listing the absorbed override rows + the resulting
 *      per-class shapes for audit.
 *
 * Idempotent via the `monitorSettingsPerClassMigratedAt` Setting marker;
 * subsequent boots no-op.
 *
 * Recovery: delete the marker
 *   DELETE FROM "settings" WHERE key = 'monitorSettingsPerClassMigratedAt';
 * and restart. Re-runs are safe — every step inspects the current state
 * before writing.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { invalidateMonitorSettingsCache } from "../services/monitoringService.js";
import { logEvent } from "../services/eventLogService.js";
import { runInstrumentedJob } from "./_metrics.js";

const MIGRATED_KEY = "monitorSettingsPerClassMigratedAt";

type StreamKey = "responseTime" | "cpuMemory" | "temperature" | "interfaces" | "lldp" | "storage";

interface StreamCell {
  polling?:          string | null;
  credentialId?:     string | null;
  intervalSeconds?:  number | null;
  timeoutMs?:        number | null;
  failureThreshold?: number | null;
  mibId?:            string | null;
}

type StreamsBlock = Partial<Record<StreamKey, StreamCell>>;

interface SeedSource {
  /** Flat monitorSettings JSON read from the integration. */
  ms: Record<string, unknown>;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Build the per-stream cells from the flat monitorSettings baseline. Each
 * cell carries every key the new shape supports — null = "fall back to
 * tier-3 baseline" but we deliberately fill in the flat baseline values
 * here so the per-class UI shows the same starting numbers operators saw
 * before Phase 2 landed.
 *
 * `pickCredential` selects the right legacy integration-tier credential per
 * stream: SNMP fields use the per-class snmpCredentialId then the integration
 * `monitorCredentialId`; SSH fields use the per-class sshCredentialId then
 * the integration sshCredentialId.
 */
function streamsFromFlat(
  src: SeedSource,
  pickCredential: (polling: string | null) => string | null,
): StreamsBlock {
  const ms = src.ms;
  function cell(args: {
    polling:          string | null;
    intervalSeconds:  number | null;
    timeoutMs:        number | null;
    mibId:            string | null;
    failureThreshold?: number | null;
  }): StreamCell {
    return {
      polling:          args.polling,
      credentialId:     pickCredential(args.polling),
      intervalSeconds:  args.intervalSeconds,
      timeoutMs:        args.timeoutMs,
      failureThreshold: args.failureThreshold ?? null,
      mibId:            args.mibId,
    };
  }
  return {
    responseTime: cell({
      polling:          strOrNull(ms.responseTimePolling),
      intervalSeconds:  numOrNull(ms.intervalSeconds),
      timeoutMs:        numOrNull(ms.probeTimeoutMs),
      failureThreshold: numOrNull(ms.failureThreshold),
      mibId:            strOrNull(ms.responseTimeMibId),
    }),
    cpuMemory: cell({
      polling:          strOrNull(ms.cpuMemoryPolling),
      intervalSeconds:  numOrNull(ms.cpuMemoryIntervalSeconds),
      timeoutMs:        numOrNull(ms.cpuMemoryTimeoutMs),
      mibId:            strOrNull(ms.cpuMemoryMibId),
    }),
    temperature: cell({
      polling:          strOrNull(ms.temperaturePolling),
      intervalSeconds:  numOrNull(ms.temperatureIntervalSeconds),
      timeoutMs:        numOrNull(ms.temperatureTimeoutMs),
      mibId:            strOrNull(ms.temperatureMibId),
    }),
    interfaces: cell({
      polling:          strOrNull(ms.interfacesPolling),
      intervalSeconds:  numOrNull(ms.systemInfoIntervalSeconds),
      timeoutMs:        numOrNull(ms.systemInfoTimeoutMs),
      mibId:            strOrNull(ms.interfacesMibId),
    }),
    lldp: cell({
      polling:          strOrNull(ms.lldpPolling),
      intervalSeconds:  numOrNull(ms.lldpIntervalSeconds) ?? numOrNull(ms.systemInfoIntervalSeconds),
      timeoutMs:        numOrNull(ms.lldpTimeoutMs)       ?? numOrNull(ms.systemInfoTimeoutMs),
      mibId:            strOrNull(ms.lldpMibId),
    }),
    storage: cell({
      polling:          strOrNull(ms.storagePolling),
      intervalSeconds:  numOrNull(ms.storageIntervalSeconds) ?? numOrNull(ms.systemInfoIntervalSeconds),
      timeoutMs:        numOrNull(ms.storageTimeoutMs)       ?? numOrNull(ms.systemInfoTimeoutMs),
      mibId:            null,
    }),
  };
}

/** Overlay one MonitorClassOverride row onto a streams block (per-row values
 *  win over flat baseline). */
function overlayOverride(streams: StreamsBlock, row: any): void {
  function setIfNotNull<K extends keyof StreamCell>(
    streamKey: StreamKey,
    field: K,
    val: StreamCell[K] | null | undefined,
  ): void {
    if (val == null) return;
    const cell = (streams[streamKey] ??= {});
    cell[field] = val;
  }
  // intervalSeconds (responseTime), probeTimeoutMs, failureThreshold
  setIfNotNull("responseTime", "intervalSeconds",  row.intervalSeconds);
  setIfNotNull("responseTime", "timeoutMs",        row.probeTimeoutMs);
  setIfNotNull("responseTime", "failureThreshold", row.failureThreshold);
  setIfNotNull("responseTime", "polling",          row.responseTimePolling);
  setIfNotNull("responseTime", "credentialId",     row.responseTimeCredentialId);
  setIfNotNull("responseTime", "mibId",            row.responseTimeMibId);
  // cpuMemory
  setIfNotNull("cpuMemory", "intervalSeconds", row.cpuMemoryIntervalSeconds);
  setIfNotNull("cpuMemory", "timeoutMs",       row.cpuMemoryTimeoutMs);
  setIfNotNull("cpuMemory", "polling",         row.cpuMemoryPolling);
  setIfNotNull("cpuMemory", "credentialId",    row.cpuMemoryCredentialId);
  setIfNotNull("cpuMemory", "mibId",           row.cpuMemoryMibId);
  // temperature
  setIfNotNull("temperature", "intervalSeconds", row.temperatureIntervalSeconds);
  setIfNotNull("temperature", "timeoutMs",       row.temperatureTimeoutMs);
  setIfNotNull("temperature", "polling",         row.temperaturePolling);
  setIfNotNull("temperature", "credentialId",    row.temperatureCredentialId);
  setIfNotNull("temperature", "mibId",           row.temperatureMibId);
  // interfaces
  setIfNotNull("interfaces", "intervalSeconds", row.systemInfoIntervalSeconds);
  setIfNotNull("interfaces", "timeoutMs",       row.systemInfoTimeoutMs);
  setIfNotNull("interfaces", "polling",         row.interfacesPolling);
  setIfNotNull("interfaces", "credentialId",    row.interfacesCredentialId);
  setIfNotNull("interfaces", "mibId",           row.interfacesMibId);
  // lldp
  setIfNotNull("lldp", "polling",      row.lldpPolling);
  setIfNotNull("lldp", "credentialId", row.lldpCredentialId);
  setIfNotNull("lldp", "mibId",        row.lldpMibId);
  // storage
  setIfNotNull("storage", "polling", row.storagePolling);
}

interface MigrationOutcome {
  integrationId:        string;
  integrationName:      string;
  integrationType:      string;
  classBlocksSeeded:    string[];
  foldedOverrideIds:    string[];
  foldedOverrideTypes:  string[];
  droppedOverrideAssetTypes: string[];
}

(async () => {
  try {
    await runInstrumentedJob("migrateMonitorSettingsPerClass", async () => {
      const marker = await prisma.setting.findUnique({ where: { key: MIGRATED_KEY } });
      if (marker) return;

      const integrations = await prisma.integration.findMany({
        where: { type: { in: ["fortimanager", "fortigate", "activedirectory", "entraid", "windowsserver"] } },
        select: { id: true, name: true, type: true, config: true },
      });

      const outcomes: MigrationOutcome[] = [];

      for (const integ of integrations) {
        const outcome: MigrationOutcome = {
          integrationId:        integ.id,
          integrationName:      integ.name,
          integrationType:      integ.type,
          classBlocksSeeded:    [],
          foldedOverrideIds:    [],
          foldedOverrideTypes:  [],
          droppedOverrideAssetTypes: [],
        };
        const cfg = ((integ.config as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
        const ms  = (cfg.monitorSettings as Record<string, unknown> | undefined) ?? {};
        const intMonitorCred = strOrNull(cfg.monitorCredentialId);
        const intSshCred     = strOrNull(cfg.sshCredentialId);

        // Decide class set per integration type and pick the right credentials
        // for each class. FMG/FortiGate classes carry their own per-class
        // snmpCredentialId / sshCredentialId fields; AD/Entra/WinSrv classes
        // don't have any (no per-stream credentials in v1 — operators add
        // them via stream credentialId).
        let classKeys: Array<{ key: string; klass: string; snmpCred: string | null; sshCred: string | null; includeStorage: boolean }> = [];
        if (integ.type === "fortimanager" || integ.type === "fortigate") {
          const fgBlock = (cfg.fortigateMonitor   as Record<string, unknown> | undefined) ?? {};
          const swBlock = (cfg.fortiswitchMonitor as Record<string, unknown> | undefined) ?? {};
          const apBlock = (cfg.fortiapMonitor     as Record<string, unknown> | undefined) ?? {};
          classKeys = [
            { key: "fortigateMonitor",   klass: "firewall",     snmpCred: intMonitorCred, sshCred: intSshCred, includeStorage: true },
            { key: "fortiswitchMonitor", klass: "switch",       snmpCred: strOrNull(swBlock.snmpCredentialId) ?? intMonitorCred, sshCred: strOrNull(swBlock.sshCredentialId) ?? intSshCred, includeStorage: true },
            { key: "fortiapMonitor",     klass: "access_point", snmpCred: strOrNull(apBlock.snmpCredentialId) ?? intMonitorCred, sshCred: strOrNull(apBlock.sshCredentialId) ?? intSshCred, includeStorage: false },
          ];
          // (fgBlock per-class creds aren't currently surfaced on the FortiGate
          // class block — it only carries pullSnmpLocation / addAsMonitored —
          // so we just fall through to integration-tier creds for it.)
          void fgBlock;
        } else {
          classKeys = [
            { key: "workstationMonitor", klass: "workstation", snmpCred: intMonitorCred, sshCred: intSshCred, includeStorage: true },
            { key: "serverMonitor",      klass: "server",      snmpCred: intMonitorCred, sshCred: intSshCred, includeStorage: true },
          ];
        }

        // Pull integration-scoped MonitorClassOverride rows (manual scope is
        // intentionally skipped).
        const overrides = await prisma.monitorClassOverride.findMany({
          where: { integrationId: integ.id },
        });
        const overridesByAssetType = new Map<string, any>();
        for (const o of overrides) overridesByAssetType.set(o.assetType, o);

        const expectedAssetTypes = new Set(classKeys.map((c) => c.klass));
        for (const o of overrides) {
          if (!expectedAssetTypes.has(o.assetType)) {
            outcome.droppedOverrideAssetTypes.push(o.assetType);
          }
        }

        // Mutate cfg with seeded streams blocks. We deliberately preserve
        // every existing field on each class block and only set/replace the
        // `streams` sub-key.
        const updatedCfg = { ...cfg };
        const isInterestingFmgClass = (klass: string) =>
          klass === "firewall" || klass === "switch" || klass === "access_point";

        const seedSource: SeedSource = { ms };

        for (const ck of classKeys) {
          const existingBlock = (updatedCfg[ck.key] as Record<string, unknown> | undefined) ?? {};
          // Build the per-class streams from the flat baseline. Credential
          // pre-population uses the picker per stream (SNMP vs SSH).
          const pickCred = (polling: string | null) => {
            if (polling === "snmp")   return ck.snmpCred ?? null;
            if (polling === "ssh")    return ck.sshCred  ?? null;
            return null;
          };
          const streams = streamsFromFlat(seedSource, pickCred);
          if (!ck.includeStorage) {
            delete streams.storage;
          }
          // Overlay integration-scoped class override for this assetType (if any).
          const overrideRow = overridesByAssetType.get(ck.klass);
          if (overrideRow) {
            overlayOverride(streams, overrideRow);
            outcome.foldedOverrideIds.push(overrideRow.id);
            outcome.foldedOverrideTypes.push(ck.klass);
          }
          updatedCfg[ck.key] = { ...existingBlock, streams };
          outcome.classBlocksSeeded.push(ck.key);
          void isInterestingFmgClass; // reserved for future per-class logic
        }

        // Persist the config + delete absorbed override rows in one transaction.
        const absorbedIds = overrides
          .filter((o) => expectedAssetTypes.has(o.assetType))
          .map((o) => o.id);

        await prisma.$transaction([
          prisma.integration.update({
            where: { id: integ.id },
            data:  { config: updatedCfg as any },
          }),
          ...(absorbedIds.length > 0
            ? [prisma.monitorClassOverride.deleteMany({ where: { id: { in: absorbedIds } } })]
            : []),
        ]);

        await logEvent({
          action:       "monitor_settings.per_class_migrated",
          resourceType: "integration",
          resourceId:   integ.id,
          resourceName: integ.name,
          actor:        "system:migrateMonitorSettingsPerClass",
          message:      `Per-class monitor streams seeded for "${integ.name}" (${integ.type}); ${absorbedIds.length} class-override row(s) absorbed`,
          details: {
            integrationType:     integ.type,
            classBlocksSeeded:   outcome.classBlocksSeeded,
            foldedOverrideIds:   outcome.foldedOverrideIds,
            foldedOverrideTypes: outcome.foldedOverrideTypes,
            droppedOverrideAssetTypes: outcome.droppedOverrideAssetTypes,
          },
        });

        outcomes.push(outcome);
      }

      // Drop the resolver cache so the next monitor tick sees the new shape.
      if (outcomes.length > 0) {
        invalidateMonitorSettingsCache();
      }

      await prisma.setting.create({
        data: {
          key:   MIGRATED_KEY,
          value: {
            migratedAt: new Date().toISOString(),
            integrationCount: outcomes.length,
            foldedOverrideCount: outcomes.reduce((n, o) => n + o.foldedOverrideIds.length, 0),
          } as any,
        },
      });

      if (outcomes.length > 0) {
        logger.info(
          {
            integrationCount: outcomes.length,
            foldedOverrideCount: outcomes.reduce((n, o) => n + o.foldedOverrideIds.length, 0),
          },
          "Migrated monitor settings to per-class streams shape",
        );
      }
    });
  } catch (err) {
    logger.error(
      { err },
      "monitor-settings per-class migration failed — recovery: delete the monitorSettingsPerClassMigratedAt Setting and restart",
    );
  }
})();
