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
 *   4. Asset update/upsert writes that stage `hostname` without touching
 *      `hostnameOverride` are checked against the row's operator hostname
 *      override and rewritten to it when set — discovery projection writes
 *      can never clobber an operator pin. Writes staging `ipAddress` without
 *      touching `ipOverride` get the same guard with discovery-gets-a-vote
 *      semantics (enforceOperatorOverrides): a staged IP equal to the
 *      override releases the pin in the same write; a different staged IP is
 *      rewritten back to the override and an ip-override Conflict is raised
 *      (fire-and-forget, via ipOverrideService) for the operator to resolve.
 * The base client (_base) is reused for the history + source writes to
 * avoid a circular import.
 */

import { randomUUID } from "node:crypto";

import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { normalizeManufacturer } from "./utils/manufacturerNormalize.js";
import { applyHostnameOverride, applyIpOverride, type IpOverrideOutcome } from "./utils/assetInvariants.js";
import { deriveAssetSources, type AssetSnapshot } from "./utils/assetSourceDerivation.js";

// Lazy-resolved to break the import cycle (dnsResolvedReservationService imports
// `prisma` from this file). The hooks below only invoke the service at runtime,
// not at module init, so a top-of-file dynamic import on first call is safe.
let _dnsResolvedSvcPromise: Promise<typeof import("./services/dnsResolvedReservationService.js")> | null = null;
function getDnsResolvedSvc() {
  if (!_dnsResolvedSvcPromise) {
    _dnsResolvedSvcPromise = import("./services/dnsResolvedReservationService.js");
  }
  return _dnsResolvedSvcPromise;
}
function fireDnsResolvedReconcile(assetId: string | undefined): void {
  if (!assetId) return;
  // Best-effort, fire-and-forget. Failures are swallowed inside the service.
  void (async () => {
    try {
      const svc = await getDnsResolvedSvc();
      await svc.reconcileDnsResolvedForAsset(assetId);
    } catch {
      /* swallowed — reconcile is best-effort */
    }
  })();
}
async function fireDnsResolvedRelease(assetId: string | undefined): Promise<void> {
  if (!assetId) return;
  try {
    const svc = await getDnsResolvedSvc();
    await svc.releaseDnsResolvedForAsset(assetId);
  } catch {
    // Best-effort — never block the delete.
  }
}

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
  // Single SQL upsert. Previously this was a findUnique-then-update-or-create
  // pair (two DB round-trips per Asset write that touched ipAddress). The
  // INSERT ... ON CONFLICT form below does the same work in one round-trip,
  // including the "reset firstSeen when source changes" logic via a CASE in
  // the UPDATE branch — discovery often re-asserts the same IP from the same
  // source, and the new statement reads as identical to the old behavior in
  // every case.
  //
  // The id column uses Prisma's @default(uuid()) which is generated client-
  // side; with raw SQL we generate it ourselves via node:crypto. The
  // generated UUID is only used when the row doesn't exist (CONFLICT path
  // ignores VALUES on the id column).
  //
  // Fire-and-forget — history is best-effort and the caller doesn't await.
  const now = new Date().toISOString();
  try {
    await base.$executeRawUnsafe(
      `INSERT INTO "asset_ip_history" ("id", "assetId", "ip", "source", "firstSeen", "lastSeen")
       VALUES ($1, $2, $3, $4, $5::timestamp, $5::timestamp)
       ON CONFLICT ("assetId", "ip") DO UPDATE SET
         "lastSeen" = EXCLUDED."lastSeen",
         "source" = EXCLUDED."source",
         "firstSeen" = CASE
           WHEN "asset_ip_history"."source" <> EXCLUDED."source" THEN EXCLUDED."firstSeen"
           ELSE "asset_ip_history"."firstSeen"
         END`,
      randomUUID(),
      assetId,
      ip,
      src,
      now,
    );
  } catch {
    // Best-effort; swallow errors so a transient DB issue can't break the
    // underlying Asset write.
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

/**
 * Mutate args.data in place to enforce the "decommissioned/disabled assets
 * are not monitored" invariant. Whenever a write sets status to one of those
 * terminal-ish values, monitored is forced false and consecutiveFailures is
 * reset (matching the assets PUT route's existing behavior on manual disable
 * via validateMonitorConfig). Re-activation is left alone — flipping back to
 * "active" doesn't auto-resume monitoring; that's the operator's choice.
 *
 * Centralized here so every write path benefits: the assets PUT route, the
 * decommissionStaleAssets job, the integration FortiSwitch/FortiAP sweep,
 * and the Entra/AD syncs that flip status="disabled" on disabled accounts.
 */
function clampMonitoredForStatus(data: any): void {
  if (!data || typeof data !== "object") return;
  if (!("status" in data)) return;
  const v = data.status;
  let status: unknown = null;
  if (typeof v === "string") status = v;
  else if (v && typeof v === "object" && "set" in v) status = (v as any).set;
  if (status !== "decommissioned" && status !== "disabled") return;
  data.monitored = false;
  data.consecutiveFailures = 0;
}

/**
 * Result of the pre-write override enforcement, handed back so the hook can
 * fire the IP-override follow-ups (conflict raise / release audit) only
 * AFTER the guarded write actually lands.
 */
interface OperatorOverrideOutcome {
  ip: IpOverrideOutcome;
  /** The ipSource the writer originally staged, captured before the
   *  re-assertion rewrote it to "manual" — conflict provenance. */
  stagedIpSource: string | null;
}

/**
 * Enforce the operator overrides (Asset.hostnameOverride / Asset.ipOverride)
 * on a pending update/upsert. Centralized here (like clampMonitoredForStatus)
 * so every discovery projection write path — integrations, agents, FMG
 * service, merge/split endpoints — respects the pins without each writer
 * knowing about them. The row read only fires when the write stages
 * `hostname` WITHOUT touching `hostnameOverride` and/or `ipAddress` WITHOUT
 * touching `ipOverride` (the operator set/clear paths are authoritative), so
 * the monitor hot paths (probe results, lastSeen bumps) never pay it;
 * hostname/IP-carrying writes are discovery-cadence, where the extra indexed
 * point read is in the same budget as the drift-detection reads that already
 * follow them — and both pins share the single read. updateMany is
 * deliberately not guarded — no current writer stages hostname or ipAddress
 * through it (re-verified 2026-07); add the guard if one appears.
 *
 * The hostname pin is absolute (always re-asserted). The IP pin gives
 * discovery a vote via applyIpOverride: matching IP → the pin is released in
 * this same write; different IP → re-asserted, and the returned outcome
 * tells the hook to raise an ip-override Conflict once the write lands.
 *
 * Best-effort: a failed read skips the rewrite rather than failing the write.
 * Self-healing — projection re-stages the fields every discovery cycle, so
 * the next guarded write re-applies the pins.
 */
async function enforceOperatorOverrides(
  base: PrismaClient,
  where: unknown,
  data: unknown,
): Promise<OperatorOverrideOutcome | null> {
  const d = data as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object") return null;
  const guardHostname = "hostname" in d && !("hostnameOverride" in d);
  const guardIp = "ipAddress" in d && !("ipOverride" in d);
  if (!guardHostname && !guardIp) return null;
  try {
    const row = await base.asset.findFirst({
      where: where as any,
      select: { hostnameOverride: true, ipOverride: true },
    });
    if (guardHostname) applyHostnameOverride(d, row?.hostnameOverride);
    if (guardIp) {
      const srcRaw = d.ipSource;
      const stagedIpSource =
        typeof srcRaw === "string"
          ? srcRaw
          : (srcRaw && typeof srcRaw === "object" && typeof (srcRaw as any).set === "string" ? (srcRaw as any).set : null);
      const ip = applyIpOverride(d, row?.ipOverride);
      if (ip.action !== "none") return { ip, stagedIpSource };
    }
  } catch {
    // Best-effort — see doc comment.
  }
  return null;
}

// Fire-and-forget follow-ups for the IP-override guard, lazily importing the
// service to break the import cycle (ipOverrideService imports `prisma` from
// this file) — same pattern as the dns_resolved reconcile above. Failures are
// logged and swallowed inside the service.
function fireIpOverrideFollowUp(outcome: OperatorOverrideOutcome, assetId: string | undefined): void {
  if (!assetId) return;
  void (async () => {
    try {
      const svc = await import("./services/ipOverrideService.js");
      if (outcome.ip.action === "released") {
        await svc.handleIpOverrideReleased(assetId, outcome.ip.ip);
      } else if (outcome.ip.action === "reasserted" && outcome.ip.discoveredIp) {
        // A staged clear (discoveredIp null) is not a disagreement — the pin
        // was re-asserted silently, no conflict.
        await svc.raiseIpOverrideConflict(assetId, outcome.ip.discoveredIp, outcome.stagedIpSource);
      }
    } catch {
      /* swallowed — follow-up is best-effort */
    }
  })();
}

function _buildClient(base: PrismaClient) {
  return base.$extends({
    query: {
      asset: {
        async create({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          clampMonitoredForStatus(args?.data);
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
          // dns_resolved reservation auto-reconcile (fire-and-forget).
          fireDnsResolvedReconcile((result as any)?.id);
          return result;
        },
        async update({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          clampMonitoredForStatus(args?.data);
          const overrideOutcome = await enforceOperatorOverrides(base, args?.where, args?.data);
          const result = await query(args);
          if (overrideOutcome) fireIpOverrideFollowUp(overrideOutcome, (result as any)?.id);
          const d = args.data as Record<string, unknown> | undefined;
          const ip = typeof d?.ipAddress === "string" ? d.ipAddress : undefined;
          if (ip) {
            const src = typeof d?.ipSource === "string" ? d.ipSource : "manual";
            recordIpHistory(base, (result as any).id, ip, src);
          }
          if (touchesAssetSources(d)) {
            shadowWriteAssetSources(base, result);
          }
          // Only re-run the dns_resolved reconcile when the write could have
          // changed eligibility: ipAddress / status / hostname / dnsName /
          // macAddress. Skips the hot monitor-result path that writes only
          // lastMonitorAt / monitorStatus / counters.
          if (
            d && (
              "ipAddress" in d || "status" in d || "hostname" in d ||
              "dnsName" in d || "macAddress" in d
            )
          ) {
            fireDnsResolvedReconcile((result as any)?.id);
          }
          return result;
        },
        async updateMany({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          clampMonitoredForStatus(args?.data);
          // updateMany: skip shadow-write. Rare on identity fields, and the
          // backfill job sweeps any drift on next startup. Same logic for the
          // dns_resolved reconcile — the periodic job catches drift.
          return query(args);
        },
        async upsert({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.create);
          normalizeManufacturerInData(args?.update);
          clampMonitoredForStatus(args?.create);
          clampMonitoredForStatus(args?.update);
          // Create branch needs no guard — a brand-new row can't carry an
          // override; the read is a no-op miss when the row doesn't exist.
          const overrideOutcome = await enforceOperatorOverrides(base, args?.where, args?.update);
          const result = await query(args);
          if (overrideOutcome) fireIpOverrideFollowUp(overrideOutcome, (result as any)?.id);
          const updateTouches = touchesAssetSources(args?.update);
          // Always fires after a create branch (we can't tell from the
          // result alone which branch ran, so we re-derive when the inputs
          // could have produced an identity change in either case).
          if (touchesAssetSources(args?.create) || updateTouches) {
            shadowWriteAssetSources(base, result);
          }
          // Conservative: always re-run reconcile after upsert — we don't
          // know which branch ran and the eligibility-relevant fields are
          // likely to be present in at least one of create/update.
          fireDnsResolvedReconcile((result as any)?.id);
          return result;
        },
        async delete({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          // Release any owned dns_resolved reservations BEFORE the delete
          // cascades so we still have the asset's hostname/MAC to find them.
          const id = typeof args?.where?.id === "string" ? args.where.id : undefined;
          await fireDnsResolvedRelease(id);
          return query(args);
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
