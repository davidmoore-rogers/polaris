/* Polaris service worker — Web Push delivery for notifications.
 *
 * Receives pushes signed with the server VAPID key (deliverNotifications
 * web_push channel) and shows a system notification. Clicking it focuses an
 * existing Polaris tab (or opens one) at the deep link the SERVER chose.
 *
 * Registered by public/js/push.js, which loads on every desktop page that
 * renders the sidebar and on the mobile SPA.
 *
 * DEEP LINKS ARE THE SERVER'S JOB. The payload's `url` already points at the
 * right surface — /mobile.html#more/alerts for a subscription enrolled from
 * the mobile SPA, /automations.html for a desktop one (PushSubscription
 * .surface → pushDeepLinkUrl). This worker deliberately contains no
 * rewriting logic; it just navigates where it's told. The url may be absolute
 * or relative (relative when POLARIS_PUBLIC_URL is unset), and both
 * client.navigate() and clients.openWindow() resolve either.
 *
 * NO FETCH HANDLER, deliberately. Polaris is an online-only tool: there is no
 * offline caching, no precache, no cache versioning to keep in step with
 * deploys. Do not add one without a deliberate decision — it changes this from
 * a push worker into a caching layer that can serve stale app code.
 * (/notifications.html deep links from already-delivered pushes stay valid —
 * the server keeps that page gated + reachable forever.)
 */

var DEFAULT_URL = "/automations.html";
var NOTIFICATION_ICON = "/icons/app-192.png";

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Polaris", body: event.data ? event.data.text() : "" };
  }
  var title = data.title || "Polaris notification";
  var options = {
    body: data.body || "",
    tag: data.notificationId || undefined,
    data: { url: data.url || DEFAULT_URL },
    // Branded icon rendered from the operator's logo by appIconService. The
    // bare (unversioned) path is used because a service worker can't know the
    // current icon version; the route serves it with a short max-age so a
    // branding change still reaches notifications quickly.
    //
    // `badge` is deliberately omitted: Android renders it as a monochrome
    // alpha mask, so a color logo arrives as a featureless white blob — worse
    // than the platform default.
    icon: NOTIFICATION_ICON,
    requireInteraction: data.severity === "error",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || DEFAULT_URL;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ("focus" in client) {
          // Only navigate when the client isn't already there. The previous
          // unconditional navigate() reloaded an already-correct page,
          // throwing away scroll position and in-flight state.
          var target = new URL(url, self.location.origin).href;
          if (client.url !== target) client.navigate(target);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

/* Endpoint rotation.
 *
 * Browsers rotate push endpoints periodically; without this the subscription
 * silently dies and the server keeps a dead endpoint until the next send
 * returns 410. Re-subscribe with the same application server key and tell the
 * server, passing the OLD endpoint so it can carry the subscription's
 * `surface` forward (a rotation mints a new endpoint, so there is no row to
 * inherit from) and retire the stale row.
 *
 * Best-effort: this can fire with no live session, and POST /push-subscriptions
 * requires alerts:read. That's why push.js ALSO re-posts the current
 * subscription on every page load (reconcileSubscription) — that boot-time
 * reconcile is the primary mechanism, since this event is unevenly supported
 * (Chrome fires it; Safari is unreliable and iOS may never fire it).
 */
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(
    (async function () {
      try {
        var oldSub = event.oldSubscription || null;
        var key = oldSub && oldSub.options && oldSub.options.applicationServerKey;

        if (!key) {
          // Not all browsers expose the old subscription's key — ask the server.
          var res = await fetch("/api/v1/push-subscriptions/key", { credentials: "include" });
          if (!res.ok) return;
          var body = await res.json();
          if (!body || !body.enabled || !body.publicKey) return;
          key = urlBase64ToUint8Array(body.publicKey);
        }

        var sub = event.newSubscription
          || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
        if (!sub) return;

        var json = sub.toJSON();
        if (!json || !json.keys) return;

        await fetch("/api/v1/push-subscriptions", {
          method: "POST",
          credentials: "include",
          headers: Object.assign({ "Content-Type": "application/json" }, await csrfHeader()),
          body: JSON.stringify({
            endpoint: sub.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
            oldEndpoint: oldSub ? oldSub.endpoint : undefined,
          }),
        });
      } catch (e) {
        // Nothing useful to do here — the boot-time reconcile in push.js
        // repairs this on the user's next visit.
      }
    })()
  );
});

/* A service worker has no document.cookie, so read the (non-HttpOnly) CSRF
 * cookie via the Cookie Store API. Chrome supports it — and Chrome is also the
 * browser that actually fires pushsubscriptionchange, so this covers the real
 * case. Where it's unavailable we send no header and the POST is rejected by
 * the CSRF middleware; that's an accepted loss, because push.js's boot-time
 * reconcile repairs the subscription on the user's next visit. */
async function csrfHeader() {
  try {
    if (self.cookieStore && self.cookieStore.get) {
      var c = await self.cookieStore.get("polaris_csrf");
      if (c && c.value) return { "X-CSRF-Token": c.value };
    }
  } catch (e) { /* ignore */ }
  return {};
}

function urlBase64ToUint8Array(base64String) {
  var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  var raw = self.atob(base64);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
