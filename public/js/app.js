/**
 * public/js/app.js — Shared UI utilities: nav, toasts, modals, helpers
 */

// ─── Theme ──────────────────────────────────────────────────────────────────

(function () {
  var saved = localStorage.getItem("polaris-theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
})();

function _getCurrentTheme() {
  return document.documentElement.getAttribute("data-theme") || "dark";
}

function _setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("polaris-theme", theme);
  // Update toggle button label if it exists
  var btn = document.getElementById("btn-theme-toggle");
  if (btn) {
    var isDark = theme === "dark";
    btn.querySelector("svg").outerHTML = isDark ? _sunIcon() : _moonIcon();
    btn.querySelector("span").textContent = isDark ? "Light Mode" : "Dark Mode";
  }
}

function _sunIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
}

function _moonIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
}

// ─── Current User ────────────────────────────────────────────────────────────
//
// After the dynamic-roles cutover `currentUserRole` carries the role NAME
// (string) for the few surfaces that need role identity (visual badge,
// sidebar polling). All real capability checks consult
// `currentRolePermissions` via the permAtLeast(functionKey, level) helper —
// the canX() back-compat shims have been rewritten to call it so existing
// call sites keep working.
//
// `currentEffectiveRegions` is the union of role.regionTags and user.regionTags.
// Storage-only in v1; consumers (asset/subnet/reservation list filters,
// map view) will read it in a follow-on change.

var currentUserRole = null;          // role name (string)
var currentRolePermissions = {};     // { [functionKey]: "none"|"read"|"write"|"fullwrite" }
var currentEffectiveRegions = [];    // string[]
var currentUserRegions = [];         // user.regionTags
var currentRoleRegions = [];         // role.regionTags
var currentUsername = null;
var _userReadyResolve = null;
var userReady = new Promise(function (resolve) { _userReadyResolve = resolve; });

async function fetchCurrentUser() {
  try {
    var data = await fetch("/api/v1/auth/me").then(function (r) { return r.json(); });
    if (data.authenticated) {
      currentUserRole = (data.role && data.role.name) || null;
      currentRolePermissions = (data.role && data.role.permissions) || {};
      currentUsername = data.username;
      currentUserRegions = (data.regionTags && data.regionTags.user) || [];
      currentRoleRegions = (data.regionTags && data.regionTags.role) || [];
      currentEffectiveRegions = (data.regionTags && data.regionTags.effective) || [];
      try {
        localStorage.setItem("polaris-user", JSON.stringify({
          role: currentUserRole,
          permissions: currentRolePermissions,
          username: data.username,
          regions: currentEffectiveRegions,
        }));
      } catch (_) {}
    } else {
      try { localStorage.removeItem("polaris-user"); } catch (_) {}
    }
  } catch (_) {}
  if (_userReadyResolve) { _userReadyResolve(); _userReadyResolve = null; }
  return currentUserRole;
}

// permAtLeast(functionKey, level) — the canonical capability check.
// none < read < write < fullwrite. Use this for any "can the user do X"
// branch; the canX() shims below are convenience wrappers for the most
// common patterns.
var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
function permLevel(key) { return currentRolePermissions[key] || "none"; }
function permAtLeast(key, level) {
  return (_PERM_RANK[permLevel(key)] || 0) >= (_PERM_RANK[level] || 0);
}

// Role-name shims — kept for places that genuinely need to know the role
// identity (sidebar admin-only menu items, role-name display badge). DO
// NOT use these for new capability checks — use permAtLeast(key, level).
function isAdmin() { return currentUserRole === "admin"; }
function isNetworkAdmin() { return currentUserRole === "networkadmin"; }
function isAssetsAdmin() { return currentUserRole === "assetsadmin"; }

// Capability shims — rewritten to consult the permission matrix. The
// names map to the closest function-key check that matches the old
// hardcoded-role behavior. Custom roles with the relevant grant pass.
function canManageNetworks() { return permAtLeast("subnets", "fullwrite"); }
function canManageAssets() { return permAtLeast("assets", "write"); }
function isUserOrAbove() { return permAtLeast("subnets", "write") || permAtLeast("reservations", "write"); }
function canReviewConflicts() { return permAtLeast("discoveryConflicts", "write"); }
function canReserveIps() { return permAtLeast("reservations", "write"); }
function canCreateNetworks() { return permAtLeast("subnets", "write"); }
function canEditSubnet(subnet) {
  if (permAtLeast("subnets", "fullwrite")) return true;
  if (!permAtLeast("subnets", "write")) return false;
  return !!(subnet && subnet.createdBy && subnet.createdBy === currentUsername);
}
function canEditReservation(reservation) {
  if (permAtLeast("reservations", "fullwrite")) return true;
  if (!permAtLeast("reservations", "write")) return false;
  return !!(reservation && reservation.createdBy && reservation.createdBy === currentUsername);
}

// ─── Sidebar Navigation ──────────────────────────────────────────────────────

const NAV_ITEMS = [
  { href: "/",                label: "Dashboard",    icon: "grid" },
  { href: "/map.html",        label: "Device Map",   icon: "mapPin" },
  { href: "/ipam.html",       label: "IPAM",         icon: "layers" },
  { href: "/assets.html",         label: "Assets",       icon: "monitor" },
  { href: "/events.html",         label: "Events",       icon: "activity" },
  { href: "/integrations.html",  label: "Integrations", icon: "plug", networkAdmin: true },
  { href: "/users.html",        label: "Users",        icon: "users", adminOnly: true },
];

const ICONS = {
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  mapPin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 01-12 0V8h12z"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
};

function renderNav() {
  const current = window.location.pathname;
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  const visibleItems = NAV_ITEMS.filter(function (item) {
    if (item.adminOnly) return isAdmin();
    if (item.networkAdmin) return canManageNetworks();
    return true;
  });

  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <img src="/logo.png" alt="" class="sidebar-logo" style="visibility:hidden">
      <h1 style="font-size:1.1rem;font-weight:600;margin:0.5rem 0 0;color:var(--color-text-primary);text-align:center;visibility:hidden">Polaris</h1>
      <p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.15rem 0 0;text-align:center;visibility:hidden">Network Management Tool</p>
    </div>
    <ul class="sidebar-nav">
      ${visibleItems.map(item => {
        let isActive = current === item.href || (item.href === "/" && (current === "/index.html" || current === "/"));
        // IPAM absorbs the legacy /blocks.html and /subnets.html surfaces;
        // mark the IPAM entry active when the user is on those URLs (they
        // get redirected by the express layer but the active class needs
        // to match either form pre-redirect on hard reloads).
        if (item.href === "/ipam.html" && (current === "/blocks.html" || current === "/subnets.html")) {
          isActive = true;
        }
        let dot = "";
        if (item.href === "/events.html") {
          dot = '<span class="nav-conflict-dot" id="nav-conflict-dot" style="display:none"></span>';
        } else if (item.href === "/ipam.html") {
          // Stale-reservation alert indicator — sourced from
          // /api/v1/reservations/alerts/count. Polled in lockstep with the
          // conflict dot below; refreshed after operator actions on the
          // Alerts panel via window.refreshAlertsDot(). Moved from the
          // standalone Networks entry when IPAM consolidation landed.
          dot = '<span class="nav-alerts-dot" id="nav-alerts-dot" style="display:none"></span>';
        }
        return `<li><a href="${item.href}" class="${isActive ? "active" : ""}">${ICONS[item.icon]}<span>${item.label}</span>${dot}</a></li>`;
      }).join("")}
    </ul>
    <div style="margin-top:auto">
      <div id="role-review-status" class="query-status role-review-status" style="display:none"></div>
      <div id="query-status" class="query-status" style="display:none"></div>
      <div id="capacity-critical-alert" class="capacity-critical-alert" style="display:none"></div>
      ${(isAdmin() || canManageAssets()) ? `<div style="padding:0.5rem 0.5rem 0;border-top:1px solid var(--color-border-light)">
        <a href="/server-settings.html" class="sidebar-bottom-link${current === '/server-settings.html' ? ' active' : ''}">${ICONS.settings}<span>Server Settings</span></a>
      </div>` : ''}
      <div style="padding:${(isAdmin() || canManageAssets()) ? '0.25rem' : '0.5rem'} 0.5rem 0;${(isAdmin() || canManageAssets()) ? '' : 'border-top:1px solid var(--color-border-light);'}">
        <button id="btn-theme-toggle" class="theme-toggle">${_getCurrentTheme() === 'dark' ? _sunIcon() : _moonIcon()}<span>${_getCurrentTheme() === 'dark' ? 'Light Mode' : 'Dark Mode'}</span></button>
      </div>
      <div style="padding:0.25rem 0.5rem 0.75rem">
        <a href="#" id="btn-logout" class="sidebar-bottom-link sidebar-bottom-link-logout">${ICONS.logout}<span>Logout</span></a>
      </div>
      <div id="sidebar-version" style="padding:0 0.75rem 0.75rem;text-align:center;font-size:0.7rem;color:var(--color-text-tertiary);letter-spacing:0.02em"></div>
    </div>
  `;

  document.getElementById("btn-theme-toggle").addEventListener("click", function () {
    _setTheme(_getCurrentTheme() === "dark" ? "light" : "dark");
  });

  document.getElementById("btn-logout").addEventListener("click", async function (e) {
    e.preventDefault();
    try { await fetch("/api/v1/auth/logout", { method: "POST", headers: _csrfHeaders() }); } catch (_) {}
    window.location.href = "/login.html";
  });

  // Wire up query status indicator
  _onQueriesChanged = renderQueryStatus;

  // Poll server for background discoveries (e.g. integration discovery after navigation)
  var _serverDiscoveries = [];
  async function pollDiscoveries() {
    try {
      var result = await api.integrations.discoveries();
      _serverDiscoveries = result.discoveries || [];
    } catch (_) {
      _serverDiscoveries = [];
    }
    renderQueryStatus();
    if (typeof window._onDiscoveriesChanged === "function") window._onDiscoveriesChanged(_serverDiscoveries);
  }
  pollDiscoveries();
  setInterval(pollDiscoveries, 4000);

  // Expose for renderQueryStatus closure and for callers that need an immediate refresh
  window._getServerDiscoveries = function () { return _serverDiscoveries; };
  window._pollDiscoveries = pollDiscoveries;

  // ─── New-user role-review notifications ────────────────────────────────
  // Admin-only sidebar panel. Lists users who just completed their first
  // login so an admin can decide whether to promote them off the default
  // role. Dismiss is global — clearing the flag hides the entry for every
  // admin at once.
  var _roleReviewUsers = [];
  async function pollRoleReviewNotifications() {
    if (!isAdmin()) return;
    try {
      var result = await api.users.roleReviewNotifications();
      _roleReviewUsers = (result && result.users) || [];
    } catch (_) {
      _roleReviewUsers = [];
    }
    renderRoleReviewStatus();
  }
  if (isAdmin()) {
    pollRoleReviewNotifications();
    setInterval(pollRoleReviewNotifications, 30000);
  }
  window._pollRoleReviewNotifications = pollRoleReviewNotifications;
  window._getRoleReviewUsers = function () { return _roleReviewUsers; };

  // Inject global search bar + user badge into page header
  renderGlobalSearch();
  renderUserBadge();

  // Events dot — poll every 30 s; also exposed so events.js can refresh on
  // resolve. Combines two Events-page signals: discovery conflicts AND the
  // reservation push queue (whose Alerts-panel filter view also lives on
  // Events). Either signal alone is operator-actionable.
  async function refreshConflictDot() {
    var dot = document.getElementById("nav-conflict-dot");
    if (!dot) return;
    try {
      var both = await Promise.all([
        canReviewConflicts()
          ? api.conflicts.count().catch(function () { return { count: 0 }; })
          : Promise.resolve({ count: 0 }),
        api.reservations.pushQueueCount().catch(function () { return { count: 0 }; }),
      ]);
      var conflictCount = (both[0] && both[0].count) || 0;
      var queueCount = (both[1] && both[1].count) || 0;
      var total = conflictCount + queueCount;
      dot.style.display = total > 0 ? "inline-block" : "none";
      dot.classList.toggle("nav-conflict-dot--warning", conflictCount === 0 && queueCount > 0);
    } catch (_) {}
  }
  refreshConflictDot();
  setInterval(refreshConflictDot, 30000);
  window.refreshConflictDot = refreshConflictDot;

  // Alerts dot on IPAM — same 30 s polling, same flashing-red pattern as
  // the Events dot. Sources from /reservations/alerts/count which returns
  // just the active (non-ignored, non-snoozed) stale-reservation count.
  // Exposed on window so the Events page Alerts panel can refresh it
  // immediately after Snooze / Free / Ignore / Un-ignore actions.
  async function refreshAlertsDot() {
    var dot = document.getElementById("nav-alerts-dot");
    if (!dot) return;
    try {
      var data = await api.reservations.alertsCount();
      dot.style.display = (data && data.count > 0) ? "inline-block" : "none";
    } catch (_) {}
  }
  refreshAlertsDot();
  setInterval(refreshAlertsDot, 30000);
  window.refreshAlertsDot = refreshAlertsDot;
}

function _getUserInitials(username) {
  if (!username) return "?";
  var parts = username.replace(/[._-]/g, " ").trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return username.substring(0, 2).toUpperCase();
}

function _getInitialsColor(username) {
  var hash = 0;
  for (var i = 0; i < (username || "").length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  var colors = ["#4a9eff", "#34d399", "#f59e0b", "#f472b6", "#a78bfa", "#fb923c", "#38bdf8", "#4ade80"];
  return colors[Math.abs(hash) % colors.length];
}

function _getRoleLabel(role) {
  switch (role) {
    case "admin":        return "Admin";
    case "networkadmin": return "Network Admin";
    case "assetsadmin":  return "Assets Admin";
    case "user":         return "User";
    default:             return role || "";
  }
}

function _getRoleBadgeClass(role) {
  switch (role) {
    case "admin":        return "badge-admin";
    case "networkadmin": return "badge-network-admin";
    case "assetsadmin":  return "badge-assets-admin";
    case "user":         return "badge-available";
    default:             return "badge-readonly";
  }
}

// ─── Global search ──────────────────────────────────────────────────────────
// Injects a search input into .page-header on every authenticated page. Ctrl/Cmd+K
// focuses it; typing queries /api/v1/search and renders a grouped dropdown.

var _searchDebounceTimer = null;
var _searchLastQuery = "";
var _searchActiveResults = null;

function _searchPlaceholder() {
  var path = window.location.pathname;
  if (path.indexOf("/assets.html") !== -1) return "Search assets, hostnames, MACs, serials…";
  if (path.indexOf("/subnets.html") !== -1) return "Search networks, CIDRs, reservations, IPs…";
  if (path.indexOf("/blocks.html") !== -1) return "Search blocks, CIDRs, networks…";
  if (path.indexOf("/events.html") !== -1) return "Search everything — IPs, MACs, hosts, assets…";
  return "Search IPs, CIDRs, hosts, MACs, assets… (Ctrl+K)";
}

function renderGlobalSearch() {
  var pageHeader = document.querySelector(".page-header");
  if (!pageHeader) return;
  if (pageHeader.querySelector(".global-search")) return; // already mounted

  var wrap = document.createElement("div");
  wrap.className = "global-search";
  wrap.innerHTML =
    '<input type="search" id="global-search-input" autocomplete="off" spellcheck="false" placeholder="' + escapeHtml(_searchPlaceholder()) + '">' +
    '<div id="global-search-dropdown" class="global-search-dropdown" style="display:none"></div>';

  // Insert between h2 and page-header-actions (if present)
  var actions = pageHeader.querySelector(".page-header-actions");
  if (actions) pageHeader.insertBefore(wrap, actions);
  else pageHeader.appendChild(wrap);

  var input = document.getElementById("global-search-input");
  var dropdown = document.getElementById("global-search-dropdown");

  input.addEventListener("input", function () {
    var q = input.value.trim();
    clearTimeout(_searchDebounceTimer);
    if (q.length < 2) {
      dropdown.style.display = "none";
      dropdown.innerHTML = "";
      _searchLastQuery = "";
      return;
    }
    _searchDebounceTimer = setTimeout(function () { _performSearch(q); }, 180);
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { input.blur(); _hideSearchDropdown(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
      _handleSearchKeyNav(e);
    }
  });

  input.addEventListener("focus", function () {
    if (_searchActiveResults) dropdown.style.display = "block";
  });

  document.addEventListener("click", function (e) {
    if (!wrap.contains(e.target)) _hideSearchDropdown();
  });

  // Ctrl+K / Cmd+K — focus the search globally
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

async function _performSearch(q) {
  var dropdown = document.getElementById("global-search-dropdown");
  _searchLastQuery = q;
  try {
    var results = await api.search.query(q);
    if (results.query !== _searchLastQuery) return; // stale response
    _searchActiveResults = results;
    _renderSearchDropdown(results);
  } catch (err) {
    dropdown.innerHTML = '<div class="global-search-empty">Search failed: ' + escapeHtml(err.message || "Unknown error") + '</div>';
    dropdown.style.display = "block";
  }
}

function _renderSearchDropdown(results) {
  var dropdown = document.getElementById("global-search-dropdown");
  var sites = results.sites || [];
  var endpointMapHits = (results.assets || [])
    .filter(function (h) { return h.context && h.context.siteId; })
    .map(function (h) {
      return Object.assign({}, h, {
        context: Object.assign({}, h.context, { mapEntry: true }),
      });
    });
  var allSites = sites.concat(endpointMapHits);
  var total = results.blocks.length + results.subnets.length + results.reservations.length + results.assets.length + results.ips.length + allSites.length;
  if (total === 0) {
    dropdown.innerHTML = '<div class="global-search-empty">No matches for "' + escapeHtml(results.query) + '"</div>';
    dropdown.style.display = "block";
    return;
  }

  function section(label, hits) {
    if (!hits.length) return "";
    var rows = hits.map(function (h) {
      return '<div class="gs-item" data-type="' + h.type + '" data-id="' + escapeHtml(h.id) + '"' +
        (h.context ? ' data-context="' + escapeHtml(JSON.stringify(h.context)) + '"' : '') + '>' +
        '<div class="gs-item-title">' + escapeHtml(h.title) + '</div>' +
        (h.subtitle ? '<div class="gs-item-sub">' + escapeHtml(h.subtitle) + '</div>' : '') +
      '</div>';
    }).join("");
    return '<div class="gs-group"><div class="gs-group-label">' + label + '</div>' + rows + '</div>';
  }

  // Page-aware section ordering — the section relevant to the page
  // the operator is currently on goes first so the most likely
  // intended pick is at the top of the dropdown. The remaining
  // sections fall through in a stable default order behind it.
  var sections = [
    { key: "ips",          label: "IP",          hits: results.ips },
    { key: "blocks",       label: "Blocks",      hits: results.blocks },
    { key: "subnets",      label: "Networks",    hits: results.subnets },
    { key: "reservations", label: "Reservations", hits: results.reservations },
    { key: "assets",       label: "Assets",      hits: results.assets },
    { key: "sites",        label: "Device Map",  hits: allSites },
  ];
  var pinned = _searchSectionForCurrentPage();
  if (pinned) {
    var idx = sections.findIndex(function (s) { return s.key === pinned; });
    if (idx > 0) {
      var hoisted = sections.splice(idx, 1)[0];
      sections.unshift(hoisted);
    }
  }
  var html = sections.map(function (s) { return section(s.label, s.hits); }).join("");

  dropdown.innerHTML = html;
  dropdown.style.display = "block";

  dropdown.querySelectorAll(".gs-item").forEach(function (el) {
    el.addEventListener("click", function () {
      var type = el.getAttribute("data-type");
      var id = el.getAttribute("data-id");
      var ctx = el.getAttribute("data-context");
      openSearchResult({ type: type, id: id, context: ctx ? JSON.parse(ctx) : null });
    });
  });
}

function _hideSearchDropdown() {
  var dropdown = document.getElementById("global-search-dropdown");
  if (dropdown) dropdown.style.display = "none";
}

function _handleSearchKeyNav(e) {
  var dropdown = document.getElementById("global-search-dropdown");
  if (!dropdown || dropdown.style.display === "none") return;
  var items = Array.from(dropdown.querySelectorAll(".gs-item"));
  if (!items.length) return;
  var idx = items.findIndex(function (el) { return el.classList.contains("active"); });
  if (e.key === "ArrowDown") {
    e.preventDefault();
    idx = (idx + 1) % items.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    idx = (idx - 1 + items.length) % items.length;
  } else if (e.key === "Enter") {
    e.preventDefault();
    var active = idx >= 0 ? items[idx] : items[0];
    active.click();
    return;
  }
  items.forEach(function (el) { el.classList.remove("active"); });
  items[idx].classList.add("active");
  items[idx].scrollIntoView({ block: "nearest" });
}

// Dispatch a search result to the right page + modal. Navigates via hash so
// the target page's init code picks it up and opens the modal on load. If the
// user is already on the target page, opens the modal directly.
function openSearchResult(hit) {
  _hideSearchDropdown();
  var input = document.getElementById("global-search-input");
  if (input) input.value = "";

  var target = _searchTargetFor(hit);
  if (!target) return;

  if (window.location.pathname === target.page) {
    target.handler();
  } else {
    window.location.href = target.page + target.hash;
  }
}

// Return the section key (matching the `sections` array in
// _renderSearchDropdown) that should be hoisted to the top when the
// operator is on the corresponding page. Null = use the default order.
function _searchSectionForCurrentPage() {
  var p = window.location.pathname || "";
  if (p === "/map.html")     return "sites";
  if (p === "/subnets.html") return "subnets";
  if (p === "/assets.html")  return "assets";
  if (p === "/blocks.html")  return "blocks";
  return null;
}

function _searchTargetFor(hit) {
  if (hit.type === "site") {
    // Site hit — pan to the marker AND open its topology modal, like
    // clicking the marker would. Same hash convention as below so
    // navigation from another page reaches the same end state.
    return {
      page: "/map.html",
      hash: "#site=" + encodeURIComponent(hit.id) + "&topology=1",
      handler: function () {
        if (typeof window.polarisMapOpenSiteTopology === "function") {
          window.polarisMapOpenSiteTopology(hit.id, null);
        }
      },
    };
  }
  if (hit.type === "asset") {
    var ctx = hit.context || {};
    // Virtual Device Map entry (mapEntry flag set by _renderSearchDropdown) —
    // open the FortiGate's topology modal focused on this endpoint.
    if (ctx.mapEntry) {
      if (window.location.pathname === "/map.html" &&
          typeof window.polarisMapOpenSiteTopology === "function") {
        var focusQuery = ctx.focusHostname || ctx.focusIpAddress || ctx.focusMacAddress || null;
        return {
          page: "/map.html",
          hash: "",
          handler: function () { window.polarisMapOpenSiteTopology(ctx.siteId, focusQuery); },
        };
      }
      var qHashFocus = ctx.focusHostname || ctx.focusIpAddress || ctx.focusMacAddress || "";
      var hash = "#site=" + encodeURIComponent(ctx.siteId) + "&topology=1" +
        (qHashFocus ? "&q=" + encodeURIComponent(qHashFocus) : "");
      return {
        page: "/map.html",
        hash: hash,
        handler: function () {
          if (typeof window.polarisMapOpenSiteTopology === "function") {
            window.polarisMapOpenSiteTopology(ctx.siteId, qHashFocus || null);
          }
        },
      };
    }
    // Regular asset click — pan-to on map page if it's a pinned marker,
    // otherwise open the asset details page.
    if (window.location.pathname === "/map.html" &&
        typeof window.polarisMapPanToAsset === "function") {
      return {
        page: "/map.html",
        hash: "",
        handler: function () {
          if (!window.polarisMapPanToAsset(hit.id)) {
            window.location.href = "/assets.html#view=asset:" + encodeURIComponent(hit.id);
          }
        },
      };
    }
    return {
      page: "/assets.html",
      hash: "#view=asset:" + encodeURIComponent(hit.id),
      handler: function () { if (typeof openViewModal === "function") openViewModal(hit.id); },
    };
  }
  if (hit.type === "block") {
    return {
      page: "/ipam.html",
      hash: "#tab=blocks&view=block:" + encodeURIComponent(hit.id),
      handler: function () { if (typeof openBlockEditModal === "function") openBlockEditModal(hit.id); },
    };
  }
  if (hit.type === "subnet") {
    return {
      page: "/ipam.html",
      hash: "#tab=networks&subnet=" + encodeURIComponent(hit.id),
      handler: function () { if (typeof openIpPanel === "function") openIpPanel(hit.id); },
    };
  }
  if (hit.type === "reservation") {
    // Route to the network slide-over so the operator sees the reservation
    // in its containing subnet context (IP-panel auto-scrolls + highlights
    // the row); supplies focusReservation= so ip-panel resolves the IP from
    // the reservation id even on hard reload.
    var resvSubnetId = hit.subnetId || (hit.context && hit.context.subnetId);
    if (resvSubnetId) {
      return {
        page: "/ipam.html",
        hash: "#tab=networks&subnet=" + encodeURIComponent(resvSubnetId) + "&focusReservation=" + encodeURIComponent(hit.id),
        handler: function () {
          if (typeof openIpPanel === "function") openIpPanel(resvSubnetId, { focusReservationId: hit.id });
        },
      };
    }
    // Fallback when the search hit didn't carry a subnetId — open the
    // reservation modal directly.
    return {
      page: "/ipam.html",
      hash: "#tab=networks&view=reservation:" + encodeURIComponent(hit.id),
      handler: function () { if (typeof openReservationModal === "function") openReservationModal(hit.id); },
    };
  }
  if (hit.type === "ip") {
    var ctx = hit.context || {};
    if (ctx.subnetId) {
      var hash = "#tab=networks&ip=" + encodeURIComponent(ctx.subnetId) + "@" + encodeURIComponent(ctx.ipAddress || "");
      return {
        page: "/ipam.html",
        hash: hash,
        handler: function () {
          if (typeof openIpPanel === "function") openIpPanel(ctx.subnetId, { focusIp: ctx.ipAddress });
        },
      };
    }
  }
  return null;
}

// Called on init — inspects the URL hash and opens the referenced modal if
// the current page matches the hash's entity type. No-op otherwise so we
// don't mis-dispatch (e.g. calling Subnets' openEditModal on the Blocks page).
function processSearchHash() {
  var hash = window.location.hash || "";
  var path = window.location.pathname;
  var onIpamPage = path.indexOf("/ipam.html") !== -1;

  // #view=<type>:<id> — legacy single-param form (still emitted by Blocks/
  // Networks legacy redirects). Match on either the legacy page paths or
  // the new IPAM consolidated page.
  var m = /#view=(\w+):([^&]+)/.exec(hash);
  if (m) {
    var type = m[1], id = decodeURIComponent(m[2]);
    setTimeout(function () {
      if (type === "asset" && path.indexOf("/assets.html") !== -1 && typeof openViewModal === "function") {
        openViewModal(id);
      } else if (type === "block" && (onIpamPage || path.indexOf("/blocks.html") !== -1) && typeof openBlockEditModal === "function") {
        openBlockEditModal(id);
      } else if (type === "subnet" && (onIpamPage || path.indexOf("/subnets.html") !== -1) && typeof openSubnetEditModal === "function") {
        openSubnetEditModal(id);
      } else if (type === "reservation" && (onIpamPage || path.indexOf("/subnets.html") !== -1) && typeof openReservationModal === "function") {
        openReservationModal(id);
      }
    }, 150);
    return;
  }

  // IPAM-style hash params: #tab=networks&subnet=<id>&focusReservation=<id>
  // and the legacy plain #ip=<sid>@<ip> form (still emitted by the redirect
  // from /subnets.html#ip=... ). Both surfaces converge on openIpPanel here.
  if (onIpamPage) {
    var params = {};
    hash.replace(/^#/, "").split("&").forEach(function (kv) {
      var p = kv.split("=");
      if (p.length === 2) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1]);
    });
    // The ipam orchestrator + subnets.js applyHashFilters already handle the
    // tab=networks + subnet=/focusReservation= path (they fire before this).
    // This branch covers #tab=networks&ip=<subnetId>@<ip> only.
    if (params.tab === "networks" && params.ip) {
      var ipParts = params.ip.split("@");
      if (ipParts.length === 2) {
        var subnetIdNew = ipParts[0];
        var focusIpNew = ipParts[1];
        setTimeout(function () {
          if (typeof openIpPanel !== "function") return;
          if (focusIpNew && api && api.subnets && typeof api.subnets.get === "function") {
            api.subnets.get(subnetIdNew).then(function (s) {
              openIpPanel(subnetIdNew, { focusIp: focusIpNew, subnetCidr: s && s.cidr });
            }, function () {
              openIpPanel(subnetIdNew, { focusIp: focusIpNew });
            });
          } else {
            openIpPanel(subnetIdNew);
          }
        }, 200);
      }
      return;
    }
  }

  // Legacy #ip=<sid>@<ip> on /subnets.html (also reachable via redirect from
  // /subnets.html → /ipam.html).
  var ipM = /^#ip=([^@]+)@(.+)$/.exec(hash);
  if (ipM && (onIpamPage || path.indexOf("/subnets.html") !== -1)) {
    var subnetId = decodeURIComponent(ipM[1]);
    var focusIp = decodeURIComponent(ipM[2]);
    setTimeout(function () {
      if (typeof openIpPanel !== "function") return;
      // Fetch the subnet metadata first so the panel can compute which page
      // contains focusIp before the initial render — avoids opening on page 1
      // and then re-fetching when the IP lives further into a large subnet.
      if (focusIp && typeof api !== "undefined" && api.subnets && typeof api.subnets.get === "function") {
        api.subnets.get(subnetId).then(function (s) {
          openIpPanel(subnetId, { focusIp: focusIp, subnetCidr: s && s.cidr });
        }, function () {
          openIpPanel(subnetId, { focusIp: focusIp });
        });
      } else {
        openIpPanel(subnetId);
      }
    }, 150);
  }
}

function renderUserBadge() {
  if (!currentUsername) return;
  var header = document.querySelector(".page-header-actions");
  if (!header) {
    var pageHeader = document.querySelector(".page-header");
    if (!pageHeader) return;
    header = document.createElement("div");
    header.className = "page-header-actions";
    pageHeader.appendChild(header);
  }

  // Idempotent: drop any previously-rendered badge. renderNav (and hence this)
  // can fire more than once per page load (cache-warm-then-server path in
  // app.js; page-specific DOMContentLoaded handlers like map.js that re-run
  // renderNav after their own fetchCurrentUser).
  var existing = header.querySelectorAll(".user-badge");
  for (var i = 0; i < existing.length; i++) existing[i].remove();

  var initials = _getUserInitials(currentUsername);
  var color = _getInitialsColor(currentUsername);

  var roleLabel = _getRoleLabel(currentUserRole);
  var roleClass = _getRoleBadgeClass(currentUserRole);

  var badge = document.createElement("div");
  badge.className = "user-badge";
  badge.innerHTML =
    '<div class="user-badge-avatar" style="background:' + color + '">' + escapeHtml(initials) + '</div>' +
    '<span class="user-badge-name">' + escapeHtml(currentUsername) + '</span>' +
    (roleLabel ? '<span class="badge ' + roleClass + '" style="font-size:0.7rem;padding:1px 6px">' + escapeHtml(roleLabel) + '</span>' : '');
  badge.title = currentUsername + ' (' + roleLabel + ')';
  header.appendChild(badge);
}

// ─── Branding ──────────────────────────────────────────────────────────────

var _branding = null;

function applyBranding(b, skipCache) {
  if (!b) return;
  _branding = b;
  if (!skipCache) {
    try { localStorage.setItem("polaris-branding", JSON.stringify(b)); } catch (_) {}
  }

  // Update sidebar logo + name
  var sidebarLogo = document.querySelector(".sidebar-logo");
  if (sidebarLogo) {
    sidebarLogo.src = b.logoUrl || "/logo.png";
    sidebarLogo.style.visibility = "";
  }
  var sidebarName = document.querySelector(".sidebar-brand h1");
  if (sidebarName) {
    sidebarName.textContent = b.appName || "Polaris";
    sidebarName.style.visibility = "";
  }
  var sidebarSub = document.querySelector(".sidebar-brand p");
  if (sidebarSub) {
    sidebarSub.textContent = b.subtitle || "";
    sidebarSub.style.display = b.subtitle ? "" : "none";
    sidebarSub.style.visibility = "";
  }

  // Update page title
  var titleEl = document.querySelector("title");
  if (titleEl) {
    var current = titleEl.textContent;
    // Replace "Polaris — X" or "AppName — X" pattern
    var dashIdx = current.indexOf(" \u2014 ");
    if (dashIdx === -1) dashIdx = current.indexOf(" — ");
    if (dashIdx !== -1) {
      titleEl.textContent = (b.appName || "Polaris") + current.substring(dashIdx);
    } else {
      titleEl.textContent = b.appName || "Polaris";
    }
  }

  // Update favicon if custom logo
  var favicon = document.querySelector('link[rel="icon"]');
  if (favicon && b.logoUrl) {
    favicon.href = b.logoUrl;
  }

  // Update version in sidebar
  var versionEl = document.getElementById("sidebar-version");
  if (versionEl && b.version) {
    versionEl.textContent = "v" + b.version;
  }

  // Check for available updates (admin only)
  if (isAdmin()) checkSidebarUpdate();
}

async function fetchBranding() {
  try {
    var cached = JSON.parse(localStorage.getItem("polaris-branding") || "null");
    if (cached) applyBranding(cached, true);
  } catch (_) {}
  try {
    var b = await api.serverSettings.getBranding();
    applyBranding(b);
  } catch (_) {
    if (!_branding) applyBranding({ appName: "Polaris", subtitle: "Network Management Tool", logoUrl: "/logo.png", version: "" });
  }
}

async function checkSidebarUpdate() {
  try {
    var status = await api.serverSettings.getUpdateStatus();
    var versionEl = document.getElementById("sidebar-version");
    if (!versionEl) return;

    // Remove any existing update badge
    var existing = document.getElementById("sidebar-update-badge");
    if (existing) existing.remove();

    if (status.state === "available") {
      var badge = document.createElement("div");
      badge.id = "sidebar-update-badge";
      badge.innerHTML =
        '<a href="/server-settings.html?tab=database" class="sidebar-update-link">' +
          '<span class="sidebar-update-dot"></span>' +
          'Update available: v' + escapeHtml(status.latestVersion) +
        '</a>';
      versionEl.parentNode.insertBefore(badge, versionEl.nextSibling);
    }
  } catch (_) {}
}

function renderQueryStatus() {
  var container = document.getElementById("query-status");
  if (!container) return;

  var serverDiscoveries = (window._getServerDiscoveries && window._getServerDiscoveries()) || [];
  var totalCount = activeQueries.length + serverDiscoveries.length;

  if (!totalCount) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }

  var queryCount = activeQueries.length;
  var discoveryCount = serverDiscoveries.length;
  var labelText;
  if (queryCount > 0 && discoveryCount > 0) {
    labelText = totalCount + ' operation' + (totalCount === 1 ? '' : 's') + ' running';
  } else if (discoveryCount > 0) {
    labelText = discoveryCount + ' discover' + (discoveryCount === 1 ? 'y' : 'ies') + ' running';
  } else {
    labelText = queryCount + ' quer' + (queryCount === 1 ? 'y' : 'ies') + ' running';
  }

  container.style.display = "block";
  container.innerHTML =
    '<div class="query-status-header">' +
      '<span class="query-spinner"></span>' +
      '<span class="query-status-label">' + labelText + '</span>' +
    '</div>' +
    '<ul class="query-status-list">' +
      activeQueries.map(function (q) {
        return '<li>' +
          '<span class="query-status-name">' + escapeHtml(q.label) + '</span>' +
          '<button class="query-abort-btn" data-qid="' + q.id + '" title="Abort">&#x2715;</button>' +
        '</li>';
      }).join("") +
      serverDiscoveries.map(function (d) {
        var slowSet = {};
        if (d.slowDevices) d.slowDevices.forEach(function (name) { slowSet[name] = true; });
        var nameClass = d.slow ? 'query-status-name query-status-name-slow' : 'query-status-name';
        var nameTitle = d.slow ? ' title="This discovery is running longer than normal"' : '';
        // FMG-only progress summary: "N/M complete · K skipped (offline)".
        // Standalone FortiGate discoveries are a single device — counts add
        // no information there. Skip-error count is rolled into the offline
        // count only when non-zero so the common case stays compact.
        var progressLine = '';
        if (d.type === 'fortimanager' && d.totalDevices != null) {
          var done = d.completedCount || 0;
          var skipOff = d.skippedOfflineCount || 0;
          var skipErr = d.skippedErrorCount || 0;
          var skipTotal = skipOff + skipErr;
          var parts = [done + '/' + d.totalDevices + ' complete'];
          if (skipTotal > 0) {
            var skipLabel = skipErr > 0 ? skipTotal + ' skipped' : skipOff + ' skipped (offline)';
            parts.push(skipLabel);
          }
          progressLine = '<span class="query-status-progress">' + escapeHtml(parts.join(' · ')) + '</span>';
        }
        return '<li><div style="min-width:0;flex:1">' +
          '<span class="' + nameClass + '"' + nameTitle + '>Discovering ' + escapeHtml(d.name) + (d.slow ? ' — slow' : '') + '</span>' +
          progressLine +
          (d.activeDevices && d.activeDevices.length ? d.activeDevices.map(function (dev) {
            var cls = slowSet[dev] ? 'query-status-device query-status-device-slow' : 'query-status-device';
            var t = slowSet[dev] ? ' title="This FortiGate is taking longer than normal"' : '';
            return '<span class="' + cls + '"' + t + '>' + escapeHtml(dev) + '</span>';
          }).join('') : '') +
          '</div>' +
          '<button class="query-abort-btn" data-discovery-id="' + escapeHtml(d.id) + '" data-discovery-name="' + escapeHtml(d.name) + '" title="Abort">&#x2715;</button>' +
          '</li>';
      }).join("") +
    '</ul>' +
    (activeQueries.length > 1
      ? '<button class="query-abort-all-btn" id="abort-all-btn">Abort All</button>'
      : '');

  container.querySelectorAll(".query-abort-btn").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var discoveryId = btn.getAttribute("data-discovery-id");
      if (discoveryId) {
        var discoveryName = btn.getAttribute("data-discovery-name") || "discovery";
        var ok = await showConfirm('Abort discovery of "' + discoveryName + '"?');
        if (!ok) return;
        try { await api.integrations.abortDiscover(discoveryId); } catch (_) {}
        return;
      }
      var qid = parseFloat(btn.getAttribute("data-qid"));
      var q = activeQueries.find(function (x) { return x.id === qid; });
      if (!q) return;
      var ok = await showConfirm('Abort "' + q.label + '"?');
      if (!ok) return;
      q.controller.abort();
      _unregisterQuery(qid);
    });
  });

  var abortAllBtn = document.getElementById("abort-all-btn");
  if (abortAllBtn) {
    abortAllBtn.addEventListener("click", async function () {
      var ok = await showConfirm("Abort all running operations?");
      if (ok) abortAllQueries();
    });
  }
}

// ─── New-user role-review notifications ────────────────────────────────────
// Renders the admin-only "new user — review role" panel in the sidebar.
// Reads from the closure-scoped _roleReviewUsers array populated by
// pollRoleReviewNotifications above. Each row has a per-user dismiss button
// that hits DELETE /users/:id/role-review (global dismiss).

function renderRoleReviewStatus() {
  var container = document.getElementById("role-review-status");
  if (!container) return;
  var users = (window._getRoleReviewUsers && window._getRoleReviewUsers()) || [];
  if (!users.length) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }
  container.style.display = "block";
  var label = users.length === 1 ? "new user logged in" : "new users logged in";
  container.innerHTML =
    '<div class="query-status-header role-review-header">' +
      '<span class="role-review-icon">&#x2728;</span>' +
      '<span class="query-status-label">' + users.length + ' ' + label + '</span>' +
    '</div>' +
    '<ul class="query-status-list">' +
      users.map(function (u) {
        var who = u.displayName ? (u.displayName + ' (' + u.username + ')') : u.username;
        var roleName = (u.role && typeof u.role === 'object') ? (u.role.name || 'readonly')
          : (typeof u.role === 'string' ? u.role : 'readonly');
        var sub = 'Role: ' + roleName + (u.authProvider === 'azure' ? ' · SSO' : '');
        return '<li><div style="min-width:0;flex:1">' +
          '<span class="query-status-name" title="' + escapeHtml(who) + '">' + escapeHtml(who) + '</span>' +
          '<span class="query-status-progress">' + escapeHtml(sub) + ' — may need role change</span>' +
          '</div>' +
          '<button class="query-abort-btn role-review-dismiss" data-user-id="' + escapeHtml(u.id) + '" title="Dismiss">&#x2715;</button>' +
          '</li>';
      }).join("") +
    '</ul>';

  container.querySelectorAll(".role-review-dismiss").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var uid = btn.getAttribute("data-user-id");
      if (!uid) return;
      btn.disabled = true;
      try {
        await api.users.dismissRoleReview(uid);
      } catch (_) {
        btn.disabled = false;
        return;
      }
      if (typeof window._pollRoleReviewNotifications === "function") {
        window._pollRoleReviewNotifications();
      }
    });
  });
}

// ─── Tracked PDF Export ─────────────────────────────────────────────────────
// Wraps a PDF export workflow in the query status tracker so it appears in the
// sidebar with an abort button.  `fn` receives an AbortSignal and must throw or
// return early when the signal fires.

async function trackedPdfExport(label, fn) {
  var controller = new AbortController();
  var qid = _registerQuery(label, controller);
  try {
    await fn(controller.signal);
  } catch (err) {
    if (err.name === "AbortError" || controller.signal.aborted) {
      showToast("PDF export aborted", "error");
    } else {
      console.error("Export error:", err);
      showToast("Export failed: " + (err.message || "Unknown error"), "error");
    }
  } finally {
    _unregisterQuery(qid);
  }
}

// ─── CSV Export Utility ─────────────────────────────────────────────────────

function downloadCsv(headers, rows, filename) {
  var csvContent = _csvRow(headers) + "\n" +
    rows.map(function (r) { return _csvRow(r); }).join("\n");
  var blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function _csvRow(cells) {
  return cells.map(function (c) {
    var s = String(c == null ? "" : c);
    if (s.indexOf(",") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }).join(",");
}

// ─── Mock Heartbeat (demo only) ─────────────────────────────────────────────

function startMockHeartbeat() {
  var _mockIntegrations = null;

  function runMock() {
    if (!_mockIntegrations) return;
    var enabled = _mockIntegrations.filter(function (i) { return i.enabled; });
    if (!enabled.length) return;
    enabled.forEach(function (intg) {
      var controller = new AbortController();
      var qid = _registerQuery("Polling " + intg.name, controller);
      var duration = 5000 + Math.floor(Math.random() * 5000);
      setTimeout(function () { _unregisterQuery(qid); }, duration);
    });
  }

  // Fire a mock "Generating PDF" entry shortly after load so the user can see it
  setTimeout(function () {
    var controller = new AbortController();
    var qid = _registerQuery("Generating PDF \u2014 Asset Report", controller);
    setTimeout(function () {
      if (!controller.signal.aborted) _unregisterQuery(qid);
    }, 8000);
  }, 2000);

  // Fetch integrations list, then start the cycle
  setTimeout(function () {
    api.integrations.list().then(function (result) {
      _mockIntegrations = result.integrations || result;
      runMock();
      setInterval(runMock, 30000);
    }).catch(function () {});
  }, 5000);
}

// ─── Toasts ───────────────────────────────────────────────────────────────────

function getToastContainer() {
  let c = document.getElementById("toast-container");
  if (!c) {
    c = document.createElement("div");
    c.id = "toast-container";
    c.className = "toast-container";
    document.body.appendChild(c);
  }
  return c;
}

function showToast(message, type) {
  type = type || "success";
  const container = getToastContainer();
  const el = document.createElement("div");
  el.className = "toast toast-" + type;

  const text = document.createElement("span");
  text.textContent = message;

  const btn = document.createElement("button");
  btn.className = "toast-copy-btn";
  btn.title = "Copy";
  btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  btn.addEventListener("click", function () {
    navigator.clipboard.writeText(message).then(function () {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(function () {
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      }, 1500);
    });
  });

  el.appendChild(text);
  el.appendChild(btn);
  container.appendChild(el);
  setTimeout(function () {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s";
    setTimeout(function () { el.remove(); }, 300);
  }, 3500);
}

// ─── Modal ────────────────────────────────────────────────────────────────────

var _modalDrag = { active: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };

function openModal(title, bodyHTML, footerHTML, options) {
  let overlay = document.getElementById("modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "modal-overlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML = '<div class="modal"><div class="modal-header"><h3></h3><button class="btn-icon modal-close">&times;</button></div><div class="modal-body"></div><div class="modal-footer"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        var closeBtn = overlay.querySelector(".modal-close");
        if (closeBtn) {
          closeBtn.classList.add("flash");
          setTimeout(function () { closeBtn.classList.remove("flash"); }, 600);
        }
      }
    });
    overlay.querySelector(".modal-close").addEventListener("click", closeModal);
    var modalEl = overlay.querySelector(".modal");
    var headerEl = overlay.querySelector(".modal-header");
    headerEl.addEventListener("mousedown", function (e) {
      if (e.target.closest(".modal-close")) return;
      _modalDrag.active = true;
      _modalDrag.startX = e.clientX - _modalDrag.offsetX;
      _modalDrag.startY = e.clientY - _modalDrag.offsetY;
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!_modalDrag.active) return;
      _modalDrag.offsetX = e.clientX - _modalDrag.startX;
      _modalDrag.offsetY = e.clientY - _modalDrag.startY;
      modalEl.style.transform = "translate(" + _modalDrag.offsetX + "px, " + _modalDrag.offsetY + "px)";
    });
    document.addEventListener("mouseup", function () {
      if (_modalDrag.active) {
        _modalDrag.active = false;
        document.body.style.userSelect = "";
      }
    });
  }
  var modal = overlay.querySelector(".modal");
  _modalDrag.offsetX = 0;
  _modalDrag.offsetY = 0;
  modal.style.transform = "";
  modal.classList.remove("modal-wide", "modal-xl");
  if (options && options.wide) modal.classList.add("modal-wide");
  if (options && options.xl) modal.classList.add("modal-xl");
  overlay.querySelector(".modal-header h3").textContent = title;
  overlay.querySelector(".modal-body").innerHTML = bodyHTML;
  overlay.querySelector(".modal-footer").innerHTML = footerHTML || "";
  var slideoverOpen = !!document.querySelector(".slideover-overlay.open");
  overlay.classList.toggle("above-slideover", slideoverOpen);
  requestAnimationFrame(function () { overlay.classList.add("open"); });
}

function closeModal() {
  var overlay = document.getElementById("modal-overlay");
  if (overlay) {
    overlay.classList.remove("open");
    overlay.classList.remove("above-slideover");
  }
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────

function showConfirm(message) {
  return new Promise(function (resolve) {
    var body = '<p style="font-size:0.9rem;color:var(--color-text-secondary)">' + escapeHtml(message) + '</p>';
    var footer = '<button class="btn btn-secondary" id="confirm-cancel">Cancel</button><button class="btn btn-danger" id="confirm-ok">Confirm</button>';
    openModal("Confirm", body, footer);
    document.getElementById("confirm-cancel").onclick = function () { closeModal(); resolve(false); };
    document.getElementById("confirm-ok").onclick = function () { closeModal(); resolve(true); };
  });
}

function showFormModal(title, formHTML, confirmLabel) {
  return new Promise(function (resolve) {
    var footer = '<button class="btn btn-secondary" id="form-modal-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="form-modal-ok">' + escapeHtml(confirmLabel || "OK") + '</button>';
    openModal(title, formHTML, footer);
    document.getElementById("form-modal-cancel").onclick = function () { closeModal(); resolve(false); };
    document.getElementById("form-modal-ok").onclick = function () { closeModal(); resolve(true); };
  });
}

// ─── Pagination Helper ───────────────────────────────────────────────────────

/**
 * Render page-size selector + numbered page buttons into a container.
 * @param {string}   containerId   - ID of the pagination div
 * @param {number}   total         - Total number of items
 * @param {number}   pageSize      - Current page size
 * @param {number}   currentPage   - Current 1-based page number
 * @param {function} onPageChange  - Called with new page number (1-based)
 * @param {function} onSizeChange  - Called with new page size
 */
/**
 * Clear both the bottom and optional top pagination containers.
 */
function clearPageControls(containerId) {
  var mainEl = document.getElementById(containerId);
  if (mainEl) mainEl.innerHTML = "";
  var topEl = document.getElementById(containerId + "-top");
  if (topEl) topEl.innerHTML = "";
}

function renderPageControls(containerId, total, pageSize, currentPage, onPageChange, onSizeChange, opts) {
  var containers = [];
  var mainEl = document.getElementById(containerId);
  if (mainEl) containers.push(mainEl);
  var topEl = document.getElementById(containerId + "-top");
  if (topEl) containers.push(topEl);
  if (containers.length === 0) return;

  var totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Page number buttons
  var pageButtons = "";
  var startPage = Math.max(1, currentPage - 2);
  var endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

  if (startPage > 1) {
    pageButtons += '<button class="btn btn-secondary btn-sm pg-btn" data-page="1">1</button>';
    if (startPage > 2) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
  }
  for (var p = startPage; p <= endPage; p++) {
    if (p === currentPage) {
      pageButtons += '<button class="btn btn-primary btn-sm pg-btn" data-page="' + p + '" disabled>' + p + '</button>';
    } else {
      pageButtons += '<button class="btn btn-secondary btn-sm pg-btn" data-page="' + p + '">' + p + '</button>';
    }
  }
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
    pageButtons += '<button class="btn btn-secondary btn-sm pg-btn" data-page="' + totalPages + '">' + totalPages + '</button>';
  }

  var html =
    '<button class="btn btn-secondary btn-sm pg-prev" ' + (currentPage <= 1 ? 'disabled' : '') + '>&laquo; Prev</button>' +
    pageButtons +
    '<button class="btn btn-secondary btn-sm pg-next" ' + (currentPage >= totalPages ? 'disabled' : '') + '>Next &raquo;</button>' +
    '<span style="font-size:0.82rem;color:var(--color-text-tertiary);margin-left:8px">' + total + ' items</span>';

  containers.forEach(function (container) {
    container.innerHTML = html;
    container.querySelector('.pg-prev').addEventListener("click", function () {
      if (currentPage > 1) onPageChange(currentPage - 1);
    });
    container.querySelector('.pg-next').addEventListener("click", function () {
      if (currentPage < totalPages) onPageChange(currentPage + 1);
    });
    container.querySelectorAll(".pg-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        onPageChange(parseInt(btn.getAttribute("data-page"), 10));
      });
    });
    if (opts && opts.actionButtons && opts.actionButtons.length) {
      container.style.position = "relative";
      var btnWrap = document.createElement("span");
      btnWrap.style.cssText = "position:absolute;right:0;display:flex;gap:6px;align-items:center;";
      opts.actionButtons.forEach(function (cfg) {
        var btn = document.createElement("button");
        btn.className = "btn btn-secondary btn-sm" + (cfg.className ? " " + cfg.className : "");
        btn.textContent = cfg.label;
        btn.addEventListener("click", cfg.onClick);
        btnWrap.appendChild(btn);
      });
      container.appendChild(btnWrap);
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function timeAgo(dateStr) {
  var diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function formatDate(dateStr) {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function statusBadge(status) {
  return '<span class="badge badge-' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>';
}

function tagsToArray(str) {
  return str.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}

function tagsToString(arr) {
  return (arr || []).join(", ");
}

function randomTagColor() {
  var palette = ["#4fc3f7","#4ade80","#f59e0b","#f472b6","#a78bfa","#fb923c","#38bdf8","#34d399","#e879f9","#facc15","#f87171","#2dd4bf","#818cf8","#c084fc"];
  return palette[Math.floor(Math.random() * palette.length)];
}

// ─── Tag field (enforced or free-text) ─────────────────────────────────────

var _tagCache = { loaded: false, enforce: false, tags: [] };

function _ensureTagCache() {
  if (_tagCache.loaded) return Promise.resolve();
  return Promise.all([
    api.serverSettings.getTagSettings(),
    api.serverSettings.listTags(),
  ]).then(function (results) {
    _tagCache.enforce = results[0] && results[0].enforce === true;
    _tagCache.tags = results[1] || [];
    _tagCache.loaded = true;
  }).catch(function () {
    _tagCache.loaded = true;
  });
}

// Auto-managed tag prefixes. These are reconciled by the backend (firewall
// breadcrumb tags by firewallTagService, region tags by mapRegionService) and
// must never be added or removed through the UI — the picker hides them and
// getTagFieldValue preserves them from the existing record on save.
var PROTECTED_TAG_PREFIXES = ["firewall:", "region:"];

function isProtectedTag(name) {
  for (var i = 0; i < PROTECTED_TAG_PREFIXES.length; i++) {
    if (name.indexOf(PROTECTED_TAG_PREFIXES[i]) === 0) return true;
  }
  return false;
}

/**
 * Build tag field HTML. Call _ensureTagCache() before using this.
 * selected: array of currently selected tag names
 */
function _renderTagChips(selected) {
  var cats = {};
  _tagCache.tags.forEach(function (t) {
    if (isProtectedTag(t.name)) return;
    var cat = t.category || "General";
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(t);
  });
  var catNames = Object.keys(cats).sort();
  var html = '';

  if (_tagCache.tags.length === 0) {
    html += '<p class="hint" style="margin:0">No tags defined yet. Use the form below to add one.</p>';
  } else {
    catNames.forEach(function (cat) {
      html += '<div class="tag-picker-category">' +
        '<span class="tag-picker-cat-label">' + escapeHtml(cat) + '</span>';
      cats[cat].forEach(function (t) {
        var checked = selected.indexOf(t.name) !== -1;
        var colorStyle = t.color
          ? 'background:' + escapeHtml(t.color) + (checked ? '44' : '11') + ';border-color:' + escapeHtml(t.color) + ';color:' + escapeHtml(t.color)
          : '';
        html += '<label class="tag-picker-chip' + (checked ? ' selected' : '') + '" style="' + colorStyle + '">' +
          '<input type="checkbox" name="f-tags-cb" value="' + escapeHtml(t.name) + '"' + (checked ? ' checked' : '') + '>' +
          escapeHtml(t.name) +
        '</label>';
      });
      html += '</div>';
    });
  }
  return html;
}

function tagFieldHTML(selected, opts) {
  selected = selected || [];
  opts = opts || {};

  // Read-only: render selected tags as static badges, no checkboxes or "add new" row.
  if (opts.readOnly) {
    var visibleSelected = selected.filter(function (n) { return !isProtectedTag(n); });
    if (visibleSelected.length === 0) {
      return '<div class="form-group"><label>Tags</label><p style="color:var(--color-text-tertiary);margin:0">—</p></div>';
    }
    var tagsByName = {};
    _tagCache.tags.forEach(function (t) { tagsByName[t.name] = t; });
    var chips = visibleSelected.map(function (name) {
      var t = tagsByName[name];
      var color = t && t.color ? t.color : '';
      var style = color ? 'background:' + escapeHtml(color) + '44;border-color:' + escapeHtml(color) + ';color:' + escapeHtml(color) : '';
      return '<span class="tag-picker-chip selected" style="' + style + '">' + escapeHtml(name) + '</span>';
    }).join('');
    return '<div class="form-group"><label>Tags</label><div class="tag-picker" style="pointer-events:none">' + chips + '</div></div>';
  }

  // Stash protected tags from the original record on the picker element so
  // getTagFieldValue can merge them back into the save payload — operators
  // can neither add nor remove these through the UI.
  var preservedTags = selected.filter(isProtectedTag);
  var preservedAttr = preservedTags.length
    ? ' data-preserved-tags="' + escapeHtml(JSON.stringify(preservedTags)) + '"'
    : '';

  var html = '<div class="form-group"><label>Tags</label>' +
    '<div class="tag-picker" id="f-tags-picker"' + preservedAttr + '>' +
    _renderTagChips(selected) +
    '</div>';

  if (!_tagCache.enforce) {
    var catOptions = '';
    var seenCats = {};
    _tagCache.tags.forEach(function (t) {
      var c = t.category || "General";
      if (!seenCats[c]) { seenCats[c] = true; catOptions += '<option value="' + escapeHtml(c) + '">'; }
    });

    html += '<div class="tag-add-row" id="f-tags-add-row" style="display:flex;gap:6px;align-items:center;margin-top:6px">' +
      '<input type="text" id="f-tag-new-name" placeholder="Tag name" style="flex:1;min-width:0">' +
      '<input type="text" id="f-tag-new-cat" list="f-tag-cat-list" placeholder="Category" style="width:120px">' +
      '<datalist id="f-tag-cat-list">' + catOptions + '</datalist>' +
      '<input type="color" id="f-tag-new-color" value="' + randomTagColor() + '" title="Tag color" style="width:36px;height:36px;padding:2px;border:1px solid var(--color-border);border-radius:var(--radius-md);cursor:pointer">' +
      '<button type="button" class="btn btn-sm btn-primary" id="f-tag-add-btn">+ Add Tag</button>' +
      '</div>' +
      '<p class="hint">Select tags above or add new ones</p>';
  }

  html += '</div>';
  return html;
}

/**
 * Read selected tags from the form — works for both enforced and free-text modes.
 * Auto-managed tags (firewall:/region:) stashed on the picker at render time
 * are merged back in so a save can neither add nor remove them.
 */
function getTagFieldValue() {
  var checked = [];
  document.querySelectorAll('input[name="f-tags-cb"]:checked').forEach(function (cb) {
    checked.push(cb.value);
  });
  var picker = document.getElementById("f-tags-picker");
  if (picker && picker.dataset.preservedTags) {
    try {
      var preserved = JSON.parse(picker.dataset.preservedTags);
      if (Array.isArray(preserved)) {
        preserved.forEach(function (name) {
          if (checked.indexOf(name) === -1) checked.push(name);
        });
      }
    } catch (_) {}
  }
  return checked;
}

/**
 * Wire up tag picker toggle styling after the form is rendered.
 */
function _wireChipListeners(container) {
  container.querySelectorAll('.tag-picker-chip input').forEach(function (cb) {
    cb.addEventListener("change", function () {
      var label = cb.parentElement;
      if (cb.checked) {
        label.classList.add("selected");
      } else {
        label.classList.remove("selected");
      }
      var tag = _tagCache.tags.find(function (t) { return t.name === cb.value; });
      if (tag && tag.color) {
        label.style.background = tag.color + (cb.checked ? '44' : '11');
      }
    });
  });
}

function wireTagPicker() {
  var picker = document.getElementById("f-tags-picker");
  if (!picker) return;
  _wireChipListeners(picker);

  var addBtn = document.getElementById("f-tag-add-btn");
  if (!addBtn) return;
  addBtn.addEventListener("click", async function () {
    var nameEl = document.getElementById("f-tag-new-name");
    var catEl = document.getElementById("f-tag-new-cat");
    var colorEl = document.getElementById("f-tag-new-color");
    var name = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }

    addBtn.disabled = true;
    try {
      var newTag = await api.serverSettings.createTag({
        name: name,
        category: catEl.value.trim() || "General",
        color: colorEl.value || randomTagColor(),
      });
      _tagCache.tags.push(newTag);

      // Get currently selected tags before re-rendering
      var selected = getTagFieldValue();
      selected.push(newTag.name);

      // Re-render chips and re-wire
      picker.innerHTML = _renderTagChips(selected);
      _wireChipListeners(picker);

      // Update category datalist
      var datalist = document.getElementById("f-tag-cat-list");
      if (datalist) {
        var seen = {};
        _tagCache.tags.forEach(function (t) {
          var c = t.category || "General";
          if (!seen[c]) { seen[c] = true; }
        });
        datalist.innerHTML = Object.keys(seen).map(function (c) {
          return '<option value="' + escapeHtml(c) + '">';
        }).join('');
      }

      nameEl.value = "";
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      addBtn.disabled = false;
    }
  });

  // Allow Enter key in the name field to trigger add
  var nameInput = document.getElementById("f-tag-new-name");
  if (nameInput) {
    nameInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addBtn.click(); }
    });
  }
}

// ─── Admin-only UI ───────────────────────────────────────────────────────────

function hideAdminOnlyElements() {
  document.querySelectorAll("[data-admin-only]").forEach(function (el) {
    if (!isAdmin()) el.style.display = "none";
  });
  document.querySelectorAll("[data-manage-networks]").forEach(function (el) {
    if (!canManageNetworks()) el.style.display = "none";
  });
  document.querySelectorAll("[data-create-networks]").forEach(function (el) {
    if (!canCreateNetworks()) el.style.display = "none";
  });
  document.querySelectorAll("[data-manage-assets]").forEach(function (el) {
    if (!canManageAssets()) el.style.display = "none";
  });
  document.querySelectorAll("[data-review-conflicts]").forEach(function (el) {
    if (!canReviewConflicts()) el.style.display = "none";
  });
}

// ─── Client-side Auto-Logout ──────────────────────────────────────────────

var _autoLogoutTimer = null;
var _autoLogoutMs = 0;

function initAutoLogout() {
  api.auth.azureConfig().then(function (cfg) {
    if (!cfg || !cfg.autoLogoutMinutes || cfg.autoLogoutMinutes <= 0) return;
    _autoLogoutMs = cfg.autoLogoutMinutes * 60 * 1000;
    _resetAutoLogoutTimer();
    // Reset timer on user activity
    ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach(function (evt) {
      document.addEventListener(evt, _resetAutoLogoutTimer, { passive: true });
    });
  }).catch(function () {});
}

function _resetAutoLogoutTimer() {
  if (_autoLogoutTimer) clearTimeout(_autoLogoutTimer);
  if (_autoLogoutMs <= 0) return;
  _autoLogoutTimer = setTimeout(function () {
    // Session expired client-side — logout
    fetch("/api/v1/auth/logout", { method: "POST", headers: _csrfHeaders() }).catch(function () {});
    window.location.href = "/login.html";
  }, _autoLogoutMs);
}

// ─── Capacity Critical Alert (sidebar) ────────────────────────────────────────

// Renders the non-dismissible critical alert when capacity.severity is
// "critical". Critical is a capacity emergency (disk near full, autovacuum
// stalled, projected DB size > 8x host RAM) and must not be silenceable
// from the UI. Warning and Watch reasons live on the Database card under
// Server Settings → Maintenance. Accepts the legacy "red" string for one
// release cycle so a stale browser tab on an old build doesn't suppress
// the banner after server-side rollout.
function renderCapacityCriticalAlert(capacity) {
  var el = document.getElementById("capacity-critical-alert");
  if (!el) return;

  var sev = capacity ? capacity.severity : null;
  var isCritical = sev === "critical" || sev === "red";
  if (!isCritical) {
    el.style.display = "none";
    return;
  }

  var criticalReasons = (capacity.reasons || []).filter(function (r) {
    return r.severity === "critical" || r.severity === "red";
  });
  if (criticalReasons.length === 0) {
    el.style.display = "none";
    return;
  }

  // Show the topmost reason; the Maintenance tab lists them all.
  var top = criticalReasons[0];
  var moreCount = criticalReasons.length - 1;

  el.innerHTML =
    '<div class="pg-tuning-header">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="pg-tuning-icon"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
      '<span>Capacity — Immediate Attention</span>' +
    '</div>' +
    '<div class="pg-tuning-body">' +
      '<p class="pg-tuning-text">' + escapeHtml(top.message) + '</p>' +
      (moreCount > 0
        ? '<p class="pg-tuning-text" style="opacity:0.75;font-style:italic">+ ' + moreCount + ' more critical issue' + (moreCount > 1 ? 's' : '') + '</p>'
        : '') +
    '</div>' +
    '<div class="pg-tuning-actions">' +
      '<a href="/server-settings.html?tab=maintenance" class="btn btn-sm btn-secondary">View capacity &rarr;</a>' +
    '</div>';
  el.style.display = "block";
}

// Polls /pg-tuning at page load to feed the capacity critical alert. Amber and
// watch reasons (pg_tuning_needed, ram_insufficient, db_pool_undersized, …)
// surface on the Database card; only red drives this sidebar alert.
function checkCapacity() {
  if (!isAdmin()) return;
  api.serverSettings.getPgTuning().then(function (data) {
    renderCapacityCriticalAlert(data && data.capacity);
  }).catch(function () {
    // Silently ignore — non-critical check
  });
}

// ─── Slide-over resize ────────────────────────────────────────────────────────

function initSlideoverResize(panelEl, storageKey) {
  var handle = panelEl.querySelector(".slideover-resize-handle");
  if (!handle) return;

  var stored = parseInt(localStorage.getItem(storageKey) || "0", 10);
  if (stored >= 380) panelEl.style.width = stored + "px";

  handle.addEventListener("mousedown", function (e) {
    e.preventDefault();
    handle.classList.add("dragging");
    var panelRight = panelEl.getBoundingClientRect().right;
    var minW = 380;
    var maxW = Math.round(window.innerWidth * 0.9);

    function onMove(e) {
      var w = Math.max(minW, Math.min(maxW, Math.round(panelRight - e.clientX)));
      panelEl.style.width = w + "px";
    }

    function onUp(e) {
      handle.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      var w = Math.max(minW, Math.min(maxW, Math.round(panelRight - e.clientX)));
      localStorage.setItem(storageKey, w);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async function () {
  // Render nav immediately from cache so the sidebar doesn't flash on navigation.
  // Restore the permission matrix + regions alongside the role NAME so the
  // first `hideAdminOnlyElements()` call gates correctly — without this, every
  // permission-gated element (Conflicts button, etc.) would be hidden until
  // the post-fetch re-render and the change-detection branch below skipped
  // re-rendering when only the matrix shifted.
  var roleBeforeFetch = null;
  var permsBeforeFetch = null;
  try {
    var cachedUser = JSON.parse(localStorage.getItem("polaris-user") || "null");
    if (cachedUser && cachedUser.role) {
      currentUserRole = cachedUser.role;
      currentUsername = cachedUser.username;
      currentRolePermissions = cachedUser.permissions || {};
      currentEffectiveRegions = Array.isArray(cachedUser.regions) ? cachedUser.regions : [];
      roleBeforeFetch = cachedUser.role;
      permsBeforeFetch = JSON.stringify(currentRolePermissions);
      renderNav();
      hideAdminOnlyElements();
    }
  } catch (_) {}

  await fetchCurrentUser();

  // Re-render if the cache was cold OR the role name changed OR the matrix
  // shifted (an admin edited the role since the last cached snapshot).
  // Comparing the JSON-serialized matrix is cheap and avoids any
  // gated element staying hidden when the cold-path snapshot was stale.
  var permsAfterFetch = JSON.stringify(currentRolePermissions || {});
  if (!roleBeforeFetch || currentUserRole !== roleBeforeFetch || permsBeforeFetch !== permsAfterFetch) {
    renderNav();
    hideAdminOnlyElements();
  }

  fetchBranding();
  initAutoLogout();
  checkCapacity();

  // Let each page's own DOMContentLoaded handler finish first, then consume
  // any #view=<type>:<id> or #ip=... hash a search click-through left us.
  setTimeout(processSearchHash, 0);
});
