/**
 * src/jobs/enforceSubnetUniqueIndex.ts
 *
 * Self-healing startup job: adds the UNIQUE index on subnets (blockId, cidr)
 * when it is missing and the data permits it.
 *
 * Migration 20260806000000 creates that index, but SKIPS creation (with a
 * WARNING) on an install that already carries duplicate (blockId, cidr) rows
 * from the pre-lock race — failing the migration there would block the whole
 * upgrade over historical data. This job closes that gap: it runs on every boot
 * of the migrating role, and once an operator has merged or deleted the
 * duplicates the index appears without needing another migration.
 *
 * Deliberately NOT marker-guarded (no hasRunMarker) unlike the other one-shots:
 * the whole point is to retry until it succeeds. The work is two cheap catalog
 * queries when the index already exists, which is the steady state.
 *
 * Import this module from src/app.ts to activate it:
 *   import "./jobs/enforceSubnetUniqueIndex.js";
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "../services/eventLogService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INDEX_NAME = "subnets_block_cidr_key";

interface DuplicateGroup {
  blockId: string;
  cidr: string;
  copies: number;
}

/** Duplicate (blockId, cidr) groups blocking the unique index, worst first. */
export async function findDuplicateSubnetCidrs(): Promise<DuplicateGroup[]> {
  return prisma.$queryRaw<DuplicateGroup[]>`
    SELECT "blockId", cidr, count(*)::int AS copies
    FROM "subnets"
    GROUP BY "blockId", cidr
    HAVING count(*) > 1
    ORDER BY count(*) DESC, cidr ASC
    LIMIT 50
  `;
}

async function indexExists(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = ${INDEX_NAME}
  `;
  return rows.length > 0;
}

async function enforceSubnetUniqueIndex(): Promise<void> {
  try {
    await runInstrumentedJob("enforceSubnetUniqueIndex", async () => {
      if (await indexExists()) return;

      const dupes = await findDuplicateSubnetCidrs();
      if (dupes.length > 0) {
        const sample = dupes.slice(0, 10).map((d) => `${d.cidr} (x${d.copies})`).join(", ");
        logger.warn(
          { duplicateGroups: dupes.length, sample },
          `${INDEX_NAME} is missing and cannot be created: duplicate (blockId, cidr) subnet rows exist. Merge or delete them and restart; the index is added automatically.`,
        );
        // Warning-level Event so this reaches the operator through the Events
        // tab and the syslog/SFTP archival path, not only the boot log. The
        // per-boot repeat is intentional: an unenforced core IPAM invariant
        // should keep nagging until the data is cleaned up.
        await logEvent({
          level: "warning",
          action: "subnet.unique_index_blocked",
          resourceType: "subnet",
          actor: "system:enforce-subnet-unique-index",
          message: `Duplicate subnet CIDRs block the ${INDEX_NAME} unique index (${dupes.length} group(s)): ${sample}`,
          details: { indexName: INDEX_NAME, duplicateGroups: dupes.length, duplicates: dupes },
        });
        return;
      }

      // CONCURRENTLY would avoid the write lock, but it cannot run inside a
      // transaction block and Prisma's $executeRaw is fine here: the subnets
      // table is small (thousands of rows at most) so the exclusive lock is
      // measured in milliseconds.
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "subnets" ("blockId", cidr)`,
      );
      logger.info({ indexName: INDEX_NAME }, "Created the subnet (blockId, cidr) unique index");
      await logEvent({
        level: "info",
        action: "subnet.unique_index_created",
        resourceType: "subnet",
        actor: "system:enforce-subnet-unique-index",
        message: `Created the ${INDEX_NAME} unique index (duplicate subnet CIDRs have been cleaned up)`,
        details: { indexName: INDEX_NAME },
      });
    });
  } catch (err) {
    // Never fatal: the per-block advisory lock in subnetService is the primary
    // guard, and this index is the backstop.
    logger.error(err, "Failed to enforce the subnet (blockId, cidr) unique index");
  }
}

void enforceSubnetUniqueIndex();
