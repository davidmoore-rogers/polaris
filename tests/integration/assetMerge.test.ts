/**
 * tests/integration/assetMerge.test.ts
 *
 * Covers POST /api/v1/assets/:id/merge (operator-driven asset merge — the
 * inverse of the per-source Split). Skips cleanly when DATABASE_URL is
 * unreachable; see tests/integration/_helpers.ts.
 *
 * Exercised:
 *   1. survivor="this" — the :id asset survives, the other is absorbed:
 *      both assets' AssetSource rows end up on the survivor, MAC/IP history
 *      transfers, tags union, blank-fill default + an explicit fieldWinner
 *      both apply, the absorbed asset is deleted, an asset.merged Event lands.
 *   2. survivor="other" — direction flips: the :id asset is the one deleted.
 *   3. self-merge → 400.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const HOST_PREFIX = "merge-test-";

async function wipe() {
  // AssetSource / MAC / IP rows cascade with their asset; deleting the assets
  // is enough. Sources are keyed globally unique on (sourceKind, externalId),
  // so also clear any test source kinds left from a half-run.
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST_PREFIX } } });
  await prisma.assetSource.deleteMany({ where: { externalId: { startsWith: HOST_PREFIX } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  try { await wipe(); } catch { /* noop */ }
  try { await prisma.$disconnect(); } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await wipe();
});

// Create asset A (survivor candidate) + asset B (absorb candidate) with
// distinct sources, MACs and tags so every transfer path is observable.
// Each asset's assetTag matches its nested source row: the db.ts shadow-write
// extension derives AssetSource rows from assetTag on every asset.create, and
// without a recognized prefix it synthesizes an extra "manual" fallback source
// (fire-and-forget, so also racy) that would skew movedSources / source lists.
async function seedPair() {
  const a = await prisma.asset.create({
    data: {
      hostname:     `${HOST_PREFIX}a`,
      assetTag:     `ad:${HOST_PREFIX}ad-a`,
      assetType:    "workstation",
      status:       "active",
      ipAddress:    "10.50.0.10",
      manufacturer: "Dell",
      monitored:    true,
      tags:         ["activedirectory"],
      sources: {
        create: { sourceKind: "ad", externalId: `${HOST_PREFIX}ad-a`, observed: {} },
      },
      macAddressRows: { create: { mac: "AA:AA:AA:AA:AA:AA", source: "ad" } },
    },
  });
  const b = await prisma.asset.create({
    data: {
      hostname:     `${HOST_PREFIX}b`,
      assetTag:     `entra:${HOST_PREFIX}entra-b`,
      assetType:    "workstation",
      status:       "active",
      serialNumber: "SN-FROM-B",
      monitored:    false,
      tags:         ["entraid", "intune"],
      sources: {
        create: { sourceKind: "entra", externalId: `${HOST_PREFIX}entra-b`, observed: {} },
      },
      macAddressRows: { create: { mac: "BB:BB:BB:BB:BB:BB", source: "entra" } },
    },
  });
  return { a, b };
}

d("POST /assets/:id/merge — behavior", () => {
  it("survivor=this absorbs the other asset, combining sources + history", async () => {
    if (!dbReachable) return;
    const { a, b } = await seedPair();
    const { agent, csrf } = await authedAgent(app);

    const resp = await agent
      .post(`/api/v1/assets/${a.id}/merge`)
      .set("X-CSRF-Token", csrf)
      .send({
        otherAssetId: b.id,
        survivor: "this",
        // serialNumber differs (A empty, B set) — blank-fill default would
        // fill it anyway, but pin it explicitly to exercise the winner path.
        fieldWinners: { serialNumber: "other" },
      })
      .set("Content-Type", "application/json");

    expect(resp.status).toBe(200);
    expect(resp.body.survivorId).toBe(a.id);
    expect(resp.body.absorbedId).toBe(b.id);
    expect(resp.body.movedSources).toBe(1);
    expect(resp.body.movedMacs).toBe(1);

    // Absorbed asset is gone.
    expect(await prisma.asset.findUnique({ where: { id: b.id } })).toBeNull();

    // Survivor now owns both sources.
    const sources = await prisma.assetSource.findMany({ where: { assetId: a.id } });
    expect(sources.map((s) => s.sourceKind).sort()).toEqual(["ad", "entra"]);

    // Field winner applied; tags unioned; MAC transferred.
    const survivor = await prisma.asset.findUnique({
      where: { id: a.id },
      include: { macAddressRows: true },
    });
    expect(survivor?.serialNumber).toBe("SN-FROM-B");
    expect((survivor?.tags ?? []).sort()).toEqual(["activedirectory", "entraid", "intune"]);
    expect(survivor?.macAddressRows.map((m) => m.mac).sort()).toEqual([
      "AA:AA:AA:AA:AA:AA",
      "BB:BB:BB:BB:BB:BB",
    ]);

    // Event written.
    const ev = await prisma.event.findFirst({
      where: { action: "asset.merged", resourceId: a.id },
      orderBy: { timestamp: "desc" },
    });
    expect(ev).not.toBeNull();
  });

  it("survivor=other flips the direction (the :id asset is the one deleted)", async () => {
    if (!dbReachable) return;
    const { a, b } = await seedPair();
    const { agent, csrf } = await authedAgent(app);

    const resp = await agent
      .post(`/api/v1/assets/${a.id}/merge`)
      .set("X-CSRF-Token", csrf)
      .send({ otherAssetId: b.id, survivor: "other" })
      .set("Content-Type", "application/json");

    expect(resp.status).toBe(200);
    expect(resp.body.survivorId).toBe(b.id);
    expect(resp.body.absorbedId).toBe(a.id);
    expect(await prisma.asset.findUnique({ where: { id: a.id } })).toBeNull();

    const sources = await prisma.assetSource.findMany({ where: { assetId: b.id } });
    expect(sources.map((s) => s.sourceKind).sort()).toEqual(["ad", "entra"]);
  });

  it("rejects merging an asset into itself", async () => {
    if (!dbReachable) return;
    const { a } = await seedPair();
    const { agent, csrf } = await authedAgent(app);

    const resp = await agent
      .post(`/api/v1/assets/${a.id}/merge`)
      .set("X-CSRF-Token", csrf)
      .send({ otherAssetId: a.id })
      .set("Content-Type", "application/json");

    expect(resp.status).toBe(400);
  });
});
