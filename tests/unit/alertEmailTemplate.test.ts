/**
 * tests/unit/alertEmailTemplate.test.ts
 *
 * The default alert email. The point of expressing it as a TEMPLATE (rather
 * than server-side string building) is that what Polaris sends and what the
 * operator can edit in a Notify action are the same text — so these tests pin
 * the template's shape, and the two prune passes that keep an under-populated
 * device from mailing a column of blank cells.
 */

import { describe, it, expect } from "vitest";
import {
  defaultAlertEmailTemplate,
  pruneEmptyRows,
  pruneEmptyTextLines,
  DEFAULT_ALERT_HTML,
  DEFAULT_ALERT_TEXT,
} from "../../src/utils/alertEmailTemplate.js";
import { substituteChartTokens, chartTokensIn, attachmentsFor, CHART_TOKENS, type RenderedChart, type ChartToken } from "../../src/services/alertChartService.js";
import { renderNotificationTemplate, buildTemplateContext } from "../../src/utils/notificationTemplate.js";

const CTX = buildTemplateContext({
  asset: "BULLITT-222E-4",
  message: "packet loss at 93.8% (fires above 5%)",
  severity: "critical",
  time: new Date("2026-08-12T10:00:00Z"),
  ruleName: "Packet loss",
  assetDetail: {
    id: "a-1",
    ipAddress: "10.20.30.40",
    lastSeenSwitch: "FS-248E-01/port15",
    lastSeenAp: null,
    location: "Bullitt County",
    manufacturer: "Fortinet",
    model: "FAP-431F",
  },
});

describe("the default alert email is a template, not string building", () => {
  it("carries the device facts the old two-line email never had", () => {
    const html = renderNotificationTemplate(DEFAULT_ALERT_HTML, CTX, { html: true });
    expect(html).toContain("BULLITT-222E-4");
    expect(html).toContain("10.20.30.40");
    expect(html).toContain("FS-248E-01/port15");
    expect(html).toContain("packet loss at 93.8%");
  });

  it("offers Acknowledge and Open device as real links", () => {
    expect(DEFAULT_ALERT_HTML).toContain('href="{ack}"');
    expect(DEFAULT_ALERT_HTML).toContain('href="{asset.link}"');
    expect(DEFAULT_ALERT_TEXT).toContain("{ack}");
    expect(DEFAULT_ALERT_TEXT).toContain("{asset.link}");
  });

  it("asks for every last-hour chart, sensor included", () => {
    // The sensor chart is requested unconditionally; it renders away for the
    // alerts that aren't about a hardware sensor (buildAlertCharts drops it
    // when the notification carries no sensor dimension), so the template
    // needs no conditional and the operator can move or delete it like any
    // other token.
    // Read from the implementation: the body is supposed to ask for the whole
    // catalogue, so a newly added chart that nobody wired into the template is
    // the failure this pins — not a list to keep in step by hand.
    const all = new Set<string>(CHART_TOKENS);
    expect(chartTokensIn(DEFAULT_ALERT_HTML)).toEqual(all);
    expect(chartTokensIn(DEFAULT_ALERT_TEXT)).toEqual(all);
  });

  it("leads the charts with the sensor — when it renders, it IS what fired", () => {
    expect(DEFAULT_ALERT_HTML.indexOf("{chart.sensor}")).toBeLessThan(DEFAULT_ALERT_HTML.indexOf("{chart.cpu}"));
    expect(DEFAULT_ALERT_TEXT.indexOf("{chart.sensor}")).toBeLessThan(DEFAULT_ALERT_TEXT.indexOf("{chart.cpu}"));
  });

  it("survives every mail client's rendering quirks: tables, inline styles, no remote assets", () => {
    // Outlook renders through Word — flexbox/grid and <style> blocks are out.
    expect(DEFAULT_ALERT_HTML).not.toMatch(/display:\s*flex|display:\s*grid|<style/i);
    // Nothing to fetch: remote images are blocked by default in most clients.
    expect(DEFAULT_ALERT_HTML).not.toMatch(/<img[^>]+src="https?:/i);
    expect(DEFAULT_ALERT_HTML).not.toMatch(/<script/i);
  });

  it("colours itself by severity through a token, not a hardcoded hex", () => {
    const html = renderNotificationTemplate(DEFAULT_ALERT_HTML, CTX, { html: true });
    expect(html).toContain("#dc2626"); // critical
    expect(renderNotificationTemplate(DEFAULT_ALERT_HTML, buildTemplateContext({ severity: "warning" }), { html: true }))
      .toContain("#d97706");
  });

  it("is what defaultAlertEmailTemplate hands the wizard to prefill", () => {
    const t = defaultAlertEmailTemplate();
    expect(t.bodyHtmlTemplate).toBe(DEFAULT_ALERT_HTML);
    expect(t.bodyTextTemplate).toBe(DEFAULT_ALERT_TEXT);
    expect(t.subjectTemplate).toContain("{severity.upper}");
  });
});

describe("pruneEmptyRows", () => {
  it("drops a facts row whose value is empty", () => {
    const html = '<table><tr><td>Connected AP</td><td></td></tr><tr><td>IP</td><td>10.0.0.1</td></tr></table>';
    const out = pruneEmptyRows(html);
    expect(out).not.toContain("Connected AP");
    expect(out).toContain("10.0.0.1");
  });

  it("treats a whitespace-only value as empty", () => {
    expect(pruneEmptyRows("<tr><td>Model</td><td>  &nbsp; </td></tr>")).toBe("");
  });

  it("never touches layout rows — only two-cell label/value pairs", () => {
    const bar = '<tr><td style="background:#dc2626">&nbsp;</td></tr>';
    expect(pruneEmptyRows(bar)).toBe(bar);
    const three = "<tr><td>a</td><td></td><td>c</td></tr>";
    expect(pruneEmptyRows(three)).toBe(three);
  });

  it("prunes the real body when the device knows little about itself", () => {
    const bare = buildTemplateContext({ asset: "host-9", message: "down", severity: "warning" });
    const out = pruneEmptyRows(renderNotificationTemplate(DEFAULT_ALERT_HTML, bare, { html: true }));
    expect(out).not.toContain("Connected switch");
    expect(out).not.toContain("Connected AP");
    // The message and the scaffolding survive.
    expect(out).toContain("down");
    expect(out).toContain("Acknowledge alert");
  });
});

describe("pruneEmptyTextLines", () => {
  it("drops label lines with nothing after the colon and collapses the gap", () => {
    const out = pruneEmptyTextLines("Device:     host-9\nAP:         \nIP:         10.0.0.1");
    expect(out).toBe("Device:     host-9\nIP:         10.0.0.1");
  });

  it("leaves prose alone — it only prunes Label: value lines", () => {
    expect(pruneEmptyTextLines("packet loss at 93.8% (fires above 5%)")).toBe("packet loss at 93.8% (fires above 5%)");
  });
});

describe("substituteChartTokens", () => {
  // hasData and attachment are DIFFERENT facts: "the device reported nothing"
  // vs "it reported, but the rasterizer failed". The first is dropped from the
  // email, the second still prints its numbers.
  const chart = (token: ChartToken, withPng: boolean, hasData = true): RenderedChart => ({
    token,
    cid: `polaris-${token.replace(".", "-")}@polaris`,
    hasData,
    summary: "CPU (last hour): now 62%, avg 40%, peak 97%",
    attachment: withPng
      ? { cid: `polaris-${token.replace(".", "-")}@polaris`, filename: "c.png", contentType: "image/png", content: Buffer.from("x") }
      : null,
  });

  it("embeds the image by cid and keeps the numbers as alt text", () => {
    const charts = new Map([["chart.cpu" as ChartToken, chart("chart.cpu", true)]]);
    const out = substituteChartTokens("<div>{chart.cpu}</div>", charts, { html: true });
    expect(out).toContain('src="cid:polaris-chart-cpu@polaris"');
    // Image blocking is on by default in a lot of clients — the numbers have
    // to survive it.
    expect(out).toContain("now 62%, avg 40%, peak 97%");
  });

  it("falls back to the summary line when there is no image to show", () => {
    const charts = new Map([["chart.cpu" as ChartToken, chart("chart.cpu", false)]]);
    const out = substituteChartTokens("<div>{chart.cpu}</div>", charts, { html: true });
    expect(out).not.toContain("<img");
    expect(out).toContain("now 62%");
  });

  it("writes plain text as a sentence, not markup", () => {
    const charts = new Map([["chart.cpu" as ChartToken, chart("chart.cpu", true)]]);
    expect(substituteChartTokens("{chart.cpu}", charts, { html: false })).toBe("CPU (last hour): now 62%, avg 40%, peak 97%");
  });

  it("removes a token nothing was built for, rather than mailing the literal", () => {
    expect(substituteChartTokens("a{chart.memory}b", new Map(), { html: true })).toBe("ab");
    expect(substituteChartTokens("a{chart.memory}b", new Map(), { html: false })).toBe("ab");
  });

  it("attaches only the images the final body actually references", () => {
    const charts = new Map<ChartToken, RenderedChart>([
      ["chart.cpu", chart("chart.cpu", true)],
      ["chart.memory", chart("chart.memory", true)],
    ]);
    const body = substituteChartTokens("<div>{chart.cpu}</div>", charts, { html: true });
    const attached = attachmentsFor(charts, body);
    expect(attached.map((a) => a.cid)).toEqual(["polaris-chart-cpu@polaris"]);
  });
});
