/**
 * src/utils/role.ts — process role model for the multi-process split.
 *
 * Polaris can run as a single monolithic process (the historical default) or
 * as a fleet of specialized processes that coordinate through the shared
 * PostgreSQL + pg-boss queue:
 *
 *   • web       — single instance. HTTP/HTTPS/agent-WS + /health + /metrics,
 *                 ALL singleton schedulers, and one-shot migrations/seeds.
 *                 The control plane.
 *   • monitor   — N replicas. Pure pg-boss monitor-queue consumers. pg-boss
 *                 hands each job to exactly one worker, so N replicas never
 *                 double-execute.
 *   • discovery — 1+ instance. Pure consumer of the discovery queue.
 *   • all       — default when POLARIS_ROLE is unset. Every capability on —
 *                 today's exact single-process behavior, so existing installs
 *                 and `npm run dev` are unaffected.
 *
 * The boot path branches on the capability booleans below, never on the role
 * string directly, so adding/retuning a role is a one-place change.
 */

import { logger } from "./logger.js";

export type PolarisRole = "all" | "web" | "monitor" | "discovery";

export interface RoleConfig {
  role: PolarisRole;
  /** Express + HTTPS + agent WebSocket + /health + /metrics. */
  runsHttp: boolean;
  /** pg-boss monitor cadence `boss.work()` handlers + the floating pool. */
  runsMonitorConsumers: boolean;
  /** pg-boss discovery queue consumer (`runDiscovery`). */
  runsDiscoveryConsumers: boolean;
  /** All singleton ticks/schedulers (monitor producer, discovery scheduler, reconcilers, rollups…). */
  runsSchedulers: boolean;
  /** One-shot startup migrate/seed/backfill jobs + TimescaleDB hypertable DDL. */
  runsMigrations: boolean;
  /** sampleWriteBuffer + probePatchBuffer flush loops. Needed by BOTH the
   *  monitor role (SNMP/REST probe + telemetry + system-info samples) AND the
   *  web role — the Polaris Agent `/samples` + `/probe-now` endpoints are
   *  mounted on the HTTP listener and enqueue into the same in-process
   *  buffers; without the flush tick those agent-sourced rows sit in memory
   *  and only land on graceful shutdown. */
  runsWriteBuffers: boolean;
}

const VALID_ROLES: readonly PolarisRole[] = ["all", "web", "monitor", "discovery"];

let cachedRole: PolarisRole | null = null;

/**
 * Resolve the process role from POLARIS_ROLE. Unset (or empty) ⇒ "all". An
 * unrecognized value logs a warning and falls back to "all" so a typo degrades
 * to the safe monolithic behavior rather than booting a half-dead process.
 * Cached after the first call — the role is constant for the life of the process.
 */
export function getRole(): PolarisRole {
  if (cachedRole) return cachedRole;
  const raw = (process.env.POLARIS_ROLE || "").trim().toLowerCase();
  if (!raw) {
    cachedRole = "all";
  } else if ((VALID_ROLES as readonly string[]).includes(raw)) {
    cachedRole = raw as PolarisRole;
  } else {
    logger.warn(
      { POLARIS_ROLE: raw, validRoles: VALID_ROLES },
      `Unrecognized POLARIS_ROLE "${raw}"; falling back to "all" (single-process mode)`,
    );
    cachedRole = "all";
  }
  return cachedRole;
}

/**
 * Capability flags for a role. Defaults to the current process's role.
 *
 * Placement rationale:
 *   - Schedulers + migrations are pinned to web (single instance) so the
 *     singleton invariant is trivially satisfied; monitor (N replicas) and
 *     discovery stay pure consumers.
 *   - Write buffers ride with the monitor consumers — they batch what the
 *     consumers produce.
 */
export function roleConfig(role: PolarisRole = getRole()): RoleConfig {
  const all = role === "all";
  return {
    role,
    runsHttp: all || role === "web",
    runsMonitorConsumers: all || role === "monitor",
    runsDiscoveryConsumers: all || role === "discovery",
    runsSchedulers: all || role === "web",
    runsMigrations: all || role === "web",
    runsWriteBuffers: all || role === "monitor" || role === "web",
  };
}

/** Test-only: clear the cached role so a test can re-resolve from env. */
export function __resetRoleForTests(): void {
  cachedRole = null;
}
