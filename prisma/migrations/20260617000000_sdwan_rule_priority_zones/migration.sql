-- Add zone-preference capture to SD-WAN rule samples. FortiOS service rules
-- configured for zone-based selection (`priority-zone`) carry no interface
-- members; this column records the preferred zone(s) in priority order so the
-- candidate members can be resolved + grouped by zone in the UI.
--
-- Constant-default ADD COLUMN = metadata-only in PG 11+ (no table rewrite) and
-- safe on the TimescaleDB hypertable / compressed chunks (no decompression).
ALTER TABLE "asset_sdwan_rule_samples" ADD COLUMN "priorityZones" TEXT[] DEFAULT ARRAY[]::TEXT[];
