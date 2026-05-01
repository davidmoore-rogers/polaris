/**
 * src/jobs/backfillAssetSources.ts
 *
 * One-shot startup job: phase-1 of the multi-source asset model. Walks every
 * Asset row, derives the AssetSource rows it should have under the legacy
 * tag/assetTag conventions, and upserts them. Idempotent — safe to re-run on
 * every startup and complements the shadow-write Prisma extension in db.ts.
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

const PAGE_SIZE = 500;

async function backfillAssetSources(): Promise<void> {
  let page = 0;
  let assetsScanned = 0;
  let sourcesUpserted = 0;
  const seenSourceKeys = new Set<string>();
  const start = Date.now();

  try {
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
          model: true,
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
          model: row.model,
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

          const updateData: Record<string, unknown> = {
            assetId: row.id,
            observed: s.observed as any,
            syncedAt: now,
            lastSeen: seen,
          };
          if (!s.inferred) updateData.inferred = false;
          if (s.integrationId) updateData.integrationId = s.integrationId;

          try {
            await prisma.assetSource.upsert({
              where: { sourceKind_externalId: { sourceKind: s.sourceKind, externalId: s.externalId } },
              create: {
                assetId: row.id,
                sourceKind: s.sourceKind,
                externalId: s.externalId,
                integrationId: s.integrationId,
                inferred: s.inferred,
                observed: s.observed as any,
                syncedAt: now,
                firstSeen: seen,
                lastSeen: seen,
              },
              update: updateData,
            });
            sourcesUpserted++;
          } catch (err: any) {
            logger.warn(
              { err: err?.message, sourceKind: s.sourceKind, externalId: s.externalId, assetId: row.id },
              "Backfill: failed to upsert AssetSource row",
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
        "Backfilled AssetSource rows from legacy tag conventions",
      );
    }
  } catch (err) {
    logger.error({ err }, "AssetSource backfill failed (writes will continue without phase-1 backfill)");
  }
}

backfillAssetSources();
