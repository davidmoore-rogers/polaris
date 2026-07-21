/**
 * tests/unit/agentlessProcessService.test.ts
 *
 * Pure-parser coverage for the agentless processes-stream collectors:
 *   - parseLinuxPs (fixture `ps -eo pid=,pcpu=,rss=,etimes=,user:32=,comm=`)
 *   - aggregatePsRows / telemetryFromPsRows (agent-parity aggregation)
 *   - buildLinuxSsCommand (on-host filtering + shell-safety rejection)
 *   - parseLinuxSs (fixture `ss -tunapH` lines: v4/v6 brackets, wildcards,
 *     multi-owner users:(...) tokens)
 *   - parseWindowsProcessJson / parseWindowsConnectionsJson (numeric + string
 *     TcpState enum forms, pid→name join)
 *   - buildConnectionRows (direction heuristic, ephemeral-port drop, loopback
 *     peer skip, TIME-WAIT skip, mapped-name filter)
 */

import { describe, it, expect } from "vitest";

import {
  parseLinuxPs,
  aggregatePsRows,
  telemetryFromPsRows,
  buildLinuxSsCommand,
  parseLinuxSs,
  parseWindowsProcessJson,
  buildWindowsConnectionsScript,
  parseWindowsConnectionsJson,
  buildConnectionRows,
  isShellSafeProcessName,
  type RawSocketRow,
} from "../../src/services/agentlessProcessService.js";

const NOW = Date.UTC(2026, 6, 21, 12, 0, 0);

describe("parseLinuxPs", () => {
  const fixture = [
    "      1  0.0 11836   86400 root     systemd",
    "   1234  2.5 204800  3600 www-data nginx",
    "   1235  1.5 102400  3600 www-data nginx",
    "   2001 12.0 4096000  120 postgres postgres",
    "   3001  0.1  5120    50 root     tmux: server",
    "garbage line without numbers",
    "",
  ].join("\n");

  it("parses pid/cpu/rss/etimes/user/comm, kib→bytes, etimes→startedAt", () => {
    const rows = parseLinuxPs(fixture, NOW);
    expect(rows).toHaveLength(5);
    const ng = rows.find((r) => r.pid === 1234)!;
    expect(ng).toMatchObject({ name: "nginx", cpuPct: 2.5, rssBytes: 204800 * 1024, user: "www-data" });
    expect(ng.startMsec).toBe(NOW - 3600 * 1000);
    // comm with spaces survives (last field takes the rest of the line)
    expect(rows.find((r) => r.pid === 3001)!.name).toBe("tmux: server");
  });

  it("aggregates by name with summed cpu/rss, count, earliest start", () => {
    const agg = aggregatePsRows(parseLinuxPs(fixture, NOW));
    const ng = agg.find((a) => a.name === "nginx")!;
    expect(ng.instanceCount).toBe(2);
    expect(ng.cpuPct).toBe(4);
    expect(ng.memRssBytes).toBe(BigInt((204800 + 102400) * 1024));
    expect(ng.username).toBe("www-data");
    expect(ng.controllable).toBe(false);
    expect(ng.serviceUnit).toBeNull();
    // postgres (12.0) sorts before nginx (4.0)
    expect(agg[0].name).toBe("postgres");
  });

  it("telemetryFromPsRows filters to the monitored set", () => {
    const tel = telemetryFromPsRows(parseLinuxPs(fixture, NOW), ["nginx"]);
    expect(tel).toHaveLength(1);
    expect(tel[0]).toMatchObject({ name: "nginx", instanceCount: 2, cpuPct: 4 });
  });
});

describe("buildLinuxSsCommand", () => {
  it("embeds one quoted -F pattern per safe name", () => {
    const cmd = buildLinuxSsCommand(["nginx", "postgres"])!;
    expect(cmd).toContain("ss -tunapH");
    expect(cmd).toContain(`-e '"nginx"'`);
    expect(cmd).toContain(`-e '"postgres"'`);
    expect(cmd).toContain("head -n 3000");
  });

  it("rejects shell-hostile names and returns null when none survive", () => {
    expect(buildLinuxSsCommand(["evil'; rm -rf /"])).toBeNull();
    expect(buildLinuxSsCommand(["$(reboot)"])).toBeNull();
    expect(buildLinuxSsCommand(["a|b", "safe-name"])).toContain(`-e '"safe-name"'`);
  });

  it("isShellSafeProcessName accepts realistic names only", () => {
    expect(isShellSafeProcessName("nginx")).toBe(true);
    expect(isShellSafeProcessName("tmux: server")).toBe(true);
    expect(isShellSafeProcessName("java.exe")).toBe(true);
    expect(isShellSafeProcessName("bad`tick")).toBe(false);
    expect(isShellSafeProcessName('quo"te')).toBe(false);
    expect(isShellSafeProcessName("")).toBe(false);
  });
});

describe("parseLinuxSs", () => {
  const fixture = [
    `tcp   LISTEN 0      511          0.0.0.0:80        0.0.0.0:*     users:(("nginx",pid=1234,fd=6),("nginx",pid=1235,fd=6))`,
    `tcp   LISTEN 0      511             [::]:443             [::]:*   users:(("nginx",pid=1234,fd=7))`,
    `tcp   ESTAB  0      0           10.0.0.1:80       10.9.9.9:51544 users:(("nginx",pid=1235,fd=12))`,
    `tcp   ESTAB  0      0           10.0.0.1:41000    10.0.0.5:5432  users:(("nginx",pid=1234,fd=14))`,
    `udp   UNCONN 0      0            0.0.0.0:53        0.0.0.0:*     users:(("dnsmasq",pid=77,fd=4))`,
    `tcp   TIME-WAIT 0   0           10.0.0.1:42000    10.0.0.9:443`,
  ].join("\n");

  it("parses proto/state/addrs and expands multi-owner tokens", () => {
    const rows = parseLinuxSs(fixture);
    // line 1 has two pids of the same name → one owner entry
    expect(rows.filter((r) => r.state === "LISTEN" && r.proto === "tcp")).toHaveLength(2);
    const v6 = rows.find((r) => r.localPort === 443)!;
    expect(v6.localAddr).toBe("::");
    const estab = rows.find((r) => r.remotePort === 51544)!;
    expect(estab).toMatchObject({ name: "nginx", state: "ESTAB", localAddr: "10.0.0.1", localPort: 80, remoteAddr: "10.9.9.9" });
    // ownerless TIME-WAIT line contributes nothing
    expect(rows.find((r) => r.localPort === 42000)).toBeUndefined();
    expect(rows.find((r) => r.proto === "udp")).toMatchObject({ name: "dnsmasq", localPort: 53, remoteAddr: "" });
  });
});

describe("buildConnectionRows (direction heuristic)", () => {
  it("classifies listen/inbound/outbound and drops ephemeral ports", () => {
    const rows = buildConnectionRows(parseLinuxSs([
      `tcp   LISTEN 0 511 0.0.0.0:80     0.0.0.0:*      users:(("nginx",pid=1,fd=6))`,
      `tcp   ESTAB  0 0   10.0.0.1:80    10.9.9.9:51544 users:(("nginx",pid=1,fd=12))`,
      `tcp   ESTAB  0 0   10.0.0.1:41000 10.0.0.5:5432  users:(("nginx",pid=1,fd=14))`,
    ].join("\n")), ["nginx"]);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.kind === "listen")).toMatchObject({ localAddr: "0.0.0.0", localPort: 80 });
    expect(rows.find((r) => r.kind === "inbound")).toMatchObject({ remoteIp: "10.9.9.9", localPort: 80, remotePort: 0 });
    expect(rows.find((r) => r.kind === "outbound")).toMatchObject({ remoteIp: "10.0.0.5", remotePort: 5432, localPort: 0 });
  });

  it("filters to mapped names, skips loopback peers + non-established tcp", () => {
    const raws: RawSocketRow[] = [
      { name: "redis", proto: "tcp", state: "ESTAB", localAddr: "10.0.0.1", localPort: 40000, remoteAddr: "10.0.0.2", remotePort: 6379 },
      { name: "nginx", proto: "tcp", state: "ESTAB", localAddr: "127.0.0.1", localPort: 40001, remoteAddr: "127.0.0.1", remotePort: 5432 },
      { name: "nginx", proto: "tcp", state: "TIME-WAIT", localAddr: "10.0.0.1", localPort: 40002, remoteAddr: "10.0.0.9", remotePort: 443 },
      { name: "nginx", proto: "tcp", state: "ESTAB", localAddr: "10.0.0.1", localPort: 40003, remoteAddr: "10.0.0.7", remotePort: 8080 },
    ];
    const rows = buildConnectionRows(raws, ["nginx"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ processName: "nginx", kind: "outbound", remoteIp: "10.0.0.7" });
  });

  it("dedups many ephemeral-port connections to one row", () => {
    const raws: RawSocketRow[] = Array.from({ length: 30 }, (_, i) => ({
      name: "java", proto: "tcp" as const, state: "ESTAB",
      localAddr: "10.0.0.1", localPort: 40000 + i, remoteAddr: "10.0.0.5", remotePort: 5432,
    }));
    expect(buildConnectionRows(raws, ["java"])).toHaveLength(1);
  });
});

describe("windows parsers", () => {
  it("parseWindowsProcessJson reads the per-PID rows", () => {
    const json = JSON.stringify([
      { p: 4, n: "System", c: 0, w: 155648, s: null },
      { p: 1234, n: "sqlservr", c: 12, w: 4096000000, s: "2026-07-20T02:00:00.000Z" },
      { p: 5678, n: "w3wp", c: null, w: 512000000, s: "2026-07-21T01:00:00.000Z" },
    ]);
    const rows = parseWindowsProcessJson(json);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ pid: 1234, name: "sqlservr", cpuPct: 12, rssBytes: 4096000000 });
    expect(rows[1].startMsec).toBe(Date.parse("2026-07-20T02:00:00.000Z"));
    expect(rows[2].cpuPct).toBeNull();
  });

  it("parseWindowsProcessJson tolerates a single-object payload and junk", () => {
    expect(parseWindowsProcessJson(JSON.stringify({ p: 1, n: "x", c: 1, w: 2, s: null }))).toHaveLength(1);
    expect(parseWindowsProcessJson("not json")).toEqual([]);
  });

  it("buildWindowsConnectionsScript embeds only safe single-quoted names", () => {
    const s = buildWindowsConnectionsScript(["sqlservr", "w3wp", "bad'quote"])!;
    expect(s).toContain(`$m=@('sqlservr','w3wp')`);
    expect(s).toContain("Get-NetTCPConnection");
    expect(s).toContain("Get-NetUDPEndpoint");
    expect(buildWindowsConnectionsScript(["bad'quote"])).toBeNull();
  });

  it("parseWindowsConnectionsJson joins pids to names and maps numeric TcpState", () => {
    const payload = JSON.stringify({
      t: [
        { State: 2, LocalAddress: "0.0.0.0", LocalPort: 1433, RemoteAddress: "0.0.0.0", RemotePort: 0, OwningProcess: 1234 },
        { State: 5, LocalAddress: "10.0.0.4", LocalPort: 1433, RemoteAddress: "10.0.0.10", RemotePort: 50122, OwningProcess: 1234 },
        { State: "Established", LocalAddress: "10.0.0.4", LocalPort: 49800, RemoteAddress: "10.0.0.20", RemotePort: 445, OwningProcess: 1234 },
      ],
      u: [{ LocalAddress: "::", LocalPort: 3389, OwningProcess: 5678 }],
      p: { "1234": "sqlservr", "5678": "svchost" },
    });
    const raws = parseWindowsConnectionsJson(payload);
    expect(raws).toHaveLength(4);
    expect(raws[0]).toMatchObject({ name: "sqlservr", proto: "tcp", state: "LISTEN", localPort: 1433 });
    expect(raws[1].state).toBe("ESTABLISHED");
    expect(raws[2].state).toBe("ESTABLISHED");
    expect(raws[3]).toMatchObject({ name: "svchost", proto: "udp", localPort: 3389 });

    const rows = buildConnectionRows(raws, ["sqlservr", "svchost"]);
    expect(rows.find((r) => r.kind === "listen" && r.proto === "tcp")).toMatchObject({ localPort: 1433 });
    expect(rows.find((r) => r.kind === "inbound")).toMatchObject({ remoteIp: "10.0.0.10", localPort: 1433 });
    expect(rows.find((r) => r.kind === "outbound")).toMatchObject({ remoteIp: "10.0.0.20", remotePort: 445 });
    expect(rows.find((r) => r.kind === "listen" && r.proto === "udp")).toMatchObject({ localPort: 3389 });
  });
});
