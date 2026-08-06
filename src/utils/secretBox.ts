/**
 * src/utils/secretBox.ts — envelope encryption for secrets stored in JSON columns.
 *
 * The problem this solves: Credential.config, Integration.config,
 * NotificationChannel.config and several Setting rows held their secrets as
 * PLAINTEXT. They were masked on the API read path, but masking is a UI
 * courtesy — the values sat in the clear in Postgres, which means in the clear
 * in every `pg_dump`, on every volume snapshot, and in front of anyone with a
 * psql session or a read replica. One backup file was the credentials to the
 * entire managed network: SNMP communities, WinRM and SSH passwords, SSH private
 * keys, FortiManager and FortiGate API keys, the Entra client secret, vCenter
 * credentials, SMTP and M365 secrets, Slack and Teams webhook URLs, and the Web
 * Push VAPID private key. The backup passphrase is optional, so the default
 * download was an unencrypted dump of all of it.
 *
 * Approach: seal individual VALUES rather than whole rows, with the key held
 * outside the database. A dump on its own is then inert — restoring it somewhere
 * without the key yields tokens, not credentials. Sealing values (not rows) also
 * keeps every non-secret field in `config` queryable, which matters: raw SQL in
 * monitorOverrideService reads `integrations.config #>> '{fortigateMonitor,…}'`.
 *
 * Token format (self-describing, so plaintext and sealed values can coexist
 * during the backfill and forever after for un-keyed installs):
 *
 *   psec:v1:<base64url iv>:<base64url authTag>:<base64url ciphertext>
 *
 * AES-256-GCM. The IV is 12 random bytes per value (never reused). The key is
 * derived once per process from POLARIS_SECRET_KEY.
 *
 * ── Key management ────────────────────────────────────────────────────────────
 * POLARIS_SECRET_KEY holds 32 bytes as 64 hex characters (or base64). Delivered
 * the same way SESSION_SECRET is: written to .env by the first-run wizard, or
 * injected from Azure Key Vault by the orchestrator in a managed deployment.
 *
 * When the key is UNSET, sealing is a NO-OP and values are stored as plaintext —
 * i.e. exactly the pre-2026-08 behavior. That is deliberate: an in-app update
 * must never leave an install unable to reach its own FortiManager because a new
 * required env var appeared. The absence surfaces as a `secrets_key_unset`
 * capacity watch reason and a boot warning instead of a broken integration.
 *
 * ── Losing the key ────────────────────────────────────────────────────────────
 * Sealed values cannot be recovered without it. `openValue` therefore NEVER
 * throws on a failed open: it logs once per process and returns an empty string,
 * so a key mismatch degrades to "this credential stopped working" (visible,
 * fixable by re-entering it) rather than crashing every poll. Rotating the key
 * means re-entering the secrets, which is why INSTALL.md tells operators to back
 * the key up somewhere other than the host it protects.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { logger } from "./logger.js";

const TOKEN_PREFIX = "psec:v1:";
const IV_LEN = 12;

let _key: Buffer | null | undefined; // undefined = not yet resolved, null = no key
let _warnedNoKey = false;
let _warnedOpenFailure = false;

/**
 * Resolve the 32-byte key from POLARIS_SECRET_KEY.
 *
 * Accepts 64 hex chars (the documented form the wizard writes) or base64. Any
 * other length is hashed to 32 bytes with SHA-256 rather than rejected, so an
 * operator who pastes a long passphrase gets working encryption instead of a
 * silent no-op — the one thing worse than a weak key here is believing you have
 * encryption when you do not.
 */
function resolveKey(): Buffer | null {
  if (_key !== undefined) return _key;

  const raw = (process.env.POLARIS_SECRET_KEY || "").trim();
  if (!raw) {
    _key = null;
    return _key;
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    _key = Buffer.from(raw, "hex");
  } else {
    const b64 = Buffer.from(raw, "base64");
    _key = b64.length === 32 ? b64 : createHash("sha256").update(raw, "utf8").digest();
  }
  return _key;
}

/** Test seam — clears the memoized key after mutating process.env. */
export function _resetKeyCacheForTests(): void {
  _key = undefined;
  _warnedNoKey = false;
  _warnedOpenFailure = false;
}

/** Is secret-at-rest encryption active on this install? */
export function secretEncryptionEnabled(): boolean {
  return resolveKey() !== null;
}

/** Generate a key in the documented form, for the wizard and for docs. */
export function generateSecretKey(): string {
  return randomBytes(32).toString("hex");
}

/** Does this value already carry the sealed-token envelope? */
export function isSealed(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(TOKEN_PREFIX);
}

/**
 * Seal a plaintext string.
 *
 * Returns the input UNCHANGED when there is no key (un-keyed install), when the
 * value is empty (nothing to protect, and an empty string is meaningful to the
 * "is this secret set?" checks), or when it is already sealed (idempotent, so
 * the backfill and the write path can both run over the same row safely).
 */
export function sealValue(plaintext: string): string {
  if (!plaintext) return plaintext;
  if (isSealed(plaintext)) return plaintext;

  const key = resolveKey();
  if (!key) {
    if (!_warnedNoKey) {
      _warnedNoKey = true;
      logger.warn(
        "POLARIS_SECRET_KEY is not set — device and integration secrets are being stored as PLAINTEXT in the database, and therefore in plaintext in every pg_dump. Set it in .env (see docs/INSTALL.md) and restart to enable encryption at rest.",
      );
    }
    return plaintext;
  }

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${TOKEN_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

/**
 * Open a sealed value. A value that is not sealed is returned unchanged, which
 * is what lets a partially-backfilled install work.
 *
 * NEVER throws. A wrong or missing key returns "" and logs once, so the failure
 * mode is a credential that stopped authenticating (diagnosable) rather than an
 * exception on every monitor tick.
 */
export function openValue(value: string): string {
  if (!isSealed(value)) return value;

  const key = resolveKey();
  if (!key) {
    if (!_warnedOpenFailure) {
      _warnedOpenFailure = true;
      logger.error(
        "Encrypted secrets are present in the database but POLARIS_SECRET_KEY is not set. Integrations, credentials and delivery channels will fail to authenticate until the key is restored to .env.",
      );
    }
    return "";
  }

  const parts = value.slice(TOKEN_PREFIX.length).split(":");
  if (parts.length !== 3) return "";
  try {
    const iv = Buffer.from(parts[0]!, "base64url");
    const tag = Buffer.from(parts[1]!, "base64url");
    const ct = Buffer.from(parts[2]!, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    if (!_warnedOpenFailure) {
      _warnedOpenFailure = true;
      logger.error(
        "Failed to decrypt a stored secret — POLARIS_SECRET_KEY does not match the key these values were sealed with (a restored backup from another host, or a rotated key). Re-enter the affected credentials, integrations and delivery channels.",
      );
    }
    return "";
  }
}
