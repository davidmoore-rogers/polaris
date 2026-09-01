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
 * EVERY MISS IN THE WINDOW COUNTS (2026-09-01). failed/total over the whole
 * window, no trimming. A probe that did not come back is a lost probe whatever
 * state the device was in when it was sent, which is what an operator means by
 * packet loss and what the loss chart has always DRAWN.
 *
 * IT USED TO TRIM, and why it stopped is the whole design. Between 2026-08 and
 * 2026-09-01 the measurement started at GREATEST(first success in window,
 * Asset.recoveryStartedAt), discarding any outage inside the window. That
 * existed to stop a device reading ~92% the moment it came back from a
 * 55-minute outage and alerting for a full window BECAUSE it recovered. But it
 * also discarded loss nobody wanted discarded: a device flapping hard enough to
 * reach `down` each cycle re-stamped recoveryStartedAt on every recovery,
 * collapsing its window to the last few probes and reporting ~0% loss forever.
 * A badly lossy link that Polaris insisted was clean is the exact failure this
 * metric exists to catch, so the trim had to go.
 *
 * THE FALSE ALERT IT PREVENTED IS NOW HANDLED WHERE IT BELONGS — in the engine,
 * as two gates on whether to ALERT rather than as a fiddle with the arithmetic
 * (business rule 29). Only a device currently answering produces a reading at
 * all (assetIsAnsweringProbes), and a reading at or above the automation's own
 * `ignoreAtOrAbove` ceiling produces none either. Both gates CLEAR a live loss
 * alert rather than freezing it. Keeping the measurement honest and deciding
 * separately what deserves an alert is the separation the anchor blurred.
 *
 * Asset.recoveryStartedAt is still stamped (utils/probeLossAnchor.ts) but is
 * read by nothing — dormant on the cooldownSec precedent.
 * * The window is anchored to UTC wall-clock (`now() AT TIME ZONE 'UTC'`)
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


  let tail = "";
  if (opts.onlyLossy) {
    tail = `
     ORDER BY 1 - (${effRecv})::float / NULLIF((${effSent}), 0) DESC
     LIMIT $${++p}`;
    params.push(opts.limit ?? null);
  }

  return prisma.$queryRawUnsafe<ProbeLossRow[]>(
    // One grouped aggregate, one scan. With the anchor gone so are its
    // partitioned min() and its join to `assets`, so this is a plain hash
    // aggregate again — strictly cheaper than the trimmed version it replaces,
    // on the same ~240k rows an hour of 2000 assets produces.
    `SELECT "assetId", (${effSent}) AS total, (${effSent}) - (${effRecv}) AS failed
     FROM "asset_monitor_samples"
     WHERE "timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval${idClause}
     GROUP BY "assetId"
     ${having}${tail}`,
    ...params,
  );
}
