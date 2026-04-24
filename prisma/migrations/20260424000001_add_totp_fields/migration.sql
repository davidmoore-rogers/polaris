-- Add optional TOTP second-factor fields to local users.
-- totpSecret is set during enrollment; totpEnabledAt flips non-null only after
-- the first valid 6-digit confirmation, at which point MFA is active on login.
-- totpBackupCodes holds argon2id-hashed single-use recovery codes.

ALTER TABLE "users"
    ADD COLUMN "totp_secret"       TEXT,
    ADD COLUMN "totp_enabled_at"   TIMESTAMP(3),
    ADD COLUMN "totp_backup_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
