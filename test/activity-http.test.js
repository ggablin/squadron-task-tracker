// Coverage for the two claims about /api/activity that can only be proven by
// driving a real request: the scope rule (a supervisor sees their own shop and
// cannot reach another's, leadership sees the squadron) and the field-stripping
// on /api/shop/members (every member can read their shop roster, so `activated`
// and `last_login_at` must be removed for a plain member server-side rather than
// merely hidden by the UI).
//
// Also pins the login side effect: a successful sign-in stamps last_login_at,
// which is the column the whole activity view is built on.
//
// DATABASE_URL must be set to the same throwaway Postgres as TEST_DATABASE_URL
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

function cookieFrom(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return cookies.length ? cookies[0].split(';')[0] : null;
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

const get = (path, cookie) =>
  fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });

const PW = 'testpass123';

// Two shops so "your own shop" is a claim with something to exclude.
async function seedWorld() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);
  const { rows: [{ id: structures }] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [{ id: hvac }] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('HVAC') RETURNING id`);

  // Returns the member id, never the row — every caller below wants an id.
  const add = async (slug, role, shopId, mustChange = false) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug,
                            password_hash, active, must_change_password)
       VALUES ($1,'Test','SSgt',$2,$3,$4,$5,true,$6) RETURNING id`,
      [slug, shopId, role, slug, hash, mustChange]);
    return id;
  };

  return {
    structures, hvac,
    lead:   await add('leadtest', 'leadership', structures),
    sup:    await add('suptest', 'supervisor', structures),
    member: await add('memtest', 'member', structures),
    hvacer: await add('hvactest', 'member', hvac),
  };
}

test('a plain member cannot reach /api/activity at all', async () => {
  await seedWorld();
  const res = await get('/api/activity', await login('memtest', PW));
  assert.strictEqual(res.status, 403);
});

test('an unauthenticated request is rejected before any scope logic', async () => {
  await seedWorld();
  const res = await fetch(`${baseUrl}/api/activity`);
  assert.strictEqual(res.status, 401);
});

test('a supervisor sees their own shop and cannot reach another via ?shop_id', async () => {
  const w = await seedWorld();
  const cookie = await login('suptest', PW);

  const own = await (await get('/api/activity', cookie)).json();
  assert.strictEqual(own.scope, 'shop');
  assert.deepStrictEqual(own.shops.map(s => s.name), ['Structures']);
  assert.ok(!own.members.some(m => m.shop === 'HVAC'));

  // The query param is leadership-only; a supervisor stays pinned regardless.
  const attempted = await (await get(`/api/activity?shop_id=${w.hvac}`, cookie)).json();
  assert.deepStrictEqual(attempted.shops.map(s => s.name), ['Structures']);
  assert.ok(!attempted.members.some(m => m.shop === 'HVAC'));
});

test('leadership sees the whole squadron, and can scope to one shop', async () => {
  const w = await seedWorld();
  const cookie = await login('leadtest', PW);

  const all = await (await get('/api/activity', cookie)).json();
  assert.strictEqual(all.scope, 'squadron');
  assert.strictEqual(all.total, 4);
  assert.deepStrictEqual(all.shops.map(s => s.name).sort(), ['HVAC', 'Structures']);

  const scoped = await (await get(`/api/activity?shop_id=${w.hvac}`, cookie)).json();
  assert.strictEqual(scoped.scope, 'shop');
  assert.strictEqual(scoped.total, 1);
  assert.deepStrictEqual(scoped.shops.map(s => s.name), ['HVAC']);
});

test('a malformed shop_id is rejected rather than silently widening scope', async () => {
  await seedWorld();
  const cookie = await login('leadtest', PW);
  for (const bad of ['abc', '-1', '0']) {
    const res = await get(`/api/activity?shop_id=${bad}`, cookie);
    assert.strictEqual(res.status, 400, `shop_id=${bad} should 400`);
  }
});

test('logging in stamps last_login_at, which is what makes a member "seen"', async () => {
  const w = await seedWorld();
  // Nobody has a recorded login yet; they only have their own passwords set.
  const before = await (await get('/api/activity', await login('leadtest', PW))).json();
  assert.strictEqual(before.members.find(m => m.id === w.sup).state, 'unknown');

  await login('suptest', PW);

  const after = await (await get('/api/activity', await login('leadtest', PW))).json();
  const sup = after.members.find(m => m.id === w.sup);
  assert.strictEqual(sup.state, 'seen');
  assert.ok(sup.last_login_at, 'the sign-in should be recorded');
  assert.ok(after.active30 >= 1);
});

test('/api/shop/members withholds activity fields from a plain member', async () => {
  await seedWorld();

  const asMember = await (await get('/api/shop/members', await login('memtest', PW))).json();
  assert.ok(asMember.length > 0);
  for (const r of asMember) {
    assert.ok(!('activated' in r), 'a plain member must not receive activated');
    assert.ok(!('last_login_at' in r), 'a plain member must not receive last_login_at');
  }

  // Same endpoint, same shop — a supervisor does get them.
  const asSup = await (await get('/api/shop/members', await login('suptest', PW))).json();
  assert.ok(asSup.every(r => 'activated' in r && 'last_login_at' in r));
});
