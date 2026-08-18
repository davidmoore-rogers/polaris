/**
 * tests/unit/alertBrandLetterhead.test.ts
 *
 * The install's letterhead in the top-right of the alert email — logo,
 * application name, subtitle. Three things here are worth pinning:
 *
 *  - the token is DEFERRED, so the compose pass must leave it literal for the
 *    delivery pass to fill (the {chart.trigger} regression, in a new place);
 *  - the two-column header must survive `pruneEmptyRows`, which drops any
 *    two-cell row whose value cell is empty and which — before the nested
 *    table went in — could have read the header as a label/value pair and taken
 *    the whole headline with it;
 *  - which artwork and whether the name prints follow business rule 27 rather
 *    than being re-decided here.
 */

import { describe, it, expect } from "vitest";
import {
  BRAND_LOGO_CID,
  MAX_LOGO_HEIGHT,
  MAX_LOGO_WIDTH,
  brandTokensIn,
  fitLogo,
  renderBrandBlock,
  substituteBrandTokens,
  type BrandLogoImage,
} from "../../src/services/alertBrandService.js";
import {
  DEFAULT_ALERT_HTML,
  DEFAULT_ALERT_TEXT,
  pruneDeadLinks,
  pruneEmptyDivs,
  pruneEmptyRows,
  pruneEmptyTextLines,
} from "../../src/utils/alertEmailTemplate.js";
import {
  buildTemplateContext,
  isDeferredToken,
  renderNotificationTemplate,
  TEMPLATE_VARIABLES,
} from "../../src/utils/notificationTemplate.js";

const LOGO: BrandLogoImage = {
  width: 150,
  height: 30,
  alt: "Polaris",
  attachment: { cid: BRAND_LOGO_CID, filename: "logo.png", contentType: "image/png", content: Buffer.from([1]) },
};

const CTX = buildTemplateContext({
  asset: "CKY2012.rogersgroupinc.com",
  severity: "critical",
  message: "CKY2012.rogersgroupinc.com is down",
  triggerSummary: "Monitor status is down",
  time: new Date("2026-08-18T15:00:00Z"),
  ruleName: "Asset down",
  assetDetail: { id: "a-1", ipAddress: "10.20.30.40", location: "OU=Company Servers" },
});

/** Compose exactly as notificationRecipientService.buildComposedEmail does. */
function compose(): string {
  return pruneDeadLinks(pruneEmptyDivs(pruneEmptyRows(
    renderNotificationTemplate(DEFAULT_ALERT_HTML, CTX, { html: true, unknown: "blank" }),
  )));
}

describe("renderBrandBlock", () => {
  it("captions an operator's own logo with the app name and subtitle", () => {
    const html = renderBrandBlock({ name: "Rogers Group", subtitle: "Network Management", logo: LOGO }, { html: true });
    expect(html).toContain(`src="cid:${BRAND_LOGO_CID}"`);
    expect(html).toContain('width="150" height="30"');
    expect(html).toContain("Rogers Group");
    expect(html).toContain("Network Management");
  });

  it("prints no name beside the shipped wordmark, but keeps the subtitle", () => {
    // Rule 27: the Polaris art carries the wordmark, so a name beside it says
    // the same thing twice. The subtitle is the operator's own copy either way.
    const html = renderBrandBlock({ name: "", subtitle: "Network Management Tool", logo: LOGO }, { html: true });
    expect(html).toContain(`cid:${BRAND_LOGO_CID}`);
    expect(html).toContain("Network Management Tool");
    expect(html).not.toContain(">Polaris<");
  });

  it("escapes both operator-supplied strings", () => {
    const html = renderBrandBlock({ name: '<script>x</script>', subtitle: 'a & "b"', logo: null }, { html: true });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });

  it("renders nothing at all when there is nothing to say", () => {
    expect(renderBrandBlock({ name: "", subtitle: "", logo: null }, { html: true })).toBe("");
    expect(renderBrandBlock({ name: "", subtitle: "", logo: null }, { html: false })).toBe("");
  });

  it("names the sender in the text body even where the HTML leaves it to the art", () => {
    // A text body has no image, so the alt text (which is always the resolved
    // app name) is the only thing identifying who sent the page.
    const text = renderBrandBlock({ name: "", subtitle: "Network Management Tool", logo: LOGO }, { html: false });
    expect(text).toBe("Polaris — Network Management Tool");
    expect(text).not.toContain("<");
  });
});

describe("fitLogo", () => {
  it("scales a wide wordmark by width and keeps its aspect ratio", () => {
    // The shipped horizontal art is 900x180.
    expect(fitLogo({ width: 900, height: 180 })).toEqual({ width: MAX_LOGO_WIDTH, height: 30 });
  });

  it("scales a square upload by height", () => {
    expect(fitLogo({ width: 512, height: 512 })).toEqual({ width: MAX_LOGO_HEIGHT, height: MAX_LOGO_HEIGHT });
  });

  it("never enlarges a small logo", () => {
    expect(fitLogo({ width: 60, height: 20 })).toEqual({ width: 60, height: 20 });
  });
});

describe("the {brand.header} token", () => {
  it("is deferred, so the compose pass leaves it for delivery", () => {
    expect(isDeferredToken("brand.header")).toBe(true);
    // Prefix, not an enumerated name — the rule that outlived {chart.trigger}.
    expect(isDeferredToken("brand.somethingWeAddNextYear")).toBe(true);
    expect(isDeferredToken("branding")).toBe(false);
    for (const body of [DEFAULT_ALERT_HTML, DEFAULT_ALERT_TEXT]) {
      expect(renderNotificationTemplate(body, CTX, { unknown: "blank" })).toContain("{brand.header}");
    }
  });

  it("is catalogued for the wizard, like every other token in the default body", () => {
    expect(TEMPLATE_VARIABLES.some((v) => v.token === "{brand.header}")).toBe(true);
  });

  it("is found in both default bodies", () => {
    expect(brandTokensIn(DEFAULT_ALERT_TEXT, DEFAULT_ALERT_HTML).has("brand.header")).toBe(true);
    expect(brandTokensIn("no tokens here").size).toBe(0);
  });

  it("removes itself when the block is empty", () => {
    expect(substituteBrandTokens("a{brand.header}b", "")).toBe("ab");
  });
});

describe("the two-column header", () => {
  it("puts the letterhead in a right-aligned cell opposite the headline", () => {
    const html = compose();
    const headerRow = /<td style="vertical-align:top">[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    expect(headerRow).toContain("CKY2012.rogersgroupinc.com");
    expect(headerRow).toContain("Monitor status is down");
    expect(headerRow).toContain("text-align:right");
    // The headline column comes first, the letterhead second — "top right".
    expect(headerRow.indexOf("{asset")).toBeLessThan(headerRow.indexOf("{brand.header}"));
  });

  it("survives pruneEmptyRows both before and after the block is filled", () => {
    // The header is a two-cell row, which is exactly the shape pruneEmptyRows
    // deletes when the second cell is empty — the bug that once closed the card
    // early and put the buttons outside the box. The nested <table> is what
    // fails the pattern at this row instead.
    const composed = compose();
    expect(composed).toContain("CKY2012.rogersgroupinc.com");
    expect(composed).toContain("{brand.header}");

    // An install whose logo can't be read and which blanked both text fields:
    // the block renders empty at delivery, and the headline must still be there.
    const delivered = substituteBrandTokens(composed, "");
    expect(pruneEmptyRows(delivered)).toContain("CKY2012.rogersgroupinc.com");
    expect(pruneEmptyRows(delivered)).toContain("Acknowledge alert");
  });

  it("keeps the card's structure intact — one opening tag per closing tag", () => {
    // The specific failure this guards: a prune that eats a `<table>` opening
    // tag leaves the matching `</table>` to close the 600px card early.
    const html = substituteBrandTokens(compose(), renderBrandBlock({ name: "RGI", subtitle: "NOC", logo: LOGO }, { html: true }));
    expect((html.match(/<table/g) ?? []).length).toBe((html.match(/<\/table>/g) ?? []).length);
    expect((html.match(/<tr[ >]/g) ?? []).length).toBe((html.match(/<\/tr>/g) ?? []).length);
  });

  it("leads the text body with the letterhead and collapses it away when empty", () => {
    const text = renderNotificationTemplate(DEFAULT_ALERT_TEXT, CTX, { unknown: "blank" });
    const filled = pruneEmptyTextLines(substituteBrandTokens(text, "Polaris — Network Management Tool"));
    expect(filled.split("\n")[0]).toBe("Polaris — Network Management Tool");
    const bare = pruneEmptyTextLines(substituteBrandTokens(text, ""));
    expect(bare.split("\n")[0]).toBe("CRITICAL: Monitor status is down");
  });

  it("still ships no remote images — the logo is an inline attachment", () => {
    const html = substituteBrandTokens(compose(), renderBrandBlock({ name: "RGI", subtitle: "NOC", logo: LOGO }, { html: true }));
    expect(html).not.toMatch(/<img[^>]+src="https?:/i);
    expect(html).not.toMatch(/<img[^>]+src="data:/i);
    expect(html).toMatch(/<img[^>]+src="cid:/);
  });
});
