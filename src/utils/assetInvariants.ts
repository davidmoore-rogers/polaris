/**
 * src/utils/assetInvariants.ts — Shared write-time invariants for Asset records.
 */

type DateLike = Date | string | null | undefined;

/**
 * An asset's acquiredAt must never be after its lastSeen — you can't be
 * seen before you were acquired. When a write would violate that (either
 * from a manual edit or from a discovery update clobbering one field
 * while leaving the other), clamp acquiredAt down to match lastSeen.
 *
 * Mutates the passed `data` object. `existing` supplies the pre-update
 * values for fields the write isn't touching; omit for creates.
 */
export function clampAcquiredToLastSeen(
  data: Record<string, unknown>,
  existing?: { acquiredAt?: DateLike; lastSeen?: DateLike } | null,
): void {
  const acqRaw = "acquiredAt" in data ? (data.acquiredAt as DateLike) : existing?.acquiredAt ?? null;
  const seenRaw = "lastSeen" in data ? (data.lastSeen as DateLike) : existing?.lastSeen ?? null;
  if (!acqRaw || !seenRaw) return;
  const acq = acqRaw instanceof Date ? acqRaw : new Date(acqRaw);
  const seen = seenRaw instanceof Date ? seenRaw : new Date(seenRaw);
  if (Number.isNaN(acq.getTime()) || Number.isNaN(seen.getTime())) return;
  if (seen < acq) data.acquiredAt = seen;
}

/**
 * Evidence-source labels for Asset.lastSeenSource. Open set — the UI renders
 * the string verbatim — but every writer should use one of these so operators
 * see a consistent vocabulary.
 */
export type LastSeenSource =
  | "dhcp-lease"        // live DHCP lease / reservation confirmed actively held
  | "device-inventory"  // FortiGate per-client device inventory (device-reported timestamp)
  | "discovery"         // infra device answered / reported connected during discovery
  | "agent"             // Polaris Agent heartbeat
  | "probe"             // successful monitor probe
  | "ping"              // AD/Entra presence-verification ICMP fallback
  | "conflict-accept"   // operator accepted a discovery conflict carrying lastSeen
  | "conflict-reject";  // separate asset created from a rejected conflict's proposed values

/**
 * Single write path for Asset.lastSeen: advance it to `evidenceAt` (stamping
 * `lastSeenSource` alongside) only when the evidence is newer than what the
 * row already holds. lastSeen never moves backward — a stale evidence source
 * (e.g. a FortiGate that remembers a device from weeks ago) can't regress a
 * fresher sighting from another source.
 *
 * Mutates `data` (the pending update payload). `existing` supplies the
 * current row value; pass null/omit for creates. Returns true when the bump
 * was applied.
 */
export function bumpLastSeen(
  data: Record<string, unknown>,
  existing: { lastSeen?: DateLike } | null | undefined,
  evidenceAt: Date | string,
  source: LastSeenSource | string,
): boolean {
  const ev = evidenceAt instanceof Date ? evidenceAt : new Date(evidenceAt);
  if (Number.isNaN(ev.getTime())) return false;
  // The freshest value already staged on this payload wins over the row.
  const stagedRaw = "lastSeen" in data ? (data.lastSeen as DateLike) : null;
  const currentRaw = stagedRaw ?? existing?.lastSeen ?? null;
  if (currentRaw) {
    const current = currentRaw instanceof Date ? currentRaw : new Date(currentRaw);
    if (!Number.isNaN(current.getTime()) && current >= ev) return false;
  }
  data.lastSeen = ev;
  data.lastSeenSource = source;
  return true;
}
