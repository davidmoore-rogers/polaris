/**
 * src/services/geocoderService.ts
 *
 * Address-string → lat/lng geocoder backed by OpenStreetMap Nominatim. Used
 * by FMG/FortiGate discovery to derive coordinates from a FortiGate's SNMP
 * `sysLocation` when the CMDB `gui-device-latitude` / `gui-device-longitude`
 * are missing or malformed — the strict fallback path in syncDhcpSubnets
 * Phase 11.5.
 *
 * Caching: results live in the `GeocodeCache` table for 90 days. Negative
 * results (the geocoder found nothing — gibberish location strings, internal
 * site codes, etc.) are stored with null lat/lng so we don't repeatedly hit
 * Nominatim for inputs that will never resolve. Transport failures (timeout,
 * non-2xx, parse error) are NOT cached — those are retried on the next
 * cycle so a transient Nominatim outage doesn't poison the table.
 *
 * Rate limit: Nominatim's usage policy permits at most 1 req/sec per
 * application. A module-level chained Promise serializes outgoing requests
 * and enforces a 1000ms gap from the previous response. The cache hit path
 * skips the rate limiter entirely — steady-state requests are near-zero
 * after the initial fleet pass.
 */
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { getAppVersion } from "../utils/version.js";

const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const RATE_LIMIT_MS = 1100; // 1 req/sec with safety margin

export interface GeocodeResult {
  latitude: number | null;
  longitude: number | null;
  cached: boolean;
}

/**
 * Canonicalize a free-text location string into the unique cache key. Same
 * normalization is applied on read and write so "Atlanta, GA" / "atlanta,  ga"
 * / " Atlanta,  GA " all collapse to one row.
 */
function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

// ─── Rate limit gate ────────────────────────────────────────────────────────
// `lastChain` is the tail of a Promise chain. Each request awaits it, fires,
// then sleeps for RATE_LIMIT_MS before resolving the next step. Module-level
// so it serializes across every discovery cycle in the process.
// INTENTIONAL .then() serialization queue — this is the rate-limiter itself,
// not a fire-and-forget; do NOT rewrite to an async IIFE (would break the
// chaining that enforces one-request-per-RATE_LIMIT_MS ordering).
let lastChain: Promise<void> = Promise.resolve();

function acquireRateSlot(): Promise<void> {
  const wait = new Promise<void>((resolveSlot) => {
    const prior = lastChain;
    lastChain = prior.then(async () => {
      resolveSlot();
      // Hold the slot for RATE_LIMIT_MS so the NEXT acquire waits.
      await new Promise<void>((r) => setTimeout(r, RATE_LIMIT_MS));
    });
  });
  return wait;
}

/** User-Agent identifying Polaris per Nominatim's usage policy. */
function userAgent(): string {
  return `Polaris-IPAM/${getAppVersion()}`;
}

/**
 * Resolve a sysLocation string to lat/lng. Always returns a result object —
 * never throws. Callers in the discovery hot path don't need to wrap.
 */
export async function geocode(rawQuery: string): Promise<GeocodeResult> {
  const trimmed = (rawQuery || "").trim();
  if (!trimmed) return { latitude: null, longitude: null, cached: false };

  const key = normalizeQuery(trimmed);
  const now = new Date();

  // Cache lookup — both positive AND negative hits short-circuit.
  try {
    const cached = await prisma.geocodeCache.findUnique({ where: { query: key } });
    if (cached && cached.ttlExpiresAt > now) {
      logger.debug(
        { query: key, lat: cached.latitude, lng: cached.longitude },
        "geocode.cache_hit",
      );
      return {
        latitude: cached.latitude,
        longitude: cached.longitude,
        cached: true,
      };
    }
  } catch (err: any) {
    // DB error on cache read isn't fatal — fall through to live geocode.
    logger.warn({ err: err?.message }, "geocode.cache_read_failed");
  }

  // Live request — gated by the rate limiter.
  await acquireRateSlot();

  let lat: number | null = null;
  let lng: number | null = null;
  let transportFailed = false;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(NOMINATIM_ENDPOINT);
    url.searchParams.set("q", trimmed);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status, query: trimmed }, "geocode.nominatim_non_200");
      transportFailed = true;
    } else {
      const body = (await res.json()) as Array<{ lat?: string; lon?: string }>;
      if (Array.isArray(body) && body.length > 0) {
        const parsedLat = Number(body[0]?.lat);
        const parsedLng = Number(body[0]?.lon);
        if (Number.isFinite(parsedLat) && Number.isFinite(parsedLng)) {
          lat = parsedLat;
          lng = parsedLng;
        }
      }
      // body length 0 (no result) → lat/lng stay null → negative cache.
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, query: trimmed }, "geocode.nominatim_fetch_failed");
    transportFailed = true;
  } finally {
    clearTimeout(timer);
  }

  // Transport failures don't poison the cache — try again next cycle.
  if (transportFailed) {
    return { latitude: null, longitude: null, cached: false };
  }

  // Persist positive OR negative result with a fresh TTL.
  try {
    const ttlExpiresAt = new Date(now.getTime() + CACHE_TTL_MS);
    await prisma.geocodeCache.upsert({
      where: { query: key },
      create: {
        query: key,
        displayQuery: trimmed,
        latitude: lat,
        longitude: lng,
        provider: "nominatim",
        fetchedAt: now,
        ttlExpiresAt,
      },
      update: {
        displayQuery: trimmed,
        latitude: lat,
        longitude: lng,
        provider: "nominatim",
        fetchedAt: now,
        ttlExpiresAt,
      },
    });
  } catch (err: any) {
    // Failing to cache shouldn't block the result from reaching the caller.
    logger.warn({ err: err?.message }, "geocode.cache_write_failed");
  }

  return { latitude: lat, longitude: lng, cached: false };
}
