/**
 * tests/integration/assetHostnameDiscovered.test.ts
 *
 * `hostnameDiscovered` on the asset list + detail payloads — the discovery-
 * projected hostname the assets-page Hostname cell prints under an
 * operator-pinned one.
 *
 * The interesting part is that it is NOT a column: `Asset.hostnameOverride`
 * makes the pinned value the effective `hostname`, so the discovered name is
 * recoverable only from the `AssetSource.observed` blobs. These tests pin
 * through the real PUT route (rather than writing `hostnameOverride` directly)
 * so the pin + the projection stay in the same relationship the UI creates,
 * and assert the three "print nothing" cases the frontend relies on.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany();
});

/**
 * An asset with one AD source claiming `dnsHostName`, projected onto the Asset
 * row the way discovery leaves it.
 */
async function seedDiscovered(dnsHostName: string): Promise<string> {
  const asset = await prisma.asset.create({
    data: { hostname: dnsHostName, assetType: "workstation", status: "active" },
  });
  await prisma.assetSource.create({
    data: {
      assetId: asset.id,
      sourceKind: "ad",
      externalId: "ad-guid:" + asset.id,
      observed: { dnsHostName },
    },
  });
  return asset.id;
}

/** Pin (or, with "", clear) an asset's hostname through the real edit route. */
async function putHostname(id: string, hostname: string) {
  const { agent, csrf } = await authedAgent(app);
  return agent.put("/api/v1/assets/" + id).set("X-CSRF-Token", csrf).send({ hostname });
}

d("GET /api/v1/assets — hostnameDiscovered", () => {
  it("names the discovered hostname on a pinned row, on both list and detail", async () => {
    const id = await seedDiscovered("WKS-OLD.corp.local");
    const { agent } = await authedAgent(app);

    const put = await putHostname(id, "reception-pc");
    expect(put.status).toBe(200);
    expect(put.body.hostname).toBe("reception-pc");
    expect(put.body.hostnameOverride).toBe("reception-pc");

    const list = await agent.get("/api/v1/assets?limit=100");
    expect(list.status).toBe(200);
    const row = (list.body.assets as Array<Record<string, unknown>>).find((a) => a.id === id);
    expect(row?.hostname).toBe("reception-pc");
    expect(row?.hostnameOverride).toBe("reception-pc");
    expect(row?.hostnameDiscovered).toBe("WKS-OLD.corp.local");

    const detail = await agent.get("/api/v1/assets/" + id);
    expect(detail.status).toBe(200);
    expect(detail.body.hostnameDiscovered).toBe("WKS-OLD.corp.local");
  });

  it("tracks what discovery says NOW, not what it said when the pin was typed", async () => {
    const id = await seedDiscovered("WKS-OLD.corp.local");
    const { agent } = await authedAgent(app);
    await putHostname(id, "reception-pc");

    // A later discovery cycle renames the device at the source. The pin keeps
    // the Asset row on "reception-pc" (the db.ts guard), and the sub-line is
    // expected to follow the source.
    await prisma.assetSource.updateMany({
      where: { assetId: id, sourceKind: "ad" },
      data: { observed: { dnsHostName: "WKS-NEW.corp.local" } },
    });

    const list = await agent.get("/api/v1/assets?limit=100");
    const row = (list.body.assets as Array<Record<string, unknown>>).find((a) => a.id === id);
    expect(row?.hostname).toBe("reception-pc");
    expect(row?.hostnameDiscovered).toBe("WKS-NEW.corp.local");
  });

  it("is null on an unpinned row, and on a pinned row with no discovery opinion", async () => {
    // Unpinned but discovered — nothing is being overridden, so no second line.
    const discovered = await seedDiscovered("plain-pc.corp.local");
    // Manually created (no sources at all), then pinned: there IS no original.
    const manual = await prisma.asset.create({
      data: { hostname: "hand-made", assetType: "server", status: "active" },
    });
    const { agent } = await authedAgent(app);
    const put = await putHostname(manual.id, "hand-made-2");
    expect(put.body.hostnameOverride).toBe("hand-made-2");

    const list = await agent.get("/api/v1/assets?limit=100");
    const rows = list.body.assets as Array<Record<string, unknown>>;
    expect(rows.find((a) => a.id === discovered)?.hostnameDiscovered).toBeNull();
    expect(rows.find((a) => a.id === manual.id)?.hostnameDiscovered).toBeNull();
  });

  it("clearing the pin drops the second line and restores the discovered name", async () => {
    const id = await seedDiscovered("WKS-OLD.corp.local");
    const { agent } = await authedAgent(app);
    await putHostname(id, "reception-pc");

    const cleared = await putHostname(id, "");
    expect(cleared.status).toBe(200);
    expect(cleared.body.hostnameOverride).toBeNull();
    expect(cleared.body.hostname).toBe("WKS-OLD.corp.local");

    const list = await agent.get("/api/v1/assets?limit=100");
    const row = (list.body.assets as Array<Record<string, unknown>>).find((a) => a.id === id);
    expect(row?.hostnameDiscovered).toBeNull();
  });
});
