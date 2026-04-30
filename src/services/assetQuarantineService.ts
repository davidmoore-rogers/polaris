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
import { logEvent } from "../api/routes/events.js";
import { fgRequest, type FortiGateConfig } from "./fortigateService.js";
import {
  fmgProxyRest,
  resolveDeviceMgmtIpViaFmg,
  type FortiManagerConfig,
} from "./fortimanagerService.js";
import { getQuarantineCandidates, type AssetSighting } from "./assetSightingService.js";

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

// ─── Transport (mirrors reservationPushService) ─────────────────────────

type Transport =
  | { kind: "direct-fortigate"; fgConfig: FortiGateConfig; vdom: string }
  | { kind: "fmg-proxy"; fmgConfig: FortiManagerConfig; deviceName: string; vdom: string };

async function buildTransport(
  fmgConfig: FortiManagerConfig,
  deviceName: string,
): Promise<Transport> {
  const vdom = "root";

  if (fmgConfig.useProxy === false) {
    if (!fmgConfig.fortigateApiToken) {
      throw new AppError(400, "Direct mode requires a FortiGate API token on the integration");
    }
    if (!fmgConfig.mgmtInterface?.trim()) {
      throw new AppError(400, 'Direct mode requires "Management Interface" to be set on the integration');
    }
    const mgmtIp = await resolveDeviceMgmtIpViaFmg(fmgConfig, deviceName);
    if (!mgmtIp) {
      throw new AppError(502, `Could not resolve management IP for "${deviceName}" via FortiManager`);
    }
    const fgConfig: FortiGateConfig = {
      host: mgmtIp,
      port: 443,
      apiUser: fmgConfig.fortigateApiUser || "",
      apiToken: fmgConfig.fortigateApiToken,
      vdom,
      verifySsl: fmgConfig.fortigateVerifySsl === true,
      mgmtInterface: fmgConfig.mgmtInterface,
    };
    return { kind: "direct-fortigate", fgConfig, vdom };
  }

  return { kind: "fmg-proxy", fmgConfig, deviceName, vdom };
}

/**
 * Build a transport from an integration row. Delegates to buildTransport
 * for FMG; standalone FortiGate integrations connect direct using the
 * integration's own FortiGateConfig.
 */
async function buildTransportForIntegration(
  integration: { id: string; type: string; config: unknown },
  deviceName: string,
): Promise<Transport> {
  if (integration.type === "fortimanager") {
    return buildTransport(integration.config as FortiManagerConfig, deviceName);
  }
  if (integration.type === "fortigate") {
    const cfg = integration.config as FortiGateConfig;
    if (!cfg?.host || !cfg?.apiToken) {
      throw new AppError(400, `Standalone FortiGate integration ${integration.id} is missing host or apiToken`);
    }
    return {
      kind: "direct-fortigate",
      fgConfig: { ...cfg, vdom: cfg.vdom || "root" },
      vdom: cfg.vdom || "root",
    };
  }
  throw new AppError(
    400,
    `Quarantine push is not supported for integration type "${integration.type}"`,
  );
}

async function callFortiOs<T>(
  t: Transport,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (t.kind === "direct-fortigate") {
    return fgRequest<T>(t.fgConfig, method, path, { query: { vdom: t.vdom }, body });
  }
  const sep = path.includes("?") ? "&" : "?";
  const resource = `${path}${sep}vdom=${encodeURIComponent(t.vdom)}`;
  return fmgProxyRest<T>(t.fmgConfig, t.deviceName, method, resource, { body });
}

// ─── Helpers ───────────────────────────────────────────────────────────

export function normalizeMac(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return mac.toLowerCase();
  return hex.match(/.{2}/g)!.join(":");
}

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
      // Reconcile: add missing, remove stale.
      const desiredSet = new Set(desiredMacs);
      const toAdd = desiredMacs.filter((m) => !existingMacs.has(m));
      const toRemove = Array.from(existingMacs).filter((m) => !desiredSet.has(m));

      for (const mac of toAdd) {
        await callFortiOs<unknown>(
          t,
          "POST",
          `/api/v2/cmdb/user/quarantine/targets/${encodeURIComponent(targetName)}/macs`,
          { mac, description: buildMacDescription(params.hostname, params.actor, mac) },
        );
      }
      for (const mac of toRemove) {
        await callFortiOs<unknown>(
          t,
          "DELETE",
          `/api/v2/cmdb/user/quarantine/targets/${encodeURIComponent(targetName)}/macs/${encodeURIComponent(mac)}`,
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

function macsForAsset(asset: { macAddress: string | null; macAddresses: unknown }): string[] {
  const set = new Set<string>();
  if (asset.macAddress) set.add(normalizeMac(asset.macAddress));
  if (Array.isArray(asset.macAddresses)) {
    for (const entry of asset.macAddresses as Array<{ mac?: string }>) {
      const m = entry?.mac ? normalizeMac(entry.mac) : "";
      if (m) set.add(m);
    }
  }
  return Array.from(set).filter((m) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m));
}

export interface QuarantineAssetParams {
  assetId: string;
  actor: string; // "user:<username>" | "api:<token-name>" | "system:auto-quarantine"
  reason?: string;
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
  const asset = await prisma.asset.findUnique({ where: { id: params.assetId } });
  if (!asset) throw new AppError(404, `Asset ${params.assetId} not found`);

  const macs = macsForAsset(asset);
  if (macs.length === 0) {
    throw new AppError(
      400,
      `Asset ${asset.hostname || asset.id} has no MAC addresses — cannot quarantine`,
    );
  }

  const candidates: AssetSighting[] = await getQuarantineCandidates(asset.id);
  if (candidates.length === 0) {
    throw new AppError(
      409,
      `Asset ${asset.hostname || asset.id} has no recent FortiGate sightings — nothing to push to`,
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
  const now = new Date();

  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      status: "quarantined",
      statusChangedAt: now,
      statusChangedBy: params.actor,
      statusBeforeQuarantine: newStatusBefore,
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
  const now = new Date();

  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      status: restoredStatus,
      statusChangedAt: now,
      statusChangedBy: params.actor,
      statusBeforeQuarantine: null,
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
export async function verifyAssetQuarantine(assetId: string): Promise<{
  targets: QuarantineTargetRecord[];
  driftDetected: boolean;
}> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) throw new AppError(404, `Asset ${assetId} not found`);

  const macs = macsForAsset(asset);
  const recordedTargets = Array.isArray(asset.quarantineTargets)
    ? (asset.quarantineTargets as unknown as QuarantineTargetRecord[])
    : [];

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
