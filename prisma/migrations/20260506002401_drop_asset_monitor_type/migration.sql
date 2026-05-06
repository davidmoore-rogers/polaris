/*
  Warnings:

  - You are about to drop the column `monitorType` on the `assets` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "assets_monitored_monitorType_lastMonitorAt_idx";

-- AlterTable
ALTER TABLE "assets" DROP COLUMN "monitorType";
