/**
 * tests/unit/automationScripts.test.ts — B5 script registry + server runner:
 *   - automationScriptService CRUD (sha256 on save, warning Events, delete
 *     refused while referenced, requestScriptRun validation),
 *   - automationScriptRunner.executeServerScript against REAL interpreters
 *     (cmd on Windows, sh elsewhere): success, non-zero exit, timeout kill,
 *     args as a single argv entry, env context vars.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── configurable fake prisma ─────────────────────────────────────────────────
const db = {
  scripts: [] as any[],
  runs: [] as any[],
  rules: [] as any[],
};
let seq = 0;

vi.mock("../../src/db.js", () => ({
  prisma: {
    automationScript: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        const ids: string[] | undefined = where?.id?.in;
        return ids ? db.scripts.filter((s) => ids.includes(s.id)) : db.scripts;
      }),
      // Shallow-copy like real Prisma (a returned row is a snapshot, not a
      // live reference the next update mutates).
      findUnique: vi.fn(async ({ where }: any) => {
        const s = db.scripts.find((x) => x.id === where.id);
        return s ? { ...s } : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const s = { id: `s${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.scripts.push(s);
        return s;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const s = db.scripts.find((x) => x.id === where.id);
        Object.assign(s, data);
        return s;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const i = db.scripts.findIndex((x) => x.id === where.id);
        db.scripts.splice(i, 1);
      }),
    },
    automationScriptRun: {
      create: vi.fn(async ({ data }: any) => {
        const r = { id: `run${++seq}`, status: "pending", requestedAt: new Date(), ...data };
        db.runs.push(r);
        return r;
      }),
      findMany: vi.fn(async () => db.runs),
      update: vi.fn(async ({ where, data }: any) => {
        const r = db.runs.find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    notificationRule: { findMany: vi.fn(async () => db.rules) },
  },
}));

const logEventMock = vi.fn(async () => {});
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }));

import {
  createScript,
  updateScript,
  deleteScript,
  requestScriptRun,
  sha256Hex,
  type ScriptInput,
} from "../../src/services/automationScriptService.js";
import { executeServerScript } from "../../src/services/automationScriptRunner.js";

const WIN = process.platform === "win32";
const SHELL = WIN ? ("cmd" as const) : ("sh" as const);

function scriptInput(overrides: Partial<ScriptInput> = {}): ScriptInput {
  return {
    name: `test-script-${++seq}`,
    interpreter: SHELL,
    body: WIN ? "@echo hello" : "echo hello",
    runTarget: "server",
    ...overrides,
  };
}

beforeEach(() => {
  db.scripts.length = 0;
  db.runs.length = 0;
  db.rules.length = 0;
  logEventMock.mockClear();
});

describe("automationScriptService CRUD", () => {
  it("createScript computes sha256 and stamps a warning Event", async () => {
    const s = await createScript(scriptInput({ body: "echo a" }), "operator1");
    expect(s.sha256).toBe(sha256Hex("echo a"));
    const evt = logEventMock.mock.calls[0]![0] as any;
    expect(evt.action).toBe("automation_script.created");
    expect(evt.level).toBe("warning");
  });

  it("updateScript flags a BODY change with old/new sha256 at warning level", async () => {
    const s = await createScript(scriptInput({ body: "echo a" }), "op");
    logEventMock.mockClear();
    await updateScript(s.id, scriptInput({ name: s.name, body: "echo b" }), "op");
    const evt = logEventMock.mock.calls[0]![0] as any;
    expect(evt.level).toBe("warning");
    expect(evt.details.oldSha256).toBe(sha256Hex("echo a"));
    expect(evt.details.newSha256).toBe(sha256Hex("echo b"));

    logEventMock.mockClear();
    await updateScript(s.id, scriptInput({ name: s.name, body: "echo b", description: "same body" }), "op");
    expect((logEventMock.mock.calls[0]![0] as any).level).toBe("info");
  });

  it("rejects oversized bodies and bad timeouts", async () => {
    await expect(createScript(scriptInput({ body: "x".repeat(64 * 1024 + 1) }))).rejects.toThrow(/64 KB/);
    await expect(createScript(scriptInput({ timeoutSec: 601 }))).rejects.toThrow(/timeoutSec/);
  });

  it("deleteScript refuses while an automation references the script (actions or tiers)", async () => {
    const s = await createScript(scriptInput());
    db.rules.push({
      id: "r1", name: "uses script",
      reset: { mode: "manual" },
      actions: [{ type: "script", scriptId: s.id, runOn: "server" }],
      targets: [], escalation: null, emailComposition: null, clearBehavior: "manual", clearAfterSec: null,
    });
    await expect(deleteScript(s.id)).rejects.toThrow(/used by 1 automation/);
    db.rules.length = 0;
    await expect(deleteScript(s.id)).resolves.toBeUndefined();
  });
});

describe("requestScriptRun validation", () => {
  it("creates a pending server run snapshotting name/sha/timeout", async () => {
    const s = await createScript(scriptInput({ timeoutSec: 30 }));
    const { runId } = await requestScriptRun({ scriptId: s.id, runOn: "server", args: "a b", requestedBy: "system:automation" });
    const run = db.runs.find((r) => r.id === runId)!;
    expect(run.scriptName).toBe(s.name);
    expect(run.sha256).toBe(s.sha256);
    expect(run.timeoutSec).toBe(30);
    expect(run.status).toBe("pending");
  });

  it("refuses disabled scripts, incompatible targets, and (for now) agent runs", async () => {
    const s = await createScript(scriptInput({ enabled: false }));
    await expect(requestScriptRun({ scriptId: s.id, runOn: "server", args: null, requestedBy: "x" })).rejects.toThrow(/disabled/);

    const serverOnly = await createScript(scriptInput());
    await expect(requestScriptRun({ scriptId: serverOnly.id, runOn: "agent", args: null, requestedBy: "x" })).rejects.toThrow(/only runs on server/);

    const either = await createScript(scriptInput({ runTarget: "either" }));
    await expect(requestScriptRun({ scriptId: either.id, runOn: "agent", args: null, requestedBy: "x" })).rejects.toThrow(/not available yet/);
  });
});

describe("executeServerScript (real interpreter)", () => {
  async function makeRun(body: string, opts: { args?: string | null; timeoutSec?: number } = {}) {
    const s = await createScript(scriptInput({ body }));
    return {
      id: `run${++seq}`,
      scriptId: s.id,
      args: opts.args ?? null,
      timeoutSec: opts.timeoutSec ?? 10,
      notificationId: "n-1",
      ruleId: "r-1",
      assetId: "a-1",
    };
  }

  it("captures stdout and exit 0 on success", async () => {
    const run = await makeRun(WIN ? "@echo hello-from-script" : "echo hello-from-script");
    const res = await executeServerScript(run);
    expect(res.status).toBe("succeeded");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hello-from-script");
  });

  it("reports a non-zero exit as failed with the exit code", async () => {
    const run = await makeRun(WIN ? "@exit /b 3" : "exit 3");
    const res = await executeServerScript(run);
    expect(res.status).toBe("failed");
    expect(res.exitCode).toBe(3);
  });

  it("kills a wedged script at timeoutSec and reports timeout", async () => {
    const run = await makeRun(WIN ? "@ping -n 30 127.0.0.1 >nul" : "sleep 30", { timeoutSec: 1 });
    const res = await executeServerScript(run);
    expect(res.status).toBe("timeout");
  }, 15_000);

  it("passes args as ONE argv entry and exposes the alert env vars", async () => {
    const body = WIN
      ? "@echo arg1=%1&& @echo alert=%POLARIS_ALERT_ID%"
      : 'echo "arg1=$1"; echo "alert=$POLARIS_ALERT_ID"';
    const run = await makeRun(body, { args: "two words" });
    const res = await executeServerScript(run);
    expect(res.status).toBe("succeeded");
    // "two words" must arrive as a single positional argument, not split.
    expect(res.stdout).toMatch(/arg1=.?two words.?\s/);
    expect(res.stdout).toContain("alert=n-1");
  });

  it("fails cleanly when the script vanished from the registry", async () => {
    const res = await executeServerScript({ id: "x", scriptId: "gone", args: null, timeoutSec: 5, notificationId: null, ruleId: null, assetId: null });
    expect(res.status).toBe("failed");
    expect(res.stderr).toMatch(/no longer exists/);
  });
});
