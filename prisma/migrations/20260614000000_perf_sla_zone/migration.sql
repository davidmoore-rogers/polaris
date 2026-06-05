-- Add the SD-WAN zone each Performance-SLA member belongs to (from
-- `config system sdwan` members[].zone). Surfaced as "interface (zone)" in the
-- asset modal's SD-WAN Members table. Additive + nullable — existing rows
-- (collected before this column) simply read null.
ALTER TABLE "asset_perf_sla_samples" ADD COLUMN "zone" TEXT;
