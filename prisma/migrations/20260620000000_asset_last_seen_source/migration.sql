-- Provenance label for Asset.lastSeen. Stamped by bumpLastSeen()
-- (src/utils/assetInvariants.ts) alongside every lastSeen advance so the
-- asset details slide-over can answer "last seen according to what?".
ALTER TABLE "assets" ADD COLUMN "lastSeenSource" TEXT;
