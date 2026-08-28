-- FortiAP radio tx-power columns: unit-neutral names, and Config instead of Min.
--
-- The columns shipped as txPowerDbm / txPowerMinDbm / txPowerMaxDbm on the
-- assumption that the AP's own MIB reports dBm. Reading the module says
-- otherwise: fapRadioTxPowerConfig / fapRadioTxPowerOper / fapRadioTxPowerMax
-- are bare Integer32 with NO `UNITS` clause, no range, and a DESCRIPTION that
-- says only "Configured / Operating / Maximum Tx Power of the Radio". FortiOS
-- reports the same quantity over REST as a PERCENTAGE of the radio's ceiling.
-- So the unit is genuinely unknown until it is read off hardware, and a column
-- named `Dbm` holding a percentage is a lie that reads like a measurement.
--
-- The MIB also publishes no MINIMUM. What it has is the CONFIGURED value —
-- what the profile asked for — next to what the radio is actually running and
-- what it could run. That is the more useful trio anyway: the gap between
-- Config and Oper is what DARRP did to the radio.
--
-- Safe as a plain rename: nothing writes these three yet (the controller half
-- fills txPowerPct only), so every existing row has NULL in all of them.
ALTER TABLE "asset_ap_radios" RENAME COLUMN "txPowerDbm"    TO "txPowerOper";
ALTER TABLE "asset_ap_radios" RENAME COLUMN "txPowerMinDbm" TO "txPowerConfig";
ALTER TABLE "asset_ap_radios" RENAME COLUMN "txPowerMaxDbm" TO "txPowerMax";
