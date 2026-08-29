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
 *    every bar would be colored as if an outage were already in progress;
 *  - and the covering automation's RECOVERY count (business rule 36): when its
 *    reset asks for more answered polls than the drain provides, the cells stay
 *    purple until the run is served — but only for a device that actually went
 *    down, never for one that merely blipped.
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
type State = {
  timestamp: string;
  status: string;
  missed: number;
  success: boolean;
  confirming: { done: number; need: number } | null;
};

const _intermittencyStates = new Function(
  `${fnSrc("_intermittencyStates")}; return _intermittencyStates;`,
)() as (samples: Sample[], threshold?: number, recoveryPolls?: number) => State[];

/** "..X.." → samples, where "." is a success and "x"/"X" a failed probe. */
function states(pattern: string, threshold?: number, recoveryPolls?: number): State[] {
  const samples = pattern.split("").map((c, i) => ({
    timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
    success: c === ".",
  }));
  return _intermittencyStates(samples, threshold, recoveryPolls);
}
/** Colors, one letter per sample. p = purple (recovering / paying the debt). */
function run(pattern: string, threshold?: number, recoveryPolls?: number): string {
  return states(pattern, threshold, recoveryPolls)
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
      { timestamp: "2026-08-25T00:00:00.000Z", status: "up", missed: 0, success: true, confirming: null },
      { timestamp: "2026-08-25T00:01:00.000Z", status: "warning", missed: 1, success: false, confirming: null },
    ]);
  });

  it("tolerates an empty or absent sample list", () => {
    expect(_intermittencyStates([], 3)).toEqual([]);
    expect(_intermittencyStates(undefined as unknown as Sample[], 3)).toEqual([]);
  });

  // ── The covering automation's recovery count (business rule 36) ──────────
  //
  // "Down after 3 missed, reset after 5 received" is the shape that forced
  // this: the bar went green on the third answer while the alert was still
  // firing, which is Polaris disagreeing with itself in the one place an
  // operator follows a device probe by probe.

  it("holds purple until the automation's recovery count is served", () => {
    // 3 misses = down. The drain alone would go green on answer 3; a reset
    // asking for 5 keeps the last two cells purple.
    expect(run("xxx.....", 3, 5)).toBe("yyrppppg");
  });

  it("counts the drain toward the recovery run rather than restarting it", () => {
    // The 5 answers include the 3 that paid the debt — an operator who wrote
    // "5 received" means five probes, not three plus five.
    const s = states("xxx.....", 3, 5);
    expect(s.filter((c) => c.success).findIndex((c) => c.status === "up")).toBe(4);
  });

  it("reports the confirmation run in the tooltip's subject", () => {
    const s = states("xxx.....", 3, 5);
    expect(s[5].confirming).toEqual({ done: 3, need: 5 });
    expect(s[6].confirming).toEqual({ done: 4, need: 5 });
    // While the bucket still has debt the cell is about the debt, not the run.
    expect(s[4].confirming).toBeNull();
    // And once the run is served it is an ordinary green.
    expect(s[7].confirming).toBeNull();
  });

  it("leaves a blip alone — only a device that went DOWN owes the run", () => {
    // Two misses against a threshold of 3 never reached down, so the second
    // answer is green exactly as it was before the recovery count existed.
    expect(run("xx..", 3, 5)).toBe("yypg");
  });

  it("is a no-op when the reset asks for no more than the drain", () => {
    expect(run("xxx.....", 3, 3)).toBe(run("xxx.....", 3));
    expect(run("xxx.....", 3, 0)).toBe(run("xxx.....", 3));
    expect(run("xxx.....", 3, 2)).toBe(run("xxx.....", 3));
  });

  it("does not extend a deep outage that already out-drained the count", () => {
    // 7 misses cost 7 answers to drain — the asset is still DOWN for the first
    // four of them (the bucket has to fall under 3) — and a 5-poll reset adds
    // nothing on top, because the drain already exceeded it.
    expect(run("xxxxxxx........", 3, 5)).toBe("yyrrrrrrrrrppgg");
    expect(run("xxxxxxx........", 3, 5)).toBe(run("xxxxxxx........", 3));
  });

  it("re-arms after a fresh outage, not once per window", () => {
    expect(run("xxx.....xxx.....", 3, 5)).toBe("yyrppppgyyrppppg");
  });

  it("never paints a healthy window purple on its third cell", () => {
    // The server infers "was down" from the counters; the replay cannot, so it
    // tracks the observation. Without that, a bar opening on a device that has
    // been up for hours reads cs >= threshold at cf 0 and goes amber.
    expect(run("..........", 3, 5)).toBe("gggggggggg");
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
