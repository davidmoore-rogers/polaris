// public/js/mobile/asset-detail.js — Asset detail screen.
//
// Phase 5 ships the highest-value sections of the desktop System tab:
//   - Hero with name + status + Refresh action
//   - Monitor section (response-time chart, status pill, RTT/last poll)
//   - Telemetry section (CPU+Memory chart, when supported)
//   - General section (IP/MAC/type/model/OS/location/last seen)
//   - IP history list
//
// Out of scope for v1 (likely never on mobile — they're complex slide-over
// surfaces that work better on a desktop):
//   - Interfaces table with per-interface comments editor + throughput chart
//   - IPsec tunnels
//   - LLDP neighbors
//   - SNMP walk
//   - Per-source observed blob view
// Each is a follow-up if operators ask for them.

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
        sections: { monitor: true, telemetry: true, general: true, ipHistory: false },
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

      // Monitor section
      + sectionHeader("monitor", "Monitor", monitorPillSubtext(asset), st.sections.monitor)
      + '<div class="sect-body" data-sect="monitor"' + (st.sections.monitor ? '' : ' hidden') + '>'
      + '  <div class="card-filled" style="padding:16px;margin-bottom:8px;">'
      + '    <div class="seg" id="asset-range-seg" style="display:inline-flex;border:1px solid var(--md-outline);border-radius:var(--shape-full);overflow:hidden;margin-bottom:8px;">' + rangeButtons + '</div>'
      + '    <div id="asset-monitor-chart" style="min-height:80px;"></div>'
      + '    <div class="muted" id="asset-monitor-stats" style="font-size:12px;margin-top:8px;letter-spacing:.4px;"></div>'
      + '  </div>'
      + '</div>'

      // Telemetry section
      + sectionHeader("telemetry", "CPU + Memory", "", st.sections.telemetry)
      + '<div class="sect-body" data-sect="telemetry"' + (st.sections.telemetry ? '' : ' hidden') + '>'
      + '  <div class="card-filled" style="padding:16px;margin-bottom:8px;">'
      + '    <div id="asset-telemetry-chart" style="min-height:80px;"></div>'
      + '    <div class="muted" id="asset-telemetry-stats" style="font-size:12px;margin-top:8px;letter-spacing:.4px;"></div>'
      + '  </div>'
      + '</div>'

      // General section
      + sectionHeader("general", "General", "", st.sections.general)
      + '<div class="sect-body" data-sect="general"' + (st.sections.general ? '' : ' hidden') + '>'
      + renderGeneralBody(asset)
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

  function sectionHeader(key, title, subtitle, expanded) {
    return ''
      + '<button class="asset-sect-header" data-key="' + key + '">'
      + '  <div style="flex:1;text-align:left;">'
      + '    <div class="sect-title">' + escapeHtml(title) + '</div>'
      + (subtitle ? '    <div class="sect-sub">' + escapeHtml(subtitle) + '</div>' : '')
      + '  </div>'
      + '  <svg class="caret" viewBox="0 0 24 24" width="24" height="24" style="fill:var(--md-on-surface-variant);"><use href="' + (expanded ? "#i-chev-down" : "#i-chev-right") + '"/></svg>'
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
    var statsHost = document.getElementById("asset-monitor-stats");
    if (!chartHost) return;
    chartHost.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    if (statsHost) statsHost.textContent = "";

    api.assets.monitorHistory(id, st.range).then(function (resp) {
      if (!resp) return;
      var samples = (resp.samples || []).map(function (s) {
        return { ts: s.timestamp, v: s.responseTimeMs };
      });
      chartHost.innerHTML = PolarisCharts.lineChart({
        series: [{ values: samples, color: "var(--md-primary)", fill: true }],
        height: 80,
        ariaLabel: "Response time over " + st.range,
      });
      if (statsHost) {
        var stats = resp.stats || {};
        var bits = [];
        if (stats.avgMs != null) bits.push("avg " + stats.avgMs + " ms");
        if (stats.maxMs != null) bits.push("max " + stats.maxMs + " ms");
        if (stats.packetLossRate != null) bits.push((stats.packetLossRate * 100).toFixed(1) + "% loss");
        if (stats.total != null) bits.push(stats.total + " samples");
        statsHost.textContent = bits.join(" · ") || "No samples";
      }
    }).catch(function (err) {
      chartHost.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">Couldn’t load monitor history: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
    });
  }

  function loadTelemetry(id, st) {
    var chartHost = document.getElementById("asset-telemetry-chart");
    var statsHost = document.getElementById("asset-telemetry-stats");
    if (!chartHost) return;
    chartHost.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    if (statsHost) statsHost.textContent = "";

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
        chartHost.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">No telemetry — this monitor type doesn’t collect CPU/memory.</div>';
        return;
      }
      chartHost.innerHTML = PolarisCharts.lineChart({
        series: [
          { values: cpuSeries, color: "var(--md-primary)" },
          { values: memSeries, color: "var(--md-tertiary)" },
        ],
        height: 80,
        yMin: 0, yMax: 100,
        ariaLabel: "CPU and memory over " + st.range,
      });
      if (statsHost) {
        var stats = resp.stats || {};
        var bits = [];
        if (stats.avgCpuPct != null) bits.push('<span style="color:var(--md-primary);">cpu avg ' + Math.round(stats.avgCpuPct) + "%</span>");
        if (stats.maxCpuPct != null) bits.push("max " + Math.round(stats.maxCpuPct) + "%");
        if (stats.avgMemPct != null) bits.push('<span style="color:var(--md-tertiary);">mem avg ' + Math.round(stats.avgMemPct) + "%</span>");
        if (stats.maxMemPct != null) bits.push("max " + Math.round(stats.maxMemPct) + "%");
        statsHost.innerHTML = bits.join(" · ") || "No samples";
      }
    }).catch(function (err) {
      chartHost.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">Couldn’t load telemetry: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
    });
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
      // Repull the charts.
      loadMonitor(id, st);
      loadTelemetry(id, st);
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
    switch (asset.monitorStatus) {
      case "up": return "up";
      case "down": return "down";
      case "unknown": return "unk";
      default: return "unk";
    }
  }

  function renderMonitorPill(asset) {
    if (!asset.monitored) return '<span class="status-pill unk">Unmonitored</span>';
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
