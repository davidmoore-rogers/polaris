/**
 * src/services/infraReservationPushService.ts
 *
 * Opt-in post-sync pass: turn a managed FortiSwitch's / FortiAP's dynamic DHCP
 * lease into a real MAC→IP `reserved-address` entry on its own FortiGate.
 *
 * The problem it solves: discovery records every managed switch/AP address as a
 * reservation, but on a FortiLink-style pool the gate is only LEASING that
 * address — nothing pins it, and the FortiGate's own DHCP page says
 * "Not Reserved". Operators who want those addresses pinned had to click Reserve
 * on each one.
 *
 * SAFETY — this writes DHCP configuration to production network devices on a
 * schedule, which nothing else in Polaris does (every other DHCP write is an
 * operator acting on one IP):
 *   • Opt-in twice. `config.pushReservations` is the transport gate and
 *     `config.autoReserveFortinetInfra` is this feature; both must be on, and the
 *     UI warns before either is. Off by default.
 *   • Net-neutral on the pool. Only addresses the device ALREADY holds by lease
 *     are pinned, so the number of addresses in use doesn't change — this is not
 *     a mechanism for claiming free space.
 *   • MAC from the lease table only. `reservation.macAddress` on these rows is
 *     filled by the Phase 5 infra branch from the DHCP entry — the MAC the gate
 *     actually saw requesting the address. A device's base MAC is NOT reliably
 *     its DHCP client MAC, and binding the wrong one produces an entry that
 *     looks right on both sides and never binds.
 *   • Bounded + paced. At most RUN_CEILING writes per integration per discovery
 *     cycle at low concurrency; the rest are picked up on later cycles.
 *   • Idempotent. A row that already carries push pointers or a push status is
 *     never re-attempted, so a refused write is not retried into the ground.
 *   • Verified. `pushReservation` reads the entry back and throws if it didn't
 *     land; a permanent refusal is recorded on the row (visible as "Push failed"
 *     in the IP panel with the device's own error) rather than silently retried.
 *
 * Reversal is the step-2 lifecycle release: decommissioning or deleting the
 * device unpushes the entry, because the push pointers stamped here are exactly
 * what `releaseReservation`'s pinned-unpush branch looks for.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { logger } from "../utils/logger.js";
import { mapSettledWithConcurrency } from "../utils/concurrency.js";
import {
  pushReservation,
  classifyPushError,
  integrationPushEnabled,
} from "./reservationPushService.js";

/**
 * Device writes per integration per discovery cycle. Deliberately far below the
 * release path's ceiling: each one is a CMDB write plus a read-back verify
 * against a production gate (through the FMG proxy lane, on FMG installs), and
 * there is no deadline — a 780-AP fleet converges over a few cycles rather than
 * arriving as one burst.
 */
const RUN_CEILING = 25;

/** Concurrent pushes. Low on purpose: these share the FMG worker lanes. */
const PUSH_CONCURRENCY = 2;

export interface InfraPushResult {
  attempted: number;
  pushed: number;
  failed: number;
  /** Eligible but over this cycle's ceiling. */
  deferred: number;
}

/** The per-row facts the eligibility decision needs. Pure — see below. */
export interface InfraPushCandidateRow {
  sourceType: string;
  dhcpBinding?: string | null;
  macAddress?: string | null;
  pushedToId?: string | null;
  pushStatus?: string | null;
  subnetDiscoveredBy?: string | null;
  subnetFortigateDevice?: string | null;
}

/**
 * Is this reservation row eligible for an automatic device-side reservation?
 *
 * Pure so the conditions that keep this from writing the wrong thing are
 * unit-testable without a FortiGate:
 *   • it must be a managed-infra row the gate currently only LEASES — a row
 *     already backed by a reservation has nothing to do, and a NULL binding
 *     means DHCP never reported the address at all,
 *   • it must carry the lease-table MAC (see the header),
 *   • it must belong to this integration and name a gate to write to,
 *   • and it must be untouched by any previous push attempt, which is what stops
 *     a gate that refuses these entries from being asked again every cycle.
 */
export function isInfraPushCandidate(
  row: InfraPushCandidateRow,
  integrationId: string,
): boolean {
  if (row.sourceType !== "fortiswitch" && row.sourceType !== "fortinap") return false;
  if (row.dhcpBinding !== "lease") return false;
  if (!row.macAddress) return false;
  if (row.pushedToId || row.pushStatus) return false;
  if (row.subnetDiscoveredBy !== integrationId) return false;
  return !!row.subnetFortigateDevice;
}

export async function runInfraReservationPush(params: {
  integrationId: string;
  integrationName: string;
  actor?: string;
  signal?: AbortSignal;
}): Promise<InfraPushResult> {
  const out: InfraPushResult = { attempted: 0, pushed: 0, failed: 0, deferred: 0 };

  const integration = await prisma.integration.findUnique({
    where: { id: params.integrationId },
    select: { id: true, type: true, config: true },
  });
  if (!integration) return out;

  // Both gates. integrationPushEnabled is the shared transport nucleus — the
  // feature flag alone must never be enough to write to a device.
  if (!integrationPushEnabled(integration)) return out;
  const cfg = (integration.config ?? {}) as Record<string, unknown>;
  if (cfg.autoReserveFortinetInfra !== true) return out;

  // Only assets this integration owns, and only ones currently in service:
  // pinning the address of a device that's on its way out is pointless work.
  const assets = await prisma.asset.findMany({
    where: {
      discoveredByIntegrationId: params.integrationId,
      assetType: { in: ["switch", "access_point"] },
      status: "active",
      ipAddress: { not: null },
    },
    select: { id: true, hostname: true, ipAddress: true },
  });
  if (assets.length === 0) return out;

  const ips = Array.from(new Set(assets.map((a) => a.ipAddress!).filter(Boolean)));
  const rows = await prisma.reservation.findMany({
    where: { ipAddress: { in: ips }, status: "active" },
    select: {
      id: true, ipAddress: true, hostname: true, notes: true, macAddress: true,
      sourceType: true, dhcpBinding: true, pushedToId: true, pushStatus: true,
      subnet: { select: { cidr: true, discoveredBy: true, fortigateDevice: true } },
    },
  });

  const eligible = rows.filter((r) =>
    isInfraPushCandidate(
      {
        sourceType: r.sourceType,
        dhcpBinding: r.dhcpBinding,
        macAddress: r.macAddress,
        pushedToId: r.pushedToId,
        pushStatus: r.pushStatus,
        subnetDiscoveredBy: r.subnet.discoveredBy,
        subnetFortigateDevice: r.subnet.fortigateDevice,
      },
      params.integrationId,
    ),
  );
  if (eligible.length === 0) return out;

  const batch = eligible.slice(0, RUN_CEILING);
  out.deferred = eligible.length - batch.length;
  out.attempted = batch.length;

  const results = await mapSettledWithConcurrency(batch, PUSH_CONCURRENCY, async (row) => {
    if (params.signal?.aborted) throw new Error("aborted");
    const result = await pushReservation({
      reservationId: row.id,
      subnetCidr: row.subnet.cidr,
      ip: row.ipAddress!,
      mac: row.macAddress!,
      hostname: row.hostname,
      notes: null,
      createdBy: "system:auto-reserve",
      integration,
      deviceName: row.subnet.fortigateDevice!,
    });
    // Stamp the pointers the release path needs to find this entry again, and
    // record that the gate now RESERVES the address rather than leasing it —
    // the next discovery cycle would observe the same thing, this just avoids
    // a cycle of disagreement in between.
    await prisma.reservation.update({
      where: { id: row.id },
      data: {
        pushedToId: integration.id,
        pushedScopeId: result.scopeId,
        pushedEntryId: result.entryId,
        pushStatus: "synced",
        pushedAt: new Date(),
        pushError: null,
        dhcpBinding: "reservation",
      },
    });
    return row;
  });

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const row = batch[i];
    if (r.status === "fulfilled") { out.pushed++; continue; }
    out.failed++;
    const err = (r as PromiseRejectedResult).reason;
    const kind = classifyPushError(err);
    // Permanent refusals are recorded ON the row: it takes the reservation out
    // of the candidate set (so a gate that rejects these entries isn't asked
    // again every cycle) and surfaces in the IP panel as "Push failed" with the
    // device's own message, which is the only way an operator learns why.
    // Transient failures are left alone — the next discovery cycle retries.
    if (kind === "permanent") {
      await prisma.reservation.update({
        where: { id: row.id },
        data: {
          pushStatus: "failed_permanent",
          pushError: String(err?.message || err).slice(0, 500),
          pushLastAttemptAt: new Date(),
        },
      }).catch(() => { /* the summary Event below still records the failure */ });
    }
    logger.warn(
      { reservationId: row.id, ip: row.ipAddress, kind, err },
      "infraReservationPush: push failed",
    );
  }

  if (out.attempted > 0) {
    void logEvent({
      action: "reservation.infra.auto_pushed",
      resourceType: "integration",
      resourceId: params.integrationId,
      resourceName: params.integrationName,
      actor: params.actor,
      level: out.failed > 0 ? "warning" : "info",
      message: `Auto-reserved ${out.pushed} managed device address(es) on their FortiGate`
        + (out.failed > 0 ? `; ${out.failed} failed` : "")
        + (out.deferred > 0 ? `; ${out.deferred} deferred to the next cycle` : ""),
      details: {
        integrationId: params.integrationId,
        attempted: out.attempted,
        pushed: out.pushed,
        failed: out.failed,
        deferred: out.deferred,
        ips: batch.slice(0, 25).map((r) => r.ipAddress),
      },
    });
  }
  return out;
}
