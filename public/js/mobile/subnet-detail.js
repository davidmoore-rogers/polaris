// public/js/mobile/subnet-detail.js — Subnet detail + Reserve sheet.
//
// Phase 8 deliverable. Two pieces:
//   1. Subnet detail screen (#subnet/<id>): info hero + paged IP list with
//      reservation status. Tapping a reserved row navigates to the linked
//      asset; tapping a free row opens the Reserve sheet pre-filled with
//      that IP.
//   2. Reserve sheet (modal): IP / hostname / owner / MAC (required when
//      `pushEligible`) + collapsible "more fields" for notes / projectRef /
//      expiresAt. POST /reservations on submit.
//
// Role gates: readonly users see the list but no Reserve FAB and tapping
// a free IP shows a snackbar instead of the sheet. user / assetsadmin /
// networkadmin / admin can reserve. The mobile UI doesn't expose
// ownership-edit guarding yet; release happens on desktop.

(function () {
  var IP_PAGE_SIZE = 256;

  // Per-subnet state cache so navigating back from a quick reserve doesn't
  // refetch the IP list.
  var _mounts = Object.create(null);
  function mountState(id) {
    if (!_mounts[id]) {
      _mounts[id] = { subnet: null, ips: [], page: 1, totalIps: 0, loading: false, ipv6: false };
    }
    return _mounts[id];
  }

  // Roles that can create reservations.
  var WRITE_ROLES = ["admin", "networkadmin", "assetsadmin", "user"];
  function canWrite(user) {
    return !!(user && user.role && WRITE_ROLES.indexOf(user.role) !== -1);
  }

  // ─── Top-level renderers ───────────────────────────────────────────────
  function renderTopbar(ctx) {
    return ''
      + '<div class="m3-topbar">'
      + '  <div class="leading">'
      + '    <button class="icon-btn" id="subnet-back-btn" aria-label="Back"><svg viewBox="0 0 24 24"><use href="#i-back"/></svg></button>'
      + '  </div>'
      + '  <div class="title" id="subnet-topbar-title">Subnet</div>'
      + '  <div class="trailing"></div>'
      + '</div>';
  }

  function render(body, ctx) {
    var id = (ctx.route && ctx.route.parts && ctx.route.parts[0]) || "";
    if (!id) {
      body.innerHTML = '<div class="empty-state" style="padding-top:64px;"><div class="ttl">Subnet id missing</div></div>';
      return;
    }
    var st = mountState(id);
    body.innerHTML = ''
      + '<div id="subnet-host"><div class="loading-screen"><div class="spinner"></div></div></div>'
      + (canWrite(ctx.user)
        ? '<button class="fab fab-ext" id="subnet-fab" style="position:fixed;right:16px;bottom:calc(var(--navbar-h) + 16px);z-index:30;display:none;"><svg viewBox="0 0 24 24"><use href="#i-add"/></svg>Reserve</button>'
        : '');

    var back = document.getElementById("subnet-back-btn");
    if (back) back.addEventListener("click", function () {
      if (window.history.length > 1) window.history.back();
      else PolarisRouter.go("more/subnets", { replace: true });
    });

    loadSubnet(id, st, ctx.user);
  }

  function loadSubnet(id, st, user) {
    api.subnets.ips(id, { page: 1, pageSize: IP_PAGE_SIZE }).then(function (resp) {
      st.subnet = resp.subnet;
      st.ips = resp.ips || [];
      st.page = resp.page || 1;
      st.totalIps = resp.totalIps || st.ips.length;
      st.ipv6 = !!resp.ipv6;
      var topbar = document.getElementById("subnet-topbar-title");
      if (topbar) topbar.textContent = st.subnet.name || st.subnet.cidr || "Subnet";

      renderShell(st, user);

      var fab = document.getElementById("subnet-fab");
      if (fab) {
        fab.style.display = "";
        fab.addEventListener("click", function () { openReserveSheet(id, st, user, null); });
      }
    }).catch(function (err) {
      var host = document.getElementById("subnet-host");
      if (host) host.innerHTML = errorState(err && err.message ? err.message : "Failed to load subnet");
    });
  }

  function errorState(msg) {
    return ''
      + '<div class="empty-state" style="padding-top:48px;">'
      + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
      + '  <div class="ttl">Couldn’t load subnet</div>'
      + '  <div class="desc">' + escapeHtml(msg) + '</div>'
      + '</div>';
  }

  function renderShell(st, user) {
    var host = document.getElementById("subnet-host");
    if (!host) return;
    var s = st.subnet;
    var heroBits = [];
    heroBits.push('<span class="mono">' + escapeHtml(s.cidr) + '</span>');
    if (s.purpose) heroBits.push(escapeHtml(s.purpose));
    if (s.vlan) heroBits.push("VLAN " + s.vlan);
    if (s.fortigateDevice) heroBits.push(escapeHtml(s.fortigateDevice));

    var pushBadge = s.pushEligible
      ? '<span class="status-pill warn" style="margin-top:8px;display:inline-flex;"><svg viewBox="0 0 24 24" width="14" height="14" style="fill:currentColor;"><use href="#i-info"/></svg>DHCP-push subnet — MAC required</span>'
      : '';

    var reservedCount = st.ips.filter(function (i) { return i.reservation; }).length;
    var paged = st.ips.length < st.totalIps;

    host.innerHTML = ''
      + '<div class="asset-hero">'
      + '  <div class="hero-name">' + escapeHtml(s.name || s.cidr) + '</div>'
      + '  <div class="hero-sub">' + heroBits.join(" · ") + '</div>'
      + '  ' + pushBadge
      + '</div>'
      + '<div class="section-head">IPs<span class="count">' + reservedCount + ' reserved · ' + (st.totalIps + (paged ? "+" : "")) + ' total</span></div>'
      + '<div id="subnet-ip-list"></div>'
      + (paged ? '<div style="text-align:center;padding:12px 0 24px;color:var(--md-on-surface-variant);font-size:12px;">Showing first ' + st.ips.length + ' addresses — open subnet on desktop for full pagination.</div>' : '');

    renderIpList(st, user);
  }

  function renderIpList(st, user) {
    var host = document.getElementById("subnet-ip-list");
    if (!host) return;

    var html = "";
    st.ips.forEach(function (ip, idx) {
      var r = ip.reservation;
      var reserved = !!r;
      var iconHref = reserved ? "#i-bookmark" : "#i-add";
      var leadCls  = reserved ? "tonal" : "";
      var headlineMain = '<span class="mono">' + escapeHtml(ip.address) + '</span>';
      var sub = "";
      if (reserved) {
        var bits = [];
        if (r.hostname) bits.push(escapeHtml(r.hostname));
        if (r.owner) bits.push(escapeHtml(r.owner));
        if (r.sourceType && r.sourceType !== "manual") bits.push(escapeHtml(r.sourceType.replace(/_/g, " ")));
        sub = bits.join(" · ");
      } else {
        sub = ip.type === "host" ? "Free" : escapeHtml(ip.type);
      }
      html += ''
        + '<button class="list-item' + (sub ? " two-line" : "") + '" data-ip="' + escapeHtml(ip.address) + '" data-reserved="' + (reserved ? "1" : "0") + '" data-asset="' + escapeHtml(ip.assetId || "") + '" data-type="' + escapeHtml(ip.type) + '">'
        + '  <span class="leading ' + leadCls + '"><svg viewBox="0 0 24 24"><use href="' + iconHref + '"/></svg></span>'
        + '  <div class="content">'
        + '    <div class="headline">' + headlineMain + '</div>'
        + (sub ? '    <div class="supporting">' + sub + '</div>' : '')
        + '  </div>'
        + '</button>'
        + (idx < st.ips.length - 1 ? '<div class="list-divider"></div>' : '');
    });
    host.innerHTML = html;

    host.querySelectorAll(".list-item").forEach(function (row) {
      row.addEventListener("click", function () {
        var ip = row.dataset.ip;
        var reserved = row.dataset.reserved === "1";
        var assetId = row.dataset.asset;
        var type = row.dataset.type;
        if (reserved) {
          if (assetId) PolarisRouter.go("asset/" + assetId);
          else PolarisTabs.showSnackbar(ip + " — reserved (no linked asset)");
          return;
        }
        if (type !== "host") {
          PolarisTabs.showSnackbar(ip + " — " + type + " address (not reservable)");
          return;
        }
        if (!canWrite(user)) {
          PolarisTabs.showSnackbar("Read-only role — reservations live on desktop.");
          return;
        }
        // Find subnetId from the route (the host element doesn't carry it)
        var subnetRoute = PolarisRouter.current();
        var subnetId = subnetRoute.parts[0];
        var st = mountState(subnetId);
        openReserveSheet(subnetId, st, user, ip);
      });
    });
  }

  // ─── Reserve sheet ─────────────────────────────────────────────────────
  function openReserveSheet(subnetId, st, user, prefilledIp) {
    closeReserveSheet();

    var s = st.subnet;
    var pushEligible = !!s.pushEligible;
    var defaultIp = prefilledIp || pickNextFreeIp(st) || "";

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "reserve-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "reserve-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      + '  <h3 class="sheet-title" style="margin:0;">Reserve IP</h3>'
      + '  <button class="icon-btn" id="reserve-close-btn" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div id="reserve-error" class="hidden" style="background:var(--md-error-container);color:var(--md-on-error-container);border-radius:var(--shape-xs);padding:10px 14px;font-size:13px;margin-bottom:12px;letter-spacing:.25px;"></div>'
      + '<form id="reserve-form" autocomplete="off">'
      + '  <div class="tf-outlined"><span class="lbl">IP address</span>'
      + '    <input class="field mono" id="r-ip" value="' + escapeHtml(defaultIp) + '" required>'
      + '    <div class="support">Inside ' + escapeHtml(s.cidr) + '</div>'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Hostname</span>'
      + '    <input class="field" id="r-hostname" maxlength="100">'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Owner</span>'
      + '    <input class="field" id="r-owner" value="' + escapeHtml((user && user.username) || "") + '" maxlength="100">'
      + '  </div>'
      + (pushEligible
        ? '  <div class="tf-outlined"><span class="lbl">MAC address *</span>'
          + '    <input class="field mono" id="r-mac" placeholder="aa:bb:cc:dd:ee:ff" required>'
          + '    <div class="support">Will be pushed to ' + escapeHtml(s.fortigateDevice || "FortiGate") + ' as a DHCP reservation.</div>'
          + '  </div>'
        : '  <div class="tf-outlined"><span class="lbl">MAC address</span>'
          + '    <input class="field mono" id="r-mac" placeholder="optional">'
          + '  </div>')
      + '  <details style="margin-bottom:16px;">'
      + '    <summary style="color:var(--md-primary);font-size:14px;font-weight:500;letter-spacing:.1px;cursor:pointer;padding:8px 0;">More fields</summary>'
      + '    <div class="tf-outlined" style="margin-top:12px;"><span class="lbl">Project / ticket</span>'
      + '      <input class="field" id="r-project" maxlength="120">'
      + '    </div>'
      + '    <div class="tf-outlined"><span class="lbl">Notes</span>'
      + '      <input class="field" id="r-notes" maxlength="500">'
      + '    </div>'
      + '    <div class="tf-outlined"><span class="lbl">Expires (YYYY-MM-DD)</span>'
      + '      <input class="field mono" id="r-expires" placeholder="">'
      + '    </div>'
      + '  </details>'
      + '  <div style="display:flex;justify-content:flex-end;gap:8px;">'
      + '    <button type="button" class="btn btn-text" id="reserve-cancel">Cancel</button>'
      + '    <button type="submit" class="btn btn-filled" id="reserve-submit">Reserve</button>'
      + '  </div>'
      + '</form>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeReserveSheet);
    document.getElementById("reserve-close-btn").addEventListener("click", closeReserveSheet);
    document.getElementById("reserve-cancel").addEventListener("click", closeReserveSheet);
    document.getElementById("reserve-form").addEventListener("submit", function (e) {
      e.preventDefault();
      onSubmit(subnetId, st, user);
    });
  }

  function closeReserveSheet() {
    var s = document.getElementById("reserve-sheet");
    var sc = document.getElementById("reserve-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }

  function pickNextFreeIp(st) {
    for (var i = 0; i < st.ips.length; i++) {
      var ip = st.ips[i];
      if (ip.type === "host" && !ip.reservation) return ip.address;
    }
    return "";
  }

  function showReserveError(msg) {
    var el = document.getElementById("reserve-error");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  function clearReserveError() {
    var el = document.getElementById("reserve-error");
    if (el) el.classList.add("hidden");
  }

  function onSubmit(subnetId, st, user) {
    clearReserveError();
    var ip       = (document.getElementById("r-ip").value || "").trim();
    var hostname = (document.getElementById("r-hostname").value || "").trim();
    var owner    = (document.getElementById("r-owner").value || "").trim();
    var mac      = (document.getElementById("r-mac") ? document.getElementById("r-mac").value || "" : "").trim();
    var project  = (document.getElementById("r-project") ? document.getElementById("r-project").value || "" : "").trim();
    var notes    = (document.getElementById("r-notes") ? document.getElementById("r-notes").value || "" : "").trim();
    var expires  = (document.getElementById("r-expires") ? document.getElementById("r-expires").value || "" : "").trim();

    if (!ip) { showReserveError("IP address is required"); return; }
    var body = { subnetId: subnetId, ipAddress: ip };
    if (hostname) body.hostname = hostname;
    if (owner) body.owner = owner;
    if (mac) body.macAddress = mac;
    if (project) body.projectRef = project;
    if (notes) body.notes = notes;
    if (expires) body.expiresAt = expires;

    var btn = document.getElementById("reserve-submit");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span>';

    api.reservations.create(body).then(function (r) {
      closeReserveSheet();
      PolarisTabs.showSnackbar("Reserved " + ip);
      // Refresh the IP list so the row flips to reserved.
      reloadList(subnetId, st, user);
    }).catch(function (err) {
      btn.disabled = false;
      btn.innerHTML = "Reserve";
      showReserveError(err && err.message ? err.message : "Reservation failed");
    });
  }

  function reloadList(subnetId, st, user) {
    api.subnets.ips(subnetId, { page: 1, pageSize: IP_PAGE_SIZE }).then(function (resp) {
      st.ips = resp.ips || [];
      st.totalIps = resp.totalIps || st.ips.length;
      renderIpList(st, user);
    }).catch(function () { /* ignore */ });
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  window.PolarisSubnetDetail = {
    spec: {
      parentTab: null,
      renderTopbar: renderTopbar,
      render: render,
    },
  };
})();
