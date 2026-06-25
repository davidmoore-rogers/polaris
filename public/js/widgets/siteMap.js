/**
 * widgets/siteMap.js — SolarWinds-NOC-style geographic site map.
 *
 * Status DOTS (green/amber/red/grey circle markers) colored by monitor health,
 * with a pulsing white-ringed dot for down sites, click popups, and hover
 * name tooltips. Plus a WEATHER overlay matching the NOC wall display:
 * animated RainViewer precipitation radar + Open-Meteo current-temperature
 * labels, with °F / RADAR / LOOP toggles and a radar timestamp. A darkened
 * basemap (CSS filter on the tile pane) keeps the dots and radar legible.
 *
 * Reuses the bundled Leaflet stack + the existing GET /map/sites endpoint (no
 * new backend). Per-instance: map, layers, weather state, and every timer live
 * in the render closure and are torn down in ctx.onUnmount (Leaflet throws
 * "Map container is already initialized" if a container is reused without
 * map.remove()). Weather fetches go to api.rainviewer.com / api.open-meteo.com
 * (whitelisted in the app CSP) and degrade silently when offline.
 */

(function () {
  var _iconPathSet = false;

  // SolarWinds status palette.
  var COLOR = { up: "#00c853", degraded: "#ffd600", down: "#ff1744", unknown: "#757575", dep: "#607d8b" };

  function healthKey(site) {
    if (!site.monitored) return "unknown";
    if (site.dependencySuppressed && site.monitorHealth !== "down") return "dep";
    switch (site.monitorHealth) {
      case "up": return "up";
      case "degraded": return "degraded";
      case "down": return "down";
      default: return "unknown";
    }
  }
  function statusColor(site) { return COLOR[healthKey(site)] || COLOR.unknown; }
  function isDown(site) { return site.monitored && site.monitorHealth === "down"; }
  function hasIssue(site) { return site.monitored && (site.monitorHealth === "down" || site.monitorHealth === "degraded"); }

  function monitorLine(site) {
    if (!site.monitored) return "Unmonitored";
    var samples = site.monitorRecentSamples || 0, failures = site.monitorRecentFailures || 0;
    if (site.dependencySuppressed && site.monitorHealth !== "down") return "Dependency down — upstream parent offline";
    switch (site.monitorHealth) {
      case "up": return "Up — last " + samples + " samples ok";
      case "degraded": return "Packet loss — " + failures + "/" + samples + " recent samples failed";
      case "down": return "Down — " + failures + "/" + samples + " samples failed";
      default: return "Monitored — no samples yet";
    }
  }

  // ── localStorage-persisted toggles (global, like the NOC kiosk) ──
  function wxPref(key, def) {
    try { var v = localStorage.getItem("polaris-sitemap-" + key); return v == null ? def : v === "true"; }
    catch (_) { return def; }
  }
  function setWxPref(key, val) { try { localStorage.setItem("polaris-sitemap-" + key, String(val)); } catch (_) {} }
  // Map theme is independent of the weather toggles: "light" | "dark",
  // defaulting to the app theme when the operator hasn't picked one.
  function themePref() {
    try {
      var v = localStorage.getItem("polaris-sitemap-theme");
      if (v === "light" || v === "dark") return v;
    } catch (_) {}
    return (document.documentElement.getAttribute("data-theme") || "dark") === "light" ? "light" : "dark";
  }

  PolarisWidgets.register({
    type: "siteMap",
    category: "NOC",
    label: "Status Map",
    description: "Geographic map of monitored sites — status dots + live weather radar.",
    defaultSize: { width: 6, height: 2 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { issuesOnly: false, regionScope: "all" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      var regions = config && config.regionScope === "mine" ? PolarisWidgets.myRegionNames() : null;
      return api.map.sites(regions).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      if (typeof L === "undefined") { el.innerHTML = '<p class="empty-state">Map library unavailable</p>'; return; }
      if (!_iconPathSet) { L.Icon.Default.imagePath = "/css/vendor/leaflet/images/"; _iconPathSet = true; }

      el.classList.add("sitemap-body");
      el.style.position = "relative";
      var mapDiv = document.createElement("div");
      mapDiv.style.cssText = "position:absolute;inset:0";
      el.appendChild(mapDiv);

      var map = L.map(mapDiv, { worldCopyJump: true, center: [39.5, -95], zoom: 4, attributionControl: true, zoomControl: true });

      // Theme-aware basemap: CARTO Dark Matter (dark) or CARTO Positron (light).
      // The .sitemap-dark class drives the basemap darkening filter (CSS), so
      // dots/radar stay legible on dark; light theme renders the map normally.
      var mapTheme = themePref();
      var basemap = null;
      function applyBasemap() {
        if (basemap) { map.removeLayer(basemap); basemap = null; }
        var dark = mapTheme === "dark";
        basemap = L.tileLayer(
          dark ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
               : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
          { maxZoom: 19, attribution: "© OpenStreetMap · CARTO" }
        ).addTo(map);
        el.classList.toggle("sitemap-dark", dark);
      }
      applyBasemap();

      var markersLayer = L.layerGroup().addTo(map);
      // Weather tiles ride a custom pane ABOVE the base tiles but OUTSIDE the
      // .leaflet-tile-pane CSS darkening filter, so radar stays vivid.
      var wxPane = map.createPane("sitemapWeather");
      wxPane.style.zIndex = 450;
      wxPane.style.pointerEvents = "none";

      // Leader lines: a dashed connector from each down site's (draggable)
      // label back to its red dot, so a label pulled aside still shows which
      // dot it belongs to. Drawn in container coords in an overlay SVG and
      // recomputed on pan/zoom/resize and live while a label is dragged.
      var SVGNS = "http://www.w3.org/2000/svg";
      var leaderSvg = document.createElementNS(SVGNS, "svg");
      leaderSvg.setAttribute("class", "sitemap-leaders");
      leaderSvg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:640;overflow:visible";
      mapDiv.appendChild(leaderSvg);
      var downMarkers = [];
      function updateLeaders() {
        while (leaderSvg.firstChild) leaderSvg.removeChild(leaderSvg.firstChild);
        var mr = mapDiv.getBoundingClientRect();
        downMarkers.forEach(function (m) {
          var tt = m.getTooltip(); if (!tt) return;
          var tEl = tt.getElement(); if (!tEl) return;
          var p = map.latLngToContainerPoint(m.getLatLng());
          var tr = tEl.getBoundingClientRect();
          var tx = tr.left - mr.left + tr.width / 2;   // label bottom-centre (its tail point)
          var ty = tr.bottom - mr.top - 1;
          var line = document.createElementNS(SVGNS, "line");
          line.setAttribute("x1", p.x); line.setAttribute("y1", p.y);
          line.setAttribute("x2", tx); line.setAttribute("y2", ty);
          line.setAttribute("stroke", "#ff1744");
          line.setAttribute("stroke-width", "1.5");
          line.setAttribute("stroke-dasharray", "3 3");
          line.setAttribute("opacity", "0.9");
          leaderSvg.appendChild(line);
        });
      }
      map.on("move zoomend viewreset resize", updateLeaders);

      // ── Markers (status dots + pulse) ──────────────────────────────────
      var markerRefs = [];
      // Per-site dragged tooltip offsets, persisted across the 60s refresh so a
      // label the operator pulled apart stays where they put it.
      var draggedOffsets = {};

      // Make a down site's permanent tooltip draggable (like the NOC wall
      // display) so overlapping red labels can be separated. Mirrors the
      // reference attachTooltipDrag: mousedown on the tooltip disables map pan,
      // mousemove rewrites the tooltip offset, mouseup re-enables pan.
      function attachTooltipDrag(circle, key) {
        var tt = circle.getTooltip(); if (!tt) return;
        var tEl = tt.getElement(); if (!tEl) return;
        L.DomEvent.disableClickPropagation(tEl);
        L.DomEvent.on(tEl, "mousedown", function (e) {
          L.DomEvent.stop(e);
          map.dragging.disable();
          tEl.classList.add("dragging");
          var startX = e.clientX, startY = e.clientY;
          var base = (tt.options.offset || [0, 0]).slice();
          function onMove(ev) {
            var off = [base[0] + (ev.clientX - startX), base[1] + (ev.clientY - startY)];
            tt.options.offset = off; tt.update(); draggedOffsets[key] = off; updateLeaders();
          }
          function onUp() {
            map.dragging.enable();
            tEl.classList.remove("dragging");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
          }
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });
      }

      function buildMarkers(sites) {
        markersLayer.clearLayers();
        markerRefs = [];
        downMarkers = [];
        var rows = (sites || []).filter(function (s) { return s.latitude != null && s.longitude != null; });
        if (config && config.issuesOnly) rows = rows.filter(hasIssue);
        var latlngs = [];
        rows.forEach(function (s) {
          var color = statusColor(s), down = isDown(s);
          if (down) {
            L.marker([s.latitude, s.longitude], {
              interactive: false,
              icon: L.divIcon({ className: "", html: '<div class="sitemap-pulse"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
            }).addTo(markersLayer);
          }
          var dot = L.circleMarker([s.latitude, s.longitude], {
            radius: down ? 7 : 6,
            fillColor: color, fillOpacity: down ? 1 : 0.85,
            color: down ? "#fff" : color, weight: down ? 2 : 1, opacity: down ? 1 : 0.6,
          });
          var name = escapeHtml(s.hostname || "(unnamed)");
          dot.bindPopup(
            '<div class="sitemap-popup-title" style="color:' + color + '">' + name + "</div>" +
            (s.model ? '<div class="sitemap-popup-row">' + escapeHtml(s.model) + "</div>" : "") +
            (s.ipAddress ? '<div class="sitemap-popup-row"><span>IP</span><code>' + escapeHtml(s.ipAddress) + "</code></div>" : "") +
            '<div class="sitemap-popup-row">' + escapeHtml(monitorLine(s)) + "</div>" +
            (s.subnetCount ? '<div class="sitemap-popup-row">' + s.subnetCount + " subnet" + (s.subnetCount === 1 ? "" : "s") + "</div>" : "") +
            '<a class="sitemap-popup-link" href="/map.html#site=' + encodeURIComponent(s.id) + '&topology=1">Open device map →</a>',
            { maxWidth: 280 }
          );
          // Down sites get a PERMANENT, DRAGGABLE red tooltip (always visible,
          // naming the down device) so the outage is readable at a glance and
          // overlapping labels can be pulled apart; healthy sites show the name
          // on hover only. Reuse any offset the operator dragged it to.
          var offset = (down && draggedOffsets[s.id]) ? draggedOffsets[s.id] : [0, down ? -10 : -8];
          dot.bindTooltip(
            down ? (name + " — DOWN") : name,
            {
              permanent: down,
              direction: "top",
              offset: offset,
              className: down ? "sitemap-tip sitemap-tip-down" : "sitemap-tip",
              opacity: 1,
            }
          );
          if (down) dot.on("tooltipopen", function () { attachTooltipDrag(dot, s.id); });
          dot.addTo(markersLayer);
          if (down) downMarkers.push(dot);
          markerRefs.push({ lat: s.latitude, lng: s.longitude });
          latlngs.push([s.latitude, s.longitude]);
        });
        requestAnimationFrame(updateLeaders);
        return latlngs;
      }
      function refit(latlngs) { if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs).pad(0.12), { maxZoom: 10 }); }
      refit(buildMarkers(data));

      // ── Weather overlay ────────────────────────────────────────────────
      var tempEnabled = wxPref("wx-temp", true);
      var radarEnabled = wxPref("wx-radar", true);
      var radarAnimate = wxPref("wx-animate", true);
      var tempLayer = null, tempTimer = null;
      var radarFrames = [], radarTimes = [], radarIdx = 0, radarTimer = null, radarAnimTimer = null;
      var RADAR_FRAME_MS = 500, RADAR_LOOP_PAUSE_MS = 1800, RADAR_OPACITY = 0.6;

      function wxRefreshMs() { var h = new Date().getHours(); return (h >= 8 && h < 17) ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000; }

      function loadTemps() {
        if (!tempEnabled) return;
        if (tempLayer) { map.removeLayer(tempLayer); tempLayer = null; }
        tempLayer = L.layerGroup().addTo(map);
        var grid = {};
        markerRefs.forEach(function (r) {
          var key = Math.round(r.lat / 1.5) + "," + Math.round(r.lng / 1.5);
          if (!grid[key]) grid[key] = { lat: r.lat, lng: r.lng };
        });
        var cells = Object.keys(grid).map(function (k) { return grid[k]; });
        cells.forEach(function (c) {
          fetch("https://api.open-meteo.com/v1/forecast?latitude=" + c.lat + "&longitude=" + c.lng + "&current=temperature_2m&temperature_unit=fahrenheit&forecast_days=1")
            .then(function (r) { return r.json(); })
            .then(function (d) {
              var t = d && d.current && d.current.temperature_2m;
              if (t == null || !tempLayer) return;
              L.marker([c.lat, c.lng], {
                interactive: false, pane: "sitemapWeather",
                icon: L.divIcon({ className: "", html: '<div class="sitemap-temp">' + Math.round(t) + "°F</div>", iconAnchor: [-8, 8] }),
              }).addTo(tempLayer);
            }).catch(function () {});
        });
        clearTimeout(tempTimer);
        tempTimer = setTimeout(loadTemps, wxRefreshMs());
      }

      function clearRadar() {
        radarFrames.forEach(function (l) { map.removeLayer(l); });
        radarFrames = []; radarTimes = [];
        clearTimeout(radarAnimTimer); radarAnimTimer = null;
      }
      function loadRadar() {
        if (!radarEnabled) return;
        fetch("https://api.rainviewer.com/public/weather-maps.json")
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var past = (d.radar && d.radar.past) || [];
            var frames = [], times = [];
            past.forEach(function (f) {
              frames.push(L.tileLayer(d.host + f.path + "/256/{z}/{x}/{y}/6/1_1.png",
                { opacity: 0, maxNativeZoom: 7, maxZoom: 18, pane: "sitemapWeather" }).addTo(map));
              times.push(f.time);
            });
            clearRadar();
            radarFrames = frames; radarTimes = times;
            applyRadarMode();
            clearTimeout(radarTimer);
            radarTimer = setTimeout(loadRadar, wxRefreshMs());
          }).catch(function () {});
      }
      function applyRadarMode() {
        clearTimeout(radarAnimTimer); radarAnimTimer = null;
        if (!radarFrames.length) return;
        if (radarAnimate) { radarIdx = 0; stepRadar(); }
        else {
          var last = radarFrames.length - 1;
          radarFrames.forEach(function (l, i) { l.setOpacity(i === last ? RADAR_OPACITY : 0); });
          updateClock(radarTimes[last]);
        }
      }
      function stepRadar() {
        if (!radarFrames.length) return;
        radarFrames.forEach(function (l, i) { l.setOpacity(i === radarIdx ? RADAR_OPACITY : 0); });
        updateClock(radarTimes[radarIdx]);
        var isLast = radarIdx === radarFrames.length - 1;
        radarIdx = (radarIdx + 1) % radarFrames.length;
        radarAnimTimer = setTimeout(stepRadar, isLast ? RADAR_LOOP_PAUSE_MS : RADAR_FRAME_MS);
      }
      function updateClock(unixSec) {
        if (clockEl == null || unixSec == null) return;
        var d = new Date(unixSec * 1000);
        clockEl.textContent = "RADAR " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
        clockEl.style.display = radarEnabled ? "block" : "none";
      }

      // ── Overlay controls (legend + weather toggles + radar clock) ───────
      var controls = document.createElement("div");
      controls.className = "sitemap-controls";
      controls.innerHTML =
        '<div class="sitemap-legend">' +
          '<span><i style="background:' + COLOR.up + '"></i>Up</span>' +
          '<span><i style="background:' + COLOR.degraded + '"></i>Warn</span>' +
          '<span><i style="background:' + COLOR.down + '"></i>Down</span>' +
          '<span><i style="background:' + COLOR.unknown + '"></i>Unknown</span>' +
        '</div>' +
        '<div class="sitemap-wx">' +
          '<button type="button" data-wx="theme" title="Toggle map theme"></button>' +
          '<button type="button" data-wx="temp">°F</button>' +
          '<button type="button" data-wx="radar">RADAR</button>' +
          '<button type="button" data-wx="animate">▶ LOOP</button>' +
          '<button type="button" data-wx="full" title="Fullscreen (Esc to exit)">⛶</button>' +
        '</div>' +
        '<div class="sitemap-radar-clock"></div>';
      el.appendChild(controls);
      var clockEl = controls.querySelector(".sitemap-radar-clock");
      var btnTheme = controls.querySelector('[data-wx="theme"]');
      var btnTemp = controls.querySelector('[data-wx="temp"]');
      var btnRadar = controls.querySelector('[data-wx="radar"]');
      var btnAnim = controls.querySelector('[data-wx="animate"]');
      var btnFull = controls.querySelector('[data-wx="full"]');
      function paintBtns() {
        // Show the icon for the theme you'd switch TO (sun = go light), mirroring the app toggle.
        btnTheme.textContent = mapTheme === "dark" ? "☀" : "🌙";
        btnTemp.classList.toggle("active", tempEnabled);
        btnRadar.classList.toggle("active", radarEnabled);
        btnAnim.classList.toggle("active", radarAnimate);
        clockEl.style.display = radarEnabled ? "block" : "none";
      }
      // Stop map drag when interacting with the controls.
      L.DomEvent.disableClickPropagation(controls);
      btnTheme.addEventListener("click", function () {
        mapTheme = mapTheme === "dark" ? "light" : "dark";
        try { localStorage.setItem("polaris-sitemap-theme", mapTheme); } catch (_) {}
        applyBasemap();
        paintBtns();
      });
      // Fullscreen: the widget body goes position:fixed inset:0 (CSS class).
      // invalidateSize after the layout change so Leaflet repaints at the new
      // size (the ResizeObserver also catches it). Esc exits.
      function setFullscreen(on) {
        el.classList.toggle("sitemap-fullscreen", on);
        btnFull.innerHTML = on ? "✖" : "⛶";
        btnFull.classList.toggle("active", on);
        setTimeout(function () { try { map.invalidateSize(); } catch (_) {} }, 60);
      }
      btnFull.addEventListener("click", function () { setFullscreen(!el.classList.contains("sitemap-fullscreen")); });
      function onKeydown(e) { if (e.key === "Escape" && el.classList.contains("sitemap-fullscreen")) setFullscreen(false); }
      document.addEventListener("keydown", onKeydown);
      btnTemp.addEventListener("click", function () {
        tempEnabled = !tempEnabled; setWxPref("wx-temp", tempEnabled); paintBtns();
        if (tempEnabled) loadTemps();
        else { if (tempLayer) { map.removeLayer(tempLayer); tempLayer = null; } clearTimeout(tempTimer); }
      });
      btnRadar.addEventListener("click", function () {
        radarEnabled = !radarEnabled; setWxPref("wx-radar", radarEnabled); paintBtns();
        if (radarEnabled) loadRadar();
        else { clearRadar(); clearTimeout(radarTimer); clockEl.textContent = ""; }
      });
      btnAnim.addEventListener("click", function () {
        radarAnimate = !radarAnimate; setWxPref("wx-animate", radarAnimate); paintBtns();
        if (radarEnabled) applyRadarMode();
      });
      paintBtns();
      if (tempEnabled) loadTemps();
      if (radarEnabled) loadRadar();

      // ── Resize + refresh + teardown ─────────────────────────────────────
      var raf = null;
      var ro = new ResizeObserver(function () {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(function () { map.invalidateSize(); });
      });
      ro.observe(el);

      var siteTimer = setInterval(function () {
        var regions = config && config.regionScope === "mine" ? PolarisWidgets.myRegionNames() : null;
        api.map.sites(regions).then(function (sites) { buildMarkers(sites); }).catch(function () {});
      }, 60000);

      ctx.onUnmount(function () {
        clearInterval(siteTimer);
        clearTimeout(tempTimer); clearTimeout(radarTimer); clearTimeout(radarAnimTimer);
        document.removeEventListener("keydown", onKeydown);
        try { ro.disconnect(); } catch (_) {}
        if (raf) cancelAnimationFrame(raf);
        try { if (controls.parentNode) controls.parentNode.removeChild(controls); } catch (_) {}
        try { map.remove(); } catch (_) {}
        el.classList.remove("sitemap-body", "sitemap-fullscreen");
      });
    },

    renderPreview: function (el) {
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:120px;flex-direction:column;gap:6px;color:var(--color-text-secondary)">' +
        '<div style="font-size:2rem">🗺️</div><div style="font-size:0.82rem">Status map · status dots + weather radar</div></div>';
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;margin:3px 0">' +
          '<input type="checkbox" data-k="issuesOnly"' + (config.issuesOnly ? " checked" : "") + '> Show only sites with issues' +
        '</label>';
      el.querySelector('[data-k="issuesOnly"]').addEventListener("change", function (e) { onChange("issuesOnly", e.target.checked); });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, false);
    },
  });
})();
