/**
 * tests/unit/role.test.ts — process-role capability matrix + env parsing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRole, roleConfig, __resetRoleForTests, type PolarisRole } from "../../src/utils/role.js";

const ORIGINAL = process.env.POLARIS_ROLE;

beforeEach(() => { __resetRoleForTests(); });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.POLARIS_ROLE;
  else process.env.POLARIS_ROLE = ORIGINAL;
  __resetRoleForTests();
});

describe("getRole — env parsing", () => {
  it("defaults to 'all' when POLARIS_ROLE is unset", () => {
    delete process.env.POLARIS_ROLE;
    expect(getRole()).toBe("all");
  });

  it("accepts the known roles (case-insensitive, trimmed)", () => {
    for (const r of ["web", "monitor", "discovery", "all"]) {
      __resetRoleForTests();
      process.env.POLARIS_ROLE = `  ${r.toUpperCase()}  `;
      expect(getRole()).toBe(r as PolarisRole);
    }
  });

  it("falls back to 'all' on an unrecognized value", () => {
    process.env.POLARIS_ROLE = "frobnicate";
    expect(getRole()).toBe("all");
  });

  it("caches the first resolution", () => {
    process.env.POLARIS_ROLE = "web";
    expect(getRole()).toBe("web");
    process.env.POLARIS_ROLE = "monitor"; // ignored — cached
    expect(getRole()).toBe("web");
  });
});

describe("roleConfig — capability matrix", () => {
  it("all = every capability on (single-process default)", () => {
    expect(roleConfig("all")).toMatchObject({
      role: "all",
      runsHttp: true,
      runsMonitorConsumers: true,
      runsDiscoveryConsumers: true,
      runsSchedulers: true,
      runsMigrations: true,
      runsWriteBuffers: true,
    });
  });

  it("web = HTTP + schedulers + migrations + write buffers (ingests agent samples)", () => {
    expect(roleConfig("web")).toMatchObject({
      runsHttp: true,
      runsSchedulers: true,
      runsMigrations: true,
      runsMonitorConsumers: false,
      runsDiscoveryConsumers: false,
      // The Polaris Agent /samples + /probe-now endpoints live on the HTTP
      // listener and enqueue into the sample/probe-patch buffers, so the web
      // role MUST run the flush tick or agent-sourced rows never persist.
      runsWriteBuffers: true,
    });
  });

  it("monitor = monitor consumers + write buffers only", () => {
    expect(roleConfig("monitor")).toMatchObject({
      runsMonitorConsumers: true,
      runsWriteBuffers: true,
      runsHttp: false,
      runsSchedulers: false,
      runsMigrations: false,
      runsDiscoveryConsumers: false,
    });
  });

  it("discovery = discovery consumer only", () => {
    expect(roleConfig("discovery")).toMatchObject({
      runsDiscoveryConsumers: true,
      runsHttp: false,
      runsMonitorConsumers: false,
      runsSchedulers: false,
      runsMigrations: false,
      runsWriteBuffers: false,
    });
  });

  it("pins singleton schedulers + migrations to exactly one role (web/all)", () => {
    const rolesRunningSchedulers = (["all", "web", "monitor", "discovery"] as PolarisRole[])
      .filter((r) => roleConfig(r).runsSchedulers);
    expect(rolesRunningSchedulers).toEqual(["all", "web"]);
    // migrations track schedulers (both control-plane)
    for (const r of ["all", "web", "monitor", "discovery"] as PolarisRole[]) {
      expect(roleConfig(r).runsMigrations).toBe(roleConfig(r).runsSchedulers);
    }
  });
});
