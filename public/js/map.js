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
  // activeView: "flat" (default — today's whole-site render) or a floor-view
  // key "<buildingKey>|<floorKey>" from computeFloorViews. Not persisted —
  // the modal always opens on Flat. floorViews caches the current payload's
  // view list for the switcher chips.
  var topoState = { siteId: null, hostname: null, data: null, pathOverlay: null, activeView: "flat", floorViews: [], hasLocationCodes: false };
  var topoSearchDebounce = null;
  var topoSuggestState  = { open: false, items: [], index: -1 };
  var POSITION_STORAGE_PREFIX = "polaris.topology.positions:";
  // Column-layout spacing (shared by the base preset layout + the
  // connection-path overlay so an endpoint lands exactly one column right of
  // its access switch/AP). depth → x (px between adjacent columns),
  // lane → y (px between stacked nodes in a column).
  var TOPO_COL_SPACING = 130;
  var TOPO_ROW_SPACING = 95;
  // Legend overlay: per-user (singleton) — same key for every site, since
  // the legend describes the rendering rules, not site-specific content.
  // Persisted state is `{visible, x, y}` so opening the modal restores the
  // operator's last spot. Drag offsets are clamped on render to keep the
  // panel inside the graph if the modal was resized between sessions.
  var LEGEND_STORAGE_KEY = "polaris.topology.legend";
  // Device-type visibility toggles (floating chips at the top-right of the
  // graph area): per-user singleton like the legend — hidden types persist
  // across sites/sessions. Stored as an array of role strings. The fortigate
  // root is intentionally NOT toggleable: it anchors the column solver, and
  // hiding it would drop the whole layout back to dagre.
  var TYPE_FILTER_STORAGE_KEY = "polaris.topology.hiddenRoles";
  // Location grouping hulls (building / floor / room / jb shapes from
  // b:/f:/r:/jb: codes in device descriptions): per-user singleton toggle,
  // default ON. The chip only renders when the site actually carries codes,
  // so untagged fleets see zero UI change.
  var SHOW_LOCATIONS_STORAGE_KEY = "polaris.topology.showLocations";
  // Toggleable roles, in chip display order. Only roles that buildTopologyElements
  // actually renders as nodes belong here (wireless clients / LLDP ghosts are
  // never drawn, and wired endpoints only appear as synthetic search-overlay
  // nodes, which bypass the filter by design).
  var TOPO_TYPE_TOGGLES = [
    { role: "fortiswitch",  label: "Switches" },
    { role: "fortiap",      label: "APs" },
    { role: "remote-asset", label: "Remote" },
  ];

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
    wireRegionEditing();

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
      // Fractional zoom so fitBounds fills the viewport instead of rounding
      // down to the nearest integer zoom (which left a large empty border
      // around the fleet on the default load).
      zoomSnap: 0.25,
      zoomDelta: 0.5,
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
      maxClusterRadius: 40,
      disableClusteringAtZoom: 11,
      spiderfyOnMaxZoom: false,
      // Default markercluster coloring buckets by child count (small/medium/large
      // → green/yellow/orange). That's misleading here: a cluster of 100 healthy
      // FortiGates would show orange. Roll up the worst monitor health among
      // children instead so the cluster matches the dot colors it represents.
      iconCreateFunction: clusterIcon,
    });
    map.addLayer(markerCluster);

    attachRightClickPan();
  }

  // Right-click drag pans the map. Useful when left-click is captured by
  // another tool (e.g. drawing a region polygon with leaflet-draw — the
  // first vertex placement would otherwise start a polygon you can't abort).
  // Active everywhere on the map page; suppresses the context menu inside
  // the map container only.
  function attachRightClickPan() {
    var container = map.getContainer();
    var state = { active: false, lastX: 0, lastY: 0 };
    container.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    container.addEventListener("mousedown", function (e) {
      if (e.button !== 2) return;
      state.active = true;
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      container.style.cursor = "grabbing";
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!state.active) return;
      var dx = e.clientX - state.lastX;
      var dy = e.clientY - state.lastY;
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      map.panBy([-dx, -dy], { animate: false });
    });
    window.addEventListener("mouseup", function (e) {
      if (e.button !== 2 || !state.active) return;
      state.active = false;
      container.style.cursor = "";
    });
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
    var sawDepDown = false;
    var worst = "up"; // up < degraded < down
    for (var i = 0; i < children.length; i++) {
      var s = children[i]._site;
      if (!s || !s.monitored) continue;
      sawMonitored = true;
      if (s.monitorHealth === "down") { worst = "down"; break; }
      if (s.monitorHealth === "degraded" && worst !== "down") worst = "degraded";
      if (s.dependencySuppressed && s.monitorHealth !== "down") sawDepDown = true;
    }
    // Probe-down/degraded wins over dep-down — those are real failures we
    // observed directly. A cluster where every monitored child is healthy
    // but some are dep-down rolls up to dep-down.
    var cls;
    if (!sawMonitored)               cls = "monitor-unmonitored";
    else if (worst !== "up")         cls = "monitor-" + worst;
    else if (sawDepDown)             cls = "monitor-dep-down";
    else                             cls = "monitor-up";
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

    // If the operator landed here from a global-search hit, the URL hash
    // tells us what to do:
    //   #site=<assetId>                                — pan to marker
    //   #site=<assetId>&topology=1                     — pan + open topology
    //   #site=<assetId>&topology=1&q=<focusQuery>      — pan + open topology
    //                                                    + auto-search the
    //                                                    modal to highlight
    //                                                    a specific endpoint
    // Defer one frame so fitBounds completes before the override.
    var hash = window.location.hash || "";
    if (hash.startsWith("#site=")) {
      var params = {};
      hash.slice(1).split("&").forEach(function (kv) {
        var idx = kv.indexOf("=");
        if (idx <= 0) return;
        params[kv.slice(0, idx)] = decodeURIComponent(kv.slice(idx + 1));
      });
      var hashSiteId = params.site;
      requestAnimationFrame(function () {
        if (params.topology === "1" && hashSiteId) {
          window.polarisMapOpenSiteTopology(hashSiteId, params.q || null);
        } else if (hashSiteId) {
          window.polarisMapPanToAsset(hashSiteId);
        }
      });
    }
  }

  function monitorClass(site) {
    if (!site.monitored) return "monitor-unmonitored";
    // Dependency suppression takes precedence over the probe-derived health
    // when the asset's own probe is succeeding through a redundant path
    // (suppressed but health still "up"). When the probe itself shows
    // "down", that's the real state and we render red — see assetMonitorBadge
    // for the matching priority on the assets list.
    if (site.dependencySuppressed && site.monitorHealth !== "down") return "monitor-dep-down";
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
    if (site.dependencySuppressed && site.monitorHealth !== "down") {
      var layerHint = (site.dependencyLayer != null) ? " (Layer " + site.dependencyLayer + ")" : "";
      return "Dependency down — upstream parent is offline" + layerHint;
    }
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

  // ─── Hooks for the global app-wide search ─────────────────────────────────
  // The global search bar in the page header (see app.js _searchTargetFor)
  // covers FortiGate hostname/serial lookup AND endpoint discovery hits as
  // part of its asset results. These hooks let the dropdown drive the map
  // page in place — pan-to-marker, optionally open the topology modal,
  // optionally highlight a specific endpoint via the modal's site-scoped
  // search. All return true on success so the caller can fall back to a
  // page navigation when the asset isn't on this map.
  window.polarisMapPanToAsset = function (assetId) {
    if (!assetId) return false;
    var site = siteCache.find(function (s) { return s.id === assetId; });
    if (!site) return false;
    focusSite(site);
    setStatus('Showing "' + (site.hostname || site.id) + '"');
    return true;
  };

  // Pan to a site, then open its topology modal — like clicking the
  // marker. When focusQuery is set (asset hostname / IP / MAC), the
  // topology modal's site-scoped search runs after load to pulse the
  // matching switch and let the operator see where that endpoint
  // plugs in.
  window.polarisMapOpenSiteTopology = function (siteId, focusQuery) {
    if (!siteId) return false;
    var site = siteCache.find(function (s) { return s.id === siteId; });
    if (!site) return false;
    focusSite(site);
    setStatus('Showing "' + (site.hostname || site.id) + '"');
    // Slight delay so the marker pan-and-zoom animation has started
    // before the modal opens — feels like one continuous gesture.
    setTimeout(function () {
      openTopology(site.id, site.hostname || "");
      if (focusQuery) {
        // The topology modal builds its search async. Wait for the
        // input to exist + the topology data to load before populating
        // it. Bounded retry loop keeps this from hanging.
        var tries = 0;
        var iv = setInterval(async function () {
          tries++;
          var input = document.getElementById("topology-search-input");
          if (input && topoState.data) {
            input.value = focusQuery;
            await runTopologySearch(focusQuery, true);
            clearInterval(iv);
          } else if (tries > 40) { // ~4s max
            clearInterval(iv);
          }
        }, 100);
      }
    }, 400);
    return true;
  };

  // ─── Topology modal ───────────────────────────────────────────────────────
  function wireModal() {
    var overlay = document.getElementById("topology-overlay");
    var closeBtn = document.getElementById("topology-close");
    var screenshotBtn = document.getElementById("topology-screenshot");
    var fullscreenBtn = document.getElementById("topology-fullscreen");
    var refreshBtn = document.getElementById("topology-refresh");
    var resetBtn = document.getElementById("topology-reset-layout");
    var legendBtn = document.getElementById("topology-legend");
    var legendCloseBtn = document.getElementById("topology-legend-close");
    var showFullBtn = document.getElementById("topology-show-full");
    var searchInput = document.getElementById("topology-search-input");
    closeBtn.addEventListener("click", closeTopology);
    // Header camera = whole-modal (map + details) screenshot. The map-only
    // screenshot lives on the floating button inside the map area.
    if (screenshotBtn) screenshotBtn.addEventListener("click", screenshotTopologyModal);
    if (fullscreenBtn) fullscreenBtn.addEventListener("click", toggleFullscreenTopology);
    if (refreshBtn) refreshBtn.addEventListener("click", refreshTopology);
    if (resetBtn) resetBtn.addEventListener("click", resetTopologyLayout);
    if (legendBtn) legendBtn.addEventListener("click", toggleTopologyLegend);
    if (legendCloseBtn) legendCloseBtn.addEventListener("click", function () { setLegendVisible(false); });
    if (showFullBtn) showFullBtn.addEventListener("click", clearConnectionPathOverlay);
    if (searchInput) wireTopologySearch(searchInput);
    wireLegendDrag();
    // Restore legend visibility on first open per page load so operators
    // who left it visible see it again the next time they pop the modal.
    renderTopologyLegend();
    // Intercept clicks on asset links in the topology right-bar so they open
    // the asset details slide-over instead of navigating away to assets.html.
    var infoPanel = document.getElementById("topology-info");
    if (infoPanel) {
      infoPanel.addEventListener("click", function (e) {
        var link = e.target.closest("a[href]");
        if (!link) return;
        var id = _assetIdFromTopoHref(link.getAttribute("href"));
        if (!id) return;
        e.preventDefault();
        openViewModal(id);
      });
    }
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        // Shared escalating flash + bloom (defined in app.js, loaded first).
        if (typeof flashModalCloseBtn === "function") flashModalCloseBtn(closeBtn);
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

  // Whole-modal screenshot: the cytoscape map (cy.png) on the left, the info
  // panel rendered as text on the right, titled with the site. The map is a
  // canvas and the info panel is HTML, so we composite them onto one canvas
  // rather than rasterizing the live DOM (no html2canvas dependency).
  function screenshotTopologyModal() {
    if (!cyInstance) {
      if (typeof showToast === "function") showToast("Topology not loaded", "error");
      return;
    }
    var rootCs = getComputedStyle(document.documentElement);
    var pick = function (n, f) { var v = rootCs.getPropertyValue(n).trim(); return v || f; };
    var bg = pick("--color-bg-primary", pick("--color-surface", "#ffffff"));
    var uri = cyInstance.png({ output: "base64uri", scale: 2, full: true, bg: bg });
    var mapImg = new Image();
    mapImg.onload = function () { _composeTopologyModalCanvas(mapImg, pick); };
    mapImg.onerror = function () {
      if (typeof showToast === "function") showToast("Screenshot failed", "error");
    };
    mapImg.src = uri;
  }

  // Extract the topology info-panel (#topology-info) into ordered blocks:
  //   { type: 'title',   text }            the <h4> FortiGate name
  //   { type: 'kv',      label, value }    the top .detail-row pairs
  //   { type: 'heading', text }            each .topology-section <h5>
  //   { type: 'item',    primary, meta, indent }  each <li> (expanded endpoint
  //                                        sub-lists are included, indented)
  function _extractTopologyInfoBlocks(infoEl) {
    var blocks = [];
    if (!infoEl) return blocks;
    var h4 = infoEl.querySelector("h4");
    if (h4) blocks.push({ type: "title", text: (h4.textContent || "").trim() });
    infoEl.querySelectorAll(":scope > .detail-row").forEach(function (dr) {
      var l = dr.querySelector(".label");
      var v = dr.querySelector(".value");
      blocks.push({
        type: "kv",
        label: (l ? l.textContent : "").trim(),
        value: (v ? v.textContent : "").trim(),
      });
    });
    function liText(li) {
      // Primary label = li text minus the trailing .meta span and any nested list.
      var clone = li.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll(".meta, ul, details"), function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      return (clone.textContent || "").replace(/\s+/g, " ").trim();
    }
    infoEl.querySelectorAll(".topology-section").forEach(function (sec) {
      var h5 = sec.querySelector("h5");
      if (h5) blocks.push({ type: "heading", text: (h5.textContent || "").trim() });
      var topList = sec.querySelector(":scope > ul");
      if (!topList) return;
      Array.prototype.forEach.call(topList.children, function (li) {
        if (li.tagName !== "LI") return;
        var details = li.querySelector(":scope > details");
        if (details) {
          var summary = details.querySelector("summary");
          blocks.push({ type: "item", primary: summary ? (summary.textContent || "").trim() : "", meta: "", indent: 0 });
          if (details.hasAttribute("open")) {
            var subList = details.querySelector("ul");
            if (subList) {
              Array.prototype.forEach.call(subList.children, function (sub) {
                if (sub.tagName !== "LI") return;
                var subMeta = sub.querySelector(":scope > .meta");
                blocks.push({ type: "item", primary: liText(sub), meta: subMeta ? (subMeta.textContent || "").trim() : "", indent: 1 });
              });
            }
          }
          return;
        }
        var meta = li.querySelector(":scope > .meta");
        blocks.push({ type: "item", primary: liText(li), meta: meta ? (meta.textContent || "").trim() : "", indent: 0 });
      });
    });
    return blocks;
  }

  function _composeTopologyModalCanvas(mapImg, pick) {
    var bgPrimary = pick("--color-bg-primary", "#ffffff");
    var bgSurface = pick("--color-surface", "#f5f5f5");
    var clrBorder = pick("--color-border", "#e0e0e0");
    var clrText   = pick("--color-text-primary", "#111");
    var clrMuted  = pick("--color-text-tertiary", "#888");
    var accent    = pick("--color-accent", "#4fc3f7");

    var fontFamily = "system-ui,-apple-system,sans-serif";
    var scale = 2;
    var pad = 20;
    var gap = 24;
    var titleH = 40;
    var infoColW = 340;
    var lineH = 19;

    var titleEl = document.getElementById("topology-title");
    var title = titleEl ? (titleEl.textContent || "").trim() : "Site topology";

    var blocks = _extractTopologyInfoBlocks(document.getElementById("topology-info"));

    // cy.png is rendered at 2x; treat its logical size as half so text drawn at
    // 2x stays crisp alongside a near-native map.
    var mapLogW = mapImg.width / 2;
    var mapLogH = mapImg.height / 2;
    var maxMapW = 1100;
    var mapDrawW = Math.min(mapLogW, maxMapW);
    var mapDrawH = mapLogW ? mapLogH * (mapDrawW / mapLogW) : mapLogH;

    var measureCtx = document.createElement("canvas").getContext("2d");
    function fit(text, maxW, font) {
      measureCtx.font = font;
      var t = String(text == null ? "" : text);
      while (measureCtx.measureText(t).width > maxW && t.length > 3) t = t.slice(0, -4) + "…";
      return t;
    }

    // Measure info column height.
    var infoH = 0;
    blocks.forEach(function (b) {
      if (b.type === "title") infoH += 26;
      else if (b.type === "heading") infoH += 28;
      else infoH += lineH;
    });

    var contentH = Math.max(mapDrawH, infoH);
    var w = pad + mapDrawW + gap + infoColW + pad;
    var h = titleH + contentH + pad;

    var canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    var ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = bgPrimary;
    ctx.fillRect(0, 0, w, h);

    // Title.
    ctx.fillStyle = clrText;
    ctx.font = "bold 16px " + fontFamily;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fit(title, w - pad * 2, "bold 16px " + fontFamily), pad, 26);

    // Map.
    ctx.drawImage(mapImg, pad, titleH, mapDrawW, mapDrawH);
    ctx.strokeStyle = clrBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + 0.5, titleH + 0.5, mapDrawW - 1, mapDrawH - 1);

    // Info column.
    var ix = pad + mapDrawW + gap;
    var iw = infoColW;
    var y = titleH;
    blocks.forEach(function (b) {
      if (b.type === "title") {
        ctx.fillStyle = accent;
        ctx.font = "bold 14px " + fontFamily;
        ctx.fillText(fit(b.text, iw, "bold 14px " + fontFamily), ix, y + 16);
        y += 26;
        return;
      }
      if (b.type === "heading") {
        y += 8;
        ctx.fillStyle = clrMuted;
        ctx.font = "600 10px " + fontFamily;
        ctx.fillText(fit(b.text.toUpperCase(), iw, "600 10px " + fontFamily), ix, y + 12);
        y += 20;
        return;
      }
      if (b.type === "kv") {
        ctx.fillStyle = clrMuted;
        ctx.font = "11px " + fontFamily;
        ctx.fillText(fit(b.label, 110, "11px " + fontFamily), ix, y + 14);
        ctx.fillStyle = clrText;
        ctx.font = "12px " + fontFamily;
        ctx.textAlign = "right";
        ctx.fillText(fit(b.value || "—", iw - 120, "12px " + fontFamily), ix + iw, y + 14);
        ctx.textAlign = "left";
        y += lineH;
        return;
      }
      // item
      var indentX = ix + (b.indent ? 14 : 0);
      ctx.fillStyle = clrText;
      ctx.font = "12px " + fontFamily;
      measureCtx.font = "11px " + fontFamily;
      var metaW = b.meta ? measureCtx.measureText(b.meta).width + 12 : 0;
      ctx.fillText(fit(b.primary, iw - (indentX - ix) - metaW, "12px " + fontFamily), indentX, y + 14);
      if (b.meta) {
        ctx.fillStyle = clrMuted;
        ctx.font = "11px " + fontFamily;
        ctx.textAlign = "right";
        ctx.fillText(fit(b.meta, iw - 60, "11px " + fontFamily), ix + iw, y + 14);
        ctx.textAlign = "left";
      }
      y += lineH;
    });

    canvas.toBlob(function (blob) {
      if (!blob) { if (typeof showToast === "function") showToast("Screenshot failed", "error"); return; }
      if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
        if (typeof showToast === "function") showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
        return;
      }
      navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(function () {
        if (typeof showToast === "function") showToast("Topology view copied to clipboard");
      }).catch(function () {
        if (typeof showToast === "function") showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
      });
    }, "image/png");
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
    topoState.activeView = "flat";
    topoState.floorViews = [];

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

  // Drop the operator's saved node positions for this site and re-run the
  // column layout against the cached topology data. Used when manual drags
  // have produced a layout the operator wants to abandon (e.g. inherited
  // positions from before a column-spacing change).
  function resetTopologyLayout() {
    if (!topoState.siteId || !topoState.data) return;
    // Scoped to the ACTIVE view — resetting a floor view's drags leaves the
    // Flat layout (and every other floor's) untouched.
    try { localStorage.removeItem(_positionsStorageKey(topoState.siteId)); }
    catch (e) { /* quota / private mode — proceed with re-render anyway */ }
    renderTopologyGraph(topoState.data);
    if (typeof showToast === "function") showToast("Layout reset");
  }

  // ── Legend overlay ────────────────────────────────────────────────────────
  function _readLegendPrefs() {
    try {
      var raw = localStorage.getItem(LEGEND_STORAGE_KEY);
      if (!raw) return { visible: false, x: null, y: null };
      var p = JSON.parse(raw);
      return { visible: !!p.visible, x: (typeof p.x === "number" ? p.x : null), y: (typeof p.y === "number" ? p.y : null) };
    } catch (e) { return { visible: false, x: null, y: null }; }
  }
  function _writeLegendPrefs(prefs) {
    try { localStorage.setItem(LEGEND_STORAGE_KEY, JSON.stringify(prefs)); } catch (e) {}
  }
  function setLegendVisible(visible) {
    var prefs = _readLegendPrefs();
    prefs.visible = !!visible;
    _writeLegendPrefs(prefs);
    renderTopologyLegend();
  }
  function toggleTopologyLegend() {
    setLegendVisible(!_readLegendPrefs().visible);
  }
  function renderTopologyLegend() {
    var el = document.getElementById("topology-legend-overlay");
    if (!el) return;
    var prefs = _readLegendPrefs();
    if (!prefs.visible) { el.hidden = true; return; }
    var spec = (window.PolarisTopologyRender && window.PolarisTopologyRender.topologyLegendSpec)
      ? window.PolarisTopologyRender.topologyLegendSpec() : null;
    if (!spec) { el.hidden = true; return; }
    var body = document.getElementById("topology-legend-body");
    if (body && !body.dataset.rendered) {
      body.innerHTML = _buildLegendHTML(spec);
      body.dataset.rendered = "1";
    }
    el.hidden = false;
    // Restore saved position (clamped to the graph container so a smaller
    // viewport doesn't strand the panel off-screen). Default = top-left
    // inset, the CSS-anchored position.
    var graph = document.getElementById("topology-graph");
    if (graph && prefs.x !== null && prefs.y !== null) {
      var maxX = Math.max(0, graph.clientWidth  - el.offsetWidth  - 4);
      var maxY = Math.max(0, graph.clientHeight - el.offsetHeight - 4);
      var x = Math.min(Math.max(0, prefs.x), maxX);
      var y = Math.min(Math.max(0, prefs.y), maxY);
      el.style.left = x + "px";
      el.style.top  = y + "px";
    } else {
      el.style.left = ""; el.style.top = "";
    }
  }
  function _buildLegendHTML(spec) {
    function nodeSwatch(row) {
      var size = row.size === "lg" ? 22 : (row.size === "sm" ? 14 : 18);
      var border = row.border ? row.border : "rgba(255,255,255,0.85)";
      var borderStyle = row.borderStyle === "dashed" ? "dashed" : "solid";
      var fill = row.fill === "data(nodeColor)" ? window.PolarisTopologyRender.HEALTH_NODE_COLORS.up : row.fill;
      var shape = "";
      if (row.kind === "diamond") {
        shape = '<div style="width:' + size + 'px;height:' + size + 'px;background:' + fill +
                ';border:2px ' + borderStyle + ' ' + border + ';transform:rotate(45deg)"></div>';
      } else if (row.kind === "round-rectangle") {
        shape = '<div style="width:' + (size + 8) + 'px;height:' + size + 'px;background:' + fill +
                ';border:2px ' + borderStyle + ' ' + border + ';border-radius:4px"></div>';
      } else {
        shape = '<div style="width:' + size + 'px;height:' + size + 'px;background:' + fill +
                ';border:2px ' + borderStyle + ' ' + border + ';border-radius:50%"></div>';
      }
      return '<span class="topology-legend-swatch">' + shape + '</span>';
    }
    function edgeSwatch(row) {
      var dash = row.style === "dashed" ? "4 3" : "0";
      return '<span class="topology-legend-swatch">' +
        '<svg width="28" height="12" viewBox="0 0 28 12" aria-hidden="true">' +
          '<line x1="2" y1="6" x2="26" y2="6" stroke="' + row.color +
          '" stroke-width="2.4" stroke-dasharray="' + dash + '" stroke-linecap="round"/>' +
        '</svg></span>';
    }
    function healthSwatch(row) {
      return '<span class="topology-legend-swatch">' +
        '<div style="width:14px;height:14px;background:' + row.color +
        ';border-radius:50%;border:2px solid rgba(255,255,255,0.85)"></div></span>';
    }
    function row(swatchHtml, label, desc) {
      var html = '<div class="topology-legend-row">' + swatchHtml +
                 '<span class="topology-legend-label">' + escapeHtml(label) + '</span></div>';
      if (desc) html += '<div class="topology-legend-desc">' + escapeHtml(desc) + '</div>';
      return html;
    }
    // Location grouping hull swatches — every level is a rounded rectangle
    // with a FIXED per-level color + solid/dashed border, mirroring
    // LOC_GROUP_KINDS in topology-render.js.
    function locationSwatch(rowSpec) {
      var color = rowSpec.color || "#4fc3f7";
      var borderStyle = rowSpec.style === "dashed" ? "dashed" : "solid";
      var shape = '<div style="width:22px;height:16px;background:' + color + '22;border:2px ' +
        borderStyle + ' ' + color + ';border-radius:4px"></div>';
      return '<span class="topology-legend-swatch">' + shape + '</span>';
    }
    var parts = [];
    parts.push('<div class="topology-legend-section"><div class="topology-legend-section-title">Nodes</div>');
    spec.nodes.forEach(function (n) { parts.push(row(nodeSwatch(n), n.label, n.desc)); });
    parts.push('</div>');
    parts.push('<div class="topology-legend-section"><div class="topology-legend-section-title">Monitor health</div>');
    spec.health.forEach(function (h) { parts.push(row(healthSwatch(h), h.label)); });
    parts.push('</div>');
    parts.push('<div class="topology-legend-section"><div class="topology-legend-section-title">Edges</div>');
    spec.edges.forEach(function (e) { parts.push(row(edgeSwatch(e), e.label, e.desc)); });
    parts.push('</div>');
    if (spec.locations) {
      parts.push('<div class="topology-legend-section"><div class="topology-legend-section-title">Location groups</div>');
      spec.locations.forEach(function (l) { parts.push(row(locationSwatch(l), l.label, l.desc)); });
      parts.push('</div>');
    }
    return parts.join("");
  }
  // Header drag — pointer-events-based so it works on touch laptops too.
  // Coordinates are stored relative to the graph container so resizing the
  // browser between sessions never strands the legend off-screen.
  function wireLegendDrag() {
    var el = document.getElementById("topology-legend-overlay");
    var header = el && el.querySelector(".topology-legend-header");
    if (!header) return;
    var dragging = false, dx = 0, dy = 0;
    header.addEventListener("pointerdown", function (e) {
      // Ignore drags initiated on the close button.
      if (e.target.closest("button")) return;
      var graph = document.getElementById("topology-graph");
      if (!graph) return;
      var rect = el.getBoundingClientRect();
      var graphRect = graph.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      dragging = true;
      header.setPointerCapture(e.pointerId);
      e.preventDefault();
      function onMove(ev) {
        if (!dragging) return;
        var x = ev.clientX - graphRect.left - dx;
        var y = ev.clientY - graphRect.top  - dy;
        var maxX = Math.max(0, graph.clientWidth  - el.offsetWidth  - 4);
        var maxY = Math.max(0, graph.clientHeight - el.offsetHeight - 4);
        x = Math.min(Math.max(0, x), maxX);
        y = Math.min(Math.max(0, y), maxY);
        el.style.left = x + "px";
        el.style.top  = y + "px";
      }
      function onUp() {
        if (!dragging) return;
        dragging = false;
        try { header.releasePointerCapture(e.pointerId); } catch (err) {}
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        var prefs = _readLegendPrefs();
        prefs.x = parseFloat(el.style.left) || 0;
        prefs.y = parseFloat(el.style.top)  || 0;
        _writeLegendPrefs(prefs);
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  // ── Position persistence ───────────────────────────────────────────────────
  // localStorage-backed per-site node positions. Keyed by site id (the Flat
  // view keeps the legacy bare key for back-compat; floor views append
  // ":<viewKey>" so each view owns its manual layout); value is a map of
  // nodeId → {x, y}. Persisted browser-side only — operator-owned mental
  // layout, not shared across users. Stale entries (nodes that no longer
  // appear in the topology) are silently dropped on next save.
  function _positionsStorageKey(siteId) {
    var suffix = topoState.activeView && topoState.activeView !== "flat" ? ":" + topoState.activeView : "";
    return POSITION_STORAGE_PREFIX + siteId + suffix;
  }
  function saveNodePositions(siteId) {
    if (!cyInstance || !siteId) return;
    var out = {};
    cyInstance.nodes().forEach(function (n) {
      // Synthetic overlays (location hulls, floor portals) are derived every
      // render — persisting them would pin stale geometry onto real node ids.
      if (n.data("isLocGroup") || n.data("isPortal")) return;
      var p = n.position();
      if (p && typeof p.x === "number" && typeof p.y === "number") {
        out[n.id()] = { x: p.x, y: p.y };
      }
    });
    try { localStorage.setItem(_positionsStorageKey(siteId), JSON.stringify(out)); }
    catch (e) { /* quota / private mode — silently skip */ }
  }
  function loadNodePositions(siteId) {
    if (!siteId) return null;
    try {
      var raw = localStorage.getItem(_positionsStorageKey(siteId));
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

  async function runTopologySearch(q, autoSelect) {
    if (!topoState.siteId) return;
    try {
      var resp = await api.map.topologySearch(topoState.siteId, q);
      topoSuggestState.items = (resp && resp.results) || [];
      topoSuggestState.index = topoSuggestState.items.length > 0 ? 0 : -1;
      topoSuggestState.open = true;
      paintTopologySearchResults();
      if (autoSelect && topoSuggestState.items.length > 0) {
        handleTopologySearchPick(topoSuggestState.items[0]);
      }
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

  // When the operator picks an endpoint from the topology search:
  //   1. Pulse the matched endpoint's switch on the graph.
  //   2. Fetch the asset's connection path (GET /assets/:id/connection-path)
  //      and overlay the endpoint as a synthetic Cytoscape node connected to
  //      its switch, dimming everything off the path so the chain stands out
  //      visually. The "Show full site" button appears in the modal header
  //      to clear the dim and reveal the rest of the graph.
  // (Asset details aren't auto-opened in the slide-over for this path —
  // operators usually want to see the topology answer first; the asset
  // is reachable from the right-side info panel rows.)
  async function handleTopologySearchPick(item) {
    closeTopologySearchResults();
    if (cyInstance && item.switchId) {
      var node = cyInstance.getElementById(item.switchId);
      if (node && node.length > 0) {
        cyInstance.animate({ center: { eles: node }, zoom: 1.4, duration: 350 });
        node.addClass("topology-pulse");
        setTimeout(function () { try { node.removeClass("topology-pulse"); } catch (e) {} }, 1500);
      }
    }
    if (!item.id || !cyInstance) return;
    try {
      var path = await api.assets.connectionPath(item.id);
      if (path) applyConnectionPathOverlay(path);
    } catch (e) {
      // Best-effort overlay — fall through to the plain pulse on failure.
    }
  }

  // Overlay a focused endpoint→firewall connection path on top of the live
  // Cytoscape graph. Adds a synthetic endpoint node + edge to the first
  // switch hop (when the endpoint isn't already a graph node), then dims
  // every element NOT on the path. Clearing is via the "Show full site"
  // button in the header or by tapping any non-path node.
  function applyConnectionPathOverlay(path) {
    if (!cyInstance || !path || !path.asset || !Array.isArray(path.hops) || path.hops.length === 0) return;
    // Sweep any leftover overlay from a previous search before drawing the new one.
    clearConnectionPathOverlay();
    var ep = path.asset;
    var leaf = path.hops[0];
    var nextHop = path.hops[1];
    var syntheticEdgeId = null;

    // Add the endpoint as a synthetic node when the live topology graph
    // doesn't already include it (which is almost always — endpoints don't
    // appear as Cytoscape nodes in the standard topology response, only in
    // the right-side panel). Switches / APs / firewalls already have nodes,
    // so we skip the synthesis in those cases.
    var alreadyOnGraph = cyInstance.getElementById(ep.id).length > 0;
    if (!alreadyOnGraph && leaf.kind === "endpoint") {
      cyInstance.add({
        group: "nodes",
        data: {
          id: ep.id,
          label: ep.hostname || ep.ipAddress || "endpoint",
          role: "endpoint",
          nodeColor: endpointNodeColor(leaf),
          synthetic: 1,
        },
      });
      // Edge from the endpoint to its first switch hop, labeled with the
      // switch port the endpoint plugs into (parsed from lastSeenSwitch).
      if (nextHop && cyInstance.getElementById(nextHop.id).length > 0) {
        syntheticEdgeId = "ep-edge-" + ep.id;
        cyInstance.add({
          group: "edges",
          data: {
            id: syntheticEdgeId,
            source: ep.id,
            target: nextHop.id,
            label: nextHop.endpointPort ? "port " + nextHop.endpointPort : "",
            synthetic: 1,
          },
        });
      }
    }

    // Build the set of path node ids and resolve each into Cytoscape elements.
    var pathNodeIds = path.hops.map(function (h) { return h.id; });
    var pathElements = cyInstance.collection();
    pathNodeIds.forEach(function (id) {
      var n = cyInstance.getElementById(id);
      if (n.length > 0) pathElements = pathElements.union(n);
    });
    if (syntheticEdgeId) {
      var syn = cyInstance.getElementById(syntheticEdgeId);
      if (syn.length > 0) pathElements = pathElements.union(syn);
    }
    // Edges between two path nodes (controller / interfaceEdges / lldpEdges
    // wiring the switches and FortiGate together) are part of the path too.
    cyInstance.edges().forEach(function (e) {
      var s = e.data("source");
      var t = e.data("target");
      if (pathNodeIds.indexOf(s) !== -1 && pathNodeIds.indexOf(t) !== -1) {
        pathElements = pathElements.union(e);
      }
    });

    cyInstance.elements().not(pathElements).addClass("dimmed");

    // Snapshot the path nodes' original positions, then lay the path out
    // left-to-right along the column grid: each real node keeps its solver
    // column (x) and is flattened onto a single row (y=0) so the chain reads
    // firewall → switch → AP → endpoint. The synthetic endpoint sits in its
    // ODD column — one column right of the access switch/AP it plugs into
    // (hops[1]) — matching the base layout's even-infra / odd-endpoint grid.
    // The base layout spaces nodes across the whole site, so without this the
    // dimmed path could land scattered across a huge canvas. Positions are
    // restored on overlay clear so the persisted layout is untouched.
    var savedPositions = {};
    pathNodeIds.forEach(function (id) {
      var n = cyInstance.getElementById(id);
      if (n.length > 0) {
        var p = n.position();
        if (p && typeof p.x === "number" && typeof p.y === "number") {
          savedPositions[id] = { x: p.x, y: p.y };
        }
        // Flatten every path node onto one row; real nodes already sit at
        // their column x from the base layout. A synthetic endpoint (added
        // above with no real column) is repositioned explicitly below.
        n.position("y", 0);
      }
    });
    // Synthetic endpoint → odd column, one column right of its first real hop
    // (hops[1]). Skip when the searched node is a real infra node (no synthetic
    // node was added) so we don't yank a switch/AP out of its own column.
    var epNode = cyInstance.getElementById(ep.id);
    if (nextHop && epNode.length > 0 && epNode.data("synthetic")) {
      var hopNode = cyInstance.getElementById(nextHop.id);
      if (hopNode.length > 0) {
        // Place the endpoint one column further from the firewall than its
        // switch — right for a verified switch (positive column), left for a
        // FortiLink-fallback switch (negative column → endpoint lands in the
        // odd col -3). Firewall itself (x≈0) defaults to the right.
        var hopX = hopNode.position().x;
        var dir = hopX < 0 ? -1 : 1;
        epNode.position({ x: hopX + dir * TOPO_COL_SPACING, y: 0 });
      }
    }

    topoState.pathOverlay = {
      endpointId: ep.id,
      edgeId: syntheticEdgeId,
      savedPositions: savedPositions,
    };

    var btn = document.getElementById("topology-show-full");
    if (btn) btn.hidden = false;

    try {
      cyInstance.animate({ fit: { eles: pathElements, padding: 80 }, duration: 350 });
    } catch (e) { /* fit may fail if pathElements is empty / single node */ }
  }

  // Remove the dim class and tear down any synthetic endpoint node + edge
  // we added in applyConnectionPathOverlay. Idempotent.
  function clearConnectionPathOverlay() {
    if (!cyInstance) return;
    cyInstance.elements().removeClass("dimmed");
    var overlay = topoState.pathOverlay;
    if (overlay) {
      // Restore original positions BEFORE removing synthetic nodes so the
      // operator's previous layout (whether persisted or just from the
      // current dagre run) snaps back into place when they "Show full site".
      if (overlay.savedPositions) {
        Object.keys(overlay.savedPositions).forEach(function (id) {
          var n = cyInstance.getElementById(id);
          if (n.length > 0) n.position(overlay.savedPositions[id]);
        });
      }
      if (overlay.edgeId) {
        var edge = cyInstance.getElementById(overlay.edgeId);
        try { if (edge.length > 0) cyInstance.remove(edge); } catch (e) {}
      }
      // Only remove the endpoint node when it was synthetic (added by us).
      // Tagged via data.synthetic = 1 so we don't accidentally rip out a
      // pre-existing node (e.g. when the operator searched a switch hostname
      // — that case never adds a synthetic node, but be defensive).
      var ep = cyInstance.getElementById(overlay.endpointId);
      if (ep.length > 0 && ep.data("synthetic")) {
        try { cyInstance.remove(ep); } catch (e) {}
      }
      topoState.pathOverlay = null;
    }
    var btn = document.getElementById("topology-show-full");
    if (btn) btn.hidden = true;
  }

  // Color the synthetic endpoint node by its monitor state — same five-state
  // palette the firewall / switch / AP nodes use, so the path reads as a
  // single visual scheme.
  function endpointNodeColor(hop) {
    // Shared node-health palette lives in topology-render.js (loaded first);
    // "recovering" (#0288d1) is endpoint-only and stays a local literal.
    var P = window.PolarisTopologyRender.HEALTH_NODE_COLORS;
    if (!hop || !hop.monitored) return P.unmonitored;
    switch (hop.monitorStatus) {
      case "up":         return P.up;
      case "warning":    return P.degraded;
      case "down":       return P.down;
      case "recovering": return "#0288d1";
      default:           return P.unknown;
    }
  }

  function closeTopologySearchResults() {
    topoSuggestState.open = false;
    topoSuggestState.items = [];
    topoSuggestState.index = -1;
    var box = document.getElementById("topology-search-results");
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  function closeTopology() {
    // If the connection-path overlay is active, restore the operator's
    // original node positions BEFORE saving — otherwise the temporary tight
    // chain would replace their persisted layout on close.
    if (topoState.pathOverlay && topoState.pathOverlay.savedPositions && cyInstance) {
      var saved = topoState.pathOverlay.savedPositions;
      Object.keys(saved).forEach(function (id) {
        var n = cyInstance.getElementById(id);
        if (n.length > 0) n.position(saved[id]);
      });
    }
    // Persist current node positions before tear-down so reopening the
    // same site restores the operator's manual layout.
    if (topoState.siteId && cyInstance) saveNodePositions(topoState.siteId);
    closeTopologySearchResults();
    topoState.siteId = null;
    topoState.hostname = null;
    topoState.data = null;
    topoState.pathOverlay = null;
    var showFullBtn = document.getElementById("topology-show-full");
    if (showFullBtn) showFullBtn.hidden = true;
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

  // Delegates to PolarisTopologyRender so desktop and mobile share one
  // color scheme. Kept as a local alias for the existing call sites.
  function fortigateNodeColor(fg) {
    return window.PolarisTopologyRender.fortinetNodeColor(fg);
  }

  function renderTopologyGraph(data) {
    // Refresh / reset rebuilds the cyInstance from scratch — any synthetic
    // overlay nodes / edges are gone, so reset the state and hide the
    // "Show full site" button before drawing the new graph. Don't call
    // clearConnectionPathOverlay() here because cyInstance is about to be
    // torn down regardless.
    topoState.pathOverlay = null;
    var showFullBtn = document.getElementById("topology-show-full");
    if (showFullBtn) showFullBtn.hidden = true;

    // Element + stylesheet construction is shared with the mobile topology
    // surface — see public/js/topology-render.js. Desktop opts into the
    // endpoint-overlay styles because the connection-path search dims
    // off-path elements and adds a synthetic round-rectangle endpoint node.
    var elements = window.PolarisTopologyRender.buildTopologyElements(data);

    // Does ANY device on this site carry a location code? Checked against the
    // unfiltered element set so the Locations chip stays available even when
    // every coded device's type is currently hidden.
    topoState.hasLocationCodes = elements.some(function (el) {
      var d = el && el.data;
      return !!(d && !d.source && (d.locB || d.locF || d.locR || d.locJb));
    });

    // Floor views present in this payload (empty unless some device carries
    // an f: code). Computed from the unfiltered set; if a refresh removed the
    // active view's floor, fall back to Flat rather than rendering nothing.
    topoState.floorViews = window.PolarisTopologyRender.computeFloorViews(elements);
    var isFloorView = topoState.activeView !== "flat";
    if (isFloorView && !topoState.floorViews.some(function (v) { return v.key === topoState.activeView; })) {
      topoState.activeView = "flat";
      isFloorView = false;
    }

    // Device-type visibility filter: drop nodes of hidden roles (and edges
    // touching them) BEFORE the column solver runs, so the layout recomputes
    // compactly for what's actually shown instead of leaving holes where the
    // hidden devices' rows were. Counts come from the UNFILTERED set so a
    // hidden type's chip stays available to re-show it. Two passes because
    // mesh edges can precede their target AP node in the element order.
    var hiddenRoles = _readHiddenRoles();
    var roleCounts = {};
    var visibleIds = {};
    elements.forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id || d.source) return; // edges handled below
      roleCounts[d.role] = (roleCounts[d.role] || 0) + 1;
      if (!hiddenRoles[d.role]) visibleIds[d.id] = true;
    });
    elements = elements.filter(function (el) {
      var d = el && el.data;
      if (!d) return false;
      if (d.source && d.target) return !!(visibleIds[d.source] && visibleIds[d.target]);
      return !!visibleIds[d.id];
    });

    // Floor view: partition down to the active (building, floor) pair — its
    // tagged devices + the FortiGate root + portal stubs where an edge
    // crosses to another floor. Runs after the type filter so a hidden
    // device type stays hidden in floor views too.
    if (isFloorView) {
      elements = window.PolarisTopologyRender.partitionElementsForFloor(elements, topoState.activeView);
    }

    // Topology graph follows the per-user MAP theme (not the global app
    // theme) so the toolbar toggle drives both the basemap and the
    // modal coherently.
    var theme = getMapTheme();

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

    // Construct cytoscape with the default no-op `preset` layout so we can
    // register the layoutstop listener BEFORE running dagre — otherwise the
    // layout can finish (and emit layoutstop) before `.one()` registers,
    // silently dropping the saved-position restore on reopen.
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
      style: window.PolarisTopologyRender.topologyStylesheet(theme, { includeEndpointOverlay: true }),
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

    // Deterministic column layout: Dijkstra-weighted depth from the firewall
    // places infra (firewall/switch/AP) on even columns and leaf nodes
    // (endpoints/wireless/ghosts/remote) on the odd column right of their
    // parent. Left-to-right here: depth → x, lane → y. Falls back to dagre
    // when there's no firewall root to anchor the solver.
    var columns = window.PolarisTopologyRender.computeTopologyColumns(elements);
    if (columns) {
      var positions = {};
      Object.keys(columns).forEach(function (id) {
        positions[id] = { x: columns[id].depth * TOPO_COL_SPACING, y: columns[id].lane * TOPO_ROW_SPACING };
      });
      cyInstance.layout({ name: "preset", positions: positions, fit: true, padding: 30 }).run();
    } else {
      cyInstance.layout({
        name: "dagre",
        rankDir: "LR",
        nodeSep: 30,
        rankSep: 160,
        fit: true,
        padding: 30,
      }).run();
    }

    // Persist node position on every drag-stop so a refresh / reopen
    // restores the operator's manual layout. Debounced via the timer
    // below so a long drag doesn't write per-tick.
    var saveTimer = null;
    cyInstance.on("dragfree", "node", function () {
      if (!topoState.siteId) return;
      // Suppress auto-save while the connection-path overlay is active —
      // the path nodes are sitting in a temporary tight-chain layout (not
      // their persisted positions), and any drag in that mode is in the
      // overlay's coordinate space. Letting it persist would clobber the
      // operator's saved layout.
      if (topoState.pathOverlay) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveNodePositions(topoState.siteId);
      }, 250);
    });

    // Single-click selects a node (Cytoscape's built-in selection highlight);
    // DOUBLE-click opens its asset details. Cytoscape has no native double-tap,
    // so we detect two taps on the same node within a short window. Resolves
    // the asset id from the node: firewall/switch/AP/endpoint use the node id
    // (which IS the asset id); cross-site remotes + matched wireless stations
    // carry it in `assetId`; LLDP ghosts and unmatched stations have no asset.
    function _openAssetForNode(node) {
      if (node.data("isPortal")) return; // floor portal — tap navigation, not an asset
      var role = node.data("role");
      if (role === "lldp") return; // ghost neighbor — no Polaris asset
      var assetId;
      if (role === "wireless-station" || role === "remote-asset") {
        assetId = node.data("assetId");
      } else {
        assetId = node.data("assetId") || node.id();
      }
      if (assetId) openViewModal(assetId);
    }
    var _lastNodeTap = { id: null, t: 0 };
    cyInstance.on("tap", "node", function (evt) {
      var node = evt.target;
      var id = node.id();
      var now = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
      if (_lastNodeTap.id === id && (now - _lastNodeTap.t) < 350) {
        _lastNodeTap = { id: null, t: 0 };
        _openAssetForNode(node);
        return;
      }
      _lastNodeTap = { id: id, t: now };
      // Single tap: selection highlight is handled by Cytoscape automatically.
    });

    // Auto-clear the connection-path dim if the operator taps any node
    // currently dimmed off-path — they're trying to navigate the rest of
    // the graph, so get out of their way without forcing them to hunt for
    // the "Show full site" button.
    cyInstance.on("tap", "node.dimmed", function () {
      if (topoState.pathOverlay) clearConnectionPathOverlay();
    });

    // Floor portal tap → jump to the remote device's floor view.
    cyInstance.on("tap", "node[isPortal]", function (evt) {
      var target = evt.target.data("targetView");
      if (target) _setTopologyView(target);
    });

    // Hover tooltip on edges — concise: the two devices, the interface on each
    // side, and a one-line connection kind. Works for every edge type
    // (controller / interface / LLDP / mesh / wireless).
    cyInstance.on("mouseover", "edge", function (evt) {
      var html = buildEdgeTooltipHtml(evt.target);
      if (!html) return;
      var orig = evt.originalEvent;
      var x = orig && typeof orig.clientX === "number" ? orig.clientX : 0;
      var y = orig && typeof orig.clientY === "number" ? orig.clientY : 0;
      showEdgeTooltip(html, x, y);
    });
    cyInstance.on("mousemove", "edge", function (evt) {
      // Track the cursor so the tooltip follows the edge as the operator
      // sweeps along it.
      var orig = evt.originalEvent;
      if (!orig) return;
      moveEdgeTooltip(orig.clientX, orig.clientY);
    });
    cyInstance.on("mouseout", "edge", function () { hideEdgeTooltip(); });

    // Location grouping hulls — drawn after the layout so bounding boxes
    // reflect final positions (the preset/dagre run + saved-position restore
    // above are synchronous), then re-fitted whenever any real node moves
    // (drag, path overlay snap-back). RAF-throttled: one refresh per frame no
    // matter how many nodes a batch reposition touches. In a floor view the
    // building/floor shapes are suppressed — the view itself IS the
    // building+floor, so only rooms + junction boxes stay useful.
    if (topoState.hasLocationCodes && _readShowLocations()) {
      window.PolarisTopologyRender.renderLocationGroups(
        cyInstance,
        isFloorView ? { suppressKinds: ["building", "floor"] } : undefined
      );
    }
    var locRefreshPending = false;
    cyInstance.on("position", "node[!isLocGroup]", function () {
      if (locRefreshPending) return;
      locRefreshPending = true;
      window.requestAnimationFrame(function () {
        locRefreshPending = false;
        if (cyInstance) window.PolarisTopologyRender.refreshLocationGroups(cyInstance);
      });
    });

    // Map-only screenshot button, overlaid at the top-right of the graph area.
    // (openTopology wipes #topology-graph's innerHTML and cytoscape re-mounts,
    // so it's re-added here on every render rather than living in static HTML.)
    _ensureTopologyMapShotButton();
    _renderTopologyTypeToggles(roleCounts, hiddenRoles);
    _renderTopologyFloorViews();
  }

  // ── Floor-view switcher ─────────────────────────────────────────────────
  // Chips at the top-left of the graph: "Flat" (whole site, default) plus one
  // per (building, floor) pair found in the payload. Rendered only when at
  // least one device carries an f: code — untagged fleets see no switcher.
  function _setTopologyView(key) {
    if (topoState.activeView === key) return;
    // Persist any manual drags under the OUTGOING view's key before switching.
    if (cyInstance && topoState.siteId && !topoState.pathOverlay) saveNodePositions(topoState.siteId);
    topoState.activeView = key;
    if (topoState.data) renderTopologyGraph(topoState.data);
  }
  function _renderTopologyFloorViews() {
    var graph = document.getElementById("topology-graph");
    if (!graph) return;
    if (!graph.style.position) graph.style.position = "relative";
    var wrap = document.getElementById("topology-floor-views");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "topology-floor-views";
      wrap.className = "topology-floor-views";
      graph.appendChild(wrap);
    }
    wrap.innerHTML = "";
    var views = topoState.floorViews || [];
    if (views.length === 0) { wrap.hidden = true; return; }
    var entries = [{ key: "flat", label: "Flat" }].concat(views);
    entries.forEach(function (v) {
      var active = topoState.activeView === v.key;
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "topology-type-chip topology-floor-chip" + (active ? " is-active" : "");
      chip.setAttribute("aria-pressed", active ? "true" : "false");
      chip.title = v.key === "flat" ? "Whole site" : "Show only " + v.label;
      chip.textContent = v.label;
      chip.addEventListener("click", function () { _setTopologyView(v.key); });
      wrap.appendChild(chip);
    });
    wrap.hidden = false;
  }

  // ── Location-hull visibility toggle ─────────────────────────────────────
  function _readShowLocations() {
    try { return localStorage.getItem(SHOW_LOCATIONS_STORAGE_KEY) !== "off"; }
    catch (e) { return true; }
  }
  function _writeShowLocations(on) {
    try { localStorage.setItem(SHOW_LOCATIONS_STORAGE_KEY, on ? "on" : "off"); }
    catch (e) { /* quota / private mode — toggle still applies this session */ }
  }

  // ── Device-type visibility toggles ─────────────────────────────────────────
  function _readHiddenRoles() {
    try {
      var raw = JSON.parse(localStorage.getItem(TYPE_FILTER_STORAGE_KEY) || "[]");
      if (Array.isArray(raw)) {
        var map = {};
        raw.forEach(function (r) { if (typeof r === "string") map[r] = true; });
        return map;
      }
    } catch (e) { /* corrupt / private mode — treat as nothing hidden */ }
    return {};
  }
  function _writeHiddenRoles(map) {
    try { localStorage.setItem(TYPE_FILTER_STORAGE_KEY, JSON.stringify(Object.keys(map))); }
    catch (e) { /* quota / private mode — toggle still applies this session */ }
  }

  // Floating show/hide chips for device types, top-right of the graph area
  // (left of the map-only camera button). One chip per toggleable role present
  // on THIS site; clicking re-renders the graph through the normal pipeline so
  // the column/row solver lays the visible subset out compactly. Rebuilt on
  // every render — openTopology wipes #topology-graph's innerHTML, and the
  // per-site role counts change anyway.
  function _renderTopologyTypeToggles(roleCounts, hiddenRoles) {
    var graph = document.getElementById("topology-graph");
    if (!graph) return;
    if (!graph.style.position) graph.style.position = "relative";
    var wrap = document.getElementById("topology-type-toggles");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "topology-type-toggles";
      wrap.className = "topology-type-toggles";
      graph.appendChild(wrap);
    }
    wrap.innerHTML = "";
    TOPO_TYPE_TOGGLES.forEach(function (t) {
      var count = roleCounts[t.role] || 0;
      if (count === 0) return; // nothing of this type on this site
      var hidden = !!hiddenRoles[t.role];
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "topology-type-chip" + (hidden ? " is-off" : "");
      chip.setAttribute("aria-pressed", hidden ? "false" : "true");
      chip.title = (hidden ? "Show " : "Hide ") + t.label.toLowerCase() + " (saved per user)";
      chip.textContent = t.label + " (" + count + ")";
      chip.addEventListener("click", function () {
        var next = _readHiddenRoles();
        if (next[t.role]) delete next[t.role];
        else next[t.role] = true;
        _writeHiddenRoles(next);
        if (topoState.data) renderTopologyGraph(topoState.data);
      });
      wrap.appendChild(chip);
    });
    // Locations chip — toggles the building/floor/room/jb grouping hulls.
    // Only offered when this site's devices actually carry location codes.
    if (topoState.hasLocationCodes) {
      var locOn = _readShowLocations();
      var locChip = document.createElement("button");
      locChip.type = "button";
      locChip.className = "topology-type-chip" + (locOn ? "" : " is-off");
      locChip.setAttribute("aria-pressed", locOn ? "true" : "false");
      locChip.title = (locOn ? "Hide" : "Show") + " location groups (saved per user)";
      locChip.textContent = "Locations";
      locChip.addEventListener("click", function () {
        var next = !_readShowLocations();
        _writeShowLocations(next);
        if (cyInstance) {
          if (next) {
            window.PolarisTopologyRender.renderLocationGroups(
              cyInstance,
              topoState.activeView !== "flat" ? { suppressKinds: ["building", "floor"] } : undefined
            );
          } else {
            window.PolarisTopologyRender.removeLocationGroups(cyInstance);
          }
        }
        locChip.className = "topology-type-chip" + (next ? "" : " is-off");
        locChip.setAttribute("aria-pressed", next ? "true" : "false");
        locChip.title = (next ? "Hide" : "Show") + " location groups (saved per user)";
      });
      wrap.appendChild(locChip);
    }
    wrap.hidden = wrap.children.length === 0;
  }

  // Adds the floating "copy map as image" camera button into #topology-graph.
  // Guarded so refresh (which keeps the button) doesn't stack duplicates.
  function _ensureTopologyMapShotButton() {
    var graph = document.getElementById("topology-graph");
    if (!graph || document.getElementById("topology-map-screenshot")) return;
    if (!graph.style.position) graph.style.position = "relative";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "topology-map-screenshot";
    btn.className = "btn-icon topology-map-shot";
    btn.title = "Copy map as image";
    btn.setAttribute("aria-label", "Copy map as image");
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
        '<circle cx="12" cy="13" r="4"/>' +
      '</svg>';
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      screenshotTopology();
    });
    graph.appendChild(btn);
  }

  // Humanize an interface speed in bits/sec → "1 Gbps" / "100 Mbps" etc.
  function _humanizeSpeedBps(bps) {
    if (bps == null || bps <= 0) return "";
    if (bps >= 1e9) return (bps % 1e9 === 0 ? (bps / 1e9).toFixed(0) : (bps / 1e9).toFixed(1)) + " Gbps";
    if (bps >= 1e6) return (bps % 1e6 === 0 ? (bps / 1e6).toFixed(0) : (bps / 1e6).toFixed(1)) + " Mbps";
    if (bps >= 1e3) return (bps / 1e3).toFixed(0) + " Kbps";
    return bps + " bps";
  }
  // One-line interface detail: "lan1 · 1 Gbps · up · errors ↓3 ↑1" (speed/
  // status omitted when unknown; errors shown only when nonzero).
  function _formatIfDetail(d) {
    if (!d || !d.name) return "";
    var bits = [d.name];
    var sp = _humanizeSpeedBps(d.speedBps);
    if (sp) bits.push(sp);
    if (d.operStatus) bits.push(d.operStatus);
    var ie = d.inErrors || 0, oe = d.outErrors || 0;
    if (ie > 0 || oe > 0) bits.push("errors ↓" + ie + " ↑" + oe);
    return bits.join(" · ");
  }

  // Build the concise edge tooltip: "DeviceA  ⇄  DeviceB" on top, the per-side
  // interface ports next, a one-line connection kind, then per-side interface
  // details (speed / status / errors) when available. Reads device names from
  // the endpoint nodes and the port pair from the edge label
  // ("<srcPort> ↔ <tgtPort>"). Returns null when there's nothing useful.
  function buildEdgeTooltipHtml(edge) {
    if (!cyInstance || !edge) return null;
    var srcId = edge.data("source");
    var tgtId = edge.data("target");
    var srcLabel = (cyInstance.getElementById(srcId).data("label")) || srcId || "?";
    var tgtLabel = (cyInstance.getElementById(tgtId).data("label")) || tgtId || "?";
    var ports = String(edge.data("label") || "").trim();
    var kind = edge.data("isMesh")     ? "Wireless mesh backhaul"
             : edge.data("isBridge")   ? "Switch bridged behind AP (wired)"
             : edge.data("isWireless") ? "Wireless client"
             : edge.data("isIface")    ? "Interface-confirmed peer link"
             : edge.data("isLldp")     ? "LLDP neighbor"
             : edge.data("isApLink")   ? "AP switch uplink"
             :                            "FortiLink controller";
    var html =
      '<div style="font-weight:600">' + escapeHtml(srcLabel) +
      ' <span style="opacity:0.7">⇄</span> ' + escapeHtml(tgtLabel) + '</div>';
    if (ports && ports !== "unknown ↔ unknown") {
      html += '<div style="font-family:var(--font-mono,monospace);font-size:0.82em;margin-top:2px">' +
        escapeHtml(ports) + '</div>';
    }
    html += '<div style="opacity:0.7;font-size:0.82em;margin-top:2px">' + escapeHtml(kind) + '</div>';
    // Per-side interface detail, each prefixed with its device so the operator
    // can tell which end "port14" / "port52" lives on (srcIf belongs to the
    // source node, tgtIf to the target).
    var sd = _formatIfDetail(edge.data("srcIf"));
    var td = _formatIfDetail(edge.data("tgtIf"));
    if (sd) html += '<div style="font-size:0.78em;opacity:0.85;margin-top:3px">' +
      '<span style="opacity:0.7">' + escapeHtml(srcLabel) + ':</span> ' + escapeHtml(sd) + '</div>';
    if (td) html += '<div style="font-size:0.78em;opacity:0.85">' +
      '<span style="opacity:0.7">' + escapeHtml(tgtLabel) + ':</span> ' + escapeHtml(td) + '</div>';
    return html;
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
  function showEdgeTooltip(html, clientX, clientY) {
    var el = ensureEdgeTooltip();
    // Structured (escaped) HTML built by buildEdgeTooltipHtml — device names,
    // interface ports, and connection kind.
    el.innerHTML = html;
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
    var fgLabel = escapeHtml(fg.hostname || "FortiGate");
    if (fg.id) {
      parts.push('<h4><a href="/assets.html#asset=' + encodeURIComponent(fg.id) + '">' + fgLabel + '</a></h4>');
    } else {
      parts.push('<h4>' + fgLabel + '</h4>');
    }

    parts.push('<div class="detail-row"><span class="label">Serial</span>' + copyableValue(fg.serial) + '</div>');
    parts.push('<div class="detail-row"><span class="label">Model</span><span class="value">' + escapeHtml(fg.model || "—") + '</span></div>');
    parts.push('<div class="detail-row"><span class="label">Mgmt IP</span>' + copyableValue(fg.ip) + '</div>');
    parts.push('<div class="detail-row"><span class="label">Status</span><span class="value">' + escapeHtml(fg.status || "—") + '</span></div>');
    if (fg.lastSeen) {
      parts.push('<div class="detail-row"><span class="label">Last seen</span><span class="value">' + escapeHtml(new Date(fg.lastSeen).toLocaleString()) + '</span></div>');
    }
    if (fg.latitude != null && fg.longitude != null) {
      var coordsText = fg.latitude.toFixed(4) + ', ' + fg.longitude.toFixed(4);
      parts.push('<div class="detail-row"><span class="label">Coords</span>' + copyableValue(coordsText) + '</div>');
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

    var infoEl = document.getElementById("topology-info");
    infoEl.innerHTML = parts.join("");
    _wireCopyableValues(infoEl);
  }

  // Renders a value cell with a click-to-copy affordance. Falls back to a
  // plain (non-copyable) cell for empty values so we never copy a literal
  // em-dash.
  function copyableValue(raw) {
    if (raw == null || raw === "") return '<span class="value">—</span>';
    var s = String(raw);
    return '<span class="value copyable" data-copy="' + escapeHtml(s) +
      '" role="button" tabindex="0" title="Click to copy">' + escapeHtml(s) + '</span>';
  }

  function _wireCopyableValues(root) {
    if (!root || root.__copyableWired) return;
    root.__copyableWired = true;
    root.addEventListener("click", function (ev) {
      var el = ev.target && ev.target.closest && ev.target.closest(".copyable");
      if (!el || !root.contains(el)) return;
      ev.preventDefault();
      _copyToClipboard(el.getAttribute("data-copy") || el.textContent, el);
    });
    root.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      var el = ev.target && ev.target.closest && ev.target.closest(".copyable");
      if (!el || !root.contains(el)) return;
      ev.preventDefault();
      _copyToClipboard(el.getAttribute("data-copy") || el.textContent, el);
    });
  }

  function _copyToClipboard(text, sourceEl) {
    var done = function (ok) { _flashCopied(sourceEl, ok); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(_legacyCopy(text)); });
        return;
      }
    } catch (_) { /* fall through to legacy path */ }
    done(_legacyCopy(text));
  }

  function _legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  function _flashCopied(el, ok) {
    if (!el) return;
    el.classList.remove("copy-flash-ok", "copy-flash-err");
    void el.offsetWidth; // restart animation
    el.classList.add(ok ? "copy-flash-ok" : "copy-flash-err");
    setTimeout(function () { el.classList.remove("copy-flash-ok", "copy-flash-err"); }, 800);
  }

  // Cross-site asset clicks + topology right-bar links pivot to the canonical
  // asset details slide-over (openViewModal in assets.js, the TEMPLATES.md
  // canonical Slide-over implementation). assets.js + its UI deps are loaded
  // on map.html for this; each file's DOMContentLoaded handler self-guards
  // so the Assets-page UI doesn't try to bootstrap here.

  function _assetIdFromTopoHref(href) {
    if (!href) return null;
    var m = href.match(/\/assets\.html#(?:asset=|view=asset:)([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function setStatus(text) {
    var el = document.getElementById("map-status");
    if (el) el.textContent = text;
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

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

  // ─── Region editing (admin / networkadmin only) ──────────────────────────
  // Regions are NOT rendered on the default map view. The "Edit regions"
  // toolbar button toggles an edit mode that overlays existing regions and
  // mounts the leaflet-draw control. Saving / renaming / deleting reconciles
  // tags on the backend; exiting edit mode hides the overlay again.
  var regionState = {
    editing: false,
    layer: null,           // L.featureGroup of L.polygon
    drawControl: null,
    polygonsByRegionId: {} // id → L.polygon
  };

  function wireRegionEditing() {
    var editBtn    = document.getElementById("map-edit-regions");
    var saveBtn    = document.getElementById("map-save-regions");
    var discardBtn = document.getElementById("map-discard-regions");
    if (!editBtn) return;
    if (typeof canManageNetworks === "function" && !canManageNetworks()) return;
    editBtn.hidden = false;
    // Save + Discard stay hidden until the operator enters edit mode; they're
    // only meaningful while there are in-flight vertex changes to commit or
    // revert. Visibility flips in setEditModeButtons.
    editBtn.addEventListener("click", function () {
      enterRegionEditMode().catch(function (err) {
        setStatus("Failed to load regions: " + (err && err.message ? err.message : err));
      });
    });
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        saveAndExitRegionEditMode().catch(function (err) {
          setStatus("Failed to save regions: " + (err && err.message ? err.message : err));
        });
      });
    }
    if (discardBtn) {
      discardBtn.addEventListener("click", function () {
        discardAndExitRegionEditMode();
      });
    }
  }

  // Swap the three toolbar buttons between view ("Edit regions" visible) and
  // edit ("Save Regions" + "Discard Changes" visible) modes. Single helper so
  // the visibility rule lives in one place.
  function setEditModeButtons(editing) {
    var editBtn    = document.getElementById("map-edit-regions");
    var saveBtn    = document.getElementById("map-save-regions");
    var discardBtn = document.getElementById("map-discard-regions");
    if (editBtn)    editBtn.hidden    = editing;
    if (saveBtn)    saveBtn.hidden    = !editing;
    if (discardBtn) discardBtn.hidden = !editing;
  }

  async function enterRegionEditMode() {
    if (regionState.editing) return;
    regionState.editing = true;
    regionState.polygonsByRegionId = {};
    regionState.layer = L.featureGroup().addTo(map);

    var regions = [];
    try {
      regions = await api.mapRegions.list();
    } catch (e) {
      regionState.editing = false;
      if (regionState.layer) { map.removeLayer(regionState.layer); regionState.layer = null; }
      throw e;
    }
    if (Array.isArray(regions)) {
      for (var i = 0; i < regions.length; i++) addRegionPolygon(regions[i]);
    }

    regionState.drawControl = new L.Control.Draw({
      position: "topright",
      draw: {
        polygon: { allowIntersection: false, showArea: false, shapeOptions: { className: "map-region-polygon" } },
        polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false
      }
      // No `edit` config — vertex editing is always on per polygon (see
      // enablePolygonVertexEdit). Delete stays in the polygon-click popup.
    });
    map.addControl(regionState.drawControl);

    map.on(L.Draw.Event.CREATED, onRegionCreated);

    setEditModeButtons(true);
    setStatus("Editing regions: draw a polygon, drag any vertex to reshape, click an existing region to rename/delete, or right-click-drag to pan. Click \"Save Regions\" to commit changes or \"Discard Changes\" to revert.");
  }

  // Walk every region polygon in edit mode and PUT the ones whose vertices
  // were dragged this session. On all-success, exit edit mode. On any
  // failure, surface the count, keep the failed polygons marked dirty, and
  // leave the operator in edit mode so they can retry. Polygons whose
  // drag-end shape matches the loaded shape (no net change) are skipped.
  async function saveAndExitRegionEditMode() {
    var dirty = [];
    for (var rid in regionState.polygonsByRegionId) {
      var p = regionState.polygonsByRegionId[rid];
      if (p && p._polarisDirty) dirty.push(p);
    }
    if (dirty.length === 0) {
      teardownRegionEditMode();
      setStatus("");
      return;
    }
    setStatus("Saving " + dirty.length + " region change" + (dirty.length === 1 ? "" : "s") + "…");
    var failures = 0;
    await Promise.all(dirty.map(function (poly) {
      var pairs = polygonLatLngsToPairs(poly);
      return api.mapRegions.update(poly._polarisRegionId, { polygon: pairs }).then(function () {
        poly._polarisSavedPolygon = pairs;
        poly._polarisDirty = false;
      }).catch(function (err) {
        failures++;
        // Per-polygon alert so the operator knows exactly which one failed.
        window.alert("Failed to save region \"" + (poly._polarisRegionName || "") + "\": " + (err && err.message ? err.message : err));
      });
    }));
    if (failures > 0) {
      setStatus(failures + " region" + (failures === 1 ? "" : "s") + " failed to save — still in edit mode, click Save Regions to retry or Discard Changes to abandon.");
      return;
    }
    teardownRegionEditMode();
    setStatus(dirty.length + " region" + (dirty.length === 1 ? "" : "s") + " saved.");
  }

  // Revert every dirty polygon to the shape it had when edit mode opened
  // (or to the shape from the last successful save during this session).
  // Doesn't touch polygons created or deleted this session — those went
  // through their own explicit PUT/DELETE and aren't tracked here.
  function discardAndExitRegionEditMode() {
    var reverted = 0;
    for (var rid in regionState.polygonsByRegionId) {
      var p = regionState.polygonsByRegionId[rid];
      if (!p || !p._polarisDirty) continue;
      if (Array.isArray(p._polarisSavedPolygon)) {
        p.setLatLngs(p._polarisSavedPolygon);
        // Re-enable editing to refresh the marker positions; without this,
        // the vertex handles still sit at the dragged locations even though
        // the polygon outline snapped back.
        if (p.editing) { p.editing.disable(); p.editing.enable(); }
        setTimeout((function (pp) { return function () { colorEditMarkers(pp); }; })(p), 0);
      }
      p._polarisDirty = false;
      reverted++;
    }
    teardownRegionEditMode();
    setStatus(reverted > 0 ? reverted + " region change" + (reverted === 1 ? "" : "s") + " discarded." : "");
  }

  // Tear-down only — shared by both save and discard paths. No network I/O
  // happens here.
  function teardownRegionEditMode() {
    regionState.editing = false;
    map.off(L.Draw.Event.CREATED, onRegionCreated);
    if (regionState.drawControl) { map.removeControl(regionState.drawControl); regionState.drawControl = null; }
    if (regionState.layer) { map.removeLayer(regionState.layer); regionState.layer = null; }
    regionState.polygonsByRegionId = {};
    setEditModeButtons(false);
  }

  function addRegionPolygon(region) {
    if (!region || !Array.isArray(region.polygon) || region.polygon.length < 3) return;
    var poly = L.polygon(region.polygon, { className: "map-region-polygon" });
    poly._polarisRegionId = region.id;
    poly._polarisRegionName = region.name;
    poly._polarisRegionColor = region.color || null;
    applyRegionColor(poly, region.color);
    poly.bindTooltip(escapeHtml(region.name), { permanent: true, direction: "center", className: "map-region-label" });
    poly.on("click", function () { openRegionActionsPopup(poly); });
    regionState.layer.addLayer(poly);
    regionState.polygonsByRegionId[region.id] = poly;
    enablePolygonVertexEdit(poly);
  }

  // Apply the region's color to the polygon stroke + fill. The CSS class
  // map-region-polygon still owns stroke width / opacities; this overrides
  // only the hue. Falls through to the CSS default (accent) when color is
  // missing — that path exists for legacy regions that haven't been rewritten
  // yet, though the backend back-fills a random palette pick at load time.
  function applyRegionColor(poly, color) {
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
    poly.setStyle({ color: color, fillColor: color });
  }

  // Turns on leaflet-draw's per-polygon vertex/midpoint handles immediately
  // (no Edit-toolbar round-trip). Every vertex drag fires `editvertex` on the
  // polygon; we debounce-save 800ms after the last change so a rapid sequence
  // of drags becomes a single PUT. Failures restore the prior shape so the
  // map matches the server.
  function enablePolygonVertexEdit(poly) {
    if (!poly || !poly.editing) return;
    poly.editing.enable();
    // Recolor the freshly-created vertex/midpoint markers to match the
    // polygon's hue. Deferred one tick so leaflet-draw has finished mounting
    // the markers into the marker pane.
    setTimeout(function () { colorEditMarkers(poly); }, 0);
    // Capture the loaded shape so Discard Changes can revert in-place. Any
    // editvertex fired afterward marks the polygon dirty so the Save / Discard
    // paths know which ones need attention; clean polygons are skipped.
    poly._polarisSavedPolygon = polygonLatLngsToPairs(poly);
    poly._polarisDirty = false;
    // leaflet-draw 1.0.4 fires plain "edit" on the polygon at each vertex
     // drag-end / midpoint-drag-conversion / vertex-deletion. The map gets
     // "draw:editvertex" (constant L.Draw.Event.EDITVERTEX) — that name does
     // NOT fire on the polygon itself, so this listener must be "edit".
    poly.on("edit", function () {
      // Midpoint-drag→vertex conversions add fresh markers; vertex deletions
      // remove them. Either way, re-color so the dot set always matches the
      // region. Deferred so the marker DOM is settled when we walk it.
      setTimeout(function () { colorEditMarkers(poly); }, 0);
      poly._polarisDirty = true;
    });
  }

  // Per-polygon vertex/midpoint marker recoloring. leaflet-draw mounts each
  // marker into the shared marker pane (siblings, not children of the polygon
  // path), so we can't reach them with a CSS-variable trick — walking the
  // handler's internal `_markerGroup` and setting borderColor inline is the
  // only stable hook. The base shape stays from the .leaflet-editing-icon
  // CSS class; we only override the ring hue.
  function colorEditMarkers(poly) {
    if (!poly || !poly.editing) return;
    var color = poly._polarisRegionColor;
    if (!color) return;
    var handlers = poly.editing._verticesHandlers || [];
    for (var h = 0; h < handlers.length; h++) {
      var group = handlers[h] && handlers[h]._markerGroup;
      if (!group || typeof group.eachLayer !== "function") continue;
      group.eachLayer(function (m) {
        if (m && m._icon) m._icon.style.borderColor = color;
      });
    }
  }

  function polygonLatLngsToPairs(poly) {
    // L.Polygon.getLatLngs() returns nested rings for multi-rings; we only
    // create simple polygons here, so pull the first ring out.
    var rings = poly.getLatLngs();
    var ring = Array.isArray(rings) && rings.length > 0 && Array.isArray(rings[0]) ? rings[0] : rings;
    var pairs = [];
    for (var i = 0; i < ring.length; i++) {
      var ll = ring[i];
      pairs.push([ll.lat, ll.lng]);
    }
    return pairs;
  }

  async function onRegionCreated(e) {
    var layer = e.layer;
    var pairs = polygonLatLngsToPairs(layer);
    var details = await promptRegionDetails("Name this region", "", randomRegionColor());
    if (!details) return; // cancelled
    try {
      var saved = await api.mapRegions.create(details.name, pairs, details.color);
      // Replace the temporary draw layer with our managed L.polygon so
      // it picks up the styled className + click handler.
      addRegionPolygon(saved);
      setStatus("Region \"" + saved.name + "\" saved.");
    } catch (err) {
      window.alert("Failed to save region: " + (err && err.message ? err.message : err));
    }
  }

  // Palette mirrors src/services/mapRegionService.ts TAG_COLOR_PALETTE so the
  // initial picker swatch matches the backend's random pick when an operator
  // saves without changing the color.
  var REGION_COLOR_PALETTE = [
    "#4fc3f7", "#4ade80", "#f59e0b", "#f472b6", "#a78bfa",
    "#fb923c", "#38bdf8", "#34d399", "#e879f9", "#facc15",
    "#f87171", "#2dd4bf", "#818cf8", "#c084fc",
  ];
  function randomRegionColor() {
    return REGION_COLOR_PALETTE[Math.floor(Math.random() * REGION_COLOR_PALETTE.length)];
  }

  function openRegionActionsPopup(poly) {
    if (!regionState.editing) return;
    var id = poly._polarisRegionId;
    var name = poly._polarisRegionName || "";
    var color = poly._polarisRegionColor || "";
    var swatch = color
      ? '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + escapeHtml(color) + ';margin-right:6px;vertical-align:middle"></span>'
      : "";
    var html =
      '<div style="display:flex;flex-direction:column;gap:6px;min-width:180px">' +
        '<div style="font-weight:600">' + swatch + escapeHtml(name) + '</div>' +
        '<button type="button" class="btn btn-secondary" data-region-rename="' + escapeHtml(id) + '">Rename</button>' +
        '<button type="button" class="btn btn-secondary" data-region-recolor="' + escapeHtml(id) + '">Change color</button>' +
        '<button type="button" class="btn btn-secondary" data-region-back="' + escapeHtml(id) + '" title="Send this polygon behind the others so an overlapping region underneath can be clicked. Resets on page reload.">Send to Bottom Layer</button>' +
        '<button type="button" class="btn btn-danger" data-region-delete="' + escapeHtml(id) + '">Delete</button>' +
      '</div>';
    var popup = L.popup({ closeButton: true, autoClose: true }).setLatLng(poly.getBounds().getCenter()).setContent(html).openOn(map);
    setTimeout(function () {
      var renameBtn = document.querySelector('[data-region-rename="' + id + '"]');
      var recolorBtn = document.querySelector('[data-region-recolor="' + id + '"]');
      var backBtn = document.querySelector('[data-region-back="' + id + '"]');
      var deleteBtn = document.querySelector('[data-region-delete="' + id + '"]');
      if (renameBtn) renameBtn.addEventListener("click", function () { map.closePopup(popup); renameRegion(id, name); });
      if (recolorBtn) recolorBtn.addEventListener("click", function () { map.closePopup(popup); recolorRegion(id, name, color); });
      if (backBtn) backBtn.addEventListener("click", function () { map.closePopup(popup); sendRegionToBack(id, name); });
      if (deleteBtn) deleteBtn.addEventListener("click", function () { map.closePopup(popup); deleteRegion(id, name); });
    }, 0);
  }

  // Per-session layer-order override. Polygons drawn later naturally sit on
  // top of earlier ones, which hides an inner region beneath a larger outer
  // one. "Send to Bottom Layer" pushes this polygon behind every other layer
  // in the region featureGroup so the operator can click the previously-
  // obscured polygon. Not persisted — resets on page reload, since the
  // saved region order on the server is just insertion order.
  function sendRegionToBack(id, name) {
    var poly = regionState.polygonsByRegionId[id];
    if (!poly || typeof poly.bringToBack !== "function") return;
    poly.bringToBack();
    setStatus("Region \"" + name + "\" sent to bottom layer.");
  }

  async function recolorRegion(id, name, currentColor) {
    var next = await promptRegionColor("Change color for \"" + name + "\"", currentColor || randomRegionColor());
    if (!next || next === currentColor) return;
    try {
      var updated = await api.mapRegions.update(id, { color: next });
      var poly = regionState.polygonsByRegionId[id];
      if (poly) {
        poly._polarisRegionColor = updated.color;
        applyRegionColor(poly, updated.color);
        colorEditMarkers(poly);
      }
      setStatus("Region \"" + name + "\" recolored.");
    } catch (err) {
      window.alert("Failed to recolor region: " + (err && err.message ? err.message : err));
    }
  }

  async function renameRegion(id, currentName) {
    var next = await promptRegionName("Rename region", currentName);
    if (!next || next === currentName) return;
    try {
      var updated = await api.mapRegions.update(id, { name: next });
      var poly = regionState.polygonsByRegionId[id];
      if (poly) {
        poly._polarisRegionName = updated.name;
        if (poly.getTooltip()) poly.setTooltipContent(escapeHtml(updated.name));
      }
      setStatus("Region renamed to \"" + updated.name + "\".");
    } catch (err) {
      window.alert("Failed to rename region: " + (err && err.message ? err.message : err));
    }
  }

  async function deleteRegion(id, name) {
    var ok = window.confirm('Delete region "' + name + '"? The "region:' + name + '" tag will be removed from every asset that carries it.');
    if (!ok) return;
    try {
      await api.mapRegions.delete(id);
      var poly = regionState.polygonsByRegionId[id];
      if (poly && regionState.layer) regionState.layer.removeLayer(poly);
      delete regionState.polygonsByRegionId[id];
      setStatus("Region \"" + name + "\" deleted.");
    } catch (err) {
      window.alert("Failed to delete region: " + (err && err.message ? err.message : err));
    }
  }

  // Rename-only prompt. Resolves to the trimmed name or null if cancelled.
  function promptRegionName(title, initial) {
    return new Promise(function (resolve) {
      var bodyHtml =
        '<label style="display:block;margin-bottom:6px;font-size:0.9rem">Region name</label>' +
        '<input type="text" id="region-name-input" maxlength="64" value="' + escapeHtml(initial || "") + '" ' +
          'style="width:100%;padding:6px 8px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary);color:var(--color-text-primary)">' +
        '<p style="margin-top:8px;font-size:0.8rem;color:var(--color-text-tertiary)">Saved as the tag <code>region:&lt;name&gt;</code>.</p>';
      var footer =
        '<button type="button" class="btn btn-secondary" id="region-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="region-save">Save</button>';
      var resolved = false;
      function finish(value) {
        if (resolved) return;
        resolved = true;
        if (typeof closeModal === "function") closeModal();
        resolve(value);
      }
      if (typeof openModal !== "function") {
        var v = window.prompt(title + ":", initial || "");
        return resolve(v && v.trim() ? v.trim() : null);
      }
      openModal(title, bodyHtml, footer);
      setTimeout(function () {
        var input = document.getElementById("region-name-input");
        if (input) { input.focus(); input.select(); }
        var cancel = document.getElementById("region-cancel");
        var save = document.getElementById("region-save");
        if (cancel) cancel.addEventListener("click", function () { finish(null); });
        if (save) save.addEventListener("click", function () {
          var v = input ? input.value.trim() : "";
          finish(v || null);
        });
        if (input) input.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter") { ev.preventDefault(); var v = input.value.trim(); finish(v || null); }
          if (ev.key === "Escape") { ev.preventDefault(); finish(null); }
        });
      }, 0);
    });
  }

  // Create-time prompt — collects name AND color. Resolves to {name, color}
  // or null if cancelled. The color picker is a palette swatch strip plus a
  // free-form hex input; the initial value is the caller-supplied random
  // palette pick so the operator can save without touching it.
  function promptRegionDetails(title, initialName, initialColor) {
    return new Promise(function (resolve) {
      var swatches = REGION_COLOR_PALETTE.map(function (c) {
        var selected = c.toLowerCase() === (initialColor || "").toLowerCase() ? " region-swatch-selected" : "";
        return '<button type="button" class="region-swatch' + selected + '" data-color="' + escapeHtml(c) + '" ' +
          'style="width:24px;height:24px;border-radius:50%;border:2px solid var(--color-border);background:' + escapeHtml(c) + ';cursor:pointer;padding:0"></button>';
      }).join("");
      var bodyHtml =
        '<label style="display:block;margin-bottom:6px;font-size:0.9rem">Region name</label>' +
        '<input type="text" id="region-name-input" maxlength="64" value="' + escapeHtml(initialName || "") + '" ' +
          'style="width:100%;padding:6px 8px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary);color:var(--color-text-primary)">' +
        '<label style="display:block;margin:14px 0 6px;font-size:0.9rem">Color</label>' +
        '<div id="region-swatches" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">' + swatches + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<input type="color" id="region-color-input" value="' + escapeHtml(initialColor || "#4fc3f7") + '" style="width:48px;height:32px;padding:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:transparent;cursor:pointer">' +
          '<span id="region-color-hex" style="font-family:monospace;color:var(--color-text-secondary)">' + escapeHtml(initialColor || "#4fc3f7") + '</span>' +
        '</div>' +
        '<p style="margin-top:12px;font-size:0.8rem;color:var(--color-text-tertiary)">Saved as the tag <code>region:&lt;name&gt;</code>. Color is chosen at random by default.</p>';
      var footer =
        '<button type="button" class="btn btn-secondary" id="region-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="region-save">Save</button>';
      var resolved = false;
      function finish(value) {
        if (resolved) return;
        resolved = true;
        if (typeof closeModal === "function") closeModal();
        resolve(value);
      }
      if (typeof openModal !== "function") {
        var v = window.prompt(title + " (name):", initialName || "");
        if (!v || !v.trim()) return resolve(null);
        return resolve({ name: v.trim(), color: initialColor || "#4fc3f7" });
      }
      openModal(title, bodyHtml, footer);
      setTimeout(function () {
        var input = document.getElementById("region-name-input");
        var colorInput = document.getElementById("region-color-input");
        var hexLabel = document.getElementById("region-color-hex");
        var cancel = document.getElementById("region-cancel");
        var save = document.getElementById("region-save");
        if (input) { input.focus(); input.select(); }
        function setColor(c) {
          if (!c) return;
          if (colorInput) colorInput.value = c;
          if (hexLabel) hexLabel.textContent = c.toLowerCase();
          var swatchEls = document.querySelectorAll("#region-swatches .region-swatch");
          for (var i = 0; i < swatchEls.length; i++) {
            var el = swatchEls[i];
            if ((el.getAttribute("data-color") || "").toLowerCase() === c.toLowerCase()) el.classList.add("region-swatch-selected");
            else el.classList.remove("region-swatch-selected");
          }
        }
        var swatchEls = document.querySelectorAll("#region-swatches .region-swatch");
        for (var i = 0; i < swatchEls.length; i++) {
          swatchEls[i].addEventListener("click", function (ev) { setColor(ev.currentTarget.getAttribute("data-color")); });
        }
        if (colorInput) colorInput.addEventListener("input", function () { setColor(colorInput.value); });
        function commit() {
          var name = input ? input.value.trim() : "";
          if (!name) { finish(null); return; }
          var color = colorInput ? colorInput.value : initialColor;
          finish({ name: name, color: color });
        }
        if (cancel) cancel.addEventListener("click", function () { finish(null); });
        if (save) save.addEventListener("click", commit);
        if (input) input.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter") { ev.preventDefault(); commit(); }
          if (ev.key === "Escape") { ev.preventDefault(); finish(null); }
        });
      }, 0);
    });
  }

  // Color-only prompt for the "Change color" popup action. Resolves to a
  // hex string or null if cancelled.
  function promptRegionColor(title, initialColor) {
    return new Promise(function (resolve) {
      var swatches = REGION_COLOR_PALETTE.map(function (c) {
        var selected = c.toLowerCase() === (initialColor || "").toLowerCase() ? " region-swatch-selected" : "";
        return '<button type="button" class="region-swatch' + selected + '" data-color="' + escapeHtml(c) + '" ' +
          'style="width:24px;height:24px;border-radius:50%;border:2px solid var(--color-border);background:' + escapeHtml(c) + ';cursor:pointer;padding:0"></button>';
      }).join("");
      var bodyHtml =
        '<div id="region-swatches" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">' + swatches + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<input type="color" id="region-color-input" value="' + escapeHtml(initialColor || "#4fc3f7") + '" style="width:48px;height:32px;padding:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:transparent;cursor:pointer">' +
          '<span id="region-color-hex" style="font-family:monospace;color:var(--color-text-secondary)">' + escapeHtml(initialColor || "#4fc3f7") + '</span>' +
        '</div>';
      var footer =
        '<button type="button" class="btn btn-secondary" id="region-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="region-save">Save</button>';
      var resolved = false;
      function finish(value) {
        if (resolved) return;
        resolved = true;
        if (typeof closeModal === "function") closeModal();
        resolve(value);
      }
      if (typeof openModal !== "function") {
        var v = window.prompt(title + " (hex color like #4fc3f7):", initialColor || "");
        if (!v || !/^#[0-9a-fA-F]{6}$/.test(v.trim())) return resolve(null);
        return resolve(v.trim().toLowerCase());
      }
      openModal(title, bodyHtml, footer);
      setTimeout(function () {
        var colorInput = document.getElementById("region-color-input");
        var hexLabel = document.getElementById("region-color-hex");
        var cancel = document.getElementById("region-cancel");
        var save = document.getElementById("region-save");
        function setColor(c) {
          if (!c) return;
          if (colorInput) colorInput.value = c;
          if (hexLabel) hexLabel.textContent = c.toLowerCase();
          var swatchEls = document.querySelectorAll("#region-swatches .region-swatch");
          for (var i = 0; i < swatchEls.length; i++) {
            var el = swatchEls[i];
            if ((el.getAttribute("data-color") || "").toLowerCase() === c.toLowerCase()) el.classList.add("region-swatch-selected");
            else el.classList.remove("region-swatch-selected");
          }
        }
        var swatchEls = document.querySelectorAll("#region-swatches .region-swatch");
        for (var i = 0; i < swatchEls.length; i++) {
          swatchEls[i].addEventListener("click", function (ev) { setColor(ev.currentTarget.getAttribute("data-color")); });
        }
        if (colorInput) colorInput.addEventListener("input", function () { setColor(colorInput.value); });
        if (cancel) cancel.addEventListener("click", function () { finish(null); });
        if (save) save.addEventListener("click", function () {
          var c = colorInput ? colorInput.value : initialColor;
          finish(c || null);
        });
      }, 0);
    });
  }
})();
