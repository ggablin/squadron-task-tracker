// HTTP coverage for reading past drills: ?cycle_id on GET /api/shop/attendance
// and on the drill-roster export. A past cycle answers with the same shape but
// read-only; drafts are not readable; the default is still the current cycle;
// and the member history endpoint carries the marks.
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
const get = (path, cookie) => fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });

// Three cycles: an archived August (4 periods, marked), the current September
// (6 periods, unmarked), and an October draft that must never be readable.
async function seedWorld() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);

  const { rows: [{ id: shop }] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [{ id: aug }] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current, start_date, end_date, period_count, created_at)
     VALUES ('Aug 2026','archived',false,'2026-08-08','2026-08-09',4, NOW() - INTERVAL '40 days') RETURNING id`);
  const { rows: [{ id: sep }] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current, start_date, end_date, period_count, created_at)
     VALUES ('Sep 2026','live',true,'2026-09-11','2026-09-13',6, NOW() - INTERVAL '10 days') RETURNING id`);
  const { rows: [{ id: oct }] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current, created_at)
     VALUES ('Oct 2026','draft',false, NOW()) RETURNING id`);

  const member = async (slug, role) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug,
                            password_hash, active, must_change_password)
       VALUES ($1,'Test','SrA',$2,$3,$4,$5,true,false) RETURNING id`,
      [slug, shop, role, slug, hash]);
    return id;
  };
  const armena = await member('armena', 'member');
  await member('suptest', 'supervisor');
  await member('leadtest', 'leadership');

  await pool.query(
    `INSERT INTO attendance (uta_cycle_id, member_id, shop_id, period, status, note)
     VALUES ($1,$2,$3,1,'present',NULL), ($1,$2,$3,2,'present',NULL),
            ($1,$2,$3,3,'ruta_excused','dental'), ($1,$2,$3,4,'ruta_excused','dental')`,
    [aug, armena, shop]);

  return { shop, aug, sep, oct, armena };
}

test('a past cycle reads back read-only with its own periods and marks', async () => {
  const w = await seedWorld();
  const cookie = await login('suptest');

  const res = await get(`/api/shop/attendance?cycle_id=${w.aug}`, cookie);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.cycle.id, w.aug);
  assert.strictEqual(body.cycle.is_current, false);
  assert.strictEqual(body.editable, false, 'a past drill can be read but not marked');
  assert.strictEqual(body.periods.length, 4, 'periods follow the past cycle, not the current one');
  assert.deepStrictEqual(
    body.rows.map(r => [r.period, r.status]).sort((a, b) => a[0] - b[0]),
    [[1, 'present'], [2, 'present'], [3, 'ruta_excused'], [4, 'ruta_excused']]);
  // Coverage counts that cycle's cells: 4 marks over 3 members × 4 periods.
  assert.deepStrictEqual(body.coverage, { marked: 4, total: 12 });
});

test('the picker lists live and archived cycles newest first, never a draft', async () => {
  const w = await seedWorld();
  const body = await (await get('/api/shop/attendance', await login('suptest'))).json();
  assert.deepStrictEqual(body.cycles.map(c => c.id), [w.sep, w.aug]);
  assert.ok(body.cycles.every(c => c.id !== w.oct), 'the October draft is not offered');
  assert.strictEqual(body.cycles[0].is_current, true);
});

test('without cycle_id the current cycle is still the default, and still editable', async () => {
  const w = await seedWorld();
  const body = await (await get('/api/shop/attendance', await login('suptest'))).json();
  assert.strictEqual(body.cycle.id, w.sep);
  assert.strictEqual(body.cycle.is_current, true);
  assert.strictEqual(body.editable, true);
  assert.strictEqual(body.periods.length, 6);
  assert.strictEqual(body.rows.length, 0, "August's marks do not bleed into September");
});

test('a draft or unknown cycle_id is a 404, not a fallback to the current cycle', async () => {
  const w = await seedWorld();
  const cookie = await login('suptest');
  for (const id of [w.oct, 999999, 'abc']) {
    const res = await get(`/api/shop/attendance?cycle_id=${id}`, cookie);
    assert.strictEqual(res.status, 404, `cycle_id=${id}`);
  }
});

test('the drill roster export takes cycle_id and names the file after that drill', async () => {
  const w = await seedWorld();
  const cookie = await login('leadtest');

  const past = await get(`/api/squadron/attendance/xlsx?cycle_id=${w.aug}`, cookie);
  assert.strictEqual(past.status, 200);
  assert.match(past.headers.get('content-disposition') || '', /Aug 2026/);

  const cur = await get('/api/squadron/attendance/xlsx', cookie);
  assert.strictEqual(cur.status, 200);
  assert.match(cur.headers.get('content-disposition') || '', /Sep 2026/);

  const draft = await get(`/api/squadron/attendance/xlsx?cycle_id=${w.oct}`, cookie);
  assert.strictEqual(draft.status, 404);
});

test('member history carries the marks for a supervisor reading their own shop', async () => {
  const w = await seedWorld();
  const res = await get(`/api/members/${w.armena}/history`, await login('suptest'));
  assert.strictEqual(res.status, 200);
  const hist = await res.json();
  const aug = hist.find(h => h.cycle.id === w.aug);
  assert.ok(aug, 'a cycle with marks but no tasks still appears');
  assert.strictEqual(aug.periods.length, 4);
  assert.deepStrictEqual(aug.attendance.map(a => a.pay).join(''), '//RR');
  assert.strictEqual(aug.attendance[2].note, 'dental');
});
