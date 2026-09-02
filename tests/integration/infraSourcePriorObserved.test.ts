/**
 * tests/integration/infraSourcePriorObserved.test.ts
 *
 * `upsertFortinetInfraAssetSource` carries the PREVIOUS scrape's osVersion
 * forward when the incoming blob has none ("absent ≠ wipe") — a managed AP or
 * switch legitimately reports no usable firmware string mid-rejoin, and
 * blanking it is the 2026-07-14 prod incident where ~780 fortiap rows lost
 * their live os_version on every restart.
 *
 * It used to read that previous blob back from the DB per device. The Fortinet
 * discovery loops now hand it in from their fleet-wide source preload, so this
 * pins that the supplied path produces the SAME row as the read path — the
 * whole point being that a wrong or missing prior is invisible until someone
 * looks at a firmware column.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { upsertFortinetInfraAssetSource } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const HOST = "INFRA-PRIOR-AP-1";
const SERIAL = "INFRA-PRIOR-SN-1";
let assetId = "";
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
  await prisma.assetSource.deleteMany({ where: { externalId: SERIAL } });
  await prisma.asset.deleteMany({ where: { hostname: { contains: "INFRA-PRIOR", mode: "insensitive" } } });
  await prisma.integration.deleteMany({ where: { name: "infra-prior-test" } });
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "fortimanager", name: "infra-prior-test", config: {}, enabled: true },
  });
  integrationId = intg.id;
  const asset = await prisma.asset.create({
    data: { hostname: HOST, assetType: "access_point", status: "active" },
  });
  assetId = asset.id;
});

/** Lay down the "previous scrape" row carrying a real firmware string. */
async function seedPrior(osVersion: string) {
  await prisma.assetSource.deleteMany({ where: { externalId: SERIAL } });
  await prisma.assetSource.create({
    data: {
      assetId, sourceKind: "fortiap", externalId: SERIAL, integrationId,
      observed: { kind: "fortiap", osVersion, name: HOST }, inferred: false,
    },
  });
}

const storedOsVersion = async () =>
  ((await prisma.assetSource.findUnique({
    where: { sourceKind_externalId: { sourceKind: "fortiap", externalId: SERIAL } },
    select: { observed: true },
  }))!.observed as any).osVersion;

d("upsertFortinetInfraAssetSource — osVersion carry-forward", () => {
  it("carries the prior version forward when the caller SUPPLIES it (no DB read)", async () => {
    await seedPrior("7.4.9");
    const now = new Date();
    await upsertFortinetInfraAssetSource(
      "fortiap", assetId, integrationId, SERIAL,
      { kind: "fortiap", osVersion: "", name: HOST }, now, now, "infra-prior-test",
      // What the loops' preload hands in.
      { kind: "fortiap", osVersion: "7.4.9", name: HOST },
    );
    expect(await storedOsVersion()).toBe("7.4.9");
  });

  it("produces the same row as the DB-read path when the caller omits it", async () => {
    await seedPrior("7.4.9");
    const now = new Date();
    await upsertFortinetInfraAssetSource(
      "fortiap", assetId, integrationId, SERIAL,
      { kind: "fortiap", osVersion: "", name: HOST }, now, now, "infra-prior-test",
      // omitted → reads the row itself, the pre-change behavior
    );
    expect(await storedOsVersion()).toBe("7.4.9");
  });

  it("an explicit null prior means no such row — nothing to carry, and no blanking of a real incoming version", async () => {
    const now = new Date();
    await upsertFortinetInfraAssetSource(
      "fortiap", assetId, integrationId, SERIAL,
      { kind: "fortiap", osVersion: "7.6.1", name: HOST }, now, now, "infra-prior-test",
      null,
    );
    expect(await storedOsVersion()).toBe("7.6.1");
  });

  it("a real incoming version always wins over the prior", async () => {
    await seedPrior("7.4.9");
    const now = new Date();
    await upsertFortinetInfraAssetSource(
      "fortiap", assetId, integrationId, SERIAL,
      { kind: "fortiap", osVersion: "7.6.2", name: HOST }, now, now, "infra-prior-test",
      { kind: "fortiap", osVersion: "7.4.9", name: HOST },
    );
    expect(await storedOsVersion()).toBe("7.6.2");
  });

  it("clears the phantom manual row the shadow-write mints on a new device", async () => {
    // No need to fabricate it: the db.ts shadow-write mints
    // `manual|<assetId>` off the asset.create in beforeEach, because this
    // asset carries no recognized source tag — which is exactly why the
    // delete inside the helper is LIVE cleanup and not a spent migration.
    //
    // It is written UNAWAITED (shadowWriteAssetSources is best-effort and
    // fire-and-forget), so wait for it rather than assuming it has landed —
    // reading immediately is racy, and a fabricated stand-in collides with it
    // on the (sourceKind, externalId) unique constraint.
    let seeded: string[] = [];
    for (let i = 0; i < 40 && !seeded.includes("manual"); i++) {
      seeded = (await prisma.assetSource.findMany({ where: { assetId }, select: { sourceKind: true } }))
        .map((s) => s.sourceKind);
      if (!seeded.includes("manual")) await new Promise((r) => setTimeout(r, 25));
    }
    expect(seeded).toContain("manual");
    const now = new Date();
    await upsertFortinetInfraAssetSource(
      "fortiap", assetId, integrationId, SERIAL,
      { kind: "fortiap", osVersion: "7.6.1", name: HOST }, now, now, "infra-prior-test", null,
    );
    const kinds = (await prisma.assetSource.findMany({ where: { assetId }, select: { sourceKind: true } }))
      .map((s) => s.sourceKind);
    expect(kinds).not.toContain("manual");
    expect(kinds).toContain("fortiap");
  });
});
