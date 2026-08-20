/**
 * src/utils/fortiswitchTrunkMap.ts
 *
 * Decoding for the FortiSwitch trunk→physical-port map published as a single
 * OctetString at `1.3.6.1.4.1.12356.106.3.1.1.0`.
 *
 * Observed on FortiSwitchOS 7.6.6 (FS-124E-FPOE):
 *
 *   8EF5920000001-0: port23 ::8EPTQ21000003-0: port27 ::GT61FTK21000002: port24 ::
 *
 * Each entry is `<trunk name>: <local physical port>`, separated by `::`. This
 * is the switch stating its own adjacencies — the trunk names are built from
 * the SERIAL NUMBER of the device at the far end, so it names peers directly
 * instead of leaving them to be inferred.
 *
 * ── Why the names look mangled ───────────────────────────────────────────────
 *
 * The trunk name is the peer's serial, suffixed `-0` for a switch, then
 * **left-truncated to 15 characters**. That single rule explains what looks
 * like two different conventions:
 *
 *   S108EF5920000001 + "-0" = 18 chars → rightmost 15 → 8EF5920000001-0
 *   FGT61FTK21000002        = 16 chars → rightmost 15 → GT61FTK21000002
 *
 * A switch appears to lose three leading characters and a FortiGate only one,
 * purely because the `-0` consumes two of the fifteen.
 *
 * ── Consequence for matching ────────────────────────────────────────────────
 *
 * Do NOT try to reconstruct the serial: that would hard-code the 15-char cap
 * and break the day a firmware release changes it. Match by SUFFIX instead —
 * strip any trailing `-<n>`, then find the asset whose serial ENDS WITH what
 * remains. That is correct under any cap, and it degrades safely: a tail short
 * enough to match two devices resolves to nothing rather than to a guess.
 */

/** One `<trunk>: <port>` pair, exactly as the device reported it. */
export interface TrunkPortEntry {
  /** Trunk name as published, e.g. "8EF5920000001-0". */
  trunkName: string;
  /** Local physical port the trunk uses, e.g. "port23". */
  localPort: string;
  /**
   * `trunkName` with any trailing `-<n>` removed — the fragment to suffix-match
   * against an asset serial. For "8EF5920000001-0" this is "8EF5920000001".
   */
  peerSerialTail: string;
}

/** Trailing member/index suffix. Only `-0` has been observed in the field;
 *  the pattern is general so a future `-1` cannot silently break matching. */
const TRUNK_SUFFIX = /-\d+$/;

/**
 * Parse the raw OctetString into entries.
 *
 * Tolerant by construction: entries are `::`-separated with inconsistent
 * spacing and a trailing separator, and a malformed chunk is skipped rather
 * than failing the whole scrape — this is an undocumented vendor string, so
 * the format is treated as something to survive, not something to trust.
 */
export function parseTrunkPortMap(raw: string | null | undefined): TrunkPortEntry[] {
  const text = (raw ?? "").trim();
  if (!text) return [];

  const out: TrunkPortEntry[] = [];
  const seen = new Set<string>();
  for (const chunk of text.split("::")) {
    const part = chunk.trim();
    if (!part) continue;
    const colon = part.indexOf(":");
    if (colon <= 0) continue;

    const trunkName = part.slice(0, colon).trim();
    const localPort = part.slice(colon + 1).trim();
    if (!trunkName || !localPort) continue;
    // A port name with whitespace in it would mean the separator assumption is
    // wrong; skip rather than store something nonsensical.
    if (/\s/.test(localPort)) continue;

    const key = `${trunkName}|${localPort}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      trunkName,
      localPort,
      peerSerialTail: trunkName.replace(TRUNK_SUFFIX, ""),
    });
  }
  return out;
}

/**
 * Resolve a trunk's peer-serial tail to an asset id by suffix match.
 *
 * Returns null when nothing matches, and — deliberately — also when MORE than
 * one serial ends with the tail. An ambiguous match would attach a trunk to the
 * wrong device, which is worse than leaving it unresolved: the port would be
 * drawn against the wrong neighbour on the map and, if it ever gated alerting,
 * would suppress the wrong port.
 */
export function matchTrunkPeer(
  peerSerialTail: string,
  serialToAssetId: ReadonlyMap<string, string>,
): string | null {
  const tail = peerSerialTail.trim().toUpperCase();
  if (!tail) return null;

  let hit: string | null = null;
  for (const [serial, assetId] of serialToAssetId.entries()) {
    if (!serial.toUpperCase().endsWith(tail)) continue;
    if (hit && hit !== assetId) return null; // ambiguous — refuse to guess
    hit = assetId;
  }
  return hit;
}
