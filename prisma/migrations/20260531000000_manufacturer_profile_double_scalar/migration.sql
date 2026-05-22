-- Generalizes the memory-only "composition" blob into a typed double_scalar
-- shape that any metric can use. Adds a second-OID column (defaultSymbolB /
-- symbolB), promotes the legacy composition rows to the new shape, and
-- leaves the deprecated `composition` JSONB columns in place for one
-- release as a rollback safety net (dropped in a follow-up migration).
--
-- Promotion rules:
--   composition.shape="percent"           → type="scalar",        symbol = pctSymbol,  symbolB = NULL,         transform unchanged
--   composition.shape="bytes_used_total"  → type="double_scalar", symbol = usedSymbol, symbolB = totalSymbol,  transform = "a_over_b_as_percent"
--   composition.shape="bytes_used_free"   → type="double_scalar", symbol = usedSymbol, symbolB = freeSymbol,   transform = "a_over_a_plus_b_as_percent"
--
-- Idempotent: re-running finds no candidates because composition is cleared
-- on successful promotion.

ALTER TABLE "manufacturer_profile_metrics"
  ADD COLUMN "defaultSymbolB" TEXT;

ALTER TABLE "manufacturer_profile_metric_overrides"
  ADD COLUMN "symbolB" TEXT;

-- ── Metric rows ────────────────────────────────────────────────────────

-- Percent → scalar. defaultSymbol may already be set; the composition's
-- pctSymbol is the source of truth, so prefer it.
UPDATE "manufacturer_profile_metrics"
SET
  "defaultType"      = 'scalar',
  "defaultSymbol"    = COALESCE("composition"->>'pctSymbol', "defaultSymbol"),
  "defaultSymbolB"   = NULL,
  "composition"      = NULL
WHERE "composition" IS NOT NULL
  AND "composition"->>'shape' = 'percent';

-- Bytes (used + total) → double_scalar with combiner a/b × 100.
UPDATE "manufacturer_profile_metrics"
SET
  "defaultType"      = 'double_scalar',
  "defaultSymbol"    = "composition"->>'usedSymbol',
  "defaultSymbolB"   = "composition"->>'totalSymbol',
  "defaultTransform" = 'a_over_b_as_percent',
  "composition"      = NULL
WHERE "composition" IS NOT NULL
  AND "composition"->>'shape' = 'bytes_used_total';

-- Bytes (used + free) → double_scalar with combiner a / (a + b) × 100.
UPDATE "manufacturer_profile_metrics"
SET
  "defaultType"      = 'double_scalar',
  "defaultSymbol"    = "composition"->>'usedSymbol',
  "defaultSymbolB"   = "composition"->>'freeSymbol',
  "defaultTransform" = 'a_over_a_plus_b_as_percent',
  "composition"      = NULL
WHERE "composition" IS NOT NULL
  AND "composition"->>'shape' = 'bytes_used_free';

-- ── Override rows ──────────────────────────────────────────────────────

-- Same three promotion paths against the override table. `symbol` is NOT
-- NULL in the schema, so we never null it out — when a percent override
-- only carried a pctSymbol via composition, copy it onto `symbol`.

UPDATE "manufacturer_profile_metric_overrides"
SET
  "type"        = 'scalar',
  "symbol"      = COALESCE("composition"->>'pctSymbol', "symbol"),
  "symbolB"     = NULL,
  "composition" = NULL
WHERE "composition" IS NOT NULL
  AND "composition"->>'shape' = 'percent';

UPDATE "manufacturer_profile_metric_overrides"
SET
  "type"        = 'double_scalar',
  "symbol"      = COALESCE("composition"->>'usedSymbol', "symbol"),
  "symbolB"     = "composition"->>'totalSymbol',
  "transform"   = 'a_over_b_as_percent',
  "composition" = NULL
WHERE "composition" IS NOT NULL
  AND "composition"->>'shape' = 'bytes_used_total';

UPDATE "manufacturer_profile_metric_overrides"
SET
  "type"        = 'double_scalar',
  "symbol"      = COALESCE("composition"->>'usedSymbol', "symbol"),
  "symbolB"     = "composition"->>'freeSymbol',
  "transform"   = 'a_over_a_plus_b_as_percent',
  "composition" = NULL
WHERE "composition" IS NOT NULL
  AND "composition"->>'shape' = 'bytes_used_free';
