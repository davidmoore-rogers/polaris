/**
 * tests/unit/hardwareSensors.test.ts
 *
 * Covers the Hardware Sensors classification + alarm-normalization helpers.
 * The name-heuristic cases are drawn from a real FortiGate-201G fgHwSensorTable
 * walk (the device that motivated the feature): TMP/VOL/FAN/PSU/DISK/MV rows.
 */

import { describe, it, expect } from "vitest";
import {
  alarmStatusToFlag,
  classifyEntitySensor,
  classifyHardwareSensor,
  entityOperStatusToAlarm,
  entityPhysicalClassLabel,
  entityPhysicalIsInventory,
  entityTypeColumnTrusted,
  normalizeFgAlarmStatus,
  normalizeRestAlarmStatus,
  pseOperStatusToAlarm,
  unitsDisplayLooksOptical,
  SENSOR_CLASS_UNITS,
} from "../../src/utils/hardwareSensors.js";

describe("classifyHardwareSensor", () => {
  it("prefers the FortiOS REST type field when present", () => {
    expect(classifyHardwareSensor("anything", "temperature")).toEqual({ sensorClass: "temperature", unit: "°C" });
    expect(classifyHardwareSensor("anything", "fan")).toEqual({ sensorClass: "fan", unit: "RPM" });
    expect(classifyHardwareSensor("anything", "voltage")).toEqual({ sensorClass: "voltage", unit: "V" });
    expect(classifyHardwareSensor("anything", "power")).toEqual({ sensorClass: "power", unit: null });
  });

  it("classifies FortiGate-201G fgHwSensorTable names by heuristic", () => {
    // The exact rows from the SNMP walk that produced no temperatures before.
    expect(classifyHardwareSensor("TMP 1 CPUTIN").sensorClass).toBe("temperature");
    expect(classifyHardwareSensor("TMP 2 PECI").sensorClass).toBe("temperature");
    expect(classifyHardwareSensor("FAN 1 CPU FAN").sensorClass).toBe("fan");
    expect(classifyHardwareSensor("FAN 3 SYS FAN2").sensorClass).toBe("fan");
    expect(classifyHardwareSensor("VOL 1 PVCCIN_CPU").sensorClass).toBe("voltage");
    expect(classifyHardwareSensor("VOL 7 P3V3_STBY_A").sensorClass).toBe("voltage");
    expect(classifyHardwareSensor("PSU [1]").sensorClass).toBe("power");
    expect(classifyHardwareSensor("DISK NVMe1").sensorClass).toBe("disk");
    expect(classifyHardwareSensor("mvlgen_0").sensorClass).toBe("temperature");
    expect(classifyHardwareSensor("MV_88E1782").sensorClass).toBe("temperature");
  });

  it("assigns the right unit per class", () => {
    expect(classifyHardwareSensor("TMP 1 CPUTIN").unit).toBe("°C");
    expect(classifyHardwareSensor("FAN 1 CPU FAN").unit).toBe("RPM");
    expect(classifyHardwareSensor("VOL 1 PVCCIN_CPU").unit).toBe("V");
    expect(classifyHardwareSensor("DISK NVMe1").unit).toBe("°C");
  });

  it("falls back to 'other' with no unit for unrecognized names", () => {
    expect(classifyHardwareSensor("WIDGET 7")).toEqual({ sensorClass: "other", unit: null });
    expect(classifyHardwareSensor("")).toEqual({ sensorClass: "other", unit: null });
  });

  it("always returns the unit from SENSOR_CLASS_UNITS (the map the automation builder renders)", () => {
    // The wizard's per-class unit hint (schema sensorClassUnits) and the
    // classifier must never drift apart — every classified sensor's unit is
    // exactly the map entry for its class.
    const names = ["TMP 1 CPUTIN", "FAN 1 CPU FAN", "VOL 1 PVCCIN_CPU", "PSU [1]", "DISK NVMe1", "WIDGET 7"];
    for (const n of names) {
      const c = classifyHardwareSensor(n);
      expect(c.unit).toBe(SENSOR_CLASS_UNITS[c.sensorClass]);
    }
  });

  it("matches standard temperature-sensor names (ENTITY-MIB style)", () => {
    expect(classifyHardwareSensor("DTS CPU0").sensorClass).toBe("temperature");
    expect(classifyHardwareSensor("LM75 Board").sensorClass).toBe("temperature");
    expect(classifyHardwareSensor("Chassis Thermal").sensorClass).toBe("temperature");
  });

  it("classifies transceiver names ahead of the generic power test", () => {
    // "RX Power" / "Tx Power" both contain "power"; if the generic test ran
    // first they'd land in `power` (unit null) and the dBm reading would be
    // stored unlabelled.
    expect(classifyHardwareSensor("SFP1 RX Power")).toEqual({ sensorClass: "optical", unit: "dBm" });
    expect(classifyHardwareSensor("Tx Power port5")).toEqual({ sensorClass: "optical", unit: "dBm" });
    expect(classifyHardwareSensor("Optical Power").sensorClass).toBe("optical");
    expect(classifyHardwareSensor("SFP Bias Current")).toEqual({ sensorClass: "current", unit: "A" });
    // Still a PSU, not an optic.
    expect(classifyHardwareSensor("PSU [1]").sensorClass).toBe("power");
  });

  it("recognises spelled-out 'voltage', which previously fell through to other", () => {
    expect(classifyHardwareSensor("SFP1 Voltage")).toEqual({ sensorClass: "voltage", unit: "V" });
  });
});

describe("entityTypeColumnTrusted", () => {
  it("distrusts a table where every row reports the same type", () => {
    // FortiSwitchOS stamps celsius(8) on optical, fan and voltage rows alike.
    expect(entityTypeColumnTrusted([8, 8, 8, 8])).toBe(false);
  });

  it("trusts a table reporting more than one type", () => {
    expect(entityTypeColumnTrusted([8, 4, 10])).toBe(true);
  });

  it("trusts a single-row table — there is nothing to be uniform with", () => {
    expect(entityTypeColumnTrusted([8])).toBe(true);
    expect(entityTypeColumnTrusted([])).toBe(true);
  });
});

describe("unitsDisplayLooksOptical", () => {
  it("detects the dBm spellings vendors use", () => {
    expect(unitsDisplayLooksOptical("dBm")).toBe(true);
    expect(unitsDisplayLooksOptical("dbm")).toBe(true);
    expect(unitsDisplayLooksOptical("dBmW")).toBe(true);
  });

  it("does not fire on other units", () => {
    expect(unitsDisplayLooksOptical("celsius")).toBe(false);
    expect(unitsDisplayLooksOptical("mA")).toBe(false);
    expect(unitsDisplayLooksOptical(null)).toBe(false);
  });
});

describe("classifyEntitySensor", () => {
  it("takes unitsDisplay as the strongest signal — the type enum has no dBm", () => {
    // Reported as celsius on an untrusted table AND as watts on a trusted one;
    // the declared unit wins in both cases.
    expect(classifyEntitySensor({
      typeCode: 8, unitsDisplay: "dBm", descr: "SFP1", typeColumnTrusted: false,
    })).toEqual({ sensorClass: "optical", unit: "dBm" });
    expect(classifyEntitySensor({
      typeCode: 6, unitsDisplay: "dBm", descr: "port9 optic", typeColumnTrusted: true,
    }).sensorClass).toBe("optical");
  });

  it("trusts the type code over a misleading name on a compliant device", () => {
    // The name contains "fan", which the name heuristic tests before
    // temperature — a compliant agent's celsius(8) must win.
    expect(classifyEntitySensor({
      typeCode: 8, unitsDisplay: null, descr: "Fan Inlet Temp", typeColumnTrusted: true,
    }).sensorClass).toBe("temperature");
    expect(classifyEntitySensor({
      typeCode: 10, unitsDisplay: null, descr: "Chassis Thermal", typeColumnTrusted: true,
    }).sensorClass).toBe("fan");
  });

  it("classifies by name when the type column is untrustworthy", () => {
    // The FortiSwitch case: everything claims celsius, so the descr decides.
    expect(classifyEntitySensor({
      typeCode: 8, unitsDisplay: null, descr: "SFP1 Voltage", typeColumnTrusted: false,
    }).sensorClass).toBe("voltage");
    expect(classifyEntitySensor({
      typeCode: 8, unitsDisplay: null, descr: "Bias Current port3", typeColumnTrusted: false,
    }).sensorClass).toBe("current");
  });

  // The behaviour-preservation case. A FortiSwitch's rows are named only by
  // bare index, so there is no descr to classify by; falling back to the type
  // code is what has always made them temperature rows, and must keep doing so.
  it("falls back to the type code for an unnamed row on an untrusted device", () => {
    expect(classifyEntitySensor({
      typeCode: 8, unitsDisplay: null, descr: "", typeColumnTrusted: false,
    })).toEqual({ sensorClass: "temperature", unit: "°C" });
  });

  it("degrades to other when nothing identifies the row", () => {
    expect(classifyEntitySensor({
      typeCode: null, unitsDisplay: null, descr: "WIDGET 7", typeColumnTrusted: true,
    })).toEqual({ sensorClass: "other", unit: null });
  });
});

describe("entityOperStatusToAlarm", () => {
  it("maps a broken sensor to an alarm", () => {
    expect(entityOperStatusToAlarm(3)).toBe("alarm"); // nonoperational
  });

  it("maps a readable sensor to ok so a cleared fault can resolve", () => {
    expect(entityOperStatusToAlarm(1)).toBe("ok");
  });

  // The load-bearing one: an empty SFP cage reports unavailable(2). Mapping
  // that to "alarm" would fire on every unused port on the switch.
  it("treats unavailable as no claim, NOT as a fault", () => {
    expect(entityOperStatusToAlarm(2)).toBeNull();
  });

  it("returns null when the device reported no status at all", () => {
    expect(entityOperStatusToAlarm(null)).toBeNull();
    expect(entityOperStatusToAlarm(undefined)).toBeNull();
  });
});

describe("normalizeFgAlarmStatus", () => {
  it("maps the fgHwSensorEntAlarmStatus integer", () => {
    expect(normalizeFgAlarmStatus(0)).toBe("ok");
    expect(normalizeFgAlarmStatus(1)).toBe("alarm");
    expect(normalizeFgAlarmStatus(null)).toBeNull();
    expect(normalizeFgAlarmStatus(undefined)).toBeNull();
  });
});

describe("alarmStatusToFlag", () => {
  it("maps the stored tri-state to the 0/1 an automation compares", () => {
    expect(alarmStatusToFlag("ok")).toBe(0);
    expect(alarmStatusToFlag("alarm")).toBe(1);
    // Case/padding tolerance: the column is written by the normalizers above, but
    // rows predating them are read defensively.
    expect(alarmStatusToFlag(" ALARM ")).toBe(1);
    expect(alarmStatusToFlag("OK")).toBe(0);
  });

  it("returns null — never 0 — when no alarm bit was reported", () => {
    // The ENTITY-SENSOR-MIB walk and the FortiAP-controller path leave the column
    // NULL because those sources publish no alarm bit. Mapping that to 0 would
    // assert health nothing ever checked, clearing live alerts and making every
    // non-Fortinet sensor look verified-healthy.
    expect(alarmStatusToFlag(null)).toBeNull();
    expect(alarmStatusToFlag(undefined)).toBeNull();
    expect(alarmStatusToFlag("")).toBeNull();
    expect(alarmStatusToFlag("   ")).toBeNull();
  });

  it("treats an unrecognized status as the alarm side, not as missing data", () => {
    // A non-empty status Polaris doesn't recognize is still a claim that
    // something is off-nominal; dropping it would go silent on a real fault.
    expect(alarmStatusToFlag("degraded")).toBe(1);
  });

  it("round-trips whatever the two normalizers can produce", () => {
    for (const raw of [0, 1, 7]) {
      expect(alarmStatusToFlag(normalizeFgAlarmStatus(raw))).toBe(raw === 0 ? 0 : 1);
    }
    for (const raw of [true, false, "normal", "critical", "0"]) {
      const expected = normalizeRestAlarmStatus(raw) === "alarm" ? 1 : 0;
      expect(alarmStatusToFlag(normalizeRestAlarmStatus(raw))).toBe(expected);
    }
    // …and an unreportable reading stays unreportable end to end.
    expect(alarmStatusToFlag(normalizeRestAlarmStatus(null))).toBeNull();
  });
});

describe("normalizeRestAlarmStatus", () => {
  it("normalizes boolean / numeric / string alarm fields", () => {
    expect(normalizeRestAlarmStatus(true)).toBe("alarm");
    expect(normalizeRestAlarmStatus(false)).toBe("ok");
    expect(normalizeRestAlarmStatus(0)).toBe("ok");
    expect(normalizeRestAlarmStatus(1)).toBe("alarm");
    expect(normalizeRestAlarmStatus("false")).toBe("ok");
    expect(normalizeRestAlarmStatus("normal")).toBe("ok");
    expect(normalizeRestAlarmStatus("critical")).toBe("alarm");
    expect(normalizeRestAlarmStatus(null)).toBeNull();
    expect(normalizeRestAlarmStatus("")).toBeNull();
  });
});

describe("entityPhysicalClassLabel", () => {
  it("decodes the RFC 4133 PhysicalClass enum", () => {
    expect(entityPhysicalClassLabel(6)).toBe("powerSupply");
    expect(entityPhysicalClassLabel(7)).toBe("fan");
    expect(entityPhysicalClassLabel(9)).toBe("module");
    expect(entityPhysicalClassLabel(3)).toBe("chassis");
  });

  it("degrades unknown codes rather than throwing", () => {
    expect(entityPhysicalClassLabel(99)).toBe("other");
    expect(entityPhysicalClassLabel(null)).toBe("unknown");
  });
});

describe("entityPhysicalIsInventory", () => {
  it("trusts the device's own FRU bit", () => {
    expect(entityPhysicalIsInventory({ entClass: "module", isFru: true })).toBe(true);
    // Even a class we wouldn't otherwise keep, if the device says it's replaceable.
    expect(entityPhysicalIsInventory({ entClass: "backplane", isFru: true })).toBe(true);
  });

  // Plenty of agents leave IsFRU false on modules that plainly are replaceable,
  // so a module carrying a serial or model is kept regardless of the bit.
  it("keeps identifiable modules/PSUs/fans when the FRU bit is unset", () => {
    expect(entityPhysicalIsInventory({ entClass: "module", isFru: false, serialNum: "ABC123" })).toBe(true);
    expect(entityPhysicalIsInventory({ entClass: "powerSupply", isFru: false, modelName: "PSU-500W" })).toBe(true);
    expect(entityPhysicalIsInventory({ entClass: "fan", isFru: false, serialNum: "F1" })).toBe(true);
  });

  // A chassis publishes a row per container, port and sensor — hundreds naming
  // nothing an operator could replace. Those are what this filter exists to drop.
  it("drops scaffolding rows", () => {
    expect(entityPhysicalIsInventory({ entClass: "container", isFru: false })).toBe(false);
    expect(entityPhysicalIsInventory({ entClass: "port", isFru: false, serialNum: "x" })).toBe(false);
    expect(entityPhysicalIsInventory({ entClass: "sensor", isFru: false })).toBe(false);
    // A module with nothing identifying it is scaffolding too.
    expect(entityPhysicalIsInventory({ entClass: "module", isFru: false })).toBe(false);
    expect(entityPhysicalIsInventory({ entClass: "module", isFru: false, serialNum: "  " })).toBe(false);
  });
});

describe("pseOperStatusToAlarm", () => {
  it("maps a failed PSE to an alarm", () => {
    expect(pseOperStatusToAlarm(3)).toBe("alarm"); // faulty
  });

  it("maps a delivering PSE to ok so a cleared fault resolves", () => {
    expect(pseOperStatusToAlarm(1)).toBe("ok");
  });

  // Same discipline as ENTITY-SENSOR's unavailable(2): PoE switched off is a
  // configuration choice, and alarming on it would fire on every switch where
  // an operator has deliberately disabled PoE.
  it("treats an off PSE as no claim, NOT as a fault", () => {
    expect(pseOperStatusToAlarm(2)).toBeNull();
  });

  it("returns null when the device reported no status", () => {
    expect(pseOperStatusToAlarm(null)).toBeNull();
    expect(pseOperStatusToAlarm(undefined)).toBeNull();
  });
});

describe("SENSOR_CLASS_UNITS — poe", () => {
  // Unit-level PoE is watts; `power` is deliberately unit-less because it also
  // carries Fortinet's status-shaped PSU rows, so mixing them would make the
  // wizard's per-class unit hint wrong for both.
  it("gives the poe class watts, leaving power unit-less", () => {
    expect(SENSOR_CLASS_UNITS.poe).toBe("W");
    expect(SENSOR_CLASS_UNITS.power).toBeNull();
  });
});
