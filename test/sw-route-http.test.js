// The /sw.js route, and the kill switch that is the only way to retire a
// service worker already installed on members' phones.
//
// Everything else in this app rolls back with a git revert. A service worker
// does not — it lives on the device, independent of the server. SW_MODE=kill is
// the escape hatch, and an escape hatch nobody has tested is not an escape
// hatch. This is the automated half of plan 12.8; the other half is rehearsing
// it on staging against a real device before production ever gets a caching
// worker.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');

const app = require('../server');

let server, baseUrl;

test.before(async () => {
  await new Promise((res, rej) => {
    server = app.listen(0, (e) => (e ? rej(e) : res()));
    server.on('error', rej);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  delete process.env.SW_MODE;
  await new Promise((r) => server.close(r));
});

const getSw = async () => {
  const res = await fetch(`${baseUrl}/sw.js`);
  return { res, body: await res.text() };
};

test('the worker is served as javascript that no cache may keep', async () => {
  delete process.env.SW_MODE;
  const { res } = await getSw();
  assert.strictEqual(res.status, 200);
  // The handoff's warning applies: this app answers 200 with text/html for any
  // unmatched path, so the status alone proves nothing. The content-type is the
  // real assertion.
  assert.match(res.headers.get('content-type'), /application\/javascript/);
  assert.match(res.headers.get('cache-control'), /no-store/);
});

test('every deploy serves a byte-different worker, so devices pick up the new one', async () => {
  delete process.env.SW_MODE;
  const { body } = await getSw();
  assert.match(body.split('\n')[0], /^const VERSION = ".+";$/,
    'the route prepends a VERSION line; without it the cache names never rotate');
});

test('normally the real worker is served, caching and all', async () => {
  delete process.env.SW_MODE;
  const { body } = await getSw();
  assert.ok(/addEventListener\('fetch'/.test(body), 'the caching worker handles fetch');
  assert.ok(/addEventListener\('push'/.test(body), 'and still handles push');
  assert.ok(!/registration\.unregister\(\)/.test(body), 'and is not the self-destruct script');
});

test('SW_MODE=kill swaps in a worker that removes itself, its caches, and the pages it controls', async () => {
  process.env.SW_MODE = 'kill';
  const { res, body } = await getSw();
  assert.match(res.headers.get('content-type'), /application\/javascript/);
  assert.ok(/registration\.unregister\(\)/.test(body), 'it must unregister itself');
  // unregister() alone leaves the caches behind, and a stale cache with no
  // worker to clear it is exactly what the switch exists to escape.
  assert.ok(/caches\.delete/.test(body), 'it must delete the caches too');
  assert.ok(/\.navigate\(/.test(body), 'and reload open pages so the member is not left on the old shell');
  assert.ok(!/addEventListener\('fetch'/.test(body),
    'the kill worker must never intercept anything');
});

test('the switch is a variable flip, reversible without a deploy of new code', async () => {
  process.env.SW_MODE = 'kill';
  assert.ok(/registration\.unregister\(\)/.test((await getSw()).body));
  delete process.env.SW_MODE;
  const restored = (await getSw()).body;
  assert.ok(/addEventListener\('fetch'/.test(restored),
    'unsetting the variable must bring the real worker straight back');
});
