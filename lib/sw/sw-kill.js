// The escape hatch. Served in place of sw.js whenever SW_MODE=kill is set on the
// service, so a bad worker can be retired with a Railway variable flip from a
// phone — no PR, no revert, no waiting on a build.
//
// A service worker lives on the member's device, not the server, so this is the
// only way to reach one that has gone wrong. Kept permanently even while sw.js
// has no fetch handler and cannot strand anyone: the hatch has to exist before
// it is needed, not be written during the incident.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => event.waitUntil((async () => {
  // unregister() alone leaves the caches behind, so clear them explicitly.
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  await self.registration.unregister();
  // Reload every open tab so they drop this worker in the same visit rather than
  // whenever the member next happens to reopen the app.
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.navigate(c.url));
})()));
