/**
 * widgets/siteMap.js — geographic map of monitored sites colored by monitor
 * health (SolarWinds map panel). Reuses the bundled Leaflet + markercluster
 * stack and the existing GET /map/sites endpoint (no new backend). The
 * marker/cluster/tooltip helpers are lifted (read-only) from public/js/map.js;
 * the page-level singletons, theme observer, right-click pan and topology modal
 * are intentionally NOT lifted — a widget can be instanced more than once, so
 * map + layers live in the per-instance render closure and are torn down in
 * ctx.onUnmount (Leaflet throws "Map container is already initialized" if a
 * container is re-used without map.remove()).
 */

(function () {
  var _iconPathSet = false;

  function monitorClass(site) {
    if (!site.monitored) return "monitor-unmonitored";
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
    if (site.dependencySuppressed && site.monitorHealth !== "down") return "Dependency down — upstream parent is offline";
    switch (site.monitorHealth) {
      case "up":       return "Up — last " + samples + " samples ok";
      case "degraded": return "Packet loss — " + failures + "/" + samples + " recent samples failed";
      case "down":     return "Down — " + failures + "/" + samples + " samples failed";
      default:         return "Monitored — no samples yet";
    }
  }

  function hasIssue(site) {
    return site.monitored && (site.monitorHealth === "down" || site.monitorHealth === "degraded");
  }

  function clusterIcon(cluster) {
    var children = cluster.getAllChildMarkers();
    var sawMonitored = false, sawDepDown = false, worst = "up";
    for (var i = 0; i < children.length; i++) {
      var s = children[i]._site;
      if (!s || !s.monitored) continue;
      sawMonitored = true;
      if (s.monitorHealth === "down") { worst = "down"; break; }
      if (s.monitorHealth === "degraded" && worst !== "down") worst = "degraded";
      if (s.dependencySuppressed && s.monitorHealth !== "down") sawDepDown = true;
    }
    var cls = !sawMonitored ? "monitor-unmonitored"
      : worst !== "up" ? "monitor-" + worst
      : sawDepDown ? "monitor-dep-down" : "monitor-up";
    return L.divIcon({ html: '<div class="fg-cluster ' + cls + '"><span>' + cluster.getChildCount() + "</span></div>", className: "", iconSize: [40, 40] });
  }

  function makeMarker(site) {
    var label = (site.hostname || "FG").slice(0, 3).toUpperCase();
    var icon = L.divIcon({
      className: "",
      html: '<div class="fg-marker ' + monitorClass(site) + '" aria-hidden="true">' + escapeHtml(label) + "</div>",
      iconSize: [34, 34], iconAnchor: [17, 17],
    });
    var marker = L.marker([site.latitude, site.longitude], { icon: icon, title: site.hostname || "" });
    marker._site = site;
    marker.bindTooltip(
      '<strong>' + escapeHtml(site.hostname || "(unnamed)") + '</strong>' +
      (site.model ? '<br><span style="opacity:.8">' + escapeHtml(site.model) + '</span>' : "") +
      '<br><span style="opacity:.8">' + escapeHtml(monitorTooltipLine(site)) + '</span>',
      { direction: "top", offset: [0, -12] }
    );
    // Hand off to the full Device Map rather than embedding the topology modal.
    marker.on("click", function () { window.location.href = "/map.html#site=" + encodeURIComponent(site.id) + "&topology=1"; });
    return marker;
  }

  function addSites(map, cluster, sites, config) {
    cluster.clearLayers();
    var rows = (sites || []).filter(function (s) { return s.latitude != null && s.longitude != null; });
    if (config && config.issuesOnly) rows = rows.filter(hasIssue);
    var latlngs = [];
    rows.forEach(function (s) { cluster.addLayer(makeMarker(s)); latlngs.push([s.latitude, s.longitude]); });
    return latlngs;
  }

  PolarisWidgets.register({
    type: "siteMap",
    label: "Site Map",
    description: "Geographic map of monitored sites, colored by monitor health.",
    defaultSize: { width: 6, height: 2 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { issuesOnly: false },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function () {
      return api.map.sites().catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      if (typeof L === "undefined") { el.innerHTML = '<p class="empty-state">Map library unavailable</p>'; return; }
      if (!_iconPathSet) { L.Icon.Default.imagePath = "/css/vendor/leaflet/images/"; _iconPathSet = true; }

      // The widget body has no intrinsic height in the flex column; make it the
      // frame and absolutely fill it so Leaflet gets a sized container.
      el.style.position = "relative";
      var mapDiv = document.createElement("div");
      mapDiv.style.cssText = "position:absolute;inset:0";
      el.appendChild(mapDiv);

      var map = L.map(mapDiv, { worldCopyJump: true, center: [39.5, -95], zoom: 4, attributionControl: true });
      var isDark = (document.documentElement.getAttribute("data-theme") || "dark") === "dark";
      L.tileLayer(
        isDark ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 19, attribution: isDark ? "© OpenStreetMap contributors © CARTO" : "© OpenStreetMap contributors" }
      ).addTo(map);

      var cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 40, disableClusteringAtZoom: 11, spiderfyOnMaxZoom: false, iconCreateFunction: clusterIcon });
      map.addLayer(cluster);

      function refit(latlngs) {
        if (latlngs.length > 0) map.fitBounds(L.latLngBounds(latlngs).pad(0.1), { maxZoom: 10 });
      }
      refit(addSites(map, cluster, data, config));

      // Keep Leaflet's internal size in sync with widget resizes.
      var raf = null;
      var ro = new ResizeObserver(function () {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(function () { map.invalidateSize(); });
      });
      ro.observe(el);

      // Refresh markers in place (no map teardown) every 60s.
      var timer = setInterval(function () {
        api.map.sites().then(function (sites) { addSites(map, cluster, sites, config); }).catch(function () {});
      }, 60000);

      ctx.onUnmount(function () {
        clearInterval(timer);
        try { ro.disconnect(); } catch (_) {}
        if (raf) cancelAnimationFrame(raf);
        try { map.remove(); } catch (_) {}
      });
    },

    renderPreview: function (el) {
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:120px;flex-direction:column;gap:6px;color:var(--color-text-secondary)">' +
        '<div style="font-size:2rem">🗺️</div><div style="font-size:0.82rem">Geographic site map</div></div>';
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;margin:3px 0">' +
          '<input type="checkbox" data-k="issuesOnly"' + (config.issuesOnly ? " checked" : "") + '> Show only sites with issues' +
        '</label>';
      el.querySelector('[data-k="issuesOnly"]').addEventListener("change", function (e) {
        onChange("issuesOnly", e.target.checked);
      });
    },
  });
})();
