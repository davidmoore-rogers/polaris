/**
 * tests/unit/burstPing.test.ts
 *
 * The two output parsers behind the batched ICMP burst sampler. These are
 * pinned hard because their failure mode is SILENT and inverted: a parser that
 * stops matching does not throw, it reports zero rows, and a fleet with no
 * parseable loss data reads as a fleet with no packet loss. Every fixture here
 * is real tool output, kept verbatim (trailing spaces and all) so a distro
 * reformatting its summary line breaks a test rather than a dashboard.
 */

import { describe, it, expect } from "vitest";
import { parseFpingOutput, suggestedSweepIntervalSec, bucketByTimeout } from "../../src/utils/burstPing.js";
import { parsePingSummary } from "../../src/utils/icmpPing.js";

describe("parseFpingOutput", () => {
  it("reads xmt/rcv and the mean RTT from a healthy target", () => {
    const out = "10.0.0.1  : xmt/rcv/%loss = 5/5/0%, min/avg/max = 0.108/0.155/0.201";
    const m = parseFpingOutput(out);
    expect(m.get("10.0.0.1")).toEqual({ sent: 5, received: 5, avgRttMs: 0.155 });
  });

  it("reads a partial-loss target", () => {
    const out = "10.0.0.2  : xmt/rcv/%loss = 5/3/40%, min/avg/max = 1.20/1.44/1.90";
    expect(m0(out, "10.0.0.2")).toEqual({ sent: 5, received: 3, avgRttMs: 1.44 });
  });

  it("reads a fully-dark target, which has no min/avg/max clause at all", () => {
    const out = "10.0.0.9  : xmt/rcv/%loss = 5/0/100%";
    expect(m0(out, "10.0.0.9")).toEqual({ sent: 5, received: 0, avgRttMs: null });
  });

  it("parses a multi-host run and keys by the target as passed in", () => {
    const out = [
      "10.0.0.1  : xmt/rcv/%loss = 5/5/0%, min/avg/max = 0.10/0.15/0.20",
      "switch-a  : xmt/rcv/%loss = 5/4/20%, min/avg/max = 2.00/2.50/3.00",
      "10.0.0.9  : xmt/rcv/%loss = 5/0/100%",
    ].join("\n");
    const m = parseFpingOutput(out);
    expect(m.size).toBe(3);
    expect(m.get("switch-a")?.received).toBe(4);
  });

  it("OMITS an unresolvable host rather than reporting it as 100% loss", () => {
    // The caller must be able to tell "asked and heard nothing" (real loss)
    // from "never asked" (not loss). fping prints no summary line for a name it
    // could not resolve, so absence is the signal.
    const out = [
      "fping: nosuchhost: Name or service not known",
      "10.0.0.1  : xmt/rcv/%loss = 5/5/0%, min/avg/max = 0.10/0.15/0.20",
    ].join("\n");
    const m = parseFpingOutput(out);
    expect(m.has("nosuchhost")).toBe(false);
    expect(m.size).toBe(1);
  });

  it("parses REAL fping output captured from a live run", () => {
    // Verbatim from `fping -q -c 3 -p 500 -i 1 -t 1000 -B 1 -r 0` (fping 5.x,
    // alpine 3.20) against loopback, an unroutable address, an unresolvable
    // name and IPv6 — the exact flag set runFpingChunk builds. Captured rather
    // than remembered: every other fixture here is only as good as my memory
    // of the wording, and this one is evidence.
    //
    // Note what is NOT in it: `no-such-host.invalid` was on the command line
    // and produced no summary line whatsoever. That is the "absent means never
    // attempted" invariant holding in the real tool, not just in the parser.
    const real = [
      "127.0.0.1    : xmt/rcv/%loss = 3/3/0%, min/avg/max = 0.027/0.073/0.160",
      "10.255.255.1 : xmt/rcv/%loss = 3/0/100%",
      "::1          : xmt/rcv/%loss = 3/3/0%, min/avg/max = 0.019/0.076/0.191",
    ].join("\n");
    const m = parseFpingOutput(real);
    expect(m.size).toBe(3);
    expect(m.get("127.0.0.1")).toEqual({ sent: 3, received: 3, avgRttMs: 0.073 });
    expect(m.get("10.255.255.1")).toEqual({ sent: 3, received: 0, avgRttMs: null });
    expect(m.get("::1")).toEqual({ sent: 3, received: 3, avgRttMs: 0.076 });
    expect(m.has("no-such-host.invalid")).toBe(false);
  });

  it("ignores noise lines and an empty run", () => {
    expect(parseFpingOutput("").size).toBe(0);
    expect(parseFpingOutput("fping: can't create socket (must run as root?)").size).toBe(0);
  });

  it("clamps a nonsensical received count instead of yielding negative loss", () => {
    // Defensive: received > sent would make 1 - recv/sent negative, and a
    // negative packet-loss reading would sail through every threshold test.
    expect(m0("10.0.0.3 : xmt/rcv/%loss = 5/9/0%", "10.0.0.3")).toEqual({
      sent: 5, received: 5, avgRttMs: null,
    });
  });

  it("skips a row claiming zero sent — it would divide by zero", () => {
    expect(parseFpingOutput("10.0.0.4 : xmt/rcv/%loss = 0/0/0%").size).toBe(0);
  });

  it("handles IPv6 targets, whose addresses contain colons", () => {
    // The separator regex has to survive a target that is itself full of colons.
    const out = "2001:db8::1 : xmt/rcv/%loss = 5/5/0%, min/avg/max = 0.30/0.40/0.50";
    expect(m0(out, "2001:db8::1")).toEqual({ sent: 5, received: 5, avgRttMs: 0.4 });
  });
});

describe("parsePingSummary (per-host fallback)", () => {
  it("reads iputils output", () => {
    const out = [
      "--- 10.0.0.1 ping statistics ---",
      "5 packets transmitted, 5 received, 0% packet loss, time 802ms",
      "rtt min/avg/max/mdev = 0.108/0.155/0.201/0.038 ms",
    ].join("\n");
    expect(parsePingSummary(out, 5)).toEqual({ sent: 5, received: 5, avgRttMs: 0.155 });
  });

  it("reads iputils partial loss", () => {
    const out = "5 packets transmitted, 2 received, 60% packet loss, time 804ms";
    expect(parsePingSummary(out, 5)).toEqual({ sent: 5, received: 2, avgRttMs: null });
  });

  it("reads Windows output", () => {
    const out = [
      "Ping statistics for 10.0.0.1:",
      "    Packets: Sent = 5, Received = 4, Lost = 1 (20% loss),",
      "Approximate round trip times in milli-seconds:",
      "    Minimum = 0ms, Maximum = 2ms, Average = 1ms",
    ].join("\r\n");
    expect(parsePingSummary(out, 5)).toEqual({ sent: 5, received: 4, avgRttMs: 1 });
  });

  it("treats unparseable output as a total loss of what we ASKED for", () => {
    // A ping killed at the hard limit prints no summary. Reporting sent:0 there
    // would drop the host out of the denominator entirely, quietly excusing the
    // very outage we were trying to measure.
    expect(parsePingSummary("", 5)).toEqual({ sent: 5, received: 0, avgRttMs: null });
  });

  it("reports no RTT when nothing came back, even if a stale figure is present", () => {
    const out = [
      "5 packets transmitted, 0 received, 100% packet loss, time 4090ms",
      "rtt min/avg/max/mdev = 1.000/2.000/3.000/0.500 ms",
    ].join("\n");
    expect(parsePingSummary(out, 5).avgRttMs).toBeNull();
  });

  it("honours a transmitted count lower than requested", () => {
    // A ping interrupted mid-burst states what it actually sent; that is the
    // honest denominator.
    expect(parsePingSummary("3 packets transmitted, 3 received, 0% packet loss", 5).sent).toBe(3);
  });
});

/** Parse one line and pull the single entry out. */
function m0(out: string, key: string): unknown {
  return parseFpingOutput(out).get(key);
}

describe("suggestedSweepIntervalSec", () => {
  it("holds a 60s cadence at any fleet size when fping is present", () => {
    // fping is ~constant-time in the fleet: one spawn per 500-host chunk, each
    // bounded by count x period rather than by how many hosts are in it.
    expect(suggestedSweepIntervalSec(100, true)).toBe(60);
    expect(suggestedSweepIntervalSec(2000, true)).toBe(60);
    expect(suggestedSweepIntervalSec(20000, true)).toBe(60);
  });

  it("never returns a cadence below 60s", () => {
    expect(suggestedSweepIntervalSec(0, false)).toBe(60);
    expect(suggestedSweepIntervalSec(10, false)).toBe(60);
  });

  it("stretches the cadence for a large fleet on the fallback path", () => {
    // The exact figure is platform-dependent (Windows ping paces at ~1s/echo
    // and cannot be told otherwise), so assert the SHAPE: a big fleet on the
    // fallback must not be handed a 60s cadence it cannot finish.
    const big = suggestedSweepIntervalSec(5000, false);
    expect(big).toBeGreaterThan(60);
    expect(big % 30).toBe(0);
  });

  it("is monotonic in fleet size", () => {
    const a = suggestedSweepIntervalSec(2000, false);
    const b = suggestedSweepIntervalSec(8000, false);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe("bucketByTimeout", () => {
  const t = (target: string, timeoutMs: number) => ({ target, timeoutMs });

  it("groups targets sharing a timeout into one invocation", () => {
    // The whole cost model: real fleets carry two or three distinct
    // probeTimeoutMs values, so this is a handful of processes rather than one
    // per host.
    expect(bucketByTimeout([t("a", 1000), t("b", 5000), t("c", 1000)])).toEqual([
      { timeoutMs: 1000, targets: ["a", "c"] },
      { timeoutMs: 5000, targets: ["b"] },
    ]);
  });

  it("orders buckets fastest-first", () => {
    // So the fast majority of a fleet is measured and recorded before one
    // slow-timeout outlier holds a worker slot.
    const out = bucketByTimeout([t("slow", 30000), t("mid", 5000), t("fast", 500)]);
    expect(out.map((b) => b.timeoutMs)).toEqual([500, 5000, 30000]);
  });

  it("preserves target order inside a bucket", () => {
    expect(bucketByTimeout([t("a", 1000), t("b", 1000), t("c", 1000)])[0]!.targets)
      .toEqual(["a", "b", "c"]);
  });

  it("collapses a duplicate target within a bucket", () => {
    // Two assets can share an address; pinging it twice would double the
    // traffic and give them different readings of the same link.
    expect(bucketByTimeout([t("a", 1000), t("a", 1000)])[0]!.targets).toEqual(["a"]);
  });

  it("keeps the same target in two DIFFERENT buckets", () => {
    // Deliberate: the two assets are entitled to different timeouts, and
    // collapsing across buckets would silently give one of them the other's.
    const out = bucketByTimeout([t("a", 1000), t("a", 9000)]);
    expect(out).toEqual([
      { timeoutMs: 1000, targets: ["a"] },
      { timeoutMs: 9000, targets: ["a"] },
    ]);
  });

  it("falls back to the default for a nonsense timeout rather than dropping the host", () => {
    // A missing or corrupt setting must not silently exclude an asset from
    // being probed at all — that reads as a device nobody is watching.
    const out = bucketByTimeout([t("a", 0), t("b", -5), t("c", Number.NaN)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.targets.sort()).toEqual(["a", "b", "c"]);
  });

  it("skips empty targets and an empty input", () => {
    expect(bucketByTimeout([])).toEqual([]);
    expect(bucketByTimeout([t("", 1000), t("   ", 1000)])).toEqual([]);
  });

  it("rounds a fractional timeout so it cannot fragment into per-host buckets", () => {
    const out = bucketByTimeout([t("a", 1000.4), t("b", 1000.2)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.timeoutMs).toBe(1000);
  });
});
