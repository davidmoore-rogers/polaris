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
    if (t.includes("temp"))                       return { sensorClass: "temperature", unit: "°C" };
    if (t.includes("fan"))                        return { sensorClass: "fan",         unit: "RPM" };
    if (t.includes("volt"))                       return { sensorClass: "voltage",     unit: "V" };
    if (t.includes("power") || t === "psu")       return { sensorClass: "power",       unit: null };
  }

  const n = (name ?? "").trim().toLowerCase();
  // Order matters: fan/voltage/power names can also contain digits that the
  // temperature pattern would catch, so test the specific classes first.
  if (/\bfan\b|rpm|tach/.test(n))                 return { sensorClass: "fan",     unit: "RPM" };
  if (/\bvol\b|vcc|vdd|vrm|\bvin\b|p\d*v\d/.test(n)) return { sensorClass: "voltage", unit: "V" };
  if (/psu|power|\bpwr\b/.test(n))                return { sensorClass: "power",   unit: null };
  if (/\bdisk\b|nvme|\bssd\b|\bhdd\b/.test(n))    return { sensorClass: "disk",    unit: "°C" };
  if (/temp|tmp|dts|adt\d|lm7\d|thermal|cputin|peci|°c/.test(n))
                                                  return { sensorClass: "temperature", unit: "°C" };
  // Marvell switch-chip temps on FortiGates surface as mvlgen_* / MV_88E*.
  if (/^mv[_l]/.test(n))                          return { sensorClass: "temperature", unit: "°C" };
  return { sensorClass: "other", unit: null };
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
export function normalizeRestAlarmStatus(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "boolean") return raw ? "alarm" : "ok";
  if (typeof raw === "number")  return raw === 0 ? "ok" : "alarm";
  const s = String(raw).trim().toLowerCase();
  if (s === "" ) return null;
  if (s === "0" || s === "false" || s === "ok" || s === "normal" || s === "none") return "ok";
  return "alarm";
}
