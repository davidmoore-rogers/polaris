-- Replace the boolean runAsRoot with a three-value privilege tier.
--   "unprivileged" (default) — hardened DynamicUser unit.
--   "ptrace"                 — unprivileged + CAP_SYS_PTRACE (Application Map
--                              connection attribution without full root).
--   "root"                   — LEGACY (full root); backfilled from runAsRoot=true.
--                              New installs can no longer select it.
ALTER TABLE "managed_agents" ADD COLUMN "privilegeTier" TEXT NOT NULL DEFAULT 'unprivileged';

-- Backfill existing root-installed agents so they render as "Root (legacy)"
-- until they're reinstalled (which downgrades them to unprivileged/ptrace).
UPDATE "managed_agents" SET "privilegeTier" = 'root' WHERE "runAsRoot" = true;

ALTER TABLE "managed_agents" DROP COLUMN "runAsRoot";
