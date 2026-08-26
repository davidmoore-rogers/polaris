/**
 * tests/unit/sidebarThemeToggleDom.test.ts
 *
 * The theme toggle is an always-visible sidebar control again — bottom-left,
 * below Server Settings and above the version line — rather than a row in the
 * page-header account menu. Two things are worth pinning:
 *
 *  - its POSITION in the renderNav template, since "below Server Settings,
 *    above the version" is the whole request and a template is easy to
 *    reorder by accident; and
 *  - the LABEL REPAINT in _setTheme, which only matters for a long-lived
 *    button. The menu row was rebuilt per open, so this had nothing to do
 *    while the toggle lived there and was deleted; a regression would leave
 *    the button reading "Light Mode" after switching to light.
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

const setTheme = new Function(
  [
    extractFn("_getCurrentTheme"),
    extractFn("_sunIcon"),
    extractFn("_moonIcon"),
    extractFn("_setTheme"),
    "return _setTheme;",
  ].join("\n"),
)() as (theme: string) => void;

describe("sidebar theme toggle placement", () => {
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
});

describe("_setTheme", () => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    document.body.innerHTML =
      '<button id="btn-theme-toggle"><svg id="sun"></svg><span>Light Mode</span></button>';
  });

  it("stores the theme on the root element and in localStorage", () => {
    setTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("polaris-theme")).toBe("light");
  });

  it("repaints the label to name the theme it will switch TO next", () => {
    setTheme("light");
    expect(document.querySelector("#btn-theme-toggle span")!.textContent).toBe("Dark Mode");
    setTheme("dark");
    expect(document.querySelector("#btn-theme-toggle span")!.textContent).toBe("Light Mode");
  });

  it("swaps the glyph with the label", () => {
    setTheme("light");
    // outerHTML replacement, so re-query rather than holding the old node.
    expect(document.querySelector("#btn-theme-toggle svg")).not.toBeNull();
    setTheme("dark");
    expect(document.querySelector("#btn-theme-toggle svg")).not.toBeNull();
  });

  it("is a no-op on a page with no toggle rather than throwing", () => {
    document.body.innerHTML = "";
    expect(() => setTheme("light")).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
