/**
 * src/jobs/backfillAssetSources.ts
 *
 * One-shot startup job: phase-1 of the multi-source asset model. Walks every
 * Asset row, derives the AssetSource rows it should have under the legacy
 * tag/assetTag conventions, and creates any that are MISSING. Idempotent —
 * safe to re-run on every startup and complements the shadow-write Prisma
 * extension in db.ts.
 *
 * CREATE-ONLY — never overwrites an existing row. Post-Phase-3b-cutover the
 * discovery pathways own the rich observed blobs; the derivation here builds
 * skeletons FROM the Asset row (osVersion, ipAddress, learnedLocation...).
 * The original upsert re-stamped every existing row on every boot, clobbering
 * real discovery-observed blobs with those skeletons — prod incident
 * 2026-07-14: all ~780 fortiap source rows lost their live os_version /
 * status on each restart and showed stale Asset-era firmware ("7.4.5 Build
 * 0734" device-inventory strings) until the next discovery healed them.
 *
 * The `inferred=true` flag is set on AD source rows recovered from
 * "ad-guid:" tags (where Entra has overtaken the assetTag pre-merge); a real
 * AD discovery run replaces those with truth and clears the flag.
 *
 * Failures are logged but never fatal — phase-2 discovery cutover will rebuild
 * the table from real source-side writes regardless.
 *
 * Import this from src/app.ts to activate.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { deriveAssetSources, type AssetSnapshot } from "../utils/assetSourceDerivation.js";
import { runInstrumentedJob } from "./_metrics.js";

const PAGE_SIZE = 500;

async function backfillAssetSources(): Promise<void> {
  let page = 0;
  let assetsScanned = 0;
  let sourcesUpserted = 0;
  const seenSourceKeys = new Set<string>();
  const start = Date.now();

  try {
    await runInstrumentedJob("backfillAssetSources", async () => {
    while (true) {
      const rows = await prisma.asset.findMany({
        skip: page * PAGE_SIZE,
        take: PAGE_SIZE,
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          assetTag: true,
          tags: true,
          discoveredByIntegrationId: true,
          hostname: true,
          ipAddress: true,
          os: true,
          osVersion: true,
          serialNumber: true,
          manufacturer: true,
          model: true,
          assetType: true,
          status: true,
          learnedLocation: true,
          dnsName: true,
          latitude: true,
          longitude: true,
          acquiredAt: true,
          lastSeen: true,
          createdBy: true,
        },
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        const snapshot: AssetSnapshot = {
          id: row.id,
          assetTag: row.assetTag,
          tags: row.tags ?? [],
          discoveredByIntegrationId: row.discoveredByIntegrationId,
          hostname: row.hostname,
          ipAddress: row.ipAddress,
          os: row.os,
          osVersion: row.osVersion,
          serialNumber: row.serialNumber,
          manufacturer: row.manufacturer,
          model: row.model,
          assetType: row.assetType,
          status: row.status,
          learnedLocation: row.learnedLocation,
          dnsName: row.dnsName,
          latitude: row.latitude,
          longitude: row.longitude,
          acquiredAt: row.acquiredAt,
          lastSeen: row.lastSeen,
          createdBy: row.createdBy,
        };
        const sources = deriveAssetSources(snapshot);
        const seen = row.lastSeen ?? new Date();
        const now = new Date();

        for (const s of sources) {
          // The (sourceKind, externalId) unique constraint means two assets
          // claiming the same identity (e.g. duplicate entra deviceId from
          // a botched manual edit) would collide on upsert. Skip the second
          // one and log; admins resolve via "split asset" once Phase 3 ships.
          const key = `${s.sourceKind}::${s.externalId}`;
          if (seenSourceKeys.has(key)) {
            logger.warn(
              { sourceKind: s.sourceKind, externalId: s.externalId, assetId: row.id },
              "Backfill: duplicate AssetSource key seen across multiple assets — skipping later occurrence",
            );
            continue;
          }
          seenSourceKeys.add(key);

          try {
            // createMany + skipDuplicates: rows that already exist (real
            // discovery-owned data) are left completely untouched — the
            // (sourceKind, externalId) unique constraint absorbs the
            // conflict without a write. Only genuinely missing rows are
            // bootstrapped from the legacy-tag derivation.
            const res = await prisma.assetSource.createMany({
              data: [{
                assetId: row.id,
                sourceKind: s.sourceKind,
                externalId: s.externalId,
                integrationId: s.integrationId,
                inferred: s.inferred,
                observed: s.observed as any,
                syncedAt: now,
                firstSeen: seen,
                lastSeen: seen,
              }],
              skipDuplicates: true,
            });
            sourcesUpserted += res.count;
          } catch (err: any) {
            logger.warn(
              { err: err?.message, sourceKind: s.sourceKind, externalId: s.externalId, assetId: row.id },
              "Backfill: failed to create AssetSource row",
            );
          }
        }
        assetsScanned++;
      }

      if (rows.length < PAGE_SIZE) break;
      page++;
    }

    if (assetsScanned > 0) {
      logger.info(
        { assets: assetsScanned, sources: sourcesUpserted, elapsedMs: Date.now() - start },
        "Backfilled missing AssetSource rows from legacy tag conventions (existing rows untouched)",
      );
    }
    });
  } catch (err) {
    logger.error({ err }, "AssetSource backfill failed (writes will continue without phase-1 backfill)");
  }
}

backfillAssetSources();
