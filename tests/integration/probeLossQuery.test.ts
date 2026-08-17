/**
 * tests/integration/probeLossQuery.test.ts
 *
 * Integration tests for src/services/probeLossQuery.ts —
 * `queryProbeLossRatios`. The whole function IS one raw SQL statement (a
 * partitioned min() anchoring the ratio to each asset's first successful probe,
 * then a grouped aggregate), so it's exercised against a live Postgres rather
 * than mocked.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 *
 * Coverage:
 *   - ANCHOR: samples before the first successful probe are excluded, so a
 *     device recovering from an outage reads 0% instead of the outage's ratio.
 *   - Loss that starts AFTER the first success is counted in full.
 *   - 0-success assets are dropped in both modes (asset-down owns them).
 *   - Engine mode keeps 0%-loss assets (hysteresis recovery); widget mode
 *     (onlyLossy) hides them and orders lossiest-first.
 *   - assetIds scoping + the window bound.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { queryProbeLossRatios } from "../../src/services/probeLossQuery.js";

const d = dbDescribe;

// Fixed ids keep the GROUP BY deterministic and scope the cleanup. The sample
// tables carry assetId but no FK to Asset (TimescaleDB hypertables — see
// CLAUDE.md tiered-sample-retention), so no real Asset rows are needed.
const A = "00000000-0000-0000-0000-0000000000b1";
const B = "00000000-0000-0000-0000-0000000000b2";
const ALL = [A, B];

/** `minutesAgo` before now, as the naive-UTC Date Prisma writes. */
function ago(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60 * 1000);
}

/**
 * Seed one probe per minute for `assetId`, oldest first: `pattern[i]` is the
 * success flag at (pattern.length - i) minutes ago. Reads like a timeline —
 * "F F F S S" is "failed three minutes, then came back".
 */
async function seedProbes(assetId: string, pattern: boolean[]): Promise<void> {
  await prisma.assetMonitorSample.createMany({
    data: pattern.map((success, i) => ({
      assetId,
      timestamp: ago(pattern.length - i),
      success,
      responseTimeMs: success ? 10 : null,
    })),
  });
}

const F = false, S = true;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: ALL } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: ALL } } });
});

d("queryProbeLossRatios — anchoring at the first successful probe", () => {
  it("excludes the outage that preceded recovery (the 92%-on-a-healthy-device case)", async () => {
    // 50 minutes dark, then 5 clean minutes: the pre-anchor failures are not
    // loss, they were an outage, so the reading is 0% rather than 50/55.
    await seedProbes(A, [...Array(50).fill(F), ...Array(5).fill(S)]);

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: ALL });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total)).toBe(5);
    expect(Number(rows[0].failed)).toBe(0);
  });

  it("counts every sample from the first success onward", async () => {
    // Anchor at minute -10; two of the ten samples from there on failed.
    await seedProbes(A, [F, F, S, F, S, S, F, S, S, S]);

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0].total)).toBe(8);
    expect(Number(rows[0].failed)).toBe(2);
  });

  it("counts loss that starts after the first success (a device going down now)", async () => {
    await seedProbes(A, [S, S, S, S, S, F, F, F, F, F]);

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0].total)).toBe(10);
    expect(Number(rows[0].failed)).toBe(5);
  });

  it("anchors per asset, not fleet-wide", async () => {
    await seedProbes(A, [F, F, F, F, S]);        // recovered — 0%
    await seedProbes(B, [S, F, S, F, S]);        // flapping  — 2/5

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: ALL });
    const byId = new Map(rows.map((r) => [r.assetId, r]));
    expect(Number(byId.get(A)!.failed)).toBe(0);
    expect(Number(byId.get(A)!.total)).toBe(1);
    expect(Number(byId.get(B)!.failed)).toBe(2);
    expect(Number(byId.get(B)!.total)).toBe(5);
  });
});

d("queryProbeLossRatios — mode + scoping contracts", () => {
  it("drops assets with no successful probe in the window (asset-down owns them)", async () => {
    await seedProbes(A, [F, F, F, F, F]);

    expect(await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] })).toHaveLength(0);
    expect(await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10 })).toHaveLength(0);
  });

  it("engine mode keeps a clean asset (0% feeds hysteresis recovery); widget mode hides it", async () => {
    await seedProbes(A, [S, S, S, S, S]);

    const engine = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(engine).toHaveLength(1);
    expect(Number(engine[0].failed)).toBe(0);

    const widget = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10 });
    expect(widget).toHaveLength(0);
  });

  it("widget mode orders lossiest-first and honours the cap", async () => {
    await seedProbes(A, [S, F, S, S, S]);        // 1/5 = 20%
    await seedProbes(B, [S, F, F, F, S]);        // 3/5 = 60%

    const ordered = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: ALL, onlyLossy: true, limit: null });
    expect(ordered.map((r) => r.assetId)).toEqual([B, A]);

    const capped = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: ALL, onlyLossy: true, limit: 1 });
    expect(capped.map((r) => r.assetId)).toEqual([B]);
  });

  it("scopes to assetIds and to the window", async () => {
    await seedProbes(A, [S, F, S]);
    await seedProbes(B, [S, F, S]);

    const scoped = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(scoped.map((r) => r.assetId)).toEqual([A]);

    // Samples older than the window are invisible — including the success that
    // would otherwise have anchored the measurement.
    await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: ALL } } });
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: A, timestamp: ago(120), success: true,  responseTimeMs: 10 },
        { assetId: A, timestamp: ago(90),  success: false, responseTimeMs: null },
      ],
    });
    expect(await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] })).toHaveLength(0);
  });
});
