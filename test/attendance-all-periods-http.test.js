// HTTP coverage for the all_periods flag on PUT /api/shop/attendance: one
// write stamps a member's whole drill (the tech-school / on-orders case), it
// overwrites periods already marked, it respects the cycle's period count, and
// the ordinary one-period write is untouched by the new flag.
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
  // The boot migration takes AccessExclusive locks and is fire-and-forget;
  // let it finish before applySchema() or the seed can collide with it.
  await app.ready;
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

// A three-day drill: six periods, so "all" is visibly more than the default 4.
async function seedWorld() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);

  const { rows: [{ id: shop }] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [{ id: otherShop }] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('HVAC') RETURNING id`);
  const { rows: [{ id: live }] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current, start_date, end_date, period_count)
     VALUES ('Sep 2026','live',true,'2026-09-11','2026-09-13',6) RETURNING id`);

  const member = async (slug, role, shopId) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug,
                            password_hash, active, must_change_password)
       VALUES ($1,'Test','SrA',$2,$3,$4,$5,true,false) RETURNING id`,
      [slug, shopId, role, slug, hash]);
    return id;
  };
  const armena = await member('armena', 'member', shop);
  const becerra = await member('becerra', 'member', shop);
  const outsider = await member('outsider', 'member', otherShop);
  await member('suptest', 'supervisor', shop);

  return { live, shop, armena, becerra, outsider };
}

const cells = (cycle, member) => pool.query(
  `SELECT period, status, note FROM attendance
   WHERE uta_cycle_id = $1 AND member_id = $2 ORDER BY period`, [cycle, member]);

test('all_periods stamps every period of the drill with one status and note', async () => {
  const w = await seedWorld();
  const cookie = await login('suptest');

  const res = await api('PUT', '/api/shop/attendance', cookie, {
    member_id: w.armena, period: 3, status: 'agr_at_orders', note: 'tech school', all_periods: true,
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.rows), 'whole-drill write answers with a rows array');
  assert.deepStrictEqual(body.rows.map(r => r.period).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);

  const { rows } = await cells(w.live, w.armena);
  assert.strictEqual(rows.length, 6);
  assert.ok(rows.every(r => r.status === 'agr_at_orders' && r.note === 'tech school'));

  // Coverage reflects the six cells; the other two shop members (Becerra and
  // the supervisor, who is on the roster too) are still unmarked.
  const sheet = await (await api('GET', '/api/shop/attendance', cookie)).json();
  assert.deepStrictEqual(sheet.coverage, { marked: 6, total: 18 });
});

test('all_periods overwrites periods that were already marked', async () => {
  const w = await seedWorld();
  const cookie = await login('suptest');

  // Period 1 was marked present before word came that the member is on orders.
  let res = await api('PUT', '/api/shop/attendance', cookie, {
    member_id: w.becerra, period: 1, status: 'present',
  });
  assert.strictEqual(res.status, 200);

  res = await api('PUT', '/api/shop/attendance', cookie, {
    member_id: w.becerra, period: 1, status: 'agr_at_orders', all_periods: true,
  });
  assert.strictEqual(res.status, 200);

  const { rows } = await cells(w.live, w.becerra);
  assert.strictEqual(rows.length, 6);
  assert.ok(rows.every(r => r.status === 'agr_at_orders'), 'period 1 is overwritten, not skipped');
});

test('without the flag a write still touches exactly one period, and the flag must be boolean true', async () => {
  const w = await seedWorld();
  const cookie = await login('suptest');

  // A truthy-but-not-true value is ignored: "all" must be a deliberate choice.
  const res = await api('PUT', '/api/shop/attendance', cookie, {
    member_id: w.armena, period: 2, status: 'ruta_excused', all_periods: 'yes',
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.period, 2, 'single-period response shape is unchanged');

  const { rows } = await cells(w.live, w.armena);
  assert.deepStrictEqual(rows.map(r => r.period), [2]);
});

test('all_periods is still fenced to the supervisor\'s own shop', async () => {
  const w = await seedWorld();
  const cookie = await login('suptest');

  const res = await api('PUT', '/api/shop/attendance', cookie, {
    member_id: w.outsider, period: 1, status: 'agr_at_orders', all_periods: true,
  });
  assert.strictEqual(res.status, 403);
  const { rows } = await cells(w.live, w.outsider);
  assert.strictEqual(rows.length, 0);
});

test('all_periods on an archived cycle is refused', async () => {
  const w = await seedWorld();
  await pool.query(`UPDATE uta_cycles SET status = 'archived' WHERE id = $1`, [w.live]);
  const cookie = await login('suptest');

  const res = await api('PUT', '/api/shop/attendance', cookie, {
    member_id: w.armena, period: 1, status: 'agr_at_orders', all_periods: true,
  });
  assert.strictEqual(res.status, 403);
});
