/**
 * tests/unit/entraClientCredentials.test.ts
 */

import { describe, it, expect } from "vitest";
import { buildClientCredentialsTokenRequest } from "../../src/utils/entraClientCredentials.js";

describe("buildClientCredentialsTokenRequest", () => {
  it("builds the v2.0 token URL with an encoded tenant", () => {
    const { url } = buildClientCredentialsTokenRequest({
      tenantId: "contoso.com/odd", clientId: "c", clientSecret: "s", scope: "x/.default",
    });
    expect(url).toBe("https://login.microsoftonline.com/contoso.com%2Fodd/oauth2/v2.0/token");
  });

  it("carries the four grant fields, scope verbatim", () => {
    const { body } = buildClientCredentialsTokenRequest({
      tenantId: "t", clientId: "client-1", clientSecret: "sec ret", scope: "https://graph.microsoft.com/.default",
    });
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("client_secret")).toBe("sec ret");
    expect(body.get("scope")).toBe("https://graph.microsoft.com/.default");
  });
});

describe("buildClientCredentialsTokenRequest — non-Graph scopes", () => {
  it("round-trips the Azure Resource Manager scope verbatim", () => {
    // Azure Arc reuses this helper rather than forking it; only the scope
    // differs from the Graph caller. This case documents that.
    const { url, body } = buildClientCredentialsTokenRequest({
      tenantId: "00000000-0000-0000-0000-000000000000",
      clientId: "11111111-1111-1111-1111-111111111111",
      clientSecret: "s",
      scope: "https://management.azure.com/.default",
    });
    expect(url).toContain("/00000000-0000-0000-0000-000000000000/oauth2/v2.0/token");
    expect(body.get("scope")).toBe("https://management.azure.com/.default");
    expect(body.get("grant_type")).toBe("client_credentials");
  });
});
