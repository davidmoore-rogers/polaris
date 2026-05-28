/**
 * tests/integration/agent-cert-pins.test.ts
 *
 * Phase 2 dual-pin: covers /server-settings/agents/cert-pins/* routes against
 * a seeded ManagedAgent fleet. Skips cleanly when DATABASE_URL is unreachable.
 *
 * Workflow exercised end-to-end:
 *   1. Seed 3 active agents, all with the same canonical pin.
 *   2. GET /summary returns one entry: { pin: canonical, canonical: 3, staged: 0 }.
 *   3. POST /bulk-add with a new staged pin: each agent gets it appended.
 *   4. GET /summary now shows two entries (canonical=3, staged=3 for new).
 *   5. POST /bulk-add with the SAME staged pin is idempotent (alreadyPresent=3).
 *   6. POST /bulk-remove of the canonical pin PROMOTES the staged pin to
 *      canonical on every agent (lastPinSkipped=0 because there's a replacement).
 *   7. POST /bulk-remove of the only-remaining pin SKIPS every agent
 *      (lastPinSkipped=3, removed=0).
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const CANON =   "sha256:" + "a".repeat(64);
const STAGED =  "sha256:" + "b".repeat(64);
const STAGED2 = "sha256:" + "c".repeat(64);

const d = dbDescribe;

let assetIds: string[] = [];

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  try { await prisma.$disconnect(); } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  // Wipe + reseed three active agents with the same canonical pin.
  await prisma.managedAgent.deleteMany({});
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: "cert-pin-test-" } } });
  assetIds = [];
  for (let i = 0; i < 3; i++) {
    const asset = await prisma.asset.create({
      data: {
        hostname:    `cert-pin-test-${i}`,
        assetType:   "server",
        status:      "active",
        ipAddress:   `10.99.0.${10 + i}`,
        monitored:   true,
      },
    });
    assetIds.push(asset.id);
    await prisma.managedAgent.create({
      data: {
        assetId:                          asset.id,
        osPlatform:                       "linux",
        arch:                             "amd64",
        installStatus:                    "active",
        installedBy:                      "test",
        serverCertFingerprint:            CANON,
        additionalServerCertFingerprints: [],
      },
    });
  }
});

d("Agent cert-pin rotation routes", () => {
  it("GET /summary returns one entry per distinct pin with canonical/staged counts", async () => {
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/server-settings/agents/cert-pins/summary");
    expect(resp.status).toBe(200);
    expect(resp.body.totalActiveAgents).toBe(3);
    expect(resp.body.pins).toHaveLength(1);
    expect(resp.body.pins[0]).toEqual({ pin: CANON, canonical: 3, staged: 0 });
  });

  it("POST /bulk-add stages a new pin on every active agent", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .post("/api/v1/server-settings/agents/cert-pins/bulk-add")
      .set("X-CSRF-Token", csrf)
      .send({ pin: STAGED });
    expect(resp.status).toBe(200);
    expect(resp.body.added).toBe(3);
    expect(resp.body.alreadyPresent).toBe(0);

    // Database reflects the change.
    const rows = await prisma.managedAgent.findMany({
      select: { serverCertFingerprint: true, additionalServerCertFingerprints: true },
    });
    for (const r of rows) {
      expect(r.serverCertFingerprint).toBe(CANON);
      expect(r.additionalServerCertFingerprints).toEqual([STAGED]);
    }

    // Summary now shows two pins.
    const sumResp = await agent.get("/api/v1/server-settings/agents/cert-pins/summary");
    expect(sumResp.body.pins).toHaveLength(2);
    const stagedEntry = sumResp.body.pins.find((p: any) => p.pin === STAGED);
    expect(stagedEntry).toEqual({ pin: STAGED, canonical: 0, staged: 3 });
  });

  it("POST /bulk-add is idempotent when the pin is already present", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent
      .post("/api/v1/server-settings/agents/cert-pins/bulk-add")
      .set("X-CSRF-Token", csrf)
      .send({ pin: STAGED });
    const resp = await agent
      .post("/api/v1/server-settings/agents/cert-pins/bulk-add")
      .set("X-CSRF-Token", csrf)
      .send({ pin: STAGED });
    expect(resp.status).toBe(200);
    expect(resp.body.added).toBe(0);
    expect(resp.body.alreadyPresent).toBe(3);
  });

  it("POST /bulk-remove of the canonical pin PROMOTES the staged pin to canonical", async () => {
    const { agent, csrf } = await authedAgent(app);
    // Stage first.
    await agent
      .post("/api/v1/server-settings/agents/cert-pins/bulk-add")
      .set("X-CSRF-Token", csrf)
      .send({ pin: STAGED });

    // Retire the canonical.
    const resp = await agent
      .post("/api/v1/server-settings/agents/cert-pins/bulk-remove")
      .set("X-CSRF-Token", csrf)
      .send({ pin: CANON });
    expect(resp.status).toBe(200);
    expect(resp.body.removed).toBe(3);
    expect(resp.body.lastPinSkipped).toBe(0);

    // Promotion: staged is now canonical, additional is empty.
    const rows = await prisma.managedAgent.findMany({
      select: { serverCertFingerprint: true, additionalServerCertFingerprints: true },
    });
    for (const r of rows) {
      expect(r.serverCertFingerprint).toBe(STAGED);
      expect(r.additionalServerCertFingerprints).toEqual([]);
    }
  });

  it("POST /bulk-remove of the LAST pin on every agent is skipped (would orphan)", async () => {
    const { agent, csrf } = await authedAgent(app);
    // All agents have just the canonical pin (no additional). Try to remove it.
    const resp = await agent
      .post("/api/v1/server-settings/agents/cert-pins/bulk-remove")
      .set("X-CSRF-Token", csrf)
      .send({ pin: CANON });
    expect(resp.status).toBe(200);
    expect(resp.body.removed).toBe(0);
    expect(resp.body.lastPinSkipped).toBe(3);

    // Database unchanged.
    const rows = await prisma.managedAgent.findMany({
      select: { serverCertFingerprint: true },
    });
    for (const r of rows) {
      expect(r.serverCertFingerprint).toBe(CANON);
    }
  });

  it("POST /bulk-remove of a pin not present reports notPresent and changes nothing", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .post("/api/v1/server-settings/agents/cert-pins/bulk-remove")
      .set("X-CSRF-Token", csrf)
      .send({ pin: STAGED2 });
    expect(resp.status).toBe(200);
    expect(resp.body.removed).toBe(0);
    expect(resp.body.notPresent).toBe(3);
  });

  it("POST /bulk-add rejects a malformed pin with 400", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .post("/api/v1/server-settings/agents/cert-pins/bulk-add")
      .set("X-CSRF-Token", csrf)
      .send({ pin: "not-a-sha256-pin" });
    expect(resp.status).toBe(400);
  });
});
