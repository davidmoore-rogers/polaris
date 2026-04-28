/**
 * src/jobs/normalizeManufacturers.ts
 *
 * One-shot startup sequence for the manufacturer alias system:
 *   1. seedDefaultAliases() — idempotent insert of common IEEE → marketing
 *      mappings on a fresh install.
 *   2. refreshAliasCache() — populate the in-memory map used by every
 *      Asset / MibFile write through the Prisma extension in db.ts.
 *   3. applyAliasesToExistingRows() — rewrite any historical rows whose
 *      manufacturer string canonicalizes to something different.
 *
 * Import this from src/app.ts to activate it. Failures are logged but never
 * fatal — the app can boot without normalization (writes just pass through
 * unchanged until aliases are loaded).
 */

import { logger } from "../utils/logger.js";
import {
  seedDefaultAliases,
  refreshAliasCache,
  applyAliasesToExistingRows,
} from "../services/manufacturerAliasService.js";

(async () => {
  try {
    const seeded = await seedDefaultAliases();
    if (seeded.inserted > 0) {
      logger.info({ count: seeded.inserted }, "Seeded default manufacturer aliases");
    }
    await refreshAliasCache();
    const applied = await applyAliasesToExistingRows();
    if (applied.assets > 0 || applied.mibs > 0) {
      logger.info(applied, "Normalized manufacturer strings on existing rows");
    }
  } catch (err) {
    logger.error({ err }, "Manufacturer alias startup task failed (writes will pass through unchanged)");
  }
})();
