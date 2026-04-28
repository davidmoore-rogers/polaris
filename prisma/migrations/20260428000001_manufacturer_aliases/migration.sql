-- CreateTable
CREATE TABLE "manufacturer_aliases" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "canonical" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manufacturer_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "manufacturer_aliases_alias_key" ON "manufacturer_aliases"("alias");

-- CreateIndex
CREATE INDEX "manufacturer_aliases_canonical_idx" ON "manufacturer_aliases"("canonical");
