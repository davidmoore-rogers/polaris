import { describe, it, expect } from "vitest";
import { fortiswitchModelFromFsSysVersion } from "../../src/utils/fortiswitchModel.js";

describe("fortiswitchModelFromFsSysVersion", () => {
  it("extracts the model token and drops the firmware suffix", () => {
    expect(fortiswitchModelFromFsSysVersion("S548DF-v7.2.5-build0453,230511 (GA)"))
      .toBe("FortiSwitch S548DF");
    expect(fortiswitchModelFromFsSysVersion("S124EN-v6.4.6-build470,210316 (GA)"))
      .toBe("FortiSwitch S124EN");
    expect(fortiswitchModelFromFsSysVersion("S108EF-v7.4.1-build083"))
      .toBe("FortiSwitch S108EF");
  });

  it("prefixes 'FortiSwitch ' so vendor-profile matching keeps working", () => {
    // pickVendorProfile tests /fortiswitch/i against `${manufacturer} ${os} ${model}`
    // and FortiSwitch assets carry no os — the prefix is what keeps the asset in
    // the FortiSwitch profile instead of falling into the FortiGate one.
    const model = fortiswitchModelFromFsSysVersion("S424DN-v7.2.5-build0453,230511 (GA)");
    expect(model).toMatch(/fortiswitch/i);
  });

  it("trims surrounding whitespace", () => {
    expect(fortiswitchModelFromFsSysVersion("  S548DF-v7.2.5-build0453  "))
      .toBe("FortiSwitch S548DF");
  });

  it("returns null when the string has no firmware marker to split on", () => {
    expect(fortiswitchModelFromFsSysVersion("S548DF")).toBeNull();
    expect(fortiswitchModelFromFsSysVersion("unexpected string")).toBeNull();
  });

  it("returns null for firmware-only strings with no model prefix", () => {
    expect(fortiswitchModelFromFsSysVersion("v7.2.5-build0453,230511 (GA)")).toBeNull();
  });

  it("returns null for empty / missing input", () => {
    expect(fortiswitchModelFromFsSysVersion("")).toBeNull();
    expect(fortiswitchModelFromFsSysVersion("   ")).toBeNull();
    expect(fortiswitchModelFromFsSysVersion(null)).toBeNull();
    expect(fortiswitchModelFromFsSysVersion(undefined)).toBeNull();
  });
});
