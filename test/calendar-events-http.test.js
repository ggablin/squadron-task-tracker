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
  // Requiring server.js above kicked off its boot migration, which creates and
  // seeds calendar_events. This file drops and re-creates that table with raw
  // DDL, which takes no lock, so the boot has to be finished — not merely
  // ordered against applySchema() — before any of it runs.
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

const RADR = { title: 'RADR', location: 'Fargo, ND', start_date: '2026-05-03',
               end_date: '2026-05-09', attendees: 'MSgt Brown', status: 'scheduled', note: null };

test('signed out: every event route is 401', async () => {
  await seed();
  for (const [m, p] of [['POST', '/api/calendar-events'], ['PATCH', '/api/calendar-events/1'],
                        ['DELETE', '/api/calendar-events/1']]) {
    assert.strictEqual((await api(m, p, null, {})).status, 401, `${m} ${p}`);
  }
});

test('403 matrix: member, supervisor and leadership-without-the-capability cannot write', async () => {
  await seed();
  for (const slug of ['memtest', 'suptest', 'leadtest']) {
    const cookie = await login(slug);
    for (const [m, p] of [['POST', '/api/calendar-events'], ['PATCH', '/api/calendar-events/1'],
                          ['DELETE', '/api/calendar-events/1']]) {
      assert.strictEqual((await api(m, p, cookie, RADR)).status, 403, `${slug} ${m} ${p}`);
    }
  }
});

test('admin CRUD round-trip; status defaults to scheduled; updated_by stamped', async () => {
  const { adminId } = await seed();
  const admin = await login('admintest');

  let res = await api('POST', '/api/calendar-events', admin,
    { title: '  RADR  ', location: 'Fargo, ND', start_date: '2026-05-03', end_date: '2026-05-09',
      attendees: ' MSgt Brown ', note: '' });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.deepStrictEqual(created, { id: created.id, title: 'RADR', location: 'Fargo, ND',
    start_date: '2026-05-03', end_date: '2026-05-09', attendees: 'MSgt Brown',
    status: 'scheduled', note: null });

  // A one-field PATCH keeps everything else, because the route merges over the row.
  res = await api('PATCH', `/api/calendar-events/${created.id}`, admin, { status: 'complete' });
  assert.strictEqual(res.status, 200);
  const patched = await res.json();
  assert.strictEqual(patched.status, 'complete');
  assert.strictEqual(patched.title, 'RADR');
  assert.strictEqual(patched.attendees, 'MSgt Brown');
  const { rows: [row] } = await pool.query('SELECT updated_by_id FROM calendar_events WHERE id = $1', [created.id]);
  assert.strictEqual(row.updated_by_id, adminId);

  // Events may overlap each other and a drill, unlike drills.
  assert.strictEqual((await api('POST', '/api/calendar-events', admin, RADR)).status, 201);
  assert.strictEqual((await api('POST', '/api/drill-dates', admin,
    { start_date: '2026-05-01', end_date: '2026-05-03', note: null })).status, 201);

  assert.strictEqual((await api('DELETE', `/api/calendar-events/${created.id}`, admin)).status, 204);
  assert.strictEqual((await api('PATCH', `/api/calendar-events/${created.id}`, admin, { status: 'complete' })).status, 404);
  assert.strictEqual((await api('DELETE', `/api/calendar-events/${created.id}`, admin)).status, 404);
  assert.strictEqual((await api('DELETE', '/api/calendar-events/abc', admin)).status, 400);
});

test('400s: missing title, bad status, end before start, over-long attendees', async () => {
  await seed();
  const admin = await login('admintest');
  const bad = async (body) => {
    const r = await api('POST', '/api/calendar-events', admin, body);
    assert.strictEqual(r.status, 400, JSON.stringify(body).slice(0, 80));
    return (await r.json()).error;
  };
  assert.match(await bad({ ...RADR, title: '  ' }), /title is required/);
  assert.match(await bad({ ...RADR, title: 'x'.repeat(121) }), /120/);
  assert.match(await bad({ ...RADR, status: 'pending' }), /status must be one of/);
  assert.match(await bad({ ...RADR, start_date: '2026-13-01' }), /start_date/);
  assert.match(await bad({ ...RADR, end_date: '2026-05-01' }), /before/);
  assert.match(await bad({ ...RADR, attendees: 'x'.repeat(601) }), /600/);
  assert.match(await bad({ ...RADR, note: 'x'.repeat(201) }), /200/);
});

test('validate rejects an impossible date instead of throwing', () => {
  assert.strictEqual(events.validate({ ...RADR, start_date: '2026-13-01' }).ok, false);
  assert.strictEqual(events.validate({ ...RADR, end_date: '2026-02-30' }).ok, false);
});

test('a fortnight-long event is accepted — the seven-day cap is a drill rule', async () => {
  await seed();
  const admin = await login('admintest');
  const res = await api('POST', '/api/calendar-events', admin,
    { ...RADR, title: 'FY26 DFT', start_date: '2026-06-15', end_date: '2026-06-29' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual((await res.json()).end_date, '2026-06-29');
});
