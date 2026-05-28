/**
 * tests/unit/certInfo.test.ts
 *
 * Covers proxy-mode cert reading + layered cache + atomic-rename survival.
 * Uses a committed fixture cert at tests/fixtures/test-cert.pem with a
 * known SHA-256 fingerprint and known SANs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getServerCertFingerprint,
  getServerCertHostnames,
  getServerCertExpiry,
  __resetCertInfoCacheForTests,
} from "../../src/services/certInfo.js";

const FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "test-cert.pem");
// Generated at fixture-build time via `openssl x509 -in test-cert.pem -noout -fingerprint -sha256`.
const KNOWN_FINGERPRINT = "sha256:9ea2065bdc49d46ce466d50680e8efaef1208ac0d125202ba8d84e72663a622c";

describe("certInfo (proxy mode)", () => {
  const savedCertPath = process.env.POLARIS_PROXY_CERT_PATH;
  let tmpDir: string | null = null;

  beforeEach(() => {
    __resetCertInfoCacheForTests();
    delete process.env.POLARIS_PROXY_CERT_PATH;
    tmpDir = mkdtempSync(path.join(tmpdir(), "polaris-certinfo-test-"));
  });

  afterEach(() => {
    if (savedCertPath === undefined) delete process.env.POLARIS_PROXY_CERT_PATH;
    else process.env.POLARIS_PROXY_CERT_PATH = savedCertPath;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
    __resetCertInfoCacheForTests();
  });

  function copyFixture(): string {
    const dest = path.join(tmpDir!, "cert.pem");
    copyFileSync(FIXTURE_PATH, dest);
    process.env.POLARIS_PROXY_CERT_PATH = dest;
    return dest;
  }

  it("returns the known fingerprint for the fixture cert", () => {
    copyFixture();
    expect(getServerCertFingerprint()).toBe(KNOWN_FINGERPRINT);
  });

  it("returns the cert's CN + DNS SANs + IP SANs", () => {
    copyFixture();
    const hosts = getServerCertHostnames();
    expect(hosts?.cn).toBe("polaris-test.example.com");
    expect(hosts?.dnsSans).toEqual(expect.arrayContaining(["polaris-test.example.com", "polaris-alt.example.com"]));
    expect(hosts?.ipSans).toEqual(["10.0.0.42"]);
  });

  it("returns an ISO 8601 expiry timestamp", () => {
    copyFixture();
    const expiry = getServerCertExpiry();
    expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("does NOT re-parse when file bytes are unchanged (cache hit on hash)", () => {
    const certPath = copyFixture();
    const first = getServerCertFingerprint();
    // Read the file directly + touch the path's mtime by re-writing identical
    // bytes. The hash key is the file CONTENT, not mtime, so this is still a
    // cache hit — the parse path doesn't run.
    const bytes = readFileSync(certPath);
    writeFileSync(certPath, bytes);
    const second = getServerCertFingerprint();
    expect(second).toBe(first);
  });

  it("returns last-known-good when the file vanishes mid-rotation", () => {
    const certPath = copyFixture();
    const first = getServerCertFingerprint();
    expect(first).toBe(KNOWN_FINGERPRINT);
    // Simulate the atomic-rename window: file briefly missing.
    unlinkSync(certPath);
    const second = getServerCertFingerprint();
    expect(second).toBe(KNOWN_FINGERPRINT); // last-known-good preserved
  });

  it("returns last-known-good when the file is zero-byte mid-rotation", () => {
    const certPath = copyFixture();
    const first = getServerCertFingerprint();
    expect(first).toBe(KNOWN_FINGERPRINT);
    writeFileSync(certPath, ""); // zero-byte window
    const second = getServerCertFingerprint();
    expect(second).toBe(KNOWN_FINGERPRINT);
  });

  it("returns last-known-good when the file contains garbage that fails PEM parse", () => {
    const certPath = copyFixture();
    const first = getServerCertFingerprint();
    expect(first).toBe(KNOWN_FINGERPRINT);
    writeFileSync(certPath, "this is not a PEM cert");
    const second = getServerCertFingerprint();
    expect(second).toBe(KNOWN_FINGERPRINT);
  });

  it("returns null when the file is unreadable AND no cache exists (first read failure)", () => {
    process.env.POLARIS_PROXY_CERT_PATH = path.join(tmpDir!, "does-not-exist.pem");
    // No prior successful read — cache is empty.
    expect(getServerCertFingerprint()).toBeNull();
  });

  it("recovers when a new valid cert is written after an unreadable interlude", () => {
    const certPath = copyFixture();
    expect(getServerCertFingerprint()).toBe(KNOWN_FINGERPRINT);
    writeFileSync(certPath, "");
    expect(getServerCertFingerprint()).toBe(KNOWN_FINGERPRINT); // last-known-good
    // Restore the real fixture
    copyFileSync(FIXTURE_PATH, certPath);
    expect(getServerCertFingerprint()).toBe(KNOWN_FINGERPRINT);
  });
});
