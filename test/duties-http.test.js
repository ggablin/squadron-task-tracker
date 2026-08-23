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
