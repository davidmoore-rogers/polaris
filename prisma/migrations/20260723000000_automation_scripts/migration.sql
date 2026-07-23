-- Automation script registry + execution results.
--
-- automation_scripts: operator-authored scripts referenced by Automation
-- `script` actions. Gated by the `automationScripts` RBAC key — RCE-equivalent
-- (server scripts run as the polaris service user; agent scripts as
-- root/LocalSystem on the triggering asset). sha256 is recomputed on every
-- save; agents verify it before executing.
--
-- automation_script_runs: one row per execution (server- or agent-side).
-- Server runs are claimed pending→running by the runAutomationScripts job;
-- agent runs ride the AgentCommand queue and complete via
-- /agents/command-result. notificationId carries NO FK (alert lifecycle is
-- independent); rows older than ~90 days are pruned by the runner's sweep.

CREATE TABLE "automation_scripts" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "interpreter" TEXT NOT NULL,
    "body"        TEXT NOT NULL,
    "runTarget"   TEXT NOT NULL DEFAULT 'server',
    "timeoutSec"  INTEGER NOT NULL DEFAULT 60,
    "sha256"      TEXT NOT NULL,
    "enabled"     BOOLEAN NOT NULL DEFAULT true,
    "createdBy"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_scripts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "automation_scripts_name_key" ON "automation_scripts"("name");

CREATE TABLE "automation_script_runs" (
    "id"             TEXT NOT NULL,
    "scriptId"       TEXT,
    "scriptName"     TEXT NOT NULL,
    "sha256"         TEXT NOT NULL,
    "notificationId" TEXT,
    "ruleId"         TEXT,
    "assetId"        TEXT,
    "runOn"          TEXT NOT NULL,
    "agentCommandId" TEXT,
    "args"           TEXT,
    "timeoutSec"     INTEGER NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'pending',
    "exitCode"       INTEGER,
    "stdout"         TEXT,
    "stderr"         TEXT,
    "requestedBy"    TEXT,
    "requestedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt"      TIMESTAMP(3),
    "completedAt"    TIMESTAMP(3),

    CONSTRAINT "automation_script_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automation_script_runs_status_runOn_idx" ON "automation_script_runs"("status", "runOn");
CREATE INDEX "automation_script_runs_scriptId_idx" ON "automation_script_runs"("scriptId");
CREATE INDEX "automation_script_runs_notificationId_idx" ON "automation_script_runs"("notificationId");

ALTER TABLE "automation_script_runs"
  ADD CONSTRAINT "automation_script_runs_scriptId_fkey"
  FOREIGN KEY ("scriptId") REFERENCES "automation_scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
