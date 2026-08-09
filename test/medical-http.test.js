// HTTP coverage for /api/squadron/medical — the parsing itself is pinned in
// medical.test.js, so this proves the three things only a real request can:
// who may read it, that it reads the live cycle, and that it applies the same
// informational rule as every other rollup.
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
  const a = await member('alpha', 'member');
  const b = await member('bravo', 'member');
  // tasks carries UNIQUE (uta_cycle_id, member_id, category_id, title), so one
  // member gets exactly one "Medical / Dental" row per cycle — which is precisely
  // why every service they owe is packed into that row's details. The notice below
  // therefore needs a member of its own.
  const c = await member('charlie', 'member');
  await member('suptest', 'supervisor');
  await member('leadtest', 'leadership');

  const task = (cycle, who, catId, title, details, urgency = 'this_uta') => pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency)
     VALUES ($1,$2,$3,$4,$5,$6)`, [cycle, who, catId, title, details, urgency]);

  await task(live, a, medCat, 'Medical / Dental', 'PHAQ / DHA3');
  await task(live, b, medCat, 'Medical / Dental', 'MMR / HIV Blood Draw');
  await task(live, a, medCat, 'PT Test', 'Due Sep 2026');
  // Must not appear: a notice, a CBT, and a medical row from a dead cycle.
  // charlie holds ONLY the notice, so if it leaked he would show up in
  // totalMembers as well as in the service list — two ways to catch it.
  await task(live, c, medCat, 'Medical / Dental', 'Sleep Study', 'info');
  await task(live, a, cbtCat, 'Cyber Awareness', null);
  await task(old,  b, medCat, 'Medical / Dental', 'Audiogram');

  return { shop, live, old };
}

test('leadership gets the rollup, grouped and counted by member', async () => {
  await seedWorld();
  const res = await get('/api/squadron/medical', await login('leadtest'));
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  const g = Object.fromEntries(body.groups.map(x => [x.group, x.people]));
  assert.strictEqual(g['Health Assessments'], 1, 'alpha owes PHAQ and DHA3 — one person');
  assert.strictEqual(g['Immunizations'], 1);
  assert.strictEqual(g['Labs & Bloodwork'], 1);
  assert.strictEqual(g['Fitness'], 1);
  assert.strictEqual(body.totalMembers, 2);

  const ha = body.groups.find(x => x.group === 'Health Assessments');
  assert.deepStrictEqual(ha.services.map(s => s.service).sort(), ['DHA3', 'PHAQ']);
});

test('informational medical rows are excluded, like every other rollup', async () => {
  await seedWorld();
  const body = await (await get('/api/squadron/medical', await login('leadtest'))).json();
  const services = body.groups.flatMap(g => g.services.map(s => s.service));
  assert.ok(!services.includes('Sleep Study'),
    "a notice is not somebody who needs an appointment booked");
});

test('only the live cycle counts', async () => {
  await seedWorld();
  const body = await (await get('/api/squadron/medical', await login('leadtest'))).json();
  const services = body.groups.flatMap(g => g.services.map(s => s.service));
  assert.ok(!services.includes('Audiogram'), 'May is archived');
});

test('non-medical categories stay out', async () => {
  await seedWorld();
  const body = await (await get('/api/squadron/medical', await login('leadtest'))).json();
  const services = body.groups.flatMap(g => g.services.map(s => s.service));
  assert.ok(!services.includes('Unspecified'),
    'the CBT has no details but is not a medical row, so it must not appear at all');
});

test('a supervisor cannot read it, and nor can an anonymous request', async () => {
  await seedWorld();
  assert.strictEqual((await get('/api/squadron/medical', await login('suptest'))).status, 403);
  assert.strictEqual((await fetch(`${baseUrl}/api/squadron/medical`)).status, 401);
});

test('a cycle with no medical tasks returns an empty rollup, not an error', async () => {
  const w = await seedWorld();
  await pool.query(`DELETE FROM tasks WHERE uta_cycle_id = $1`, [w.live]);
  const res = await get('/api/squadron/medical', await login('leadtest'));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { groups: [], totalMembers: 0 });
});
