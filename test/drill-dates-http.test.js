// The calendar: drill dates and the merged year view. Read by every signed-in
// member, written only by roster admins. Also covers drill seed-on-create.
//
// DATABASE_URL must point at the same throwaway Postgres as TEST_DATABASE_URL
// before requiring server.js, since the app builds its pool at module-load time.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const { pool, applySchema, resetDb } = require('./helpers/db');
const cal = require('../lib/drill-calendar');
const DEFAULTS = require('../data/drill-dates');
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

test('seed-on-create: a fresh table gets the ten 2026 drills exactly once; deleted rows stay deleted', async () => {
  await pool.query('DROP TABLE IF EXISTS drill_dates');
  assert.deepStrictEqual(await cal.ensureTable(pool, DEFAULTS), { created: true, seeded: 10 });
  const count = async () => Number((await pool.query('SELECT COUNT(*) FROM drill_dates')).rows[0].count);
  assert.strictEqual(await count(), 10);
  assert.deepStrictEqual(await cal.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 10);
  await pool.query(`DELETE FROM drill_dates WHERE start_date = DATE '2026-08-08'`);
  assert.deepStrictEqual(await cal.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 9, 'a deleted row never comes back');
  const all = await cal.listAll(pool);
  assert.strictEqual(all[0].start_date, '2026-01-31', 'dates come back as YYYY-MM-DD strings');
  assert.strictEqual(all[0].note, 'Jan & Feb combined');
});

test('seed-on-create is atomic: a row that fails mid-seed leaves no table behind', async () => {
  await pool.query('DROP TABLE IF EXISTS drill_dates');
  // Second row ends before it starts, violating the table's own CHECK, so the
  // INSERT throws partway through.
  const bad = [{ start: '2026-01-15', end: '2026-01-16', note: null },
               { start: '2026-03-06', end: '2026-03-01', note: null }];
  await assert.rejects(() => cal.ensureTable(pool, bad));
  const { rows } = await pool.query(`SELECT to_regclass('public.drill_dates') AS t`);
  assert.strictEqual(rows[0].t, null,
    'the table must roll back with the failed seed, or the next boot skips it forever');
  // A clean run afterwards still works, and seeds in full.
  assert.deepStrictEqual(await cal.ensureTable(pool, DEFAULTS), { created: true, seeded: 10 });
  assert.strictEqual(
    Number((await pool.query('SELECT COUNT(*) FROM drill_dates')).rows[0].count), 10);
});

const SEP = { start_date: '2026-09-11', end_date: '2026-09-13', note: null };

test('signed out: the calendar and every drill route is 401', async () => {
  await seed();
  for (const [m, p] of [['GET', '/api/calendar'], ['POST', '/api/drill-dates'],
                        ['PATCH', '/api/drill-dates/1'], ['DELETE', '/api/drill-dates/1']]) {
    // fetch refuses a GET that carries a body, so only the writes get one.
    const body = m === 'GET' ? undefined : {};
    assert.strictEqual((await api(m, p, null, body)).status, 401, `${m} ${p}`);
  }
});

test('403 matrix: member, supervisor and leadership-without-the-capability cannot write; all can read', async () => {
  await seed();
  for (const slug of ['memtest', 'suptest', 'leadtest']) {
    const cookie = await login(slug);
    assert.strictEqual((await api('GET', '/api/calendar', cookie)).status, 200, `${slug} can read`);
    for (const [m, p] of [['POST', '/api/drill-dates'], ['PATCH', '/api/drill-dates/1'],
                          ['DELETE', '/api/drill-dates/1']]) {
      assert.strictEqual((await api(m, p, cookie, SEP)).status, 403, `${slug} ${m} ${p}`);
    }
  }
});

test('GET /api/calendar: twelve months, drills and events together, years across both tables', async () => {
  await seed();
  const admin = await login('admintest');
  for (const d of [SEP, { start_date: '2026-08-08', end_date: '2026-08-09', note: null }]) {
    assert.strictEqual((await api('POST', '/api/drill-dates', admin, d)).status, 201);
  }
  await pool.query(
    `INSERT INTO calendar_events (title, location, start_date, end_date, attendees, status)
     VALUES ('RADR','Fargo, ND',DATE '2026-09-20',DATE '2026-09-26','MSgt Brown','scheduled'),
            ('Silver Flag','Tyndall AFB, FL',DATE '2025-11-03',DATE '2025-11-09','TSgt Price','complete')`);

  const member = await login('memtest');
  let body = await (await api('GET', '/api/calendar?year=2026', member)).json();
  assert.strictEqual(body.year, 2026);
  assert.deepStrictEqual(body.years, [2025, 2026], 'years spans drills and events');
  assert.strictEqual(body.months.length, 12);
  const sep = body.months.find(m => m.month === 9);
  assert.strictEqual(sep.noUta, false);
  assert.deepStrictEqual(sep.entries.map(e => [e.kind, e.label]),
    [['drill', '11–13 Sep'], ['event', '20–26 Sep']]);
  assert.strictEqual(body.months.find(m => m.month === 7).noUta, true);
  assert.strictEqual(body.months.filter(m => m.noUta).length, 10, 'only Aug and Sep have drills');

  body = await (await api('GET', '/api/calendar?year=2025', member)).json();
  assert.strictEqual(body.months.flatMap(m => m.entries).length, 1);
  assert.ok(body.months.every(m => m.noUta), '2025 has events but no drills');

  for (const bad of ['abc', '99', '1999', '2101']) {
    assert.strictEqual((await api('GET', `/api/calendar?year=${bad}`, member)).status, 400, `year=${bad}`);
  }
  const dflt = await (await api('GET', '/api/calendar', member)).json();
  assert.strictEqual(dflt.year, new Date().getUTCFullYear(), 'defaults to the current year');
});

test('admin drill CRUD round-trip with updated_by stamped; 404 on unknown ids', async () => {
  const { adminId } = await seed();
  const admin = await login('admintest');
  let res = await api('POST', '/api/drill-dates', admin, { ...SEP, note: '  3-day  ' });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.deepStrictEqual(created,
    { id: created.id, start_date: '2026-09-11', end_date: '2026-09-13', note: '3-day' });

  res = await api('PATCH', `/api/drill-dates/${created.id}`, admin, { end_date: '2026-09-12', note: '' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(),
    { id: created.id, start_date: '2026-09-11', end_date: '2026-09-12', note: null });
  const { rows: [row] } = await pool.query('SELECT updated_by_id FROM drill_dates WHERE id = $1', [created.id]);
  assert.strictEqual(row.updated_by_id, adminId);

  assert.strictEqual((await api('DELETE', `/api/drill-dates/${created.id}`, admin)).status, 204);
  assert.strictEqual((await api('PATCH', `/api/drill-dates/${created.id}`, admin, { note: 'x' })).status, 404);
  assert.strictEqual((await api('DELETE', `/api/drill-dates/${created.id}`, admin)).status, 404);
  assert.strictEqual((await api('DELETE', '/api/drill-dates/abc', admin)).status, 400);
});

test('400s: malformed date, end before start, an eight-day span, an 81-character note', async () => {
  await seed();
  const admin = await login('admintest');
  const bad = async (body) => {
    const r = await api('POST', '/api/drill-dates', admin, body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    return (await r.json()).error;
  };
  assert.match(await bad({ start_date: '9/11/2026', end_date: '2026-09-13' }), /start_date/);
  assert.match(await bad({ start_date: '2026-09-13', end_date: '2026-09-11' }), /before/);
  assert.match(await bad({ start_date: '2026-09-01', end_date: '2026-09-08' }), /seven days/);
  assert.match(await bad({ ...SEP, note: 'x'.repeat(81) }), /80/);
});

test('409: overlapping another drill, on create and on edit; a PATCH never conflicts with itself', async () => {
  await seed();
  const admin = await login('admintest');
  const { id } = await (await api('POST', '/api/drill-dates', admin, SEP)).json();
  const { id: oct } = await (await api('POST', '/api/drill-dates', admin,
    { start_date: '2026-10-17', end_date: '2026-10-18', note: null })).json();

  const dup = await api('POST', '/api/drill-dates', admin,
    { start_date: '2026-09-13', end_date: '2026-09-14', note: null });
  assert.strictEqual(dup.status, 409);
  assert.match((await dup.json()).error, /overlap/i);
  assert.strictEqual((await api('POST', '/api/drill-dates', admin,
    { start_date: '2026-09-14', end_date: '2026-09-15', note: null })).status, 201, 'adjacent is fine');

  assert.strictEqual((await api('PATCH', `/api/drill-dates/${oct}`, admin,
    { start_date: '2026-09-12', end_date: '2026-09-13' })).status, 409, 'editing onto another drill');
  assert.strictEqual((await api('PATCH', `/api/drill-dates/${id}`, admin,
    { end_date: '2026-09-12' })).status, 200, 'shrinking within itself');
});
