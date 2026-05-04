/**
 * src/db.ts — Prisma client singleton
 *
 * Import `prisma` from this module instead of instantiating PrismaClient
 * directly, so the connection pool is shared across the process.
 *
 * The extended client wraps every write so that:
 *   1. Any write to Asset.manufacturer or MibFile.manufacturer is run
 *      through normalizeManufacturer() before hitting the DB. The map is
 *      empty at module load — manufacturerAliasService.refreshAliasCache()
 *      populates it during app startup, so any pre-cache write falls
 *      through unchanged (which is fine: the startup backfill cleans up
 *      anything written before the cache loaded).
 *   2. Every asset.create / asset.update that sets ipAddress also records
 *      the IP in asset_ip_history (one row per assetId+ip). When the
 *      source changes (e.g. IP moves to a different FortiGate) firstSeen
 *      is reset so first/last seen reflect the current source rather than
 *      the original one.
 *   3. Asset writes that touch identity-relevant fields (assetTag, tags,
 *      discoveredByIntegrationId) shadow-write to asset_sources via the
 *      phase-1 derivation rules. Discovery hasn't cut over to writing
 *      AssetSource directly yet (phase 2), so this keeps the table fresh
 *      for new/edited assets between backfill runs at startup.
 * The base client (_base) is reused for the history + source writes to
 * avoid a circular import.
 */

import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { normalizeManufacturer } from "./utils/manufacturerNormalize.js";
import { deriveAssetSources, type AssetSnapshot } from "./utils/assetSourceDerivation.js";

const g = globalThis as unknown as { prisma: any; _prismaBase: PrismaClient };

// Resolve the pg connection-pool size. The driver-adapter (`@prisma/adapter-pg`)
// runs queries through a `pg.Pool`, whose default `max` is 10 — undersized
// once you sum monitor workers + HTTP request handlers + background jobs at
// any meaningful asset count. `DATABASE_POOL_SIZE` lets operators raise it
// without editing code; the default of 25 is a safe step up that covers
// today's worker pool plus comfortable headroom for HTTP burst.
function resolveDatabasePoolSize(): number {
  const raw = process.env.DATABASE_POOL_SIZE;
  if (!raw) return 25;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 25;
  return n;
}

function buildBaseClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? "",
    max: resolveDatabasePoolSize(),
  });
  return new PrismaClient({ adapter });
}

// Shadow-write asset_sources from a freshly-written Asset row. Idempotent
// (per-source upsert on the (sourceKind, externalId) unique key). Best-effort:
// failures are swallowed so a transient table problem can't break the
// underlying asset write. Discovery cutover (phase 2) replaces this with
// integration-side writes.
async function shadowWriteAssetSources(base: PrismaClient, asset: any): Promise<void> {
  if (!asset?.id) return;
  const snapshot: AssetSnapshot = {
    id: String(asset.id),
    assetTag: asset.assetTag ?? null,
    tags: Array.isArray(asset.tags) ? asset.tags : [],
    discoveredByIntegrationId: asset.discoveredByIntegrationId ?? null,
    hostname: asset.hostname ?? null,
    ipAddress: asset.ipAddress ?? null,
    os: asset.os ?? null,
    osVersion: asset.osVersion ?? null,
    serialNumber: asset.serialNumber ?? null,
    manufacturer: asset.manufacturer ?? null,
    model: asset.model ?? null,
    assetType: asset.assetType ?? null,
    status: asset.status ?? null,
    learnedLocation: asset.learnedLocation ?? null,
    dnsName: asset.dnsName ?? null,
    latitude: typeof asset.latitude === "number" ? asset.latitude : null,
    longitude: typeof asset.longitude === "number" ? asset.longitude : null,
    acquiredAt: asset.acquiredAt ?? null,
    lastSeen: asset.lastSeen ?? null,
    createdBy: asset.createdBy ?? null,
  };
  const sources = deriveAssetSources(snapshot);
  if (sources.length === 0) return;
  const now = new Date();
  const seen = snapshot.lastSeen ?? now;
  for (const s of sources) {
    try {
      // The UPDATE path intentionally does NOT touch `observed` — once an
      // AssetSource row exists, its observed blob is owned by the discovery
      // path that writes the source explicitly (Phase 2). The shadow-write
      // here only refreshes metadata (assetId linkage, integrationId,
      // syncedAt, lastSeen) so it never downgrades a rich source-shaped blob
      // back to the simple tag-derived one.
      //
      // The CREATE path *does* write observed, since this is the first time
      // the row appears (e.g. a new Asset created before the discovery
      // cutover for its source kind). The next real discovery run replaces
      // it via explicit upsert.
      const updateData: Record<string, unknown> = {
        assetId: snapshot.id,
        syncedAt: now,
        lastSeen: seen,
      };
      if (!s.inferred) updateData.inferred = false;
      if (s.integrationId) updateData.integrationId = s.integrationId;

      await base.assetSource.upsert({
        where: { sourceKind_externalId: { sourceKind: s.sourceKind, externalId: s.externalId } },
        create: {
          assetId: snapshot.id,
          sourceKind: s.sourceKind,
          externalId: s.externalId,
          integrationId: s.integrationId,
          inferred: s.inferred,
          observed: s.observed as any,
          syncedAt: now,
          firstSeen: seen,
          lastSeen: seen,
        },
        update: updateData,
      });
    } catch {
      // Best-effort
    }
  }
}

// Quick gate: did the caller pass any field that affects source derivation?
// Avoids re-deriving on hot-path lastSeen / monitor-result writes.
function touchesAssetSources(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return "assetTag" in d || "tags" in d || "discoveredByIntegrationId" in d;
}

async function recordIpHistory(base: PrismaClient, assetId: string, ip: string, src: string) {
  const now = new Date();
  try {
    const existing = await base.assetIpHistory.findUnique({ where: { assetId_ip: { assetId, ip } } });
    if (existing) {
      const sourceChanged = existing.source !== src;
      await base.assetIpHistory.update({
        where: { assetId_ip: { assetId, ip } },
        data: { lastSeen: now, source: src, ...(sourceChanged ? { firstSeen: now } : {}) },
      });
    } else {
      await base.assetIpHistory.create({
        data: { assetId, ip, source: src, firstSeen: now, lastSeen: now },
      });
    }
  } catch {
    // Fire-and-forget; history is best-effort.
  }
}

/**
 * Mutate args.data.manufacturer in place if present. Handles both single
 * data shapes ({manufacturer: "x"}) and Prisma's nested set/setNull form
 * ({manufacturer: {set: "x"}}). Empty/blank string is normalized to null.
 */
function normalizeManufacturerInData(data: any): void {
  if (!data || typeof data !== "object") return;
  if (!("manufacturer" in data)) return;
  const v = data.manufacturer;
  if (v === null || v === undefined) return;
  if (typeof v === "string") {
    data.manufacturer = normalizeManufacturer(v);
    return;
  }
  if (typeof v === "object" && "set" in v && typeof v.set === "string") {
    v.set = normalizeManufacturer(v.set);
  }
}

function _buildClient(base: PrismaClient) {
  return base.$extends({
    query: {
      asset: {
        async create({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          const result = await query(args);
          const d = args.data as Record<string, unknown> | undefined;
          const ip = typeof d?.ipAddress === "string" ? d.ipAddress : undefined;
          if (ip) {
            const src = typeof d?.ipSource === "string" ? d.ipSource : "manual";
            recordIpHistory(base, (result as any).id, ip, src);
          }
          // Shadow-write asset_sources from the new row. Always fires on
          // create; on update we gate by touchesAssetSources() to skip the
          // re-derive on hot-path writes.
          shadowWriteAssetSources(base, result);
          return result;
        },
        async update({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          const result = await query(args);
          const d = args.data as Record<string, unknown> | undefined;
          const ip = typeof d?.ipAddress === "string" ? d.ipAddress : undefined;
          if (ip) {
            const src = typeof d?.ipSource === "string" ? d.ipSource : "manual";
            recordIpHistory(base, (result as any).id, ip, src);
          }
          if (touchesAssetSources(d)) {
            shadowWriteAssetSources(base, result);
          }
          return result;
        },
        async updateMany({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          // updateMany: skip shadow-write. Rare on identity fields, and the
          // backfill job sweeps any drift on next startup.
          return query(args);
        },
        async upsert({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.create);
          normalizeManufacturerInData(args?.update);
          const result = await query(args);
          const updateTouches = touchesAssetSources(args?.update);
          // Always fires after a create branch (we can't tell from the
          // result alone which branch ran, so we re-derive when the inputs
          // could have produced an identity change in either case).
          if (touchesAssetSources(args?.create) || updateTouches) {
            shadowWriteAssetSources(base, result);
          }
          return result;
        },
      },
      mibFile: {
        async create({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          return query(args);
        },
        async update({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          return query(args);
        },
        async updateMany({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          return query(args);
        },
        async upsert({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.create);
          normalizeManufacturerInData(args?.update);
          return query(args);
        },
      },
    },
  });
}

const _base: PrismaClient = g._prismaBase ?? buildBaseClient();
export const prisma: ReturnType<typeof _buildClient> = g.prisma ?? _buildClient(_base);

if (process.env.NODE_ENV !== "production") {
  g._prismaBase = _base;
  g.prisma = prisma;
}
