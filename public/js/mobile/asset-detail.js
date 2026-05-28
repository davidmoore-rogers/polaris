// public/js/mobile/asset-detail.js — Asset detail slide-up sheet.
//
// Sections (top to bottom):
//   - Hero with status pill + identity bits (name lives in the sheet header)
//   - Monitor section (response-time chart, status pill, RTT/last poll)
//   - Telemetry section (CPU+Memory chart, when supported)
//   - General section (IP/MAC/type/model/OS/location/last seen)
//   - Temperatures section — current per-sensor reading + 1h min/avg/max
//   - Interfaces section — operStatus=="up" only; tap a row opens a bottom
//     sheet with status / speed / ip / mac / errors / LLDP neighbor(s)
//   - Discovery sources — per-source list (sourceKind + integration + lastSeen)
//   - Firewall sightings — which FortiGates saw this asset (needs
//     assetsQuarantine read; degrades to a muted note otherwise)
//   - IP history list
//
// Out of scope for v1 (desktop-only):
//   - Per-interface throughput + errors charts
//   - Per-interface comments editor
//   - IPsec tunnels
//   - SNMP walk
//   - Per-source observed blob view (mobile shows the source summary, not the
//     full observed key/value table)

(function () {
  // Single shared chart range — driven by the 24h/7d segmented control on
  // the Monitor card. Telemetry chart follows the same range so both
  // sections move together when the operator switches windows.
  var DEFAULT_RANGE = "24h";
  var RANGES = ["1h", "24h", "7d", "30d"];

  // Human labels for AssetSource.sourceKind — mirrors `_assetSourceLabels` in
  // the desktop assets.js so both surfaces name discovery sources the same.
  var SOURCE_LABELS = {
    "entra":              "Microsoft Entra ID",
    "intune":             "Microsoft Intune",
    "ad":                 "Active Directory",
    "fortigate-firewall": "FortiGate (firewall)",
    "fortiswitch":        "FortiSwitch",
    "fortiap":            "FortiAP",
    "fortigate-endpoint": "FortiGate / FortiManager (endpoint)",
    "polaris-agent":      "Polaris Agent",
    "manual":             "Manual / other",
  };

  // Per-mount state keyed by asset id so navigating back from another tab
  // remembers which sections were collapsed and which range was active.
  var _mounts = Object.create(null);

  function mountState(id) {
    if (!_mounts[id]) {
      _mounts[id] = {
        range: DEFAULT_RANGE,
        // Chart sections collapse by default — operators get the summary
        // (avg/max in the section subtitle) at a glance and can expand for
        // the full chart when needed.
        sections: {
          monitor: false,
          telemetry: false,
          general: true,
          temperatures: true,
          interfaces: true,
          // Discovery provenance. Sources expanded by default (the primary
          // "where did this asset come from" answer); firewall sightings +
          // IP history collapsed with a count in the header subtitle.
          sources: true,
          sightings: false,
          ipHistory: false,
        },
        // Interfaces sub-toggle: collapsed shows only `monitoredInterfaces`
        // (the operator-pinned fast-poll subset); expanded shows every up
        // interface. Persists per asset for the lifetime of the SPA mount.
        interfacesShowAll: false,
      };
    }
    return _mounts[id];
  }

  // ─── Three-state slide-up sheet ────────────────────────────────────────
  // The asset detail is a bottom sheet (not a full-page route): tapping an
  // asset anywhere calls `open(id)`. States:
  //   expanded — tall (~90vh) scrollable sheet with the full content.
  //   peek     — slid down so only the header band (status dot + name) shows;
  //              the scrim is hidden so the searchbar behind becomes usable.
  //              The DOM is NOT torn down — charts, scroll position and per-
  //              asset `mountState` survive, so re-expand is instant.
  //   closed   — sheet + scrim removed from the DOM.
  // Minimize is triggered by tapping the scrim (i.e. the dimmed area over the
  // searchbar); expand by tapping the peek bar; dismiss by swipe-down or the
  // close button.
  // Sized to clear the full peek-band content above the bottom navbar:
  // 32px of handle area (4px line + 12+16 margins) + 64px of header (48px
  // icon-btn rows + 4+12 padding) = 96px. Anything smaller cuts into the
  // hostname row.
  var PEEK_BAND_PX = 96;
  var _state = "closed";   // "closed" | "expanded" | "peek"
  var _openId = null;      // asset id currently shown — also the loader race guard

  // Build the scrim + sheet once and reuse across opens. Returns the sheet.
  function ensureSheet() {
    var existing = document.getElementById("asset-sheet");
    if (existing) return existing;

    var scrim = document.createElement("div");
    scrim.className = "scrim asset-scrim";
    scrim.id = "asset-sheet-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet asset-sheet";
    sheet.id = "asset-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div class="asset-sheet-header">'
      + '  <span class="dot" id="asset-sheet-dot" style="display:none;"></span>'
      + '  <div class="asset-sheet-name" id="asset-sheet-name">Asset</div>'
      + '  <button class="icon-btn" id="asset-sheet-refresh" aria-label="Refresh"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
      + '  <button class="icon-btn" id="asset-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div id="asset-host"></div>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    // Tapping the scrim (over the searchbar) minimizes rather than dismisses.
    scrim.addEventListener("click", minimize);
    document.getElementById("asset-sheet-close").addEventListener("click", dismiss);
    document.getElementById("asset-sheet-refresh").addEventListener("click", function () {
      if (_openId) onRefresh(_openId, this, mountState(_openId));
    });
    // Tapping the header while peeked re-expands (ignore taps on the buttons).
    sheet.querySelector(".asset-sheet-header").addEventListener("click", function (e) {
      if (_state === "peek" && !e.target.closest("#asset-sheet-close, #asset-sheet-refresh")) expand();
    });
    PolarisTabs.attachSwipeToDismiss(sheet, dismiss, {
      // First swipe-down locks to peek; second swipe-down dismisses.
      onSwipeDown: function () {
        if (_state === "expanded") {
          minimize();
        } else if (_state === "peek") {
          sheet.style.transition = "transform .2s ease-out";
          sheet.style.transform = "translateY(100%)";
          setTimeout(dismiss, 180);
        }
      },
      // Keep drag offsets continuous when peeked — without this the touchmove
      // overrides the peek CSS transform with translateY(dy), jumping the
      // sheet back to its natural position before the drag continues.
      baselineTranslate: function () {
        if (_state !== "peek") return 0;
        return Math.max(0, (sheet.offsetHeight || 0) - PEEK_BAND_PX);
      },
    });
    return sheet;
  }

  function setHeader(asset) {
    var nameEl = document.getElementById("asset-sheet-name");
    if (nameEl) nameEl.textContent = asset.hostname || asset.assetTag || "Asset";
    var dotEl = document.getElementById("asset-sheet-dot");
    if (dotEl) {
      var cls = monitorDotCls(asset);
      dotEl.className = "dot" + (cls ? " " + cls : "");
      dotEl.style.display = cls ? "" : "none";
    }
    // Refresh fires probeNow, which only makes sense for monitored assets —
    // unmonitored hosts have no probe transport to run, so hide the button.
    var refreshBtn = document.getElementById("asset-sheet-refresh");
    if (refreshBtn) refreshBtn.style.display = asset.monitored ? "" : "none";
  }

  function minimize() {
    if (_state !== "expanded") return;
    var sheet = document.getElementById("asset-sheet");
    var scrim = document.getElementById("asset-sheet-scrim");
    if (!sheet) return;
    // Slide the sheet down so only its top band (handle + header) peeks above
    // the bottom navbar. The sheet is anchored at bottom: navbar-h (see CSS),
    // so translateY(offsetHeight - PEEK_BAND_PX) leaves the band exposed just
    // above the navbar; the rest of the sheet extends behind the navbar and
    // is occluded by the navbar's higher z-index. Measured from the live
    // height so short content peeks correctly too. attachSwipeToDismiss
    // clears inline transform on snap-back, which falls through to the CSS
    // translate, so peek is restored.
    var translate = Math.max(0, (sheet.offsetHeight || 0) - PEEK_BAND_PX);
    sheet.style.setProperty("--asset-peek-y", translate + "px");
    sheet.classList.add("peek");
    if (scrim) scrim.style.display = "none";
    _state = "peek";
  }

  function expand() {
    if (_state !== "peek") return;
    var sheet = document.getElementById("asset-sheet");
    var scrim = document.getElementById("asset-sheet-scrim");
    if (!sheet) return;
    sheet.classList.remove("peek");
    sheet.style.transform = "";   // drop any inline transform left by a drag
    if (scrim) scrim.style.display = "";
    _state = "expanded";
  }

  function dismiss() {
    _openId = null;
    _state = "closed";
    var s = document.getElementById("asset-sheet");
    var sc = document.getElementById("asset-sheet-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }

  // Public opener. Builds the sheet (if needed), then fetches + renders the
  // asset into it. Opening a different asset while one is shown replaces the
  // content in place (single #asset-host). Opening the same asset just
  // re-expands. `_openId` doubles as the loader race guard: a late promise
  // from a superseded asset bails because `_openId` no longer matches.
  function open(id) {
    if (!id) return;
    var sheet = ensureSheet();

    if (_openId === id && _state !== "closed") { expand(); return; }

    _openId = id;
    expandFresh(sheet);

    var st = mountState(id);
    api.assets.get(id).then(function (asset) {
      if (_openId !== id) return;
      if (!asset) throw new Error("Asset not found");
      setHeader(asset);
      renderShell(asset, st);
      // Fire monitor + telemetry + IP history fetches in parallel — these
      // populate their respective sections independently.
      loadMonitor(id, st);
      loadTelemetry(id, st);
      loadSystemInfo(id, st, asset);
      loadSources(id, st);
      loadSightings(id, st);
      loadIpHistory(id, st);
    }).catch(function (err) {
      if (_openId !== id) return;
      var msg = (err && err.message) ? err.message : "Failed to load asset";
      var host = document.getElementById("asset-host");
      if (!host) return;
      host.innerHTML = ''
        + '<div class="empty-state" style="padding-top:64px;">'
        + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
        + '  <div class="ttl">Couldn’t load asset</div>'
        + '  <div class="desc">' + escapeHtml(msg) + '</div>'
        + '</div>';
    });
  }

  // Reset the sheet to a fresh expanded loading state (used by open()).
  function expandFresh(sheet) {
    sheet.classList.remove("peek");
    sheet.style.transform = "";
    var scrim = document.getElementById("asset-sheet-scrim");
    if (scrim) scrim.style.display = "";
    _state = "expanded";
    sheet.scrollTop = 0;
    var nameEl = document.getElementById("asset-sheet-name");
    if (nameEl) nameEl.textContent = "Asset";
    var dotEl = document.getElementById("asset-sheet-dot");
    if (dotEl) { dotEl.className = "dot"; dotEl.style.display = "none"; }
    var refreshBtn = document.getElementById("asset-sheet-refresh");
    if (refreshBtn) refreshBtn.style.display = "none"; // setHeader re-shows when monitored
    var host = document.getElementById("asset-host");
    if (host) host.innerHTML = '<div class="loading-screen"><div class="spinner"></div></div>';
  }

  // Deep-link shim: `#asset/<id>` routes still resolve (e.g. a pasted URL).
  // Render the assets list as a backdrop so dismissing reveals it, then open
  // the sheet over it. Does NOT push history — normal in-app navigation calls
  // open() directly.
  function render(body, ctx) {
    var id = (ctx && ctx.route && ctx.route.parts && ctx.route.parts[0]) || "";
    if (window.PolarisAssetsTab && PolarisAssetsTab.spec && PolarisAssetsTab.spec.render) {
      try {
        PolarisAssetsTab.spec.render(body, { user: ctx && ctx.user, route: { name: "assets", parts: [], full: "assets" } });
      } catch (_) { /* backdrop is best-effort */ }
    }
    if (id) open(id);
  }

  function renderShell(asset, st) {
    var host = document.getElementById("asset-host");
    if (!host) return;

    // The sheet header already shows the status dot + asset name, so the hero
    // omits the name line (it used to repeat it) and leads with the status
    // pill + identity bits.
    var monitorPillHtml = renderMonitorPill(asset);
    var heroBits = [];
    if (asset.ipAddress) heroBits.push('<span class="mono">' + escapeHtml(asset.ipAddress) + '</span>');
    var modelLine = [asset.manufacturer, asset.model].filter(Boolean).join(" ");
    if (modelLine) heroBits.push(escapeHtml(modelLine));
    if (asset.serialNumber) heroBits.push('<span class="mono">S/N ' + escapeHtml(asset.serialNumber) + '</span>');

    var rangeButtons = RANGES.map(function (r) {
      return '<button class="seg-item' + (r === st.range ? " on" : "") + '" data-range="' + r + '">' + r + '</button>';
    }).join("");

    host.innerHTML = ''
      + '<div class="asset-hero">'
      + (heroBits.length ? '  <div class="hero-sub">' + heroBits.join(" · ") + '</div>' : '')
      + '  <div style="margin-top:' + (heroBits.length ? '12px' : '0') + ';">' + monitorPillHtml + '</div>'
      + '</div>'

      // Response Time section — collapsed by default; subtitle shows
      // avg/max once the loader returns. `asset-monitor-sub` is the slot
      // the loader writes into.
      + sectionHeader("monitor", "Response Time", escapeHtml(monitorPillSubtext(asset)), st.sections.monitor, "asset-monitor-sub")
      + '<div class="sect-body" data-sect="monitor"' + (st.sections.monitor ? '' : ' hidden') + '>'
      + '  <div class="card-filled" style="padding:16px;margin-bottom:8px;">'
      + '    <div class="seg" id="asset-range-seg" style="display:inline-flex;border:1px solid var(--md-outline);border-radius:var(--shape-full);overflow:hidden;margin-bottom:8px;">' + rangeButtons + '</div>'
      + '    <div id="asset-monitor-chart" style="min-height:120px;"></div>'
      + '  </div>'
      + '</div>'

      // CPU + Memory section — collapsed by default; subtitle shows
      // cpu/mem avg/max once the loader returns.
      + sectionHeader("telemetry", "CPU + Memory", "", st.sections.telemetry, "asset-telemetry-sub")
      + '<div class="sect-body" data-sect="telemetry"' + (st.sections.telemetry ? '' : ' hidden') + '>'
      + '  <div class="card-filled" style="padding:16px;margin-bottom:8px;">'
      + '    <div id="asset-telemetry-chart" style="min-height:120px;"></div>'
      + '  </div>'
      + '</div>'

      // General section
      + sectionHeader("general", "General", "", st.sections.general)
      + '<div class="sect-body" data-sect="general"' + (st.sections.general ? '' : ' hidden') + '>'
      + renderGeneralBody(asset)
      + '</div>'

      // Temperatures section — populated by loadSystemInfo.
      + sectionHeader("temperatures", "Temperatures", "", st.sections.temperatures)
      + '<div class="sect-body" data-sect="temperatures"' + (st.sections.temperatures ? '' : ' hidden') + '>'
      + '  <div id="asset-temperatures-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
      + '</div>'

      // Interfaces section — populated by loadSystemInfo (operStatus=="up" only).
      + sectionHeader("interfaces", "Interfaces", "", st.sections.interfaces)
      + '<div class="sect-body" data-sect="interfaces"' + (st.sections.interfaces ? '' : ' hidden') + '>'
      + '  <div id="asset-interfaces-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
      + '</div>'

      // Discovery sources — which integrations independently reported this
      // asset. Header subtitle shows the source count once loaded.
      + sectionHeader("sources", "Discovery sources", "", st.sections.sources, "asset-sources-sub")
      + '<div class="sect-body" data-sect="sources"' + (st.sections.sources ? '' : ' hidden') + '>'
      + '  <div id="asset-sources-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
      + '</div>'

      // FortiGate sightings — which firewalls have seen this asset (needs
      // assetsQuarantine read; degrades to a muted note otherwise).
      + sectionHeader("sightings", "Firewall sightings", "", st.sections.sightings, "asset-sightings-sub")
      + '<div class="sect-body" data-sect="sightings"' + (st.sections.sightings ? '' : ' hidden') + '>'
      + '  <div id="asset-sightings-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
      + '</div>'

      // IP history section
      + sectionHeader("ipHistory", "IP history", "", st.sections.ipHistory, "asset-ip-history-sub")
      + '<div class="sect-body" data-sect="ipHistory"' + (st.sections.ipHistory ? '' : ' hidden') + '>'
      + '  <div id="asset-ip-history-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
      + '</div>';

    // Section toggles
    document.querySelectorAll(".asset-sect-header").forEach(function (h) {
      h.addEventListener("click", function () {
        var key = h.dataset.key;
        st.sections[key] = !st.sections[key];
        var body = document.querySelector('.sect-body[data-sect="' + key + '"]');
        var caret = h.querySelector(".caret");
        if (body) {
          if (st.sections[key]) body.removeAttribute("hidden");
          else body.setAttribute("hidden", "");
        }
        // The icon is the <use> child's href — setting it on the <svg> does
        // nothing, which is why the chevron never flipped.
        if (caret) {
          var useEl = caret.querySelector("use");
          if (useEl) useEl.setAttribute("href", st.sections[key] ? "#i-chev-down" : "#i-chev-right");
        }
      });
    });

    // Range segmented control
    var seg = document.getElementById("asset-range-seg");
    if (seg) seg.querySelectorAll(".seg-item").forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.dataset.range === st.range) return;
        st.range = b.dataset.range;
        seg.querySelectorAll(".seg-item").forEach(function (x) {
          x.classList.toggle("on", x.dataset.range === st.range);
        });
        loadMonitor(asset.id, st);
        loadTelemetry(asset.id, st);
      });
    });
    // Back/refresh now live in the sheet header (wired once in ensureSheet).
  }

  // `subtitleHtml` is rendered raw (callers escape their own text). Pass
  // `subtitleId` when a loader needs to update the subtitle asynchronously
  // — the slot is always rendered so the loader can write into it even if
  // the initial subtitle is empty.
  function sectionHeader(key, title, subtitleHtml, expanded, subtitleId) {
    var subId = subtitleId ? ' id="' + subtitleId + '"' : '';
    return ''
      + '<button class="asset-sect-header" data-key="' + key + '">'
      + '  <div style="flex:1;text-align:left;min-width:0;">'
      + '    <div class="sect-title">' + escapeHtml(title) + '</div>'
      + '    <div class="sect-sub"' + subId + '>' + (subtitleHtml || "") + '</div>'
      + '  </div>'
      + '  <svg class="caret" viewBox="0 0 24 24" width="24" height="24" style="fill:var(--md-on-surface-variant);flex-shrink:0;"><use href="' + (expanded ? "#i-chev-down" : "#i-chev-right") + '"/></svg>'
      + '</button>';
  }

  function renderGeneralBody(asset) {
    var rows = [];
    function row(k, v) { if (v != null && v !== "") rows.push({ k: k, v: v }); }
    row("Type", asset.assetType);
    row("IP", asset.ipAddress ? '<span class="mono">' + escapeHtml(asset.ipAddress) + '</span>' : null);
    row("MAC", asset.macAddress ? '<span class="mono">' + escapeHtml(asset.macAddress) + '</span>' : null);
    row("Hostname", asset.hostname);
    row("DNS name", asset.dnsName);
    row("Serial", asset.serialNumber ? '<span class="mono">' + escapeHtml(asset.serialNumber) + '</span>' : null);
    row("Manufacturer", asset.manufacturer);
    row("Model", asset.model);
    row("OS", [asset.os, asset.osVersion].filter(Boolean).join(" "));
    row("Location", asset.location || asset.learnedLocation);
    row("Department", asset.department);
    row("Assigned to", asset.assignedTo);
    row("Last seen", formatTimeAgo(asset.lastSeen));
    row("Last seen port", asset.lastSeenSwitch
      ? '<span class="mono">' + escapeHtml(asset.lastSeenSwitch) + '</span>'
      : null);
    row("Acquired", formatDate(asset.acquiredAt));

    if (rows.length === 0) {
      return '<div class="muted" style="padding:8px 16px 16px;">No additional details.</div>';
    }
    return rows.map(function (r) {
      return ''
        + '<div class="kv-row">'
        + '  <span class="k">' + escapeHtml(r.k) + '</span>'
        + '  <span class="v">' + (typeof r.v === "string" && r.v.indexOf("<") === 0 ? r.v : escapeHtml(r.v)) + '</span>'
        + '</div>';
    }).join("");
  }

  // ─── Loaders ───────────────────────────────────────────────────────────
  function loadMonitor(id, st) {
    var chartHost = document.getElementById("asset-monitor-chart");
    var sub = document.getElementById("asset-monitor-sub");
    if (chartHost) chartHost.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';

    api.assets.monitorHistory(id, st.range).then(function (resp) {
      if (_openId !== id || !resp) return;   // bail if a newer asset replaced us
      var samples = (resp.samples || []).map(function (s) {
        return { ts: s.timestamp, v: s.responseTimeMs };
      });
      if (chartHost) {
        chartHost.innerHTML = PolarisCharts.lineChart({
          series: [{ values: samples, color: "var(--md-primary)", fill: true }],
          height: 120,
          yUnit: "ms",
          ariaLabel: "Response time over " + st.range,
        });
      }
      if (sub) {
        var stats = resp.stats || {};
        var statBits = [];
        if (stats.avgMs != null) statBits.push("avg " + stats.avgMs + " ms");
        if (stats.maxMs != null) statBits.push("max " + stats.maxMs + " ms");
        if (stats.packetLossRate != null && stats.packetLossRate > 0) {
          statBits.push((stats.packetLossRate * 100).toFixed(1) + "% loss");
        }
        sub.textContent = statBits.length ? statBits.join(" · ") : "No samples";
      }
    }).catch(function (err) {
      if (chartHost) chartHost.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">Couldn’t load monitor history: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
      if (sub) sub.textContent = "—";
    });
  }

  function loadTelemetry(id, st) {
    var chartHost = document.getElementById("asset-telemetry-chart");
    var sub = document.getElementById("asset-telemetry-sub");
    if (chartHost) chartHost.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';

    api.assets.telemetryHistory(id, st.range).then(function (resp) {
      if (_openId !== id || !resp) return;   // bail if a newer asset replaced us
      var samples = resp.samples || [];
      var cpuSeries = samples
        .filter(function (s) { return s.cpuPct != null; })
        .map(function (s) { return { ts: s.timestamp, v: s.cpuPct }; });
      var memSeries = samples
        .filter(function (s) { return s.memPct != null || (s.memUsedBytes != null && s.memTotalBytes); })
        .map(function (s) {
          var pct = s.memPct != null
            ? s.memPct
            : (s.memTotalBytes ? (Number(s.memUsedBytes) / Number(s.memTotalBytes)) * 100 : null);
          return { ts: s.timestamp, v: pct };
        })
        .filter(function (p) { return p.v != null; });

      if (cpuSeries.length === 0 && memSeries.length === 0) {
        if (chartHost) chartHost.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">No telemetry — this monitor type doesn’t collect CPU/memory.</div>';
        if (sub) sub.textContent = "Not collected for this monitor type";
        return;
      }
      if (chartHost) {
        chartHost.innerHTML = PolarisCharts.lineChart({
          series: [
            { values: cpuSeries, color: "var(--md-primary)" },
            { values: memSeries, color: "var(--md-tertiary)" },
          ],
          height: 120,
          yMin: 0, yMax: 100,
          yUnit: "%",
          ariaLabel: "CPU and memory over " + st.range,
        });
      }
      if (sub) {
        var stats = resp.stats || {};
        var bits = [];
        if (stats.avgCpuPct != null) bits.push('<span style="color:var(--md-primary);">cpu avg ' + Math.round(stats.avgCpuPct) + "%</span>");
        if (stats.maxCpuPct != null) bits.push("max " + Math.round(stats.maxCpuPct) + "%");
        if (stats.avgMemPct != null) bits.push('<span style="color:var(--md-tertiary);">mem avg ' + Math.round(stats.avgMemPct) + "%</span>");
        if (stats.maxMemPct != null) bits.push("max " + Math.round(stats.maxMemPct) + "%");
        sub.innerHTML = bits.length ? bits.join(" · ") : "No samples";
      }
    }).catch(function (err) {
      if (chartHost) chartHost.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">Couldn’t load telemetry: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
      if (sub) sub.textContent = "—";
    });
  }

  // Fetch system-info (current interfaces + temperatures + LLDP) and 1h
  // temperature samples for per-sensor min/avg/max. The two requests are
  // independent so they fly in parallel.
  function loadSystemInfo(id, st, asset) {
    if (asset) _assetCache[id] = asset;
    var resolvedAsset = asset || _assetCache[id] || null;
    var tempsHost  = document.getElementById("asset-temperatures-host");
    var ifacesHost = document.getElementById("asset-interfaces-host");
    if (!tempsHost && !ifacesHost) return;
    if (tempsHost)  tempsHost.innerHTML  = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    if (ifacesHost) ifacesHost.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';

    Promise.all([
      api.assets.systemInfo(id).catch(function (e) { return { error: e }; }),
      api.assets.temperatureHistory(id, { range: "1h" }).catch(function () { return null; }),
    ]).then(function (results) {
      if (_openId !== id) return;   // bail if a newer asset replaced us
      var info = results[0] || {};
      var tempHist = results[1] || null;

      if (info.error) {
        var msg = (info.error && info.error.message) ? info.error.message : "error";
        if (tempsHost)  tempsHost.innerHTML  = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t load temperatures: ' + escapeHtml(msg) + '</div>';
        if (ifacesHost) ifacesHost.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t load interfaces: ' + escapeHtml(msg) + '</div>';
        return;
      }

      // Cache for the interface-sheet open path so we don't re-fetch.
      _systemInfoCache[id] = info;

      if (tempsHost)  renderTemperatures(tempsHost, info, tempHist);
      if (ifacesHost) renderInterfaces(ifacesHost, info, id, st, resolvedAsset);
    });
  }

  // Per-asset cache of the latest /system-info payload so the bottom sheet
  // can render details without re-fetching. Re-populated on every loadSystemInfo.
  var _systemInfoCache = Object.create(null);
  // Per-asset cache of the Asset row itself so async loaders (Refresh, the
  // interfaces toggle) can read fields like `monitoredInterfaces` without
  // re-fetching.
  var _assetCache = Object.create(null);

  function renderTemperatures(host, info, tempHist) {
    var temps = (info && info.temperatures) || [];
    if (temps.length === 0) {
      host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No sensors reported.</div>';
      return;
    }
    // Aggregate the unfiltered 1h samples by sensorName so we get per-sensor
    // min/avg/max in one round-trip instead of N. AssetTemperatureSample rows
    // carry sensorName + celsius directly.
    var byName = Object.create(null);
    var samples = (tempHist && tempHist.samples) || [];
    samples.forEach(function (s) {
      if (s.celsius == null || !s.sensorName) return;
      var b = byName[s.sensorName] || (byName[s.sensorName] = { sum: 0, n: 0, min: Infinity, max: -Infinity });
      b.sum += Number(s.celsius);
      b.n   += 1;
      if (s.celsius < b.min) b.min = Number(s.celsius);
      if (s.celsius > b.max) b.max = Number(s.celsius);
    });

    var html = "";
    temps.forEach(function (t, i) {
      var b = byName[t.sensorName];
      var statsLine = "";
      if (b && b.n > 0) {
        var avg = b.sum / b.n;
        statsLine = "1h · min " + b.min.toFixed(1) + "° · avg " + avg.toFixed(1) + "° · max " + b.max.toFixed(1) + "°";
      } else {
        statsLine = "no 1h history";
      }
      var current = (t.celsius != null) ? Math.round(t.celsius * 10) / 10 + "°C" : "—";
      html += ''
        + '<div class="list-item two-line" style="padding-left:16px;padding-right:16px;">'
        + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-temp"/></svg></span>'
        + '  <div class="content">'
        + '    <div class="headline">' + escapeHtml(t.sensorName || "sensor") + '</div>'
        + '    <div class="supporting">' + escapeHtml(statsLine) + '</div>'
        + '  </div>'
        + '  <span class="trailing mono" style="font-weight:600;">' + escapeHtml(current) + '</span>'
        + '</div>'
        + (i < temps.length - 1 ? '<div class="list-divider"></div>' : '');
    });
    host.innerHTML = html;
  }

  // Default view: only `Asset.monitoredInterfaces` (the operator-pinned
  // fast-poll subset) — these are the interfaces the operator cares about,
  // and pinned-but-currently-down ones are kept so the operator can see
  // the outage. Expanded view: every interface whose latest sample reports
  // operStatus==="up", regardless of pinning. The "Show all / Show
  // monitored only" button at the bottom of the section flips
  // `st.interfacesShowAll` and re-renders.
  function renderInterfaces(host, info, assetId, st, asset) {
    var ifaces = (info && info.interfaces) || [];
    var monitoredSet = Object.create(null);
    var monitoredArr = (asset && asset.monitoredInterfaces) || [];
    monitoredArr.forEach(function (n) { if (n) monitoredSet[n] = true; });

    var allUp = ifaces.filter(function (i) { return (i.operStatus || "").toLowerCase() === "up"; });
    var monitored = ifaces.filter(function (i) { return monitoredSet[i.ifName]; });

    function cmp(a, b) {
      var an = (a.alias || a.ifName || "").toLowerCase();
      var bn = (b.alias || b.ifName || "").toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    }
    allUp.sort(cmp);
    monitored.sort(cmp);

    var showAll = !!(st && st.interfacesShowAll);
    var visible = showAll ? allUp : monitored;

    var listHtml = "";
    if (visible.length === 0) {
      if (!showAll && monitoredArr.length === 0) {
        listHtml = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No interfaces monitored. Tap <b>Show all</b> to browse every up interface.</div>';
      } else if (!showAll) {
        // monitoredArr non-empty but no matching samples yet (heavy cadence hasn't fired).
        listHtml = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Monitored interfaces pinned but no samples yet.</div>';
      } else {
        listHtml = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No interfaces up.</div>';
      }
    } else {
      visible.forEach(function (iface, i) {
        var label = iface.alias || iface.ifName || "(unnamed)";
        var sub   = iface.alias && iface.ifName && iface.alias !== iface.ifName
          ? iface.ifName
          : (iface.ipAddress || "");
        var speed = (iface.speedBps != null) ? formatBps(iface.speedBps) : "";
        var idx   = String(i);
        // operStatus drives the leading status dot — pinned-but-down monitored
        // interfaces should look down, not up, when the operator opens the section.
        var statusCls = (iface.operStatus || "").toLowerCase() === "up" ? "up" : "down";
        listHtml += ''
          + '<div class="list-item two-line iface-row" data-iface-idx="' + escapeHtml(idx) + '" role="button" tabindex="0" style="padding-left:16px;padding-right:16px;cursor:pointer;">'
          + '  <span class="leading"><span class="dot ' + statusCls + '" style="display:inline-block;width:10px;height:10px;border-radius:50%;"></span></span>'
          + '  <div class="content">'
          + '    <div class="headline">' + escapeHtml(label) + '</div>'
          + (sub ? '    <div class="supporting mono">' + escapeHtml(sub) + '</div>' : '')
          + '  </div>'
          + '  <span class="trailing muted mono" style="font-size:12px;">' + escapeHtml(speed) + '</span>'
          + '</div>'
          + (i < visible.length - 1 ? '<div class="list-divider"></div>' : '');
      });
    }

    var btnLabel = showAll
      ? "Show monitored only"
      : "Show all" + (allUp.length ? " (" + allUp.length + ")" : "");
    var toggleHtml = ''
      + '<div style="padding:12px 16px 4px;">'
      + '  <button class="btn btn-tonal" id="iface-show-all-btn" style="width:100%;">' + escapeHtml(btnLabel) + '</button>'
      + '</div>';

    host.innerHTML = listHtml + toggleHtml;

    // Wire row taps — index into the same `visible` list rendered above.
    host.querySelectorAll(".iface-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var idx = parseInt(row.dataset.ifaceIdx, 10);
        if (isNaN(idx)) return;
        openInterfaceSheet(visible[idx], info, assetId);
      });
    });

    // Wire the toggle — flips state and re-renders against the same data.
    var toggleBtn = document.getElementById("iface-show-all-btn");
    if (toggleBtn) toggleBtn.addEventListener("click", function () {
      if (st) st.interfacesShowAll = !st.interfacesShowAll;
      renderInterfaces(host, info, assetId, st, asset);
    });
  }

  // ─── Interface bottom sheet ────────────────────────────────────────────
  // Reuses the .sheet + .scrim pattern from map-tab.js for consistency.
  function openInterfaceSheet(iface, info, assetId) {
    closeInterfaceSheet();

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "iface-sheet-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "iface-sheet";

    var title = iface.alias || iface.ifName || "Interface";
    var ifSubtitle = (iface.alias && iface.ifName && iface.alias !== iface.ifName) ? iface.ifName : "";

    // Rows: status, speed, ip, mac, errors. Keep it tight.
    var rows = [];
    function row(k, v, mono) {
      if (v == null || v === "") return;
      rows.push({ k: k, v: v, mono: !!mono });
    }
    var statusBits = [];
    if (iface.operStatus)  statusBits.push("oper " + iface.operStatus);
    if (iface.adminStatus) statusBits.push("admin " + iface.adminStatus);
    row("Status", statusBits.join(" · "));
    row("Speed", iface.speedBps != null ? formatBps(iface.speedBps) : null);
    if (iface.ifType) row("Type", iface.ifType + (iface.vlanId != null ? " · VLAN " + iface.vlanId : ""));
    row("IP",  iface.ipAddress, true);
    row("MAC", iface.macAddress, true);
    row("In errors",  iface.inErrors  != null ? String(iface.inErrors)  : null);
    row("Out errors", iface.outErrors != null ? String(iface.outErrors) : null);

    var detailRowsHtml = rows.map(function (r) {
      var v = r.mono ? '<span class="mono">' + escapeHtml(r.v) + '</span>' : escapeHtml(r.v);
      return ''
        + '<div class="kv-row">'
        + '  <span class="k">' + escapeHtml(r.k) + '</span>'
        + '  <span class="v">' + v + '</span>'
        + '</div>';
    }).join("");

    // LLDP neighbors on this localIfName — drawn from the cached system-info
    // payload. Peer-inferred rows are included server-side so they render here too.
    var allNeighbors = (info && info.lldpNeighbors) || [];
    var neighbors = allNeighbors.filter(function (n) { return n.localIfName === iface.ifName; });
    var neighborHtml = "";
    if (neighbors.length === 0) {
      neighborHtml = '<div class="muted" style="padding:4px 0 0;font-size:13px;">No LLDP neighbor seen.</div>';
    } else {
      neighborHtml = neighbors.map(function (n) {
        var headline = n.systemName || n.managementIp || n.chassisId || "(unknown)";
        var portBit  = n.portId ? '<span class="mono">' + escapeHtml(n.portId) + '</span>' : "";
        var metaBits = [];
        if (n.managementIp) metaBits.push('<span class="mono">' + escapeHtml(n.managementIp) + '</span>');
        if (n.chassisId && n.chassisId !== n.managementIp) metaBits.push('<span class="mono">' + escapeHtml(n.chassisId) + '</span>');
        if (n.source === "peer-inferred") metaBits.push('<em>inferred</em>');
        var matchBtn = "";
        if (n.matchedAsset && n.matchedAsset.id) {
          matchBtn = '<button class="btn btn-tonal iface-neighbor-pivot" data-asset-id="' + escapeHtml(n.matchedAsset.id) + '" style="margin-top:8px;"><svg viewBox="0 0 24 24"><use href="#i-server"/></svg>View asset</button>';
        }
        return ''
          + '<div class="card-filled" style="padding:12px;margin-bottom:8px;">'
          + '  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">'
          + '    <div style="min-width:0;font-weight:500;">' + escapeHtml(headline) + '</div>'
          + '    <div style="font-size:12px;">' + portBit + '</div>'
          + '  </div>'
          + (metaBits.length ? '  <div class="muted" style="font-size:12px;margin-top:4px;">' + metaBits.join(" · ") + '</div>' : '')
          + (n.systemDescription ? '  <div class="muted" style="font-size:12px;margin-top:4px;">' + escapeHtml(n.systemDescription) + '</div>' : '')
          + matchBtn
          + '</div>';
      }).join("");
    }

    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px;">'
      + '  <div style="min-width:0;">'
      + '    <h3 class="sheet-title" style="margin:0 0 4px;">' + escapeHtml(title) + '</h3>'
      + (ifSubtitle ? '    <div class="muted mono" style="font-size:13px;">' + escapeHtml(ifSubtitle) + '</div>' : '')
      + '  </div>'
      + '  <button class="icon-btn" id="iface-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + detailRowsHtml
      + '<div style="font-weight:500;margin:16px 0 8px;">Neighbor</div>'
      + neighborHtml;

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeInterfaceSheet);
    document.getElementById("iface-sheet-close").addEventListener("click", closeInterfaceSheet);
    PolarisTabs.attachSwipeToDismiss(sheet, closeInterfaceSheet);
    sheet.querySelectorAll(".iface-neighbor-pivot").forEach(function (b) {
      b.addEventListener("click", function () {
        var nid = b.dataset.assetId;
        closeInterfaceSheet();
        if (nid) open(nid);   // replace the sheet content in place with the neighbor
      });
    });
  }

  function closeInterfaceSheet() {
    var s = document.getElementById("iface-sheet");
    var sc = document.getElementById("iface-sheet-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }

  function formatBps(bps) {
    if (bps == null) return "";
    var n = Number(bps);
    if (!isFinite(n) || n <= 0) return "";
    if (n >= 1e9) return (n / 1e9) + " Gbps";
    if (n >= 1e6) return (n / 1e6) + " Mbps";
    if (n >= 1e3) return (n / 1e3) + " Kbps";
    return n + " bps";
  }

  // Discovery sources — which integrations independently reported this asset.
  function loadSources(id, st) {
    var host = document.getElementById("asset-sources-host");
    var sub  = document.getElementById("asset-sources-sub");
    if (!host) return;
    api.assets.getSources(id).then(function (resp) {
      if (_openId !== id) return;   // bail if a newer asset replaced us
      var rows = Array.isArray(resp) ? resp : [];
      if (sub) sub.textContent = rows.length ? rows.length + (rows.length === 1 ? " source" : " sources") : "none";
      if (rows.length === 0) {
        host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No discovery sources recorded.</div>';
        return;
      }
      var html = "";
      rows.forEach(function (s, i) {
        var label = SOURCE_LABELS[s.sourceKind] || s.sourceKind;
        var bits = [];
        if (s.integration && s.integration.name) bits.push(escapeHtml(s.integration.name));
        if (s.lastSeen) bits.push("seen " + escapeHtml(formatTimeAgo(s.lastSeen)));
        var inferred = s.inferred ? ' <span class="muted" style="font-size:12px;font-weight:400;">· inferred</span>' : '';
        var extId = s.externalId
          ? '<div class="mono" style="font-size:11px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(s.externalId) + '</div>'
          : '';
        html += ''
          + '<div class="list-item two-line" style="padding-left:16px;padding-right:16px;">'
          + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-server"/></svg></span>'
          + '  <div class="content">'
          + '    <div class="headline">' + escapeHtml(label) + inferred + '</div>'
          + '    <div class="supporting">' + bits.join(" · ") + extId + '</div>'
          + '  </div>'
          + '</div>'
          + (i < rows.length - 1 ? '<div class="list-divider"></div>' : '');
      });
      host.innerHTML = html;
    }).catch(function (err) {
      if (_openId !== id) return;
      if (sub) sub.textContent = "—";
      host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t load sources: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
    });
  }

  // FortiGate sightings — which firewalls have seen this asset, enriched with
  // subnet/VLAN server-side. Endpoint needs `assetsQuarantine read`; lower-
  // privilege roles get an error which we surface as a muted note.
  function loadSightings(id, st) {
    var host = document.getElementById("asset-sightings-host");
    var sub  = document.getElementById("asset-sightings-sub");
    if (!host) return;
    api.assets.getSightings(id).then(function (resp) {
      if (_openId !== id) return;   // bail if a newer asset replaced us
      var rows = Array.isArray(resp) ? resp : [];
      if (sub) sub.textContent = rows.length ? rows.length + (rows.length === 1 ? " firewall" : " firewalls") : "none";
      if (rows.length === 0) {
        host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No firewall sightings.</div>';
        return;
      }
      var html = "";
      rows.forEach(function (s, i) {
        var bits = [];
        if (s.ipAddress) bits.push('<span class="mono">' + escapeHtml(s.ipAddress) + '</span>');
        var netParts = [];
        if (s.subnetName) netParts.push(escapeHtml(s.subnetName));
        if (s.vlan != null) netParts.push("VLAN " + escapeHtml(String(s.vlan)));
        if (netParts.length) bits.push(netParts.join(" "));
        if (s.source) bits.push(escapeHtml(s.source));
        if (s.lastSeen) bits.push("seen " + escapeHtml(formatTimeAgo(s.lastSeen)));
        html += ''
          + '<div class="list-item two-line" style="padding-left:16px;padding-right:16px;">'
          + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-router"/></svg></span>'
          + '  <div class="content">'
          + '    <div class="headline">' + escapeHtml(s.fortigateDevice || "?") + '</div>'
          + '    <div class="supporting">' + bits.join(" · ") + '</div>'
          + '  </div>'
          + '</div>'
          + (i < rows.length - 1 ? '<div class="list-divider"></div>' : '');
      });
      host.innerHTML = html;
    }).catch(function (err) {
      if (_openId !== id) return;
      if (sub) sub.textContent = "—";
      host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t load firewall sightings: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
    });
  }

  function loadIpHistory(id, st) {
    var host = document.getElementById("asset-ip-history-host");
    var sub  = document.getElementById("asset-ip-history-sub");
    if (!host) return;
    api.assets.getIpHistory(id).then(function (resp) {
      if (_openId !== id) return;   // bail if a newer asset replaced us
      // The endpoint returns a bare array — not `{ history: [...] }`.
      var rows = Array.isArray(resp) ? resp : ((resp && resp.history) || []);
      if (sub) sub.textContent = rows.length ? rows.length + (rows.length === 1 ? " address" : " addresses") : "none";
      if (rows.length === 0) {
        host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No IP history recorded yet.</div>';
        return;
      }
      var html = "";
      rows.forEach(function (r, i) {
        html += ''
          + '<div class="list-item two-line" style="padding-left:16px;padding-right:16px;">'
          + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-history"/></svg></span>'
          + '  <div class="content">'
          + '    <div class="headline mono">' + escapeHtml(r.ip || "") + '</div>'
          + '    <div class="supporting">' + escapeHtml((r.source ? r.source + " · " : "") + (formatTimeAgo(r.lastSeen) || "")) + '</div>'
          + '  </div>'
          + '</div>'
          + (i < rows.length - 1 ? '<div class="list-divider"></div>' : '');
      });
      host.innerHTML = html;
    }).catch(function (err) {
      if (_openId !== id) return;
      if (sub) sub.textContent = "—";
      host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t load IP history: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
    });
  }

  function onRefresh(id, btn, st) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span>';
    api.assets.probeNow(id).then(function (resp) {
      // Reflect what each stream did so the operator knows whether it
      // was a partial failure (matches desktop "Refresh partial" toast).
      var bits = [];
      if (resp.success) bits.push("probe " + (resp.responseTimeMs != null ? resp.responseTimeMs + " ms" : "ok"));
      else if (resp.error) bits.push("probe failed");
      if (resp.telemetry) {
        if (resp.telemetry.collected) bits.push("telemetry");
        else if (resp.telemetry.error) bits.push("telemetry: " + resp.telemetry.error);
      }
      if (resp.systemInfo) {
        if (resp.systemInfo.collected) bits.push("system-info");
        else if (resp.systemInfo.error) bits.push("system-info: " + resp.systemInfo.error);
      }
      var anyFailure = (resp.success === false) ||
        (resp.telemetry && resp.telemetry.collected === false && resp.telemetry.error) ||
        (resp.systemInfo && resp.systemInfo.collected === false && resp.systemInfo.error);
      PolarisTabs.showSnackbar((anyFailure ? "Refresh partial — " : "Refresh ok — ") + bits.join(" · "), { error: !!anyFailure });
      // Repull the charts + system-info sections.
      loadMonitor(id, st);
      loadTelemetry(id, st);
      loadSystemInfo(id, st);
    }).catch(function (err) {
      var msg = (err && err.message) ? err.message : "Refresh failed";
      PolarisTabs.showSnackbar("Refresh failed — " + msg, { error: true });
    }).finally(function () {
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg>';
    });
  }

  // ─── helpers ───────────────────────────────────────────────────────────
  function monitorDotCls(asset) {
    if (!asset.monitored) return "";
    if (asset.dependencySuppressed && asset.monitorStatus !== "down") return "dep-down";
    switch (asset.monitorStatus) {
      case "up": return "up";
      case "down": return "down";
      case "unknown": return "unk";
      default: return "unk";
    }
  }

  function renderMonitorPill(asset) {
    if (!asset.monitored) return '<span class="status-pill unk">Unmonitored</span>';
    if (asset.dependencySuppressed && asset.monitorStatus !== "down") {
      var layerBit = (asset.dependencyLayer != null) ? " (Layer " + asset.dependencyLayer + ")" : "";
      return '<span class="status-pill dep-down"><span class="dot dep-down"></span>Dep. Down' + layerBit + '</span>';
    }
    var rttBit = (asset.lastResponseTimeMs != null) ? " · " + asset.lastResponseTimeMs + " ms" : "";
    switch (asset.monitorStatus) {
      case "up":      return '<span class="status-pill up"><span class="dot up"></span>Up' + rttBit + '</span>';
      case "down":    return '<span class="status-pill down"><span class="dot down"></span>Down — ' + (asset.consecutiveFailures || 0) + ' consecutive fails</span>';
      case "unknown": return '<span class="status-pill unk"><span class="dot unk"></span>No samples yet</span>';
      default:        return '<span class="status-pill unk"><span class="dot unk"></span>Monitored</span>';
    }
  }

  function monitorPillSubtext(asset) {
    if (!asset.monitored) return "";
    var bits = [];
    if (asset.dependencySuppressed && asset.monitorStatus !== "down") bits.push("upstream parent down");
    if (asset.responseTimePolling) bits.push(asset.responseTimePolling);
    if (asset.lastMonitorAt) bits.push("last poll " + formatTimeAgo(asset.lastMonitorAt));
    return bits.join(" · ");
  }

  function formatTimeAgo(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (sec < 60)    return sec + "s ago";
    if (sec < 3600)  return Math.floor(sec / 60) + "m ago";
    if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
    return Math.floor(sec / 86400) + "d ago";
  }
  function formatDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Pull-to-refresh path — same backend work the topbar Refresh button
  // does (probe-now + repull monitor/telemetry/system-info), but returns a
  // promise so the PTR puck can spin until it settles. Snackbar still
  // fires so the operator gets the same per-stream outcome message.
  function refreshFromPtr(ctx) {
    var id = (ctx && ctx.route && ctx.route.parts && ctx.route.parts[0]) || "";
    if (!id) return null;
    var st = mountState(id);
    return api.assets.probeNow(id).then(function (resp) {
      var bits = [];
      if (resp.success) bits.push("probe " + (resp.responseTimeMs != null ? resp.responseTimeMs + " ms" : "ok"));
      else if (resp.error) bits.push("probe failed");
      if (resp.telemetry) {
        if (resp.telemetry.collected) bits.push("telemetry");
        else if (resp.telemetry.error) bits.push("telemetry: " + resp.telemetry.error);
      }
      if (resp.systemInfo) {
        if (resp.systemInfo.collected) bits.push("system-info");
        else if (resp.systemInfo.error) bits.push("system-info: " + resp.systemInfo.error);
      }
      var anyFailure = (resp.success === false) ||
        (resp.telemetry && resp.telemetry.collected === false && resp.telemetry.error) ||
        (resp.systemInfo && resp.systemInfo.collected === false && resp.systemInfo.error);
      PolarisTabs.showSnackbar((anyFailure ? "Refresh partial — " : "Refresh ok — ") + bits.join(" · "), { error: !!anyFailure });
      loadMonitor(id, st);
      loadTelemetry(id, st);
      loadSystemInfo(id, st);
    }).catch(function (err) {
      var msg = (err && err.message) ? err.message : "Refresh failed";
      PolarisTabs.showSnackbar("Refresh failed — " + msg, { error: true });
    });
  }

  window.PolarisAssetDetail = {
    open: open,
    spec: {
      parentTab: "assets",
      // No topbar — the slide-up sheet carries its own header.
      renderTopbar: function () { return ""; },
      render: render,
      onPullToRefresh: refreshFromPtr,
    },
  };
})();
