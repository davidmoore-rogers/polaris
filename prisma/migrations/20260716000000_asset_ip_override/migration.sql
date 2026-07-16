-- Operator IP override (pin). When set, the value is the effective
-- Asset.ipAddress. Discovery writes staging a matching IP release the pin
-- (self-disabling); writes staging a different IP are re-asserted back to it
-- and raise a pending Conflict (proposedAssetFields.collisionReason =
-- "ip-override"). See Asset.ipOverride in schema.prisma and
-- src/services/ipOverrideService.ts.
ALTER TABLE "assets" ADD COLUMN "ipOverride" TEXT;
