/**
 * src/jobs/seedAssetTypes.ts
 *
 * One-shot startup sequence for the AssetTypeDef registry:
 *   1. seedBuiltInAssetTypes() — idempotent insert of the eight historical
 *      built-in rows. Safety net for fresh Docker volumes / restored
 *      backups where the registry-cutover migration didn't get a chance to
 *      seed (the migration itself is the authoritative seed path).
 *   2. refreshCache() — populate the in-memory map used by the Prisma
 *      extension in db.ts to validate Asset.assetType writes.
 *
 * Failures are logged but never fatal — the cache stays empty and
 * isKnownAssetType() falls back to accepting the eight built-in names so
 * any in-flight write keeps working.
 */

import { logger } from "../utils/logger.js";
import {
  seedBuiltInAssetTypes,
  refreshCache,
} from "../services/assetTypeService.js";
import { runInstrumentedJob } from "./_metrics.js";

(async () => {
  try {
    await runInstrumentedJob("seedAssetTypes", async () => {
      const seeded = await seedBuiltInAssetTypes();
      if (seeded.inserted > 0) {
        logger.info({ count: seeded.inserted }, "Seeded built-in asset types");
      }
      await refreshCache();
    });
  } catch (err) {
    logger.error({ err }, "Asset type registry startup task failed (Asset.assetType writes will fall back to built-in validation)");
  }
})();
