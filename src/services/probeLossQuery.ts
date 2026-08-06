/**
 * src/services/probeLossQuery.ts — the ONE windowed failed-probe-ratio query
 * over asset_monitor_samples, shared by the notification engine's probeLossPct
 * trigger and the NOC dashboard's Packet Loss widget (2026-08 dedup — the two
 * hand-maintained copies had already drifted in their HAVING clauses, which
 * turned out to be a real semantic difference, so it's a parameter here):
 *
 *   - Engine mode (onlyLossy=false): every asset with ≥1 successful probe in
 *     the window, INCLUDING 0%-loss rows — an auto-clear/hysteresis rule needs
 *     the clean reading to recover. Fully-down assets (0 successes) are
 *     dropped either way — asset-down owns them.
 *   - Widget mode (onlyLossy=true): additionally requires ≥1 FAILURE (a clean
 *     asset isn't "packet loss"), orders lossiest-first, and caps at `limit`
 *     (null = uncapped; Postgres treats LIMIT NULL as ALL).
 *
 * The window is anchored to UTC wall-clock (`now() AT TIME ZONE 'UTC'`)
 * rather than a bound JS Date to avoid tz skew against the hypertable's
 * naive timestamps. All SQL fragments are compile-time literals; user data
 * rides positional parameters only.
 */

import { prisma } from "../db.js";

export interface ProbeLossRow {
  assetId: string;
  total: bigint;
  failed: bigint;
}

export async function queryProbeLossRatios(opts: {
  sinceMinutes: number;
  assetIds?: string[] | null;
  onlyLossy?: boolean;
  limit?: number | null;
}): Promise<ProbeLossRow[]> {
  const params: unknown[] = [String(opts.sinceMinutes)];
  let p = 1;

  let idClause = "";
  if (opts.assetIds) {
    idClause = ` AND "assetId" = ANY($${++p}::text[])`;
    params.push(opts.assetIds);
  }

  const having = opts.onlyLossy
    ? `HAVING count(*) FILTER (WHERE NOT "success") > 0
        AND count(*) FILTER (WHERE "success") > 0`
    : `HAVING count(*) FILTER (WHERE "success") > 0`;

  let tail = "";
  if (opts.onlyLossy) {
    tail = `
     ORDER BY (count(*) FILTER (WHERE NOT "success"))::float / count(*) DESC
     LIMIT $${++p}`;
    params.push(opts.limit ?? null);
  }

  return prisma.$queryRawUnsafe<ProbeLossRow[]>(
    `SELECT "assetId", count(*) AS total, count(*) FILTER (WHERE NOT "success") AS failed
     FROM "asset_monitor_samples"
     WHERE "timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval${idClause}
     GROUP BY "assetId"
     ${having}${tail}`,
    ...params,
  );
}
