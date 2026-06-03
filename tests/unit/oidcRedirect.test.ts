/**
 * tests/unit/oidcRedirect.test.ts — OIDC redirect-URI derivation
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/api/routes/events.js", () => ({ logEvent: vi.fn() }));

import { getRedirectUri } from "../../src/services/oidcAuthService.js";

const ORIGINAL = process.env.POLARIS_PUBLIC_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.POLARIS_PUBLIC_URL;
  else process.env.POLARIS_PUBLIC_URL = ORIGINAL;
});

describe("getRedirectUri", () => {
  it("derives the callback URL from POLARIS_PUBLIC_URL (trailing slash trimmed)", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com/";
    expect(getRedirectUri()).toBe("https://polaris.example.com/api/v1/auth/oidc/callback");
  });

  it("throws a clear error when POLARIS_PUBLIC_URL is unset", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    expect(() => getRedirectUri()).toThrowError(/POLARIS_PUBLIC_URL/);
  });
});
