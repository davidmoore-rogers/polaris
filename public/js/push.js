/* public/js/push.js — Web Push enrollment helper (classic script).
 *
 * Exposes window.polarisPush: register the service worker, check status, and
 * enable/disable a browser/PWA push subscription for the logged-in user.
 *
 * Loaded on every desktop page that renders the sidebar (app.js wires the
 * sidebar's "Push notifications" row) and on the mobile SPA (the More tab's
 * Notifications row). Depends on the `api` global (api.js, loaded first).
 *
 * SURFACE: enable() takes { surface: "desktop" | "mobile" }. The server stores
 * it on the subscription and uses it to pick the push deep link, because on
 * Android the installed PWA and the browser share one subscription — subscribe
 * time is the only moment the surface is knowable.
 */
(function () {
  function isSupported() {
    return (
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window &&
      window.isSecureContext
    );
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = window.atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  var swReg = null;
  async function registerSW() {
    if (!isSupported()) return null;
    if (swReg) return swReg;
    swReg = await navigator.serviceWorker.register("/sw.js");
    return swReg;
  }

  async function getSubscription() {
    var reg = await registerSW();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  }

  // { supported, enabledOnServer, permission, subscribed }
  async function status() {
    var supported = isSupported();
    var enabledOnServer = false;
    if (supported) {
      try {
        var key = await api.push.key();
        enabledOnServer = !!(key && key.enabled);
      } catch (e) { /* ignore */ }
    }
    var subscribed = false;
    if (supported) {
      try { subscribed = !!(await getSubscription()); } catch (e) { /* ignore */ }
    }
    return {
      supported: supported,
      enabledOnServer: enabledOnServer,
      permission: supported ? Notification.permission : "denied",
      subscribed: subscribed,
    };
  }

  function normalizeSurface(s) {
    return s === "mobile" ? "mobile" : "desktop";
  }

  async function enable(opts) {
    if (!isSupported()) throw new Error("This browser doesn't support push notifications.");

    // ─────────────────────────────────────────────────────────────────────
    // Notification.requestPermission() MUST come first, before any await
    // that hits the network.
    //
    // Safari (desktop and iOS) requires the call to happen while the click's
    // transient user activation is still live, and an awaited fetch drops it.
    // The old order (api.push.key() then requestPermission()) made the iOS
    // prompt fail silently — the single reason mobile push appeared not to
    // work at all.
    //
    // Prompting before we've confirmed the server has Web Push configured is
    // safe ONLY because every caller hides its control unless
    // status().enabledOnServer is already true (see app.js's sidebar row and
    // more-tab.js's Notifications row). Do not "tidy" this by moving the key
    // fetch back up.
    // ─────────────────────────────────────────────────────────────────────
    var perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notification permission was not granted.");

    var key = await api.push.key();
    if (!key || !key.enabled || !key.publicKey) {
      throw new Error("Push isn't enabled on the server. Ask an admin to configure Web Push on Automations → Delivery.");
    }
    var reg = await registerSW();
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.publicKey),
      });
    }
    var json = sub.toJSON();
    await api.push.subscribe({
      endpoint: sub.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      surface: normalizeSurface(opts && opts.surface),
    });
    return true;
  }

  async function disable() {
    var sub = await getSubscription();
    if (!sub) return false;
    try { await api.push.unsubscribe(sub.endpoint); } catch (e) { /* server may already be gone */ }
    await sub.unsubscribe();
    return true;
  }

  /**
   * Boot-time self-heal for rotated push endpoints.
   *
   * Browsers rotate push endpoints periodically. sw.js has a
   * pushsubscriptionchange handler for the immediate case, but that event is
   * unevenly supported (Chrome fires it; Safari's support is unreliable and it
   * may not fire at all on iOS) and it can fire with no live session. So THIS
   * is the primary mechanism, not the fallback: on every page load, re-post
   * whatever subscription the browser currently holds.
   *
   * savePushSubscription is an idempotent upsert keyed on endpoint, so a
   * repeat post costs one cheap upsert; a rotated endpoint simply lands as a
   * fresh row and the stale one is pruned by the existing 410 path.
   *
   * Silent by design — never surfaces an error to a user who did nothing.
   */
  async function reconcileSubscription(surface) {
    if (!isSupported()) return false;
    try {
      var sub = await getSubscription();
      if (!sub) return false;
      var json = sub.toJSON();
      if (!json || !json.keys || !json.keys.p256dh || !json.keys.auth) return false;
      await api.push.subscribe({
        endpoint: sub.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        surface: normalizeSurface(surface),
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  window.polarisPush = {
    isSupported: isSupported,
    registerSW: registerSW,
    status: status,
    enable: enable,
    disable: disable,
    reconcileSubscription: reconcileSubscription,
  };
})();
