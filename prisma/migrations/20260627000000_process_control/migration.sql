-- Phase 4: process control.
--
-- (1) The agent_commands queue table (operator Stop/Start/Restart requests).
-- (2) Seed the new `processControl` RBAC function key onto every existing role's
--     permission matrix: admin = fullwrite, assetsadmin = write, everyone else
--     = none. The gate (requirePermission) reads the stored matrix with no admin
--     bypass, so admin MUST be seeded fullwrite or it would lose the new function.
--     updatedAt is bumped so the in-memory role-snapshot cache refetches.

CREATE TABLE "agent_commands" (
  "id"             TEXT NOT NULL,
  "assetId"        TEXT NOT NULL,
  "managedAgentId" TEXT NOT NULL,
  "action"         TEXT NOT NULL,
  "target"         TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "requestedBy"    TEXT,
  "requestedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt"         TIMESTAMP(3),
  "completedAt"    TIMESTAMP(3),
  "error"          TEXT,
  "resultState"    TEXT,
  CONSTRAINT "agent_commands_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_commands_managedAgentId_status_idx" ON "agent_commands"("managedAgentId", "status");
CREATE INDEX "agent_commands_assetId_idx" ON "agent_commands"("assetId");

-- Seed processControl on every role missing it (default none), then raise the
-- two built-ins. The `permissions` column is jsonb (Prisma Json).
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{processControl}', '"none"', true),
      "updatedAt"   = NOW()
  WHERE NOT ("permissions" ? 'processControl');
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{processControl}', '"fullwrite"', true),
      "updatedAt"   = NOW()
  WHERE "name" = 'admin';
UPDATE "roles"
  SET "permissions" = jsonb_set("permissions", '{processControl}', '"write"', true),
      "updatedAt"   = NOW()
  WHERE "name" = 'assetsadmin';
