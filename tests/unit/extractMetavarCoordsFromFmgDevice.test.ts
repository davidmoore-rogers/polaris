import { describe, it, expect } from "vitest";
import { extractMetavarCoordsFromFmgDevice } from "../../src/services/fortimanagerService.js";

// extractMetavarCoordsFromFmgDevice() reads per-device FMG metavariables off a
// raw device record's "meta fields" object. Names default to the common
// Latitude / Longitude convention but are operator-overridable; the optional
// address metavar is blank-disabled. Lookup is case-insensitive. Pure — no DB,
// no network.

describe("extractMetavarCoordsFromFmgDevice", () => {
  it("returns empty when meta fields absent", () => {
    expect(extractMetavarCoordsFromFmgDevice({})).toEqual({});
    expect(extractMetavarCoordsFromFmgDevice({ "meta fields": null })).toEqual({});
  });

  it("reads default Latitude / Longitude (exact case)", () => {
    const r = extractMetavarCoordsFromFmgDevice({
      "meta fields": { Latitude: "40.7128", Longitude: "-74.0060" },
    });
    expect(r.latitude).toBeCloseTo(40.7128, 4);
    expect(r.longitude).toBeCloseTo(-74.0060, 4);
    expect(r.address).toBeUndefined();
  });

  it("lookup is case-insensitive against the configured name", () => {
    const r = extractMetavarCoordsFromFmgDevice(
      { "meta fields": { LATITUDE: "10", longitude: "20" } },
      "Latitude",
      "Longitude",
    );
    expect(r.latitude).toBe(10);
    expect(r.longitude).toBe(20);
  });

  it("honors custom metavar names", () => {
    const r = extractMetavarCoordsFromFmgDevice(
      { "meta fields": { GPS_Lat: "1.5", GPS_Lng: "2.5", Latitude: "99" } },
      "GPS_Lat",
      "GPS_Lng",
    );
    expect(r.latitude).toBe(1.5);
    expect(r.longitude).toBe(2.5);
  });

  it("skips non-finite / empty coord values", () => {
    const r = extractMetavarCoordsFromFmgDevice({
      "meta fields": { Latitude: "", Longitude: "not-a-number" },
    });
    expect(r.latitude).toBeUndefined();
    expect(r.longitude).toBeUndefined();
  });

  it("extracts the address metavar only when a name is supplied", () => {
    const meta = { "meta fields": { Address: "123 Main St, Ashfield TN", Latitude: "36" } };
    // No addrName → address ignored.
    expect(extractMetavarCoordsFromFmgDevice(meta).address).toBeUndefined();
    // addrName supplied → trimmed string returned.
    const r = extractMetavarCoordsFromFmgDevice(meta, "Latitude", "Longitude", "Address");
    expect(r.address).toBe("123 Main St, Ashfield TN");
  });

  it("ignores a blank / whitespace-only address metavar value", () => {
    const r = extractMetavarCoordsFromFmgDevice(
      { "meta fields": { Address: "   " } },
      "Latitude",
      "Longitude",
      "Address",
    );
    expect(r.address).toBeUndefined();
  });
});
