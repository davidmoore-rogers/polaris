/**
 * tests/integration/sightingSettingsRoute.test.ts — route-order regression
 *
 * GET|PUT /assets/sighting-settings were registered BELOW the parameterized
 * /assets/:id handlers from the day they shipped, so Express captured the
 * literal as id="sighting-settings" and both verbs answered 404 "Asset not
 * found" — unreachable until 2026-09-02 (found while authoring the /api
 * docs; nothing in the UI calls them, so only external API callers hit it).
 * This suite pins the fix: the literals answer as themselves, not as an
 * asset lookup.
 */

import { it, expect, beforeAll } from "vitest";
import { app } from "../../src/app.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
});

d("GET|PUT /assets/sighting-settings — not shadowed by /:id", () => {
  it("GET answers the settings shape, not 'Asset not found'", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/assets/sighting-settings");
    expect(res.status).toBe(200);
    expect(typeof res.body.sightingMaxAgeDays).toBe("number");
  });

  it("PUT round-trips a value and GET reads it back", async () => {
    const { agent, csrf } = await authedAgent(app);
    const put = await agent
      .put("/api/v1/assets/sighting-settings")
      .set("X-CSRF-Token", csrf)
      .send({ sightingMaxAgeDays: 181 });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ sightingMaxAgeDays: 181 });

    const read = await agent.get("/api/v1/assets/sighting-settings");
    expect(read.body.sightingMaxAgeDays).toBe(181);

    // Restore the default so the shared test DB isn't left drifted.
    await agent
      .put("/api/v1/assets/sighting-settings")
      .set("X-CSRF-Token", csrf)
      .send({ sightingMaxAgeDays: 180 });
  });

  it("PUT rejects an out-of-range value at the schema layer", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .put("/api/v1/assets/sighting-settings")
      .set("X-CSRF-Token", csrf)
      .send({ sightingMaxAgeDays: 9999 });
    expect(res.status).toBe(400);
  });
});
