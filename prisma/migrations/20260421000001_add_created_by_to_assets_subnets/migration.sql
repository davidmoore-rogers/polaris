-- AlterTable
ALTER TABLE "subnets" ADD COLUMN "createdBy" TEXT;

-- AlterTable
ALTER TABLE "assets" ADD COLUMN "createdBy" TEXT;

-- CreateIndex
CREATE INDEX "subnets_createdBy_idx" ON "subnets"("createdBy");

-- CreateIndex
CREATE INDEX "assets_createdBy_idx" ON "assets"("createdBy");
