/**
 * src/jobs/backfillFortigateEndpointSources.ts
 *
 * One-shot startup migration: stamp a `fortigate-endpoint` AssetSource
 * row on every existing endpoint asset that was discovered by an
 * FMG/FortiGate integration but predates the source-kind cutover.
 * Pairs with the inline upsert added to `syncDhcpSubnets` so future
 * sync cycles maintain the row.
 *
 * Eligibility:
 *   - assetType is NOT firewall / switch / access_point (those have
 *     dedicated source kinds — fortigate-firewall / fortiswitch /
 *     fortiap)
 *   - asset has a primary `macAddress` (used as externalId)
 *   - asset has `discoveredByIntegrationId` pointing at an active
 *     fortimanager / fortigate integration, OR is a FortiGate-DHCP
 *     sighting target (AssetFortigateSighting row exists for it)
 *   - no existing fortigate-endpoint source for this MAC
 *
 * After upsert, the asset's "manual" source row (if any — Phase 1
 * backfill placeholder) is swept so the Sources tab doesn't show a
 * stale generic card alongside the new specific one.
 *
 * Idempotent: the upsert hits the (sourceKind, externalId) unique key,
 * and the eligibility filter excludes assets that already have the
 * source. Re-running the job after it converges is a no-op.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { bareFortinetDeviceName } from "../utils/assetSourceLocation.js";
import { runInstrumentedJob } from "./_metrics.js";

(async () => {
  try {
    await runInstrumentedJob("backfillFortigateEndpointSources", async () => {
    // FMG/FortiGate integrations — used to map discoveredByIntegrationId
    // to the per-source integrationId reference.
    const fortinetIntegrations = await prisma.integration.findMany({
      where: { type: { in: ["fortimanager", "fortigate"] } },
      select: { id: true, type: true },
    });
    const fortinetIntegrationIds = new Set(fortinetIntegrations.map((i) => i.id));
    const integrationTypeById = new Map(fortinetIntegrations.map((i) => [i.id, i.type]));
    if (fortinetIntegrations.length === 0) return; // no FMG/FortiGate to backfill from

    // Existing fortigate-endpoint MACs — exclude these from the candidate set.
    const existing = await prisma.assetSource.findMany({
      where: { sourceKind: "fortigate-endpoint" },
      select: { externalId: true },
    });
    const existingMacs = new Set(existing.map((s) => s.externalId));

    // Candidate assets: discovered by a fortinet integration, has a MAC,
    // is not infrastructure. We DON'T also pull sighting-only candidates
    // here — those would require a join most installs don't need; once
    // discovery runs again under the new code, the inline flush catches
    // them. Backfill is the "older data" sweep.
    const candidates = await prisma.asset.findMany({
      where: {
        macAddress: { not: null },
        assetType: { notIn: ["firewall", "switch", "access_point"] },
        discoveredByIntegrationId: { in: Array.from(fortinetIntegrationIds) },
      },
      select: {
        id: true, hostname: true, macAddress: true, ipAddress: true, ipSource: true,
        os: true, osVersion: true, manufacturer: true, model: true, assetType: true,
        lastSeenSwitch: true, lastSeenAp: true,
        discoveredByIntegrationId: true, lastSeen: true,
      },
    });

    // Which FortiGate sighted each candidate. Read from the sighting table —
    // the only FortiGate-owned record of it — NOT from `Asset.learnedLocation`,
    // which is the projection's merged output and on a domain-joined machine
    // holds AD's OU path (stamping that here made this source claim the gate
    // had said it; see discoveryEngine's buildFortigateEndpointObservedBlob).
    // Ascending lastSeen so the freshest sighting is the one left in the map.
    const gateByAsset = new Map<string, string>();
    if (candidates.length > 0) {
      const sightings = await prisma.assetFortigateSighting.findMany({
        where: { assetId: { in: candidates.map((a) => a.id) } },
        select: { assetId: true, fortigateDevice: true },
        orderBy: { lastSeen: "asc" },
      });
      for (const s of sightings) {
        if (s.fortigateDevice?.trim()) gateByAsset.set(s.assetId, s.fortigateDevice.trim());
      }
    }

    let stamped = 0;
    let manualSwept = 0;
    const now = new Date();
    for (const asset of candidates) {
      if (!asset.macAddress) continue;
      const mac = asset.macAddress.toUpperCase();
      if (existingMacs.has(mac)) continue;
      const integrationId = asset.discoveredByIntegrationId;
      if (!integrationId || !fortinetIntegrationIds.has(integrationId)) continue;
      const integrationType = integrationTypeById.get(integrationId) || "fortimanager";
      const observed: Record<string, unknown> = {
        mac,
        hostname: asset.hostname ?? null,
        ipAddress: asset.ipAddress ?? null,
        ipSource: asset.ipSource ?? null,
        os: asset.os ?? null,
        osVersion: asset.osVersion ?? null,
        hardwareVendor: asset.manufacturer ?? null,
        model: asset.model ?? null,
        // The sighting FortiGate, bare (a stored name may carry the Sources
        // card's "<integration>:" render). Null when no sighting row exists —
        // the next discovery run's Phase 10 flush fills it from the pathway
        // that touches the asset, which is better than a guess.
        learnedLocation: bareFortinetDeviceName(gateByAsset.get(asset.id) ?? "") || null,
        lastSeenSwitch: asset.lastSeenSwitch ?? null,
        lastSeenAp: asset.lastSeenAp ?? null,
        discoveredVia: integrationType,
      };
      const lastSeen = asset.lastSeen ?? now;
      try {
        await prisma.assetSource.upsert({
          where: { sourceKind_externalId: { sourceKind: "fortigate-endpoint", externalId: mac } },
          create: {
            assetId: asset.id,
            sourceKind: "fortigate-endpoint",
            externalId: mac,
            integrationId,
            observed: observed as any,
            inferred: false,
            syncedAt: now,
            firstSeen: lastSeen,
            lastSeen,
          },
          update: {
            assetId: asset.id,
            integrationId,
            observed: observed as any,
            syncedAt: now,
            lastSeen,
          },
        });
        stamped++;
        // Sweep the Phase 1 manual placeholder if it's the only other
        // source on the asset. Best-effort.
        try {
          const swept = await prisma.assetSource.deleteMany({
            where: { assetId: asset.id, sourceKind: "manual" },
          });
          if (swept.count > 0) manualSwept++;
        } catch {
          // ignore
        }
      } catch (err) {
        logger.error({ err, assetId: asset.id, mac }, "fortigate-endpoint backfill upsert failed");
      }
    }

    if (stamped > 0) {
      logger.info({ stamped, manualSwept }, "Backfilled fortigate-endpoint AssetSource rows for FMG/FortiGate-discovered endpoints");
    }
    });
  } catch (err) {
    logger.error({ err }, "fortigate-endpoint backfill failed (will retry next boot)");
  }
})();
