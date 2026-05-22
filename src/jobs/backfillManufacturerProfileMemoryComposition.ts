/**
 * src/jobs/backfillManufacturerProfileMemoryComposition.ts
 *
 * One-shot startup migration: promote existing single-symbol memory rows to
 * the generic `double_scalar` shape on installs that ran the seed job
 * BEFORE the `defaultSymbolB` column existed. Pairs with the inline
 * emission in `seedManufacturerProfiles` so fresh installs get the new
 * shape stamped from the start; this job is for installs that ran the
 * old seed.
 *
 * The 20260531000000 SQL migration already promoted any rows that carried
 * the legacy `composition` JSON blob; this job catches the orphan case
 * where the seed wrote `defaultSymbol = "<usedBytesSymbol>"` + `type =
 * "scalar"` but never got a composition stamped (because composition came
 * later AND this job didn't run before the new shape landed).
 *
 * Behaviour: for every VENDOR_TELEMETRY_PROFILES entry whose `memory` block
 * maps to a `double_scalar` (bytes-form), find the matching DB row(s) and
 * promote ONLY when:
 *   1. The row's existing `defaultSymbolB` / `symbolB` is null (no shape
 *      stamped yet).
 *   2. The row's `defaultSymbol` / `symbol` matches the bytes-form's
 *      primary OID (sanity check — operator hasn't replaced the seed).
 *   3. The row's `defaultType` / `type` is "scalar" (not already promoted,
 *      not table).
 *
 * Idempotent via the marker key (and the three safety checks above mean a
 * re-run wouldn't clobber anything anyway).
 *
 * Marker key is kept as the legacy `backfillManufacturerProfileMemoryCompositionAt`
 * for back-compat with installs that already ran the prior version of this
 * job — those installs are already in the desired post-promotion state.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { runInstrumentedJob } from "./_metrics.js";
import { VENDOR_TELEMETRY_PROFILES, memoryQueryToDoubleScalar } from "../services/vendorTelemetryProfiles.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import { refreshProfileCache } from "../services/manufacturerProfileService.js";

const MARKER_KEY = "backfillManufacturerProfileMemoryCompositionAt";

interface SeedRow { vendorLabel: string; manufacturer: string; modelPattern: string | null }
const SEED_MAP: SeedRow[] = [
  { vendorLabel: "Cisco IOS / IOS-XE / NX-OS",        manufacturer: "Cisco",    modelPattern: null },
  { vendorLabel: "Juniper Junos",                     manufacturer: "Juniper",  modelPattern: null },
  { vendorLabel: "Mikrotik RouterOS",                 manufacturer: "Mikrotik", modelPattern: null },
  { vendorLabel: "Fortinet FortiSwitch (SNMP path)",  manufacturer: "Fortinet", modelPattern: "FortiSwitch" },
  { vendorLabel: "Fortinet FortiAP (SNMP path)",      manufacturer: "Fortinet", modelPattern: "FortiAP" },
  { vendorLabel: "Fortinet FortiOS (SNMP path)",      manufacturer: "Fortinet", modelPattern: null },
  { vendorLabel: "HP / Aruba ProCurve",               manufacturer: "HP",       modelPattern: null },
  { vendorLabel: "Dell PowerConnect / Networking",    manufacturer: "Dell",     modelPattern: null },
];

interface BackfillStats { metricRowsUpdated: number; overrideRowsUpdated: number; skipped: boolean }

export async function backfillManufacturerProfileMemoryComposition(): Promise<BackfillStats> {
  const marker = await prisma.setting.findUnique({ where: { key: MARKER_KEY } });
  if (marker !== null) {
    return { metricRowsUpdated: 0, overrideRowsUpdated: 0, skipped: true };
  }

  let metricRowsUpdated = 0;
  let overrideRowsUpdated = 0;

  for (const seedRow of SEED_MAP) {
    const profile = VENDOR_TELEMETRY_PROFILES.find((p) => p.vendor === seedRow.vendorLabel);
    if (!profile?.memory) continue;
    const ds = memoryQueryToDoubleScalar(profile.memory);
    // Only the double_scalar case needs promotion. scalar (percent) rows are
    // already correctly stamped by the old seed and don't need any change.
    if (!ds || ds.type !== "double_scalar") continue;

    const mfr = normalizeManufacturer(seedRow.manufacturer) ?? seedRow.manufacturer;
    const dbProfile = await (prisma as any).manufacturerProfile.findUnique({
      where: { manufacturer: mfr },
      include: { metrics: { where: { metricKey: "memory" }, include: { overrides: true } } },
    });
    if (!dbProfile) continue;
    const memoryRow = dbProfile.metrics[0];
    if (!memoryRow) continue;

    if (seedRow.modelPattern) {
      // Promote a per-model override (FortiSwitch).
      const override = memoryRow.overrides.find(
        (o: any) => o.modelPattern === seedRow.modelPattern && o.symbol === ds.symbol,
      );
      if (!override) continue;
      if (override.symbolB) continue;       // already promoted
      if (override.type !== "scalar") continue; // already changed shape
      await (prisma as any).manufacturerProfileMetricOverride.update({
        where: { id: override.id },
        data:  {
          type:      "double_scalar",
          symbolB:   ds.symbolB,
          transform: ds.transform,
        },
      });
      overrideRowsUpdated += 1;
    } else {
      // Promote the umbrella metric row.
      if (memoryRow.defaultSymbolB) continue;
      if (memoryRow.defaultType !== "scalar") continue;
      if (memoryRow.defaultSymbol !== ds.symbol) continue;
      await (prisma as any).manufacturerProfileMetric.update({
        where: { id: memoryRow.id },
        data:  {
          defaultType:      "double_scalar",
          defaultSymbolB:   ds.symbolB,
          defaultTransform: ds.transform,
        },
      });
      metricRowsUpdated += 1;
    }
  }

  await prisma.setting.upsert({
    where:  { key: MARKER_KEY },
    update: { value: { at: new Date().toISOString(), metricRowsUpdated, overrideRowsUpdated } },
    create: { key: MARKER_KEY, value: { at: new Date().toISOString(), metricRowsUpdated, overrideRowsUpdated } },
  });

  return { metricRowsUpdated, overrideRowsUpdated, skipped: false };
}

(async () => {
  try {
    await runInstrumentedJob("backfillManufacturerProfileMemoryComposition", async () => {
      const result = await backfillManufacturerProfileMemoryComposition();
      if (!result.skipped && (result.metricRowsUpdated || result.overrideRowsUpdated)) {
        logger.info(result, "Promoted manufacturer profile memory rows to double_scalar");
      }
      await refreshProfileCache();
    });
  } catch (err) {
    logger.error({ err }, "backfillManufacturerProfileMemoryComposition startup task failed");
  }
})();
