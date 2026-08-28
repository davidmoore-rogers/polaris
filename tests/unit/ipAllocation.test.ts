import { describe, it, expect } from "vitest";
import { selectAvailableIps } from "../../src/utils/ipAllocation.js";

/** Ordered host list for 10.0.0.0/24 (network + broadcast already dropped). */
function hosts(from = 1, to = 254): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`10.0.0.${i}`);
  return out;
}

describe("selectAvailableIps", () => {
  it("returns the first N free addresses when contiguity is not required", () => {
    const sel = selectAvailableIps(hosts(), new Set(["10.0.0.1", "10.0.0.2"]), 3, false);
    expect(sel.ips).toEqual(["10.0.0.3", "10.0.0.4", "10.0.0.5"]);
  });

  it("skips over taken addresses rather than stopping at them", () => {
    const taken = new Set(["10.0.0.2", "10.0.0.4"]);
    const sel = selectAvailableIps(hosts(), taken, 3, false);
    expect(sel.ips).toEqual(["10.0.0.1", "10.0.0.3", "10.0.0.5"]);
  });

  it("returns an unbroken run when contiguous is requested", () => {
    // .1 free, .2 taken, .3-.5 free — the run must start at .3, not .1.
    const taken = new Set(["10.0.0.2"]);
    const sel = selectAvailableIps(hosts(1, 5), taken, 3, false);
    expect(sel.ips).toEqual(["10.0.0.1", "10.0.0.3", "10.0.0.4"]);
    const run = selectAvailableIps(hosts(1, 5), taken, 3, true);
    expect(run.ips).toEqual(["10.0.0.3", "10.0.0.4", "10.0.0.5"]);
  });

  it("picks the EARLIEST fitting run, not the largest", () => {
    // .1-.3 free (fits 3), .4 taken, .5-.10 free (larger).
    const taken = new Set(["10.0.0.4"]);
    const sel = selectAvailableIps(hosts(1, 10), taken, 3, true);
    expect(sel.ips).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
  });

  it("refuses rather than part-filling when no run is long enough", () => {
    // Longest free run is 2 (.1-.2 and .4-.5).
    const taken = new Set(["10.0.0.3", "10.0.0.6"]);
    const sel = selectAvailableIps(hosts(1, 6), taken, 3, true);
    expect(sel.ips).toEqual([]);
    expect(sel.largestRun).toBe(2);
    expect(sel.availableCount).toBe(4);
  });

  it("refuses rather than part-filling when too few addresses are free at all", () => {
    const taken = new Set(hosts(1, 252));
    const sel = selectAvailableIps(hosts(), taken, 5, false);
    expect(sel.ips).toEqual([]);
    expect(sel.availableCount).toBe(2);
  });

  it("reports the largest run and free count over a fully free subnet", () => {
    const sel = selectAvailableIps(hosts(), new Set(), 1, true);
    expect(sel.ips).toEqual(["10.0.0.1"]);
    expect(sel.largestRun).toBe(254);
    expect(sel.availableCount).toBe(254);
  });

  it("reports zeroes and selects nothing when everything is taken", () => {
    const sel = selectAvailableIps(hosts(), new Set(hosts()), 1, false);
    expect(sel.ips).toEqual([]);
    expect(sel.largestRun).toBe(0);
    expect(sel.availableCount).toBe(0);
  });

  it("selects nothing for a non-positive count but still reports the stats", () => {
    const sel = selectAvailableIps(hosts(1, 4), new Set(["10.0.0.2"]), 0, true);
    expect(sel.ips).toEqual([]);
    expect(sel.availableCount).toBe(3);
    expect(sel.largestRun).toBe(2);
  });

  it("handles a run that ends at the last host address", () => {
    const taken = new Set(["10.0.0.251"]);
    const sel = selectAvailableIps(hosts(250, 254), taken, 3, true);
    expect(sel.ips).toEqual(["10.0.0.252", "10.0.0.253", "10.0.0.254"]);
  });
});
