// appmap.js — the Application Map page: a Cytoscape graph of application
// connectivity built from mapped-process connection facts.
//
// Data comes from GET /api/v1/application-map (see applicationMapService):
// asset nodes are compound parents, their mapped processes are child nodes,
// unresolved endpoints are grey unknown-IP nodes. Layout is a two-pass
// scheme: bundled dagre lays out the COLLAPSED asset-level graph in a
// headless Cytoscape instance (dagre doesn't handle compound graphs well),
// then each asset's process children are stacked at the parent's coordinate
// (compound parents derive their box from the children). Saved positions win
// over the computed layout: server `savedLayout` (shared, applicationMap=write)
// > localStorage (per-browser fallback for readers) > computed.
//
// Filters (age / proto / hide-external) are client-side over the cached
// payload; the graph auto-refreshes every 60s (paused while the tab is
// hidden) preserving current node positions. Node click-through reuses the
// canonical asset details slide-in (openViewModal from assets.js).

(function () {
  "use strict";

  var LS_KEY = "polaris.appmap.positions";
  var STALE_MS = 15 * 60 * 1000;
  var REFRESH_MS = 60 * 1000;
  var PROC_ROW_GAP = 52;

  var cy = null;
  var payload = null;         // last server payload
  var refreshTimer = null;
  var saveTimer = null;
  var selectedId = null;

  document.addEventListener("DOMContentLoaded", async function () {
    if (!document.getElementById("appmap-graph")) return; // not this page
    // Permissions must be loaded before gated UI (reset-layout button, layout
    // persistence target) is wired — same sequencing as map.js.
    if (typeof fetchCurrentUser === "function") await fetchCurrentUser();
    wireToolbar();
    loadGraph(false);
    refreshTimer = setInterval(function () {
      if (!document.hidden) loadGraph(true);
    }, REFRESH_MS);
    window.addEventListener("beforeunload", function () {
      if (refreshTimer) clearInterval(refreshTimer);
    });
  });

  function pageTheme() {
    return document.documentElement.getAttribute("data-theme") || "dark";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function canWriteLayout() {
    return typeof permAtLeast === "function" && permAtLeast("applicationMap", "write");
  }

  // ─── Filters ───────────────────────────────────────────────────────

  function currentFilters() {
    var age = Number((document.getElementById("appmap-age") || {}).value || 86400);
    return {
      ageMs: age > 0 ? age * 1000 : 0,
      tcp: !!(document.getElementById("appmap-proto-tcp") || {}).checked,
      udp: !!(document.getElementById("appmap-proto-udp") || {}).checked,
      hideExternal: !!(document.getElementById("appmap-hide-external") || {}).checked,
    };
  }

  // Apply the client-side filters to the cached payload. Asset/process nodes
  // always stay (they're the operator's selection); unknown nodes stay only
  // while an edge still references them.
  function filterGraph(f) {
    var now = Date.now();
    var edges = [];
    for (var i = 0; i < payload.edges.length; i++) {
      var e = payload.edges[i];
      if (f.ageMs > 0 && now - Date.parse(e.lastSeen) > f.ageMs) continue;
      var ports = e.ports.filter(function (p) {
        return (p.proto === "tcp" && f.tcp) || (p.proto === "udp" && f.udp);
      });
      if (ports.length === 0 && e.ports.length > 0) continue;
      if (f.hideExternal && (isUnknownId(e.source) || isUnknownId(e.target))) continue;
      edges.push({ edge: e, ports: ports });
    }
    var referenced = {};
    edges.forEach(function (r) { referenced[r.edge.source] = true; referenced[r.edge.target] = true; });
    var nodes = payload.nodes.filter(function (n) {
      if (n.kind === "asset" || n.kind === "process") {
        // Resolved-target assets with no mapped processes only matter while
        // an edge points at them.
        if (n.kind === "asset" && n.hasMappedProcesses === false) return !!referenced["" + n.id];
        return true;
      }
      if (f.hideExternal) return false;
      return !!referenced[n.id];
    });
    // Guard against DANGLING references before they reach cytoscape/dagre: a
    // process node whose parent asset isn't in the set, or an edge whose
    // source/target has no node, makes the layout throw ("Cannot set properties
    // of null (setting 'hidden')") and fails the whole render. This happens when
    // connection rows (or mapped-process pins) outlive the process/asset that
    // owned them — e.g. a mapped process that no longer exists in inventory.
    // Drop the orphans; the rest of the graph still renders.
    var nodeIds = {};
    nodes.forEach(function (n) { nodeIds[n.id] = true; });
    nodes = nodes.filter(function (n) {
      return !(n.kind === "process" && n.parent && !nodeIds[n.parent]);
    });
    nodeIds = {};
    nodes.forEach(function (n) { nodeIds[n.id] = true; });
    var cleanEdges = edges.filter(function (r) {
      return nodeIds[r.edge.source] && nodeIds[r.edge.target];
    });
    return { nodes: nodes, edges: cleanEdges };
  }

  function isUnknownId(id) {
    return id.indexOf("ip:") === 0 || id.indexOf("ipgroup:") === 0;
  }

  // ─── Elements + stylesheet ─────────────────────────────────────────

  function nodeLabel(n) {
    if (n.kind === "asset") return n.hostname || n.ipAddress || n.assetId || "asset";
    if (n.kind === "process") return n.processName || "process";
    if (n.kind === "unknown-ip") return n.ip || "?";
    if (n.kind === "unknown-ip-group") return (n.cidr || "?") + "\n" + ((n.ips || []).length) + " hosts";
    if (n.kind === "unknown-overflow") return "+" + (n.overflowCount || 0) + " external";
    return n.id;
  }

  function edgeLabel(ports, overflow) {
    var parts = ports.slice(0, 3).map(function (p) { return p.proto + "/" + p.port; });
    var extra = ports.length - 3 + (overflow || 0);
    return parts.join(", ") + (extra > 0 ? " +" + extra : "");
  }

  function buildElements(g) {
    var now = Date.now();
    var els = [];
    g.nodes.forEach(function (n) {
      var data = {
        id: n.id,
        label: nodeLabel(n),
        kind: n.kind,
        hasIcon: n.iconUrl ? 1 : 0,
      };
      if (n.iconUrl) data.iconUrl = n.iconUrl;
      if (n.kind === "process" && n.parent) data.parent = n.parent;
      els.push({ group: "nodes", data: data });
    });
    g.edges.forEach(function (r) {
      var e = r.edge;
      var stale = now - Date.parse(e.lastSeen) > STALE_MS;
      els.push({
        group: "edges",
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          kind: e.kind,
          label: edgeLabel(r.ports.length ? r.ports : e.ports, e.portOverflow),
          stale: stale ? 1 : 0,
        },
      });
    });
    return els;
  }

  function appmapStylesheet(theme) {
    var isDark = theme === "dark";
    var textColor = isDark ? "#eef0f4" : "#1a1a1a";
    var edgeColor = isDark ? "#6a7388" : "#9aa2b1";
    return [
      // Compound asset parent — translucent rounded box, label top-left.
      {
        selector: 'node[kind="asset"]',
        style: {
          shape: "round-rectangle",
          "background-color": "#4fc3f7",
          "background-opacity": isDark ? 0.08 : 0.10,
          "border-width": 1.5,
          "border-color": "#4fc3f7",
          label: "data(label)",
          color: textColor,
          "font-size": "12px",
          "font-weight": 600,
          "font-family": "Inter, system-ui, sans-serif",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": -6,
          padding: 14,
        },
      },
      // Process child node.
      {
        selector: 'node[kind="process"]',
        style: {
          shape: "round-rectangle",
          width: "label",
          height: 26,
          padding: 6,
          "background-color": "#7e57c2",
          "border-width": 1.5,
          "border-color": isDark ? "#b39ddb" : "#5e35b1",
          label: "data(label)",
          color: "#ffffff",
          "font-size": "11px",
          "font-family": "Roboto Mono, monospace",
          "text-valign": "center",
          "text-halign": "center",
        },
      },
      // Unknown externals — grey, dashed.
      {
        selector: 'node[kind="unknown-ip"], node[kind="unknown-ip-group"], node[kind="unknown-overflow"]',
        style: {
          shape: "ellipse",
          width: 34,
          height: 34,
          "background-color": isDark ? "#4a4f5a" : "#bdbdbd",
          "border-width": 1.5,
          "border-style": "dashed",
          "border-color": isDark ? "#8a8f9a" : "#757575",
          label: "data(label)",
          color: textColor,
          "text-wrap": "wrap",
          "font-size": "10px",
          "font-family": "Roboto Mono, monospace",
          "text-valign": "bottom",
          "text-margin-y": 5,
        },
      },
      // Vendor icon overlay on asset boxes (recipe from topology-render.js —
      // background-fit: contain alone is the predictable combination).
      {
        selector: 'node[kind="asset"][hasIcon = 1]',
        style: {
          "background-image": "data(iconUrl)",
          "background-fit": "contain",
          "background-clip": "node",
          "background-image-containment": "inside",
          "background-image-opacity": 0.18,
          "background-position-x": "50%",
          "background-position-y": "50%",
        },
      },
      {
        selector: "edge",
        style: {
          width: 1.8,
          "curve-style": "bezier",
          "line-color": edgeColor,
          "target-arrow-shape": "triangle",
          "target-arrow-color": edgeColor,
          "arrow-scale": 0.9,
          label: "data(label)",
          color: textColor,
          "font-size": "9px",
          "font-family": "Roboto Mono, monospace",
          "text-background-color": isDark ? "#1c2029" : "#ffffff",
          "text-background-opacity": 0.85,
          "text-background-padding": 2,
          "text-rotation": "autorotate",
        },
      },
      { selector: 'edge[kind="process"]', style: { "line-color": "#66bb6a", "target-arrow-color": "#66bb6a", width: 2.2 } },
      { selector: 'edge[kind="asset"]',   style: { "line-color": "#4fc3f7", "target-arrow-color": "#4fc3f7" } },
      { selector: 'edge[kind="external"], edge[kind="external-inbound"]', style: { "line-style": "dashed" } },
      { selector: "edge[stale = 1]", style: { opacity: 0.35 } },
      { selector: "node:selected", style: { "border-width": 3, "border-color": "#ffb300" } },
      { selector: "edge:selected", style: { width: 3 } },
    ];
  }

  // ─── Two-pass layout ───────────────────────────────────────────────

  // Pass 1: dagre over the COLLAPSED asset-level graph (process endpoints
  // fold into their parent asset). Pass 2: stack each asset's children
  // vertically at the parent's dagre coordinate. Returns positions for child
  // + plain nodes only (compound parents derive their box).
  function computeLayout(g) {
    var parentOf = {};
    g.nodes.forEach(function (n) {
      if (n.kind === "process" && n.parent) parentOf[n.id] = n.parent;
    });
    var collapsedNodes = {};
    g.nodes.forEach(function (n) {
      if (n.kind !== "process") collapsedNodes[n.id] = true;
    });
    var collapsedEdges = {};
    g.edges.forEach(function (r) {
      var s = parentOf[r.edge.source] || r.edge.source;
      var t = parentOf[r.edge.target] || r.edge.target;
      if (s === t) return;
      // Both collapsed endpoints must be real nodes — an edge to a phantom node
      // makes cytoscape-dagre throw. (filterGraph already drops dangling edges;
      // this is defense in depth for the collapsed projection.)
      if (!collapsedNodes[s] || !collapsedNodes[t]) return;
      collapsedEdges[s + "|" + t] = { source: s, target: t };
    });
    var els = [];
    Object.keys(collapsedNodes).forEach(function (id) {
      els.push({ group: "nodes", data: { id: id } });
    });
    Object.keys(collapsedEdges).forEach(function (k) {
      var e = collapsedEdges[k];
      els.push({ group: "edges", data: { id: "ce:" + k, source: e.source, target: e.target } });
    });
    var head = cytoscape({ headless: true, elements: els, styleEnabled: false });
    head.layout({ name: "dagre", rankDir: "LR", nodeSep: 60, rankSep: 240 }).run();
    var anchor = {};
    head.nodes().forEach(function (n) {
      anchor[n.id()] = { x: n.position("x"), y: n.position("y") };
    });
    head.destroy();

    var positions = {};
    // Plain nodes take the dagre coordinate directly.
    g.nodes.forEach(function (n) {
      if (n.kind !== "process" && anchor[n.id]) positions[n.id] = anchor[n.id];
    });
    // Children stack centered on the parent's coordinate.
    var childrenByParent = {};
    g.nodes.forEach(function (n) {
      if (n.kind !== "process" || !n.parent) return;
      (childrenByParent[n.parent] = childrenByParent[n.parent] || []).push(n.id);
    });
    Object.keys(childrenByParent).forEach(function (pid) {
      var kids = childrenByParent[pid].sort();
      var base = anchor[pid] || { x: 0, y: 0 };
      kids.forEach(function (kid, i) {
        positions[kid] = { x: base.x, y: base.y + (i - (kids.length - 1) / 2) * PROC_ROW_GAP };
      });
    });
    return positions;
  }

  function loadLocalPositions() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || "null") || null;
    } catch (e) { return null; }
  }

  function resolvePositions(g, preserved) {
    var computed = computeLayout(g);
    var saved = (payload.savedLayout && payload.savedLayout.positions) || loadLocalPositions() || {};
    var out = {};
    Object.keys(computed).forEach(function (id) {
      out[id] = (preserved && preserved[id]) || saved[id] || computed[id];
    });
    return out;
  }

  function capturePositions() {
    if (!cy) return null;
    var out = {};
    cy.nodes().forEach(function (n) {
      if (n.isParent()) return; // parents derive from children
      out[n.id()] = { x: n.position("x"), y: n.position("y") };
    });
    return out;
  }

  // ─── Rendering ─────────────────────────────────────────────────────

  function loadGraph(preserve) {
    var preserved = preserve ? capturePositions() : null;
    api.applicationMap.get().then(function (p) {
      payload = p;
      render(preserved);
    }).catch(function (err) {
      setStatus("Load failed: " + (err && err.message ? err.message : err));
    });
  }

  function render(preserved) {
    var mappedAssets = payload.nodes.filter(function (n) { return n.kind === "asset" && n.hasMappedProcesses; });
    var emptyEl = document.getElementById("appmap-empty");
    var f = currentFilters();
    var g = filterGraph(f);

    if (mappedAssets.length === 0) {
      showEmpty("No mapped processes yet", null);
      if (cy) { cy.destroy(); cy = null; }
      setStatus("");
      return;
    }
    if (g.edges.length === 0 && payload.edges.length > 0) {
      showEmpty("No connections in this window", "Widen the “Seen within” filter — connection data exists but nothing was seen recently enough.");
    } else {
      emptyEl.hidden = true;
    }

    var positions = resolvePositions(g, preserved);
    if (cy) { cy.destroy(); cy = null; }
    cy = cytoscape({
      container: document.getElementById("appmap-graph"),
      elements: buildElements(g),
      wheelSensitivity: 0.2,
      // maxZoom bounds the preset layout's fit too — without it a 3-node
      // graph fit-zooms to fill the whole canvas with giant nodes.
      minZoom: 0.1,
      maxZoom: 1.5,
      style: appmapStylesheet(pageTheme()),
      layout: { name: "preset", positions: function (n) { return positions[n.id()] || undefined; }, fit: true, padding: 40 },
    });
    wireGraphEvents();
    populateSearchList(g);
    setStatus(
      g.nodes.filter(function (n) { return n.kind === "asset"; }).length + " assets · " +
      payload.stats.processCount + " processes · " +
      g.edges.length + " connections" +
      (payload.stats.truncated && payload.stats.truncated.unknownIps ? " · " + payload.stats.truncated.unknownIps + " external IPs collapsed" : "")
    );
    if (selectedId) {
      var sel = cy.getElementById(selectedId);
      if (sel && sel.length) sel.select();
    }
    applyFocusHash();
  }

  var _emptyDefaultHtml = null; // the onboarding <p>'s original markup

  function showEmpty(title, text) {
    var emptyEl = document.getElementById("appmap-empty");
    var textEl = document.getElementById("appmap-empty-text");
    if (_emptyDefaultHtml === null) _emptyDefaultHtml = textEl.innerHTML;
    document.getElementById("appmap-empty-title").textContent = title;
    // null text = restore the onboarding copy (it carries markup, so a
    // one-way textContent overwrite would lose it for the session).
    if (text === null || text === undefined) textEl.innerHTML = _emptyDefaultHtml;
    else textEl.textContent = text;
    emptyEl.hidden = false;
  }

  function setStatus(text) {
    var el = document.getElementById("appmap-status");
    if (el) el.textContent = text;
  }

  function wireGraphEvents() {
    cy.on("tap", "node", function (evt) {
      selectedId = evt.target.id();
      renderInfoNode(evt.target.id());
    });
    cy.on("tap", "edge", function (evt) {
      selectedId = evt.target.id();
      renderInfoEdge(evt.target.id());
    });
    cy.on("tap", function (evt) {
      if (evt.target === cy) {
        selectedId = null;
        var info = document.getElementById("appmap-info");
        info.hidden = true;
        info.innerHTML = "";
      }
    });
    cy.on("dragfree", "node", function () {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(persistLayout, 800);
    });
  }

  function persistLayout() {
    var positions = capturePositions();
    if (!positions) return;
    if (canWriteLayout()) {
      api.applicationMap.saveLayout("global", positions).then(function (dto) {
        if (payload) payload.savedLayout = dto;
      }).catch(function () {
        try { localStorage.setItem(LS_KEY, JSON.stringify(positions)); } catch (e) { /* full */ }
      });
    } else {
      try { localStorage.setItem(LS_KEY, JSON.stringify(positions)); } catch (e) { /* full */ }
    }
  }

  // ─── Info rail ─────────────────────────────────────────────────────

  function findNode(id) {
    for (var i = 0; i < payload.nodes.length; i++) {
      if (payload.nodes[i].id === id) return payload.nodes[i];
    }
    return null;
  }

  function edgesTouching(id) {
    return payload.edges.filter(function (e) { return e.source === id || e.target === id; });
  }

  function renderInfoNode(id) {
    var n = findNode(id);
    var info = document.getElementById("appmap-info");
    if (!n || !info) return;
    var html = "";
    if (n.kind === "asset") {
      html += "<h3>" + esc(n.hostname || n.ipAddress || "asset") + "</h3>";
      html += '<div class="appmap-info-sub">' + esc(n.assetType || "") + (n.ipAddress ? " · " + esc(n.ipAddress) : "") + (n.monitorStatus ? " · " + esc(n.monitorStatus) : "") + "</div>";
      var procs = payload.nodes.filter(function (p) { return p.kind === "process" && p.assetId === n.assetId; });
      if (procs.length) {
        html += "<table><tr><th>Mapped process</th><th>Listening</th></tr>";
        procs.forEach(function (p) {
          var lp = (p.listenPorts || []).map(function (x) { return x.proto + "/" + x.port; }).join(", ");
          html += "<tr><td>" + esc(p.processName) + "</td><td>" + esc(lp || "—") + "</td></tr>";
        });
        html += "</table>";
      }
      html += '<div class="appmap-info-actions"><button type="button" class="btn btn-secondary" data-open-asset="' + esc(n.assetId) + '">Open asset details</button></div>';
    } else if (n.kind === "process") {
      html += "<h3>" + esc(n.processName) + "</h3>";
      var owner = findNode("asset:" + n.assetId);
      html += '<div class="appmap-info-sub">on ' + esc(owner && (owner.hostname || owner.ipAddress) || n.assetId) + "</div>";
      var lp2 = (n.listenPorts || []);
      if (lp2.length) {
        html += "<table><tr><th>Listening port</th></tr>";
        lp2.forEach(function (x) { html += "<tr><td>" + esc(x.proto + "/" + x.port) + "</td></tr>"; });
        html += "</table>";
      }
      var touching = edgesTouching(n.id);
      if (touching.length) {
        html += "<table><tr><th>Connection</th><th>Ports</th></tr>";
        touching.forEach(function (e) {
          var otherId = e.source === n.id ? e.target : e.source;
          var other = findNode(otherId);
          var dir = e.source === n.id ? "→ " : "← ";
          html += "<tr><td>" + esc(dir + (other ? nodeLabel(other).split("\n")[0] : otherId)) + "</td><td>" +
            esc(e.ports.slice(0, 4).map(function (p) { return p.proto + "/" + p.port; }).join(", ") + (e.ports.length > 4 ? " +" + (e.ports.length - 4) : "")) + "</td></tr>";
        });
        html += "</table>";
      }
      html += '<div class="appmap-info-actions"><button type="button" class="btn btn-secondary" data-open-asset="' + esc(n.assetId) + '">Open asset details</button></div>';
    } else {
      html += "<h3>" + esc(nodeLabel(n).split("\n")[0]) + "</h3>";
      html += '<div class="appmap-info-sub">' + (n.kind === "unknown-ip-group" ? "External subnet (not matched to any asset)" : n.kind === "unknown-overflow" ? "Collapsed external endpoints" : "External IP (not matched to any asset)") + "</div>";
      if (n.ips && n.ips.length) {
        html += "<table><tr><th>Member IPs</th></tr>";
        n.ips.slice(0, 50).forEach(function (ip) { html += "<tr><td>" + esc(ip) + "</td></tr>"; });
        if (n.ips.length > 50) html += "<tr><td>… " + (n.ips.length - 50) + " more</td></tr>";
        html += "</table>";
      }
      if (typeof n.connCount === "number") {
        html += '<div class="appmap-info-sub">' + n.connCount + " observed connection(s)</div>";
      }
    }
    info.innerHTML = html;
    info.hidden = false;
    var btn = info.querySelector("[data-open-asset]");
    if (btn) {
      btn.addEventListener("click", function () {
        if (typeof openViewModal === "function") openViewModal(btn.getAttribute("data-open-asset"));
      });
    }
  }

  function renderInfoEdge(id) {
    var info = document.getElementById("appmap-info");
    var e = null;
    for (var i = 0; i < payload.edges.length; i++) {
      if (payload.edges[i].id === id) { e = payload.edges[i]; break; }
    }
    if (!e || !info) return;
    var src = findNode(e.source);
    var tgt = findNode(e.target);
    var html = "<h3>" + esc((src ? nodeLabel(src).split("\n")[0] : e.source) + " → " + (tgt ? nodeLabel(tgt).split("\n")[0] : e.target)) + "</h3>";
    html += '<div class="appmap-info-sub">' + esc(e.kind) + " connection</div>";
    html += "<table><tr><th>Port</th><th>Seen</th><th>Last seen</th></tr>";
    e.ports.forEach(function (p) {
      html += "<tr><td>" + esc(p.proto + "/" + p.port) + "</td><td>" + p.count + "×</td><td>" + esc(new Date(p.lastSeen).toLocaleString()) + "</td></tr>";
    });
    html += "</table>";
    if (e.portOverflow > 0) html += '<div class="appmap-info-sub">+ ' + e.portOverflow + " more port(s)</div>";
    info.innerHTML = html;
    info.hidden = false;
  }

  // ─── Toolbar / search / hash focus ─────────────────────────────────

  function wireToolbar() {
    ["appmap-age", "appmap-proto-tcp", "appmap-proto-udp", "appmap-hide-external"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", function () { if (payload) render(capturePositions()); });
    });
    var refresh = document.getElementById("appmap-refresh");
    if (refresh) refresh.addEventListener("click", function () { loadGraph(true); });

    var legendBtn = document.getElementById("appmap-legend-btn");
    var legend = document.getElementById("appmap-legend");
    if (legendBtn && legend) {
      legendBtn.addEventListener("click", function () { legend.hidden = !legend.hidden; });
      var legendClose = document.getElementById("appmap-legend-close");
      if (legendClose) legendClose.addEventListener("click", function () { legend.hidden = true; });
    }

    var reset = document.getElementById("appmap-reset-layout");
    if (reset) {
      // Permissions are loaded before wireToolbar runs (init awaits
      // fetchCurrentUser), so this is a plain synchronous check.
      if (canWriteLayout()) reset.hidden = false;
      reset.addEventListener("click", function () {
        api.applicationMap.deleteLayout("global").catch(function () { /* best-effort */ });
        try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
        if (payload) { payload.savedLayout = null; render(null); }
      });
    }

    var search = document.getElementById("appmap-search");
    if (search) {
      search.addEventListener("change", function () { focusByLabel(search.value); });
      search.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") focusByLabel(search.value);
      });
    }
  }

  function populateSearchList(g) {
    var list = document.getElementById("appmap-search-list");
    if (!list) return;
    list.innerHTML = "";
    g.nodes.forEach(function (n) {
      var opt = document.createElement("option");
      opt.value = nodeLabel(n).split("\n")[0];
      list.appendChild(opt);
    });
  }

  function focusByLabel(q) {
    if (!cy || !q) return;
    q = q.trim().toLowerCase();
    var hit = null;
    payload.nodes.some(function (n) {
      var label = nodeLabel(n).split("\n")[0].toLowerCase();
      var ip = (n.ipAddress || n.ip || "").toLowerCase();
      if (label.indexOf(q) >= 0 || ip.indexOf(q) >= 0) { hit = n; return true; }
      return false;
    });
    if (!hit) return;
    focusNode(hit.id);
  }

  function focusNode(id) {
    var el = cy.getElementById(id);
    if (!el || el.length === 0) return;
    cy.elements().unselect();
    el.select();
    cy.animate({ center: { eles: el }, zoom: Math.max(cy.zoom(), 1) }, { duration: 250 });
    selectedId = id;
    renderInfoNode(id);
  }

  // Deep link: /appmap.html#focus=asset:<id> (used by the process detail
  // panel's "View on Application Map" link).
  function applyFocusHash() {
    var m = /[#&]focus=([^&]+)/.exec(window.location.hash || "");
    if (!m || !cy) return;
    var id = decodeURIComponent(m[1]);
    if (cy.getElementById(id).length) {
      focusNode(id);
      // One-shot: clear so later refreshes don't re-zoom.
      window.location.hash = "";
    }
  }
})();
