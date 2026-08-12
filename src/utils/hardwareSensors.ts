/**
 * src/utils/hardwareSensors.ts
 *
 * Classification helpers for the Hardware Sensors stream. A FortiGate's
 * fgHwSensorTable (and most vendors' sensor tables) mix temperature, fan,
 * voltage, power/PSU, and disk-temp rows with NO type column over SNMP — so we
 * infer the class (and its display unit) from the sensor name. FortiOS REST
 * sensor-info DOES carry a `type` field; when present it takes precedence over
 * the name heuristic.
 *
 * Best-effort by design: an unrecognized sensor falls to `other` with no unit
 * rather than being dropped, so the operator still sees the raw reading +
 * alarm status. Kept dependency-free so it unit-tests without a Prisma/SNMP
 * client in scope.
 */

export type HardwareSensorClass =
  | "temperature"
  | "fan"
  | "voltage"
  | "power"
  | "disk"
  | "other";

export interface ClassifiedSensor {
  sensorClass: HardwareSensorClass;
  /** Display unit for the reading, or null when the class has no natural unit. */
  unit: string | null;
}

/**
 * Canonical display unit per sensor class. Single source of truth shared by
 * the classifier below and the automation-builder schema (`sensorClassUnits`),
 * so the wizard's unit hint can never drift from what the samples store.
 * `power` and `other` have no natural unit (PSU rows are status-style values).
 */
export const SENSOR_CLASS_UNITS: Record<HardwareSensorClass, string | null> = {
  temperature: "°C",
  fan:         "RPM",
  voltage:     "V",
  power:       null,
  disk:        "°C",
  other:       null,
};

function cls(sensorClass: HardwareSensorClass): ClassifiedSensor {
  return { sensorClass, unit: SENSOR_CLASS_UNITS[sensorClass] };
}

/**
 * Classify one sensor. `restType` is the FortiOS REST `type` field when the
 * source is sensor-info (authoritative); omit it for SNMP rows so the name
 * heuristic decides.
 */
export function classifyHardwareSensor(
  name: string,
  restType?: string | null,
): ClassifiedSensor {
  const t = (restType ?? "").trim().toLowerCase();
  if (t) {
    if (t.includes("temp"))                       return cls("temperature");
    if (t.includes("fan"))                        return cls("fan");
    if (t.includes("volt"))                       return cls("voltage");
    if (t.includes("power") || t === "psu")       return cls("power");
  }

  const n = (name ?? "").trim().toLowerCase();
  // Order matters: fan/voltage/power names can also contain digits that the
  // temperature pattern would catch, so test the specific classes first.
  if (/\bfan\b|rpm|tach/.test(n))                 return cls("fan");
  if (/\bvol\b|vcc|vdd|vrm|\bvin\b|p\d*v\d/.test(n)) return cls("voltage");
  if (/psu|power|\bpwr\b/.test(n))                return cls("power");
  if (/\bdisk\b|nvme|\bssd\b|\bhdd\b/.test(n))    return cls("disk");
  if (/temp|tmp|dts|adt\d|lm7\d|thermal|cputin|peci|°c/.test(n))
                                                  return cls("temperature");
  // Marvell switch-chip temps on FortiGates surface as mvlgen_* / MV_88E*.
  if (/^mv[_l]/.test(n))                          return cls("temperature");
  return cls("other");
}

/**
 * Normalize a FortiGate fgHwSensorEntAlarmStatus integer (0 = no alarm,
 * 1 = alarm) into the stored alarm string. Returns null when the device
 * didn't report a status.
 */
export function normalizeFgAlarmStatus(raw: number | null | undefined): string | null {
  if (raw == null) return null;
  return raw === 0 ? "ok" : "alarm";
}

/**
 * Normalize a FortiOS REST sensor-info alarm field (boolean / 0|1 / string)
 * into the stored alarm string. Returns null when absent.
 */
/**
 * `AssetHardwareSensorSample.alarmStatus` → the 0/1 an automation compares.
 *
 * The column is written exclusively by the two normalizers here, so its domain
 * is exactly `"ok" | "alarm" | null` — but this reads defensively because it
 * also runs over rows written before those normalizers existed.
 *
 * **null means "no reading", and that is load-bearing.** Only the FortiOS REST
 * `sensor-info` and SNMP `fgHwSensorTable` collectors populate the column; the
 * ENTITY-SENSOR-MIB walk and the FortiAP-controller path leave it NULL because
 * those sources publish no alarm bit. Mapping that absence to 0 would be a
 * positive claim of health: it would clear a live alert, and it would make every
 * non-Fortinet sensor in the fleet look actively verified-healthy when nothing
 * ever checked. The engine drops nulls, so those sensors simply produce no
 * readings for this metric.
 */
export function alarmStatusToFlag(raw: string | null | undefined): 0 | 1 | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  if (s === "ok") return 0;
  if (s === "alarm") return 1;
  // An unrecognized non-empty status is a claim that something is off-nominal,
  // not an absence of data — treat it as the alarm side rather than dropping it.
  return 1;
}

export function normalizeRestAlarmStatus(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "boolean") return raw ? "alarm" : "ok";
  if (typeof raw === "number")  return raw === 0 ? "ok" : "alarm";
  const s = String(raw).trim().toLowerCase();
  if (s === "" ) return null;
  if (s === "0" || s === "false" || s === "ok" || s === "normal" || s === "none") return "ok";
  return "alarm";
}
