-- Add per-asset LLDP transport override. Mirrors the existing per-stream
-- response-time / telemetry / interfaces overrides; null inherits from the
-- integration's matching toggle (which itself defaults to "rest").

ALTER TABLE "assets" ADD COLUMN "monitorLldpSource" TEXT;
