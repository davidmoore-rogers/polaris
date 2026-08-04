/**
 * src/utils/mac.ts
 *
 * Shared MAC-address normalization. The storage convention across Polaris is
 * colon-separated UPPERCASE (e.g. "AA:BB:CC:DD:EE:FF") — see the pervasive
 * `.toUpperCase().replace(/-/g, ":")` pattern in the discovery services and the
 * comment at the top of `normalizeMacKey` in src/api/routes/integrations.ts.
 *
 * `normalizeMacOrNull` additionally rejects empty, malformed, and all-zero
 * MACs by returning null, so callers can skip writing a meaningless value.
 * FortiOS reports `00:00:00:00:00:00` for unconfigured / virtual interfaces;
 * stamping that onto an Asset would be worse than leaving the field null (it
 * would collide in the byMac index and re-create the very duplicate the
 * firewall-mgmt-MAC capture is meant to prevent).
 *
 * Four shapes, one home: `macColonUpperOrNull` (loose upper-colon),
 * `normalizeMacOrNull` (strict upper-colon — Asset storage), `macHexKeyOrNull`
 * (strict bare-hex — match indexes), `normalizeMacLowerColon` (FortiOS wire
 * form — DHCP push / quarantine).
 */

const ALL_ZERO_HEX = "000000000000";

/**
 * LOOSE normalize: colon-separated uppercase, or null when the input is
 * empty / not exactly 12 hex digits. Accepts the all-zero MAC — use this
 * where zero is a legitimate value to represent faithfully (global search,
 * the AssetMacAddress side-table's stored-shape normalization), and
 * `normalizeMacOrNull` where a zero MAC must never become an identity.
 */
export function macColonUpperOrNull(raw: unknown): string | null {
  if (!raw) return null;
  const hex = String(raw).toUpperCase().replace(/[^0-9A-F]/g, "");
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(":");
}

/**
 * Normalize a raw MAC to colon-separated uppercase, or null when the input is
 * empty / not exactly 12 hex digits / all-zero.
 */
export function normalizeMacOrNull(raw: string | null | undefined): string | null {
  const norm = macColonUpperOrNull(raw);
  if (norm === null) return null;
  return norm.replace(/:/g, "") === ALL_ZERO_HEX ? null : norm;
}

/**
 * Bare-hex UPPERCASE matching key ("AABBCCDDEEFF"), or null when the input
 * is empty / not exactly 12 hex digits / all-zero. This is the shape for
 * cross-asset MAC match indexes (discovery byMac, duplicate-hostname merge
 * grouping) — all-zero is rejected so two unrelated devices reporting
 * 00:00:00:00:00:00 can never collide into one identity.
 */
export function macHexKeyOrNull(raw: string | null | undefined): string | null {
  const norm = normalizeMacOrNull(raw);
  return norm === null ? null : norm.replace(/:/g, "");
}

/**
 * FortiOS wire form: colon-separated LOWERCASE. Unrecognizable input passes
 * through lowercased (unchanged historical behavior — the device rejects it
 * with its own error, which is more actionable than silently dropping the
 * value client-side). Use for DHCP-reservation push and quarantine-object
 * matching; use `normalizeMacOrNull` for Asset storage.
 */
export function normalizeMacLowerColon(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return mac.toLowerCase();
  return hex.match(/.{2}/g)!.join(":");
}

/**
 * Normalize a list of raw MACs to distinct, valid, colon-uppercase form,
 * preserving first-seen order. Empty / malformed / all-zero entries are
 * dropped (loopback and tunnel interfaces report all-zero MACs). Used to
 * collect every physical interface MAC off a FortiGate so the firewall is
 * recognized in discovery's byMac index regardless of which interface a peer
 * sighted it on.
 */
export function normalizeMacsDistinct(raws: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    const norm = normalizeMacOrNull(raw);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}
