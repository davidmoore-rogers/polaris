/**
 * src/utils/secretMask.ts
 *
 * THE mask sentinel for secrets echoed to the UI, and the one detector for
 * "the client sent the mask back unchanged". Every secret-bearing surface
 * (credentials, integrations, delivery channels, agent signing, LDAP/OIDC
 * auth settings, event-archive settings) masks stored secrets with
 * SECRET_MASK on read and must treat a masked echo as "keep the stored
 * value" on write — persisting the mask itself produces garbage like
 * "Bearer ••••••••", which Node's HTTP layer rejects with a ByteString
 * error on the next call.
 *
 * Before this util existed there were seven independent implementations
 * using two different glyphs ("••••••••" and "********"); a config value
 * flowing between two surfaces could ship the placeholder as a real
 * secret because the detectors didn't recognize each other's mask.
 */

export const SECRET_MASK = "••••••••";

/**
 * The asterisk-style mask the LDAP/OIDC settings surfaces emitted before
 * the consolidation. Only those two merge paths still accept it (an
 * in-flight settings form from a pre-upgrade page echoes it back); do NOT
 * extend asterisk recognition to other surfaces — a real all-asterisk
 * password there would silently become un-settable.
 */
export const LEGACY_ASTERISK_MASK = "********";

/**
 * True when the value is a run of mask bullets (any length ≥1 — the edit
 * modals pre-fill with SECRET_MASK but some historical forms echoed
 * different lengths). Deliberately does NOT match asterisk runs; see
 * LEGACY_ASTERISK_MASK.
 */
export function isMaskedSecret(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && /^•+$/.test(value);
}
