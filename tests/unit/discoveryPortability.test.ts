/**
 * tests/unit/discoveryPortability.test.ts — `.discovery.json` export / import
 * (public/js/discovery-portability.js).
 *
 * The headline property, borrowed from the automations module: **every export
 * is a valid import.** The stripped `scan` is exactly a route request body, so
 * a round trip must survive without the wizard or the server having to repair
 * anything.
 *
 * The rest of what's pinned is the security and honesty half:
 *
 *  - **credential IDs never leave the install.** They are the only
 *    install-specific ids a Discovery carries and they point into a secret
 *    store; the file is something operators email and commit. They are recorded
 *    by NAME as dependencies instead;
 *  - **the row's identity and any run state are stripped.** Carrying results
 *    into another install would offer devices that are not on its network;
 *  - **a method whose credentials were stripped is kept with an EMPTY list, not
 *    dropped.** `validateScanInput` then refuses it, which is exactly the error
 *    the importer should see — silently demoting an SNMP scan to ICMP-only
 *    looks like it ran fine and found nothing;
 *  - **an import never carries a foreign id** — a property of the code, so the
 *    importer re-strips rather than trusting the file;
 *  - prototype-polluting keys and unbounded nesting are refused, because the
 *    parsed object is copied into the wizard draft;
 *  - the filename round-trips as the name, and a filename that can't yield one
 *    is an error naming the fix rather than a Discovery called "".
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const SRC = readFileSync(resolve(__dirname, "../../public/js/discovery-portability.js"), "utf8");

interface Portability {
  FORMAT_VERSION: number;
  FILE_SUFFIX: string;
  MAX_IMPORT_BYTES: number;
  nameFromFilename: (f: string) => string;
  filenameForExport: (n: string) => string;
  stripForExport: (scan: unknown, catalogs: unknown) => { scan: any; dependencies: any[]; needsCredentials: boolean };
  buildExportFile: (scan: unknown, catalogs: unknown, meta?: unknown) => any;
  parseImportFile: (text: string, filename: string) => any;
  checkDependencies: (deps: unknown[], catalogs: unknown) => any[];
  assertSafeKeys: (v: unknown, d: number) => void;
}

let P: Portability;

beforeAll(() => {
  const g = globalThis as Record<string, any>;
  const win: Record<string, any> = {};
  g.window = win;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  (0, eval)(SRC);
  P = win.PolarisDiscoveryPortability as Portability;
});

/** A saved Discovery as the API returns it, ids and all. */
const saved = () => ({
  id: "aaaaaaaa-0000-4000-8000-000000000000",
  name: "Ashfield management",
  description: "The mgmt VLAN",
  targets: [
    { kind: "cidr", value: "10.4.0.0/24" },
    { kind: "range", value: "10.4.1.10-10.4.1.20" },
  ],
  methods: [
    { type: "icmp", credentialIds: [] },
    { type: "snmp", credentialIds: ["cred-1", "cred-2"] },
  ],
  autoMonitor: { snmp: { interfaces: { byNames: { names: ["port1", "port2"] } } } },
  createdBy: "dmoore",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  lastRunAt: "2026-08-03T00:00:00.000Z",
  // Run state that came along for the ride.
  runId: "run-1",
  hits: [{ address: "10.4.0.9" }],
  selected: ["10.4.0.9"],
});

const catalogs = {
  credentialName: (id: string) => ({ "cred-1": "public", "cred-2": "private" } as Record<string, string>)[id] || id,
  credentials: [{ name: "public" }],
};

describe("stripForExport", () => {
  it("carries the configuration and drops everything install-specific", () => {
    const out = P.stripForExport(saved(), catalogs);
    expect(Object.keys(out.scan).sort()).toEqual(["autoMonitor", "description", "methods", "name", "targets"]);
    expect(out.scan.targets).toHaveLength(2);
    expect(out.scan.autoMonitor.snmp.interfaces.byNames.names).toEqual(["port1", "port2"]);
  });

  it("never emits a credential id, and records the names instead", () => {
    const out = P.stripForExport(saved(), catalogs);
    const json = JSON.stringify(out);
    expect(json).not.toContain("cred-1");
    expect(json).not.toContain("cred-2");
    expect(out.dependencies).toEqual([
      { kind: "credential", name: "public", usedFor: ["snmp"] },
      { kind: "credential", name: "private", usedFor: ["snmp"] },
    ]);
  });

  it("keeps a credentialed method with an EMPTY list rather than dropping it", () => {
    // Dropping it would silently demote an SNMP scan to ICMP-only, which looks
    // like it ran fine and found nothing.
    const out = P.stripForExport(saved(), catalogs);
    expect(out.scan.methods).toEqual([
      { type: "icmp", credentialIds: [] },
      { type: "snmp", credentialIds: [] },
    ]);
    expect(out.needsCredentials).toBe(true);
  });

  it("strips the row's identity and any run state", () => {
    const json = JSON.stringify(P.stripForExport(saved(), catalogs).scan);
    for (const k of ["id", "createdBy", "createdAt", "updatedAt", "lastRunAt", "runId", "hits", "selected"]) {
      expect(json, k).not.toContain(`"${k}"`);
    }
  });

  it("drops malformed targets and unknown methods", () => {
    const out = P.stripForExport({
      name: "x",
      targets: [{ kind: "cidr", value: "10.0.0.0/24" }, { kind: "nope", value: "y" }, { kind: "single" }, null],
      methods: [{ type: "http", credentialIds: [] }, { type: "snmp", credentialIds: [] }, { type: "snmp" }],
    }, {});
    expect(out.scan.targets).toEqual([{ kind: "cidr", value: "10.0.0.0/24" }]);
    // One entry per method; the first wins.
    expect(out.scan.methods).toEqual([{ type: "snmp", credentialIds: [] }]);
  });

  it("emits null autoMonitor rather than an empty object", () => {
    expect(P.stripForExport({ name: "x", targets: [], methods: [], autoMonitor: {} }, {}).scan.autoMonitor).toBeNull();
  });
});

describe("buildExportFile", () => {
  it("puts dependencies FIRST — it is what a human opening the file reads", () => {
    const file = P.buildExportFile(saved(), catalogs);
    expect(Object.keys(file).slice(0, 4)).toEqual(["polarisDiscovery", "exportedAt", "dependencies", "needsCredentialSelection"]);
    expect(Object.keys(file)[Object.keys(file).length - 1]).toBe("scan");
  });

  it("stamps the format version", () => {
    expect(P.buildExportFile(saved(), catalogs).polarisDiscovery).toBe(P.FORMAT_VERSION);
  });
});

describe("parseImportFile — the round trip", () => {
  it("every export is a valid import", () => {
    const file = P.buildExportFile(saved(), catalogs);
    const back = P.parseImportFile(JSON.stringify(file), "Ashfield management.discovery.json");
    expect(back.scan.targets).toEqual(file.scan.targets);
    expect(back.scan.methods).toEqual(file.scan.methods);
    expect(back.scan.autoMonitor).toEqual(file.scan.autoMonitor);
    expect(back.name).toBe("Ashfield management");
  });

  it("takes the name from the FILENAME, not the body", () => {
    const file = P.buildExportFile(saved(), catalogs);
    const back = P.parseImportFile(JSON.stringify(file), "Renamed by an operator.discovery.json");
    expect(back.scan.name).toBe("Renamed by an operator");
  });

  it("never carries a foreign id, even when the file has one", () => {
    // A property of the CODE, not a promise about the file: without the
    // re-strip, the wizard's first save would PUT against an unrelated row.
    const hostile = JSON.stringify({
      polarisDiscovery: 1,
      scan: { ...saved(), id: "someone-elses-row" },
    });
    const back = P.parseImportFile(hostile, "x.discovery.json");
    expect(JSON.stringify(back.scan)).not.toContain("someone-elses-row");
    expect(back.scan.id).toBeUndefined();
  });

  it("accepts a bare configuration someone pasted out of a file", () => {
    const back = P.parseImportFile(JSON.stringify(saved()), "pasted.discovery.json");
    expect(back.scan.targets).toHaveLength(2);
  });

  it("reports a version mismatch as a problem, not a refusal", () => {
    const file = P.buildExportFile(saved(), catalogs);
    const back = P.parseImportFile(JSON.stringify({ ...file, polarisDiscovery: 99 }), "x.discovery.json");
    expect(back.problems.join(" ")).toMatch(/version 99/);
    expect(back.scan.targets).toHaveLength(2);
  });
});

describe("parseImportFile — refusals", () => {
  const good = () => JSON.stringify(P.buildExportFile(saved(), catalogs));

  it("refuses an empty or non-JSON file", () => {
    expect(() => P.parseImportFile("", "x.discovery.json")).toThrow(/empty/i);
    expect(() => P.parseImportFile("not json", "x.discovery.json")).toThrow(/JSON/i);
  });

  it("refuses an oversize file before reading it as a Discovery", () => {
    const huge = "x".repeat(P.MAX_IMPORT_BYTES + 1);
    expect(() => P.parseImportFile(huge, "x.discovery.json")).toThrow(/too large/i);
  });

  it("refuses prototype-polluting keys", () => {
    // The parsed object is copied into the wizard draft, which is where
    // pollution would bite.
    const bad = '{"polarisDiscovery":1,"scan":{"targets":[{"kind":"cidr","value":"10.0.0.0/24"}],"methods":[{"type":"icmp"}],"__proto__":{"x":1}}}';
    expect(() => P.parseImportFile(bad, "x.discovery.json")).toThrow(/will not read/i);
  });

  it("refuses unbounded nesting", () => {
    let deep: any = { v: 1 };
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(() => P.parseImportFile(JSON.stringify({ scan: deep }), "x.discovery.json")).toThrow(/nested too deeply/i);
  });

  it("refuses a file with no targets", () => {
    expect(() => P.parseImportFile('{"polarisDiscovery":1,"scan":{"methods":[{"type":"icmp"}]}}', "x.discovery.json"))
      .toThrow(/no targets/i);
  });

  it("refuses a file whose targets are all unusable", () => {
    const bad = '{"polarisDiscovery":1,"scan":{"targets":[{"kind":"nope","value":"x"}],"methods":[{"type":"icmp"}]}}';
    expect(() => P.parseImportFile(bad, "x.discovery.json")).toThrow(/usable/i);
  });

  it("refuses a file with no probe methods", () => {
    const bad = '{"polarisDiscovery":1,"scan":{"targets":[{"kind":"cidr","value":"10.0.0.0/24"}],"methods":[]}}';
    expect(() => P.parseImportFile(bad, "x.discovery.json")).toThrow(/no probe methods/i);
  });

  it("refuses a filename that can't yield a name, naming the fix", () => {
    expect(() => P.parseImportFile(good(), ".discovery.json")).toThrow(/Rename the file/i);
    expect(() => P.parseImportFile(good(), "..discovery.json")).toThrow(/Rename the file/i);
  });
});

describe("names", () => {
  it("round-trips a name through the filename", () => {
    for (const name of ["Ashfield management", "Site-3 / mgmt", "a".repeat(300)]) {
      const file = P.filenameForExport(name);
      expect(file.endsWith(P.FILE_SUFFIX)).toBe(true);
      expect(P.nameFromFilename(file)).toBeTruthy();
    }
  });

  it("strips path separators and reserved filename characters", () => {
    expect(P.filenameForExport('a/b:c*d?e"f<g>h|i')).toBe("a-b-c-d-e-f-g-h-i.discovery.json");
    expect(P.nameFromFilename("C:\\Users\\x\\Downloads\\Site 3.discovery.json")).toBe("Site 3");
  });

  it("falls back to a usable filename for an empty name", () => {
    expect(P.filenameForExport("")).toBe("discovery.discovery.json");
    expect(P.filenameForExport("   ")).toBe("discovery.discovery.json");
  });

  it("drops the suffix once, not any dot-segment", () => {
    expect(P.nameFromFilename("v1.2 rollout.discovery.json")).toBe("v1.2 rollout");
    // A plain .json also works — someone renames these.
    expect(P.nameFromFilename("mgmt.json")).toBe("mgmt");
  });
});

describe("checkDependencies", () => {
  it("marks a credential present or missing against this install", () => {
    const deps = [
      { kind: "credential", name: "public" },
      { kind: "credential", name: "private" },
    ];
    const out = P.checkDependencies(deps, catalogs);
    expect(out[0].present).toBe(true);
    expect(out[1].present).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(P.checkDependencies([{ kind: "credential", name: "PUBLIC" }], catalogs)[0].present).toBe(true);
  });

  it("answers null — can't tell — for a kind with no catalogue", () => {
    // Never a false "missing".
    expect(P.checkDependencies([{ kind: "something-else", name: "x" }], catalogs)[0].present).toBeNull();
    expect(P.checkDependencies([{ kind: "credential", name: "x" }], {})[0].present).toBe(false);
  });
});
