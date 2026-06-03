-- IdP group → role + tags mapping, plus a free-form "other" tag dimension
-- parallel to region_tags, and provider-stable external-id columns for the
-- new OIDC + LDAP login flows. All additive: array columns default to empty
-- and the new id columns are nullable, so this is a metadata-only change on a
-- populated database (no table rewrite) and safe at any user-table size.

-- AlterTable: roles — second (free-form) tag dimension parallel to region_tags
ALTER TABLE "roles" ADD COLUMN "other_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable: users — other_tags, last-seen SSO groups, provider external ids
ALTER TABLE "users" ADD COLUMN "other_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "users" ADD COLUMN "sso_groups" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "users" ADD COLUMN "oidc_subject" TEXT;
ALTER TABLE "users" ADD COLUMN "ldap_uid" TEXT;

-- CreateTable: group_mappings
CREATE TABLE "group_mappings" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "group_key" TEXT NOT NULL,
    "group_label" TEXT,
    "role_id" TEXT,
    "region_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "other_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_oidc_subject_key" ON "users"("oidc_subject");

-- CreateIndex
CREATE UNIQUE INDEX "users_ldap_uid_key" ON "users"("ldap_uid");

-- CreateIndex
CREATE UNIQUE INDEX "group_mappings_provider_group_key_key" ON "group_mappings"("provider", "group_key");

-- CreateIndex
CREATE INDEX "group_mappings_provider_enabled_idx" ON "group_mappings"("provider", "enabled");

-- CreateIndex
CREATE INDEX "group_mappings_role_id_idx" ON "group_mappings"("role_id");

-- AddForeignKey
ALTER TABLE "group_mappings" ADD CONSTRAINT "group_mappings_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
