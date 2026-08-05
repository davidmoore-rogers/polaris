/**
 * src/jobs/migrateAutoMonitorInterfacesShape.ts
 *
 * One-shot startup migration: rewrites stored
 * `Integration.config.{fortigateMonitor|fortiswitchMonitor|fortiapMonitor}
 * .autoMonitorInterfaces` rows from the legacy single-mode discriminated
 * union into the multi-block union the new UI persists.
 *
 *   { mode: "names",    names }            → { byNames:    { names } }
 *   { mode: "wildcard", patterns, onlyUp } → { byPatterns: { patterns, regex: false, onlyUp } }
 *   { mode: "type",     types,    onlyUp } → { byTypes:    { types, onlyUp } }
 *
 * Pairs with the Zod-layer + apply-route `coerceLegacySelection` calls so the
 * mixed state between deploy and this job running is still valid. Idempotent
 * via the `autoMonitorInterfacesShapeMigratedAt` Setting marker; subsequent
 * boots no-op.
 *
 * Recovery: delete the marker
 *   DELETE FROM "settings" WHERE key = 'autoMonitorInterfacesShapeMigratedAt';
 * and restart. Already-new-shape rows pass through unchanged on a re-run.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { coerceLegacySelection } from "../services/autoMonitorInterfacesService.js";

const MIGRATED_KEY = "autoMonitorInterfacesShapeMigratedAt";
const BLOCK_KEYS = ["fortigateMonitor", "fortiswitchMonitor", "fortiapMonitor"] as const;

(async () => {
  try {
    await runInstrumentedJob("migrateAutoMonitorInterfacesShape", async () => {
      if (await hasRunMarker(MIGRATED_KEY)) return;

      const integrations = await prisma.integration.findMany({
        where: { type: { in: ["fortimanager", "fortigate"] } },
        select: { id: true, name: true, config: true },
      });

      let rowsUpdated = 0;
      let selectionsRewritten = 0;

      for (const integ of integrations) {
        const cfg = (integ.config ?? {}) as Record<string, any>;
        let touched = false;

        for (const blockKey of BLOCK_KEYS) {
          const block = cfg[blockKey];
          const sel = block?.autoMonitorInterfaces;
          if (!sel || typeof sel !== "object") continue;
          // Already new shape — leave alone.
          if ("byNames" in sel || "byPatterns" in sel || "byTypes" in sel || "byLldp" in sel) continue;
          // Legacy shape — coerce.
          const coerced = coerceLegacySelection(sel);
          if (!coerced) continue;
          cfg[blockKey] = { ...block, autoMonitorInterfaces: coerced };
          touched = true;
          selectionsRewritten += 1;
        }

        if (touched) {
          await prisma.integration.update({
            where: { id: integ.id },
            data:  { config: cfg as any },
          });
          rowsUpdated += 1;
        }
      }

      await stampRunMarker(MIGRATED_KEY, { rowsUpdated, selectionsRewritten });

      if (rowsUpdated > 0) {
        logger.info(
          { rowsUpdated, selectionsRewritten },
          "Migrated autoMonitorInterfaces from legacy single-mode shape to multi-block union",
        );
      }
    });
  } catch (err) {
    logger.error(
      { err },
      "autoMonitorInterfaces shape migration failed — recovery: delete the autoMonitorInterfacesShapeMigratedAt Setting and restart",
    );
  }
})();
