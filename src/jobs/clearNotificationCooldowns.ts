/**
 * src/jobs/clearNotificationCooldowns.ts
 *
 * One-shot startup migration: clear `NotificationRule.cooldownSec` on every
 * automation, retiring the "Re-notify cooldown (minutes)" control the wizard
 * offered until 2026-08.
 *
 * WHY THE DATA GOES TOO. Removing the field from the builder without clearing
 * the column would leave a rule holding a cooldown that nothing on screen
 * states and nothing in the UI can edit — still enforced by the engine's
 * fire()/event-tail checks, so an operator asking "why did this automation go
 * quiet for twenty minutes?" would have no surface anywhere in Polaris that
 * could answer. An invisible setting that still governs behavior is worse than
 * either keeping the control or dropping the behavior, so the value is cleared
 * with the control.
 *
 * WHAT SURVIVES. The `cooldownSec` column and the engine's two checks stay —
 * dormant, the `failureThreshold` precedent (business rule 36). An API caller
 * may still set one deliberately; the wizard simply never reads it back and
 * writes null on every save, so a value re-set through the API can't outlive
 * the next edit in the builder. Removing the column outright would break
 * pre-cutover API clients and rule exports for no gain.
 *
 * AUDIT BEFORE DATA. The Event is written FIRST and carries every affected
 * rule's name and its old value in seconds, because the update is what makes
 * that number unrecoverable — an operator who wants the suppression back needs
 * to know what it was, and Events are the only place left that can tell them.
 * One Event for the whole sweep, not one per rule: this is a single migration,
 * and a fleet with fifty cooled-down automations should not push a day of
 * unrelated audit history off the 7-day retention window.
 *
 * Idempotency: marker key "notificationCooldownsClearedAt" in Setting, plus the
 * WHERE filter (safe to re-run after restores).
 * Recovery: delete the marker Setting and restart — though a re-run finds
 * nothing to clear, the Event from the first pass being the record.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { logEvent } from "../services/eventLogService.js";

const CLEARED_KEY = "notificationCooldownsClearedAt";

/** Cap on the per-rule detail carried in the Event. A fleet with hundreds of
 *  cooled-down automations should not write an unbounded JSON blob into an
 *  audit row; the count is always exact, the list is a sample. */
const MAX_DETAIL_ROWS = 100;

(async () => {
  try {
    await runInstrumentedJob("clearNotificationCooldowns", async () => {
      if (await hasRunMarker(CLEARED_KEY)) return;

      // Rules, not assets: the automation table is operator-sized (tens to low
      // hundreds), so this reads the affected ones whole in one query.
      const rows = await prisma.notificationRule.findMany({
        where: { cooldownSec: { not: null } },
        select: { id: true, name: true, cooldownSec: true },
        orderBy: { name: "asc" },
      });

      if (rows.length === 0) {
        await stampRunMarker(CLEARED_KEY, { rulesCleared: 0 });
        return;
      }

      // Written before the update: after it, the old values are gone.
      await logEvent({
        action: "automation.cooldown.retired",
        resourceType: "system",
        actor: "system:migration",
        level: "warning",
        message:
          `Re-notify cooldown was retired from the automation builder; cleared it on ${rows.length} ` +
          `automation${rows.length === 1 ? "" : "s"}. Those automations may now raise a new alert about the ` +
          `same device as soon as one clears. Use "Repeat this notification" if you want an alert to keep ` +
          `reminding instead.`,
        details: {
          rulesCleared: rows.length,
          rules: rows.slice(0, MAX_DETAIL_ROWS).map((r) => ({
            id: r.id,
            name: r.name,
            previousCooldownSec: r.cooldownSec,
          })),
          ...(rows.length > MAX_DETAIL_ROWS ? { detailTruncatedAt: MAX_DETAIL_ROWS } : {}),
        },
      });

      // One statement rather than a per-row loop: same WHERE, and it stays a
      // single indexed UPDATE whether the install has three automations or
      // three hundred.
      const { count } = await prisma.notificationRule.updateMany({
        where: { cooldownSec: { not: null } },
        data: { cooldownSec: null },
      });

      await stampRunMarker(CLEARED_KEY, { rulesCleared: count });
      logger.info({ rulesCleared: count }, "Cleared re-notify cooldown on every automation (control retired)");
    });
  } catch (err) {
    logger.error(
      { err },
      "notification cooldown clear-out failed — recovery: delete the notificationCooldownsClearedAt Setting and restart",
    );
  }
})();
