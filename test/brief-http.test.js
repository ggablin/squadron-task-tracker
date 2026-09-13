// HTTP coverage for the Leadership Brief: the API and the page are leadership
// only, the payload comes from the live cycle, and its numbers agree with the
// rollups the Squadron tab already shows.
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
const get = (path, cookie) => fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie }, redirect: 'manual' });

async function seedWorld() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);
  const { rows: [{ id: shop }] } = await pool.query(`INSERT INTO shops (name) VALUES ('HVAC') RETURNING id`);
  const { rows: [{ id: live }] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current, start_date, end_date, period_count)
     VALUES ('Sep 2026','live',true,'2026-09-12','2026-09-13',4) RETURNING id`);
  const { rows: [{ id: old }] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('Aug 2026','archived',false) RETURNING id`);
  const { rows: [{ id: cbt }] } = await pool.query(
    `INSERT INTO task_categories (code, label, sort_order) VALUES ('cbt','CBTs',2) RETURNING id`);
  const member = async (slug, role) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active, must_change_password)
       VALUES ($1,'Test','SrA',$2,$3,$4,$5,true,false) RETURNING id`, [slug, shop, role, slug, hash]);
    return id;
  };
  const a = await member('ma', 'member');
  const b = await member('mb', 'member');
  await member('suptest', 'supervisor');
  await member('leadtest', 'leadership');
  const task = (cycle, who, title, done) => pool.query(
    `WITH t AS (INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency) VALUES ($1,$2,$3,$4,'this_uta') RETURNING id)
     INSERT INTO task_completions (task_id, completed_by_id, state) SELECT t.id, $2, 'done' FROM t WHERE $5`,
    [cycle, who, cbt, title, !!done]);
  await task(live, a, 'Cyber Awareness', true);
  await task(live, b, 'Cyber Awareness', false);
  await task(old,  b, 'Old thing', false);          // dead cycle, never in the brief
  await pool.query(
    `INSERT INTO shop_events (uta_cycle_id, shop_id, event_type, title, status, wo_number)
     VALUES ($1,$2,'work_order','Fix the chiller','in_progress','WO-7'), ($1,$2,'schedule','Formation','open',NULL)`,
    [live, shop]);
  await pool.query(
    `INSERT INTO attendance (uta_cycle_id, member_id, shop_id, period, status)
     VALUES ($1,$2,$3,1,'ruta_excused'), ($1,$2,$3,2,'ruta_excused')`, [live, b, shop]);
  return { live, shop, a, b };
}

test('the brief is leadership only, as an API and as a page', async () => {
  await seedWorld();
  for (const slug of ['ma', 'suptest']) {
    const cookie = await login(slug);
    assert.strictEqual((await get('/api/brief', cookie)).status, 403, `${slug} on the API`);
    const page = await get('/brief', cookie);
    assert.strictEqual(page.status, 302, `${slug} on the page`);
    assert.strictEqual(page.headers.get('location'), '/');
  }
  assert.strictEqual((await get('/api/brief', null)).status, 401);
  const lead = await login('leadtest');
  assert.strictEqual((await get('/api/brief', lead)).status, 200);
  const page = await get('/brief', lead);
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /Leadership Brief/);
});

test('the payload reads the live cycle and agrees with the Squadron rollups', async () => {
  const w = await seedWorld();
  const cookie = await login('leadtest');
  const b = await (await get('/api/brief', cookie)).json();
  assert.strictEqual(b.cycle.id, w.live);
  assert.strictEqual(b.cycle.period_count, 4);
  assert.strictEqual(b.shops.length, 1);
  const hvac = b.shops[0];
  assert.strictEqual(hvac.member_count, 4);
  assert.strictEqual(hvac.present_count, 3, 'b is on a RUTA');
  assert.deepStrictEqual(hvac.tasks.all, { total: 2, done: 1, critical: 2, critical_done: 1 });
  assert.deepStrictEqual(hvac.tasks.present, { total: 1, done: 1, critical: 1, critical_done: 1 });
  assert.deepStrictEqual(hvac.work_orders.map(w => w.title), ['Fix the chiller'], 'schedule rows are not work orders');
  assert.deepStrictEqual(hvac.work_order_counts, { open: 0, in_progress: 1, complete: 0, total: 1 });
  assert.deepStrictEqual(hvac.attendance, { marked: 2, total: 16 });
  assert.deepStrictEqual(b.squadron.away.map(m => m.id), [w.b]);
  assert.ok(!JSON.stringify(b).includes('Old thing'), 'the archived cycle is not in the brief');

  // Same numbers the Squadron tab shows.
  const sq = (await (await get('/api/squadron', cookie)).json())[0];
  assert.strictEqual(parseInt(sq.total_tasks), b.squadron.tasks.all.total);
  assert.strictEqual(parseInt(sq.done_tasks), b.squadron.tasks.all.done);
  assert.strictEqual(parseInt(sq.total_tasks_present), b.squadron.tasks.present.total);
  assert.strictEqual(parseInt(sq.present_count), b.squadron.members.present);
});
