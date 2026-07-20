import { describe, it, expect } from "vitest";
import { extractHaFromFmgDevice } from "../../src/services/fortimanagerService.js";

// extractHaFromFmgDevice() reads ha_mode + ha_slave[] off a raw FMG device
// record and produces the normalized { haMode, haMembers } shape Phase 3 of
// syncDhcpSubnets consumes. The function is pure — no DB, no network.

describe("extractHaFromFmgDevice", () => {
  it("standalone device — string ha_mode", () => {
    const r = extractHaFromFmgDevice({ sn: "FGT60FTK20012345", ha_mode: "standalone", ha_slave: [] });
    expect(r.haMode).toBe("standalone");
    expect(r.haMembers).toEqual([]);
  });

  it("standalone device — integer ha_mode 0", () => {
    const r = extractHaFromFmgDevice({ sn: "FGT60FTK20012345", ha_mode: 0 });
    expect(r.haMode).toBe("standalone");
    expect(r.haMembers).toEqual([]);
  });

  it("standalone device — missing ha_mode + ha_slave", () => {
    const r = extractHaFromFmgDevice({ sn: "FGT60FTK20012345" });
    expect(r.haMode).toBe("standalone");
    expect(r.haMembers).toEqual([]);
  });

  it("a-p cluster — string encoding + sn-matched primary", () => {
    const r = extractHaFromFmgDevice({
      sn: "FGT-A-SERIAL",
      ha_mode: "a-p",
      ha_slave: [
        { idx: 0, name: "FGT-A", sn: "FGT-A-SERIAL", prio: 200, role: 1, status: 1 },
        { idx: 1, name: "FGT-B", sn: "FGT-B-SERIAL", prio: 100, role: 0, status: 1 },
      ],
    });
    expect(r.haMode).toBe("a-p");
    expect(r.haMembers.length).toBe(2);
    const primary = r.haMembers.find((m) => m.isPrimary)!;
    expect(primary).toBeDefined();
    expect(primary.serial).toBe("FGT-A-SERIAL");
    expect(primary.name).toBe("FGT-A");
    expect(primary.priority).toBe(200);
    const secondary = r.haMembers.find((m) => !m.isPrimary)!;
    expect(secondary.serial).toBe("FGT-B-SERIAL");
    expect(secondary.name).toBe("FGT-B");
  });

  it("a-p cluster — integer encoding (1)", () => {
    const r = extractHaFromFmgDevice({
      sn: "FGT-A-SERIAL",
      ha_mode: 1,
      ha_slave: [
        { idx: 0, name: "FGT-A", sn: "FGT-A-SERIAL" },
        { idx: 1, name: "FGT-B", sn: "FGT-B-SERIAL" },
      ],
    });
    expect(r.haMode).toBe("a-p");
    expect(r.haMembers.find((m) => m.isPrimary)?.serial).toBe("FGT-A-SERIAL");
  });

  it("a-a cluster — integer encoding (2)", () => {
    const r = extractHaFromFmgDevice({
      sn: "FGT-A-SERIAL",
      ha_mode: 2,
      ha_slave: [
        { idx: 0, name: "FGT-A", sn: "FGT-A-SERIAL" },
        { idx: 1, name: "FGT-B", sn: "FGT-B-SERIAL" },
      ],
    });
    expect(r.haMode).toBe("a-a");
  });

  it("post-failover — device.sn now matches the SECOND ha_slave entry", () => {
    // Simulates a failover where the FMG device record has been updated:
    // device.sn flipped from FGT-A to FGT-B. ha_slave[] is unchanged.
    // The function must identify FGT-B as the current primary based on
    // the sn match, NOT idx === 0.
    const r = extractHaFromFmgDevice({
      sn: "FGT-B-SERIAL",
      ha_mode: "a-p",
      ha_slave: [
        { idx: 0, name: "FGT-A", sn: "FGT-A-SERIAL", role: 0 },
        { idx: 1, name: "FGT-B", sn: "FGT-B-SERIAL", role: 1 },
      ],
    });
    expect(r.haMembers.length).toBe(2);
    const primary = r.haMembers.find((m) => m.isPrimary);
    expect(primary?.serial).toBe("FGT-B-SERIAL");
    const secondary = r.haMembers.find((m) => !m.isPrimary);
    expect(secondary?.serial).toBe("FGT-A-SERIAL");
  });

  it("idx=0 fallback when device.sn is missing", () => {
    const r = extractHaFromFmgDevice({
      ha_mode: "a-p",
      ha_slave: [
        { idx: 0, name: "FGT-A", sn: "FGT-A-SERIAL" },
        { idx: 1, name: "FGT-B", sn: "FGT-B-SERIAL" },
      ],
    });
    const primary = r.haMembers.find((m) => m.isPrimary);
    expect(primary?.serial).toBe("FGT-A-SERIAL");
  });

  it("filters out ha_slave entries with empty serials", () => {
    const r = extractHaFromFmgDevice({
      sn: "FGT-A-SERIAL",
      ha_mode: "a-p",
      ha_slave: [
        { idx: 0, name: "FGT-A", sn: "FGT-A-SERIAL" },
        { idx: 1, name: "ghost-member-no-serial", sn: "" },
      ],
    });
    expect(r.haMembers.length).toBe(1);
    expect(r.haMembers[0].serial).toBe("FGT-A-SERIAL");
  });

  it("per-member status — numeric 1/0 map to up/down", () => {
    const r = extractHaFromFmgDevice({
      sn: "FGT-A-SERIAL",
      ha_mode: "a-p",
      ha_slave: [
        { idx: 0, name: "FGT-A", sn: "FGT-A-SERIAL", status: 1 },
        { idx: 1, name: "FGT-B", sn: "FGT-B-SERIAL", status: 0 },
      ],
    });
    expect(r.haMembers.find((m) => m.serial === "FGT-A-SERIAL")?.status).toBe("up");
    expect(r.haMembers.find((m) => m.serial === "FGT-B-SERIAL")?.status).toBe("down");
  });

  it("per-member status — string-encoded numbers normalized", () => {
    const r = extractHaFromFmgDevice({
      sn: "FGT-A-SERIAL",
      ha_mode: "a-p",
      ha_slave: [
        { idx: 0, sn: "FGT-A-SERIAL", status: "1" },
        { idx: 1, sn: "FGT-B-SERIAL", status: "0" },
      ],
    });
    expect(r.haMembers.find((m) => m.serial === "FGT-A-SERIAL")?.status).toBe("up");
    expect(r.haMembers.find((m) => m.serial === "FGT-B-SERIAL")?.status).toBe("down");
  });

  it("per-member status — missing or unrecognized stays undefined (no false alarm)", () => {
    const r = extractHaFromFmgDevice({
      sn: "FGT-A-SERIAL",
      ha_mode: "a-p",
      ha_slave: [
        { idx: 0, sn: "FGT-A-SERIAL" },
        { idx: 1, sn: "FGT-B-SERIAL", status: "weird" },
      ],
    });
    expect(r.haMembers.find((m) => m.serial === "FGT-A-SERIAL")?.status).toBeUndefined();
    expect(r.haMembers.find((m) => m.serial === "FGT-B-SERIAL")?.status).toBeUndefined();
  });

  it("unrecognized string ha_mode falls back to standalone", () => {
    const r = extractHaFromFmgDevice({
      sn: "FGT-A-SERIAL",
      ha_mode: "weird-mode-fmg-might-emit-someday",
      ha_slave: [{ idx: 0, sn: "FGT-A-SERIAL" }],
    });
    expect(r.haMode).toBe("standalone");
    expect(r.haMembers).toEqual([]);
  });

  it("guards against multiple isPrimary entries (keeps first, demotes rest)", () => {
    // Real-world scenario: HA cluster mid-failover where FMG briefly
    // reports two members claiming primary. Defensive: keep exactly one.
    // To force this, point device.sn at neither member so the sn-match
    // path doesn't fire, and rely on idx===0 fallback (which would only
    // pick the first). Then ensure the post-pass guard runs cleanly when
    // we synthesize a multi-primary situation via a non-matching sn.
    const r = extractHaFromFmgDevice({
      sn: "FGT-A-SERIAL",
      ha_mode: "a-p",
      ha_slave: [
        { idx: 0, name: "FGT-A", sn: "FGT-A-SERIAL" },
        { idx: 0, name: "FGT-B", sn: "FGT-B-SERIAL" }, // duplicate idx=0 (FMG corruption)
      ],
    });
    const primaries = r.haMembers.filter((m) => m.isPrimary);
    expect(primaries.length).toBe(1);
    // sn-match for FGT-A wins over idx-fallback for FGT-B
    expect(primaries[0].serial).toBe("FGT-A-SERIAL");
  });
});
