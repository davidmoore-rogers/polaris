/**
 * src/jobs/migrateTagFilterShape.ts
 *
 * One-shot startup migration: persist each auto-assigning tag's device filter as
 * an `assetCondition` condition tree — the same shape the automations device
 * filter and the address book store — for rows still carrying the flat
 * `criteria` blob.
 *
 * The conversion is the SAME pure function every reader already normalizes
 * through (criteriaToCondition, via tagFilterOf), so which assets a tag matches
 * is identical before and after this job runs; persisting is what lets the
 * editor open an old tag in the new builder and what lets the legacy predicate
 * eventually go away. The migrateContactFilterShape precedent, verbatim,
 * including nulling the legacy column: the two shapes are not kept as mirrors —
 * exactly one is live per row, and a criteria blob left behind a condition would
 * be a second answer to "which devices?".
 *
 * A tag whose criteria carries a rule the tree cannot express (`integration`,
 * which only an API caller could have written — the criteria builder never
 * offered it) is DELIBERATELY SKIPPED and left flat: converting it would
 * silently widen which devices carry the tag, and dropping the rule would
 * silently narrow it. Those tags keep matching through the legacy predicate and
 * are logged so an operator can decide.
 *
 * No reconcile is triggered. The fold is match-equivalent by construction, so
 * every tag lands on exactly the assets it was already on; reconcileAllTags runs
 * on its own schedule regardless.
 *
 * Idempotency: marker key "tagFilterConditionMigratedAt" in Setting, plus the
 * WHERE filter (safe to re-run after restores).
 * Recovery: delete the marker Setting and restart.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { criteriaToCondition } from "../utils/criteriaToCondition.js";

const MIGRATED_KEY = "tagFilterConditionMigratedAt";

(async () => {
  try {
    await runInstrumentedJob("migrateTagFilterShape", async () => {
      if (await hasRunMarker(MIGRATED_KEY)) return;

      // Only rows that still have a flat filter and no tree. The tag registry is
      // small by nature (a category list, not a fleet), so this reads them all.
      const rows = await prisma.tag.findMany({
        where: { assetCondition: { equals: Prisma.AnyNull } as never },
        select: { id: true, name: true, criteria: true },
      });

      let updated = 0;
      const skipped: Array<{ tag: string; fields: string[] }> = [];
      for (const row of rows) {
        if (row.criteria == null) continue; // ordinary manual tag, nothing to fold
        const { condition, unconvertible } = criteriaToCondition(row.criteria);
        if (unconvertible.length > 0) {
          skipped.push({ tag: row.name, fields: unconvertible });
          continue;
        }
        if (!condition) continue; // a blob with nothing usable in it — leave as is
        try {
          await prisma.tag.update({
            where: { id: row.id },
            data: { assetCondition: condition as never, criteria: null as never },
          });
          updated++;
        } catch (err: unknown) {
          // A tag deleted between the read above and this write (P2025). Per-row
          // rather than around the loop: one vanished tag must not abandon the
          // fold for every remaining row, which would leave the marker unstamped
          // and the whole job retrying every boot.
          if ((err as { code?: string })?.code !== "P2025") throw err;
          logger.debug({ tagId: row.id }, "migrateTagFilterShape: tag vanished mid-fold, skipping");
        }
      }

      await stampRunMarker(MIGRATED_KEY, { rowsUpdated: updated, rowsSkipped: skipped.length });

      if (updated > 0) {
        logger.info({ rowsUpdated: updated }, "Folded tag auto-assign criteria forward to condition trees");
      }
      if (skipped.length > 0) {
        logger.warn(
          { skipped },
          "Some tag auto-assign filters were left in the legacy shape: they use a field the condition builder cannot express (they still match, but the editor cannot show them)",
        );
      }
    });
  } catch (err) {
    logger.error(
      { err },
      "tag device-filter startup migration failed — recovery: delete the tagFilterConditionMigratedAt Setting and restart",
    );
  }
})();
