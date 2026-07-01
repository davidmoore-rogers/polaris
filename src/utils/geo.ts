/**
 * src/utils/geo.ts
 *
 * Pure geometry helpers. No DB, no I/O.
 *
 * Coordinates throughout Polaris are stored as [latitude, longitude] pairs
 * (Asset.latitude / Asset.longitude, MapRegion polygon vertices). Helpers in
 * this module use the same ordering.
 */

export type LatLng = [number, number];

/**
 * Standard ray-casting point-in-polygon test. Treats the polygon as a closed
 * ring whether or not the caller repeated the first vertex at the end.
 *
 * Counts the polygon edge as "inside" on the Y-bound where horizontal ray
 * exits crossings — fine for our use case (firewall coords vs operator-drawn
 * polygons; equality is exceptionally unlikely and either bucketing is fine).
 *
 * Does NOT handle polygons that cross the antimeridian. Polaris fleets are
 * regional; this is documented as out-of-scope in the feature plan.
 */
export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false;
  const [py, px] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [iy, ix] = polygon[i]!;
    const [jy, jx] = polygon[j]!;
    const intersects =
      iy > py !== jy > py &&
      px < ((jx - ix) * (py - iy)) / (jy - iy + Number.EPSILON) + ix;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Treats lat/lng as valid only when both are finite numbers, fall inside
 * Earth's lat/lng ranges, AND aren't the FortiOS-default (0, 0). FortiOS
 * serializes unset `gui-device-latitude` / `gui-device-longitude` as 0.0 / 0.0
 * which is a real geographic point off the coast of Africa — operators don't
 * actually pin firewalls there, so we treat (0,0) as "unset" and fall through
 * to the SNMP-geocoded path.
 *
 * Pure (no I/O). Used by syncDhcpSubnets Phase 11.5 to decide whether to
 * skip the SNMP fallback.
 */
export function isValidGeoCoord(
  lat: unknown,
  lng: unknown,
): lat is number {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

/**
 * Validate an operator-supplied manual coordinate patch from the asset
 * create/edit form. Coordinates travel as a pair: a request may omit both
 * (no change), null both (clear — resumes discovery ownership), or set both
 * to numbers, which must form a valid geographic pair per isValidGeoCoord
 * (finite, in-range, and not the (0,0) unset sentinel).
 *
 * Returns a human-readable error string, or null when the patch is valid.
 * Pure (no I/O) — route handlers map the string onto an AppError(400).
 */
export function manualCoordPatchError(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): string | null {
  if (latitude === undefined && longitude === undefined) return null;
  if (latitude === undefined || longitude === undefined) {
    return "Latitude and longitude must be provided together";
  }
  if (latitude === null && longitude === null) return null;
  if (latitude === null || longitude === null) {
    return "Latitude and longitude must both be set or both be cleared";
  }
  if (!isValidGeoCoord(latitude, longitude)) {
    return "Coordinates must be valid decimal degrees (latitude -90 to 90, longitude -180 to 180, and not 0,0)";
  }
  return null;
}

/**
 * Compare two coordinate pairs for "close enough" — used by the FortiGate
 * SNMP-location write-back path to decide whether the geocoded coords match
 * what's currently in the FortiGate's CMDB. A mismatch triggers a write-back
 * to update `gui-device-latitude` / `gui-device-longitude` (and FMG metavars).
 *
 * Default tolerance is 1e-5° — roughly 1.1 m at the equator, tighter near
 * the poles. Nominatim returns 6-7 decimal places for typical address inputs,
 * so this catches operator edits without firing on Nominatim's internal
 * representation jitter.
 *
 * Caller is responsible for verifying both pairs are themselves valid coords
 * via `isValidGeoCoord` first — this function only does the proximity check.
 */
export function coordsClose(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  tolerance = 1e-5,
): boolean {
  return Math.abs(lat1 - lat2) <= tolerance && Math.abs(lng1 - lng2) <= tolerance;
}
