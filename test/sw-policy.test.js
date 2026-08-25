'use strict';
// The service worker's routing table, tested against the ACTUAL shipped file.
//
// lib/sw/sw.js cannot be require()d — it runs in a worker scope and is served as
// a string by the /sw.js route, which prepends `const VERSION = "..."`. So the
// test loads the real source into a node:vm context with a stubbed worker scope
// and prepends VERSION exactly as the route does. No duplicated policy, no build
// step, and a drift between what is tested and what ships is impossible.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ORIGIN = 'https://tracker.test';

// Minimal Cache Storage stub. Real enough to catch ordering and ignoreSearch
// mistakes; a Map of name -> Map of url -> response.
function makeCaches(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, new Map(Object.entries(v))]));
  const openCache = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const c = store.get(name);
    return {
      async match(reqOrUrl, opts) {
        const key = typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url;
        if (opts && opts.ignoreSearch) {
          const bare = key.split('?')[0];
          for (const [k, v] of c) if (k.split('?')[0] === bare) return v;
          return undefined;
        }
        return c.get(key);
      },
      async put(reqOrUrl, res) { c.set(typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url, res); },
      async addAll(urls) { for (const u of urls) c.set(typeof u === 'string' ? u : u.url, { ok: true, type: 'basic', status: 200, body: 'precached' }); },
    };
  };
  return {
    open: async (n) => openCache(n),
    keys: async () => [...store.keys()],
    delete: async (n) => store.delete(n),
    __store: store,
  };
}

function loadWorker({ fetchStub, caches: cacheStub } = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sw', 'sw.js'), 'utf8');
  const handlers = {};
  const ctx = {
    console, URL, Response, Request, AbortController,
    setTimeout, clearTimeout, Promise, JSON,
    fetch: fetchStub || (async () => { throw new Error('test made no network stub available'); }),
    caches: cacheStub || makeCaches(),
  };
  ctx.self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting() {}, location: { origin: ORIGIN },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    registration: { showNotification: async () => {} },
  };
  vm.createContext(ctx);
  // Exactly what server.js's /sw.js route sends.
  vm.runInContext(`const VERSION = ${JSON.stringify('testsha')};\n${src}`, ctx);
  return { ctx, handlers };
}

// A stand-in for the parts of Request the routing table reads.
const req = (url, { method = 'GET', mode = 'no-cors' } = {}) => ({ method, mode, url });

test('the worker never intercepts /api/ — a shared phone must not serve one member cached data for another', () => {
  const { ctx } = loadWorker();
  assert.strictEqual(typeof ctx.routeRequest, 'function',
    'sw.js should expose routeRequest() so the routing table is testable');
  for (const url of ['/api/auth/me', '/api/tasks', '/api/notifications', '/api/push/vapid-key']) {
    assert.strictEqual(ctx.routeRequest(req(ORIGIN + url)), null, `${url} must not be intercepted`);
  }
});

test('a navigation to the app shell takes the shell strategy, including with a ?view= deep link', () => {
  const { ctx } = loadWorker();
  const nav = (u) => ctx.routeRequest(req(ORIGIN + u, { mode: 'navigate' }));
  assert.strictEqual(nav('/'), 'shell');
  // ignoreSearch: a push tap lands on /?view=member, which must still resolve to
  // the cached '/' rather than missing the cache on the query string.
  assert.strictEqual(nav('/?view=member'), 'shell');
});

test('navigations to the leadership desktop pages are left alone', () => {
  const { ctx } = loadWorker();
  for (const p of ['/build', '/records', '/roster', '/export', '/newsletter', '/task-builder-mockup']) {
    assert.strictEqual(ctx.routeRequest(req(ORIGIN + p, { mode: 'navigate' })), null,
      `${p} is an online-only desktop tool and must not be cached`);
  }
});

test('assets that never change under a given URL are cache-first', () => {
  const { ctx } = loadWorker();
  for (const p of ['/fonts/general-sans-400.woff2', '/icons/icon-192.png',
                   '/icons/badge-96.png', '/manifest.webmanifest', '/favicon.ico']) {
    assert.strictEqual(ctx.routeRequest(req(ORIGIN + p)), 'cache-first', p);
  }
});

test('the shared front-end files are stale-while-revalidate, because nothing content-hashes them', () => {
  const { ctx } = loadWorker();
  for (const p of ['/design.css', '/ui.js', '/member-browser.js', '/offline.js',
                   '/duties.js', '/calendar.js']) {
    assert.strictEqual(ctx.routeRequest(req(ORIGIN + p)), 'swr', p);
  }
});

test('a cross-origin request is never intercepted, even when its path looks cacheable', () => {
  const { ctx } = loadWorker();
  // Without an origin guard this would match the cache-first rule on pathname
  // alone and let a third-party response into our cache.
  assert.strictEqual(ctx.routeRequest(req('https://elsewhere.test/icons/icon-192.png')), null);
  assert.strictEqual(ctx.routeRequest(req('https://elsewhere.test/design.css')), null);
});

test('a non-GET request is never intercepted', () => {
  const { ctx } = loadWorker();
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    assert.strictEqual(ctx.routeRequest(req(ORIGIN + '/design.css', { method })), null, method);
  }
});

test('a document download is left alone so it opens natively rather than through the cache', () => {
  const { ctx } = loadWorker();
  assert.strictEqual(ctx.routeRequest(req(ORIGIN + '/api/documents/1/file')), null);
});

test('only a real same-origin 200 is allowed into the cache', () => {
  const { ctx } = loadWorker();
  const res = (status, type) => ({ ok: status >= 200 && status < 300, status, type });
  assert.strictEqual(ctx.shouldCache(res(200, 'basic')), true);
  // The one that matters: Railway serves a 502 page while a deploy swaps over.
  // Caching it would pin members to an error page that a refresh cannot clear.
  assert.strictEqual(ctx.shouldCache(res(502, 'basic')), false, 'a 502 must never be cached');
  assert.strictEqual(ctx.shouldCache(res(404, 'basic')), false);
  assert.strictEqual(ctx.shouldCache(res(200, 'opaque')), false, 'an opaque response has an unknown status');
  assert.strictEqual(ctx.shouldCache(res(200, 'opaqueredirect')), false);
  assert.strictEqual(ctx.shouldCache(res(200, 'cors')), false);
});

test('activating a new version deletes every cache from an older one, and nothing else', () => {
  const { ctx } = loadWorker();
  const stale = ctx.staleCaches(
    ['shell-testsha', 'assets-testsha', 'shell-oldsha', 'assets-oldsha', 'some-other-app-cache'],
  );
  assert.deepStrictEqual(stale.sort(), ['assets-oldsha', 'shell-oldsha'],
    'only our own caches from a previous VERSION should be removed');
});


// ── The fetch handler ─────────────────────────────────────────────────────
const shellReq = () => req(ORIGIN + '/', { mode: 'navigate' });
const netRes   = (body, over = {}) => {
  const r = { ok: true, status: 200, type: 'basic', body, ...over };
  r.clone = () => netRes(body, over);   // a real Response body is single-use
  return r;
};
const seedShell = (body) => makeCaches({ ['shell-testsha']: { [ORIGIN + '/']: netRes(body) } });

test('the shell comes from the network when the network answers', async () => {
  const caches = seedShell('stale');
  const { ctx } = loadWorker({ caches, fetchStub: async () => netRes('fresh') });
  const res = await ctx.handleFetch(shellReq(), 'shell', 50);
  assert.strictEqual(res.body, 'fresh');
});

test('a hanging network falls back to the cached shell instead of spinning — the one-bar drill case', async () => {
  const caches = seedShell('cached shell');
  // Never resolves: exactly the condition the timeout exists for. A plain
  // offline check would not catch this, because the request does not reject.
  const { ctx } = loadWorker({ caches, fetchStub: () => new Promise(() => {}) });
  const started = Date.now();
  const res = await ctx.handleFetch(shellReq(), 'shell', 50);
  assert.strictEqual(res.body, 'cached shell');
  assert.ok(Date.now() - started < 2000, 'must give up on the timeout, not hang');
});

test('a Railway 502 mid-deploy serves the cached shell rather than the error page', async () => {
  const caches = seedShell('cached shell');
  const { ctx } = loadWorker({ caches, fetchStub: async () => ({ ok: false, status: 502, type: 'basic', body: '502' }) });
  const res = await ctx.handleFetch(shellReq(), 'shell', 50);
  assert.strictEqual(res.body, 'cached shell', 'a good cached shell beats a fresh error page');
  const stored = await (await caches.open('shell-testsha')).match(ORIGIN + '/');
  assert.strictEqual(stored.body, 'cached shell', 'and the 502 must not overwrite it');
});

test('a cache-first asset is served without touching the network', async () => {
  const caches = makeCaches({ ['assets-testsha']: { [ORIGIN + '/icons/icon-192.png']: netRes('icon') } });
  let called = false;
  const { ctx } = loadWorker({ caches, fetchStub: async () => { called = true; return netRes('net'); } });
  const res = await ctx.handleFetch(req(ORIGIN + '/icons/icon-192.png'), 'cache-first', 50);
  assert.strictEqual(res.body, 'icon');
  assert.strictEqual(called, false, 'a cache hit must not hit the network');
});

test('stale-while-revalidate answers from cache immediately and refreshes behind it', async () => {
  const caches = makeCaches({ ['assets-testsha']: { [ORIGIN + '/design.css']: netRes('old css') } });
  let resolveNet;
  const { ctx } = loadWorker({ caches, fetchStub: () => new Promise((r) => { resolveNet = r; }) });
  const res = await ctx.handleFetch(req(ORIGIN + '/design.css'), 'swr', 50);
  assert.strictEqual(res.body, 'old css', 'the cached copy is returned without waiting');
  resolveNet(netRes('new css'));
  await new Promise((r) => setTimeout(r, 20));
  const stored = await (await caches.open('assets-testsha')).match(ORIGIN + '/design.css');
  assert.strictEqual(stored.body, 'new css', 'and the background revalidation updated the cache');
});


// ── Event wiring ──────────────────────────────────────────────────────────
test('an unrouted request is passed straight through, with respondWith never called', async () => {
  const { handlers } = loadWorker();
  let respondedWith = null;
  handlers.fetch({ request: req(ORIGIN + '/api/tasks'), respondWith: (p) => { respondedWith = p; } });
  assert.strictEqual(respondedWith, null,
    'calling respondWith at all would put the worker in the path of every API call');
});

test('a routed request is answered by the worker', async () => {
  const caches = seedShell('cached');
  const { handlers } = loadWorker({ caches, fetchStub: async () => netRes('fresh') });
  let respondedWith = null;
  handlers.fetch({ request: shellReq(), respondWith: (p) => { respondedWith = p; } });
  assert.ok(respondedWith, 'the shell navigation should be handled');
  assert.strictEqual((await respondedWith).body, 'fresh');
});

test('installing precaches everything the app needs to boot with no signal', async () => {
  const caches = makeCaches();
  const { handlers } = loadWorker({ caches, fetchStub: async () => netRes('x') });
  const waited = [];
  await handlers.install({ waitUntil: (p) => waited.push(p) });
  await Promise.all(waited);
  const shell  = [...caches.__store.get('shell-testsha').keys()];
  const assets = [...caches.__store.get('assets-testsha').keys()];
  assert.deepStrictEqual(shell, [ORIGIN + '/'], 'the shell belongs in the shell cache');
  for (const p of ['/design.css', '/ui.js', '/member-browser.js', '/offline.js',
                   // Without these two the app boots offline from the cached shell
                   // with window.dutiesInit and window.calendarInit undefined, and
                   // People and Calendar render a heading over an empty panel —
                   // no skeleton, no offline note, no error.
                   '/duties.js', '/calendar.js',
                   '/manifest.webmanifest', '/icons/icon-192.png']) {
    assert.ok(assets.includes(ORIGIN + p), `${p} should be precached`);
  }
});

test('activating drops older versions and leaves other origins caches alone', async () => {
  const caches = makeCaches({
    'shell-testsha': {}, 'assets-testsha': {},
    'shell-oldsha': {}, 'assets-oldsha': {}, 'unrelated-cache': {},
  });
  let claimed = false;
  const { ctx, handlers } = loadWorker({ caches });
  ctx.self.clients.claim = async () => { claimed = true; };
  const waited = [];
  await handlers.activate({ waitUntil: (p) => waited.push(p) });
  await Promise.all(waited);
  assert.deepStrictEqual((await caches.keys()).sort(),
    ['assets-testsha', 'shell-testsha', 'unrelated-cache']);
  assert.strictEqual(claimed, true, 'the new worker must take over open pages');
});

test('the worker never caches /sw.js itself, or the kill switch could never reach the device', () => {
  const { ctx } = loadWorker();
  assert.strictEqual(ctx.routeRequest(req(ORIGIN + '/sw.js')), null,
    'a cached worker script would make SW_MODE=kill unreachable — the escape hatch must always come from the network');
});
