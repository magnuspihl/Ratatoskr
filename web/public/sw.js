// Ratatoskr service worker: phone/desktop notifications only. It deliberately has no fetch handler
// and caches nothing, so the app stays a thin client that always talks to the server.
// The payload formats are NotificationPayload and ClearPayload in server/src/push/notify.ts.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function sameOriginPath(url) {
  try {
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* show a generic notification below */
  }
  const setBadge = async () => {
    if (typeof data.badge === 'number' && 'setAppBadge' in self.navigator) {
      await (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {});
    }
  };
  // The mail was read (or moved away) elsewhere: close its notifications (ClearPayload).
  if (data.type === 'clear') {
    const tags = new Set(Array.isArray(data.tags) ? data.tags : []);
    event.waitUntil(
      (async () => {
        for (const n of await self.registration.getNotifications()) if (tags.has(n.tag)) n.close();
        await setBadge();
      })(),
    );
    return;
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'New mail';
  event.waitUntil(
    (async () => {
      // Browsers require a visible notification for every push, so always show one.
      await self.registration.showNotification(title, {
        body: typeof data.body === 'string' ? data.body : '',
        tag: typeof data.tag === 'string' ? data.tag : undefined,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { url: sameOriginPath(data.url || '/') },
      });
      await setBadge();
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        // The app listens for this and navigates without a reload (see web/src/push.ts).
        existing.postMessage({ type: 'open', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// The push service rotated the subscription: register the new one with the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch('/api/push', { credentials: 'same-origin' });
      if (!res.ok) return;
      const { publicKey } = await res.json();
      const sub =
        event.newSubscription ||
        (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey }));
      await fetch('/api/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-ratatoskr': '1' },
        body: JSON.stringify(sub.toJSON()),
      });
    })(),
  );
});
