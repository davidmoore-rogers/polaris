/**
 * public/js/app.js — Shared UI utilities: nav, toasts, modals, helpers
 */

// ─── Theme ──────────────────────────────────────────────────────────────────
//
// Three themes in two families: `nightfall` is dark, `morning`/`noon` share
// the daylight overrides in styles.css. Listed in day order, which is the order
// the picker shows them in. The retired `dark`/`light` ids are not recognized
// anywhere any more — a browser holding one falls through to DEFAULT_THEME.
//
// Adding a theme = one entry here, one token block in styles.css, one id in
// theme-init.js's KNOWN list. Nothing else.
var THEMES = [
  { id: "morning",   label: "Morning",   family: "light", icon: _sunriseIcon },
  { id: "noon",      label: "Noon",      family: "light", icon: _sunIcon },
  { id: "nightfall", label: "Nightfall", family: "dark",  icon: _starIcon },
];
// The fallback for an unknown or retired saved value. Deliberately NOT
// THEMES[0]: display order and the default move independently, so reordering
// the picker never changes what a new install lands on.
var DEFAULT_THEME = "nightfall";

// No saved preference (fresh browser, or a user who has never touched the
// picker) follows the OS; matching on "light" leaves nightfall as the fallback
// for a browser that states no preference. Mirrors js/theme-init.js, which
// does the same for the login + setup pages. Deliberately does not persist:
// staying unsaved is what keeps the user tracking their system, and _setTheme
// is the opt-out.
(function () {
  var saved = null;
  try { saved = localStorage.getItem("polaris-theme"); } catch (e) {}
  if (saved && !_themeExists(saved)) saved = null;
  if (!saved) {
    var light = false;
    try { light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches; } catch (e) {}
    saved = light ? "morning" : DEFAULT_THEME;
  }
  document.documentElement.setAttribute("data-theme", saved);
})();

function _themeExists(id) {
  for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return true;
  return false;
}

/** The theme record for `id`, or DEFAULT_THEME's when it names nothing. */
function _getTheme(id) {
  for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
  for (var k = 0; k < THEMES.length; k++) if (THEMES[k].id === DEFAULT_THEME) return THEMES[k];
  return THEMES[0];
}

function _getCurrentTheme() {
  return document.documentElement.getAttribute("data-theme") || DEFAULT_THEME;
}

// True for the daylight family. Use this instead of comparing against a theme
// id anywhere a surface picks an image, a basemap or a chart palette by
// brightness — an id check misses morning and noon.
function isLightTheme(id) {
  return _getTheme(id || _getCurrentTheme()).family === "light";
}
window.isLightTheme = isLightTheme;

function _setTheme(theme) {
  var t = _getTheme(theme);
  document.documentElement.setAttribute("data-theme", t.id);
  try { localStorage.setItem("polaris-theme", t.id); } catch (e) {}
  // The sidebar control is a long-lived button labelled with the CURRENT theme
  // (it opens the full list rather than flipping between two), so it has to be
  // repainted here — nothing else rebuilds it.
  var btn = document.getElementById("btn-theme-toggle");
  if (btn) {
    var svg = btn.querySelector("svg");
    if (svg) svg.outerHTML = t.icon();
    var label = btn.querySelector("span");
    if (label) label.textContent = t.label;
  }
  // Anything that cached colors at render time — canvases, Leaflet layers,
  // Cytoscape stylesheets, hand-rolled SVG charts — listens for this rather
  // than hooking the picker.
  document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: t.id, family: t.family } }));
}

// The footer control opens the full list: past two themes a toggle buries the
// rest behind a cycle through the ones you didn't want.
function openThemeMenu(anchor) {
  var current = _getCurrentTheme();
  showRowMenu(anchor, THEMES.map(function (t) {
    return {
      label: t.label + (t.id === current ? "  ✓" : ""),
      icon: t.icon(),
      onSelect: function () { _setTheme(t.id); },
    };
  }), { label: "Theme" });
}

// Kept for callers that predate the theme list: steps to the next theme.
function toggleTheme() {
  var i = THEMES.indexOf(_getTheme(_getCurrentTheme()));
  _setTheme(THEMES[(i + 1) % THEMES.length].id);
}

function _sunIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
}

function _sunriseIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 18a5 5 0 00-10 0"/><line x1="12" y1="2" x2="12" y2="9"/><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"/><line x1="1" y1="18" x2="3" y2="18"/><line x1="21" y1="18" x2="23" y2="18"/><line x1="18.36" y1="11.64" x2="19.78" y2="10.22"/><line x1="23" y1="22" x2="1" y2="22"/><polyline points="8 6 12 2 16 6"/></svg>';
}

// Nightfall: a filled crescent built as a MASKED DISC — one circle kept, an
// offset circle punched out. Hand-fitted arcs collapse to a hairline or read
// as a full ring at the 15px this renders at; the mask keeps the taper.
function _starIcon() {
  return '<svg viewBox="0 0 24 24" fill="none"><mask id="pk-moon"><circle cx="12" cy="12" r="9" fill="#fff"/><circle cx="18" cy="10" r="9" fill="#000"/></mask><circle cx="12" cy="12" r="9" fill="currentColor" mask="url(#pk-moon)"/></svg>';
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
var currentUserRoleColor = null;     // role.color (#rrggbb) or null
var currentRolePermissions = {};     // { [functionKey]: "none"|"read"|"write"|"fullwrite" }
var currentEffectiveRegions = [];    // string[]
var currentUserRegions = [];         // user.regionTags
var currentRoleRegions = [];         // role.regionTags
var currentUsername = null;
var currentUserAuthProvider = "local"; // "local" | "azure" | "oidc" | "ldap"
var _userReadyResolve = null;
var userReady = new Promise(function (resolve) { _userReadyResolve = resolve; });

async function fetchCurrentUser() {
  try {
    var data = await fetch("/api/v1/auth/me").then(function (r) { return r.json(); });
    if (data.authenticated) {
      currentUserRole = (data.role && data.role.name) || null;
      currentUserRoleColor = (data.role && data.role.color) || null;
      currentRolePermissions = (data.role && data.role.permissions) || {};
      currentUsername = data.username;
      currentUserAuthProvider = data.authProvider || "local";
      currentUserRegions = (data.regionTags && data.regionTags.user) || [];
      currentRoleRegions = (data.regionTags && data.regionTags.role) || [];
      currentEffectiveRegions = (data.regionTags && data.regionTags.effective) || [];
      try {
        localStorage.setItem("polaris-user", JSON.stringify({
          role: currentUserRole,
          roleColor: currentUserRoleColor,
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
// Quarantine is its OWN function key, not part of `assets` — a role can manage
// asset records without being allowed to push MAC blocks to FortiGates, and
// (per the built-in matrix) vice versa. Every server route under
// /assets/:id/quarantine* gates on assetsQuarantine, so anything offering those
// verbs in the UI must check this and not canManageAssets(), or the control
// appears for operators whose click can only 403.
function canQuarantineAssets() { return permAtLeast("assetsQuarantine", "write"); }
function canManageMaintenance() { return permAtLeast("maintenanceManagement", "fullwrite"); }
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

// `perm` hides the entry unless the role holds that function key at that
// level; `anyPerm` hides it unless AT LEAST ONE of the listed pairs holds —
// which is what a multi-tab page needs (IPAM is IP Blocks + Networks, and a
// role granted only one of them still has somewhere to land; `reservations`
// is deliberately NOT in IPAM's set — a reservation is only reachable through
// its subnet's IP panel, so subnets:read is what makes the page usable).
// Every entry whose page can 403 needs one of the two: without it the sidebar
// advertises a page whose first fetch is the only thing that tells the
// operator they can't be there. Dashboard is deliberately ungated — its
// routes carry no permission gate and it's the post-login landing page.
const NAV_ITEMS = [
  { href: "/",                label: "Dashboard",    icon: "grid" },
  { href: "/map.html",        label: "Device Map",   icon: "mapPin", perm: ["deviceMap", "read"] },
  { href: "/appmap.html",     label: "Application Map", icon: "share2", perm: ["applicationMap", "read"] },
  { href: "/ipam.html",       label: "IPAM",         icon: "layers", anyPerm: [["ipBlocks", "read"], ["subnets", "read"]] },
  { href: "/assets.html",         label: "Assets",       icon: "monitor", perm: ["assets", "read"] },
  { href: "/events.html",         label: "Events",       icon: "activity", perm: ["events", "read"] },
  { href: "/automations.html", label: "Automations", icon: "zap", perm: ["automationManagement", "read"] },
  // Was gated on canManageNetworks() (subnets:fullwrite) — the wrong key
  // entirely: a role granted integrations couldn't see the page, and a role
  // granted IP space but not integrations saw it and 403'd. No built-in role
  // changes hands (readonly/user/assetsadmin hold integrations:none, and
  // networkadmin holds :write).
  { href: "/integrations.html",  label: "Integrations", icon: "plug", perm: ["integrations", "read"] },
  { href: "/users.html",        label: "Users",        icon: "users", adminOnly: true },
];

// Last known push status + in-flight guard. Module-level because the control
// is rebuilt from scratch every time the user menu opens — there is no
// long-lived button to repaint, so the state has to outlive the menu.
var _pushState = null;
var _pushBusy = false;

// Last known TOTP enrollment state for the account menu's two-factor row, and
// a one-per-page-load fetch guard. Same reason as _pushState: the row is built
// fresh every time the menu opens, so there's no control to repaint.
var _totpState = null;
var _totpFetched = false;

/**
 * Push enrollment state + service-worker registration for the user menu's
 * "Enable push" / "Disable push" row.
 *
 * Gated on alerts:read, which is what the push routes themselves require —
 * pushSubscriptions.ts states the intent outright ("any viewer may opt into
 * push"). Previously the only control lived on /automations.html, which is
 * page-gated automationManagement:read, so a role with alerts but not
 * automation management could never enroll. The user menu renders on every
 * page, which preserves that.
 *
 * Registering the worker here (rather than lazily on first toggle) means the
 * push handler is live on every page for anyone who has already granted
 * permission, and reconcileSubscription repairs a rotated endpoint.
 */
function wirePushToggle() {
  if (!window.polarisPush || !polarisPush.isSupported()) return;
  if (!permAtLeast("alerts", "read")) return;

  polarisPush.registerSW()
    .then(function () { return polarisPush.reconcileSubscription("desktop"); })
    .catch(function () { /* push is optional */ });

  polarisPush.status()
    .then(function (st) { _pushState = st || null; })
    .catch(function () { _pushState = null; });
}

/**
 * The user menu's push row, or null when push isn't on offer — unsupported
 * browser, a role below alerts:read, or no Web Push channel configured
 * server-side (offering a control that can only error is worse than omitting
 * it; mirrors the Automations page).
 */
function _pushMenuItem() {
  if (!window.polarisPush || !polarisPush.isSupported()) return null;
  if (!permAtLeast("alerts", "read")) return null;
  if (!_pushState || !_pushState.enabledOnServer) return null;

  if (_pushState.permission === "denied") {
    // Sticky: requestPermission() resolves instantly with no UI once denied,
    // so the row states the reason rather than pretending to be actionable.
    return {
      label: "Push blocked in browser",
      icon: ICONS.bell,
      disabled: true,
      title: "Notifications are blocked for this site in your browser settings.",
    };
  }

  var subscribed = !!_pushState.subscribed;
  return {
    label: subscribed ? "Disable push" : "Enable push",
    icon: ICONS.bell,
    onSelect: _togglePush,
  };
}

/**
 * Never await before enable() — awaiting burns the click's transient user
 * activation and Safari then refuses the permission prompt. That's why this
 * branches off the cached _pushState instead of re-reading status(). See the
 * ordering comment in push.js.
 */
function _togglePush() {
  if (_pushBusy || !_pushState || _pushState.permission === "denied") return;
  _pushBusy = true;
  var wasSubscribed = !!_pushState.subscribed;

  var action = wasSubscribed ? polarisPush.disable() : polarisPush.enable({ surface: "desktop" });
  action.then(function () {
    if (typeof showToast === "function") {
      showToast(wasSubscribed ? "Push notifications disabled" : "Push notifications enabled", wasSubscribed ? "info" : "success");
    }
  }).catch(function (err) {
    if (typeof showToast === "function") showToast((err && err.message) || "Push action failed", "error");
  }).then(function () {
    _pushBusy = false;
    return polarisPush.status().then(function (st) { _pushState = st || null; }).catch(function () {});
  });
}

/**
 * Two-factor (TOTP) enrollment state for the user menu's row.
 *
 * Fetched once per page load — the account menu is the only surface that
 * reads it, and it's rebuilt per open. Deliberately NOT gated on
 * `currentUserAuthProvider`: renderNav also runs off the localStorage cache,
 * which doesn't carry the provider (it defaults to "local"), so the row gates
 * on the status payload's OWN authProvider instead. That's also the value the
 * /auth/totp/* routes enforce against, so the menu can't offer a control the
 * server will refuse.
 */
function wireTotpState() {
  if (_totpFetched) return;
  if (!window.PolarisTotpSelf || !window.api || !api.totp) return;
  _totpFetched = true;
  PolarisTotpSelf.status()
    .then(function (st) { _totpState = st || null; })
    .catch(function () { _totpState = null; });
}

/**
 * The user menu's two-factor row, or null when it isn't on offer: no shared
 * module on the page, state not read yet, or an SSO/LDAP account whose
 * directory owns MFA (the enroll route rejects those outright).
 *
 * Local accounts get a self-service second factor here because /users.html —
 * where this flow used to live exclusively — is admin-gated, so an ordinary
 * local user could never reach it despite the routes being self-service.
 */
function _totpMenuItem() {
  if (!window.PolarisTotpSelf) return null;
  if (!_totpState || _totpState.authProvider !== "local") return null;

  var label, title;
  if (_totpState.enabled) {
    label = "Disable two-factor auth";
    title = "Requires a current authenticator code or a backup code"
      + (_totpState.backupCodesRemaining ? " (" + _totpState.backupCodesRemaining + " backup codes left)" : "");
  } else if (_totpState.enrolling) {
    // A secret was minted but never confirmed — enroll() re-issues one, so
    // the row resumes the flow rather than pretending nothing happened.
    label = "Finish two-factor setup";
    title = "Enrollment was started but never confirmed";
  } else {
    label = "Set up two-factor auth";
    title = "Add an authenticator-app code to your login";
  }
  return { label: label, icon: ICONS.shield, title: title, onSelect: _openTotpSelf };
}

/**
 * Re-read enrollment state so the row relabels after the flow changed it.
 * Exposed because /users.html hosts the same flow off its own row menu — the
 * cached row would otherwise still read "Set up two-factor auth" on the page
 * where the operator just enabled it.
 */
function refreshTotpState() {
  if (!window.PolarisTotpSelf) return;
  PolarisTotpSelf.status()
    .then(function (st) { _totpState = st || null; })
    .catch(function () {});
}

/** Open the enroll/disable flow, refreshing the cached row state after. */
function _openTotpSelf() {
  PolarisTotpSelf.open({ onChange: refreshTotpState });
}

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
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
  share2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
};

function renderNav() {
  const current = window.location.pathname;
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  const visibleItems = NAV_ITEMS.filter(function (item) {
    if (item.adminOnly) return isAdmin();
    if (item.perm) return permAtLeast(item.perm[0], item.perm[1]);
    if (item.anyPerm) {
      return item.anyPerm.some(function (pair) { return permAtLeast(pair[0], pair[1]); });
    }
    return true;
  });

  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <img src="/img/brand/polaris-vert-dark.png" alt="" class="sidebar-logo brand-mark brand-mark-sidebar" style="visibility:hidden">
      <h1 style="font-size:1.1rem;font-weight:600;margin:0.5rem 0 0;color:var(--color-text-primary);text-align:center;visibility:hidden;display:none">Polaris</h1>
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
          // Single sidebar alert dot. Lives only on Events — the page that
          // hosts both the Conflicts and Alerts panels. Combines discovery
          // conflicts (danger/red) with stale-reservation alerts + queued
          // pushes (warning/yellow); red takes precedence (see
          // refreshConflictDot). There is intentionally no second dot.
          dot = '<span class="nav-conflict-dot" id="nav-conflict-dot" style="display:none"></span>';
        }
        return `<li><a href="${item.href}" class="${isActive ? "active" : ""}">${ICONS[item.icon]}<span>${item.label}</span>${dot}</a></li>`;
      }).join("")}
    </ul>
    <div style="margin-top:auto">
      <div id="role-review-status" class="query-status role-review-status" style="display:none"></div>
      <div id="integration-failed-status" class="query-status integration-failed-status" style="display:none"></div>
      <div id="signing-failure-alert" class="query-status signing-failure-alert" style="display:none"></div>
      <div id="update-status" class="query-status update-status" style="display:none"></div>
      <div id="query-status" class="query-status" style="display:none"></div>
      <div id="capacity-critical-alert" class="capacity-critical-alert" style="display:none"></div>
      ${(isAdmin() || canManageAssets()) ? `<div style="padding:0.5rem 0.5rem 0;border-top:1px solid var(--color-border-light)">
        <a href="/server-settings.html" class="sidebar-bottom-link${current === '/server-settings.html' ? ' active' : ''}">${ICONS.settings}<span>Server Settings</span></a>
      </div>` : ''}
      <!-- The theme picker sits here, below Server Settings and above the
           version line. Push enrollment and logout stay in the user menu
           behind the page-header badge (renderUserBadge) — push in
           particular must stay reachable for an alerts:read role that cannot
           open /automations.html, where the only enrollment control once
           lived. The padding/border pair depends on whether the Server
           Settings block above rendered: without it this block owns the
           separator from the nav.

           The button is labelled with the CURRENT theme and opens the full
           list (openThemeMenu) — with three themes a two-way toggle would make
           the third reachable only by cycling past one you didn't want. -->
      <div style="padding:${(isAdmin() || canManageAssets()) ? '0.25rem' : '0.5rem'} 0.5rem 0.5rem;${(isAdmin() || canManageAssets()) ? '' : 'border-top:1px solid var(--color-border-light);'}">
        <button type="button" id="btn-theme-toggle" class="theme-toggle" aria-haspopup="menu" aria-expanded="false">${_getTheme(_getCurrentTheme()).icon()}<span>${_getTheme(_getCurrentTheme()).label}</span></button>
      </div>
      <div id="sidebar-version" style="padding:0 0.75rem 0.75rem;text-align:center;font-size:0.7rem;color:var(--color-text-tertiary);letter-spacing:0.02em"></div>
    </div>
  `;

  var themeBtn = document.getElementById("btn-theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      openThemeMenu(themeBtn);
    });
  }

  wirePushToggle();
  wireTotpState();

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

  // ─── Failed-integration notice ────────────────────────────────────────
  // Sidebar panel surfacing integrations whose most recent credential test
  // failed. `integrationConnectionTester` refreshes lastTestOk every 10 min,
  // so polling at 30 s is plenty — the underlying state changes slowly.
  // Silently degrades on permission denial (the route requires
  // integrations=read; users without it just see nothing).
  var _failedIntegrations = [];
  async function pollFailedIntegrations() {
    try {
      var result = await api.integrations.healthSummary();
      _failedIntegrations = (result && result.failed) || [];
    } catch (_) {
      _failedIntegrations = [];
    }
    renderIntegrationFailedStatus();
  }
  pollFailedIntegrations();
  setInterval(pollFailedIntegrations, 30000);
  window._pollFailedIntegrations = pollFailedIntegrations;
  window._getFailedIntegrations = function () { return _failedIntegrations; };

  // ─── Agent code-signing failure alert ─────────────────────────────────
  // Dismissable sidebar alert: the last agent build shipped UNSIGNED
  // Windows binaries (code signing enabled but failed — the build is
  // fail-open by design). Visible only to roles that can deploy agents
  // (assets:write — same gate as the per-asset agent install routes).
  // Dismissal is per-user + per-failure: the localStorage key stores the
  // failure's `at` stamp, so a NEW failure re-shows the alert. Cleared
  // server-side by the next fully-signed build or by disabling signing.
  var _signingFailure = null;
  async function pollSigningAlert() {
    if (!canManageAssets()) return;
    try {
      var result = await api.assets.agentSigningAlert();
      _signingFailure = (result && result.failure) || null;
    } catch (_) {
      _signingFailure = null;
    }
    renderSigningFailureAlert();
  }
  if (canManageAssets()) {
    pollSigningAlert();
    setInterval(pollSigningAlert, 30000);
  }
  window._pollSigningAlert = pollSigningAlert;
  window._getSigningFailure = function () { return _signingFailure; };

  // ─── In-app update progress ───────────────────────────────────────────
  // Sidebar panel that mirrors the discovery indicator while an in-app
  // update is being applied (Server Settings → Maintenance kicks it off,
  // but it should be visible from any page). Reads the same in-memory
  // /updates/status the Maintenance card polls; surfaced only while the
  // update is actually running (state applying/restarting). Admin-only,
  // matching checkSidebarUpdate — the status route is serverSettingsSystem-
  // gated, so polling it as a non-admin would only earn 403s.
  var _updateStatus = null;
  async function pollUpdateProgress() {
    if (!isAdmin()) return;
    try {
      _updateStatus = await api.serverSettings.getUpdateStatus();
    } catch (_) {
      // Mid-restart the web process is briefly unreachable and the poll
      // fails. Keep the last known status so the panel persists across the
      // restart window instead of flickering out; only clear it when we
      // weren't already mid-update.
      if (!(_updateStatus && (_updateStatus.state === "applying" || _updateStatus.state === "restarting"))) {
        _updateStatus = null;
      }
    }
    renderUpdateStatus();
  }
  if (isAdmin()) {
    pollUpdateProgress();
    // 5 s — responsive enough to track per-step progress; the status route
    // just returns an in-memory object so the poll is cheap.
    setInterval(pollUpdateProgress, 5000);
  }
  window._pollUpdateProgress = pollUpdateProgress;
  window._getUpdateStatus = function () { return _updateStatus; };

  // Inject global search bar + user badge into page header
  renderGlobalSearch();
  renderUserBadge();

  // Single Events-page sidebar dot — poll every 30 s; exposed on window so
  // events.js can refresh it after operator actions. Combines every
  // Events-page alert signal: discovery conflicts (danger) + the reservation
  // push queue + stale-reservation alerts (both warning). The dot shows red
  // when there are conflicts and yellow otherwise — red precedence, so a
  // danger signal is never masked by a warning one. There is no separate
  // IPAM dot; the legacy window.refreshAlertsDot was folded into this.
  async function refreshConflictDot() {
    var dot = document.getElementById("nav-conflict-dot");
    if (!dot) return;
    try {
      var counts = await Promise.all([
        canReviewConflicts()
          ? api.conflicts.count().catch(function () { return { count: 0 }; })
          : Promise.resolve({ count: 0 }),
        api.reservations.pushQueueCount().catch(function () { return { count: 0 }; }),
        api.reservations.alertsCount().catch(function () { return { count: 0 }; }),
      ]);
      var conflictCount = (counts[0] && counts[0].count) || 0;
      var queueCount = (counts[1] && counts[1].count) || 0;
      var alertCount = (counts[2] && counts[2].count) || 0;
      var warningCount = queueCount + alertCount;
      dot.style.display = (conflictCount + warningCount) > 0 ? "inline-block" : "none";
      // Red (danger) wins over yellow (warning): only flip to the warning
      // colour when there are no conflicts but there are stale alerts / pushes.
      dot.classList.toggle("nav-conflict-dot--warning", conflictCount === 0 && warningCount > 0);
    } catch (_) {}
  }
  refreshConflictDot();
  setInterval(refreshConflictDot, 30000);
  window.refreshConflictDot = refreshConflictDot;
  // Back-compat alias: events.js still calls window.refreshAlertsDot() after
  // Alerts-panel actions. With the dots consolidated, both point at the one
  // refresher so callers don't need to know which signal changed.
  window.refreshAlertsDot = refreshConflictDot;

  // Re-apply branding when it already loaded — the brand block above renders
  // visibility:hidden until applyBranding clears it, and on pages that re-run
  // renderNav after boot (map.js re-renders after its own fetchCurrentUser)
  // the fetchBranding() apply can land BEFORE that re-render, leaving the
  // logo / app name / version invisible until the next full page load.
  if (_branding) applyBranding(_branding, true);
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

// ─── Role badge color helpers ────────────────────────────────────────────────
// A role can carry a stored `color` (#rrggbb). When present it drives the badge
// inline (translucent fill + solid text + border, matching the .badge-* CSS
// recipe) so renamed built-ins and custom roles keep their color. When absent,
// callers fall back to the legacy name-keyed badge classes above.

function hexToRgba(hex, alpha) {
  var m = /^#?([0-9a-fA-F]{6})$/.exec((hex || "").trim());
  if (!m) return null;
  var n = parseInt(m[1], 16);
  var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

// Inline style string for a role badge given its stored color. Returns "" when
// the color is missing/invalid so the caller can fall back to a CSS class.
function roleBadgeStyleFromColor(color) {
  var solid = hexToRgba(color, 1);
  if (!solid) return "";
  return "background:" + hexToRgba(color, 0.14) + ";color:" + color +
    ";border:1px solid " + hexToRgba(color, 0.30);
}

// A pleasant random `#rrggbb` for the new-role color picker default — random
// hue, fixed mid saturation/lightness so every default reads as a usable badge.
function randomRoleColor() {
  var h = Math.floor(Math.random() * 360), s = 0.62, l = 0.55;
  var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + rgb.map(function (v) {
    return ("0" + Math.round((v + m) * 255).toString(16)).slice(-2);
  }).join("");
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
    '<span id="global-search-spinner" class="global-search-spinner" hidden aria-hidden="true"></span>' +
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
      // Empty input → fall back to the focus-state shortcut hints so
      // operators see the scope abbreviations again the moment they
      // clear the box. A 1-char query still hides the dropdown so
      // accidental keystrokes don't flash the hint panel.
      if (q.length === 0) _showSearchShortcutHints();
      else { dropdown.style.display = "none"; dropdown.innerHTML = ""; }
      _searchLastQuery = "";
      _searchActiveResults = null;
      _setSearchBusy(false);
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
    else if (!input.value.trim()) _showSearchShortcutHints();
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

// Toggle the in-flight spinner on the right edge of the search bar.
function _setSearchBusy(busy) {
  var spinner = document.getElementById("global-search-spinner");
  if (spinner) spinner.hidden = !busy;
}

async function _performSearch(q) {
  var dropdown = document.getElementById("global-search-dropdown");
  _searchLastQuery = q;
  _setSearchBusy(true);
  try {
    var results = await api.search.query(q);
    if (results.query !== _searchLastQuery) return; // stale response — a newer query owns the spinner
    _searchActiveResults = results;
    _renderSearchDropdown(results);
    _setSearchBusy(false);
  } catch (err) {
    if (q !== _searchLastQuery) return; // stale failure — don't clear a newer query's spinner
    dropdown.innerHTML = '<div class="global-search-empty">Search failed: ' + escapeHtml(err.message || "Unknown error") + '</div>';
    dropdown.style.display = "block";
    _setSearchBusy(false);
  }
}

function _renderSearchDropdown(results) {
  var dropdown = document.getElementById("global-search-dropdown");
  var sites = results.sites || [];
  // Skip the virtual-Device-Map synthesis when the operator typed a
  // non-map scope prefix (`a:`, `r:`, `n:`, `b:` / long forms). The
  // backend already returns only that group's hits; synthesizing map
  // rows from the asset list would defeat the scope.
  var scopeMatch = (results.query || "").match(/^(block|asset|reservation|network|b|a|r|n):/i);
  var endpointMapHits = scopeMatch ? [] : (results.assets || [])
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

  // Asset/site hits carry `status` (the assets-table monitor pill, computed
  // server-side); map its kind onto the existing badge classes so the
  // dropdown pill matches the assets list exactly.
  var pillClassByKind = {
    "unmonitored": "badge-unmonitored",
    "up":          "badge-monitored",
    "warning":     "badge-monitor-warning",
    "down":        "badge-monitor-down",
    "recovering":  "badge-monitor-recovering",
    "pending":     "badge-monitor-recovering",
    "passive":     "badge-monitor-passive",
    "dep-down":    "badge-monitor-dep-down",
    "dep-test":    "badge-monitor-dep-test",
  };

  function section(label, hits) {
    if (!hits.length) return "";
    var rows = hits.map(function (h) {
      var pill = "";
      if (h.status && pillClassByKind[h.status.kind]) {
        pill = ' <span class="badge gs-item-pill ' + pillClassByKind[h.status.kind] + '">' + escapeHtml(h.status.label) + '</span>';
      }
      return '<div class="gs-item" data-type="' + h.type + '" data-id="' + escapeHtml(h.id) + '"' +
        (h.context ? ' data-context="' + escapeHtml(JSON.stringify(h.context)) + '"' : '') + '>' +
        '<div class="gs-item-title">' + escapeHtml(h.title) + pill + '</div>' +
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

// Show the scope-shortcut help panel when the search bar is focused with
// no query in flight. Clicking a hint pre-fills the input with the scope
// prefix and a trailing space so the operator can keep typing.
function _showSearchShortcutHints() {
  var dropdown = document.getElementById("global-search-dropdown");
  if (!dropdown) return;
  var hints = [
    { prefix: "block:",       short: "b:", label: "Search IP blocks only" },
    { prefix: "network:",     short: "n:", label: "Search networks (subnets) only" },
    { prefix: "asset:",       short: "a:", label: "Search assets only" },
    { prefix: "reservation:", short: "r:", label: "Search reservations only" },
    { prefix: "map:",         short: "m:", label: "Search pinned firewalls (Device Map) only" },
    { prefix: "tag:",         short: "t:", label: "Search by tag across networks & assets" },
  ];
  var rows = hints.map(function (h) {
    return '<div class="gs-hint" data-prefix="' + escapeHtml(h.prefix) + '">' +
      '<div class="gs-hint-keys"><span class="gs-hint-key">' + escapeHtml(h.prefix) + '</span>' +
        '<span class="gs-hint-or">or</span>' +
        '<span class="gs-hint-key">' + escapeHtml(h.short) + '</span></div>' +
      '<div class="gs-hint-label">' + escapeHtml(h.label) + '</div>' +
    '</div>';
  }).join("");
  dropdown.innerHTML =
    '<div class="gs-group gs-hint-group">' +
    '  <div class="gs-group-label">Search shortcuts — scoped searches return up to 200 results (no top-8 cap)</div>' +
    rows +
    '  <div class="gs-hint-foot">Type multiple words to match all of them · wrap a phrase in "quotes" to keep spaces</div>' +
    '</div>';
  dropdown.style.display = "block";

  dropdown.querySelectorAll(".gs-hint").forEach(function (el) {
    el.addEventListener("click", function () {
      var input = document.getElementById("global-search-input");
      if (!input) return;
      input.value = el.getAttribute("data-prefix") + " ";
      input.focus();
      // Keep the hint panel up — the operator hasn't typed a query yet.
    });
  });
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
  for (var i = 0; i < existing.length; i++) {
    // An open account menu is body-mounted and fixed, so it would outlive the
    // badge it hangs off. Close it here rather than leaving it anchored to a
    // detached node — scoped to THIS badge so a re-render can't shut a row
    // menu somewhere else on the page.
    if (_rowMenuTeardown && _rowMenuTeardown.anchor === existing[i]) closeRowMenu({ silent: true });
    existing[i].remove();
  }

  var initials = _getUserInitials(currentUsername);
  var color = _getInitialsColor(currentUsername);

  var roleLabel = _getRoleLabel(currentUserRole);
  // Prefer the role's stored color (survives renames + works for custom roles);
  // fall back to the legacy name-keyed badge class when no color is set.
  var roleColorStyle = roleBadgeStyleFromColor(currentUserRoleColor);
  var roleBadgeAttrs = roleColorStyle
    ? 'class="badge" style="font-size:0.7rem;padding:1px 6px;' + roleColorStyle + '"'
    : 'class="badge ' + _getRoleBadgeClass(currentUserRole) + '" style="font-size:0.7rem;padding:1px 6px"';

  // The badge is the account menu's trigger — theme, push enrollment and
  // logout hang off it rather than off the sidebar bottom, so per-account
  // actions sit with the account identity instead of with the navigation.
  var badge = document.createElement("button");
  badge.type = "button";
  badge.className = "user-badge user-menu-trigger";
  badge.setAttribute("aria-haspopup", "menu");
  badge.setAttribute("aria-expanded", "false");
  badge.innerHTML =
    '<div class="user-badge-avatar" style="background:' + color + '">' + escapeHtml(initials) + '</div>' +
    '<span class="user-badge-name">' + escapeHtml(currentUsername) + '</span>' +
    (roleLabel ? '<span ' + roleBadgeAttrs + '>' + escapeHtml(roleLabel) + '</span>' : '') +
    '<svg class="user-badge-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
  badge.title = currentUsername + ' (' + roleLabel + ')';
  badge.addEventListener("click", function () { openUserMenu(badge); });
  header.appendChild(badge);
}

/**
 * The account menu behind the page-header user badge: push enrollment,
 * two-factor enrollment, logout. Items are built per open so the push / 2FA
 * rows reflect current state without anything to keep repainted. The theme
 * toggle lives at the bottom of the sidebar, not here — it is a display
 * preference rather than an account action, and an always-visible control
 * beats one behind a menu for something operators flip often.
 */
function openUserMenu(anchor) {
  if (typeof showRowMenu !== "function") return;

  var items = [];

  var push = _pushMenuItem();
  if (push) items.push(push);

  var totp = _totpMenuItem();
  if (totp) items.push(totp);

  // Only separate Logout from something — with no push or 2FA row the menu is
  // Logout alone, and a leading rule would be a divider above nothing.
  if (items.length) items.push({ separator: true });
  items.push({
    label: "Logout",
    icon: ICONS.logout,
    danger: true,
    onSelect: function () {
      fetch("/api/v1/auth/logout", { method: "POST", headers: _csrfHeaders() })
        .catch(function () { /* log out locally regardless */ })
        .then(function () { window.location.href = "/login.html"; });
    },
  });

  showRowMenu(anchor, items, { label: "Account menu", align: "end" });
}

// ─── Branding ──────────────────────────────────────────────────────────────

var _branding = null;

function applyBranding(b, skipCache) {
  if (!b) return;
  _branding = b;
  if (!skipCache) {
    try { localStorage.setItem("polaris-branding", JSON.stringify(b)); } catch (_) {}
  }
  // Hardware-sensor display unit rides the branding payload — hand it to the
  // converter now so a changed preference (or a first load with no cached
  // branding) takes effect on this page without a reload.
  if (window.PolarisTempUnit) window.PolarisTempUnit.setFromBranding(b);

  // Update sidebar logo + name. Which mark (operator's logo vs the shipped
  // Polaris art for the current theme) and whether the name is text at all are
  // PolarisBrandLogo's call — see public/js/brand-logo.js.
  var sidebarLogo = document.querySelector(".sidebar-logo");
  var placement = window.PolarisBrandLogo
    ? PolarisBrandLogo.applyTo(sidebarLogo, b, "sidebar")
    : { showName: true, showSubtitle: Boolean(b.subtitle) };
  if (sidebarLogo) sidebarLogo.style.visibility = "";
  var sidebarName = document.querySelector(".sidebar-brand h1");
  if (sidebarName) {
    sidebarName.textContent = b.appName || "Polaris";
    sidebarName.style.display = placement.showName ? "" : "none";
    sidebarName.style.visibility = "";
  }
  var sidebarSub = document.querySelector(".sidebar-brand p");
  if (sidebarSub) {
    sidebarSub.textContent = b.subtitle || "";
    sidebarSub.style.display = placement.showSubtitle ? "" : "none";
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

  // Favicon follows an operator's UPLOAD only. The `customLogo` check is
  // load-bearing: the shipped default logoUrl is now the light-inked symbol
  // (for the PWA icon's dark canvas), so swapping it in unconditionally — as
  // this did while the default was the same file the page already declared —
  // would force light ink onto light browser chrome and make the icon vanish.
  // setFavicon updates BOTH declared links; see brand-logo.js.
  if (b.customLogo && b.logoUrl && window.PolarisBrandLogo) {
    PolarisBrandLogo.setFavicon(b.logoUrl);
  }

  // Update version in sidebar
  var versionEl = document.getElementById("sidebar-version");
  if (versionEl && b.version) {
    versionEl.textContent = "v" + b.version;
  }

  // Check for available updates (admin only)
  if (isAdmin()) checkSidebarUpdate();
}

// Swap the sidebar mark when the theme flips (the toggle, or the OS changing
// under a user who never picked one) — the Polaris art is theme-specific and
// the wrong variant is near-invisible. Logo only: applyBranding also kicks an
// update check, which has nothing to do with a color scheme.
if (window.PolarisBrandLogo) {
  PolarisBrandLogo.onThemeChange(function () {
    if (_branding) PolarisBrandLogo.applyTo(document.querySelector(".sidebar-logo"), _branding, "sidebar");
  });
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
    if (!_branding) applyBranding({ appName: "Polaris", subtitle: "Network Management Tool", logoUrl: "/img/brand/polaris-symbol-dark.png", version: "" });
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
            var cls = 'query-status-device query-status-device-link' + (slowSet[dev] ? ' query-status-device-slow' : '');
            var t = slowSet[dev]
              ? ' title="This FortiGate is taking longer than normal — click to open asset details"'
              : ' title="Open asset details"';
            return '<span class="' + cls + '"' + t +
              ' role="button" tabindex="0" data-device-name="' + escapeHtml(dev) + '">' +
              escapeHtml(dev) + '</span>';
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

  // Clicking (or Enter/Space on) a FortiGate name in the discovery popup opens
  // that firewall's asset slide-over.
  container.querySelectorAll(".query-status-device-link").forEach(function (el) {
    el.addEventListener("click", function () {
      openDiscoveryDevice(el.getAttribute("data-device-name"));
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDiscoveryDevice(el.getAttribute("data-device-name"));
      }
    });
  });
}

// Resolve a discovery "currently querying" FortiGate name to its Asset and open
// the asset details slide-over. The popup surfaces FortiGate device names, which
// equal the firewall Asset's hostname (see connectionPathService's hostname
// lookup). On the Assets page we open the slide-over in place; elsewhere we
// route through the same #view=asset: hash the global search uses, so
// processSearchHash opens it after navigation. No match (the transient FMG
// self-entry, or a FortiGate not yet inventoried) surfaces a toast rather than
// failing silently.
async function openDiscoveryDevice(name) {
  if (!name) return;
  var list;
  try {
    var rows = await api.assets.list({ search: name, limit: 25 });
    list = Array.isArray(rows) ? rows : (rows && rows.assets) || [];
  } catch (_) {
    showToast("Couldn't look up " + name, "error");
    return;
  }
  var lower = name.toLowerCase();
  var match =
    list.find(function (a) { return (a.hostname || "").toLowerCase() === lower && a.assetType === "firewall"; }) ||
    list.find(function (a) { return (a.hostname || "").toLowerCase() === lower; }) ||
    list.find(function (a) { return (a.dnsName || "").toLowerCase() === lower; });
  if (!match) {
    showToast("No matching asset for " + name, "error");
    return;
  }
  if (typeof openViewModal === "function") {
    openViewModal(match.id);
  } else {
    window.location.href = "/assets.html#view=asset:" + encodeURIComponent(match.id);
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

// ─── Failed-integration notice ──────────────────────────────────────────────
// Renders the sidebar panel listing integrations whose latest credential test
// failed. Reads from the closure-scoped _failedIntegrations array populated by
// pollFailedIntegrations above. Clicking the panel navigates to
// /integrations.html so the operator can inspect and re-test.

function renderIntegrationFailedStatus() {
  var container = document.getElementById("integration-failed-status");
  if (!container) return;
  var failed = (window._getFailedIntegrations && window._getFailedIntegrations()) || [];
  if (!failed.length) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }
  container.style.display = "block";
  var label = failed.length === 1 ? "integration not reachable" : "integrations not reachable";
  function typeLabel(t) {
    if (t === "fortimanager") return "FortiManager";
    if (t === "fortigate") return "FortiGate";
    if (t === "windowsserver") return "Windows Server";
    if (t === "entraid") return "Entra ID";
    if (t === "activedirectory") return "Active Directory";
    if (t === "vcenter") return "vCenter";
    if (t === "azurearc") return "Azure Arc";
    return t || "";
  }
  container.innerHTML =
    '<div class="query-status-header integration-failed-header">' +
      '<span class="integration-failed-icon" aria-hidden="true">&#9888;</span>' +
      '<span class="query-status-label">' + failed.length + ' ' + label + '</span>' +
    '</div>' +
    '<ul class="query-status-list">' +
      failed.map(function (i) {
        var sub = typeLabel(i.type);
        if (i.lastTestAt) {
          var when = new Date(i.lastTestAt);
          if (!isNaN(when.getTime())) sub += ' · last test ' + when.toLocaleString();
        } else {
          sub += ' · never tested';
        }
        return '<li><div style="min-width:0;flex:1">' +
          '<span class="query-status-name integration-failed-name" title="' + escapeHtml(i.name) + '">' + escapeHtml(i.name) + '</span>' +
          '<span class="query-status-progress">' + escapeHtml(sub) + '</span>' +
          '</div></li>';
      }).join("") +
    '</ul>';

  // Whole panel clicks through to the integrations page. Skip clicks that
  // originated on a button (defensive — there are none today, but parity with
  // the role-review panel pattern).
  container.style.cursor = "pointer";
  container.onclick = function (e) {
    if (e.target && e.target.tagName === "BUTTON") return;
    window.location.href = "/integrations.html";
  };
}

// ─── Agent code-signing failure alert ───────────────────────────────────────
// Renders the dismissable sidebar alert when the last agent build shipped
// unsigned Windows binaries (fail-open signing). Reads the closure-scoped
// _signingFailure populated by pollSigningAlert. Dismissal is per-user +
// per-failure via localStorage: the key stores the failure's `at` stamp, so
// dismissing hides THIS failure across reloads while a new failure (different
// stamp) re-surfaces the panel. Clicking through opens the Polaris Agents card.

function _signingAlertDismissKey() {
  return "polaris.signing-alert.dismissed." + (currentUsername || "anon");
}

function renderSigningFailureAlert() {
  var container = document.getElementById("signing-failure-alert");
  if (!container) return;
  var failure = (window._getSigningFailure && window._getSigningFailure()) || null;

  var dismissedAt = null;
  try { dismissedAt = localStorage.getItem(_signingAlertDismissKey()); } catch (_) {}

  if (!failure || dismissedAt === failure.at) {
    container.style.display = "none";
    container.innerHTML = "";
    container.onclick = null;
    return;
  }

  var when = new Date(failure.at);
  var sub = "v" + (failure.version || "?");
  if (!isNaN(when.getTime())) sub += " · " + when.toLocaleString();
  container.style.display = "block";
  container.innerHTML =
    '<div class="query-status-header signing-failure-header">' +
      '<span class="signing-failure-icon" aria-hidden="true">&#9888;</span>' +
      '<span class="query-status-label">Agent code signing failed</span>' +
      '<button class="query-abort-btn signing-failure-dismiss" title="Dismiss (re-appears on a new failure)">&#x2715;</button>' +
    '</div>' +
    '<ul class="query-status-list">' +
      '<li><div style="min-width:0;flex:1">' +
        '<span class="query-status-name">Windows agent binaries shipped UNSIGNED</span>' +
        '<span class="query-status-progress" title="' + escapeHtml(failure.error || "") + '">' + escapeHtml(sub) + '</span>' +
      '</div></li>' +
    '</ul>';

  var dismissBtn = container.querySelector(".signing-failure-dismiss");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      try { localStorage.setItem(_signingAlertDismissKey(), failure.at); } catch (_) {}
      renderSigningFailureAlert();
    });
  }

  // Click-through to the Polaris Agents card (Integrations → Polaris Agents),
  // where the Code signing pane names the specific problem.
  container.style.cursor = "pointer";
  container.onclick = function (e) {
    if (e.target && e.target.tagName === "BUTTON") return;
    window.location.href = "/integrations.html";
  };
}

// ─── In-app update progress ─────────────────────────────────────────────────
// Renders the sidebar panel shown while an in-app update is being applied.
// Reads the closure-scoped _updateStatus populated by pollUpdateProgress.
// Only visible while state is "applying" or "restarting" — the "available"
// badge near the version (checkSidebarUpdate) handles the not-yet-started
// case, and complete/failed are surfaced on the Maintenance card. Shows just
// the step the pipeline is currently on (not the full checklist — that lives
// on the Maintenance card). The whole panel clicks through there for detail.

function renderUpdateStatus() {
  var container = document.getElementById("update-status");
  if (!container) return;
  var status = (window._getUpdateStatus && window._getUpdateStatus()) || null;
  var active = status && (status.state === "applying" || status.state === "restarting");
  if (!active) {
    container.style.display = "none";
    container.innerHTML = "";
    container.onclick = null;
    return;
  }

  var label = status.state === "restarting" ? "Update — restarting" : "Applying update";
  var steps = Array.isArray(status.steps) ? status.steps : [];
  var current = steps.find(function (st) { return st.status === "running"; });
  // Between steps (or in the restart phase) nothing is mid-flight — fall back
  // to the coarse status.step string, then to a sensible default.
  var currentName = (current && current.name) || status.step ||
    (status.state === "restarting" ? "Restarting service" : "");
  var currentMsg = current && current.message;

  container.style.display = "block";
  container.innerHTML =
    '<div class="query-status-header update-status-header">' +
      '<span class="query-spinner"></span>' +
      '<span class="query-status-label">' + escapeHtml(label) + '</span>' +
    '</div>' +
    (currentName
      ? '<ul class="query-status-list"><li><div style="min-width:0;flex:1">' +
          '<span class="query-status-name">' + escapeHtml(currentName) + '</span>' +
          (currentMsg ? '<span class="query-status-progress">' + escapeHtml(currentMsg) + '</span>' : '') +
          '</div></li></ul>'
      : "");

  container.style.cursor = "pointer";
  container.onclick = function () {
    window.location.href = "/server-settings.html?tab=database";
  };
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

// ─── CSV export + Toasts ────────────────────────────────────────────────────
// downloadCsv/_csvRow and getToastContainer/showToast are canonical in
// api.js (loaded before this file on every page, incl. dash/mobile) since
// the 2026-08 audit — the dash-boot forks are gone.


// ─── Modal ────────────────────────────────────────────────────────────────────

var _modalDrag = { active: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };

// Escalating "use the X" hint: each off-modal click flashes the close button
// brighter than the last, with a radial bloom that grows in quarter-size
// increments. Resets after 1s of no off-clicks (or on close). Shared by every
// modal overlay (IPAM modals via openModal + the Device Map topology modal in
// map.js), so it's a global helper keyed off whichever close button is passed.
var _modalFlashLevel = 0;
var _modalFlashResetTimer = null;

// Flash the given modal close button + bloom one escalation step. closeBtn is
// the ".modal-close" / equivalent X element of the overlay the user clicked off.
function flashModalCloseBtn(closeBtn) {
  if (!closeBtn) return;
  // Each subsequent off-click ramps brighter (capped); decays 1s after the
  // last click, so a pause resets the escalation back to the start.
  var lvl = (_modalFlashLevel = Math.min(_modalFlashLevel + 1, 8));
  if (_modalFlashResetTimer) clearTimeout(_modalFlashResetTimer);
  _modalFlashResetTimer = setTimeout(function () { _modalFlashLevel = 0; }, 1000);
  // Drive the transition inline (matched to the bloom's 0.45s ease-out below)
  // so the X glow and the radial bloom fade in/out together. Inline so it
  // applies to both the modal .modal-close and the slide-over .btn-icon, and
  // survives the class removal in the reset so the fade-OUT is also 0.45s
  // instead of snapping back via the base .modal-close 0.15s transition.
  closeBtn.style.transition =
    "color 0.45s ease-out, background 0.45s ease-out, transform 0.45s ease-out," +
    "filter 0.45s ease-out, text-shadow 0.45s ease-out";
  closeBtn.style.background = "rgba(255,77,109," + Math.min(0.25 + lvl * 0.09, 0.95) + ")";
  closeBtn.style.filter = "brightness(" + (1 + lvl * 0.18) + ")";
  closeBtn.style.textShadow = "0 0 " + (lvl * 3) + "px rgba(255,77,109,0.9)";
  closeBtn.classList.add("flash");
  // Singleton bloom on <body>: position:fixed + high z-index so it paints over
  // any modal and spills past the corner unclipped, regardless of which overlay
  // owns the X. Styles are inline (not a CSS class) so a stale cached
  // stylesheet can't render it invisible.
  var bloom = document.getElementById("modal-close-bloom");
  if (!bloom) {
    bloom = document.createElement("div");
    bloom.id = "modal-close-bloom";
    bloom.style.cssText =
      "position:fixed;border-radius:50%;pointer-events:none;opacity:0;z-index:100000;" +
      "transform:translate(-50%,-50%);mix-blend-mode:screen;" +
      "background:radial-gradient(circle,rgba(255,77,109,0.85) 0%,rgba(255,77,109,0.6) 32%,rgba(255,77,109,0) 70%);" +
      "transition:opacity 0.45s ease-out,width 0.08s,height 0.08s;";
  }
  // A fullscreened element renders in the browser's top layer, which paints
  // over body-level fixed elements. Re-home the bloom into whatever is
  // fullscreen (else body) so it still shows over the topology modal there;
  // a position:fixed child of the top-layer element renders in the top layer.
  var bloomHost = document.fullscreenElement || document.body;
  if (bloom.parentNode !== bloomHost) bloomHost.appendChild(bloom);
  // No bloom on the first off-click; from the 2nd on it starts at 1/4 the full
  // size and grows by quarter increments to full by the 5th.
  var steps = Math.min(lvl - 1, 4); // 0..4
  if (steps <= 0) {
    bloom.style.opacity = "0";
  } else {
    var r = closeBtn.getBoundingClientRect();
    var size = 280 * steps / 4; // 70px → 280px in quarter steps
    bloom.style.left = (r.left + r.width / 2) + "px";
    bloom.style.top = (r.top + r.height / 2) + "px";
    bloom.style.width = size + "px";
    bloom.style.height = size + "px";
    bloom.style.opacity = String(0.35 + steps * 0.15); // 0.5 → 0.95
  }
  setTimeout(function () {
    closeBtn.classList.remove("flash");
    closeBtn.style.background = "";
    closeBtn.style.filter = "";
    closeBtn.style.textShadow = "";
    bloom.style.opacity = "0";
    // Let the 0.45s fade-out run, then drop the inline transition so the
    // button's normal hover snaps back to the base .modal-close 0.15s timing.
    setTimeout(function () { closeBtn.style.transition = ""; }, 460);
  }, 600);
}

// ─── Modal accessibility (focus trap + restore + Escape) ──────────────────────
// Shared helpers so every openModal / showConfirm caller gets dialog semantics,
// a Tab focus-trap, Escape-to-close, and focus restoration for free.
function _focusableIn(container) {
  var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.prototype.slice.call(container.querySelectorAll(sel))
    .filter(function (el) { return el.offsetParent !== null; });
}
// Trap Tab within `container`; call `onEscape` on Escape. Returns a teardown fn.
function _trapFocus(container, onEscape) {
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); onEscape(); return; }
    if (e.key !== "Tab") return;
    var f = _focusableIn(container);
    if (!f.length) { e.preventDefault(); container.focus(); return; }
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", onKey, true);
  return function () { document.removeEventListener("keydown", onKey, true); };
}
function _focusFirstIn(container) {
  var f = _focusableIn(container);
  if (f.length) f[0].focus(); else container.focus();
}
var _modalReturnFocus = null;  // element refocused when the shared modal closes
var _modalKeyTeardown = null;  // active focus-trap teardown for the shared modal

// ─── Panel lock (per-user, app-wide) ────────────────────────────────────────
//
// A lock toggle next to the X on every modal and slide-over. Locking is global
// per type — one switch governs ALL modals, another ALL slide-overs — and is
// saved per user in localStorage. When locked, clicking the backdrop (off the
// panel) does NOT dismiss it; when unlocked, an off-click closes it (the
// default). The X and Escape always close regardless of lock.
//
// Modals route through openModal (handled inline below). Slide-overs each wire
// their own backdrop-close handler, so a capture-phase document listener blocks
// that close when locked instead of editing every panel. Lock buttons are
// injected generically by a MutationObserver, so new panels get one for free.
//
// State lives on `window`, NOT in file scope: app.js can be evaluated more than
// once on a page, and a fresh file-scope object would silently reset the lock
// while the buttons already injected into the DOM kept claiming the old state.
// Re-using the existing object makes a re-evaluation a no-op instead.
window.__polarisPanelLock = window.__polarisPanelLock ||
  { state: { modal: false, slideover: false }, user: "anon", wired: false };
var _panelLockStore = window.__polarisPanelLock;

function _panelLockKey() { return "polaris.panellock." + _panelLockStore.user; }

function _loadPanelLock() {
  var st = _panelLockStore.state;
  try {
    var v = JSON.parse(localStorage.getItem(_panelLockKey()) || "null");
    st.modal = !!(v && v.modal);
    st.slideover = !!(v && v.slideover);
  } catch (_) { st.modal = false; st.slideover = false; }
  _syncAllLockButtons();
}

function _savePanelLock() {
  try { localStorage.setItem(_panelLockKey(), JSON.stringify(_panelLockStore.state)); } catch (_) {}
}

function _togglePanelLock(type) {
  _panelLockStore.state[type] = !_panelLockStore.state[type];
  _savePanelLock();
  _syncAllLockButtons(type);
}

// Read-only accessor for page code that has to honor the lock beyond the
// backdrop-click rule — e.g. the asset slide-over's Edit button, which
// normally closes the panel before opening the edit modal and must not when
// the operator has pinned the panel open.
function isPanelLocked(type) { return !!_panelLockStore.state[type]; }
window.isPanelLocked = isPanelLocked;

function _lockBtnSvg(locked) {
  var attrs = 'width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  var body = locked
    ? '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
    : '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>';
  return '<svg ' + attrs + '>' + body + '</svg>';
}

function _syncLockButton(btn) {
  if (!btn) return;
  var type = btn.getAttribute("data-lock-type");
  var locked = !!_panelLockStore.state[type];
  var noun = type === "modal" ? "dialogs" : "panels";
  btn.innerHTML = _lockBtnSvg(locked);
  btn.classList.toggle("locked", locked);
  btn.style.color = locked ? "var(--color-accent)" : "";
  btn.setAttribute("aria-pressed", locked ? "true" : "false");
  btn.setAttribute("aria-label", locked ? ("Unlock " + noun) : ("Lock " + noun));
  btn.title = locked
    ? ("Locked — clicking outside won’t close " + noun + ". Saved for your account. Click to unlock.")
    : ("Unlocked — clicking outside closes it. Click to lock all " + noun + " (saved for your account).");
}

function _syncAllLockButtons(type) {
  var sel = ".panel-lock-btn" + (type ? '[data-lock-type="' + type + '"]' : "");
  document.querySelectorAll(sel).forEach(_syncLockButton);
}

// Insert a lock button immediately before the close (X) button in a panel
// header. Idempotent — re-running skips headers that already have one.
function _ensureLockButton(headerEl, type) {
  if (!headerEl || headerEl.querySelector(".panel-lock-btn")) return;
  var closeBtn = type === "modal"
    ? headerEl.querySelector(".modal-close")
    : headerEl.querySelector(".btn-icon");
  if (!closeBtn) return;
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-icon panel-lock-btn";
  btn.setAttribute("data-lock-type", type);
  // Headers are flex with space-between; margin-left:auto absorbs the free
  // space so the lock sits flush against the X instead of centered.
  btn.style.marginLeft = "auto";
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    _togglePanelLock(type);
  });
  closeBtn.parentNode.insertBefore(btn, closeBtn);
  _syncLockButton(btn);
}

function _injectPanelLockButtons() {
  document.querySelectorAll(".slideover .slideover-header-top").forEach(function (h) {
    _ensureLockButton(h, "slideover");
  });
  var mh = document.querySelector("#modal-overlay .modal-header");
  if (mh) _ensureLockButton(mh, "modal");
}

// Wire the observer (injects lock buttons into newly-created panels) + the
// capture-phase backdrop guard for slide-overs, then load the saved preference.
//
// Safe to call repeatedly AND safe to call late: the listeners are wired once,
// everything else re-syncs. Call it from the SAME ready path that waits for the
// rest of the runtime — running before the scripts resolve leaves the observer
// unwired and keys the preference to `anon` instead of the username.
//
//   initPanelLock({ user: currentUsername })
function initPanelLock(opts) {
  if (opts && opts.user) _panelLockStore.user = opts.user;
  _loadPanelLock();
  if (_panelLockStore.wired) { _injectPanelLockButtons(); return; }
  _panelLockStore.wired = true;

  // Block slide-over backdrop-close when locked. Capture phase runs before the
  // panel's own (bubbling) overlay handler, so stopping propagation here keeps
  // it open. e.target is the overlay itself only on a genuine backdrop click.
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains("slideover-overlay") && _panelLockStore.state.slideover) {
      e.stopPropagation();
      // Same glow/bloom the modal X gives on an off-click while locked — flash
      // this slide-over's close button (the btn-icon that isn't the lock).
      var closeBtn = t.querySelector(".slideover-header-top .btn-icon:not(.panel-lock-btn)");
      flashModalCloseBtn(closeBtn);
    }
  }, true);

  if (window.MutationObserver) {
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          var isOverlay = n.classList && (n.classList.contains("slideover-overlay") || n.classList.contains("modal-overlay"));
          if (isOverlay || (n.querySelector && n.querySelector(".slideover-overlay, .modal-overlay"))) {
            _injectPanelLockButtons();
            return;
          }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  _injectPanelLockButtons();
}
if (typeof window !== "undefined") window.initPanelLock = initPanelLock;

/**
 * Keep `tr.selected` in step with the row checkboxes under `scope` (a tbody,
 * a table, or anything containing them).
 *
 * The class is what pairs the bulk bar's count with WHICH rows it means — a
 * checkbox alone is a poor cue on a wide table where the checkbox column has
 * scrolled out of view. Call it after any wholesale tbody re-render and after
 * a select-all: assigning `.checked` in script does NOT fire a change event,
 * so the delegated listener below never sees those.
 */
function syncSelectedRows(scope) {
  var root = scope || document;
  root.querySelectorAll(".cb-col input[type=checkbox]").forEach(function (cb) {
    var tr = cb.closest("tr");
    if (tr) tr.classList.toggle("selected", cb.checked);
  });
}
if (typeof window !== "undefined") window.syncSelectedRows = syncSelectedRows;

// One delegated listener covers every list page's single-row clicks, so a page
// only has to call syncSelectedRows for the two cases this can't see.
document.addEventListener("change", function (e) {
  var cb = e.target;
  if (!cb || cb.type !== "checkbox") return;
  var cell = cb.closest && cb.closest("td.cb-col");
  if (!cell) return;
  var tr = cell.closest("tr");
  if (tr) tr.classList.toggle("selected", cb.checked);
});

/**
 * Reveal an overlay that animates in: add `.open` on the next animation frame
 * so the transition has a start state, with a timeout floor because
 * requestAnimationFrame does NOT fire in a hidden tab — a panel opened in a
 * background tab would otherwise be built and never shown, staying invisible
 * until the tab is next looked at. Idempotent: whichever fires first wins.
 *
 * `after` runs once, immediately after the class lands (focus, sizing).
 */
function revealOverlay(el, after) {
  if (!el) return;
  var opened = false;
  var reveal = function () {
    if (opened) return;
    opened = true;
    el.classList.add("open");
    if (typeof after === "function") after();
  };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 50);
}
if (typeof window !== "undefined") window.revealOverlay = revealOverlay;

// ─── Modal tabs + form parts ────────────────────────────────────────────────
//
// A tall config form stays ONE modal with tabs — never a wizard, never a new
// page. These two are the canonical pair; assets.js and integrations.js each
// grew a byte-identical private copy, and both now delegate here.
//
// tabs: [{ key, label, html }] — panel ids are `<prefix>-tab-<key>`.
//
// Keep field ids UNIQUE ACROSS TABS so one read pass collects the whole form:
// a per-tab read silently drops whatever the operator never opened.

function tabbedBodyHTML(prefix, tabs) {
  return '<div class="page-tabs" id="' + prefix + '-tabs" style="margin-bottom:1rem">' +
      tabs.map(function (t, i) {
        return '<button type="button" class="page-tab' + (i === 0 ? " active" : "") +
          '" data-tab="' + escapeHtml(t.key) + '">' + escapeHtml(t.label) + "</button>";
      }).join("") +
    "</div>" +
    tabs.map(function (t, i) {
      return '<div class="page-tab-panel' + (i === 0 ? " active" : "") +
        '" id="' + prefix + "-tab-" + escapeHtml(t.key) + '">' + t.html + "</div>";
    }).join("");
}

function wireModalTabs(prefix) {
  var tabs = document.querySelectorAll("#" + prefix + "-tabs .page-tab");
  Array.prototype.forEach.call(tabs, function (btn) {
    btn.addEventListener("click", function () {
      Array.prototype.forEach.call(tabs, function (b) { b.classList.remove("active"); });
      Array.prototype.forEach.call(
        document.querySelectorAll('[id^="' + prefix + '-tab-"]'),
        function (p) { p.classList.remove("active"); },
      );
      btn.classList.add("active");
      var panel = document.getElementById(prefix + "-tab-" + btn.getAttribute("data-tab"));
      if (panel) panel.classList.add("active");
    });
  });
}

// Form section parts. Config modals build their sections from these rather
// than hand-rolling the same markup, so they read as one design language.
//   sectionHeading("Connection Settings")  → uppercase tertiary label
//   formDivider()                          → 1px rule between groups
//   infoBox("<html>")                      → accent-tinted informational block
//   checkboxRow(id, label, checked)        → 'auto'-width box + label on a line
//   calloutHTML(variant, title, bodyHtml)  → left-accent emphasis callout

function sectionHeading(text) {
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;' +
    'color:var(--color-text-tertiary);margin-bottom:0.75rem">' + escapeHtml(text) + "</p>";
}

function formDivider() {
  return '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">';
}

// Compatibility / scope constraints stated UP FRONT — versions, on-prem vs
// cloud, what the integration will and won't reach. Bold the specific values.
function infoBox(html) {
  return '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);' +
    'border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;' +
    'color:var(--color-text-secondary);line-height:1.5">' + html + "</div>";
}

function checkboxRow(id, label, checked) {
  return '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="' + escapeHtml(id) + '"' + (checked ? " checked" : "") +
        ' style="width:auto">' +
      '<label for="' + escapeHtml(id) + '" style="margin:0">' + escapeHtml(label) + "</label>" +
    "</div>";
}

// Every highlighted note (security blast-radius warnings, tip/alternative
// boxes, permission requirements) renders through this one helper. `variant`
// selects the accent from real theme tokens (so it adapts across themes); the
// faint tint is derived from that same token via color-mix. `title` is the bold
// lead row (icon prepended automatically); `bodyHtml` is raw HTML as hint text.
var CALLOUT_VARIANTS = {
  warning: { color: "var(--color-warning)", icon: "&#9888;" },        // warning sign — security / silent-failure caveats
  tip:     { color: "var(--color-accent)", icon: "&#128161;" },       // light bulb — alternatives / suggestions
  note:    { color: "var(--color-text-secondary)", icon: "" },        // neutral informational
};
function calloutHTML(variant, title, bodyHtml) {
  var v = CALLOUT_VARIANTS[variant] || CALLOUT_VARIANTS.note;
  return '<div style="border-left:3px solid ' + v.color + ';' +
      'background:color-mix(in srgb, ' + v.color + ' 9%, transparent);' +
      'border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:0.6rem 0.8rem;margin-top:0.75rem">' +
      (title
        ? '<p style="margin:0 0 0.4rem 0;font-weight:600;color:' + v.color + '">' +
            (v.icon ? v.icon + " " : "") + title + '</p>'
        : '') +
      '<p class="hint" style="margin:0">' + bodyHtml + '</p>' +
    '</div>';
}

// ─── Integration modal (the standard shape) ─────────────────────────────────
//
// Every "connect us to another system" dialog is the SAME dialog. Polaris grew
// seven of them by hand (FortiManager, FortiGate, Active Directory, Entra ID,
// Windows Server, vCenter, Azure Arc) and they drifted: two tab
// implementations, footers in different orders, and per-type required-field
// chains copy-pasted with different rules. This is the one shape:
//
//   title    "<Action> <Product> Integration" — never a bare "Add Integration"
//            or "Edit Integration", because the operator picked a product to
//            get here and the title should confirm it.
//   body     General tab first (identity + connection), Monitoring second where
//            it exists, then feature tabs. One tab per concern; a concern with
//            three fields is a section inside General, not a tab of its own.
//   footer   Test Connection · Cancel · Create/Save Changes. Test is a
//            secondary on the LEFT: it is the rehearsal, not the commitment.
//   test     gated on the fields the request actually needs, and the toast
//            NAMES what is missing — never fire a request you know will fail
//            and report the server's error as if it were news.
//
// Saving is deliberately NEVER blocked on a passing test: an operator
// configuring ahead of a firewall change has a legitimate reason to save
// something that cannot connect yet. `onSave` receives `{ tested }` if it wants
// to act on it. Both buttons disable and relabel while in flight — these calls
// reach a remote system and can take seconds.
//
// Unlike the UI kit's version this does NOT scrape the form for you: Polaris's
// per-type config readers (_formConfigForType and the per-class block readers)
// handle nested blocks, arrays and keep-current secrets, so `onTest`/`onSave`
// read the form themselves and this owns only the shell.
//
//   openIntegrationModal({
//     product: "FortiManager", action: "Add",
//     prefix: "intg-edit",
//     tabs: [{key,label,html}, …],          // or `html` for a single-pane form
//     requires: [["f-host","host"], ["f-apiToken","API token"]],
//     onWire:  function () {…},             // per-type wiring, runs after open
//     onTest:  function () {…},             // return {ok} or throw
//     onSave:  function (ctx) {…},          // ctx.tested; throw to stay open
//   })
function openIntegrationModal(cfg) {
  var prefix = cfg.prefix || "intg";
  var action = cfg.action || "Add";
  var tabs = cfg.tabs || null;
  var body = tabs ? tabbedBodyHTML(prefix, tabs) : (cfg.html || "");
  var saveLabel = cfg.saveLabel || (action === "Edit" ? "Save Changes" : "Create");
  var busyLabel = cfg.busyLabel || (action === "Edit" ? "Saving…" : "Creating…");
  var footer =
    '<button class="btn btn-secondary" id="' + prefix + '-test">Test Connection</button>' +
    '<button class="btn btn-secondary" id="' + prefix + '-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="' + prefix + '-save">' + escapeHtml(saveLabel) + "</button>";

  openModal(action + " " + cfg.product + " Integration", body, footer, { wide: true });
  if (tabs) wireModalTabs(prefix);
  if (cfg.onWire) cfg.onWire();

  // Names the missing fields rather than saying "fill in the form": the whole
  // point of testing before saving is to find out what is wrong.
  function missingFields() {
    var missing = [];
    (cfg.requires || []).forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (el && !String(el.value || "").trim()) missing.push(pair[1] || pair[0]);
    });
    return missing;
  }

  function busy(btn, label, fn) {
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    return Promise.resolve().then(fn).catch(function (err) {
      if (err && err.name === "AbortError") showToast("Aborted", "error");
      else showToast((err && err.message) || "Request failed", "error");
    }).then(function () {
      btn.disabled = false;
      btn.textContent = original;
    });
  }

  var tested = false;
  var testBtn = document.getElementById(prefix + "-test");
  var saveBtn = document.getElementById(prefix + "-save");
  var cancelBtn = document.getElementById(prefix + "-cancel");

  if (testBtn) testBtn.addEventListener("click", function () {
    var missing = missingFields();
    if (missing.length) {
      showToast("Fill in " + missing.join(", ") + " first", "error");
      return;
    }
    if (!cfg.onTest) return;
    busy(testBtn, "Testing…", function () {
      return Promise.resolve(cfg.onTest()).then(function (result) {
        tested = !!(result && result.ok);
      });
    });
  });

  if (saveBtn) saveBtn.addEventListener("click", function () {
    if (!cfg.onSave) return;
    busy(saveBtn, busyLabel, function () {
      return Promise.resolve(cfg.onSave({ tested: tested }));
    });
  });

  // A wired listener, not an inline onclick="closeModal()" — the footer is
  // built here, so its handlers belong here too.
  if (cancelBtn) cancelBtn.addEventListener("click", function () {
    if (cfg.onCancel) cfg.onCancel();
    closeModal();
  });

  return { wasTested: function () { return tested; } };
}

function openModal(title, bodyHTML, footerHTML, options) {
  let overlay = document.getElementById("modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "modal-overlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><div class="modal-header"><h3 id="modal-title"></h3><button class="btn-icon modal-close" aria-label="Close dialog">&times;</button></div><div class="modal-body"></div><div class="modal-footer"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        // Locked → keep the dialog open (flash the X as a hint); unlocked →
        // an off-click dismisses it. See "Panel lock" above.
        if (_panelLockStore.state.modal) {
          flashModalCloseBtn(overlay.querySelector(".modal-close"));
        } else {
          closeModal();
        }
      }
    });
    overlay.querySelector(".modal-close").addEventListener("click", closeModal);
    var modalEl = overlay.querySelector(".modal");
    var headerEl = overlay.querySelector(".modal-header");
    headerEl.addEventListener("mousedown", function (e) {
      if (e.target.closest(".modal-close") || e.target.closest(".panel-lock-btn")) return;
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
  modal.classList.remove("modal-wide", "modal-large", "modal-xl");
  if (options && options.wide) modal.classList.add("modal-wide");
  if (options && options.large) modal.classList.add("modal-large");
  if (options && options.xl) modal.classList.add("modal-xl");
  overlay.querySelector(".modal-header h3").textContent = title;
  overlay.querySelector(".modal-body").innerHTML = bodyHTML;
  overlay.querySelector(".modal-footer").innerHTML = footerHTML || "";
  var slideoverOpen = !!document.querySelector(".slideover-overlay.open");
  overlay.classList.toggle("above-slideover", slideoverOpen);
  initPanelLock();
  _injectPanelLockButtons();
  // Remember what had focus so closeModal can restore it; trap Tab + Escape
  // inside the dialog while it's open.
  _modalReturnFocus = document.activeElement;
  if (_modalKeyTeardown) { _modalKeyTeardown(); }
  _modalKeyTeardown = _trapFocus(modal, closeModal);
  // rAF so the transition has a start state to animate from — but rAF does
  // NOT fire in a hidden tab, which would leave the dialog built and invisible
  // until the tab is next looked at. The timeout is the floor; `reveal` is
  // idempotent so whichever fires first wins.
  var opened = false;
  var reveal = function () {
    if (opened) return;
    opened = true;
    overlay.classList.add("open");
    _focusFirstIn(modal);
  };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 50);
}

function closeModal() {
  var overlay = document.getElementById("modal-overlay");
  if (overlay) {
    overlay.classList.remove("open");
    overlay.classList.remove("above-slideover");
  }
  if (_modalKeyTeardown) { _modalKeyTeardown(); _modalKeyTeardown = null; }
  if (_modalReturnFocus && typeof _modalReturnFocus.focus === "function") {
    try { _modalReturnFocus.focus(); } catch (_) { /* element gone */ }
  }
  _modalReturnFocus = null;
  if (_modalFlashResetTimer) clearTimeout(_modalFlashResetTimer);
  _modalFlashLevel = 0;
}

// ─── Row context menu ─────────────────────────────────────────────────────────
//
// The list pages put their per-row verbs behind the row's NAME rather than an
// Actions column of buttons: one affordance, no column competing with the data
// for horizontal space, and room to add a verb without re-cutting the layout.
//
// Why this is `position: fixed` on <body> rather than the existing
// `.btn-dropdown-menu` pattern (which is absolute inside a positioned wrapper):
// every list table scrolls inside `.table-wrapper-sticky`, so an absolutely
// positioned menu in a <td> is clipped by that overflow the moment it's taller
// than the remaining rows. Fixed + body-mounted escapes the clip; the cost is
// that the menu must close on scroll, since it can no longer follow its anchor.
//
// items: [{ label, onSelect, danger?, disabled?, title? } | { separator: true }]
var _rowMenuTeardown = null;

/** Close whatever row menu is open. Safe to call when none is. */
function closeRowMenu(opts) {
  if (_rowMenuTeardown) _rowMenuTeardown(opts || {});
}

function showRowMenu(anchor, items, opts) {
  if (!anchor || !items || !items.length) return;
  // A second click on the same anchor toggles rather than stacking menus.
  var reopening = _rowMenuTeardown && _rowMenuTeardown.anchor === anchor;
  closeRowMenu({ silent: true });
  if (reopening) return;

  var menu = document.createElement("div");
  menu.className = "btn-dropdown-menu row-context-menu open";
  menu.setAttribute("role", "menu");
  if (opts && opts.label) menu.setAttribute("aria-label", opts.label);

  var buttons = [];
  items.forEach(function (it) {
    if (!it) return;
    if (it.separator) {
      var hr = document.createElement("div");
      hr.className = "dropdown-divider";
      menu.appendChild(hr);
      return;
    }
    if (it.heading) {
      var h = document.createElement("div");
      h.className = "dropdown-heading";
      h.textContent = it.heading;
      menu.appendChild(h);
      return;
    }
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    // `icon` is developer-supplied SVG markup (ICONS / _sunIcon), never user
    // data, so innerHTML is safe here; the label stays textContent regardless.
    if (it.icon) {
      b.innerHTML = it.icon;
      var lbl = document.createElement("span");
      lbl.textContent = it.label;
      b.appendChild(lbl);
      b.className = "has-icon" + (it.danger ? " danger" : "");
    } else {
      b.textContent = it.label;
      if (it.danger) b.className = "danger";
    }
    if (it.title) b.title = it.title;
    if (it.disabled) {
      b.disabled = true;
    } else {
      b.addEventListener("click", function () {
        // Close BEFORE the handler runs: most of these open a modal or a
        // slide-over, and a lingering fixed menu would float over it.
        closeRowMenu();
        try { it.onSelect(); } catch (err) { if (typeof showToast === "function") showToast((err && err.message) || "Action failed", "error"); }
      });
      buttons.push(b);
    }
    menu.appendChild(b);
  });
  if (!buttons.length && !menu.childNodes.length) return;

  document.body.appendChild(menu);

  // Position under the anchor, flipped when it would leave the viewport.
  var r = anchor.getBoundingClientRect();
  var mw = menu.offsetWidth;
  var mh = menu.offsetHeight;
  var pad = 6;
  var top = r.bottom + 4;
  if (top + mh > window.innerHeight - pad) {
    var above = r.top - 4 - mh;
    top = above >= pad ? above : Math.max(pad, window.innerHeight - pad - mh);
  }
  // Left-aligned to the anchor by default; `align:"end"` right-aligns it, which
  // is what a trigger sitting at the right edge of the page header wants.
  var left = (opts && opts.align === "end") ? r.right - mw : r.left;
  if (left + mw > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pad - mw);
  if (left < pad) left = pad;
  menu.style.top = top + "px";
  menu.style.left = left + "px";

  // ── Dismissal + keyboard ────────────────────────────────────────────────
  function onDocPointerDown(e) {
    // `contains` on the anchor, not identity: a trigger with child elements
    // (the account badge's avatar / name / caret) would otherwise close here
    // on pointerdown and immediately re-open on the click, so a second click
    // could never dismiss it.
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeRowMenu();
  }
  function onKeyDown(e) {
    if (e.key === "Escape") { e.stopPropagation(); closeRowMenu(); return; }
    if (e.key === "Tab") { closeRowMenu(); return; }
    if (!buttons.length) return;
    var idx = buttons.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      var next = e.key === "ArrowDown"
        ? (idx < 0 ? 0 : (idx + 1) % buttons.length)
        : (idx <= 0 ? buttons.length - 1 : idx - 1);
      buttons[next].focus();
    } else if (e.key === "Home") { e.preventDefault(); buttons[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); buttons[buttons.length - 1].focus(); }
  }
  // Capture-phase scroll so a scroll inside the table wrapper closes it too —
  // the menu is fixed and cannot track its anchor. But only a scroll that
  // MOVED the anchor is a reason to close: the dashboard's NOC auto-scroll
  // creeps every overflowing widget body by a pixel every 80ms, and closing on
  // those made the account menu flash open and vanish on that page. A scroll in
  // a container that doesn't hold the anchor leaves the menu correctly placed.
  function onScroll(e) {
    var t = e && e.target;
    // Document-level scroll (target is the Document node) moves everything.
    if (!t || t.nodeType === 9 || typeof t.contains !== "function") { closeRowMenu(); return; }
    if (t.contains(anchor)) closeRowMenu();
  }
  function onScrollOrResize() { closeRowMenu(); }

  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScrollOrResize);

  _rowMenuTeardown = function (o) {
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScrollOrResize);
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    _rowMenuTeardown = null;
    if (anchor) anchor.setAttribute("aria-expanded", "false");
    // Hand focus back so keyboard users don't land at the top of the document —
    // except when another affordance is about to claim it (silent close).
    if (!(o && o.silent) && typeof anchor.focus === "function") {
      try { anchor.focus(); } catch (_) { /* row re-rendered */ }
    }
  };
  _rowMenuTeardown.anchor = anchor;

  anchor.setAttribute("aria-expanded", "true");
  if (buttons.length) buttons[0].focus();
}

if (typeof window !== "undefined") {
  window.showRowMenu = showRowMenu;
  window.closeRowMenu = closeRowMenu;
}

// ─── Stacked Overlay (a dialog above an open modal) ───────────────────────────

/**
 * Build a dismissible overlay ABOVE any open modal — the stacked-modal pattern.
 * Returns { overlay, dialog, close }; `onClose` fires for backdrop click,
 * Escape and the close button.
 *
 * Why this exists rather than calling openModal: openModal creates and then
 * REUSES one shared #modal-overlay, overwriting its .modal-body innerHTML — so
 * calling it from inside an open modal destroys that modal's form DOM and loses
 * whatever the operator had typed. Layer rungs: 1300 over a base modal, 1320
 * when a third layer must sit over the second.
 *
 * Lives here (rather than in the file that first needed it) because every
 * dependency is in app.js and app.js loads on every page: the automations code
 * editor opens from the wizard, which loads on five pages, only one of which
 * loads the address book.
 */
function buildOverlay(z, title, bodyHtml, footerHtml, onClose, wide) {
  var overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.style.zIndex = String(z);
  overlay.innerHTML =
    '<div class="modal' + (wide ? " modal-large" : " modal-wide") + '" role="dialog" aria-modal="true" tabindex="-1">' +
      '<div class="modal-header"><h3>' + escapeHtml(title) + '</h3>' +
        '<button class="btn-icon modal-close" type="button" aria-label="Close dialog">&times;</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' + footerHtml + '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  var dialog = overlay.querySelector(".modal");
  var prevFocus = document.activeElement;
  var closed = false;
  var teardownTrap = _trapFocus(dialog, function () { close(); });

  function close() {
    if (closed) return;
    closed = true;
    teardownTrap();
    overlay.classList.remove("open");
    // Remove on transition end, with a timer fallback for reduced-motion.
    overlay.addEventListener("transitionend", function () {
      if (overlay.parentNode) overlay.remove();
    }, { once: true });
    setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
    if (prevFocus && typeof prevFocus.focus === "function") { try { prevFocus.focus(); } catch (_) {} }
    if (onClose) onClose();
  }

  // Panel lock: one global switch governs EVERY modal, so these stacked
  // overlays take the same toggle app.js injects into the shared #modal-overlay
  // (its MutationObserver only looks at that one element, hence the direct
  // call) and honor it the same way — an off-click while locked flashes the X
  // + bloom instead of dismissing. Guarded so the module still works on a page
  // that somehow loads without app.js.
  var closeBtn = overlay.querySelector(".modal-close");
  if (typeof _ensureLockButton === "function") {
    _ensureLockButton(overlay.querySelector(".modal-header"), "modal");
  }
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", function (ev) {
    if (ev.target !== overlay) return;
    if (typeof isPanelLocked === "function" && isPanelLocked("modal")) {
      if (typeof flashModalCloseBtn === "function") flashModalCloseBtn(closeBtn);
      return;
    }
    close();
  });
  // See openModal: rAF alone never fires in a hidden tab.
  var opened = false;
  var reveal = function () {
    if (opened) return;
    opened = true;
    overlay.classList.add("open");
    _focusFirstIn(dialog);
  };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 50);

  return { overlay: overlay, dialog: dialog, close: close };
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────

function showConfirm(message) {
  return new Promise(function (resolve) {
    // Build a dedicated overlay rather than reusing openModal's single shared
    // #modal-overlay. openModal overwrites that element's body/footer innerHTML,
    // so calling it while another modal is open (e.g. the Edit Integration
    // auto-monitor guards) would destroy that modal's form DOM. A standalone
    // overlay at a higher z-index STACKS above any open modal, leaving its
    // markup intact so a save flow can still read the form after the confirm
    // resolves. white-space:pre-wrap preserves \n line breaks in the message.
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "1300";
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-label="Confirm" tabindex="-1">' +
        '<div class="modal-header"><h3>Confirm</h3></div>' +
        '<div class="modal-body"><p style="font-size:0.9rem;color:var(--color-text-secondary);white-space:pre-wrap"></p></div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-secondary" data-confirm="cancel">Cancel</button>' +
          '<button class="btn btn-danger" data-confirm="ok">Confirm</button>' +
        '</div>' +
      '</div>';
    overlay.querySelector(".modal-body p").textContent = message;
    document.body.appendChild(overlay);
    var dialog = overlay.querySelector(".modal");
    var prevFocus = document.activeElement;
    var teardownTrap = _trapFocus(dialog, function () { done(false); });
    function done(val) {
      teardownTrap();
      overlay.classList.remove("open");
      overlay.addEventListener("transitionend", function () {
        if (overlay.parentNode) overlay.remove();
      }, { once: true });
      // Fallback in case the transition doesn't fire (reduced-motion, etc.).
      setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
      if (prevFocus && typeof prevFocus.focus === "function") {
        try { prevFocus.focus(); } catch (_) { /* element gone */ }
      }
      resolve(val);
    }
    overlay.querySelector('[data-confirm="cancel"]').onclick = function () { done(false); };
    overlay.querySelector('[data-confirm="ok"]').onclick = function () { done(true); };
    // See openModal: rAF alone never fires in a hidden tab.
    var shown = false;
    var reveal = function () {
      if (shown) return;
      shown = true;
      overlay.classList.add("open");
      _focusFirstIn(dialog);
    };
    requestAnimationFrame(reveal);
    setTimeout(reveal, 50);
  });
}

/**
 * showConfirm's sibling for the case where the operator has to TYPE something:
 * resolves to the entered string, or `null` if they cancelled.
 *
 * `null` vs `""` is the whole contract, and callers depend on it — an empty
 * string is a deliberate "no reason given" on an optional field, while null
 * means "don't do this at all". It matches `window.prompt`'s semantics, which is
 * what this replaces: prompt() is styled by the browser, unreachable in the
 * mobile PWA, and suppressed outright by some browsers (and by Chrome in
 * cross-origin iframes), so an operator could be left unable to complete an
 * action with no visible reason why.
 *
 * opts: { title, label, placeholder, value, okLabel, danger, required,
 *         requiredMessage, multiline, maxLength, help }
 */
function showPrompt(message, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    // Standalone overlay at the same z-index as showConfirm, for the same
    // reason: it must stack over an open modal without destroying its DOM.
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "1300";
    var title = opts.title || "Enter a value";
    var field = opts.multiline
      ? '<textarea id="prompt-input" rows="3" style="width:100%;resize:vertical"></textarea>'
      : '<input type="text" id="prompt-input" style="width:100%">';
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" tabindex="-1">' +
        '<div class="modal-header"><h3></h3></div>' +
        '<div class="modal-body">' +
          '<p class="prompt-message" style="font-size:0.9rem;color:var(--color-text-secondary);white-space:pre-wrap;margin:0 0 0.75rem"></p>' +
          '<div class="form-group" style="margin-bottom:0">' +
            '<label for="prompt-input" class="prompt-label"></label>' +
            field +
            '<p class="hint prompt-help" style="margin:0.35rem 0 0;display:none"></p>' +
            '<p class="prompt-error" style="margin:0.35rem 0 0;font-size:0.82rem;color:var(--color-danger);display:none"></p>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-secondary" data-prompt="cancel">Cancel</button>' +
          '<button class="btn" data-prompt="ok"></button>' +
        '</div>' +
      '</div>';

    var dialog = overlay.querySelector(".modal");
    dialog.setAttribute("aria-label", title);
    dialog.querySelector(".modal-header h3").textContent = title;
    // textContent throughout: every one of these is caller-supplied copy, and
    // some callers interpolate a hostname straight from discovery.
    var msgEl = overlay.querySelector(".prompt-message");
    if (message) msgEl.textContent = message; else msgEl.style.display = "none";
    var labelEl = overlay.querySelector(".prompt-label");
    if (opts.label) labelEl.textContent = opts.label; else labelEl.style.display = "none";
    if (opts.help) {
      var helpEl = overlay.querySelector(".prompt-help");
      helpEl.textContent = opts.help;
      helpEl.style.display = "";
    }
    var input = overlay.querySelector("#prompt-input");
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.value) input.value = opts.value;
    if (opts.maxLength) input.maxLength = opts.maxLength;
    var okBtn = overlay.querySelector('[data-prompt="ok"]');
    okBtn.textContent = opts.okLabel || "OK";
    okBtn.classList.add(opts.danger ? "btn-danger" : "btn-primary");

    document.body.appendChild(overlay);
    var prevFocus = document.activeElement;
    // Escape / backdrop resolve null — cancelling must never read as "".
    var teardownTrap = _trapFocus(dialog, function () { done(null); });

    function done(val) {
      teardownTrap();
      overlay.classList.remove("open");
      overlay.addEventListener("transitionend", function () {
        if (overlay.parentNode) overlay.remove();
      }, { once: true });
      setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
      if (prevFocus && typeof prevFocus.focus === "function") {
        try { prevFocus.focus(); } catch (_) { /* element gone */ }
      }
      resolve(val);
    }

    var errEl = overlay.querySelector(".prompt-error");
    function submit() {
      var v = input.value.trim();
      if (opts.required && !v) {
        // Don't resolve — an empty required field is a correction, not a cancel.
        // Say so: a red border alone reads as a button that did nothing, which
        // is exactly how "I clicked Acknowledge and nothing happened" starts.
        input.focus();
        input.classList.add("input-error");
        errEl.textContent = opts.requiredMessage || "This can't be left blank.";
        errEl.style.display = "";
        return;
      }
      done(v);
    }

    overlay.querySelector('[data-prompt="cancel"]').onclick = function () { done(null); };
    okBtn.onclick = submit;
    input.addEventListener("input", function () {
      input.classList.remove("input-error");
      errEl.style.display = "none";
    });
    // Enter submits a single-line field; a textarea keeps Enter for newlines.
    if (!opts.multiline) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
    }

    // See openModal: rAF alone never fires in a hidden tab.
    var shown = false;
    var reveal = function () {
      if (shown) return;
      shown = true;
      overlay.classList.add("open");
      try { input.focus(); } catch (_) { _focusFirstIn(dialog); }
    };
    requestAnimationFrame(reveal);
    setTimeout(reveal, 50);
  });
}
if (typeof window !== "undefined") window.showPrompt = showPrompt;

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
 * Bound every .table-wrapper-sticky on the page to the viewport so vertical
 * scrolling happens INSIDE the wrapper: the sticky thead (styles.css) pins to
 * its top edge, and everything above — bulk bar, top pagination — stays put
 * because the page itself no longer needs to scroll. The reserve leaves room
 * for the bottom pagination row below the wrapper. max-height (not height) so
 * short result sets keep a short table. Called from renderPageControls /
 * clearPageControls (so it re-measures after every list render — the empty
 * top pagination row grows when controls first appear, shifting the wrapper's
 * document-space top) and on window resize; pages with their own pagination
 * renderer (Events) call it directly. No-op on pages without the class.
 */
function sizeStickyTableWrappers() {
  document.querySelectorAll(".table-wrapper-sticky").forEach(function (w) {
    var docTop = w.getBoundingClientRect().top + window.scrollY;
    var h = window.innerHeight - docTop - 72;
    w.style.maxHeight = Math.max(260, Math.round(h)) + "px";
  });
}
window.addEventListener("resize", sizeStickyTableWrappers);

/**
 * Clear both the bottom and optional top pagination containers.
 */
function clearPageControls(containerId) {
  var mainEl = document.getElementById(containerId);
  if (mainEl) mainEl.innerHTML = "";
  var topEl = document.getElementById(containerId + "-top");
  if (topEl) topEl.innerHTML = "";
  sizeStickyTableWrappers();
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

  var navHtml =
    '<button class="btn btn-secondary btn-sm pg-prev" ' + (currentPage <= 1 ? 'disabled' : '') + '>&laquo; Prev</button>' +
    pageButtons +
    '<button class="btn btn-secondary btn-sm pg-next" ' + (currentPage >= totalPages ? 'disabled' : '') + '>Next &raquo;</button>' +
    // nowrap: at narrow widths this label would otherwise break between the
    // number and the word, which reads as two separate facts.
    '<span style="font-size:0.82rem;color:var(--color-text-tertiary);margin-left:8px;white-space:nowrap">' + total + ' items</span>';

  // Standard list-controls row: a 3-column grid keeps the page navigation
  // centered across the full width regardless of the right cluster's size.
  // Left cell empty, center = pagination, right cell = action buttons + the
  // page-size ("Show N") selector (rendered when onSizeChange is supplied).
  // Replaces the older absolute-positioned action-button cluster. Documented
  // in UI-CANON.md → "Paginated list controls row".
  var pageSizes = (opts && opts.pageSizes) || [15, 25, 50, 100];
  var hasTop = !!topEl; // render the size selector only once (top row when present)

  containers.forEach(function (container) {
    container.style.display = "grid";
    // Breathing room against the table: the top row sits above the wrapper and
    // the bottom row below it, and flush against the border both read as table
    // chrome rather than as controls FOR the table.
    container.style.margin = (container === topEl) ? "0 0 10px" : "10px 0 0";
    // minmax(0,1fr) rather than 1fr: a 1fr track refuses to shrink below its
    // content, so on a narrow table the side columns push into the centered
    // nav instead of letting it wrap.
    container.style.gridTemplateColumns = "minmax(0,1fr) auto minmax(0,1fr)";
    container.style.alignItems = "center";
    container.style.gap = "12px";
    container.style.position = "";
    container.innerHTML =
      '<span></span>' +
      '<div class="pg-center" style="display:flex;align-items:center;gap:12px;justify-content:center;flex-wrap:wrap">' + navHtml + '</div>' +
      '<div class="pg-right" style="display:flex;align-items:center;gap:6px;justify-self:end;flex-wrap:wrap;justify-content:flex-end"></div>';

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

    var right = container.querySelector('.pg-right');
    if (opts && opts.actionButtons && opts.actionButtons.length) {
      opts.actionButtons.forEach(function (cfg) {
        var btn = document.createElement("button");
        btn.className = "btn btn-secondary btn-sm" + (cfg.className ? " " + cfg.className : "");
        btn.textContent = cfg.label;
        // Optional: a button whose label changes with context (Assets' Clear
        // Filters / Reset Filter) says which one it is here.
        if (cfg.title) btn.title = cfg.title;
        btn.addEventListener("click", cfg.onClick);
        right.appendChild(btn);
      });
    }
    if (typeof onSizeChange === "function" && (!hasTop || container === topEl)) {
      var lbl = document.createElement("label");
      lbl.style.cssText = "display:flex;align-items:center;gap:6px;margin:0;font-size:0.82rem;color:var(--color-text-tertiary);text-transform:uppercase;letter-spacing:0.04em";
      lbl.appendChild(document.createTextNode("Show"));
      var sel = document.createElement("select");
      sel.style.width = "auto";
      pageSizes.forEach(function (s) {
        var o = document.createElement("option");
        o.value = String(s); o.textContent = String(s);
        if (s === pageSize) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () { onSizeChange(parseInt(sel.value, 10) || pageSize); });
      lbl.appendChild(sel);
      right.appendChild(lbl);
    }
  });
  sizeStickyTableWrappers();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// escapeHtml is the canonical global from api.js (loaded first on every page).

function formatDate(dateStr) {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Compact device-uptime duration: "42d 6h" / "6h 12m" / "12m" / "<1m".
// Shows the two most-significant non-zero units. Mirror of the server-side
// formatUptime in src/utils/uptime.ts. Returns "—" for null/invalid input.
function formatUptime(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return "—";
  var s = Math.floor(seconds);
  if (s < 60) return "<1m";
  var days = Math.floor(s / 86400);
  var hours = Math.floor((s % 86400) / 3600);
  var mins = Math.floor((s % 3600) / 60);
  if (days > 0) return hours > 0 ? days + "d " + hours + "h" : days + "d";
  if (hours > 0) return mins > 0 ? hours + "h " + mins + "m" : hours + "h";
  return mins + "m";
}

function statusBadge(status) {
  return '<span class="badge badge-' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>';
}

// Trimmed value of an input by id — THE copy (was five identical top-level
// copies across page scripts, shadowing each other on co-loaded pages).
function val(id) { return document.getElementById(id).value.trim(); }

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

// region: tags are editable like any other tag (2026-08). They used to be a
// hidden "protected prefix" the picker filtered out and force-preserved on
// save, because the add-only reconciler couldn't tell a hand-applied tag from
// its own — but mapRegionService now records provenance (RegionTagAssignment),
// so a tag added here is operator-owned and never auto-stripped, and removing
// an auto-applied one on an in-region device just re-adds it next reconcile.
// The Map Regions category carries a hint saying exactly that.
var REGION_TAG_CATEGORY = "Map Regions";

// Inline style for one tag chip. Selected/unselected must be tellable apart at
// a glance for ANY tag color, so the distinction rides three channels — an
// unselected chip dims its border and text as well as its background. Background
// alpha alone (the old 44-vs-11 split) left every chip's full-strength border +
// text looking equally "on" in a dark theme.
function _tagChipStyle(color, checked) {
  if (!color) return '';
  var c = escapeHtml(color);
  return checked
    ? 'background:' + c + '44;border-color:' + c + ';color:' + c
    : 'background:' + c + '11;border-color:' + c + '40;color:' + c + '99';
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
        var colorStyle = _tagChipStyle(t.color, checked);
        html += '<label class="tag-picker-chip' + (checked ? ' selected' : '') + '" style="' + colorStyle + '">' +
          '<input type="checkbox" name="f-tags-cb" value="' + escapeHtml(t.name) + '"' + (checked ? ' checked' : '') + '>' +
          escapeHtml(t.name) +
        '</label>';
      });
      if (cat === REGION_TAG_CATEGORY) {
        // These are also written by the Device Map region reconciler; say what
        // an edit here actually does so a re-appearing tag isn't a mystery.
        html += '<p class="hint" style="flex-basis:100%;margin:2px 0 0">' +
          'Region tags are auto-applied to devices inside a Device Map region — removing one from a device still in the region re-adds it on the next reconcile. A tag you add here yourself is never auto-removed.' +
        '</p>';
      }
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
    var visibleSelected = selected;
    if (visibleSelected.length === 0) {
      return '<div class="form-group"><label>Tags</label><p style="color:var(--color-text-tertiary);margin:0">—</p></div>';
    }
    var tagsByName = {};
    _tagCache.tags.forEach(function (t) { tagsByName[t.name] = t; });
    var chips = visibleSelected.map(function (name) {
      var t = tagsByName[name];
      var style = _tagChipStyle(t && t.color ? t.color : '', true);
      return '<span class="tag-picker-chip selected" style="' + style + '">' + escapeHtml(name) + '</span>';
    }).join('');
    return '<div class="form-group"><label>Tags</label><div class="tag-picker" style="pointer-events:none">' + chips + '</div></div>';
  }

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
      '<button type="button" class="btn btn-sm btn-primary" id="f-tag-add-btn">+ Add Tag</button>' +
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
        label.style.cssText = _tagChipStyle(tag.color, cb.checked);
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
  // Separate from data-manage-assets: quarantine is its own function key, so a
  // control that pushes a MAC block must not ride the asset-editing gate.
  document.querySelectorAll("[data-quarantine-assets]").forEach(function (el) {
    if (!canQuarantineAssets()) el.style.display = "none";
  });
  document.querySelectorAll("[data-maintenance-mgmt]").forEach(function (el) {
    if (!canManageMaintenance()) el.style.display = "none";
  });
  document.querySelectorAll("[data-review-conflicts]").forEach(function (el) {
    if (!canReviewConflicts()) el.style.display = "none";
  });
  // Generic multi-key gate: `data-perm-any="assets:write,networkScan:read"`
  // hides the element unless AT LEAST ONE pair holds — the element-level twin
  // of the sidebar's `anyPerm` (see NAV_ITEMS). The single-key attributes
  // above stay as they are: each names one capability. This one exists for a
  // control that fronts two SEPARATELY gated things and so can't be expressed
  // by any of them — the Assets page's "+ Add Asset(s)" menu, whose two rows
  // are an asset form (`assets`) and a network Discovery (`networkScan`).
  document.querySelectorAll("[data-perm-any]").forEach(function (el) {
    var ok = (el.getAttribute("data-perm-any") || "").split(",").some(function (spec) {
      var parts = spec.trim().split(":");
      return parts.length === 2 && permAtLeast(parts[0].trim(), parts[1].trim());
    });
    if (!ok) el.style.display = "none";
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
// watch reasons (pg_tuning_needed, db_io_pressure, db_pool_undersized, …)
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
      currentUserRoleColor = cachedUser.roleColor || null;
      currentUsername = cachedUser.username;
      currentRolePermissions = cachedUser.permissions || {};
      currentEffectiveRegions = Array.isArray(cachedUser.regions) ? cachedUser.regions : [];
      roleBeforeFetch = cachedUser.role;
      permsBeforeFetch = JSON.stringify(currentRolePermissions);
      renderNav();
      hideAdminOnlyElements();
    }
  } catch (_) {}

  // Wires the observer + backdrop guard and loads the preference under whatever
  // username the cache gave us (possibly none).
  initPanelLock({ user: currentUsername });

  await fetchCurrentUser();

  // Re-key to the authoritative username, reload and re-sync the buttons. This
  // is why initPanelLock has to be idempotent rather than run-once.
  initPanelLock({ user: currentUsername });

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
