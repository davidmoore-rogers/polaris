/**
 * tests/unit/fortiapRadioSnmp.test.ts
 *
 * The pure decoders behind the SNMP half of the FortiAP radio tree
 * (FORTINET-FORTIAP-MIB fapRadioTable + fapVapTable).
 *
 * The theme in every case here is the same: an SNMP enum that the module does
 * not define a member for must decode to NULL, never to a plausible default.
 * A radio shown on the wrong band or at a width it isn't running reads exactly
 * as confidently as a correct one, and this MIB predates Wi-Fi 6E/7 — so
 * out-of-enum values are the expected case on new hardware, not a corner one.
 */

import { describe, it, expect } from "vitest";
import {
  FAP_RADIO_OID,
  FAP_VAP_OID,
  decodeRadioMode,
  decodeChannelWidth,
  decodeRadioType,
  parseStationInfoCount,
  parseVapSuffix,
} from "../../src/utils/fortiapRadioSnmp.js";

describe("column OIDs", () => {
  // The two columns the station collector already used since before this
  // feature — if these ever disagree, the transcription is wrong.
  it("agrees with the columns already in use for band derivation", () => {
    expect(FAP_RADIO_OID.type).toBe("1.3.6.1.4.1.12356.120.4.1.1.6");
    expect(FAP_RADIO_OID.channelOper).toBe("1.3.6.1.4.1.12356.120.4.1.1.14");
  });

  it("hangs the VAP table off its own subtree, not the radio table's", () => {
    expect(FAP_VAP_OID.ssid).toBe("1.3.6.1.4.1.12356.120.7.1.1.4");
    expect(FAP_VAP_OID.bssid).toBe("1.3.6.1.4.1.12356.120.7.1.1.3");
    expect(FAP_VAP_OID.vlanId).toBe("1.3.6.1.4.1.12356.120.7.1.1.18");
  });
});

describe("decodeRadioMode", () => {
  it("decodes every member of the enum", () => {
    expect(decodeRadioMode(0)).toBe("ap");
    expect(decodeRadioMode(1)).toBe("disabled");
    expect(decodeRadioMode(2)).toBe("monitor");
    expect(decodeRadioMode(3)).toBe("sniffer");
    expect(decodeRadioMode(4)).toBe("failed");
  });

  it("accepts the string form net-snmp sometimes hands back", () => {
    expect(decodeRadioMode("2")).toBe("monitor");
  });

  it("returns null for a value the module does not define", () => {
    expect(decodeRadioMode(9)).toBeNull();
    expect(decodeRadioMode(null)).toBeNull();
    expect(decodeRadioMode("")).toBeNull();
  });
});

describe("decodeChannelWidth", () => {
  it("decodes the three widths the module names", () => {
    expect(decodeChannelWidth(0)).toBe(20);
    expect(decodeChannelWidth(1)).toBe(40);
    expect(decodeChannelWidth(2)).toBe(80);
  });

  // The enum stops at 80 MHz. A 160 MHz radio reports something outside it,
  // and guessing would put a wrong width on a radio the controller could have
  // told us about correctly.
  it("returns null above the enum rather than guessing a wider channel", () => {
    expect(decodeChannelWidth(3)).toBeNull();
    expect(decodeChannelWidth(4)).toBeNull();
  });
});

describe("decodeRadioType", () => {
  it("names the band outright for the members that carry one", () => {
    expect(decodeRadioType(0)).toEqual({ label: "802.11a", band: "5GHz" });
    expect(decodeRadioType(1)).toEqual({ label: "802.11b", band: "2.4GHz" });
    expect(decodeRadioType(2)).toEqual({ label: "802.11g only", band: "2.4GHz" });
    expect(decodeRadioType(3)).toEqual({ label: "802.11ac 2.4GHz", band: "2.4GHz" });
    expect(decodeRadioType(4)).toEqual({ label: "802.11ac", band: "5GHz" });
    expect(decodeRadioType(5)).toEqual({ label: "802.11n 2.4GHz", band: "2.4GHz" });
    expect(decodeRadioType(6)).toEqual({ label: "802.11n 5GHz", band: "5GHz" });
  });

  // Plain "n" runs on either band, so it names the PHY and leaves the band to
  // the channel-based derivation rather than picking one.
  it("gives no band for plain 802.11n", () => {
    expect(decodeRadioType(7)).toEqual({ label: "802.11n", band: null });
  });

  // No 6 GHz member exists in this module at all — a 6E radio is out-of-enum.
  it("gives neither label nor band outside the enum", () => {
    expect(decodeRadioType(11)).toEqual({ label: null, band: null });
    expect(decodeRadioType(undefined)).toEqual({ label: null, band: null });
  });
});

describe("parseStationInfoCount", () => {
  // fapRadioStationInfo is "connected/allowed"; only the connected half is a
  // reading, and the allowed half is a profile setting.
  it("takes the connected count from the x/y form", () => {
    expect(parseStationInfoCount("3/64")).toBe(3);
    expect(parseStationInfoCount(" 0 / 64 ")).toBe(0);
    expect(parseStationInfoCount("128/128")).toBe(128);
  });

  it("returns null for anything that is not two integers", () => {
    expect(parseStationInfoCount("3")).toBeNull();
    expect(parseStationInfoCount("n/a")).toBeNull();
    expect(parseStationInfoCount("3/")).toBeNull();
    expect(parseStationInfoCount("")).toBeNull();
    expect(parseStationInfoCount(null)).toBeNull();
  });
});

describe("parseVapSuffix", () => {
  // INDEX = { fapVapRadioId, fapVapWlanId }, so a row suffix is exactly two
  // parts. Anything else is a shape Polaris does not recognize.
  it("splits the two index columns", () => {
    expect(parseVapSuffix("1.0")).toEqual({ radioIndex: 1, wlanId: 0 });
    expect(parseVapSuffix("2.15")).toEqual({ radioIndex: 2, wlanId: 15 });
  });

  it("rejects a suffix that is not two integers", () => {
    expect(parseVapSuffix("1")).toBeNull();
    expect(parseVapSuffix("1.0.6")).toBeNull();
    expect(parseVapSuffix("a.b")).toBeNull();
  });
});
