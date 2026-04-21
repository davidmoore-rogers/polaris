-- CreateEnum
CREATE TYPE "ReservationSourceType" AS ENUM ('manual', 'dhcp_reservation', 'dhcp_lease', 'interface_ip', 'vip', 'fortiswitch', 'fortinap', 'fortimanager');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('pending', 'accepted', 'rejected');

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN "sourceType" "ReservationSourceType" NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "conflicts" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "integrationId" TEXT,
    "proposedHostname" TEXT,
    "proposedOwner" TEXT,
    "proposedProjectRef" TEXT,
    "proposedNotes" TEXT,
    "proposedSourceType" TEXT NOT NULL,
    "conflictFields" TEXT[],
    "status" "ConflictStatus" NOT NULL DEFAULT 'pending',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conflicts_reservationId_idx" ON "conflicts"("reservationId");

-- CreateIndex
CREATE INDEX "conflicts_status_idx" ON "conflicts"("status");

-- CreateIndex
CREATE INDEX "conflicts_integrationId_idx" ON "conflicts"("integrationId");

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
