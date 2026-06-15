// public/js/mobile/assets-tab.js — Assets list tab.
//
// Card feed of every asset, filterable by type via the chip row at the
// top. Tapping a card navigates to the asset detail route (real renderer
// arrives in Phase 5; Phase 4 lands on the placeholder).
//
// State management: filter + asset list are kept on the module so a
// re-render (e.g. snapping back from a detail screen) can repopulate
// without re-fetching. Re-fetch on filter change.

(function () {
  // Asset type → leading icon + avatar class. Keep this in sync with the
  // .ico-* color tokens in mobile.css.
  var TYPE_META = {
    firewall:     { icon: "#i-shield",       cls: "ico-fw",    label: "Firewalls" },
    switch:       { icon: "#i-switch-icon",  cls: "ico-sw",    label: "Switches" },
    access_point: { icon: "#i-wifi",         cls: "ico-ap",    label: "APs" },
    router:       { icon: "#i-router",       cls: "ico-rtr",   label: "Routers" },
    server:       { icon: "#i-server",       cls: "ico-srv",   label: "Servers" },
    workstation:  { icon: "#i-desktop",      cls: "ico-wks",   label: "Workstations" },
    printer:      { icon: "#i-printer",      cls: "ico-prn",   label: "Printers" },
    other:        { icon: "#i-server",       cls: "ico-other", label: "Other" },
  };

  // Filter chips, in display order. `type` null = no assetType filter.
  var FILTERS = [
    { key: "all",          label: "All",          type: null },
    { key: "firewall",     label: "Firewalls",    type: "firewall" },
    { key: "switch",       label: "Switches",     type: "switch" },
    { key: "access_point", label: "APs",          type: "access_point" },
    { key: "router",       label: "Routers",      type: "router" },
    { key: "server",       label: "Servers",      type: "server" },
    { key: "workstation",  label: "Workstations", type: "workstation" },
    { key: "printer",      label: "Printers",     type: "printer" },
    { key: "other",        label: "Other",        type: "other" },
  ];

  var PAGE_SIZE = 50;

  var _state = {
    filterKey: "all",
    assets: [],      // accumulated rows
    total: 0,
    offset: 0,
    loading: false,
    // Monotonic sequence — incremented on every loadPage() call and checked
    // when the response arrives. Lets us drop stale results after a filter
    // change without needing AbortController support in api.js.
    seq: 0,
  };

  var Assets = {
    title: "Assets",
    icon: "#i-list",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Assets</div>'
        + '  <div class="trailing">'
        + '    <button class="icon-btn" id="assets-search-btn" aria-label="Search"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></button>'
        + '  </div>'
        + '</div>';
    },
    render: function (body) {
      body.innerHTML = ''
        + '<div class="chip-row" id="assets-chips"></div>'
        + '<div id="assets-list-host"></div>';

      var searchBtn = document.getElementById("assets-search-btn");
      if (searchBtn) searchBtn.addEventListener("click", function () { PolarisRouter.go("search"); });

      renderChips();
      // Reset list state on every fresh render — operators expect tapping
      // the Assets tab to give them a clean view, not the leftover scroll
      // from yesterday.
      _state.assets = [];
      _state.offset = 0;
      _state.total = 0;
      loadPage(true);
    },
    onPullToRefresh: function () {
      // Reset paging + re-fetch the first page under the current filter.
      _state.assets = [];
      _state.offset = 0;
      _state.total = 0;
      return loadPage(true);
    },
  };

  function renderChips() {
    var row = document.getElementById("assets-chips");
    if (!row) return;
    row.innerHTML = FILTERS.map(function (f) {
      var sel = f.key === _state.filterKey;
      return ''
        + '<button class="chip ' + (sel ? "selected" : "") + '" data-key="' + f.key + '">'
        + (sel ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>' : '')
        + escapeHtml(f.label)
        + '</button>';
    }).join("");
    row.querySelectorAll(".chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.dataset.key;
        if (key === _state.filterKey) return;
        _state.filterKey = key;
        _state.assets = [];
        _state.offset = 0;
        _state.total = 0;
        renderChips();
        loadPage(true);
      });
    });
  }

  function loadPage(replace) {
    var filter = FILTERS.find(function (f) { return f.key === _state.filterKey; }) || FILTERS[0];
    _state.seq++;
    var thisSeq = _state.seq;
    _state.loading = true;
    renderList();

    var params = { limit: PAGE_SIZE, offset: _state.offset };
    if (filter.type) params.assetType = filter.type;

    return api.assets.list(params).then(function (resp) {
      if (thisSeq !== _state.seq) return; // superseded by a later filter change
      _state.loading = false;
      if (!resp) return;
      var fresh = Array.isArray(resp.assets) ? resp.assets : [];
      _state.total = resp.total || fresh.length;
      _state.assets = replace ? fresh : _state.assets.concat(fresh);
      _state.offset = (replace ? 0 : _state.offset) + fresh.length;
      renderList();
    }).catch(function (err) {
      if (thisSeq !== _state.seq) return;
      _state.loading = false;
      renderError(err && err.message ? err.message : "Failed to load assets");
    });
  }

  function renderList() {
    var host = document.getElementById("assets-list-host");
    if (!host) return;

    if (_state.assets.length === 0 && _state.loading) {
      host.innerHTML = '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';
      return;
    }
    if (_state.assets.length === 0 && !_state.loading) {
      host.innerHTML = ''
        + '<div class="empty-state" style="padding-top:48px;">'
        + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-list"/></svg></div>'
        + '  <div class="ttl">No assets</div>'
        + '  <div class="desc">Nothing matches this filter. Try “All” or run a discovery to populate the inventory.</div>'
        + '</div>';
      return;
    }

    var html = '<div class="asset-list">';
    _state.assets.forEach(function (a) {
      html += renderAssetCard(a);
    });
    html += '</div>';

    var hasMore = _state.assets.length < _state.total;
    if (hasMore) {
      html += ''
        + '<div style="display:flex;justify-content:center;padding:8px 16px 24px;">'
        + '  <button class="btn btn-tonal" id="assets-load-more"' + (_state.loading ? ' disabled' : '') + '>'
        + '    ' + (_state.loading
          ? '<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span> Loading…'
          : 'Load more (' + (_state.total - _state.assets.length) + ' remaining)')
        + '  </button>'
        + '</div>';
    } else {
      html += '<div style="text-align:center;padding:16px 16px 24px;color:var(--md-on-surface-variant);font-size:12px;letter-spacing:.5px;">' + _state.assets.length + ' asset' + (_state.assets.length === 1 ? "" : "s") + '</div>';
    }

    host.innerHTML = html;

    host.querySelectorAll(".asset-card").forEach(function (card) {
      card.addEventListener("click", function () {
        var id = card.dataset.id;
        if (!id) return;
        if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(id);
        else PolarisRouter.go("asset/" + id);
      });
    });
    var more = document.getElementById("assets-load-more");
    if (more) more.addEventListener("click", function () { loadPage(false); });
  }

  function renderError(msg) {
    var host = document.getElementById("assets-list-host");
    if (!host) return;
    host.innerHTML = ''
      + '<div class="empty-state" style="padding-top:48px;">'
      + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
      + '  <div class="ttl">Couldn’t load assets</div>'
      + '  <div class="desc">' + escapeHtml(msg) + '</div>'
      + '</div>';
  }

  function renderAssetCard(a) {
    var meta = TYPE_META[a.assetType] || TYPE_META.other;
    var dotCls = monitorDotCls(a);
    var bits = [];
    if (a.ipAddress) bits.push('<span class="mono">' + escapeHtml(a.ipAddress) + '</span>');
    var modelLine = [a.manufacturer, a.model].filter(Boolean).join(" ");
    if (modelLine) bits.push(escapeHtml(modelLine));
    if (a.location || a.learnedLocation) bits.push(escapeHtml(a.location || a.learnedLocation));
    if (!bits.length) bits.push(escapeHtml(a.assetType || "asset"));

    return ''
      + '<button class="asset-card" data-id="' + escapeHtml(a.id) + '">'
      + '  <div class="top">'
      + '    <div class="ico ' + meta.cls + '"><svg viewBox="0 0 24 24"><use href="' + meta.icon + '"/></svg></div>'
      + '    <div class="name">' + escapeHtml(a.hostname || a.assetTag || "(unnamed)") + '</div>'
      + (dotCls ? '    <span class="dot ' + dotCls + '" title="' + escapeHtml(monitorTitle(a)) + '"></span>' : '')
      + '  </div>'
      + '  <div class="meta">' + bits.join('<span class="muted">·</span>') + '</div>'
      + '</button>';
  }

  function monitorDotCls(a) {
    if (!a.monitored) return "";
    switch (a.monitorStatus) {
      case "up":      return "up";
      case "down":    return "down";
      case "unknown": return "unk";
      default:        return "unk";
    }
  }
  function monitorTitle(a) {
    if (!a.monitored) return "Unmonitored";
    if (a.monitorStatus === "up")      return "Up — last RTT " + (a.lastResponseTimeMs != null ? a.lastResponseTimeMs + " ms" : "n/a");
    if (a.monitorStatus === "down")    return "Down";
    if (a.monitorStatus === "unknown") return "No samples yet";
    return "Monitored";
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  window.PolarisAssetsTab = { spec: Assets };
})();
