/**
 * tests/unit/automationSentences.test.ts — the automation wizard's sentence
 * builder, the live English rendering of a draft rule's trigger + reset that
 * operators read on steps 3/4/6. Extracted from openAutomationWizard as a
 * pure factory over the /automations/schema payload (2026-08); evaluated here
 * in a Node vm with a stub window — same idiom as appmapFilter.test.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

interface Ladder { severity?: string; severityBands?: Array<Record<string, unknown>> | null }

let make: (s: Record<string, unknown>) => {
  triggerSentence: (tr: Record<string, unknown> | null, opts?: Ladder) => string;
  resetSentence: (reset: Record<string, unknown> | null, tr: Record<string, unknown> | null, cooldownSec?: number) => string;
  humanDuration: (sec: number) => string;
  leafUnit: (metric: string, df?: Record<string, string>) => string;
  isTriggerScoped: (tr: Record<string, unknown> | null) => boolean;
};

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/automations-wizard.js");
  const code = readFileSync(file, "utf8");
  const sandbox: Record<string, any> = {
    window: {},
    document: { addEventListener() {}, getElementById: () => null },
    // Globals the wizard file references at call time; the sentence factory
    // itself needs only escapeHtml.
    escapeHtml: (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    api: {},
    permAtLeast: () => true,
    showToast: () => {},
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  make = sandbox.window.PolarisAutomationSentences.make;
});

// Minimal schema slice — the factory falls back to built-in phrase tables for
// everything the schema doesn't supply, which is also worth pinning.
const SCHEMA = {
  triggerTypes: [
    { type: "asset_metric", label: "Device metric", scoped: true },
    { type: "host_metric", label: "Host metric", scoped: false },
    { type: "asset_state", label: "Device state", scoped: true },
    { type: "event", label: "Audit event match", scoped: false },
    { type: "change", label: "Change detection", scoped: false },
    { type: "composite", label: "Multiple conditions", scoped: true },
  ],
  metricMeta: {
    cpuPct: { label: "CPU usage", unit: "%" },
    hwSensorValue: { label: "Hardware sensor", unit: "(sensor unit)" },
  },
  sensorClassUnits: { temperature: "°C", fan: "RPM" },
  fieldMeta: { monitorStatus: { label: "Monitor status" } },
  changeTypeMeta: { new_asset: "a new device" },
};

describe("makeAutomationSentences", () => {
  it("renders a metric trigger with aggregation window, unit, dimension filter, and sustain", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence({
      type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90,
      aggregation: "avg", windowSec: 300,
      dimensionFilter: { ifNamePattern: "wan" },
      forDurationSec: 120,
    });
    expect(out).toContain("CPU usage (avg over 5 minutes) is above 90 %");
    expect(out).toContain("on interfaces matching wan");
    expect(out).toContain("sustained for <strong>2 minutes</strong>");
  });

  it("resolves the hardware-sensor unit from the dimension filter's sensor class", () => {
    const s = make(SCHEMA as never);
    expect(s.leafUnit("hwSensorValue", { sensorClass: "temperature" })).toBe("°C");
    expect(s.leafUnit("hwSensorValue", { sensorClass: "fan" })).toBe("RPM");
    expect(s.leafUnit("hwSensorValue", {})).toBe("");
    expect(s.leafUnit("cpuPct", {})).toBe("%");
  });

  it("renders composite trees with AND/OR joins and parenthesized sub-groups", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence({
      type: "composite", kind: "asset", op: "or",
      children: [
        { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 },
        { op: "and", children: [
          { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
          { type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 5 },
        ] },
      ],
    });
    expect(out).toContain("CPU usage is above 90 % OR (Monitor status equals down AND CPU usage is below 5 %)");
  });

  it("auto reset inverts the trigger comparator for the hysteresis clear line", () => {
    const s = make(SCHEMA as never);
    const tr = { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 };
    const out = s.resetSentence({ mode: "auto", clearThreshold: 80, sustainSec: 60 }, tr, 300);
    expect(out).toContain("is at or below 80 %");
    expect(out).toContain("stays there for <strong>1 minute</strong>");
    expect(out).toContain("re-fire within <strong>5 minutes</strong>");
  });

  it("manual / timed / condition reset modes each phrase distinctly", () => {
    const s = make(SCHEMA as never);
    expect(s.resetSentence({ mode: "manual" }, null)).toContain("someone clears it manually");
    expect(s.resetSentence({ mode: "timed", afterSec: 3600 }, null)).toContain("after <strong>1 hour</strong>");
    const cond = s.resetSentence(
      { mode: "condition", condition: { op: "and", children: [{ type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 10 }] } },
      { type: "composite" },
    );
    expect(cond).toContain("Resets when <strong>CPU usage is below 10 %</strong>");
  });

  it("scoping: composites depend on kind, flat triggers on the schema's scoped flag", () => {
    const s = make(SCHEMA as never);
    expect(s.isTriggerScoped({ type: "composite", kind: "asset" })).toBe(true);
    expect(s.isTriggerScoped({ type: "composite", kind: "host" })).toBe(false);
    expect(s.isTriggerScoped({ type: "host_metric" })).toBe(false);
    expect(s.isTriggerScoped({ type: "asset_metric" })).toBe(true);
  });

  it("names the severity when one is passed, and nothing when it isn't", () => {
    const s = make(SCHEMA as never);
    const tr = { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 80 };
    // Callers that only want the condition (the pre-bands rendering) are unchanged.
    expect(s.triggerSentence(tr)).toBe("When <strong>CPU usage is at or above 80 %</strong>.");
    expect(s.triggerSentence(tr, { severity: "warning" }))
      .toBe("When <strong>CPU usage is at or above 80 %</strong> — <strong>warning</strong>.");
  });

  it("spells out every severity band, not just the base tier", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence(
      { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 80, forDurationSec: 1800 },
      {
        severity: "warning",
        severityBands: [
          { severity: "serious", threshold: 90 },
          { severity: "critical", threshold: 95, forDurationSec: 300 },
        ],
      },
    );
    expect(out).toContain("sustained for <strong>30 minutes</strong>");
    expect(out).toContain("<strong>warning</strong> at this level");
    // A band inheriting the base sustain says nothing about duration…
    expect(out).toContain("<strong>serious</strong> at or above 90 %,");
    // …one that overrides it spells its own out.
    expect(out).toContain("<strong>critical</strong> at or above 95 % for 5 minutes");
  });

  it("a band may override the comparator, and a 0-second band reads as immediate", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence(
      { type: "asset_metric", metric: "hwSensorValue", operator: ">", threshold: 65, forDurationSec: 600, dimensionFilter: { sensorClass: "temperature" } },
      { severity: "notice", severityBands: [{ severity: "critical", operator: ">=", threshold: 90, forDurationSec: 0 }] },
    );
    expect(out).toContain("<strong>critical</strong> at or above 90 °C immediately");
  });

  it("ignores bands on a trigger type that can't carry them", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence(
      { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
      { severity: "critical", severityBands: [{ severity: "serious", threshold: 5 }] },
    );
    expect(out).toBe("When <strong>Monitor status equals down</strong> — <strong>critical</strong>.");
  });

  it("appends the ladder to a composite trigger too", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence(
      { type: "composite", kind: "asset", op: "and", children: [{ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 }] },
      { severity: "serious" },
    );
    expect(out.endsWith("— <strong>serious</strong>.")).toBe(true);
  });

  it("escapes operator-controlled strings in the HTML sentence", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence({ type: "event", actionPattern: "<img src=x>" });
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x&gt;");
  });
});
