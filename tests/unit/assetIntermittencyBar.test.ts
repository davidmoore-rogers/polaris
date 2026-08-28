/**
 * tests/unit/assetIntermittencyBar.test.ts — the asset System tab's
 * "Last 30 min" sample strip (_intermittencyStates in public/js/assets.js).
 *
 * The strip is the only place an operator sees the monitor state sample by
 * sample, so it has to speak the same vocabulary as the Status pill above it —
 * which means it is a MIRROR of recordProbeResult, and these cases exist to
 * catch the two drifting apart.
 *
 * The rule under test is the leaky bucket of business rule 30: a miss adds one
 * to the missed count, a success takes one back (floored at 0), the LEVEL picks
 * the color, and this probe's outcome only breaks the tie below the threshold.
 * What's pinned:
 *  - a single missed poll never smears — green, amber, green;
 *  - paying back N misses takes N answers, so the recovery run is N cells;
 *  - the level decides, so one answered packet cannot repaint a deep outage —
 *    this is the case a "success wins outright" machine gets wrong;
 *  - a blip during the climb back out re-fills the bucket and can go red again;
 *  - the pre-window state is fully recovered (count 0), or the first cells of
 *    every bar would be colored as if an outage were already in progress.
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
type State = { timestamp: string; status: string; missed: number; success: boolean };

const _intermittencyStates = new Function(
  `${fnSrc("_intermittencyStates")}; return _intermittencyStates;`,
)() as (samples: Sample[], threshold?: number) => State[];

/** "..X.." → samples, where "." is a success and "x"/"X" a failed probe. */
function states(pattern: string, threshold?: number): State[] {
  const samples = pattern.split("").map((c, i) => ({
    timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
    success: c === ".",
  }));
  return _intermittencyStates(samples, threshold);
}
/** Colors, one letter per sample. p = purple (recovering / paying the debt). */
function run(pattern: string, threshold?: number): string {
  return states(pattern, threshold)
    .map((s) => ({ up: "g", recovering: "p", warning: "y", down: "r" }[s.status] ?? "?"))
    .join("");
}
/** The missed-poll count after each probe — what the tooltip reports. */
function counts(pattern: string, threshold?: number): number[] {
  return states(pattern, threshold).map((s) => s.missed);
}

describe("_intermittencyStates", () => {
  it("takes as many answers to pay the misses back as it took to accrue them", () => {
    // threshold 3: three misses declare down, and three answers walk 3→2→1→0.
    expect(run("..xxx....", 3)).toBe("ggyyrppgg");
    expect(counts("..xxx....", 3)).toEqual([0, 0, 1, 2, 3, 2, 1, 0, 0]);
  });

  it("never smears a single missed poll", () => {
    expect(run(".x.", 3)).toBe("gyg");
    expect(counts(".x.", 3)).toEqual([0, 1, 0]);
  });

  it("re-fills the bucket on a blip during the climb out, so it can go red again", () => {
    // 1,2,3 → down; one answer pays it to 2; the blip puts it straight back to
    // 3 and it is down again. The run-length machine painted that cell amber,
    // which said "a poll was missed" when the truth was "still fully down".
    expect(run("xxx.x..", 3)).toBe("yyrprpp");
    expect(counts("xxx.x..", 3)).toEqual([1, 2, 3, 2, 3, 2, 1]);
  });

  it("does not let one answered packet repaint a deep outage", () => {
    // Five misses is a debt of 5. One answer takes it to 4 — still at or over
    // the threshold, so the cell stays RED. This is the whole reason the level
    // decides rather than the last outcome: at threshold 3 a device dark for an
    // hour would otherwise read "recovering" on a single lucky poll.
    expect(run("xxxxx.", 3)).toBe("yyrrrr");
    expect(counts("xxxxx.", 3)).toEqual([1, 2, 3, 4, 5, 4]);
    // It takes two more answers to drop under the threshold, then two to clear.
    expect(run("xxxxx.....", 3)).toBe("yyrrrrrppg");
  });

  it("goes straight to green at threshold 1 (no recovery window to show)", () => {
    expect(run("x.", 1)).toBe("rg");
  });

  it("assumes the pre-window state is recovered, so a clean stream is all green", () => {
    expect(run("......", 3)).toBe("gggggg");
    expect(counts("......", 3)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("never floors the count below zero on a long clean run", () => {
    expect(counts(".x....", 3)).toEqual([0, 1, 0, 0, 0, 0]);
  });

  it("falls back to threshold 3 when the resolved setting is unusable", () => {
    expect(run("..xxx...", undefined)).toBe("ggyyrppg");
    expect(run("..xxx...", 0)).toBe("ggyyrppg");
    expect(run("..xxx...", Number.NaN)).toBe("ggyyrppg");
  });

  it("runs the bucket for a passive asset but never paints it red", () => {
    // threshold null = no down-detection automation covers the device, so no
    // verdict may be rendered — but the count is still the tooltip's subject.
    expect(run("xxxxx.", null as unknown as number)).toBe("yyyyyp");
    expect(counts("xxxxx.", null as unknown as number)).toEqual([1, 2, 3, 4, 5, 4]);
  });

  it("returns one state per sample, carrying the timestamp and count through", () => {
    const samples: Sample[] = [
      { timestamp: "2026-08-25T00:00:00.000Z", success: true },
      { timestamp: "2026-08-25T00:01:00.000Z", success: false },
    ];
    expect(_intermittencyStates(samples, 3)).toEqual([
      { timestamp: "2026-08-25T00:00:00.000Z", status: "up", missed: 0, success: true },
      { timestamp: "2026-08-25T00:01:00.000Z", status: "warning", missed: 1, success: false },
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
    // Recovering is PURPLE on this strip — "answered, misses still outstanding".
    // Pinned as the magenta-leaning purple 400 and NOT the muted lavender
    // #9575cd (149,117,205) that means maintenance elsewhere in the product.
    expect(map).toMatch(/recovering:\s*"rgba\(171,71,188,/);
    expect(map).not.toContain("149,117,205");
  });
});
