-- Per-automation "acknowledging this needs a note".
--
-- A plain boolean column rather than a field inside the `actions` JSON: the
-- demand belongs to the ALERT record (the in-app card), not to any one delivery,
-- and every acknowledge path -- the Alerts tab, the mobile list, the emailed
-- one-click link and the web-push action button -- has to read it on a row it
-- already loads. A column makes that read free; a JSON probe would not.
--
-- Defaults FALSE, so every stored automation keeps exactly today's behavior
-- (note optional) until an operator ticks the box.
ALTER TABLE "notification_rules"
  ADD COLUMN "requireAckNote" BOOLEAN NOT NULL DEFAULT false;
