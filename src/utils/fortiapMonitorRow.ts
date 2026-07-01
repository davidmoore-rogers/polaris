/**
 * src/utils/fortiapMonitorRow.ts
 *
 * Pure (no I/O) parser for one row of FortiOS's
 * `/api/v2/monitor/wifi/managed_ap` response. Shared by
 * `fortimanagerService` (proxy path) and `fortigateService` (direct REST)
 * so the two transports don't drift on field handling.
 *
 * Per-AP IP picker (first non-empty wins, `0.0.0.0` normalized to empty):
 *   ip_addr → ip_address → local_ipv4_address → local_ipv4_addr → local_addr →
 *   wtp_ip → connecting_ip → connecting_from
 * (`local_addr` / `connecting_from` are the field names some FortiOS releases
 * populate instead of the `local_ipv4*` / `connecting_ip` variants — an AP
 * whose IP only lands in those keys otherwise projects with no IP.)
 *
 * Per-AP MAC picker (first non-empty wins, all-zero MAC normalized to empty):
 *   base_mac → board_mac → mac
 *
 * Model derivation: when `model` (and the `wtp_profile` fallback) come
 * back empty, FortiAP serials encode the model in the leading "FP" +
 * suffix prefix (e.g. `FP234FTF21000000` → model `FortiAP-234F`).
 * Lifted out as a separate helper because operators sometimes have APs
 * whose model field is blank in the proxy response even though the
 * serial is healthy.
 */

import { extractApLldpAndMesh, parseApLldpNeighbors, type ApLldpNeighborSample } from "./fortiapLldp.js";

const ALL_ZERO_MAC = /^0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}[:\-.]0{1,2}$/i;

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Derive a human "FortiAP-234F"-style model string from a FortiAP serial
 * number. FortiAP serials start with "FP", then the marketing model code,
 * then a per-unit body (region letter + date + sequence).
 *
 * The model code is `<2-3 digits><trailing letter(s)>` with an optional
 * leading letter for the special families:
 *   - common indoor/outdoor: 221E, 231F, 234F, 431G, 231K, 243K  (digits + 1 letter)
 *   - J-series:              23JF, 24JF                          (digits + "J" + letter)
 *   - U-series / EV suffix:  U431F, U421EV                       (leading "U", optional "EV")
 *   - S-series:              S321C                               (leading "S")
 *
 * We anchor on that grammar rather than a fixed char count: the previous
 * `{3,5}` greedy window over-captured the start of the serial body (e.g.
 * `FP231K5...` → `231K5` instead of `231K`, and `FP234FTF...` → `234FT`).
 * The serial body can begin with either a digit (`FP231K5...`) or a letter
 * (`FP234FTF...`), so we match the model code itself, not "everything up to
 * the next digit". Returns empty string when the serial doesn't match the
 * expected shape — caller decides whether to fall back or leave it empty.
 */
export function deriveFortiapModelFromSerial(serial: string): string {
  if (!serial) return "";
  const m = /^FP([A-Z]?\d{2,3}(?:J[A-Z]|EV|[A-Z]))[A-Z0-9]*$/i.exec(serial.trim());
  if (!m) return "";
  return `FortiAP-${m[1].toUpperCase()}`;
}

export interface FortiapTelemetrySnapshot {
  cpuPct?: number;
  memFreeMb?: number;
  memTotalMb?: number;
  sensorTemperatures?: Array<{ name: string; celsius: number }>;
}

/**
 * Pull cpu_usage / mem_free / mem_total / sensors_temperatures off one
 * managed_ap row in a transport-agnostic way. Exported on its own so the
 * runtime telemetry collector (monitoringService.collectTelemetryFortiapRest)
 * can reuse the parser when it queries the same endpoint at telemetry
 * cadence.
 *
 * `sensors_temperatures` shape varies across FortiOS releases — sometimes
 * an array of `{name, value}` (or `{name, celsius}`), sometimes a single
 * scalar number that we interpret as one anonymous sensor named "ap".
 */
export function parseFortiapTelemetrySnapshot(row: Record<string, unknown>): FortiapTelemetrySnapshot {
  const out: FortiapTelemetrySnapshot = {};
  const cpu = num(row.cpu_usage);
  if (cpu !== undefined) out.cpuPct = cpu;
  const memFree = num(row.mem_free);
  if (memFree !== undefined) out.memFreeMb = memFree;
  const memTotal = num(row.mem_total);
  if (memTotal !== undefined) out.memTotalMb = memTotal;

  const sensors: Array<{ name: string; celsius: number }> = [];
  const raw = row.sensors_temperatures;
  if (Array.isArray(raw)) {
    for (const s of raw as unknown[]) {
      if (typeof s === "number" && Number.isFinite(s)) {
        sensors.push({ name: "sensor", celsius: s });
        continue;
      }
      if (s && typeof s === "object") {
        const obj = s as Record<string, unknown>;
        const name = str(obj.name).trim() || str(obj.sensor).trim() || "sensor";
        const celsius = num(obj.celsius) ?? num(obj.value) ?? num(obj.temperature);
        if (celsius !== undefined) sensors.push({ name, celsius });
      }
    }
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    sensors.push({ name: "ap", celsius: raw });
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const [name, val] of Object.entries(obj)) {
      const celsius = num(val);
      if (celsius !== undefined) sensors.push({ name, celsius });
    }
  }
  if (sensors.length > 0) out.sensorTemperatures = sensors;
  return out;
}

export interface ParsedFortiapRow {
  name:        string;
  serial:      string;
  model:       string;
  ipAddress:   string;
  baseMac:     string;
  status:      string;
  osVersion:   string;
  // Wired uplink + mesh + AP-local port from the LLDP/wan_status block.
  peerSwitch?:        string;
  peerPort?:          string;
  peerSource?:        "lldp" | "detected-device";
  meshUplink?:        "ethernet" | "mesh";
  parentApSerial?:    string;
  apUplinkInterface?: string;
  // Full LLDP neighbor table off the same row (every entry, not just the
  // FortiSwitch-uplink summary above). Absent when the row carried no
  // `lldp` array at all — consumers must treat absent as "unknown, don't
  // wipe" and `[]` as "scraped clean".
  lldpNeighbors?:     ApLldpNeighborSample[];
  // Telemetry snapshot.
  cpuPct?:             number;
  memFreeMb?:          number;
  memTotalMb?:         number;
  sensorTemperatures?: Array<{ name: string; celsius: number }>;
}

/** Parse one row of the managed_ap monitor response into the shape both
 *  discovery services consume. */
export function parseFortiapMonitorRow(row: Record<string, unknown>): ParsedFortiapRow {
  const rawApIp = str(row.ip_addr)
    || str(row.ip_address)
    || str(row.local_ipv4_address)
    || str(row.local_ipv4_addr)
    || str(row.local_addr)
    || str(row.wtp_ip)
    || str(row.connecting_ip)
    || str(row.connecting_from)
    || "";
  const rawApMac = str(row.base_mac) || str(row.board_mac) || str(row.mac) || "";

  const lldpExt = extractApLldpAndMesh(row as Parameters<typeof extractApLldpAndMesh>[0]);
  const lldpNeighbors = parseApLldpNeighbors(row as Parameters<typeof parseApLldpNeighbors>[0]);
  const tel = parseFortiapTelemetrySnapshot(row);

  const serial = str(row.serial) || str(row.wtp_id) || "";
  // model on the live row first, then wtp_profile (CMDB-side fallback),
  // then serial-prefix derivation. Operators have reported APs whose
  // model comes back blank from /managed_ap even on healthy units;
  // derivation closes the gap without faking data when the serial is
  // also missing.
  let model = str(row.model) || str(row.wtp_profile) || "";
  if (!model) model = deriveFortiapModelFromSerial(serial);

  const apUplinkInterface = lldpExt.wanInterface || lldpExt.lldpLocalPort;

  return {
    name:       str(row.name) || str(row.wtp_id) || "",
    serial,
    model,
    ipAddress:  rawApIp === "0.0.0.0" ? "" : rawApIp,
    baseMac:    ALL_ZERO_MAC.test(rawApMac) ? "" : rawApMac,
    status:     str(row.status) || str(row.state) || "",
    osVersion:  str(row.os_version) || str(row.version) || str(row.firmware_version) || "",
    ...(lldpExt.lldpUplinkSwitch && lldpExt.lldpUplinkPort
      ? { peerSwitch: lldpExt.lldpUplinkSwitch, peerPort: lldpExt.lldpUplinkPort, peerSource: "lldp" as const }
      : {}),
    ...(lldpExt.meshUplink ? { meshUplink: lldpExt.meshUplink } : {}),
    ...(lldpExt.parentApSerial ? { parentApSerial: lldpExt.parentApSerial } : {}),
    ...(apUplinkInterface ? { apUplinkInterface } : {}),
    ...(lldpNeighbors ? { lldpNeighbors } : {}),
    ...(tel.cpuPct !== undefined ? { cpuPct: tel.cpuPct } : {}),
    ...(tel.memFreeMb !== undefined ? { memFreeMb: tel.memFreeMb } : {}),
    ...(tel.memTotalMb !== undefined ? { memTotalMb: tel.memTotalMb } : {}),
    ...(tel.sensorTemperatures ? { sensorTemperatures: tel.sensorTemperatures } : {}),
  };
}

/** Tightened `format=` query for /api/v2/monitor/wifi/managed_ap. Single
 *  source of truth — both transports import this so they don't drift. */
export const FORTIAP_MONITOR_FORMAT = [
  "name", "wtp_id", "serial", "model", "wtp_profile",
  // IP picker (firmware variance — keep all known field names)
  "ip_addr", "ip_address", "local_ipv4_address", "local_ipv4_addr", "local_addr", "wtp_ip", "connecting_ip", "connecting_from",
  // MAC picker
  "base_mac", "board_mac", "mac",
  "status", "state",
  "os_version", "version", "firmware_version",
  // Topology
  "lldp", "mesh_uplink", "parent_wtp_id", "wan_status",
  // Telemetry
  "cpu_usage", "mem_free", "mem_total", "sensors_temperatures",
].join("|");
