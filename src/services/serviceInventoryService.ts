// serviceInventoryService — current-state systemd unit / Windows service
// inventory writer. The service DIMENSION counterpart to the process inventory
// (persistAssetProcesses in monitoringService): units keyed by name, not by the
// backing program, so a service running as a shared runtime (e.g. a Spring Boot
// app as "java") is visible as itself and oneshot/exited units still appear.
//
// Single writer: the agent's `serviceInventory` sample stream. Full-replace per
// push (delete-then-insert in one $transaction, retryOnDeadlock), mirroring
// persistAssetProcesses / persistSdwanRules — a reader sees either the old set
// or the new set, never an empty intermediate. Agent-only (agentless SSH/WinRM
// does not resolve units).
import { randomUUID } from "node:crypto";

import { prisma } from "../db.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";

export interface AssetServiceInput {
  unit:         string;
  platform:     "systemd" | "windows";
  displayName:  string | null;
  loadState:    string | null;
  activeState:  string | null;
  subState:     string | null;
  enabledState: string | null;
  mainPid:      number | null;
  mainProcess:  string | null;
  memBytes:     bigint | null;
}

/**
 * True when the unit/service can be start/stop/restarted via the AgentCommand
 * queue. systemd: any loaded, non-masked unit (`systemctl start/stop/restart`
 * targets the unit regardless of current active state — needed to *start* a
 * stopped service). Windows: every SCM service is controllable via `net`/`sc`.
 * A masked or not-found systemd unit cannot be acted on.
 */
export function isServiceControllable(s: AssetServiceInput): boolean {
  if (s.platform === "windows") return true;
  const load = (s.loadState ?? "").toLowerCase();
  return load === "loaded";
}

/**
 * Current-state service inventory full-replace for one asset. An empty `rows`
 * is a valid delete-only scrape (a host that lost its agent / has no services).
 */
export async function persistAssetServices(
  assetId: string,
  rows: AssetServiceInput[],
): Promise<void> {
  const data = rows.map((r) => ({
    id:           randomUUID(),
    assetId,
    unit:         r.unit,
    platform:     r.platform,
    displayName:  r.displayName,
    loadState:    r.loadState,
    activeState:  r.activeState,
    subState:     r.subState,
    enabledState: r.enabledState,
    mainPid:      r.mainPid,
    mainProcess:  r.mainProcess,
    memBytes:     r.memBytes,
    controllable: isServiceControllable(r),
  }));
  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetService.deleteMany({ where: { assetId } }),
      ...(data.length > 0
        ? [prisma.assetService.createMany({ data, skipDuplicates: true })]
        : []),
    ]),
  );
}
