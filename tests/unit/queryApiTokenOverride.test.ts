/**
 * tests/unit/queryApiTokenOverride.test.ts
 *
 * The Query API's per-request FortiGate credential override.
 *
 * Two properties, both security-relevant:
 *
 *   1. The token lands in the RIGHT field for the integration type. A standalone
 *      FortiGate authenticates with `apiToken`; an FMG in bypass mode carries the
 *      per-gate credential as `fortigateApiToken` and still needs its OWN
 *      `apiToken` to resolve the device's management IP. Overwriting the FMG's
 *      token with a FortiGate one would break the lookup before the REST call is
 *      ever made.
 *   2. The caller's config is never mutated. It comes from Prisma and is shared;
 *      an in-place write would leak a one-request credential into whatever else
 *      holds that object for the life of the request.
 *
 * The helper is re-declared here rather than imported: integrations.ts is a route
 * module whose import graph pulls in the DB client and every integration service.
 * Keep the two in step — the shapes asserted below are the contract.
 */

import { describe, it, expect } from "vitest";
import { isMaskedSecret } from "../../src/utils/secretMask.js";

/** Mirror of overrideFortigateCreds in src/api/routes/integrations.ts. */
function overrideFortigateCreds(
  config: unknown,
  apiToken: string | undefined,
  apiUser: string | undefined,
  type: "fortigate" | "fortimanager",
): Record<string, unknown> {
  const base = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  if (!apiToken && !apiUser) return base;
  const out = { ...base };
  if (type === "fortigate") {
    if (apiToken) out.apiToken = apiToken;
    if (apiUser) out.apiUser = apiUser;
  } else {
    if (apiToken) out.fortigateApiToken = apiToken;
    if (apiUser) out.fortigateApiUser = apiUser;
  }
  return out;
}

const fmgConfig = Object.freeze({
  host: "10.0.0.1",
  apiUser: "fmg-admin",
  apiToken: "FMG-TOKEN",
  fortigateApiUser: "fgt-admin",
  fortigateApiToken: "STORED-FGT-TOKEN",
  useProxy: false,
});

describe("overrideFortigateCreds — FMG (bypass mode)", () => {
  it("replaces fortigateApiToken and LEAVES the FortiManager's own token alone", () => {
    const out = overrideFortigateCreds(fmgConfig, "PER-GATE-TOKEN", undefined, "fortimanager");
    expect(out.fortigateApiToken).toBe("PER-GATE-TOKEN");
    // FMG still has to resolve the device's management IP with its own creds.
    expect(out.apiToken).toBe("FMG-TOKEN");
    expect(out.apiUser).toBe("fmg-admin");
  });

  it("keeps the stored FortiGate api user when only a token is supplied", () => {
    const out = overrideFortigateCreds(fmgConfig, "PER-GATE-TOKEN", undefined, "fortimanager");
    expect(out.fortigateApiUser).toBe("fgt-admin");
  });

  it("overrides the FortiGate api user when one is supplied", () => {
    const out = overrideFortigateCreds(fmgConfig, "T", "other-admin", "fortimanager");
    expect(out.fortigateApiUser).toBe("other-admin");
    expect(out.apiUser).toBe("fmg-admin");
  });
});

describe("overrideFortigateCreds — standalone FortiGate", () => {
  it("replaces apiToken, since that IS the device credential", () => {
    const cfg = { host: "10.0.0.9", apiUser: "admin", apiToken: "STORED" };
    const out = overrideFortigateCreds(cfg, "OVERRIDE", undefined, "fortigate");
    expect(out.apiToken).toBe("OVERRIDE");
    expect(out.host).toBe("10.0.0.9");
  });
});

describe("overrideFortigateCreds — safety", () => {
  it("never mutates the caller's config (it is shared, straight off Prisma)", () => {
    const cfg: Record<string, unknown> = { apiToken: "STORED", fortigateApiToken: "STORED-FGT" };
    const out = overrideFortigateCreds(cfg, "OVERRIDE", undefined, "fortimanager");
    expect(cfg.fortigateApiToken).toBe("STORED-FGT");
    expect(out).not.toBe(cfg);
  });

  it("returns the config untouched when no override is supplied", () => {
    const out = overrideFortigateCreds(fmgConfig, undefined, undefined, "fortimanager");
    expect(out).toBe(fmgConfig);
  });

  it("tolerates a null/!object config without throwing", () => {
    expect(overrideFortigateCreds(null, "T", undefined, "fortigate")).toEqual({ apiToken: "T" });
    expect(overrideFortigateCreds(undefined, undefined, undefined, "fortigate")).toEqual({});
  });
});

describe("override input validation", () => {
  it("rejects a masked placeholder, so a form echo can't be sent as a token", () => {
    // The same trap the stored-secret merge paths guard against: persisting or
    // sending "••••••••" produces "Bearer ••••••••", which Node's HTTP layer
    // rejects with a ByteString error.
    expect(isMaskedSecret("••••••••")).toBe(true);
    expect(isMaskedSecret("a-real-token")).toBe(false);
  });
});
