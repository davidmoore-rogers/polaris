// public/js/topology-render.js — shared topology graph builders.
//
// Both the desktop Device Map (public/js/map.js) and the mobile topology
// surface (public/js/mobile/topology-tab.js) consume the /map/sites/:id/topology
// payload and render it via Cytoscape. Element construction + the visual
// stylesheet are identical between the two — node colors per monitor health,
// edge styles for controller / interface-inferred / LLDP edges, ghost LLDP
// nodes, cross-site remote assets, operator-uploaded icons. Diverging those
// rules across desktop and mobile would just be drift bait, so they live
// here.
//
// Mobile-only knobs (top-to-bottom dagre, no drag-to-reposition) stay in the
// mobile module — this file only exposes shared building blocks.

(function () {
  // Topology node-health palette. Shared by fortinetNodeColor() and the legend
  // here, AND by map.js's endpointNodeColor() (which loads after this file and
  // reads it off window.PolarisTopologyRender). These hues are deliberately
  // distinct from the CSS --color-* theme variables and from the assets-page
  // monitor-state palette — do NOT remap them. Extracting them here only
  // deduplicates the literals across the two files; the rendered values are
  // unchanged.
  var HEALTH_NODE_COLORS = {
    up:          "#2e7d32", // green
    degraded:    "#f9a825", // amber
    down:        "#c62828", // red
    unknown:     "#9e9e9e", // gray — unknown / dep-suppressed
    unmonitored: "#757575", // gray — unmonitored
  };

  // Color a Fortinet-infrastructure node (FortiGate, FortiSwitch, FortiAP)
  // from its monitor health. Same priority as the asset list Status pill:
  // confirmed-down probe wins over the dependency-suppression flag, so a
  // suppressed-but-actually-down node still renders red.
  function fortinetNodeColor(asset) {
    if (!asset || !asset.monitored) return HEALTH_NODE_COLORS.unmonitored;
    if (asset.dependencySuppressed && asset.monitorHealth !== "down") return HEALTH_NODE_COLORS.unknown; // Dep. Down (upstream parent offline)
    switch (asset.monitorHealth) {
      case "up":       return HEALTH_NODE_COLORS.up;
      case "degraded": return HEALTH_NODE_COLORS.degraded;
      case "down":     return HEALTH_NODE_COLORS.down;
      default:         return HEALTH_NODE_COLORS.unknown;
    }
  }

  // Build the elements array Cytoscape consumes from a /topology payload.
  // The shape mirrors what desktop map.js used to construct inline; mobile
  // and desktop now both call this so a new node/edge type only needs to
  // be added in one place.
  function buildTopologyElements(data) {
    if (!data) return [];
    var elements = [];

    if (data.fortigate) {
      elements.push({
        data: {
          id: data.fortigate.id,
          label: data.fortigate.hostname || "FortiGate",
          role: "fortigate",
          nodeColor: fortinetNodeColor(data.fortigate),
          iconUrl: data.fortigate.iconUrl || null,
          hasIcon: data.fortigate.iconUrl ? 1 : 0,
        },
      });
    }
    (data.switches || []).forEach(function (s) {
      elements.push({
        data: {
          id: s.id,
          label: s.hostname || "FortiSwitch",
          role: "fortiswitch",
          nodeColor: fortinetNodeColor(s),
          iconUrl: s.iconUrl || null,
          hasIcon: s.iconUrl ? 1 : 0,
        },
      });
    });
    // AP id set — used to detect wireless MESH: a leaf AP shows up in the
    // station table of its ROOT AP (the root sees its mesh child as an
    // associated client; the leaf does not list the root). Only APs ever
    // appear in another AP's station list — a switch never does — so the mesh
    // match is AP-only. When a station resolves to another AP in this site we
    // draw a mesh edge root→leaf instead of a client diamond.
    var apIdSet = {};
    (data.aps || []).forEach(function (a) { if (a && a.id) apIdSet[a.id] = true; });
    // Mesh leaves (filled in the AP loop below). Their wired fallback edge from
    // the FortiGate is bogus — superseded by the mesh edge — so it's skipped
    // when emitting controller edges so the graph doesn't show a stray gray
    // line crossing to the leaf.
    var meshLeafIds = {};

    (data.aps || []).forEach(function (a) {
      elements.push({
        data: {
          id: a.id,
          label: a.hostname || "FortiAP",
          role: "fortiap",
          nodeColor: fortinetNodeColor(a),
          iconUrl: a.iconUrl || null,
          hasIcon: a.iconUrl ? 1 : 0,
        },
      });
      // Wireless stations connected to this AP. Each station becomes a
      // small diamond node hanging off the AP via a dashed-cyan "wireless"
      // edge. Stations matched to a Polaris asset get the asset's
      // hostname as the label and the asset id as a tap target; unmatched
      // stations show their MAC (the only identity available).
      (a.stations || []).forEach(function (s) {
        // Mesh child: this "station" is actually another FortiAP (mesh leaf).
        // Draw a mesh edge root(a) → leaf(s.id) and skip the client diamond —
        // the leaf already has its own fortiap node.
        if (s.id && apIdSet[s.id] && s.id !== a.id) {
          meshLeafIds[s.id] = true;
          elements.push({
            data: {
              id: "mesh-" + a.id + "-" + s.id,
              source: a.id, target: s.id,
              label: s.ssid || "mesh",
              isMesh: 1,
            },
          });
        }
        // Wireless CLIENT stations (workstations / servers / phones / etc.) are
        // intentionally NOT rendered — the topology shows the FG / switch / AP
        // backbone only. The endpoint search reveals a specific host on demand.
      });
    });
    // Wireless-bridge edges (server-detected via LLDP): a FortiLink switch
    // behind a FortiAP. Rendered like a mesh edge AP→switch; the switch is
    // marked a mesh/bridge leaf so its FortiLink controller edge is skipped
    // below and the solver routes it behind the AP.
    (data.bridgeEdges || []).forEach(function (e, i) {
      meshLeafIds[e.target] = true;
      elements.push({
        data: {
          id: "br" + i, source: e.source, target: e.target,
          label: e.label || "", reason: e.reason || "",
          isMesh: 1,
        },
      });
    });
    // FortiGate id + switch id set so we can label/style the FortiGate→switch
    // FortiLink uplinks. FortiOS reports `fortilink` (a logical meta-interface,
    // not a physical port) on those, so the raw label is often
    // "unknown ↔ unknown" — relabel those to "fortilink", and dash-gray the
    // UNVERIFIED ones (no interface/LLDP-backed cable) to read as a
    // virtual/management link. When the server resolved interface details on
    // BOTH ends (srcIf/tgtIf — FG side LLDP-confirmed, switch side resolved
    // through the trunk→physical-member swap), the link is a known physical
    // cable: keep a real port-pair label like any normal connection.
    var fgId = data.fortigate ? data.fortigate.id : null;
    var switchIdSet = {};
    (data.switches || []).forEach(function (s) { if (s && s.id) switchIdSet[s.id] = true; });
    (data.edges || []).forEach(function (e, i) {
      // Skip the bogus wired uplink to a mesh/bridge leaf — the mesh edge
      // already connects it (and from the correct parent AP).
      if (meshLeafIds[e.target]) return;
      var isFgSwitch = fgId && e.source === fgId && switchIdSet[e.target];
      var label = e.label || "";
      var fortilinkFallback = 0;
      if (isFgSwitch) {
        var srcPort = e.srcIf && e.srcIf.name;
        var tgtPort = e.tgtIf && e.tgtIf.name;
        if (e.verifiedUplink && srcPort && tgtPort) {
          // srcIf/tgtIf carry the post-swap names (trunk → single physical
          // member), so this label matches the tooltip's per-side lines.
          label = srcPort + " ↔ " + tgtPort;
        } else {
          label = "fortilink"; // logical FortiLink uplink, not a physical port pair
          if (!e.verifiedUplink) fortilinkFallback = 1; // unverified → virtual (dashed gray)
        }
      }
      elements.push({
        data: {
          id: "e" + i, source: e.source, target: e.target,
          label: label,
          reason: e.reason || "",
          // FG→switch controller edge with a physically-confirmed (interface/
          // LLDP-backed) link — treated as a verified uplink by the column
          // solver so the switch isn't mistaken for a FortiLink fallback.
          isVerifiedUplink: e.verifiedUplink ? 1 : 0,
          isFortilinkFallback: fortilinkFallback,
          srcIf: e.srcIf || null,
          tgtIf: e.tgtIf || null,
        },
      });
    });
    // LLDP ghost neighbors (non-Polaris devices — IP phones, third-party gear,
    // etc.) are NOT rendered: the topology is a managed FG/switch/AP backbone.
    // (lldpNodes intentionally skipped.)
    //
    // Cross-site remote assets render ONLY when they're infra (firewall /
    // switch / access_point); workstations / servers / "other" / phones / etc.
    // are dropped, along with any edge to them, so the backbone stays clean.
    var INFRA_REMOTE = { firewall: true, switch: true, access_point: true };
    var droppedRemoteIds = {};
    (data.remoteAssetNodes || []).forEach(function (n) {
      var rt = (n.assetType || "").toLowerCase();
      if (!INFRA_REMOTE[rt]) { droppedRemoteIds[n.id] = true; return; }
      var label = n.hostname || n.ipAddress || n.id;
      elements.push({
        data: {
          id: n.id, label: label, role: "remote-asset",
          assetId: n.id, assetType: n.assetType || null,
          iconUrl: n.iconUrl || null, hasIcon: n.iconUrl ? 1 : 0,
        },
      });
    });
    (data.lldpEdges || []).forEach(function (e, i) {
      // Skip edges to a ghost (non-asset neighbor) or to a dropped non-infra
      // remote — those nodes aren't rendered.
      if (!e.targetIsAsset) return;
      if (droppedRemoteIds[e.source] || droppedRemoteIds[e.target]) return;
      elements.push({
        data: {
          id: "le" + i, source: e.source, target: e.target,
          label: e.label || "", isLldp: 1,
          reason: e.reason || "",
          srcIf: e.srcIf || null,
          tgtIf: e.tgtIf || null,
        },
      });
    });
    (data.interfaceEdges || []).forEach(function (e, i) {
      if (droppedRemoteIds[e.source] || droppedRemoteIds[e.target]) return;
      elements.push({
        data: {
          id: "ie" + i, source: e.source, target: e.target,
          label: e.label || "", isIface: 1,
          reason: e.reason || "",
          srcIf: e.srcIf || null,
          tgtIf: e.tgtIf || null,
        },
      });
    });
    // MCLAG ICL edges: a peer/sibling link between two FortiSwitches in an
    // MCLAG pair (not a parent/child uplink). Rendered as a distinct fuchsia
    // edge; flagged isMclag so the column solver treats it as visual-only
    // (excluded from depth adjacency) and never makes one peer the other's
    // parent.
    (data.mclagEdges || []).forEach(function (e, i) {
      if (droppedRemoteIds[e.source] || droppedRemoteIds[e.target]) return;
      elements.push({
        data: {
          id: "me" + i, source: e.source, target: e.target,
          label: e.label ? "MCLAG " + e.label : "MCLAG", isMclag: 1,
          reason: e.reason || "",
        },
      });
    });

    return elements;
  }

  // Cytoscape stylesheet — node colors per role, edge styles per source
  // (controller / interface-inferred / LLDP), selected/dimmed/pulse states,
  // and the operator-uploaded icon overlay. `theme` is "dark" or "light";
  // text + edge color swap accordingly so the graph reads well on either
  // basemap. `opts.includeEndpointOverlay` adds the synthetic endpoint
  // and dim styles used by desktop's connection-path overlay — mobile
  // doesn't carry that feature so it leaves it off.
  function topologyStylesheet(theme, opts) {
    opts = opts || {};
    var isDark = theme === "dark";
    var textColor = isDark ? "#eef0f4" : "#1a1a1a";
    var edgeColor = isDark ? "#6a7388" : "#9aa2b1";
    var textBg    = isDark ? "#1c2029" : "#ffffff";

    var style = [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "text-wrap": "wrap",
          "text-max-width": 160,
          color: textColor,
          "font-size": "11px",
          "font-family": "Inter, system-ui, sans-serif",
          "text-valign": "bottom",
          "text-margin-y": 6,
          "background-color": "#546e7a",
          width: 44,
          height: 44,
          "border-width": 2,
          "border-color": "#ffffff",
          "border-opacity": 0.85,
        },
      },
      { selector: 'node[role="fortigate"]',   style: { "background-color": "data(nodeColor)", width: 64, height: 64, "font-weight": 700 } },
      { selector: 'node[role="fortiswitch"]', style: { "background-color": "data(nodeColor)" } },
      { selector: 'node[role="fortiap"]',     style: { "background-color": "data(nodeColor)", width: 36, height: 36 } },
      {
        selector: 'node[role="lldp"]',
        style: {
          "background-color": "#7a4f1a",
          "border-color": "#f59e0b",
          "border-style": "dashed",
          width: 36,
          height: 36,
        },
      },
      {
        selector: 'node[role="remote-asset"]',
        style: {
          "background-color": "#1e3a5f",
          "border-color": "#4fc3f7",
          "border-style": "solid",
          "border-width": 2,
          width: 44,
          height: 44,
        },
      },
      // Wireless station — diamond shape so it's visually distinct from
      // wired endpoints + LLDP ghosts. Smaller than an AP since one AP
      // can carry dozens of stations and we don't want them dominating
      // the layout. Cyan border-bg matches the "wireless" edge style so
      // the eye groups the AP + its stations as one cluster.
      {
        selector: 'node[role="wireless-station"]',
        style: {
          "background-color": "#0e2a3a",
          "border-color":     "#22d3ee",
          "border-style":     "solid",
          "border-width":     2,
          shape:              "diamond",
          width:              24,
          height:             24,
          "font-size":        "9px",
        },
      },
      // Vendor logo overlay. Both signals stay visible: the colored
      // border carries the monitor health (green/amber/red/grey —
      // the same role/nodeColor used on plain nodes), the logo
      // identifies the vendor + model. White interior fill so the
      // logo's colors pop against any basemap (dark or light), and
      // the image is sized to fit the node via `background-fit:
      // contain` with no explicit width/height — pixel-valued
      // `background-width` was tried and gets treated as render
      // pixels (icon stops scaling with zoom AND ends up anchored
      // upper-left because `background-position` interacts oddly
      // with explicit-pixel `background-width`); percentage-valued
      // `background-width` plus contain has its own zoom-dependent
      // overflow quirk. Letting contain do the work alone is the
      // most predictable recipe in Cytoscape 3.30. To create the
      // ~70% inscribed-square inset operators wanted, the border
      // is thickened proportionally per role (see role selectors
      // for `node[hasIcon = 1]`) so the colored ring eats the
      // outer ~15% on each side and the visible image lands at
      // ~70% of the overall node diameter.
      {
        selector: 'node[hasIcon = 1]',
        style: {
          "background-image": "data(iconUrl)",
          "background-fit": "contain",
          "background-clip": "node",
          "background-image-containment": "inside",
          "background-position-x": "50%",
          "background-position-y": "50%",
          "background-color": "#ffffff",
          "background-opacity": 1,
          "border-color": "data(nodeColor)",
          "border-opacity": 1,
        },
      },
      // Per-role border widths for icon-bearing nodes. The width
      // numbers match ~15% of the role's node diameter so the ring
      // takes up the outer 30% of the visible diameter and the
      // image (which `background-fit: contain` scales to fill the
      // node) appears inset at ~70% of the visual circle. Borders
      // draw outward in Cytoscape so node coordinate space (used
      // by edges + labels) is unchanged.
      { selector: 'node[hasIcon = 1][role="fortigate"]',    style: { "border-width": 10 } },
      { selector: 'node[hasIcon = 1][role="fortiswitch"]',  style: { "border-width": 7 } },
      { selector: 'node[hasIcon = 1][role="fortiap"]',      style: { "border-width": 6 } },
      { selector: 'node[hasIcon = 1][role="remote-asset"]', style: { "border-width": 7 } },
      {
        selector: "edge",
        style: {
          width: 1.8,
          "line-color": edgeColor,
          "target-arrow-color": edgeColor,
          "target-arrow-shape": "none",
          "curve-style": "bezier",
          label: "data(label)",
          "font-size": "9px",
          color: textColor,
          "text-background-color": textBg,
          "text-background-opacity": 0.85,
          "text-background-padding": 2,
          "text-rotation": "autorotate",
        },
      },
      {
        selector: 'edge[isLldp = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#f59e0b",
          "target-arrow-color": "#f59e0b",
        },
      },
      {
        selector: 'edge[isIface = 1]',
        style: {
          "line-style": "solid",
          "line-color": "#14b8a6",
          "target-arrow-color": "#14b8a6",
          width: 2.4,
        },
      },
      // MCLAG ICL edge: a sibling/peer link between two FortiSwitches. Fuchsia,
      // dashed, no arrowhead (no hierarchy — they're peers), heavier than the
      // observed edges so it reads as an authoritative interconnect distinct
      // from the amber LLDP / teal interface / violet mesh edges.
      {
        selector: 'edge[isMclag = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#d946ef",
          "target-arrow-color": "#d946ef",
          "target-arrow-shape": "none",
          width: 2.4,
        },
      },
      // Wireless edge: AP → connected station. Dashed cyan, lighter than
      // the wired controller / interface edges so the eye doesn't read
      // station-cluster fanout as critical topology.
      {
        selector: 'edge[isWireless = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#22d3ee",
          "target-arrow-color": "#22d3ee",
          width: 1.4,
          opacity: 0.7,
        },
      },
      // Wireless mesh backhaul: root AP → leaf AP. Heavier dashed violet with a
      // directional arrow so it reads as an authoritative uplink (the leaf
      // depends on the root), distinct from the lighter cyan client wireless.
      {
        selector: 'edge[isMesh = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#a78bfa",
          "target-arrow-color": "#a78bfa",
          "target-arrow-shape": "triangle",
          width: 2.2,
        },
      },
      // Unverified FortiLink uplink (FortiGate→switch with no interface/LLDP-
      // confirmed cable): a logical/management link, drawn dashed + dimmed gray
      // so it reads as virtual versus the solid controller/physical edges.
      {
        selector: 'edge[isFortilinkFallback = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#6a7388",
          "target-arrow-color": "#6a7388",
          opacity: 0.7,
        },
      },
      {
        selector: 'node.topology-pulse',
        style: {
          "border-color": "#22d3ee",
          "border-width": 4,
          "border-opacity": 1,
        },
      },
      {
        selector: 'node:selected',
        style: {
          "border-color": "#22d3ee",
          "border-width": 5,
          "border-opacity": 1,
          "overlay-color": "#22d3ee",
          "overlay-opacity": 0.18,
          "overlay-padding": 6,
        },
      },
      {
        selector: 'edge:selected',
        style: {
          "line-color": "#22d3ee",
          "target-arrow-color": "#22d3ee",
          width: 3,
          "overlay-color": "#22d3ee",
          "overlay-opacity": 0.15,
          "overlay-padding": 3,
        },
      },
      {
        selector: 'core',
        style: {
          "selection-box-color":        "#22d3ee",
          "selection-box-border-color": "#22d3ee",
          "selection-box-border-width": 1.5,
          "selection-box-opacity":      0.22,
          "active-bg-color":            "#22d3ee",
          "active-bg-opacity":          0.14,
        },
      },
    ];

    if (opts.includeEndpointOverlay) {
      style.push({
        selector: 'node[role="endpoint"]',
        style: {
          "background-color": "data(nodeColor)",
          shape: "round-rectangle",
          width: 44,
          height: 36,
        },
      });
      style.push({
        selector: 'node.dimmed',
        style: { display: 'none' },
      });
      style.push({
        selector: 'edge.dimmed',
        style: { display: 'none' },
      });
    }

    return style;
  }

  // Legend rows for the topology overlay. Colors here mirror the constants
  // used by `fortinetNodeColor()` (status hues) and `topologyStylesheet()`
  // (node fills + edge styles) so a stylesheet change has exactly one place
  // the legend has to follow.
  function topologyLegendSpec() {
    return {
      nodes: [
        { label: "FortiGate",         kind: "circle",          size: "lg", fill: "data(nodeColor)", desc: "Color = monitor health" },
        { label: "FortiSwitch",       kind: "circle",          size: "md", fill: "data(nodeColor)" },
        { label: "FortiAP",           kind: "circle",          size: "sm", fill: "data(nodeColor)" },
        { label: "Endpoint",          kind: "round-rectangle", size: "md", fill: "data(nodeColor)", desc: "Only via endpoint search" },
        { label: "Remote asset",      kind: "circle",          size: "md", fill: "#1e3a5f", border: "#4fc3f7", desc: "Infra (FW/switch/AP) at another site" },
      ],
      health: [
        { label: "Up",                color: HEALTH_NODE_COLORS.up },
        { label: "Degraded",          color: HEALTH_NODE_COLORS.degraded },
        { label: "Down",              color: HEALTH_NODE_COLORS.down },
        { label: "Dep. Down",         color: HEALTH_NODE_COLORS.unknown },
        { label: "Unmonitored",       color: HEALTH_NODE_COLORS.unmonitored },
      ],
      edges: [
        { label: "Controller",        color: "#6a7388", style: "solid",  desc: "FortiLink / managed-AP authoritative" },
        { label: "FortiLink (virtual)",color: "#6a7388", style: "dashed", desc: "Unverified FortiLink uplink — no physical cable confirmed" },
        { label: "Interface-inferred",color: "#14b8a6", style: "solid",  desc: "Naming-convention peer link" },
        { label: "LLDP",              color: "#f59e0b", style: "dashed" },
        { label: "MCLAG ICL",         color: "#d946ef", style: "dashed", desc: "Inter-Chassis Link between MCLAG-peer switches" },
        { label: "Mesh / bridge",     color: "#a78bfa", style: "dashed", desc: "AP → mesh leaf AP / bridged switch" },
      ],
    };
  }

  // Per-device-type weights for the Dijkstra column solver. Infrastructure
  // (firewall / switch / AP) carries the operator's intended hierarchy weight;
  // every leaf kind (wired endpoint, wireless station, LLDP ghost, cross-site
  // remote asset) is treated as an endpoint (4) so it lands in an odd "leaf"
  // column to the right of the infra node it hangs off.
  var TOPOLOGY_NODE_WEIGHT = {
    fortigate: 1,
    fortiswitch: 2,
    fortiap: 3,
    endpoint: 4,
    "wireless-station": 4,
    lldp: 4,
    "remote-asset": 4,
  };
  // Roles that occupy EVEN columns by weighted depth. Everything else is a
  // leaf and occupies the ODD column immediately right of its infra parent.
  var TOPOLOGY_INFRA_ROLES = { fortigate: true, fortiswitch: true, fortiap: true };

  function topologyNodeWeight(role) {
    return TOPOLOGY_NODE_WEIGHT[role] != null ? TOPOLOGY_NODE_WEIGHT[role] : 4;
  }

  // Compute a column ("depth") + within-column ordinal ("lane") for every node
  // in a /topology element set, used by both the desktop and mobile surfaces to
  // position nodes deterministically instead of letting dagre auto-rank them.
  //
  // Algorithm:
  //   1. Node-weighted Dijkstra from the FortiGate root (firewall=1, switch=2,
  //      AP=3, leaf=4). Each node's cumulative path value is the sum of the
  //      weights of every node on its shortest path, both endpoints included
  //      (firewall=1; switch-on-fw=3; switch-on-switch=5; AP-on-switch=6; …).
  //   2. The DISTINCT cumulative values among infra nodes, sorted ascending,
  //      map to contiguous ranks; an infra node's column = rank * 2 (so infra
  //      lands on even columns 0,2,4,… with empty weighted-depth gaps squeezed
  //      out — "nothing in column 2 → move it left").
  //   3. Leaf nodes take the ODD column one right of their nearest infra
  //      ancestor (parent even column + 1).
  //   4. Disconnected nodes (no path to the firewall) drop into a rightmost
  //      orphan column so they stay visible.
  //   5. Lanes (rows) come from a tidy-tree pass over the Dijkstra predecessor
  //      tree: a node's FIRST child (infra before leaves, then tallest subtree,
  //      then element order) is placed first and the node inherits its lane, so
  //      the spine continues on one row; every other node takes the next free
  //      row from a global cursor, giving each sibling subtree a disjoint row
  //      band — tree edges never cross or overlap. Fallback exiles get the same
  //      treatment with their own cursor; orphans stack below the main tree.
  //   6. A final pass nudges leaf endpoints off non-tree edges (mesh backhaul,
  //      LLDP cross-links) that pass through their column.
  //
  // Returns { [nodeId]: { depth, lane } }, or null when there is no FortiGate
  // root (caller should fall back to its previous layout).
  function computeTopologyColumns(elements) {
    if (!Array.isArray(elements) || elements.length === 0) return null;

    var roleById = {};
    var nodeIds = [];
    var adj = {}; // undirected adjacency: id -> [neighborId, ...]
    var rootId = null;

    elements.forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id) return;
      if (d.source && d.target) return; // edge — handled below
      roleById[d.id] = d.role || null;
      nodeIds.push(d.id);
      adj[d.id] = adj[d.id] || [];
      if (d.role === "fortigate" && !rootId) rootId = d.id;
    });
    if (!rootId) return null; // no firewall — let the caller keep dagre

    // Mesh pre-pass: a mesh edge (root AP → leaf AP) makes the leaf a mesh
    // child. Its real uplink is wireless to the root AP, so any controller/
    // fallback edge that wired it to a FortiGate/FortiSwitch is bogus and must
    // be suppressed — otherwise Dijkstra would route the leaf off that switch
    // (or the FG fallback) instead of through its mesh parent.
    var meshLeaf = {};
    elements.forEach(function (el) {
      var d = el && el.data;
      if (d && d.source && d.target && d.isMesh) meshLeaf[d.target] = true;
    });

    // Full adjacency (every edge) drives depth; physical adjacency (interface-
    // inferred + LLDP edges only) drives "is this switch's uplink to the
    // firewall actually verified?" A controller/FortiLink edge is NOT physical
    // proof — FortiOS reports `fortilink` on every managed switch whether or
    // not we can see the real cable, so a switch reachable ONLY through
    // controller edges is a fallback (placed in the negative columns below).
    var physicalAdj = {};
    var edgeList = []; // every DRAWN edge (id pairs) — used to keep endpoint
                       // nodes off connection lines that pass through them.
    elements.forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.source || !d.target) return; // node — already handled
      if (!(d.source in adj) || !(d.target in adj)) return; // dangling edge
      edgeList.push([d.source, d.target]);
      // MCLAG ICL edges are sibling links, not uplinks: keep them in edgeList
      // (so connection-path overlays route around them) but exclude from the
      // depth/physical adjacency so neither peer becomes the other's parent and
      // the pair lands on the same column.
      if (d.isMclag) return;
      // Suppress a mesh leaf's bogus wired uplink: a non-mesh edge joining the
      // leaf to an infra node (FG/switch). Keep the mesh edge itself and the
      // leaf's downstream client edges (target is a wireless-station node).
      if (!d.isMesh) {
        var srcLeaf = meshLeaf[d.source] && TOPOLOGY_INFRA_ROLES[roleById[d.target]];
        var tgtLeaf = meshLeaf[d.target] && TOPOLOGY_INFRA_ROLES[roleById[d.source]];
        if (srcLeaf || tgtLeaf) return;
      }
      adj[d.source].push(d.target);
      adj[d.target].push(d.source);
      // Physical proof of a real link: interface-inferred, LLDP, OR a
      // controller edge flagged verifiedUplink (the FG↔switch interface edge
      // deduped into it). Mesh is wireless backhaul, deliberately NOT physical
      // proof of a switch's wired uplink.
      if (d.isIface || d.isLldp || d.isVerifiedUplink) {
        (physicalAdj[d.source] = physicalAdj[d.source] || []).push(d.target);
        (physicalAdj[d.target] = physicalAdj[d.target] || []).push(d.source);
      }
    });

    // --- 1. Node-weighted Dijkstra from the firewall -----------------------
    var INF = Infinity;
    var dist = {};
    var pred = {};
    nodeIds.forEach(function (id) { dist[id] = INF; pred[id] = null; });
    dist[rootId] = topologyNodeWeight(roleById[rootId]);
    var visited = {};
    // Small per-site graphs — a linear-scan extract-min is plenty.
    for (var iter = 0; iter < nodeIds.length; iter++) {
      var u = null;
      var best = INF;
      for (var i = 0; i < nodeIds.length; i++) {
        var cand = nodeIds[i];
        if (!visited[cand] && dist[cand] < best) { best = dist[cand]; u = cand; }
      }
      if (u === null) break; // remaining nodes unreachable
      visited[u] = true;
      (adj[u] || []).forEach(function (v) {
        var nd = dist[u] + topologyNodeWeight(roleById[v]);
        if (nd < dist[v]) { dist[v] = nd; pred[v] = u; }
      });
    }

    // --- 2. Physical-verification: which switches reach the firewall over
    //        interface/LLDP edges? BFS from the root over physicalAdj only. ---
    var physicallyVerified = {};
    physicallyVerified[rootId] = true;
    var pq = [rootId];
    while (pq.length) {
      var pcur = pq.shift();
      (physicalAdj[pcur] || []).forEach(function (n) {
        if (!physicallyVerified[n]) { physicallyVerified[n] = true; pq.push(n); }
      });
    }
    // A FortiSwitch that is reachable in the full graph (so not an orphan) but
    // NOT physically verified to the firewall is a FortiLink fallback — its
    // real cable can't be proven, so it's exiled to the negative columns.
    var FALLBACK_SWITCH_COL = -2; // even, mirrors verified switch parity
    var FALLBACK_ENDPOINT_COL = -3; // odd, mirrors verified endpoint parity
    function isFallbackSwitch(id) {
      // A bridge-leaf switch (FortiLink switch behind a FortiAP, reached via a
      // mesh/bridge edge) is a legitimate node placed via its AP, NOT a
      // FortiLink fallback.
      return roleById[id] === "fortiswitch" && dist[id] !== INF && !physicallyVerified[id] && !meshLeaf[id];
    }

    // --- 3. Verified infra cumulative values -> even columns ---------------
    // Fallback switches are excluded so they don't consume a positive rank.
    var infraValues = {};
    nodeIds.forEach(function (id) {
      if (TOPOLOGY_INFRA_ROLES[roleById[id]] && dist[id] !== INF && !isFallbackSwitch(id)) {
        infraValues[dist[id]] = true;
      }
    });
    var sortedVals = Object.keys(infraValues)
      .map(Number)
      .sort(function (a, b) { return a - b; });
    var evenColByValue = {};
    sortedVals.forEach(function (val, idx) { evenColByValue[val] = idx * 2; });

    // Nearest infra ancestor for a leaf, walking the Dijkstra predecessor chain.
    // Returns the ancestor's id (so the caller can tell verified vs fallback).
    function nearestInfraAncestor(id) {
      var cur = pred[id];
      var guard = 0;
      while (cur && guard++ < nodeIds.length) {
        if (TOPOLOGY_INFRA_ROLES[roleById[cur]] && dist[cur] !== INF) return cur;
        cur = pred[cur];
      }
      return null;
    }

    // --- 4. Assign a depth to every node -----------------------------------
    var depth = {};
    var maxInfraCol = sortedVals.length > 0 ? (sortedVals.length - 1) * 2 : 0;
    var orphanCol = maxInfraCol + 1;
    nodeIds.forEach(function (id) {
      if (isFallbackSwitch(id)) {
        depth[id] = FALLBACK_SWITCH_COL;
      } else if (TOPOLOGY_INFRA_ROLES[roleById[id]] && dist[id] !== INF) {
        depth[id] = evenColByValue[dist[id]];
      } else if (dist[id] !== INF) {
        var anc = nearestInfraAncestor(id);
        if (anc == null) depth[id] = orphanCol;
        else if (isFallbackSwitch(anc)) depth[id] = FALLBACK_ENDPOINT_COL; // leaf on a fallback switch
        else depth[id] = evenColByValue[dist[anc]] + 1; // verified leaf → odd col right of parent
      } else {
        depth[id] = orphanCol; // disconnected — keep visible at the right edge
      }
    });

    // --- 5. Tidy-tree lane assignment over the Dijkstra predecessor tree ---
    // A node's FIRST child continues on the node's own row (the spine stays
    // flat); every other node claims a fresh row from a global cursor, so each
    // sibling subtree owns a disjoint contiguous row band — tree edges never
    // cross, no two fan-out edges are collinear, and edge labels spread out.
    var children = {};
    nodeIds.forEach(function (id) {
      if (pred[id] != null && dist[id] !== INF) {
        (children[pred[id]] = children[pred[id]] || []).push(id);
      }
    });
    var orderIdx = {};
    nodeIds.forEach(function (id, k) { orderIdx[id] = k; });
    var inFallbackRegion = {};
    nodeIds.forEach(function (id) { if (depth[id] < 0) inFallbackRegion[id] = true; });

    // Longest pred-chain below a node, self included (memoized).
    var heightMemo = {};
    function subtreeHeight(id) {
      if (heightMemo[id] != null) return heightMemo[id];
      heightMemo[id] = 1; // guard — pred tree is acyclic, but cheap insurance
      var h = 1;
      (children[id] || []).forEach(function (c) {
        var ch = 1 + subtreeHeight(c);
        if (ch > h) h = ch;
      });
      heightMemo[id] = h;
      return h;
    }

    // Children within one region (verified tree vs fallback exile), ordered so
    // the spine continues through infra (switch/AP) before endpoints, then the
    // tallest subtree (the longest chain holds the row), then element order
    // for determinism. The region filter is load-bearing: a fallback switch is
    // infra-role and would otherwise sort first among the FortiGate's children
    // and drag the spine into the negative columns.
    function orderedChildren(id, fallbackRegion) {
      var kids = (children[id] || []).filter(function (c) {
        return !!inFallbackRegion[c] === fallbackRegion;
      });
      kids.sort(function (a, b) {
        var ia = TOPOLOGY_INFRA_ROLES[roleById[a]] ? 0 : 1;
        var ib = TOPOLOGY_INFRA_ROLES[roleById[b]] ? 0 : 1;
        if (ia !== ib) return ia - ib;
        var ha = subtreeHeight(a);
        var hb = subtreeHeight(b);
        if (ha !== hb) return hb - ha;
        return orderIdx[a] - orderIdx[b];
      });
      return kids;
    }

    var lane = {};
    var nextRow = 0;
    function placeSubtree(id, fallbackRegion) {
      if (lane[id] != null) return; // safety — pred tree visits each node once
      var kids = orderedChildren(id, fallbackRegion);
      // The spine child — the first ordered child in a DIFFERENT column — is
      // placed first and the node inherits its row, so the chain stays flat.
      // A same-column child (leaf chained off a leaf, switch chained off a
      // fallback switch) can never continue the row: it would overlap.
      var spine = null;
      for (var ks = 0; ks < kids.length; ks++) {
        if (depth[kids[ks]] !== depth[id]) { spine = kids[ks]; break; }
      }
      if (spine != null) {
        placeSubtree(spine, fallbackRegion);
        lane[id] = lane[spine];
      } else {
        lane[id] = nextRow++;
      }
      for (var ki = 0; ki < kids.length; ki++) placeSubtree(kids[ki], fallbackRegion);
    }
    placeSubtree(rootId, false);
    var mainRows = nextRow;

    // Fallback exiles (negative columns): same recursion with its own cursor
    // so the exile cluster top-aligns with the root. Row numbers repeat but x
    // is negative (column -1 is always empty), so nothing overlaps spatially.
    nextRow = 0;
    nodeIds.forEach(function (id) {
      if (inFallbackRegion[id] && (pred[id] == null || !inFallbackRegion[pred[id]])) {
        placeSubtree(id, true);
      }
    });

    // Orphans (no path to the firewall → no pred) and any stragglers: stack
    // BELOW the main tree. orphanCol is shared with the rightmost verified
    // leaves, so restarting this cursor at 0 would collide with them.
    nextRow = mainRows;
    nodeIds.forEach(function (id) {
      if (lane[id] == null) lane[id] = nextRow++;
    });

    // --- 6. Keep endpoint nodes off connection lines -----------------------
    // A leaf endpoint placed in an odd column can land directly on a wired/mesh
    // edge that passes THROUGH that column (e.g. a wireless station in the
    // column between a root AP and its mesh-leaf AP sits on the mesh backhaul
    // line). Nudge any such endpoint to the nearest free lane that no
    // pass-through edge crosses. Only leaf endpoints move — infra stays put.
    var occupied = {};
    nodeIds.forEach(function (id) {
      (occupied[depth[id]] = occupied[depth[id]] || {})[lane[id]] = true;
    });
    // Interpolated lane of an edge where it crosses integer column `col`, or
    // null when the edge doesn't strictly pass through that column.
    function edgeLaneAt(s, t, col) {
      var ds = depth[s], dt = depth[t];
      if (ds === dt) return null;
      if (col <= Math.min(ds, dt) || col >= Math.max(ds, dt)) return null;
      return lane[s] + ((col - ds) / (dt - ds)) * (lane[t] - lane[s]);
    }
    function laneCollides(id, col, L) {
      for (var e = 0; e < edgeList.length; e++) {
        var s = edgeList[e][0], t = edgeList[e][1];
        if (s === id || t === id) continue; // edges that terminate here are fine
        var el = edgeLaneAt(s, t, col);
        if (el != null && Math.abs(el - L) < 0.45) return true;
      }
      return false;
    }
    nodeIds.forEach(function (id) {
      if (TOPOLOGY_INFRA_ROLES[roleById[id]]) return; // only nudge leaf endpoints
      var col = depth[id];
      if (!laneCollides(id, col, lane[id])) return;
      occupied[col][lane[id]] = false; // vacate, search for a clear lane nearby
      var picked = lane[id];
      for (var step = 1; step <= 16; step++) {
        var down = lane[id] + step;
        if (!occupied[col][down] && !laneCollides(id, col, down)) { picked = down; break; }
        var up = lane[id] - step;
        if (!occupied[col][up] && !laneCollides(id, col, up)) { picked = up; break; }
      }
      lane[id] = picked;
      occupied[col][picked] = true;
    });

    var out = {};
    nodeIds.forEach(function (id) { out[id] = { depth: depth[id], lane: lane[id] }; });
    return out;
  }

  window.PolarisTopologyRender = {
    HEALTH_NODE_COLORS: HEALTH_NODE_COLORS,
    fortinetNodeColor: fortinetNodeColor,
    buildTopologyElements: buildTopologyElements,
    topologyStylesheet: topologyStylesheet,
    topologyLegendSpec: topologyLegendSpec,
    computeTopologyColumns: computeTopologyColumns,
    topologyNodeWeight: topologyNodeWeight,
  };
})();
