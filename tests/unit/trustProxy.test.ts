/**
 * tests/unit/trustProxy.test.ts
 *
 * Asserts resolveTrustProxy()'s precedence: operator override > proxy-mode
 * auto-default > unset. And asserts it never mutates process.env.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTrustProxy } from "../../src/utils/trustProxy.js";

describe("resolveTrustProxy", () => {
  const savedTrust = process.env.TRUST_PROXY;
  const savedProxy = process.env.POLARIS_PROXY_CERT_PATH;

  beforeEach(() => {
    delete process.env.TRUST_PROXY;
    delete process.env.POLARIS_PROXY_CERT_PATH;
  });

  afterEach(() => {
    if (savedTrust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = savedTrust;
    if (savedProxy === undefined) delete process.env.POLARIS_PROXY_CERT_PATH;
    else process.env.POLARIS_PROXY_CERT_PATH = savedProxy;
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveTrustProxy()).toBeUndefined();
  });

  it("returns the operator value when TRUST_PROXY is set, regardless of proxy mode", () => {
    process.env.TRUST_PROXY = "10.0.0.0/8";
    expect(resolveTrustProxy()).toBe("10.0.0.0/8");

    process.env.POLARIS_PROXY_CERT_PATH = "/etc/polaris-nginx/cert.pem";
    expect(resolveTrustProxy()).toBe("10.0.0.0/8"); // operator override still wins
  });

  it("returns \"1\" (first-hop) by default in proxy mode", () => {
    process.env.POLARIS_PROXY_CERT_PATH = "/etc/polaris-nginx/cert.pem";
    expect(resolveTrustProxy()).toBe("1");
  });

  it("does NOT mutate process.env", () => {
    process.env.POLARIS_PROXY_CERT_PATH = "/etc/polaris-nginx/cert.pem";
    expect(process.env.TRUST_PROXY).toBeUndefined();
    resolveTrustProxy();
    expect(process.env.TRUST_PROXY).toBeUndefined();
  });
});
