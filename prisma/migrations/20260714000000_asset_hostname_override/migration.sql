-- Operator hostname override (pin). When set, the value is the effective
-- Asset.hostname; discovery-projected hostname writes are re-asserted back to
-- it by the Prisma extension in src/db.ts. See Asset.hostnameOverride in
-- schema.prisma.
ALTER TABLE "assets" ADD COLUMN "hostnameOverride" TEXT;
