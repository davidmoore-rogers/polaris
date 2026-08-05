/**
 * tests/unit/publicUrl.test.ts
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getPublicUrlPort, deriveNginxServerName, derivePolarisPort } from "../../src/utils/publicUrl.js";

const savedPublicUrl = process.env.POLARIS_PUBLIC_URL;
const savedPort = process.env.PORT;

beforeEach(() => {
  delete process.env.POLARIS_PUBLIC_URL;
  delete process.env.PORT;
});

afterAll(() => {
  if (savedPublicUrl === undefined) delete process.env.POLARIS_PUBLIC_URL;
  else process.env.POLARIS_PUBLIC_URL = savedPublicUrl;
  if (savedPort === undefined) delete process.env.PORT;
  else process.env.PORT = savedPort;
});

describe("getPublicUrlPort", () => {
  it("returns null when unset", () => {
    expect(getPublicUrlPort()).toBeNull();
  });
  it("returns the explicit port", () => {
    process.env.POLARIS_PUBLIC_URL = "https://x.example.com:8443";
    expect(getPublicUrlPort()).toBe(8443);
  });
  it("defaults https to 443 and http to 80", () => {
    process.env.POLARIS_PUBLIC_URL = "https://x.example.com";
    expect(getPublicUrlPort()).toBe(443);
    process.env.POLARIS_PUBLIC_URL = "http://x.example.com";
    expect(getPublicUrlPort()).toBe(80);
  });
  it("returns null on a malformed URL", () => {
    process.env.POLARIS_PUBLIC_URL = "not a url";
    expect(getPublicUrlPort()).toBeNull();
  });
});

describe("deriveNginxServerName", () => {
  it("uses POLARIS_PUBLIC_URL's hostname", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.corp.example:8443/base";
    expect(deriveNginxServerName()).toBe("polaris.corp.example");
  });
  it("falls back to the placeholder when unset or malformed", () => {
    expect(deriveNginxServerName()).toBe("polaris.example.com");
    process.env.POLARIS_PUBLIC_URL = "not a url";
    expect(deriveNginxServerName()).toBe("polaris.example.com");
  });
});

describe("derivePolarisPort", () => {
  it("defaults to 3000 when PORT is unset", () => {
    expect(derivePolarisPort()).toBe(3000);
  });
  it("uses a valid PORT", () => {
    process.env.PORT = "8080";
    expect(derivePolarisPort()).toBe(8080);
  });
  it("falls back to 3000 on junk or out-of-range values", () => {
    for (const bad of ["abc", "0", "-1", "70000", "3.5"]) {
      process.env.PORT = bad;
      expect(derivePolarisPort()).toBe(3000);
    }
  });
});
