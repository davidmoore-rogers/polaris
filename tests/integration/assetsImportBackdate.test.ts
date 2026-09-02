/**
 * tests/integration/assetsImportBackdate.test.ts
 *
 * POST /assets/import backdates Asset.createdAt ("first seen") from a
 * serial+date spreadsheet. It resolves every serial in one read and applies
 * the backdates in chunked transactions, where it used to run a findFirst per
 * row and an update per match — ~4000 serialized queries on a 2000-row import,
 * on the request most likely to hit a proxy timeout.
 *
 * The endpoint had no coverage at all, and it MUTATES createdAt, so what's
 * pinned here is the contract rather than the batching: a date must only ever
 * move first-seen EARLIER, dryRun must write nothing, unknown serials are
 * counted rather than failing the import, and unparseable rows are skipped.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const SERIAL = "IMPORT-TEST-SN-1";
const HOST = "IMPORT-BACKDATE-1";
const ORIGINAL = new Date("2026-06-01T00:00:00Z");

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { contains: "IMPORT-BACKDATE", mode: "insensitive" } } });
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.asset.create({
    data: { hostname: HOST, serialNumber: SERIAL, assetType: "server", status: "active", createdAt: ORIGINAL },
  });
});

const firstSeen = async () =>
  (await prisma.asset.findFirst({ where: { serialNumber: SERIAL }, select: { createdAt: true } }))!.createdAt;

d("POST /api/v1/assets/import", () => {
  it("backdates first-seen to an earlier date", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent.post("/api/v1/assets/import").set("X-CSRF-Token", csrf)
      .send({ rows: [{ serialNumber: SERIAL, date: "2026-01-15" }] });
    expect(resp.status).toBe(200);
    expect(resp.body.updated).toBe(1);
    expect(resp.body.notFound).toBe(0);
    expect(resp.body.preview[0].willUpdate).toBe(true);
    expect((await firstSeen()).toISOString()).toBe(new Date("2026-01-15").toISOString());
  });

  it("never moves first-seen LATER", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent.post("/api/v1/assets/import").set("X-CSRF-Token", csrf)
      .send({ rows: [{ serialNumber: SERIAL, date: "2026-09-01" }] });
    expect(resp.status).toBe(200);
    expect(resp.body.updated).toBe(0);
    // Still previewed — the operator sees the row and why it was skipped.
    expect(resp.body.preview[0].willUpdate).toBe(false);
    expect((await firstSeen()).toISOString()).toBe(ORIGINAL.toISOString());
  });

  it("dryRun previews without writing", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent.post("/api/v1/assets/import").set("X-CSRF-Token", csrf)
      .send({ rows: [{ serialNumber: SERIAL, date: "2026-01-15" }], dryRun: true });
    expect(resp.status).toBe(200);
    expect(resp.body.dryRun).toBe(true);
    expect(resp.body.preview[0].willUpdate).toBe(true);
    expect((await firstSeen()).toISOString()).toBe(ORIGINAL.toISOString());
  });

  it("counts unknown serials and skips unparseable rows without failing the import", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent.post("/api/v1/assets/import").set("X-CSRF-Token", csrf)
      .send({ rows: [
        { serialNumber: SERIAL, date: "2026-02-02" },
        { serialNumber: "NO-SUCH-SERIAL-XYZ", date: "2026-02-02" },
        { serialNumber: SERIAL, date: "not-a-date" },
        { serialNumber: "", date: "2026-02-02" },
      ] });
    expect(resp.status).toBe(200);
    expect(resp.body.updated).toBe(1);
    expect(resp.body.notFound).toBe(1);
    // Only the one resolvable, parseable row is previewed.
    expect(resp.body.preview).toHaveLength(1);
    expect((await firstSeen()).toISOString()).toBe(new Date("2026-02-02").toISOString());
  });
});
