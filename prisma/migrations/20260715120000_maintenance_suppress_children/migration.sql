-- Per-schedule toggle: does an in-window (status='maintenance') asset count
-- as DOWN for child dependency suppression? Default true preserves the
-- launch behavior (a maintenance parent takes its dependents into
-- dependency suppression). false = suppression ignores the maintenance
-- status and the parent evaluates by its frozen monitorStatus, so
-- dependents keep monitoring/alerting normally.
ALTER TABLE "maintenance_schedules" ADD COLUMN "suppressChildren" BOOLEAN NOT NULL DEFAULT true;
