-- Add per-role badge color (#rrggbb). Null = fall back to legacy name-keyed
-- badge classes. Backfill the five built-ins with their historical colors so
-- existing installs render identically post-migration (assetsadmin shifts
-- from cyan to a clearer blue per operator request).
ALTER TABLE "roles" ADD COLUMN "color" TEXT;

UPDATE "roles" SET "color" = '#ff1744' WHERE "name" = 'admin'        AND "color" IS NULL;
UPDATE "roles" SET "color" = '#ff9800' WHERE "name" = 'networkadmin' AND "color" IS NULL;
UPDATE "roles" SET "color" = '#2196f3' WHERE "name" = 'assetsadmin'  AND "color" IS NULL;
UPDATE "roles" SET "color" = '#9e9e9e' WHERE "name" = 'readonly'     AND "color" IS NULL;
UPDATE "roles" SET "color" = '#00c853' WHERE "name" = 'user'         AND "color" IS NULL;
