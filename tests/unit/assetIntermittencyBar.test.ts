/**
 * tests/unit/assetIntermittencyBar.test.ts — the asset System tab's
 * "Last 30 min" sample strip (_intermittencyStates in public/js/assets.js).
 *
 * The strip is the only place an operator sees the monitor state sample by
 * sample, so it has to speak the same vocabulary as the Status pill above it.
 * It previously emitted only up / warning / down: every success was green the
 * instant it landed, so the blue Recovering state — the whole window between
 * "it answered once" and "it is confirmed back" — was invisible on the one
 * surface built to show it.
 *
 * What's pinned here is the split that makes that work without reintroducing
 * a smear on blips:
 *  - failures stay literal (yellow, red on the Nth consecutive one), so a
 *    failed probe is never painted blue;
 *  - successes come from the machine, so the exit from `down` is blue until N
 *    consecutive successes confirm the device;
 *  - a single missed poll never smears — green, yellow, green;
 *  - a blip DURING recovery keeps the machine in recovering, so the successes
 *    after it are still blue (this is where a naive per-sample map diverges
 *    from the pill);
 *  - the pre-window state is `up`, not `unknown`, or the first cells of every
 *    bar would be blue.
 *
 * assets.js is a ~18k-line browser script with no module boundary, so the
 * function under test is sliced out by name — the approach of
 * tests/unit/assetPanelHistoryDom.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = assetsLines.findIndex(
    (l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`),
  );
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

type Sample = { timestamp: string; success: boolean };
type State = { timestamp: string; status: string };

const _intermittencyStates = new Function(
  `${fnSrc("_intermittencyStates")}; return _intermittencyStates;`,
)() as (samples: Sample[], threshold?: number) => State[];

/** "..X.." → samples, where "." is a success and "x"/"X" a failed probe. */
function run(pattern: string, threshold?: number): string {
  const samples = pattern.split("").map((c, i) => ({
    timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
    success: c === ".",
  }));
  return _intermittencyStates(samples, threshold)
    .map((s) => ({ up: "g", recovering: "b", warning: "y", down: "r" }[s.status] ?? "?"))
    .join("");
}

describe("_intermittencyStates", () => {
  it("paints the recovery run blue until the success threshold is met", () => {
    // threshold 3: three failures declare down; three successes confirm up.
    expect(run("..xxx....", 3)).toBe("ggyyrbbgg");
  });

  it("never smears a single missed poll", () => {
    expect(run(".x.", 3)).toBe("gyg");
  });

  it("keeps failures literal — a failed probe during recovery is yellow", () => {
    // The blip does not reach the threshold, so the machine stays recovering
    // and the successes after it are still blue (the pill reads Recovering).
    expect(run("xxx.x..", 3)).toBe("yyrbybb");
  });

  it("stays red for the whole failure run and only the first success turns blue", () => {
    expect(run("xxxxx.", 3)).toBe("yyrrrb");
  });

  it("goes straight to green at threshold 1 (no recovery window to show)", () => {
    expect(run("x.", 1)).toBe("rg");
  });

  it("assumes the pre-window state is up, so a clean stream is all green", () => {
    expect(run("......", 3)).toBe("gggggg");
  });

  it("falls back to threshold 3 when the resolved setting is unusable", () => {
    expect(run("..xxx...", undefined)).toBe("ggyyrbbg");
    expect(run("..xxx...", 0)).toBe("ggyyrbbg");
    expect(run("..xxx...", Number.NaN)).toBe("ggyyrbbg");
  });

  it("returns one state per sample, carrying the timestamp through", () => {
    const samples: Sample[] = [
      { timestamp: "2026-08-25T00:00:00.000Z", success: true },
      { timestamp: "2026-08-25T00:01:00.000Z", success: false },
    ];
    expect(_intermittencyStates(samples, 3)).toEqual([
      { timestamp: "2026-08-25T00:00:00.000Z", status: "up" },
      { timestamp: "2026-08-25T00:01:00.000Z", status: "warning" },
    ]);
  });

  it("tolerates an empty or absent sample list", () => {
    expect(_intermittencyStates([], 3)).toEqual([]);
    expect(_intermittencyStates(undefined as unknown as Sample[], 3)).toEqual([]);
  });

  it("the renderer's color map covers every state the replay can emit", () => {
    const src = assetsLines.join("\n");
    const map = /var colors = \{([\s\S]*?)\};/.exec(src)![1];
    for (const state of ["up", "recovering", "warning", "down"]) {
      expect(map).toContain(`${state}:`);
    }
    // Recovering must be the pill's blue (badge-monitor-recovering).
    expect(map).toMatch(/recovering:\s*"rgba\(79,195,247,/);
  });
});
