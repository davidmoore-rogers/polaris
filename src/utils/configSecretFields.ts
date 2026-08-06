/**
 * src/utils/configSecretFields.ts — which JSON keys hold secrets.
 *
 * Consumed by the Prisma extension in src/db.ts, which seals these fields on
 * write and opens them on read for the four secret-bearing JSON columns:
 * Credential.config, Integration.config, NotificationChannel.config, and
 * Setting.value (LDAP bind password, OIDC client secret, agent signing key,
 * event-archive SFTP password, the scheduled-backup passphrase).
 *
 * ── Why a name union rather than per-type lists ────────────────────────────────
 * Each of those services already owns a per-type secret-field list for MASKING
 * (credentialService's SECRET_FIELDS_BY_TYPE, integrations' stripSecret, the
 * `secret: true` flags in CHANNEL_TYPE_META). Encryption deliberately does NOT
 * reuse them, for two reasons:
 *
 *   1. Coupling. db.ts is the lowest layer in the graph; importing three
 *      services' vocabularies into it would invert the dependency direction and
 *      drag the notification type catalogue into every process.
 *   2. Failure direction. A per-type list that MISSES a field stores a real
 *      secret in plaintext, silently. A name union that includes a field which
 *      happens not to be secret for some type merely encrypts a harmless value.
 *      Over-sealing is a non-event; under-sealing is the bug being fixed.
 *
 * So: any string leaf whose KEY is in this set gets sealed, wherever it appears
 * in the JSON (the walk is recursive because Integration.config nests secrets
 * inside per-class blocks, and Setting.value shapes vary per key).
 *
 * ── Adding a field ────────────────────────────────────────────────────────────
 * When you add a config field that holds a secret, add its key here IN THE SAME
 * CHANGE as the masking entry. Sealing is idempotent and openValue passes
 * plaintext through, so adding a name is safe on an existing install: new writes
 * seal, and the backfillSecretEncryption job seals what is already stored.
 */

/**
 * JSON keys whose string values are encrypted at rest.
 *
 * Sources, so this stays auditable against the masking lists:
 *   Credential   — community, authKey, privKey (snmp); password (winrm);
 *                  password, privateKey (ssh); apiToken (restapi)
 *   Integration  — apiToken, fortigateApiToken, password, clientSecret,
 *                  bindPassword
 *   Channel      — password (smtp), clientSecret (oauth_m365),
 *                  accessToken (pushbullet), webhookUrl (slack, teams),
 *                  privateKey (web_push VAPID)
 *   Setting      — bindPassword (ldap), clientSecret (oidc),
 *                  privateKey / signingKey (agent signing),
 *                  password / passphrase (event-archive SFTP, backupSchedule)
 */
export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "accessToken",
  "apiToken",
  "authKey",
  "bindPassword",
  "clientSecret",
  "community",
  "fortigateApiToken",
  "passphrase",
  "password",
  "privKey",
  "privateKey",
  "secretAccessKey",
  "signingKey",
  "token",
  "webhookUrl",
]);

/** Prisma model names whose JSON payload is walked for secret fields. */
export const SECRET_BEARING_MODELS: ReadonlySet<string> = new Set([
  "Credential",
  "Integration",
  "NotificationChannel",
  "Setting",
]);

/**
 * The JSON column to walk, per model. Setting stores its blob in `value`; the
 * other three use `config`.
 */
export function secretJsonFieldFor(model: string): "config" | "value" | null {
  if (model === "Setting") return "value";
  if (SECRET_BEARING_MODELS.has(model)) return "config";
  return null;
}

/** Guard against a malformed or hostile blob costing unbounded work. */
const MAX_WALK_DEPTH = 8;

/**
 * Recursively transform every string leaf whose key is a secret key.
 *
 * Returns a NEW structure — never mutates the input, because Prisma args and
 * query results are shared with the caller. Non-objects, numbers, booleans and
 * nulls pass through untouched.
 */
export function transformSecretFields(
  value: unknown,
  transform: (plain: string) => string,
  depth = 0,
): unknown {
  if (depth > MAX_WALK_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((v) => transformSecretFields(v, transform, depth + 1));
  }
  if (value === null || typeof value !== "object") return value;

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "string" && SECRET_CONFIG_KEYS.has(k)) {
      out[k] = transform(v);
    } else {
      out[k] = transformSecretFields(v, transform, depth + 1);
    }
  }
  return out;
}
