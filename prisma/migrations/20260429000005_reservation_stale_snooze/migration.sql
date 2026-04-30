-- Operator-driven snooze + ignore for stale-reservation alerts.
--
-- staleSnoozedUntil: while in the future, the row is suppressed from the
-- alert list and the flagStaleReservations job won't re-fire on it. The
-- discovery sync clears this field whenever the IP is seen actively leased
-- again, so a snoozed reservation that comes back online re-arms cleanly.
--
-- staleIgnored: admin/networkadmin-driven "permanently ignore" — the row
-- never alerts again until explicitly un-ignored. Unlike snooze, this flag
-- is NOT cleared by discovery seeing the IP active again; the operator's
-- intent is durable across online/offline cycles.

ALTER TABLE "reservations"
    ADD COLUMN "staleSnoozedUntil" TIMESTAMP(3),
    ADD COLUMN "staleIgnored"      BOOLEAN NOT NULL DEFAULT false;
