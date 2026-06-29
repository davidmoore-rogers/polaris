/* Polaris service worker — Web Push delivery for notifications.
 *
 * Receives pushes signed with the server VAPID key (deliverNotifications
 * web_push channel) and shows a system notification. Clicking it focuses an
 * existing Polaris tab (or opens one) at the notifications page / deep link.
 *
 * Registered by public/js/push.js on both the desktop app and the mobile SPA.
 * Intentionally minimal — no offline caching; Polaris is an online-only tool.
 */

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
    data: { url: data.url || "/notifications.html" },
    badge: "/favicon.ico",
    icon: "/favicon.ico",
    requireInteraction: data.severity === "error",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/notifications.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
