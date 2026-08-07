// public/js/mobile/more-tab.js — More tab + its sub-pages.
//
// The More tab is two things: a menu of the rest of the app (Blocks /
// Subnets / Reservations / Events / Profile), and a host for those
// sub-pages. The router emits `#more/<sub>` and we dispatch on
// route.parts[0] inside this module so the rest of app.js doesn't have
// to know about More's sub-routes.
//
// Sub-pages are deliberately read-only — networks live on desktop for
// editing. Reservation creation comes via Phase 8 (Reserve sheet).

(function () {
  // ─── Sub-pages registry ────────────────────────────────────────────────
  var SUB_PAGES = {};

  function registerSub(key, spec) { SUB_PAGES[key] = spec; }

  // ─── Helpers ───────────────────────────────────────────────────────────
  function backTopbar(title) {
    return ''
      + '<div class="m3-topbar">'
      + '  <div class="leading">'
      + '    <button class="icon-btn" data-back aria-label="Back"><svg viewBox="0 0 24 24"><use href="#i-back"/></svg></button>'
      + '  </div>'
      + '  <div class="title">' + escapeHtml(title) + '</div>'
      + '  <div class="trailing"></div>'
      + '</div>';
  }
  function wireBack() {
    var btn = document.querySelector("[data-back]");
    if (!btn) return;
    btn.addEventListener("click", function () { PolarisRouter.go("more"); });
  }
  // escapeHtml is the canonical global from api.js (loaded first on every page).
  // api.js timeAgo with the mobile guard for empty/unparseable timestamps.
  function formatTimeAgo(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return timeAgo(iso);
  }
  function loadingHtml() {
    return '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';
  }
  function errorState(msg) {
    return ''
      + '<div class="empty-state" style="padding-top:48px;">'
      + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
      + '  <div class="ttl">Couldn’t load</div>'
      + '  <div class="desc">' + escapeHtml(msg) + '</div>'
      + '</div>';
  }

  // ─── Blocks sub-page ───────────────────────────────────────────────────
  registerSub("blocks", {
    renderTopbar: function () { return backTopbar("Blocks"); },
    render: function (body) {
      body.innerHTML = loadingHtml();
      return api.blocks.list().then(function (blocks) {
        if (!Array.isArray(blocks) || blocks.length === 0) {
          body.innerHTML = '<div class="empty-state" style="padding-top:48px;"><div class="icon"><svg viewBox="0 0 24 24"><use href="#i-block"/></svg></div><div class="ttl">No blocks</div><div class="desc">No IP blocks have been created yet.</div></div>';
          return;
        }
        var html = "";
        blocks.forEach(function (b, i) {
          html += ''
            + '<button class="list-item two-line" data-id="' + escapeHtml(b.id) + '">'
            + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-block"/></svg></span>'
            + '  <div class="content">'
            + '    <div class="headline">' + escapeHtml(b.name || "(unnamed)") + '</div>'
            + '    <div class="supporting"><span class="mono">' + escapeHtml(b.cidr || "") + '</span>' + (b.description ? ' · ' + escapeHtml(b.description) : '') + '</div>'
            + '  </div>'
            + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
            + '</button>'
            + (i < blocks.length - 1 ? '<div class="list-divider"></div>' : '');
        });
        body.innerHTML = html;
        body.querySelectorAll(".list-item").forEach(function (row) {
          row.addEventListener("click", function () { PolarisRouter.go("block/" + row.dataset.id); });
        });
      }).catch(function (err) { body.innerHTML = errorState(err && err.message ? err.message : "error"); });

      wireBack();
    },
  });

  // ─── Subnets sub-page ──────────────────────────────────────────────────
  registerSub("subnets", {
    renderTopbar: function () { return backTopbar("Networks"); },
    render: function (body) {
      body.innerHTML = loadingHtml();
      return api.subnets.list({ limit: 200 }).then(function (resp) {
        // listSubnets returns { subnets, total, limit, offset }
        var subnets = (resp && resp.subnets) || [];
        if (subnets.length === 0) {
          body.innerHTML = '<div class="empty-state" style="padding-top:48px;"><div class="icon"><svg viewBox="0 0 24 24"><use href="#i-subnet"/></svg></div><div class="ttl">No networks</div><div class="desc">No networks have been created yet.</div></div>';
          return;
        }
        var html = "";
        subnets.forEach(function (s, i) {
          var pieces = [];
          if (s.purpose) pieces.push(escapeHtml(s.purpose));
          if (s.vlan) pieces.push('VLAN ' + s.vlan);
          if (s.fortigateDevice) pieces.push(escapeHtml(s.fortigateDevice));
          var subtitle = '<span class="mono">' + escapeHtml(s.cidr || "") + '</span>' + (pieces.length ? ' · ' + pieces.join(' · ') : '');
          html += ''
            + '<button class="list-item two-line" data-id="' + escapeHtml(s.id) + '">'
            + '  <span class="leading tonal"><svg viewBox="0 0 24 24"><use href="#i-subnet"/></svg></span>'
            + '  <div class="content">'
            + '    <div class="headline">' + escapeHtml(s.name || s.cidr || "(unnamed)") + '</div>'
            + '    <div class="supporting">' + subtitle + '</div>'
            + '  </div>'
            + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
            + '</button>'
            + (i < subnets.length - 1 ? '<div class="list-divider"></div>' : '');
        });
        body.innerHTML = html;
        body.querySelectorAll(".list-item").forEach(function (row) {
          row.addEventListener("click", function () { PolarisRouter.go("subnet/" + row.dataset.id); });
        });
      }).catch(function (err) { body.innerHTML = errorState(err && err.message ? err.message : "error"); });

      wireBack();
    },
  });

  // ─── Events sub-page ───────────────────────────────────────────────────
  registerSub("events", {
    renderTopbar: function () { return backTopbar("Events"); },
    render: function (body) {
      body.innerHTML = loadingHtml();
      return api.events.list({ limit: 100 }).then(function (resp) {
        var events = (resp && resp.events) || [];
        if (events.length === 0) {
          body.innerHTML = '<div class="empty-state" style="padding-top:48px;"><div class="icon"><svg viewBox="0 0 24 24"><use href="#i-event"/></svg></div><div class="ttl">No events</div><div class="desc">No events recorded in the retention window.</div></div>';
          return;
        }
        var html = "";
        events.forEach(function (e, i) {
          var leadCls = e.level === "error" ? "error" : (e.level === "warning" ? "warning" : "");
          var iconHref = e.level === "error" ? "#i-down-arrow" : (e.level === "warning" ? "#i-warn" : "#i-info");
          html += ''
            + '<button class="list-item three-line" data-rt="' + escapeHtml(e.resourceType || "") + '" data-rid="' + escapeHtml(e.resourceId || "") + '">'
            + '  <span class="leading ' + leadCls + '"><svg viewBox="0 0 24 24"><use href="' + iconHref + '"/></svg></span>'
            + '  <div class="content">'
            + '    <div class="headline">' + escapeHtml(prettyAction(e.action)) + (e.resourceName ? " · " + escapeHtml(e.resourceName) : "") + '</div>'
            + '    <div class="supporting" style="white-space:normal;">' + escapeHtml(e.message || "") + '</div>'
            + '    <div class="supporting mono" style="font-size:12px;color:var(--md-on-surface-variant);margin-top:4px;">' + escapeHtml(formatTimeAgo(e.timestamp)) + (e.actor ? " · " + escapeHtml(e.actor) : "") + '</div>'
            + '  </div>'
            + '</button>'
            + (i < events.length - 1 ? '<div class="list-divider"></div>' : '');
        });
        body.innerHTML = html;
        body.querySelectorAll(".list-item").forEach(function (row) {
          row.addEventListener("click", function () {
            var rt = row.dataset.rt, rid = row.dataset.rid;
            if (!rid) return;
            if (rt === "asset") {
              if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(rid);
              else PolarisRouter.go("asset/" + rid);
            }
            else if (rt === "subnet") PolarisRouter.go("subnet/" + rid);
            else if (rt === "block")  PolarisRouter.go("block/" + rid);
            else PolarisTabs.showSnackbar("No mobile view for this event.");
          });
        });
      }).catch(function (err) { body.innerHTML = errorState(err && err.message ? err.message : "error"); });

      wireBack();
    },
  });
  function prettyAction(action) {
    if (!action) return "Event";
    var s = action.replace(/\./g, " ").replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ─── Alerts sub-page ───────────────────────────────────────────────────
  // The destination for every push notification enrolled from mobile
  // (PushSubscription.surface = "mobile" → /mobile.html#more/alerts). Without
  // this route the hash resolves to nothing and app.js's routeChanged bounces
  // unknown routes to #search — i.e. a push tap would land on an empty search
  // box. Read-only for now; acknowledge/clear stay on desktop.
  registerSub("alerts", {
    renderTopbar: function () { return backTopbar("Alerts"); },
    render: function (body) {
      body.innerHTML = loadingHtml();
      return api.alerts.list({ limit: 100 }).then(function (resp) {
        var alerts = (resp && resp.notifications) || [];
        if (alerts.length === 0) {
          body.innerHTML = '<div class="empty-state" style="padding-top:48px;"><div class="icon"><svg viewBox="0 0 24 24"><use href="#i-bell"/></svg></div><div class="ttl">No active alerts</div><div class="desc">Nothing is firing right now.</div></div>';
          return;
        }
        var html = "";
        alerts.forEach(function (n, i) {
          var sev = n.severity || "info";
          var leadCls = sev === "critical" || sev === "error" ? "error" : (sev === "warning" ? "warning" : "");
          var iconHref = sev === "critical" || sev === "error" ? "#i-down-arrow" : (sev === "warning" ? "#i-warn" : "#i-info");
          var meta = formatTimeAgo(n.triggeredAt);
          if (n.acknowledged) meta += " · acknowledged";
          html += ''
            + '<button class="list-item three-line" data-aid="' + escapeHtml(n.assetId || "") + '">'
            + '  <span class="leading ' + leadCls + '"><svg viewBox="0 0 24 24"><use href="' + iconHref + '"/></svg></span>'
            + '  <div class="content">'
            + '    <div class="headline">' + escapeHtml(sev.toUpperCase()) + (n.assetHostname ? " · " + escapeHtml(n.assetHostname) : "") + '</div>'
            + '    <div class="supporting" style="white-space:normal;">' + escapeHtml(n.message || "") + '</div>'
            + '    <div class="supporting mono" style="font-size:12px;color:var(--md-on-surface-variant);margin-top:4px;">' + escapeHtml(meta) + '</div>'
            + '  </div>'
            + '</button>'
            + (i < alerts.length - 1 ? '<div class="list-divider"></div>' : '');
        });
        body.innerHTML = html;
        body.querySelectorAll(".list-item").forEach(function (row) {
          row.addEventListener("click", function () {
            var aid = row.dataset.aid;
            // The alert may outlive its asset (assetId is nullable and the
            // hostname is snapshotted), so only navigate when there's one.
            if (!aid) return;
            if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(aid);
            else PolarisRouter.go("asset/" + aid);
          });
        });
      }).catch(function (err) { body.innerHTML = errorState(err && err.message ? err.message : "error"); });
    },
  });

  // ─── Add to Home Screen sub-page ───────────────────────────────────────
  registerSub("install", {
    renderTopbar: function () { return backTopbar("Add to Home Screen"); },
    render: function (body) {
      var ios = window.PolarisInstall && PolarisInstall.isIos();
      var firefox = window.PolarisInstall && PolarisInstall.isFirefox();
      var steps;
      if (ios) {
        steps = ['Tap the <b>Share</b> button at the bottom of Safari.',
                 'Scroll down and tap <b>Add to Home Screen</b>.',
                 'Tap <b>Add</b>.',
                 'Open Polaris from your home screen — then come back to <b>More → Push notifications</b> to turn alerts on.'];
      } else if (firefox) {
        // Firefox can install, it just never implemented beforeinstallprompt,
        // so there's no button we can offer — only its own menu.
        steps = ['Open the Firefox menu (⋮).',
                 'Tap <b>Add to Home screen</b> (older builds) or <b>Install</b>.',
                 'Confirm.',
                 'Open Polaris from your home screen.'];
      } else {
        steps = ['Open your browser menu (⋮).',
                 'Tap <b>Install app</b> or <b>Add to Home screen</b>.',
                 'Confirm.',
                 'Open Polaris from your home screen.'];
      }

      var html = ''
        + '<div style="padding:24px 20px 8px;">'
        + '  <div class="ty-title-m" style="margin-bottom:8px;">Install Polaris</div>'
        + '  <div class="ty-body-m" style="color:var(--md-on-surface-variant);">Runs full screen, launches from your home screen, and can send you alert notifications.</div>'
        + '</div>';

      if (ios) {
        // Not a nicety on iOS: Apple grants Web Push only to an installed
        // home-screen web app, so this page IS the enrollment prerequisite.
        html += ''
          + '<div style="margin:8px 20px 4px;padding:12px 14px;border-radius:12px;background:var(--md-secondary-container);color:var(--md-on-secondary-container);" class="ty-body-m">'
          + '  On iPhone and iPad, notifications only work once Polaris is installed to the home screen. This is an Apple restriction.'
          + '</div>';
      }

      html += '<ol style="margin:12px 20px 24px;padding-left:20px;line-height:1.9;" class="ty-body-m">';
      steps.forEach(function (s) { html += '<li>' + s + '</li>'; });
      html += '</ol>';

      body.innerHTML = html;
    },
  });

  // ─── Menu (root More) ──────────────────────────────────────────────────
  function renderMenu(body, ctx) {
    var user = ctx.user || {};
    var displayName = user.displayName || user.username || "user";
    var role = user.role || "?";

    var themeIsDark = (window.PolarisTheme ? PolarisTheme.get() : "dark") === "dark";
    var standalone = !!(window.PolarisInstall && PolarisInstall.isStandalone());

    body.innerHTML = ''
      + '<div class="section-head">Network</div>'
      + menuRow("blocks", "i-block",   "Blocks",       "")
      + '<div class="list-divider"></div>'
      + menuRow("subnets", "i-subnet", "Networks",     "")

      + '<div class="section-head">Operations</div>'
      + menuRow("alerts", "i-bell", "Alerts", "Active alerts")
      + '<div class="list-divider"></div>'
      + menuRow("events", "i-event", "Events", "Audit log · last 7 days")

      // Hidden until wirePushRow() resolves polarisPush.status(): the row is
      // meaningless (and sometimes actively wrong) until we know whether the
      // browser supports push and whether the server has Web Push configured.
      + '<div class="section-head" id="push-section-head" style="display:none;">Notifications</div>'
      + '<button class="list-item two-line" id="push-toggle-row" style="display:none;">'
      + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-bell"/></svg></span>'
      + '  <div class="content">'
      + '    <div class="headline">Push notifications</div>'
      + '    <div class="supporting" id="push-status-label">Checking…</div>'
      + '  </div>'
      + '</button>'

      + '<div class="section-head" id="install-section-head" style="display:none;">App</div>'
      + '<button class="list-item two-line" id="install-row" style="display:none;">'
      + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-desktop"/></svg></span>'
      + '  <div class="content">'
      + '    <div class="headline">Add to Home Screen</div>'
      + '    <div class="supporting" id="install-sub">Install Polaris on this phone</div>'
      + '  </div>'
      + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
      + '</button>'

      + '<div class="section-head">Appearance</div>'
      + '<button class="list-item two-line" id="theme-toggle-row">'
      + '  <span class="leading"><svg viewBox="0 0 24 24" id="theme-toggle-icon"><use href="#' + (themeIsDark ? "i-sun" : "i-moon") + '"/></svg></span>'
      + '  <div class="content">'
      + '    <div class="headline">Theme</div>'
      + '    <div class="supporting" id="theme-current-label">' + (themeIsDark ? "Dark" : "Light") + '</div>'
      + '  </div>'
      + '</button>'

      + '<div class="section-head">Account</div>'
      + '<div class="list-item two-line">'
      + '  <span class="leading tertiary"><svg viewBox="0 0 24 24"><use href="#i-person"/></svg></span>'
      + '  <div class="content"><div class="headline">' + escapeHtml(displayName) + '</div><div class="supporting">' + escapeHtml(role) + '</div></div>'
      + '</div>'
      + '<div class="list-divider"></div>'
      // In an installed app, manifest scope "/" means this link would open the
      // full desktop layout INSIDE the standalone window — no address bar, no
      // back button, no way out. Hand it to the real browser instead.
      + '<a class="list-item two-line" href="/index.html?desktop=1"'
      + (standalone ? ' target="_blank" rel="noopener"' : '') + '>'
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

    body.querySelectorAll("[data-sub]").forEach(function (row) {
      row.addEventListener("click", function () {
        PolarisRouter.go("more/" + row.dataset.sub);
      });
    });

    var themeToggle = document.getElementById("theme-toggle-row");
    if (themeToggle) {
      themeToggle.addEventListener("click", function () {
        var nowDark = (window.PolarisTheme ? PolarisTheme.get() : "dark") === "dark";
        var next = nowDark ? "light" : "dark";
        if (window.PolarisTheme) PolarisTheme.set(next);
        // Update the row in place — supporting label + icon — instead of
        // re-rendering the whole tab.
        var label = document.getElementById("theme-current-label");
        if (label) label.textContent = next === "dark" ? "Dark" : "Light";
        var iconSvg = document.getElementById("theme-toggle-icon");
        if (iconSvg) {
          var useEl = iconSvg.querySelector("use");
          if (useEl) useEl.setAttribute("href", next === "dark" ? "#i-sun" : "#i-moon");
        }
      });
    }

    wirePushRow();
    wireInstallRow();

    document.getElementById("sign-out-btn").addEventListener("click", function () {
      // _csrfHeaders is the api.js canonical (carries the stale-Secure-cookie
      // detection this inline copy bypassed — 2026-08 audit).
      fetch("/api/v1/auth/logout", { method: "POST", headers: _csrfHeaders() })
        .finally(function () { window.PolarisMobile.boot(); });
    });

    fetch("/api/v1/auth/me").then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (!data || !data.version) return;
      var v = data.version;
      var tag = (typeof v === "string") ? v : (v.tag || (v.major + "." + v.minor + "." + v.patch));
      var el = document.getElementById("version-line");
      if (el) el.textContent = "Polaris " + tag;
    }).catch(function () {});
  }

  // ─── Push notifications row ────────────────────────────────────────────
  // Six states. The resolved status is held in a closure so the click handler
  // can branch SYNCHRONOUSLY — awaiting status() inside the handler burns the
  // click's transient user activation and Safari then refuses the permission
  // prompt (see the ordering comment in push.js).
  function wirePushRow() {
    var head = document.getElementById("push-section-head");
    var row = document.getElementById("push-toggle-row");
    var label = document.getElementById("push-status-label");
    if (!head || !row || !label) return;

    if (!window.polarisPush || !polarisPush.isSupported()) return; // stays hidden

    var state = null;
    var busy = false;

    function show(text, dimmed) {
      head.style.display = "";
      row.style.display = "";
      row.style.opacity = dimmed ? ".6" : "";
      label.textContent = text;
    }

    function paint(st) {
      state = st;
      // Server has no Web Push channel configured — keep the control hidden
      // rather than offer a button that can only error. Mirrors automations.js.
      if (!st || !st.enabledOnServer) { head.style.display = "none"; row.style.display = "none"; return; }

      // iOS grants Web Push ONLY to an installed home-screen app. On iOS 16.4+
      // "PushManager" in window is true even in plain Safari, so isSupported()
      // passes and a naive UI would offer a button that always throws.
      if (window.PolarisInstall && PolarisInstall.isIos() && !PolarisInstall.isStandalone()) {
        show("Add to Home Screen to enable push", true);
        return;
      }
      // "denied" is sticky: requestPermission() resolves instantly with no UI,
      // so re-prompting is pointless. Only browser settings can undo it.
      if (st.permission === "denied") { show("Blocked — allow notifications in your browser settings", true); return; }
      if (st.subscribed) { show("On — tap to turn off", false); return; }
      show("Off — tap to turn on", false);
    }

    row.addEventListener("click", function () {
      if (busy || !state) return;

      if (window.PolarisInstall && PolarisInstall.isIos() && !PolarisInstall.isStandalone()) {
        PolarisRouter.go("more/install");
        return;
      }
      if (state.permission === "denied") {
        PolarisTabs.showSnackbar("Notifications are blocked for this site in your browser settings.");
        return;
      }

      busy = true;
      var wasSubscribed = !!state.subscribed;
      label.textContent = wasSubscribed ? "Turning off…" : "Turning on…";

      // No await before enable() — see the closure note above.
      var action = wasSubscribed
        ? polarisPush.disable()
        : polarisPush.enable({ surface: "mobile" });

      action.then(function () {
        PolarisTabs.showSnackbar(wasSubscribed ? "Push notifications turned off" : "Push notifications turned on");
      }).catch(function (err) {
        PolarisTabs.showSnackbar((err && err.message) || "Couldn't change push notifications");
      }).then(function () {
        busy = false;
        return polarisPush.status().then(paint).catch(function () {});
      });
    });

    polarisPush.status().then(paint).catch(function () { /* stays hidden */ });
  }

  // ─── Add-to-Home-Screen row ────────────────────────────────────────────
  function wireInstallRow() {
    var head = document.getElementById("install-section-head");
    var row = document.getElementById("install-row");
    var sub = document.getElementById("install-sub");
    if (!head || !row || !sub || !window.PolarisInstall) return;

    function paint() {
      // Already installed — nothing to offer.
      if (PolarisInstall.isStandalone()) { head.style.display = "none"; row.style.display = "none"; return; }

      // Otherwise ALWAYS offer it. `canPrompt()` only tells us whether we can
      // trigger the install ourselves; a browser without beforeinstallprompt
      // (Firefox for Android, Safari) can still install from its own menu, so
      // hiding the row there left those users with no affordance at all.
      head.style.display = ""; row.style.display = "";
      sub.textContent = PolarisInstall.isIos()
        ? "Required for notifications on iPhone"
        : (PolarisInstall.canPrompt() ? "Install Polaris on this phone" : "How to install on this browser");
    }

    row.addEventListener("click", function () {
      // Native prompt when the browser gives us one; step-by-step instructions
      // for every browser that doesn't.
      if (!PolarisInstall.isIos() && PolarisInstall.canPrompt()) {
        PolarisInstall.prompt().then(function (outcome) {
          if (outcome === "accepted") PolarisTabs.showSnackbar("Polaris added to your home screen");
          paint();
        });
        return;
      }
      PolarisRouter.go("more/install");
    });

    // beforeinstallprompt can land AFTER this tab has painted.
    PolarisInstall.onChange(function () {
      if (document.getElementById("install-row") === row) paint();
    });
    paint();
  }

  function menuRow(sub, iconId, title, supporting) {
    var supLine = supporting ? '<div class="supporting">' + escapeHtml(supporting) + '</div>' : '';
    return ''
      + '<button class="list-item ' + (supporting ? "two-line" : "") + '" data-sub="' + sub + '">'
      + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#' + iconId + '"/></svg></span>'
      + '  <div class="content"><div class="headline">' + escapeHtml(title) + '</div>' + supLine + '</div>'
      + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
      + '</button>';
  }

  // ─── Tab spec ──────────────────────────────────────────────────────────
  var More = {
    title: "More",
    icon: "#i-more",
    renderTopbar: function (ctx) {
      var sub = ctx.route && ctx.route.parts && ctx.route.parts[0];
      var subSpec = sub && SUB_PAGES[sub];
      if (subSpec) return subSpec.renderTopbar(ctx);
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">More</div>'
        + '  <div class="trailing"></div>'
        + '</div>';
    },
    render: function (body, ctx) {
      var sub = ctx.route && ctx.route.parts && ctx.route.parts[0];
      var subSpec = sub && SUB_PAGES[sub];
      if (subSpec) return subSpec.render(body, ctx);
      return renderMenu(body, ctx);
    },
    // PTR only meaningful on the list sub-pages (blocks / subnets /
    // events). The root menu is static and has nothing to refresh.
    enablesPullToRefresh: function (ctx) {
      var sub = ctx && ctx.route && ctx.route.parts && ctx.route.parts[0];
      return !!(sub && SUB_PAGES[sub]);
    },
    onPullToRefresh: function (ctx) {
      var sub = ctx && ctx.route && ctx.route.parts && ctx.route.parts[0];
      var subSpec = sub && SUB_PAGES[sub];
      if (!subSpec) return null;
      var body = document.getElementById("app-body");
      if (!body) return null;
      return subSpec.render(body, ctx);
    },
  };

  window.PolarisMoreTab = { spec: More };
})();
