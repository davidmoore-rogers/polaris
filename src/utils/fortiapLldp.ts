/**
 * src/utils/fortiapLldp.ts
 *
 * Pure (no I/O) extractor for the LLDP + mesh fields on a FortiOS
 * `/api/v2/monitor/wifi/managed_ap` row. Used by both fortimanagerService
 * and fortigateService — each FortiAP discovery path calls this to learn
 * its wired uplink (FortiSwitch hostname + port) directly from the AP
 * itself, plus its mesh parent serial when applicable.
 *
 * The wired-uplink discriminator is `system_description` starts with
 * "FortiSwitch" — that filters out wireless backhaul rows (which advertise
 * "FortiAP-…" peers) and any other LLDP-speaking gear that isn't a
 * managed FortiSwitch (e.g., upstream non-Fortinet switches stay
 * un-resolved here; they'd need a separate path). The bare "FortiSwitch"
 * prefix (not "FortiSwitch-") is deliberate: the Rugged family advertises
 * "FortiSwitchRugged-112F-POE …", so requiring the hyphen dropped every
 * FSR uplink on the floor.
 *
 * `port_id` is the canonical port label ("port9"); `port_description` is
 * operator-set free text and not safe to key on.
 */

export interface FortiapLldpResult {
  // Filled when the AP's LLDP table reports a FortiSwitch neighbor on a
  // wired uplink. system_name and port_id from the matching LLDP entry.
  lldpUplinkSwitch?: string;
  lldpUplinkPort?: string;
  // The AP-local port that observed the FortiSwitch neighbor (e.g.
  // "lan1"). Captured from the same matching LLDP entry's `local_port`.
  // Falls back to `wan_status.interface` in the caller when LLDP is empty.
  lldpLocalPort?: string;
  // Mesh role + parent. mesh_uplink: "ethernet" = wired-uplink AP, "mesh"
  // = wireless-mesh leaf. parent_wtp_id = the parent AP's serial number;
  // only meaningful when meshUplink === "mesh".
  meshUplink?: "ethernet" | "mesh";
  parentApSerial?: string;
  // AP's own uplink interface as reported by `wan_status[].interface` on
  // the managed_ap row. `lan*` = physical Ethernet; `wbh*` = wireless
  // bridge (virtual). Preferred signal for "which port on the AP is
  // uplinking" because it's authoritative regardless of whether LLDP
  // saw anything. Falls back to `lldpLocalPort` when missing.
  wanInterface?: string;
}

interface ApLldpEntry {
  local_port?: unknown;
  chassis_id?: unknown;
  system_name?: unknown;
  system_description?: unknown;
  port_id?: unknown;
  port_description?: unknown;
}

/**
 * One fully-parsed LLDP neighbor off a managed_ap row — every entry, not
 * just the FortiSwitch-uplink summary `extractApLldpAndMesh` distills.
 * Structurally compatible with monitoringService's `LldpNeighborSample`
 * so the persist layer consumes it as-is.
 */
export interface ApLldpNeighborSample {
  localIfName:        string;
  chassisIdSubtype?:  string | null;
  chassisId?:         string | null;
  portIdSubtype?:     string | null;
  portId?:            string | null;
  portDescription?:   string | null;
  systemName?:        string | null;
  systemDescription?: string | null;
  managementIp?:      string | null;
  capabilities?:      string[];
}

interface ApRowForLldp {
  lldp?: unknown;
  mesh_uplink?: unknown;
  parent_wtp_id?: unknown;
  wan_status?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Six hex pairs separated by ":" / "-" (FortiOS emits colon form; dash
// defended). Used to infer the macAddress subtype when FortiOS doesn't
// carry an explicit one.
const MAC_SHAPE = /^[0-9a-f]{2}([:\-][0-9a-f]{2}){5}$/i;

// FortiOS managed_ap LLDP entries pack the subtype INTO the value string as
// a leading word — real payloads show `chassis_id: "mac e0:23:ff:36:26:ee"`.
// Map the observed FortiOS tokens onto the canonical subtype names the rest
// of the LLDP pipeline uses (persist-time asset matching keys on
// `chassisIdSubtype === "macAddress"`; the Device Map's edge-label backfill
// keys on the name-form portId subtypes).
const FORTIOS_SUBTYPE_TOKENS: Record<string, string> = {
  mac:     "macAddress",
  ip:      "networkAddress",
  ifname:  "interfaceName",
  ifalias: "interfaceAlias",
  local:   "local",
};

/**
 * Split an LLDP id value into (subtype, value). Handles the FortiOS
 * "<token> <value>" packing, then falls back to shape inference: a bare
 * MAC-looking string is macAddress, anything else non-empty is
 * interfaceName for port ids / local for chassis ids (callers pass the
 * fallback). MAC values are normalized colon-uppercase so persist-time
 * matching lines up with `Asset.macAddress` normalization.
 */
function splitLldpId(raw: string, nonMacFallback: string | null): { subtype: string | null; value: string } {
  const trimmed = raw.trim();
  const sp = trimmed.indexOf(" ");
  if (sp > 0) {
    const token = trimmed.slice(0, sp).toLowerCase();
    const rest = trimmed.slice(sp + 1).trim();
    const mapped = FORTIOS_SUBTYPE_TOKENS[token];
    if (mapped && rest) {
      const value = mapped === "macAddress" && MAC_SHAPE.test(rest)
        ? rest.toUpperCase().replace(/-/g, ":")
        : rest;
      return { subtype: mapped, value };
    }
  }
  if (MAC_SHAPE.test(trimmed)) {
    return { subtype: "macAddress", value: trimmed.toUpperCase().replace(/-/g, ":") };
  }
  return { subtype: trimmed ? nonMacFallback : null, value: trimmed };
}

export function extractApLldpAndMesh(row: ApRowForLldp): FortiapLldpResult {
  const out: FortiapLldpResult = {};

  // 1. Wired uplink LLDP — find the first entry whose neighbor advertises
  //    itself as a FortiSwitch. Skip mesh peers (FortiAP-…) and any other
  //    non-FortiSwitch neighbors. Order in the FortiOS payload is local-
  //    port-major, but we iterate defensively.
  if (Array.isArray(row.lldp)) {
    for (const raw of row.lldp as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as ApLldpEntry;
      const sysDesc = asString(e.system_description);
      // Match "FortiSwitch-148E…" and "FortiSwitchRugged-112F…" alike, but
      // still exclude "FortiAP-…" mesh peers (they don't start "FortiSwitch").
      if (!sysDesc.startsWith("FortiSwitch")) continue;
      const sysName = asString(e.system_name).trim();
      const portId = asString(e.port_id).trim();
      if (!sysName || !portId) continue;
      out.lldpUplinkSwitch = sysName;
      out.lldpUplinkPort = portId;
      const localPort = asString(e.local_port).trim();
      if (localPort) out.lldpLocalPort = localPort;
      break;
    }
  }

  // 1b. `wan_status` reports the AP's own uplink interface authoritatively
  //     — works even when LLDP is empty (e.g. AP plugged into a non-LLDP
  //     speaker, or LLDP RX not enabled on the FortiSwitch port).
  //     FortiOS firmware variance: sometimes a single object, sometimes
  //     an array. Pick the first entry whose `interface` is non-empty.
  const wanStatus = row.wan_status;
  if (Array.isArray(wanStatus)) {
    for (const w of wanStatus as unknown[]) {
      if (!w || typeof w !== "object") continue;
      const iface = asString((w as { interface?: unknown }).interface).trim();
      if (iface) { out.wanInterface = iface; break; }
    }
  } else if (wanStatus && typeof wanStatus === "object") {
    const iface = asString((wanStatus as { interface?: unknown }).interface).trim();
    if (iface) out.wanInterface = iface;
  }

  // 2. Mesh fields. mesh_uplink is FortiOS's own classification — trust
  //    it directly. parent_wtp_id is only meaningful for mesh leaves.
  const meshUplink = asString(row.mesh_uplink).trim();
  if (meshUplink === "ethernet" || meshUplink === "mesh") {
    out.meshUplink = meshUplink;
  }
  const parentWtp = asString(row.parent_wtp_id).trim();
  if (parentWtp) out.parentApSerial = parentWtp;

  return out;
}

/**
 * Parse the FULL `lldp` array off a managed_ap row into neighbor samples —
 * every entry (FortiSwitch uplink, wireless-mesh FortiAP peers, non-Fortinet
 * gear), unlike `extractApLldpAndMesh` which distills a single-uplink
 * summary. The sync layer persists these as real `AssetLldpNeighbor` rows
 * (source "managed-ap") so the asset-details LLDP section and the Device Map
 * show the AP's exact neighbors instead of peer-inferred ones.
 *
 * Returns `undefined` when the row carries no `lldp` array at all (firmware
 * that doesn't return the field — caller must NOT wipe existing rows), and
 * `[]` when the array is present but empty (a real "no neighbors seen"
 * scrape — full-replace semantics apply, subject to the persist layer's
 * 48-hour stickiness grace).
 *
 * `local_port` is kept verbatim (FortiAP-CLI naming, e.g. "lan1"); the
 * persist wrapper normalizes it against the AP's SNMP ifNames (lan1 ↔ eth0,
 * see fortiapInterfaceAlias.ts) where the interface table is available.
 */
export function parseApLldpNeighbors(row: ApRowForLldp): ApLldpNeighborSample[] | undefined {
  if (!Array.isArray(row.lldp)) return undefined;
  const out: ApLldpNeighborSample[] = [];
  for (const raw of row.lldp as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as ApLldpEntry & { management_ip?: unknown; mgmt_ip?: unknown; capability?: unknown };
    const localPort = asString(e.local_port).trim();
    if (!localPort) continue; // no local anchor — row can't render anywhere
    const chassisRaw = asString(e.chassis_id).trim();
    const portRaw = asString(e.port_id).trim();
    const systemName = asString(e.system_name).trim();
    // Require at least one identity field so all-empty filler rows don't
    // persist as unmatchable ghosts.
    if (!chassisRaw && !portRaw && !systemName) continue;
    const chassis = splitLldpId(chassisRaw, "local");
    const port = splitLldpId(portRaw, "interfaceName");
    const portDescription = asString(e.port_description).trim();
    const systemDescription = asString(e.system_description).trim();
    const managementIp = asString(e.management_ip).trim() || asString(e.mgmt_ip).trim();
    // Capability tokens when present (string CSV or array — firmware varies).
    const capRaw = e.capability;
    const capabilities = Array.isArray(capRaw)
      ? capRaw.map((c) => String(c).trim().toLowerCase()).filter((c) => c.length > 0)
      : typeof capRaw === "string"
        ? capRaw.split(/[,\s]+/).map((c) => c.trim().toLowerCase()).filter((c) => c.length > 0)
        : [];
    out.push({
      localIfName:       localPort,
      chassisIdSubtype:  chassis.subtype,
      chassisId:         chassis.value || null,
      portIdSubtype:     port.subtype,
      portId:            port.value || null,
      portDescription:   portDescription || null,
      systemName:        systemName || null,
      systemDescription: systemDescription || null,
      managementIp:      managementIp || null,
      capabilities,
    });
  }
  return out;
}
