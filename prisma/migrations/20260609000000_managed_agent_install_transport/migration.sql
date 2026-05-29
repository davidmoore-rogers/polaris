-- ManagedAgent.installTransport — records which remote transport (SSH or WinRM)
-- was used to run the install scripts. Pre-this-migration, the transport was
-- inferred from osPlatform (linux/darwin → SSH, windows → WinRM). With this
-- migration, Windows hosts may install via SSH (OpenSSH Server) instead of
-- WinRM if the operator picks the SSH transport in the install modal.
--
-- Backfill: existing rows match the pre-migration behavior — Windows installs
-- went over WinRM, everything else over SSH.
--
-- Additive + non-nullable with default. Safe to run while monitor / web /
-- discovery workers are live — no existing reader consults this column;
-- agentInstallService gains a branch on it as part of the same change.

ALTER TABLE "managed_agents"
  ADD COLUMN "installTransport" TEXT NOT NULL DEFAULT 'ssh';

UPDATE "managed_agents"
  SET "installTransport" = 'winrm'
  WHERE "osPlatform" = 'windows';
