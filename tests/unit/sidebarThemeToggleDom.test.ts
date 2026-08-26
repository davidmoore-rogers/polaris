/**
 * tests/unit/sidebarThemeToggleDom.test.ts
 *
 * The theme picker is an always-visible sidebar control — bottom-left, below
 * Server Settings and above the version line — rather than a row in the
 * page-header account menu. Three things are worth pinning:
 *
 *  - its POSITION in the renderNav template, since "below Server Settings,
 *    above the version" is the whole request and a template is easy to
 *    reorder by accident;
 *  - the LABEL REPAINT in _setTheme, which only matters for a long-lived
 *    button. The menu row was rebuilt per open, so this had nothing to do
 *    while the toggle lived there and was deleted; a regression would leave
 *    the button naming the theme the operator just switched away from; and
 *  - the FALLBACK, which is what a browser holding the retired `dark`/`light`
 *    id lands on after the three-theme cutover. Trusting a saved value that
 *    names no token block would render the whole install unstyled.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");

function extractFn(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  let depth = 0;
  let i = APP_JS.indexOf("{", start);
  for (; i < APP_JS.length; i++) {
    if (APP_JS[i] === "{") depth++;
    else if (APP_JS[i] === "}") { depth--; if (depth === 0) break; }
  }
  return APP_JS.slice(start, i + 1);
}

/** The THEMES array literal, lifted verbatim so the test can't drift from it. */
function extractThemes(): string {
  const start = APP_JS.indexOf("var THEMES = [");
  const end = APP_JS.indexOf("];", start);
  if (start < 0 || end < 0) throw new Error("THEMES not found in app.js");
  return APP_JS.slice(start, end + 2);
}

const harness = [
  extractThemes(),
  'var DEFAULT_THEME = "nightfall";',
  extractFn("_getTheme"),
  extractFn("_getCurrentTheme"),
  extractFn("isLightTheme"),
  extractFn("_setTheme"),
  extractFn("_sunIcon"),
  extractFn("_sunriseIcon"),
  extractFn("_starIcon"),
  "return { setTheme: _setTheme, isLightTheme: isLightTheme, THEMES: THEMES };",
].join("\n");

const api = new Function(harness)() as {
  setTheme: (theme: string) => void;
  isLightTheme: (id?: string) => boolean;
  THEMES: Array<{ id: string; label: string; family: string }>;
};

describe("sidebar theme picker placement", () => {
  it("renders the button between the Server Settings link and the version line", () => {
    const serverSettings = APP_JS.indexOf('href="/server-settings.html" class="sidebar-bottom-link');
    const toggle = APP_JS.indexOf('id="btn-theme-toggle"');
    const version = APP_JS.indexOf('<div id="sidebar-version"');
    expect(serverSettings).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(serverSettings);
    expect(version).toBeGreaterThan(toggle);
  });

  it("wires the click handler in renderNav", () => {
    expect(APP_JS).toContain('document.getElementById("btn-theme-toggle")');
  });

  it("opens the full theme menu rather than flipping between two", () => {
    expect(APP_JS).toContain("openThemeMenu(themeBtn)");
  });
});

describe("THEMES", () => {
  it("lists morning, noon and nightfall in day order", () => {
    expect(api.THEMES.map((t) => t.id)).toEqual(["morning", "noon", "nightfall"]);
  });

  it("puts morning and noon in the daylight family and nightfall in the dark one", () => {
    expect(api.isLightTheme("morning")).toBe(true);
    expect(api.isLightTheme("noon")).toBe(true);
    expect(api.isLightTheme("nightfall")).toBe(false);
  });

  it("treats the retired dark/light ids as unknown, not as themes", () => {
    // They resolve to DEFAULT_THEME (nightfall), so a browser carrying one
    // lands on a real theme rather than on an unstyled page.
    expect(api.isLightTheme("light")).toBe(false);
    expect(api.isLightTheme("dark")).toBe(false);
  });
});

describe("_setTheme", () => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-theme", "nightfall");
    document.body.innerHTML =
      '<button id="btn-theme-toggle"><svg id="star"></svg><span>Nightfall</span></button>';
  });

  it("stores the theme on the root element and in localStorage", () => {
    api.setTheme("morning");
    expect(document.documentElement.getAttribute("data-theme")).toBe("morning");
    expect(localStorage.getItem("polaris-theme")).toBe("morning");
  });

  it("falls back to nightfall rather than trusting an unrecognized id", () => {
    api.setTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("nightfall");
    expect(localStorage.getItem("polaris-theme")).toBe("nightfall");
  });

  it("repaints the label to name the CURRENT theme", () => {
    api.setTheme("morning");
    expect(document.querySelector("#btn-theme-toggle span")!.textContent).toBe("Morning");
    api.setTheme("noon");
    expect(document.querySelector("#btn-theme-toggle span")!.textContent).toBe("Noon");
    api.setTheme("nightfall");
    expect(document.querySelector("#btn-theme-toggle span")!.textContent).toBe("Nightfall");
  });

  it("swaps the glyph with the label", () => {
    api.setTheme("morning");
    // outerHTML replacement, so re-query rather than holding the old node.
    expect(document.querySelector("#btn-theme-toggle svg")).not.toBeNull();
    api.setTheme("nightfall");
    expect(document.querySelector("#btn-theme-toggle svg")).not.toBeNull();
  });

  it("announces the change on document so cached palettes can repaint", () => {
    let detail: { theme: string; family: string } | null = null;
    document.addEventListener("themechange", (e) => {
      detail = (e as CustomEvent).detail;
    });
    api.setTheme("noon");
    expect(detail).toEqual({ theme: "noon", family: "light" });
  });

  it("is a no-op on a page with no picker rather than throwing", () => {
    document.body.innerHTML = "";
    expect(() => api.setTheme("morning")).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("morning");
  });
});
