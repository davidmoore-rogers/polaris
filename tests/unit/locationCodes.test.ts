/**
 * tests/unit/locationCodes.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  parseLocationCodes,
  resolveEffectiveLocation,
  hasLocationCodes,
  locationGroupKey,
  shouldSyncDescriptionToNotes,
} from "../../src/utils/locationCodes.js";

describe("parseLocationCodes", () => {
  it("parses all four keys with multi-word values", () => {
    expect(parseLocationCodes("b:Shop f:2 r:North Closet jb:112-305")).toEqual({
      building: "Shop",
      floor: "2",
      room: "North Closet",
      junctionBox: "112-305",
    });
  });

  it("returns all-null for empty / null / undefined / prose-only input", () => {
    const empty = { building: null, floor: null, room: null, junctionBox: null };
    expect(parseLocationCodes(null)).toEqual(empty);
    expect(parseLocationCodes(undefined)).toEqual(empty);
    expect(parseLocationCodes("")).toEqual(empty);
    expect(parseLocationCodes("uplink switch for the east wing")).toEqual(empty);
  });

  it("is case-insensitive on keys and preserves value casing", () => {
    expect(parseLocationCodes("B:Shop JB:A-1 R:MDF")).toEqual({
      building: "Shop",
      floor: null,
      room: "MDF",
      junctionBox: "A-1",
    });
  });

  it("only matches keys at start or after whitespace (hub:/shelf: are not tokens)", () => {
    const parsed = parseLocationCodes("hub:5 shelf:3");
    expect(parsed).toEqual({ building: null, floor: null, room: null, junctionBox: null });
    // ...but a real token after prose still parses
    expect(parseLocationCodes("core switch b:Office").building).toBe("Office");
  });

  it("does not let b: match inside jb:", () => {
    expect(parseLocationCodes("jb:12")).toEqual({
      building: null,
      floor: null,
      room: null,
      junctionBox: "12",
    });
  });

  it("supports underground / free-form floor values", () => {
    expect(parseLocationCodes("b:Shop f:-1").floor).toBe("-1");
    expect(parseLocationCodes("b:Shop f:B2").floor).toBe("B2");
    expect(parseLocationCodes("f:Mezzanine").floor).toBe("Mezzanine");
  });

  it("ignores unknown xx: tokens (their text folds into the preceding value)", () => {
    const parsed = parseLocationCodes("b:Shop rack:4 r:MDF");
    // "rack:4" is not a token, so it rides along inside the building value.
    expect(parsed.building).toBe("Shop rack:4");
    expect(parsed.room).toBe("MDF");
  });

  it("keeps the last non-empty occurrence of a duplicated key", () => {
    expect(parseLocationCodes("b:Shop b:Annex").building).toBe("Annex");
    expect(parseLocationCodes("b:Shop b:").building).toBe("Shop");
  });

  it("treats an empty value as absent", () => {
    expect(parseLocationCodes("b: r:MDF")).toEqual({
      building: null,
      floor: null,
      room: "MDF",
      junctionBox: null,
    });
  });
});

describe("resolveEffectiveLocation", () => {
  it("merges per key with precedence notes > description > deviceDescription", () => {
    expect(
      resolveEffectiveLocation({
        deviceDescription: "b:Shop f:1 r:MDF",
        description: "f:2",
        notes: "jb:112-305",
      })
    ).toEqual({ building: "Shop", floor: "2", room: "MDF", junctionBox: "112-305" });
  });

  it("lets notes add a single key without erasing device-side codes", () => {
    const codes = resolveEffectiveLocation({
      deviceDescription: "b:Shop r:North Closet",
      notes: "jb:7",
    });
    expect(codes.building).toBe("Shop");
    expect(codes.room).toBe("North Closet");
    expect(codes.junctionBox).toBe("7");
  });

  it("returns all-null when no source carries codes", () => {
    const codes = resolveEffectiveLocation({ notes: "operator remark", description: null });
    expect(hasLocationCodes(codes)).toBe(false);
  });
});

describe("locationGroupKey", () => {
  it("trims, collapses whitespace, and lowercases", () => {
    expect(locationGroupKey("  North   Closet ")).toBe("north closet");
    expect(locationGroupKey("SHOP")).toBe(locationGroupKey("shop"));
  });
});

describe("shouldSyncDescriptionToNotes", () => {
  it("syncs onto empty notes", () => {
    expect(
      shouldSyncDescriptionToNotes({ deviceDescription: "b:Shop", currentNotes: "", lastSyncedDescription: null })
    ).toBe(true);
    expect(
      shouldSyncDescriptionToNotes({ deviceDescription: "b:Shop", currentNotes: null, lastSyncedDescription: null })
    ).toBe(true);
  });

  it("syncs over the previous cycle's synced value", () => {
    expect(
      shouldSyncDescriptionToNotes({
        deviceDescription: "b:Shop f:2",
        currentNotes: "b:Shop",
        lastSyncedDescription: "b:Shop",
      })
    ).toBe(true);
  });

  it("syncs over the auto-discovery boilerplate", () => {
    expect(
      shouldSyncDescriptionToNotes({
        deviceDescription: "b:Shop",
        currentNotes: "Auto-discovered from FortiGate branch-fw via port5 via HQ FMG",
        lastSyncedDescription: null,
      })
    ).toBe(true);
    expect(
      shouldSyncDescriptionToNotes({
        deviceDescription: "b:Shop",
        currentNotes: "Auto-discovered from FortiGate device inventory (branch-fw)",
        lastSyncedDescription: null,
      })
    ).toBe(true);
  });

  it("never overwrites operator-edited notes", () => {
    expect(
      shouldSyncDescriptionToNotes({
        deviceDescription: "b:Shop",
        currentNotes: "replaced PSU 2026-05, keep an eye on it",
        lastSyncedDescription: "b:Old",
      })
    ).toBe(false);
  });

  it("is a no-op when notes already match the device description", () => {
    expect(
      shouldSyncDescriptionToNotes({
        deviceDescription: "b:Shop",
        currentNotes: "b:Shop",
        lastSyncedDescription: null,
      })
    ).toBe(false);
  });

  it("never syncs an empty/cleared device description", () => {
    expect(
      shouldSyncDescriptionToNotes({ deviceDescription: "", currentNotes: "", lastSyncedDescription: "b:Shop" })
    ).toBe(false);
    expect(
      shouldSyncDescriptionToNotes({ deviceDescription: null, currentNotes: "b:Shop", lastSyncedDescription: "b:Shop" })
    ).toBe(false);
  });
});
