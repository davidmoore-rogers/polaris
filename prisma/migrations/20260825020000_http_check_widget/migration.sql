-- HTTP-check custom widgets.
--
-- The HTTP check moved from being a polling method (its definition stored on an
-- `http` Credential) to a manufacturer custom widget. A check varies by vendor
-- AND model, while a login varies by vendor or site — sharing one row meant a
-- second path needed a second copy of the same password, and rotating the
-- password meant editing every path.
--
-- Three changes, all additive or widening, so this is safe to re-run forward on
-- an install that never used the HTTP check:
--
--  1. `symbol` / `mibId` become NULLABLE. They are SNMP concepts (an OID name
--     and the MIB that defines it); an http widget names a request instead.
--     They stay required for every other widgetType, enforced in
--     manufacturerProfileService because the rule is per-widgetType and a
--     column constraint cannot express that.
--  2. `httpCheck` holds the check definition as JSON.
--  3. `credentialId` points at the `http` Credential supplying authentication.
--     ON DELETE SET NULL rather than CASCADE: deleting a credential must not
--     silently delete the check that used it — the widget should survive and
--     fail loudly until a new credential is chosen.
--
-- No data migration. Pre-split `http` credentials carried a check definition,
-- but a credential names no manufacturer or model, so there is nothing to
-- attribute a widget to without inventing configuration nobody wrote; those
-- fields are dropped on the credential's next save instead.

ALTER TABLE "manufacturer_custom_widgets" ALTER COLUMN "symbol" DROP NOT NULL;
ALTER TABLE "manufacturer_custom_widgets" ALTER COLUMN "mibId"  DROP NOT NULL;

ALTER TABLE "manufacturer_custom_widgets" ADD COLUMN "httpCheck"    JSONB;
ALTER TABLE "manufacturer_custom_widgets" ADD COLUMN "credentialId" TEXT;

ALTER TABLE "manufacturer_custom_widgets"
  ADD CONSTRAINT "manufacturer_custom_widgets_credentialId_fkey"
  FOREIGN KEY ("credentialId") REFERENCES "credentials"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "manufacturer_custom_widgets_credentialId_idx"
  ON "manufacturer_custom_widgets"("credentialId");
