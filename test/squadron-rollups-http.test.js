// Regression coverage for the Squadron Stats rollups (2026-08-11 audit, batch 1).
//
// Two invariants pinned here:
//
// 1. Inactive members leave EVERY rollup. /api/squadron/categories and
//    /api/squadron/medical used to join tasks straight to categories with no
//    members.active filter, while /api/squadron (shops) and the category
//    drill-in both filtered — so one mid-cycle separation made the category
//    header disagree with the shops card and with its own drill-down.
//    The cross-endpoint agreement assertions are the real test: the three
//    surfaces must move together when a member is deactivated.
//
// 2. "Critical" means urgency overdue/this_uta, per lib/informational's
//    criticalSql. The hero tile used to display ALL remaining work under the
//    "Critical this UTA" label; the crit_* columns exist so it can't again.
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

// The three rollups, reduced to the numbers that must agree.
async function readRollups(cookie) {
  const shops = await (await get('/api/squadron', cookie)).json();
  const cats  = await (await get('/api/squadron/categories', cookie)).json();
  const med   = await (await get('/api/squadron/medical', cookie)).json();
  return {
    shops,
    shopsTotal: shops.reduce((s, r) => s + parseInt(r.total_tasks), 0),
    catsTotal:  cats.reduce((s, r) => s + parseInt(r.total), 0),
    medTotal:   med.total,
  };
}

async function seedWorld() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);

  const { rows: [{ id: shop }] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('HVAC') RETURNING id`);
  const { rows: [{ id: live }] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('Aug 2026','live',true)
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
  const a = await member('ma', 'member');
  const b = await member('mb', 'member');
  const c = await member('mc', 'member');
  await member('leadtest', 'leadership');

  const task = (who, catId, title, urgency, done) => pool.query(
    `WITH t AS (
       INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency)
       VALUES ($1,$2,$3,$4,$5) RETURNING id)
     INSERT INTO task_completions (task_id, completed_by_id, state)
     SELECT t.id, $2, 'done' FROM t WHERE $6`,
    [live, who, catId, title, urgency, !!done]);

  // Member b is the one the deactivation tests flip: one medical task, one CBT.
  await task(a, medCat, 'BCA Assessment', 'this_uta', true);
  await task(b, medCat, 'BCA Assessment', 'this_uta', false);
  await task(b, cbtCat, 'Cyber Awareness', 'this_uta', false);
  await task(c, medCat, 'HIV Blood Draw', 'overdue',  false);
  await task(c, cbtCat, 'Cyber Awareness', 'next_uta', false);
  await task(a, cbtCat, 'Force Protection', 'future',  false);
  await task(c, cbtCat, 'Records Review',  'info',    false);   // informational, never counted

  return { live, shop, a, b, c };
}

test('all three rollups agree, before and after a member is deactivated', async () => {
  const w = await seedWorld();
  const cookie = await login('leadtest');

  const before = await readRollups(cookie);
  // 6 countable tasks seeded (the info row never counts).
  assert.strictEqual(before.shopsTotal, 6);
  assert.strictEqual(before.catsTotal, before.shopsTotal,
    'category card must sum to the same total as the shops rollup');
  assert.strictEqual(before.medTotal, 3);

  // A mid-cycle separation: b keeps their rows but goes inactive.
  await pool.query(`UPDATE members SET active = false WHERE id = $1`, [w.b]);

  const after = await readRollups(cookie);
  assert.strictEqual(after.shopsTotal, 4, 'shops rollup drops b\'s two tasks');
  assert.strictEqual(after.catsTotal, after.shopsTotal,
    'category card must drop a deactivated member\'s tasks along with the shops rollup');
  assert.strictEqual(after.medTotal, 2, 'medical rollup drops b\'s medical task');
});

test('the category drill-in agrees with its header after a deactivation', async () => {
  const w = await seedWorld();
  const cookie = await login('leadtest');
  await pool.query(`UPDATE members SET active = false WHERE id = $1`, [w.b]);

  const cats = await (await get('/api/squadron/categories', cookie)).json();
  const medHeader = cats.find(c => c.code === 'medical');
  const drill = await (await get('/api/squadron/categories/medical/tasks', cookie)).json();
  const drillTotal = drill.reduce((s, r) => s + parseInt(r.total), 0);
  assert.strictEqual(parseInt(medHeader.total), drillTotal,
    'header fraction and drill-in rows must count the same tasks');
});

test('crit_* columns count only overdue and this-UTA work', async () => {
  await seedWorld();
  const cookie = await login('leadtest');
  const shops = await (await get('/api/squadron', cookie)).json();
  const critTasks = shops.reduce((s, r) => s + parseInt(r.crit_tasks), 0);
  const critDone  = shops.reduce((s, r) => s + parseInt(r.crit_done), 0);
  const total     = shops.reduce((s, r) => s + parseInt(r.total_tasks), 0);

  // Critical: a's done BCA, b's BCA, b's CBT (this_uta) + c's blood draw
  // (overdue) = 4. The next_uta and future rows count toward total (6) only.
  assert.strictEqual(critTasks, 4);
  assert.strictEqual(critDone, 1);
  assert.strictEqual(total, 6);
  assert.ok(critTasks < total, 'critical must be a subset of all remaining work');
});

test('present-scoped criticals: away members leave, members on orders stay', async () => {
  const w = await seedWorld();
  const cookie = await login('leadtest');

  // c is away on a RUTA; a is on orders, which lib/presence counts as PRESENT.
  await pool.query(
    `INSERT INTO attendance (uta_cycle_id, member_id, shop_id, period, status)
     VALUES ($1,$2,$3,1,'ruta_excused'), ($1,$4,$3,1,'agr_at_orders')`,
    [w.live, w.c, w.shop, w.a]);

  const shops = await (await get('/api/squadron', cookie)).json();
  const critPresent = shops.reduce((s, r) => s + parseInt(r.crit_tasks_present), 0);
  // All-scope criticals are 4; c's overdue blood draw drops out with them away,
  // a's task stays because orders count as at drill. 4 - 1 = 3.
  assert.strictEqual(critPresent, 3);
});
