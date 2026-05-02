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
  // Currently-open topology modal state. siteId drives Refresh + position
  // persistence; data is the latest /topology payload (used for endpoint
  // pivots from search results without a re-fetch).
  var topoState = { siteId: null, hostname: null, data: null };
  var topoSearchDebounce = null;
  var topoSuggestState  = { open: false, items: [], index: -1 };
  var POSITION_STORAGE_PREFIX = "polaris.topology.positions:";

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

    // Theme-aware basemap. OpenStreetMap for light theme, CartoDB Dark
    // Matter for dark. Both are free and don't require API keys; CartoDB
    // is documented as fair-use friendly. Tile layer is swapped in place
    // when the operator clicks the map-theme toggle, OR when the global
    // app theme changes AND the user hasn't set a per-user map override
    // (getMapTheme falls back to the global theme in that case).
    applyBasemapTheme();
    var themeObserver = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].attributeName === "data-theme") { applyBasemapTheme(); break; }
      }
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // Per-user map theme toggle in the toolbar — separate from the
    // global app theme. Click flips the saved preference, swaps the
    // basemap, and re-renders the topology modal if it's open.
    var mapThemeBtn = document.getElementById("map-theme-toggle");
    if (mapThemeBtn) mapThemeBtn.addEventListener("click", toggleMapTheme);

    markerCluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      // Default markercluster coloring buckets by child count (small/medium/large
      // → green/yellow/orange). That's misleading here: a cluster of 100 healthy
      // FortiGates would show orange. Roll up the worst monitor health among
      // children instead so the cluster matches the dot colors it represents.
      iconCreateFunction: clusterIcon,
    });
    map.addLayer(markerCluster);
  }

  // Active basemap tile layer; swapped in place when the map theme
  // changes. Holding the reference here so the MutationObserver in initMap
  // can remove the previous layer cleanly.
  var basemapLayer = null;

  // Map page has its own theme toggle, separate from the overall app
  // theme. Persisted per user in localStorage so each operator's
  // preference survives reload. Falls back to the global app theme
  // when no preference is set, so users who don't toggle see no change.
  function _mapThemePrefKey() {
    var u = (typeof currentUsername === "string" && currentUsername) ? currentUsername : "anon";
    return "polaris-prefs-map-" + u;
  }
  function getMapTheme() {
    try {
      var raw = localStorage.getItem(_mapThemePrefKey());
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && (parsed.theme === "dark" || parsed.theme === "light")) {
          return parsed.theme;
        }
      }
    } catch (e) { /* fall through */ }
    return (document.documentElement.getAttribute("data-theme") || "dark");
  }
  function setMapTheme(theme) {
    try {
      localStorage.setItem(_mapThemePrefKey(), JSON.stringify({ theme: theme }));
    } catch (e) { /* quota / private mode — silently skip */ }
  }

  function applyBasemapTheme() {
    if (!map) return;
    var isDark = getMapTheme() === "dark";
    var url = isDark
      ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
    var attribution = isDark
      ? "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors © <a href=\"https://carto.com/attributions\">CARTO</a>"
      : "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors";
    if (basemapLayer) map.removeLayer(basemapLayer);
    basemapLayer = L.tileLayer(url, { maxZoom: 19, attribution: attribution }).addTo(map);
    paintMapThemeToggle();
  }

  // Update the toolbar toggle's icon to reflect the current state.
  // Sun = "switch to light" (i.e. we're currently dark); moon = "switch
  // to dark" (i.e. we're currently light). Matches the global theme
  // toggle's idiom.
  function paintMapThemeToggle() {
    var btn = document.getElementById("map-theme-toggle");
    if (!btn) return;
    var isDark = getMapTheme() === "dark";
    btn.innerHTML = isDark
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
    btn.title = "Map theme: " + (isDark ? "dark" : "light") + " (click to toggle, saved per user)";
  }
  function toggleMapTheme() {
    var next = getMapTheme() === "dark" ? "light" : "dark";
    setMapTheme(next);
    applyBasemapTheme();
    // If the topology modal is open, re-render so its colors follow
    // the new map theme too — Cytoscape stylesheet reads the theme at
    // render time, not reactively.
    var overlay = document.getElementById("topology-overlay");
    if (overlay && overlay.classList.contains("open") && topoState.data) {
      renderTopologyGraph(topoState.data);
    }
  }

  function clusterIcon(cluster) {
    var children = cluster.getAllChildMarkers();
    var sawMonitored = false;
    var worst = "up"; // up < degraded < down
    for (var i = 0; i < children.length; i++) {
      var s = children[i]._site;
      if (!s || !s.monitored) continue;
      sawMonitored = true;
      if (s.monitorHealth === "down") { worst = "down"; break; }
      if (s.monitorHealth === "degraded" && worst !== "down") worst = "degraded";
    }
    var cls = sawMonitored ? "monitor-" + worst : "monitor-unmonitored";
    var count = cluster.getChildCount();
    return L.divIcon({
      html: '<div class="fg-cluster ' + cls + '"><span>' + count + "</span></div>",
      className: "",
      iconSize: [40, 40],
    });
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
      // Tighter fit — 5% padding around the actual asset bounds (was 20%)
      // so the operator's eye lands on the cluster, not the empty
      // ocean/border. maxZoom bumped to 12 for clustered fleets where
      // the natural fit zoom would otherwise be capped too far out.
      map.fitBounds(bounds.pad(0.05), { maxZoom: 12 });
    }
    setStatus(siteCache.length + " FortiGate" + (siteCache.length === 1 ? "" : "s") + " on the map");

    // If the operator landed here from a global-search "site" hit, the URL
    // hash carries `#site=<assetId>`. Pan once the marker cache is built.
    var hash = window.location.hash || "";
    var m = hash.match(/^#site=([^&]+)/);
    if (m) {
      var siteId = decodeURIComponent(m[1]);
      // Defer one frame so fitBounds completes first; then flyTo overrides.
      requestAnimationFrame(function () {
        if (typeof window.polarisMapPanToAsset === "function") {
          window.polarisMapPanToAsset(siteId);
        }
      });
    }
  }

  function monitorClass(site) {
    if (!site.monitored) return "monitor-unmonitored";
    switch (site.monitorHealth) {
      case "up":       return "monitor-up";
      case "degraded": return "monitor-degraded";
      case "down":     return "monitor-down";
      default:         return "monitor-unknown";
    }
  }

  function monitorTooltipLine(site) {
    if (!site.monitored) return "Unmonitored";
    var samples = site.monitorRecentSamples || 0;
    var failures = site.monitorRecentFailures || 0;
    switch (site.monitorHealth) {
      case "up":       return "Up — last " + samples + " samples ok";
      case "degraded": return "Packet loss — " + failures + "/" + samples + " recent samples failed";
      case "down":     return "Down — " + failures + "/" + samples + " samples failed";
      default:         return "Monitored — no samples yet";
    }
  }

  function makeMarker(site) {
    var label = (site.hostname || "FG").slice(0, 3).toUpperCase();
    var icon = L.divIcon({
      className: "",
      html: '<div class="fg-marker ' + monitorClass(site) + '" aria-hidden="true">' + escapeHtml(label) + "</div>",
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    var marker = L.marker([site.latitude, site.longitude], {
      icon: icon,
      title: site.hostname || "",
    });
    // Stashed for clusterIcon() to roll up health across children.
    marker._site = site;
    marker.bindTooltip(
      '<strong>' + escapeHtml(site.hostname || "(unnamed)") + '</strong>' +
      (site.model ? '<br><span style="opacity:.8">' + escapeHtml(site.model) + '</span>' : "") +
      '<br><span style="opacity:.8">' + escapeHtml(monitorTooltipLine(site)) + '</span>' +
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

  // ─── Pan-to hook for the global app-wide search ───────────────────────────
  // The global search bar in the page header (see app.js _searchTargetFor)
  // covers FortiGate hostname/serial lookup as part of its asset results.
  // When the operator picks a FortiGate hit while on the map page, route
  // through this hook so the marker gets focused instead of leaving the
  // page to open the asset details modal. Returns true if we panned, false
  // if the asset isn't on the map (no coords, or not in this site list);
  // the caller can then fall back to the default asset-details navigation.
  window.polarisMapPanToAsset = function (assetId) {
    if (!assetId) return false;
    var site = siteCache.find(function (s) { return s.id === assetId; });
    if (!site) return false;
    focusSite(site);
    setStatus('Showing "' + (site.hostname || site.id) + '"');
    return true;
  };

  // ─── Topology modal ───────────────────────────────────────────────────────
  function wireModal() {
    var overlay = document.getElementById("topology-overlay");
    var closeBtn = document.getElementById("topology-close");
    var screenshotBtn = document.getElementById("topology-screenshot");
    var fullscreenBtn = document.getElementById("topology-fullscreen");
    var refreshBtn = document.getElementById("topology-refresh");
    var searchInput = document.getElementById("topology-search-input");
    closeBtn.addEventListener("click", closeTopology);
    if (screenshotBtn) screenshotBtn.addEventListener("click", screenshotTopology);
    if (fullscreenBtn) fullscreenBtn.addEventListener("click", toggleFullscreenTopology);
    if (refreshBtn) refreshBtn.addEventListener("click", refreshTopology);
    if (searchInput) wireTopologySearch(searchInput);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        closeBtn.classList.add("flash");
        setTimeout(function () { closeBtn.classList.remove("flash"); }, 600);
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.classList.contains("open")) closeTopology();
    });
    // When the browser exits fullscreen via Esc / OS gesture, drop the
    // fullscreen class so the modal styling reverts cleanly.
    document.addEventListener("fullscreenchange", function () {
      var modal = overlay && overlay.querySelector(".modal");
      if (!document.fullscreenElement && modal) modal.classList.remove("topology-fullscreen");
      // Cytoscape needs a resize hint when the container size changes.
      if (cyInstance) { try { cyInstance.resize(); cyInstance.fit(undefined, 30); } catch (e) {} }
    });
  }

  // Toggle native browser fullscreen on the topology modal element. Falls
  // back to a CSS-driven "occupy the whole viewport" mode when the
  // Fullscreen API isn't available (older Safari / iframe contexts).
  function toggleFullscreenTopology() {
    var overlay = document.getElementById("topology-overlay");
    var modal = overlay && overlay.querySelector(".modal");
    if (!modal) return;
    var nativeAvailable = !!(modal.requestFullscreen || modal.webkitRequestFullscreen);
    if (nativeAvailable) {
      if (document.fullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        (modal.requestFullscreen || modal.webkitRequestFullscreen).call(modal);
      }
    } else {
      modal.classList.toggle("topology-fullscreen");
      if (cyInstance) { try { cyInstance.resize(); cyInstance.fit(undefined, 30); } catch (e) {} }
    }
  }

  // Cytoscape ships a built-in cy.png() that respects the current layout/colors
  // and renders independently of the live <canvas>. We pull it as a Blob and
  // copy to the clipboard, mirroring the chart-screenshot UX in assets.js.
  function screenshotTopology() {
    if (!cyInstance) {
      if (typeof showToast === "function") showToast("Topology not loaded", "error");
      return;
    }
    var rootCs = getComputedStyle(document.documentElement);
    var bg = rootCs.getPropertyValue("--color-bg-primary").trim() ||
             rootCs.getPropertyValue("--color-surface").trim() || "#ffffff";
    var blob = cyInstance.png({ output: "blob", scale: 2, full: true, bg: bg });
    if (!blob) {
      if (typeof showToast === "function") showToast("Screenshot failed", "error");
      return;
    }
    if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
      if (typeof showToast === "function") showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
      return;
    }
    navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(function () {
      if (typeof showToast === "function") showToast("Topology copied to clipboard");
    }).catch(function () {
      if (typeof showToast === "function") showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
    });
  }

  async function openTopology(id, hostname) {
    var overlay = document.getElementById("topology-overlay");
    document.getElementById("topology-title").textContent = hostname || "Site topology";
    document.getElementById("topology-graph").innerHTML = "";
    document.getElementById("topology-info").innerHTML = '<p class="muted">Loading…</p>';
    var searchInput = document.getElementById("topology-search-input");
    if (searchInput) searchInput.value = "";
    closeTopologySearchResults();
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    topoState.siteId = id;
    topoState.hostname = hostname || null;
    topoState.data = null;

    try {
      var data = await api.map.topology(id);
      topoState.data = data;
      renderTopologyGraph(data);
      renderTopologyInfo(data);
    } catch (err) {
      document.getElementById("topology-info").innerHTML =
        '<p class="error">Failed to load topology: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>';
    }
  }

  // Re-fetch + re-render WITHOUT destroying the cytoscape instance up
  // front. We capture current node positions before tear-down so the new
  // graph keeps the operator's manual layout where possible.
  async function refreshTopology() {
    if (!topoState.siteId) return;
    var btn = document.getElementById("topology-refresh");
    if (btn) btn.disabled = true;
    try {
      // Snapshot positions for any nodes that survive the refresh.
      if (cyInstance) saveNodePositions(topoState.siteId);
      var data = await api.map.topology(topoState.siteId);
      topoState.data = data;
      renderTopologyGraph(data);
      renderTopologyInfo(data);
      if (typeof showToast === "function") showToast("Topology refreshed");
    } catch (err) {
      if (typeof showToast === "function") {
        showToast("Refresh failed — " + (err && err.message ? err.message : String(err)), "error");
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── Position persistence ───────────────────────────────────────────────────
  // localStorage-backed per-site node positions. Keyed by site id; value is
  // a map of nodeId → {x, y}. Persisted browser-side only — operator-owned
  // mental layout, not shared across users. Stale entries (nodes that no
  // longer appear in the topology) are silently dropped on next save.
  function saveNodePositions(siteId) {
    if (!cyInstance || !siteId) return;
    var out = {};
    cyInstance.nodes().forEach(function (n) {
      var p = n.position();
      if (p && typeof p.x === "number" && typeof p.y === "number") {
        out[n.id()] = { x: p.x, y: p.y };
      }
    });
    try { localStorage.setItem(POSITION_STORAGE_PREFIX + siteId, JSON.stringify(out)); }
    catch (e) { /* quota / private mode — silently skip */ }
  }
  function loadNodePositions(siteId) {
    if (!siteId) return null;
    try {
      var raw = localStorage.getItem(POSITION_STORAGE_PREFIX + siteId);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) { return null; }
  }

  // ── Topology search (slice 2) ──────────────────────────────────────────────
  function wireTopologySearch(input) {
    input.addEventListener("input", function () {
      if (topoSearchDebounce) { clearTimeout(topoSearchDebounce); topoSearchDebounce = null; }
      var q = input.value.trim();
      if (!q) { closeTopologySearchResults(); return; }
      topoSearchDebounce = setTimeout(function () { runTopologySearch(q); }, 200);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeTopologySearchResults(); input.blur(); return; }
      if (!topoSuggestState.open) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        topoSuggestState.index = Math.min(topoSuggestState.items.length - 1, topoSuggestState.index + 1);
        paintTopologySearchResults();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        topoSuggestState.index = Math.max(0, topoSuggestState.index - 1);
        paintTopologySearchResults();
      } else if (e.key === "Enter") {
        e.preventDefault();
        var pick = topoSuggestState.items[topoSuggestState.index];
        if (pick) handleTopologySearchPick(pick);
      }
    });
    document.addEventListener("click", function (e) {
      var box = document.getElementById("topology-search-results");
      if (!box) return;
      if (e.target === input || (box.contains && box.contains(e.target))) return;
      closeTopologySearchResults();
    });
  }

  async function runTopologySearch(q) {
    if (!topoState.siteId) return;
    try {
      var resp = await api.map.topologySearch(topoState.siteId, q);
      topoSuggestState.items = (resp && resp.results) || [];
      topoSuggestState.index = topoSuggestState.items.length > 0 ? 0 : -1;
      topoSuggestState.open = true;
      paintTopologySearchResults();
    } catch (err) {
      topoSuggestState.items = [];
      topoSuggestState.index = -1;
      topoSuggestState.open = true;
      paintTopologySearchResults();
    }
  }

  function paintTopologySearchResults() {
    var box = document.getElementById("topology-search-results");
    if (!box) return;
    box.innerHTML = "";
    box.hidden = !topoSuggestState.open;
    if (!topoSuggestState.open) return;
    if (topoSuggestState.items.length === 0) {
      var li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No endpoints matched in this site.";
      box.appendChild(li);
      return;
    }
    topoSuggestState.items.forEach(function (item, i) {
      var li = document.createElement("li");
      li.setAttribute("role", "option");
      if (i === topoSuggestState.index) li.classList.add("active");
      var primary = item.hostname || item.ipAddress || item.macAddress || "(unnamed)";
      var bits = [];
      if (item.ipAddress)   bits.push(item.ipAddress);
      if (item.macAddress)  bits.push(item.macAddress);
      if (item.assignedTo)  bits.push(item.assignedTo);
      bits.push(item.switchHostname + (item.port ? "/" + item.port : ""));
      li.innerHTML =
        '<div>' + escapeHtml(primary) + '</div>' +
        '<span class="meta">' + escapeHtml(bits.join(" · ")) + '</span>';
      li.addEventListener("mousedown", function (e) {
        e.preventDefault();
        handleTopologySearchPick(item);
      });
      box.appendChild(li);
    });
  }

  // Pulse the matched endpoint's switch on the graph + scroll the info
  // panel to its row. Click an item to navigate to the asset details.
  function handleTopologySearchPick(item) {
    closeTopologySearchResults();
    if (cyInstance && item.switchId) {
      var node = cyInstance.getElementById(item.switchId);
      if (node && node.length > 0) {
        cyInstance.animate({ center: { eles: node }, zoom: 1.4, duration: 350 });
        node.addClass("topology-pulse");
        setTimeout(function () { try { node.removeClass("topology-pulse"); } catch (e) {} }, 1500);
      }
    }
    // Pivot to the endpoint's asset details page.
    if (item.id) window.location.href = "/assets.html#view=asset:" + item.id;
  }

  function closeTopologySearchResults() {
    topoSuggestState.open = false;
    topoSuggestState.items = [];
    topoSuggestState.index = -1;
    var box = document.getElementById("topology-search-results");
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  function closeTopology() {
    // Persist current node positions before tear-down so reopening the
    // same site restores the operator's manual layout.
    if (topoState.siteId && cyInstance) saveNodePositions(topoState.siteId);
    closeTopologySearchResults();
    topoState.siteId = null;
    topoState.hostname = null;
    topoState.data = null;
    // Exit native fullscreen first — otherwise the browser stays in
    // fullscreen mode showing nothing after the modal hides, and the user
    // has to hit Esc / their OS gesture to recover.
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        try { exit.call(document); } catch (e) {}
      }
    }
    var overlay = document.getElementById("topology-overlay");
    var modal = overlay && overlay.querySelector(".modal");
    if (modal) modal.classList.remove("topology-fullscreen");
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    if (cyInstance) {
      cyInstance.destroy();
      cyInstance = null;
    }
  }

  function fortigateNodeColor(fg) {
    if (!fg.monitored) return "#757575"; // gray — unmonitored
    switch (fg.monitorHealth) {
      case "up":       return "#2e7d32"; // green
      case "degraded": return "#f9a825"; // amber
      case "down":     return "#c62828"; // red
      default:         return "#9e9e9e"; // unknown — light gray
    }
  }

  function renderTopologyGraph(data) {
    var elements = [];

    elements.push({
      data: {
        id: data.fortigate.id,
        label: data.fortigate.hostname || "FortiGate",
        role: "fortigate",
        nodeColor: fortigateNodeColor(data.fortigate),
        iconUrl: data.fortigate.iconUrl || null,
        hasIcon: data.fortigate.iconUrl ? 1 : 0,
      },
    });
    (data.switches || []).forEach(function (s) {
      elements.push({
        data: {
          id: s.id,
          label: s.hostname || "FortiSwitch",
          role: "fortiswitch",
          iconUrl: s.iconUrl || null,
          hasIcon: s.iconUrl ? 1 : 0,
        },
      });
    });
    (data.aps || []).forEach(function (a) {
      elements.push({
        data: {
          id: a.id,
          label: a.hostname || "FortiAP",
          role: "fortiap",
          iconUrl: a.iconUrl || null,
          hasIcon: a.iconUrl ? 1 : 0,
        },
      });
    });
    (data.edges || []).forEach(function (e, i) {
      elements.push({
        data: {
          id: "e" + i, source: e.source, target: e.target,
          label: e.label || "",
          reason: e.reason || "",
        },
      });
    });
    // LLDP-derived ghost nodes for non-Polaris neighbors. The dashed border
    // and orange tint signal "observed via LLDP, not authoritatively managed".
    (data.lldpNodes || []).forEach(function (n) {
      var label = n.hostname || n.managementIp || n.chassisId || "Unknown";
      elements.push({
        data: { id: n.id, label: label, role: "lldp" },
      });
    });
    // Cross-site Polaris assets observed via LLDP from this site. Separate
    // role so the styling can flag "real asset, just elsewhere" — and
    // tagged with `assetId` so the click handler can pivot to that asset's
    // details page.
    (data.remoteAssetNodes || []).forEach(function (n) {
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
      elements.push({
        data: {
          id: "le" + i, source: e.source, target: e.target,
          label: e.label || "", isLldp: 1,
          reason: e.reason || "",
        },
      });
    });
    // Interface-inferred edges — CMDB-stamped peer aggregates (FortiOS auto
    // serial-named or operator-named hostname-named). Authoritative, so
    // rendered with a solid teal line to contrast with the dashed orange
    // LLDP edges and the muted gray controller-data edges.
    (data.interfaceEdges || []).forEach(function (e, i) {
      elements.push({
        data: {
          id: "ie" + i, source: e.source, target: e.target,
          label: e.label || "", isIface: 1,
          reason: e.reason || "",
        },
      });
    });

    // Topology graph follows the per-user MAP theme (not the global app
    // theme) so the toolbar toggle drives both the basemap and the
    // modal coherently.
    var theme = getMapTheme();
    var isDark = theme === "dark";
    var textColor = isDark ? "#eef0f4" : "#1a1a1a";
    var edgeColor = isDark ? "#6a7388" : "#9aa2b1";

    // Refresh path: tear down the previous cytoscape before mounting the
    // new one. Without this, a Refresh click stacks two graphs and the
    // canvas leaks.
    if (cyInstance) {
      try { cyInstance.destroy(); } catch (e) {}
      cyInstance = null;
    }

    // Restore manually-dragged node positions from localStorage if any
    // are saved for this site. We use the dagre layout as the base
    // (handles new nodes that didn't exist last time), then snap saved
    // nodes to their stored positions in a layoutstop hook below.
    var savedPositions = topoState.siteId ? loadNodePositions(topoState.siteId) : null;

    cyInstance = cytoscape({
      container: document.getElementById("topology-graph"),
      elements: elements,
      // Box-select: shift+drag on background draws a selection rectangle;
      // selected nodes can be dragged together to rearrange. Multi-node
      // selection is also addable via shift-click on individual nodes.
      // Pan stays as plain drag on background (Cytoscape default).
      boxSelectionEnabled: true,
      selectionType: "additive",
      // Halve scroll-wheel zoom sensitivity — the default felt jumpy on
      // typical mouse wheels (one notch was 25–30% zoom step).
      wheelSensitivity: 0.5,
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
        // FortiGate node color is driven by its monitor health (computed
        // server-side from the last 10 AssetMonitorSample rows).
        { selector: 'node[role="fortigate"]',   style: { "background-color": "data(nodeColor)", width: 64, height: 64, "font-weight": 700 } },
        // FortiSwitches and FortiAPs always render as dark gray: they sit
        // behind the FortiGate, so Polaris can't independently verify their
        // reachability — coloring them green/red would be misleading.
        { selector: 'node[role="fortiswitch"]', style: { "background-color": "#37474f" } },
        { selector: 'node[role="fortiap"]',     style: { "background-color": "#37474f", width: 36, height: 36 } },
        // LLDP-discovered ghost neighbor (non-Polaris device, e.g. an upstream
        // ISP router or a third-party access switch). Orange + dashed border
        // signals "we know it's there because LLDP told us, but Polaris isn't
        // managing it directly".
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
        // Cross-site Polaris asset observed via LLDP (e.g. a firewall at
        // another site that this site's FortiGate sees as an upstream
        // neighbor). Solid border + blue tint signals "real Polaris asset,
        // just not this site". Click navigates to the asset details page.
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
        // Operator-uploaded device icon. Overrides the role-color with the
        // uploaded image when an icon was resolved for this node's
        // (manufacturer, model, assetType) combo. Sized larger so the icon
        // is legible. Selected with `hasIcon = 1` (Cytoscape doesn't allow
        // boolean property selectors directly, so the data field stamps an
        // integer).
        {
          selector: 'node[hasIcon = 1]',
          style: {
            "background-image": "data(iconUrl)",
            "background-fit": "contain",
            "background-clip": "node",
            "background-color": "#ffffff", // contrast layer behind translucent icons
            "background-opacity": 0.95,
            width: 56,
            height: 56,
            "border-width": 1,
          },
        },
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
        // LLDP edges render dashed in the orange ghost-node tint so the
        // operator can tell at a glance which links came from authoritative
        // controller data (FortiLink, switch-controller MAC learning) vs
        // observed LLDP advertisements.
        {
          selector: 'edge[isLldp = 1]',
          style: {
            "line-style": "dashed",
            "line-color": "#f59e0b",
            "target-arrow-color": "#f59e0b",
          },
        },
        // Interface-inferred edges (peer aggregates whose name encodes the
        // peer's serial fragment or hostname). These are CMDB-stamped, so
        // a confident solid teal line — distinct from both the muted
        // gray controller-data edges and the dashed orange LLDP edges.
        {
          selector: 'edge[isIface = 1]',
          style: {
            "line-style": "solid",
            "line-color": "#14b8a6",
            "target-arrow-color": "#14b8a6",
            width: 2.4,
          },
        },
        // Pulse style applied transiently to a node that the topology
        // search just located. Bright accent ring draws the eye; class
        // is removed after ~1.5s by the pick handler.
        {
          selector: 'node.topology-pulse',
          style: {
            "border-color": "#22d3ee",
            "border-width": 4,
            "border-opacity": 1,
          },
        },
        // Selected nodes (shift+drag box-select OR shift+click) — bright
        // cyan halo + thicker border so the operator can see exactly
        // which nodes are about to move when they drag the group. The
        // default Cytoscape selection styling is too subtle on dark.
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
        // Selected edges get the same accent so multi-select operations
        // that include edges (e.g. inspecting a sub-graph) read clearly.
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
        // Selection rectangle (shift+drag on background). The default
        // Cytoscape rectangle is a faint gray that disappears against
        // the dark modal background. Give it the same bright cyan
        // accent the selected nodes use.
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
      ],
    });

    // Restore saved positions AFTER the dagre layout finishes so any
    // brand-new nodes get a sensible default placement and only the ones
    // the operator dragged previously snap to their stored coordinates.
    cyInstance.one("layoutstop", function () {
      if (!savedPositions) return;
      cyInstance.batch(function () {
        cyInstance.nodes().forEach(function (n) {
          var p = savedPositions[n.id()];
          if (p && typeof p.x === "number" && typeof p.y === "number") {
            n.position({ x: p.x, y: p.y });
          }
        });
      });
      try { cyInstance.fit(undefined, 30); } catch (e) {}
    });

    // Persist node position on every drag-stop so a refresh / reopen
    // restores the operator's manual layout. Debounced via the timer
    // below so a long drag doesn't write per-tick.
    var saveTimer = null;
    cyInstance.on("dragfree", "node", function () {
      if (!topoState.siteId) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveNodePositions(topoState.siteId);
      }, 250);
    });

    // Click-through on cross-site Polaris asset nodes — navigate to that
    // asset's details page on the Assets tab. Other node kinds (firewall,
    // switch, AP, ghost-LLDP) don't have a navigation target so we skip.
    cyInstance.on("tap", 'node[role="remote-asset"]', function (evt) {
      var assetId = evt.target.data("assetId");
      if (assetId) {
        window.location.href = "/assets.html#view=asset:" + assetId;
      }
    });

    // Hover tooltip on edges — explains the rule + evidence behind each
    // connection. Backend stamps a `reason` data field on every edge
    // (controller, interface-inferred, LLDP). The tooltip lets the
    // operator audit the topology layer without reading code.
    cyInstance.on("mouseover", "edge", function (evt) {
      var reason = evt.target.data("reason");
      if (!reason) return;
      var orig = evt.originalEvent;
      var x = orig && typeof orig.clientX === "number" ? orig.clientX : 0;
      var y = orig && typeof orig.clientY === "number" ? orig.clientY : 0;
      showEdgeTooltip(reason, x, y);
    });
    cyInstance.on("mousemove", "edge", function (evt) {
      // Track the cursor so the tooltip follows the edge as the operator
      // sweeps along it.
      var orig = evt.originalEvent;
      if (!orig) return;
      moveEdgeTooltip(orig.clientX, orig.clientY);
    });
    cyInstance.on("mouseout", "edge", function () { hideEdgeTooltip(); });
  }

  // ── Edge hover tooltip ─────────────────────────────────────────────────────
  // Rendered as a fixed-position div appended to <body> (not the modal) so
  // it doesn't get clipped by the modal's overflow rules and stays visible
  // when the modal is fullscreen. Single instance reused for every edge.
  var _edgeTooltipEl = null;
  function ensureEdgeTooltip() {
    if (_edgeTooltipEl) return _edgeTooltipEl;
    var el = document.createElement("div");
    el.id = "topology-edge-tooltip";
    el.setAttribute("role", "tooltip");
    document.body.appendChild(el);
    _edgeTooltipEl = el;
    return el;
  }
  function showEdgeTooltip(text, clientX, clientY) {
    var el = ensureEdgeTooltip();
    // Preserve newlines from the backend reason — pre-wrap renders them
    // and CSS clamps the width.
    el.textContent = text;
    el.classList.add("visible");
    moveEdgeTooltip(clientX, clientY);
  }
  function moveEdgeTooltip(clientX, clientY) {
    var el = _edgeTooltipEl;
    if (!el || !el.classList.contains("visible")) return;
    // Anchor below-right of the cursor, but flip to above-left near the
    // viewport edge so the tooltip never escapes the screen.
    var pad = 14;
    var rect = el.getBoundingClientRect();
    var maxX = window.innerWidth - rect.width - 6;
    var maxY = window.innerHeight - rect.height - 6;
    var x = clientX + pad; if (x > maxX) x = clientX - rect.width - pad;
    var y = clientY + pad; if (y > maxY) y = clientY - rect.height - pad;
    if (x < 6) x = 6;
    if (y < 6) y = 6;
    el.style.left = x + "px";
    el.style.top  = y + "px";
  }
  function hideEdgeTooltip() {
    if (_edgeTooltipEl) _edgeTooltipEl.classList.remove("visible");
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
        var endpointCount = s.endpointCount || 0;
        var endpoints = s.endpoints || [];
        parts.push(
          '<li><a href="/assets.html#asset=' + encodeURIComponent(s.id) + '">' + escapeHtml(s.hostname || "(unnamed)") + '</a>' +
          '<span class="meta">' + escapeHtml(displayableUplink(s.uplinkInterface) || "—") + '</span></li>'
        );
        if (endpointCount > 0) {
          var samplesShown = Math.min(endpoints.length, 25);
          var heading = "Endpoints (" + endpointCount + ")";
          if (samplesShown < endpointCount) heading += " — showing " + samplesShown;
          parts.push(
            '<li class="switch-endpoints"><details>' +
            '<summary>' + escapeHtml(heading) + '</summary><ul>'
          );
          endpoints.forEach(function (ep) {
            var primary = ep.hostname || ep.ipAddress || ep.macAddress || "(unnamed)";
            var bits = [];
            if (ep.port) bits.push(ep.port);
            if (ep.ipAddress)  bits.push(ep.ipAddress);
            if (ep.assignedTo) bits.push(ep.assignedTo);
            parts.push(
              '<li><a href="/assets.html#view=asset:' + encodeURIComponent(ep.id) + '">' +
              escapeHtml(primary) + '</a>' +
              '<span class="meta">' + escapeHtml(bits.join(" · ")) + '</span></li>'
            );
          });
          parts.push('</ul></details></li>');
        }
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

    // CMDB-inferred peers from interface naming conventions (FortiOS-auto
    // serial aggregates + operator-named hostname aggregates). These map
    // back to the solid teal edges in the graph. Built from the inventory
    // we already loaded; sourceIfName tells the operator which local
    // aggregate carries the link.
    var interfaceEdges = data.interfaceEdges || [];
    var remoteLookup = {};
    (data.remoteAssetNodes || []).forEach(function (n) { remoteLookup[n.id] = n; });
    var siblingLookup = {};
    (data.switches || []).forEach(function (s) { siblingLookup[s.id] = s; });
    (data.aps || []).forEach(function (a) { siblingLookup[a.id] = a; });
    if (interfaceEdges.length > 0) {
      parts.push('<div class="topology-section"><h5>Interface-inferred peers (' + interfaceEdges.length + ')</h5><ul>');
      interfaceEdges.forEach(function (e) {
        var target = remoteLookup[e.target] || siblingLookup[e.target] || null;
        var label = target ? (target.hostname || target.ipAddress || target.id) : e.target;
        var hrefId = e.target;
        parts.push(
          '<li><a href="/assets.html#asset=' + encodeURIComponent(hrefId) + '">' + escapeHtml(label) + '</a>' +
          '<span class="meta">' + escapeHtml((e.sourceIfName || "") + (e.matchVia === "hostname" ? " · hostname" : "")) + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }

    // LLDP-discovered neighbors (matched + ghost). Listed alongside Switches /
    // APs so the operator can see what the FortiGate / managed switches
    // actually advertise on the wire — the dashed orange edges in the graph
    // map back to entries here.
    var lldpNodes = data.lldpNodes || [];
    var lldpEdges = data.lldpEdges || [];
    if (lldpNodes.length > 0 || lldpEdges.length > 0) {
      parts.push('<div class="topology-section"><h5>LLDP Neighbors (' + lldpEdges.length + ')</h5><ul>');
      lldpEdges.forEach(function (e) {
        var label = e.targetLabel || "Unknown neighbor";
        var titleHtml = e.targetIsAsset
          ? '<a href="/assets.html#asset=' + encodeURIComponent(e.target) + '">' + escapeHtml(label) + '</a>'
          : escapeHtml(label);
        parts.push(
          '<li><span>' + titleHtml + '</span>' +
          '<span class="meta">' + escapeHtml(e.label || "") + '</span></li>'
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

  // Filter out FortiOS meta-interface names that don't add useful
  // information to the topology view. "fortilink" is the software-managed
  // FortiLink interface on the FortiGate side; the relationship it
  // represents is already encoded in the FG→switch edge itself, so
  // displaying it as a label is redundant. Real port names like "port49"
  // or aggregate serial-fragments like "8FFTV23025884-0" still pass through.
  function displayableUplink(name) {
    if (!name) return "";
    return String(name).toLowerCase() === "fortilink" ? "" : name;
  }
})();
