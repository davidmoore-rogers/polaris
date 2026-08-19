/**
 * src/utils/portVlans.ts
 *
 * Decoding for per-port VLAN membership out of Q-BRIDGE-MIB (RFC 4363) —
 * the SNMP path to a switch port's native (untagged) VLAN and the set of
 * VLANs it carries tagged. The authoritative source for a *managed*
 * FortiSwitch stays the parent FortiGate's `switch-controller/managed-switch`
 * CMDB (config truth, and the only place `allowed-vlans all` is expressible);
 * this covers every switch that CMDB overlay can't reach.
 *
 * Three things make this fiddly enough to isolate and unit-test:
 *
 *   1. **Membership is a PortList bitmap, not a row per port.** Both member
 *      columns are OCTET STRINGs where the FIRST octet's MOST-SIGNIFICANT bit
 *      is dot1dBasePort 1 (RFC 4363 PortList). Decoding LSB-first, or from
 *      byte 0 bit 0, silently yields a plausible-looking wrong port set.
 *   2. **The bitmap names dot1dBasePorts, not ifIndexes** — the same join
 *      `dot1dBasePortIfIndex` the forwarding-database walk performs (see
 *      macForwarding.ts). Skipping it attributes VLANs to whatever interface
 *      happens to sit at that number.
 *   3. **`dot1qVlanStaticUntaggedPorts` cannot be trusted.** The RFC way to
 *      get a port's tagged set is egress-members minus untagged-members, but
 *      agents in the field publish the untagged column as a verbatim COPY of
 *      the egress column (observed on FortiSwitch, 2026-08: `.4.3.1.2` and
 *      `.4.3.1.4` walk to byte-identical bitmaps for every VLAN). Subtracting
 *      that leaves EVERY port with an empty tagged set — the feature silently
 *      reporting "no tagged VLANs" on a working trunk, which is worse than
 *      reporting nothing at all. `derivePortVlans` therefore trusts the
 *      untagged column only when it is a STRICT SUBSET of egress (a claim an
 *      echoing agent can never make) and otherwise falls back to the port's
 *      own PVID, which `dot1qPvid` reports directly and reliably.
 *
 * The fallback's one inaccuracy is worth stating: a port configured with
 * SEVERAL untagged VLANs (FortiSwitch `untagged-vlans` is a list) has only its
 * PVID excluded, so its other untagged VLANs read as tagged. That is rare, it
 * is only reachable on agents whose untagged column was unusable anyway, and
 * the CMDB overlay — which distinguishes them properly — wins wherever it runs.
 */

/** Highest valid 802.1Q VLAN id. 0 and 4095 are reserved. */
const MAX_VLAN_ID = 4094;

/** A valid, storable VLAN id. */
export function isVlanId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_VLAN_ID;
}

/**
 * Decode an RFC 4363 `PortList` into the dot1dBasePort numbers it names.
 *
 * Bit order is the part worth being explicit about: port N lives in octet
 * `floor((N-1)/8)` at bit `7 - ((N-1) % 8)` — i.e. octet 0's MSB is port 1.
 * A trailing all-zero octet is legal and simply names no ports.
 */
export function decodePortList(value: unknown): number[] {
  const bytes = toBytes(value);
  if (!bytes) return [];
  const out: number[] = [];
  for (let byteIdx = 0; byteIdx < bytes.length; byteIdx++) {
    const byte = bytes[byteIdx];
    if (byte === 0) continue;
    for (let bit = 0; bit < 8; bit++) {
      if ((byte & (0x80 >> bit)) !== 0) out.push(byteIdx * 8 + bit + 1);
    }
  }
  return out;
}

function toBytes(value: unknown): Uint8Array | null {
  if (value == null) return null;
  // net-snmp hands OCTET STRINGs back as Buffers; Uint8Array covers a caller
  // that already normalized. A string is treated as raw latin1 bytes, which is
  // what String()-ing a Buffer somewhere upstream would have produced.
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    if (value.length === 0) return null;
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
    return out;
  }
  return null;
}

/** One VLAN's membership, as walked off the agent. */
export interface VlanMembership {
  vlanId: number;
  /** `dot1qVlanStaticEgressPorts` (or `dot1qVlanCurrentEgressPorts`). */
  egress: readonly number[];
  /** `dot1qVlanStaticUntaggedPorts`. May be an unusable copy of `egress`. */
  untagged: readonly number[];
}

/** Per-port VLAN config, keyed by dot1dBasePort in the return of derivePortVlans. */
export interface PortVlanConfig {
  nativeVlan: number | null;
  taggedVlans: number[];
}

/**
 * Fold `dot1qPvid` + the per-VLAN member bitmaps into per-port VLAN config.
 *
 * Rules, in the order they matter:
 *   - `nativeVlan` is the port's PVID, and nothing else. It is a single value
 *     the agent states directly, so it is never inferred from membership.
 *   - a VLAN's untagged members are believed only when they are a strict
 *     subset of its egress members (see the header note on echoing agents);
 *     otherwise the PVID does that job.
 *   - a port's own native VLAN is never listed among its tagged VLANs, whether
 *     or not the untagged column was believed. By definition it is untagged
 *     there, and an agent that says both is wrong about one of them.
 *
 * Ports that appear in no bitmap and have no PVID are absent from the result
 * rather than present with empty values — the caller distinguishes "this
 * switch reports no VLAN data" from "this port is in no VLAN".
 */
export function derivePortVlans(
  pvidByBasePort: ReadonlyMap<number, number>,
  memberships: readonly VlanMembership[],
): Map<number, PortVlanConfig> {
  // A Set per port: the dot1qVlanCurrentTable fallback is indexed by
  // { timeMark, vlanId } and can legally name one VLAN more than once.
  const taggedByPort = new Map<number, Set<number>>();

  for (const m of memberships) {
    if (!isVlanId(m.vlanId)) continue;
    const egress = new Set(m.egress);
    if (egress.size === 0) continue;
    const untagged = new Set(m.untagged);
    // Strict subset — a copy of the egress bitmap fails this, which is the
    // whole point. `untagged ⊆ egress && untagged.size < egress.size`.
    let trustUntagged = untagged.size < egress.size;
    if (trustUntagged) {
      for (const p of untagged) {
        if (!egress.has(p)) { trustUntagged = false; break; }
      }
    }
    for (const port of egress) {
      if (trustUntagged && untagged.has(port)) continue;
      if (pvidByBasePort.get(port) === m.vlanId) continue;
      const set = taggedByPort.get(port);
      if (set) set.add(m.vlanId);
      else taggedByPort.set(port, new Set([m.vlanId]));
    }
  }

  const out = new Map<number, PortVlanConfig>();
  for (const [port, pvid] of pvidByBasePort.entries()) {
    out.set(port, {
      nativeVlan: isVlanId(pvid) ? pvid : null,
      taggedVlans: [...(taggedByPort.get(port) ?? [])].sort((a, b) => a - b),
    });
  }
  for (const [port, tagged] of taggedByPort.entries()) {
    if (out.has(port)) continue;
    out.set(port, { nativeVlan: null, taggedVlans: [...tagged].sort((a, b) => a - b) });
  }
  return out;
}
