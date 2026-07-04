/**
 * tests/unit/notificationTemplate.test.ts
 *
 * The shared notification template renderer: token catalog completeness,
 * single-pass {token} interpolation, unknown-token passthrough, HTML-escaping
 * of interpolated values (not template markup), and the small helpers
 * (escapeHtml / templateNeedsAsset / formatElapsed).
 */

import { describe, it, expect } from "vitest";
import {
  TEMPLATE_VARIABLES,
  buildTemplateContext,
  renderNotificationTemplate,
  escapeHtml,
  templateNeedsAsset,
  formatElapsed,
  type TemplateContextParts,
} from "../../src/utils/notificationTemplate.js";

const FULL_PARTS: TemplateContextParts = {
  asset: "fw-atl-01",
  metric: "cpuPct",
  value: "97.5",
  threshold: "90",
  dimension: "port1",
  message: "High CPU: fw-atl-01 — cpuPct = 97.5 (threshold 90)",
  severity: "critical",
  time: new Date("2026-07-04T12:00:00.000Z"),
  link: "https://polaris.example.com/notifications.html",
  ruleName: "High CPU",
  ruleDescription: "Fires on sustained CPU",
  assetDetail: {
    ipAddress: "10.1.1.1",
    macAddress: "AA:BB:CC:DD:EE:FF",
    assetType: "firewall",
    status: "active",
    location: "Atlanta DC",
    learnedLocation: "fgt-atl",
    manufacturer: "Fortinet",
    model: "FGT-100F",
    serialNumber: "FG100F123",
    os: "FortiOS",
    osVersion: "7.4.5",
    department: "IT",
    assignedTo: "netops",
    tags: ["prod", "region:Atlanta"],
  },
  escalationTier: 2,
  escalationElapsed: "1h 30m",
};

describe("buildTemplateContext", () => {
  it("provides a context key for every cataloged token", () => {
    const ctx = buildTemplateContext(FULL_PARTS);
    for (const v of TEMPLATE_VARIABLES) {
      const name = v.token.slice(1, -1); // strip { }
      expect(ctx, `missing context key for ${v.token}`).toHaveProperty([name]);
    }
  });

  it("renders every cataloged token to a non-empty value with full parts", () => {
    const ctx = buildTemplateContext(FULL_PARTS);
    for (const v of TEMPLATE_VARIABLES) {
      expect(renderNotificationTemplate(v.token, ctx), `${v.token} rendered empty`).not.toBe("");
      expect(renderNotificationTemplate(v.token, ctx)).not.toBe(v.token);
    }
  });

  it("maps the derived fields correctly", () => {
    const ctx = buildTemplateContext(FULL_PARTS);
    expect(ctx["severity.upper"]).toBe("CRITICAL");
    expect(ctx["time"]).toBe("2026-07-04T12:00:00.000Z");
    expect(ctx["asset.location"]).toBe("Atlanta DC");
    expect(ctx["asset.tags"]).toBe("prod, region:Atlanta");
    expect(ctx["escalation.tier"]).toBe("2");
  });

  it("falls back to learnedLocation when location is unset and to empty strings when parts are missing", () => {
    const ctx = buildTemplateContext({ assetDetail: { learnedLocation: "fgt-atl" } });
    expect(ctx["asset.location"]).toBe("fgt-atl");
    const empty = buildTemplateContext({});
    expect(empty["asset.ip"]).toBe("");
    expect(empty["escalation.tier"]).toBe("");
    expect(empty["asset.tags"]).toBe("");
  });
});

describe("renderNotificationTemplate", () => {
  const ctx = buildTemplateContext(FULL_PARTS);

  it("interpolates known tokens", () => {
    expect(renderNotificationTemplate("{asset}: {metric} = {value} (limit {threshold})", ctx))
      .toBe("fw-atl-01: cpuPct = 97.5 (limit 90)");
  });

  it("leaves unknown tokens literal (typos stay visible)", () => {
    expect(renderNotificationTemplate("{asset} {notAToken} {asset.nope}", ctx))
      .toBe("fw-atl-01 {notAToken} {asset.nope}");
  });

  it("does not re-interpolate substituted values (single pass)", () => {
    const c = buildTemplateContext({ ...FULL_PARTS, value: "{threshold}" });
    expect(renderNotificationTemplate("{value}", c)).toBe("{threshold}");
  });

  it("HTML mode escapes interpolated values but not template markup", () => {
    const c = buildTemplateContext({ ...FULL_PARTS, asset: '<script>alert("x")</script>' });
    const out = renderNotificationTemplate("<p><strong>{asset}</strong></p>", c, { html: true });
    expect(out).toBe("<p><strong>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</strong></p>");
  });
});

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});

describe("templateNeedsAsset", () => {
  it("detects {asset.*} tokens across templates", () => {
    expect(templateNeedsAsset(["{asset} only", null, undefined])).toBe(false);
    expect(templateNeedsAsset([null, "IP: {asset.ip}"])).toBe(true);
  });
});

describe("formatElapsed", () => {
  it("formats minutes / hours / days", () => {
    expect(formatElapsed(5 * 60_000)).toBe("5m");
    expect(formatElapsed(92 * 60_000)).toBe("1h 32m");
    expect(formatElapsed(120 * 60_000)).toBe("2h");
    expect(formatElapsed(26 * 60 * 60_000)).toBe("1d 2h");
    expect(formatElapsed(-500)).toBe("0m");
  });
});
