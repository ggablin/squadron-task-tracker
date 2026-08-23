// Calendar events — TDY and training rotations. Read through /api/calendar,
// written only by roster admins. Also covers event seed-on-create.
//
// DATABASE_URL must point at the same throwaway Postgres as TEST_DATABASE_URL
// before requiring server.js, since the app builds its pool at module-load time.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const { pool, applySchema, resetDb } = require('./helpers/db');
const events = require('../lib/calendar-events');
const DEFAULTS = require('../data/calendar-events');
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

// Four accounts: the roster admin, a leadership member WITHOUT the capability
// (the twenty-one-versus-two distinction), a supervisor and a plain member.
// must_change_password=false so requireOnboarded never confounds a 403.
async function seed() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);
  const { rows: [{ id: shop }] } = await pool.query(`INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const add = (slug, role, admin) => pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active,
                          must_change_password, can_manage_roster)
     VALUES ($1,'Test','SSgt',$2,$3,$4,$5,true,false,$6) RETURNING id`, [slug, shop, role, slug, hash, admin]);
  const { rows: [admin] } = await add('admintest', 'leadership', true);
  await add('leadtest', 'leadership', false);
  await add('suptest', 'supervisor', false);
  await add('memtest', 'member', false);
  return { adminId: admin.id };
}

const api = (method, path, cookie, body) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('seed-on-create: a fresh table gets the ten rotations exactly once; deleted rows stay deleted', async () => {
  await pool.query('DROP TABLE IF EXISTS calendar_events');
  assert.deepStrictEqual(await events.ensureTable(pool, DEFAULTS), { created: true, seeded: 10 });
  const count = async () => Number((await pool.query('SELECT COUNT(*) FROM calendar_events')).rows[0].count);
  assert.strictEqual(await count(), 10);
  assert.deepStrictEqual(await events.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 10);
  await pool.query(`DELETE FROM calendar_events WHERE title = 'REOTS'`);
  assert.deepStrictEqual(await events.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 9, 'a deleted row never comes back');
  const all = await events.listAll(pool);
  assert.strictEqual(all[0].start_date, '2025-12-07', 'ordered by date, as YYYY-MM-DD strings');
  assert.strictEqual(all[0].status, 'complete');
  const dft = all.find(e => e.title === 'FY26 DFT');
  assert.ok(dft.attendees.includes('A1C Whittingham'), 'the 23-name roster survives the round trip');
});

test('seed-on-create is atomic: a row that fails mid-seed leaves no table behind', async () => {
  await pool.query('DROP TABLE IF EXISTS calendar_events');
  // Second row overflows VARCHAR(120), so the INSERT throws partway through.
  const bad = [{ title: 'RADR', location: null, start: '2026-04-06', end: '2026-04-10',
                 attendees: null, status: 'scheduled', note: null },
               { title: 'x'.repeat(200), location: null, start: '2026-05-03', end: '2026-05-09',
                 attendees: null, status: 'scheduled', note: null }];
  await assert.rejects(() => events.ensureTable(pool, bad));
  const { rows } = await pool.query(`SELECT to_regclass('public.calendar_events') AS t`);
  assert.strictEqual(rows[0].t, null,
    'the table must roll back with the failed seed, or the next boot skips it forever');
  // A clean run afterwards still works, and seeds in full.
  assert.deepStrictEqual(await events.ensureTable(pool, DEFAULTS), { created: true, seeded: 10 });
  assert.strictEqual(
    Number((await pool.query('SELECT COUNT(*) FROM calendar_events')).rows[0].count), 10);
});
