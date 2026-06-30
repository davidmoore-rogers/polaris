/**
 * tests/integration/dashboardNocToken.test.ts
 *
 * Covers the bearer-token scope gate on GET /api/v1/dashboard/noc-summary.
 * The no-login NOC kiosk authenticates with an API token carrying the
 * `dashboard:read` scope; the handler grants such a token the asset- and
 * event-sourced sections it otherwise resolves from a session role snapshot
 * (which token callers don't have). A token WITHOUT the scope still gets a
 * 200 with the shape intact but every section empty (filter-don't-403).
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { createToken } from "../../src/services/apiTokenService.js";

const d = dbDescribe;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.apiToken.deleteMany();
  await prisma.asset.deleteMany();
  // One monitored, down, non-suppressed firewall — surfaces in statusCounts.down
  // and downNodes when (and only when) the caller is granted the asset section.
  await prisma.asset.create({
    data: {
      hostname: "down-fw-01",
      assetType: "firewall",
      status: "active",
      monitored: true,
      monitorStatus: "down",
    },
  });
});

async function mintToken(scopes: string[]): Promise<string> {
  const { rawToken } = await createToken({
    name: `noc-kiosk-test-${scopes.join("_")}`,
    scopes,
    createdBy: "integration-test",
  });
  return rawToken;
}

d("GET /api/v1/dashboard/noc-summary — bearer token scope gate", () => {
  it("a dashboard:read token gets populated asset-sourced sections", async () => {
    const raw = await mintToken(["dashboard:read"]);
    const res = await request(app)
      .get("/api/v1/dashboard/noc-summary")
      .set("Authorization", `Bearer ${raw}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("statusCounts");
    expect(res.body.statusCounts.down).toBeGreaterThanOrEqual(1);
    expect(res.body.activeAlertCount).toBeGreaterThanOrEqual(1);
    expect(res.body.downNodes.map((n: { hostname: string }) => n.hostname)).toContain("down-fw-01");
  });

  it("a dashboard:read token can read /filter-options (types + regions)", async () => {
    const raw = await mintToken(["dashboard:read"]);
    const res = await request(app)
      .get("/api/v1/dashboard/filter-options")
      .set("Authorization", `Bearer ${raw}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assetTypes)).toBe(true);
    expect(res.body.assetTypes).toContain("firewall"); // the seeded down-fw-01
    expect(Array.isArray(res.body.regions)).toBe(true);
  });

  it("a token without dashboard:read gets the shape but empty sections", async () => {
    const raw = await mintToken(["assets:read"]);
    const res = await request(app)
      .get("/api/v1/dashboard/noc-summary")
      .set("Authorization", `Bearer ${raw}`);

    expect(res.status).toBe(200);
    expect(res.body.statusCounts).toEqual({
      total: 0, up: 0, down: 0, warning: 0, unknown: 0, recovering: 0,
    });
    expect(res.body.activeAlertCount).toBe(0);
    expect(res.body.downNodes).toEqual([]);
    expect(res.body.sitesWithIssues).toEqual([]);
  });
});
