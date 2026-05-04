-- Composite index covering the runMonitorPass candidate query:
--   SELECT ... FROM assets WHERE monitored = true AND monitorType IS NOT NULL;
-- The existing `assets_monitored_lastMonitorAt_idx` is kept because queries
-- that filter only on monitored + lastMonitorAt cannot use this composite
-- index as a prefix.

CREATE INDEX "assets_monitored_monitorType_lastMonitorAt_idx"
    ON "assets" ("monitored", "monitorType", "lastMonitorAt");
