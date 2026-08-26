/**
 * polaris-ui.js — portable UI runtime lifted out of Polaris's public/js/app.js.
 *
 * Contains ONLY the app-agnostic pieces: theme, sidebar shell, modal, confirm,
 * toast, pagination row, sticky-table sizing, slide-over resize, formatters.
 * Everything Polaris-specific (permissions, discovery status, capacity advisor,
 * tag picker, global search) was deliberately left behind.
 *
 * Load order on every page:
 *   <script src="/js/theme-init.js"></script>   (in <head>, before CSS)
 *   <script src="/js/polaris-ui.js"></script>
 *   <script src="/js/table-sf.js"></script>
 *   <script src="/js/<your-page>.js"></script>
 */

/* ─── Theme ─────────────────────────────────────────────────────────────── */

/* Three themes, two families: `nightfall` is dark, `morning`/`noon` share the
 * daylight overrides in the CSS. Listed in day order (morning → noon →
 * nightfall), which is how the picker reads them.
 * Adding a theme = one entry here + one token block in the CSS. */
var THEMES = [
  { id: "morning",   label: "Morning",   family: "light", icon: sunriseIcon },
  { id: "noon",      label: "Noon",      family: "light", icon: sunIcon },
  { id: "nightfall", label: "Nightfall", family: "dark",  icon: starIcon }
];
/* The fallback for an unknown or retired saved value (the `dark`/`light` this
 * list used to carry) — deliberately NOT THEMES[0], so display order and the
 * default can move independently. */
var DEFAULT_THEME = "nightfall";

function getTheme(id) {
  for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
  for (var k = 0; k < THEMES.length; k++) if (THEMES[k].id === DEFAULT_THEME) return THEMES[k];
  return THEMES[0];
}

function getCurrentTheme() {
  return document.documentElement.getAttribute("data-theme") || DEFAULT_THEME;
}

/* True for the daylight family — use this instead of `=== "light"` anywhere a
 * page picks an asset or chart palette by brightness. */
function isLightTheme(id) {
  return getTheme(id || getCurrentTheme()).family === "light";
}

function setTheme(theme) {
  var t = getTheme(theme);
  document.documentElement.setAttribute("data-theme", t.id);
  try { localStorage.setItem("polaris-theme", t.id); } catch (e) {}
  var btn = document.getElementById("btn-theme-toggle");
  if (btn) {
    var svg = btn.querySelector("svg");
    if (svg) svg.outerHTML = t.icon();
    var lbl = btn.querySelector("span");
    if (lbl) lbl.textContent = t.label;
  }
  document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: t.id, family: t.family } }));
}

/* The footer control opens the full list rather than flipping between two
 * themes — with five of them a toggle would make the other four reachable only
 * by cycling past the ones you don't want. */
function openThemeMenu(anchor) {
  var current = getCurrentTheme();
  showRowMenu(anchor, THEMES.map(function (t) {
    return {
      label: t.label + (t.id === current ? "  \u2713" : ""),
      icon: t.icon(),
      onSelect: function () { setTheme(t.id); }
    };
  }), { label: "Theme" });
}

/* Kept for callers that predate the theme list: steps to the next theme. */
function toggleTheme() {
  var i = THEMES.indexOf(getTheme(getCurrentTheme()));
  setTheme(THEMES[(i + 1) % THEMES.length].id);
}

/* Fallback boot for pages that skip theme-init.js. Must follow THEMES. */
(function () {
  var saved = null;
  try { saved = localStorage.getItem("polaris-theme"); } catch (e) {}
  document.documentElement.setAttribute("data-theme", getTheme(saved).id);
})();

/* The engraved sun-face from the clockface the daylight themes are drawn from,
 * reduced to what survives at 16px: a ring of alternating rays, and a face of
 * two eyes, one nose stroke and a smile. Thinner strokes than the other icons
 * on purpose — at 2px the face fills in and reads as a blob. */
function sunFaceIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><g stroke-width="1.1"><line x1="12.00" y1="5.40" x2="12.00" y2="0.70"/><line x1="14.53" y1="5.90" x2="15.67" y2="3.13"/><line x1="16.67" y1="7.33" x2="19.99" y2="4.01"/><line x1="18.10" y1="9.47" x2="20.87" y2="8.33"/><line x1="18.60" y1="12.00" x2="23.30" y2="12.00"/><line x1="18.10" y1="14.53" x2="20.87" y2="15.67"/><line x1="16.67" y1="16.67" x2="19.99" y2="19.99"/><line x1="14.53" y1="18.10" x2="15.67" y2="20.87"/><line x1="12.00" y1="18.60" x2="12.00" y2="23.30"/><line x1="9.47" y1="18.10" x2="8.33" y2="20.87"/><line x1="7.33" y1="16.67" x2="4.01" y2="19.99"/><line x1="5.90" y1="14.53" x2="3.13" y2="15.67"/><line x1="5.40" y1="12.00" x2="0.70" y2="12.00"/><line x1="5.90" y1="9.47" x2="3.13" y2="8.33"/><line x1="7.33" y1="7.33" x2="4.01" y2="4.01"/><line x1="9.47" y1="5.90" x2="8.33" y2="3.13"/></g><circle cx="12" cy="12" r="5.3"/><circle cx="10.2" cy="10.9" r="0.5" fill="currentColor" stroke="none"/><circle cx="13.8" cy="10.9" r="0.5" fill="currentColor" stroke="none"/><path d="M10 13.6c.55.7 1.2 1.05 2 1.05s1.45-.35 2-1.05" stroke-width="1.1"/></svg>';
}

function sunIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
}

function sunriseIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 18a5 5 0 00-10 0"/><line x1="12" y1="2" x2="12" y2="9"/><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"/><line x1="1" y1="18" x2="3" y2="18"/><line x1="21" y1="18" x2="23" y2="18"/><line x1="18.36" y1="11.64" x2="19.78" y2="10.22"/><line x1="23" y1="22" x2="1" y2="22"/><polyline points="8 6 12 2 16 6"/></svg>';
}

/* Nightfall: a plain filled crescent, sized to the same ink box as the nav
 * icons. Solid rather than stroked — a thin outlined crescent loses its taper
 * at 15px. */
function starIcon() {
  return '<svg viewBox="0 0 24 24" fill="none"><mask id="pk-moon"><circle cx="12" cy="12" r="9" fill="#fff"/><circle cx="18" cy="10" r="9" fill="#000"/></mask><circle cx="12" cy="12" r="9" fill="currentColor" mask="url(#pk-moon)"/></svg>';
}

function moonIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
}

/* ─── escapeHtml (canonical — never re-declare locally) ─────────────────── */

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ─── Sidebar shell ─────────────────────────────────────────────────────────
 * Logo is CENTERED in the brand block: .sidebar-brand is text-align:center and
 * .sidebar-logo is `margin: 0 auto 6px; max-width: 70px; width: 100%`. Never
 * left-align it, never hardcode a pixel width on the <img>.
 *
 * renderSidebar({
 *   logo: "/logo.png", product: "Polaris", tagline: "Network Ops",
 *   items:       [{ href: "/assets.html", label: "Assets", icon: "<svg …>" }],
 *   bottomItems: [{ href: "/users.html", label: "Users",  icon: "<svg …>" },
 *                 { href: "/logout",     label: "Log Out", icon: "<svg …>",
 *                   className: "sidebar-bottom-link-logout" }],
 *   themeToggle: true
 * })
 */
function renderSidebar(cfg) {
  var el = document.getElementById("sidebar");
  if (!el) return;
  var here = location.pathname.split("/").pop() || "index.html";
  var isActive = function (href) {
    return (href || "").split("/").pop() === here;
  };

  // With no cfg.logo, fall back to the shipped theme-aware art rather than
  // nothing — and let watchBrandLogo below swap it on a theme change.
  var usingBrandArt = !cfg.logo;
  var logoSrc = cfg.logo || brandLogoSrc("sidebar");

  var html =
    '<div class="sidebar-brand">' +
      '<img class="sidebar-logo' + (usingBrandArt ? " brand-mark brand-mark-sidebar" : "") +
        '" src="' + escapeHtml(logoSrc) + '" alt="' + escapeHtml(usingBrandArt ? "Polaris" : (cfg.product || "")) + '">' +
      (cfg.tagline ? "<p>" + escapeHtml(cfg.tagline) + "</p>" : "") +
    "</div>" +
    '<ul class="sidebar-nav">' +
      (cfg.items || []).map(function (i) {
        return '<li><a href="' + escapeHtml(i.href) + '"' +
          (isActive(i.href) ? ' class="active"' : "") + ">" +
          (i.icon || "") + "<span>" + escapeHtml(i.label) + "</span></a></li>";
      }).join("") +
    "</ul>" +
    '<div style="margin-top:auto">' +
      /* Status panels stack directly above the footer links, newest concern on
         top. Each is a .query-status block, hidden until it has content. */
      '<div id="query-status" class="query-status" style="display:none"></div>' +
      '<div style="padding:0.5rem;display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--color-border-light)">' +
        (cfg.bottomItems || []).map(function (i) {
          return '<a href="' + escapeHtml(i.href) + '" class="sidebar-bottom-link' +
            (i.className ? " " + i.className : "") + (isActive(i.href) ? " active" : "") + '">' +
            (i.icon || "") + "<span>" + escapeHtml(i.label) + "</span></a>";
        }).join("") +
        (cfg.themeToggle === false ? "" :
          '<button class="theme-toggle" id="btn-theme-toggle" aria-haspopup="menu" aria-expanded="false">' +
            getTheme(getCurrentTheme()).icon() +
            "<span>" + getTheme(getCurrentTheme()).label + "</span>" +
          "</button>") +
        (cfg.onLogout || cfg.logoutHref ?
          '<a href="' + escapeHtml(cfg.logoutHref || "#") + '" id="btn-logout" ' +
            'class="sidebar-bottom-link sidebar-bottom-link-logout">' +
            (cfg.logoutIcon || _logoutSvg) + "<span>Logout</span></a>" : "") +
      "</div>" +
      '<div id="sidebar-version" style="padding:0 0.75rem 0.75rem;text-align:center;' +
        'font-size:0.7rem;color:var(--color-text-tertiary);letter-spacing:0.02em">' +
        (cfg.version ? "v" + escapeHtml(cfg.version) : "") +
      "</div>" +
    "</div>";

  el.innerHTML = html;
  var tt = document.getElementById("btn-theme-toggle");
  if (tt) tt.addEventListener("click", function () { openThemeMenu(tt); });
  var lo = document.getElementById("btn-logout");
  if (lo && cfg.onLogout) {
    lo.addEventListener("click", function (e) { e.preventDefault(); cfg.onLogout(); });
  }
  if (usingBrandArt) watchBrandLogo(el.querySelector(".sidebar-logo"), "sidebar");
  if (cfg.updateAvailable) setSidebarUpdate(cfg.updateAvailable, cfg.updateHref);
}

var _logoutSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';

/* Update-available line under the version. Pass a falsy version to clear it.
 * setSidebarUpdate("0.9.1870", "/server-settings.html?tab=database") */
function setSidebarUpdate(latestVersion, href) {
  var versionEl = document.getElementById("sidebar-version");
  if (!versionEl) return;
  var existing = document.getElementById("sidebar-update-badge");
  if (existing) existing.remove();
  if (!latestVersion) return;
  var badge = document.createElement("div");
  badge.id = "sidebar-update-badge";
  badge.innerHTML =
    '<a href="' + escapeHtml(href || "#") + '" class="sidebar-update-link">' +
      '<span class="sidebar-update-dot"></span>' +
      "Update available: v" + escapeHtml(latestVersion) +
    "</a>";
  versionEl.parentNode.insertBefore(badge, versionEl.nextSibling);
}

/* ─── Sidebar status panel ──────────────────────────────────────────────────
 * The live-operation panel above the footer links: a spinner + count label,
 * an optional abort button, and a truncating list of in-flight items. Hidden
 * automatically when items is empty.
 *
 * renderStatusPanel({
 *   id: "query-status",                       // defaults to "query-status"
 *   label: "1 discovery running",
 *   subtitle: "Discovering PLVCORFMG1",       // optional accent line
 *   progress: "93/200 complete · 2 skipped",
 *   items: ["HICKMAN-61F-1", "HILLSBORO-61F-1"],
 *   onAbort: function () {}                   // renders the red ✕ when given
 * })
 */
function renderStatusPanel(cfg) {
  var el = document.getElementById((cfg && cfg.id) || "query-status");
  if (!el) return;
  var items = (cfg && cfg.items) || [];
  if (!cfg || (!cfg.label && !items.length)) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "block";
  el.innerHTML =
    '<div class="query-status-header">' +
      '<span class="query-spinner"></span>' +
      '<span class="query-status-label">' + escapeHtml(cfg.label || "") + "</span>" +
    "</div>" +
    '<ul class="query-status-list">' +
      '<li><div style="min-width:0;flex:1">' +
        (cfg.subtitle ? '<span class="query-status-name">' + escapeHtml(cfg.subtitle) + "</span>" : "") +
        (cfg.progress ? '<span class="query-status-progress">' + escapeHtml(cfg.progress) + "</span>" : "") +
        items.map(function (t) {
          return '<span class="query-status-device">' + escapeHtml(t) + "</span>";
        }).join("") +
      "</div>" +
      (cfg.onAbort ? '<button class="query-abort-btn" data-abort="1" title="Abort">&#x2715;</button>' : "") +
      "</li>" +
    "</ul>";
  if (cfg.onAbort) {
    var btn = el.querySelector('[data-abort="1"]');
    if (btn) btn.addEventListener("click", function () { cfg.onAbort(); });
  }
}

/* ─── User badge (top-right of .page-header) ────────────────────────────────
 * Always the LAST child of .page-header-actions, right of the primary button,
 * separated by its own left border. Avatar initials get a deterministic color
 * from the username so the same person is the same color on every page.
 *
 * renderUserBadge({ username: "david.moore", role: "Admin", roleColor: "#ff1744" })
 */
var _AVATAR_COLORS = ["#f5a623", "#4fc3f7", "#7c4dff", "#26a69a", "#ec407a", "#66bb6a", "#ff7043", "#5c6bc0"];

function userInitials(name) {
  var parts = String(name || "").split(/[.\s_-]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function initialsColor(name) {
  var h = 0, s = String(name || "");
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  return _AVATAR_COLORS[h % _AVATAR_COLORS.length];
}

function renderUserBadge(cfg) {
  if (!cfg || !cfg.username) return;
  var header = document.querySelector(".page-header-actions");
  if (!header) {
    var ph = document.querySelector(".page-header");
    if (!ph) return;
    header = document.createElement("div");
    header.className = "page-header-actions";
    ph.appendChild(header);
  }
  // Idempotent — renderUserBadge may run twice (cached user, then server user).
  var old = header.querySelectorAll(".user-badge");
  for (var i = 0; i < old.length; i++) old[i].remove();

  var color = cfg.avatarColor || initialsColor(cfg.username);
  var badge = document.createElement("div");
  badge.className = "user-badge";
  badge.title = cfg.username + (cfg.role ? " (" + cfg.role + ")" : "");
  badge.innerHTML =
    '<div class="user-badge-avatar" style="background:' + color + '">' +
      escapeHtml(userInitials(cfg.username)) + "</div>" +
    '<span class="user-badge-name">' + escapeHtml(cfg.username) + "</span>" +
    (cfg.role ? '<span class="badge" style="font-size:0.7rem;padding:1px 6px' +
      (cfg.roleColor ? ";color:" + cfg.roleColor + ";background:" + cfg.roleColor + "22;border-color:" + cfg.roleColor + "55" : "") +
      '">' + escapeHtml(cfg.role) + "</span>" : "");
  header.appendChild(badge);
}

/* ─── Toast ─────────────────────────────────────────────────────────────── */

var _copySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
var _checkSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function getToastContainer() {
  var c = document.getElementById("toast-container");
  if (!c) {
    c = document.createElement("div");
    c.id = "toast-container";
    c.className = "toast-container";
    document.body.appendChild(c);
  }
  return c;
}

/** showToast(message, "success" | "error") */
function showToast(message, type) {
  var el = document.createElement("div");
  el.className = "toast toast-" + (type || "success");

  var text = document.createElement("span");
  text.textContent = message;

  var btn = document.createElement("button");
  btn.className = "toast-copy-btn";
  btn.title = "Copy";
  btn.innerHTML = _copySvg;
  btn.addEventListener("click", function () {
    navigator.clipboard.writeText(message).then(function () {
      btn.innerHTML = _checkSvg;
      setTimeout(function () { btn.innerHTML = _copySvg; }, 1500);
    });
  });

  el.appendChild(text);
  el.appendChild(btn);
  getToastContainer().appendChild(el);
  setTimeout(function () {
    el.style.transition = "opacity 0.3s";
    el.style.opacity = "0";
    setTimeout(function () { el.remove(); }, 300);
  }, 3500);
}

/* ─── Focus management (shared by modal + confirm) ──────────────────────── */

function _focusableIn(container) {
  return Array.prototype.filter.call(
    container.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    ),
    function (el) { return el.offsetParent !== null; }
  );
}

function _focusFirstIn(container) {
  var f = _focusableIn(container);
  (f[0] || container).focus();
}

function _trapFocus(container, onEscape) {
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); onEscape && onEscape(); return; }
    if (e.key !== "Tab") return;
    var f = _focusableIn(container);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", onKey, true);
  return function () { document.removeEventListener("keydown", onKey, true); };
}

/* ─── Modal ─────────────────────────────────────────────────────────────────
 * Single shared #modal-overlay, reused across opens. Header is the drag handle.
 * Backdrop click FLASHES the close button instead of dismissing (protects
 * in-progress edits). Escape closes, Tab is trapped, focus is restored.
 * Width: default 480px · {wide:true} 672 · {large:true} ≤1200 · {xl:true} ≤1360
 * (xl zeroes body padding for full-bleed content).
 */

var _modalDrag = { active: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
var _modalReturnFocus = null;
var _modalKeyTeardown = null;

/* ─── Off-click hint: escalating flash + bloom ───────────────────────────────
 * A backdrop click never dismisses a modal or a locked slide-over — edits in
 * progress are worth more than the convenience of an off-click. Instead the
 * close button answers: each successive off-click flashes it brighter, with a
 * radial bloom that grows in quarter-size steps, so the escalation itself
 * points at the way out. A 1s pause resets to the start.
 *
 * Shared by every overlay (openModal and each slide-over), keyed off whichever
 * close button is passed in.
 */
var _modalFlashLevel = 0;
var _modalFlashResetTimer = null;

function flashModalCloseBtn(closeBtn) {
  if (!closeBtn) return;
  var lvl = (_modalFlashLevel = Math.min(_modalFlashLevel + 1, 8));
  if (_modalFlashResetTimer) clearTimeout(_modalFlashResetTimer);
  _modalFlashResetTimer = setTimeout(function () { _modalFlashLevel = 0; }, 1000);
  // Timing is driven inline, matched to the bloom's 0.45s ease-out, so the X
  // glow and the bloom fade together. Inline also means it applies to both the
  // modal .modal-close and a slide-over .btn-icon, and survives the class
  // removal below — otherwise the fade-OUT would snap back on .modal-close's
  // base 0.15s transition.
  closeBtn.style.transition =
    "color 0.45s ease-out, background 0.45s ease-out, transform 0.45s ease-out," +
    "filter 0.45s ease-out, text-shadow 0.45s ease-out";
  closeBtn.style.background = "rgba(255,77,109," + Math.min(0.25 + lvl * 0.09, 0.95) + ")";
  closeBtn.style.filter = "brightness(" + (1 + lvl * 0.18) + ")";
  closeBtn.style.textShadow = "0 0 " + (lvl * 3) + "px rgba(255,77,109,0.9)";
  closeBtn.classList.add("flash");
  // One shared bloom element on <body>: fixed + very high z-index so it paints
  // over any overlay and spills past the button corner unclipped. Styles are
  // inline rather than a CSS class so a stale cached stylesheet cannot render
  // the hint invisible.
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
  // fullscreen (else body) so the hint still shows there.
  var bloomHost = document.fullscreenElement || document.body;
  if (bloom.parentNode !== bloomHost) bloomHost.appendChild(bloom);
  // No bloom on the FIRST off-click — one stray click is an accident, not a
  // misunderstanding. From the 2nd it starts at a quarter size and reaches
  // full by the 5th.
  var steps = Math.min(lvl - 1, 4);
  if (steps <= 0) {
    bloom.style.opacity = "0";
  } else {
    var r = closeBtn.getBoundingClientRect();
    var size = 280 * steps / 4;            // 70px → 280px
    bloom.style.left = (r.left + r.width / 2) + "px";
    bloom.style.top = (r.top + r.height / 2) + "px";
    bloom.style.width = size + "px";
    bloom.style.height = size + "px";
    bloom.style.opacity = String(0.35 + steps * 0.15);   // 0.5 → 0.95
  }
  setTimeout(function () {
    closeBtn.classList.remove("flash");
    closeBtn.style.background = "";
    closeBtn.style.filter = "";
    closeBtn.style.textShadow = "";
    bloom.style.opacity = "0";
    // Let the 0.45s fade-out finish, then drop the inline transition so normal
    // hover snaps back to the base timing.
    setTimeout(function () { closeBtn.style.transition = ""; }, 460);
  }, 600);
}

/* ─── Panel lock ─────────────────────────────────────────────────────────────
 * A lock toggle beside the X on every modal and slide-over. Locking is global
 * PER TYPE — one switch governs all modals, another all slide-overs — and is
 * saved per user, because "I never want an off-click to close these" is a
 * standing preference, not a per-panel one. When locked, a backdrop click gets
 * the flash/bloom instead of a dismiss. The X and Escape always close.
 *
 * Modals route through openModal. Slide-overs each wire their own backdrop
 * handler, so a CAPTURE-phase document listener blocks that close when locked
 * rather than every panel having to check. Lock buttons are injected by a
 * MutationObserver, so a new panel gets one without touching its code.
 *
 * initPanelLock({ user })   once per page, after the shell exists
 * isPanelLocked("modal"|"slideover")
 */
/* State lives on `window`, not in file scope: this script can be evaluated more
 * than once on a page (helmet re-loads, hot reload, a second <script src>), and
 * a fresh file-scope object would silently reset the lock while the buttons
 * already injected into the DOM kept claiming the old state. Re-using the
 * existing object makes a re-evaluation a no-op instead. */
window.__polarisPanelLock = window.__polarisPanelLock ||
  { state: { modal: false, slideover: false }, user: "anon", wired: false };
var _panelLockStore = window.__polarisPanelLock;

function _panelLockKey() { return "polaris.panellock." + _panelLockStore.user; }

function _loadPanelLock() {
  var s = _panelLockStore.state;
  try {
    var v = JSON.parse(localStorage.getItem(_panelLockKey()) || "null");
    s.modal = !!(v && v.modal);
    s.slideover = !!(v && v.slideover);
  } catch (_) { s.modal = false; s.slideover = false; }
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

/* Read-only accessor for page code that must honor the lock beyond the
 * backdrop rule — e.g. a slide-over Edit button that normally closes the panel
 * before opening its modal, and must not when the operator pinned it open. */
function isPanelLocked(type) { return !!_panelLockStore.state[type]; }

function _lockBtnSvg(locked) {
  var attrs = 'width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  var body = locked
    ? '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
    : '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>';
  return "<svg " + attrs + ">" + body + "</svg>";
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
  // The tooltip states the CURRENT state and what the click will do — a lock
  // glyph alone reads ambiguously as either.
  btn.title = locked
    ? ("Locked — clicking outside won\u2019t close " + noun + ". Saved for your account. Click to unlock.")
    : ("Unlocked — clicking outside closes it. Click to lock all " + noun + " (saved for your account).");
}

function _syncAllLockButtons(type) {
  var sel = ".panel-lock-btn" + (type ? '[data-lock-type="' + type + '"]' : "");
  document.querySelectorAll(sel).forEach(_syncLockButton);
}

/* Insert a lock button immediately before the close (X) in a panel header.
 * Idempotent — re-running skips headers that already have one. */
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
  // space so the lock sits flush against the X instead of floating mid-header.
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

/* Safe to call repeatedly and safe to call LATE: the listeners are wired once,
 * everything else re-syncs. Call it from the same ready path that waits for the
 * rest of the runtime. */
function initPanelLock(opts) {
  if (opts && opts.user) _panelLockStore.user = opts.user;
  _loadPanelLock();
  if (_panelLockStore.wired) { _injectPanelLockButtons(); return; }
  _panelLockStore.wired = true;

  // Capture phase runs BEFORE a panel's own bubbling overlay handler, so
  // stopping propagation here keeps it open. e.target is the overlay itself
  // only on a genuine backdrop click.
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains("slideover-overlay") && _panelLockStore.state.slideover) {
      e.stopPropagation();
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
          var isOverlay = n.classList &&
            (n.classList.contains("slideover-overlay") || n.classList.contains("modal-overlay"));
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

function openModal(title, bodyHTML, footerHTML, options) {
  var overlay = document.getElementById("modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "modal-overlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">' +
        '<div class="modal-header"><h3 id="modal-title"></h3>' +
          '<button class="btn-icon modal-close" aria-label="Close dialog">&times;</button></div>' +
        '<div class="modal-body"></div><div class="modal-footer"></div>' +
      "</div>";
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target !== overlay) return;
      // Locked → keep the dialog open and flash the X as the hint; unlocked →
      // an off-click dismisses. See "Panel lock" above.
      if (_panelLockStore.state.modal) flashModalCloseBtn(overlay.querySelector(".modal-close"));
      else closeModal();
    });
    overlay.querySelector(".modal-close").addEventListener("click", closeModal);

    var modalEl = overlay.querySelector(".modal");
    overlay.querySelector(".modal-header").addEventListener("mousedown", function (e) {
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
      modalEl.style.transform = "translate(" + _modalDrag.offsetX + "px," + _modalDrag.offsetY + "px)";
    });
    document.addEventListener("mouseup", function () {
      if (_modalDrag.active) { _modalDrag.active = false; document.body.style.userSelect = ""; }
    });
  }

  var modal = overlay.querySelector(".modal");
  _modalDrag.offsetX = 0; _modalDrag.offsetY = 0;
  modal.style.transform = "";
  modal.classList.remove("modal-wide", "modal-large", "modal-xl");
  if (options && options.wide) modal.classList.add("modal-wide");
  if (options && options.large) modal.classList.add("modal-large");
  if (options && options.xl) modal.classList.add("modal-xl");

  overlay.querySelector(".modal-header h3").textContent = title;
  overlay.querySelector(".modal-body").innerHTML = bodyHTML;
  overlay.querySelector(".modal-footer").innerHTML = footerHTML || "";

  // Opened from inside a slide-over? Bump above it (1075 vs 1050).
  overlay.classList.toggle("above-slideover", !!document.querySelector(".slideover-overlay.open"));

  _modalReturnFocus = document.activeElement;
  if (_modalKeyTeardown) _modalKeyTeardown();
  _modalKeyTeardown = _trapFocus(modal, closeModal);
  // rAF so the transition has a start state to animate from — but rAF does not
  // fire in a hidden tab, which would leave the dialog built and invisible
  // until the tab is next looked at. The timeout is the floor.
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
  if (overlay) overlay.classList.remove("open", "above-slideover");
  if (_modalKeyTeardown) { _modalKeyTeardown(); _modalKeyTeardown = null; }
  if (_modalReturnFocus && _modalReturnFocus.focus) {
    try { _modalReturnFocus.focus(); } catch (_) {}
  }
  _modalReturnFocus = null;
}

/** await showConfirm("Delete 3 rows?") — never window.confirm(). */
function showConfirm(message) {
  return new Promise(function (resolve) {
    // Dedicated overlay (z 1300) so it STACKS above an open modal instead of
    // overwriting its body — a save flow can still read the form afterwards.
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
        "</div></div>";
    overlay.querySelector(".modal-body p").textContent = message;
    document.body.appendChild(overlay);

    var dialog = overlay.querySelector(".modal");
    var prevFocus = document.activeElement;
    var teardown = _trapFocus(dialog, function () { done(false); });

    function done(val) {
      teardown();
      overlay.classList.remove("open");
      setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (_) {} }
      resolve(val);
    }
    overlay.querySelector('[data-confirm="cancel"]').onclick = function () { done(false); };
    overlay.querySelector('[data-confirm="ok"]').onclick = function () { done(true); };
    var shown = false;
    var reveal = function () {
      if (shown) return;
      shown = true;
      overlay.classList.add("open");
      _focusFirstIn(dialog);
    };
    requestAnimationFrame(reveal);   // hidden tabs never fire it — see below
    setTimeout(reveal, 50);
  });
}

/** await showFormModal("Add User", formHTML, "Create") → true/false */
function showFormModal(title, formHTML, confirmLabel) {
  return new Promise(function (resolve) {
    var footer =
      '<button class="btn btn-secondary" id="form-modal-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="form-modal-ok">' + escapeHtml(confirmLabel || "OK") + "</button>";
    openModal(title, formHTML, footer);
    document.getElementById("form-modal-cancel").onclick = function () { closeModal(); resolve(false); };
    document.getElementById("form-modal-ok").onclick = function () { closeModal(); resolve(true); };
  });
}

/* ─── Sticky table wrappers ─────────────────────────────────────────────────
 * Bounds every .table-wrapper-sticky to the viewport so vertical scrolling
 * happens INSIDE the wrapper (thead pins; bulk bar + top pagination stay put).
 * Called automatically from renderPageControls / clearPageControls + resize.
 * NEVER use .table-wrapper-sticky inside a slide-over — use
 * .table-wrapper-panel-sticky with your own panel-relative sizer.
 */
function sizeStickyTableWrappers() {
  document.querySelectorAll(".table-wrapper-sticky").forEach(function (w) {
    var docTop = w.getBoundingClientRect().top + window.scrollY;
    var h = window.innerHeight - docTop - 72;
    w.style.maxHeight = Math.max(260, Math.round(h)) + "px";
  });
}
window.addEventListener("resize", sizeStickyTableWrappers);

/* ─── Paginated list controls row ───────────────────────────────────────────
 * Grid `1fr auto 1fr`: empty left cell · centered page nav · right cell with
 * action buttons + the "Show N" selector. Renders into #<id> and #<id>-top;
 * the size selector renders only in the -top row. Do NOT add a separate
 * "Show" filter-bar above the table.
 */
function clearPageControls(containerId) {
  var m = document.getElementById(containerId);
  if (m) m.innerHTML = "";
  var t = document.getElementById(containerId + "-top");
  if (t) t.innerHTML = "";
  sizeStickyTableWrappers();
}

function renderPageControls(containerId, total, pageSize, currentPage, onPageChange, onSizeChange, opts) {
  var containers = [];
  var mainEl = document.getElementById(containerId);
  if (mainEl) containers.push(mainEl);
  var topEl = document.getElementById(containerId + "-top");
  if (topEl) containers.push(topEl);
  if (!containers.length) return;

  var totalPages = Math.max(1, Math.ceil(total / pageSize));
  var pageButtons = "";
  var startPage = Math.max(1, currentPage - 2);
  var endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

  if (startPage > 1) {
    pageButtons += '<button class="btn btn-secondary btn-sm pg-btn" data-page="1">1</button>';
    if (startPage > 2) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
  }
  for (var p = startPage; p <= endPage; p++) {
    pageButtons += p === currentPage
      ? '<button class="btn btn-primary btn-sm pg-btn" data-page="' + p + '" disabled>' + p + "</button>"
      : '<button class="btn btn-secondary btn-sm pg-btn" data-page="' + p + '">' + p + "</button>";
  }
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
    pageButtons += '<button class="btn btn-secondary btn-sm pg-btn" data-page="' + totalPages + '">' + totalPages + "</button>";
  }

  var navHtml =
    '<button class="btn btn-secondary btn-sm pg-prev" ' + (currentPage <= 1 ? "disabled" : "") + ">&laquo; Prev</button>" +
    pageButtons +
    '<button class="btn btn-secondary btn-sm pg-next" ' + (currentPage >= totalPages ? "disabled" : "") + ">Next &raquo;</button>" +
    /* nowrap: at narrow widths this label would otherwise break between the
       number and "items" and read as colliding with the controls beside it. */
    '<span style="font-size:0.82rem;color:var(--color-text-tertiary);margin-left:8px;white-space:nowrap">' + total + " items</span>";

  var pageSizes = (opts && opts.pageSizes) || [15, 25, 50, 100];
  var hasTop = !!topEl;

  containers.forEach(function (container) {
    container.style.display = "grid";
    // Breathing room against the table: the top row sits above the wrapper and
    // the bottom row below it, and flush against the border both read as table
    // chrome rather than as controls for it.
    container.style.margin = (container === topEl) ? "0 0 10px" : "10px 0 0";
    // minmax(0,1fr) rather than 1fr: a 1fr track refuses to shrink below its
    // content, which pushes the side columns into the centered nav on a narrow
    // table. Also lets the center wrap instead of overflowing.
    container.style.gridTemplateColumns = "minmax(0,1fr) auto minmax(0,1fr)";
    container.style.alignItems = "center";
    container.style.gap = "12px";
    container.innerHTML =
      "<span></span>" +
      '<div class="pg-center" style="display:flex;align-items:center;gap:12px;justify-content:center;flex-wrap:wrap">' + navHtml + "</div>" +
      '<div class="pg-right" style="display:flex;align-items:center;gap:6px;justify-self:end;flex-wrap:wrap;justify-content:flex-end"></div>';

    container.querySelector(".pg-prev").addEventListener("click", function () {
      if (currentPage > 1) onPageChange(currentPage - 1);
    });
    container.querySelector(".pg-next").addEventListener("click", function () {
      if (currentPage < totalPages) onPageChange(currentPage + 1);
    });
    container.querySelectorAll(".pg-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        onPageChange(parseInt(btn.getAttribute("data-page"), 10));
      });
    });

    var right = container.querySelector(".pg-right");
    if (opts && opts.actionButtons) {
      opts.actionButtons.forEach(function (cfg) {
        var btn = document.createElement("button");
        btn.className = "btn btn-secondary btn-sm" + (cfg.className ? " " + cfg.className : "");
        btn.textContent = cfg.label;
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

/* ─── Slide-over ────────────────────────────────────────────────────────────
 * DOM shape (build once, reuse; open on the NEXT frame so the CSS transition
 * runs):
 *   .slideover-overlay > .slideover >
 *      .slideover-resize-handle
 *      .slideover-header > [.slideover-header-top (h3 + close), .slideover-meta]
 *      .slideover-body      (padding:0 — every body state supplies its own
 *                            gutter: 1rem 1.25rem 1rem 2.5rem)
 *      .slideover-footer
 * Width is user-resizable + persisted per surface.
 */
function initSlideoverResize(panelEl, storageKey) {
  var handle = panelEl.querySelector(".slideover-resize-handle");
  if (!handle) return;

  var stored = parseInt(localStorage.getItem(storageKey) || "0", 10);
  if (stored >= 380) panelEl.style.width = stored + "px";

  handle.addEventListener("mousedown", function (e) {
    e.preventDefault();
    handle.classList.add("dragging");
    var panelRight = panelEl.getBoundingClientRect().right;
    var minW = 380, maxW = Math.round(window.innerWidth * 0.9);

    function width(ev) {
      return Math.max(minW, Math.min(maxW, Math.round(panelRight - ev.clientX)));
    }
    function onMove(ev) { panelEl.style.width = width(ev) + "px"; }
    function onUp(ev) {
      handle.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      localStorage.setItem(storageKey, width(ev));
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/** Open an already-built overlay with its transition. */
function openSlideover(overlayEl) {
  requestAnimationFrame(function () { overlayEl.classList.add("open"); });
}

function closeSlideover(overlayEl) {
  overlayEl.classList.remove("open");
}

/* ─── Formatters ────────────────────────────────────────────────────────── */

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
  return '<span class="badge badge-' + escapeHtml(status) + '">' + escapeHtml(status) + "</span>";
}

function downloadCsv(headers, rows, filename) {
  var esc = function (c) {
    var s = c == null ? "" : String(c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  var csv = [headers.map(esc).join(",")].concat(rows.map(function (r) { return r.map(esc).join(","); })).join("\n");
  var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  var a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}


/* ─── Tabbed modal bodies ───────────────────────────────────────────────────
 * A tall config form splits into tabs INSIDE the modal, never into a wizard.
 * The strip is the modal-body's first child so it pins itself (CSS drops the
 * body's top padding and makes .page-tabs sticky + horizontally scrollable).
 * Field ids stay unique across tabs so one read pass collects the whole form.
 *
 * openModal({ title: "Add Integration",
 *             body: tabbedBodyHTML("int", [{key:"general", label:"General", html: …}]),
 *             onOpen: function () { wireModalTabs("int"); } })
 */
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
        function (p) { p.classList.remove("active"); }
      );
      btn.classList.add("active");
      var panel = document.getElementById(prefix + "-tab-" + btn.getAttribute("data-tab"));
      if (panel) panel.classList.add("active");
    });
  });
}

/* ─── Form section parts ────────────────────────────────────────────────────
 * sectionHeading("Connection Settings")  → uppercase tertiary label
 * formDivider()                          → 1px rule between groups
 * infoBox("<html>")                      → accent-tinted informational block
 * calloutHTML("warning"|"tip"|"note", title, bodyHtml) → left-accent callout
 */
function sectionHeading(text) {
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;' +
    'color:var(--color-text-tertiary);margin-bottom:0.75rem">' + escapeHtml(text) + "</p>";
}

function formDivider() {
  return '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">';
}

function infoBox(html) {
  return '<div style="background:rgba(79,195,247,0.08);border:1px solid rgba(79,195,247,0.2);' +
    'border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;' +
    'color:var(--color-text-secondary);line-height:1.5">' + html + "</div>";
}

var CALLOUT_VARIANTS = {
  warning: { color: "var(--color-warning)", icon: "&#9888;" },
  tip:     { color: "var(--color-accent)", icon: "&#128161;" },
  note:    { color: "var(--color-text-secondary)", icon: "" }
};

function calloutHTML(variant, title, bodyHtml) {
  var v = CALLOUT_VARIANTS[variant] || CALLOUT_VARIANTS.note;
  return '<div style="border-left:3px solid ' + v.color + ';' +
      "background:color-mix(in srgb, " + v.color + ' 9%, transparent);' +
      'border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:0.6rem 0.8rem;margin-top:0.75rem">' +
      (title ? '<p style="margin:0 0 0.4rem 0;font-weight:600;color:' + v.color + '">' +
        (v.icon ? v.icon + " " : "") + title + "</p>" : "") +
      '<p class="hint" style="margin:0">' + bodyHtml + "</p>" +
    "</div>";
}

/* Checkbox row: 'auto'-width box + label on one line, hint (if any) below.
 * checkboxRow("f-verifySsl", "Verify SSL certificate", true) */
function checkboxRow(id, label, checked) {
  return '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="' + escapeHtml(id) + '"' + (checked ? " checked" : "") +
        ' style="width:auto">' +
      '<label for="' + escapeHtml(id) + '" style="margin:0">' + escapeHtml(label) + "</label>" +
    "</div>";
}


/* ─── Row context menu ──────────────────────────────────────────────────────
 * List pages put per-row verbs behind the row's NAME, not an Actions column:
 * one affordance, no column competing with the data, room to add a verb
 * without re-cutting the layout.
 *
 * The menu is position:fixed on <body> rather than absolute inside a wrapper —
 * list tables scroll inside .table-wrapper-sticky, which clips an absolutely
 * positioned menu as soon as it's taller than the remaining rows. The cost of
 * fixed is that it must close on scroll, since it can't follow its anchor.
 *
 * rowMenuTriggerHTML(name)  → the <button class="row-menu-trigger"> markup
 * showRowMenu(anchor, items, { align: "end", label })
 *   items: [{label, onSelect, icon?, danger?, disabled?, title?}
 *           | {separator:true} | {heading:"..."}]
 * closeRowMenu()
 */
function rowMenuTriggerHTML(name, attrs) {
  return '<button type="button" class="row-menu-trigger" aria-haspopup="menu" ' +
    'aria-expanded="false"' + (attrs ? " " + attrs : "") + ">" + escapeHtml(name) + "</button>";
}

var _rowMenuTeardown = null;

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
    // `icon` is developer-supplied SVG markup, never user data, so innerHTML is
    // safe here; the label stays textContent regardless.
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
        try { it.onSelect(); }
        catch (err) {
          if (typeof showToast === "function") showToast((err && err.message) || "Action failed", "error");
        }
      });
      buttons.push(b);
    }
    menu.appendChild(b);
  });
  if (!buttons.length && !menu.childNodes.length) return;

  document.body.appendChild(menu);

  // Position under the anchor, flipped when it would leave the viewport.
  var r = anchor.getBoundingClientRect();
  var mw = menu.offsetWidth, mh = menu.offsetHeight, pad = 6;
  var top = r.bottom + 4;
  if (top + mh > window.innerHeight - pad) {
    var above = r.top - 4 - mh;
    top = above >= pad ? above : Math.max(pad, window.innerHeight - pad - mh);
  }
  // Left-aligned to the anchor by default; align:"end" right-aligns it, which
  // is what a trigger sitting at the right edge of the page header wants.
  var left = (opts && opts.align === "end") ? r.right - mw : r.left;
  if (left + mw > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pad - mw);
  if (left < pad) left = pad;
  menu.style.top = top + "px";
  menu.style.left = left + "px";

  function onDocPointerDown(e) {
    // contains() on the anchor, not identity: a trigger with child elements
    // would close on pointerdown and immediately re-open on the click, so a
    // second click could never dismiss it.
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
  // the menu is fixed and cannot track its anchor. But only a scroll that MOVED
  // the anchor is a reason to close: an auto-scrolling widget elsewhere on the
  // page would otherwise make the menu flash open and vanish.
  function onScroll(e) {
    var t = e && e.target;
    if (!t || t.nodeType === 9 || typeof t.contains !== "function") { closeRowMenu(); return; }
    if (t.contains(anchor)) closeRowMenu();
  }
  function onResize() { closeRowMenu(); }

  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);

  _rowMenuTeardown = function (o) {
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    _rowMenuTeardown = null;
    anchor.setAttribute("aria-expanded", "false");
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


/* ─── Theme-aware brand art ─────────────────────────────────────────────────
 * The shipped marks are baked per theme — the wordmark is light blue on the
 * dark art and near-black on the light one — so painting the wrong file on the
 * wrong ground makes the logo vanish. Two shapes, by surface: horizontal for a
 * login card, vertical for the narrow sidebar column. (symbol-* is the
 * standalone star, for favicons and compositing.)
 *
 * Which file is chosen by theme FAMILY, not id, so morning/noon both take the
 * light art without another asset. Add a theme and the art follows.
 *
 *   brandLogoSrc("sidebar")            → the right file for the current theme
 *   applyBrandLogo(imgEl, "sidebar")   → sets src + marker classes + alt
 *   watchBrandLogo(imgEl, "sidebar")   → keeps it right across theme changes
 */
var BRAND_ART = {
  login:   { dark: "img/brand/polaris-horiz-dark.png",  light: "img/brand/polaris-horiz-light.png" },
  sidebar: { dark: "img/brand/polaris-vert-dark.png",   light: "img/brand/polaris-vert-light.png" },
  symbol:  { dark: "img/brand/polaris-symbol-dark.png", light: "img/brand/polaris-symbol-light.png" }
};
/* Where the kit is served from, derived from this file's own URL (…/js/ →
   …/). Computed rather than configured because a page can re-evaluate this
   script, which would reset a global someone set from the page. Assign
   window.BRAND_ART_BASE only to override a genuinely different asset host. */
var BRAND_ART_BASE = (function () {
  if (typeof window.BRAND_ART_BASE === "string") return window.BRAND_ART_BASE;
  try {
    var s = document.currentScript ||
      document.querySelector('script[src*="polaris-ui.js"]');
    if (s && s.getAttribute("src")) {
      return s.getAttribute("src").replace(/js\/polaris-ui\.js.*$/, "");
    }
  } catch (e) { /* fall through to page-root */ }
  return "";
})();

function brandLogoSrc(surface) {
  var art = BRAND_ART[surface] || BRAND_ART.login;
  return BRAND_ART_BASE + art[isLightTheme() ? "light" : "dark"];
}

/* A custom logo REPLACES the shipped art, and never gets the brand-mark class:
 * the Polaris art is a fixed-aspect wordmark, an operator upload is any shape
 * at all, and the two cannot be sized by the same rule. */
function applyBrandLogo(img, surface, opts) {
  if (!img) return;
  var custom = opts && opts.customSrc;
  var src = custom || brandLogoSrc(surface);
  if (img.getAttribute("src") !== src) img.src = src;
  img.classList.toggle("brand-mark", !custom);
  img.classList.toggle("brand-mark-" + surface, !custom);
  img.alt = custom ? ((opts && opts.appName) || "") : "Polaris";
}

/* Repaint on theme change. Listens for the `themechange` event setTheme fires,
 * and also observes data-theme directly so a theme set by other means (the
 * pre-CSS boot in theme-init.js, another tab syncing) is picked up too. */
function watchBrandLogo(img, surface, opts) {
  applyBrandLogo(img, surface, opts);
  document.addEventListener("themechange", function () { applyBrandLogo(img, surface, opts); });
  try {
    new MutationObserver(function () { applyBrandLogo(img, surface, opts); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  } catch (e) { /* no MutationObserver — the event path still covers the toggle */ }
}

/* ─── Wizard (stepper modal) ─────────────────────────────────────────────────
 * For a task with real sequence and dependencies (each step narrowing what the
 * next one can offer) — NOT for a long form, which stays one modal with tabs.
 * The stepper strip is the modal-body's first child so the CSS pins it while a
 * step scrolls; panels are .step-panel, one .visible at a time.
 *
 * var wiz = createWizard({
 *   prefix: "aw",                        // ids: #aw-stepper, #aw-step-1, …
 *   steps: ["Basics", "Scope", "Trigger", "Review"],
 *   onEnter: function (n) {},            // render steps that depend on earlier ones
 *   collect: { 1: fn, 2: fn },           // read the panel into your draft
 *   validate: { 1: function () { return "Name is required"; } }  // message or null
 * });
 * openModal("New automation", wiz.bodyHtml(panels), wiz.footerHtml(), { wide: true });
 * wiz.wire();
 *
 * Visited steps are clickable — an operator who typed step 4 wrong should not
 * have to walk back through 3 and 2 to fix it.
 */
function createWizard(cfg) {
  var p = cfg.prefix || "wiz";
  var steps = cfg.steps || [];
  var step = 1;
  var visited = 1;

  function stepperHtml() {
    var parts = [];
    for (var i = 1; i <= steps.length; i++) {
      parts.push('<div class="stepper-step" data-step="' + i + '"><span class="stepper-num">' +
        i + "</span><span>" + escapeHtml(steps[i - 1]) + "</span></div>");
      if (i < steps.length) parts.push('<div class="stepper-line" data-line="' + i + '"></div>');
    }
    return '<div class="stepper" id="' + p + '-stepper">' + parts.join("") + "</div>";
  }

  /* panels: array of HTML strings, one per step ("" for panels rendered on
     entry by onEnter). */
  function bodyHtml(panels) {
    return stepperHtml() + steps.map(function (_, i) {
      return '<div class="step-panel' + (i === 0 ? " visible" : "") + '" id="' + p + "-step-" + (i + 1) +
        '">' + ((panels && panels[i]) || "") + "</div>";
    }).join("");
  }

  function footerHtml(saveLabel) {
    return '<button class="btn btn-secondary" id="' + p + '-cancel">Cancel</button>' +
      '<button class="btn btn-secondary" id="' + p + '-back" style="display:none">&larr; Back</button>' +
      '<button class="btn btn-primary" id="' + p + '-next">Next &rarr;</button>' +
      '<button class="btn btn-primary" id="' + p + '-save" style="display:none">' +
      escapeHtml(saveLabel || "Create") + "</button>";
  }

  function updateStepper() {
    document.querySelectorAll("#" + p + "-stepper .stepper-step").forEach(function (el) {
      var n = Number(el.getAttribute("data-step"));
      el.classList.toggle("active", n === step);
      el.classList.toggle("done", n < step);
      el.classList.toggle("clickable", n <= visited && n !== step);
    });
    document.querySelectorAll("#" + p + "-stepper .stepper-line").forEach(function (el) {
      el.classList.toggle("done", Number(el.getAttribute("data-line")) < step);
    });
  }

  function syncFooter() {
    var back = document.getElementById(p + "-back");
    var next = document.getElementById(p + "-next");
    var save = document.getElementById(p + "-save");
    if (back) back.style.display = step > 1 ? "" : "none";
    if (next) next.style.display = step < steps.length ? "" : "none";
    // In edit mode every step is already valid, so let them save from wherever
    // they finished changing things instead of walking to the end.
    if (save) save.style.display = (step === steps.length || cfg.editing) ? "" : "none";
  }

  function goToStep(n, opts) {
    opts = opts || {};
    var collect = (cfg.collect || {})[step];
    if (!opts.skipCollect && collect) collect();
    if (opts.validate) {
      var check = (cfg.validate || {})[step];
      var problem = check && check();
      if (problem) { showToast(problem, "error"); return false; }
    }
    var cur = document.getElementById(p + "-step-" + step);
    if (cur) cur.classList.remove("visible");
    step = n;
    visited = Math.max(visited, n);
    if (cfg.onEnter) cfg.onEnter(n);
    var nextPanel = document.getElementById(p + "-step-" + n);
    if (nextPanel) nextPanel.classList.add("visible");
    updateStepper();
    syncFooter();
    // A step change is a new screenful of content; leaving it mid-scroll reads
    // as a half-rendered panel.
    var mb = document.querySelector(".modal-body");
    if (mb) mb.scrollTop = 0;
    return true;
  }

  function wire(handlers) {
    handlers = handlers || {};
    var next = document.getElementById(p + "-next");
    var back = document.getElementById(p + "-back");
    var save = document.getElementById(p + "-save");
    var cancel = document.getElementById(p + "-cancel");
    if (next) next.addEventListener("click", function () { goToStep(step + 1, { validate: true }); });
    if (back) back.addEventListener("click", function () { goToStep(step - 1); });
    if (save) save.addEventListener("click", function () {
      var collect = (cfg.collect || {})[step];
      if (collect) collect();
      var check = (cfg.validate || {})[step];
      var problem = check && check();
      if (problem) { showToast(problem, "error"); return; }
      if (handlers.onSave) handlers.onSave();
    });
    if (cancel) cancel.addEventListener("click", function () {
      if (handlers.onCancel) handlers.onCancel();
      closeModal();
    });
    document.querySelectorAll("#" + p + "-stepper .stepper-step").forEach(function (el) {
      el.addEventListener("click", function () {
        var n = Number(el.getAttribute("data-step"));
        if (n <= visited && n !== step) goToStep(n);
      });
    });
    if (cfg.editing) visited = steps.length;
    if (cfg.onEnter) cfg.onEnter(1);
    updateStepper();
    syncFooter();
  }

  return {
    bodyHtml: bodyHtml, footerHtml: footerHtml, wire: wire, goToStep: goToStep,
    currentStep: function () { return step; },
    markAllVisited: function () { visited = steps.length; updateStepper(); syncFooter(); }
  };
}

/* ─── Integration modal (the standard shape) ─────────────────────────────────
 * Every "connect us to another system" dialog is the same dialog. Polaris grew
 * seven of these by hand (FortiManager, FortiGate, AD, Entra, Windows Server,
 * vCenter, Azure Arc) and they drifted: two tab implementations, footers in
 * different orders, some gating Test Connection on required fields and some
 * firing a doomed request. This is the one shape:
 *
 *   title    "<Action> <Product> Integration" — never a bare "Add Integration",
 *            because the operator picked a product to get here.
 *   body     General tab first (identity + connection), Monitoring second when
 *            it exists, then feature tabs. One tab per concern; a concern with
 *            three fields is a section, not a tab.
 *   footer   Test Connection · Cancel · Create/Save Changes. Test is a
 *            secondary on the LEFT: it is the rehearsal, not the commitment.
 *   test     gated on the fields the request actually needs, so a half-filled
 *            form gets a specific message instead of a server error.
 *
 * openIntegrationModal({
 *   product: "FortiManager",
 *   action: "Add",                       // or "Edit"
 *   tabs: [{key,label,html}, …],         // single-tab: pass `html` instead
 *   requires: [["f-host","host"], ["f-apiToken","API token"]],
 *   onTest: function (vals) {…},         // return {ok,message} or throw
 *   onSave: function (vals) {…},         // throw to keep the modal open
 *   saveLabel: "Create"                  // defaults by action
 * })
 */
function openIntegrationModal(cfg) {
  var prefix = cfg.prefix || "intg";
  var action = cfg.action || "Add";
  var tabs = cfg.tabs || null;
  var body = tabs ? tabbedBodyHTML(prefix, tabs) : (cfg.html || "");
  var saveLabel = cfg.saveLabel || (action === "Edit" ? "Save Changes" : "Create");
  var footer =
    '<button class="btn btn-secondary" id="' + prefix + '-test">Test Connection</button>' +
    '<button class="btn btn-secondary" id="' + prefix + '-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="' + prefix + '-save">' + escapeHtml(saveLabel) + "</button>";

  openModal(action + " " + cfg.product + " Integration", body, footer, { wide: true });
  if (tabs) wireModalTabs(prefix);

  /* Field ids stay unique ACROSS tabs so one pass collects the whole form —
   * a per-tab read would silently drop whatever the operator never opened. */
  function readVals() {
    var out = {};
    document.querySelectorAll(".modal [id^=\"f-\"]").forEach(function (el) {
      var key = el.id.slice(2);
      out[key] = el.type === "checkbox" ? el.checked : el.value;
    });
    return out;
  }

  /* Names the missing fields rather than saying "fill in the form": the whole
   * point of testing before saving is to find out what is wrong. */
  function missingFields() {
    var missing = [];
    (cfg.requires || []).forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (el && !String(el.value || "").trim()) missing.push(pair[1] || pair[0]);
    });
    return missing;
  }

  /* Disabled + relabelled while in flight: these calls reach a remote system
   * and can take seconds, and a second click would queue another one. */
  function busy(btn, label, fn) {
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    return Promise.resolve()
      .then(fn)
      .catch(function (err) {
        if (err && err.name === "AbortError") showToast("Aborted", "error");
        else showToast((err && err.message) || "Request failed", "error");
      })
      .then(function () {
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
    busy(testBtn, "Testing\u2026", function () {
      return Promise.resolve(cfg.onTest(readVals())).then(function (result) {
        tested = !!(result && result.ok);
        if (result && result.message) showToast(result.message, tested ? "success" : "error");
      });
    });
  });

  if (saveBtn) saveBtn.addEventListener("click", function () {
    if (!cfg.onSave) return;
    // Saving is never blocked on a passing test — an operator configuring
    // ahead of a firewall change has a legitimate reason to save something
    // that cannot connect yet. The modal stays open if onSave throws.
    busy(saveBtn, action === "Edit" ? "Saving\u2026" : "Creating\u2026", function () {
      return Promise.resolve(cfg.onSave(readVals(), { tested: tested })).then(function (result) {
        if (result === false) return;   // handler kept the modal open on purpose
        closeModal();
      });
    });
  });

  if (cancelBtn) cancelBtn.addEventListener("click", function () {
    if (cfg.onCancel) cfg.onCancel();
    closeModal();
  });

  return { readVals: readVals, wasTested: function () { return tested; } };
}