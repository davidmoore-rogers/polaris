/**
 * public/js/map.js — Device Map page
 *
 * Reads firewall assets populated by FortiManager / FortiGate discovery (with
 * lat/lng pulled from `config system global`) and plots them on a Leaflet map.
 * A FortiGate click fetches /map/sites/:id/topology and renders a Cytoscape
 * graph of FortiGate → FortiSwitches → FortiAPs, using edge data captured from
 * switch-controller detected-device MAC learnings (real uplinks, not guesses).
 */

(function () {
  var map = null;
  var markerCluster = null;
  var markersById = Object.create(null); // id → L.Marker
  var cyInstance = null;
  var siteCache = [];                    // last /map/sites payload
  var suggestState = { open: false, items: [], index: -1 };
  var searchDebounce = null;

  // Register cytoscape-dagre once. Both globals are populated by the UMD builds
  // loaded in map.html. Guarded so hot-reload doesn't throw.
  if (window.cytoscape && window.cytoscapeDagre && !window._cytoscapeDagreRegistered) {
    window.cytoscape.use(window.cytoscapeDagre);
    window._cytoscapeDagreRegistered = true;
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", async function () {
    await fetchCurrentUser();
    renderNav();

    initMap();
    wireSearch();
    wireModal();

    try {
      await loadSites();
    } catch (err) {
      setStatus("Failed to load sites: " + (err && err.message ? err.message : err));
    }
  });

  // ─── Leaflet setup ────────────────────────────────────────────────────────
  function initMap() {
    map = L.map("map", {
      worldCopyJump: true,
      // Continental-US starting view — bounds will tighten once data loads
      center: [39.5, -95],
      zoom: 4,
    });

    // Leaflet's default marker icons rely on images being sibling to leaflet.css.
    // We bundle them under /css/vendor/leaflet/images — point Leaflet at that
    // path so PNG URLs resolve correctly.
    L.Icon.Default.imagePath = "/css/vendor/leaflet/images/";

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
    }).addTo(map);

    markerCluster = L.markerClusterGroup({ showCoverageOnHover: false });
    map.addLayer(markerCluster);
  }

  // ─── Sites load ───────────────────────────────────────────────────────────
  async function loadSites() {
    setStatus("Loading FortiGates…");
    var sites = await api.map.sites();
    siteCache = Array.isArray(sites) ? sites : [];
    markerCluster.clearLayers();
    markersById = Object.create(null);

    if (siteCache.length === 0) {
      setStatus("No FortiGates with coordinates yet. Run a discovery; the map populates from `config system global`.");
      return;
    }

    var latlngs = [];
    siteCache.forEach(function (s) {
      if (s.latitude == null || s.longitude == null) return;
      var m = makeMarker(s);
      markerCluster.addLayer(m);
      markersById[s.id] = m;
      latlngs.push([s.latitude, s.longitude]);
    });

    if (latlngs.length > 0) {
      var bounds = L.latLngBounds(latlngs);
      map.fitBounds(bounds.pad(0.2), { maxZoom: 11 });
    }
    setStatus(siteCache.length + " FortiGate" + (siteCache.length === 1 ? "" : "s") + " on the map");
  }

  function makeMarker(site) {
    var statusClass = " status-" + (site.status || "active");
    var label = (site.hostname || "FG").slice(0, 3).toUpperCase();
    var icon = L.divIcon({
      className: "",
      html: '<div class="fg-marker' + statusClass + '" aria-hidden="true">' + escapeHtml(label) + "</div>",
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    var marker = L.marker([site.latitude, site.longitude], {
      icon: icon,
      title: site.hostname || "",
    });
    marker.bindTooltip(
      '<strong>' + escapeHtml(site.hostname || "(unnamed)") + '</strong>' +
      (site.model ? '<br><span style="opacity:.8">' + escapeHtml(site.model) + '</span>' : "") +
      (site.subnetCount ? '<br>' + site.subnetCount + ' subnet' + (site.subnetCount === 1 ? '' : 's') : ''),
      { direction: "top", offset: [0, -12] }
    );
    marker.on("click", function () { openTopology(site.id, site.hostname || ""); });
    return marker;
  }

  function focusSite(site) {
    if (site.latitude == null || site.longitude == null) return;
    map.flyTo([site.latitude, site.longitude], 13, { duration: 0.8 });
    var marker = markersById[site.id];
    if (marker) {
      // If the marker is still inside a cluster, zoom to it; once revealed,
      // fire a click so the tooltip/modal path is consistent with direct use.
      setTimeout(function () {
        if (markerCluster.hasLayer(marker)) {
          markerCluster.zoomToShowLayer(marker, function () {
            marker.openTooltip();
          });
        } else {
          marker.openTooltip();
        }
      }, 700);
    }
  }

  // ─── Search + autocomplete ────────────────────────────────────────────────
  function wireSearch() {
    var form = document.getElementById("map-search-form");
    var input = document.getElementById("map-search-input");
    var list = document.getElementById("map-search-suggest");

    input.addEventListener("input", function () {
      var q = input.value.trim();
      clearTimeout(searchDebounce);
      if (!q) {
        closeSuggest();
        return;
      }
      searchDebounce = setTimeout(function () { runSuggest(q); }, 150);
    });

    input.addEventListener("keydown", function (e) {
      if (!suggestState.open || suggestState.items.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSuggest(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSuggest(-1);
      } else if (e.key === "Escape") {
        closeSuggest();
      } else if (e.key === "Enter" && suggestState.index >= 0) {
        e.preventDefault();
        var pick = suggestState.items[suggestState.index];
        if (pick) chooseSite(pick);
      }
    });

    input.addEventListener("blur", function () {
      // Delay so a click on a suggestion can register first
      setTimeout(closeSuggest, 150);
    });
    input.addEventListener("focus", function () {
      if (input.value.trim()) runSuggest(input.value.trim());
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      // If suggestions are open and one is active, take that; otherwise try to
      // match the query against the cached site list (exact/startsWith first).
      if (suggestState.open && suggestState.index >= 0) {
        chooseSite(suggestState.items[suggestState.index]);
        return;
      }
      var match = findBestMatch(q);
      if (match) {
        chooseSite(match);
      } else {
        setStatus('No FortiGate matches "' + q + '"');
      }
    });

    list.addEventListener("mousedown", function (e) {
      // mousedown beats blur; grab the li without letting the input lose focus early
      var li = e.target.closest("li[data-id]");
      if (!li) return;
      e.preventDefault();
      var id = li.getAttribute("data-id");
      var pick = suggestState.items.find(function (s) { return s.id === id; });
      if (pick) chooseSite(pick);
    });
  }

  async function runSuggest(q) {
    try {
      var results = await api.map.search(q);
      suggestState.items = Array.isArray(results) ? results : [];
      suggestState.index = suggestState.items.length > 0 ? 0 : -1;
      renderSuggest();
    } catch (err) {
      console.error("map search failed", err);
    }
  }

  function renderSuggest() {
    var list = document.getElementById("map-search-suggest");
    if (suggestState.items.length === 0) {
      list.innerHTML = "";
      list.hidden = true;
      suggestState.open = false;
      return;
    }
    list.innerHTML = suggestState.items.map(function (s, i) {
      var selected = i === suggestState.index ? ' aria-selected="true"' : "";
      return (
        '<li role="option" data-id="' + s.id + '"' + selected + '>' +
          '<span>' + escapeHtml(s.hostname || "(unnamed)") + '</span>' +
          (s.serialNumber ? '<span class="suggest-sub">' + escapeHtml(s.serialNumber) + '</span>' : '') +
        '</li>'
      );
    }).join("");
    list.hidden = false;
    suggestState.open = true;
  }

  function moveSuggest(delta) {
    var n = suggestState.items.length;
    if (n === 0) return;
    suggestState.index = ((suggestState.index + delta) % n + n) % n;
    renderSuggest();
  }

  function closeSuggest() {
    var list = document.getElementById("map-search-suggest");
    list.hidden = true;
    suggestState.open = false;
    suggestState.index = -1;
  }

  function chooseSite(site) {
    var input = document.getElementById("map-search-input");
    input.value = site.hostname || "";
    closeSuggest();
    focusSite(site);
    setStatus('Showing "' + (site.hostname || site.id) + '"');
  }

  function findBestMatch(q) {
    var qLower = q.toLowerCase();
    var exact = siteCache.find(function (s) { return (s.hostname || "").toLowerCase() === qLower; });
    if (exact) return exact;
    var starts = siteCache.find(function (s) { return (s.hostname || "").toLowerCase().startsWith(qLower); });
    if (starts) return starts;
    return siteCache.find(function (s) {
      var h = (s.hostname || "").toLowerCase();
      var sn = (s.serialNumber || "").toLowerCase();
      return h.indexOf(qLower) !== -1 || sn.indexOf(qLower) !== -1;
    }) || null;
  }

  // ─── Topology modal ───────────────────────────────────────────────────────
  function wireModal() {
    var overlay = document.getElementById("topology-overlay");
    var closeBtn = document.getElementById("topology-close");
    closeBtn.addEventListener("click", closeTopology);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        closeBtn.classList.add("flash");
        setTimeout(function () { closeBtn.classList.remove("flash"); }, 600);
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.classList.contains("open")) closeTopology();
    });
  }

  async function openTopology(id, hostname) {
    var overlay = document.getElementById("topology-overlay");
    document.getElementById("topology-title").textContent = hostname || "Site topology";
    document.getElementById("topology-graph").innerHTML = "";
    document.getElementById("topology-info").innerHTML = '<p class="muted">Loading…</p>';
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");

    try {
      var data = await api.map.topology(id);
      renderTopologyGraph(data);
      renderTopologyInfo(data);
    } catch (err) {
      document.getElementById("topology-info").innerHTML =
        '<p class="error">Failed to load topology: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>';
    }
  }

  function closeTopology() {
    var overlay = document.getElementById("topology-overlay");
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    if (cyInstance) {
      cyInstance.destroy();
      cyInstance = null;
    }
  }

  function renderTopologyGraph(data) {
    var elements = [];

    elements.push({
      data: { id: data.fortigate.id, label: data.fortigate.hostname || "FortiGate", role: "fortigate" },
    });
    (data.switches || []).forEach(function (s) {
      elements.push({
        data: {
          id: s.id,
          label: (s.hostname || "FortiSwitch") + (s.uplinkInterface ? "\n↥ " + s.uplinkInterface : ""),
          role: "fortiswitch",
        },
      });
    });
    (data.aps || []).forEach(function (a) {
      elements.push({
        data: {
          id: a.id,
          label: (a.hostname || "FortiAP") + (a.peerPort ? "\n" + a.peerPort : ""),
          role: "fortiap",
        },
      });
    });
    (data.edges || []).forEach(function (e, i) {
      elements.push({
        data: { id: "e" + i, source: e.source, target: e.target, label: e.label || "" },
      });
    });

    var theme = document.documentElement.getAttribute("data-theme") || "dark";
    var isDark = theme === "dark";
    var textColor = isDark ? "#eef0f4" : "#1a1a1a";
    var edgeColor = isDark ? "#6a7388" : "#9aa2b1";

    cyInstance = cytoscape({
      container: document.getElementById("topology-graph"),
      elements: elements,
      layout: {
        name: "dagre",
        rankDir: "TB",
        nodeSep: 55,
        rankSep: 90,
        fit: true,
        padding: 30,
      },
      style: [
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
        { selector: 'node[role="fortigate"]',   style: { "background-color": "#d32f2f", width: 64, height: 64, "font-weight": 700 } },
        { selector: 'node[role="fortiswitch"]', style: { "background-color": "#1976d2" } },
        { selector: 'node[role="fortiap"]',     style: { "background-color": "#388e3c", width: 36, height: 36 } },
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
            "text-background-color": isDark ? "#1c2029" : "#ffffff",
            "text-background-opacity": 0.85,
            "text-background-padding": 2,
            "text-rotation": "autorotate",
          },
        },
      ],
    });
  }

  function renderTopologyInfo(data) {
    var fg = data.fortigate || {};
    var parts = [];
    parts.push('<h4>' + escapeHtml(fg.hostname || "FortiGate") + '</h4>');

    parts.push('<div class="detail-row"><span class="label">Serial</span><span class="value">' + escapeHtml(fg.serial || "—") + '</span></div>');
    parts.push('<div class="detail-row"><span class="label">Model</span><span class="value">' + escapeHtml(fg.model || "—") + '</span></div>');
    parts.push('<div class="detail-row"><span class="label">Mgmt IP</span><span class="value">' + escapeHtml(fg.ip || "—") + '</span></div>');
    parts.push('<div class="detail-row"><span class="label">Status</span><span class="value">' + escapeHtml(fg.status || "—") + '</span></div>');
    if (fg.lastSeen) {
      parts.push('<div class="detail-row"><span class="label">Last seen</span><span class="value">' + escapeHtml(new Date(fg.lastSeen).toLocaleString()) + '</span></div>');
    }
    if (fg.latitude != null && fg.longitude != null) {
      parts.push('<div class="detail-row"><span class="label">Coords</span><span class="value">' + fg.latitude.toFixed(4) + ', ' + fg.longitude.toFixed(4) + '</span></div>');
    }

    if ((data.switches || []).length > 0) {
      parts.push('<div class="topology-section"><h5>FortiSwitches (' + data.switches.length + ')</h5><ul>');
      data.switches.forEach(function (s) {
        parts.push(
          '<li><a href="/assets.html#asset=' + encodeURIComponent(s.id) + '">' + escapeHtml(s.hostname || "(unnamed)") + '</a>' +
          '<span class="meta">' + escapeHtml(s.uplinkInterface || "—") + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }
    if ((data.aps || []).length > 0) {
      parts.push('<div class="topology-section"><h5>FortiAPs (' + data.aps.length + ')</h5><ul>');
      data.aps.forEach(function (a) {
        var meta = a.peerSwitch ? (a.peerSwitch + "/" + (a.peerPort || "?")) : "direct";
        parts.push(
          '<li><a href="/assets.html#asset=' + encodeURIComponent(a.id) + '">' + escapeHtml(a.hostname || "(unnamed)") + '</a>' +
          '<span class="meta">' + escapeHtml(meta) + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }
    if ((data.subnets || []).length > 0) {
      parts.push('<div class="topology-section"><h5>Subnets (' + data.subnets.length + ')</h5><ul>');
      data.subnets.forEach(function (n) {
        parts.push(
          '<li><a href="/subnets.html#subnet=' + encodeURIComponent(n.id) + '">' + escapeHtml(n.cidr) + '</a>' +
          '<span class="meta">' + (n.vlan ? 'VLAN ' + n.vlan : (n.name ? escapeHtml(n.name) : '—')) + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }

    document.getElementById("topology-info").innerHTML = parts.join("");
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function setStatus(text) {
    var el = document.getElementById("map-status");
    if (el) el.textContent = text;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
