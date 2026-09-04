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
