/**
 * src/services/logFlagRuleService.ts — user-defined log-flag rules (Feature C).
 *
 * Operators define rules that FLAG matching process-log lines. Evaluation is at
 * READ time over the /process-logs query window — there is NO per-row persisted
 * flag, so a new or edited rule retroactively flags history with no backfill and
 * edits take effect on the next fetch.
 *
 * Rules are cached + compiled once (module-level, invalidated on any write) so
 * the hot read path doesn't recompile regexes per request. Scope narrows which
 * lines a rule applies to: global (every process log), asset (one asset), or
 * process (one asset + program name).
 *
 * The pure helpers (globToRegExp / compileRule / lineMatchesRule /
 * applicableRules) are exported for unit tests; the DB-bound CRUD + cache live
 * alongside.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";

export interface LogFlagRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  scope: string;            // "global" | "asset" | "process"
  assetId: string | null;
  processName: string | null;
  matchType: string;        // "substring" | "regex" | "glob"
  pattern: string;
  caseSensitive: boolean;
  minLevel: string | null;
  label: string | null;
  color: string | null;
}

export interface CompiledRule {
  rule: LogFlagRuleRow;
  /** Returns true when a log line (message + optional level) matches. */
  test: (message: string, level: string | null) => boolean;
}

const LEVEL_RANK: Record<string, number> = { info: 0, warning: 1, error: 2, critical: 3 };

/** Convert a glob (`*` = any run, `?` = any char) to an anchored RegExp source. */
export function globToRegExp(glob: string): string {
  let out = "^";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out + "$";
}

/**
 * Compile one rule into a matcher. Invalid regex patterns compile to a matcher
 * that never matches (so a typo can't throw on the read path) — the caller can
 * surface validity separately. Pure.
 */
export function compileRule(rule: LogFlagRuleRow): CompiledRule {
  const flags = rule.caseSensitive ? "" : "i";
  let re: RegExp | null = null;
  try {
    if (rule.matchType === "regex") {
      re = new RegExp(rule.pattern, flags);
    } else if (rule.matchType === "glob") {
      re = new RegExp(globToRegExp(rule.pattern), flags);
    }
  } catch {
    re = null; // invalid regex → never matches
  }
  const needle = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
  const minRank = rule.minLevel ? (LEVEL_RANK[rule.minLevel] ?? 0) : null;

  return {
    rule,
    test(message: string, level: string | null): boolean {
      // minLevel gate: suppress only when the line's level is KNOWN and below
      // the floor. Unknown level → don't suppress (can't compare).
      if (minRank != null && level && (LEVEL_RANK[level] ?? -1) >= 0 && (LEVEL_RANK[level] ?? 0) < minRank) {
        return false;
      }
      if (rule.matchType === "substring") {
        const hay = rule.caseSensitive ? message : message.toLowerCase();
        return hay.includes(needle);
      }
      return re != null && re.test(message);
    },
  };
}

// ─── Cache ──────────────────────────────────────────────────────────────────

let cache: CompiledRule[] | null = null;

/** Drop the cache so the next read recompiles. Called on every rule write. */
export function invalidateLogFlagRuleCache(): void {
  cache = null;
}

async function getCompiledRules(): Promise<CompiledRule[]> {
  if (cache) return cache;
  const rows = await prisma.logFlagRule.findMany({ where: { enabled: true } });
  cache = rows.map((r) => compileRule(r as LogFlagRuleRow));
  return cache;
}

/** Filter compiled rules to those whose scope applies to (assetId, processName). Pure. */
export function applicableRules(rules: CompiledRule[], assetId: string, processName: string): CompiledRule[] {
  return rules.filter((c) => {
    const r = c.rule;
    if (r.scope === "global") return true;
    if (r.scope === "asset") return r.assetId === assetId;
    if (r.scope === "process") return r.assetId === assetId && r.processName === processName;
    return false;
  });
}

export interface FlaggedLogLine {
  timestamp: Date | string;
  level: string | null;
  message: string;
  source: string | null;
  /** Rule labels/ids that matched this line (empty when none). */
  flags: Array<{ id: string; name: string; label: string | null; color: string | null }>;
}

/**
 * Annotate log rows with the rules that matched each line. Returns every row
 * with a `flags` array (empty when unmatched). `onlyFlagged` drops unmatched rows.
 */
export async function evaluateLogFlags(
  assetId: string,
  processName: string,
  rows: Array<{ timestamp: Date | string; level: string | null; message: string; source: string | null }>,
  onlyFlagged = false,
): Promise<FlaggedLogLine[]> {
  const compiled = applicableRules(await getCompiledRules(), assetId, processName);
  const out: FlaggedLogLine[] = [];
  for (const row of rows) {
    const flags = compiled
      .filter((c) => c.test(row.message, row.level))
      .map((c) => ({ id: c.rule.id, name: c.rule.name, label: c.rule.label, color: c.rule.color }));
    if (onlyFlagged && flags.length === 0) continue;
    out.push({ ...row, flags });
  }
  return out;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────

export interface LogFlagRuleInput {
  name: string;
  enabled?: boolean;
  scope: string;
  assetId?: string | null;
  processName?: string | null;
  matchType: string;
  pattern: string;
  caseSensitive?: boolean;
  minLevel?: string | null;
  label?: string | null;
  color?: string | null;
}

export async function listLogFlagRules(): Promise<LogFlagRuleRow[]> {
  return (await prisma.logFlagRule.findMany({ orderBy: [{ scope: "asc" }, { name: "asc" }] })) as LogFlagRuleRow[];
}

export async function createLogFlagRule(input: LogFlagRuleInput, actor?: string): Promise<LogFlagRuleRow> {
  const row = await prisma.logFlagRule.create({
    data: {
      name: input.name,
      enabled: input.enabled ?? true,
      scope: input.scope,
      assetId: input.scope === "global" ? null : (input.assetId ?? null),
      processName: input.scope === "process" ? (input.processName ?? null) : null,
      matchType: input.matchType,
      pattern: input.pattern,
      caseSensitive: input.caseSensitive ?? false,
      minLevel: input.minLevel ?? null,
      label: input.label ?? null,
      color: input.color ?? null,
      createdBy: actor ?? null,
    },
  });
  invalidateLogFlagRuleCache();
  void logEvent({ action: "logflagrule.created", resourceType: "log_flag_rule", resourceId: row.id, resourceName: row.name, actor, message: `Log-flag rule "${row.name}" created` });
  return row as LogFlagRuleRow;
}

export async function updateLogFlagRule(id: string, input: Partial<LogFlagRuleInput>, actor?: string): Promise<LogFlagRuleRow> {
  const data: Record<string, unknown> = {};
  for (const k of ["name", "enabled", "scope", "matchType", "pattern", "caseSensitive", "minLevel", "label", "color"] as const) {
    if (input[k] !== undefined) data[k] = input[k];
  }
  // Keep scope/assetId/processName coherent when scope changes.
  if (input.scope !== undefined || input.assetId !== undefined) {
    data.assetId = input.scope === "global" ? null : (input.assetId ?? null);
  }
  if (input.scope !== undefined || input.processName !== undefined) {
    data.processName = (input.scope ?? "") === "process" ? (input.processName ?? null) : (input.scope !== undefined ? null : input.processName ?? null);
  }
  const row = await prisma.logFlagRule.update({ where: { id }, data });
  invalidateLogFlagRuleCache();
  void logEvent({ action: "logflagrule.updated", resourceType: "log_flag_rule", resourceId: row.id, resourceName: row.name, actor, message: `Log-flag rule "${row.name}" updated` });
  return row as LogFlagRuleRow;
}

export async function deleteLogFlagRule(id: string, actor?: string): Promise<void> {
  const row = await prisma.logFlagRule.delete({ where: { id } });
  invalidateLogFlagRuleCache();
  void logEvent({ action: "logflagrule.deleted", resourceType: "log_flag_rule", resourceId: id, resourceName: row.name, actor, message: `Log-flag rule "${row.name}" deleted` });
}
