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
import { deriveRadioBand } from "./fortiapRadioBand.js";

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

/**
 * True when a managed_ap `status` value means the AP is currently up.
 * FortiOS firmware variance: most releases report "online" (the
 * controller-status probe documents "online" | "offline" | "discovered" |
 * ...), some report "connected" — accept both, exactly like the probe path
 * in monitoringService. Empty/missing gets the benefit of the doubt so a
 * payload quirk doesn't silently freeze lastSeen (or gate off the LLDP
 * persist) for a whole fleet.
 */
export function isFortiapStatusOnline(status: string | null | undefined): boolean {
  const s = (status ?? "").trim();
  if (!s) return true;
  return /^(connected|online)$/i.test(s);
}

/**
 * True when a managed_ap version string is the canonical live-firmware shape
 * FortiOS reports in `os_version`: "FP432F-v7.6.5-build1105" (platform prefix,
 * dotted version, build). The response rows ALSO carry `version` /
 * `firmware_version` fields holding a CACHED display-format value
 * ("7.4.5 Build 0734", a bare "FortiAP" placeholder, or blank) that lags
 * upgrades — observed fleet-wide on FortiOS 7.6.7 (2026-07: stale versions
 * persisted for a week after AP upgrades whenever a scrape caught a row
 * without os_version and the parser fell back to the cached field). Fallback
 * values are only trusted when they match this canonical shape.
 */
export function isCanonicalFortiapVersion(v: string | null | undefined): boolean {
  return !!v && /^FP[A-Z0-9]*-v\d+\.\d+(\.\d+)?-build\d+$/i.test(v.trim());
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
  // Controller admission state from the row's `state` field ("authorized" /
  // "discovered" / ...). Distinct from `status` (connectivity): an AP can be
  // authorized-but-offline or discovered-but-connected. Empty when the
  // firmware omits the field. Surfaced as the Authorization row on the
  // asset details General tab via fortinetTopology.state.
  authorizationState: string;
  // AP profile the controller has this WTP bound to (`wtp_profile`) — the
  // FortiOS object that decides its radios, SSIDs and power. Empty when the
  // firmware omits the field. Surfaced as the AP Profile row on the asset
  // details General tab via fortinetTopology.profile. Note the overlap with
  // `model`, which falls back to this same field when the row carries no
  // model of its own: that fallback stays (a blank model reads worse than a
  // profile name), but the profile is now carried in its own right rather
  // than only as that stand-in.
  profile:     string;
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
  // Radio inventory + the SSIDs each radio broadcasts. Absent when the row
  // carried no `radio` array — "unknown, do not wipe", the same contract as
  // lldpNeighbors above.
  radios?:            ApRadioSample[];
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
  const radios = parseFortiapRadios(row);

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
    authorizationState: str(row.state).trim(),
    // Hyphenated form first: the monitor endpoint answers `wtp_profile`, but
    // the wtp CMDB (and some proxied FMG shapes) spell it `wtp-profile`.
    profile:    (str(row["wtp-profile"]) || str(row.wtp_profile)).trim(),
    // os_version is the live running firmware; version/firmware_version are
    // cached display-format values that lag upgrades — accept them only in
    // the canonical shape (see isCanonicalFortiapVersion). A row with no
    // usable version yields "" and the sync layer keeps the previous value.
    osVersion:  str(row.os_version)
      || [str(row.version), str(row.firmware_version)].find(isCanonicalFortiapVersion)
      || "",
    // A wireless-mesh leaf's uplink is its mesh parent AP, not a switch — an
    // LLDP-visible FortiSwitch on a mesh leaf is a switch bridged BEHIND the
    // AP's LAN port (the inverse direction), so stamping it as peerSwitch
    // would invert the topology. The bridged switch is still represented via
    // the AP's persisted lldpNeighbors (the Device Map's wireless-bridge edge
    // and the dependency tree's bridge-leaf detection consume those).
    ...(lldpExt.meshUplink !== "mesh" && lldpExt.lldpUplinkSwitch && lldpExt.lldpUplinkPort
      ? { peerSwitch: lldpExt.lldpUplinkSwitch, peerPort: lldpExt.lldpUplinkPort, peerSource: "lldp" as const }
      : {}),
    ...(lldpExt.meshUplink ? { meshUplink: lldpExt.meshUplink } : {}),
    ...(lldpExt.parentApSerial ? { parentApSerial: lldpExt.parentApSerial } : {}),
    ...(apUplinkInterface ? { apUplinkInterface } : {}),
    ...(lldpNeighbors ? { lldpNeighbors } : {}),
    ...(radios ? { radios } : {}),
    ...(tel.cpuPct !== undefined ? { cpuPct: tel.cpuPct } : {}),
    ...(tel.memFreeMb !== undefined ? { memFreeMb: tel.memFreeMb } : {}),
    ...(tel.memTotalMb !== undefined ? { memTotalMb: tel.memTotalMb } : {}),
    ...(tel.sensorTemperatures ? { sensorTemperatures: tel.sensorTemperatures } : {}),
  };
}


// ─── Radios + VAPs (the two levels above a wireless station) ────────────────

/** One broadcast SSID on one radio, off the managed_ap row's `vaps` array. */
export interface ApVapSample {
  /** The VAP object's name — identity. Falls back to the SSID when a row
   *  publishes only that; a VAP with neither is dropped, since there would be
   *  nothing stable to key it on. */
  vapName:     string;
  ssid:        string | null;
  /** The join key down to AssetWirelessStation.bssid. */
  bssid:       string | null;
  vlanId:      number | null;
  clientCount: number | null;
}

/** One radio off the managed_ap row's `radio` array. */
export interface ApRadioSample {
  radioIndex:    number;
  radioType:     string | null;
  band:          string | null;
  mode:          string | null;
  channel:       number | null;
  bandwidthMhz:  number | null;
  txPowerPct:    number | null;
  txPowerDbm:    number | null;
  txPowerMinDbm: number | null;
  txPowerMaxDbm: number | null;
  txPowerMode:   string | null;
  baseBssid:     string | null;
  clientCount:   number | null;
  countryCode:   string | null;
  /** The SSIDs this radio is broadcasting. `undefined` means the row carried
   *  no VAP list at all (unknown — the persist layer must leave stored rows
   *  alone); `[]` means the radio was scraped and is broadcasting nothing. */
  vaps?:         ApVapSample[];
}

/** First non-empty string among several spellings of one field. */
function pickStr(row: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = str(row[k]).trim();
    if (v) return v;
  }
  return "";
}

/** First finite number among several spellings of one field. */
function pickNum(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const n = num(row[k]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/**
 * Channel width in MHz. FortiOS spells this several ways and sometimes as a
 * label ("80MHz", "HT40", "20") rather than a number.
 *
 * The trap this exists to avoid: `bandwidth_rx` / `bandwidth_tx` on the same
 * radio object are THROUGHPUT counters, not channel width. Reading them here
 * would put a byte count in a MHz column and make every radio look like it
 * was running an impossible width — so only width-named keys are consulted,
 * and a value that doesn't reduce to one of the real 802.11 widths is dropped
 * rather than stored.
 */
const CHANNEL_WIDTHS_MHZ = new Set([20, 40, 80, 160, 320]);
function parseChannelWidthMhz(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const direct = num(raw);
  if (direct !== undefined) return CHANNEL_WIDTHS_MHZ.has(direct) ? direct : undefined;
  const s = String(raw).trim().toLowerCase();
  if (!s) return undefined;
  // "80mhz" / "ht40" / "vht80" / "40 mhz" all reduce to their digits.
  const m = /(\d{2,3})/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  return CHANNEL_WIDTHS_MHZ.has(n) ? n : undefined;
}

/** Normalize a source-declared band label onto the three stored values. */
function normalizeRadioBandLabel(raw: string): "2.4GHz" | "5GHz" | "6GHz" | null {
  const s = raw.toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  if (s.includes("2.4") || s === "2g") return "2.4GHz";
  if (s.includes("6g") || s.includes("6e")) return "6GHz";
  if (s.includes("5g") || s.startsWith("5")) return "5GHz";
  return null;
}

/** Parse one entry of a radio's `vaps` array. */
function parseApVap(raw: unknown): ApVapSample | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const ssid    = pickStr(v, ["ssid", "SSID"]);
  const vapName = pickStr(v, ["vap_name", "vap-name", "name", "vap"]) || ssid;
  if (!vapName) return null;
  return {
    vapName,
    ssid:        ssid || null,
    bssid:       pickStr(v, ["bssid", "base_bssid", "mac"]).toUpperCase() || null,
    vlanId:      pickNum(v, ["vlan_id", "vlan-id", "vlanid", "vlan"]) ?? null,
    clientCount: pickNum(v, ["client_count", "num_clients", "sta_count", "clients"]) ?? null,
  };
}

/**
 * Parse the managed_ap row's `radio` array into one sample per radio, each
 * carrying the SSIDs it broadcasts.
 *
 * Returns `undefined` when the row has no radio array at all — the field is
 * absent on firmware that doesn't publish it and on a row fetched with a
 * `format=` filter that didn't ask for it, and both mean "unknown", not "this
 * AP has no radios". The persist layer leaves stored rows alone on undefined
 * and full-replaces on an array, the same contract the LLDP and station
 * tables already use.
 *
 * Field names vary across FortiOS releases (hyphen vs underscore, `oper_chan`
 * vs `channel`), so every read goes through the multi-spelling pickers above
 * — the same defensive shape as the IP and MAC pickers at the top of this
 * file, for the same reason.
 */
export function parseFortiapRadios(row: Record<string, unknown>): ApRadioSample[] | undefined {
  const raw = row.radio ?? row.radios ?? row["radio-list"];
  if (!Array.isArray(raw)) return undefined;

  const out: ApRadioSample[] = [];
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") return;
    const r = entry as Record<string, unknown>;
    // radio-id is 1-based on FortiOS. Fall back to the array position when a
    // row omits it entirely, so a radio is never dropped just for being
    // unlabelled — but keep the source's own numbering wherever it exists,
    // since that is what the station rows' radioId joins against.
    const radioIndex = pickNum(r, ["radio-id", "radio_id", "radioId", "index"]) ?? i + 1;
    if (!Number.isInteger(radioIndex)) return;

    const radioType = pickStr(r, ["radio-type", "radio_type", "type", "wireless_mode", "wireless-mode"]);
    const channel   = pickNum(r, ["oper_chan", "oper-chan", "operating_channel", "channel"]);
    const declaredBand = pickStr(r, ["band", "freq_band", "frequency_band"]);

    const vapsRaw = r.vaps ?? r.vap ?? r["vap-list"];
    const vaps = Array.isArray(vapsRaw)
      ? vapsRaw.map(parseApVap).filter((v): v is ApVapSample => v !== null)
      : undefined;

    out.push({
      radioIndex,
      radioType: radioType || null,
      // The source's own band label wins; otherwise derive it from type +
      // channel exactly as the station collector already does, so a radio and
      // the stations on it can never disagree about which band they are on.
      band: normalizeRadioBandLabel(declaredBand) ?? deriveRadioBand(radioType, channel ?? null),
      mode: pickStr(r, ["mode", "oper_mode", "radio_mode"]) || null,
      channel: channel ?? null,
      bandwidthMhz: parseChannelWidthMhz(
        r.oper_chan_bw ?? r["oper-chan-bw"] ?? r.chan_bw ?? r["chan-bw"]
          ?? r.channel_bw ?? r["channel-bw"] ?? r.bandwidth_mhz ?? r.channel_bonding ?? r["channel-bonding"],
      ) ?? null,
      // `oper_txpower` is a PERCENTAGE of the radio's ceiling on FortiOS, not
      // dBm. The dBm reading and the floor/ceiling come from the MIB instead,
      // which is why they stay null here rather than being back-computed from
      // a percentage against a maximum Polaris does not know.
      txPowerPct: pickNum(r, ["oper_txpower", "oper-txpower", "txpower", "power_level", "power-level"]) ?? null,
      txPowerDbm: pickNum(r, ["oper_txpower_dbm", "txpower_dbm", "tx_power_dbm"]) ?? null,
      txPowerMinDbm: null,
      txPowerMaxDbm: null,
      txPowerMode: pickStr(r, ["txpower_mode", "txpower-mode", "power_mode", "auto_power_level"]) || null,
      baseBssid: pickStr(r, ["base_bssid", "base-bssid", "bssid"]).toUpperCase() || null,
      clientCount: pickNum(r, ["client_count", "num_clients", "sta_count", "clients"]) ?? null,
      countryCode: pickStr(r, ["country_code", "country-code", "country"]) || null,
      ...(vaps !== undefined ? { vaps } : {}),
    });
  });
  return out;
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
  // Radios + the SSIDs each one broadcasts (nested `vaps`). The one field
  // here that materially grows the response, which is why it is worth being
  // explicit: it is a per-AP array of a handful of objects, on a call already
  // made once per controller.
  "radio",
].join("|");
