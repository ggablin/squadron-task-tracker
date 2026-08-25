// A rejected async route handler must produce a RESPONSE, not a hang.
//
// On stock Express 4 an `async` handler that throws returns a rejected promise
// that nothing is listening to: the router ignores the return value, no error
// middleware runs, and the socket is simply never written to. The request hangs
// until the client gives up. This is not a theoretical failure — it already
// happened here. lib/calendar-events.js validated a date by round-tripping
// through toISOString(), '2026-13-01' made that throw, the throw escaped
// POST /api/calendar-events (which calls validate OUTSIDE its try, as every
// write route on this branch still does), and a test sat for 305 SECONDS
// instead of failing.
//
// server.js now requires express-async-errors, which patches the Express 4
// router to forward such a rejection to the error middleware at the bottom of
// server.js. These tests fail — by timing out rather than by asserting — if that
// require is ever removed.
//
// DATABASE_URL must point at the same throwaway Postgres as TEST_DATABASE_URL
// before requiring server.js, since the app builds its pool at module-load time.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const express = require('express');
const { pool, applySchema, resetDb } = require('./helpers/db');
const calEvents = require('../lib/calendar-events');
// Requiring server.js is what applies the express-async-errors patch. This file
// deliberately never requires express-async-errors itself — otherwise it would
// prove only that the library works, not that the app actually wires it in.
const app = require('../server');

let server, baseUrl;

// A short ceiling on every request. The whole point is that these paths used to
// hang, so "no response" has to fail in seconds rather than stall the suite.
const TIMEOUT_MS = 5000;

test.before(async () => {
  await app.ready;
  await applySchema();
  await new Promise((resolve, reject) => {
    server = app.listen(0, err => (err ? reject(err) : resolve()));
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { await new Promise(r => server.close(r)); });

const PW = 'testpass123';

async function seedAdmin() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);
  const { rows: [{ id: shop }] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash,
                          active, must_change_password, can_manage_roster)
     VALUES ('admintest','Test','SSgt',$1,'leadership','admintest',$2,true,false,true)`,
    [shop, hash]);
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'admintest', password: PW }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  assert.strictEqual(res.status, 200, 'login as the roster admin should succeed');
  const c = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return c.length ? c[0].split(';')[0] : null;
}

// Turns a hang into a readable failure instead of an opaque AbortError.
async function fetchOrFail(url, opts, what) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      assert.fail(
        `${what} never responded within ${TIMEOUT_MS}ms — the rejected handler was ` +
        `swallowed. Is require('express-async-errors') still at the top of server.js?`);
    }
    throw err;
  }
}

// The real production route, failing the real production way: a throw out of
// calEvents.validate(), which server.js calls before entering its try block.
// Nothing in server.js or lib/ is modified — only the module export the route
// already reaches through, restored immediately afterwards.
test('a throw from validate() outside a route try still answers the request', async () => {
  const cookie = await seedAdmin();
  const original = calEvents.validate;
  const boom = new Error('validate blew up the way toISOString() once did');
  calEvents.validate = () => { throw boom; };
  try {
    const res = await fetchOrFail(`${baseUrl}/api/calendar-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'RADR', start_date: '2026-13-01', end_date: '2026-13-02' }),
    }, 'POST /api/calendar-events with a throwing validate()');

    assert.strictEqual(res.status, 500, 'the rejection must reach the error middleware as a 500');
    assert.match(res.headers.get('content-type') || '', /application\/json/,
      'server.js error middleware answers JSON, so fetch().json() gets a real status not a SyntaxError');
    assert.deepStrictEqual(await res.json(), { error: 'Server error' });
  } finally {
    calEvents.validate = original;
  }
});

// Control: with validate restored, the same route behaves exactly as before.
// Without this, a patch that broke the route outright would still pass above.
test('the patch leaves the normal request path untouched', async () => {
  const cookie = await seedAdmin();
  const bad = await fetchOrFail(`${baseUrl}/api/calendar-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: 'RADR', start_date: '2026-13-01', end_date: '2026-13-02' }),
  }, 'POST /api/calendar-events with an impossible date');
  assert.strictEqual(bad.status, 400, 'an impossible date is still a clean 400, not a 500');
  assert.deepStrictEqual(await bad.json(),
    { error: 'start_date must be a real YYYY-MM-DD date' });

  const ok = await fetchOrFail(`${baseUrl}/api/calendar-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: 'RADR', start_date: '2026-04-06', end_date: '2026-04-10' }),
  }, 'POST /api/calendar-events with a valid body');
  assert.strictEqual(ok.status, 201, 'a valid event is still created');
  const body = await ok.json();
  assert.strictEqual(body.start_date, '2026-04-06');
});

// The post-await case, which the route above cannot reach: a handler that
// rejects from a microtask after it has already yielded. Mounted on a throwaway
// app rather than the real one, because server.js's /api/* 404 and SPA
// catch-alls sit after every route and would shadow anything added later.
//
// This still exercises the app's wiring: express-async-errors patches Express's
// router prototype process-wide, and requiring ../server above is the only
// thing in this file that applies it.
test('a rejection after an await reaches error middleware, on any Express 4 router', async () => {
  const probe = express();
  probe.get('/late-throw', async () => {
    await new Promise(r => setImmediate(r));
    throw new Error('rejected after yielding to the event loop');
  });
  probe.use((err, req, res, next) => {  // eslint-disable-line no-unused-vars
    res.status(500).json({ error: 'Server error', caught: err.message });
  });

  const probeServer = await new Promise((resolve, reject) => {
    const s = probe.listen(0, err => (err ? reject(err) : resolve(s)));
    s.on('error', reject);
  });
  try {
    const url = `http://127.0.0.1:${probeServer.address().port}/late-throw`;
    const res = await fetchOrFail(url, {}, 'GET /late-throw');
    assert.strictEqual(res.status, 500);
    assert.deepStrictEqual(await res.json(),
      { error: 'Server error', caught: 'rejected after yielding to the event loop' });
  } finally {
    await new Promise(r => probeServer.close(r));
  }
});
