/**
 * tests/unit/chassisDiff.test.ts
 *
 * The per-address diff behind a chassis-replacement conflict (business rule 41)
 * — what the old FortiGate served against what the new one serves.
 *
 * Two things it has to get right:
 *
 *   1. A line's VERDICT. `only-old` is the interesting one — an address the
 *      replacement does not know about, which is exactly what an operator has
 *      to decide about. `only-new` is the new box's own config arriving.
 *   2. WHAT MAY BE MIGRATED. Only `manual` and `dhcp_reservation` — the two
 *      source types that represent an assignment somebody MADE and the new box
 *      is missing. Everything else is refused for a reason of its own
 *      (`device-owned` / `observed` / `device-managed`), and each refused line
 *      is still SHOWN, because hiding it would leave an operator wondering
 *      where an address they remember went.
 */

import { describe, it, expect } from "vitest";
import {
  diffReservationLines,
  type DiffSide,
} from "../../src/services/subnetChassisConflictService.js";

const row = (over: Partial<DiffSide> & { ipAddress: string | null }): DiffSide => ({
  hostname: null,
  macAddress: null,
  owner: null,
  sourceType: "manual",
  status: "active",
  notes: null,
  projectRef: null,
  ...over,
});

describe("diffReservationLines — verdicts", () => {
  it("an address only the old chassis served is only-old and migratable", () => {
    const lines = diffReservationLines([row({ ipAddress: "10.1.1.10" })], []);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ip: "10.1.1.10", verdict: "only-old", migratable: true });
    expect(lines[0]!.new).toBeNull();
  });

  it("an address only the new chassis serves is only-new and NOT migratable", () => {
    // There is nothing to carry forward — it is already there.
    const lines = diffReservationLines([], [row({ ipAddress: "10.1.1.20" })]);
    expect(lines[0]).toMatchObject({ ip: "10.1.1.20", verdict: "only-new", migratable: false });
    expect(lines[0]!.old).toBeNull();
  });

  it("identical rows on both sides are same", () => {
    const a = row({ ipAddress: "10.1.1.30", hostname: "printer-a", macAddress: "aa:bb:cc:00:00:01" });
    const lines = diffReservationLines([a], [{ ...a }]);
    expect(lines[0]).toMatchObject({ verdict: "same", migratable: true });
  });

  it("a disagreement on any compared field is differs", () => {
    const oldRow = row({ ipAddress: "10.1.1.40", hostname: "printer-a" });
    const newRow = row({ ipAddress: "10.1.1.40", hostname: "printer-b" });
    expect(diffReservationLines([oldRow], [newRow])[0]).toMatchObject({ verdict: "differs" });
  });

  it.each([
    ["hostname", { hostname: "other" }],
    ["macAddress", { macAddress: "aa:bb:cc:00:00:09" }],
    ["owner", { owner: "someone" }],
    ["sourceType", { sourceType: "dhcp_reservation" }],
    ["notes", { notes: "changed" }],
    ["projectRef", { projectRef: "PRJ-2" }],
  ])("%s is a compared field", (_label, over) => {
    const base = row({ ipAddress: "10.1.1.50" });
    const lines = diffReservationLines([base], [{ ...base, ...over } as DiffSide]);
    expect(lines[0]!.verdict).toBe("differs");
  });

  it("status alone is NOT a compared field", () => {
    // An expired-vs-active pair is the same reservation as far as the operator's
    // migrate decision goes; the row is carried with its own status either way.
    const base = row({ ipAddress: "10.1.1.60" });
    const lines = diffReservationLines([base], [{ ...base, status: "expired" }]);
    expect(lines[0]!.verdict).toBe("same");
  });
});

describe("diffReservationLines — what may be carried forward", () => {
  // Migration answers "the new box does not know about an assignment somebody
  // MADE". Only two source types are that; each exclusion below has its own
  // reason, and collapsing them into one "not migratable" would lose it.
  it.each(["manual", "dhcp_reservation"])("a %s line IS migratable", (sourceType) => {
    const lines = diffReservationLines([row({ ipAddress: "10.1.1.65", sourceType })], []);
    expect(lines[0]).toMatchObject({ migratable: true });
    expect(lines[0]!.notMigratableReason).toBeUndefined();
  });

  it.each(["vip", "interface_ip"])("a %s line is device-owned and never migratable", (sourceType) => {
    // Read-only in Polaris everywhere else; the NEW gate's own config states
    // these, so carrying one forward would write Polaris's memory of a dead box
    // over a live device's truth.
    const lines = diffReservationLines([row({ ipAddress: "10.1.1.70", sourceType })], []);
    expect(lines[0]).toMatchObject({
      verdict: "only-old",
      migratable: false,
      notMigratableReason: "device-owned",
    });
  });

  it.each(["dhcp_lease", "dns_resolved"])("a %s line is observed, not assigned", (sourceType) => {
    // A lease is a sighting of a client that may not even be there any more.
    // Turning one into a reservation would invent an assignment nobody made.
    const lines = diffReservationLines([row({ ipAddress: "10.1.1.75", sourceType })], []);
    expect(lines[0]).toMatchObject({ migratable: false, notMigratableReason: "observed" });
  });

  it.each(["fortiswitch", "fortinap", "fortimanager", "fortigate"])(
    "a %s line is device-managed infrastructure",
    (sourceType) => {
      // Those devices are still on the wire; the new gate re-discovers them
      // within a cycle, and migrating fights rule 23's give-it-back lifecycle.
      const lines = diffReservationLines([row({ ipAddress: "10.1.1.76", sourceType })], []);
      expect(lines[0]).toMatchObject({ migratable: false, notMigratableReason: "device-managed" });
    },
  );

  it("a refused line still APPEARS, so the card can show it", () => {
    // Shown and not offered. Hiding them would leave an operator wondering
    // where an address they remember went.
    for (const sourceType of ["vip", "dhcp_lease", "fortiswitch"]) {
      const lines = diffReservationLines([row({ ipAddress: "10.1.1.71", sourceType })], []);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.old?.sourceType).toBe(sourceType);
      expect(lines[0]!.migratable).toBe(false);
    }
  });

  it("notMigratableReason is absent on an ordinary non-migratable line", () => {
    // only-new is not migratable because there is no old row, which is a
    // different thing from being refused.
    const lines = diffReservationLines([], [row({ ipAddress: "10.1.1.72" })]);
    expect(lines[0]!.notMigratableReason).toBeUndefined();
  });
});

describe("diffReservationLines — keying", () => {
  it("full-subnet reservations (null ip) key separately from addresses", () => {
    const lines = diffReservationLines(
      [row({ ipAddress: null }), row({ ipAddress: "10.1.1.80" })],
      [row({ ipAddress: null })],
    );
    const full = lines.find((l) => l.ip === null);
    const addr = lines.find((l) => l.ip === "10.1.1.80");
    expect(full).toMatchObject({ verdict: "same" });
    expect(addr).toMatchObject({ verdict: "only-old" });
  });

  it("returns one line per distinct address across both sides", () => {
    const lines = diffReservationLines(
      [row({ ipAddress: "10.1.1.1" }), row({ ipAddress: "10.1.1.2" })],
      [row({ ipAddress: "10.1.1.2" }), row({ ipAddress: "10.1.1.3" })],
    );
    expect(lines.map((l) => l.ip)).toEqual(["10.1.1.1", "10.1.1.2", "10.1.1.3"]);
    expect(lines.map((l) => l.verdict)).toEqual(["only-old", "same", "only-new"]);
  });

  it("two empty sides produce no lines", () => {
    expect(diffReservationLines([], [])).toEqual([]);
  });
});
