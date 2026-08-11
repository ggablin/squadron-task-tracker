// The app is a ~400KB single-file SPA served to phones on base wifi; Express
// doesn't compress by default and Railway's proxy doesn't add it either, so
// the compression middleware is the only thing standing between members and
// the full uncompressed payload. This pins that it stays wired up.
//
// DATABASE_URL must be set to the same throwaway Postgres as TEST_DATABASE_URL
// before requiring server.js, since the app builds its pool at module-load time.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const { applySchema } = require('./helpers/db');
const app = require('../server');

let server, baseUrl;

test.before(async () => {
  await applySchema();
  await new Promise((resolve, reject) => {
    server = app.listen(0, err => (err ? reject(err) : resolve()));
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('the SPA goes out gzipped to a client that accepts it', async () => {
  const res = await fetch(`${baseUrl}/`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-encoding'), 'gzip');
  // fetch transparently decompresses; prove the body is still the real page.
  const body = await res.text();
  assert.ok(body.includes('108th CES'), 'decompressed body should be the app shell');
  assert.ok(body.length > 100_000, `expected the full SPA, got ${body.length} bytes`);
});

test('a client that does not accept gzip still gets the page, uncompressed', async () => {
  const res = await fetch(`${baseUrl}/`, { headers: { 'Accept-Encoding': 'identity' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-encoding'), null);
  assert.ok((await res.text()).includes('108th CES'));
});
