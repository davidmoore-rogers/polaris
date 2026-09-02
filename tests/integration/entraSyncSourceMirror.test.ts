/**
 * tests/integration/entraSyncSourceMirror.test.ts
 *
 * The Entra sync projects assets from an in-memory source map instead of a
 * per-device assetSource.findMany (one round trip per device), and skips the
 * upsert helper's cleanup deletes when that map proves they match nothing
 * (sweep hints). Both are only safe if the mirror stays byte-faithful to
 * upsertEntraIntuneSources' DB effects — which only a real Postgres round
 * trip can prove. Three paths pinned:
 *   1. steady state (same deviceId): hints skip every delete, one entra row
 *      remains, observed refreshes, the asset projects from the map.
 *   2. deviceId change via the duplicate-registration auto-resolve: the stale
 *      row is swept, the new identity lands on the same asset.
 *   3. a source stops contributing (intune dropped): the row at the current
 *      deviceId is deleted because the hint said it exists.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncEntraDevices, syncActiveDirectoryDevices } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const HOST = "ENTRA-MIRROR-T1";
const OLD_ID = "entra-mirror-old-id";
const NEW_ID = "entra-mirror-new-id";
let integrationId = "";

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
  await prisma.assetSource.deleteMany({ where: { externalId: { in: [OLD_ID, NEW_ID] } } });
  // Conflicts on our assets cascade with the asset delete; tombstones keyed by
  // integration go with the integration delete below.
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: "ENTRA-MIRROR-" } } });
  const intgs = await prisma.integration.findMany({ where: { name: "entra-mirror-test" }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "entraid", name: "entra-mirror-test", config: {}, enabled: true },
  });
  integrationId = intg.id;
});

function dev(over: Record<string, unknown> = {}) {
  return {
    sources: ["entra"] as ("entra" | "intune")[],
    deviceId: NEW_ID,
    displayName: HOST,
    operatingSystem: "Windows",
    operatingSystemVersion: "10.0.26100.1000",
    trustType: "AzureAd",
    accountEnabled: true,
    approximateLastSignInDateTime: new Date().toISOString(),
    ...over,
  } as any;
}

async function seedAsset(sourceRows: Array<{ sourceKind: string; externalId: string; lastSeen?: Date }>) {
  return prisma.asset.create({
    data: {
      hostname: HOST,
      assetType: "workstation",
      status: "active",
      tags: ["entraid"],
      sources: {
        create: sourceRows.map((s) => ({
          sourceKind: s.sourceKind,
          externalId: s.externalId,
          integrationId,
          observed: { hostname: HOST },
          inferred: false,
          lastSeen: s.lastSeen ?? new Date("2026-01-01T00:00:00Z"),
        })),
      },
    },
  });
}

d("syncEntraDevices source mirror", () => {
  it("steady state: sweep hints skip the deletes and exactly one refreshed entra row remains", async () => {
    const asset = await seedAsset([{ sourceKind: "entra", externalId: NEW_ID }]);
    const r = await syncEntraDevices(integrationId, "entra-mirror-test", {}, { devices: [dev()] });
    expect(r.updated).toContain(HOST);
    const rows = (await prisma.assetSource.findMany({ where: { assetId: asset.id } })).filter((s) => s.sourceKind === "entra" || s.sourceKind === "intune");
    expect(rows.map((s) => `${s.sourceKind}|${s.externalId}`)).toEqual([`entra|${NEW_ID}`]);
    // The observed blob refreshed from the device (the mirror fed the same
    // blob to the projection that the DB row now carries).
    expect((rows[0]!.observed as any).deviceId).toBe(NEW_ID);
    expect((rows[0]!.observed as any).kind).toBe("entra");
    const after = await prisma.asset.findUnique({ where: { id: asset.id }, select: { hostname: true, os: true } });
    expect(after?.hostname).toBe(HOST);
    // The map-fed projection reached the asset write intact — and rule 28's
    // normalizeWindowsOs then derived the family from build 26100 (>= 22000).
    expect(after?.os).toBe("Windows 11");
  });

  it("deviceId change: the duplicate-registration resolve sweeps the stale row and lands the new identity", async () => {
    const asset = await seedAsset([{ sourceKind: "entra", externalId: OLD_ID, lastSeen: new Date("2026-01-01T00:00:00Z") }]);
    const r = await syncEntraDevices(integrationId, "entra-mirror-test", {}, { devices: [dev()] });
    expect(r.skipped.length + r.updated.length + r.created.length).toBeGreaterThan(0);
    const rows = (await prisma.assetSource.findMany({ where: { assetId: asset.id }, orderBy: { externalId: "asc" } })).filter((s) => s.sourceKind === "entra" || s.sourceKind === "intune");
    expect(rows.map((s) => `${s.sourceKind}|${s.externalId}`)).toEqual([`entra|${NEW_ID}`]);
    // No second asset was minted for the new deviceId.
    const assets = await prisma.asset.findMany({ where: { hostname: HOST }, select: { id: true } });
    expect(assets.map((a) => a.id)).toEqual([asset.id]);
  });

  it("a source that stops contributing is deleted at the current deviceId (intune dropped)", async () => {
    const asset = await seedAsset([
      { sourceKind: "entra", externalId: NEW_ID },
      { sourceKind: "intune", externalId: NEW_ID },
    ]);
    await syncEntraDevices(integrationId, "entra-mirror-test", {}, { devices: [dev({ sources: ["entra"] })] });
    const rows = (await prisma.assetSource.findMany({ where: { assetId: asset.id } })).filter((s) => s.sourceKind === "entra" || s.sourceKind === "intune");
    expect(rows.map((s) => `${s.sourceKind}|${s.externalId}`)).toEqual([`entra|${NEW_ID}`]);
  });

  it("AD sync: the map-fed projection matches the refreshed row (same mirror, simpler cascade)", async () => {
    const GUID = "ad-mirror-guid-1";
    const asset = await seedAsset([{ sourceKind: "ad", externalId: GUID }]);
    await prisma.assetSource.updateMany({ where: { externalId: GUID }, data: { observed: { objectSid: "S-1-5-21-1" } } });
    const r = await syncActiveDirectoryDevices(integrationId, "entra-mirror-test", {}, {
      devices: [{
        objectGuid: GUID,
        objectSid: "S-1-5-21-1",
        cn: HOST,
        dnsHostName: `${HOST.toLowerCase()}.corp.example.com`,
        distinguishedName: `CN=${HOST},OU=Workstations,DC=corp`,
        operatingSystem: "Windows 10 Pro",
        operatingSystemVersion: "10.0 (26100)",
        description: "",
        disabled: false,
        ouPath: "OU=Workstations",
      }],
    });
    await prisma.assetSource.deleteMany({ where: { externalId: GUID } }); // cleanup key not in the shared list
    expect(r.updated.length).toBe(1);
    const after = await prisma.asset.findUnique({ where: { id: asset.id }, select: { hostname: true, learnedLocation: true, dnsName: true } });
    // hostname/learnedLocation came through the in-memory map's refreshed ad
    // row: FQDN preferred for hostname, ouPath as the learned location.
    expect(after?.hostname).toBe(`${HOST.toLowerCase()}.corp.example.com`);
    expect(after?.learnedLocation).toBe("OU=Workstations");
    expect(after?.dnsName).toBe(`${HOST.toLowerCase()}.corp.example.com`);
  });
});
