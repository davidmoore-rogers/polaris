/**
 * tests/unit/fortinetClassHint.test.ts — `fortinetClassHint` + the
 * `assetType`-aware `pickVendorProfile` (src/services/vendorTelemetryProfiles.ts).
 *
 * Vendor profile selection decides WHICH OIDs Polaris reads for CPU, memory,
 * temperature and flash storage. It did that by regex over
 * `manufacturer + os + model`, which made a display string load-bearing for
 * device identity — and a managed FortiSwitch has no `os`, while
 * `MODEL_RULES` in utils/assetProjection.ts deliberately skips the fortiswitch
 * source's own model. An asset that reached "Fortinet" + empty model therefore
 * matched only the generic FortiOS entry and was pointed at `fgSysCpuUsage` /
 * `fgSysMemUsage` under the FortiGate root, which a FortiSwitch doesn't publish.
 *
 * What's pinned, and why each is a decision rather than an implementation
 * detail:
 *
 *  - **An empty model must still resolve to FortiSwitch.** This is the
 *    regression: not a cosmetic blank field but the wrong OIDs, and (before the
 *    `snmpVbToNumber` fix) a confident flat 0% rather than a visible gap.
 *  - **It was a DEADLOCK, not a miss.** The FortiOS profile carries no `model`
 *    query, so `fsSysVersion` was never read, so `adoptDetectedModel` never got
 *    a value, so the empty model could never be filled in. Pinned by asserting
 *    the resolved profile actually carries the `model` query — that is the
 *    escape hatch, and losing it re-closes the trap silently.
 *  - **The model outranks the type when it states a class.** A model is
 *    device- or operator-stated; a type can be misclassified. And the
 *    FortiSwitch entry is ordered ahead of FortiAP, so blindly appending would
 *    let a FortiAP-typed model match FortiSwitch first.
 *  - **Gated on the manufacturer.** `assetType === "switch"` is true of every
 *    Cisco and Aruba switch too; only Fortinet's switches are FortiSwitches.
 *  - **`firewall` gets no hint.** A FortiGate matches the FortiOS entry on the
 *    manufacturer alone — that entry is the fallback that swallowed the others,
 *    so it must keep working untouched.
 */
import { describe, it, expect } from "vitest";
import { fortinetClassHint, pickVendorProfile } from "../../src/services/vendorTelemetryProfiles.js";

describe("fortinetClassHint", () => {
  it("names the class from assetType when the model is empty", () => {
    expect(fortinetClassHint("Fortinet", null, "switch")).toBe("FortiSwitch");
    expect(fortinetClassHint("Fortinet", "", "access_point")).toBe("FortiAP");
  });

  it("yields nothing when the model already states a class", () => {
    expect(fortinetClassHint("Fortinet", "FortiSwitch S548DF", "switch")).toBeNull();
    // Misclassified type + a model that disagrees: the model wins, and the
    // hint must not drag an AP into the FortiSwitch profile (ordered first).
    expect(fortinetClassHint("Fortinet", "FortiAP-231F", "switch")).toBeNull();
  });

  it("yields nothing for a non-Fortinet manufacturer", () => {
    expect(fortinetClassHint("Cisco", null, "switch")).toBeNull();
    expect(fortinetClassHint("HP", null, "access_point")).toBeNull();
    expect(fortinetClassHint(null, null, "switch")).toBeNull();
  });

  it("yields nothing for a firewall or an unhinted type", () => {
    expect(fortinetClassHint("Fortinet", null, "firewall")).toBeNull();
    expect(fortinetClassHint("Fortinet", null, "server")).toBeNull();
    expect(fortinetClassHint("Fortinet", null, null)).toBeNull();
  });
});

describe("pickVendorProfile — Fortinet class routing", () => {
  it("routes a modelless Fortinet switch to FortiSwitch, not FortiOS", () => {
    // The prod case: manufacturer "Fortinet", model empty, assetType "switch".
    const p = pickVendorProfile("Fortinet", null, null, "switch");
    expect(p?.vendor).toMatch(/fortiswitch/i);
    expect(p?.cpu?.symbol).toBe("fsSysCpuUsage");
    expect(p?.memory?.usedBytesSymbol).toBe("fsSysMemUsage");
    expect(p?.memory?.totalBytesSymbol).toBe("fsSysMemCapacity");
  });

  it("hands that switch the fsSysVersion query that breaks the deadlock", () => {
    // Without this the model can never be detected, so the empty model that
    // caused the misroute can never be corrected.
    const p = pickVendorProfile("Fortinet", null, null, "switch");
    expect(p?.model?.symbol).toBe("fsSysVersion");
  });

  it("routes a modelless Fortinet AP to FortiAP", () => {
    const p = pickVendorProfile("Fortinet", null, null, "access_point");
    expect(p?.vendor).toMatch(/fortiap/i);
    expect(p?.cpu?.symbol).toBe("fapCpuUsage");
  });

  it("still routes a Fortinet firewall to the FortiOS profile", () => {
    const p = pickVendorProfile("Fortinet", "FortiOS", null, "firewall");
    expect(p?.cpu?.symbol).toBe("fgSysCpuUsage");
  });

  it("leaves non-Fortinet switches alone", () => {
    expect(pickVendorProfile("Cisco", "Cisco IOS", null, "switch")?.cpu?.symbol)
      .toBe("cpmCPUTotal5secRev");
  });

  it("keeps working with no assetType (every pre-existing caller)", () => {
    expect(pickVendorProfile("Fortinet", null, "FortiSwitch S548DF")?.cpu?.symbol)
      .toBe("fsSysCpuUsage");
    expect(pickVendorProfile("Fortinet", null, null)?.cpu?.symbol)
      .toBe("fgSysCpuUsage"); // unchanged: nothing identifies it as a switch
  });
});
