/**
 * src/services/notificationEngine.ts
 *
 * The notification rule evaluator. Two paths, both driven by the
 * evaluateNotificationRules job:
 *
 *  1. Threshold / state path (asset_metric, asset_state, host_metric):
 *     batch-load in-scope assets + their latest sample readings, compare
 *     against the rule, and drive a per-(rule, asset, dimension) firing state
 *     machine (clear → pending → firing) with sustained-duration + debounce.
 *     Fires only on the clear→firing crossing; clears per the rule's
 *     clearBehavior (manual / auto / timed). Modeled on capacityWatch's
 *     transition guard — state writes happen only on transition, so the hot
 *     path is bounded by the number of *changes*, not the fleet size.
 *
 *  2. Event-tail path (event, change): consume new Event audit rows since a
 *     stored cursor and match them against event/change rules. Change rules
 *     are sugar over the change-Events the persist* functions emit.
 *
 * The engine WRITES notifications; notificationService is the read/lifecycle
 * side. previewRule() dry-runs a draft against current data with no writes
 * (the builder's Test button).
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { logEvent } from "./eventLogService.js";
import { REGION_TAG_PREFIX } from "./notificationService.js";
import {
  type Trigger,
  type RuleScope,
  type RuleInput,
  type DeliveryTarget,
  CHANGE_TYPE_ACTIONS,
} from "./notificationTypes.js";
import { expandDeliveries } from "./notificationRecipientService.js";

const LAST_EVENT_SETTING_KEY = "notificationEngine.lastEventCursor";
const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000; // window to find the "latest" sample

// ─── A rule as loaded from the DB ───────────────────────────────────────────
interface DbRule {
  id: string;
  name: string;
  severity: string;
  trigger: Trigger;
  scope: RuleScope;
  clearBehavior: string;
  clearAfterSec: number | null;
  cooldownSec: number | null;
  messageTemplate: string | null;
  targets: DeliveryTarget[];
}

/** Best-effort outbound-delivery expansion — never breaks rule evaluation. */
async function expandDeliveriesSafe(notificationId: string, targets: DeliveryTarget[]): Promise<void> {
  if (!targets || targets.length === 0) return;
  try {
    await expandDeliveries(notificationId, targets);
  } catch (err) {
    await logEvent({
      action: "notification.delivery_expand_error",
      resourceType: "notification",
      resourceId: notificationId,
      actor: "system:notification-engine",
      level: "warning",
      message: "Failed to expand notification delivery targets",
      details: { err: (err as Error)?.message },
    }).catch(() => {});
  }
}

interface ScopeAssetRow {
  id: string;
  hostname: string | null;
  assetType: string | null;
  tags: string[];
  discoveredByIntegrationId: string | null;
  monitorStatus: string | null;
  status: string;
  consecutiveFailures: number;
  dependencySuppressed: boolean;
  quarantinedAt: Date | null;
}

/** A single evaluated reading for a (asset, dimension). */
interface Reading {
  assetId: string;
  hostname: string | null;
  tags: string[];
  dimKey: string;
  dimLabel: string;
  value: number | string | boolean | null;
}

// ─── Comparators ────────────────────────────────────────────────────────────

export function compareNum(value: number, op: string, threshold: number): boolean {
  switch (op) {
    case ">": return value > threshold;
    case ">=": return value >= threshold;
    case "<": return value < threshold;
    case "<=": return value <= threshold;
    case "==": return value === threshold;
    case "!=": return value !== threshold;
    default: return false;
  }
}

export function compareValue(value: number | string | boolean | null, op: string, target: number | string | boolean): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number" && typeof target === "number") return compareNum(value, op, target);
  // string / boolean: only equality comparisons are meaningful
  const a = String(value).toLowerCase();
  const b = String(target).toLowerCase();
  if (op === "==") return a === b;
  if (op === "!=") return a !== b;
  // allow numeric comparison if both coerce to numbers (e.g. consecutiveFailures)
  const na = Number(value);
  const nb = Number(target);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return compareNum(na, op, nb);
  return false;
}

// ─── Scope → assets ─────────────────────────────────────────────────────────

const SCOPE_SELECT = {
  id: true, hostname: true, assetType: true, tags: true, discoveredByIntegrationId: true,
  monitorStatus: true, status: true, consecutiveFailures: true, dependencySuppressed: true,
  quarantinedAt: true,
} as const;

/** Build a Prisma where from a scope, or null if the scope matches nothing. */
function scopeWhere(scope: RuleScope): Prisma.AssetWhereInput | null {
  if (scope.allAssets) return {};
  const and: Prisma.AssetWhereInput[] = [];
  if (scope.assetTypes?.length) and.push({ assetType: { in: scope.assetTypes } });
  if (scope.tags?.length) and.push({ tags: { hasSome: scope.tags } });
  if (scope.assetIds?.length) and.push({ id: { in: scope.assetIds } });
  if (scope.integrationIds?.length) and.push({ discoveredByIntegrationId: { in: scope.integrationIds } });
  if (and.length === 0) return null; // no dimensions + not allAssets ⇒ nothing
  return { AND: and };
}

async function loadScopeAssets(scope: RuleScope): Promise<ScopeAssetRow[]> {
  const where = scopeWhere(scope);
  if (!where) return [];
  return prisma.asset.findMany({ where, select: SCOPE_SELECT });
}

function regionSnapshot(tags: string[]): string[] {
  return tags
    .filter((t) => t.toLowerCase().startsWith(REGION_TAG_PREFIX))
    .map((t) => t.slice(REGION_TAG_PREFIX.length))
    .filter(Boolean);
}

// ─── Reading resolvers ──────────────────────────────────────────────────────

function substringMatch(haystack: string | null, needle?: string): boolean {
  if (!needle) return true;
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

/** Reduce sample rows to the latest per dimension key, or aggregate over window. */
function reduceReadings(
  rows: Array<{ assetId: string; timestamp: Date }>,
  assetIndex: Map<string, ScopeAssetRow>,
  dimKeyFn: (row: any) => string,
  dimLabelFn: (row: any) => string,
  valueFn: (row: any) => number | null,
  aggregation: string,
): Reading[] {
  // group by assetId|dimKey
  const groups = new Map<string, { asset: ScopeAssetRow; dimKey: string; dimLabel: string; values: number[]; latest: { ts: number; v: number | null } }>();
  for (const row of rows) {
    const asset = assetIndex.get(row.assetId);
    if (!asset) continue;
    const dimKey = dimKeyFn(row);
    const key = `${row.assetId}|${dimKey}`;
    const v = valueFn(row);
    let g = groups.get(key);
    if (!g) {
      g = { asset, dimKey, dimLabel: dimLabelFn(row), values: [], latest: { ts: -1, v: null } };
      groups.set(key, g);
    }
    if (v !== null) g.values.push(v);
    const ts = row.timestamp.getTime();
    if (ts > g.latest.ts) g.latest = { ts, v };
  }
  const out: Reading[] = [];
  for (const g of groups.values()) {
    let value: number | null;
    if (aggregation === "avg") value = g.values.length ? g.values.reduce((a, b) => a + b, 0) / g.values.length : null;
    else if (aggregation === "min") value = g.values.length ? Math.min(...g.values) : null;
    else if (aggregation === "max") value = g.values.length ? Math.max(...g.values) : null;
    else value = g.latest.v; // latest
    out.push({ assetId: g.asset.id, hostname: g.asset.hostname, tags: g.asset.tags, dimKey: g.dimKey, dimLabel: g.dimLabel, value });
  }
  return out;
}

async function resolveAssetMetricReadings(trigger: Extract<Trigger, { type: "asset_metric" }>, assets: ScopeAssetRow[]): Promise<Reading[]> {
  const ids = assets.map((a) => a.id);
  if (ids.length === 0) return [];
  const index = new Map(assets.map((a) => [a.id, a]));
  const since = new Date(Date.now() - Math.max(trigger.windowSec * 1000, DEFAULT_LOOKBACK_MS));
  const df = trigger.dimensionFilter ?? {};
  const agg = trigger.aggregation;
  const num = (b: bigint | null | undefined): number | null => (b === null || b === undefined ? null : Number(b));

  switch (trigger.metric) {
    case "cpuPct": case "memPct": case "memUsedBytes": case "sessionCount": {
      const rows = await prisma.assetTelemetrySample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, cpuPct: true, memPct: true, memUsedBytes: true, sessionCount: true } });
      const pick = (r: any) => trigger.metric === "memUsedBytes" ? num(r.memUsedBytes) : (r[trigger.metric] ?? null);
      return reduceReadings(rows, index, () => "", () => "", pick, agg);
    }
    case "responseTimeMs": case "uptimeSec": {
      const rows = await prisma.assetMonitorSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, responseTimeMs: true, uptimeSec: true } });
      return reduceReadings(rows, index, () => "", () => "", (r) => r[trigger.metric] ?? null, agg);
    }
    case "hwSensorValue": {
      const rows = await prisma.assetHardwareSensorSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since }, ...(df.sensorClass ? { sensorClass: df.sensorClass } : {}) }, select: { assetId: true, timestamp: true, sensorName: true, sensorClass: true, value: true } });
      return reduceReadings(rows, index, (r) => r.sensorName, (r) => `${r.sensorName} (${r.sensorClass})`, (r) => r.value ?? null, agg);
    }
    case "storageUsedBytes": case "storageUsedPct": {
      const rows = await prisma.assetStorageSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, mountPath: true, usedBytes: true, totalBytes: true } });
      const filtered = rows.filter((r) => substringMatch(r.mountPath, df.mountPathPattern));
      const valueFn = (r: any) => {
        if (trigger.metric === "storageUsedBytes") return num(r.usedBytes);
        const used = num(r.usedBytes); const total = num(r.totalBytes);
        return used !== null && total ? (used / total) * 100 : null;
      };
      return reduceReadings(filtered, index, (r) => r.mountPath, (r) => r.mountPath, valueFn, agg);
    }
    case "sdwanLatencyMs": case "sdwanJitterMs": case "sdwanPacketLoss": {
      const col = trigger.metric === "sdwanLatencyMs" ? "latencyMs" : trigger.metric === "sdwanJitterMs" ? "jitterMs" : "packetLoss";
      const rows = await prisma.assetPerfSlaSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, healthCheck: true, link: true, latencyMs: true, jitterMs: true, packetLoss: true } });
      const filtered = rows.filter((r) => substringMatch(r.healthCheck, df.healthCheck) && substringMatch(r.link, df.link));
      return reduceReadings(filtered, index, (r) => `${r.healthCheck}|${r.link}`, (r) => `${r.healthCheck} / ${r.link}`, (r) => r[col] ?? null, agg);
    }
    case "customWidgetValue": {
      const rows = await prisma.assetCustomWidgetSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since }, kind: "scalar", ...(df.widgetId ? { widgetId: df.widgetId } : {}) }, select: { assetId: true, timestamp: true, widgetId: true, value: true } });
      return reduceReadings(rows, index, (r) => r.widgetId, (r) => r.widgetId, (r) => (typeof r.value === "number" ? r.value : Number(r.value)) || null, agg);
    }
    case "ifInBps": case "ifOutBps": case "ifInErrorRate": case "ifOutErrorRate": {
      const col = trigger.metric === "ifInBps" ? "inOctets" : trigger.metric === "ifOutBps" ? "outOctets" : trigger.metric === "ifInErrorRate" ? "inErrors" : "outErrors";
      const mult = trigger.metric === "ifInBps" || trigger.metric === "ifOutBps" ? 8 : 1; // octets→bits
      const rows = await prisma.assetInterfaceSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: { timestamp: "desc" }, select: { assetId: true, timestamp: true, ifName: true, inOctets: true, outOctets: true, inErrors: true, outErrors: true } });
      const filtered = rows.filter((r) => substringMatch(r.ifName, df.ifNamePattern));
      return rateReadings(filtered, index, (r) => r.ifName, (r) => r.ifName, (r) => num((r as any)[col]), mult);
    }
    case "ipsecThroughputBps": {
      const rows = await prisma.assetIpsecTunnelSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: { timestamp: "desc" }, select: { assetId: true, timestamp: true, tunnelName: true, incomingBytes: true, outgoingBytes: true } });
      const filtered = rows.filter((r) => substringMatch(r.tunnelName, df.tunnelName));
      return rateReadings(filtered, index, (r) => r.tunnelName, (r) => r.tunnelName, (r) => { const i = num(r.incomingBytes); const o = num(r.outgoingBytes); return i === null && o === null ? null : (i ?? 0) + (o ?? 0); }, 8);
    }
    default:
      return [];
  }
}

/** Compute a per-dimension rate (delta / dt) from the two latest counter samples. */
function rateReadings(
  rowsDesc: Array<{ assetId: string; timestamp: Date }>,
  assetIndex: Map<string, ScopeAssetRow>,
  dimKeyFn: (r: any) => string,
  dimLabelFn: (r: any) => string,
  counterFn: (r: any) => number | null,
  mult: number,
): Reading[] {
  const groups = new Map<string, any[]>();
  for (const row of rowsDesc) {
    const dimKey = dimKeyFn(row);
    const key = `${row.assetId}|${dimKey}`;
    const arr = groups.get(key) ?? [];
    if (arr.length < 2) { arr.push(row); groups.set(key, arr); }
  }
  const out: Reading[] = [];
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    const [newer, older] = arr; // desc order
    const asset = assetIndex.get(newer.assetId);
    if (!asset) continue;
    const cN = counterFn(newer); const cO = counterFn(older);
    const dt = (newer.timestamp.getTime() - older.timestamp.getTime()) / 1000;
    let value: number | null = null;
    if (cN !== null && cO !== null && dt > 0 && cN >= cO) value = ((cN - cO) * mult) / dt;
    out.push({ assetId: asset.id, hostname: asset.hostname, tags: asset.tags, dimKey: dimKeyFn(newer), dimLabel: dimLabelFn(newer), value });
  }
  return out;
}

async function resolveAssetStateReadings(trigger: Extract<Trigger, { type: "asset_state" }>, assets: ScopeAssetRow[]): Promise<Reading[]> {
  const index = new Map(assets.map((a) => [a.id, a]));
  const ids = assets.map((a) => a.id);
  const df = trigger.dimensionFilter ?? {};
  const mk = (a: ScopeAssetRow, dimKey: string, dimLabel: string, value: any): Reading => ({ assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey, dimLabel, value });

  switch (trigger.field) {
    case "monitorStatus": return assets.map((a) => mk(a, "", "", a.monitorStatus));
    case "status": return assets.map((a) => mk(a, "", "", a.status));
    case "consecutiveFailures": return assets.map((a) => mk(a, "", "", a.consecutiveFailures));
    case "dependencySuppressed": return assets.map((a) => mk(a, "", "", a.dependencySuppressed));
    case "quarantined": return assets.map((a) => mk(a, "", "", a.quarantinedAt !== null || a.status === "quarantined"));
    case "ifOperStatus": case "ifAdminStatus": {
      const col = trigger.field === "ifOperStatus" ? "operStatus" : "adminStatus";
      const since = new Date(Date.now() - DEFAULT_LOOKBACK_MS);
      const rows = await prisma.assetInterfaceSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: [{ assetId: "asc" }, { ifName: "asc" }, { timestamp: "desc" }], distinct: ["assetId", "ifName"], select: { assetId: true, ifName: true, operStatus: true, adminStatus: true } });
      return rows.filter((r) => substringMatch(r.ifName, df.ifNamePattern)).map((r) => { const a = index.get(r.assetId)!; return mk(a, r.ifName, r.ifName, (r as any)[col]); });
    }
    case "ipsecStatus": {
      const since = new Date(Date.now() - DEFAULT_LOOKBACK_MS);
      const rows = await prisma.assetIpsecTunnelSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: [{ assetId: "asc" }, { tunnelName: "asc" }, { timestamp: "desc" }], distinct: ["assetId", "tunnelName"], select: { assetId: true, tunnelName: true, status: true } });
      return rows.filter((r) => substringMatch(r.tunnelName, df.tunnelName)).map((r) => { const a = index.get(r.assetId)!; return mk(a, r.tunnelName, r.tunnelName, r.status); });
    }
    case "sdwanRuleStatus": case "sdwanSelectedMember": {
      const rows = await prisma.assetSdwanRule.findMany({ where: { assetId: { in: ids } }, select: { assetId: true, ruleName: true, status: true, selectedMember: true } });
      const col = trigger.field === "sdwanRuleStatus" ? "status" : "selectedMember";
      return rows.map((r) => { const a = index.get(r.assetId); if (!a) return null; return mk(a, r.ruleName, r.ruleName, (r as any)[col]); }).filter(Boolean) as Reading[];
    }
    default: return [];
  }
}

async function resolveHostMetricReading(trigger: Extract<Trigger, { type: "host_metric" }>): Promise<Reading | null> {
  const since = new Date(Date.now() - Math.max(trigger.windowSec * 1000, DEFAULT_LOOKBACK_MS));
  const rows = await prisma.hostMetricsSample.findMany({ where: { timestamp: { gte: since } }, orderBy: { timestamp: "desc" }, take: 2000 });
  if (rows.length === 0) return null;
  const num = (b: bigint) => Number(b);
  const valueOf = (r: any): number => {
    switch (trigger.metric) {
      case "cpuPct": return r.cpuPct;
      case "memUsedPct": return r.memUsedPct;
      case "memUsedBytes": return num(r.memUsedBytes);
      case "loadAvg1": return r.loadAvg1;
      case "loadAvg5": return r.loadAvg5;
      case "loadAvg15": return r.loadAvg15;
      case "procRssBytes": return num(r.procRssBytes);
      default: return NaN;
    }
  };
  let value: number;
  if (trigger.aggregation === "avg") value = rows.reduce((a, r) => a + valueOf(r), 0) / rows.length;
  else if (trigger.aggregation === "min") value = Math.min(...rows.map(valueOf));
  else if (trigger.aggregation === "max") value = Math.max(...rows.map(valueOf));
  else value = valueOf(rows[0]); // latest
  return { assetId: "", hostname: "Polaris host", tags: [], dimKey: "", dimLabel: "", value };
}

export function readingMeets(trigger: Trigger, value: number | string | boolean | null): boolean {
  if (value === null || value === undefined) return false;
  if (trigger.type === "asset_metric" || trigger.type === "host_metric") {
    return typeof value === "number" && compareNum(value, trigger.operator, trigger.threshold);
  }
  if (trigger.type === "asset_state") {
    return compareValue(value, trigger.operator, trigger.value);
  }
  return false;
}

// ─── Message templating ─────────────────────────────────────────────────────

function renderMessage(rule: DbRule, reading: Reading): string {
  const trigger = rule.trigger;
  const metric = trigger.type === "asset_metric" || trigger.type === "host_metric" ? trigger.metric
    : trigger.type === "asset_state" ? trigger.field : trigger.type;
  const threshold = trigger.type === "asset_metric" || trigger.type === "host_metric" ? String(trigger.threshold)
    : trigger.type === "asset_state" ? String(trigger.value) : "";
  const valueStr = reading.value === null ? "n/a" : typeof reading.value === "number" ? round2(reading.value) : String(reading.value);
  const assetStr = reading.hostname || reading.assetId || "host";
  const dim = reading.dimLabel ? ` [${reading.dimLabel}]` : "";
  if (rule.messageTemplate && rule.messageTemplate.trim()) {
    return rule.messageTemplate
      .replaceAll("{asset}", assetStr)
      .replaceAll("{metric}", String(metric))
      .replaceAll("{value}", valueStr)
      .replaceAll("{threshold}", threshold)
      .replaceAll("{dimension}", reading.dimLabel || "");
  }
  return `${rule.name}: ${assetStr}${dim} — ${metric} = ${valueStr} (threshold ${threshold})`;
}

function round2(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

// ─── Threshold / state evaluation ───────────────────────────────────────────

async function evaluateThresholdRule(rule: DbRule): Promise<void> {
  const trigger = rule.trigger;
  let readings: Reading[] = [];

  if (trigger.type === "host_metric") {
    const r = await resolveHostMetricReading(trigger);
    readings = r ? [r] : [];
  } else if (trigger.type === "asset_metric") {
    const assets = await loadScopeAssets(rule.scope);
    readings = await resolveAssetMetricReadings(trigger, assets);
  } else if (trigger.type === "asset_state") {
    const assets = await loadScopeAssets(rule.scope);
    readings = await resolveAssetStateReadings(trigger, assets);
  } else {
    return;
  }

  // Existing firing/pending state for this rule.
  const states = await prisma.notificationRuleState.findMany({ where: { ruleId: rule.id } });
  const stateMap = new Map(states.map((s) => [`${s.assetId ?? ""}|${s.dimensionKey}`, s]));
  const now = new Date();
  const seen = new Set<string>();

  for (const reading of readings) {
    const key = `${reading.assetId || ""}|${reading.dimKey}`;
    seen.add(key);
    const meets = readingMeets(trigger, reading.value);
    const st = stateMap.get(key);
    const lastValue = typeof reading.value === "number" ? reading.value : null;

    if (meets) {
      if (!st || st.state === "clear") {
        if ((trigger as any).forDurationSec > 0) {
          // start the sustained-duration timer
          await upsertState(rule.id, reading, "pending", { conditionMetSince: now, lastValue });
        } else {
          await fire(rule, reading, lastValue, now);
        }
      } else if (st.state === "pending") {
        const since = st.conditionMetSince ?? now;
        if (now.getTime() - since.getTime() >= (trigger as any).forDurationSec * 1000) {
          await fire(rule, reading, lastValue, now);
        }
        // else keep pending
      } // firing → already active; suppress
    } else {
      // condition not met for this reading
      if (st && st.state === "pending") {
        await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null } });
      } else if (st && st.state === "firing") {
        await recover(rule, st);
      }
    }
  }

  // Timed auto-clear: firing states past their timer, even without an explicit
  // recovery reading (e.g. the asset stopped reporting).
  if (rule.clearBehavior === "timed" && rule.clearAfterSec) {
    for (const st of states) {
      if (st.state === "firing" && st.firedAt && now.getTime() - st.firedAt.getTime() >= rule.clearAfterSec * 1000) {
        await clearActiveNotification(st, "system:timed");
        await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, notificationId: null } });
      }
    }
  }
}

async function upsertState(
  ruleId: string,
  reading: Reading,
  state: string,
  extra: { conditionMetSince?: Date | null; firedAt?: Date | null; lastValue?: number | null; notificationId?: string | null },
) {
  await prisma.notificationRuleState.upsert({
    where: { ruleId_assetId_dimensionKey: { ruleId, assetId: reading.assetId, dimensionKey: reading.dimKey } },
    create: { ruleId, assetId: reading.assetId, dimensionKey: reading.dimKey, state, ...extra },
    update: { state, ...extra },
  });
}

async function fire(rule: DbRule, reading: Reading, lastValue: number | null, now: Date): Promise<void> {
  // Respect cooldown: if this (rule,asset,dim) fired within cooldownSec, skip.
  const existing = await prisma.notificationRuleState.findUnique({
    where: { ruleId_assetId_dimensionKey: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey } },
  });
  if (rule.cooldownSec && existing?.firedAt && now.getTime() - existing.firedAt.getTime() < rule.cooldownSec * 1000) {
    return;
  }
  const notif = await prisma.notification.create({
    data: {
      ruleId: rule.id,
      assetId: reading.assetId || null,
      assetHostname: reading.hostname,
      severity: rule.severity,
      message: renderMessage(rule, reading),
      regionTags: regionSnapshot(reading.tags),
    },
  });
  await prisma.notificationRuleState.upsert({
    where: { ruleId_assetId_dimensionKey: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey } },
    create: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey, state: "firing", firedAt: now, lastValue, notificationId: notif.id },
    update: { state: "firing", firedAt: now, lastValue, notificationId: notif.id, conditionMetSince: null },
  });
  await expandDeliveriesSafe(notif.id, rule.targets);
  await logEvent({
    action: "notification.triggered",
    resourceType: "notification",
    resourceId: notif.id,
    resourceName: rule.name,
    actor: "system:notification-engine",
    level: rule.severity === "error" ? "error" : rule.severity === "warning" ? "warning" : "info",
    message: notif.message,
    details: { ruleId: rule.id, assetId: reading.assetId || null, dimension: reading.dimKey },
  });
}

async function recover(rule: DbRule, st: { id: string; notificationId: string | null }): Promise<void> {
  if (rule.clearBehavior === "auto") {
    await clearActiveNotification(st, "system:auto-resolve");
    await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, notificationId: null } });
    await logEvent({
      action: "notification.auto_cleared",
      resourceType: "notification",
      resourceId: st.notificationId ?? undefined,
      resourceName: rule.name,
      actor: "system:notification-engine",
      message: `Auto-resolved: ${rule.name} condition recovered`,
      details: { ruleId: rule.id },
    });
  } else {
    // manual / timed: re-arm the state but leave the notification for a human
    // (timed is swept by the timer pass; manual stays until cleared).
    if (rule.clearBehavior === "manual") {
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, notificationId: null } });
    }
  }
}

async function clearActiveNotification(st: { notificationId: string | null }, by: string): Promise<void> {
  if (!st.notificationId) return;
  await prisma.notification.updateMany({
    where: { id: st.notificationId, cleared: false },
    data: { cleared: true, clearedBy: by, clearedAt: new Date() },
  });
}

// ─── Event-tail evaluation ──────────────────────────────────────────────────

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

const LEVEL_RANK: Record<string, number> = { info: 0, warning: 1, error: 2 };

async function runEventTail(rules: DbRule[]): Promise<void> {
  const eventRules = rules.filter((r) => r.trigger.type === "event" || r.trigger.type === "change");
  if (eventRules.length === 0) return;

  const cursorRow = await prisma.setting.findUnique({ where: { key: LAST_EVENT_SETTING_KEY } });
  const cursorIso = (cursorRow?.value as any)?.lastTimestamp as string | undefined;
  const since = cursorIso ? new Date(cursorIso) : new Date(Date.now() - DEFAULT_LOOKBACK_MS);

  const events = await prisma.event.findMany({
    where: { timestamp: { gt: since } },
    orderBy: { timestamp: "asc" },
    take: 1000,
  });
  if (events.length === 0) return;

  // Precompile matchers. flatMap so non-event/change rules (shouldn't appear,
  // but the filter predicate isn't a type guard) are dropped and TS narrows.
  type CompiledMatcher = {
    rule: DbRule;
    re: RegExp;
    trigger: Extract<Trigger, { type: "event" }> | Extract<Trigger, { type: "change" }>;
  };
  const compiled: CompiledMatcher[] = eventRules.flatMap((r): CompiledMatcher[] => {
    if (r.trigger.type === "event") {
      return [{ rule: r, re: globToRegExp(r.trigger.actionPattern), trigger: r.trigger }];
    }
    if (r.trigger.type === "change") {
      const action = CHANGE_TYPE_ACTIONS[r.trigger.changeType];
      return [{ rule: r, re: globToRegExp(action), trigger: r.trigger }];
    }
    return [];
  });

  const toCreate: Prisma.NotificationCreateManyInput[] = [];
  // Notifications from rules with delivery targets get a client-generated id so
  // we can expand their deliveries after the batch insert (createMany returns
  // no ids). Rows without targets keep the DB default.
  const deliverAfter: { id: string; targets: DeliveryTarget[] }[] = [];
  for (const ev of events) {
    for (const c of compiled) {
      if (!c.re.test(ev.action)) continue;
      if (c.trigger.type === "event") {
        if (c.trigger.resourceType && ev.resourceType !== c.trigger.resourceType) continue;
        if (c.trigger.minLevel && (LEVEL_RANK[ev.level] ?? 0) < (LEVEL_RANK[c.trigger.minLevel] ?? 0)) continue;
        if (c.trigger.detailsMatch && !detailsMatch(ev.details, c.trigger.detailsMatch)) continue;
      }
      const assetId = ev.resourceType === "asset" ? ev.resourceId ?? null : null;
      const tags = assetId ? await assetTags(assetId) : [];
      const tmpl = c.rule.messageTemplate;
      const message = tmpl && tmpl.trim()
        ? tmpl.replaceAll("{asset}", ev.resourceName ?? "").replaceAll("{metric}", ev.action).replaceAll("{value}", ev.message)
        : `${c.rule.name}: ${ev.message}`;
      const hasTargets = Array.isArray(c.rule.targets) && c.rule.targets.length > 0;
      const id = hasTargets ? randomUUID() : undefined;
      if (hasTargets && id) deliverAfter.push({ id, targets: c.rule.targets });
      toCreate.push({
        ...(id ? { id } : {}),
        ruleId: c.rule.id,
        assetId,
        assetHostname: ev.resourceName ?? null,
        severity: c.rule.severity,
        message,
        regionTags: regionSnapshot(tags),
      });
    }
  }

  if (toCreate.length > 0) {
    await prisma.notification.createMany({ data: toCreate });
  }
  for (const d of deliverAfter) {
    await expandDeliveriesSafe(d.id, d.targets);
  }

  const newest = events[events.length - 1].timestamp.toISOString();
  await prisma.setting.upsert({
    where: { key: LAST_EVENT_SETTING_KEY },
    create: { key: LAST_EVENT_SETTING_KEY, value: { lastTimestamp: newest } },
    update: { value: { lastTimestamp: newest } },
  });
}

function detailsMatch(details: unknown, match: Record<string, string | number | boolean>): boolean {
  if (!details || typeof details !== "object") return false;
  const d = details as Record<string, unknown>;
  return Object.entries(match).every(([k, v]) => String(d[k]) === String(v));
}

const _assetTagCache = new Map<string, string[]>();
async function assetTags(assetId: string): Promise<string[]> {
  if (_assetTagCache.has(assetId)) return _assetTagCache.get(assetId)!;
  const a = await prisma.asset.findUnique({ where: { id: assetId }, select: { tags: true } });
  const tags = a?.tags ?? [];
  _assetTagCache.set(assetId, tags);
  return tags;
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function evaluateAllNotificationRules(): Promise<void> {
  const dbRules = await prisma.notificationRule.findMany({ where: { enabled: true } });
  const rules: DbRule[] = dbRules.map((r) => ({
    id: r.id, name: r.name, severity: r.severity,
    trigger: r.trigger as unknown as Trigger,
    scope: (r.scope ?? {}) as RuleScope,
    clearBehavior: r.clearBehavior, clearAfterSec: r.clearAfterSec, cooldownSec: r.cooldownSec,
    messageTemplate: r.messageTemplate,
    targets: Array.isArray(r.targets) ? (r.targets as unknown as DeliveryTarget[]) : [],
  }));

  _assetTagCache.clear();

  for (const rule of rules) {
    try {
      if (rule.trigger.type === "asset_metric" || rule.trigger.type === "asset_state" || rule.trigger.type === "host_metric") {
        await evaluateThresholdRule(rule);
      }
    } catch (err) {
      await logEvent({ action: "notification.engine_error", actor: "system:notification-engine", level: "error", message: `Rule "${rule.name}" evaluation failed`, details: { ruleId: rule.id, err: (err as Error)?.message } }).catch(() => {});
    }
  }

  try {
    await runEventTail(rules);
  } catch (err) {
    await logEvent({ action: "notification.engine_error", actor: "system:notification-engine", level: "error", message: "Event-tail evaluation failed", details: { err: (err as Error)?.message } }).catch(() => {});
  }
}

// ─── Preview (builder Test button) ──────────────────────────────────────────

export interface PreviewMatch {
  assetId: string | null;
  hostname: string | null;
  dimension: string;
  value: number | string | boolean | null;
  meets: boolean;
}

export interface PreviewResult {
  supported: boolean;
  note?: string;
  totalEvaluated: number;
  matches: PreviewMatch[];
}

/** Dry-run a draft rule against current data with NO writes. */
export async function previewRule(input: RuleInput): Promise<PreviewResult> {
  const trigger = input.trigger;
  let readings: Reading[] = [];

  if (trigger.type === "host_metric") {
    const r = await resolveHostMetricReading(trigger);
    readings = r ? [r] : [];
  } else if (trigger.type === "asset_metric") {
    const assets = await loadScopeAssets(input.scope);
    readings = await resolveAssetMetricReadings(trigger, assets);
  } else if (trigger.type === "asset_state") {
    const assets = await loadScopeAssets(input.scope);
    readings = await resolveAssetStateReadings(trigger, assets);
  } else {
    return { supported: false, note: "Event and change rules fire on new audit events; there's nothing to preview against current data.", totalEvaluated: 0, matches: [] };
  }

  const matches: PreviewMatch[] = readings.map((r) => ({
    assetId: r.assetId || null,
    hostname: r.hostname,
    dimension: r.dimLabel,
    value: r.value,
    meets: readingMeets(trigger, r.value),
  }));
  matches.sort((a, b) => Number(b.meets) - Number(a.meets));
  return { supported: true, totalEvaluated: readings.length, matches: matches.slice(0, 200) };
}
