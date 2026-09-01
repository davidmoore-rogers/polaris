/**
 * tests/unit/downSeverityColor.test.ts
 *
 * The colour a `down` monitor state is DRAWN in, per severity (business rule
 * 36) — and the fact that the browser and the server agree about it.
 *
 * Down is not inherently red. Red is what `critical` looks like, and critical
 * is merely the default severity of a seeded down automation. An operator who
 * rates an outage on a device class `warning` has said something about how it
 * should read, and every surface that paints the state honours it: the
 * Last-30-min strip, the desktop response-time chart, the phone's, and the
 * chart rasterized into the alert email.
 *
 * WHY A PARITY TEST. The palette is duplicated by necessity — `DOWN_SEVERITY_HEX`
 * in src/utils/severityStyle.ts for the email, `DOWN_SEV_COLOR` in
 * public/js/chart-severity.js for the browser — because nothing crosses that
 * boundary (no build step on the frontend). One outage drawn two different
 * colours depending on where you read it is exactly what this vocabulary exists
 * to prevent, so the two maps are pinned to each other here.
 *
 * The COLLISION assertions at the bottom are the other half. This palette lands
 * on charts that already spend amber on a below-threshold miss, blue on a
 * recovering probe and grey on a dependency-explained one; each down colour has
 * to stay distinguishable from the neighbour it sits beside in that vocabulary.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { downSeverityCss, downSeverityHex } from "../../src/utils/severityStyle.js";
import { SEVERITIES } from "../../src/services/notificationTypes.js";

const chartSeveritySrc = readFileSync(
  resolve(__dirname, "../../public/js/chart-severity.js"),
  "utf8",
);

const browser = new Function(
  `const window = {}; ${chartSeveritySrc}; return window.PolarisChartSeverity;`,
)() as {
  downColorOf: (s: string | null) => string;
  DOWN_DEFAULT_COLOR: string;
};

/** The three colours already spoken on the same charts, which a down colour
 *  must not be mistaken for. Values duplicated from _CHART_MISS_COLOR /
 *  _CHART_RECOVER_COLOR / _CHART_DEP_COLOR in public/js/assets.js. */
const MISS_AMBER = "#ffc107";
const RECOVER_BLUE = "#0288d1";
const DEP_GREY = "#9aa0a6";

describe("the down-severity palette", () => {
  it("covers every severity in the vocabulary", () => {
    for (const sev of SEVERITIES) {
      expect(downSeverityCss(sev)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps critical on the red every surface already drew Down in", () => {
    // A default install must look exactly as it did: every seeded down
    // automation is `critical`, and this is _CHART_FAIL_COLOR.
    expect(downSeverityCss("critical")).toBe("#d32f2f");
  });

  it("falls back to the red for an absent or unrecognized severity", () => {
    // Passive devices and unresolved automations both land here, and inventing
    // a gentler colour would understate a verdict Polaris is still asserting.
    for (const bad of [null, undefined, "", "bogus", "resolved"]) {
      expect(downSeverityHex(bad)).toBe(downSeverityHex("critical"));
    }
  });

  it("agrees with the browser copy on every severity", () => {
    // The whole point: an operator reading an outage on the device page and in
    // the email about the same device must not see two colours.
    for (const sev of SEVERITIES) {
      expect(browser.downColorOf(sev)).toBe(downSeverityCss(sev));
    }
    expect(browser.DOWN_DEFAULT_COLOR).toBe(downSeverityCss("critical"));
    expect(browser.downColorOf(null)).toBe(downSeverityCss("critical"));
    expect(browser.downColorOf("bogus" as string)).toBe(downSeverityCss("critical"));
  });

  it("is NOT the alert-wide severity palette", () => {
    // severityHex colours a whole alert — an email's severity bar, a Teams card
    // — where nothing competes with it. These land on a chart that already
    // speaks three other colours, so they are deliberately separate values.
    expect(downSeverityCss("critical")).not.toBe("#dc2626");
  });

  it("gives every severity its own colour", () => {
    const seen = new Set(SEVERITIES.map((s) => downSeverityCss(s)));
    expect(seen.size).toBe(SEVERITIES.length);
  });

  it("never collides with the chart's miss / recovering / dependency colours", () => {
    // Each down colour sits beside one of these in the same vocabulary and has
    // to stay tellable apart from it. `warning` vs the miss amber is the
    // closest pair by design — a warning-severity outage and the misses that
    // built it ARE two shades of one yellow — but they must still differ.
    for (const sev of SEVERITIES) {
      const c = downSeverityCss(sev);
      expect(c).not.toBe(MISS_AMBER);
      expect(c).not.toBe(RECOVER_BLUE);
      expect(c).not.toBe(DEP_GREY);
    }
  });

  it("keeps the maintenance lavender out of the palette", () => {
    // #9575cd means MAINTENANCE elsewhere on these charts — a gap that IS
    // explained. A down state is the opposite claim.
    for (const sev of SEVERITIES) {
      expect(downSeverityCss(sev)).not.toBe("#9575cd");
    }
  });
});
