// public/js/mobile/asset-detail.js — Asset detail screen.
//
// Sections (top to bottom):
//   - Hero with name + status + Refresh action
//   - Monitor section (response-time chart, status pill, RTT/last poll)
//   - Telemetry section (CPU+Memory chart, when supported)
//   - General section (IP/MAC/type/model/OS/location/last seen)
//   - Temperatures section — current per-sensor reading + 1h min/avg/max
//   - Interfaces section — operStatus=="up" only; tap a row opens a bottom
//     sheet with status / speed / ip / mac / errors / LLDP neighbor(s)
//   - IP history list
//
// Out of scope for v1 (desktop-only):
//   - Per-interface throughput + errors charts
//   - Per-interface comments editor
//   - IPsec tunnels
//   - SNMP walk
//   - Per-source observed blob view

(function () {
  // Single shared chart range — driven by the 24h/7d segmented control on
  // the Monitor card. Telemetry chart follows the same range so both
  // sections move together when the operator switches windows.
  var DEFAULT_RANGE = "24h";
  var RANGES = ["1h", "24h", "7d", "30d"];

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
          ipHistory: false,
        },
      };
    }
    return _mounts[id];
  }

  function render(body, ctx) {
    var id = (ctx.route && ctx.route.parts && ctx.route.parts[0]) || "";
    if (!id) {
      body.innerHTML = '<div class="empty-state" style="padding-top:64px;"><div class="ttl">Asset id missing</div></div>';
      return;
    }
    var st = mountState(id);

    body.innerHTML = '<div id="asset-host"><div class="loading-screen"><div class="spinner"></div></div></div>';

    api.assets.get(id).then(function (asset) {
      if (!asset) throw new Error("Asset not found");
      renderShell(asset, st);
      // Fire monitor + telemetry + IP history fetches in parallel — these
      // populate their respective sections independently.
      loadMonitor(id, st);
      loadTelemetry(id, st);
      loadSystemInfo(id, st);
      loadIpHistory(id, st);
    }).catch(function (err) {
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

  function renderTopbar(ctx) {
    return ''
      + '<div class="m3-topbar">'
      + '  <div class="leading">'
      + '    <button class="icon-btn" id="asset-back-btn" aria-label="Back"><svg viewBox="0 0 24 24"><use href="#i-back"/></svg></button>'
      + '  </div>'
      + '  <div class="title" id="asset-topbar-title">Asset</div>'
      + '  <div class="trailing">'
      + '    <button class="icon-btn" id="asset-refresh-btn" aria-label="Refresh"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
      + '  </div>'
      + '</div>';
  }

  function renderShell(asset, st) {
    var host = document.getElementById("asset-host");
    if (!host) return;

    var topbarTitle = document.getElementById("asset-topbar-title");
    if (topbarTitle) topbarTitle.textContent = asset.hostname || asset.assetTag || "Asset";

    var dotCls = monitorDotCls(asset);
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
      + '  <div class="hero-name">'
      + (dotCls ? '    <span class="dot ' + dotCls + '"></span>' : '')
      + '    <span>' + escapeHtml(asset.hostname || asset.assetTag || "asset") + '</span>'
      + '  </div>'
      + '  <div class="hero-sub">' + heroBits.join(" · ") + '</div>'
      + '  <div style="margin-top:12px;">' + monitorPillHtml + '</div>'
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

      // IP history section
      + sectionHeader("ipHistory", "IP history", "", st.sections.ipHistory)
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
        if (caret) caret.setAttribute("href", st.sections[key] ? "#i-chev-down" : "#i-chev-right");
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

    // Topbar back + refresh wiring
    var back = document.getElementById("asset-back-btn");
    if (back) back.addEventListener("click", function () {
      if (window.history.length > 1) window.history.back();
      else PolarisRouter.go("assets", { replace: true });
    });
    var refresh = document.getElementById("asset-refresh-btn");
    if (refresh) refresh.addEventListener("click", function () { onRefresh(asset.id, refresh, st); });
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
      if (!resp) return;
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
      if (!resp) return;
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
  function loadSystemInfo(id, st) {
    var tempsHost  = document.getElementById("asset-temperatures-host");
    var ifacesHost = document.getElementById("asset-interfaces-host");
    if (!tempsHost && !ifacesHost) return;
    if (tempsHost)  tempsHost.innerHTML  = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    if (ifacesHost) ifacesHost.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';

    Promise.all([
      api.assets.systemInfo(id).catch(function (e) { return { error: e }; }),
      api.assets.temperatureHistory(id, { range: "1h" }).catch(function () { return null; }),
    ]).then(function (results) {
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
      if (ifacesHost) renderInterfaces(ifacesHost, info, id);
    });
  }

  // Per-asset cache of the latest /system-info payload so the bottom sheet
  // can render details without re-fetching. Re-populated on every loadSystemInfo.
  var _systemInfoCache = Object.create(null);

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

  function renderInterfaces(host, info, assetId) {
    var ifaces = (info && info.interfaces) || [];
    var up = ifaces.filter(function (i) { return (i.operStatus || "").toLowerCase() === "up"; });
    if (up.length === 0) {
      host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No interfaces up.</div>';
      return;
    }
    // Stable order: by alias/ifName.
    up.sort(function (a, b) {
      var an = (a.alias || a.ifName || "").toLowerCase();
      var bn = (b.alias || b.ifName || "").toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    var html = "";
    up.forEach(function (iface, i) {
      var label = iface.alias || iface.ifName || "(unnamed)";
      var sub   = iface.alias && iface.ifName && iface.alias !== iface.ifName
        ? iface.ifName
        : (iface.ipAddress || "");
      var speed = (iface.speedBps != null) ? formatBps(iface.speedBps) : "";
      var idx   = String(i);
      html += ''
        + '<div class="list-item two-line iface-row" data-iface-idx="' + escapeHtml(idx) + '" role="button" tabindex="0" style="padding-left:16px;padding-right:16px;cursor:pointer;">'
        + '  <span class="leading"><span class="dot up" style="display:inline-block;width:10px;height:10px;border-radius:50%;"></span></span>'
        + '  <div class="content">'
        + '    <div class="headline">' + escapeHtml(label) + '</div>'
        + (sub ? '    <div class="supporting mono">' + escapeHtml(sub) + '</div>' : '')
        + '  </div>'
        + '  <span class="trailing muted mono" style="font-size:12px;">' + escapeHtml(speed) + '</span>'
        + '</div>'
        + (i < up.length - 1 ? '<div class="list-divider"></div>' : '');
    });
    host.innerHTML = html;

    // Wire tap → bottom sheet. Stash the sorted-up list on the closure so
    // the index in dataset matches what's rendered above.
    host.querySelectorAll(".iface-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var idx = parseInt(row.dataset.ifaceIdx, 10);
        if (isNaN(idx)) return;
        openInterfaceSheet(up[idx], info, assetId);
      });
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
        if (nid) PolarisRouter.go("asset/" + nid);
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

  function loadIpHistory(id, st) {
    var host = document.getElementById("asset-ip-history-host");
    if (!host) return;
    api.assets.getIpHistory(id).then(function (resp) {
      var rows = (resp && resp.history) || [];
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

  window.PolarisAssetDetail = {
    spec: {
      parentTab: "assets",
      renderTopbar: renderTopbar,
      render: render,
    },
  };
})();
