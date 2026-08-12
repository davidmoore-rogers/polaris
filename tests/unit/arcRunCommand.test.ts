/**
 * tests/unit/arcRunCommand.test.ts
 *
 * dispatchRunCommand itself — the ARM write. arcPublish.test.ts mocks this
 * function to test the orchestration around it, so the safety-critical
 * behaviour inside it is pinned here:
 *
 *   - the right script goes to the right OS (sending PowerShell through a
 *     shell as root is the failure mode)
 *   - an undeterminable OS is SKIPPED, never guessed
 *   - one machine's failure does not abort or silently shorten the batch
 *   - the opt-in flag is enforced at the lowest level, not just at the service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { dispatchRunCommand } from "../../src/services/azureArcService.js";

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  };
}
const TOKEN_OK = res(200, { access_token: "tok", expires_in: 3600 });

let fetchMock: ReturnType<typeof vi.fn>;
let cfgSeq = 0;
let CONFIG: any;

/** Requests that were NOT the token fetch, in call order. */
function armCalls() {
  return fetchMock.mock.calls
    .filter(([u]) => !String(u).includes("login.microsoftonline.com"))
    .map(([url, init]) => ({ url: String(url), init }));
}

beforeEach(() => {
  // Fresh clientId per test: azureArcService caches tokens per tenant:client.
  CONFIG = { tenantId: "t", clientId: `c${++cfgSeq}`, clientSecret: "s", allowRunCommand: true };
  fetchMock = vi.fn(async (url: string) =>
    String(url).includes("login.microsoftonline.com") ? TOKEN_OK : res(201, { id: "rc" }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function target(over: Partial<any> = {}) {
  return {
    armId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.HybridCompute/machines/m",
    name: "m", subscriptionId: "sub-1", resourceGroup: "rg-1", azureRegion: "eastus",
    osType: "linux", status: "Connected", ...over,
  };
}
const SCRIPTS = { windows: "WIN-BODY", linux: "LIN-BODY" };
const OPTS = { runCommandName: "polaris-ssh-onboarding" };

describe("opt-in gate", () => {
  it("refuses before touching the network when the flag is off", async () => {
    await expect(
      dispatchRunCommand({ ...CONFIG, allowRunCommand: false }, [target()], SCRIPTS, OPTS),
    ).rejects.toThrow(/not enabled/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the flag is merely truthy rather than true", async () => {
    await expect(
      dispatchRunCommand({ ...CONFIG, allowRunCommand: "yes" }, [target()], SCRIPTS, OPTS),
    ).rejects.toThrow(/not enabled/i);
  });
});

describe("per-OS script routing", () => {
  it("sends the shell script to Linux and PowerShell to Windows", async () => {
    const out = await dispatchRunCommand(
      CONFIG,
      [target({ name: "lin", osType: "Linux" }), target({ name: "win", osType: "Windows" })],
      SCRIPTS, OPTS,
    );
    expect(out.every((r) => r.dispatched)).toBe(true);

    const bodies = armCalls().map((c) => JSON.parse(c.init.body));
    const scripts = bodies.map((b) => b.properties.source.script);
    expect(scripts).toContain("LIN-BODY");
    expect(scripts).toContain("WIN-BODY");
    // The Linux machine must not have received PowerShell.
    const linCall = armCalls().find((c) => c.url.includes("/machines/lin"))!;
    expect(JSON.parse(linCall.init.body).properties.source.script).toBe("LIN-BODY");
  });

  it("SKIPS a machine whose OS is unknown instead of guessing", async () => {
    const out = await dispatchRunCommand(CONFIG, [target({ osType: null })], SCRIPTS, OPTS);
    expect(out[0]).toMatchObject({ dispatched: false });
    expect(out[0].skipped).toMatch(/unknown OS/i);
    expect(armCalls()).toHaveLength(0); // nothing was executed
  });

  it("skips a machine with no Azure region rather than sending an invalid body", async () => {
    const out = await dispatchRunCommand(CONFIG, [target({ azureRegion: "" })], SCRIPTS, OPTS);
    expect(out[0].skipped).toMatch(/region/i);
    expect(armCalls()).toHaveLength(0);
  });
});

describe("request shape", () => {
  it("PUTs to the machine's runCommands resource with its own scope", async () => {
    await dispatchRunCommand(
      CONFIG, [target({ name: "srv1", subscriptionId: "sub-9", resourceGroup: "rg-9" })], SCRIPTS, OPTS,
    );
    const c = armCalls()[0];
    expect(c.init.method).toBe("PUT");
    expect(c.url).toContain("/subscriptions/sub-9/resourceGroups/rg-9/");
    expect(c.url).toContain("/providers/Microsoft.HybridCompute/machines/srv1/runCommands/polaris-ssh-onboarding");
    expect(c.url).toMatch(/api-version=/);
  });

  it("carries the machine region and lets ARM own execution", async () => {
    await dispatchRunCommand(CONFIG, [target({ azureRegion: "westeurope" })], SCRIPTS, OPTS);
    const body = JSON.parse(armCalls()[0].init.body);
    expect(body.location).toBe("westeurope");
    // asyncExecution keeps the PUT fast — we report dispatch, not results.
    expect(body.properties.asyncExecution).toBe(true);
  });
});

describe("partial failure", () => {
  it("keeps going after one machine fails and reports every target", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("login.microsoftonline.com")) return TOKEN_OK;
      if (String(url).includes("/machines/bad/")) return res(403, { error: { message: "denied" } });
      return res(201, { id: "rc" });
    });

    const out = await dispatchRunCommand(
      CONFIG,
      [target({ name: "ok1" }), target({ name: "bad" }), target({ name: "ok2" })],
      SCRIPTS, OPTS,
    );

    expect(out).toHaveLength(3);
    expect(out.filter((r) => r.dispatched).map((r) => r.name).sort()).toEqual(["ok1", "ok2"]);
    const bad = out.find((r) => r.name === "bad")!;
    expect(bad.dispatched).toBe(false);
    expect(bad.error).toMatch(/denied|403/i);
  });

  it("returns results in target order so the caller can zip them back", async () => {
    const targets = ["a", "b", "c"].map((n) => target({ name: n }));
    const out = await dispatchRunCommand(CONFIG, targets, SCRIPTS, OPTS);
    expect(out.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("handles an empty target list without calling out", async () => {
    const out = await dispatchRunCommand(CONFIG, [], SCRIPTS, OPTS);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
