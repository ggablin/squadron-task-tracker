// requireOnboarded coverage. This middleware is what stops a member who has
// never set a password beyond the default (see reset-default-passwords.js)
// from writing anything — and nothing else in the suite exercises it. Every
// fixture across every other *-http.test.js file inserts
// must_change_password = false (activity-http.test.js even has a mustChange
// parameter that is never passed true), so deleting requireOnboarded from all
// 52 route definitions it guards would leave the whole suite green.
//
// One fixture member — role='leadership', can_manage_roster=true, active=true
// — is built to clear every OTHER gate on every route exercised below:
// requireRole('supervisor'), requireRole('leadership'), requireRosterAdmin
// and requireWorkOrderWriter all wave a leadership, roster-admin member
// through without looking at must_change_password. That member also has
// must_change_password=true, which is the one thing that's supposed to stop
// it. So the 403 each assertion checks for can only be coming from
// requireOnboarded — not from an earlier gate in the chain rejecting the
// member for an unrelated reason.
//
// That distinction is the actual trap: requireRosterAdmin sits *before*
// requireOnboarded on write routes and also answers 403, but with a different
// message ('Forbidden'). A fixture that instead failed requireRosterAdmin
// would turn a status-only assertion green for the wrong reason, on every
// route it guards. Asserting on the response body's error message (not just
// the status) is what rules that out — see the shared ONBOARD_MSG constant
// below.
//
// Five routes, one per distinct middleware shape that sits in front of
// requireOnboarded on a write route — not all 52 (per the "you don't need all
// of them" guidance), but enough that every *kind* of gate ahead of it is
// represented once:
//   - requireAuth only            → PUT  /api/tasks/:id
//   - requireRole('supervisor')   → PUT  /api/shop/attendance
//   - requireRole('leadership')   → POST /api/squadron/tasks
//   - requireRosterAdmin          → POST /api/duties       (the trap route)
//   - requireWorkOrderWriter      → POST /api/shop/events
//
// Each body is deliberately empty: requireOnboarded runs before any handler
// looks at req.body, so an empty body still reaches it. That's also what
// makes a manual "delete requireOnboarded and re-run" check clean — without
// the gate, each of these routes fails its own validation on a real task id it
// doesn't hold or a required field it wasn't given (a 400 or 404), rather than
// happening to succeed outright.
//
// DATABASE_URL must point at the same throwaway Postgres as TEST_DATABASE_URL
// before requiring server.js, since the app builds its pool at module-load time.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const { pool, applySchema, resetDb } = require('./helpers/db');
const app = require('../server');

let server, baseUrl;

test.before(async () => {
  // Requiring server.js above kicked off its boot migration (which, among
  // other things, seeds additional_duties — one of the tables this file
  // writes to via POST /api/duties). Wait for it to finish before applying
  // schema.sql on a second connection, same as duties-http.test.js.
  await app.ready;
  await applySchema();
  await new Promise((resolve, reject) => {
    server = app.listen(0, err => (err ? reject(err) : resolve()));
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { await new Promise(r => server.close(r)); });

function cookieFrom(res) {
  const c = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return c.length ? c[0].split(';')[0] : null;
}

const PW = 'testpass123';

async function login(slug) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, password: PW }),
  });
  assert.strictEqual(res.status, 200, `login as ${slug} should succeed`);
  return cookieFrom(res);
}

const api = (method, path, cookie, body) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Leadership + roster-admin, so it clears requireRole('supervisor'),
// requireRole('leadership'), requireRosterAdmin and requireWorkOrderWriter —
// every gate that sits in front of requireOnboarded on the routes exercised
// below. must_change_password=true (a fresh default-password account, per
// reset-default-passwords.js) is the one thing left that's supposed to block
// it.
async function seed() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);
  const { rows: [{ id: shop }] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active,
                          must_change_password, can_manage_roster)
     VALUES ('Newkid','Test','AB',$1,'leadership','onboardtest',$2,true,true,true)`,
    [shop, hash]);
}

const ONBOARD_MSG = 'You must change your password before continuing';

test('requireOnboarded blocks a never-changed-password member on one write per gate family', async () => {
  await seed();
  const cookie = await login('onboardtest');

  const routes = [
    ['PUT',  '/api/tasks/999999',    {}, "requireAuth only"],
    ['PUT',  '/api/shop/attendance', {}, "requireRole('supervisor')"],
    ['POST', '/api/squadron/tasks',  {}, "requireRole('leadership')"],
    ['POST', '/api/duties',          {}, 'requireRosterAdmin (the Item 2 trap route)'],
    ['POST', '/api/shop/events',     {}, 'requireWorkOrderWriter'],
  ];

  for (const [method, path, body, why] of routes) {
    const res = await api(method, path, cookie, body);
    assert.strictEqual(res.status, 403,
      `${method} ${path} (${why}) should be blocked by requireOnboarded`);
    const json = await res.json();
    // The message, not just the status, is what proves this 403 came from
    // requireOnboarded rather than from an earlier gate (in particular
    // requireRosterAdmin's own 403, 'Forbidden') answering for an unrelated
    // reason — the exact trap the fixture above is built to avoid.
    assert.strictEqual(json.error, ONBOARD_MSG,
      `${method} ${path} (${why}) — 403 came from the wrong gate`);
  }
});
