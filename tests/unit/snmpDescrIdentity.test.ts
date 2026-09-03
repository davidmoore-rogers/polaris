/**
 * tests/unit/snmpDescrIdentity.test.ts — `parseVendorSysDescr`
 * (src/utils/snmpDescrIdentity.ts).
 *
 * The system group has no model object, so `snmpIdentity` refused to invent
 * one from sysDescr. This file is the exception it allows: a vendor that
 * publishes a FIXED delimited layout can be parsed rather than guessed at.
 *
 * What's pinned, and why each is a decision rather than an implementation
 * detail:
 *
 *  - **The parser anchors on the vendor token, it does not count fields from
 *    the left.** AXIS field 1 is an operator-settable device name — empty out
 *    of the box, populated the moment someone names the camera — so a
 *    positional read is wrong on exactly the devices that have been touched.
 *  - **A field is claimed only when it is shaped like what it should be.** The
 *    firmware slot must look like a version. A vendor reordering its own
 *    format across a generation yields LESS detail, never wrong detail.
 *  - **A pre-filter match with an unreadable layout yields nothing** — not the
 *    manufacturer alone, which would claim the vendor off a string we just
 *    failed to parse.
 *  - **Unknown vendors yield undefined.** Most devices are unknown vendors,
 *    and the caller must be left with exactly the identity it already had.
 */

import { describe, it, expect } from "vitest";
import {
  parseVendorSysDescr,
  decideDescrAdoption,
  type StoredDescrIdentity,
} from "../../src/utils/snmpDescrIdentity.js";

/**
 * The real reading off a prod camera, verbatim — leading empty name field and
 * all. Every AXIS expectation below is anchored to this string rather than to
 * a tidied-up version of it.
 */
const AXIS_M2036 =
  "; AXIS M2036-LE; Bullet Camera; 10.12.114; Oct 03 2022 14:20; 7EC.1; 1";

describe("parseVendorSysDescr — AXIS", () => {
  it("reads manufacturer, model, product type and firmware off a real camera", () => {
    expect(parseVendorSysDescr(AXIS_M2036)).toEqual({
      manufacturer: "Axis Communications",
      model: "M2036-LE",
      productType: "Bullet Camera",
      osVersion: "10.12.114",
    });
  });

  it("reads the same fields once the camera has been given a name", () => {
    // The name lands in field 1, shifting every other field right. This is the
    // case a left-counting parser gets wrong.
    const named = parseVendorSysDescr(
      "front-door-cam; AXIS M2036-LE; Bullet Camera; 10.12.114; Oct 03 2022 14:20; 7EC.1; 1",
    );
    expect(named?.model).toBe("M2036-LE");
    expect(named?.osVersion).toBe("10.12.114");
    expect(named?.productType).toBe("Bullet Camera");
  });

  it("reads an older four-part firmware and a dome model", () => {
    const dome = parseVendorSysDescr(
      "AXIS P3364-LVE; Network Fixed Dome Camera; 5.55.4.1; Nov 27 2014 11:00; 18C; 0;",
    );
    expect(dome?.model).toBe("P3364-LVE");
    expect(dome?.osVersion).toBe("5.55.4.1");
    expect(dome?.productType).toBe("Network Fixed Dome Camera");
  });

  it("takes the firmware from the next field when the type field is absent", () => {
    const terse = parseVendorSysDescr("; AXIS M2036-LE; 10.12.114; Oct 03 2022 14:20");
    expect(terse?.model).toBe("M2036-LE");
    expect(terse?.osVersion).toBe("10.12.114");
    // And does not store the version as what the device is.
    expect(terse?.productType).toBeUndefined();
  });

  it("still names the model when nothing after it is readable", () => {
    const partial = parseVendorSysDescr("; AXIS M2036-LE; ; ;");
    expect(partial?.model).toBe("M2036-LE");
    expect(partial?.osVersion).toBeUndefined();
  });

  it("does not claim a firmware from a slot that is not version-shaped", () => {
    const odd = parseVendorSysDescr("; AXIS M2036-LE; Bullet Camera; RELEASE_BUILD_7; x; y");
    expect(odd?.model).toBe("M2036-LE");
    expect(odd?.osVersion).toBeUndefined();
    expect(odd?.productType).toBe("Bullet Camera");
  });

  it("is case-insensitive about the vendor token", () => {
    expect(parseVendorSysDescr("; Axis M2036-LE; Bullet Camera; 10.12.114")?.model)
      .toBe("M2036-LE");
  });

  it("yields nothing when the vendor word appears with no model after it", () => {
    // The pre-filter must not be enough on its own to claim the vendor.
    expect(parseVendorSysDescr("Some device; AXIS; ; ;")).toBeUndefined();
  });

  it("yields nothing for prose that merely mentions the vendor", () => {
    expect(
      parseVendorSysDescr("Linux nvr 5.4.0; recording from AXIS cameras; 1.0"),
    ).toBeUndefined();
  });

  it("bounds a malformed model rather than storing a paragraph", () => {
    const long = parseVendorSysDescr("; AXIS " + "M".repeat(500) + "; Bullet Camera; 10.1");
    expect(long?.model?.length).toBe(64);
  });
});

describe("parseVendorSysDescr — everything else", () => {
  it("returns undefined for vendors whose layout is not in the table", () => {
    for (const descr of [
      "Cisco IOS Software, C2960 Software, Version 15.0(2)SE11",
      "FortiSwitch-148F v7.2.5,build0123,220401",
      "Hardware: Intel64 Family 6 - Software: Windows Version 6.3",
      "APC Web/SNMP Management Card (MB:v4.1.0 PF:v6.4.6)",
    ]) {
      expect(parseVendorSysDescr(descr), descr).toBeUndefined();
    }
  });

  it("returns undefined for undelimited, empty and missing input", () => {
    expect(parseVendorSysDescr("AXIS M2036-LE Bullet Camera 10.12.114")).toBeUndefined();
    expect(parseVendorSysDescr("")).toBeUndefined();
    expect(parseVendorSysDescr(undefined)).toBeUndefined();
  });

  it("never throws on hostile input", () => {
    for (const descr of [";;;;;;;;", ";".repeat(5000), "\u0000; AXIS ;", "; AXIS \n\n ;"]) {
      expect(() => parseVendorSysDescr(descr)).not.toThrow();
    }
  });
});

describe("decideDescrAdoption", () => {
  const AXIS = {
    manufacturer: "Axis Communications",
    model: "M2036-LE",
    productType: "Bullet Camera",
    osVersion: "10.12.114",
  };
  const DESCR = "; AXIS M2036-LE; Bullet Camera; 10.12.114; Oct 03 2022 14:20; 7EC.1; 1";
  const empty: StoredDescrIdentity = { manufacturer: null, model: null, osVersion: null, os: null };
  const adopted: StoredDescrIdentity = {
    manufacturer: "Axis Communications", model: "M2036-LE", osVersion: "10.12.114", os: DESCR,
  };

  it("fills every empty field on the first reading", () => {
    expect(decideDescrAdoption(empty, AXIS, DESCR)).toEqual({
      manufacturer: "Axis Communications",
      model: "M2036-LE",
      osVersion: "10.12.114",
      os: DESCR,
    });
  });

  it("writes NOTHING once the asset already agrees", () => {
    // The fleet-scale property: every pass after the first costs a comparison,
    // not a write. A null here is what keeps this free at 2000 assets.
    expect(decideDescrAdoption(adopted, AXIS, DESCR)).toBeNull();
  });

  it("refreshes the firmware after an upgrade, and drags os along with it", () => {
    const upgraded = "; AXIS M2036-LE; Bullet Camera; 11.11.61; Mar 14 2026 09:02; 7EC.1; 1";
    const patch = decideDescrAdoption(adopted, { ...AXIS, osVersion: "11.11.61" }, upgraded);
    expect(patch).toEqual({ osVersion: "11.11.61", os: upgraded });
    // Hardware identity is NOT restated on an upgrade.
    expect(patch).not.toHaveProperty("model");
    expect(patch).not.toHaveProperty("manufacturer");
  });

  it("never overwrites a model or manufacturer someone else already set", () => {
    const typed: StoredDescrIdentity = {
      manufacturer: "Axis", model: "M2036-LE-BLK", osVersion: "10.12.114", os: DESCR,
    };
    // Hardware does not change under a fixed address, so a disagreement is
    // either operator-typed or a swap — indistinguishable from here, and the
    // safe direction is to leave it (adoptDetectedModel's posture).
    expect(decideDescrAdoption(typed, AXIS, DESCR)).toBeNull();
  });

  it("treats whitespace as empty rather than as a held value", () => {
    const blank: StoredDescrIdentity = { manufacturer: "  ", model: "	", osVersion: " ", os: "" };
    expect(decideDescrAdoption(blank, AXIS, DESCR)).toEqual({
      manufacturer: "Axis Communications",
      model: "M2036-LE",
      osVersion: "10.12.114",
      os: DESCR,
    });
  });

  it("has no opinion at all when the vendor layout was unreadable", () => {
    // The whole fleet outside the vendor table lands here: no detail, no
    // patch, so a Cisco switch's stored fields are never touched by this path.
    expect(decideDescrAdoption(empty, undefined, "Cisco IOS Software, Version 15.0")).toBeNull();
    expect(decideDescrAdoption(adopted, undefined, DESCR)).toBeNull();
  });

  it("does not move a field the format did not state", () => {
    // A reading that yielded only a model must not blank the firmware.
    const patch = decideDescrAdoption(adopted, { manufacturer: "Axis Communications", model: "M2036-LE" }, DESCR);
    expect(patch).toBeNull();
  });

  it("fills the firmware silently when it was never known", () => {
    // Deliberately paired with the service-side comment: computeFirmwareChange
    // rules a first learn is not an upgrade, so this patch fires no Event.
    const neverKnown: StoredDescrIdentity = { ...adopted, osVersion: null };
    expect(decideDescrAdoption(neverKnown, AXIS, DESCR)).toEqual({ osVersion: "10.12.114" });
  });
});
