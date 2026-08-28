/**
 * src/services/downDetectionService.ts
 *
 * WHO DECIDES A DEVICE IS DOWN.
 *
 * Down used to be a Monitor Settings value: `recordProbeResult` compared
 * consecutiveFailures against a `failureThreshold` resolved through the
 * (integration, assetType) tier hierarchy. That put the number that decides an
 * outage in a settings card scoped by integration and asset type, while the
 * thing operators think of as "my down alert" — the automation, with its device
 * filter — could not touch it.
 *
 * Now the AUTOMATION owns it. A `monitorStatus == down` automation carries a
 * `missedPolls` count, and that count is what the probe loop compares against
 * for every device the automation covers. Which automation covers a device when
 * several match is decided by the SAME most-specific-wins ladder that already
 * governs alerting (business rule 18, `scopeRank`) — deliberately not a second
 * precedence system, because two rules that disagreed would be unexplainable.
 *
 * An asset covered by NO down-detection automation has no threshold at all:
 * `resolveDownThreshold` answers null and the asset reads "passive". It is
 * still polled and still charted — Polaris simply renders no verdict about a
 * device nobody asked it to judge.
 *
 * HOT PATH. `resolveDownThreshold` is called once per probe per asset — 2000
 * assets on a 60s cadence — so it must never query. It reads ONE Map built by
 * a snapshot that is rebuilt at most once per TTL (plus once per rule write),
 * and `createTtlCache` makes an in-flight build count as fresh, so a cold start
 * under 2000 concurrent probes performs exactly one build rather than 2000.
 *
 * Staleness contract:
 *  - RULE edits invalidate explicitly (notificationRuleService CRUD).
 *  - ASSET drift (a tag added, a type corrected, an asset moved between
 *    integrations) is covered by the TTL alone. Instrumenting every asset
 *    writer is not viable — discoveryEngine alone has dozens of write sites —
 *    and one TTL is less than one probe cycle, so the worst case is a
 *    stale-but-valid threshold for under a minute.
 *  - A brand-new asset, the one case where staleness could produce a WRONG
 *    verdict rather than a stale one, is exact: `fallback` answers from the
 *    all-assets rule, which covers any asset by definition.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { createTtlCache } from "../utils/ttlCache.js";
import { logEvent } from "./eventLogService.js";
import {
  DEFAULT_MISSED_POLLS,
  isDownDetectionTrigger,
  scopeRank,
  deviceFilterMatch,
  DEVICE_FILTER_DIMENSIONS,
  scopeMatchesAsset,
  type ScopeAsset,
  type Trigger,
  type RuleScope,
} from "./notificationTypes.js";
import { decorateRelationLeafHits } from "./scopeRelationIndex.js";
import {
  recordDownDetectionBuild,
  setDownDetectionAssets,
  recordDownDetectionUnavailable,
} from "../metrics.js";

export { DEFAULT_MISSED_POLLS, isDownDetectionTrigger };

/**
 * How long a snapshot is served before a rebuild. Exported so tests can reason
 * about it; keep it between 30s and 120s — below that the rebuild cost stops
 * amortizing across a probe cycle, above it this becomes the only mechanism
 * catching asset scope drift and the window gets uncomfortable.
 */
export const DOWN_DETECTION_TTL_MS = 60_000;

/** The winning automation for one asset. */
export interface DownWinner {
  threshold: number;
  ruleId: string;
  ruleName: string;
  rank: number;
}

/** Two equally-specific automations asking for different counts on one asset. */
export interface DownConflict {
  assetId: string;
  hostname: string | null;
  ruleIds: string[];
  counts: number[];
  chosen: number;
}

/** A down-detection automation, pre-digested for the per-asset walk. */
export interface DownRule {
  id: string;
  name: string;
  createdAt: Date;
  scope: RuleScope;
  rank: number;
  threshold: number;
  dimensionFilter: Parameters<typeof deviceFilterMatch>[0];
}

interface DownDetectionIndex {
  builtAt: number;
  /** assetId → resolved winner. Absent ⇒ passive, subject to `fallback`. */
  byAsset: Map<string, DownWinner>;
  /** Winner among rules covering EVERY asset — answers for assets discovered
   *  since the last rebuild. */
  fallback: DownWinner | null;
  ruleCount: number;
  assetCount: number;
  conflicts: DownConflict[];
}

const EMPTY_INDEX: DownDetectionIndex = {
  builtAt: 0,
  byAsset: new Map(),
  fallback: null,
  ruleCount: 0,
  assetCount: 0,
  conflicts: [],
};

/** Cap on the conflicts carried on a snapshot — one bad config must not pin
 *  2000 rows in memory or write 2000 log lines. */
const MAX_CONFLICTS = 50;

const cache = createTtlCache<DownDetectionIndex>({ ttlMs: DOWN_DETECTION_TTL_MS, maxEntries: 1 });
const CACHE_KEY = "";

/** The last snapshot that built successfully — the mat under a failed rebuild,
 *  deliberately NOT cleared by invalidate(). */
let lastGoodIndex: DownDetectionIndex | null = null;

/** Whether the previous build saw zero down-detection automations, so the
 *  "nothing is being judged" Event fires on the TRANSITION rather than every
 *  rebuild. null = we have not built yet. */
let lastRuleCountWasZero: boolean | null = null;

/**
 * The asset columns the three coverage predicates read: scopeMatchesAsset,
 * evaluateScopeCondition (via the condition tree) and deviceFilterMatch.
 *
 * Deliberately NOT the engine's SCOPE_SELECT — that one also pulls
 * monitoredInterfaces / monitoredIpsecTunnels / monitoredStorage, array columns
 * this resolver never reads and which dominate the row size at 2000 assets.
 */
const DOWN_SCOPE_SELECT = {
  id: true,
  // NOTE: `interfaces` is deliberately absent even though the condition tree can
  // read it — decorateRelationLeafHits resolves those leaves in SQL instead.
  // See scopeInterfaceIndex.ts.
  hostname: true,
  assetType: true,
  tags: true,
  discoveredByIntegrationId: true,
  manufacturer: true,
  model: true,
  os: true,
  ipAddress: true,
  macAddress: true,
  status: true,
} as const;

/** Does a rule's device filter constrain anything at all? */
function filterIsActive(df: Parameters<typeof deviceFilterMatch>[0]): boolean {
  if (!df) return false;
  const rec = df as Record<string, string | undefined>;
  return DEVICE_FILTER_DIMENSIONS.some((d) => rec[d]);
}

/** Does this rule cover this asset — scope AND device filter? */
function ruleCoversAsset(rule: DownRule, asset: ScopeAsset): boolean {
  if (!scopeMatchesAsset(rule.scope, asset)) return false;
  if (!filterIsActive(rule.dimensionFilter)) return true;
  return deviceFilterMatch(rule.dimensionFilter, asset);
}

/**
 * Pick the automation that governs one asset. Pure — no DB, no cache — so the
 * precedence rules are unit-testable in isolation.
 *
 * Most specific wins (scopeRank). On a TIE, in order:
 *
 *  1. the SMALLER count wins. Two reasons. It matches the convention this
 *     codebase already settled on for the same shape of ambiguity —
 *     getMetricSeverityTiers resolves competing thresholds at one severity by
 *     taking the more sensitive, "that's where that severity first appears".
 *     And it is the safe direction for a monitoring product: choosing the
 *     larger count would silently withhold an outage the operator asked to hear
 *     about in 2 polls for 10, whereas choosing the smaller costs at most an
 *     early alert. Note both tied automations still FIRE (rule 18 leaves
 *     same-rank ties alone), so taking the smaller also means neither ever
 *     fires later than its own configuration promised.
 *  2. the older `createdAt`, then 3. the lower `id`. These only matter when the
 *     counts are equal — the threshold is then identical and the tiebreak
 *     exists solely to give the winner a stable IDENTITY for the "why is this
 *     asset's threshold N?" diagnostic. Both are immutable, so two Polaris
 *     processes never disagree.
 */
export function pickDownWinner(rules: DownRule[], asset: ScopeAsset, sink?: DownConflict[]): DownWinner | null {
  let best: DownRule | null = null;
  let tied: DownRule[] = [];

  for (const r of rules) {
    if (!ruleCoversAsset(r, asset)) continue;
    if (!best) {
      best = r;
      tied = [];
      continue;
    }
    if (r.rank > best.rank) {
      best = r;
      tied = [];
      continue;
    }
    if (r.rank < best.rank) continue;

    // Same rank — record the peer, then apply the tiebreak ladder.
    tied.push(best);
    if (r.threshold !== best.threshold) {
      if (r.threshold < best.threshold) best = r;
    } else if (r.createdAt.getTime() !== best.createdAt.getTime()) {
      if (r.createdAt.getTime() < best.createdAt.getTime()) best = r;
    } else if (r.id < best.id) {
      best = r;
    }
  }

  if (!best) return null;

  const winner = best;
  if (sink && sink.length < MAX_CONFLICTS) {
    const disagreeing = tied.filter((o) => o.threshold !== winner.threshold);
    if (disagreeing.length) {
      sink.push({
        assetId: asset.id,
        hostname: asset.hostname ?? null,
        ruleIds: [winner.id, ...disagreeing.map((o) => o.id)],
        counts: [winner.threshold, ...disagreeing.map((o) => o.threshold)],
        chosen: winner.threshold,
      });
    }
  }

  return { threshold: winner.threshold, ruleId: winner.id, ruleName: winner.name, rank: winner.rank };
}

/** Digest a stored rule row into the shape the per-asset walk wants. */
function toDownRule(row: { id: string; name: string; createdAt: Date; trigger: unknown; scope: unknown }): DownRule | null {
  const trigger = row.trigger as unknown as Trigger;
  if (!trigger || !isDownDetectionTrigger(trigger)) return null;
  const scope = (row.scope ?? {}) as RuleScope;
  const missed = (trigger as { missedPolls?: number }).missedPolls;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    scope,
    rank: scopeRank(scope),
    // A rule authored before the count existed still governs its devices — at
    // the number that was in force when it was written.
    threshold: typeof missed === "number" && missed > 0 ? missed : DEFAULT_MISSED_POLLS,
    dimensionFilter: (trigger as { dimensionFilter?: Parameters<typeof deviceFilterMatch>[0] }).dimensionFilter,
  };
}

/** The best rule that covers EVERY asset — no scope narrowing, no filter. */
function pickFallback(rules: DownRule[]): DownWinner | null {
  const universal = rules.filter((r) => r.scope.allAssets === true && !filterIsActive(r.dimensionFilter));
  if (!universal.length) return null;
  // Same ladder; every candidate is rank 0 so this is the tie path.
  const pseudo: ScopeAsset = { id: "", assetType: null, tags: [], discoveredByIntegrationId: null };
  return pickDownWinner(universal, pseudo);
}

async function buildDownDetectionIndex(): Promise<DownDetectionIndex> {
  const startedAt = Date.now();

  // Query 1 — the rule set. Small table by nature (tens of rows).
  const rows = await prisma.notificationRule.findMany({
    where: { enabled: true },
    select: { id: true, name: true, createdAt: true, trigger: true, scope: true },
  });
  const rules = rows.map(toDownRule).filter((r): r is DownRule => r !== null);

  // Query 2 — the fleet. Only monitored assets: recordProbeResult is the sole
  // consumer of byAsset and never runs for the rest.
  const assets = await prisma.asset.findMany({
    where: { monitored: true },
    select: DOWN_SCOPE_SELECT,
  });

  // Query 3 (only if some down automation filters by interface) — the one
  // condition field backed by a relation, resolved to per-asset verdicts rather
  // than joined onto DOWN_SCOPE_SELECT. Which asset each automation covers
  // decides what "down" MEANS for it (business rule 36), so an unresolved leaf
  // would leave devices reading passive.
  await decorateRelationLeafHits(assets, rules.map((r) => r.scope?.condition));

  const byAsset = new Map<string, DownWinner>();
  const conflicts: DownConflict[] = [];
  if (rules.length) {
    for (const a of assets) {
      const w = pickDownWinner(rules, a as ScopeAsset, conflicts);
      if (w) byAsset.set(a.id, w);
    }
  }

  const index: DownDetectionIndex = {
    builtAt: Date.now(),
    byAsset,
    fallback: pickFallback(rules),
    ruleCount: rules.length,
    assetCount: assets.length,
    conflicts,
  };

  recordDownDetectionBuild((Date.now() - startedAt) / 1000);
  setDownDetectionAssets(byAsset.size, assets.length - byAsset.size);
  reportBuild(index);
  return index;
}

/** Log + audit what the freshly-built snapshot says, without spamming. */
function reportBuild(index: DownDetectionIndex): void {
  // One warn per rebuild summarizing the DISTINCT conflicting rule pairs — not
  // one per asset, or a single bad config would print thousands of lines.
  if (index.conflicts.length) {
    const pairs = new Map<string, { ruleIds: string[]; counts: number[]; chosen: number; assets: number }>();
    for (const c of index.conflicts) {
      const key = c.ruleIds.slice().sort().join("|");
      const e = pairs.get(key);
      if (e) e.assets++;
      else pairs.set(key, { ruleIds: c.ruleIds, counts: c.counts, chosen: c.chosen, assets: 1 });
    }
    logger.warn(
      { pairs: Array.from(pairs.values()), truncated: index.conflicts.length >= MAX_CONFLICTS },
      "down detection: equally-specific automations disagree on the missed-poll count — using the smaller (more sensitive) value",
    );
  }

  // A fleet with NO down-detection automation is judged by nothing, and the
  // thing that would normally alert about that is exactly what was deleted. Fire
  // on the TRANSITION into that state so it is in the audit trail once, rather
  // than every 60s forever.
  const isZero = index.ruleCount === 0;
  if (isZero !== lastRuleCountWasZero) {
    if (isZero && index.assetCount > 0) {
      logger.warn(
        { monitoredAssets: index.assetCount },
        "down detection: no enabled automation defines down — every monitored asset is passive",
      );
      void logEvent({
        action: "monitor.down_detection_absent",
        level: "warning",
        resourceType: "monitor_settings",
        resourceName: "Down detection",
        actor: "system:down-detection",
        message: `No enabled automation defines when a device is down, so all ${index.assetCount} monitored device(s) are Passive — Polaris is recording their polls but will not declare any of them down.`,
        details: { monitoredAssets: index.assetCount },
      });
    } else if (!isZero && lastRuleCountWasZero === true) {
      void logEvent({
        action: "monitor.down_detection_restored",
        level: "info",
        resourceType: "monitor_settings",
        resourceName: "Down detection",
        actor: "system:down-detection",
        message: `Down detection is active again (${index.ruleCount} automation(s) define it).`,
        details: { ruleCount: index.ruleCount },
      });
    }
    lastRuleCountWasZero = isZero;
  }
}

async function getIndex(): Promise<DownDetectionIndex> {
  try {
    const idx = await cache.getOrCompute(CACHE_KEY, buildDownDetectionIndex);
    lastGoodIndex = idx;
    return idx;
  } catch (err) {
    if (lastGoodIndex) {
      logger.warn(
        { err, ageMs: Date.now() - lastGoodIndex.builtAt },
        "down-detection index rebuild failed — serving the last good snapshot",
      );
      return lastGoodIndex;
    }
    // No snapshot at all: render NO verdict rather than invent one. Every asset
    // reads passive, samples and counters still land, and it self-heals on the
    // next probe because createTtlCache never caches a rejection.
    logger.warn({ err }, "down-detection index unavailable — treating all assets as passive this tick");
    recordDownDetectionUnavailable();
    return EMPTY_INDEX;
  }
}

/**
 * The asset's missed-poll threshold, or null when no automation covers it
 * (= passive). ONE Map lookup in the steady state.
 */
export async function resolveDownThreshold(assetId: string): Promise<number | null> {
  const idx = await getIndex();
  const hit = idx.byAsset.get(assetId);
  if (hit) return hit.threshold;
  // Absent from the snapshot: either genuinely uncovered, or discovered since
  // the last rebuild. An all-assets automation covers ANY asset by definition,
  // so answering from it is exact and can never over-claim — a narrower rule
  // could only raise the specificity, and it converges within one TTL.
  return idx.fallback?.threshold ?? null;
}

/** Diagnostics for one asset: who governs it, at what count, and whether an
 *  equally-specific automation disagrees. Not the hot path — the asset modal
 *  and the effective-settings endpoint. */
export async function describeDownDetectionFor(assetId: string): Promise<{
  passive: boolean;
  winner: DownWinner | null;
  viaFallback: boolean;
  conflict: DownConflict | null;
} | null> {
  const idx = await getIndex();
  const hit = idx.byAsset.get(assetId) ?? null;
  const winner = hit ?? idx.fallback;
  return {
    passive: winner === null,
    winner,
    viaFallback: hit === null && idx.fallback !== null,
    conflict: idx.conflicts.find((c) => c.assetId === assetId) ?? null,
  };
}

/** How many monitored assets currently have no down-detection automation.
 *  Feeds the NOC summary's Passive tile. */
export async function countPassiveAssets(): Promise<number> {
  const idx = await getIndex();
  if (idx.fallback) return 0;
  return Math.max(0, idx.assetCount - idx.byAsset.size);
}

/**
 * What happens to down detection if this automation goes away — the answer the
 * delete/disable confirmation needs.
 *
 * Deleting the last automation covering a device makes it PASSIVE: Polaris
 * keeps polling it and never declares it down again. That is a legitimate
 * choice, but it must be a deliberate one, and it is exactly the change nothing
 * else can warn about — the thing that would normally alert about a blind fleet
 * is the automation being deleted.
 *
 * Answers three numbers: how many devices this rule currently GOVERNS, how many
 * would fall through to a broader automation (fine), and how many would be left
 * with nothing at all (the number worth a confirmation).
 *
 * Deliberately builds its own view rather than reading the cached snapshot's
 * winners: "who would win INSTEAD" is a different question from "who wins", and
 * it only runs when an operator opens a confirm dialog.
 */
export async function previewDownDetectionRemoval(ruleId: string): Promise<{
  isDownDetection: boolean;
  governs: number;
  wouldFallBackToAnother: number;
  wouldBecomePassive: number;
  sampleHostnames: string[];
}> {
  const empty = { isDownDetection: false, governs: 0, wouldFallBackToAnother: 0, wouldBecomePassive: 0, sampleHostnames: [] };

  const rows = await prisma.notificationRule.findMany({
    where: { enabled: true },
    select: { id: true, name: true, createdAt: true, trigger: true, scope: true },
  });
  const rules = rows.map(toDownRule).filter((r): r is DownRule => r !== null);
  if (!rules.some((r) => r.id === ruleId)) return empty;

  const survivors = rules.filter((r) => r.id !== ruleId);
  const assets = await prisma.asset.findMany({ where: { monitored: true }, select: DOWN_SCOPE_SELECT });

  let governs = 0;
  let fallback = 0;
  let passive = 0;
  const samples: string[] = [];
  for (const a of assets) {
    const before = pickDownWinner(rules, a as ScopeAsset);
    if (!before || before.ruleId !== ruleId) continue;
    governs += 1;
    if (pickDownWinner(survivors, a as ScopeAsset)) fallback += 1;
    else {
      passive += 1;
      if (samples.length < 5) samples.push(a.hostname ?? a.id);
    }
  }
  return { isDownDetection: true, governs, wouldFallBackToAnother: fallback, wouldBecomePassive: passive, sampleHostnames: samples };
}

/**
 * Drop the snapshot so the next resolve rebuilds. Called unconditionally from
 * rule create/update/delete — an update can turn a rule INTO or OUT of a
 * down-detection rule, so gating on "was it one?" would be a bug waiting to
 * happen. Deliberately leaves `lastGoodIndex` alone: that is the crash mat, not
 * the answer.
 */
export function invalidateDownDetectionCache(): void {
  cache.invalidate();
}

/** Test seam — forget the crash mat and the transition state too. */
export function resetDownDetectionStateForTests(): void {
  cache.invalidate();
  lastGoodIndex = null;
  lastRuleCountWasZero = null;
}
