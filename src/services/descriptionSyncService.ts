/**
 * src/services/descriptionSyncService.ts — Polaris-primary description sync
 * for the FortiManager / standalone FortiGate integrations, gated by the
 * per-integration `syncDescriptions` toggle (default off).
 *
 * Policy (operator-specified): POLARIS IS PRIMARY.
 *   - Polaris empty + device has a value → adopt (seed) the device value into
 *     Polaris (device-level only; interface comments already fall back to the
 *     discovered description for display, so no override row is created).
 *   - Polaris has a value → it is written to the device. Device-side edits
 *     are overwritten on the next sync; every overwrite is audited with the
 *     value it replaced.
 *
 * Synced surfaces and their FortiOS CMDB endpoints (all reached through the
 * shared Transport from reservationPushService, so both `useProxy` modes and
 * the standalone FortiGate integration work identically):
 *   - FortiGate interface description:
 *       GET/PUT /api/v2/cmdb/system/interface/<name>            { description }
 *   - FortiGate device description:
 *       GET/PUT /api/v2/cmdb/system/global                      { alias }
 *   - FortiSwitch device description (via parent FortiGate):
 *       GET/PUT /api/v2/cmdb/switch-controller/managed-switch/<switch-id>
 *                                                               { description }
 *   - FortiSwitch port description (via parent FortiGate, child table):
 *       PUT /api/v2/cmdb/switch-controller/managed-switch/<switch-id>/ports/<port>
 *                                                               { description }
 *   - FortiAP device description (via parent FortiGate):
 *       GET/PUT /api/v2/cmdb/wireless-controller/wtp/<wtp-id>   { comment }
 *
 * VERIFY ON A REAL FortiOS 7.x DEVICE before trusting in production (same
 * caveat posture as the SD-WAN collectors): the `system/global.alias` field
 * name + its short length cap, the managed-switch mkey (`switch-id` = serial),
 * child-table PUT patch semantics on `ports/<port>`, and whether `wtp` rows
 * carry a `comment` attribute at all. When the wtp read shows no comment
 * support, the FortiAP surface is skipped (logged once per reconcile).
 *
 * Failure posture: best-effort with per-row status, never throws to callers
 * (coord-push posture). Transport/read errors leave sync state untouched
 * (quarantine-verify rule); only an actual failed PUT stamps
 * syncStatus="failed" + syncError. No retry queue — the per-discovery
 * reconcile pass self-heals rows whose push failed transiently.
 */
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import {
  buildTransportForIntegration,
  callFortiOs,
  classifyPushError,
  type Transport,
} from "./reservationPushService.js";

// ─── Value normalization + decision ─────────────────────────────────────────

/** Trim; empty/whitespace-only/non-string → null. */
export function normalizeDescription(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export type DescSyncAction = "none" | "push" | "adopt";

/**
 * Polaris-primary decision. `polaris` / `device` are the CURRENT values on
 * each side (raw; normalized here).
 */
export function decideDescriptionSync(polaris: unknown, device: unknown): DescSyncAction {
  const p = normalizeDescription(polaris);
  const d = normalizeDescription(device);
  if (p === null) return d === null ? "none" : "adopt";
  return p === d ? "none" : "push";
}

// Per-target device-side length caps. FortiOS truncates or rejects
// over-length CMDB strings depending on version; capping client-side keeps
// the read-back verify honest. UNVERIFIED against a real device — see header.
export type DescTargetKind =
  | "fortigate-interface"
  | "fortigate-global"
  | "managed-switch"
  | "switch-port"
  | "wtp";

export const DESCRIPTION_CAPS: Record<DescTargetKind, number> = {
  "fortigate-interface": 255,
  "fortigate-global": 35, // system/global `alias` is a short field
  "managed-switch": 63,
  "switch-port": 63,
  "wtp": 255,
};

export function capDescriptionForTarget(value: string, target: DescTargetKind): string {
  const cap = DESCRIPTION_CAPS[target];
  return value.length > cap ? value.slice(0, cap) : value;
}

// ─── FortiOS CMDB shapes (subset we use) ─────────────────────────────────────

interface FortiOsInterfaceRow {
  name?: string;
  description?: string;
  alias?: string;
}

interface FortiOsGlobalRow {
  alias?: string;
}

interface FortiOsManagedSwitchRow {
  "switch-id"?: string;
  sn?: string;
  description?: string;
  ports?: Array<{ "port-name"?: string; description?: string }>;
}

interface FortiOsWtpRow {
  "wtp-id"?: string;
  name?: string;
  comment?: string;
}

// FortiOS GETs return `results` as an array (even for mkey reads); some
// global-scope objects come back as a bare object. Handle both.
function firstResult<T>(res: unknown): T | null {
  if (Array.isArray(res)) return (res[0] as T) ?? null;
  if (res && typeof res === "object") return res as T;
  return null;
}

function listResults<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return [];
}

// ─── Push results ────────────────────────────────────────────────────────────

export type DescPushResult =
  | { ok: true; previousDeviceValue: string | null }
  | { ok: false; error: string; errorKind: "permanent" | "transient" };

function pushFailure(err: unknown, context: string): DescPushResult {
  const kind = classifyPushError(err);
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, error: `[${kind}] ${context}: ${msg}`, errorKind: kind };
}

// One PUT + read-back verify against a CMDB object. `getPath` re-reads the
// object; `extract` pulls the description-like field out of the row.
async function putAndVerify<TRow>(
  t: Transport,
  putPath: string,
  body: Record<string, string>,
  getPath: string,
  extract: (row: TRow | null) => unknown,
  expected: string,
  context: string,
  currentDeviceValue: string | null,
): Promise<DescPushResult> {
  try {
    await callFortiOs(t, "PUT", putPath, body);
  } catch (err) {
    return pushFailure(err, context);
  }
  try {
    const after = await callFortiOs<unknown>(t, "GET", getPath);
    const landed = normalizeDescription(extract(firstResult<TRow>(after)));
    if (landed !== normalizeDescription(expected)) {
      return {
        ok: false,
        error: `[permanent] ${context}: verify mismatch — device kept ${JSON.stringify(landed)}`,
        errorKind: "permanent",
      };
    }
  } catch (err) {
    // The PUT went through but the verify read failed — report transient so
    // the reconcile pass re-checks next cycle rather than flagging a hard
    // failure for what is likely a momentary read error.
    return pushFailure(err, `${context} (verify read)`);
  }
  return { ok: true, previousDeviceValue: currentDeviceValue };
}

export interface DescPushBaseParams {
  integration: { id: string; type: string; config: unknown };
  /** FMG/dvmdb device name of the FortiGate the transport lands on. */
  deviceName: string;
  /** Value to write (pre-normalized, non-empty). */
  value: string;
  /**
   * Current device-side value when the caller already read it (reconcile
   * path). Undefined → pre-read here. Skips the push when equal.
   */
  currentDeviceValue?: string | null;
  /** Reuse an already-built transport (reconcile path). */
  transport?: Transport;
}

async function resolveTransport(p: DescPushBaseParams): Promise<Transport> {
  return p.transport ?? (await buildTransportForIntegration(p.integration, p.deviceName));
}

/** FortiGate interface `description` (system/interface). */
export async function pushInterfaceDescription(
  p: DescPushBaseParams & { ifName: string },
): Promise<DescPushResult> {
  const context = `interface ${p.ifName} on ${p.deviceName}`;
  const path = `/api/v2/cmdb/system/interface/${encodeURIComponent(p.ifName)}`;
  const value = capDescriptionForTarget(p.value, "fortigate-interface");
  try {
    const t = await resolveTransport(p);
    let current = p.currentDeviceValue;
    if (current === undefined) {
      const res = await callFortiOs<unknown>(t, "GET", path);
      current = normalizeDescription(firstResult<FortiOsInterfaceRow>(res)?.description);
    }
    if (normalizeDescription(current) === normalizeDescription(value)) {
      return { ok: true, previousDeviceValue: current ?? null };
    }
    return await putAndVerify<FortiOsInterfaceRow>(
      t, path, { description: value }, path, (r) => r?.description, value, context, current ?? null,
    );
  } catch (err) {
    return pushFailure(err, context);
  }
}

/** FortiSwitch port `description` (managed-switch child table, via parent FG). */
export async function pushSwitchPortDescription(
  p: DescPushBaseParams & { switchId: string; portName: string },
): Promise<DescPushResult> {
  const context = `switch ${p.switchId} port ${p.portName} via ${p.deviceName}`;
  const base = `/api/v2/cmdb/switch-controller/managed-switch/${encodeURIComponent(p.switchId)}`;
  const portPath = `${base}/ports/${encodeURIComponent(p.portName)}`;
  const value = capDescriptionForTarget(p.value, "switch-port");
  try {
    const t = await resolveTransport(p);
    let current = p.currentDeviceValue;
    if (current === undefined) {
      const res = await callFortiOs<unknown>(t, "GET", base);
      const row = firstResult<FortiOsManagedSwitchRow>(res);
      const port = (row?.ports ?? []).find((x) => x?.["port-name"] === p.portName);
      current = normalizeDescription(port?.description);
    }
    if (normalizeDescription(current) === normalizeDescription(value)) {
      return { ok: true, previousDeviceValue: current ?? null };
    }
    return await putAndVerify<{ description?: string }>(
      t, portPath, { description: value }, portPath, (r) => r?.description, value, context, current ?? null,
    );
  } catch (err) {
    return pushFailure(err, context);
  }
}

export type DeviceDescTarget =
  | { kind: "fortigate-global" }
  | { kind: "managed-switch"; switchId: string }
  | { kind: "wtp"; wtpId: string };

/** Device-level description (FortiGate alias / switch description / wtp comment). */
export async function pushDeviceDescription(
  p: DescPushBaseParams & { target: DeviceDescTarget },
): Promise<DescPushResult> {
  try {
    const t = await resolveTransport(p);
    if (p.target.kind === "fortigate-global") {
      const context = `system/global alias on ${p.deviceName}`;
      const path = "/api/v2/cmdb/system/global";
      const value = capDescriptionForTarget(p.value, "fortigate-global");
      let current = p.currentDeviceValue;
      if (current === undefined) {
        const res = await callFortiOs<unknown>(t, "GET", path);
        current = normalizeDescription(firstResult<FortiOsGlobalRow>(res)?.alias);
      }
      if (normalizeDescription(current) === normalizeDescription(value)) {
        return { ok: true, previousDeviceValue: current ?? null };
      }
      return await putAndVerify<FortiOsGlobalRow>(
        t, path, { alias: value }, path, (r) => r?.alias, value, context, current ?? null,
      );
    }
    if (p.target.kind === "managed-switch") {
      const context = `managed-switch ${p.target.switchId} via ${p.deviceName}`;
      const path = `/api/v2/cmdb/switch-controller/managed-switch/${encodeURIComponent(p.target.switchId)}`;
      const value = capDescriptionForTarget(p.value, "managed-switch");
      let current = p.currentDeviceValue;
      if (current === undefined) {
        const res = await callFortiOs<unknown>(t, "GET", path);
        current = normalizeDescription(firstResult<FortiOsManagedSwitchRow>(res)?.description);
      }
      if (normalizeDescription(current) === normalizeDescription(value)) {
        return { ok: true, previousDeviceValue: current ?? null };
      }
      return await putAndVerify<FortiOsManagedSwitchRow>(
        t, path, { description: value }, path, (r) => r?.description, value, context, current ?? null,
      );
    }
    // wtp
    const context = `wtp ${p.target.wtpId} via ${p.deviceName}`;
    const path = `/api/v2/cmdb/wireless-controller/wtp/${encodeURIComponent(p.target.wtpId)}`;
    const value = capDescriptionForTarget(p.value, "wtp");
    let current = p.currentDeviceValue;
    if (current === undefined) {
      const res = await callFortiOs<unknown>(t, "GET", path);
      current = normalizeDescription(firstResult<FortiOsWtpRow>(res)?.comment);
    }
    if (normalizeDescription(current) === normalizeDescription(value)) {
      return { ok: true, previousDeviceValue: current ?? null };
    }
    return await putAndVerify<FortiOsWtpRow>(
      t, path, { comment: value }, path, (r) => r?.comment, value, context, current ?? null,
    );
  } catch (err) {
    return pushFailure(err, `device description on ${p.deviceName}`);
  }
}

// ─── Eligibility + save-time fast path ──────────────────────────────────────

interface TopologyBlob {
  role?: string;
  haRole?: string;
  controllerFortigate?: string;
  deviceName?: string;
}

interface EligibleContext {
  integration: { id: string; type: string; config: unknown; name: string };
  topology: TopologyBlob;
  role: "fortigate" | "fortiswitch" | "fortiap";
  /** Transport target: the FortiGate itself, or the parent controller. */
  deviceName: string;
}

function syncEnabled(config: unknown): boolean {
  return (config as { syncDescriptions?: boolean } | null)?.syncDescriptions === true;
}

/**
 * Resolve whether description sync applies to this asset and, if so, which
 * FortiGate the transport must land on. Null = not eligible (toggle off,
 * non-Fortinet asset, HA-secondary member, or missing controller linkage).
 */
function resolveEligibility(asset: {
  fortinetTopology: unknown;
  hostname: string | null;
  discoveredByIntegration: { id: string; type: string; config: unknown; name: string } | null;
}): EligibleContext | null {
  const integration = asset.discoveredByIntegration;
  if (!integration) return null;
  if (integration.type !== "fortimanager" && integration.type !== "fortigate") return null;
  if (!syncEnabled(integration.config)) return null;
  const topology = (asset.fortinetTopology ?? {}) as TopologyBlob;
  const role = topology.role;
  if (role !== "fortigate" && role !== "fortiswitch" && role !== "fortiap") return null;
  // HA config replicates from the primary; never push at a standby member.
  if (role === "fortigate" && topology.haRole === "secondary") return null;
  const deviceName =
    role === "fortigate"
      ? (topology.deviceName || asset.hostname || "").trim()
      : (topology.controllerFortigate || "").trim();
  if (!deviceName) return null;
  return { integration, topology, role, deviceName };
}

export interface SaveSyncResult {
  attempted: boolean;
  status?: "synced" | "failed";
  error?: string;
}

/**
 * Save-time fast path: called after an operator writes an interface comment
 * (scope="interface") or Asset.description (scope="device"). The Polaris row
 * is already persisted by the caller — this only mirrors the value to the
 * device and stamps sync state. Never throws.
 */
export async function syncDescriptionsOnSave(params: {
  assetId: string;
  scope: "interface" | "device";
  ifName?: string;
  actor?: string;
}): Promise<SaveSyncResult> {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: params.assetId },
      select: {
        id: true,
        hostname: true,
        serialNumber: true,
        description: true,
        fortinetTopology: true,
        discoveredByIntegration: { select: { id: true, type: true, config: true, name: true } },
      },
    });
    if (!asset) return { attempted: false };
    const ctx = resolveEligibility(asset);
    if (!ctx) return { attempted: false };

    if (params.scope === "interface") {
      if (!params.ifName) return { attempted: false };
      if (ctx.role === "fortiap") return { attempted: false }; // no AP interface descriptions
      const override = await prisma.assetInterfaceOverride.findUnique({
        where: { assetId_ifName: { assetId: asset.id, ifName: params.ifName } },
      });
      const value = normalizeDescription(override?.description);
      // Cleared override (row deleted by the route) or empty value: local-only
      // clear — the device keeps its description and the discovered value
      // shows through again.
      if (!override || value === null) return { attempted: false };

      let result: DescPushResult;
      if (ctx.role === "fortigate") {
        result = await pushInterfaceDescription({
          integration: ctx.integration,
          deviceName: ctx.deviceName,
          ifName: params.ifName,
          value,
        });
      } else {
        const switchId = (asset.serialNumber || "").trim();
        if (!switchId) return { attempted: false };
        result = await pushSwitchPortDescription({
          integration: ctx.integration,
          deviceName: ctx.deviceName,
          switchId,
          portName: params.ifName,
          value,
        });
      }
      await stampOverrideSyncState(override.id, result);
      await logInterfacePushEvent(asset, params.ifName, value, result, params.actor);
      return result.ok
        ? { attempted: true, status: "synced" }
        : { attempted: true, status: "failed", error: result.error };
    }

    // scope === "device"
    const value = normalizeDescription(asset.description);
    if (value === null) {
      // Operator cleared the Polaris description: local-only, clear stale
      // sync state so the UI doesn't show a "synced" badge for an empty field.
      await prisma.asset.update({
        where: { id: asset.id },
        data: { descriptionSync: Prisma.DbNull },
      });
      return { attempted: false };
    }
    const target = deviceTargetFor(ctx.role, asset.serialNumber);
    if (!target) return { attempted: false };
    const result = await pushDeviceDescription({
      integration: ctx.integration,
      deviceName: ctx.deviceName,
      target,
      value,
    });
    await stampAssetSyncState(asset.id, result);
    await logDevicePushEvent(asset, value, result, params.actor);
    return result.ok
      ? { attempted: true, status: "synced" }
      : { attempted: true, status: "failed", error: result.error };
  } catch (err) {
    logger.warn(
      { assetId: params.assetId, scope: params.scope, ifName: params.ifName, err: err instanceof Error ? err.message : String(err) },
      "description_sync.on_save_failed",
    );
    return { attempted: false };
  }
}

function deviceTargetFor(
  role: "fortigate" | "fortiswitch" | "fortiap",
  serialNumber: string | null,
): DeviceDescTarget | null {
  if (role === "fortigate") return { kind: "fortigate-global" };
  const serial = (serialNumber || "").trim();
  if (!serial) return null;
  return role === "fortiswitch" ? { kind: "managed-switch", switchId: serial } : { kind: "wtp", wtpId: serial };
}

async function stampOverrideSyncState(overrideId: string, result: DescPushResult): Promise<void> {
  await prisma.assetInterfaceOverride.update({
    where: { id: overrideId },
    data: result.ok
      ? { syncStatus: "synced", lastSyncAt: new Date(), syncError: null }
      : { syncStatus: "failed", lastSyncAt: new Date(), syncError: result.error },
  }).catch(() => { /* row may have been cleared concurrently — best-effort */ });
}

async function stampAssetSyncState(assetId: string, result: DescPushResult): Promise<void> {
  const blob = result.ok
    ? { status: "synced", at: new Date().toISOString() }
    : { status: "failed", at: new Date().toISOString(), error: result.error };
  await prisma.asset.update({
    where: { id: assetId },
    data: { descriptionSync: blob },
  }).catch(() => { /* asset may have been deleted concurrently — best-effort */ });
}

async function logInterfacePushEvent(
  asset: { id: string; hostname: string | null },
  ifName: string,
  value: string,
  result: DescPushResult,
  actor?: string,
): Promise<void> {
  await logEvent({
    action: result.ok ? "asset.interface.description.pushed" : "asset.interface.description.push_failed",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname ?? undefined,
    actor,
    level: result.ok ? "info" : "warning",
    message: result.ok
      ? `Interface comment for ${ifName} pushed to device`
      : `Interface comment push for ${ifName} failed: ${result.error}`,
    details: {
      ifName,
      value,
      ...(result.ok
        ? result.previousDeviceValue !== null && result.previousDeviceValue !== value
          ? { overwroteDeviceValue: result.previousDeviceValue }
          : {}
        : { error: result.error }),
    },
  });
}

async function logDevicePushEvent(
  asset: { id: string; hostname: string | null },
  value: string,
  result: DescPushResult,
  actor?: string,
): Promise<void> {
  await logEvent({
    action: result.ok ? "asset.description.pushed" : "asset.description.push_failed",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname ?? undefined,
    actor,
    level: result.ok ? "info" : "warning",
    message: result.ok
      ? "Device description pushed to device"
      : `Device description push failed: ${result.error}`,
    details: {
      value,
      ...(result.ok
        ? result.previousDeviceValue !== null && result.previousDeviceValue !== value
          ? { overwroteDeviceValue: result.previousDeviceValue }
          : {}
        : { error: result.error }),
    },
  });
}

// ─── Discovery reconcile pass ────────────────────────────────────────────────

export interface DescriptionSyncSummary {
  devices: number;
  pushed: number;
  adopted: number;
  failed: number;
  skippedDevices: number;
}

interface ReconcileAsset {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  description: string | null;
  descriptionSync: unknown;
  fortinetTopology: unknown;
}

/**
 * Per-discovery reconcile: for every FortiGate this integration owns, read
 * the current device-side descriptions (one CMDB GET per surface) and run the
 * Polaris-primary decision over the device-level values + every interface
 * override. Adopts where Polaris is empty, re-pushes where the device
 * drifted from a non-empty Polaris value (this is also the retry path for
 * pushes that failed transiently at save time). DB writes happen only on
 * change. Never throws.
 */
export async function runDescriptionSyncForIntegration(
  integration: { id: string; type: string; config: unknown; name: string },
): Promise<DescriptionSyncSummary> {
  const summary: DescriptionSyncSummary = { devices: 0, pushed: 0, adopted: 0, failed: 0, skippedDevices: 0 };
  if (!syncEnabled(integration.config)) return summary;

  const assets: ReconcileAsset[] = await prisma.asset.findMany({
    where: {
      discoveredByIntegrationId: integration.id,
      status: { notIn: ["decommissioned", "disabled"] },
    },
    select: {
      id: true,
      hostname: true,
      serialNumber: true,
      description: true,
      descriptionSync: true,
      fortinetTopology: true,
    },
  });

  // Group assets under the FortiGate whose transport reaches them.
  const groups = new Map<string, { firewall?: ReconcileAsset; switches: ReconcileAsset[]; aps: ReconcileAsset[] }>();
  const groupFor = (deviceName: string) => {
    let g = groups.get(deviceName);
    if (!g) {
      g = { switches: [], aps: [] };
      groups.set(deviceName, g);
    }
    return g;
  };
  for (const a of assets) {
    const topo = (a.fortinetTopology ?? {}) as TopologyBlob;
    if (topo.role === "fortigate") {
      if (topo.haRole === "secondary") continue;
      const name = (topo.deviceName || a.hostname || "").trim();
      if (name) groupFor(name).firewall = a;
    } else if (topo.role === "fortiswitch") {
      const ctrl = (topo.controllerFortigate || "").trim();
      if (ctrl) groupFor(ctrl).switches.push(a);
    } else if (topo.role === "fortiap") {
      const ctrl = (topo.controllerFortigate || "").trim();
      if (ctrl) groupFor(ctrl).aps.push(a);
    }
  }
  if (groups.size === 0) return summary;

  const allAssetIds = assets.map((a) => a.id);
  const overrides = await prisma.assetInterfaceOverride.findMany({
    where: { assetId: { in: allAssetIds } },
  });
  const overridesByAsset = new Map<string, typeof overrides>();
  for (const o of overrides) {
    const list = overridesByAsset.get(o.assetId) ?? [];
    list.push(o);
    overridesByAsset.set(o.assetId, list);
  }

  // Small device-level parallelism: pushes are rare (only on drift), so the
  // per-device work is read-dominated. 5 concurrent devices matches the
  // discovery parallelism floor without hammering FMG's proxy lane.
  const deviceNames = [...groups.keys()];
  const CHUNK = 5;
  for (let i = 0; i < deviceNames.length; i += CHUNK) {
    await Promise.all(
      deviceNames.slice(i, i + CHUNK).map(async (deviceName) => {
        const group = groups.get(deviceName)!;
        try {
          await reconcileDevice(integration, deviceName, group, overridesByAsset, summary);
          summary.devices++;
        } catch (err) {
          // Transport preconditions (missing direct-mode token, unresolvable
          // mgmt IP) or a wholesale read failure: skip the device, touch no
          // state (quarantine-verify rule).
          summary.skippedDevices++;
          logger.warn(
            { integrationId: integration.id, deviceName, err: err instanceof Error ? err.message : String(err) },
            "description_sync.device_skipped",
          );
        }
      }),
    );
  }
  return summary;
}

async function reconcileDevice(
  integration: { id: string; type: string; config: unknown; name: string },
  deviceName: string,
  group: { firewall?: ReconcileAsset; switches: ReconcileAsset[]; aps: ReconcileAsset[] },
  overridesByAsset: Map<string, Array<{ id: string; assetId: string; ifName: string; description: string | null; syncStatus: string | null }>>,
  summary: DescriptionSyncSummary,
): Promise<void> {
  const transport = await buildTransportForIntegration(integration, deviceName);

  // Reads are per-surface best-effort: a failed read skips that surface's
  // decisions this cycle without touching state.
  let interfaceByName: Map<string, string | null> | null = null;
  let globalAlias: string | null | undefined; // undefined = read failed
  let switchRows: Map<string, FortiOsManagedSwitchRow> | null = null;
  let wtpRows: Map<string, FortiOsWtpRow> | null = null;
  let wtpSupportsComment = false;

  if (group.firewall) {
    try {
      const res = await callFortiOs<unknown>(transport, "GET", "/api/v2/cmdb/system/interface");
      interfaceByName = new Map(
        listResults<FortiOsInterfaceRow>(res)
          .filter((r) => typeof r?.name === "string" && r.name)
          .map((r) => [r.name as string, normalizeDescription(r.description)]),
      );
    } catch { /* surface skipped this cycle */ }
    try {
      const res = await callFortiOs<unknown>(transport, "GET", "/api/v2/cmdb/system/global");
      globalAlias = normalizeDescription(firstResult<FortiOsGlobalRow>(res)?.alias);
    } catch { globalAlias = undefined; }
  }
  if (group.switches.length > 0) {
    try {
      const res = await callFortiOs<unknown>(transport, "GET", "/api/v2/cmdb/switch-controller/managed-switch");
      switchRows = new Map(
        listResults<FortiOsManagedSwitchRow>(res)
          .map((r) => [String(r?.["switch-id"] || r?.sn || "").trim().toUpperCase(), r] as const)
          .filter(([k]) => k.length > 0),
      );
    } catch { /* surface skipped */ }
  }
  if (group.aps.length > 0) {
    try {
      const res = await callFortiOs<unknown>(transport, "GET", "/api/v2/cmdb/wireless-controller/wtp");
      const rows = listResults<FortiOsWtpRow>(res);
      // Comment support gate: only trust the surface when at least one row
      // carries the attribute (older FortiOS may not expose it — see header).
      wtpSupportsComment = rows.some((r) => r && Object.prototype.hasOwnProperty.call(r, "comment"));
      wtpRows = new Map(
        rows
          .map((r) => [String(r?.["wtp-id"] || "").trim().toUpperCase(), r] as const)
          .filter(([k]) => k.length > 0),
      );
      if (!wtpSupportsComment && rows.length > 0) {
        logger.info(
          { integrationId: integration.id, deviceName },
          "description_sync.wtp_comment_unsupported",
        );
      }
    } catch { /* surface skipped */ }
  }

  // ── Device-level: firewall alias ──
  if (group.firewall && globalAlias !== undefined) {
    await reconcileDeviceLevel(
      integration, deviceName, transport, group.firewall,
      { kind: "fortigate-global" }, globalAlias, summary,
    );
  }
  // ── Device-level: switches ──
  for (const sw of group.switches) {
    const serial = (sw.serialNumber || "").trim().toUpperCase();
    const row = serial && switchRows ? switchRows.get(serial) : undefined;
    if (!row) continue; // switch missing from CMDB (or read failed) — skip
    await reconcileDeviceLevel(
      integration, deviceName, transport, sw,
      { kind: "managed-switch", switchId: String(row["switch-id"] || sw.serialNumber || "").trim() },
      normalizeDescription(row.description), summary,
    );
  }
  // ── Device-level: APs ──
  if (wtpSupportsComment && wtpRows) {
    for (const ap of group.aps) {
      const serial = (ap.serialNumber || "").trim().toUpperCase();
      const row = serial ? wtpRows.get(serial) : undefined;
      if (!row) continue;
      await reconcileDeviceLevel(
        integration, deviceName, transport, ap,
        { kind: "wtp", wtpId: String(row["wtp-id"] || ap.serialNumber || "").trim() },
        normalizeDescription(row.comment), summary,
      );
    }
  }

  // ── Interface-level: firewall interface overrides ──
  if (group.firewall && interfaceByName) {
    for (const o of overridesByAsset.get(group.firewall.id) ?? []) {
      if (!interfaceByName.has(o.ifName)) continue; // renamed/unknown interface
      const polaris = normalizeDescription(o.description);
      if (polaris === null) continue; // empty override — local clear semantics
      const device = interfaceByName.get(o.ifName) ?? null;
      if (polaris === device) {
        await markOverrideSyncedIfNeeded(o, summary);
        continue;
      }
      const result = await pushInterfaceDescription({
        integration, deviceName, ifName: o.ifName, value: polaris,
        currentDeviceValue: device, transport,
      });
      await stampOverrideSyncState(o.id, result);
      await logInterfacePushEvent(
        { id: o.assetId, hostname: group.firewall.hostname }, o.ifName, polaris, result, "system:description-sync",
      );
      if (result.ok) summary.pushed++; else summary.failed++;
    }
  }
  // ── Interface-level: switch port overrides ──
  if (switchRows) {
    for (const sw of group.switches) {
      const serial = (sw.serialNumber || "").trim().toUpperCase();
      const row = serial ? switchRows.get(serial) : undefined;
      if (!row) continue;
      const portDesc = new Map(
        (row.ports ?? [])
          .filter((x) => typeof x?.["port-name"] === "string" && x["port-name"])
          .map((x) => [x["port-name"] as string, normalizeDescription(x.description)]),
      );
      for (const o of overridesByAsset.get(sw.id) ?? []) {
        if (!portDesc.has(o.ifName)) continue;
        const polaris = normalizeDescription(o.description);
        if (polaris === null) continue;
        const device = portDesc.get(o.ifName) ?? null;
        if (polaris === device) {
          await markOverrideSyncedIfNeeded(o, summary);
          continue;
        }
        const result = await pushSwitchPortDescription({
          integration, deviceName,
          switchId: String(row["switch-id"] || sw.serialNumber || "").trim(),
          portName: o.ifName, value: polaris,
          currentDeviceValue: device, transport,
        });
        await stampOverrideSyncState(o.id, result);
        await logInterfacePushEvent(
          { id: o.assetId, hostname: sw.hostname }, o.ifName, polaris, result, "system:description-sync",
        );
        if (result.ok) summary.pushed++; else summary.failed++;
      }
    }
  }
}

async function reconcileDeviceLevel(
  integration: { id: string; type: string; config: unknown; name: string },
  deviceName: string,
  transport: Transport,
  asset: ReconcileAsset,
  target: DeviceDescTarget,
  deviceValue: string | null,
  summary: DescriptionSyncSummary,
): Promise<void> {
  const action = decideDescriptionSync(asset.description, deviceValue);
  if (action === "none") {
    // Values agree (or both empty) — stamp "synced" once if the last attempt
    // failed / never ran, so the UI reflects convergence. Write-on-change only.
    const status = (asset.descriptionSync as { status?: string } | null)?.status;
    if (normalizeDescription(asset.description) !== null && status !== "synced") {
      await prisma.asset.update({
        where: { id: asset.id },
        data: { descriptionSync: { status: "synced", at: new Date().toISOString() } },
      }).catch(() => {});
    }
    return;
  }
  if (action === "adopt") {
    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        description: deviceValue,
        descriptionSync: { status: "synced", at: new Date().toISOString() },
      },
    }).catch(() => {});
    summary.adopted++;
    await logEvent({
      action: "asset.description.adopted",
      resourceType: "asset",
      resourceId: asset.id,
      resourceName: asset.hostname ?? undefined,
      actor: "system:description-sync",
      message: `Device description adopted from ${deviceName}`,
      details: { value: deviceValue },
    });
    return;
  }
  // push
  const value = normalizeDescription(asset.description)!;
  const result = await pushDeviceDescription({
    integration, deviceName, target, value,
    currentDeviceValue: deviceValue, transport,
  });
  await stampAssetSyncState(asset.id, result);
  await logDevicePushEvent({ id: asset.id, hostname: asset.hostname }, value, result, "system:description-sync");
  if (result.ok) summary.pushed++; else summary.failed++;
}

async function markOverrideSyncedIfNeeded(
  o: { id: string; syncStatus: string | null },
  _summary: DescriptionSyncSummary,
): Promise<void> {
  if (o.syncStatus === "synced") return;
  await prisma.assetInterfaceOverride.update({
    where: { id: o.id },
    data: { syncStatus: "synced", lastSyncAt: new Date(), syncError: null },
  }).catch(() => {});
}
