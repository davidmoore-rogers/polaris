/**
 * src/jobs/cleanupStaleDnsResolvedReleased.ts
 *
 * One-shot startup cleanup. Hard-deletes every Reservation row with
 * `sourceType="dns_resolved" AND status="released"`. dns_resolved is a
 * system-created fallback marker; before the release→delete cutover the
 * "release" step flipped these rows to status="released" and left them in
 * place, permanently occupying the (subnetId, ipAddress, "released") slot
 * under the @@unique([subnetId, ipAddress, status]) index. That blocked
 * later status transitions at the same target — surfacing on prod as
 * "Failed to create DHCP lease ... Unique constraint failed on
 * (subnetId, ipAddress, status)" P2002 errors in discovery sync, where
 * the discovery-side P2002 retry path itself couldn't move the active
 * dns_resolved row to "released" because the slot was already taken.
 *
 * Idempotent — re-running finds zero rows once the table is converged.
 * No marker needed; the deleteMany IS the converge check.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { runInstrumentedJob } from "./_metrics.js";

(async () => {
  try {
    await runInstrumentedJob("cleanupStaleDnsResolvedReleased", async () => {
      const res = await prisma.reservation.deleteMany({
        where: {
          sourceType: "dns_resolved" as any,
          status: "released",
        },
      });
      if (res.count > 0) {
        logger.info({ count: res.count }, "Cleaned up stale released dns_resolved reservation rows");
      }
    });
  } catch (err) {
    logger.warn({ err }, "cleanupStaleDnsResolvedReleased failed");
  }
})();
