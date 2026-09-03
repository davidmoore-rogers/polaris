/**
 * src/utils/snmpDescrIdentity.ts
 *
 * Read a vendor's OWN documented sysDescr format.
 *
 * `utils/snmpIdentity.ts` deliberately refused to derive a model from
 * sysDescr, and the reason it gave is still right: that object is free text,
 * so a cross-vendor regex ("the token after the vendor word is the model") is
 * the kind of inference that is correct often enough to look correct and
 * silently wrong the rest of the time.
 *
 * This file is the narrow version of that job, and the difference is where the
 * knowledge comes from. Some vendors publish a FIXED, delimited sysDescr whose
 * fields are positional by specification — an AXIS camera answers
 *
 *   `; AXIS M2036-LE; Bullet Camera; 10.12.114; Oct 03 2022 14:20; 7EC.1; 1`
 *
 * which is model, product type, firmware, build date and hardware id in that
 * order, on every AXIS device. Reading that is not a guess; it is parsing a
 * format. So the rule mirrors the enterprise table next door: **a vendor is in
 * here only when its layout is known, and a string that does not match the
 * layout yields nothing rather than a partial guess.**
 *
 * Three consequences worth stating:
 *
 *  - **Every parser ANCHORS on the vendor token, it does not count from the
 *    left.** AXIS puts an operator-settable free-text name in field 1 — empty
 *    on a factory-fresh camera, the device's name once someone sets it — so
 *    "field 3 is the firmware" is wrong on exactly the devices an operator has
 *    already touched. Anchoring on `AXIS <model>` and walking right is stable
 *    across both.
 *  - **A field is claimed only when it is SHAPED like what it should be.** The
 *    firmware slot has to look like a version, or `osVersion` stays empty. A
 *    vendor that reorders its own format across a firmware generation then
 *    yields less detail, never wrong detail.
 *  - **Only fields Polaris can store are parsed.** The build date and the
 *    hardware id (`7EC.1`) are real and identify a board revision, but there
 *    is no Asset column for either and `AssetPhysicalEntity` is ENTITY-MIB's,
 *    populated by a different walk. Parsing them here would produce a value
 *    whose only consumer is this comment.
 */

import { normalizeManufacturer } from "./manufacturerNormalize.js";

/** What a vendor's own sysDescr format can tell us, beyond the raw text. */
export interface SysDescrDetail {
  /** The vendor, spelled the way this file's parser owns it. */
  manufacturer?: string;
  /** Model as the device states it, vendor token stripped ("M2036-LE"). */
  model?: string;
  /** Firmware version — Asset.osVersion is "OS or firmware version". */
  osVersion?: string;
  /**
   * The vendor's own words for what the device IS ("Bullet Camera"). Not an
   * Asset column: it rides the scan hit so the Results step can name the
   * device in one short line instead of printing the whole sysDescr, and so
   * the asset-type match rules see it as a fact of its own.
   */
  productType?: string;
}

/** Longest model / product-type string kept. Bounds a malformed descr. */
const MAX_FIELD = 64;

/** A version-shaped firmware string: 10.12.114, 5.55.4.1, 11.11. */
const VERSION_RE = /^\d+(?:\.\d+){1,4}$/;

/** Collapse whitespace, bound length, and drop an empty result. */
function field(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

/**
 * AXIS Communications — cameras, encoders, door controllers, speakers.
 *
 * `[<device name>]; AXIS <model>; <product type>; <firmware>; <build date>;
 *  <hardware id>; <n>`
 *
 * Anchored on the `AXIS <model>` field because field 1 is the operator's own
 * device name and is empty until someone sets it.
 */
function parseAxis(fields: string[]): SysDescrDetail | undefined {
  const at = fields.findIndex((f) => /^AXIS\s+\S/i.test(f.trim()));
  if (at < 0) return undefined;

  const model = field(fields[at].trim().replace(/^AXIS\s+/i, ""));
  if (!model) return undefined;

  const out: SysDescrDetail = { manufacturer: "Axis Communications", model };

  // The product type sits immediately right of the model. Guard against a
  // version landing here (a firmware generation that drops the type field)
  // rather than storing "10.12.114" as what the device is.
  const type = field(fields[at + 1]);
  if (type && !VERSION_RE.test(type)) out.productType = type;

  // Firmware: the field after the type when there was one, else the next
  // field — so a descr with no product type still yields a version.
  for (const candidate of [fields[at + 2], fields[at + 1]]) {
    const v = field(candidate);
    if (v && VERSION_RE.test(v)) { out.osVersion = v; break; }
  }

  return out;
}

/**
 * The vendors whose sysDescr layout is known.
 *
 * One entry, because AXIS is the format in hand and confirmed against real
 * hardware. That is the whole admission criterion — adding a vendor is adding
 * an entry once its layout is documented, and a vendor whose format is merely
 * *probably* like this one does not belong in the table. The `test` is a cheap
 * pre-filter; the parser still has to find its own anchor.
 */
const VENDOR_DESCR_PARSERS: readonly {
  vendor: string;
  test: RegExp;
  parse: (fields: string[]) => SysDescrDetail | undefined;
}[] = [
  { vendor: "Axis Communications", test: /(^|;)\s*AXIS\s+\S/i, parse: parseAxis },
];

/**
 * Parse a sysDescr through its vendor's own format, when we know it.
 *
 * Pure, never throws, and `undefined` for everything else — which is most
 * devices, and is the point: a caller that gets nothing back is left with
 * exactly the identity it had before this file existed.
 */
export function parseVendorSysDescr(sysDescr: string | undefined): SysDescrDetail | undefined {
  if (!sysDescr) return undefined;
  const raw = String(sysDescr);
  if (!raw.includes(";")) return undefined; // Every known format is delimited.

  const fields = raw.split(";");
  for (const entry of VENDOR_DESCR_PARSERS) {
    if (!entry.test.test(raw)) continue;
    const detail = entry.parse(fields);
    // A vendor that matched the pre-filter but not its own layout yields
    // nothing — deliberately not `{ manufacturer }` alone, which would claim
    // the vendor off a string we just failed to read.
    if (detail && (detail.model || detail.osVersion)) return detail;
  }
  return undefined;
}

// ─── Adopting what the format said onto a stored asset ──────────────────────

/** The stored fields an adoption decision compares against. */
export interface StoredDescrIdentity {
  manufacturer: string | null;
  model: string | null;
  osVersion: string | null;
  /** The device's own self-description, i.e. the last sysDescr we stored. */
  os: string | null;
}

/** Fields to write. Only ever the ones that should actually move. */
export interface DescrPatch {
  manufacturer?: string;
  model?: string;
  osVersion?: string;
  os?: string;
}

/**
 * Decide what a fresh reading should change on a stored asset.
 *
 * A Discovery reads sysDescr once, at adoption, so a camera upgraded a year
 * later still showed the firmware it shipped with. The monitor pass re-reads
 * it, which makes this the question: of the fields the format states, which
 * may a later reading overwrite?
 *
 * One answer for all four: **what the device states about itself wins.** The
 * device is the authority on its own identity — the posture business rule 12
 * takes for presence and rule 28 takes for the Windows build — and a reading
 * parsed out of the vendor's own documented format is the device stating it,
 * not Polaris guessing. So a value that disagrees is corrected on the next
 * pass, whichever field it is.
 *
 * Model and manufacturer were fill-only when this shipped, on the reasoning
 * that hardware does not change while the address stays put, so a
 * disagreement had to be either operator-typed or a swap — indistinguishable
 * from here. Refreshing them was chosen instead, deliberately, because both
 * of those cases are better served by it:
 *
 *  - **A swapped device self-heals.** A camera replaced behind the same
 *    address reports its real model within one system-info pass instead of
 *    carrying its predecessor's forever.
 *  - **A bad stored value self-heals too.** Every AXIS camera adopted before
 *    the enterprise arc 368 fix carries the manufacturer "ServerTech"; with
 *    manufacturer refreshed, those rows correct themselves on the next pass
 *    rather than needing a migration or a hand edit.
 *
 * The cost, stated plainly: there is no operator-pin column for these two
 * (unlike `Asset.hostnameOverride` / `ipOverride`), so a hand-typed model on a
 * device whose format Polaris can read is overwritten on the next pass. An
 * operator who needs a different model on such a device has to clear the
 * vendor's entry from the parser table, not edit the row.
 *
 * `os` follows the firmware for its own reason: it holds the whole sysDescr,
 * in which the firmware is one token, so leaving it behind while `osVersion`
 * moves would publish two different answers about one device on one page.
 *
 * Returns `null` when nothing should move — which is the steady state on every
 * pass after the first, and is what keeps this free at fleet scale: an
 * unchanged camera costs a comparison, not a write.
 */
export function decideDescrAdoption(
  stored: StoredDescrIdentity,
  detail: SysDescrDetail | undefined,
  descrText?: string | null,
): DescrPatch | null {
  // No readable layout ⇒ no opinion. Most devices land here, and they must be
  // left exactly as they were.
  if (!detail) return null;

  const patch: DescrPatch = {};
  const held = (v: string | null | undefined): string => (v ?? "").trim();

  // Manufacturer is compared and written in its CANONICAL form, because the
  // `db.ts` extension runs every staged value through `normalizeManufacturer`
  // on the way to the column. Comparing the raw parse against an
  // alias-canonicalized stored value ("Axis Communications" vs an install's
  // "Axis") would differ forever: a write every pass, an audit row every pass,
  // and the row never converging. Normalizing both sides is what makes
  // refreshing this field idempotent.
  const vendor = detail.manufacturer ? normalizeManufacturer(detail.manufacturer) : null;
  if (vendor && vendor !== held(stored.manufacturer)) patch.manufacturer = vendor;
  if (detail.model && detail.model !== held(stored.model)) patch.model = detail.model;
  if (detail.osVersion && detail.osVersion !== held(stored.osVersion)) patch.osVersion = detail.osVersion;

  const descr = (descrText ?? "").trim();
  if (descr && descr !== held(stored.os)) patch.os = descr;

  return Object.keys(patch).length ? patch : null;
}
