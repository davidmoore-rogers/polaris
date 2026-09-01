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
 * ICMP loss sweep (utils/lossSweep.ts): a uniform burst of echoes
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
 * A SECOND ANCHOR COVERS THE OUTAGE THAT STARTED MID-WINDOW (2026-08). The
 * first-success anchor only helps while the outage is still running at the
 * window's leading edge; once the device has been back long enough for a
 * healthy sample to precede the outage, that first success sits BEFORE it and
 * the anchor goes inert — the whole outage stays in the denominator, so the
 * device reads heavily lossy for a full window *because* it recovered. That is
 * the same false alert the first anchor exists to prevent (and the engine's
 * device-down supersede only covers the outage itself, not the window after
 * it). So the measurement also starts no earlier than `Asset.recoveryStartedAt`
 * — the success that ended the last outage, i.e. the moment monitorStatus left
 * down/unknown for recovering. Effective anchor = GREATEST(first success,
 * recoveryStartedAt); Postgres's GREATEST ignores NULLs, so a device that has
 * not recovered inside the window behaves exactly as before.
 *
 * Only an outage-ending recovery stamps that column — a warning→up recovery
 * never does. That is what keeps flapping measurable: a lossy device passes
 * through warning constantly, and anchoring on those recoveries would restart
 * the window every few probes and report ~0% forever.
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
    // Qualified: the subquery joins assets, and an unqualified column there is
    // one schema change away from being ambiguous.
    idClause = ` AND s."assetId" = ANY($${++p}::text[])`;
    params.push(opts.assetIds);
  }

  // "≥1 success" is enforced by the anchor itself (`"firstOk" IS NOT NULL`
  // below keeps only assets that HAD one, and the anchor row is a success), so
  // engine mode needs no HAVING at all. Widget mode still has to hide clean
  // assets.
  const having = opts.onlyLossy
    ? `HAVING count(*) FILTER (WHERE NOT "success") > 0`
    : "";

  // The anchor trims everything before the LATER of the asset's first
  // successful probe and the end of its last outage (see the header).
  // GREATEST ignores NULLs, so an asset that hasn't recovered inside the
  // window falls back to the first-success anchor alone. An asset with NO
  // success has no anchor at all: engine mode drops it (asset-down owns a
  // total outage), display mode keeps every row so the ratio comes out at 100%.
  const anchor = `GREATEST("firstOk", "recoveredAt")`;
  const anchorClause = opts.includeFullyDown
    ? `(("firstOk" IS NOT NULL AND "timestamp" >= ${anchor}) OR "firstOk" IS NULL)`
    : `("firstOk" IS NOT NULL AND "timestamp" >= ${anchor})`;

  let tail = "";
  if (opts.onlyLossy) {
    tail = `
     ORDER BY (count(*) FILTER (WHERE NOT "success"))::float / count(*) DESC
     LIMIT $${++p}`;
    params.push(opts.limit ?? null);
  }

  // One pass: the partitioned min() stamps each asset's first successful probe
  // onto its own rows, the LEFT JOIN carries its recovery anchor alongside, the
  // outer WHERE trims everything before the later of the two, and the grouped
  // aggregate counts what's left. Scale note — this reads the same rows the
  // plain aggregate did (an hour of 2000 assets' probes is ~240k rows on the
  // 60s engine tick) but now sorts/hashes them by assetId for the partition; it
  // stays one query with one scan, never a per-asset lookup. The join is to a
  // ~2000-row dimension table on its primary key, and it must stay a LEFT JOIN:
  // the sample tables have no FK to assets (hypertables), so rows whose asset
  // row is gone — or, in tests, was never created — must still count.
  return prisma.$queryRawUnsafe<ProbeLossRow[]>(
    `SELECT "assetId", count(*) AS total, count(*) FILTER (WHERE NOT "success") AS failed
     FROM (
       SELECT s."assetId", s."success", s."timestamp",
              min(s."timestamp") FILTER (WHERE s."success") OVER (PARTITION BY s."assetId") AS "firstOk",
              a."recoveryStartedAt" AS "recoveredAt"
       FROM "asset_monitor_samples" s
       LEFT JOIN "assets" a ON a."id" = s."assetId"
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval${idClause}
     ) w
     WHERE ${anchorClause}
     GROUP BY "assetId"
     ${having}${tail}`,
    ...params,
  );
}
