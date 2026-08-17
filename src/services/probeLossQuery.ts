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
 * THE MEASUREMENT STARTS AT THE FIRST SUCCESSFUL PROBE IN THE WINDOW, not at
 * the window's leading edge (2026-08). Loss is failed/total over the samples
 * from that probe onward; everything before it is discarded. The window is a
 * ratio denominator, and a device that was UNREACHABLE for part of it never
 * had probes that could be "lost" — it was down, which asset-down already owns
 * (the same reasoning that drops 0-success assets entirely, applied to the
 * down PORTION of a window instead of all of it). Without the anchor a device
 * recovering from a 55-minute outage reads ~92% loss the moment it comes back
 * and keeps alerting until the outage slides out of the window — the alert
 * fires *because* the device is healthy again, and a 60-minute window makes it
 * stick around for an hour. With it, the reading is 0% on the first clean
 * probe after recovery, so the rule clears instead.
 *
 * The cost is that a leading failure run is not counted as loss even when it
 * was a brief blip rather than an outage (a single failure at the window's
 * first sample reads 0%). That is deliberate: the alternative is a threshold
 * separating "blip" from "outage", and the blip re-enters the ratio on the next
 * tick anyway, since the anchor only ever discards samples OLDER than the
 * first success. Flapping is unaffected — an early success anchors near the
 * window edge, so nearly the whole window still counts.
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

  // "≥1 success" is enforced by the anchor itself (`"firstOk" IS NOT NULL`
  // below keeps only assets that HAD one, and the anchor row is a success), so
  // engine mode needs no HAVING at all. Widget mode still has to hide clean
  // assets.
  const having = opts.onlyLossy
    ? `HAVING count(*) FILTER (WHERE NOT "success") > 0`
    : "";

  let tail = "";
  if (opts.onlyLossy) {
    tail = `
     ORDER BY (count(*) FILTER (WHERE NOT "success"))::float / count(*) DESC
     LIMIT $${++p}`;
    params.push(opts.limit ?? null);
  }

  // One pass: the partitioned min() stamps each asset's first successful probe
  // onto its own rows, the outer WHERE trims everything before it, and the
  // grouped aggregate counts what's left. Scale note — this reads the same rows
  // the plain aggregate did (an hour of 2000 assets' probes is ~240k rows on the
  // 60s engine tick) but now sorts/hashes them by assetId for the partition;
  // it stays one query with one scan, never a per-asset lookup.
  return prisma.$queryRawUnsafe<ProbeLossRow[]>(
    `SELECT "assetId", count(*) AS total, count(*) FILTER (WHERE NOT "success") AS failed
     FROM (
       SELECT "assetId", "success", "timestamp",
              min("timestamp") FILTER (WHERE "success") OVER (PARTITION BY "assetId") AS "firstOk"
       FROM "asset_monitor_samples"
       WHERE "timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval${idClause}
     ) w
     WHERE "firstOk" IS NOT NULL AND "timestamp" >= "firstOk"
     GROUP BY "assetId"
     ${having}${tail}`,
    ...params,
  );
}
