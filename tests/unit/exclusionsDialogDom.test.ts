/**
 * tests/unit/exclusionsDialogDom.test.ts — the Networks → Exclusions dialog's
 * row renderer (`_renderExclusions` in public/js/subnets.js), business rule 42.
 *
 * Three properties are worth pinning, because each one is a claim the backend
 * also makes and the two must agree:
 *
 *  - the CIDR renders as TEXT and the NAME as the only editable field. The
 *    route's Zod schema carries no `cidr` on the PUT, so a CIDR input here
 *    would be a control whose value the server silently ignores.
 *  - a read-level operator gets the list with no add / rename / remove
 *    controls, matching `subnets:read` to look and `subnets:fullwrite` to
 *    change. They still SEE it: what has been kept out of the networks list is
 *    exactly the thing worth being able to look up while reading it.
 *  - `matchCount` renders as a neutral statement of fact, never as an error.
 *    Adding an exclusion deliberately leaves those networks in place, so a red
 *    "3 already listed" would report a healthy outcome as a fault.
 *
 * subnets.js is a browser script with no module boundary, so the renderer is
 * sliced out by name and eval'd — the approach of tests/unit/addAssetMenu.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/subnets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of subnets.js. */
function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`subnets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`subnets.js: no end of function ${name}`);
  return lines.slice(start, end + 1).join("\n");
}

const EXCLUSIONS = [
  {
    id: "ex-1",
    cidr: "10.255.0.0/24",
    name: "Site Management VLAN",
    notes: null,
    createdBy: "dmoore",
    matchCount: 2,
    matches: [
      { id: "s1", cidr: "10.255.0.0/24", name: "DHCP: mgmt (gate-a)", status: "available", blockName: "Core" },
      { id: "s2", cidr: "10.255.0.128/25", name: "DHCP: mgmt-b (gate-b)", status: "available", blockName: "Core" },
    ],
  },
  {
    id: "ex-2",
    cidr: "192.168.100.0/22",
    name: "Out-of-band",
    notes: null,
    createdBy: null,
    matchCount: 0,
    matches: [],
  },
];

let render: () => void;
let doc: Document;

function mount(opts: { canEdit: boolean; rows?: any[] }) {
  const win = new Window();
  doc = win.document as unknown as Document;
  doc.body.innerHTML = '<div id="excl-list" class="empty-state"></div>';
  g.document = doc;
  g.window = g;
  g.escapeHtml = (v: any) =>
    String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  g.canManageNetworks = () => opts.canEdit;
  g.showToast = () => {};
  g.showConfirm = async () => false;
  g.api = { subnets: { exclusions: { update: async () => ({}), delete: async () => {} } } };
  g._exclusions = opts.rows ?? EXCLUSIONS;
  (0, eval)(fnSrc("_renderExclusions"));
  render = g._renderExclusions;
  expect(typeof render, "subnets.js no longer declares _renderExclusions").toBe("function");
  render();
}

beforeEach(() => {
  mount({ canEdit: true });
});

describe("exclusions dialog — the CIDR is not editable", () => {
  it("renders each CIDR as text and only the name as an input", () => {
    const inputs = Array.from(doc.querySelectorAll("#excl-list input"));
    // One per row, all of them the name field.
    expect(inputs).toHaveLength(2);
    for (const el of inputs) expect(el.className).toBe("excl-name-edit");
    const values = inputs.map((el) => (el as HTMLInputElement).value).sort();
    expect(values).toEqual(["Out-of-band", "Site Management VLAN"]);

    const codes = Array.from(doc.querySelectorAll("#excl-list code")).map((c) => c.textContent);
    expect(codes).toEqual(["10.255.0.0/24", "192.168.100.0/22"]);
    // No control anywhere carries the CIDR as an editable value.
    expect(inputs.some((el) => (el as HTMLInputElement).value.includes("/"))).toBe(false);
  });

  it("says so in words, so an operator is not left hunting for the field", () => {
    expect(doc.getElementById("excl-list")!.textContent).toMatch(/cannot be changed/i);
  });
});

describe("exclusions dialog — read-level operators look but do not touch", () => {
  it("renders no inputs and no remove buttons", () => {
    mount({ canEdit: false });
    expect(doc.querySelectorAll("#excl-list input")).toHaveLength(0);
    expect(doc.querySelectorAll("#excl-list .excl-remove")).toHaveLength(0);
  });

  it("still shows every exclusion and its CIDR", () => {
    mount({ canEdit: false });
    const text = doc.getElementById("excl-list")!.textContent!;
    expect(text).toContain("Site Management VLAN");
    expect(text).toContain("10.255.0.0/24");
    expect(text).toContain("Out-of-band");
  });
});

describe("exclusions dialog — existing matches are a fact, not a fault", () => {
  it("labels the count neutrally and lists the covered networks in the tooltip", () => {
    const cell = doc.querySelector("#excl-list .excl-match")!;
    expect(cell.textContent).toBe("2 already listed");
    const tip = cell.getAttribute("title")!;
    expect(tip).toContain("10.255.0.0/24 — DHCP: mgmt (gate-a)");
    expect(tip).toContain("10.255.0.128/25 — DHCP: mgmt-b (gate-b)");
    // Never styled as an error: the exclusion is not supposed to remove these.
    expect(cell.className).not.toMatch(/danger|error/);
  });

  it("says 'none listed' rather than a bare 0", () => {
    expect(doc.querySelector("#excl-list .excl-clear")!.textContent).toBe("none listed");
  });
});

describe("exclusions dialog — empty state", () => {
  it("tells a fullwrite operator how to add one and a reader nothing more", () => {
    mount({ canEdit: true, rows: [] });
    expect(doc.getElementById("excl-list")!.textContent).toMatch(/Add a subnet above/i);
    mount({ canEdit: false, rows: [] });
    expect(doc.getElementById("excl-list")!.textContent).toBe("Nothing is excluded.");
  });
});

describe("exclusions dialog — escaping", () => {
  it("escapes a name carrying markup", () => {
    mount({
      canEdit: false,
      rows: [{ id: "x", cidr: "10.0.0.0/8", name: '<img src=x onerror="boom">', notes: null, createdBy: null, matchCount: 0, matches: [] }],
    });
    expect(doc.querySelectorAll("#excl-list img")).toHaveLength(0);
    expect(doc.getElementById("excl-list")!.textContent).toContain("<img src=x");
  });
});
