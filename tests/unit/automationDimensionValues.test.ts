/**
 * tests/unit/automationDimensionValues.test.ts — the automation builder's
 * dimension-value picker.
 *
 * Two halves, both pure:
 *  - `foldValuePairs` (notificationDimensionService) turns the Postgres-side
 *    GROUP BY (value, assetId) rows into per-value DEVICE counts. Counting rows
 *    instead of distinct assets would report "temperature (12431)".
 *  - the client's option/note builders (public/js/automations-wizard.js, off
 *    window.PolarisAutomationDimensions). The load-bearing cases: a stored
 *    filter value the scoped devices don't currently report must stay selected
 *    (otherwise opening an old automation quietly widens it to "any"), and an
 *    empty result has to say so — that message is the whole reason the picker
 *    replaced a free-text box.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { foldValuePairs } from "../../src/services/notificationDimensionService.js";

interface DimResult {
  values: { value: string; assetCount: number }[];
  noun: string;
  narrowLabel?: string;
  scopedAssets: number;
  sampledAssets: number;
  assetsWithData: number;
  windowHours: number;
  loading?: boolean;
  error?: boolean;
}

let optionsHtml: (res: DimResult | null, current: string) => string;
let datalistHtml: (res: DimResult | null) => string;
let note: (res: DimResult | null | { loading: true } | { error: true }) => { text: string; warn: boolean };
let narrow: (dim: string, df: Record<string, string> | null) => Record<string, string>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(resolve(here, "../../public/js/automations-wizard.js"), "utf8");
  const sandbox: Record<string, any> = {
    window: {},
    document: { addEventListener() {}, getElementById: () => null },
    escapeHtml: (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    api: {},
    permAtLeast: () => true,
    showToast: () => {},
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  ({ optionsHtml, datalistHtml, note, narrow } = sandbox.window.PolarisAutomationDimensions);
});

const result = (over: Partial<DimResult> = {}): DimResult => ({
  values: [{ value: "temperature", assetCount: 8 }, { value: "fan", assetCount: 6 }],
  noun: "hardware sensors",
  narrowLabel: "",
  scopedAssets: 8,
  sampledAssets: 8,
  assetsWithData: 8,
  windowHours: 3,
  ...over,
});

describe("foldValuePairs", () => {
  it("counts DISTINCT devices per value, not sample rows", () => {
    const { values, assetsWithData } = foldValuePairs([
      { value: "temperature", assetId: "a" },
      { value: "temperature", assetId: "b" },
      { value: "temperature", assetId: "a" }, // same device again
      { value: "fan", assetId: "a" },
    ]);
    expect(values).toEqual([
      { value: "temperature", assetCount: 2 },
      { value: "fan", assetCount: 1 },
    ]);
    expect(assetsWithData).toBe(2);
  });

  it("drops null/empty values and reports no devices when nothing is reported", () => {
    const { values, assetsWithData } = foldValuePairs([
      { value: null, assetId: "a" },
      { value: "", assetId: "b" },
    ]);
    expect(values).toEqual([]);
    expect(assetsWithData).toBe(0);
  });

  it("orders by device count then alphabetically, so ties are stable", () => {
    const { values } = foldValuePairs([
      { value: "voltage", assetId: "a" },
      { value: "fan", assetId: "a" },
      { value: "power", assetId: "a" },
      { value: "temperature", assetId: "a" },
      { value: "temperature", assetId: "b" },
    ]);
    expect(values.map((v) => v.value)).toEqual(["temperature", "fan", "power", "voltage"]);
  });
});

describe("dimension picker options", () => {
  it("offers (any) plus each reported value with its device count", () => {
    const html = optionsHtml(result(), "");
    expect(html).toContain('<option value="">(any)</option>');
    expect(html).toContain('<option value="temperature">temperature (8)</option>');
    expect(html).toContain('<option value="fan">fan (6)</option>');
  });

  it("marks the current value selected", () => {
    expect(optionsHtml(result(), "fan")).toContain('<option value="fan" selected>');
  });

  it("KEEPS a stored value the devices no longer report, flagged", () => {
    const html = optionsHtml(result(), "disk");
    expect(html).toContain('<option value="disk" selected>disk — not currently reported</option>');
  });

  it("renders just (any) before the values have loaded", () => {
    expect(optionsHtml(null, "")).toBe('<option value="">(any)</option>');
  });

  it("still preserves the stored value with no data loaded", () => {
    expect(optionsHtml(null, "temperature")).toContain('value="temperature" selected');
  });

  it("builds datalist suggestions for substring dimensions", () => {
    expect(datalistHtml(result({ values: [{ value: "port1", assetCount: 3 }] })))
      .toBe('<option value="port1"></option>');
    expect(datalistHtml(null)).toBe("");
  });
});

describe("dimension picker note", () => {
  it("warns — and says the condition can never match — when the devices report none", () => {
    const n = note(result({ values: [], assetsWithData: 0 }));
    expect(n.warn).toBe(true);
    expect(n.text).toContain("None of the 8 selected device(s)");
    expect(n.text).toContain("hardware sensors");
    expect(n.text).toContain("never match");
  });

  it("warns when the device filter itself matches nothing", () => {
    const n = note(result({ values: [], scopedAssets: 0, sampledAssets: 0, assetsWithData: 0 }));
    expect(n.warn).toBe(true);
    expect(n.text).toContain("No devices match the filter");
  });

  it("stays quiet when every sampled device reports the dimension", () => {
    expect(note(result())).toEqual({ text: "", warn: false });
  });

  it("says how many devices report it when only some do", () => {
    const n = note(result({ scopedAssets: 48, sampledAssets: 48, assetsWithData: 8 }));
    expect(n.warn).toBe(false);
    expect(n.text).toContain("Reported by 8 of 48 device(s)");
  });

  it("discloses a capped sample", () => {
    const n = note(result({ scopedAssets: 2000, sampledAssets: 250, assetsWithData: 250 }));
    expect(n.text).toContain("Sampled 250 of 2000 selected devices");
  });

  it("shows a checking hint while loading and nothing on error", () => {
    expect(note({ loading: true }).text).toContain("Checking");
    expect(note({ error: true })).toEqual({ text: "", warn: false });
  });

  it("says WHICH slice was empty when the list was narrowed by a sibling", () => {
    // Without the narrow label this reads as "this device has no sensors at
    // all", when it only has no sensors of the class the operator picked.
    const n = note(result({ values: [], assetsWithData: 0, noun: "hardware sensors", narrowLabel: " of class fan" }));
    expect(n.text).toContain("hardware sensors of class fan");
  });
});

describe("sibling narrowing", () => {
  it("narrows sensor NAMES by the class already chosen on the row", () => {
    expect(narrow("sensorNamePattern", { sensorClass: "temperature" })).toEqual({ sensorClass: "temperature" });
  });

  it("narrows SD-WAN members by the chosen health check", () => {
    expect(narrow("link", { healthCheck: "Internet" })).toEqual({ healthCheck: "Internet" });
  });

  it("does not narrow when the sibling is unset, or for independent dimensions", () => {
    expect(narrow("sensorNamePattern", {})).toEqual({});
    expect(narrow("sensorNamePattern", null)).toEqual({});
    expect(narrow("sensorClass", { sensorNamePattern: "CPU" })).toEqual({});
    expect(narrow("ifNamePattern", { sensorClass: "temperature" })).toEqual({});
  });
});
