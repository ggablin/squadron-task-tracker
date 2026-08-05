// Coverage for adding a task to a LIVE cycle via POST /api/cycles/:id/tasks.
//
// The builder's Live cycle section now adds through this route, so the things
// worth guarding are the ones with consequences for ~70 people: the add must
// be additive (never disturb completions already recorded), members who
// actually received a row must be notified, members who already had the task
// must NOT be notified a second time, and a draft add must stay silent —
// pinging people about work they cannot see is worse than not pinging them.
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
async function seed() {
  HASH = HASH || await bcrypt.hash('pw12345678', 10);
  const { rows: [shop] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO task_categories (code, label, sort_order) VALUES ('cbt','CBT',1) RETURNING id`);
  const mk = async (last, slug, role) => {
    const { rows: [m] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug,
                            password_hash, active, must_change_password)
       VALUES ($1,'X','SrA',$2,$3,$4,$5,true,false) RETURNING id`,
      [last, shop.id, role, slug, HASH]);
    return m.id;
  };
  const lead = await mk('Leader', 'ldr', 'leadership');
  const a = await mk('Alpha', 'alpha', 'member');
  const b = await mk('Bravo', 'bravo', 'member');
  return { shopId: shop.id, catId: cat.id, lead, a, b };
}

async function login(slug) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, password: 'pw12345678' }),
  });
  assert.strictEqual(res.status, 200);
  return cookieFrom(res);
}

async function addTask(cycleId, cookie, member_ids, title = 'Cyber Awareness CBT') {
  const res = await fetch(`${baseUrl}/api/cycles/${cycleId}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      title, category_code: 'cbt',
      assignments: [{ member_ids, urgency: 'this_uta' }],
    }),
  });
  return { status: res.status, body: res.ok ? await res.json() : null };
}

const notifCount = async (memberId) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notifications
     WHERE member_id = $1 AND type = 'task_assigned'`, [memberId]);
  return rows[0].n;
};

test('adding to a LIVE cycle notifies exactly the members who received a row', async () => {
  await resetDb();
  const s = await seed();
  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Aug 2026', true, 'live') RETURNING id`);
  const cookie = await login('ldr');

  const first = await addTask(live.id, cookie, [s.a, s.b]);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.added, 2);
  assert.strictEqual(await notifCount(s.a), 1);
  assert.strictEqual(await notifCount(s.b), 1);

  // Re-adding the same task: Alpha already has it (ON CONFLICT skips), so only
  // Bravo would be new — except Bravo has it too. Nobody is notified twice.
  const again = await addTask(live.id, cookie, [s.a, s.b]);
  assert.strictEqual(again.body.added, 0);
  assert.strictEqual(again.body.skipped, 2);
  assert.strictEqual(await notifCount(s.a), 1, 'no duplicate notification');
  assert.strictEqual(await notifCount(s.b), 1, 'no duplicate notification');
});

test('a member added later is notified; one who already had it is not re-notified', async () => {
  await resetDb();
  const s = await seed();
  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Aug 2026', true, 'live') RETURNING id`);
  const cookie = await login('ldr');

  await addTask(live.id, cookie, [s.a]);
  assert.strictEqual(await notifCount(s.a), 1);

  // Same title, now covering both. Only Bravo gets a row, so only Bravo pings.
  const second = await addTask(live.id, cookie, [s.a, s.b]);
  assert.strictEqual(second.body.added, 1);
  assert.strictEqual(second.body.skipped, 1);
  assert.strictEqual(await notifCount(s.a), 1, 'Alpha already had it');
  assert.strictEqual(await notifCount(s.b), 1, 'Bravo is new and told');
});

test('adding to a DRAFT cycle stays silent', async () => {
  await resetDb();
  const s = await seed();
  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Aug 2026', true, 'live') RETURNING id`);
  const { rows: [draft] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Sep 2026', false, 'draft') RETURNING id`);
  const cookie = await login('ldr');

  const r = await addTask(draft.id, cookie, [s.a, s.b]);
  assert.strictEqual(r.body.added, 2);
  assert.strictEqual(await notifCount(s.a), 0, 'draft work is not announced');
  assert.strictEqual(await notifCount(s.b), 0);

  // And the rows landed on the draft, not on the live cycle members can see.
  const { rows } = await pool.query(
    `SELECT uta_cycle_id FROM tasks WHERE member_id = $1`, [s.a]);
  assert.deepStrictEqual(rows.map(x => x.uta_cycle_id), [draft.id]);
  assert.notStrictEqual(draft.id, live.id);
});

test('a mid-cycle add never disturbs completions already recorded', async () => {
  await resetDb();
  const s = await seed();
  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Aug 2026', true, 'live') RETURNING id`);
  const cookie = await login('ldr');

  await addTask(live.id, cookie, [s.a], 'Dental exam');
  const { rows: [t] } = await pool.query(
    `SELECT id FROM tasks WHERE member_id = $1 AND title = 'Dental exam'`, [s.a]);
  await pool.query(
    `INSERT INTO task_completions (task_id, completed_by_id, state)
     VALUES ($1,$2,'done')`, [t.id, s.a]);

  // A second, unrelated add for the same member mid-cycle.
  await addTask(live.id, cookie, [s.a, s.b], 'Cyber Awareness CBT');

  const { rows: [c] } = await pool.query(
    `SELECT state FROM task_completions WHERE task_id = $1`, [t.id]);
  assert.strictEqual(c.state, 'done', 'existing check-off survives a later add');

  const { rows: titles } = await pool.query(
    `SELECT title FROM tasks WHERE member_id = $1 ORDER BY title`, [s.a]);
  assert.deepStrictEqual(titles.map(x => x.title), ['Cyber Awareness CBT', 'Dental exam']);
});

test('non-leadership cannot add to a cycle', async () => {
  await resetDb();
  const s = await seed();
  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Aug 2026', true, 'live') RETURNING id`);
  const cookie = await login('alpha');
  const r = await addTask(live.id, cookie, [s.b]);
  assert.strictEqual(r.status, 403);
});
