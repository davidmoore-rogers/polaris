/**
 * public/js/app.js — Shared UI utilities: nav, toasts, modals, helpers
 */

// ─── Theme ──────────────────────────────────────────────────────────────────

(function () {
  var saved = localStorage.getItem("shelob-theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
})();

function _getCurrentTheme() {
  return document.documentElement.getAttribute("data-theme") || "dark";
}

function _setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("shelob-theme", theme);
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

var currentUserRole = null;
var currentUsername = null;
var _userReadyResolve = null;
var userReady = new Promise(function (resolve) { _userReadyResolve = resolve; });

async function fetchCurrentUser() {
  try {
    var data = await fetch("/api/v1/auth/me").then(function (r) { return r.json(); });
    if (data.authenticated) {
      currentUserRole = data.role;
      currentUsername = data.username;
      try {
        localStorage.setItem("shelob-user", JSON.stringify({ role: data.role, username: data.username }));
      } catch (_) {}
    } else {
      try { localStorage.removeItem("shelob-user"); } catch (_) {}
    }
  } catch (_) {}
  if (_userReadyResolve) { _userReadyResolve(); _userReadyResolve = null; }
  return currentUserRole;
}

function isAdmin() { return currentUserRole === "admin"; }
function isNetworkAdmin() { return currentUserRole === "networkadmin"; }
function isAssetsAdmin() { return currentUserRole === "assetsadmin"; }
function canManageNetworks() { return currentUserRole === "admin" || currentUserRole === "networkadmin"; }
function canManageAssets() { return currentUserRole === "admin" || currentUserRole === "assetsadmin"; }
function canReserveIps() { return currentUserRole === "admin" || currentUserRole === "networkadmin" || currentUserRole === "user" || currentUserRole === "assetsadmin"; }

// ─── Sidebar Navigation ──────────────────────────────────────────────────────

const NAV_ITEMS = [
  { href: "/",                label: "Dashboard",    icon: "grid" },
  { href: "/blocks.html",     label: "IP Blocks",    icon: "box" },
  { href: "/subnets.html",    label: "Networks",     icon: "layers" },
  { href: "/assets.html",         label: "Assets",       icon: "monitor" },
  { href: "/events.html",         label: "Events",       icon: "activity" },
  { href: "/integrations.html",  label: "Integrations", icon: "plug", networkAdmin: true },
  { href: "/users.html",        label: "Users",        icon: "users", adminOnly: true },
];

const ICONS = {
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
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
      <h1 style="font-size:1.1rem;font-weight:600;margin:0.5rem 0 0;color:var(--color-text-primary);text-align:center;visibility:hidden">Shelob</h1>
      <p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.15rem 0 0;text-align:center;visibility:hidden">Network Management Tool</p>
    </div>
    <ul class="sidebar-nav">
      ${visibleItems.map(item => {
        const isActive = current === item.href || (item.href === "/" && (current === "/index.html" || current === "/"));
        const dot = item.href === "/events.html" ? '<span class="nav-conflict-dot" id="nav-conflict-dot" style="display:none"></span>' : "";
        return `<li><a href="${item.href}" class="${isActive ? "active" : ""}">${ICONS[item.icon]}<span>${item.label}</span>${dot}</a></li>`;
      }).join("")}
    </ul>
    <div style="margin-top:auto">
      <div id="query-status" class="query-status" style="display:none"></div>
      <div id="pg-tuning-alert" class="pg-tuning-alert" style="display:none"></div>
      <div id="ram-warning-alert" class="ram-warning-alert" style="display:none"></div>
      ${isAdmin() ? `<div style="padding:0.5rem 0.5rem 0;border-top:1px solid var(--color-border-light)">
        <a href="/server-settings.html" class="sidebar-bottom-link${current === '/server-settings.html' ? ' active' : ''}">${ICONS.settings}<span>Server Settings</span></a>
      </div>` : ''}
      <div style="padding:${isAdmin() ? '0.25rem' : '0.5rem'} 0.5rem 0;${isAdmin() ? '' : 'border-top:1px solid var(--color-border-light);'}">
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
    try { await fetch("/api/v1/auth/logout", { method: "POST" }); } catch (_) {}
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

  // Expose for renderQueryStatus closure
  window._getServerDiscoveries = function () { return _serverDiscoveries; };

  // Inject user badge into page header
  renderUserBadge();

  // Conflict dot — poll every 30 s; also exposed so events.js can refresh on resolve
  async function refreshConflictDot() {
    var dot = document.getElementById("nav-conflict-dot");
    if (!dot || !canManageNetworks()) return;
    try {
      var data = await api.conflicts.count();
      dot.style.display = (data.count > 0) ? "inline-block" : "none";
    } catch (_) {}
  }
  refreshConflictDot();
  setInterval(refreshConflictDot, 30000);
  window.refreshConflictDot = refreshConflictDot;
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
    default:             return "badge-readonly";
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
    try { localStorage.setItem("shelob-branding", JSON.stringify(b)); } catch (_) {}
  }

  // Update sidebar logo + name
  var sidebarLogo = document.querySelector(".sidebar-logo");
  if (sidebarLogo) {
    sidebarLogo.src = b.logoUrl || "/logo.png";
    sidebarLogo.style.visibility = "";
  }
  var sidebarName = document.querySelector(".sidebar-brand h1");
  if (sidebarName) {
    sidebarName.textContent = b.appName || "Shelob";
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
    // Replace "Shelob — X" or "AppName — X" pattern
    var dashIdx = current.indexOf(" \u2014 ");
    if (dashIdx === -1) dashIdx = current.indexOf(" — ");
    if (dashIdx !== -1) {
      titleEl.textContent = (b.appName || "Shelob") + current.substring(dashIdx);
    } else {
      titleEl.textContent = b.appName || "Shelob";
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
    var cached = JSON.parse(localStorage.getItem("shelob-branding") || "null");
    if (cached) applyBranding(cached, true);
  } catch (_) {}
  try {
    var b = await api.serverSettings.getBranding();
    applyBranding(b);
  } catch (_) {
    if (!_branding) applyBranding({ appName: "Shelob", subtitle: "Network Management Tool", logoUrl: "/logo.png", version: "" });
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

  container.style.display = "block";
  container.innerHTML =
    '<div class="query-status-header">' +
      '<span class="query-spinner"></span>' +
      '<span class="query-status-label">' + totalCount + ' quer' + (totalCount === 1 ? 'y' : 'ies') + ' running</span>' +
    '</div>' +
    '<ul class="query-status-list">' +
      activeQueries.map(function (q) {
        return '<li>' +
          '<span class="query-status-name">' + escapeHtml(q.label) + '</span>' +
          '<button class="query-abort-btn" data-qid="' + q.id + '" title="Abort">&#x2715;</button>' +
        '</li>';
      }).join("") +
      serverDiscoveries.map(function (d) {
        return '<li><div style="min-width:0;flex:1">' +
          '<span class="query-status-name">Discovering ' + escapeHtml(d.name) + '</span>' +
          (d.currentDevice ? '<span class="query-status-device">' + escapeHtml(d.currentDevice) + '</span>' : '') +
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
  el.textContent = message;
  container.appendChild(el);
  setTimeout(function () {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s";
    setTimeout(function () { el.remove(); }, 300);
  }, 3500);
}

// ─── Modal ────────────────────────────────────────────────────────────────────

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
  }
  var modal = overlay.querySelector(".modal");
  modal.classList.remove("modal-wide", "modal-xl");
  if (options && options.wide) modal.classList.add("modal-wide");
  if (options && options.xl) modal.classList.add("modal-xl");
  overlay.querySelector(".modal-header h3").textContent = title;
  overlay.querySelector(".modal-body").innerHTML = bodyHTML;
  overlay.querySelector(".modal-footer").innerHTML = footerHTML || "";
  requestAnimationFrame(function () { overlay.classList.add("open"); });
}

function closeModal() {
  var overlay = document.getElementById("modal-overlay");
  if (overlay) overlay.classList.remove("open");
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
function renderPageControls(containerId, total, pageSize, currentPage, onPageChange, onSizeChange) {
  var container = document.getElementById(containerId);
  if (!container) return;

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

  container.innerHTML =
    '<button class="btn btn-secondary btn-sm" id="' + containerId + '-prev" ' + (currentPage <= 1 ? 'disabled' : '') + '>&laquo; Prev</button>' +
    pageButtons +
    '<button class="btn btn-secondary btn-sm" id="' + containerId + '-next" ' + (currentPage >= totalPages ? 'disabled' : '') + '>Next &raquo;</button>' +
    '<span style="font-size:0.82rem;color:var(--color-text-tertiary);margin-left:8px">' + total + ' items</span>';

  document.getElementById(containerId + '-prev').addEventListener("click", function () {
    if (currentPage > 1) onPageChange(currentPage - 1);
  });
  document.getElementById(containerId + '-next').addEventListener("click", function () {
    if (currentPage < totalPages) onPageChange(currentPage + 1);
  });
  container.querySelectorAll(".pg-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      onPageChange(parseInt(btn.getAttribute("data-page"), 10));
    });
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

/**
 * Build tag field HTML. Call _ensureTagCache() before using this.
 * selected: array of currently selected tag names
 */
function _renderTagChips(selected) {
  var cats = {};
  _tagCache.tags.forEach(function (t) {
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

function tagFieldHTML(selected) {
  selected = selected || [];

  var html = '<div class="form-group"><label>Tags</label>' +
    '<div class="tag-picker" id="f-tags-picker">' +
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
      '<button type="button" class="btn btn-sm btn-secondary" id="f-tag-add-btn">Add</button>' +
      '</div>' +
      '<p class="hint">Select tags above or add new ones</p>';
  }

  html += '</div>';
  return html;
}

/**
 * Read selected tags from the form — works for both enforced and free-text modes.
 */
function getTagFieldValue() {
  var checked = [];
  document.querySelectorAll('input[name="f-tags-cb"]:checked').forEach(function (cb) {
    checked.push(cb.value);
  });
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
  document.querySelectorAll("[data-manage-assets]").forEach(function (el) {
    if (!canManageAssets()) el.style.display = "none";
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
    fetch("/api/v1/auth/logout", { method: "POST" }).catch(function () {});
    window.location.href = "/login.html";
  }, _autoLogoutMs);
}

// ─── PostgreSQL Tuning Alert ──────────────────────────────────────────────────

function checkPgTuning() {
  if (!isAdmin()) return;
  api.serverSettings.getPgTuning().then(function (data) {
    var container = document.getElementById("pg-tuning-alert");
    if (!container) return;

    if (!data.needed || data.snoozedUntil) {
      container.style.display = "none";
      return;
    }

    var badSettings = (data.settings || []).filter(function (s) { return !s.ok; });
    if (!badSettings.length) {
      container.style.display = "none";
      return;
    }

    var triggeredText = data.triggered.map(function (t) {
      var count = data.counts[t] || 0;
      var threshold = data.thresholds[t] || 0;
      return t + " (" + count.toLocaleString() + "/" + threshold.toLocaleString() + ")";
    }).join(", ");

    var settingsRows = badSettings.map(function (s) {
      return '<div class="pg-tuning-row">' +
        '<span class="pg-tuning-param">' + escapeHtml(s.name) + '</span>' +
        '<span class="pg-tuning-values">' + escapeHtml(s.current) + ' &rarr; ' + escapeHtml(s.recommended) + '</span>' +
      '</div>';
    }).join("");

    container.innerHTML =
      '<div class="pg-tuning-header">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="pg-tuning-icon"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        '<span>PostgreSQL Tuning</span>' +
      '</div>' +
      '<div class="pg-tuning-body">' +
        '<p class="pg-tuning-text">Scale threshold reached for ' + triggeredText + '. Recommended PostgreSQL tuning:</p>' +
        settingsRows +
      '</div>' +
      '<div class="pg-tuning-actions">' +
        '<button class="btn btn-sm btn-secondary" id="pg-tuning-snooze">Snooze 7d</button>' +
      '</div>';

    container.style.display = "block";

    document.getElementById("pg-tuning-snooze").addEventListener("click", function () {
      api.serverSettings.snoozePgTuning(7).then(function () {
        container.style.display = "none";
        showToast("Alert snoozed for 7 days", "success");
      }).catch(function () {
        showToast("Failed to snooze alert", "error");
      });
    });

    // ── RAM insufficient warning ──────────────────────────────────────────────
    var ramContainer = document.getElementById("ram-warning-alert");
    if (ramContainer) {
      if (!data.ramInsufficient) {
        // RAM is now adequate — clear any prior dismissal so warning reappears if load grows again
        localStorage.removeItem("shelob_ram_dismissed");
        ramContainer.style.display = "none";
      } else if (localStorage.getItem("shelob_ram_dismissed")) {
        ramContainer.style.display = "none";
      } else {
        ramContainer.innerHTML =
          '<div class="pg-tuning-header">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="pg-tuning-icon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
            '<span>Insufficient RAM</span>' +
          '</div>' +
          '<div class="pg-tuning-body">' +
            '<p class="pg-tuning-text">This server has ' + data.currentRamGb + ' GB RAM. At least ' + data.recommendedRamGb + ' GB is recommended for the current database size.</p>' +
          '</div>' +
          '<div class="pg-tuning-actions">' +
            '<button class="btn btn-sm btn-secondary" id="ram-warning-dismiss">Dismiss</button>' +
          '</div>';
        ramContainer.style.display = "block";

        document.getElementById("ram-warning-dismiss").addEventListener("click", function () {
          localStorage.setItem("shelob_ram_dismissed", "1");
          ramContainer.style.display = "none";
        });
      }
    }
  }).catch(function () {
    // Silently ignore — non-critical check
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async function () {
  // Render nav immediately from cache so the sidebar doesn't flash on navigation
  var roleBeforeFetch = null;
  try {
    var cachedUser = JSON.parse(localStorage.getItem("shelob-user") || "null");
    if (cachedUser && cachedUser.role) {
      currentUserRole = cachedUser.role;
      currentUsername = cachedUser.username;
      roleBeforeFetch = cachedUser.role;
      renderNav();
      hideAdminOnlyElements();
    }
  } catch (_) {}

  await fetchCurrentUser();

  // Re-render if the cache was cold or the role changed (e.g. role was updated by admin)
  if (!roleBeforeFetch || currentUserRole !== roleBeforeFetch) {
    renderNav();
    hideAdminOnlyElements();
  }

  fetchBranding();
  initAutoLogout();
  checkPgTuning();
});
