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

interface ApRowForLldp {
  lldp?: unknown;
  mesh_uplink?: unknown;
  parent_wtp_id?: unknown;
  wan_status?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
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
