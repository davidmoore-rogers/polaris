/**
 * tests/integration/ackLink.test.ts
 *
 * The public one-click acknowledge surface (/ack/:token). What matters here
 * is not that acknowledging works — it's the ways it must NOT work:
 *
 *   - GET is INERT. Mail gateways (Outlook Safe Links, Proofpoint) fetch every
 *     link in every message before a human sees it, so a GET that
 *     acknowledged would auto-acknowledge every alert Polaris ever mailed.
 *   - the page mounts ABOVE session/CSRF, so a POST with no cookie and no
 *     CSRF token succeeds — and, just as important, a scanner's GET must not
 *     leave a session row behind.
 *   - a token is single-use, expires, is bound to ONE alert and ONE user, and
 *     stops working if that user's role loses alerts:write.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { dbDescribe, ensureTestUser } from "./_helpers.js";
import { hashPassword } from "../../src/utils/password.js";
import { generateAckToken, hashAckToken } from "../../src/utils/ackToken.js";

const d = dbDescribe;

const USERNAME = "polaris-ack-link-user";
let userId = "";
let readonlyUserId = "";
let notificationId = "";

async function mintFor(user: string, opts?: { expiresAt?: Date; usedAt?: Date }): Promise<string> {
  const raw = generateAckToken();
  await prisma.notificationAckToken.create({
    data: {
      tokenHash: hashAckToken(raw),
      notificationId,
      userId: user,
      channel: "email",
      expiresAt: opts?.expiresAt ?? new Date(Date.now() + 86400000),
      usedAt: opts?.usedAt ?? null,
    },
  });
  return raw;
}

d("ack links", () => {
  beforeAll(async () => {
    await ensureTestUser();
    const admin = await prisma.role.findUnique({ where: { name: "admin" } });
    const readonly = await prisma.role.findUnique({ where: { name: "readonly" } });
    const u = await prisma.user.upsert({
      where: { username: USERNAME },
      update: { roleId: admin!.id },
      create: { username: USERNAME, passwordHash: await hashPassword("x".repeat(20)), roleId: admin!.id, authProvider: "local" },
    });
    userId = u.id;
    const ro = await prisma.user.upsert({
      where: { username: `${USERNAME}-ro` },
      update: { roleId: readonly!.id },
      create: { username: `${USERNAME}-ro`, passwordHash: await hashPassword("x".repeat(20)), roleId: readonly!.id, authProvider: "local" },
    });
    readonlyUserId = ro.id;
  });

  beforeEach(async () => {
    await prisma.notificationAckToken.deleteMany({});
    await prisma.notification.deleteMany({ where: { assetHostname: "ack-test-host" } });
    const n = await prisma.notification.create({
      data: { message: "packet loss at 93.8%", severity: "critical", assetHostname: "ack-test-host" },
    });
    notificationId = n.id;
  });

  afterAll(async () => {
    await prisma.notificationAckToken.deleteMany({});
    await prisma.notification.deleteMany({ where: { assetHostname: "ack-test-host" } });
    await prisma.user.deleteMany({ where: { username: { in: [USERNAME, `${USERNAME}-ro`] } } });
  });

  it("GET renders the alert but acknowledges NOTHING (mail scanners follow links)", async () => {
    const raw = await mintFor(userId);
    const res = await request(app).get(`/ack/${raw}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-robots-tag"]).toMatch(/noindex/);
    expect(res.text).toContain("packet loss at 93.8%");
    expect(res.text).toContain("ack-test-host");
    // The control is a POST form, never a link that acts.
    expect(res.text).toMatch(/<form method="post"/);

    const after = await prisma.notification.findUnique({ where: { id: notificationId } });
    expect(after?.acknowledged).toBe(false);
    const tok = await prisma.notificationAckToken.findUnique({ where: { tokenHash: hashAckToken(raw) } });
    expect(tok?.usedAt).toBeNull();
  });

  it("carries no inline <script> (the CSP bans it, and the page must work without JS)", async () => {
    const raw = await mintFor(userId);
    const res = await request(app).get(`/ack/${raw}`);
    expect(res.text).not.toMatch(/<script/i);
  });

  it("POST acknowledges with no session and no CSRF token, recording the bound user", async () => {
    const raw = await mintFor(userId);
    const res = await request(app).post(`/ack/${raw}`).type("form").send({ confirm: "1", note: "on it" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Acknowledged");

    const after = await prisma.notification.findUnique({ where: { id: notificationId } });
    expect(after?.acknowledged).toBe(true);
    expect(after?.acknowledgedBy).toBe(`${USERNAME} (ack link)`);
    expect(after?.acknowledgeNote).toBe("on it");
    const tok = await prisma.notificationAckToken.findUnique({ where: { tokenHash: hashAckToken(raw) } });
    expect(tok?.usedAt).not.toBeNull();
  });

  it("answers JSON for the service worker's Acknowledge button", async () => {
    const raw = await mintFor(userId);
    const res = await request(app).post(`/ack/${raw}`).set("Accept", "application/json").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, state: "valid" });
    expect(res.body.acknowledgedBy).toBe(`${USERNAME} (ack link)`);
  });

  it("is single-use — a second POST reports the acknowledgement, not a failure", async () => {
    const raw = await mintFor(userId);
    await request(app).post(`/ack/${raw}`).type("form").send({ confirm: "1" });
    const second = await request(app).post(`/ack/${raw}`).set("Accept", "application/json").send({});
    // Already acknowledged: the clicker's intent is satisfied, so ok stays true.
    expect(second.body).toMatchObject({ ok: true, state: "already" });
  });

  it("refuses an expired token", async () => {
    const raw = await mintFor(userId, { expiresAt: new Date(Date.now() - 1000) });
    const res = await request(app).post(`/ack/${raw}`).type("form").send({ confirm: "1" });
    expect(res.status).toBe(410);
    const after = await prisma.notification.findUnique({ where: { id: notificationId } });
    expect(after?.acknowledged).toBe(false);
  });

  it("refuses a recipient whose role lost alerts:write after the mail went out", async () => {
    const raw = await mintFor(readonlyUserId);
    const res = await request(app).post(`/ack/${raw}`).type("form").send({ confirm: "1" });
    expect(res.status).toBe(403);
    const after = await prisma.notification.findUnique({ where: { id: notificationId } });
    expect(after?.acknowledged).toBe(false);
  });

  it("gives an unknown token a vague 404 and writes no audit Event", async () => {
    const before = await prisma.event.count({ where: { action: "notification.ack_link.rejected" } });
    const res = await request(app).get(`/ack/${generateAckToken()}`);
    expect(res.status).toBe(404);
    expect(res.text).toContain("no longer valid");
    expect(res.text).not.toContain("ack-test-host"); // no oracle about real alerts
    const after = await prisma.event.count({ where: { action: "notification.ack_link.rejected" } });
    expect(after).toBe(before);
  });

  it("rejects a mangled token without touching the database", async () => {
    for (const bad of ["nope", "polaris_ack_short", "polaris_deadbeef"]) {
      const res = await request(app).get(`/ack/${bad}`);
      expect(res.status).toBe(404);
    }
  });
});
