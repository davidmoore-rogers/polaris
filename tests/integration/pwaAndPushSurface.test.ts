/**
 * tests/integration/pwaAndPushSurface.test.ts
 *
 * The PWA install surface + the push-subscription `surface` dimension:
 *   - GET /manifest.webmanifest is reachable WITHOUT a session (a
 *     <link rel="manifest"> is fetched with credentials omitted, so a gated
 *     manifest would 401 for every caller) and is generated from branding
 *   - GET /icons/:file honors the ICON_SPECS allowlist and 404s everything
 *     else — an operator-supplied size would let resvg allocate an
 *     unbounded canvas
 *   - the deleted static public/manifest.json really is gone, which also
 *     proves the route mount precedes express.static
 *   - POST /push-subscriptions records `surface`, and the rotation path
 *     (oldEndpoint) carries it forward WITHOUT letting one user touch
 *     another user's subscription row
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable, ensureTestUser, authedAgent } from "./_helpers.js";
import { hashPassword } from "../../src/utils/password.js";

const d = dbDescribe;

const OTHER_USERNAME = "polaris-pwa-other-user";
const EP = (s: string) => `https://push.example.com/ep/${s}`;

function pngDims(buf: Buffer) {
  return {
    sig: buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    w: buf.readUInt32BE(16),
    h: buf.readUInt32BE(20),
  };
}

let otherUserId = "";
/**
 * Snapshot of any web_push channel that existed before this suite ran.
 *
 * These tests must create and delete the singleton to exercise first-enable,
 * but that keypair is not disposable state: every PushSubscription in the DB is
 * signed against it, so wiping it permanently kills every enrolled device
 * (regenerating produces DIFFERENT keys). Running the suite against a dev
 * database you actually use would silently break push on every browser and
 * phone you'd enrolled — which is exactly what happened once. Restore it.
 */
let preExistingWebPush: { id: string; name: string; enabled: boolean; config: unknown; createdBy: string | null } | null = null;

beforeAll(async () => {
  if (!dbReachable) return;
  const existing = await prisma.notificationChannel.findFirst({ where: { type: "web_push" } });
  preExistingWebPush = existing
    ? { id: existing.id, name: existing.name, enabled: existing.enabled, config: existing.config, createdBy: existing.createdBy }
    : null;
  await ensureTestUser();
  const role = await prisma.role.findUnique({ where: { name: "admin" } });
  const other = await prisma.user.upsert({
    where: { username: OTHER_USERNAME },
    update: {},
    create: {
      username: OTHER_USERNAME,
      passwordHash: await hashPassword("unused-password-for-fixture"),
      roleId: role!.id,
      authProvider: "local",
    },
  });
  otherUserId = other.id;
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.pushSubscription.deleteMany({ where: { endpoint: { startsWith: "https://push.example.com/ep/" } } });
  await prisma.user.deleteMany({ where: { username: OTHER_USERNAME } });
  await prisma.setting.deleteMany({ where: { key: "branding" } });
  // Put the operator's channel back, keypair intact, so a run against a dev DB
  // doesn't silently invalidate every enrolled device.
  await prisma.notificationChannel.deleteMany({ where: { type: "web_push" } });
  if (preExistingWebPush) {
    await prisma.notificationChannel.create({
      data: {
        id: preExistingWebPush.id,
        name: preExistingWebPush.name,
        type: "web_push",
        enabled: preExistingWebPush.enabled,
        config: preExistingWebPush.config as any,
        createdBy: preExistingWebPush.createdBy,
      },
    });
  }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.pushSubscription.deleteMany({ where: { endpoint: { startsWith: "https://push.example.com/ep/" } } });
});

d("GET /manifest.webmanifest", () => {
  it("is served without a session and describes the MOBILE app", async () => {
    // No agent: a plain unauthenticated request, which is how the browser
    // fetches a <link rel="manifest"> with no crossorigin attribute.
    const res = await request(app).get("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/manifest+json");
    expect(res.body.id).toBe("/mobile.html");
    expect(res.body.start_url).toBe("/mobile.html");
    expect(res.body.scope).toBe("/");
    expect(res.body.display).toBe("standalone");
  });

  it("takes its name from branding", async () => {
    await prisma.setting.upsert({
      where: { key: "branding" },
      update: { value: { appName: "Rogers Group NetOps", subtitle: "IP + asset management", logoUrl: "/logo.png" } },
      create: { key: "branding", value: { appName: "Rogers Group NetOps", subtitle: "IP + asset management", logoUrl: "/logo.png" } },
    });
    const res = await request(app).get("/manifest.webmanifest");
    expect(res.body.name).toBe("Rogers Group NetOps");
    expect(res.body.description).toBe("IP + asset management");
    expect(String(res.body.short_name).length).toBeLessThanOrEqual(12);
    await prisma.setting.deleteMany({ where: { key: "branding" } });
  });

  it("revalidates with an ETag rather than being uncacheable", async () => {
    const first = await request(app).get("/manifest.webmanifest");
    expect(first.headers["cache-control"]).toContain("no-cache");
    const etag = first.headers["etag"];
    expect(etag).toBeTruthy();
    const second = await request(app).get("/manifest.webmanifest").set("If-None-Match", etag);
    expect(second.status).toBe(304);
  });

  it("no longer serves the deleted static manifest.json", async () => {
    // Also proves the pwa router is mounted BEFORE express.static.
    const res = await request(app).get("/manifest.json");
    expect(res.status).toBe(404);
  });
});

d("GET /icons/:file", () => {
  it("renders each allowlisted icon at its declared pixel size", async () => {
    for (const [name, size] of [["app-192", 192], ["app-512", 512], ["app-maskable-192", 192], ["app-apple-180", 180]] as const) {
      const res = await request(app).get(`/icons/${name}.png`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status, name).toBe(200);
      expect(res.headers["content-type"], name).toContain("image/png");
      const { sig, w, h } = pngDims(res.body as Buffer);
      expect(sig, name).toBe(true);
      expect([w, h], name).toEqual([size, size]);
    }
  });

  it("caches versioned URLs forever and bare URLs briefly", async () => {
    const manifest = await request(app).get("/manifest.webmanifest");
    const version = String(manifest.body.icons[0].src).split("?v=")[1];

    const versioned = await request(app).get(`/icons/app-192.png?v=${version}`);
    expect(versioned.headers["cache-control"]).toContain("immutable");

    // sw.js references the bare path — it can't know the current version.
    const bare = await request(app).get("/icons/app-192.png");
    expect(bare.headers["cache-control"]).toBe("public, max-age=300");
  });

  it("404s anything outside the allowlist", async () => {
    for (const path of [
      "/icons/app-999.png",        // not a spec — an unbounded size is a memory DoS
      "/icons/app-192.txt",        // wrong extension
      "/icons/app-192",            // no extension
      "/icons/%2E%2E%2Fmanifest",  // traversal-ish
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
    }
  });
});

d("Web Push as an on/off capability", () => {
  beforeEach(async () => {
    await prisma.notificationChannel.deleteMany({ where: { type: "web_push" } });
  });

  it("reports not-configured before anything is set up", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/delivery-channels/web-push").expect(200);
    // Proves the literal path isn't swallowed by the "/:id" route below it.
    expect(res.body).toMatchObject({ enabled: false, configured: false, channelId: null });
  });

  it("enabling creates the channel AND generates the keypair in one call", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf)
      .send({ enabled: true }).expect(200);
    expect(res.body).toMatchObject({ enabled: true, configured: true });
    expect(res.body.channelId).toBeTruthy();

    // The operator never had to think about VAPID; clients can now enroll.
    const key = await agent.get("/api/v1/push-subscriptions/key").expect(200);
    expect(key.body.enabled).toBe(true);
    expect(String(key.body.publicKey).length).toBeGreaterThan(80);
  });

  it("is idempotent", async () => {
    const { agent, csrf } = await authedAgent(app);
    const a = await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf).send({ enabled: true }).expect(200);
    const b = await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf).send({ enabled: true }).expect(200);
    expect(b.body.channelId).toBe(a.body.channelId);
    expect(await prisma.notificationChannel.count({ where: { type: "web_push" } })).toBe(1);
  });

  it("disabling KEEPS the keypair so enrolled devices survive a re-enable", async () => {
    // The load-bearing one: every PushSubscription is signed against this
    // keypair. Dropping it on disable would silently invalidate every enrolled
    // device and force the whole fleet to re-enroll.
    const { agent, csrf } = await authedAgent(app);
    await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf).send({ enabled: true }).expect(200);
    const before = (await agent.get("/api/v1/push-subscriptions/key")).body.publicKey;

    await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf).send({ enabled: false }).expect(200);
    // While disabled, clients correctly hide their push controls.
    expect((await agent.get("/api/v1/push-subscriptions/key")).body.enabled).toBe(false);
    // The row and its keys are still there.
    expect(await prisma.notificationChannel.count({ where: { type: "web_push" } })).toBe(1);

    await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf).send({ enabled: true }).expect(200);
    expect((await agent.get("/api/v1/push-subscriptions/key")).body.publicKey).toBe(before);
  });

  it("counts enrolled devices so the toggle isn't feedback-free", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf).send({ enabled: true }).expect(200);
    await agent.post("/api/v1/push-subscriptions").set("X-CSRF-Token", csrf)
      .send({ endpoint: EP("counted"), keys: { p256dh: "k", auth: "a" }, surface: "mobile" }).expect(204);

    const res = await agent.get("/api/v1/delivery-channels/web-push").expect(200);
    expect(res.body.subscriberCount).toBeGreaterThanOrEqual(1);
  });

  it("rejects a non-boolean body", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf).send({ enabled: "yes" }).expect(400);
  });

  it("stays selectable by the automation builder", async () => {
    // The UI hides it from the channel CARDS, but a Notify action must still be
    // able to target it — that's how an operator picks who gets a push.
    const { agent, csrf } = await authedAgent(app);
    await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf).send({ enabled: true }).expect(200);
    const res = await agent.get("/api/v1/delivery-channels").expect(200);
    expect(res.body.channels.some((c: any) => c.type === "web_push")).toBe(true);
  });
});

d("Web Push self-test", () => {
  beforeEach(async () => {
    await prisma.notificationChannel.deleteMany({ where: { type: "web_push" } });
  });

  it("refuses when Web Push is turned off", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/delivery-channels/web-push/test").set("X-CSRF-Token", csrf).expect(400);
    expect(String(res.body.error)).toMatch(/turned off/i);
  });

  it("explains itself when the caller has no enrolled device", async () => {
    // The likeliest real case: an admin enables push, hits Test, and has not
    // yet turned it on in their own browser. That must be actionable, not a
    // silent no-op.
    const { agent, csrf } = await authedAgent(app);
    await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf).send({ enabled: true }).expect(200);
    await prisma.pushSubscription.deleteMany({});
    const res = await agent.post("/api/v1/delivery-channels/web-push/test").set("X-CSRF-Token", csrf).expect(400);
    expect(String(res.body.error)).toMatch(/no push-enabled devices/i);
  });

  it("prunes a dead subscription rather than reporting a bare failure", async () => {
    // The endpoint below isn't a real push service, so the send fails. What
    // matters is that a fabricated/expired endpoint doesn't linger forever.
    const { agent, csrf } = await authedAgent(app);
    await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf).send({ enabled: true }).expect(200);
    await agent.post("/api/v1/push-subscriptions").set("X-CSRF-Token", csrf)
      .send({ endpoint: EP("dead"), keys: { p256dh: "bm90LWEtcmVhbC1rZXk", auth: "bm90LXJlYWw" }, surface: "desktop" })
      .expect(204);

    const res = await agent.post("/api/v1/delivery-channels/web-push/test").set("X-CSRF-Token", csrf).expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.sent).toBe(0);
    expect(res.body.failed).toBeGreaterThan(0);
    expect(typeof res.body.message).toBe("string");
  });

  it("never reaches another user's devices", async () => {
    // A "test" that can notify arbitrary people is a nuisance vector.
    const { agent, csrf } = await authedAgent(app);
    await agent.put("/api/v1/delivery-channels/web-push").set("X-CSRF-Token", csrf).send({ enabled: true }).expect(200);
    await prisma.pushSubscription.deleteMany({});
    await prisma.pushSubscription.create({
      data: { userId: otherUserId, endpoint: EP("someone-else"), p256dh: "k", auth: "a", surface: "mobile" },
    });
    // Caller owns nothing → 400, and the other user's row is untouched.
    await agent.post("/api/v1/delivery-channels/web-push/test").set("X-CSRF-Token", csrf).expect(400);
    expect(await prisma.pushSubscription.findUnique({ where: { endpoint: EP("someone-else") } })).not.toBeNull();
  });
});

d("recipient reachability", () => {
  it("reports each user's enrolled device count so the builder can warn", async () => {
    const { agent, csrf } = await authedAgent(app);
    await prisma.pushSubscription.deleteMany({});
    await agent.post("/api/v1/push-subscriptions").set("X-CSRF-Token", csrf)
      .send({ endpoint: EP("reach"), keys: { p256dh: "k", auth: "a" }, surface: "desktop" }).expect(204);

    const res = await agent.get("/api/v1/automations/recipient-users").expect(200);
    const users: any[] = res.body.users ?? res.body;
    expect(Array.isArray(users)).toBe(true);
    // Every user carries the field, so the builder can flag the zeroes.
    for (const u of users) expect(typeof u.pushDevices).toBe("number");
    const other = users.find((u) => u.id === otherUserId);
    expect(other?.pushDevices).toBe(0);
    expect(users.some((u) => u.pushDevices > 0)).toBe(true);
  });
});

d("POST /push-subscriptions — surface + rotation", () => {
  it("defaults to desktop and records an explicit mobile surface", async () => {
    const { agent, csrf } = await authedAgent(app);

    await agent.post("/api/v1/push-subscriptions").set("X-CSRF-Token", csrf)
      .send({ endpoint: EP("plain"), keys: { p256dh: "k1", auth: "a1" } })
      .expect(204);
    await agent.post("/api/v1/push-subscriptions").set("X-CSRF-Token", csrf)
      .send({ endpoint: EP("mob"), keys: { p256dh: "k2", auth: "a2" }, surface: "mobile" })
      .expect(204);

    const plain = await prisma.pushSubscription.findUnique({ where: { endpoint: EP("plain") } });
    const mob = await prisma.pushSubscription.findUnique({ where: { endpoint: EP("mob") } });
    expect(plain?.surface).toBe("desktop"); // pre-upgrade clients keep working
    expect(mob?.surface).toBe("mobile");
  });

  it("carries surface forward across a rotation and retires the old row", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent.post("/api/v1/push-subscriptions").set("X-CSRF-Token", csrf)
      .send({ endpoint: EP("old"), keys: { p256dh: "k", auth: "a" }, surface: "mobile" })
      .expect(204);

    // What sw.js's pushsubscriptionchange handler sends: a brand-new endpoint
    // plus the one it replaced. No `surface` — the SW doesn't know it.
    await agent.post("/api/v1/push-subscriptions").set("X-CSRF-Token", csrf)
      .send({ endpoint: EP("new"), keys: { p256dh: "k", auth: "a" }, oldEndpoint: EP("old") })
      .expect(204);

    expect(await prisma.pushSubscription.findUnique({ where: { endpoint: EP("old") } })).toBeNull();
    const fresh = await prisma.pushSubscription.findUnique({ where: { endpoint: EP("new") } });
    expect(fresh?.surface).toBe("mobile");
  });

  it("ignores an oldEndpoint owned by a DIFFERENT user", async () => {
    // The security property: oldEndpoint is caller-supplied, so it must never
    // read or delete a row the caller doesn't own.
    await prisma.pushSubscription.create({
      data: { userId: otherUserId, endpoint: EP("victim"), p256dh: "k", auth: "a", surface: "mobile" },
    });

    const { agent, csrf } = await authedAgent(app);
    await agent.post("/api/v1/push-subscriptions").set("X-CSRF-Token", csrf)
      .send({ endpoint: EP("attacker"), keys: { p256dh: "k", auth: "a" }, oldEndpoint: EP("victim") })
      .expect(204);

    // The other user's row survives untouched...
    const victim = await prisma.pushSubscription.findUnique({ where: { endpoint: EP("victim") } });
    expect(victim).not.toBeNull();
    expect(victim?.userId).toBe(otherUserId);
    expect(victim?.surface).toBe("mobile");
    // ...and its surface was NOT inherited.
    const attacker = await prisma.pushSubscription.findUnique({ where: { endpoint: EP("attacker") } });
    expect(attacker?.surface).toBe("desktop");
  });

  it("rejects an unknown surface value", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent.post("/api/v1/push-subscriptions").set("X-CSRF-Token", csrf)
      .send({ endpoint: EP("bad"), keys: { p256dh: "k", auth: "a" }, surface: "tablet" })
      .expect(400);
  });
});
