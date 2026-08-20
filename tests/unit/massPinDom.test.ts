/**
 * tests/unit/massPinDom.test.ts — the Mass Pinning section's pure staging helpers
 * (public/js/assets-masspin.js, window.PolarisMassPin).
 *
 * These are the tri-state math and the staged-diff model: staged holds ONLY
 * diffs vs the server state (staging a value back to the server's deletes the
 * key), the aggregate-row click cycle is "not all pinned → pin all, all
 * pinned → unpin all", and buildApplyPayload routes each key to its field.
 * The DOM-bound half (init/wire) is exercised manually — these helpers are
 * what make the checkbox semantics trustworthy.
 *
 * Loaded by eval into a happy-dom Window, the conditionBuilderDom pattern.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

type Dev = { a: number; pinned: boolean };
type Row = { name: string; ifType: string | null; isIpsecTunnel: boolean; deviceCount: number; devices: Dev[] };
type Inventory = { facet: string; assets: Array<{ id: string; hostname: string | null; ipAddress: string | null }>; rows: Row[] };

interface MassPin {
  stageKey: (field: string, assetId: string, name: string) => string;
  parseStageKey: (key: string) => { field: string; assetId: string; name: string };
  fieldForRow: (facet: string, row: Row) => string;
  setStaged: (staged: Map<string, boolean>, key: string, desired: boolean, serverPinned: boolean) => void;
  devicePinned: (facet: string, row: Row, inv: Inventory, staged: Map<string, boolean>, dev: Dev) => boolean;
  rowState: (facet: string, row: Row, inv: Inventory, staged: Map<string, boolean>) => { on: number; total: number; state: string };
  cycleRow: (facet: string, row: Row, inv: Inventory, staged: Map<string, boolean>) => boolean;
  toggleDevice: (facet: string, row: Row, inv: Inventory, staged: Map<string, boolean>, dev: Dev) => boolean;
  buildApplyPayload: (staged: Map<string, boolean>) => { pin: Array<Record<string, string>>; unpin: Array<Record<string, string>> };
  summarize: (staged: Map<string, boolean>) => { pins: number; unpins: number; devices: number };
}

const g = globalThis as Record<string, unknown>;
let MP: MassPin;

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/assets-masspin.js"), "utf8"));
  MP = (win as unknown as Record<string, MassPin>).PolarisMassPin;
});

function inv(rows: Row[], assetIds = ["A", "B", "C"]): Inventory {
  return {
    facet: "interfaces",
    assets: assetIds.map((id) => ({ id, hostname: "host-" + id, ipAddress: null })),
    rows,
  };
}
function row(name: string, devices: Dev[], over: Partial<Row> = {}): Row {
  return { name, ifType: "physical", isIpsecTunnel: false, deviceCount: devices.length, devices, ...over };
}

describe("stageKey / parseStageKey", () => {
  it("round-trips names containing separators like : and |", () => {
    const key = MP.stageKey("interfaces", "asset-1", "Gi1/0:1|x");
    expect(MP.parseStageKey(key)).toEqual({ field: "interfaces", assetId: "asset-1", name: "Gi1/0:1|x" });
  });
});

describe("fieldForRow", () => {
  it("routes tunnel rows to ipsecTunnels, others by facet", () => {
    expect(MP.fieldForRow("interfaces", row("vpn", [], { isIpsecTunnel: true }))).toBe("ipsecTunnels");
    expect(MP.fieldForRow("interfaces", row("port1", []))).toBe("interfaces");
    expect(MP.fieldForRow("storage", row("/var", []))).toBe("storage");
  });
});

describe("setStaged (diff model)", () => {
  it("staging a value equal to the server state deletes the key", () => {
    const staged = new Map<string, boolean>();
    MP.setStaged(staged, "k", true, false);
    expect(staged.get("k")).toBe(true);
    MP.setStaged(staged, "k", false, false); // back to server truth
    expect(staged.has("k")).toBe(false);
  });
});

describe("rowState", () => {
  it("computes tri-state over server + staged effective values", () => {
    const r = row("port1", [{ a: 0, pinned: true }, { a: 1, pinned: false }, { a: 2, pinned: false }]);
    const i = inv([r]);
    const staged = new Map<string, boolean>();
    expect(MP.rowState("interfaces", r, i, staged)).toEqual({ on: 1, total: 3, state: "indeterminate" });

    // Stage the two unpinned devices on → checked.
    MP.toggleDevice("interfaces", r, i, staged, r.devices[1]!);
    MP.toggleDevice("interfaces", r, i, staged, r.devices[2]!);
    expect(MP.rowState("interfaces", r, i, staged).state).toBe("checked");

    // Stage the server-pinned one off → back to indeterminate.
    MP.toggleDevice("interfaces", r, i, staged, r.devices[0]!);
    expect(MP.rowState("interfaces", r, i, staged).state).toBe("indeterminate");
  });
});

describe("cycleRow", () => {
  it("partial → pin all; checked → unpin all; staged entries matching server state vanish", () => {
    const r = row("port1", [{ a: 0, pinned: true }, { a: 1, pinned: false }]);
    const i = inv([r]);
    const staged = new Map<string, boolean>();

    // Partial: one more click takes all of them.
    expect(MP.cycleRow("interfaces", r, i, staged)).toBe(true);
    expect(MP.rowState("interfaces", r, i, staged).state).toBe("checked");
    // Device A was already pinned on the server — no diff stored for it.
    expect(staged.has(MP.stageKey("interfaces", "A", "port1"))).toBe(false);
    expect(staged.get(MP.stageKey("interfaces", "B", "port1"))).toBe(true);

    // Checked: next click unpins everywhere.
    expect(MP.cycleRow("interfaces", r, i, staged)).toBe(false);
    expect(MP.rowState("interfaces", r, i, staged).state).toBe("unchecked");
    expect(staged.get(MP.stageKey("interfaces", "A", "port1"))).toBe(false);
    // Device B is back at its server state (unpinned) — key deleted.
    expect(staged.has(MP.stageKey("interfaces", "B", "port1"))).toBe(false);

    // Unchecked: click pins everywhere again; A returns to server truth.
    expect(MP.cycleRow("interfaces", r, i, staged)).toBe(true);
    expect(staged.has(MP.stageKey("interfaces", "A", "port1"))).toBe(false);
    expect(staged.get(MP.stageKey("interfaces", "B", "port1"))).toBe(true);
  });
});

describe("buildApplyPayload / summarize", () => {
  it("splits staged diffs into pin/unpin deltas with their fields", () => {
    const staged = new Map<string, boolean>([
      [MP.stageKey("interfaces", "A", "port1"), true],
      [MP.stageKey("ipsecTunnels", "A", "vpn-hq"), false],
      [MP.stageKey("storage", "B", "/var"), true],
    ]);
    const payload = MP.buildApplyPayload(staged);
    expect(payload.pin).toEqual(expect.arrayContaining([
      { assetId: "A", name: "port1", field: "interfaces" },
      { assetId: "B", name: "/var", field: "storage" },
    ]));
    expect(payload.unpin).toEqual([{ assetId: "A", name: "vpn-hq", field: "ipsecTunnels" }]);

    const s = MP.summarize(staged);
    expect(s).toEqual({ pins: 2, unpins: 1, devices: 2 }); // A touched twice = one device
  });

  it("empty staged map summarizes to zeros", () => {
    expect(MP.summarize(new Map())).toEqual({ pins: 0, unpins: 0, devices: 0 });
  });
});

describe("tunnel provenance in staging", () => {
  it("a tunnel row and an interface row of the same name stage under different keys", () => {
    const tunnel = row("vpn-hq", [{ a: 0, pinned: false }], { isIpsecTunnel: true, ifType: "tunnel" });
    const iface = row("vpn-hq", [{ a: 0, pinned: false }]);
    const i = inv([tunnel, iface]);
    const staged = new Map<string, boolean>();
    MP.toggleDevice("interfaces", tunnel, i, staged, tunnel.devices[0]!);
    MP.toggleDevice("interfaces", iface, i, staged, iface.devices[0]!);
    expect(staged.size).toBe(2);
    const payload = MP.buildApplyPayload(staged);
    expect(payload.pin.map((p) => p.field).sort()).toEqual(["interfaces", "ipsecTunnels"]);
  });
});
