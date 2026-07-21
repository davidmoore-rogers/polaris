/* public/js/push.js — Web Push enrollment helper (classic script).
 *
 * Exposes window.polarisPush: register the service worker, check status, and
 * enable/disable a browser/PWA push subscription for the logged-in user. Used
 * by the Notifications page's "Enable push" control on both the desktop app
 * and the mobile SPA. Depends on the `api` global (api.js, loaded first).
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

  async function enable() {
    if (!isSupported()) throw new Error("This browser doesn't support push notifications.");
    var key = await api.push.key();
    if (!key || !key.enabled || !key.publicKey) {
      throw new Error("Push isn't enabled on the server. Ask an admin to configure Web Push on Automations → Delivery.");
    }
    var perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notification permission was not granted.");
    var reg = await registerSW();
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.publicKey),
      });
    }
    var json = sub.toJSON();
    await api.push.subscribe({ endpoint: sub.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
    return true;
  }

  async function disable() {
    var sub = await getSubscription();
    if (!sub) return false;
    try { await api.push.unsubscribe(sub.endpoint); } catch (e) { /* server may already be gone */ }
    await sub.unsubscribe();
    return true;
  }

  window.polarisPush = { isSupported: isSupported, registerSW: registerSW, status: status, enable: enable, disable: disable };
})();
