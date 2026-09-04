-- Business rule 41 — a discovered subnet records WHICH CHASSIS serves it, and a
-- retired subnet moves to an archive instead of squatting on its CIDR.
--
-- Three parts:
--   1. subnets.fortigateSerial — chassis identity, tri-state (NULL = unknown).
--   2. archived_subnets / archived_reservations — the posterity tables.
--   3. conflicts.subnetId + proposedSubnetFields — the `chassis-replaced` flavour.
--
-- Backfill is deliberately omitted for fortigateSerial. NULL means "unknown",
-- and the first discovery pass that reads a serial adopts it as a first LEARN
-- rather than a replacement (classifyChassis), so every existing row converges
-- on its own without a migration guessing at chassis identity from a name.

-- ── 1. Chassis identity on the live subnet ───────────────────────────────────
ALTER TABLE "subnets" ADD COLUMN "fortigateSerial" TEXT;
CREATE INDEX "subnets_fortigateSerial_idx" ON "subnets"("fortigateSerial");

-- ── 2. Archive tables ────────────────────────────────────────────────────────
-- No foreign keys out to ip_blocks or integrations, deliberately: subnets.blockId
-- cascades from ip_blocks, so an FK here would let deleting a block erase the
-- archive. Block/integration identity is denormalized instead.
CREATE TABLE "archived_subnets" (
    "id" TEXT NOT NULL,
    "originalSubnetId" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "blockCidr" TEXT NOT NULL,
    "blockName" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT,
    "status" "SubnetStatus" NOT NULL,
    "vlan" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "discoveredBy" TEXT,
    "integrationName" TEXT,
    "fortigateDevice" TEXT,
    "fortigateSerial" TEXT,
    "createdBy" TEXT,
    "lastDiscoveredAt" TIMESTAMP(3),
    "originalCreatedAt" TIMESTAMP(3) NOT NULL,
    "originalUpdatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedBy" TEXT,
    "archiveReason" TEXT NOT NULL,

    CONSTRAINT "archived_subnets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "archived_subnets_originalSubnetId_idx" ON "archived_subnets"("originalSubnetId");
CREATE INDEX "archived_subnets_cidr_idx" ON "archived_subnets"("cidr");
CREATE INDEX "archived_subnets_blockId_idx" ON "archived_subnets"("blockId");
CREATE INDEX "archived_subnets_archivedAt_idx" ON "archived_subnets"("archivedAt");
CREATE INDEX "archived_subnets_fortigateSerial_idx" ON "archived_subnets"("fortigateSerial");

CREATE TABLE "archived_reservations" (
    "id" TEXT NOT NULL,
    "archivedSubnetId" TEXT NOT NULL,
    "originalReservationId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "hostname" TEXT,
    "owner" TEXT,
    "projectRef" TEXT,
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,
    "status" "ReservationStatus" NOT NULL,
    "sourceType" "ReservationSourceType" NOT NULL,
    "createdBy" TEXT,
    "macAddress" TEXT,
    "dhcpBinding" TEXT,
    "vipInfo" JSONB,
    "pushStatus" TEXT,
    "pushedAt" TIMESTAMP(3),
    "lastSeenLeased" TIMESTAMP(3),
    "lastSeenArp" TIMESTAMP(3),
    "originalCreatedAt" TIMESTAMP(3) NOT NULL,
    "originalUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "archived_reservations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "archived_reservations_archivedSubnetId_idx" ON "archived_reservations"("archivedSubnetId");
CREATE INDEX "archived_reservations_originalReservationId_idx" ON "archived_reservations"("originalReservationId");
CREATE INDEX "archived_reservations_ipAddress_idx" ON "archived_reservations"("ipAddress");

ALTER TABLE "archived_reservations"
    ADD CONSTRAINT "archived_reservations_archivedSubnetId_fkey"
    FOREIGN KEY ("archivedSubnetId") REFERENCES "archived_subnets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. The subnet Conflict flavour ───────────────────────────────────────────
-- entityType is a plain TEXT column ("reservation" | "asset" | "subnet"), so
-- adding a third variant needs no enum change.
ALTER TABLE "conflicts" ADD COLUMN "subnetId" TEXT;
ALTER TABLE "conflicts" ADD COLUMN "proposedSubnetFields" JSONB;
CREATE INDEX "conflicts_subnetId_idx" ON "conflicts"("subnetId");

ALTER TABLE "conflicts"
    ADD CONSTRAINT "conflicts_subnetId_fkey"
    FOREIGN KEY ("subnetId") REFERENCES "subnets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
