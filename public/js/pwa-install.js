/* public/js/pwa-install.js — Add-to-Home-Screen affordance (classic script).
 *
 * Loaded FIRST on mobile.html: `beforeinstallprompt` can fire before the app
 * has booted, and a listener registered later misses it entirely. External
 * file (not inline) because the CSP sets script-src 'self' with no
 * 'unsafe-inline' — same reason dash-mode.js and theme-init.js exist.
 *
 * Exposes window.PolarisInstall:
 *   isStandalone()  — running as an installed/home-screen app
 *   isIos()         — iOS/iPadOS, which needs manual Add-to-Home-Screen steps
 *   canPrompt()     — a native install prompt is available to trigger
 *   prompt()        — trigger it; resolves "accepted" | "dismissed" | "unavailable"
 *   onChange(fn)    — called when canPrompt()/isStandalone() changes
 *
 * WHY THIS MATTERS BEYOND CONVENIENCE: iOS grants Web Push only to a
 * home-screen-installed web app. On iOS 16.4+ `"PushManager" in window` is
 * true even in plain Safari, so a naive UI would offer an Enable button that
 * always throws. isStandalone() is what lets the More tab say "Add to Home
 * Screen first" instead.
 */
(function () {
  var deferred = null;
  var listeners = [];

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* a bad listener must not break the rest */ }
    }
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    // Chrome/Edge on Android + desktop. Never fires on iOS Safari, Firefox, or
    // desktop Safari — canPrompt() staying false is the normal path there.
    e.preventDefault();
    deferred = e;
    emit();
  });

  window.addEventListener("appinstalled", function () {
    deferred = null;
    emit();
  });

  function isStandalone() {
    try {
      // navigator.standalone is the legacy iOS-only property and is the
      // RELIABLE signal there — display-mode has been flaky across iOS
      // versions, so check both.
      if (navigator.standalone === true) return true;
      if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  // Firefox never implemented beforeinstallprompt, but Firefox for Android CAN
  // install from its own menu — so canPrompt() being false must not be read as
  // "this browser can't install". Callers use this to pick the right manual
  // instructions instead of hiding the affordance entirely.
  function isFirefox() {
    try { return /Firefox\/|FxiOS\//.test(navigator.userAgent || ""); } catch (e) { return false; }
  }

  function isIos() {
    try {
      var ua = navigator.userAgent || "";
      if (/iPad|iPhone|iPod/.test(ua)) return true;
      // iPadOS 13+ reports a desktop Mac UA; the touch-point count is the
      // usual discriminator.
      if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function canPrompt() { return !!deferred; }

  async function prompt() {
    if (!deferred) return "unavailable";
    var evt = deferred;
    // Clear first: the event is single-use, and leaving it set after a
    // dismissal would show a button that silently does nothing.
    deferred = null;
    emit();
    try {
      evt.prompt();
      var choice = await evt.userChoice;
      return (choice && choice.outcome) || "dismissed";
    } catch (e) {
      return "dismissed";
    }
  }

  window.PolarisInstall = {
    isStandalone: isStandalone,
    isIos: isIos,
    isFirefox: isFirefox,
    canPrompt: canPrompt,
    prompt: prompt,
    onChange: function (fn) { if (typeof fn === "function") listeners.push(fn); },
  };
})();
