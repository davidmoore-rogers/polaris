/**
 * tests/unit/httpsRuntime.test.ts
 *
 * Asserts proxy-mode behavior of the listener-half of the former httpsManager:
 *  - getHttpsPort() returns the port parsed from POLARIS_PUBLIC_URL
 *  - isHttpsRunning() returns true in proxy mode (reachability is real)
 *  - isHttpsExternallyManaged() returns true only in proxy mode
 *  - httpsRedirectMiddleware is a pass-through in proxy mode
 *  - initHttps + applyHttps are inert in proxy mode (no listener binds)
 *
 * Does NOT test the Node-HTTPS listener path — that requires real cert/key
 * material + a free port + database mocking, which is heavier integration
 * test territory. The unit-level contract here is the proxy-mode branch.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import {
  applyHttps,
  getHttpsPort,
  httpsRedirectMiddleware,
  initHttps,
  isHttpsExternallyManaged,
  isHttpsRunning,
} from "../../src/httpsRuntime.js";

describe("httpsRuntime in proxy mode", () => {
  const savedCert = process.env.POLARIS_PROXY_CERT_PATH;
  const savedUrl = process.env.POLARIS_PUBLIC_URL;
  let tmpDir: string | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "polaris-httpsruntime-test-"));
    const certPath = path.join(tmpDir, "cert.pem");
    writeFileSync(certPath, "placeholder");
    process.env.POLARIS_PROXY_CERT_PATH = certPath;
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
  });

  afterEach(() => {
    if (savedCert === undefined) delete process.env.POLARIS_PROXY_CERT_PATH;
    else process.env.POLARIS_PROXY_CERT_PATH = savedCert;
    if (savedUrl === undefined) delete process.env.POLARIS_PUBLIC_URL;
    else process.env.POLARIS_PUBLIC_URL = savedUrl;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("getHttpsPort() returns 443 when POLARIS_PUBLIC_URL has no explicit port", () => {
    expect(getHttpsPort()).toBe(443);
  });

  it("getHttpsPort() returns the explicit port from POLARIS_PUBLIC_URL", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com:8443";
    expect(getHttpsPort()).toBe(8443);
  });

  it("isHttpsRunning() returns true in proxy mode (HTTPS reachability is real)", () => {
    expect(isHttpsRunning()).toBe(true);
  });

  it("isHttpsExternallyManaged() returns true in proxy mode", () => {
    expect(isHttpsExternallyManaged()).toBe(true);
  });

  it("isHttpsExternallyManaged() returns false when proxy mode is off", () => {
    delete process.env.POLARIS_PROXY_CERT_PATH;
    expect(isHttpsExternallyManaged()).toBe(false);
  });

  it("initHttps() is a no-op in proxy mode (no listener binds)", () => {
    // Pass a fake "express app" — if initHttps tried to mount on it, the test
    // would explode. Proxy mode early-returns before touching it.
    const fakeApp = {} as any;
    expect(() => initHttps(fakeApp)).not.toThrow();
  });

  it("applyHttps() returns the externally-managed result in proxy mode", async () => {
    const result = await applyHttps();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/external proxy/i);
  });

  it("httpsRedirectMiddleware is a pass-through in proxy mode", () => {
    let nextCalled = false;
    const req = { secure: false, headers: {}, path: "/foo", originalUrl: "/foo" } as unknown as Request;
    const res = {} as Response;
    const next: NextFunction = () => { nextCalled = true; };
    httpsRedirectMiddleware(req, res, next);
    expect(nextCalled).toBe(true);
  });
});
