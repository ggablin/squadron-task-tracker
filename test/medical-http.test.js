// HTTP coverage for /api/squadron/medical. The arithmetic is pinned in
// medical.test.js; this proves the things only a real request can — who may read
// it, that it reads the live cycle, that it reads TITLES rather than details, and
// that it applies the same informational rule as every other rollup.
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

async function seedWorld() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);

  const { rows: [{ id: shop }] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('HVAC') RETURNING id`);
  const { rows: [{ id: live }] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('Aug 2026','live',true)
     RETURNING id`);
  const { rows: [{ id: old }] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('May 2026','archived',false)
     RETURNING id`);
  const { rows: [{ id: medCat }] } = await pool.query(
    `INSERT INTO task_categories (code, label, sort_order)
     VALUES ('medical','Medical / Fitness',3) RETURNING id`);
  const { rows: [{ id: cbtCat }] } = await pool.query(
    `INSERT INTO task_categories (code, label, sort_order)
     VALUES ('cbt','Computer Training (CBTs)',2) RETURNING id`);

  const member = async (slug, role) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug,
                            password_hash, active, must_change_password)
       VALUES ($1,'Test','SrA',$2,$3,$4,$5,true,false) RETURNING id`,
      [slug, shop, role, slug, hash]);
    return id;
  };
  const ids = [];
  for (const n of ['a', 'b', 'c', 'd', 'e']) ids.push(await member('m' + n, 'member'));
  await member('suptest', 'supervisor');
  await member('leadtest', 'leadership');

  // Real production detail text, so a regression to reading `details` shows up as
  // a service literally called "Need to get Height/Weight/Waist measured...".
  const task = (cycle, who, catId, title, details, urgency, done) => pool.query(
    `WITH t AS (
       INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id)
     INSERT INTO task_completions (task_id, completed_by_id, state)
     SELECT t.id, $2, 'done' FROM t WHERE $7`,
    [cycle, who, catId, title, details, urgency, !!done]);

  const [a, b, c, d, e] = ids;
  await task(live, a, medCat, 'BCA Assessment', 'Need to get Height/Weight/Waist measured Saturday @ 1030hrs', 'this_uta', true);
  await task(live, b, medCat, 'BCA Assessment', 'Need to get Height/Weight/Waist measured Saturday @ 0930hrs', 'this_uta', false);
  await task(live, c, medCat, 'HIV Blood Draw', 'Walk-in Saturday 0900-1400', 'this_uta', false);
  await task(live, d, medCat, 'PT Test', 'Need to go into MyFitness and schedule PT Test for next Drill', 'next_uta', false);
  await task(live, e, medCat, 'PTL Training', 'FSS Classroom @0930', 'this_uta', true);
  // Excluded: a notice, a non-medical category, a dead cycle.
  await task(live, c, medCat, 'Sleep Study', null, 'info', false);
  await task(live, a, cbtCat, 'Cyber Awareness', null, 'this_uta', false);
  await task(old,  b, medCat, 'Audiogram', 'Saturday 6 June @ 1300hrs', 'this_uta', false);

  return { live, old };
}

const names = body => body.services.map(s => s.service).sort();

test('services are task titles, with x of y done and a percentage', async () => {
  await seedWorld();
  const res = await get('/api/squadron/medical', await login('leadtest'));
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.deepStrictEqual(names(body), ['BCA Assessment', 'HIV Blood Draw']);
  const bca = body.services.find(s => s.service === 'BCA Assessment');
  assert.deepStrictEqual({ done: bca.done, total: bca.total, pct: bca.pct },
    { done: 1, total: 2, pct: 50 });
  assert.strictEqual(body.total, 3);
  assert.strictEqual(body.done, 1);
});

test('the appointment text in details never becomes a service', async () => {
  await seedWorld();
  const body = await (await get('/api/squadron/medical', await login('leadtest'))).json();
  const joined = names(body).join(' | ');
  assert.ok(!/Height|Waist|Walk-in|Classroom|Saturday/.test(joined),
    `details leaked into the service list: ${joined}`);
});

test('a PT test set for next UTA is deferred, not counted', async () => {
  await seedWorld();
  const body = await (await get('/api/squadron/medical', await login('leadtest'))).json();
  assert.ok(!names(body).includes('PT Test'));
  assert.strictEqual(body.deferred, 1);
});

test('PTL Training, notices, other categories and dead cycles all stay out', async () => {
  await seedWorld();
  const body = await (await get('/api/squadron/medical', await login('leadtest'))).json();
  const list = names(body);
  assert.ok(!list.includes('PTL Training'), 'duty qualification');
  assert.ok(!list.includes('Sleep Study'), 'informational');
  assert.ok(!list.includes('Cyber Awareness'), 'not a medical category');
  assert.ok(!list.includes('Audiogram'), 'May is archived');
});

test('a supervisor cannot read it, and nor can an anonymous request', async () => {
  await seedWorld();
  assert.strictEqual((await get('/api/squadron/medical', await login('suptest'))).status, 403);
  assert.strictEqual((await fetch(`${baseUrl}/api/squadron/medical`)).status, 401);
});

test('a cycle with nothing due returns zeroes, not an error', async () => {
  const w = await seedWorld();
  // completions reference tasks, so they go first
  await pool.query(
    `DELETE FROM task_completions WHERE task_id IN
       (SELECT id FROM tasks WHERE uta_cycle_id = $1)`, [w.live]);
  await pool.query(`DELETE FROM tasks WHERE uta_cycle_id = $1`, [w.live]);
  const res = await get('/api/squadron/medical', await login('leadtest'));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(),
    { services: [], total: 0, done: 0, pct: 0, deferred: 0 });
});
