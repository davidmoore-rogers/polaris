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
 *   - Widget mode (onlyLossy=true): additionally requires actual LOSS — asked of
 *     the effective packet counts, not of row outcomes, so a device whose every
 *     burst dropped packets while still getting something back is not filtered
 *     out as spotless — orders lossiest-first, and caps at `limit`
 *     (null = uncapped; Postgres treats LIMIT NULL as ALL). It also passes
 *     `includeFullyDown`, so an asset with no success in the window reads 100%
 *     instead of disappearing — see that option's doc for why the engine must
 *     not.
 *
 * IT COUNTS PACKETS, NOT ROWS, WHEREVER IT CAN (2026-09-01). The ICMP loss
 * sweep writes ONE row per burst carrying `packetsSent` / `packetsReceived`, so
 * an asset with any burst rows in the window has its ratio computed from those
 * sums and its response-time poll rows left out. Counting such a row as a
 * single outcome understated loss badly — a 5-echo burst that got one reply
 * back is an 80%-lossy reading but a perfectly "successful" row. Poll rows are
 * excluded rather than blended because that poll may be SNMP, SSH, REST or
 * WinRM, and folding a lost SNMP response into a figure labelled "packet loss"
 * would make the number mean something different per asset depending on how it
 * happens to be monitored. An asset with no burst rows falls back to the row
 * ratio, which is exactly the pre-sweep behaviour. The returned {total, failed}
 * shape is unchanged: the UNITS beneath it moved from rows to packets, the
 * arithmetic every caller does did not.
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

  // EFFECTIVE PACKET COUNTS. A burst row (the ICMP loss sweep) describes N
  // echoes in one row; a response-time poll row describes one probe and leaves
  // the columns NULL. Mixing the two by COUNTING ROWS understates loss badly —
  // a 5-echo burst that got 1 reply back is a 80%-lossy reading but a
  // perfectly "successful" row — so when an asset has ANY burst rows in the
  // window its ratio is computed from PACKETS and the poll rows are left out
  // of it entirely.
  //
  // Leaving them out is deliberate rather than lazy: the response-time poll
  // may be SNMP, SSH, REST or WinRM, and folding a lost SNMP response into a
  // figure labelled "packet loss" would make the number mean something
  // different per asset depending on how it happens to be monitored. An asset
  // with no burst rows (no pingable target, sweep disabled, or the window
  // predates the sweep) falls back to the row ratio, which is exactly the
  // pre-sweep behaviour.
  //
  // The results keep the {total, failed} shape so every caller is unchanged —
  // the units under it changed from rows to packets, the arithmetic did not.
  const hasBursts = `count(*) FILTER (WHERE "packetsSent" IS NOT NULL) > 0`;
  const effSent = `CASE WHEN ${hasBursts} THEN sum("packetsSent") ELSE count(*) END`;
  const effRecv = `CASE WHEN ${hasBursts} THEN coalesce(sum("packetsReceived"), 0) ELSE count(*) FILTER (WHERE "success") END`;

  // Widget mode still hides clean assets — but "clean" now has to be asked of
  // the effective counts, or a device whose every burst lost packets while
  // still getting SOMETHING back (so no row is a failure) would be filtered
  // out as spotless, which is the exact device the widget exists to surface.
  const having = opts.onlyLossy ? `HAVING (${effSent}) > (${effRecv})` : "";

  const anchor = `GREATEST("firstOk", "recoveredAt")`;
  const anchorClause = opts.includeFullyDown
    ? `(("firstOk" IS NOT NULL AND "timestamp" >= ${anchor}) OR "firstOk" IS NULL)`
    : `("firstOk" IS NOT NULL AND "timestamp" >= ${anchor})`;

  let tail = "";
  if (opts.onlyLossy) {
    tail = `
     ORDER BY 1 - (${effRecv})::float / NULLIF((${effSent}), 0) DESC
     LIMIT $${++p}`;
    params.push(opts.limit ?? null);
  }

  return prisma.$queryRawUnsafe<ProbeLossRow[]>(
    `SELECT "assetId", (${effSent}) AS total, (${effSent}) - (${effRecv}) AS failed
     FROM (
       SELECT s."assetId", s."success", s."timestamp", s."packetsSent", s."packetsReceived",
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
