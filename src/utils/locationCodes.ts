/**
 * src/utils/locationCodes.ts
 *
 * Physical-location codes embedded in FortiSwitch/FortiAP admin descriptions
 * and/or Asset notes, e.g. "a:Mine b:Shop f:2 r:North Closet jb:112-305":
 *
 *   a: area    b: building    f: floor    r: room    jb: junction box
 *
 * Hierarchy (outermost first): area > building > floor > room > junction box.
 *
 * Parsed server-side only — the topology endpoint resolves each node's
 * effective codes (notes → Asset.description → device description) and ships
 * the final strings, so the browser never needs the grammar.
 *
 * Grammar: keys are case-insensitive and match only at start-of-string or
 * after whitespace, so "hub:5" / "shelf:3" are not tokens. A value runs until
 * the next known token or end of string and is trimmed; an empty value means
 * the key is absent. Leading prose and unknown "xx:" tokens are ignored.
 * A duplicated key keeps its last occurrence.
 */

export type LocationCodes = {
  area: string | null;
  building: string | null;
  floor: string | null;
  room: string | null;
  junctionBox: string | null;
};

const EMPTY: LocationCodes = { area: null, building: null, floor: null, room: null, junctionBox: null };

const KEY_TO_FIELD: Record<string, keyof LocationCodes> = {
  a: "area",
  b: "building",
  f: "floor",
  r: "room",
  jb: "junctionBox",
};

// Longest keys first ("jb" before "b") so a multi-letter key is never
// shadowed by a single-letter prefix. Matches only at ^ or after whitespace.
const TOKEN_RE = /(?:^|\s)(jb|a|b|f|r):/gi;

/** Parse a:/b:/f:/r:/jb: codes out of a free-text description. */
export function parseLocationCodes(raw: string | null | undefined): LocationCodes {
  if (!raw || typeof raw !== "string") return { ...EMPTY };
  const out: LocationCodes = { ...EMPTY };

  TOKEN_RE.lastIndex = 0;
  type Hit = { field: keyof LocationCodes; valueStart: number; tokenStart: number };
  const hits: Hit[] = [];
  for (let m = TOKEN_RE.exec(raw); m; m = TOKEN_RE.exec(raw)) {
    const key = m[1].toLowerCase();
    hits.push({
      field: KEY_TO_FIELD[key],
      // m.index points at the leading whitespace when one was consumed.
      tokenStart: m.index,
      valueStart: m.index + m[0].length,
    });
  }

  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].tokenStart : raw.length;
    const value = raw.slice(hits[i].valueStart, end).trim();
    if (value) out[hits[i].field] = value; // duplicate key: last non-empty wins
  }
  return out;
}

/**
 * Resolve a node's effective codes from its three sources, merging PER KEY
 * with precedence notes → Asset.description → device description — so an
 * operator can add just "jb:112-305" in notes without re-typing the
 * device-side b:/f:/r: codes.
 */
export function resolveEffectiveLocation(sources: {
  notes?: string | null;
  description?: string | null;
  deviceDescription?: string | null;
}): LocationCodes {
  const layers = [
    parseLocationCodes(sources.deviceDescription),
    parseLocationCodes(sources.description),
    parseLocationCodes(sources.notes),
  ];
  const out: LocationCodes = { ...EMPTY };
  for (const layer of layers) {
    for (const field of Object.values(KEY_TO_FIELD)) {
      if (layer[field] !== null) out[field] = layer[field];
    }
  }
  return out;
}

/** True when the resolved codes carry at least one value. */
export function hasLocationCodes(codes: LocationCodes): boolean {
  return codes.area !== null || codes.building !== null || codes.floor !== null ||
    codes.room !== null || codes.junctionBox !== null;
}

/**
 * Canonical grouping key for a code value: trim, collapse internal
 * whitespace, lowercase. Display surfaces keep the original trimmed casing;
 * only group membership compares via this key.
 */
export function locationGroupKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// Discovery-created switch/AP assets stamp notes with this boilerplate
// (integrations.ts); the notes sync treats it as overwritable.
const AUTO_DISCOVERED_NOTES_RE = /^Auto-discovered from FortiGate /;

/**
 * Gate for the discovery-time device-description → Asset.notes sync.
 * Sync (overwrite notes) only when the device carries a description AND the
 * current notes are not operator-authored: empty, exactly what a previous
 * cycle synced (`lastSyncedDescription` = fortinetTopology.notesSyncedFrom),
 * or the auto-discovery boilerplate. Notes that already match the device
 * value need no write. Operator-edited notes always win — and a device that
 * CLEARS its description never clears notes.
 */
export function shouldSyncDescriptionToNotes(args: {
  deviceDescription: string | null | undefined;
  currentNotes: string | null | undefined;
  lastSyncedDescription: string | null | undefined;
}): boolean {
  const device = typeof args.deviceDescription === "string" ? args.deviceDescription.trim() : "";
  if (!device) return false;
  const notes = typeof args.currentNotes === "string" ? args.currentNotes : "";
  if (notes === device) return false;
  if (!notes.trim()) return true;
  if (typeof args.lastSyncedDescription === "string" && notes === args.lastSyncedDescription) return true;
  return AUTO_DISCOVERED_NOTES_RE.test(notes);
}
