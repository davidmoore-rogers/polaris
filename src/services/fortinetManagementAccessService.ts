/**
 * src/services/fortinetManagementAccessService.ts
 *
 * Reads the management-access configuration (`allowaccess` — the set of
 * protocols permitted on a device's management surface, e.g. "ping https ssh
 * snmp") for Fortinet devices discovered through a FortiManager or standalone
 * FortiGate integration, and summarizes it into the shape stored on
 * `Asset.managementAccess`.
 *
 * Three device classes read their access config from different places:
 *   - Firewall (FortiGate) — the operator-named management interface's
 *     `allowaccess` from `/api/v2/cmdb/system/interface`.
 *   - Access point (FortiAP) — the AP's `wtp-profile` `allowaccess` on the
 *     controller FortiGate (`/api/v2/cmdb/wireless-controller/wtp-profile`,
 *     joined to the AP via `/api/v2/cmdb/wireless-controller/wtp`).
 *   - Switch (FortiSwitch) — the switch's `internal` (or custom) interface
 *     `allowaccess`. ⚠️ The exact REST source for a managed FortiSwitch's own
 *     interface allowaccess is NOT yet verified on a live FortiOS 7.x device;
 *     the parser is best-effort and yields `protocols: null` (unknown) when it
 *     cannot read it, so the UI renders buttons optimistically with a note.
 *
 * The summary drives the asset slide-over's Open HTTPS / Open SSH buttons and
 * the FortiAP "SNMP not enabled in profile" warning. It is read-only — nothing
 * here writes to the device.
 *
 * Transport is unified via buildTransportForIntegration + callFortiOs, so the
 * same code path serves FMG-proxy, FMG-direct, and standalone FortiGate.
 */

import { buildTransportForIntegration, callFortiOs } from "./reservationPushService.js";
import { logger } from "../utils/logger.js";

export type ManagementAccessSource = "firewall-interface" | "fortiswitch" | "fortiap-profile";

export interface ManagementAccessSummary {
  source: ManagementAccessSource;
  /** Interface name the access was read from (firewall/switch), else null. */
  interfaceName: string | null;
  /** AP profile name (AP only), else null. */
  profileName: string | null;
  /** IP the slide-over buttons should target. Falls back upstream to Asset.ipAddress. */
  mgmtIp: string | null;
  /** Normalized lowercase allowaccess list, or null when it could not be read. */
  protocols: string[] | null;
  https: boolean;
  ssh: boolean;
  snmp: boolean;
  /** ISO timestamp of the read. */
  checkedAt: string;
}

export const DEFAULT_SWITCH_MGMT_INTERFACE = "internal";

// ─── Pure parsers (unit-tested) ───────────────────────────────────────────────

/**
 * Normalize a FortiOS `allowaccess` value to a lowercase protocol list.
 * FortiOS returns it either as a space-separated string ("ping https ssh snmp")
 * or, on some CMDB/monitor shapes, an array of strings or `{q_origin_key|name}`
 * objects. Anything unrecognized yields an empty list (never throws).
 */
export function parseAllowaccess(raw: unknown): string[] {
  const out: string[] = [];
  const push = (s: unknown) => {
    if (typeof s !== "string") return;
    for (const tok of s.trim().split(/\s+/)) {
      const t = tok.trim().toLowerCase();
      if (t) out.push(t);
    }
  };
  if (typeof raw === "string") {
    push(raw);
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string") push(entry);
      else if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        push(o.q_origin_key ?? o.name ?? o.id);
      }
    }
  }
  // Dedupe, preserve order.
  return [...new Set(out)];
}

/** Convenience booleans for the protocols that drive UI affordances. */
export function protocolFlags(protocols: string[] | null): { https: boolean; ssh: boolean; snmp: boolean } {
  if (!protocols) return { https: false, ssh: false, snmp: false };
  const has = (p: string) => protocols.includes(p);
  return { https: has("https"), ssh: has("ssh"), snmp: has("snmp") };
}

/** Pull the first IPv4 token from a CMDB interface `ip` field ("10.0.0.1 255.255.255.0"). */
function firstIpToken(ip: unknown): string | null {
  if (typeof ip !== "string") return null;
  const tok = ip.trim().split(/\s+/)[0];
  return tok && tok !== "0.0.0.0" ? tok : null;
}

function normalizeCmdbArray(res: unknown): any[] {
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object" && Array.isArray((res as any).results)) return (res as any).results;
  return [];
}

/** Find a CMDB `system/interface` row by name (case-insensitive). */
export function findInterfaceRow(cmdbInterfaces: unknown, ifName: string | null | undefined): any | null {
  const name = (ifName ?? "").trim().toLowerCase();
  if (!name) return null;
  for (const row of normalizeCmdbArray(cmdbInterfaces)) {
    if (row && typeof row === "object" && typeof row.name === "string" && row.name.trim().toLowerCase() === name) {
      return row;
    }
  }
  return null;
}

function buildSummary(
  source: ManagementAccessSource,
  fields: { interfaceName?: string | null; profileName?: string | null; mgmtIp?: string | null; protocols: string[] | null },
  checkedAt: string,
): ManagementAccessSummary {
  const flags = protocolFlags(fields.protocols);
  return {
    source,
    interfaceName: fields.interfaceName ?? null,
    profileName: fields.profileName ?? null,
    mgmtIp: fields.mgmtIp ?? null,
    protocols: fields.protocols,
    ...flags,
    checkedAt,
  };
}

/**
 * Firewall summary from a `/api/v2/cmdb/system/interface` response + the
 * operator-named management interface. Returns null when the named interface
 * isn't present (so the caller leaves managementAccess untouched).
 */
export function buildFirewallSummary(
  cmdbInterfaces: unknown,
  mgmtInterfaceName: string | null | undefined,
  fallbackMgmtIp: string | null | undefined,
  checkedAt: string,
): ManagementAccessSummary | null {
  const row = findInterfaceRow(cmdbInterfaces, mgmtInterfaceName);
  if (!row) return null;
  const protocols = parseAllowaccess(row.allowaccess);
  return buildSummary(
    "firewall-interface",
    {
      interfaceName: typeof row.name === "string" ? row.name : (mgmtInterfaceName ?? null),
      mgmtIp: firstIpToken(row.ip) ?? (fallbackMgmtIp || null),
      protocols,
    },
    checkedAt,
  );
}

/** profileName(lowercased) → protocol list, from a `wtp-profile` CMDB response. */
export function parseWtpProfiles(res: unknown): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of normalizeCmdbArray(res)) {
    if (row && typeof row === "object" && typeof row.name === "string") {
      map.set(row.name.trim().toLowerCase(), parseAllowaccess(row.allowaccess));
    }
  }
  return map;
}

/** AP serial(uppercased) → profile name, from a `wtp` CMDB response. */
export function parseWtpToProfile(res: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of normalizeCmdbArray(res)) {
    if (!row || typeof row !== "object") continue;
    const serial = row.serial ?? row["wtp-id"] ?? row.wtp_id ?? row.name;
    const profile = row["wtp-profile"] ?? row.wtp_profile;
    if (typeof serial === "string" && typeof profile === "string" && serial.trim() && profile.trim()) {
      map.set(serial.trim().toUpperCase(), profile.trim());
    }
  }
  return map;
}

/**
 * AP summary by joining the AP serial → wtp-profile → allowaccess. Returns null
 * when the AP can't be resolved to a profile (leaves managementAccess untouched).
 */
export function buildApSummary(
  apSerial: string,
  apIp: string | null | undefined,
  wtpToProfile: Map<string, string>,
  profiles: Map<string, string[]>,
  checkedAt: string,
): ManagementAccessSummary | null {
  const profileName = wtpToProfile.get((apSerial ?? "").trim().toUpperCase());
  if (!profileName) return null;
  const protocols = profiles.get(profileName.toLowerCase()) ?? [];
  return buildSummary(
    "fortiap-profile",
    { profileName, mgmtIp: apIp || null, protocols },
    checkedAt,
  );
}

/**
 * Switch summary. ⚠️ Best-effort: the managed-switch CMDB object does not
 * reliably expose the FortiSwitch's own interface `allowaccess` over the
 * controller's REST API (needs verification on a live FortiOS 7.x device).
 * When the access list can't be read, `protocols` is null (unknown) and the UI
 * renders buttons optimistically with an "unverified" note rather than hiding
 * them. We still attempt to read a per-switch interface allowaccess if the
 * firmware exposes one.
 */
export function buildSwitchSummary(
  managedSwitchRow: unknown,
  switchIfaceName: string,
  switchIp: string | null | undefined,
  checkedAt: string,
): ManagementAccessSummary {
  let protocols: string[] | null = null;
  if (managedSwitchRow && typeof managedSwitchRow === "object") {
    const row = managedSwitchRow as Record<string, any>;
    // Some firmware exposes a `switch-interface` / `interface` array on the
    // managed-switch object; try to find the named SVI's allowaccess.
    const ifaceArrays = [row["switch-interface"], row.interface, row.interfaces].filter(Array.isArray) as any[][];
    for (const arr of ifaceArrays) {
      const m = findInterfaceRow(arr, switchIfaceName);
      if (m && m.allowaccess !== undefined) {
        protocols = parseAllowaccess(m.allowaccess);
        break;
      }
    }
  }
  return buildSummary(
    "fortiswitch",
    { interfaceName: switchIfaceName, mgmtIp: switchIp || null, protocols },
    checkedAt,
  );
}

// ─── Live collection ──────────────────────────────────────────────────────────

export interface DeviceAccessGroup {
  /** Controller FortiGate device name (used to build the transport). */
  deviceName: string;
  /** The firewall itself, when this device is a discovered firewall asset. */
  firewall?: { serial: string; mgmtIp?: string | null } | null;
  switches: Array<{ serial: string; ipAddress?: string | null }>;
  aps: Array<{ serial: string; ipAddress?: string | null }>;
}

/** Run async work over `items` with a bounded concurrency. */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners: Promise<void>[] = [];
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await fn(next);
    }
  };
  for (let i = 0; i < Math.max(1, Math.min(limit, items.length)); i++) runners.push(worker());
  await Promise.all(runners);
}

/**
 * Collect management-access summaries for every firewall / switch / AP in the
 * supplied groups. Returns a Map keyed by device SERIAL. Failures (transport
 * build, individual REST reads) are swallowed per-device so one unreachable
 * FortiGate never aborts the whole pass — the affected serials simply don't
 * appear in the returned map, and the caller leaves their managementAccess as-is.
 */
export async function collectManagementAccess(
  integration: { id: string; type: string; config: unknown },
  groups: DeviceAccessGroup[],
  opts: { mgmtInterface?: string | null; switchManagementInterface?: string | null; concurrency?: number; checkedAt?: string } = {},
): Promise<Map<string, ManagementAccessSummary>> {
  const result = new Map<string, ManagementAccessSummary>();
  const checkedAt = opts.checkedAt ?? new Date().toISOString();
  const mgmtIfaceName = (opts.mgmtInterface ?? "").trim() || "mgmt";
  const switchIfaceName = (opts.switchManagementInterface ?? "").trim() || DEFAULT_SWITCH_MGMT_INTERFACE;

  await mapWithConcurrency(groups, opts.concurrency ?? 4, async (group) => {
    if (!group.deviceName) return;
    const needsWireless = group.aps.length > 0;
    const needsSwitch = group.switches.length > 0;
    let transport;
    try {
      transport = await buildTransportForIntegration(integration, group.deviceName);
    } catch (err) {
      logger.debug({ err, device: group.deviceName }, "managementAccess: transport build failed; skipping device");
      return;
    }

    const get = (path: string) =>
      callFortiOs<unknown>(transport!, "GET", path).catch((err) => {
        logger.debug({ err, device: group.deviceName, path }, "managementAccess: CMDB read failed");
        return null;
      });

    const [cmdbInterfaces, wtpProfilesRes, wtpRes, managedSwitchRes] = await Promise.all([
      group.firewall ? get("/api/v2/cmdb/system/interface") : Promise.resolve(null),
      needsWireless ? get("/api/v2/cmdb/wireless-controller/wtp-profile") : Promise.resolve(null),
      needsWireless ? get("/api/v2/cmdb/wireless-controller/wtp") : Promise.resolve(null),
      needsSwitch ? get("/api/v2/cmdb/switch-controller/managed-switch") : Promise.resolve(null),
    ]);

    // Firewall
    if (group.firewall && cmdbInterfaces) {
      const summary = buildFirewallSummary(cmdbInterfaces, mgmtIfaceName, group.firewall.mgmtIp, checkedAt);
      if (summary) result.set(group.firewall.serial, summary);
    }

    // Access points
    if (needsWireless) {
      const profiles = parseWtpProfiles(wtpProfilesRes);
      const wtpToProfile = parseWtpToProfile(wtpRes);
      for (const ap of group.aps) {
        const summary = buildApSummary(ap.serial, ap.ipAddress, wtpToProfile, profiles, checkedAt);
        if (summary) result.set(ap.serial, summary);
      }
    }

    // Switches (best-effort; protocols may be null/unknown)
    if (needsSwitch) {
      const switchRows = normalizeCmdbArray(managedSwitchRes);
      const bySerial = new Map<string, any>();
      for (const row of switchRows) {
        const sn = row?.["switch-id"] ?? row?.serial ?? row?.name;
        if (typeof sn === "string") bySerial.set(sn.trim().toUpperCase(), row);
      }
      for (const sw of group.switches) {
        const row = bySerial.get((sw.serial ?? "").trim().toUpperCase()) ?? null;
        result.set(sw.serial, buildSwitchSummary(row, switchIfaceName, sw.ipAddress, checkedAt));
      }
    }
  });

  return result;
}
