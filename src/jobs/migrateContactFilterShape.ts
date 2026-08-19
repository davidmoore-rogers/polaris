/**
 * src/jobs/migrateContactFilterShape.ts
 *
 * One-shot startup migration: persist each address-book contact's device filter
 * as an `assetCondition` condition tree — the same shape the automations device
 * filter stores — for rows still carrying the flat `assetCriteria` blob.
 *
 * The conversion is the SAME pure function every reader already normalizes
 * through (criteriaToCondition, via contactFilterOf), so matching behaviour is
 * identical before and after this job runs; persisting is what lets the editor
 * open an old contact in the new builder and what lets the legacy predicate
 * eventually go away. The migrateAutomationRuleShape precedent, with one
 * difference: the legacy column IS nulled here, because the two shapes are not
 * kept as mirrors — exactly one is live per row, and a criteria blob left behind
 * a condition would be a second answer to "which devices?".
 *
 * A row whose criteria carries a rule the tree cannot express (`integration`,
 * which only an API caller could have written — the address-book UI never
 * offered it) is DELIBERATELY SKIPPED and left flat: converting it would
 * silently widen who the contact is responsible for, and dropping the rule would
 * silently narrow it. Those rows keep matching through the legacy predicate and
 * are logged so an operator can decide.
 *
 * Idempotency: marker key "contactFilterConditionMigratedAt" in Setting, plus
 * the WHERE filter (safe to re-run after restores).
 * Recovery: delete the marker Setting and restart.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { criteriaToCondition } from "../utils/criteriaToCondition.js";

const MIGRATED_KEY = "contactFilterConditionMigratedAt";

(async () => {
  try {
    await runInstrumentedJob("migrateContactFilterShape", async () => {
      if (await hasRunMarker(MIGRATED_KEY)) return;

      // Only rows that still have a flat filter and no tree. Contact counts are
      // small by nature (an address book, not a fleet), so this reads them all.
      const rows = await prisma.contact.findMany({
        where: { assetCondition: { equals: Prisma.AnyNull } as never },
        select: { id: true, email: true, assetCriteria: true },
      });

      let updated = 0;
      const skipped: Array<{ email: string; fields: string[] }> = [];
      for (const row of rows) {
        if (row.assetCriteria == null) continue; // address-only contact, nothing to fold
        const { condition, unconvertible } = criteriaToCondition(row.assetCriteria);
        if (unconvertible.length > 0) {
          skipped.push({ email: row.email, fields: unconvertible });
          continue;
        }
        if (!condition) continue; // a blob with nothing usable in it — leave as is
        await prisma.contact.update({
          where: { id: row.id },
          data: { assetCondition: condition as never, assetCriteria: null as never },
        });
        updated++;
      }

      await stampRunMarker(MIGRATED_KEY, { rowsUpdated: updated, rowsSkipped: skipped.length });

      if (updated > 0) {
        logger.info({ rowsUpdated: updated }, "Folded address-book device filters forward to condition trees");
      }
      if (skipped.length > 0) {
        logger.warn(
          { skipped },
          "Some address-book device filters were left in the legacy shape: they use a field the condition builder cannot express (they still match, but the editor cannot show them)",
        );
      }
    });
  } catch (err) {
    logger.error(
      { err },
      "contact device-filter startup migration failed — recovery: delete the contactFilterConditionMigratedAt Setting and restart",
    );
  }
})();
