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
 * NOTE: this differs from `normalizeMac` in assetQuarantineService.ts, which
 * emits LOWERCASE for FortiOS quarantine-object matching and never returns
 * null. Use that one for quarantine; use this one for Asset storage.
 */

const ALL_ZERO_HEX = "000000000000";

/**
 * Normalize a raw MAC to colon-separated uppercase, or null when the input is
 * empty / not exactly 12 hex digits / all-zero.
 */
export function normalizeMacOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.toUpperCase().replace(/[^0-9A-F]/g, "");
  if (hex.length !== 12) return null;
  if (hex === ALL_ZERO_HEX) return null;
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
