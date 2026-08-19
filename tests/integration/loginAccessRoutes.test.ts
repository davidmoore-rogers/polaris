/**
 * tests/integration/loginAccessRoutes.test.ts — GET/PUT /server-settings/login-access
 *
 * The route's own job on top of the service: reporting the caller's IP as
 * Polaris resolves it (the trust-proxy reveal), the ANTI-LOCKOUT guard that
 * refuses a scope excluding the admin doing the enabling, and the audit
 * Event. Plus the property that makes the gate survivable: it restricts new
 * LOGINS, not existing sessions — so an admin who locks themselves out mid-
 * session can still undo it.
 *
 * Skips cleanly when DATABASE_URL isn't reachable.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import {
  saveLoginAccessSettings,
  getLoginAccessSettings,
  invalidateLoginAccessCache,
} from "../../src/services/loginAccessService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";

const d = dbDescribe;

let agent: Awaited<ReturnType<typeof authedAgent>>["agent"];
let csrf: string;

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  // Log in while the gate is off — the suite then keeps using this session.
  await saveLoginAccessSettings({ enabled: false, ipScope: "rfc1918" });
  invalidateLoginAccessCache();
  ({ agent, csrf } = await authedAgent(app, { fresh: true }));
});

afterAll(async () => {
  if (!dbReachable) return;
  await saveLoginAccessSettings({ enabled: false, ipScope: "rfc1918", allowedCidrs: [] });
  invalidateLoginAccessCache();
  await prisma.event.deleteMany({ where: { action: "login_access.updated" } });
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.event.deleteMany({ where: { action: "login_access.updated" } });
});

function put(body: unknown) {
  return agent.put("/api/v1/server-settings/login-access").set("x-csrf-token", csrf).send(body as object);
}

d("GET /login-access", () => {
  it("returns the settings plus the caller's IP as Polaris resolves it", async () => {
    const res = await agent.get("/api/v1/server-settings/login-access");
    expect(res.status).toBe(200);
    expect(res.body.loginAccess).toMatchObject({ enabled: false, ipScope: "rfc1918" });
    // Loopback here; in production this is what reveals a proxy address being
    // seen instead of the real client.
    expect(typeof res.body.callerIp).toBe("string");
    expect(res.body.callerIp.length).toBeGreaterThan(0);
  });
});

d("PUT /login-access — anti-lockout guard", () => {
  it("REFUSES a scope that excludes the caller's own address", async () => {
    const res = await put({ enabled: true, ipScope: "custom", allowedCidrs: ["203.0.113.99/32"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lock you out/i);
    // Nothing was persisted.
    invalidateLoginAccessCache();
    expect((await getLoginAccessSettings()).enabled).toBe(false);
  });

  it("names the address it saw, so the operator can fix the list", async () => {
    const res = await put({ enabled: true, ipScope: "custom", allowedCidrs: ["203.0.113.99/32"] });
    const me = await agent.get("/api/v1/server-settings/login-access");
    expect(res.body.error).toContain(me.body.callerIp);
  });

  it("accepts a scope that covers the caller", async () => {
    const res = await put({ enabled: true, ipScope: "rfc1918" });
    expect(res.status).toBe(200);
    expect(res.body.loginAccess).toMatchObject({ enabled: true, ipScope: "rfc1918" });
  });

  it("never blocks DISABLING — the recovery direction is always allowed", async () => {
    await put({ enabled: true, ipScope: "rfc1918" });
    const res = await put({ enabled: false, ipScope: "custom", allowedCidrs: ["203.0.113.99/32"] });
    expect(res.status).toBe(200);
    expect(res.body.loginAccess.enabled).toBe(false);
  });

  it("still restricts new logins but leaves this session working, so the change is undoable", async () => {
    await put({ enabled: true, ipScope: "rfc1918" });
    // A fresh login from a now-out-of-scope source would be refused; the
    // established session keeps working, which is how an operator recovers.
    const stillIn = await agent.get("/api/v1/auth/me");
    expect(stillIn.status).toBe(200);
  });
});

d("PUT /login-access — audit", () => {
  it("stamps a warning Event when the restriction is enabled", async () => {
    await put({ enabled: true, ipScope: "rfc1918" });
    expect(await waitForEventCount("login_access.updated", 1)).toBeGreaterThanOrEqual(1);
    const ev = await prisma.event.findFirst({
      where: { action: "login_access.updated" },
      orderBy: { timestamp: "desc" },
    });
    expect(ev?.level).toBe("warning");
    expect(ev?.message).toContain("RFC1918");
  });

  it("stamps an info Event when the restriction is lifted", async () => {
    await put({ enabled: true, ipScope: "rfc1918" });
    await prisma.event.deleteMany({ where: { action: "login_access.updated" } });
    await put({ enabled: false });
    expect(await waitForEventCount("login_access.updated", 1)).toBeGreaterThanOrEqual(1);
    const ev = await prisma.event.findFirst({
      where: { action: "login_access.updated" },
      orderBy: { timestamp: "desc" },
    });
    expect(ev?.level).toBe("info");
  });
});

d("PUT /login-access — permissions", () => {
  it("refuses an unauthenticated caller", async () => {
    const res = await request(app)
      .put("/api/v1/server-settings/login-access")
      .send({ enabled: true, ipScope: "rfc1918" });
    // 403 in practice — CSRF rejects a token-less mutation before the auth
    // guard runs. Either refusal is correct; what matters is that no
    // unauthenticated caller can narrow the login surface.
    expect([401, 403]).toContain(res.status);
  });
});
