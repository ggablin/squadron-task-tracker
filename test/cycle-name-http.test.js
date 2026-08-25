// Coverage for the duplicate-cycle-name guard added with the /build mode split.
//
// The guard exists because the builder's cycle bar used to read "Aug 2026 UTA —
// Draft — members still see Aug 2026 UTA until you press Go live". When both
// cycles carry the same name, the one sentence whose job is to distinguish them
// says nothing, and every later reference ("Start from Aug 2026 UTA") inherits
// the ambiguity.
//
// The important property to hold: this is a GUARD, not a migration. It refuses
// a new name and must never rename, modify, or remove a row that already
// exists — including duplicates already in the database from before it shipped.
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

function cookieFrom(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return cookies.length ? cookies[0].split(';')[0] : null;
}

let HASH;
async function seedLeader() {
  HASH = HASH || await bcrypt.hash('pw12345678', 10);
  const { rows: [shop] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug,
                          password_hash, active, must_change_password)
     VALUES ('Leader','L','CMSgt',$1,'leadership','ldr',$2,true,false)`,
    [shop.id, HASH]);
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'ldr', password: 'pw12345678' }),
  });
  assert.strictEqual(res.status, 200);
  return cookieFrom(res);
}

async function createCycle(cookie, name, dates) {
  const res = await fetch(`${baseUrl}/api/cycles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name, ...dates }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// POST /api/cycles is the only one of lib/cycles.js's three date-carrying
// queries with an HTTP test, so the wire format gets pinned here rather than in
// a harness of its own. res.json is where the defect actually bites: a bare DATE
// column arrives from node-postgres as a Date at LOCAL midnight, and
// JSON.stringify runs it through toISOString(), so anywhere ahead of UTC the
// client reads the day before the drill. Under CI's UTC it does not misreport —
// it serialises as '2026-08-08T00:00:00.000Z' — so assert the exact string and a
// revert fails in every timezone. (The matching SELECT and UPDATE … RETURNING
// are covered at the lib level in test/cycles.test.js.)
test('drill dates come back over the wire as YYYY-MM-DD, not an ISO timestamp', async () => {
  await resetDb();
  const cookie = await seedLeader();

  const r = await createCycle(cookie, 'Aug 2026 UTA',
    { start_date: '2026-08-08', end_date: '2026-08-09' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.start_date, '2026-08-08');
  assert.strictEqual(r.body.end_date, '2026-08-09');
  assert.strictEqual(r.body.period_count, 4, 'a two-day drill still derives four periods');

  // Both dates omitted stays null rather than becoming a string.
  const undated = await createCycle(cookie, 'Undated 2026');
  assert.strictEqual(undated.status, 200);
  assert.strictEqual(undated.body.start_date, null);
  assert.strictEqual(undated.body.end_date, null);
});

test('a name already held by the live cycle is refused with 409', async () => {
  await resetDb();
  const cookie = await seedLeader();
  await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Aug 2026 UTA', true, 'live')`);

  const r = await createCycle(cookie, 'Aug 2026 UTA');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'DUPLICATE_NAME');
  assert.match(r.body.message, /live cycle is already named/i);

  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM uta_cycles`);
  assert.strictEqual(rows[0].n, 1, 'nothing was created');
});

test('case and surrounding whitespace do not slip a duplicate past the guard', async () => {
  await resetDb();
  const cookie = await seedLeader();
  await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Aug 2026 UTA', true, 'live')`);

  for (const variant of ['  aug 2026 uta  ', 'AUG 2026 UTA', 'Aug 2026 UTA ']) {
    const r = await createCycle(cookie, variant);
    assert.strictEqual(r.status, 409, `"${variant}" should collide`);
  }
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM uta_cycles`);
  assert.strictEqual(rows[0].n, 1);
});

test('a draft name collides too, and a genuinely new name still works', async () => {
  await resetDb();
  const cookie = await seedLeader();
  await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Aug 2026 UTA', true, 'live')`);

  const ok = await createCycle(cookie, 'Sep 2026 UTA');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.name, 'Sep 2026 UTA');

  const dupDraft = await createCycle(cookie, 'Sep 2026 UTA');
  assert.strictEqual(dupDraft.status, 409);
  assert.match(dupDraft.body.message, /draft cycle is already named/i);
});

test('an archived name is reusable — only cycles that can share a screen collide', async () => {
  await resetDb();
  const cookie = await seedLeader();
  await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Aug 2025 UTA', false, 'archived')`);

  const r = await createCycle(cookie, 'Aug 2025 UTA');
  assert.strictEqual(r.status, 200, 'retired names are free to reuse');
});

test('the guard never touches duplicates that already exist', async () => {
  await resetDb();
  const cookie = await seedLeader();
  // Two cycles sharing a name, as could exist from before the guard shipped.
  const { rows: [a] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Aug 2026 UTA', true, 'live') RETURNING id`);
  const { rows: [b] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Aug 2026 UTA', false, 'draft') RETURNING id`);

  // A rejected create must roll back cleanly and leave both rows untouched.
  const r = await createCycle(cookie, 'Aug 2026 UTA');
  assert.strictEqual(r.status, 409);

  const { rows } = await pool.query(
    `SELECT id, name, status FROM uta_cycles ORDER BY id`);
  assert.deepStrictEqual(rows, [
    { id: a.id, name: 'Aug 2026 UTA', status: 'live' },
    { id: b.id, name: 'Aug 2026 UTA', status: 'draft' },
  ], 'pre-existing duplicates survive unchanged');
});
