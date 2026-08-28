/**
 * tests/unit/agentlessHostService.test.ts
 *
 * Pure parsers for the agentless host collectors — the unit-test surface, the
 * way parseLinuxPs / parseWindowsProcessJson are for the processes stream.
 * Fixtures in, rows out, malformed input skipped rather than thrown.
 */

import { describe, it, expect } from "vitest";
import {
  parseLinuxCpuMem,
  parseLinuxInterfaces,
  parseLinuxStorage,
  parseWindowsCpuMem,
  parseWindowsInterfaces,
  parseWindowsStorage,
  parseWindowsLinkSpeed,
} from "../../src/services/agentlessHostService.js";

describe("parseLinuxCpuMem", () => {
  // Two /proc/stat snapshots then /proc/meminfo, separated by ---.
  const sample = [
    "cpu  100 0 100 800 0 0 0 0",
    "cpu  200 0 200 1400 0 0 0 0",
    "---",
    "MemTotal:       16384000 kB",
    "MemFree:          512000 kB",
    "MemAvailable:    8192000 kB",
  ].join("\n");

  // Totals 1000 → 1800 (Δ800); idle+iowait 800 → 1400 (Δ600). Busy is the
  // remainder: 200/800 = 25%.
  it("derives CPU from the delta between the two snapshots", () => {
    expect(parseLinuxCpuMem(sample).cpuPct).toBe(25);
  });

  // MemAvailable, not MemFree: page cache is not "used" in any sense an
  // operator means, and MemFree makes every healthy Linux box look full.
  it("uses MemAvailable for the used figure", () => {
    const t = parseLinuxCpuMem(sample);
    expect(t.memTotalBytes).toBe(16384000 * 1024);
    expect(t.memUsedBytes).toBe((16384000 - 8192000) * 1024);
    expect(t.memPct).toBe(50);
  });

  // A counter that went backwards means the host rebooted between snapshots;
  // a fabricated 0% or 100% would be worse than no reading.
  it("returns null CPU when the counters go backwards or do not move", () => {
    expect(parseLinuxCpuMem("cpu 200 0 200 1400 0\ncpu 100 0 100 800 0\n---\n").cpuPct).toBeNull();
    expect(parseLinuxCpuMem("cpu 100 0 100 800 0\ncpu 100 0 100 800 0\n---\n").cpuPct).toBeNull();
  });

  it("survives truncated or empty output", () => {
    expect(parseLinuxCpuMem("").cpuPct).toBeNull();
    expect(parseLinuxCpuMem("garbage").memTotalBytes).toBeNull();
    // One snapshot is not a rate.
    expect(parseLinuxCpuMem("cpu 100 0 100 800 0\n---\nMemTotal: 100 kB").cpuPct).toBeNull();
  });

  // Per-core rows (cpu0, cpu1…) must not be mistaken for the aggregate.
  it("ignores per-core rows", () => {
    const withCores = [
      "cpu  100 0 100 800 0", "cpu0 50 0 50 400 0",
      "cpu  200 0 200 1400 0", "cpu0 100 0 100 700 0",
      "---", "MemTotal: 1000 kB", "MemAvailable: 500 kB",
    ].join("\n");
    expect(parseLinuxCpuMem(withCores).cpuPct).toBe(25);
  });
});

describe("parseLinuxInterfaces", () => {
  const sample = [
    "IF=eth0", "OPER=up", "MAC=aa:bb:cc:dd:ee:ff", "SPEED=1000",
    "RXB=123456", "TXB=654321", "RXE=1", "TXE=2",
    "IF=lo", "OPER=unknown", "MAC=00:00:00:00:00:00", "SPEED=",
    "RXB=10", "TXB=10", "RXE=0", "TXE=0",
  ].join("\n");

  it("reads one row per interface with counters and link rate", () => {
    const rows = parseLinuxInterfaces(sample);
    expect(rows.map((r) => r.ifName)).toEqual(["eth0", "lo"]);
    const eth0 = rows[0];
    expect(eth0.operStatus).toBe("up");
    expect(eth0.macAddress).toBe("aa:bb:cc:dd:ee:ff");
    expect(eth0.speedBps).toBe(1_000_000_000); // sysfs reports Mbit/s
    expect(eth0.inOctets).toBe(123456);
    expect(eth0.outErrors).toBe(2);
  });

  // A virtual or unplugged NIC reports nothing (or -1). Only a real negotiated
  // rate is a reading — 0 bps would render as a broken link.
  it("leaves speed null when there is no negotiated rate", () => {
    expect(parseLinuxInterfaces(sample)[1].speedBps).toBeNull();
    expect(parseLinuxInterfaces("IF=x\nSPEED=-1")[0].speedBps).toBeNull();
  });

  it("maps operstate onto an admin flag", () => {
    expect(parseLinuxInterfaces("IF=a\nOPER=down")[0].adminStatus).toBe("down");
    expect(parseLinuxInterfaces("IF=a\nOPER=up")[0].adminStatus).toBe("up");
  });

  it("returns nothing for empty or unrecognisable output", () => {
    expect(parseLinuxInterfaces("")).toEqual([]);
    expect(parseLinuxInterfaces("no equals signs here")).toEqual([]);
  });
});

describe("parseLinuxStorage", () => {
  const sample = [
    "Filesystem     Type  1024-blocks     Used Available Capacity Mounted on",
    "/dev/sda1      ext4     41152812  8123456  30934012      21% /",
    "tmpfs          tmpfs     8192000        0   8192000       0% /dev/shm",
    "/dev/sdb1      xfs     104857600 52428800  52428800      50% /data",
    "udev           devtmpfs  4096000        0   4096000       0% /dev",
  ].join("\n");

  it("reads real filesystems and converts 1K blocks to bytes", () => {
    const rows = parseLinuxStorage(sample);
    expect(rows.map((r) => r.mountPath)).toEqual(["/", "/data"]);
    expect(rows[1].totalBytes).toBe(104857600 * 1024);
    expect(rows[1].usedBytes).toBe(52428800 * 1024);
  });

  // tmpfs / devtmpfs are kernel bookkeeping — rows nobody can act on.
  it("drops pseudo-filesystems", () => {
    const paths = parseLinuxStorage(sample).map((r) => r.mountPath);
    expect(paths).not.toContain("/dev/shm");
    expect(paths).not.toContain("/dev");
  });

  // -P keeps each mount on one line, but a mount point can still contain
  // spaces, so the path is the remainder of the line rather than one field.
  it("keeps a mount path containing spaces intact", () => {
    const rows = parseLinuxStorage(
      "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n" +
      "/dev/sdc1 ext4 1000 500 500 50% /mnt/my volume",
    );
    expect(rows[0].mountPath).toBe("/mnt/my volume");
  });

  it("skips zero-size mounts and junk", () => {
    expect(parseLinuxStorage("Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/x ext4 0 0 0 0% /empty")).toEqual([]);
    expect(parseLinuxStorage("")).toEqual([]);
  });
});

describe("Windows parsers", () => {
  it("parseWindowsCpuMem converts KB to bytes and derives the percentage", () => {
    const t = parseWindowsCpuMem(JSON.stringify({ cpu: 17, totalKb: 8388608, freeKb: 4194304 }));
    expect(t.cpuPct).toBe(17);
    expect(t.memTotalBytes).toBe(8388608 * 1024);
    expect(t.memUsedBytes).toBe(4194304 * 1024);
    expect(t.memPct).toBe(50);
  });

  it("parseWindowsCpuMem tolerates junk", () => {
    expect(parseWindowsCpuMem("not json").cpuPct).toBeNull();
    expect(parseWindowsCpuMem("").memTotalBytes).toBeNull();
  });

  // Get-NetAdapter.LinkSpeed is a DISPLAY string, not a number.
  it("parseWindowsLinkSpeed reads the display string", () => {
    expect(parseWindowsLinkSpeed("1 Gbps")).toBe(1_000_000_000);
    expect(parseWindowsLinkSpeed("100 Mbps")).toBe(100_000_000);
    expect(parseWindowsLinkSpeed("2.5 Gbps")).toBe(2_500_000_000);
    expect(parseWindowsLinkSpeed("")).toBeNull();
    expect(parseWindowsLinkSpeed("fast")).toBeNull();
    expect(parseWindowsLinkSpeed(1000)).toBe(1000);
  });

  it("parseWindowsInterfaces normalises the MAC to colons", () => {
    const rows = parseWindowsInterfaces(JSON.stringify([
      { n: "Ethernet", admin: "Up", oper: "Up", speed: "1 Gbps", mac: "AA-BB-CC-DD-EE-FF", ip: "10.0.0.5", rxb: 5, txb: 6, rxe: 0, txe: 0 },
    ]));
    expect(rows).toHaveLength(1);
    // Every other source in Polaris uses colons and the identity joins assume it.
    expect(rows[0].macAddress).toBe("aa:bb:cc:dd:ee:ff");
    expect(rows[0].speedBps).toBe(1_000_000_000);
    expect(rows[0].ipAddress).toBe("10.0.0.5");
    expect(rows[0].operStatus).toBe("up");
  });

  // ConvertTo-Json emits a bare object, not an array, for a single row.
  it("parseWindowsInterfaces accepts a single non-array object", () => {
    expect(parseWindowsInterfaces(JSON.stringify({ n: "Ethernet" }))).toHaveLength(1);
  });

  it("parseWindowsInterfaces skips rows with no name", () => {
    expect(parseWindowsInterfaces(JSON.stringify([{ mac: "AA-BB" }]))).toEqual([]);
  });

  it("parseWindowsStorage derives used from size minus remaining", () => {
    const rows = parseWindowsStorage(JSON.stringify([
      { path: "C:", size: 1000, free: 400 },
      { path: "D:", size: 0, free: 0 },
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0].mountPath).toBe("C:");
    expect(rows[0].usedBytes).toBe(600);
  });

  it("parseWindowsStorage tolerates junk", () => {
    expect(parseWindowsStorage("nope")).toEqual([]);
    expect(parseWindowsStorage("")).toEqual([]);
  });
});
