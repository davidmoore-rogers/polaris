-- Business rule 42 — a CIDR the operator has declared out of scope for the
-- networks list.
--
-- Global rather than per-block on purpose: the reason a CIDR needs excluding is
-- that several sites serve the SAME one, and scoping the exclusion to a block
-- would let it be recorded through another block.
--
-- `cidr` is the identity (unique, normalized on write) and is frozen after
-- create; only `name` / `notes` are editable. Nothing is backfilled and no
-- existing subnet is touched by this migration — adding an exclusion stops
-- FUTURE recording and leaves rows already in the list alone for the operator
-- to retire (or keep) explicitly.
CREATE TABLE "subnet_exclusions" (
    "id" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subnet_exclusions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subnet_exclusions_cidr_key" ON "subnet_exclusions"("cidr");
CREATE INDEX "subnet_exclusions_cidr_idx" ON "subnet_exclusions"("cidr");
