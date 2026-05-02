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

// ─── Input classification ────────────────────────────────────────────────────

const MAC_HEX_ONLY = /^[0-9a-f]{12}$/i;

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
  const q = rawQuery.trim();
  const empty: SearchResults = {
    query: q,
    blocks: [], subnets: [], reservations: [], assets: [], ips: [], sites: [],
  };
  if (q.length < 2) return empty;

  const mac = normalizeMac(q);
  const isIp = isIpLike(q);
  const isCidr = !isIp && isCidrLike(q) && q.includes("/");

  // Text pattern used for contains-insensitive matches
  const like = q;

  // Run all queries in parallel
  const [blocks, subnets, reservations, assets, ipHit] = await Promise.all([
    searchBlocks(like),
    searchSubnets(like, isCidr ? q : null),
    searchReservations(like, isIp ? q : null),
    searchAssets(like, mac),
    isIp ? resolveIp(q) : Promise.resolve(null),
  ]);

  // Site = firewall asset with lat/lng coords. Surface separately under
  // the "Device Map" section so the dropdown can pan-to-marker. Drop
  // these from the regular Assets group too so the same FortiGate
  // doesn't appear in both sections.
  const sites = assets.filter(
    (a) => a.assetType === "firewall" && a.latitude !== null && a.longitude !== null,
  );
  const siteIds = new Set(sites.map((s) => s.id));
  const assetsWithoutSites = assets.filter((a) => !siteIds.has(a.id));

  return {
    query: q,
    blocks: blocks.map(blockHit),
    subnets: subnets.map(subnetHit),
    reservations: reservations.map(reservationHit),
    assets: assetsWithoutSites.map(assetHit),
    ips: ipHit ? [ipHit] : [],
    sites: sites.map(siteHit),
  };
}

// ─── Query helpers ───────────────────────────────────────────────────────────

async function searchBlocks(like: string) {
  return prisma.ipBlock.findMany({
    where: {
      OR: [
        { name: { contains: like, mode: "insensitive" } },
        { description: { contains: like, mode: "insensitive" } },
        { cidr: { contains: like, mode: "insensitive" } },
      ],
    },
    take: PER_GROUP_LIMIT,
    orderBy: { name: "asc" },
  });
}

async function searchSubnets(like: string, cidrExact: string | null) {
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
    take: PER_GROUP_LIMIT,
    orderBy: { name: "asc" },
  });
}

async function searchReservations(like: string, ipExact: string | null) {
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
    take: PER_GROUP_LIMIT,
    orderBy: { hostname: "asc" },
  });
}

async function searchAssets(like: string, mac: string | null) {
  const or: any[] = [
    { hostname: { contains: like, mode: "insensitive" as const } },
    { dnsName: { contains: like, mode: "insensitive" as const } },
    { assetTag: { contains: like, mode: "insensitive" as const } },
    { serialNumber: { contains: like, mode: "insensitive" as const } },
    { ipAddress: { contains: like, mode: "insensitive" as const } },
    { manufacturer: { contains: like, mode: "insensitive" as const } },
    { model: { contains: like, mode: "insensitive" as const } },
  ];
  if (mac) {
    or.push({ macAddress: mac });
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
  const [byAsset, sourceHits] = await Promise.all([
    prisma.asset.findMany({
      where: { OR: or },
      take: PER_GROUP_LIMIT,
      orderBy: { hostname: "asc" },
    }),
    prisma.assetSource.findMany({
      where: {
        externalId: { contains: sourceQuery, mode: "insensitive" as const },
      },
      include: {
        asset: true,
      },
      take: PER_GROUP_LIMIT,
    }),
  ]);
  // Merge dedup by asset id; assetTag-side wins on hostname-sort order
  // for ties, so the existing presentation is preserved when both
  // pathways return the same row.
  const seen = new Set<string>();
  const merged: typeof byAsset = [];
  for (const a of byAsset) {
    if (a && a.id && !seen.has(a.id)) {
      seen.add(a.id);
      merged.push(a);
    }
  }
  for (const s of sourceHits) {
    const a = s.asset;
    if (!a || !a.id || seen.has(a.id)) continue;
    seen.add(a.id);
    merged.push(a as any);
    if (merged.length >= PER_GROUP_LIMIT) break;
  }
  return merged.slice(0, PER_GROUP_LIMIT);
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
