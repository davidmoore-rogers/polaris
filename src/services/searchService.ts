/**
 * src/services/searchService.ts — Global fuzzy search across the domain
 *
 * Detects what the user typed (IP, CIDR, MAC, or plain text) and runs the
 * appropriate set of database queries in parallel. Returns a grouped hit list
 * capped at PER_GROUP_LIMIT per entity type so the UI typeahead can render a
 * compact dropdown.
 */

import { prisma } from "../db.js";
import { isValidIpAddress, normalizeCidr, ipInCidr } from "../utils/cidr.js";

export interface SearchHit {
  type: "block" | "subnet" | "reservation" | "asset" | "ip" | "site";
  id: string;
  title: string;       // Primary label (hostname, name, IP, etc.)
  subtitle?: string;   // Secondary label (CIDR, MAC, owner, etc.)
  // Type-specific context needed for client-side navigation
  context?: Record<string, unknown>;
}

export interface SearchResults {
  query: string;
  blocks: SearchHit[];
  subnets: SearchHit[];
  reservations: SearchHit[];
  assets: SearchHit[];
  ips: SearchHit[];
  /**
   * Firewall assets that have lat/lng coordinates set — i.e. they
   * appear as pins on the Device Map. Surfaced as a separate group so
   * the dropdown can render a "Device Map" section that lets the
   * operator pan-to-marker. Excluded from `assets` to avoid showing
   * the same FortiGate twice.
   */
  sites: SearchHit[];
}

const PER_GROUP_LIMIT = 8;
// When the operator scopes a search to one group via a `block:` / `network:`
// / `asset:` / `reservation:` / `map:` prefix (or the short forms `b:` /
// `n:` / `a:` / `r:` / `m:`), the per-group cap is lifted to this value.
// Picked to be much larger than the default cap while still bounded so a
// pathological query can't scan the entire fleet — operators who want to
// enumerate a whole category have the dedicated page for that.
const SCOPED_LIMIT = 200;

// ─── Input classification ────────────────────────────────────────────────────

const MAC_HEX_ONLY = /^[0-9a-f]{12}$/i;

type SearchScope = "block" | "asset" | "reservation" | "map" | "network";

// Recognize `block:` / `asset:` / `reservation:` / `map:` / `network:` and
// their short forms `b:` / `a:` / `r:` / `m:` / `n:`. Case-insensitive;
// trims whitespace after the colon so `asset:  foo` works. The scopes are
// mutually exclusive with the `entra:` / `ad:` / `fgt:` source-kind prefix
// consumed inside `stripSourceKindPrefix` — none of those start with the
// scope letters.
function parseSearchScope(raw: string): { scope: SearchScope | null; query: string } {
  const m = raw.match(/^(block|asset|reservation|map|network|b|a|r|m|n):\s*(.*)$/i);
  if (!m) return { scope: null, query: raw };
  const prefix = m[1].toLowerCase();
  const rest = m[2].trim();
  let scope: SearchScope;
  if (prefix === "block" || prefix === "b") scope = "block";
  else if (prefix === "asset" || prefix === "a") scope = "asset";
  else if (prefix === "reservation" || prefix === "r") scope = "reservation";
  else if (prefix === "network" || prefix === "n") scope = "network";
  else scope = "map";
  return { scope, query: rest };
}

/** Normalize a MAC to UPPER:CASE:COLON:FORM if recognizable, else null. */
export function normalizeMac(raw: string): string | null {
  const compact = raw.replace(/[\s:\-.]/g, "").toLowerCase();
  if (!MAC_HEX_ONLY.test(compact)) return null;
  return compact.toUpperCase().match(/.{2}/g)!.join(":");
}

function isCidrLike(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){0,3}(\/\d{1,2})?$/.test(s);
}

function isIpLike(s: string): boolean {
  return isValidIpAddress(s);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function searchAll(rawQuery: string): Promise<SearchResults> {
  const trimmed = rawQuery.trim();
  // Always echo the original query back to the client; the dropdown
  // stale-response check compares against what was typed, not the
  // post-scope-strip form.
  const empty: SearchResults = {
    query: trimmed,
    blocks: [], subnets: [], reservations: [], assets: [], ips: [], sites: [],
  };

  const { scope, query: scopedQuery } = parseSearchScope(trimmed);
  // Scoped searches accept any non-empty query (so `block:f` works);
  // unscoped queries keep the 2-char min so accidental keystrokes don't
  // fan out across every entity table.
  const minLen = scope ? 1 : 2;
  const q = scopedQuery;
  if (q.length < minLen) return empty;

  const mac = normalizeMac(q);
  const isIp = isIpLike(q);
  const isCidr = !isIp && isCidrLike(q) && q.includes("/");

  // Text pattern used for contains-insensitive matches
  const like = q;

  // Scoped path: run only the requested group's query with the elevated
  // cap and return everything else empty. Operators who pick a scope
  // explicitly want the full enumeration, not the typeahead-tuned top 8.
  if (scope === "block") {
    const blocks = await searchBlocks(like, SCOPED_LIMIT);
    return { ...empty, blocks: blocks.map(blockHit) };
  }
  if (scope === "network") {
    const subnets = await searchSubnets(like, isCidr ? q : null, SCOPED_LIMIT);
    return { ...empty, subnets: subnets.map(subnetHit) };
  }
  if (scope === "reservation") {
    const reservations = await searchReservations(like, isIp ? q : null, SCOPED_LIMIT);
    return { ...empty, reservations: reservations.map(reservationHit) };
  }
  if (scope === "map") {
    const sites = await searchPinnedFirewalls(like, mac, SCOPED_LIMIT);
    return { ...empty, sites: sites.map(siteHit) };
  }
  if (scope === "asset") {
    const assetRows = await searchAssets(like, mac, SCOPED_LIMIT);
    const originBySrcId = await resolveOriginFortigates(assetRows.map((a) => a.id));
    const assetHits = assetRows.map((a) => decorateAssetHit(a, originBySrcId.get(a.id)));
    return { ...empty, assets: assetHits };
  }

  // Run all queries in parallel. Pinned firewalls are queried as their
  // own group (`sites`) with an independent PER_GROUP_LIMIT budget so
  // they don't get crowded out of `assets` by alphabetically-earlier
  // workstations/switches matching the same site code on large fleets.
  const [blocks, subnets, reservations, assets, sites, ipHit] = await Promise.all([
    searchBlocks(like),
    searchSubnets(like, isCidr ? q : null),
    searchReservations(like, isIp ? q : null),
    searchAssets(like, mac),
    searchPinnedFirewalls(like, mac),
    isIp ? resolveIp(q) : Promise.resolve(null),
  ]);

  const assetsWithoutSites = assets;

  // Resolve the origin FortiGate (a pinned site on the Device Map)
  // for each asset hit. When set, the dropdown's map-page handler can
  // open that FortiGate's topology modal and highlight where the
  // workstation/endpoint plugs in — instead of opening the asset
  // details page when the operator clearly wants the connectivity
  // view. Pinned-only filter ensures we only return FortiGates the
  // map page can actually navigate to.
  const originBySrcId = await resolveOriginFortigates(
    assetsWithoutSites.map((a) => a.id),
  );
  const assetHits = assetsWithoutSites.map((a) =>
    decorateAssetHit(a, originBySrcId.get(a.id)),
  );

  return {
    query: q,
    blocks: blocks.map(blockHit),
    subnets: subnets.map(subnetHit),
    reservations: reservations.map(reservationHit),
    assets: assetHits,
    ips: ipHit ? [ipHit] : [],
    sites: sites.map(siteHit),
  };
}

/**
 * For each asset id, find the FortiGate that asset was discovered on,
 * and only return the ones whose FortiGate is pinned on the Device Map
 * (lat/lng set — otherwise the map page can't navigate to it). Most-
 * recent DHCP sighting wins; falls back to `Asset.learnedLocation`
 * when no sighting exists (Entra/AD-discovered hosts that haven't been
 * seen on a FortiGate yet won't have one — that's fine, they fall
 * through to the asset-details navigation).
 */
async function resolveOriginFortigates(
  assetIds: string[],
): Promise<Map<string, { siteId: string; hostname: string }>> {
  const out = new Map<string, { siteId: string; hostname: string }>();
  if (assetIds.length === 0) return out;

  const sightings = await prisma.assetFortigateSighting.findMany({
    where: { assetId: { in: assetIds } },
    select: { assetId: true, fortigateDevice: true, lastSeen: true },
    orderBy: { lastSeen: "desc" },
  });
  const sightingByAsset = new Map<string, string>();
  for (const s of sightings) {
    if (!sightingByAsset.has(s.assetId)) sightingByAsset.set(s.assetId, s.fortigateDevice);
  }

  // learnedLocation fallback for assets without DHCP sightings (e.g.
  // Entra/AD-discovered with no FortiGate dance yet).
  const fallbackAssets = assetIds.filter((id) => !sightingByAsset.has(id));
  let learnedByAsset = new Map<string, string>();
  if (fallbackAssets.length > 0) {
    const rows = await prisma.asset.findMany({
      where: { id: { in: fallbackAssets }, learnedLocation: { not: null } },
      select: { id: true, learnedLocation: true },
    });
    for (const r of rows) {
      if (r.learnedLocation) learnedByAsset.set(r.id, r.learnedLocation);
    }
  }

  const candidateHostnames = new Set<string>([
    ...sightingByAsset.values(),
    ...learnedByAsset.values(),
  ]);
  if (candidateHostnames.size === 0) return out;

  const firewalls = await prisma.asset.findMany({
    where: {
      assetType: "firewall",
      hostname: { in: Array.from(candidateHostnames) },
      latitude: { not: null },
      longitude: { not: null },
    },
    select: { id: true, hostname: true },
  });
  const fgByHostname = new Map<string, { siteId: string; hostname: string }>();
  for (const fg of firewalls) {
    if (fg.hostname) fgByHostname.set(fg.hostname, { siteId: fg.id, hostname: fg.hostname });
  }

  for (const [assetId, fgHostname] of sightingByAsset) {
    const fg = fgByHostname.get(fgHostname);
    if (fg) out.set(assetId, fg);
  }
  for (const [assetId, fgHostname] of learnedByAsset) {
    const fg = fgByHostname.get(fgHostname);
    if (fg) out.set(assetId, fg);
  }
  return out;
}

// ─── Query helpers ───────────────────────────────────────────────────────────

async function searchBlocks(like: string, limit = PER_GROUP_LIMIT) {
  return prisma.ipBlock.findMany({
    where: {
      OR: [
        { name: { contains: like, mode: "insensitive" } },
        { description: { contains: like, mode: "insensitive" } },
        { cidr: { contains: like, mode: "insensitive" } },
      ],
    },
    take: limit,
    orderBy: { name: "asc" },
  });
}

async function searchSubnets(like: string, cidrExact: string | null, limit = PER_GROUP_LIMIT) {
  let cidrNormalized: string | null = null;
  if (cidrExact) {
    try { cidrNormalized = normalizeCidr(cidrExact); } catch { /* ignore */ }
  }

  return prisma.subnet.findMany({
    where: {
      OR: [
        ...(cidrNormalized ? [{ cidr: cidrNormalized }] : []),
        { cidr: { contains: like, mode: "insensitive" as const } },
        { name: { contains: like, mode: "insensitive" as const } },
        { purpose: { contains: like, mode: "insensitive" as const } },
        { fortigateDevice: { contains: like, mode: "insensitive" as const } },
      ],
    },
    take: limit,
    orderBy: { name: "asc" },
  });
}

async function searchReservations(like: string, ipExact: string | null, limit = PER_GROUP_LIMIT) {
  return prisma.reservation.findMany({
    where: {
      status: "active",
      OR: [
        ...(ipExact ? [{ ipAddress: ipExact }] : []),
        { hostname: { contains: like, mode: "insensitive" as const } },
        { owner: { contains: like, mode: "insensitive" as const } },
        { projectRef: { contains: like, mode: "insensitive" as const } },
        { notes: { contains: like, mode: "insensitive" as const } },
        ...(ipExact ? [] : [{ ipAddress: { contains: like, mode: "insensitive" as const } }]),
      ],
    },
    include: { subnet: { select: { id: true, cidr: true, name: true } } },
    take: limit,
    orderBy: { hostname: "asc" },
  });
}

async function searchAssets(like: string, mac: string | null, limit = PER_GROUP_LIMIT) {
  return runAssetSearch(like, mac, {}, limit);
}

async function searchPinnedFirewalls(like: string, mac: string | null, limit = PER_GROUP_LIMIT) {
  return runAssetSearch(like, mac, {
    assetType: "firewall",
    latitude: { not: null },
    longitude: { not: null },
  }, limit);
}

async function runAssetSearch(like: string, mac: string | null, baseFilter: any, limit = PER_GROUP_LIMIT) {
  const or: any[] = [
    { hostname: { contains: like, mode: "insensitive" as const } },
    { dnsName: { contains: like, mode: "insensitive" as const } },
    { assetTag: { contains: like, mode: "insensitive" as const } },
    { serialNumber: { contains: like, mode: "insensitive" as const } },
    { ipAddress: { contains: like, mode: "insensitive" as const } },
    { manufacturer: { contains: like, mode: "insensitive" as const } },
    { model: { contains: like, mode: "insensitive" as const } },
    { assignedTo: { contains: like, mode: "insensitive" as const } },
    { department: { contains: like, mode: "insensitive" as const } },
  ];
  if (mac) {
    // Stored MAC case is inconsistent — some discovery paths uppercase
    // (monitoringService, FMG CMDB), others store the device-reported value
    // as-is (FMG endpoint clients, often lowercase). Match case-insensitively
    // so all four typed forms (colon / dash / dot / bare) resolve regardless
    // of stored case.
    or.push({ macAddress: { equals: mac, mode: "insensitive" as const } });
  } else {
    or.push({ macAddress: { contains: like, mode: "insensitive" as const } });
  }
  // AssetSource cross-search — operator-typed searches by Entra deviceId,
  // AD objectGUID, or FortiGate serial used to hit `Asset.assetTag`
  // (entra:..., ad:..., fgt:... prefixes). After Phase 4d cuts those
  // assetTag writes, the canonical key is on AssetSource.externalId.
  // Run both queries in parallel and merge — old rows still match the
  // legacy assetTag column, new rows match via AssetSource. Strip the
  // common "<kind>:" prefix so an operator can paste either form.
  const sourceQuery = stripSourceKindPrefix(like);
  const likePattern = `%${like}%`;
  const jsonLimit = limit * 4;
  const [byAsset, sourceHits, macSideHits, ipSideHits, jsonHitIds] = await Promise.all([
    prisma.asset.findMany({
      where: { ...baseFilter, OR: or },
      take: limit,
      orderBy: { hostname: "asc" },
    }),
    prisma.assetSource.findMany({
      where: {
        externalId: { contains: sourceQuery, mode: "insensitive" as const },
        asset: baseFilter,
      },
      include: {
        asset: true,
      },
      take: limit,
    }),
    // Full MAC history (the side table) — `Asset.macAddress` only carries the
    // most-recently-seen value, so historical MACs from prior NICs / sightings
    // would otherwise be invisible to search.
    prisma.assetMacAddress.findMany({
      where: {
        mac: mac
          ? { equals: mac, mode: "insensitive" as const }
          : { contains: like, mode: "insensitive" as const },
        asset: baseFilter,
      },
      include: { asset: true },
      take: limit,
      orderBy: { lastSeen: "desc" },
    }),
    // Secondary interface IPs — `Asset.ipAddress` is the primary; multi-NIC
    // servers / FortiGates with several VIPs hold their other IPs in this
    // side table.
    prisma.assetAssociatedIp.findMany({
      where: {
        ip: { contains: like, mode: "insensitive" as const },
        asset: baseFilter,
      },
      include: { asset: true },
      take: limit,
      orderBy: { lastSeen: "desc" },
    }),
    // JSON-blob substring search across `Asset.associatedUsers` (logged-in
    // users from FortiGate DHCP sightings, shape `[{user, domain?, lastSeen,
    // source?}]`) and `AssetSource.observed` (Entra/AD/Intune raw blobs —
    // SID, UPN, onPremisesSecurityIdentifier, etc.). Backed by GIN trigram
    // indexes added in 20260507200000_search_json_trgm_indexes; falls back
    // to a seq scan only for queries shorter than 3 chars.
    prisma.$queryRaw<{ assetId: string }[]>`
      SELECT id AS "assetId" FROM assets
      WHERE "associatedUsers"::text ILIKE ${likePattern}
      UNION
      SELECT "assetId" FROM asset_sources
      WHERE observed::text ILIKE ${likePattern}
      LIMIT ${jsonLimit}
    `,
  ]);
  // The raw query returns asset ids only; load the asset rows with the
  // baseFilter applied so the firewall vs. non-firewall partition still
  // holds (a pinned-firewall hit via observed-blob substring would otherwise
  // leak into the regular Assets group).
  const jsonAssets = jsonHitIds.length
    ? await prisma.asset.findMany({
        where: { ...baseFilter, id: { in: jsonHitIds.map((r) => r.assetId) } },
        take: limit,
        orderBy: { hostname: "asc" },
      })
    : [];
  // Merge dedup by asset id; the byAsset query wins on hostname-sort order
  // for ties so existing presentation is preserved. Source/MAC/IP side hits
  // and JSON-blob hits fill any remaining budget in that order.
  const seen = new Set<string>();
  const merged: typeof byAsset = [];
  const tryPush = (a: any) => {
    if (!a || !a.id || seen.has(a.id)) return;
    seen.add(a.id);
    merged.push(a);
  };
  for (const a of byAsset) tryPush(a);
  for (const s of sourceHits) {
    if (merged.length >= limit) break;
    tryPush(s.asset);
  }
  for (const m of macSideHits) {
    if (merged.length >= limit) break;
    tryPush(m.asset);
  }
  for (const ip of ipSideHits) {
    if (merged.length >= limit) break;
    tryPush(ip.asset);
  }
  for (const a of jsonAssets) {
    if (merged.length >= limit) break;
    tryPush(a);
  }
  return merged.slice(0, limit);
}

// Build an asset SearchHit + stamp the origin-FortiGate context onto it when
// the asset was seen on a pinned firewall. Extracted from `searchAll` so the
// scoped `asset:` path can reuse the same shape.
function decorateAssetHit(
  a: { id: string; hostname: string | null; ipAddress: string | null; macAddress: string | null; assetTag: string | null; assetType: string; manufacturer: string | null; model: string | null },
  origin: { siteId: string; hostname: string } | undefined,
): SearchHit {
  const hit = assetHit(a);
  if (origin) {
    hit.context = {
      ...(hit.context ?? {}),
      siteId: origin.siteId,
      siteHostname: origin.hostname,
      focusHostname: a.hostname ?? null,
      focusIpAddress: a.ipAddress ?? null,
      focusMacAddress: a.macAddress ?? null,
      focusAssetId: a.id,
    };
  }
  return hit;
}

// Strip the "entra:" / "ad:" / "fgt:" / "intune:" / "fortiswitch:" / "fortiap:"
// prefix from a query so an operator pasting `entra:abcd-1234` matches the
// AssetSource externalId that just stores `abcd-1234`. Anything not
// matching one of the known prefixes passes through unchanged.
function stripSourceKindPrefix(q: string): string {
  const m = q.match(/^(entra|intune|ad|fgt|fortiswitch|fortiap):(.+)$/i);
  return m ? m[2].trim() : q;
}

// Find which subnet contains the IP and whether there is an active reservation.
async function resolveIp(ip: string): Promise<SearchHit | null> {
  const subnets = await prisma.subnet.findMany({
    where: { status: { not: "deprecated" } },
    select: { id: true, cidr: true, name: true },
  });
  const containing = subnets.find((s) => {
    try { return ipInCidr(ip, s.cidr); } catch { return false; }
  });
  if (!containing) return null;

  const reservation = await prisma.reservation.findFirst({
    where: { subnetId: containing.id, ipAddress: ip, status: "active" },
    select: { id: true, hostname: true, owner: true },
  });

  return {
    type: "ip",
    id: `${containing.id}|${ip}`,
    title: ip,
    subtitle: reservation
      ? `${reservation.hostname || reservation.owner || "reserved"} — in ${containing.cidr}`
      : `free — in ${containing.cidr} (${containing.name})`,
    context: {
      subnetId: containing.id,
      subnetCidr: containing.cidr,
      subnetName: containing.name,
      ipAddress: ip,
      reservationId: reservation?.id ?? null,
    },
  };
}

// ─── Hit shapers ─────────────────────────────────────────────────────────────

function blockHit(b: { id: string; name: string; cidr: string; description: string | null }): SearchHit {
  return {
    type: "block",
    id: b.id,
    title: b.name,
    subtitle: b.cidr + (b.description ? ` — ${b.description}` : ""),
  };
}

function subnetHit(s: { id: string; name: string; cidr: string; purpose: string | null }): SearchHit {
  return {
    type: "subnet",
    id: s.id,
    title: s.name,
    subtitle: s.cidr + (s.purpose ? ` — ${s.purpose}` : ""),
    context: { cidr: s.cidr },
  };
}

function reservationHit(
  r: { id: string; hostname: string | null; ipAddress: string | null; owner: string | null; subnet: { id: string; cidr: string; name: string } | null },
): SearchHit {
  return {
    type: "reservation",
    id: r.id,
    title: r.hostname || r.ipAddress || "reservation",
    subtitle: [r.ipAddress, r.subnet?.cidr, r.owner].filter(Boolean).join(" — "),
    context: {
      subnetId: r.subnet?.id ?? null,
      ipAddress: r.ipAddress,
    },
  };
}

function assetHit(
  a: { id: string; hostname: string | null; ipAddress: string | null; macAddress: string | null; assetTag: string | null; assetType: string; manufacturer: string | null; model: string | null },
): SearchHit {
  const secondary = [a.ipAddress, a.macAddress, [a.manufacturer, a.model].filter(Boolean).join(" ")].filter(Boolean).join(" — ");
  return {
    type: "asset",
    id: a.id,
    title: a.hostname || a.assetTag || "asset",
    subtitle: secondary || a.assetType,
  };
}

function siteHit(
  a: { id: string; hostname: string | null; serialNumber: string | null; ipAddress: string | null; model: string | null; learnedLocation: string | null },
): SearchHit {
  // Site label leads with hostname; subtitle pulls model + IP/serial so
  // the operator can disambiguate FortiGates whose hostnames overlap
  // (e.g. multiple branch units of the same model).
  const bits: string[] = [];
  if (a.model) bits.push(a.model);
  if (a.ipAddress) bits.push(a.ipAddress);
  if (a.serialNumber) bits.push(a.serialNumber);
  if (a.learnedLocation && a.learnedLocation !== a.hostname) bits.push(a.learnedLocation);
  return {
    type: "site",
    id: a.id,
    title: a.hostname || a.serialNumber || "FortiGate",
    subtitle: bits.join(" — "),
  };
}
