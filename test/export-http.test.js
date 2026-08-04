// Coverage for GET /api/export/shop-lists — the payload behind the printable
// shop handouts. The things worth guarding: the leadership gate (a handout
// contains every member's tasks, so member/supervisor sessions must bounce),
// the live-cycle scoping (draft content must never leak onto paper handed out
// at drill), and the rank ordering (the whole point of the member section is
// high-to-low, which nothing else in the app exercises).
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
  if (!cookies.length) return null;
  return cookies[0].split(';')[0];
}

async function login(slug, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, password }),
  });
  assert.strictEqual(res.status, 200, `login as ${slug} should succeed`);
  const cookie = cookieFrom(res);
  assert.ok(cookie, 'login should set a session cookie');
  return cookie;
}

async function getExport(cookie) {
  return fetch(`${baseUrl}/api/export/shop-lists`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

// One password hash shared by every seeded login — hashing is the slow part.
let HASH;
async function seedMember(slug, role, shopId, rank, last, first, extra = {}) {
  HASH = HASH || await bcrypt.hash('pw12345678', 10);
  const { rows: [m] } = await pool.query(
    `INSERT INTO members
       (last_name, first_name, rank, shop_id, role, slug, password_hash,
        active, must_change_password)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false) RETURNING id`,
    [last, first, rank, shopId, role, slug, HASH, extra.active !== false]);
  return m.id;
}

test('member and supervisor sessions are refused; no session is a 401', async () => {
  await resetDb();
  const { rows: [shop] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  await seedMember('mem', 'member', shop.id, 'SrA', 'Member', 'Mia');
  await seedMember('sup', 'supervisor', shop.id, 'MSgt', 'Super', 'Sam');

  assert.strictEqual((await getExport(null)).status, 401, 'no session');
  assert.strictEqual((await getExport(await login('mem', 'pw12345678'))).status, 403, 'member');
  assert.strictEqual((await getExport(await login('sup', 'pw12345678'))).status, 403, 'supervisor');
});

test('with no live cycle a leadership session gets a 404, not an empty document', async () => {
  await resetDb();
  const { rows: [shop] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  await seedMember('ldr', 'leadership', shop.id, 'CMSgt', 'Leader', 'Lee');
  // A draft alone must not satisfy the export — handouts come from what
  // members can actually see.
  await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status) VALUES ('Sep 2026', false, 'draft')`);

  const res = await getExport(await login('ldr', 'pw12345678'));
  assert.strictEqual(res.status, 404);
});

test('payload: live-cycle scope, rank-descending members, split event types', async () => {
  await resetDb();
  const { rows: [shopS] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [shopH] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('HVAC') RETURNING id`);

  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status, start_date, end_date)
     VALUES ('Aug 2026', true, 'live', '2026-08-08', '2026-08-09') RETURNING id`);
  const { rows: [draft] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status)
     VALUES ('Sep 2026', false, 'draft') RETURNING id`);

  const ldr = await seedMember('ldr', 'leadership', shopS.id, 'CMSgt', 'Leader', 'Lee');
  // Rank order must beat alphabetical order: "Aaa" is the junior member and
  // must sort BELOW "Zzz" despite winning every name sort.
  const jr = await seedMember('aaa', 'member', shopS.id, 'SrA', 'Aaa', 'Jay');
  const sr = await seedMember('zzz', 'member', shopS.id, 'MSgt', 'Zzz', 'Zoe');
  await seedMember('gone', 'member', shopS.id, 'TSgt', 'Gone', 'Gil', { active: false });

  const { rows: [catB] } = await pool.query(
    `INSERT INTO task_categories (code, label, sort_order) VALUES ('b_cat','Medical',2) RETURNING id`);
  const { rows: [catA] } = await pool.query(
    `INSERT INTO task_categories (code, label, sort_order) VALUES ('a_cat','Training',1) RETURNING id`);

  // Inserted in the "wrong" order on purpose: category sort_order must win.
  const { rows: [tMed] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency)
     VALUES ($1,$2,$3,'Dental exam','this_uta') RETURNING id`, [live.id, jr, catB.id]);
  await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency)
     VALUES ($1,$2,$3,'Cyber Awareness CBT','overdue')`, [live.id, jr, catA.id]);
  await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title)
     VALUES ($1,$2,$3,'Draft-only task — must not print')`, [draft.id, jr, catA.id]);
  await pool.query(
    `INSERT INTO task_completions (task_id, completed_by_id, state)
     VALUES ($1,$2,'done')`, [tMed.id, jr]);

  await pool.query(
    `INSERT INTO shop_events (uta_cycle_id, shop_id, event_type, day, start_time, title)
     VALUES ($1,$2,'schedule','Saturday','0830','Shop training'),
            ($1,$2,'work_order',NULL,NULL,'Patch wall in 3301'),
            ($1,$2,'emphasis',NULL,NULL,'Form 55 review')`, [live.id, shopS.id]);
  await pool.query(
    `INSERT INTO shop_events (uta_cycle_id, shop_id, event_type, day, title)
     VALUES ($1,$2,'schedule','Saturday','Draft-only event')`, [draft.id, shopS.id]);
  await pool.query(
    `INSERT INTO squadron_events (uta_cycle_id, day, start_time, title, kind)
     VALUES ($1,'Saturday','0800','Formation / Roll Call','formation')`, [live.id]);
  await pool.query(
    `INSERT INTO squadron_events (uta_cycle_id, day, title, kind)
     VALUES ($1,'Saturday','Draft-only formation','formation')`, [draft.id]);

  const res = await getExport(await login('ldr', 'pw12345678'));
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.strictEqual(body.cycle.id, live.id);
  assert.deepStrictEqual(body.shops.map(s => s.name), ['HVAC', 'Structures'],
    'shops come alphabetical');

  const sq = body.squadron_events;
  assert.strictEqual(sq.length, 1, 'only the live cycle\'s squadron events ship');
  assert.strictEqual(sq[0].title, 'Formation / Roll Call');

  const st = body.shops.find(s => s.name === 'Structures');
  assert.deepStrictEqual(st.schedule.map(e => e.title), ['Shop training'],
    'shop schedule excludes the draft event and the non-schedule types');
  assert.deepStrictEqual(st.work_orders.map(e => e.title), ['Patch wall in 3301']);
  assert.deepStrictEqual(st.emphasis.map(e => e.title), ['Form 55 review']);

  const names = st.members.map(m => m.last_name);
  assert.ok(!names.includes('Gone'), 'inactive members do not print');
  assert.ok(names.indexOf('Zzz') < names.indexOf('Aaa'),
    'MSgt Zzz outranks SrA Aaa regardless of the alphabet');
  assert.ok(names.indexOf('Leader') < names.indexOf('Zzz'),
    'CMSgt outranks MSgt');

  const aaa = st.members.find(m => m.last_name === 'Aaa');
  assert.deepStrictEqual(aaa.tasks.map(t => t.title),
    ['Cyber Awareness CBT', 'Dental exam'],
    'live-cycle tasks only, in category sort order');
  assert.strictEqual(aaa.tasks[0].category_label, 'Training');
  assert.strictEqual(aaa.tasks[1].state, 'done', 'completion state rides along');

  const hv = body.shops.find(s => s.name === 'HVAC');
  assert.deepStrictEqual(hv.schedule, [], 'other shops do not inherit shop events');
  assert.deepStrictEqual(hv.members, [], 'no members seeded in HVAC');
});
