/**
 * src/services/networkScanService.ts — saved network **Discovery** CRUD, run
 * lifecycle, and adoption.
 *
 * The runner (networkScanRunner.ts) does the sweeping; this owns everything
 * around it: the saved configuration, dispatching a run, cancelling one, and
 * turning chosen responders into assets.
 *
 * Two boundaries worth stating up front, because they are what the RBAC design
 * rests on (business rule 34a):
 *
 *   - **Running creates nothing.** `triggerScan` writes a run row and hands it
 *     to a worker. No Asset, no AssetSource, no pin. That is what lets a
 *     `networkScan`-only role sweep a range without being able to add anything
 *     to inventory.
 *   - **Adoption is the only writer of assets here**, and its route chains
 *     `assets:write` on top of `networkScan:write`.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { publishScanJob } from "./queueService.js";
import { expandScanTargets, type ScanTarget, SCAN_MAX_TARGETS } from "../utils/cidr.js";
import {
  runScan,
  parseStoredMethods,
  parseStoredTargets,
  loadKnownAddresses,
  type ScanHit,
  type ScanMethod,
} from "./networkScanRunner.js";
import { resolvePinnedInterfaces, splitPinsByProvenance, type AutoMonitorSelection } from "./autoMonitorInterfacesService.js";
import { resolvePinnedStorage, type AutoMonitorStorageSelection } from "./autoMonitorStorageService.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * The auto-monitor selection a Discovery applies to what it adopts, keyed by
 * the polling method that identified the device.
 *
 * Keyed by METHOD rather than stored flat because what can be pinned depends
 * on what answered: an SNMP responder reported real interface names during the
 * scan, an ICMP-only one reported nothing, and an SSH/WinRM host only reports
 * interfaces once an agent runs. One selection for all of them would be a
 * selection that means something different per group.
 */
export interface ScanAutoMonitor {
  [method: string]: {
    interfaces?: AutoMonitorSelection;
    storage?: AutoMonitorStorageSelection;
  } | undefined;
}

export interface ScanRecord {
  id: string;
  name: string;
  description: string | null;
  targets: ScanTarget[];
  methods: ScanMethod[];
  autoMonitor: ScanAutoMonitor | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastRunAt: Date | null;
}

export interface SaveScanInput {
  name: string;
  description?: string | null;
  targets: ScanTarget[];
  methods: ScanMethod[];
  autoMonitor?: ScanAutoMonitor | null;
}

// ─── Caps ───────────────────────────────────────────────────────────────────

/** Target ROWS an operator may type. Addresses are capped separately. */
export const MAX_SCAN_TARGET_ROWS = 50;
/** Credentials to try per method. A community list, not a dictionary attack. */
export const MAX_CREDENTIALS_PER_METHOD = 10;
/** Addresses adoptable in one call — the assets-route bulk-cap precedent. */
export const MAX_ADOPT_PER_CALL = 500;
/** How stale a run's heartbeat may be before it's presumed dead. */
export const SCAN_RUN_STALE_MS = 3 * 60_000;

/**
 * `requestActor(req)` returns undefined for a caller with neither a session
 * username nor a token name. `NetworkScanRun.actor` is NOT NULL and an audit
 * row with a blank actor is worse than one naming the gap, so normalize once
 * here rather than in six call sites.
 */
function normalizeActor(actor?: string): string {
  return (actor ?? "").trim() || "unknown";
}

// ─── Shaping ────────────────────────────────────────────────────────────────

function toRecord(row: {
  id: string; name: string; description: string | null;
  targets: unknown; methods: unknown; autoMonitor: unknown;
  createdBy: string | null; createdAt: Date; updatedAt: Date; lastRunAt: Date | null;
}): ScanRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    targets: parseStoredTargets(row.targets),
    methods: parseStoredMethods(row.methods),
    autoMonitor: (row.autoMonitor as ScanAutoMonitor | null) ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt,
  };
}

/**
 * Validate a saved configuration.
 *
 * Deliberately NOT a Zod schema in the route: the same checks have to hold for
 * an imported `.discovery.json`, and the target/credential caps are properties
 * of the feature rather than of one HTTP body.
 */
export function validateScanInput(input: SaveScanInput): string | null {
  const name = (input.name ?? "").trim();
  if (!name) return "Name is required.";
  if (name.length > 200) return "Name is too long.";

  const targets = input.targets ?? [];
  if (!targets.length) return "Add at least one IP range, subnet or address to scan.";
  if (targets.length > MAX_SCAN_TARGET_ROWS) return `At most ${MAX_SCAN_TARGET_ROWS} target rows.`;

  // Expanding here is what turns "10.0.0.0/8" into an error at SAVE time
  // rather than a run that fails minutes later.
  const expanded = expandScanTargets(targets);
  const badRow = expanded.perTarget.find((t) => t.error);
  if (badRow) return badRow.error!;
  if (!expanded.total) {
    return expanded.dropped
      ? "Every address in those targets is excluded (loopback, link-local, multicast or reserved)."
      : "Those targets expand to no addresses.";
  }

  const methods = input.methods ?? [];
  if (!methods.length) return "Select at least one probe method.";
  for (const m of methods) {
    const ids = m.credentialIds ?? [];
    if (m.type === "icmp") {
      // Not a formality: an ICMP "credential" would be a stored secret nothing
      // reads, and the credential store has no icmp type to hold it.
      if (ids.length) return "ICMP takes no credentials.";
      continue;
    }
    if (!ids.length) return `Select at least one credential for ${m.type}.`;
    if (ids.length > MAX_CREDENTIALS_PER_METHOD) {
      return `At most ${MAX_CREDENTIALS_PER_METHOD} credentials per method.`;
    }
    if (new Set(ids).size !== ids.length) return `Duplicate credential selected for ${m.type}.`;
  }
  return null;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function listScans(): Promise<(ScanRecord & { latestRun: RunSummary | null })[]> {
  const rows = await prisma.networkScan.findMany({ orderBy: { name: "asc" } });
  // One query for every Discovery's newest run rather than N+1 — the list is
  // small but this is also the reattach path, which runs on every list open.
  const runs = await prisma.networkScanRun.findMany({
    where: { scanId: { in: rows.map((r) => r.id) } },
    orderBy: { createdAt: "desc" },
  });
  const newest = new Map<string, (typeof runs)[number]>();
  for (const run of runs) if (!newest.has(run.scanId)) newest.set(run.scanId, run);
  return rows.map((row) => ({
    ...toRecord(row),
    latestRun: newest.has(row.id) ? summarizeRun(newest.get(row.id)!) : null,
  }));
}

export async function getScan(id: string): Promise<ScanRecord> {
  const row = await prisma.networkScan.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Discovery not found");
  return toRecord(row);
}

export async function createScan(input: SaveScanInput, actor?: string): Promise<ScanRecord> {
  const who = normalizeActor(actor);
  const problem = validateScanInput(input);
  if (problem) throw new AppError(400, problem);
  const name = input.name.trim();
  const clash = await prisma.networkScan.findUnique({ where: { name } });
  if (clash) throw new AppError(409, `A Discovery named "${name}" already exists.`);
  const row = await prisma.networkScan.create({
    data: {
      name,
      description: input.description?.trim() || null,
      targets: input.targets as unknown as object,
      methods: input.methods as unknown as object,
      autoMonitor: (input.autoMonitor ?? null) as unknown as object,
      createdBy: who,
    },
  });
  await logEvent({
    action: "network_scan.created",
    resourceType: "network_scan",
    resourceId: row.id,
    resourceName: row.name,
    actor: who,
    message: `Discovery "${row.name}" created`,
    details: { targets: input.targets.length, methods: input.methods.map((m) => m.type) },
  });
  return toRecord(row);
}

export async function updateScan(id: string, input: SaveScanInput, actor?: string): Promise<ScanRecord> {
  const who = normalizeActor(actor);
  const existing = await prisma.networkScan.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Discovery not found");
  const problem = validateScanInput(input);
  if (problem) throw new AppError(400, problem);
  const name = input.name.trim();
  if (name !== existing.name) {
    const clash = await prisma.networkScan.findUnique({ where: { name } });
    if (clash) throw new AppError(409, `A Discovery named "${name}" already exists.`);
  }
  const row = await prisma.networkScan.update({
    where: { id },
    data: {
      name,
      description: input.description?.trim() || null,
      targets: input.targets as unknown as object,
      methods: input.methods as unknown as object,
      autoMonitor: (input.autoMonitor ?? null) as unknown as object,
    },
  });
  await logEvent({
    action: "network_scan.updated",
    resourceType: "network_scan",
    resourceId: row.id,
    resourceName: row.name,
    actor: who,
    message: `Discovery "${row.name}" updated`,
  });
  return toRecord(row);
}

export async function deleteScan(id: string, actor?: string): Promise<void> {
  const who = normalizeActor(actor);
  const existing = await prisma.networkScan.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Discovery not found");
  if (await isScanRunning(id)) {
    throw new AppError(409, "That Discovery is running. Cancel it before deleting.");
  }
  // The run rows cascade (they are history OF this Discovery, not independent).
  await prisma.networkScan.delete({ where: { id } });
  await logEvent({
    action: "network_scan.deleted",
    resourceType: "network_scan",
    resourceId: id,
    resourceName: existing.name,
    actor: who,
    level: "warning",
    message: `Discovery "${existing.name}" deleted`,
  });
}

// ─── Runs ───────────────────────────────────────────────────────────────────

export interface RunSummary {
  id: string;
  scanId: string;
  status: string;
  actor: string;
  error: string | null;
  totalTargets: number;
  droppedTargetCount: number;
  scannedCount: number;
  hitCount: number;
  skippedKnownCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  /** True while the row says running/queued AND its heartbeat is fresh. */
  active: boolean;
  /** Running, but the worker stopped writing — the run is presumed dead. */
  stalled: boolean;
}

function summarizeRun(row: {
  id: string; scanId: string; status: string; actor: string; error: string | null;
  totalTargets: number; droppedTargetCount: number; scannedCount: number; hitCount: number;
  skippedKnownCount: number; startedAt: Date | null; finishedAt: Date | null;
  createdAt: Date; workerHeartbeatAt: Date | null;
}): RunSummary {
  const inFlight = row.status === "running" || row.status === "queued";
  const beat = row.workerHeartbeatAt?.getTime() ?? row.createdAt.getTime();
  const stale = Date.now() - beat > SCAN_RUN_STALE_MS;
  return {
    id: row.id,
    scanId: row.scanId,
    status: row.status,
    actor: row.actor,
    error: row.error,
    totalTargets: row.totalTargets,
    droppedTargetCount: row.droppedTargetCount,
    scannedCount: row.scannedCount,
    hitCount: row.hitCount,
    skippedKnownCount: row.skippedKnownCount,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    active: inFlight && !stale,
    stalled: inFlight && stale,
  };
}

/** Is a run in flight for this Discovery? A stalled row does not count. */
export async function isScanRunning(scanId: string): Promise<boolean> {
  const row = await prisma.networkScanRun.findFirst({
    where: { scanId, status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return false;
  return summarizeRun(row).active;
}

/**
 * Start a run.
 *
 * Copies `triggerDiscovery`'s dispatch exactly: publish to the worker, and when
 * pg-boss isn't live run it in-process detached. That fallback is mandatory —
 * `Setting.monitor.queueMode` defaults to cursor, so on a default install
 * nothing would ever execute without it.
 */
export async function triggerScan(scanId: string, actor?: string): Promise<RunSummary> {
  const who = normalizeActor(actor);
  const scan = await prisma.networkScan.findUnique({ where: { id: scanId } });
  if (!scan) throw new AppError(404, "Discovery not found");

  const problem = validateScanInput({
    name: scan.name,
    targets: parseStoredTargets(scan.targets),
    methods: parseStoredMethods(scan.methods),
  });
  if (problem) throw new AppError(400, problem);

  if (await isScanRunning(scanId)) {
    throw new AppError(409, "That Discovery is already running.");
  }

  const run = await prisma.networkScanRun.create({
    data: { scanId, status: "queued", actor: who, workerHeartbeatAt: new Date() },
  });

  const enqueued = await publishScanJob(run.id, scanId, who).catch(() => false);
  if (!enqueued) {
    // Detached on purpose: the route answers 202 and the wizard watches the
    // run row. An await here would hold the request open for the whole sweep.
    void runScan(run.id, who).catch((err) => {
      logger.error({ err, runId: run.id }, "in-process network scan failed");
    });
  }
  return summarizeRun(run);
}

/** Ask a run to stop. The worker notices on its next throttle tick. */
export async function cancelRun(runId: string, actor?: string): Promise<RunSummary> {
  const who = normalizeActor(actor);
  const run = await prisma.networkScanRun.findUnique({ where: { id: runId }, include: { scan: true } });
  if (!run) throw new AppError(404, "Run not found");
  if (run.status !== "queued" && run.status !== "running") {
    // Not an error: the operator clicked Cancel as it finished.
    return summarizeRun(run);
  }
  const updated = await prisma.networkScanRun.update({
    where: { id: runId },
    data: { cancelRequested: true },
  });
  await logEvent({
    action: "network_scan.cancel_requested",
    resourceType: "network_scan",
    resourceId: run.scanId,
    resourceName: run.scan.name,
    actor: who,
    level: "warning",
    message: `Cancel requested for Discovery "${run.scan.name}"`,
  });
  return summarizeRun(updated);
}

export interface RunDetail extends RunSummary {
  hits: ScanHit[];
  scanName: string;
}

export async function getRun(runId: string): Promise<RunDetail> {
  const run = await prisma.networkScanRun.findUnique({ where: { id: runId }, include: { scan: true } });
  if (!run) throw new AppError(404, "Run not found");
  return {
    ...summarizeRun(run),
    hits: Array.isArray(run.hits) ? (run.hits as unknown as ScanHit[]) : [],
    scanName: run.scan.name,
  };
}

// ─── Target preview ─────────────────────────────────────────────────────────

export interface TargetPreview {
  total: number;
  dropped: number;
  droppedBy: { invalid: number; excluded: number; cap: number };
  perTarget: { count: number; error?: string }[];
  /**
   * Deliberately NO address list. The preview answers "did I type what I
   * meant?", and the COUNT plus the per-target verdicts answer that; shipping
   * a sample (or a range summary of one) was noise on every keystroke.
   */
  /** How many of those addresses inventory already carries. */
  alreadyKnown: number;
  cap: number;
}

/**
 * Resolve operator-typed targets without touching the network.
 *
 * Read-level on purpose: it is pure IP math plus one indexed read, and a role
 * allowed to look at a Discovery must be able to see what its targets mean.
 */
export async function previewTargets(targets: ScanTarget[]): Promise<TargetPreview> {
  const expanded = expandScanTargets(targets ?? []);
  let alreadyKnown = 0;
  if (expanded.total) {
    const known = await loadKnownAddresses();
    for (const a of expanded.addresses) if (known.has(a)) alreadyKnown += 1;
  }
  return {
    total: expanded.total,
    dropped: expanded.dropped,
    droppedBy: expanded.droppedBy,
    perTarget: expanded.perTarget.map((t) => ({ count: t.count, ...(t.error ? { error: t.error } : {}) })),
    alreadyKnown,
    cap: SCAN_MAX_TARGETS,
  };
}

// ─── Adoption ───────────────────────────────────────────────────────────────

export interface AdoptResult {
  created: number;
  skipped: { address: string; reason: string }[];
  assetIds: string[];
}

/**
 * Map a hit's identity onto an asset type.
 *
 * Deliberately shallow. `inferAssetTypeFromOs` in discoveryEngine answers
 * workstation/server/other from an OS string, which is the wrong question for a
 * PDU — and guessing "switch" from a vendor name is exactly the kind of
 * inference that is right often enough to look correct and wrong the rest of
 * the time. Everything lands as `other` unless the device's own description
 * says otherwise in as many words, and the operator retypes it once.
 */
export function assetTypeForHit(hit: ScanHit): string {
  const text = `${hit.identity?.os ?? ""} ${hit.identity?.hostname ?? ""}`.toLowerCase();
  if (/\bfortigate\b|\bfirewall\b|\bpalo alto\b|\bsonicwall\b/.test(text)) return "firewall";
  if (/\bfortiswitch\b|\bswitch\b|\bcatalyst\b|\bnexus\b/.test(text)) return "switch";
  if (/\bfortiap\b|access point|\bwlan\b|\bwireless\b/.test(text)) return "access_point";
  if (/\brouter\b|\bios\b.*\brouter\b/.test(text)) return "router";
  if (/\bprinter\b|laserjet|officejet/.test(text)) return "printer";
  return "other";
}

/** Which polling method a hit's monitoring selection should be read from. */
export function methodKeyForHit(hit: ScanHit): string {
  return hit.identifiedBy ?? (hit.respondedTo.includes("icmp") ? "icmp" : "unknown");
}

/**
 * Turn chosen responders into assets.
 *
 * Assets are created exactly like the manual `POST /assets` path — fields
 * inline, `ipSource="manual"`, and the `db.ts` extension minting the `manual`
 * AssetSource row. There is deliberately **no `network-scan` sourceKind**:
 * `projectAssetFromSources` has zero rules for a kind outside its union, so
 * such a row would contribute nothing to the projection while
 * `projectionDriftService` compared projection against the stored row — a
 * drift-log generator. Provenance goes where discovery already puts it, the
 * one-time notes boilerplate plus an audit Event.
 *
 * Pins are resolved by the SAME pure resolvers the integration auto-monitor
 * pass uses, against the inventory the scan collected, so a selection means the
 * same thing here as it does there.
 */
export async function adoptHits(
  runId: string,
  addresses: string[],
  actor?: string,
): Promise<AdoptResult> {
  const who = normalizeActor(actor);
  const run = await prisma.networkScanRun.findUnique({ where: { id: runId }, include: { scan: true } });
  if (!run) throw new AppError(404, "Run not found");
  const wanted = Array.from(new Set((addresses ?? []).map((a) => a.trim()).filter(Boolean)));
  if (!wanted.length) throw new AppError(400, "Select at least one address to add.");
  if (wanted.length > MAX_ADOPT_PER_CALL) {
    throw new AppError(400, `At most ${MAX_ADOPT_PER_CALL} addresses at a time (you selected ${wanted.length}).`);
  }

  const hits = (Array.isArray(run.hits) ? (run.hits as unknown as ScanHit[]) : []);
  const byAddress = new Map(hits.map((h) => [h.address, h]));
  const autoMonitor = (run.scan.autoMonitor as ScanAutoMonitor | null) ?? null;

  // Re-check inventory at adopt time, not scan time: minutes or hours may have
  // passed and another operator (or a discovery run) may have created the
  // device in between. This is the check that keeps the duplicate out.
  const known = await loadKnownAddresses();

  const skipped: { address: string; reason: string }[] = [];
  const assetIds: string[] = [];

  for (const address of wanted) {
    const hit = byAddress.get(address);
    if (!hit) { skipped.push({ address, reason: "Not a responder in this run" }); continue; }
    if (known.has(address)) { skipped.push({ address, reason: "An asset already carries this address" }); continue; }

    const selection = autoMonitor?.[methodKeyForHit(hit)] ?? undefined;
    let monitoredInterfaces: string[] = [];
    let monitoredIpsecTunnels: string[] = [];
    let monitoredStorage: string[] = [];
    if (selection?.interfaces && hit.interfaces?.length) {
      const picked = resolvePinnedInterfaces(
        selection.interfaces,
        hit.interfaces.map((i) => ({ ifName: i.ifName, ifType: i.ifType, operStatus: i.operStatus })),
      );
      const split = splitPinsByProvenance(
        picked,
        hit.interfaces.map((i) => ({ ifName: i.ifName, ifType: i.ifType, operStatus: i.operStatus })),
      );
      monitoredInterfaces = split.interfaces;
      monitoredIpsecTunnels = split.ipsecTunnels;
    }
    if (selection?.storage && hit.storage?.length) {
      monitoredStorage = resolvePinnedStorage(
        selection.storage,
        hit.storage.map((s) => ({ mountPath: s.mountPath })),
      );
    }

    try {
      const asset = await prisma.asset.create({
        data: {
          hostname: hit.identity?.hostname || address,
          ipAddress: address,
          ipSource: "manual",
          assetType: assetTypeForHit(hit),
          status: "active",
          manufacturer: hit.identity?.manufacturer ?? null,
          os: hit.identity?.os ?? null,
          snmpLocation: hit.identity?.snmpLocation ?? null,
          notes: `Found by Polaris Discovery "${run.scan.name}" at ${address}` +
            (hit.identifiedBy ? ` (answered ${hit.identifiedBy})` : ""),
          createdBy: who,
          statusChangedAt: new Date(),
          statusChangedBy: who,
          ...(monitoredInterfaces.length ? { monitoredInterfaces } : {}),
          ...(monitoredIpsecTunnels.length ? { monitoredIpsecTunnels } : {}),
          ...(monitoredStorage.length ? { monitoredStorage } : {}),
        },
        select: { id: true },
      });
      assetIds.push(asset.id);
      // Guard the rest of THIS call against a duplicate selection.
      known.add(address);
    } catch (err) {
      skipped.push({ address, reason: err instanceof Error ? err.message : "Create failed" });
    }
  }

  await logEvent({
    action: "network_scan.adopted",
    resourceType: "network_scan",
    resourceId: run.scanId,
    resourceName: run.scan.name,
    actor: who,
    message:
      `Added ${assetIds.length} asset(s) from Discovery "${run.scan.name}"` +
      (skipped.length ? `, ${skipped.length} skipped` : ""),
    details: { created: assetIds.length, skipped },
  });

  return { created: assetIds.length, skipped, assetIds };
}
