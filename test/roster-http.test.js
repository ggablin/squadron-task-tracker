// Regression coverage for the roster-management spec's single most important
// claim (spec §12): "every /api/roster/* endpoint rejects a `leadership`
// session without the flag, confirming the twenty-one-versus-two distinction
// actually holds." Before this file, that claim was verified only by reading
// requireRosterAdmin, never by driving a real request through it — a
// role='leadership' session (twenty-one people) clears requireRole
// ('leadership') easily, and only requireRosterAdmin's separate
// can_manage_roster check (two people) is supposed to stop it.
//
// This also doubles as the regression test for the live-session fix
// (requireRosterAdmin now re-reads can_manage_roster/active from the database
// on every request instead of trusting req.session.canManageRoster, which was
// set once at login and good for a 30-day cookie): granting or revoking the
// flag mid-test, on the SAME session with no re-login, must change the
// outcome on the very next request.
//
// DATABASE_URL must be set to the same throwaway Postgres as
// TEST_DATABASE_URL before requiring server.js, since the app builds its own
// connection pool from DATABASE_URL at module-load time.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const { pool, applySchema, resetDb } = require('./helpers/db');
const app = require('../server');

let server, baseUrl;

test.before(async () => {
  await applySchema();
  await new Promise((resolve, reject) => {
    server = app.listen(0, (err) => (err ? reject(err) : resolve()));
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

// Node's fetch (undici) exposes getSetCookie() for the multi-Set-Cookie-safe
// read; fall back to the single-header form for older runtimes.
function cookieFrom(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  if (!cookies.length) return null;
  return cookies[0].split(';')[0];
}

async function login(slug, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, password }),
  });
  assert.strictEqual(res.status, 200, `login as ${slug} should succeed`);
  const cookie = cookieFrom(res);
  assert.ok(cookie, 'login should set a session cookie');
  return cookie;
}

// The five endpoints spec §8 defines under /api/roster/*.
const ROSTER_ENDPOINTS = (id) => ([
  { method: 'GET',    path: '/api/roster' },
  { method: 'POST',   path: '/api/roster/members' },
  { method: 'PATCH',  path: `/api/roster/members/${id}` },
  { method: 'DELETE', path: `/api/roster/members/${id}` },
  { method: 'PATCH',  path: `/api/roster/members/${id}/admin` },
]);

async function hitRosterEndpoints(id, cookie) {
  const results = [];
  for (const { method, path } of ROSTER_ENDPOINTS(id)) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: method === 'GET' ? undefined : JSON.stringify({}),
    });
    results.push({ method, path, status: res.status });
  }
  return results;
}

test('every /api/roster/* endpoint 403s a leadership session without can_manage_roster; granting or revoking the flag takes effect on that same live session', async () => {
  await resetDb();
  const { rows: [shop] } = await pool.query(`INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const hash = await bcrypt.hash('leadpass123', 10);
  // must_change_password: false so requireOnboarded never confounds the
  // can_manage_roster assertions below — it also runs after requireRosterAdmin
  // on every mutating route and would otherwise 403 for a different reason.
  const { rows: [leader] } = await pool.query(
    `INSERT INTO members
       (last_name, first_name, rank, shop_id, role, slug, password_hash, active, can_manage_roster, must_change_password)
     VALUES ('Leader','Lee','MSgt',$1,'leadership','ldrtest',$2,true,false,false)
     RETURNING id`,
    [shop.id, hash]);

  const cookie = await login('ldrtest', 'leadpass123');

  // Phase 1: role='leadership' clears requireRole('leadership') easily, but
  // can_manage_roster is false — every roster endpoint must still 403.
  for (const r of await hitRosterEndpoints(leader.id, cookie)) {
    assert.strictEqual(r.status, 403, `${r.method} ${r.path} should 403 without can_manage_roster`);
  }

  // Phase 2: grant directly in the database — no re-login. The gate must
  // notice on the very next request, not wait for a fresh session/cookie.
  await pool.query(`UPDATE members SET can_manage_roster = true WHERE id = $1`, [leader.id]);
  for (const r of await hitRosterEndpoints(leader.id, cookie)) {
    assert.notStrictEqual(r.status, 403,
      `${r.method} ${r.path} should no longer 403 once granted (same session, no re-login)`);
  }

  // Phase 3: revoke again, same session still live. This is the literal
  // IMPORTANT-1 bug report: a revoked admin used to keep full roster control,
  // including granting the capability back to themselves, for the life of the
  // 30-day session cookie, because the old gate only read req.session at login.
  await pool.query(`UPDATE members SET can_manage_roster = false WHERE id = $1`, [leader.id]);
  for (const r of await hitRosterEndpoints(leader.id, cookie)) {
    assert.strictEqual(r.status, 403,
      `${r.method} ${r.path} should 403 again once revoked (same session, no re-login)`);
  }
});

test('a malformed :id on a roster mutation route 400s instead of 500ing', async () => {
  await resetDb();
  const { rows: [shop] } = await pool.query(`INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const hash = await bcrypt.hash('adminpass123', 10);
  await pool.query(
    `INSERT INTO members
       (last_name, first_name, rank, shop_id, role, slug, password_hash, active, can_manage_roster, must_change_password)
     VALUES ('Admin','Ada','MSgt',$1,'leadership','admintest',$2,true,true,false)`,
    [shop.id, hash]);
  const cookie = await login('admintest', 'adminpass123');

  for (const { method, path } of [
    { method: 'PATCH',  path: '/api/roster/members/not-a-number' },
    { method: 'DELETE', path: '/api/roster/members/not-a-number' },
    { method: 'PATCH',  path: '/api/roster/members/not-a-number/admin' },
  ]) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400, `${method} ${path} should 400 on a malformed id, not 500`);
  }
});
