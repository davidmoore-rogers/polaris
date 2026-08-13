// public/js/brand-logo.js — which mark to paint, and in which theme.
//
// Two rules, one place, because they have to agree on the desktop login, the
// mobile login and the sidebar:
//
//   1. The shipped Polaris art is THEME-AWARE. The wordmark is light blue on
//      the dark variant and near-black on the light one, so painting the wrong
//      file on the wrong background makes the logo disappear. Horizontal art
//      for the login card, vertical for the sidebar column.
//   2. An operator's own logo REPLACES it — per surface (Server Settings →
//      Customization has a checkbox for each), optionally with the Polaris
//      symbol composited onto its corner (rendered server-side, see
//      services/brandLogoService.ts). The Application Name is text that only
//      makes sense NEXT TO a custom logo: the Polaris art already spells the
//      name out, so a caption under it would just say it twice.
//
// Theme changes are picked up by observing data-theme on <html> rather than by
// hooking each surface's theme setter — the desktop toggle, the mobile toggle
// and the OS-preference listener below all end at that attribute.

(function (global) {
  "use strict";

  var ASSETS = {
    // Login card — wide art, wordmark beside the star.
    login: {
      dark:  "/img/brand/polaris-horiz-dark.png",
      light: "/img/brand/polaris-horiz-light.png",
    },
    // Sidebar — stacked art, star above the wordmark, for a narrow column.
    sidebar: {
      dark:  "/img/brand/polaris-vert-dark.png",
      light: "/img/brand/polaris-vert-light.png",
    },
  };

  var ACCENT_PATH = "/server-settings/branding/logo-accent.png";
  var DEFAULT_LOGO = "/logo.png";

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  /** The OS preference, used only when the operator has never picked a theme. */
  function preferredTheme() {
    try {
      if (global.matchMedia && global.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    } catch (e) { /* matchMedia missing — fall through to the historical default */ }
    return "dark";
  }

  function savedTheme() {
    try { return localStorage.getItem("polaris-theme"); } catch (e) { return null; }
  }

  // Dash and mobile run against their own API mounts.
  function apiBase() {
    return global.__polarisApiBase || "/api/v1";
  }

  /**
   * Does this branding payload carry a custom logo? `customLogo` is computed
   * server-side; the fallback covers a payload cached in localStorage before
   * this field existed.
   */
  function isCustom(b) {
    if (!b) return false;
    if (typeof b.customLogo === "boolean") return b.customLogo;
    return Boolean(b.logoUrl) && b.logoUrl !== DEFAULT_LOGO;
  }

  /**
   * Is the custom logo wanted on this surface? The placement flags default ON
   * — an older cached payload has neither, and "show the logo I uploaded" is
   * the behavior that install already had.
   */
  function customOn(b, surface) {
    if (!isCustom(b)) return false;
    if (surface === "login")   return b.logoOnLogin   !== false;
    if (surface === "sidebar") return b.logoOnSidebar !== false;
    return true;
  }

  /**
   * Resolve everything a surface needs to render its brand block:
   *   { src, custom, showName, showSubtitle }
   * `showName` is false for the Polaris art on purpose (rule 2 above); the
   * operator's subtitle is their own line of copy and rides along either way.
   */
  function resolve(b, surface) {
    var assets = ASSETS[surface] || ASSETS.login;
    if (customOn(b, surface)) {
      return {
        src: b.logoAccent ? apiBase() + ACCENT_PATH : b.logoUrl,
        custom: true,
        showName: Boolean((b.appName || "").trim()),
        showSubtitle: Boolean((b.subtitle || "").trim()),
      };
    }
    return {
      src: assets[currentTheme()],
      custom: false,
      showName: false,
      showSubtitle: Boolean(b && (b.subtitle || "").trim()),
    };
  }

  /**
   * Point an <img> at the right mark and tag it so CSS can size the two cases
   * differently — the Polaris art is a fixed-aspect wordmark, an operator's
   * upload is any shape at all.
   */
  function applyTo(img, b, surface, opts) {
    var r = resolve(b, surface);
    if (img) {
      // The accent URL is fixed (the upload route reuses one filename), so a
      // just-saved change is the same URL with different bytes — `bust` is how
      // the Customization tab forces the live sidebar to re-fetch it. Every
      // other surface picks the change up on its next load, since the route
      // answers no-cache and revalidates.
      if (opts && opts.bust) r.src = r.src + (r.src.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
      if (img.getAttribute("src") !== r.src) img.src = r.src;
      img.classList.toggle("brand-mark", !r.custom);
      img.classList.toggle("brand-mark-" + surface, !r.custom);
      img.alt = r.custom ? ((b && b.appName) || "") : "Polaris";
    }
    return r;
  }

  /**
   * Re-run `cb` whenever the effective theme changes — the in-app toggle
   * (which writes data-theme) or, for a user who has never chosen one, the OS
   * flipping light/dark.
   */
  function onThemeChange(cb) {
    var last = currentTheme();
    try {
      new MutationObserver(function () {
        var now = currentTheme();
        if (now === last) return;
        last = now;
        cb(now);
      }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } catch (e) { /* no MutationObserver — the logo just won't restyle live */ }
  }

  /**
   * Follow the OS while the operator has no saved preference. Deliberately
   * does NOT write localStorage: staying unsaved is what keeps them tracking
   * the system, and the first use of the in-app toggle opts them out for good.
   */
  function followSystemTheme() {
    var mq;
    try { mq = global.matchMedia && global.matchMedia("(prefers-color-scheme: light)"); } catch (e) { return; }
    if (!mq) return;
    var handler = function () {
      if (savedTheme()) return;
      document.documentElement.setAttribute("data-theme", preferredTheme());
    };
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else if (mq.addListener) mq.addListener(handler);
  }

  followSystemTheme();

  global.PolarisBrandLogo = {
    ASSETS: ASSETS,
    currentTheme: currentTheme,
    preferredTheme: preferredTheme,
    savedTheme: savedTheme,
    isCustom: isCustom,
    customOn: customOn,
    resolve: resolve,
    applyTo: applyTo,
    onThemeChange: onThemeChange,
  };
})(window);
