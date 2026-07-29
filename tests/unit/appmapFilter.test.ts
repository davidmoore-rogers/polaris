/**
 * tests/unit/appmapFilter.test.ts
 *
 * Unit tests for the Application Map's pill-filter core — applyGraphFilter(),
 * buildFilterCatalog() and rankSuggestions() in public/js/appmap.js. Those live
 * in a browser IIFE (no module export), so we evaluate the file in a Node vm
 * context with a stub `window` and pull them off window.PolarisAppMap — same
 * approach as tests/unit/topologyColumns.test.ts.
 *
 * The behaviour under test is the semantic the operator was promised: pills
 * combine OR WITHIN a kind and AND ACROSS kinds.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

interface Node {
  id: string;
  kind: string;
  parent?: string;
  assetId?: string;
  hostname?: string;
  ipAddress?: string;
  assetType?: string;
  processName?: string;
  serviceUnit?: string;
  listenPorts?: Array<{ proto: string; port: number }>;
  ip?: string;
  cidr?: string;
  ips?: string[];
  hasMappedProcesses?: boolean;
}
interface Port { proto: string; port: number; count?: number; firstSeen?: string; lastSeen?: string }
interface Edge { id: string; source: string; target: string; kind: string; ports: Port[]; portOverflow?: number; lastSeen: string }
interface Pill { kind: string; value: string }
interface Filter { ageMs: number; hideExternal: boolean; pills: Pill[] }
interface Result { nodes: Node[]; edges: Array<{ edge: Edge; ports: Port[] }> }

let applyGraphFilter: (n: Node[], e: Edge[], f: Filter, now: number) => Result;
let buildFilterCatalog: (n: Node[], e: Edge[]) => Pill[];
let rankSuggestions: (c: Pill[], q: string) => Pill[];

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/appmap.js");
  const code = readFileSync(file, "utf8");
  // The IIFE registers a DOMContentLoaded listener and touches `document` only
  // from inside handlers, so a bare stub is enough to evaluate it.
  const sandbox: { window: Record<string, any>; document: any } = {
    window: {},
    document: { addEventListener() {}, getElementById: () => null, documentElement: { getAttribute: () => "dark" } },
  };
  (sandbox.window as any).document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  applyGraphFilter = sandbox.window.PolarisAppMap.applyGraphFilter;
  buildFilterCatalog = sandbox.window.PolarisAppMap.buildFilterCatalog;
  rankSuggestions = sandbox.window.PolarisAppMap.rankSuggestions;
});

const NOW = Date.parse("2026-07-28T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

// Two hosts. web01 runs nginx (a mapped process) and myapp.service (a mapped
// service); db01 runs postgres. Plus one external IP.
function fixture(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    { id: "asset:A", kind: "asset", assetId: "A", hostname: "web01", ipAddress: "10.0.0.1", assetType: "server", hasMappedProcesses: true },
    { id: "proc:A:nginx", kind: "process", parent: "asset:A", assetId: "A", processName: "nginx", listenPorts: [{ proto: "tcp", port: 443 }] },
    { id: "svc:A:myapp", kind: "service", parent: "asset:A", assetId: "A", serviceUnit: "myapp.service", listenPorts: [{ proto: "tcp", port: 8080 }] },
    { id: "asset:B", kind: "asset", assetId: "B", hostname: "db01", ipAddress: "10.0.0.2", assetType: "workstation", hasMappedProcesses: true },
    { id: "proc:B:postgres", kind: "process", parent: "asset:B", assetId: "B", processName: "postgres", listenPorts: [{ proto: "tcp", port: 5432 }] },
    { id: "ip:203.0.113.9", kind: "unknown-ip", ip: "203.0.113.9" },
  ];
  const edges: Edge[] = [
    // web01's nginx → db01's postgres, tcp/5432
    { id: "e1", source: "proc:A:nginx", target: "proc:B:postgres", kind: "process", ports: [{ proto: "tcp", port: 5432 }], lastSeen: iso(2) },
    // web01's service → an external IP over udp/514
    { id: "e2", source: "svc:A:myapp", target: "ip:203.0.113.9", kind: "external", ports: [{ proto: "udp", port: 514 }], lastSeen: iso(2) },
    // db01's postgres → external, tcp/80, and OLD
    { id: "e3", source: "proc:B:postgres", target: "ip:203.0.113.9", kind: "external", ports: [{ proto: "tcp", port: 80 }], lastSeen: iso(600) },
  ];
  return { nodes, edges };
}

const noFilter = (over: Partial<Filter> = {}): Filter =>
  ({ ageMs: 0, hideExternal: false, pills: [], ...over });

const run = (f: Filter) => {
  const { nodes, edges } = fixture();
  return applyGraphFilter(nodes, edges, f, NOW);
};
const edgeIds = (r: Result) => r.edges.map((x) => x.edge.id).sort();
const nodeIds = (r: Result) => r.nodes.map((n) => n.id).sort();

describe("applyGraphFilter — no pills (baseline behaviour preserved)", () => {
  it("keeps every asset/child node and every edge", () => {
    const r = run(noFilter());
    expect(edgeIds(r)).toEqual(["e1", "e2", "e3"]);
    expect(nodeIds(r)).toContain("asset:A");
    expect(nodeIds(r)).toContain("svc:A:myapp");
  });

  it("age filter drops edges older than the window", () => {
    const r = run(noFilter({ ageMs: 60 * 60_000 }));
    expect(edgeIds(r)).toEqual(["e1", "e2"]);
  });

  it("hideExternal drops unknown nodes and any edge touching them", () => {
    const r = run(noFilter({ hideExternal: true }));
    expect(edgeIds(r)).toEqual(["e1"]);
    expect(nodeIds(r)).not.toContain("ip:203.0.113.9");
  });
});

describe("applyGraphFilter — OR within a kind", () => {
  it("a proto pill keeps only edges with a matching port", () => {
    expect(edgeIds(run(noFilter({ pills: [{ kind: "proto", value: "udp" }] })))).toEqual(["e2"]);
  });

  it("two proto pills union rather than intersect", () => {
    const r = run(noFilter({ pills: [{ kind: "proto", value: "tcp" }, { kind: "proto", value: "udp" }] }));
    expect(edgeIds(r)).toEqual(["e1", "e2", "e3"]);
  });

  it("a port pill matches the port number", () => {
    expect(edgeIds(run(noFilter({ pills: [{ kind: "port", value: "5432" }] })))).toEqual(["e1"]);
  });

  it("two asset pills union", () => {
    const r = run(noFilter({ pills: [{ kind: "asset", value: "web01" }, { kind: "asset", value: "db01" }] }));
    expect(edgeIds(r)).toEqual(["e1", "e2", "e3"]);
  });
});

describe("applyGraphFilter — AND across kinds", () => {
  it("proto AND asset both have to hold", () => {
    // web01 has a tcp edge (e1) and a udp edge (e2); tcp+web01 leaves only e1.
    const r = run(noFilter({ pills: [{ kind: "proto", value: "tcp" }, { kind: "asset", value: "web01" }] }));
    expect(edgeIds(r)).toEqual(["e1"]);
  });

  it("an asset pill covers traffic flowing through its children", () => {
    // e2's endpoint is svc:A:myapp, not asset:A — the asset group is expanded to
    // its children, otherwise filtering by a hostname would find nothing.
    expect(edgeIds(run(noFilter({ pills: [{ kind: "asset", value: "web01" }] })))).toEqual(["e1", "e2"]);
  });

  it("service AND asset agree via the parent/child proxy", () => {
    const r = run(noFilter({ pills: [{ kind: "service", value: "myapp.service" }, { kind: "asset", value: "web01" }] }));
    expect(edgeIds(r)).toEqual(["e2"]);
    expect(nodeIds(r)).toContain("svc:A:myapp");
    expect(nodeIds(r)).toContain("asset:A"); // compound box renders
  });

  it("a service on the WRONG host is excluded by the asset pill", () => {
    const r = run(noFilter({ pills: [{ kind: "service", value: "myapp.service" }, { kind: "asset", value: "db01" }] }));
    expect(edgeIds(r)).toEqual([]);
    expect(nodeIds(r)).not.toContain("svc:A:myapp");
  });

  it("the three-pill case from the request: proto + host + service", () => {
    const r = run(noFilter({
      pills: [
        { kind: "proto", value: "udp" },
        { kind: "asset", value: "web01" },
        { kind: "service", value: "myapp.service" },
      ],
    }));
    expect(edgeIds(r)).toEqual(["e2"]);
  });
});

describe("applyGraphFilter — device type", () => {
  it("a type pill keeps only traffic touching assets of that type", () => {
    // web01 is a server: its edges are e1 (to db01) and e2 (to external).
    expect(edgeIds(run(noFilter({ pills: [{ kind: "type", value: "server" }] })))).toEqual(["e1", "e2"]);
  });

  it("covers traffic flowing through a matching asset's children", () => {
    // e2's endpoint is svc:A:myapp, not asset:A — the type group must expand to
    // children or filtering by device type would find almost nothing.
    const r = run(noFilter({ pills: [{ kind: "type", value: "workstation" }] }));
    expect(edgeIds(r)).toEqual(["e1", "e3"]);
    expect(nodeIds(r)).toContain("proc:B:postgres");
  });

  it("two type pills union", () => {
    const r = run(noFilter({ pills: [{ kind: "type", value: "server" }, { kind: "type", value: "workstation" }] }));
    expect(edgeIds(r)).toEqual(["e1", "e2", "e3"]);
  });

  it("ANDs across kinds like any other pill", () => {
    const r = run(noFilter({ pills: [{ kind: "type", value: "server" }, { kind: "proto", value: "udp" }] }));
    expect(edgeIds(r)).toEqual(["e2"]);
  });

  it("a type nothing matches yields an empty graph", () => {
    expect(edgeIds(run(noFilter({ pills: [{ kind: "type", value: "firewall" }] })))).toEqual([]);
  });

  it("does NOT leak into free-text matching", () => {
    // A bare "server" as free text would otherwise match most of the fleet and
    // read as a broken filter.
    expect(edgeIds(run(noFilter({ pills: [{ kind: "text", value: "server" }] })))).toEqual([]);
  });
});

describe("applyGraphFilter — narrowing and visibility", () => {
  it("an active scope drops unrelated asset boxes (it narrows, not just centers)", () => {
    const r = run(noFilter({ pills: [{ kind: "service", value: "myapp.service" }] }));
    expect(nodeIds(r)).not.toContain("proc:B:postgres");
  });

  it("a scoped node with no surviving edges still renders", () => {
    // nginx listens on 443 but has no tcp/443 edge in the fixture.
    const r = run(noFilter({ pills: [{ kind: "process", value: "nginx" }, { kind: "port", value: "443" }] }));
    expect(edgeIds(r)).toEqual([]);
    expect(nodeIds(r)).toContain("proc:A:nginx");
    expect(nodeIds(r)).toContain("asset:A");
  });

  it("never emits a child whose parent is absent, or an edge with a missing endpoint", () => {
    // Dangling refs make cytoscape-dagre throw and kill the whole render.
    const orphan: Node[] = [
      { id: "proc:GONE:x", kind: "process", parent: "asset:GONE", assetId: "GONE", processName: "x" },
    ];
    const { nodes, edges } = fixture();
    const r = applyGraphFilter(
      nodes.concat(orphan),
      edges.concat([{ id: "e9", source: "proc:GONE:x", target: "ip:198.51.100.7", kind: "external", ports: [], lastSeen: iso(1) }]),
      noFilter(),
      NOW,
    );
    const ids = nodeIds(r);
    expect(ids).not.toContain("proc:GONE:x");
    expect(edgeIds(r)).not.toContain("e9");
    r.edges.forEach((x) => {
      expect(ids).toContain(x.edge.source);
      expect(ids).toContain(x.edge.target);
    });
  });

  it("a genuinely port-less edge survives a proto pill", () => {
    // Port-less edges carry no proto to contradict the filter; dropping them
    // would silently hide asset-level connectivity.
    const { nodes } = fixture();
    const r = applyGraphFilter(
      nodes,
      [{ id: "e0", source: "asset:A", target: "asset:B", kind: "asset", ports: [], lastSeen: iso(1) }],
      noFilter({ pills: [{ kind: "proto", value: "tcp" }] }),
      NOW,
    );
    expect(edgeIds(r)).toEqual(["e0"]);
  });

  it("a free-text pill matches across node kinds", () => {
    expect(edgeIds(run(noFilter({ pills: [{ kind: "text", value: "postgres" }] })))).toEqual(["e1", "e3"]);
  });
});

describe("buildFilterCatalog / rankSuggestions", () => {
  it("offers every filterable dimension exactly once", () => {
    const { nodes, edges } = fixture();
    const cat = buildFilterCatalog(nodes, edges);
    const of = (k: string) => cat.filter((c) => c.kind === k).map((c) => c.value);
    expect(of("proto").sort()).toEqual(["tcp", "udp"]);
    expect(of("asset").sort()).toEqual(["db01", "web01"]);
    expect(of("type").sort()).toEqual(["server", "workstation"]);
    expect(of("process").sort()).toEqual(["nginx", "postgres"]);
    expect(of("service")).toEqual(["myapp.service"]);
    expect(of("external")).toEqual(["203.0.113.9"]);
    // Ports come from edge ports AND node listenPorts.
    expect(of("port")).toEqual(["80", "443", "514", "5432", "8080"]);
    expect(cat.length).toBe(new Set(cat.map((c) => c.kind + " " + c.value)).size);
  });

  it("typing \"tc\" surfaces tcp first", () => {
    const { nodes, edges } = fixture();
    const hits = rankSuggestions(buildFilterCatalog(nodes, edges), "tc");
    expect(hits[0]).toEqual({ kind: "proto", value: "tcp" });
  });

  it("prefix matches outrank interior matches", () => {
    const cat: Pill[] = [
      { kind: "asset", value: "prod-web01" },
      { kind: "asset", value: "web01" },
    ];
    expect(rankSuggestions(cat, "web")[0].value).toBe("web01");
  });

  it("an empty query lists the catalog, and a miss lists nothing", () => {
    const { nodes, edges } = fixture();
    const cat = buildFilterCatalog(nodes, edges);
    expect(rankSuggestions(cat, "").length).toBe(cat.length);
    expect(rankSuggestions(cat, "zzzzz")).toEqual([]);
  });
});
