/**
 * tests/unit/chassisIdentity.test.ts
 *
 * Is this still the same FortiGate? (business rule 41)
 *
 * A discovered subnet stores the SERIAL of the chassis that serves it, because
 * the name it used to store cannot tell a rename from a replacement — and those
 * two need opposite handling. A rename must re-point silently; a replacement
 * must raise a conflict, because the new box knows nothing about the
 * reservations Polaris holds and every pushed row's device-side pointers are
 * now aimed at a chassis that no longer exists.
 *
 * The three things this file exists to pin down:
 *
 *   1. TRI-STATE. Absent-stored means UNKNOWN and must LEARN, not accuse; an
 *      unreadable DISCOVERED serial must apply no constraint at all. One failed
 *      CMDB read would otherwise declare every subnet on the fleet replaced.
 *   2. HA. A cluster's top-level serial flips to whichever member is active, so
 *      comparing against a single value reports a replacement on every
 *      failover. The comparison is membership in the reporting device's own
 *      chassis set, and that set is PER DEVICE — a chassis re-registered under
 *      a different device entry is genuinely a replacement for this subnet.
 *   3. WHICH VERDICTS WRITE. `replaced` must NOT re-point the stored serial:
 *      the pending conflict is the unresolved state, and the stored serial is
 *      what keeps the detection derivable from the subnet row itself rather
 *      than dependent on the conflict row surviving.
 */

import { describe, it, expect } from "vitest";
import {
  classifyChassis,
  classifyDeprecatedSupersede,
  normalizeSerial,
  normalizeSerialSet,
  verdictWritesSerial,
} from "../../src/utils/chassisIdentity.js";

// Synthetic serials — never paste real fleet serials into tests.
const OLD = "FGT60FTK00000001";
const NEW = "FGT81FTK00000002";
const PEER = "FGT60FTK00000009";

describe("normalizeSerial", () => {
  it("upper-cases and trims", () => {
    expect(normalizeSerial("  fgt60ftk00000001 ")).toBe(OLD);
  });

  it("treats blank and non-strings as absent", () => {
    expect(normalizeSerial("")).toBeNull();
    expect(normalizeSerial("   ")).toBeNull();
    expect(normalizeSerial(null)).toBeNull();
    expect(normalizeSerial(undefined)).toBeNull();
    expect(normalizeSerial(42 as unknown as string)).toBeNull();
  });
});

describe("normalizeSerialSet", () => {
  it("drops blanks and folds case", () => {
    const s = normalizeSerialSet(["fgt60ftk00000001", "", null, undefined, "  " + NEW + "  "]);
    expect(Array.from(s).sort()).toEqual([OLD, NEW].sort());
  });

  it("is empty for null/undefined input", () => {
    expect(normalizeSerialSet(null).size).toBe(0);
    expect(normalizeSerialSet(undefined).size).toBe(0);
  });
});

describe("classifyChassis — tri-state", () => {
  it("an unreadable discovered serial is UNKNOWN, never replaced", () => {
    // The load-bearing case. A gate whose CMDB read failed this run must not
    // look like a swap, whatever is stored.
    for (const discovered of ["", "   ", null, undefined]) {
      const v = classifyChassis(OLD, discovered);
      expect(v.kind).toBe("unknown");
    }
  });

  it("an absent stored serial LEARNS — a first sighting is not a replacement", () => {
    // Every row predating the column arrives here, which is why no migration
    // backfills the field: they converge on their own.
    const v = classifyChassis(null, NEW);
    expect(v).toEqual({ kind: "learn", serial: NEW });
  });

  it("a blank stored serial learns too", () => {
    expect(classifyChassis("   ", NEW).kind).toBe("learn");
  });

  it("the same chassis is SAME, case- and whitespace-insensitively", () => {
    const v = classifyChassis(OLD, "  fgt60ftk00000001 ");
    expect(v).toEqual({ kind: "same", serial: OLD, viaCluster: false });
  });

  it("a genuinely different chassis is REPLACED", () => {
    const v = classifyChassis(OLD, NEW);
    expect(v).toEqual({ kind: "replaced", from: OLD, to: NEW });
  });
});

describe("classifyChassis — HA clusters", () => {
  it("a failover to another cluster member is SAME, not a replacement", () => {
    // FMG's device record flips its top-level `sn` to the active member, so
    // without the set test every failover would raise a conflict per subnet.
    const v = classifyChassis(OLD, PEER, [OLD, PEER]);
    expect(v).toEqual({ kind: "same", serial: PEER, viaCluster: true });
  });

  it("reports viaCluster so the caller can tell a failover from a no-op", () => {
    expect(classifyChassis(OLD, OLD, [OLD, PEER])).toMatchObject({ viaCluster: false });
    expect(classifyChassis(OLD, PEER, [OLD, PEER])).toMatchObject({ viaCluster: true });
  });

  it("a chassis outside the reporting device's set is still REPLACED", () => {
    // The set is per device on purpose: an old chassis re-registered under a
    // different FMG device entry (repurposed to another site) is a replacement
    // for THIS subnet, and a fleet-wide set would call it unchanged.
    const v = classifyChassis(OLD, NEW, [NEW, "FGT81FTK00000003"]);
    expect(v).toEqual({ kind: "replaced", from: OLD, to: NEW });
  });

  it("an empty or missing cluster set falls back to the plain comparison", () => {
    expect(classifyChassis(OLD, NEW, []).kind).toBe("replaced");
    expect(classifyChassis(OLD, NEW, undefined).kind).toBe("replaced");
    expect(classifyChassis(OLD, OLD, []).kind).toBe("same");
  });

  it("blank entries in the cluster set cannot match a stored serial", () => {
    // Guards against a roster row with an empty `sn` making everything match.
    expect(classifyChassis(OLD, NEW, ["", null, undefined]).kind).toBe("replaced");
  });
});

describe("classifyDeprecatedSupersede", () => {
  // The half that had been left to an operator's API call. A subnet deprecated
  // before the chassis column existed still holds the unique index while being
  // invisible to discovery's lookup, so a replacement gate's identical CIDR was
  // skipped on every run. The question here is only ever "is a DIFFERENT gate
  // serving this space now?".

  it("supersedes on a different chassis serial", () => {
    expect(
      classifyDeprecatedSupersede({
        storedSerial: OLD, storedDeviceName: "gate-a",
        discoveredSerial: NEW, discoveredDeviceName: "gate-a",
      }),
    ).toEqual({ kind: "supersede", via: "serial" });
  });

  it("keeps when the same chassis still serves it", () => {
    // An operator deprecated a range its own gate still hands out. Archiving
    // would silently reactivate what they retired.
    expect(
      classifyDeprecatedSupersede({
        storedSerial: OLD, storedDeviceName: "gate-a",
        discoveredSerial: OLD, discoveredDeviceName: "gate-a",
      }),
    ).toEqual({ kind: "keep", reason: "same-chassis" });
  });

  it("keeps across an HA failover", () => {
    expect(
      classifyDeprecatedSupersede({
        storedSerial: OLD, discoveredSerial: PEER, clusterSerials: [OLD, PEER],
      }),
    ).toMatchObject({ kind: "keep", reason: "same-chassis" });
  });

  it("falls back to the device NAME for a row predating the serial column", () => {
    // The case that actually bit: rows deprecated long before rule 41 carry no
    // serial at all, so a name change is the only evidence available.
    expect(
      classifyDeprecatedSupersede({
        storedSerial: null, storedDeviceName: "old-gate",
        discoveredSerial: NEW, discoveredDeviceName: "new-gate",
      }),
    ).toEqual({ kind: "supersede", via: "device-name" });
  });

  it("keeps a same-named gate with no stored serial — genuinely ambiguous", () => {
    // Could be a same-name RMA swap or an operator's deliberate deprecation,
    // and nothing here can tell them apart. A wrongly-kept row is a skipped
    // subnet somebody can archive by hand; a wrongly-archived one silently
    // reactivates a retired range.
    expect(
      classifyDeprecatedSupersede({
        storedSerial: null, storedDeviceName: "gate-a",
        discoveredSerial: NEW, discoveredDeviceName: "gate-a",
      }),
    ).toEqual({ kind: "keep", reason: "same-device-name" });
  });

  it("is case- and whitespace-insensitive about device names", () => {
    expect(
      classifyDeprecatedSupersede({
        storedDeviceName: "  GATE-A ", discoveredDeviceName: "gate-a",
      }),
    ).toMatchObject({ kind: "keep", reason: "same-device-name" });
  });

  it("keeps when either side has no name to compare", () => {
    for (const pair of [
      { storedDeviceName: null, discoveredDeviceName: "gate-b" },
      { storedDeviceName: "gate-a", discoveredDeviceName: "" },
      { storedDeviceName: null, discoveredDeviceName: null },
    ]) {
      expect(classifyDeprecatedSupersede(pair)).toEqual({
        kind: "keep",
        reason: "indistinguishable",
      });
    }
  });

  it("an unreadable serial this run does not block the name fallback", () => {
    // `unknown` means "no serial evidence", not "same gate" — the name still
    // gets its say, which is what unblocks a fleet whose CMDB read failed.
    expect(
      classifyDeprecatedSupersede({
        storedSerial: OLD, storedDeviceName: "old-gate",
        discoveredSerial: null, discoveredDeviceName: "new-gate",
      }),
    ).toEqual({ kind: "supersede", via: "device-name" });
  });
});

describe("verdictWritesSerial", () => {
  it("learn adopts the discovered serial", () => {
    expect(verdictWritesSerial({ kind: "learn", serial: NEW })).toBe(NEW);
  });

  it("same re-stamps, so the stored value tracks the active cluster member", () => {
    // Otherwise a cluster that fails over twice would keep comparing against an
    // ever-staler member.
    expect(verdictWritesSerial({ kind: "same", serial: PEER, viaCluster: true })).toBe(PEER);
  });

  it("unknown writes nothing — an unreadable run must not erase a known identity", () => {
    expect(verdictWritesSerial({ kind: "unknown", reason: "no-discovered-serial" })).toBeNull();
  });

  it("replaced writes nothing — the conflict carries the transition", () => {
    expect(verdictWritesSerial({ kind: "replaced", from: OLD, to: NEW })).toBeNull();
  });
});
