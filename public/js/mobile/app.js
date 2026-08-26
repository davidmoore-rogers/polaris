// public/js/mobile/app.js — Mobile app orchestrator.
//
// On boot, calls /auth/me. If unauthenticated, hands over to PolarisAuth.
// If authenticated, renders the tab shell and dispatches to the tab matching
// the current hash route.
//
// All state-changing requests funnel through window.api (loaded from the
// shared /js/api.js). The 401 hook below redirects to the in-app login
// rather than /login.html, so session expiry pops a familiar screen.

// Apply persisted theme BEFORE the IIFE below runs, so the first paint
// uses the right surface color (no dark-flash on a light-mode user's
// reload). Same `polaris-theme` localStorage key the desktop uses, so a
// preference set on either surface flows to the other.
// Nothing saved (first launch of the installed app, typically) follows the OS
// — "morning" for a light preference, "nightfall" otherwise. Same rule as
// js/theme-init.js and app.js, and a retired id (the old "dark"/"light") names
// no token block, so it falls back the same way as no preference at all.
//
// The desktop's three themes come in two FAMILIES, and mobile.css carries one
// palette per family — so this SPA reads and writes family-wise (see
// PolarisTheme below) while still storing a real theme id, which is what keeps
// the shared `polaris-theme` key valid for the desktop app.
var MOBILE_THEME_IDS = { light: "morning", dark: "nightfall" };
(function () {
  var KNOWN = ["morning", "noon", "nightfall"];
  var saved = null;
  try { saved = localStorage.getItem("polaris-theme"); } catch (e) {}
  if (saved && KNOWN.indexOf(saved) === -1) saved = null;
  if (!saved) {
    var light = false;
    try { light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches; } catch (e) {}
    saved = light ? "morning" : "nightfall";
  }
  document.documentElement.setAttribute("data-theme", saved);
})();

// Tiny shared get/set so map-tab and more-tab can flip theme without
// duplicating the localStorage key. `get` answers the FAMILY ("light"|"dark")
// — that is the granularity every caller here wants (one basemap pair, one
// Material palette pair, one two-way toggle row) — while `set` writes a
// concrete theme id the desktop also understands. `getId` is the raw value for
// anything that needs it.
window.PolarisTheme = {
  getId: function () { return document.documentElement.getAttribute("data-theme") || "nightfall"; },
  get: function () {
    var id = document.documentElement.getAttribute("data-theme");
    return (id === "morning" || id === "noon") ? "light" : "dark";
  },
  set: function (family) {
    // Accepts a family ("light"/"dark") or a concrete theme id, so a caller
    // that already knows which theme it wants can say so.
    var theme = MOBILE_THEME_IDS[family] || family;
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("polaris-theme", theme); } catch (e) {}
    // Keep the installed app's chrome (Android status bar / task switcher)
    // in step with the theme. --md-surface-cont per theme; the dark value
    // matches the manifest's theme_color. The manifest colour itself is
    // frozen at install time and only affects the launch splash, so a
    // light-mode user still gets a dark splash — cosmetic and unavoidable.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", window.PolarisTheme.get() === "dark" ? "#1d2024" : "#eef0f7");
  },
};

(function () {
  var app = document.getElementById("app");
  var currentUser = null;

  // Hook the shared api.js 401 handler so it routes back to our in-app
  // login screen instead of /login.html.
  window.__polarisOn401 = function () {
    currentUser = null;
    PolarisAuth.renderLogin(app);
  };

  // Best-effort portrait lock. Honored on Android Chrome / Firefox; iOS
  // Safari outside an installed PWA silently rejects, which is fine —
  // mobile.css carries a landscape lockout overlay as the universal
  // fallback for that case. Wrapped in try/catch because the API throws
  // synchronously on some platforms when called outside fullscreen.
  try {
    if (screen && screen.orientation && typeof screen.orientation.lock === "function") {
      screen.orientation.lock("portrait").catch(function () { /* unsupported — fall through to CSS overlay */ });
    }
  } catch (e) { /* silent — same path as a quiet rejection */ }

  // ─── Boot ──────────────────────────────────────────────────────────────
  async function boot() {
    app.dataset.tab = "";
    app.innerHTML = '<div class="loading-screen"><div class="spinner"></div></div>';

    // Branding carries the hardware-sensor display unit (°C/°F). Fire-and-forget
    // so it never delays the first paint — the sensor list reads the cached value
    // and a changed preference lands on the next boot at the latest.
    if (window.PolarisAuthFlow) { void PolarisAuthFlow.fetchBranding(); }

    var user = null;
    var bootError = null;
    try {
      var bootController = new AbortController();
      var bootTimeout = setTimeout(function () { bootController.abort(); }, 10000);
      var res = await fetch("/api/v1/auth/me", { signal: bootController.signal });
      clearTimeout(bootTimeout);
      if (res.ok) {
        var data = await res.json();
        // /auth/me returns { authenticated, username, role: {id,name,permissions,...},
        // authProvider, regionTags: {user, role, effective} }. Translate to
        // the shape the rest of the mobile bundle expects — role becomes the
        // role NAME string for back-compat with existing role-name checks in
        // reservations-tab.js / subnet-detail.js / more-tab.js. Permissions +
        // effective regions are passed through under explicit keys so future
        // surfaces (e.g. region-filtered reservation list) can read them.
        if (data && data.authenticated) {
          user = {
            username:     data.username,
            role:         (data.role && data.role.name) || null,
            permissions:  (data.role && data.role.permissions) || {},
            regions:      (data.regionTags && data.regionTags.effective) || [],
            authProvider: data.authProvider,
            displayName:  data.username,
          };
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") {
        bootError = "Connection timed out. Check your network and tap Retry.";
      } else if (err && err.message) {
        bootError = "Could not reach server: " + err.message + ". Tap Retry.";
      }
    }

    if (bootError) {
      app.innerHTML = ''
        + '<div class="empty-state" style="padding-top:64px;">'
        + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);">'
        + '    <svg viewBox="0 0 24 24"><use href="#i-warn"/></svg>'
        + '  </div>'
        + '  <div class="ttl">Unable to connect</div>'
        + '  <div class="desc">' + bootError + '</div>'
        + '  <button class="btn-filled" style="margin-top:24px;" id="boot-retry-btn">Retry</button>'
        + '</div>';
      var retryBtn = document.getElementById("boot-retry-btn");
      if (retryBtn) retryBtn.addEventListener("click", function () { boot(); });
      return;
    }

    if (!user) {
      currentUser = null;
      PolarisAuth.renderLogin(app);
      return;
    }

    currentUser = user;
    // Make the current user available to api.js callers (avatar, role checks).
    window.__polarisUser = user;

    renderShell();
    PolarisRouter.onChange(routeChanged);
    if (!window.location.hash) PolarisRouter.go("search", { replace: true });
    initPushOnce();
  }

  // Register the service worker once per page load, as soon as we know the
  // visitor is authenticated. boot() is re-entrant (the offline Retry button,
  // sign-out, and post-login all call it), hence the guard.
  //
  // Registering here rather than lazily from the More tab means (a) Chrome's
  // installability check sees an ACTIVE service worker whether or not the user
  // ever opens More, and (b) the push handler is live regardless. It subscribes
  // to nothing, so there is no permission or privacy consequence.
  //
  // reconcileSubscription re-posts an already-granted subscription so a rotated
  // push endpoint self-heals — see the comment in push.js; this boot-time pass
  // is the primary rotation repair, not the service worker's event handler.
  var _pushInitDone = false;
  function initPushOnce() {
    if (_pushInitDone || !window.polarisPush) return;
    _pushInitDone = true;
    polarisPush.registerSW()
      .then(function () { return polarisPush.reconcileSubscription("mobile"); })
      .catch(function () { /* push is optional — never block boot */ });
  }

  // ─── Shell ─────────────────────────────────────────────────────────────
  function renderShell() {
    app.innerHTML = ''
      + '<div id="search-slot">' + buildSearchbar() + '</div>'
      + '<div id="topbar-slot"></div>'
      + '<main class="app-body" id="app-body"></main>'
      + buildNavbar();
    wireSearchbar();
    wireNavbar();
  }

  // Persistent searchbar — visible at the top of every page. Typing
  // routes the user to the Search tab (which renders results into
  // #app-body) without losing the input value across navigation, since
  // the input lives in this shell-owned slot and is never re-rendered.
  function buildSearchbar() {
    var initials = (currentUser && currentUser.username || "?").slice(0, 2).toUpperCase();
    return ''
      + '<div class="m3-searchbar" style="margin:8px 16px 4px;">'
      + '  <button class="icon-btn" id="search-clear-btn" aria-label="Clear" type="button" style="display:none;"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '  <button class="icon-btn" id="search-icon-btn" aria-label="Search" type="button"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></button>'
      + '  <input class="input" type="search" id="search-input" placeholder="Search IPs, assets, networks…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">'
      + '  <div class="avatar" id="search-avatar">' + PolarisTabs.escapeHtml(initials) + '</div>'
      + '</div>';
  }

  function wireSearchbar() {
    var input    = document.getElementById("search-input");
    var clearBtn = document.getElementById("search-clear-btn");
    var iconBtn  = document.getElementById("search-icon-btn");
    if (!input) return;

    function setClearVisible(visible) {
      if (!clearBtn || !iconBtn) return;
      clearBtn.style.display = visible ? "" : "none";
      iconBtn.style.display  = visible ? "none" : "";
    }

    input.addEventListener("input", function () {
      var q = input.value.trim();
      setClearVisible(!!input.value);
      // Typing anywhere except the Search tab routes to /search so the
      // results land in the body. Replace history so back doesn't have
      // to walk through every keystroke's intermediate route.
      var cur = PolarisRouter.current();
      if (q.length > 0 && cur.name !== "search") {
        PolarisRouter.go("search", { replace: true });
      }
      PolarisSearch.debounce(q);
    });

    // Tapping the search input from any tab brings up the Search tab so
    // the shortcut-hint chips are visible before the operator types. We
    // only route on empty input so this doesn't fight an in-progress
    // query (focus events fire on keyboard re-entry too).
    input.addEventListener("focus", function () {
      var cur = PolarisRouter.current();
      if (!input.value.trim() && cur.name !== "search") {
        PolarisRouter.go("search", { replace: true });
      }
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        input.value = "";
        setClearVisible(false);
        PolarisSearch.runSearch("");
      }
    });

    if (clearBtn) clearBtn.addEventListener("click", function () {
      input.value = "";
      setClearVisible(false);
      PolarisSearch.runSearch("");
      input.focus();
    });
  }

  function buildNavbar() {
    var html = '<nav class="m3-navbar" id="navbar">';
    PolarisTabs.list.forEach(function (t) {
      html += ''
        + '<button class="nav-item" data-tab="' + t.id + '">'
        + '  <div class="nav-icon-pill">'
        + '    <svg viewBox="0 0 24 24"><use href="' + t.spec.icon + '"/></svg>'
        + '  </div>'
        + '  <div class="nav-label">' + t.spec.title + '</div>'
        + '</button>';
    });
    html += '</nav>';
    return html;
  }

  function wireNavbar() {
    var nav = document.getElementById("navbar");
    if (!nav) return;
    nav.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var tabId = btn.dataset.tab;
        PolarisRouter.go(tabId);
      });
    });
  }

  function setActiveTab(tabId) {
    app.dataset.tab = tabId || "";
    var nav = document.getElementById("navbar");
    if (!nav) return;
    nav.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.tab === tabId);
    });
  }

  // Pull-to-refresh handle for the currently-mounted route. Cleared on
  // every route change so handlers + indicator DOM don't stack up.
  var _ptrRelease = null;

  function installPtrForSpec(spec, ctx) {
    if (_ptrRelease) { try { _ptrRelease(); } catch (_) {} _ptrRelease = null; }
    if (!spec || typeof spec.onPullToRefresh !== "function") return;
    // Optional predicate — lets a spec like More disable PTR on its root
    // menu while keeping it on the sub-pages. Treat missing predicate as
    // "always enabled."
    if (typeof spec.enablesPullToRefresh === "function") {
      try { if (!spec.enablesPullToRefresh(ctx)) return; }
      catch (_) { return; }
    }
    var body = document.getElementById("app-body");
    if (!body || !window.PolarisTabs || !PolarisTabs.installPullRefresh) return;
    _ptrRelease = PolarisTabs.installPullRefresh(body, function () {
      try { return spec.onPullToRefresh(ctx); } catch (_) { return null; }
    });
  }

  // ─── Route handler ─────────────────────────────────────────────────────
  function routeChanged(route) {
    if (!currentUser) return;

    var topbar = document.getElementById("topbar-slot");
    var body = document.getElementById("app-body");
    if (!topbar || !body) {
      // Shell got torn down (login screen showing) — re-render and retry.
      renderShell();
      topbar = document.getElementById("topbar-slot");
      body = document.getElementById("app-body");
    }

    // Page-aware search ordering: snapshot every non-search route so
    // when the operator starts typing (which replace-navigates to
    // /search) the result renderer still knows which page they came
    // from and can hoist the matching section to the top.
    if (route && route.name !== "search" && window.PolarisSearch && PolarisSearch.setOriginRoute) {
      PolarisSearch.setOriginRoute(route.name, route.parts);
    }

    // Top-level tab?
    var tabSpec = PolarisTabs.byId(route.name);
    if (tabSpec) {
      setActiveTab(route.name);
      var tabCtx = { user: currentUser, route: route };
      topbar.innerHTML = tabSpec.renderTopbar
        ? tabSpec.renderTopbar(tabCtx) : '';
      tabSpec.render(body, tabCtx);
      body.scrollTop = 0;
      installPtrForSpec(tabSpec, tabCtx);
      return;
    }

    // Detail route? (asset, subnet, block, site)
    var details = window.PolarisDetails || {};
    var detailSpec = details[route.name];
    if (detailSpec) {
      // Detail specs may declare a parentTab — when set, the corresponding
      // navbar item stays highlighted so the user understands which tab
      // they're conceptually inside. Without a parentTab the navbar is
      // visible but no item is active (e.g. block detail).
      var parentTab = detailSpec.parentTab || "";
      app.dataset.tab = parentTab || route.name;
      var nav = document.getElementById("navbar");
      if (nav) nav.querySelectorAll(".nav-item").forEach(function (b) {
        b.classList.toggle("active", parentTab !== "" && b.dataset.tab === parentTab);
      });

      var detailCtx = { user: currentUser, route: route };
      topbar.innerHTML = detailSpec.renderTopbar
        ? detailSpec.renderTopbar(detailCtx) : '';
      detailSpec.render(body, detailCtx);
      body.scrollTop = 0;
      installPtrForSpec(detailSpec, detailCtx);
      return;
    }

    // Unknown route — bounce to search. Clear any installed PTR.
    if (_ptrRelease) { try { _ptrRelease(); } catch (_) {} _ptrRelease = null; }
    PolarisRouter.go("search", { replace: true });
  }

  // ─── Public surface ────────────────────────────────────────────────────
  window.PolarisMobile = {
    boot: boot,
    user: function () { return currentUser; },
  };

  // Kick off on DOM ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
