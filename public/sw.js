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
 * ACKNOWLEDGE BUTTON. When the payload carries `ackUrl` (a single-use token
 * link minted for this recipient — only recipients who may actually
 * acknowledge get one), the notification grows an "Acknowledge" action that
 * POSTs it and replaces the alert in the tray with a silent confirmation,
 * without opening the app. Action buttons are unsupported on iOS/Safari, where
 * the option is simply ignored and the body tap behaves as it always has.
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
/* Severities that keep the notification on screen until it's dealt with. This
 * read `data.severity === "error"` until 2026-08 — a value the server has never
 * sent, since SEVERITIES is a closed enum of notice/informational/warning/
 * serious/critical. No alert had ever actually been sticky. */
var LOUD_SEVERITIES = ["serious", "critical"];

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
    data: {
      url: data.url || DEFAULT_URL,
      // Single-use acknowledge link for THIS recipient. Absent when they
      // can't acknowledge (see notificationRecipientService) — the button
      // below is added only when it's here, so an unentitled recipient never
      // sees a control that would fail.
      ackUrl: data.ackUrl || null,
      notificationId: data.notificationId || null,
    },
    // Branded icon rendered from the operator's logo by appIconService. The
    // bare (unversioned) path is used because a service worker can't know the
    // current icon version; the route serves it with a short max-age so a
    // branding change still reaches notifications quickly.
    //
    // `badge` is deliberately omitted: Android renders it as a monochrome
    // alpha mask, so a color logo arrives as a featureless white blob — worse
    // than the platform default.
    icon: NOTIFICATION_ICON,
    requireInteraction: LOUD_SEVERITIES.indexOf(data.severity) !== -1,
  };
  // Acknowledge straight from the tray. No feature detection: an unsupported
  // NotificationOptions member is dropped, not an error, so iOS/Safari (which
  // renders no action buttons at all) simply shows the plain notification and
  // the body tap keeps working.
  if (data.ackUrl) options.actions = [{ action: "ack", title: "Acknowledge" }];
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  var d = event.notification.data || {};
  var url = d.url || DEFAULT_URL;
  event.notification.close();
  // Exactly one waitUntil per invocation, taken before the first await, so the
  // worker stays alive for the whole chain.
  if (event.action === "ack" && d.ackUrl) {
    event.waitUntil(acknowledgeAndConfirm(d, url));
    return;
  }
  event.waitUntil(focusOrOpen(url));
});

function focusOrOpen(url) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
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
  });
}

/* Acknowledge from the notification's own button, without opening the app.
 *
 * The token in ackUrl IS the credential, so this posts with credentials
 * omitted: no session cookie rides along, and therefore none of the CSRF
 * dance pushsubscriptionchange needs below (/ack is mounted above the CSRF
 * middleware precisely because there is no cookie to protect).
 *
 * This is a fetch INSIDE notificationclick, not a `fetch` event handler — the
 * worker's no-offline-caching posture is unchanged.
 */
async function acknowledgeAndConfirm(d, url) {
  try {
    // Same-origin only. The push is VAPID-signed, but resolving the URL costs
    // nothing and keeps this worker from ever being a request forwarder to a
    // foreign host (CSP connect-src is 'self' anyway).
    var target = new URL(d.ackUrl, self.location.origin);
    if (target.origin !== self.location.origin) return focusOrOpen(url);

    var res = await fetch(target.href, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    });
    // The alert's automation demands a note, and a tray button has no field to
    // type one into. Open the ack PAGE (not the app) — the token is still
    // unspent, the page has the textarea, and it needs no session, which
    // matters on the phone that just buzzed. Read before the generic !res.ok
    // branch below, which would otherwise send them to a login wall.
    if (res.status === 400) {
      var body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (body && body.state === "note_required") return focusOrOpen(target.href);
    }
    // Expired, spent, or forbidden: hand it to the app rather than swallowing.
    if (!res.ok) return focusOrOpen(url);

    await self.registration.showNotification("Acknowledged", {
      body: "This alert is acknowledged.",
      // Same tag replaces the alert in the tray instead of stacking beside it.
      tag: d.notificationId || undefined,
      data: { url: url },
      icon: NOTIFICATION_ICON,
      requireInteraction: false,
      // A confirmation must not buzz the phone a second time. `renotify` is
      // deliberately omitted (defaults false) for the same reason.
      silent: true,
    });
  } catch (e) {
    // Offline or blocked — fall back to today's behaviour so the operator can
    // still act. Deliberately no auto-dismiss timer: holding the worker alive
    // on a timer invites the browser to kill it mid-flight, and a swipeable
    // confirmation beats one that vanishes before it's read.
    return focusOrOpen(url);
  }
}

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
