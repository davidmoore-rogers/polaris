/**
 * tests/integration/loginAccessGate.test.ts — local login source-IP gate
 *
 * End-to-end over the real app: the /login.html page half (unauthorized
 * sources are DROPPED, not answered) and the credential-endpoint half (same
 * generic 401 a wrong password gets, plus a warning Event naming the source).
 * Also the invariant that makes the feature safe to enable: SSO entry points
 * are never gated, so an SSO-only fleet keeps working from anywhere.
 *
 * Source simulation follows entraProxyLogin.test.ts: the suite runs without
 * trust proxy, so req.ip is always the loopback socket peer. "Allowed" = a
 * scope covering loopback (rfc1918); "blocked" = a custom scope listing only
 * a TEST-NET address. Skips cleanly when DATABASE_URL isn't reachable.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import {
  saveLoginAccessSettings,
  invalidateLoginAccessCache,
} from "../../src/services/loginAccessService.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;

async function setScope(
  enabled: boolean,
  ipScope: "rfc1918" | "all" | "custom",
  allowedCidrs: string[] = [],
): Promise<void> {
  await saveLoginAccessSettings({ enabled, ipScope, allowedCidrs });
  invalidateLoginAccessCache();
}

/** Blocked: loopback is outside a custom list holding only a TEST-NET address. */
const BLOCK_LOOPBACK = () => setScope(true, "custom", ["203.0.113.99/32"]);

beforeAll(async () => {
  if (!dbReachable) return;
  await setScope(false, "rfc1918");
});

afterAll(async () => {
  if (!dbReachable) return;
  await setScope(false, "rfc1918");
  await prisma.event.deleteMany({ where: { action: "auth.login.blocked_source" } });
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.event.deleteMany({ where: { action: "auth.login.blocked_source" } });
});

d("disabled (the default)", () => {
  it("serves the login page to any source", async () => {
    await setScope(false, "rfc1918");
    const res = await request(app).get("/login.html");
    expect(res.status).toBe(200);
  });

  it("lets a credential POST reach the login handler", async () => {
    await setScope(false, "rfc1918");
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: "nobody-login-access-test", password: "wrong" });
    expect(res.status).toBe(401);
    // Reached the handler, so the refusal was the credential check, not the gate.
    const blocked = await prisma.event.count({ where: { action: "auth.login.blocked_source" } });
    expect(blocked).toBe(0);
  });
});

d("enabled, source allowed", () => {
  it("serves the login page from an in-scope source", async () => {
    await setScope(true, "rfc1918"); // loopback counts as private
    const res = await request(app).get("/login.html");
    expect(res.status).toBe(200);
  });

  it("does not block the credential POST", async () => {
    await setScope(true, "rfc1918");
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: "nobody-login-access-test", password: "wrong" });
    expect(res.status).toBe(401);
    const blocked = await prisma.event.count({ where: { action: "auth.login.blocked_source" } });
    expect(blocked).toBe(0);
  });
});

d("enabled, source blocked", () => {
  it("DROPS the login page request rather than answering it", async () => {
    await BLOCK_LOOPBACK();
    // The socket is destroyed with no response — supertest surfaces that as a
    // transport error. A 403 here would confirm the surface exists.
    await expect(request(app).get("/login.html")).rejects.toBeTruthy();
  });

  it("refuses the credential POST with the SAME generic 401 a wrong password gets", async () => {
    await BLOCK_LOOPBACK();
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: "nobody-login-access-test", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid username or password");
  });

  it("writes a warning Event naming the source", async () => {
    await BLOCK_LOOPBACK();
    await request(app)
      .post("/api/v1/auth/login")
      .send({ username: "nobody-login-access-test", password: "wrong" });
    // The gate's logEvent is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 200));
    const ev = await prisma.event.findFirst({
      where: { action: "auth.login.blocked_source" },
      orderBy: { timestamp: "desc" },
    });
    expect(ev).toBeTruthy();
    expect(ev?.level).toBe("warning");
    expect(ev?.resourceName).toBe("nobody-login-access-test");
  });

  it("also covers the TOTP second step", async () => {
    await BLOCK_LOOPBACK();
    const res = await request(app).post("/api/v1/auth/login/totp").send({ token: "000000" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid username or password");
  });

  it("NEVER gates the SSO entry points — that is what makes this safe to enable", async () => {
    await BLOCK_LOOPBACK();
    // Not configured in this suite, so each redirects to /login.html with an
    // error rather than being refused by the gate. The assertion is that the
    // gate let them through at all.
    for (const path of ["/api/v1/auth/azure/login", "/api/v1/auth/oidc/login"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("/login.html");
    }
  });

  it("leaves other static pages alone — only the login form is gated", async () => {
    await BLOCK_LOOPBACK();
    const res = await request(app).get("/mobile.html");
    expect(res.status).toBe(200);
  });
});
