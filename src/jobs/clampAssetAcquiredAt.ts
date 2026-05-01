/**
 * src/jobs/clampAssetAcquiredAt.ts
 *
 * One-shot startup job: enforces the acquiredAt <= lastSeen invariant on
 * existing Asset rows. Any row where lastSeen is earlier than acquiredAt
 * has its acquiredAt clamped down to match lastSeen. Write-time enforcement
 * via clampAcquiredToLastSeen keeps new writes clean; this handles historical
 * data that predates the invariant.
 *
 * Import this module from src/app.ts to activate it:
 *   import "./jobs/clampAssetAcquiredAt.js";
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

async function clampExistingAssetAcquiredAt(): Promise<void> {
  try {
    // The Prisma model is `Asset` but the on-disk table is `assets`
    // (via the @@map in schema.prisma).
    const count = await prisma.$executeRaw`
      UPDATE assets
      SET "acquiredAt" = "lastSeen"
      WHERE "acquiredAt" IS NOT NULL
        AND "lastSeen" IS NOT NULL
        AND "lastSeen" < "acquiredAt"
    `;
    if (count > 0) {
      logger.info({ count }, "Clamped acquiredAt to lastSeen for existing assets");
    }
  } catch (err) {
    logger.error(err, "Failed to clamp acquiredAt on existing assets");
  }
}

clampExistingAssetAcquiredAt();
