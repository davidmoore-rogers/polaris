/**
 * tests/unit/fortiapRadios.test.ts
 *
 * parseFortiapRadios — the REST half of the FortiAP radio → SSID → station
 * tree, read off the `radio[]` array of one /api/v2/monitor/wifi/managed_ap
 * row.
 */

import { describe, it, expect } from "vitest";
import { parseFortiapRadios, parseFortiapMonitorRow, FORTIAP_MONITOR_FORMAT } from "../../src/utils/fortiapMonitorRow.js";

describe("parseFortiapRadios presence contract", () => {
  // The whole undefined-vs-empty discipline the persist layer depends on.
  it("returns undefined when the row carries no radio array at all", () => {
    expect(parseFortiapRadios({ name: "AP-1" })).toBeUndefined();
    // A firmware that answers with a non-array is equally "unknown".
    expect(parseFortiapRadios({ radio: null })).toBeUndefined();
    expect(parseFortiapRadios({ radio: "2" })).toBeUndefined();
  });

  it("returns [] for a row that carries an empty radio array", () => {
    expect(parseFortiapRadios({ radio: [] })).toEqual([]);
  });

  it("skips entries that are not objects rather than failing the row", () => {
    const radios = parseFortiapRadios({ radio: [null, "x", { "radio-id": 2 }] });
    expect(radios?.map((r) => r.radioIndex)).toEqual([2]);
  });
});

describe("parseFortiapRadios radio identity", () => {
  it("keeps the source's own radio numbering — it is what stations join on", () => {
    const radios = parseFortiapRadios({ radio: [{ "radio-id": 1 }, { "radio-id": 2 }] });
    expect(radios?.map((r) => r.radioIndex)).toEqual([1, 2]);
  });

  it("accepts the underscore spelling", () => {
    expect(parseFortiapRadios({ radio: [{ radio_id: 3 }] })?.[0].radioIndex).toBe(3);
  });

  it("falls back to 1-based array position when the row omits the id", () => {
    const radios = parseFortiapRadios({ radio: [{ mode: "ap" }, { mode: "ap" }] });
    expect(radios?.map((r) => r.radioIndex)).toEqual([1, 2]);
  });
});

describe("parseFortiapRadios channel width", () => {
  // The trap: bandwidth_rx / bandwidth_tx on the same object are THROUGHPUT
  // counters. Reading them as width would put a byte count in a MHz column.
  it("never reads channel width from the throughput counters", () => {
    const radios = parseFortiapRadios({
      radio: [{ "radio-id": 1, bandwidth_rx: 1048576, bandwidth_tx: 2097152 }],
    });
    expect(radios?.[0].bandwidthMhz).toBeNull();
  });

  it("reads a numeric width", () => {
    expect(parseFortiapRadios({ radio: [{ oper_chan_bw: 80 }] })?.[0].bandwidthMhz).toBe(80);
  });

  it("reads a labelled width", () => {
    expect(parseFortiapRadios({ radio: [{ oper_chan_bw: "80MHz" }] })?.[0].bandwidthMhz).toBe(80);
    expect(parseFortiapRadios({ radio: [{ channel_bonding: "HT40" }] })?.[0].bandwidthMhz).toBe(40);
    expect(parseFortiapRadios({ radio: [{ "chan-bw": "160 MHz" }] })?.[0].bandwidthMhz).toBe(160);
  });

  it("drops a value that is not a real 802.11 width rather than storing it", () => {
    expect(parseFortiapRadios({ radio: [{ oper_chan_bw: 37 }] })?.[0].bandwidthMhz).toBeNull();
  });
});

describe("parseFortiapRadios power", () => {
  // FortiOS reports a PERCENTAGE of the radio's ceiling. Storing it as dBm
  // would be a silent unit error; the dBm reading + floor/ceiling come from
  // the MIB instead.
  it("reads oper_txpower as a percentage, leaving the dBm trio null", () => {
    const r = parseFortiapRadios({ radio: [{ "radio-id": 1, oper_txpower: 70 }] })?.[0];
    expect(r?.txPowerPct).toBe(70);
    expect(r?.txPowerOper).toBeNull();
    expect(r?.txPowerConfig).toBeNull();
    expect(r?.txPowerMax).toBeNull();
  });

  it("carries the power mode as the source words it", () => {
    expect(parseFortiapRadios({ radio: [{ txpower_mode: "auto" }] })?.[0].txPowerMode).toBe("auto");
  });
});

describe("parseFortiapRadios band", () => {
  it("prefers the band the source declares", () => {
    expect(parseFortiapRadios({ radio: [{ band: "5GHz", oper_chan: 6 }] })?.[0].band).toBe("5GHz");
    expect(parseFortiapRadios({ radio: [{ band: "2.4 GHz" }] })?.[0].band).toBe("2.4GHz");
    expect(parseFortiapRadios({ radio: [{ freq_band: "6E" }] })?.[0].band).toBe("6GHz");
  });

  // Same derivation the station collector uses, so a radio and the stations
  // on it can never disagree about which band they are on.
  it("derives the band from type + channel when the source declares none", () => {
    expect(parseFortiapRadios({ radio: [{ oper_chan: 6 }] })?.[0].band).toBe("2.4GHz");
    expect(parseFortiapRadios({ radio: [{ oper_chan: 149 }] })?.[0].band).toBe("5GHz");
    expect(parseFortiapRadios({ radio: [{ "radio-type": "802.11ax-6E", oper_chan: 5 }] })?.[0].band)
      .toBe("6GHz");
  });

  it("leaves the band null when nothing identifies it", () => {
    expect(parseFortiapRadios({ radio: [{ "radio-id": 1 }] })?.[0].band).toBeNull();
  });
});

describe("parseFortiapRadios VAPs", () => {
  it("parses the SSIDs a radio broadcasts", () => {
    const radios = parseFortiapRadios({
      radio: [{
        "radio-id": 1,
        oper_chan: 11,
        vaps: [
          { vap_name: "corp-2g", ssid: "CORP", bssid: "aa:bb:cc:dd:ee:01", vlan_id: 10, client_count: 4 },
          { vap_name: "guest-2g", ssid: "GUEST", bssid: "aa:bb:cc:dd:ee:02" },
        ],
      }],
    });
    expect(radios?.[0].vaps).toEqual([
      { vapName: "corp-2g", ssid: "CORP", bssid: "AA:BB:CC:DD:EE:01", vlanId: 10, clientCount: 4 },
      { vapName: "guest-2g", ssid: "GUEST", bssid: "AA:BB:CC:DD:EE:02", vlanId: null, clientCount: null },
    ]);
  });

  // Identity is the VAP name; several VAPs commonly share one SSID.
  it("falls back to the SSID for the VAP name, and drops a VAP with neither", () => {
    const radios = parseFortiapRadios({ radio: [{ vaps: [{ ssid: "CORP" }, { bssid: "aa:bb:cc:dd:ee:03" }] }] });
    expect(radios?.[0].vaps).toEqual([
      { vapName: "CORP", ssid: "CORP", bssid: null, vlanId: null, clientCount: null },
    ]);
  });

  it("distinguishes 'no VAP list published' from 'broadcasting nothing'", () => {
    // Absent key — the persist layer must leave stored SSIDs alone.
    expect(parseFortiapRadios({ radio: [{ "radio-id": 1 }] })?.[0].vaps).toBeUndefined();
    // Present and empty — the radio was asked and answered "none".
    expect(parseFortiapRadios({ radio: [{ "radio-id": 1, vaps: [] }] })?.[0].vaps).toEqual([]);
  });
});

describe("parseFortiapMonitorRow radio integration", () => {
  it("carries the radios onto the parsed row", () => {
    const parsed = parseFortiapMonitorRow({
      name: "AP-1",
      serial: "FP231FTF20000000",
      radio: [{ "radio-id": 1, oper_chan: 6, oper_txpower: 100, vaps: [{ ssid: "CORP" }] }],
    });
    expect(parsed.radios).toHaveLength(1);
    expect(parsed.radios?.[0].channel).toBe(6);
    expect(parsed.radios?.[0].vaps?.[0].ssid).toBe("CORP");
  });

  it("leaves radios absent on a row that published none", () => {
    expect(parseFortiapMonitorRow({ name: "AP-1" }).radios).toBeUndefined();
  });

  it("asks the controller for the radio array", () => {
    // The field filter is the reason the array arrives at all — a format=
    // string that omits it silently empties the whole feature.
    expect(String(FORTIAP_MONITOR_FORMAT).split("|")).toContain("radio");
  });
});
