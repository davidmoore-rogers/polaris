/**
 * tests/unit/savedDashboardService.test.ts
 *
 * The pure half of saved dashboards. It matters for the same reason the saved
 * filter validators do, only more so: a PUBLIC dashboard's layout is JSON
 * authored in one operator's browser and replayed into everyone else's — and
 * into the UNAUTHENTICATED Dash wallboard — so anything the canvas can't itself
 * produce is refused at the door rather than stored.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const {
  countWidgets,
  normalizeName,
  sanitizeDashboardLayout,
} = await import("../../src/services/savedDashboardService.js");
const { MAX_WIDGETS, MAX_COLUMNS } = await import("../../src/utils/dashboardLayout.js");

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

function widget(id: string, type = "statusSummary") {
  return { id, type, height: 1, config: {} };
}

describe("sanitizeDashboardLayout", () => {
  it("round-trips a real column stack", () => {
    const layout = sanitizeDashboardLayout({
      columns: [
        { id: UUID_A, width: 6, widgets: [widget(UUID_B), { ...widget(UUID_C, "downNodes"), height: 2 }] },
      ],
    });
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0].width).toBe(6);
    expect(layout.columns[0].widgets.map((w) => w.type)).toEqual(["statusSummary", "downNodes"]);
    expect(countWidgets(layout)).toBe(2);
  });

  it("defaults a widget's absent config rather than rejecting it", () => {
    const layout = sanitizeDashboardLayout({
      columns: [{ id: UUID_A, width: 12, widgets: [{ id: UUID_B, type: "topCpu", height: 3 }] }],
    });
    expect(layout.columns[0].widgets[0].config).toEqual({});
  });

  it("accepts an EMPTY canvas — a placeholder screen is a legitimate thing to save", () => {
    expect(sanitizeDashboardLayout({ columns: [] })).toEqual({ columns: [] });
    expect(sanitizeDashboardLayout({})).toEqual({ columns: [] });
  });

  it("rejects a non-object layout", () => {
    expect(() => sanitizeDashboardLayout(null)).toThrowError(/layout must be an object/);
    expect(() => sanitizeDashboardLayout([])).toThrowError(/layout must be an object/);
    expect(() => sanitizeDashboardLayout("columns")).toThrowError(/layout must be an object/);
  });

  it("rejects a width or height the canvas cannot render", () => {
    expect(() =>
      sanitizeDashboardLayout({ columns: [{ id: UUID_A, width: 5, widgets: [] }] }),
    ).toThrowError(/layout.columns is invalid/);
    expect(() =>
      sanitizeDashboardLayout({
        columns: [{ id: UUID_A, width: 6, widgets: [{ id: UUID_B, type: "topCpu", height: 9 }] }],
      }),
    ).toThrowError(/layout.columns is invalid/);
  });

  it("rejects an id that isn't a uuid — instance ids are the canvas's own keys", () => {
    expect(() =>
      sanitizeDashboardLayout({ columns: [{ id: "col-1", width: 6, widgets: [] }] }),
    ).toThrowError(/layout.columns is invalid/);
  });

  it("caps the column count", () => {
    const columns = Array.from({ length: MAX_COLUMNS + 1 }, (_v, i) => ({
      id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      width: 3,
      widgets: [],
    }));
    expect(() => sanitizeDashboardLayout({ columns })).toThrowError(/layout.columns is invalid/);
  });

  it("caps widgets across the WHOLE dashboard, not per column", () => {
    // Two columns, each under the per-array cap, together over it — the case a
    // per-column check alone would wave through.
    const half = Math.ceil((MAX_WIDGETS + 2) / 2);
    const mk = (n: number, seed: number) =>
      Array.from({ length: n }, (_v, i) => widget(`${String(seed + i).padStart(8, "0")}-0000-4000-8000-000000000000`));
    expect(() =>
      sanitizeDashboardLayout({
        columns: [
          { id: UUID_A, width: 6, widgets: mk(half, 1000) },
          { id: UUID_B, width: 6, widgets: mk(half, 5000) },
        ],
      }),
    ).toThrowError(/too many widgets/);
  });
});

describe("normalizeName", () => {
  it("is the SAME rule saved filters use — one vocabulary for named presets", async () => {
    const filters = await import("../../src/services/savedFilterService.js");
    expect(normalizeName).toBe(filters.normalizeName);
    expect(normalizeName("  NOC   overview ")).toBe("NOC overview");
    expect(() => normalizeName("  ")).toThrowError(/name is required/);
    expect(() => normalizeName("bad\u0007name")).toThrowError(/control characters/);
  });
});
