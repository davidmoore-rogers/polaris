/**
 * tests/integration/_helpers.ts
 *
 * Shared scaffolding for the integration test suites:
 *   - dbReachable: probes DATABASE_URL at module load. When the DB is
 *     unreachable, suites use `describe.skip` so vitest reports them as
 *     skipped rather than red on sandboxed / offline runs.
 *   - ensureTestUser: idempotent admin user used to authenticate every
 *     mutating request. One row across the whole test process.
 *   - authedAgent: returns a supertest agent with a live session +
 *     captured CSRF token. Pass the `csrf` value as `X-CSRF-Token` on
 *     every PUT/POST/DELETE.
 *
 * The probe runs once per worker process (vitest forks workers per file
 * by default, but Prisma + the helper module both no-op cleanly on the
 * second probe so this is safe under any concurrency model).
 */

import { describe } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";

const TEST_USERNAME = "polaris-integration-tester";
const TEST_PASSWORD = "test-password-do-not-use-in-prod";

/** True when DATABASE_URL is set AND the DB answers a trivial SELECT. */
export const dbReachable: boolean = await (async () => {
  if (!process.env.DATABASE_URL) return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

/** Use this in place of `describe` to make a suite skip cleanly when the DB is unreachable. */
export const dbDescribe: typeof describe = dbReachable ? describe : describe.skip;

if (!dbReachable) {
  // eslint-disable-next-line no-console
  console.warn("[integration tests] DB unreachable — suites will skip. Set DATABASE_URL and ensure the DB is up to run them.");
}

/**
 * Idempotently create the shared test user. Safe to call from every file's
 * beforeAll. The user is left in place across tests; per-file beforeEach
 * hooks wipe everything else.
 */
export async function ensureTestUser(): Promise<{ username: string; password: string }> {
  if (!dbReachable) return { username: TEST_USERNAME, password: TEST_PASSWORD };
  const existing = await prisma.user.findUnique({ where: { username: TEST_USERNAME } });
  if (!existing) {
    await prisma.user.create({
      data: {
        username:     TEST_USERNAME,
        passwordHash: await hashPassword(TEST_PASSWORD),
        role:         "admin",
        authProvider: "local",
      },
    });
  }
  return { username: TEST_USERNAME, password: TEST_PASSWORD };
}

/**
 * Tear-down companion to ensureTestUser. Call from afterAll only when no
 * other suite still needs the user — usually the user lives forever in the
 * test DB and nobody bothers to delete it.
 */
export async function deleteTestUser(): Promise<void> {
  if (!dbReachable) return;
  await prisma.user.deleteMany({ where: { username: TEST_USERNAME } });
}

/**
 * Build a logged-in supertest agent. The agent's cookie jar holds the
 * session cookie + the polaris_csrf cookie across requests; the returned
 * `csrf` string is what mutating requests must echo in the `X-CSRF-Token`
 * header.
 */
export async function authedAgent(app: Express): Promise<{
  agent: ReturnType<typeof request.agent>;
  csrf:  string;
}> {
  const agent = request.agent(app);
  // GET first so the session-pinned CSRF cookie gets set before login.
  await agent.get("/api/v1/auth/me");
  const loginResp = await agent
    .post("/api/v1/auth/login")
    .send({ username: TEST_USERNAME, password: TEST_PASSWORD })
    .set("Content-Type", "application/json");
  if (loginResp.status !== 200) {
    throw new Error(`Login failed (${loginResp.status}): ${JSON.stringify(loginResp.body)}`);
  }
  const cookies = (agent.jar as any).getCookies("http://127.0.0.1/");
  const csrf = (cookies.find((c: any) => c.key === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
  return { agent, csrf };
}
