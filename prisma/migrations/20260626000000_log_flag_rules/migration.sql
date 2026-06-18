-- Log-flag rules (Feature C): operator-defined rules that flag matching process
-- log lines. Evaluated at read time (no per-row persisted flag), so this is a
-- plain config table — no hypertable, no FK.

CREATE TABLE "log_flag_rules" (
  "id"            TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "enabled"       BOOLEAN NOT NULL DEFAULT true,
  "scope"         TEXT NOT NULL DEFAULT 'global',
  "assetId"       TEXT,
  "processName"   TEXT,
  "matchType"     TEXT NOT NULL DEFAULT 'substring',
  "pattern"       TEXT NOT NULL,
  "caseSensitive" BOOLEAN NOT NULL DEFAULT false,
  "minLevel"      TEXT,
  "label"         TEXT,
  "color"         TEXT,
  "createdBy"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "log_flag_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "log_flag_rules_enabled_idx" ON "log_flag_rules"("enabled");
CREATE INDEX "log_flag_rules_assetId_idx" ON "log_flag_rules"("assetId");
