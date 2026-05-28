/**
 * tests/unit/runtimeConfig.test.ts
 *
 * Asserts validateRuntimeConfiguration() fails fast on proxy-mode
 * misconfiguration with actionable error messages.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateRuntimeConfiguration } from "../../src/utils/runtimeConfig.js";

describe("validateRuntimeConfiguration", () => {
  const savedCert = process.env.POLARIS_PROXY_CERT_PATH;
  const savedUrl = process.env.POLARIS_PUBLIC_URL;
  let tmpDir: string | null = null;

  beforeEach(() => {
    delete process.env.POLARIS_PROXY_CERT_PATH;
    delete process.env.POLARIS_PUBLIC_URL;
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

  function makeCertFile(): string {
    tmpDir = mkdtempSync(path.join(tmpdir(), "polaris-runtimeconfig-test-"));
    const certPath = path.join(tmpDir, "cert.pem");
    writeFileSync(certPath, "placeholder-not-real-pem");
    return certPath;
  }

  it("passes silently when proxy mode is off", () => {
    expect(() => validateRuntimeConfiguration()).not.toThrow();
  });

  it("throws when POLARIS_PROXY_CERT_PATH is set but POLARIS_PUBLIC_URL is missing", () => {
    process.env.POLARIS_PROXY_CERT_PATH = makeCertFile();
    expect(() => validateRuntimeConfiguration()).toThrow(/POLARIS_PUBLIC_URL is missing/);
  });

  it("throws when POLARIS_PUBLIC_URL is not a valid URL", () => {
    process.env.POLARIS_PROXY_CERT_PATH = makeCertFile();
    process.env.POLARIS_PUBLIC_URL = "not-a-url";
    expect(() => validateRuntimeConfiguration()).toThrow(/not a valid URL/);
  });

  it("throws when POLARIS_PUBLIC_URL uses http: instead of https:", () => {
    process.env.POLARIS_PROXY_CERT_PATH = makeCertFile();
    process.env.POLARIS_PUBLIC_URL = "http://polaris.example.com";
    expect(() => validateRuntimeConfiguration()).toThrow(/must use https:/);
  });

  it("throws when POLARIS_PROXY_CERT_PATH points to a file that doesn't exist", () => {
    process.env.POLARIS_PROXY_CERT_PATH = "/nonexistent/cert.pem";
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(() => validateRuntimeConfiguration()).toThrow(/does not exist/);
  });

  it("passes when both env vars are well-formed and the cert file exists", () => {
    process.env.POLARIS_PROXY_CERT_PATH = makeCertFile();
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(() => validateRuntimeConfiguration()).not.toThrow();
  });

  it("accepts explicit port in POLARIS_PUBLIC_URL", () => {
    process.env.POLARIS_PROXY_CERT_PATH = makeCertFile();
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com:8443";
    expect(() => validateRuntimeConfiguration()).not.toThrow();
  });
});
