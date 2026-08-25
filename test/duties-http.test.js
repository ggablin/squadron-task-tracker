// Additional duties: read by every signed-in member, written only by roster
// admins (the Forms gate). Also covers seed-on-create — the table is loaded from
// data/additional-duties.js only in the boot that creates it, so rows an admin
// deletes never come back.
//
// DATABASE_URL must point at the same throwaway Postgres as TEST_DATABASE_URL
// before requiring server.js, since the app builds its pool at module-load time.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const { pool, applySchema, resetDb } = require('./helpers/db');
const duties = require('../lib/duties');
const DEFAULTS = require('../data/additional-duties');
const app = require('../server');

let server, baseUrl;

test.before(async () => {
  // Requiring server.js above kicked off its boot migration, which creates and
  // seeds additional_duties. This file drops and re-creates that table with raw
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

test('seed-on-create: a fresh table gets the 52 duties exactly once; deleted rows stay deleted', async () => {
  await pool.query('DROP TABLE IF EXISTS additional_duties');
  assert.deepStrictEqual(await duties.ensureTable(pool, DEFAULTS), { created: true, seeded: 52 });
  const count = async () => Number((await pool.query('SELECT COUNT(*) FROM additional_duties')).rows[0].count);
  assert.strictEqual(await count(), 52);

  assert.deepStrictEqual(await duties.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 52, 'a second boot adds nothing');

  await pool.query(`DELETE FROM additional_duties WHERE duty = 'ADUTM'`);
  assert.deepStrictEqual(await duties.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 51, 'a deleted row never comes back');

  const { rows } = await pool.query(
    `SELECT primary_owner, alternate_owner FROM additional_duties WHERE duty = 'Records Management / FARM'`);
  assert.deepStrictEqual(rows[0], { primary_owner: null, alternate_owner: null });
});

test('seed-on-create is atomic: a row that fails mid-seed leaves no table behind', async () => {
  await pool.query('DROP TABLE IF EXISTS additional_duties');
  // Second row overflows VARCHAR(120), so the INSERT throws partway through.
  const bad = [{ duty: 'Lodging Monitor', primary: 'Glikin', alternate: null },
               { duty: 'x'.repeat(200), primary: null, alternate: null }];
  await assert.rejects(() => duties.ensureTable(pool, bad));
  const { rows } = await pool.query(`SELECT to_regclass('public.additional_duties') AS t`);
  assert.strictEqual(rows[0].t, null,
    'the table must roll back with the failed seed, or the next boot skips it forever');
  // A clean run afterwards still works, and seeds in full.
  assert.deepStrictEqual(await duties.ensureTable(pool, DEFAULTS), { created: true, seeded: 52 });
  assert.strictEqual(
    Number((await pool.query('SELECT COUNT(*) FROM additional_duties')).rows[0].count), 52);
});

test('signed out: every duties route is 401', async () => {
  await seed();
  for (const [m, p] of [['GET', '/api/duties'], ['POST', '/api/duties'],
                        ['PATCH', '/api/duties/1'], ['DELETE', '/api/duties/1']]) {
    const body = m === 'GET' ? undefined : {};
    assert.strictEqual((await api(m, p, null, body)).status, 401, `${m} ${p}`);
  }
});

test('403 matrix: member, supervisor and leadership-without-the-capability cannot write; all can read', async () => {
  await seed();
  for (const slug of ['memtest', 'suptest', 'leadtest']) {
    const cookie = await login(slug);
    assert.strictEqual((await api('GET', '/api/duties', cookie)).status, 200, `${slug} can read`);
    for (const [m, p] of [['POST', '/api/duties'], ['PATCH', '/api/duties/1'], ['DELETE', '/api/duties/1']]) {
      assert.strictEqual((await api(m, p, cookie, { duty: 'X' })).status, 403, `${slug} ${m} ${p}`);
    }
  }
});

test('admin CRUD round-trip, ordered case-insensitively, with updated_by stamped', async () => {
  const { adminId } = await seed();
  const admin = await login('admintest');

  let res = await api('POST', '/api/duties', admin,
    { duty: 'Lodging Monitor', primary_owner: ' Glikin ', alternate_owner: '' });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.deepStrictEqual(created,
    { id: created.id, duty: 'Lodging Monitor', primary_owner: 'Glikin', alternate_owner: null });

  assert.strictEqual((await api('POST', '/api/duties', admin, { duty: 'adutm' })).status, 201);

  const { duties: listed } = await (await api('GET', '/api/duties', await login('memtest'))).json();
  assert.deepStrictEqual(listed.map(d => d.duty), ['adutm', 'Lodging Monitor'], 'lower(duty) ordering');

  res = await api('PATCH', `/api/duties/${created.id}`, admin, { primary_owner: '' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).primary_owner, null, 'blank clears the owner');
  const { rows: [row] } = await pool.query('SELECT updated_by_id FROM additional_duties WHERE id = $1', [created.id]);
  assert.strictEqual(row.updated_by_id, adminId);

  assert.strictEqual((await api('DELETE', `/api/duties/${created.id}`, admin)).status, 204);
  assert.strictEqual((await (await api('GET', '/api/duties', admin)).json()).duties.length, 1);
  assert.strictEqual((await api('PATCH', `/api/duties/${created.id}`, admin, { duty: 'Gone' })).status, 404);
  assert.strictEqual((await api('DELETE', `/api/duties/${created.id}`, admin)).status, 404);
  assert.strictEqual((await api('DELETE', '/api/duties/abc', admin)).status, 400);
});

test('400s: empty duty, 121-character duty, 201-character owner, PATCH with nothing to update', async () => {
  await seed();
  const admin = await login('admintest');
  const bad = async (m, p, body) => {
    const r = await api(m, p, admin, body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    return (await r.json()).error;
  };
  assert.match(await bad('POST', '/api/duties', { duty: '   ' }), /required/);
  assert.match(await bad('POST', '/api/duties', { duty: 'x'.repeat(121) }), /120/);
  assert.match(await bad('POST', '/api/duties', { duty: 'ok', primary_owner: 'x'.repeat(201) }), /200/);
  const { id } = await (await api('POST', '/api/duties', admin, { duty: 'ok' })).json();
  assert.match(await bad('PATCH', `/api/duties/${id}`, {}), /Nothing to update/);
});

test('409: a case-insensitive duplicate, on create and on rename', async () => {
  await seed();
  const admin = await login('admintest');
  assert.strictEqual((await api('POST', '/api/duties', admin, { duty: 'ADUTM' })).status, 201);
  const dup = await api('POST', '/api/duties', admin, { duty: 'adutm' });
  assert.strictEqual(dup.status, 409);
  assert.match((await dup.json()).error, /already exists/);
  const { id } = await (await api('POST', '/api/duties', admin, { duty: 'ITEC' })).json();
  assert.strictEqual((await api('PATCH', `/api/duties/${id}`, admin, { duty: 'Adutm' })).status, 409);
  assert.strictEqual((await api('PATCH', `/api/duties/${id}`, admin, { duty: 'ITEC' })).status, 200,
    'renaming to itself is fine');
});
