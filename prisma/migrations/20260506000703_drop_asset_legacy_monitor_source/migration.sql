/*
  Warnings:

  - You are about to drop the column `monitorInterfacesSource` on the `assets` table. All the data in the column will be lost.
  - You are about to drop the column `monitorLldpSource` on the `assets` table. All the data in the column will be lost.
  - You are about to drop the column `monitorResponseTimeSource` on the `assets` table. All the data in the column will be lost.
  - You are about to drop the column `monitorTelemetrySource` on the `assets` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "assets" DROP COLUMN "monitorInterfacesSource",
DROP COLUMN "monitorLldpSource",
DROP COLUMN "monitorResponseTimeSource",
DROP COLUMN "monitorTelemetrySource";
