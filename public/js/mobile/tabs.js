// public/js/mobile/tabs.js — Tab renderers.
//
// Each tab exposes `render(body, ctx)` where:
//   body — the .app-body element to populate
//   ctx  — { user, route } so handlers can act on the current user/route
//
// Phase 1 ships the navigation shell and placeholder bodies. Subsequent
// phases replace the placeholder bodies with real implementations.

(function () {
  function placeholder(title, message) {
    return ''
      + '<div class="empty-state">'
      + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-construction"/></svg></div>'
      + '  <div class="ttl">' + title + '</div>'
      + '  <div class="desc">' + message + '</div>'
      + '</div>';
  }

  // ─── Shared snackbar ───────────────────────────────────────────────────
  // Single-instance toast at the bottom of the viewport, above the navbar.
  // showSnackbar(message, opts?) where opts may carry { error, action: { label, onClick }, duration }.
  // Re-calling supersedes the previous toast immediately.
  var _snackTimer = null;
  function showSnackbar(message, opts) {
    opts = opts || {};
    var existing = document.getElementById("snackbar");
    if (existing) existing.remove();
    if (_snackTimer) { clearTimeout(_snackTimer); _snackTimer = null; }

    var sb = document.createElement("div");
    sb.id = "snackbar";
    sb.className = "snackbar" + (opts.error ? " error" : "");
    sb.innerHTML = '<span class="label">' + escapeHtml(message) + '</span>'
      + (opts.action ? '<button class="action" id="snack-action">' + escapeHtml(opts.action.label) + '</button>' : '');
    document.body.appendChild(sb);

    if (opts.action) {
      document.getElementById("snack-action").addEventListener("click", function () {
        try { opts.action.onClick(); } catch (_) {}
        sb.remove();
        if (_snackTimer) { clearTimeout(_snackTimer); _snackTimer = null; }
      });
    }

    _snackTimer = setTimeout(function () {
      sb.remove();
      _snackTimer = null;
    }, opts.duration || 3500);
  }

  // ─── Search ────────────────────────────────────────────────────────────
  // Group order on results — picks the most discriminating hits first so
  // the user sees the answer they were typing toward at the top of the
  // list. IPs is first because typing an IP is the strongest signal
  // ("the user knows the exact IP and wants to see what's there").
  var SEARCH_GROUP_ORDER = ["ips", "assets", "sites", "subnets", "reservations", "blocks"];

  var SEARCH_GROUP_META = {
    ips:           { label: "IP addresses",  icon: "#i-router",   leading: "tonal" },
    assets:        { label: "Assets",        icon: "#i-server",   leading: "" },
    sites:         { label: "Device Map",    icon: "#i-map",      leading: "tertiary" },
    subnets:       { label: "Networks",      icon: "#i-subnet",   leading: "tonal" },
    reservations:  { label: "Reservations",  icon: "#i-bookmark", leading: "" },
    blocks:        { label: "Blocks",        icon: "#i-block",    leading: "" },
  };

  // Map a hit to the route to navigate to on tap. Returns null when there's
  // no sensible mobile destination (those rows are still tappable but
  // navigate via fallback — see hitClick).
  function hitTarget(group, hit) {
    if (group === "assets")       return "asset/" + hit.id;
    if (group === "sites")        return "site/" + hit.id;
    if (group === "subnets")      return "subnet/" + hit.id;
    if (group === "blocks")       return "block/" + hit.id;
    if (group === "reservations") {
      var ctx = hit.context || {};
      if (ctx.subnetId) return "subnet/" + ctx.subnetId;
      return null;
    }
    if (group === "ips") {
      var ctx2 = hit.context || {};
      if (ctx2.subnetId) return "subnet/" + ctx2.subnetId;
      return null;
    }
    return null;
  }

  var Search = {
    title: "Search",
    icon: "#i-search",
    renderTopbar: function (ctx) {
      var initials = (ctx.user && ctx.user.username || "?")
        .slice(0, 2).toUpperCase();
      return ''
        + '<div class="m3-searchbar" style="margin:8px 16px 0;">'
        + '  <button class="icon-btn" id="search-clear-btn" aria-label="Clear" type="button" style="display:none;"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
        + '  <button class="icon-btn" id="search-icon-btn" aria-label="Search" type="button"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></button>'
        + '  <input class="input" type="search" id="search-input" placeholder="Search IPs, assets, subnets…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">'
        + '  <div class="avatar">' + escapeHtml(initials) + '</div>'
        + '</div>';
    },
    render: function (body) {
      body.innerHTML = '<div id="search-state"></div>';
      var state = document.getElementById("search-state");
      var input = document.getElementById("search-input");
      var clearBtn = document.getElementById("search-clear-btn");
      var iconBtn  = document.getElementById("search-icon-btn");

      var debounceTimer = null;
      var inFlight = null;

      function setClearVisible(visible) {
        if (!clearBtn || !iconBtn) return;
        clearBtn.style.display = visible ? "" : "none";
        iconBtn.style.display  = visible ? "none" : "";
      }

      function renderEmpty() {
        state.innerHTML = ''
          + '<div class="empty-state" style="padding-top:48px;">'
          + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></div>'
          + '  <div class="ttl">Search Polaris</div>'
          + '  <div class="desc">Find IPs, assets, subnets, FortiGate sites and reservations. Try typing an IP, hostname, MAC, or partial name.</div>'
          + '</div>';
      }

      function renderLoading() {
        state.innerHTML = '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';
      }

      function renderError(msg) {
        state.innerHTML = ''
          + '<div class="empty-state" style="padding-top:48px;">'
          + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
          + '  <div class="ttl">Search failed</div>'
          + '  <div class="desc">' + escapeHtml(msg) + '</div>'
          + '</div>';
      }

      function renderResults(data) {
        var totalHits = 0;
        SEARCH_GROUP_ORDER.forEach(function (g) { totalHits += (data[g] || []).length; });
        if (totalHits === 0) {
          state.innerHTML = ''
            + '<div class="empty-state" style="padding-top:48px;">'
            + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></div>'
            + '  <div class="ttl">No matches</div>'
            + '  <div class="desc">Nothing matched “' + escapeHtml(data.query || "") + '”. Try a different query.</div>'
            + '</div>';
          return;
        }

        var html = "";
        SEARCH_GROUP_ORDER.forEach(function (g) {
          var hits = data[g] || [];
          if (hits.length === 0) return;
          var meta = SEARCH_GROUP_META[g];
          html += '<div class="section-head">' + meta.label + '<span class="count">' + hits.length + '</span></div>';
          hits.forEach(function (hit, idx) {
            var titleClass = (g === "ips" || g === "subnets" || g === "blocks") ? "headline mono" : "headline";
            var leadingCls = "leading" + (meta.leading ? " " + meta.leading : "");
            html += ''
              + '<button class="list-item two-line" data-group="' + g + '" data-idx="' + idx + '">'
              + '  <span class="' + leadingCls + '"><svg viewBox="0 0 24 24"><use href="' + meta.icon + '"/></svg></span>'
              + '  <div class="content">'
              + '    <div class="' + titleClass + '">' + escapeHtml(hit.title || "") + '</div>'
              + (hit.subtitle ? '    <div class="supporting">' + escapeHtml(hit.subtitle) + '</div>' : '')
              + '  </div>'
              + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
              + '</button>';
          });
        });
        state.innerHTML = html;

        // Wire row taps. We rebuild the list on every query so listeners
        // are fresh — no leak risk.
        state.querySelectorAll(".list-item").forEach(function (row) {
          row.addEventListener("click", function () {
            var g = row.dataset.group;
            var idx = parseInt(row.dataset.idx, 10);
            var hit = (data[g] || [])[idx];
            if (!hit) return;
            var target = hitTarget(g, hit);
            if (target) {
              PolarisRouter.go(target);
            } else {
              showSnackbar("No mobile view for this result yet — open it on desktop.");
            }
          });
        });
      }

      function runSearch(q) {
        // Abort any in-flight request first, even if we're about to bail
        // on the short-query check — otherwise a slow response from a
        // longer prior query can paint stale results over the empty state.
        if (inFlight) { inFlight.abort(); inFlight = null; }
        if (q.length < 2) {
          renderEmpty();
          return;
        }
        inFlight = new AbortController();
        var thisFlight = inFlight;

        renderLoading();
        fetch("/api/v1/search?q=" + encodeURIComponent(q), { signal: thisFlight.signal })
          .then(function (r) {
            if (r.status === 401) { window.PolarisMobile.boot(); throw new Error("auth"); }
            if (!r.ok) throw new Error("Request failed (" + r.status + ")");
            return r.json();
          })
          .then(function (data) {
            if (thisFlight !== inFlight) return; // superseded
            renderResults(data);
          })
          .catch(function (err) {
            if (err.name === "AbortError" || err.message === "auth") return;
            renderError(err.message || "Network error");
          });
      }

      input.addEventListener("input", function () {
        setClearVisible(!!input.value);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () { runSearch(input.value.trim()); }, 200);
      });

      input.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          input.value = "";
          setClearVisible(false);
          renderEmpty();
        }
      });

      if (clearBtn) {
        clearBtn.addEventListener("click", function () {
          input.value = "";
          setClearVisible(false);
          renderEmpty();
          input.focus();
        });
      }

      // Initial state.
      renderEmpty();
      // Auto-focus the input on first land. Skip on touch devices
      // (showing the keyboard before the user asks is annoying on
      // phones — it covers the screen).
      if (!("ontouchstart" in window)) {
        setTimeout(function () { try { input.focus(); } catch (_) {} }, 50);
      }
    },
  };

  // ─── Map ───────────────────────────────────────────────────────────────
  var Map = {
    title: "Device Map",
    icon: "#i-map",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Device Map</div>'
        + '  <div class="trailing"></div>'
        + '</div>';
    },
    render: function (body) {
      body.innerHTML = placeholder(
        "Device Map coming soon",
        "Leaflet basemap + clustered pins for every FortiGate site, color-coded by monitor health."
      );
    },
  };

  // ─── Assets ────────────────────────────────────────────────────────────
  var Assets = {
    title: "Assets",
    icon: "#i-list",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Assets</div>'
        + '  <div class="trailing">'
        + '    <button class="icon-btn" aria-label="Search"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></button>'
        + '  </div>'
        + '</div>';
    },
    render: function (body) {
      body.innerHTML = placeholder(
        "Assets coming soon",
        "Card feed of every asset, filter chips for type/status, tap-through to a System tab with charts."
      );
    },
  };

  // ─── Alerts ────────────────────────────────────────────────────────────
  var Alerts = {
    title: "Alerts",
    icon: "#i-bell",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Alerts</div>'
        + '  <div class="trailing">'
        + '    <button class="icon-btn" aria-label="Refresh"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
        + '  </div>'
        + '</div>';
    },
    render: function (body) {
      body.innerHTML = placeholder(
        "Alerts coming soon",
        "Down-now monitored assets at the top, recent warning/error events below — pulls /events at level≥warning."
      );
    },
  };

  // ─── More ──────────────────────────────────────────────────────────────
  var More = {
    title: "More",
    icon: "#i-more",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">More</div>'
        + '  <div class="trailing"></div>'
        + '</div>';
    },
    render: function (body, ctx) {
      var user = ctx.user || {};
      var role = user.role || "?";
      var displayName = user.displayName || user.username || "user";

      // Phase 1 stub: just the profile card and sign-out, so the auth flow
      // is exercisable end-to-end. Sub-pages come in Phase 7.
      body.innerHTML = ''
        + '<div class="section-head">Account</div>'
        + '<div class="list-item two-line">'
        + '  <span class="leading tertiary"><svg viewBox="0 0 24 24"><use href="#i-person"/></svg></span>'
        + '  <div class="content"><div class="headline">' + escapeHtml(displayName) + '</div><div class="supporting">' + escapeHtml(role) + '</div></div>'
        + '</div>'
        + '<div class="list-divider"></div>'
        + '<a class="list-item two-line" href="/index.html">'
        + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-desktop"/></svg></span>'
        + '  <div class="content"><div class="headline">Desktop view</div><div class="supporting">Open the full app</div></div>'
        + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
        + '</a>'
        + '<div class="list-divider"></div>'
        + '<button class="list-item" id="sign-out-btn">'
        + '  <span class="leading error"><svg viewBox="0 0 24 24"><use href="#i-logout"/></svg></span>'
        + '  <div class="content"><div class="headline" style="color:var(--md-error);">Sign out</div></div>'
        + '</button>'
        + '<div style="text-align:center;padding:32px 0 24px;color:var(--md-on-surface-variant);font-size:11px;letter-spacing:.5px;" id="version-line">Polaris</div>';

      document.getElementById("sign-out-btn").addEventListener("click", function () {
        fetch("/api/v1/auth/logout", { method: "POST", headers: csrfHeaders() })
          .finally(function () { window.PolarisMobile.boot(); });
      });

      // Pull version into the footer (best-effort).
      fetch("/api/v1/auth/me").then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
        if (!data || !data.version) return;
        var v = data.version;
        var tag = (typeof v === "string") ? v : (v.tag || (v.major + "." + v.minor + "." + v.patch));
        document.getElementById("version-line").textContent = "Polaris " + tag;
      }).catch(function () {});
    },
  };

  // ─── Tab registry ──────────────────────────────────────────────────────
  // Order here drives the navbar layout. Keep at five — that's the MD3 spec
  // limit and what fits comfortably on a phone width.
  var TABS = [
    { id: "search",  spec: Search },
    { id: "map",     spec: Map },
    { id: "assets",  spec: Assets },
    { id: "alerts",  spec: Alerts },
    { id: "more",    spec: More },
  ];

  // ─── helpers ───────────────────────────────────────────────────────────
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function csrfHeaders() {
    var headers = {};
    var m = document.cookie.match(/(?:^|; )polaris_csrf=([^;]+)/);
    if (m) headers["X-CSRF-Token"] = decodeURIComponent(m[1]);
    return headers;
  }

  window.PolarisTabs = {
    list: TABS,
    byId: function (id) {
      for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i].spec;
      return null;
    },
    escapeHtml: escapeHtml,
    placeholder: placeholder,
    showSnackbar: showSnackbar,
  };
})();
