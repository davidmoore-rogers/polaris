-- Operator opt-in (Linux) to install the Polaris Agent as root instead of the
-- default unprivileged DynamicUser systemd unit. Root is required for service
-- control (systemctl start/stop/restart), root automation scripts, and
-- Application Map connection attribution (reading other users' /proc/<pid>/fd).
-- Default false preserves the hardened unprivileged install for every existing
-- and new agent unless the operator explicitly opts in at install time. On
-- Windows the agent always runs as LocalSystem, so this flag is not consulted.
ALTER TABLE "managed_agents" ADD COLUMN "runAsRoot" BOOLEAN NOT NULL DEFAULT false;
