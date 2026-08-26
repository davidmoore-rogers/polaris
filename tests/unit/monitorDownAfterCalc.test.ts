/**
 * tests/unit/monitorDownAfterCalc.test.ts
 *
 * `window._polarisMonDownAfterCalc` from public/js/integrations.js — the derived
 * "Declare Down after (seconds without an answer)" arithmetic shared by the
 * three monitor-settings cards (integration Monitoring tab, class overrides,
 * manual settings) at render time and by the live input sync.
 *
 * The figure it reports is `failureThreshold × poll interval`, because the
 * fast-confirm re-probe was removed 2026-08-19: every miss after the first now
 * waits a FULL interval. This is the number operators plan around, and it is
 * derived rather than stored precisely so it cannot disagree with the two
 * settings it is computed from.
 *
 * Loaded through a vm context (the file is a browser script, not a module) —
 * same approach as appmapFilter.test.ts / topologyColumns.test.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

interface Calc {
  threshold: number;
  interval: number;
  timeoutSec: number;
  realSec: number;
  note: string;
}
let calc: (thr: unknown, intervalSec: unknown, timeoutMs: unknown) => Calc;

beforeAll(() => {
  // The helper lives in its own tiny module now — it is shared with the
  // automations wizard (the missed-poll COUNT belongs to the down-detection
  // automation, business rule 36), and the wizard's DOM tests cannot eval
  // integrations.js. That also means this loader no longer needs the elaborate
  // sandbox that existed purely to keep 7,500 lines of integrations.js from
  // throwing at parse time.
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(resolve(here, "../../public/js/monitor-down-after.js"), "utf8");
  const sandbox: Record<string, any> = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  calc = sandbox.window.PolarisMonitorDownAfter.calc;
  // The legacy alias must keep working for one release.
  expect(sandbox.window._polarisMonDownAfterCalc).toBe(calc);
});

describe("_polarisMonDownAfterCalc", () => {
  it("reports threshold × interval, plus the timeout on the first miss", () => {
    // 3 misses at a 60s cadence: the first costs up to the 5s timeout, the two
    // after it each wait a full interval. 2 × 60 + 5.
    const c = calc(3, 60, 5000);
    expect(c.realSec).toBe(125);
    expect(c.threshold).toBe(3);
    expect(c.interval).toBe(60);
    expect(c.timeoutSec).toBe(5);
  });

  it("scales with the interval — this is the regression fast-confirm used to hide", () => {
    // The point of stating it: at a 300s cadence, 3 misses is over ten minutes.
    // With fast-confirm this figure was ~35s regardless of cadence.
    expect(calc(3, 300, 5000).realSec).toBe(605);
    expect(calc(3, 5, 5000).realSec).toBe(15);
  });

  it("treats a threshold of 1 as the timeout alone (no interval to wait out)", () => {
    const c = calc(1, 300, 5000);
    expect(c.realSec).toBe(5);
    // "poll", not "probe": the note shares the automation's own vocabulary
    // now that the count is the automation's field.
    expect(c.note).toContain("1 consecutive missed poll");
    expect(c.note).not.toContain("polls");
  });

  it("carries the probe timeout into the figure", () => {
    expect(calc(2, 60, 30000).realSec).toBe(90);   // 1 × 60 + 30
    expect(calc(2, 60, 30000).timeoutSec).toBe(30);
    expect(calc(2, 60, 1500).timeoutSec).toBe(2);  // rounds up to whole seconds
  });

  it("clamps a nonsense threshold rather than producing a nonsense duration", () => {
    expect(calc(0, 60, 5000).threshold).toBe(3);      // falls back to the default
    expect(calc(-4, 60, 5000).threshold).toBe(3);
    expect(calc(9999, 60, 5000).threshold).toBe(100); // hard ceiling
    expect(calc("abc", 60, 5000).threshold).toBe(3);
  });

  it("falls back to sane defaults for a blank interval or timeout", () => {
    expect(calc(3, 0, 0).interval).toBe(60);
    expect(calc(3, 0, 0).timeoutSec).toBe(5);
    expect(calc(3, null, undefined).realSec).toBe(125);
  });

  it("says the first probe's wait is extra, so the figure is not read as end-to-end", () => {
    // Detection also includes the blind gap before the first probe notices —
    // stating it is the difference between an honest number and a misleading one.
    expect(calc(3, 60, 5000).note).toContain("another poll interval on top");
    // The count is now visible on the same screen (it is the automation's own
    // field), so the note names it instead of saying "the same number".
    expect(calc(3, 60, 5000).note).toContain("Recovery to Up needs 3 consecutive successes");
    expect(calc(1, 60, 5000).note).toContain("Recovery to Up needs 1 consecutive success");
  });

  it("no longer mentions a confirmation re-probe", () => {
    // The fast-confirm field is gone from the cards; the note must not describe
    // a control that no longer exists.
    expect(calc(3, 60, 30000).note).not.toMatch(/confirmation re-probe/i);
  });
});
