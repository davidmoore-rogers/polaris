/**
 * tests/integration/backfillBatchSemantics.test.ts
 *
 * The two startup backfills stopped issuing one round trip per row, and each
 * now leans on a Postgres behavior worth proving rather than assuming:
 *
 *   backfillAssetSources batches a whole page into ONE createMany, so the
 *   create-only guarantee is now a per-ROW property of a MULTI-row insert:
 *   an existing (sourceKind, externalId) must be left completely untouched
 *   while the new rows beside it in the same statement still land. That
 *   guarantee is what the 2026-07-14 prod incident depends on — re-stamping
 *   existing rows clobbered ~780 fortiap observed blobs with Asset-era
 *   skeletons on every restart.
 *
 *   backfillMonitorStatusChangedAt reads the newest monitor.status_changed per
 *   asset in one query via `distinct` + resourceId-then-timestamp-desc
 *   ordering (a DISTINCT ON). If that ever returned the OLDEST event per
 *   asset, the backfill would silently seed every duration from the wrong
 *   transition.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;
const TAG = "backfill-batch-test";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup(): Promise<void> {
  await prisma.assetSource.deleteMany({ where: { externalId: { startsWith: TAG } } });
  await prisma.event.deleteMany({ where: { resourceName: TAG } });
  await prisma.asset.deleteMany({ where: { hostname: { contains: TAG, mode: "insensitive" } } });
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

d("backfill batch semantics", () => {
  it("a mixed createMany leaves the existing row's observed blob intact and still inserts the new ones", async () => {
    const asset = await prisma.asset.create({
      data: { hostname: `${TAG}-a`, assetType: "access_point", status: "active" },
    });
    // Stand in for a discovery-owned row carrying live data.
    await prisma.assetSource.create({
      data: {
        assetId: asset.id, sourceKind: "fortiap", externalId: `${TAG}-existing`,
        observed: { osVersion: "7.4.9", status: "connected" }, inferred: false,
      },
    });

    const now = new Date();
    const res = await prisma.assetSource.createMany({
      data: [
        // Same key as above, carrying the skeleton the derivation would build.
        { assetId: asset.id, sourceKind: "fortiap", externalId: `${TAG}-existing`, observed: { osVersion: "7.4.5 Build 0734" }, inferred: false, syncedAt: now, firstSeen: now, lastSeen: now },
        { assetId: asset.id, sourceKind: "manual", externalId: `${TAG}-new-1`, observed: {}, inferred: false, syncedAt: now, firstSeen: now, lastSeen: now },
        { assetId: asset.id, sourceKind: "fortiswitch", externalId: `${TAG}-new-2`, observed: {}, inferred: false, syncedAt: now, firstSeen: now, lastSeen: now },
      ],
      skipDuplicates: true,
    });

    // The conflicting row is skipped, the two new ones insert — per-row, in
    // one statement. `count` is what the job reports as "sources created".
    expect(res.count).toBe(2);
    const rows = await prisma.assetSource.findMany({
      where: { assetId: asset.id, externalId: { startsWith: TAG } },
      orderBy: { externalId: "asc" },
      select: { externalId: true, observed: true },
    });
    expect(rows.map((r) => r.externalId)).toEqual([`${TAG}-existing`, `${TAG}-new-1`, `${TAG}-new-2`]);
    // Untouched: still the live value, NOT the skeleton in the batch.
    expect((rows[0]!.observed as any).osVersion).toBe("7.4.9");
    expect((rows[0]!.observed as any).status).toBe("connected");
  });

  it("distinct on resourceId returns each asset's NEWEST status_changed event in one query", async () => {
    const a1 = await prisma.asset.create({ data: { hostname: `${TAG}-b`, assetType: "server", status: "active" } });
    const a2 = await prisma.asset.create({ data: { hostname: `${TAG}-c`, assetType: "server", status: "active" } });
    const mk = (assetId: string, iso: string, nextStatus: string) =>
      prisma.event.create({
        data: {
          action: "monitor.status_changed", resourceType: "asset", resourceId: assetId,
          resourceName: TAG, level: "info", levelRank: 0, message: "test",
          timestamp: new Date(iso), details: { nextStatus },
        },
      });
    // Deliberately inserted oldest-last so insertion order can't be what makes
    // the assertion pass.
    await mk(a1.id, "2026-09-01T10:00:00Z", "down");
    await mk(a1.id, "2026-09-01T12:00:00Z", "recovering");
    await mk(a1.id, "2026-09-01T08:00:00Z", "warning");
    await mk(a2.id, "2026-09-01T09:00:00Z", "warning");

    const rows = await prisma.event.findMany({
      where: { action: "monitor.status_changed", resourceId: { in: [a1.id, a2.id] } },
      orderBy: [{ resourceId: "asc" }, { timestamp: "desc" }],
      distinct: ["resourceId"],
      select: { resourceId: true, timestamp: true, details: true },
    });

    expect(rows.length).toBe(2);
    const byAsset = new Map(rows.map((r) => [r.resourceId, r]));
    expect((byAsset.get(a1.id)!.details as any).nextStatus).toBe("recovering");
    expect(byAsset.get(a1.id)!.timestamp.toISOString()).toBe("2026-09-01T12:00:00.000Z");
    expect((byAsset.get(a2.id)!.details as any).nextStatus).toBe("warning");
  });
});
