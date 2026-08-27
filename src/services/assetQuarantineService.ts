/**
 * src/services/assetQuarantineService.ts — Push / release asset MAC
 * quarantine on FortiGates.
 *
 * Pushes every MAC associated with an asset to every FortiGate the asset
 * has been recently sighted on (per assetSightingService) using the
 * persistent FortiOS user.quarantine.targets CMDB tree. Each Polaris-
 * managed quarantine becomes a single target named `polaris-<short-id>`
 * on the FortiGate, with one MAC entry per associated MAC. Release
 * deletes the target wholesale.
 *
 * ── FortiOS endpoint assumption ─────────────────────────────────────────
 * The CMDB tree this service writes to is:
 *
 *     /api/v2/cmdb/user/quarantine/targets
 *     /api/v2/cmdb/user/quarantine/targets/<name>
 *     /api/v2/cmdb/user/quarantine/targets/<name>/macs
 *     /api/v2/cmdb/user/quarantine/targets/<name>/macs/<mac>
 *
 * This matches FortiOS 7.0+ persistent NAC quarantine. Earlier majors
 * (6.4 and below) and some branch-class images may surface the table at
 * a slightly different path or omit it entirely. Operators should verify
 * with a dry "Test Quarantine Permission" call (a no-op GET against
 * `/cmdb/user/quarantine/targets`) before enabling push on an integration.
 *
 * ── Transport ───────────────────────────────────────────────────────────
 * Identical to reservationPushService:
 *   - useProxy=true  → wrap each call in FMG `/sys/proxy/json`
 *   - useProxy=false → resolve the device's mgmt IP via FMG, then call
 *                       the FortiGate REST API directly with
 *                       `fortigateApiUser` / `fortigateApiToken`.
 *
 * ── Atomicity ──────────────────────────────────────────────────────────
 * Per-FortiGate is all-or-nothing: a partial-target write rolls back by
 * deleting the target before throwing. Across-FortiGate is best-effort:
 * if 3 of 5 sites succeed, the asset still flips to `quarantined` and
 * the failed targets are recorded as `status: "failed"` in
 * `Asset.quarantineTargets[]` so an operator can retry.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import {
  buildTransportForIntegration,
  callFortiOs,
  normalizeMac,
  type Transport,
} from "./reservationPushService.js";
import { getQuarantineCandidates, type AssetSighting } from "./assetSightingService.js";
import { expandMacRange } from "../utils/macAddresses.js";

// ─── FortiOS user.quarantine shapes (subset) ────────────────────────────

interface FortiOsQuarantineTarget {
  name?: string;
  description?: string;
  entry?: string;
  macs?: Array<{
    mac?: string;
    description?: string;
  }>;
}

// ─── Transport ──────────────────────────────────────────────────────────
// Shared with every other FortiOS write pathway: buildTransportForIntegration
// / callFortiOs / normalizeMac are imported from reservationPushService (the
// Transport surface's home). This file carried byte-identical private copies
// until 2026-08, when the 2026-08-04 production-readiness audit called it out.
// (The report itself is a generated artifact and is no longer tracked — see
// .gitignore — so this records the finding rather than pointing at a path.)

// ─── Helpers ───────────────────────────────────────────────────────────

export function quarantineTargetName(assetId: string): string {
  // FortiOS object names are typically capped at 35 chars. `polaris-q-`
  // is 10 chars; a short asset id of 12 hex chars gives a 22-char total
  // with comfortable headroom across versions. Strip dashes from the
  // UUID so the name is a clean prefix + alphanumeric tail.
  const compact = assetId.replace(/-/g, "");
  return `polaris-q-${compact.slice(0, 12)}`;
}

function buildMacDescription(
  hostname: string | null | undefined,
  actor: string,
  fallback: string,
): string {
  // Format: "Polaris/<actor>: <hostname>" — origin first so a FortiGate
  // admin scanning the quarantine list immediately sees Polaris owns this
  // entry and which user/token initiated it.
  const name = (hostname && hostname.trim()) || fallback || "(unnamed)";
  const candidate = `Polaris/${actor}: ${name}`;
  return candidate.length > 64 ? candidate.slice(0, 64) : candidate;
}

async function getTarget(
  t: Transport,
  name: string,
): Promise<FortiOsQuarantineTarget | null> {
  try {
    const data = await callFortiOs<FortiOsQuarantineTarget | FortiOsQuarantineTarget[]>(
      t,
      "GET",
      `/api/v2/cmdb/user/quarantine/targets/${encodeURIComponent(name)}`,
    );
    if (Array.isArray(data)) return data[0] ?? null;
    return data ?? null;
  } catch (err: any) {
    // 404 is expected when the target doesn't exist yet.
    if (err?.status === 404 || /not found|does not exist|404/i.test(String(err?.message || ""))) {
      return null;
    }
    throw err;
  }
}

async function deleteTarget(t: Transport, name: string): Promise<{ removed: boolean; alreadyAbsent: boolean }> {
  try {
    await callFortiOs<unknown>(
      t,
      "DELETE",
      `/api/v2/cmdb/user/quarantine/targets/${encodeURIComponent(name)}`,
    );
    return { removed: true, alreadyAbsent: false };
  } catch (err: any) {
    if (err?.status === 404 || /not found|does not exist|404/i.test(String(err?.message || ""))) {
      return { removed: false, alreadyAbsent: true };
    }
    throw err;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface PushQuarantineParams {
  assetId: string;
  hostname?: string | null;
  /** All MACs to write to this device. Caller dedupes + normalizes. */
  macs: string[];
  /** "user:<username>" or "api:<token-name>" or "system:auto-quarantine". */
  actor: string;
  /** Pre-built transport for the target FortiGate. */
  transport: Transport;
  /** Device name (informational, used in error messages and result). */
  deviceName: string;
}

export interface PushQuarantineResult {
  fortigateDevice: string;
  targetName: string;
  pushedMacs: string[];
}

/**
 * Push a per-asset quarantine target to one FortiGate. Idempotent: if the
 * target already exists, its MAC list is reconciled to match `macs` (adds
 * missing entries, removes stale ones). On any verify failure the target
 * is rolled back (deleted) before throwing so a partial write doesn't
 * leave the device in an inconsistent state.
 */
export async function pushQuarantineToFortigate(
  params: PushQuarantineParams,
): Promise<PushQuarantineResult> {
  if (!params.deviceName) {
    throw new AppError(400, "Push requires a FortiGate device name");
  }
  if (params.macs.length === 0) {
    throw new AppError(400, "Push requires at least one MAC");
  }

  const targetName = quarantineTargetName(params.assetId);
  const desiredMacs = Array.from(new Set(params.macs.map(normalizeMac)))
    .filter((m) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m));
  if (desiredMacs.length === 0) {
    throw new AppError(400, "Push requires at least one valid MAC");
  }

  const t = params.transport;
  const existing = await getTarget(t, targetName);
  const existingMacs = new Set(
    (existing?.macs ?? []).map((m) => normalizeMac(m.mac || "")).filter(Boolean),
  );

  const targetWasNew = !existing;

  try {
    if (!existing) {
      // Create a fresh target with all desired MACs in one shot.
      await callFortiOs<unknown>(t, "POST", `/api/v2/cmdb/user/quarantine/targets`, {
        name: targetName,
        description: `Polaris asset quarantine — ${params.actor}`,
        macs: desiredMacs.map((mac) => ({
          mac,
          description: buildMacDescription(params.hostname, params.actor, mac),
        })),
      });
    } else {
      // Reconcile in ONE call: PUT the full desired MAC set on the parent
      // target. FortiOS CMDB PUT replaces the object's `macs` child table with
      // the provided list, so this adds missing entries and removes stale ones
      // atomically — instead of one POST/DELETE round-trip per MAC (FortiManager
      // API Best Practices Guide: multiplex multiple objects into one request).
      // The create path above already multiplexes the same `macs` array shape,
      // and `callFortiOs` PUT carries the body on both transports (FMG proxy +
      // direct FortiGate), so this keeps FMG↔FortiGate parity.
      const desiredSet = new Set(desiredMacs);
      const needsReconcile =
        desiredMacs.some((m) => !existingMacs.has(m)) ||
        Array.from(existingMacs).some((m) => !desiredSet.has(m));
      if (needsReconcile) {
        await callFortiOs<unknown>(
          t,
          "PUT",
          `/api/v2/cmdb/user/quarantine/targets/${encodeURIComponent(targetName)}`,
          {
            macs: desiredMacs.map((mac) => ({
              mac,
              description: buildMacDescription(params.hostname, params.actor, mac),
            })),
          },
        );
      }
    }

    // Verify by reading the target back.
    const after = await getTarget(t, targetName);
    if (!after) {
      throw new AppError(502, `FortiGate accepted the write but the quarantine target ${targetName} was not visible on read-back`);
    }
    const verifiedMacs = new Set(
      (after.macs ?? []).map((m) => normalizeMac(m.mac || "")).filter(Boolean),
    );
    const missing = desiredMacs.filter((m) => !verifiedMacs.has(m));
    if (missing.length > 0) {
      throw new AppError(502, `FortiGate verify mismatch — target ${targetName} is missing MACs: ${missing.join(", ")}`);
    }

    return { fortigateDevice: params.deviceName, targetName, pushedMacs: desiredMacs };
  } catch (err) {
    // Roll back partial writes so we never leave the device in a half-
    // configured state. Only roll back the target itself if we just
    // created it; if it already existed, leave it alone (the operator's
    // prior state may have included entries we shouldn't blow away).
    if (targetWasNew) {
      try {
        await deleteTarget(t, targetName);
      } catch {
        /* swallow rollback failure — caller still surfaces the original error */
      }
    }
    throw err;
  }
}

export interface UnpushQuarantineParams {
  assetId: string;
  transport: Transport;
}

export interface UnpushQuarantineResult {
  removed: boolean;
  alreadyAbsent: boolean;
}

export async function unpushQuarantineFromFortigate(
  params: UnpushQuarantineParams,
): Promise<UnpushQuarantineResult> {
  const targetName = quarantineTargetName(params.assetId);
  return deleteTarget(params.transport, targetName);
}

/**
 * Read-only verify against the device. Returns true if the target exists
 * and contains every desired MAC; false otherwise. Used by the discovery
 * sync for drift detection.
 */
export async function verifyQuarantineOnFortigate(params: {
  assetId: string;
  desiredMacs: string[];
  transport: Transport;
}): Promise<{ present: boolean; missingMacs: string[] }> {
  const targetName = quarantineTargetName(params.assetId);
  const desired = Array.from(new Set(params.desiredMacs.map(normalizeMac)));
  const target = await getTarget(params.transport, targetName);
  if (!target) return { present: false, missingMacs: desired };
  const verifiedMacs = new Set(
    (target.macs ?? []).map((m) => normalizeMac(m.mac || "")).filter(Boolean),
  );
  const missingMacs = desired.filter((m) => !verifiedMacs.has(m));
  return { present: missingMacs.length === 0, missingMacs };
}

// ─── High-level orchestration ───────────────────────────────────────────

/**
 * Per-FortiGate record stamped on Asset.quarantineTargets[]. Status:
 *   "synced" — push verified on read-back
 *   "failed" — last push attempt errored; may retry
 *   "drift"  — was synced; later discovery found the target/MACs missing
 */
export interface QuarantineTargetRecord {
  fortigateDevice: string;
  integrationId: string;
  pushedMacs: string[];
  pushedAt: string;
  status: "synced" | "failed" | "drift";
  error?: string;
}

function macsForAsset(asset: { macAddress: string | null; macAddressRows?: Array<{ mac: string; macEnd?: string | null }> }): string[] {
  const set = new Set<string>();
  if (asset.macAddress) set.add(normalizeMac(asset.macAddress));
  if (Array.isArray(asset.macAddressRows)) {
    for (const entry of asset.macAddressRows) {
      if (!entry?.mac) continue;
      // Interface-fold range rows expand so quarantine blocks every port MAC
      // in the range, not just the range start. Capped — a quarantined asset
      // is an endpoint, so real ranges here are a handful of NICs.
      for (const mac of expandMacRange(entry.mac, entry.macEnd ?? null, 64)) {
        const m = normalizeMac(mac);
        if (m) set.add(m);
      }
    }
  }
  return Array.from(set).filter((m) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m));
}

export interface QuarantineAssetParams {
  assetId: string;
  actor: string; // "user:<username>" | "api:<token-name>" | "system:auto-quarantine"
  reason?: string;
  // When provided (bearer-token callers), restricts which integrations the
  // push will fan out to. Sightings whose originating integration is not in
  // this list are silently ignored, so a SIEM token minted for "Site A" can
  // never accidentally quarantine via Site B's FortiGate. Undefined =
  // session-authenticated or system caller; no filter applied.
  tokenIntegrationIds?: string[];
}

export interface QuarantineAssetResult {
  assetId: string;
  status: "quarantined" | "ineligible";
  targets: QuarantineTargetRecord[];
  succeededCount: number;
  failedCount: number;
  message: string;
}

/**
 * Whether quarantine push is available on this install at all: does ANY
 * enabled FortiManager / FortiGate integration carry `config.pushQuarantine`?
 *
 * `quarantineAsset` already skips every sighting whose integration has the
 * toggle off, so with it off fleet-wide a push resolves to zero targets and
 * the operator gets a 502 reading "0/0 FortiGate(s) accepted the push" — a
 * failure that describes a device problem when the real answer is that the
 * feature was never turned on. The frontends call this to hide the quarantine
 * verbs rather than offer a button that can only fail.
 *
 * Deliberately install-wide rather than per-asset: the per-asset answer needs
 * each asset's sightings joined to their integrations, and the row menu asks
 * this question for every row of a 2000-asset table. On a multi-integration
 * install where only some carry the toggle this is therefore the OPTIMISTIC
 * answer — the push stays the authority, and its per-target records still name
 * the FortiGates it skipped.
 *
 * Release is NOT gated on it: `releaseQuarantine` unpushes from the targets
 * recorded on the asset without consulting the toggle, so an asset quarantined
 * before push was switched off must stay releasable.
 */
export async function getQuarantinePushAvailability(): Promise<{
  pushEnabled: boolean;
  integrationCount: number;
  pushEnabledCount: number;
}> {
  const rows = await prisma.integration.findMany({
    where: { type: { in: ["fortimanager", "fortigate"] }, enabled: true },
    select: { config: true },
  });
  const pushEnabledCount = rows.filter(
    (r) => ((r.config ?? {}) as Record<string, unknown>).pushQuarantine === true,
  ).length;
  return {
    pushEnabled: pushEnabledCount > 0,
    integrationCount: rows.length,
    pushEnabledCount,
  };
}

/**
 * Quarantine an asset across every FortiGate it has been recently sighted
 * on. Per-FortiGate is all-or-nothing; across-FortiGate is best-effort
 * (partial successes still flip the asset to `quarantined`).
 *
 * Eligibility:
 *   - Asset must exist and have at least one valid MAC.
 *   - At least one sighting must fall inside the configured
 *     `quarantine.sightingMaxAgeDays` window AND its integration must
 *     still be enabled.
 */
export async function quarantineAsset(
  params: QuarantineAssetParams,
): Promise<QuarantineAssetResult> {
  const asset = await prisma.asset.findUnique({
    where: { id: params.assetId },
    include: { macAddressRows: { select: { mac: true, macEnd: true } } },
  });
  if (!asset) throw new AppError(404, `Asset ${params.assetId} not found`);

  // Infrastructure assets discovered from FMG/FortiGate (firewalls, switches,
  // access points) cannot be quarantined — quarantining the device that does
  // the quarantining would lock the operator out of the network.
  if (asset.assetType === "firewall" || asset.assetType === "switch" || asset.assetType === "access_point") {
    throw new AppError(
      400,
      `Asset ${asset.hostname || asset.id} is a ${asset.assetType} and cannot be quarantined`,
    );
  }

  const macs = macsForAsset(asset);
  if (macs.length === 0) {
    throw new AppError(
      400,
      `Asset ${asset.hostname || asset.id} has no MAC addresses — cannot quarantine`,
    );
  }

  const allCandidates: AssetSighting[] = await getQuarantineCandidates(asset.id);
  if (allCandidates.length === 0) {
    throw new AppError(
      409,
      `Asset ${asset.hostname || asset.id} has no recent FortiGate sightings — nothing to push to`,
    );
  }

  // Bearer-token callers are scoped to a fixed integration set. Drop any
  // sighting whose integration isn't in that set before doing any work; if
  // nothing survives, fail with a 403 rather than silently no-op'ing.
  const tokenScope = params.tokenIntegrationIds;
  const candidates = tokenScope
    ? allCandidates.filter((c) => c.integrationId && tokenScope.includes(c.integrationId))
    : allCandidates;
  if (tokenScope && candidates.length === 0) {
    throw new AppError(
      403,
      `Asset ${asset.hostname || asset.id} has no recent sightings on the integrations this token is allowed to push to`,
    );
  }

  // Group sightings by integration so we load each integration once.
  const integrationIds = new Set(candidates.map((c) => c.integrationId).filter((id): id is string => !!id));
  const integrations = await prisma.integration.findMany({
    where: { id: { in: Array.from(integrationIds) }, enabled: true },
  });
  const integrationById = new Map(integrations.map((i) => [i.id, i]));

  const targets: QuarantineTargetRecord[] = [];

  for (const sighting of candidates) {
    if (!sighting.integrationId) continue;
    const integration = integrationById.get(sighting.integrationId);
    if (!integration) continue; // disabled or deleted; skip silently

    // Skip integrations where the operator has not enabled quarantine push.
    const intgCfg = integration.config as Record<string, unknown>;
    if (intgCfg.pushQuarantine !== true) continue;

    let transport: Transport;
    try {
      transport = await buildTransportForIntegration(
        integration as { id: string; type: string; config: unknown },
        sighting.fortigateDevice,
      );
    } catch (err: any) {
      targets.push({
        fortigateDevice: sighting.fortigateDevice,
        integrationId: integration.id,
        pushedMacs: [],
        pushedAt: new Date().toISOString(),
        status: "failed",
        error: err?.message || "Transport setup failed",
      });
      continue;
    }

    try {
      const res = await pushQuarantineToFortigate({
        assetId: asset.id,
        hostname: asset.hostname,
        macs,
        actor: params.actor,
        transport,
        deviceName: sighting.fortigateDevice,
      });
      targets.push({
        fortigateDevice: res.fortigateDevice,
        integrationId: integration.id,
        pushedMacs: res.pushedMacs,
        pushedAt: new Date().toISOString(),
        status: "synced",
      });
    } catch (err: any) {
      targets.push({
        fortigateDevice: sighting.fortigateDevice,
        integrationId: integration.id,
        pushedMacs: [],
        pushedAt: new Date().toISOString(),
        status: "failed",
        error: err?.message || "Quarantine push failed",
      });
    }
  }

  const succeeded = targets.filter((t) => t.status === "synced");
  const failed = targets.filter((t) => t.status === "failed");

  if (succeeded.length === 0) {
    // Nothing landed — do not flip status. Surface the worst error.
    const firstError = failed[0]?.error || "No FortiGates could be reached";
    await logEvent({
      action: "asset.quarantine.failed",
      resourceType: "asset",
      resourceId: asset.id,
      resourceName: asset.hostname || asset.ipAddress || undefined,
      actor: params.actor,
      level: "error",
      message: `Quarantine failed for ${asset.hostname || asset.id}: 0/${targets.length} FortiGate(s) accepted the push`,
      details: { targets },
    });
    throw new AppError(
      502,
      `Quarantine failed: 0/${targets.length} FortiGate(s) accepted the push. First error: ${firstError}`,
    );
  }

  // Stamp the new state. Preserve the prior status so release can pop back.
  // If the asset is already quarantined, don't overwrite statusBeforeQuarantine
  // (this can happen on auto-quarantine extending an existing quarantine).
  const newStatusBefore =
    asset.status === "quarantined" ? asset.statusBeforeQuarantine : asset.status;
  // Park `monitored` alongside the status. Quarantined is one of the statuses
  // that cannot be monitor-enabled (the clamp in db.ts turns polling off on
  // this very write, since every probe against an isolated device fails BY
  // DESIGN), so without the park a release would hand the device back to the
  // network unwatched. Same re-quarantine guard as the status above.
  const newMonitoredBefore =
    asset.status === "quarantined" ? asset.monitoredBeforeQuarantine : asset.monitored;
  const now = new Date();

  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      status: "quarantined",
      statusChangedAt: now,
      statusChangedBy: params.actor,
      statusBeforeQuarantine: newStatusBefore,
      monitoredBeforeQuarantine: newMonitoredBefore ?? null,
      quarantineReason: params.reason || asset.quarantineReason || null,
      quarantinedAt: asset.quarantinedAt ?? now,
      quarantinedBy: params.actor,
      quarantineTargets: targets as any,
    },
  });

  const message =
    failed.length === 0
      ? `Quarantine succeeded for ${asset.hostname || asset.id}: ${succeeded.length}/${targets.length} FortiGate(s)`
      : `Quarantine partial for ${asset.hostname || asset.id}: ${succeeded.length}/${targets.length} FortiGate(s) accepted, ${failed.length} failed`;

  await logEvent({
    action: failed.length === 0 ? "asset.quarantine.succeeded" : "asset.quarantine.partial",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname || asset.ipAddress || undefined,
    actor: params.actor,
    level: failed.length === 0 ? "info" : "warning",
    message,
    details: { reason: params.reason, targets, macs },
  });

  return {
    assetId: asset.id,
    status: "quarantined",
    targets,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    message,
  };
}

export interface ReleaseQuarantineParams {
  assetId: string;
  actor: string;
  // See QuarantineAssetParams.tokenIntegrationIds. For release, we refuse
  // outright if the existing quarantine touches integrations outside the
  // token's scope — partial release would leave the asset's status flipped
  // back to active in Polaris while orphan entries linger on the out-of-
  // scope gateways. Session/system callers leave this undefined.
  tokenIntegrationIds?: string[];
}

export interface ReleaseQuarantineResult {
  assetId: string;
  newStatus: string;
  unpushedFrom: string[];
  failedToUnpush: Array<{ fortigateDevice: string; error: string }>;
  message: string;
}

/**
 * Release an asset's quarantine. Best-effort unpush from every recorded
 * target — a device-side failure is logged as a warning but does not block
 * the status flip. The asset's status is restored from
 * statusBeforeQuarantine (defaulting to "active" if null).
 */
export async function releaseQuarantine(
  params: ReleaseQuarantineParams,
): Promise<ReleaseQuarantineResult> {
  const asset = await prisma.asset.findUnique({ where: { id: params.assetId } });
  if (!asset) throw new AppError(404, `Asset ${params.assetId} not found`);

  if (asset.status !== "quarantined") {
    throw new AppError(409, `Asset ${asset.hostname || asset.id} is not currently quarantined`);
  }

  const recordedTargets = Array.isArray(asset.quarantineTargets)
    ? (asset.quarantineTargets as unknown as QuarantineTargetRecord[])
    : [];

  // Token-scope guard: refuse partial release.
  if (params.tokenIntegrationIds) {
    const allowed = new Set(params.tokenIntegrationIds);
    const outside = recordedTargets.filter((t) => !allowed.has(t.integrationId));
    if (outside.length > 0) {
      const names = Array.from(new Set(outside.map((t) => t.fortigateDevice))).join(", ");
      throw new AppError(
        403,
        `Quarantine for ${asset.hostname || asset.id} touches FortiGate(s) ${names} on integrations this token is not allowed to operate against — release must be performed by an admin or a token covering all targets`,
      );
    }
  }

  // Group by integrationId so we load each integration once.
  const integrationIds = new Set(recordedTargets.map((t) => t.integrationId).filter(Boolean));
  const integrations = await prisma.integration.findMany({
    where: { id: { in: Array.from(integrationIds) } },
  });
  const integrationById = new Map(integrations.map((i) => [i.id, i]));

  const unpushedFrom: string[] = [];
  const failedToUnpush: Array<{ fortigateDevice: string; error: string }> = [];

  for (const target of recordedTargets) {
    const integration = integrationById.get(target.integrationId);
    if (!integration) {
      // Integration was deleted while quarantine was active — record as a
      // soft failure so the operator knows there may be an orphan target.
      failedToUnpush.push({
        fortigateDevice: target.fortigateDevice,
        error: "Integration no longer exists — possible orphan quarantine entry on device",
      });
      continue;
    }
    try {
      const transport = await buildTransportForIntegration(
        integration as { id: string; type: string; config: unknown },
        target.fortigateDevice,
      );
      const res = await unpushQuarantineFromFortigate({
        assetId: asset.id,
        transport,
      });
      // Either removed or alreadyAbsent counts as success — both mean the
      // device no longer has the target.
      void res;
      unpushedFrom.push(target.fortigateDevice);
    } catch (err: any) {
      failedToUnpush.push({
        fortigateDevice: target.fortigateDevice,
        error: err?.message || "Unpush failed",
      });
    }
  }

  // Pop status back. statusBeforeQuarantine null → restore to active (the
  // asset was somehow quarantined without a prior-status snapshot, e.g.
  // hand-imported data; "active" is a safe default).
  const restoredStatus = asset.statusBeforeQuarantine ?? "active";
  // Pop `monitored` back with the status. null (never parked, or the asset
  // wasn't monitored when it was quarantined) restores to not-monitored, which
  // is also the pre-column behaviour. Staged in the SAME write as the status
  // so the db.ts clamp sees the restored status rather than "quarantined" and
  // lets the flag through.
  const restoredMonitored = asset.monitoredBeforeQuarantine === true;
  const now = new Date();

  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      status: restoredStatus,
      monitored: restoredMonitored,
      statusChangedAt: now,
      statusChangedBy: params.actor,
      statusBeforeQuarantine: null,
      monitoredBeforeQuarantine: null,
      quarantineReason: null,
      quarantinedAt: null,
      quarantinedBy: null,
      quarantineTargets: [] as any,
    },
  });

  const message = failedToUnpush.length === 0
    ? `Quarantine released for ${asset.hostname || asset.id}: unpushed from ${unpushedFrom.length} FortiGate(s)`
    : `Quarantine released for ${asset.hostname || asset.id}: unpushed from ${unpushedFrom.length}, ${failedToUnpush.length} failed (orphan entries may remain on those devices)`;

  await logEvent({
    action: "asset.quarantine.released",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname || asset.ipAddress || undefined,
    actor: params.actor,
    level: failedToUnpush.length === 0 ? "info" : "warning",
    message,
    details: { restoredStatus, unpushedFrom, failedToUnpush },
  });

  if (failedToUnpush.length > 0) {
    await logEvent({
      action: "asset.quarantine.unpush.failed",
      resourceType: "asset",
      resourceId: asset.id,
      resourceName: asset.hostname || asset.ipAddress || undefined,
      actor: params.actor,
      level: "warning",
      message: `Quarantine release: ${failedToUnpush.length} FortiGate(s) could not be unpushed — possible orphan entries`,
      details: { failedToUnpush },
    });
  }

  return {
    assetId: asset.id,
    newStatus: restoredStatus,
    unpushedFrom,
    failedToUnpush,
    message,
  };
}

/**
 * Drift check for a single asset: re-verify each recorded target. Returns
 * the updated quarantineTargets[] with any "synced" entries flipped to
 * "drift" if the device no longer holds the target / required MACs.
 * Caller is responsible for persisting the result.
 */
export async function verifyAssetQuarantine(
  assetId: string,
  tokenIntegrationIds?: string[],
): Promise<{
  targets: QuarantineTargetRecord[];
  driftDetected: boolean;
}> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { macAddressRows: { select: { mac: true, macEnd: true } } },
  });
  if (!asset) throw new AppError(404, `Asset ${assetId} not found`);

  const macs = macsForAsset(asset);
  const recordedTargets = Array.isArray(asset.quarantineTargets)
    ? (asset.quarantineTargets as unknown as QuarantineTargetRecord[])
    : [];

  if (tokenIntegrationIds) {
    const allowed = new Set(tokenIntegrationIds);
    const outside = recordedTargets.filter((t) => !allowed.has(t.integrationId));
    if (outside.length > 0) {
      const names = Array.from(new Set(outside.map((t) => t.fortigateDevice))).join(", ");
      throw new AppError(
        403,
        `Quarantine for ${asset.hostname || asset.id} touches FortiGate(s) ${names} on integrations this token is not allowed to read`,
      );
    }
  }

  const integrationIds = new Set(recordedTargets.map((t) => t.integrationId).filter(Boolean));
  const integrations = await prisma.integration.findMany({
    where: { id: { in: Array.from(integrationIds) } },
  });
  const integrationById = new Map(integrations.map((i) => [i.id, i]));

  let driftDetected = false;
  const updated: QuarantineTargetRecord[] = [];

  for (const target of recordedTargets) {
    const integration = integrationById.get(target.integrationId);
    if (!integration) {
      updated.push(target); // Can't verify — preserve existing record
      continue;
    }
    try {
      const transport = await buildTransportForIntegration(
        integration as { id: string; type: string; config: unknown },
        target.fortigateDevice,
      );
      const v = await verifyQuarantineOnFortigate({
        assetId: asset.id,
        desiredMacs: macs,
        transport,
      });
      if (target.status === "synced" && !v.present) {
        driftDetected = true;
        updated.push({ ...target, status: "drift", error: `Missing MACs on device: ${v.missingMacs.join(", ") || "(target absent)"}` });
      } else {
        updated.push(target);
      }
    } catch {
      // Verify itself failed — leave the existing record alone (don't flip to drift on a transport error).
      updated.push(target);
    }
  }

  return { targets: updated, driftDetected };
}
