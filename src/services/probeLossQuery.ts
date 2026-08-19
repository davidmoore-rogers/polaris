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
 *     (null = uncapped; Postgres treats LIMIT NULL as ALL). It also passes
 *     `includeFullyDown`, so an asset with no success in the window reads 100%
 *     instead of disappearing — see that option's doc for why the engine must
 *     not.
 *
 * THIS QUERY COUNTS EVERY `probeKind`. It is one of only three readers of
 * asset_monitor_samples that does (with alertChartService's loss chart);
 * everything else filters to the response-time poll. That is the point of the
 * ICMP loss sampler (utils/lossSampler.ts): a 10s side-probe during
 * warning/recovering windows so a 15-minute ratio divides ~90 samples instead
 * of ~15. The sampler's rows carry probeKind='icmp' and a NULL responseTimeMs,
 * so they can only ever affect a ratio, never a timing.
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
  /**
   * DISPLAY ONLY. Report an asset with ZERO successful probes in the window as
   * 100% loss instead of dropping it. Without this a device that was down for
   * the whole window vanishes from the Packet Loss widget rather than pegging
   * at 100%, which reads as "no loss" — the opposite of the truth.
   *
   * Deliberately NOT set by the notification engine: `assetIsAnsweringProbes`
   * already keeps `down` / `recovering` assets out of its id list, and a 100%
   * reading reaching a probeLossPct automation would fire a second alert about
   * an outage that asset-down already owns (business rule 29's supersede). If
   * this is ever passed on the engine path, that dedup is gone.
   */
  includeFullyDown?: boolean;
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

  // The anchor trims everything before the asset's first successful probe (see
  // the header). An asset with NO success has no anchor: engine mode drops it
  // (asset-down owns a total outage), display mode keeps every row so the ratio
  // comes out at 100%.
  const anchorClause = opts.includeFullyDown
    ? `(("firstOk" IS NOT NULL AND "timestamp" >= "firstOk") OR "firstOk" IS NULL)`
    : `("firstOk" IS NOT NULL AND "timestamp" >= "firstOk")`;

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
     WHERE ${anchorClause}
     GROUP BY "assetId"
     ${having}${tail}`,
    ...params,
  );
}
