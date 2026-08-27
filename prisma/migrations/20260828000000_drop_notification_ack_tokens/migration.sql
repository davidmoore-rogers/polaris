-- Acknowledging from an email now goes through the logged-in
-- /alert-ack.html page rather than a single-use link, so the token table has
-- no writer and no reader left. Business rule 25.
--
-- Unconditional DROP: every row in here is a credential with at most a 30-day
-- life, and the rows outlive their usefulness the moment the /ack route stops
-- being mounted. Nothing references them (the two FKs point OUT of this table,
-- at Notification and User), so the drop cannot orphan anything.
DROP TABLE IF EXISTS "notification_ack_tokens";
