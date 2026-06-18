import { describe, it, expect } from "vitest";
import { parseFmgVariableDynamicMapping } from "../../src/services/fortimanagerService.js";

// parseFmgVariableDynamicMapping() turns a single FMG metadata-variable object
// (the `data` from GET /pm/config/adom/<adom>/obj/fmg/variable/<name>) into a
// per-device value map keyed by the LOWERCASED device name found in each
// dynamic_mapping entry's _scope. The top-level ADOM-wide `value` is ignored.
// Pure — no DB, no network.

describe("parseFmgVariableDynamicMapping", () => {
  it("returns empty when dynamic_mapping is absent or not an array", () => {
    expect(parseFmgVariableDynamicMapping(undefined).size).toBe(0);
    expect(parseFmgVariableDynamicMapping({}).size).toBe(0);
    expect(parseFmgVariableDynamicMapping({ value: "36.2" }).size).toBe(0);
    expect(parseFmgVariableDynamicMapping({ dynamic_mapping: null }).size).toBe(0);
  });

  it("maps each device scope name (lowercased) to its value", () => {
    const m = parseFmgVariableDynamicMapping({
      name: "Latitude",
      value: "36.20053",
      dynamic_mapping: [
        { _scope: [{ name: "ARCHMAT-101F-1", vdom: "global" }], value: "39.08547", oid: 110117 },
        { _scope: [{ name: "FLOWERMOUND-61F-1", vdom: "global" }], value: "33.0146", oid: 110200 },
      ],
    });
    expect(m.get("archmat-101f-1")).toBe("39.08547");
    expect(m.get("flowermound-61f-1")).toBe("33.0146");
    expect(m.size).toBe(2);
  });

  it("does NOT apply the top-level ADOM-wide default value to any device", () => {
    const m = parseFmgVariableDynamicMapping({ value: "36.20053", dynamic_mapping: [] });
    expect(m.size).toBe(0);
  });

  it("skips entries with empty / non-string values", () => {
    const m = parseFmgVariableDynamicMapping({
      dynamic_mapping: [
        { _scope: [{ name: "A", vdom: "global" }], value: "" },
        { _scope: [{ name: "B", vdom: "global" }], value: 42 },
        { _scope: [{ name: "C", vdom: "global" }], value: "1.23" },
      ],
    });
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(false);
    expect(m.get("c")).toBe("1.23");
  });

  it("handles an entry whose _scope lists multiple devices", () => {
    const m = parseFmgVariableDynamicMapping({
      dynamic_mapping: [
        { _scope: [{ name: "FW-1", vdom: "global" }, { name: "FW-2", vdom: "global" }], value: "5.5" },
      ],
    });
    expect(m.get("fw-1")).toBe("5.5");
    expect(m.get("fw-2")).toBe("5.5");
  });

  it("tolerates malformed _scope shapes without throwing", () => {
    const m = parseFmgVariableDynamicMapping({
      dynamic_mapping: [
        { _scope: null, value: "1" },
        { _scope: [{ vdom: "global" }], value: "2" },
        { value: "3" },
        { _scope: [{ name: "OK", vdom: "global" }], value: "4" },
      ],
    });
    expect(m.size).toBe(1);
    expect(m.get("ok")).toBe("4");
  });
});
