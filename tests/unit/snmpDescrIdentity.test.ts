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
  sameDescrObserved,
  descrReadDue,
  DESCR_READ_INTERVAL_SEC,
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

describe("sameDescrObserved — the monitor path's no-I/O gate", () => {
  const reading = {
    manufacturer: "Axis Communications",
    model: "M2036-LE",
    osVersion: "10.12.114",
    os: "; AXIS M2036-LE; Bullet Camera; 10.12.114; Oct 03 2022 14:20; 7EC.1; 1",
    productType: "Bullet Camera",
  };

  it("is true when the device said exactly what we last recorded", () => {
    // The steady state for every camera on every pass: one indexed read, no
    // write, no projection, no event.
    expect(sameDescrObserved({ ...reading }, reading)).toBe(true);
  });

  it("is false on a firmware upgrade, a swap, and a vendor correction", () => {
    expect(sameDescrObserved({ ...reading, osVersion: "10.12.100" }, reading)).toBe(false);
    expect(sameDescrObserved({ ...reading, model: "P3364-LVE" }, reading)).toBe(false);
    expect(sameDescrObserved({ ...reading, manufacturer: "ServerTech" }, reading)).toBe(false);
  });

  it("is false with nothing recorded yet, so the first reading always lands", () => {
    expect(sameDescrObserved(null, reading)).toBe(false);
    expect(sameDescrObserved(undefined, reading)).toBe(false);
  });

  it("does not treat absent, null, empty and whitespace as changes", () => {
    // Field-wise, not JSON-wise: a row written before productType existed
    // must not re-write on every pass just for carrying fewer keys.
    const terse = { manufacturer: "Axis Communications", model: "M2036-LE" };
    expect(sameDescrObserved(terse, { ...terse, osVersion: null, os: null, productType: "" }))
      .toBe(true);
    expect(sameDescrObserved({ ...terse, model: "   " }, { ...terse, model: null }))
      .toBe(true);
  });

  it("ignores key order and extra keys it does not compare", () => {
    const reordered: Record<string, unknown> = {};
    for (const k of Object.keys(reading).reverse()) reordered[k] = (reading as any)[k];
    reordered.sysDescr = "something a later version added";
    expect(sameDescrObserved(reordered, reading)).toBe(true);
  });

  it("compares only strings, so a malformed stored blob reads as changed", () => {
    expect(sameDescrObserved({ model: 42 } as any, { model: "42" })).toBe(false);
  });
});

describe("descrReadDue — what makes the probe carry the extra varbind", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const agoSec = (n: number) => new Date(now.getTime() - n * 1000);

  it("is due when never read, so existing assets pick identity up once", () => {
    expect(descrReadDue(null, now)).toBe(true);
    expect(descrReadDue(undefined, now)).toBe(true);
  });

  it("is not due inside the interval, and due at it", () => {
    expect(descrReadDue(agoSec(DESCR_READ_INTERVAL_SEC - 1), now)).toBe(false);
    expect(descrReadDue(agoSec(DESCR_READ_INTERVAL_SEC), now)).toBe(true);
  });

  it("carries the varbind on one probe in ten at a 60s cadence", () => {
    // The whole cost argument, simulated the way it actually runs: each probe
    // that carries the read stamps the anchor, so the following nine at 60s
    // spacing skip it. Ten probes, one extra varbind.
    let stamp: Date | null = null;
    let carried = 0;
    for (let i = 0; i < 10; i++) {
      const at = new Date(now.getTime() + i * 60_000);
      if (descrReadDue(stamp, at)) { carried++; stamp = at; }
    }
    expect(carried).toBe(1);
  });

  it("carries it again once the interval has passed", () => {
    let stamp: Date | null = null;
    let carried = 0;
    // An hour of 60s probes: the read lands every ten minutes, six times.
    for (let i = 0; i < 60; i++) {
      const at = new Date(now.getTime() + i * 60_000);
      if (descrReadDue(stamp, at)) { carried++; stamp = at; }
    }
    expect(carried).toBe(6);
  });

  it("reads a future stamp as due rather than parking the asset", () => {
    // Clock skew or a restored backup must not freeze identity until the
    // wall clock catches up.
    expect(descrReadDue(new Date(now.getTime() + 86_400_000), now)).toBe(true);
  });

  it("treats an invalid stamp as due", () => {
    expect(descrReadDue(new Date(NaN), now)).toBe(true);
  });
});
