/**
 * src/utils/fortiapRadioBand.ts
 *
 * Pure (no I/O) derivation of a FortiAP radio's frequency band from the two
 * fields Polaris walks out of FORTINET-FORTIAP-MIB::fapRadioTable
 * (1.3.6.1.4.1.12356.120.4.1.1):
 *   - fapRadioType        (.6)  — radio PHY/mode
 *   - fapRadioChannelOper (.14) — current operating channel
 *
 * There is no explicit band column in fapRadioTable, so band is derived. The
 * operating channel cleanly separates 2.4 GHz (1–14) from 5 GHz (32–177); the
 * one genuine ambiguity is 6 GHz (6E), whose channel numbers overlap the lower
 * 2.4/5 GHz ranges. We resolve 6 GHz from the radio type when it signals a
 * 6 GHz-capable PHY, and otherwise from clearly-6 GHz channel numbers (>177).
 *
 * Returned strings match what `AssetWirelessStation.band` stores:
 *   "2.4GHz" | "5GHz" | "6GHz" | null (unknown).
 *
 * NOTE: `fapRadioType` is an enumerated INTEGER whose exact value→band mapping
 * is not published in the public OID tree. We only treat *string* forms with an
 * explicit 6 GHz marker ("6e" / "6ghz") as a 6 GHz hint — never a bare number,
 * since a numeric enum value of 6 could mean anything. When the type carries no
 * usable hint, 6 GHz is still recovered from clearly-6 GHz channel numbers
 * (>177). Tune `is6GhzRadioType` once the live enum is confirmed.
 */

export type RadioBand = "2.4GHz" | "5GHz" | "6GHz";

/** Heuristic: does this fapRadioType value indicate a 6 GHz (6E) radio? */
export function is6GhzRadioType(radioType: number | string | null | undefined): boolean {
  if (radioType == null) return false;
  const s = String(radioType).toLowerCase();
  // Explicit string markers only: "6e", "11ax6e", "802.11ax-6e", "6ghz", "6 ghz".
  return /6e/.test(s) || /6\s*ghz/.test(s);
}

/**
 * Derive the band for one radio from its type + operating channel.
 * Channel is the primary discriminator; radioType only disambiguates 6 GHz.
 */
export function deriveRadioBand(
  radioType: number | string | null | undefined,
  channel: number | null | undefined,
): RadioBand | null {
  const ch = typeof channel === "number" && Number.isFinite(channel) ? channel : null;
  const sixE = is6GhzRadioType(radioType);

  if (ch == null) {
    // No channel — fall back to the type hint; only 6 GHz is inferable.
    return sixE ? "6GHz" : null;
  }
  if (ch >= 1 && ch <= 14) {
    // 2.4 GHz channel plan — unless the radio is explicitly a 6 GHz PHY,
    // whose low channels (1, 5, 9, …) collide with the 2.4 GHz numbers.
    return sixE ? "6GHz" : "2.4GHz";
  }
  if (ch >= 32 && ch <= 177) {
    // 5 GHz channel plan. A 6 GHz radio can also report channels in this
    // range, so the type hint wins when set.
    return sixE ? "6GHz" : "5GHz";
  }
  if (ch > 177) {
    // 6 GHz extended channels (181–233) have no 5 GHz counterpart.
    return "6GHz";
  }
  return null;
}
