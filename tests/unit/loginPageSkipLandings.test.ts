/**
 * tests/unit/loginPageSkipLandings.test.ts
 *
 * "Skip login page" now redirects the bare /login.html to SSO, so every
 * surface that deliberately LANDS on the form has to say why. This pins the
 * three sides of that contract at the source level (the DB-backed redirect
 * itself is exercised by tests/integration/loginPageSkip.test.ts):
 *
 *  - the desktop logout landings carry `?signed_out=1` — without it a silent
 *    prompt=none provider signs the operator straight back in and Logout
 *    looks broken;
 *  - the Session tab's hint names `/login.html?local=1`, the anti-lockout
 *    path (an admin reading the hint during an IdP outage must be told the
 *    key, since the bare URL no longer draws the form);
 *  - app.ts lets exactly those keys plus `?error=` through — `error` because
 *    every SSO failure route redirects to /login.html?error=…, and redirecting
 *    that again would ping-pong with the IdP forever.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf-8");

describe("desktop logout landings", () => {
  const appJs = read("public", "js", "app.js");

  it("every app.js navigation to the login page carries ?signed_out=1", () => {
    const landings = appJs.match(/window\.location\.href = "\/login\.html[^"]*"/g) ?? [];
    expect(landings.length).toBeGreaterThanOrEqual(2); // account menu + inactivity timer
    for (const l of landings) expect(l).toContain("/login.html?signed_out=1");
  });

  it("api.js 401 redirects stay BARE so an expired session re-enters SSO silently", () => {
    const apiJs = read("public", "js", "api.js");
    const landings = apiJs.match(/window\.location\.href = "\/login\.html[^"]*"/g) ?? [];
    expect(landings.length).toBeGreaterThan(0);
    for (const l of landings) expect(l).toBe('window.location.href = "/login.html"');
  });
});

describe("the anti-lockout path is named where an admin will read it", () => {
  it("the Session tab hint points at /login.html?local=1", () => {
    const usersJs = read("public", "js", "users.js");
    expect(usersJs).toContain("<code>/login.html?local=1</code>");
  });
});

describe("app.ts form-drawing query keys", () => {
  const appTs = read("src", "app.ts");

  it("declares exactly error, signed_out and local", () => {
    const m = appTs.match(/const LOGIN_FORM_QUERY_KEYS = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const keys = m![1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean).sort();
    expect(keys).toEqual(["error", "local", "signed_out"]);
  });

  it("every SSO failure route lands on /login.html WITH ?error= (the anti-loop key)", () => {
    const authTs = read("src", "api", "routes", "auth.ts");
    const landings = authTs.match(/redirect\((["`])\/login\.html[^"`]*\1\)/g) ?? [];
    expect(landings.length).toBeGreaterThan(5);
    for (const l of landings) expect(l).toContain("/login.html?error=");
  });

  it("the server-side idle logout lands with ?signed_out=1", () => {
    expect(appTs).toContain('res.redirect("/login.html?signed_out=1")');
  });
});
