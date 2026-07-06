/**
 * tests/unit/dashConfig.test.ts
 *
 * Dash-listener config resolution: port parsing/fallbacks, and the bind
 * rule (loopback forced in proxy mode; POLARIS_DASH_BIND honored otherwise).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveDashPort, resolveDashBind, DEFAULT_DASH_PORT } from "../../src/utils/dashConfig.js";

const ENV_KEYS = ["POLARIS_DASH_PORT", "POLARIS_DASH_BIND", "POLARIS_PROXY_CERT_PATH"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveDashPort", () => {
  it("defaults to 3001 when unset or blank", () => {
    expect(resolveDashPort()).toBe(DEFAULT_DASH_PORT);
    process.env.POLARIS_DASH_PORT = "  ";
    expect(resolveDashPort()).toBe(DEFAULT_DASH_PORT);
  });

  it("honors a valid port", () => {
    process.env.POLARIS_DASH_PORT = "8085";
    expect(resolveDashPort()).toBe(8085);
  });

  it("falls back to the default on non-numeric or out-of-range values", () => {
    for (const bad of ["abc", "0", "-1", "65536", "80.5"]) {
      process.env.POLARIS_DASH_PORT = bad;
      expect(resolveDashPort()).toBe(DEFAULT_DASH_PORT);
    }
  });
});

describe("resolveDashBind", () => {
  it("forces loopback in proxy mode regardless of POLARIS_DASH_BIND", () => {
    process.env.POLARIS_PROXY_CERT_PATH = "/etc/polaris-nginx/cert.pem";
    process.env.POLARIS_DASH_BIND = "0.0.0.0";
    expect(resolveDashBind()).toBe("127.0.0.1");
  });

  it("honors POLARIS_DASH_BIND outside proxy mode", () => {
    process.env.POLARIS_DASH_BIND = "192.168.1.10";
    expect(resolveDashBind()).toBe("192.168.1.10");
  });

  it("defaults to all interfaces outside proxy mode", () => {
    expect(resolveDashBind()).toBe("0.0.0.0");
  });
});
