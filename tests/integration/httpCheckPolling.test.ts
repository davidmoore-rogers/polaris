/**
 * tests/integration/httpCheckPolling.test.ts
 *
 * Route-level contract for the `http` (HTTP Check) polling method — the two
 * halves an operator can get wrong from the UI and the API alike: which STREAM
 * the method may be attached to, and what a blank per-asset path override
 * means. Both are behaviors whose wrong version is silent (a setting that saves
 * and then never applies; an override that quietly repoints a device at "/"),
 * which is why they're pinned here rather than left to the unit tests on
 * `isMethodValidForStream` / `resolveHttpTarget`.
 *
 * Also covers the credential type's save-time validation reaching the route, so
 * an invalid regex is a 400 on the form rather than a per-probe failure.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const HOST = "http-check-polling-test";
const CRED = "http-check-polling-test-cred";
let assetId = "";

async function seedAsset(extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
  const asset = await prisma.asset.create({
    data: {
      hostname: HOST,
      assetType: "server",
      status: "active",
      ipAddress: "10.98.0.10",
      monitored: false,
      ...extra,
    } as never,
  });
  assetId = asset.id;
}

async function put(body: unknown, id = assetId) {
  const { agent, csrf } = await authedAgent(app);
  return agent.put(`/api/v1/assets/${id}`).set("X-CSRF-Token", csrf).send(body as object);
}

async function postCredential(body: unknown) {
  const { agent, csrf } = await authedAgent(app);
  return agent.post("/api/v1/credentials").set("X-CSRF-Token", csrf).send(body as object);
}

async function cleanup() {
  try {
    await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
    await prisma.credential.deleteMany({ where: { name: { startsWith: CRED } } });
  } catch { /* noop */ }
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  try { await prisma.$disconnect(); } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  await seedAsset();
});

d("PUT /assets/:id — http is a response-time-only method", () => {
  it("accepts http on responseTimePolling", async () => {
    const res = await put({ responseTimePolling: "http" });
    expect(res.status).toBe(200);
    const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { responseTimePolling: true } });
    expect(row?.responseTimePolling).toBe("http");
  });

  it("rejects http on every other stream, naming the field", async () => {
    // A silently-ignored setting reads to the operator as a broken save, which
    // is the whole reason validateAssetUpdate rejects rather than letting the
    // resolver fall through.
    for (const field of ["cpuMemoryPolling", "temperaturePolling", "interfacesPolling", "lldpPolling", "storagePolling"]) {
      const res = await put({ [field]: "http" });
      expect(res.status, field).toBe(400);
      expect(String(res.body?.error || res.text), field).toContain(field);
    }
  });
});

d("PUT /assets/:id — httpCheckPath override semantics", () => {
  it("stores a path override", async () => {
    const res = await put({ responseTimePolling: "http", httpCheckPath: "/api/ping" });
    expect(res.status).toBe(200);
    const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { httpCheckPath: true } });
    expect(row?.httpCheckPath).toBe("/api/ping");
  });

  it("a BLANK override clears to NULL, not to \"/\"", async () => {
    // NULL means "use the credential's path". Storing "" or "/" here would
    // repoint the device at the web root the moment an operator emptied the box.
    await put({ responseTimePolling: "http", httpCheckPath: "/api/ping" });
    const res = await put({ httpCheckPath: "" });
    expect(res.status).toBe(200);
    const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { httpCheckPath: true } });
    expect(row?.httpCheckPath).toBe(null);
  });

  it("whitespace-only is a clear too — a spacebar is not a path", async () => {
    await put({ responseTimePolling: "http", httpCheckPath: "/api/ping" });
    await put({ httpCheckPath: "   " });
    const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { httpCheckPath: true } });
    expect(row?.httpCheckPath).toBe(null);
  });

  it("an explicit null clears it", async () => {
    await put({ responseTimePolling: "http", httpCheckPath: "/api/ping" });
    await put({ httpCheckPath: null });
    const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { httpCheckPath: true } });
    expect(row?.httpCheckPath).toBe(null);
  });

  it("is left alone by a PUT that doesn't mention it", async () => {
    await put({ responseTimePolling: "http", httpCheckPath: "/api/ping" });
    await put({ department: "ops" });
    const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { httpCheckPath: true } });
    expect(row?.httpCheckPath).toBe("/api/ping");
  });
});

d("POST /credentials — the http type", () => {
  it("creates one with only a path and an expectation", async () => {
    const res = await postCredential({
      name: CRED, type: "http",
      config: { path: "healthz", expectBody: "OK" },
    });
    expect(res.status).toBe(201);
    const row = await prisma.credential.findUnique({ where: { name: CRED } });
    const cfg = (row?.config || {}) as Record<string, unknown>;
    // Canonicalized at save so the stored value equals the request line.
    expect(cfg.path).toBe("/healthz");
    expect(cfg.expectBody).toBe("OK");
  });

  it("creates one with no config at all — an unauthenticated GET / expecting 2xx is a valid check", async () => {
    const res = await postCredential({ name: CRED, type: "http", config: {} });
    expect(res.status).toBe(201);
  });

  it("rejects an invalid regex at save time rather than once per probe forever", async () => {
    const res = await postCredential({
      name: CRED, type: "http",
      config: { expectBody: "([unclosed", matchMode: "regex" },
    });
    expect(res.status).toBe(400);
    expect(String(res.body?.error || res.text)).toMatch(/regex/i);
  });

  it("rejects half-configured basic auth", async () => {
    const res = await postCredential({
      name: CRED, type: "http", config: { username: "monitor" },
    });
    expect(res.status).toBe(400);
  });

  it("masks the bearer token on read but never the expected content", async () => {
    // expectBody is the thing the operator must see and edit on every visit —
    // masking it would make the check un-reviewable.
    await postCredential({
      name: CRED, type: "http",
      config: { path: "/healthz", expectBody: "OK", apiToken: "supersecret" },
    });
    const { agent } = await authedAgent(app);
    const list = await agent.get("/api/v1/credentials");
    expect(list.status).toBe(200);
    const found = (list.body as Array<Record<string, unknown>>).find((c) => c.name === CRED);
    const cfg = (found?.config || {}) as Record<string, unknown>;
    expect(cfg.apiToken).not.toBe("supersecret");
    expect(cfg.expectBody).toBe("OK");
  });
});

d("POST /credentials/test — the http response comes back so the check can be tailored", () => {
  // A real loopback server, so this covers the route + probe + diagnostics path
  // end to end rather than a mock's idea of it.
  let srv: import("node:http").Server | null = null;
  let srvPort = 0;
  let testAssetId = "";

  beforeAll(async () => {
    if (!dbReachable) return;
    const { createServer } = await import("node:http");
    srv = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"state":"healthy","build":"1.2.3"}');
    });
    await new Promise<void>((resolve) => srv!.listen(0, "127.0.0.1", () => resolve()));
    srvPort = (srv!.address() as { port: number }).port;
  });

  afterAll(async () => {
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    // The test flow borrows an asset only for its host, so point one at loopback.
    const a = await prisma.asset.findFirst({ where: { hostname: HOST } });
    testAssetId = a?.id || "";
    await prisma.asset.update({ where: { id: testAssetId }, data: { ipAddress: "127.0.0.1" } });
  });

  async function runTest(config: Record<string, unknown>) {
    const { agent, csrf } = await authedAgent(app);
    return agent.post("/api/v1/credentials/test").set("X-CSRF-Token", csrf).send({
      assetId: testAssetId, type: "http", config: { port: srvPort, ...config },
    });
  }

  it("returns the status, content-type and body so a match string can be picked out of it", async () => {
    const res = await runTest({ path: "/" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const diag = res.body.httpDiagnostics;
    expect(diag).toBeTruthy();
    expect(diag.statusCode).toBe(200);
    expect(diag.contentType).toContain("application/json");
    expect(diag.excerpt).toContain('"state":"healthy"');
    // matched:null is the first-test state — nothing configured to match yet.
    expect(diag.matched).toBe(null);
  });

  it("reports the verdict once an expectation is set, so the operator can confirm the string they picked", async () => {
    const hit = await runTest({ path: "/", expectBody: "healthy" });
    expect(hit.body.httpDiagnostics.matched).toBe(true);
    const miss = await runTest({ path: "/", expectBody: "degraded" });
    expect(miss.body.httpDiagnostics.matched).toBe(false);
    expect(miss.body.success).toBe(false);
  });

  it("audits the SHAPE of the answer but never the response body", async () => {
    // The body is arbitrary device output: it would land in every pg_dump and
    // every syslog forward, and the operator who needs it is already looking at
    // it in the modal.
    await runTest({ path: "/", expectBody: "healthy" });
    const ev = await prisma.event.findFirst({
      where: { action: "credential.tested" },
      orderBy: { timestamp: "desc" },
    });
    expect(ev).toBeTruthy();
    const details = JSON.stringify(ev?.details ?? {});
    expect(details).toContain("httpStatus");
    expect(details).not.toContain("healthy");
  });

  it("other credential types carry no httpDiagnostics key at all", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/credentials/test").set("X-CSRF-Token", csrf).send({
      assetId: testAssetId, type: "restapi", config: {},
    });
    // The route reports a config-validation failure as a probe-shaped RESULT
    // rather than a 4xx, so the modal renders it inline like any other failure.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.httpDiagnostics).toBeUndefined();
  });
});

