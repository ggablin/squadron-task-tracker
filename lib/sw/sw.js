// Push-only service worker. VERSION is prepended by the /sw.js route in server.js.
//
// There is deliberately NO fetch handler. That is what makes this phase safe to
// ship at any time: a worker that never intercepts a request cannot pin anyone
// to a stale shell, which is the failure the caching phase has to be careful
// about. Chrome does not even start this worker for navigations.
// ── Routing table ─────────────────────────────────────────────────
// Returns the strategy for a request, or null to leave it alone entirely.
// Null is the default on purpose: not intercepting is always the safe answer,
// so a URL nobody thought about falls through to the network untouched.
//
// Nothing here is content-hashed (there is no bundler), which is why the files
// that change land in stale-while-revalidate rather than cache-first.
const SWR_FILES = ['/design.css', '/ui.js', '/member-browser.js', '/offline.js',
                   '/duties.js', '/calendar.js'];

function routeRequest(request) {
  // Only GET is ever cacheable, and a write must never be served from a cache.
  if (request.method !== 'GET') return null;

  const url = new URL(request.url, self.location.origin);
  // Cross-origin is left to the network. Without this, any third-party URL whose
  // path happened to look like ours would be matched on pathname alone.
  if (url.origin !== self.location.origin) return null;

  // Never /api/. This is a safety property, not a performance choice: caching a
  // member's data would let a shared phone serve it to whoever signs in next.
  // It also covers document downloads, which live under /api/documents/.
  if (url.pathname.startsWith('/api/')) return null;

  // Only the member SPA at '/' is cached. Navigations to the leadership desktop
  // tools stay online-only — they are out of scope for offline, and caching them
  // would multiply the stale-shell surface for no gain.
  if (request.mode === 'navigate') return url.pathname === '/' ? 'shell' : null;

  const path = url.pathname;
  if (path.startsWith('/fonts/') || path.startsWith('/icons/')
      || path === '/manifest.webmanifest' || path === '/favicon.ico') return 'cache-first';
  if (SWR_FILES.indexOf(path) !== -1) return 'swr';

  return null;
}

// Cache names are versioned by the commit SHA the /sw.js route prepends, so a
// deploy rotates them and last release's bytes are dropped rather than merged.
const SHELL_CACHE  = 'shell-' + VERSION;
const ASSETS_CACHE = 'assets-' + VERSION;

// Only a genuine same-origin 200 earns a place in the cache. 'basic' excludes
// opaque and CORS responses, whose status cannot be trusted; the status check
// excludes the Railway 502 page served while a deploy swaps over, which is the
// realistic way a cache gets poisoned with something a refresh cannot clear.
function shouldCache(response) {
  return !!response && response.ok === true && response.type === 'basic';
}

// Everything we own from a previous VERSION, and nothing belonging to anyone
// else on this origin.
function staleCaches(names) {
  return names.filter((n) => (n.indexOf('shell-') === 0 || n.indexOf('assets-') === 0)
                          && n !== SHELL_CACHE && n !== ASSETS_CACHE);
}

// The shell is stored under the bare '/' so a plain open and a /?view=member
// deep link from a notification share one entry rather than fragmenting.
const SHELL_URL = self.location.origin + '/';
// 4s because the failure this guards is not clean offline — it is one bar at
// drill, where a request neither answers nor rejects. Waiting on that is
// indistinguishable to a member from the app being broken.
const SHELL_TIMEOUT_MS = 4000;
const TIMED_OUT = Symbol('timed out');

async function shellStrategy(request, timeoutMs) {
  const cache = await caches.open(SHELL_CACHE);
  let timer;
  let response = null;
  try {
    response = await Promise.race([
      fetch(request),
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); }),
    ]);
  } catch (err) {
    response = null;                       // hard network failure
  }
  clearTimeout(timer);

  if (response && response !== TIMED_OUT && shouldCache(response)) {
    cache.put(SHELL_URL, response.clone());
    return response;
  }
  // Timed out, failed, or answered with something not worth keeping. A good
  // cached shell beats a fresh Railway 502 mid-deploy, so the cache wins here
  // even though the network technically replied.
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  // Nothing cached: hand back whatever the network really said, so the member
  // sees the true error rather than a fabricated one.
  if (response && response !== TIMED_OUT) return response;
  throw new Error('offline, and no shell has been cached yet');
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSETS_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (shouldCache(res)) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSETS_CACHE);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((res) => { if (shouldCache(res)) cache.put(request, res.clone()); return res; })
    .catch(() => null);
  return hit || network;                   // cached copy answers now; refresh lands behind it
}

function handleFetch(request, strategy, timeoutMs) {
  const t = typeof timeoutMs === 'number' ? timeoutMs : SHELL_TIMEOUT_MS;
  if (strategy === 'shell') return shellStrategy(request, t);
  if (strategy === 'cache-first') return cacheFirst(request);
  if (strategy === 'swr') return staleWhileRevalidate(request);
  return fetch(request);
}

// Precached on install so a member who has only ever opened the app once still
// has a shell to boot from. 'reload' bypasses the HTTP cache, so a new VERSION
// never fills its fresh cache with bytes the browser was already holding.
const PRECACHE_ASSETS = SWR_FILES.concat(['/manifest.webmanifest', '/icons/icon-192.png']);
const reloadReq = (path) => new Request(self.location.origin + path, { cache: 'reload' });

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const [shell, assets] = await Promise.all([caches.open(SHELL_CACHE), caches.open(ASSETS_CACHE)]);
    await Promise.all([
      shell.addAll([reloadReq('/')]),
      assets.addAll(PRECACHE_ASSETS.map(reloadReq)),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(staleCaches(names).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const strategy = routeRequest(event.request);
  // Returning without calling respondWith leaves the request completely alone —
  // the browser fetches it as if no worker existed. Anything not explicitly
  // routed above takes this path.
  if (!strategy) return;
  event.respondWith(handleFetch(event.request, strategy));
});

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
