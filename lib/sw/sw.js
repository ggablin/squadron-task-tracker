// Push-only service worker. VERSION is prepended by the /sw.js route in server.js.
//
// There is deliberately NO fetch handler. That is what makes this phase safe to
// ship at any time: a worker that never intercepts a request cannot pin anyone
// to a stale shell, which is the failure the caching phase has to be careful
// about. Chrome does not even start this worker for navigations.
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (err) {}
  // Always show something. Chrome penalises a push that shows no notification,
  // and iOS requires one — a silent push can cost the permission entirely.
  event.waitUntil(self.registration.showNotification(d.title || 'UTA Tracker', {
    body: d.body || '',
    // icon is the large, full-colour image inside the notification.
    icon: '/icons/icon-192.png',
    // badge is the small status-bar mark, and Android renders it as a SILHOUETTE:
    // colour is discarded and every opaque pixel is painted white. Passing the app
    // icon here — opaque corner to corner — produces a solid white square, which
    // is what a member reported. badge-96.png is a purpose-drawn glyph whose shape
    // lives entirely in its alpha channel. See tools/make-badge.py.
    badge: '/icons/badge-96.png',
    // Same tag replaces an earlier notification for the same row rather than
    // stacking duplicates if a flush retries.
    tag: d.tag || 'uta',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || '/', self.location.origin);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find(c => new URL(c.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      // postMessage rather than navigate(): navigating would throw away whatever
      // the member was doing. index.html listens and calls applyDeepLink().
      open.postMessage({ type: 'open-view', url: target.href });
    } else {
      await self.clients.openWindow(target.href);
    }
  })());
});
