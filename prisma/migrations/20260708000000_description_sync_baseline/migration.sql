-- Description-sync three-way merge (newest-wins). Interface-level baseline:
-- the last value Polaris and the device agreed on (last pushed/adopted). NULL
-- = no merge base yet → Polaris-primary bootstrap on the next reconcile;
-- non-NULL enables newest-wins (only the side that changed since the baseline
-- wins; both changed → syncStatus="conflict", touch neither side). Device-level
-- baseline lives in the existing Asset.descriptionSync JSON blob (`value` key),
-- so no column is needed there.
ALTER TABLE "asset_interface_overrides" ADD COLUMN "syncedValue" VARCHAR(255);
