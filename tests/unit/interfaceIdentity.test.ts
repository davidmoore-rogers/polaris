import { describe, it, expect } from "vitest";
import {
  buildInterfaceIdentity,
  canonicalInterfaceName,
  canonicalizeInterfacePins,
  canonicalizeInterfaceRows,
  EMPTY_INTERFACE_IDENTITY,
} from "../../src/utils/interfaceIdentity.js";

/**
 * The prod row set this exists for (MORGAN-148E-1, 2026-08-25): a FortiSwitch
 * reports `ifAlias` = the port name and carries the operator's label in
 * `description`, which is what an `ifDescr`-only scrape renamed the port to.
 */
const SWITCH_ROWS = [
  { ifName: "port8",  alias: "port8",  description: "Erin Bachich" },
  { ifName: "port9",  alias: "port9",  description: "MORGAN-221E-1" },
  { ifName: "port12", alias: "port12", description: "Tim Smith" },
  { ifName: "port33", alias: "port33", description: null },
  { ifName: "4FPTF22010554-0", alias: "4FPTF22010554-0", description: "" },
];

describe("buildInterfaceIdentity", () => {
  it("indexes every ifName and maps each description back to its port", () => {
    const id = buildInterfaceIdentity(SWITCH_ROWS);
    expect(id.names.has("port9")).toBe(true);
    expect(id.names.has("4FPTF22010554-0")).toBe(true);
    expect(id.labelToName.get("MORGAN-221E-1")).toBe("port9");
    expect(id.labelToName.get("Tim Smith")).toBe("port12");
  });

  it("never treats an alias that IS a port name as a label", () => {
    const id = buildInterfaceIdentity(SWITCH_ROWS);
    // alias === ifName on a FortiSwitch, so this must not become a self-entry.
    expect(id.labelToName.has("port9")).toBe(false);
    expect(id.labelToName.size).toBe(3);
  });

  it("drops a label two ports claim rather than guessing between them", () => {
    const id = buildInterfaceIdentity([
      { ifName: "port16", alias: null, description: "Camera Station" },
      { ifName: "port17", alias: null, description: "Camera Station" },
      { ifName: "port18", alias: null, description: "Time Clock" },
    ]);
    expect(id.labelToName.has("Camera Station")).toBe(false);
    expect(id.labelToName.get("Time Clock")).toBe("port18");
  });

  it("stays ambiguous once ambiguous, whatever order the rows arrive in", () => {
    const id = buildInterfaceIdentity([
      { ifName: "port1", description: "Shared" },
      { ifName: "port2", description: "Shared" },
      { ifName: "port1", description: "Shared" },
    ]);
    expect(id.labelToName.has("Shared")).toBe(false);
  });

  it("ignores blank and whitespace-only identity values", () => {
    const id = buildInterfaceIdentity([
      { ifName: "  port5  ", alias: "   ", description: "" },
      { ifName: "", description: "orphan" },
    ]);
    expect(id.names.has("port5")).toBe(true);
    expect(id.labelToName.size).toBe(0);
  });
});

describe("canonicalInterfaceName", () => {
  const id = buildInterfaceIdentity(SWITCH_ROWS);

  it("returns a real interface name unchanged", () => {
    expect(canonicalInterfaceName("port9", id)).toBe("port9");
    expect(canonicalInterfaceName("  port9 ", id)).toBe("port9");
  });

  it("resolves a description to the port that carries it", () => {
    expect(canonicalInterfaceName("MORGAN-221E-1", id)).toBe("port9");
  });

  it("returns null for a name the asset has never reported", () => {
    expect(canonicalInterfaceName("port99", id)).toBeNull();
    expect(canonicalInterfaceName("", id)).toBeNull();
  });

  it("resolves nothing against an empty identity", () => {
    expect(canonicalInterfaceName("port9", EMPTY_INTERFACE_IDENTITY)).toBeNull();
  });
});

describe("canonicalizeInterfaceRows", () => {
  const id = buildInterfaceIdentity(SWITCH_ROWS);

  it("renames a description-named row back to its port, keeping its data", () => {
    const out = canonicalizeInterfaceRows(
      [{ ifName: "MORGAN-221E-1", poeStatus: "fault" }],
      id,
    );
    expect(out.rows).toEqual([{ ifName: "port9", poeStatus: "fault" }]);
    expect(out.renamed).toEqual([{ from: "MORGAN-221E-1", to: "port9" }]);
    expect(out.dropped).toBe(0);
  });

  it("drops the label-named twin when the real port is in the same batch", () => {
    const out = canonicalizeInterfaceRows(
      [
        { ifName: "port9", poeStatus: "fault" },
        { ifName: "MORGAN-221E-1", poeStatus: "fault" },
      ],
      id,
    );
    expect(out.rows).toEqual([{ ifName: "port9", poeStatus: "fault" }]);
    expect(out.dropped).toBe(1);
    expect(out.renamed).toHaveLength(0);
  });

  it("passes an unknown name through — a new port has no row to match yet", () => {
    const out = canonicalizeInterfaceRows([{ ifName: "port53" }], id);
    expect(out.rows).toEqual([{ ifName: "port53" }]);
    expect(out.renamed).toHaveLength(0);
  });

  it("is a no-op when the identity carries no labels", () => {
    const rows = [{ ifName: "MORGAN-221E-1" }];
    const out = canonicalizeInterfaceRows(rows, EMPTY_INTERFACE_IDENTITY);
    expect(out.rows).toEqual(rows);
    expect(out.renamed).toHaveLength(0);
    expect(out.dropped).toBe(0);
  });

  it("preserves order for the rows it keeps", () => {
    const out = canonicalizeInterfaceRows(
      [{ ifName: "port33" }, { ifName: "Tim Smith" }, { ifName: "port8" }],
      id,
    );
    expect(out.rows.map((r) => r.ifName)).toEqual(["port33", "port12", "port8"]);
  });
});

describe("canonicalizeInterfacePins", () => {
  const id = buildInterfaceIdentity(SWITCH_ROWS);

  it("rewrites a description pin onto the port it describes", () => {
    const out = canonicalizeInterfacePins(["port33", "MORGAN-221E-1"], id);
    expect(out?.pins).toEqual(["port33", "port9"]);
    expect(out?.renamed).toEqual([{ from: "MORGAN-221E-1", to: "port9" }]);
  });

  it("collapses the rewritten pin into an existing pin for the same port", () => {
    // The prod shape: both the port and its description were pinned.
    const out = canonicalizeInterfacePins(["port9", "port33", "MORGAN-221E-1"], id);
    expect(out?.pins).toEqual(["port9", "port33"]);
    expect(out?.renamed).toEqual([{ from: "MORGAN-221E-1", to: "port9" }]);
  });

  it("returns null when every pin is already a port name", () => {
    expect(canonicalizeInterfacePins(["port9", "port33"], id)).toBeNull();
    expect(canonicalizeInterfacePins([], id)).toBeNull();
  });

  it("leaves a pin the asset doesn't report alone — absent is not renamed", () => {
    // A pulled module / rebooting stack member must stay monitored.
    const out = canonicalizeInterfacePins(["port99", "MORGAN-221E-1"], id);
    expect(out?.pins).toEqual(["port99", "port9"]);
  });

  it("is a no-op against an empty identity", () => {
    expect(canonicalizeInterfacePins(["MORGAN-221E-1"], EMPTY_INTERFACE_IDENTITY)).toBeNull();
  });
});
