/**
 * tests/unit/maintenanceScheduleService.test.ts
 *
 * Behavioral coverage for the maintenance reconcile (enter/exit diff against
 * open window rows, status parking/restore via maintenanceReturnStatus,
 * overlapping schedules, disabled/deleted/criteria-drop exits, operator-
 * release re-entry suppression, self-heal of clobbered statuses) plus the
 * CRUD-side validation and the immediate-entry-on-create path.
 *
 * Prisma is replaced by a small in-memory fake (assets + window rows +
 * schedules) that answers exactly the query shapes the service issues, so
 * the tests assert end-state like an integration test but run DB-free. The
 * wall clock is pinned with fake timers — recurrence math is covered
 * separately in maintenanceRecurrence.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  type FakeAsset = {
    id: string;
    hostname: string | null;
    ipAddress: string | null;
    model: string | null;
    manufacturer: string | null;
    status: string;
    maintenanceReturnStatus: string | null;
    monitored: boolean;
    statusChangedAt?: Date;
    statusChangedBy?: string;
  };
  type FakeWindow = {
    id: string;
    assetId: string;
    scheduleId: string | null;
    scheduleName: string;
    startedAt: Date;
    endedAt: Date | null;
    endReason: string | null;
  };
  type FakeSchedule = {
    id: string;
    name: string;
    enabled: boolean;
    criteria: unknown | null;
    assetIds: string[];
    schedule: unknown;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  };

  const db = {
    assets: [] as FakeAsset[],
    windows: [] as FakeWindow[],
    schedules: [] as FakeSchedule[],
  };
  let seq = 1;
  const nextId = () => `gen-${seq++}`;

  function assetMatches(a: FakeAsset, where: any): boolean {
    if (!where) return true;
    if (where.id?.in && !where.id.in.includes(a.id)) return false;
    if (typeof where.id === "string" && a.id !== where.id) return false;
    if (where.monitored === true && !a.monitored) return false;
    if (where.status?.not && a.status === where.status.not) return false;
    return true;
  }
  function windowMatches(w: FakeWindow, where: any): boolean {
    if (!where) return true;
    if (where.id?.in && !where.id.in.includes(w.id)) return false;
    if (where.endedAt === null && w.endedAt !== null) return false;
    if (where.endedAt && typeof where.endedAt === "object") {
      if ("not" in where.endedAt && where.endedAt.not === null && w.endedAt === null) return false;
      if ("lt" in where.endedAt && !(w.endedAt !== null && w.endedAt < where.endedAt.lt)) return false;
      if ("gte" in where.endedAt && !(w.endedAt === null || w.endedAt >= where.endedAt.gte)) return false;
    }
    if (typeof where.assetId === "string" && w.assetId !== where.assetId) return false;
    if (where.assetId?.in && !where.assetId.in.includes(w.assetId)) return false;
    if (where.scheduleId?.in && !(w.scheduleId && where.scheduleId.in.includes(w.scheduleId))) return false;
    if (where.endReason && w.endReason !== where.endReason) return false;
    if (where.startedAt?.lte && !(w.startedAt <= where.startedAt.lte)) return false;
    return true;
  }
  // Simplified OR support for listAssetWindows' overlap query.
  function windowMatchesWithOr(w: FakeWindow, where: any): boolean {
    if (!windowMatches(w, { ...where, OR: undefined })) return false;
    if (Array.isArray(where?.OR)) return where.OR.some((sub: any) => windowMatches(w, sub));
    return true;
  }

  const prisma = {
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    asset: {
      findMany: async (args: any = {}) =>
        db.assets.filter((a) => assetMatches(a, args.where)).map((a) => ({ ...a })),
      findUnique: async (args: any) => {
        const a = db.assets.find((x) => x.id === args.where.id);
        return a ? { ...a } : null;
      },
      update: async (args: any) => {
        const a = db.assets.find((x) => x.id === args.where.id);
        if (a) Object.assign(a, args.data);
        return a ? { ...a } : null;
      },
      updateMany: async (args: any) => {
        let count = 0;
        for (const a of db.assets) {
          if (!assetMatches(a, args.where)) continue;
          Object.assign(a, args.data);
          count++;
        }
        return { count };
      },
    },
    assetMaintenanceWindow: {
      findMany: async (args: any = {}) =>
        db.windows.filter((w) => windowMatchesWithOr(w, args.where)).map((w) => ({ ...w })),
      updateMany: async (args: any) => {
        let count = 0;
        for (const w of db.windows) {
          if (!windowMatches(w, args.where)) continue;
          Object.assign(w, args.data);
          count++;
        }
        return { count };
      },
      createMany: async (args: any) => {
        for (const row of args.data) {
          db.windows.push({ id: nextId(), endedAt: null, endReason: null, ...row });
        }
        return { count: args.data.length };
      },
      deleteMany: async (args: any) => {
        const keep = db.windows.filter((w) => !windowMatches(w, args.where));
        const count = db.windows.length - keep.length;
        db.windows = keep;
        return { count };
      },
    },
    maintenanceSchedule: {
      findMany: async () => db.schedules.map((s) => ({ ...s })),
      findUnique: async (args: any) => {
        const s = db.schedules.find((x) => x.id === args.where.id);
        return s ? { ...s } : null;
      },
      create: async (args: any) => {
        const row: FakeSchedule = {
          id: nextId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          criteria: null,
          createdBy: null,
          ...args.data,
        };
        db.schedules.push(row);
        return { ...row };
      },
      update: async (args: any) => {
        const s = db.schedules.find((x) => x.id === args.where.id)!;
        Object.assign(s, args.data, { updatedAt: new Date() });
        return { ...s };
      },
      delete: async (args: any) => {
        const idx = db.schedules.findIndex((x) => x.id === args.where.id);
        const [row] = db.schedules.splice(idx, 1);
        // Prisma onDelete: SetNull on the window FK.
        for (const w of db.windows) if (w.scheduleId === row.id) w.scheduleId = null;
        return { ...row };
      },
    },
  };

  return { db, prisma, reset: () => { db.assets = []; db.windows = []; db.schedules = []; seq = 1; } };
});

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async () => {}),
  logEventsBatch: vi.fn(async () => 0),
}));
vi.mock("../../src/services/tagAssignmentService.js", () => ({
  // Tests hand in pre-normalized criteria (or null); resolveMatchingAssetIds
  // is stubbed per-test. The real normalize/resolve pipeline has its own
  // coverage in tagAssignment tests.
  normalizeCriteria: vi.fn((raw: unknown) => (raw == null ? null : raw)),
  resolveMatchingAssetIds: vi.fn(async () => new Set<string>()),
}));

import {
  reconcileMaintenance,
  createSchedule,
  deleteSchedule,
  operatorReleaseAsset,
  previewTargets,
} from "../../src/services/maintenanceScheduleService.js";
import { logEventsBatch } from "../../src/services/eventLogService.js";
import { resolveMatchingAssetIds } from "../../src/services/tagAssignmentService.js";

const NOW = new Date(2026, 6, 10, 12, 0, 0); // 2026-07-10 12:00 local

function asset(id: string, over: Partial<{ status: string; monitored: boolean; maintenanceReturnStatus: string | null; hostname: string }> = {}) {
  return {
    id,
    hostname: over.hostname ?? id.toUpperCase(),
    ipAddress: null,
    model: null,
    manufacturer: null,
    status: over.status ?? "active",
    maintenanceReturnStatus: over.maintenanceReturnStatus ?? null,
    monitored: over.monitored ?? true,
  };
}

/** A one-shot spanning the pinned NOW. */
const ACTIVE_ONESHOT = { version: 1, kind: "oneshot", startAt: "2026-07-10T11:00", endAt: "2026-07-10T14:00" };
/** A one-shot that already ended before NOW. */
const PAST_ONESHOT = { version: 1, kind: "oneshot", startAt: "2026-07-09T11:00", endAt: "2026-07-09T14:00" };
/** Daily 11:00–14:00 — active at the pinned NOW. */
const DAILY = { version: 1, kind: "recurring", freq: "daily", startTime: "11:00", endTime: "14:00" };

function schedule(id: string, shape: unknown, over: Partial<{ enabled: boolean; assetIds: string[]; criteria: unknown; name: string }> = {}) {
  return {
    id,
    name: over.name ?? `Schedule ${id}`,
    enabled: over.enabled ?? true,
    criteria: over.criteria ?? null,
    assetIds: over.assetIds ?? [],
    schedule: shape,
    createdBy: null,
    createdAt: new Date(2026, 0, 1),
    updatedAt: new Date(2026, 0, 1),
  };
}

const openWindows = () => h.db.windows.filter((w) => w.endedAt === null);
const assetById = (id: string) => h.db.assets.find((a) => a.id === id)!;

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reconcileMaintenance — enter", () => {
  it("enters matched monitored assets: window row + status flip + parked return status", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }));

    await reconcileMaintenance();

    expect(openWindows()).toHaveLength(1);
    expect(openWindows()[0]).toMatchObject({ assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1" });
    expect(assetById("a1")).toMatchObject({
      status: "maintenance",
      maintenanceReturnStatus: "active",
      statusChangedBy: "system:maintenance",
    });
    expect(vi.mocked(logEventsBatch)).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ action: "maintenance.entered", resourceId: "a1" })]),
    );
  });

  it("never targets unmonitored assets", async () => {
    h.db.assets.push(asset("a1", { monitored: false }));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }));

    await reconcileMaintenance();

    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1").status).toBe("active");
  });

  it("does nothing when the schedule is out of window or disabled", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", PAST_ONESHOT, { assetIds: ["a1"] }));
    h.db.schedules.push(schedule("s2", ACTIVE_ONESHOT, { assetIds: ["a1"], enabled: false }));

    await reconcileMaintenance();

    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1").status).toBe("active");
  });

  it("preserves a manually-set maintenance status verbatim (no restore loop)", async () => {
    h.db.assets.push(asset("a1", { status: "maintenance" }));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }));

    await reconcileMaintenance();
    expect(assetById("a1").maintenanceReturnStatus).toBe("maintenance");

    // Window ends → restore to the operator's manual "maintenance".
    vi.setSystemTime(new Date(2026, 6, 10, 15, 0, 0));
    await reconcileMaintenance();
    expect(assetById("a1")).toMatchObject({ status: "maintenance", maintenanceReturnStatus: null });
    expect(openWindows()).toHaveLength(0);
  });

  it("unions criteria matches with explicit assetIds", async () => {
    h.db.assets.push(asset("a1"), asset("a2"));
    vi.mocked(resolveMatchingAssetIds).mockResolvedValue(new Set(["a2"]));
    h.db.schedules.push(
      schedule("s1", ACTIVE_ONESHOT, {
        assetIds: ["a1"],
        criteria: { version: 1, match: "all", rules: [{ field: "hostname", op: "contains", values: ["A2"] }] },
      }),
    );

    await reconcileMaintenance();

    expect(openWindows().map((w) => w.assetId).sort()).toEqual(["a1", "a2"]);
  });
});

describe("reconcileMaintenance — exit", () => {
  it("closes the window and restores the parked status when the schedule ends", async () => {
    h.db.assets.push(asset("a1", { status: "maintenance", maintenanceReturnStatus: "storage" }));
    h.db.schedules.push(schedule("s1", PAST_ONESHOT, { assetIds: ["a1"] }));
    h.db.windows.push({ id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1", startedAt: new Date(2026, 6, 9, 11, 0), endedAt: null, endReason: null });

    await reconcileMaintenance();

    expect(openWindows()).toHaveLength(0);
    expect(h.db.windows[0]).toMatchObject({ endReason: "schedule" });
    expect(assetById("a1")).toMatchObject({ status: "storage", maintenanceReturnStatus: null });
    expect(vi.mocked(logEventsBatch)).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ action: "maintenance.exited", resourceId: "a1" })]),
    );
  });

  it("closes with reason 'disabled' / 'deleted' / 'criteria' appropriately", async () => {
    h.db.assets.push(
      asset("a1", { status: "maintenance", maintenanceReturnStatus: "active" }),
      asset("a2", { status: "maintenance", maintenanceReturnStatus: "active" }),
      asset("a3", { status: "maintenance", maintenanceReturnStatus: "active" }),
    );
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"], enabled: false }));
    h.db.schedules.push(schedule("s3", ACTIVE_ONESHOT, { assetIds: [] })); // a3 no longer matches
    const started = new Date(2026, 6, 10, 11, 0);
    h.db.windows.push(
      { id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1", startedAt: started, endedAt: null, endReason: null },
      { id: "w2", assetId: "a2", scheduleId: null, scheduleName: "Gone", startedAt: started, endedAt: null, endReason: null },
      { id: "w3", assetId: "a3", scheduleId: "s3", scheduleName: "Schedule s3", startedAt: started, endedAt: null, endReason: null },
    );

    await reconcileMaintenance();

    const byId = Object.fromEntries(h.db.windows.map((w) => [w.id, w]));
    expect(byId.w1.endReason).toBe("disabled");
    expect(byId.w2.endReason).toBe("deleted");
    expect(byId.w3.endReason).toBe("criteria");
    for (const id of ["a1", "a2", "a3"]) expect(assetById(id).status).toBe("active");
  });

  it("overlapping schedules: enter once, exit only when the LAST window closes", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(
      schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }),
      schedule("s2", DAILY, { assetIds: ["a1"] }),
    );

    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(2);
    expect(assetById("a1")).toMatchObject({ status: "maintenance", maintenanceReturnStatus: "active" });

    // 14:30 — the one-shot ended (14:00) AND the daily window ended (14:00).
    // Advance in two steps: first to 13:30 (one-shot still ends at 14:00 but
    // daily also ends 14:00 — both still open at 13:30).
    vi.setSystemTime(new Date(2026, 6, 10, 13, 30));
    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(2);
    expect(assetById("a1").status).toBe("maintenance");

    // Disable s2 → its window closes, but s1 is still active → stays in maintenance.
    h.db.schedules.find((s) => s.id === "s2")!.enabled = false;
    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(1);
    expect(assetById("a1").status).toBe("maintenance");

    // s1's one-shot ends → last window closes → restore.
    vi.setSystemTime(new Date(2026, 6, 10, 14, 30));
    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1")).toMatchObject({ status: "active", maintenanceReturnStatus: null });
  });

  it("leaves an operator-moved status alone on exit (clears the parked column only)", async () => {
    // Operator moved status off maintenance mid-window through a path that
    // closed no windows (defensive case).
    h.db.assets.push(asset("a1", { status: "decommissioned", maintenanceReturnStatus: "active" }));
    h.db.schedules.push(schedule("s1", PAST_ONESHOT, { assetIds: ["a1"] }));
    h.db.windows.push({ id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1", startedAt: new Date(2026, 6, 9, 11, 0), endedAt: null, endReason: null });

    await reconcileMaintenance();

    expect(assetById("a1")).toMatchObject({ status: "decommissioned", maintenanceReturnStatus: null });
  });
});

describe("reconcileMaintenance — operator release & self-heal", () => {
  it("does not re-enter during the occurrence the operator released", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", DAILY, { assetIds: ["a1"] }));
    // Operator released 30 minutes ago — inside today's 11:00-14:00 occurrence.
    h.db.windows.push({
      id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1",
      startedAt: new Date(2026, 6, 10, 11, 0), endedAt: new Date(2026, 6, 10, 11, 30), endReason: "operator",
    });

    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1").status).toBe("active");

    // Next day's occurrence → re-enters normally.
    vi.setSystemTime(new Date(2026, 6, 11, 12, 0));
    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(1);
    expect(assetById("a1").status).toBe("maintenance");
  });

  it("operatorReleaseAsset closes all open windows without touching status", async () => {
    h.db.assets.push(asset("a1", { status: "maintenance", maintenanceReturnStatus: "active" }));
    h.db.windows.push(
      { id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "S1", startedAt: NOW, endedAt: null, endReason: null },
      { id: "w2", assetId: "a1", scheduleId: "s2", scheduleName: "S2", startedAt: NOW, endedAt: null, endReason: null },
    );

    const released = await operatorReleaseAsset("a1", "operator1");

    expect(released).toBe(true);
    expect(openWindows()).toHaveLength(0);
    expect(h.db.windows.every((w) => w.endReason === "operator")).toBe(true);
    // Status untouched (the caller's own write wins); parked column cleared.
    expect(assetById("a1")).toMatchObject({ status: "maintenance", maintenanceReturnStatus: null });
  });

  it("self-heals a status clobbered by a system writer mid-window", async () => {
    h.db.assets.push(asset("a1", { status: "maintenance", maintenanceReturnStatus: "active" }));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }));
    h.db.windows.push({ id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1", startedAt: new Date(2026, 6, 10, 11, 0), endedAt: null, endReason: null });

    // A discovery path flips status mid-window (guards missed it).
    assetById("a1").status = "disabled";
    // The reconcile needs a diff to reach the self-heal — add an unrelated change.
    h.db.assets.push(asset("a2"));
    h.db.schedules[0].assetIds = ["a1", "a2"];

    await reconcileMaintenance();

    // Re-flipped, and the clobbered value absorbed so exit restores it.
    expect(assetById("a1")).toMatchObject({ status: "maintenance", maintenanceReturnStatus: "disabled" });

    vi.setSystemTime(new Date(2026, 6, 10, 15, 0));
    await reconcileMaintenance();
    expect(assetById("a1")).toMatchObject({ status: "disabled", maintenanceReturnStatus: null });
  });
});

describe("schedule CRUD", () => {
  it("createSchedule with a now-active one-shot enters immediately (inline reconcile)", async () => {
    h.db.assets.push(asset("a1"));

    await createSchedule(
      { name: "Ad-hoc — A1", assetIds: ["a1"], schedule: ACTIVE_ONESHOT },
      "operator1",
    );

    expect(openWindows()).toHaveLength(1);
    expect(assetById("a1").status).toBe("maintenance");
  });

  it("rejects empty targets, status criteria, and malformed schedules", async () => {
    await expect(createSchedule({ name: "x", schedule: ACTIVE_ONESHOT })).rejects.toThrow(/target at least one asset/);
    await expect(
      createSchedule({
        name: "x",
        criteria: { version: 1, match: "all", rules: [{ field: "status", op: "exact", values: ["active"] }] },
        schedule: ACTIVE_ONESHOT,
      }),
    ).rejects.toThrow(/cannot filter on status/);
    await expect(
      createSchedule({ name: "x", assetIds: ["a1"], schedule: { version: 1, kind: "recurring", freq: "weekly" } }),
    ).rejects.toThrow(/Invalid schedule/);
  });

  it("deleteSchedule exits its open windows and restores statuses", async () => {
    h.db.assets.push(asset("a1"));
    const created = await createSchedule({ name: "S", assetIds: ["a1"], schedule: ACTIVE_ONESHOT }, "op");
    expect(assetById("a1").status).toBe("maintenance");

    await deleteSchedule(created.id, "op");

    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1")).toMatchObject({ status: "active", maintenanceReturnStatus: null });
  });
});

describe("previewTargets", () => {
  it("returns only monitored assets, capped, with the total", async () => {
    for (let i = 0; i < 60; i++) h.db.assets.push(asset(`a${i}`, { hostname: `HOST-${String(i).padStart(2, "0")}` }));
    h.db.assets.push(asset("um1", { monitored: false }));
    const ids = h.db.assets.map((a) => a.id);

    const res = await previewTargets({ assetIds: ids });

    expect(res.total).toBe(60); // unmonitored excluded
    expect(res.assets).toHaveLength(50); // cap
    expect(res.assets[0].hostname).toBe("HOST-00"); // hostname-sorted
  });
});
