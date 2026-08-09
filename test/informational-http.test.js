// Coverage for informational tasks — rows that are shown to the member but never
// checked off and never counted: is_upcoming, urgency 'info', or the Upgrade
// Training category.
//
// The rule was previously only is_upcoming, a flag someone had to remember to set
// at creation. On the live cycle it was false on all 113 tasks including every
// Upcoming one, so the exclusion was excluding nothing and 11 notices were sitting
// in the squadron's denominator. Deriving it from urgency and category is what
// makes it hold without anyone remembering.
//
// The last test here guards the change's own risk: the rollups gained a LEFT JOIN
// to task_categories, and getting that wrong would quietly drop every member who
// has no tasks from their shop roster.
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
  const { rows: [{ id: cycle }] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('Aug 2026','live',true)
     RETURNING id`);

  const cat = async (code, label, order) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO task_categories (code, label, sort_order) VALUES ($1,$2,$3) RETURNING id`,
      [code, label, order]);
    return id;
  };
  const cats = {
    cbt:      await cat('cbt', 'Computer Training (CBTs)', 2),
    upgrade:  await cat('upgrade', 'Upgrade Training', 4),
    upcoming: await cat('upcoming', 'Upcoming', 5),
  };

  const member = async (slug, role) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug,
                            password_hash, active, must_change_password)
       VALUES ($1,'Test','SrA',$2,$3,$4,$5,true,false) RETURNING id`,
      [slug, shop, role, slug, hash]);
    return id;
  };
  const mem  = await member('memtest', 'member');
  const sup  = await member('suptest', 'supervisor');
  const lead = await member('leadtest', 'leadership');
  const idle = await member('idletest', 'member');   // deliberately gets no tasks

  const task = async (memberId, catId, title, urgency, isUpcoming = false) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency, is_upcoming)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [cycle, memberId, catId, title, urgency, isUpcoming]);
    return id;
  };

  return {
    shop, cycle, cats, mem, sup, lead, idle,
    real1:      await task(mem, cats.cbt, 'Cyber Awareness', 'overdue'),
    real2:      await task(mem, cats.cbt, 'SABC refresher', 'this_uta'),
    infoUrg:    await task(mem, cats.cbt, 'PT window opens next UTA', 'info'),
    upgradeTsk: await task(mem, cats.upgrade, '5-level eligible in October', 'this_uta'),
    upcomingF:  await task(mem, cats.upcoming, 'Deployment brief', 'this_uta', true),
  };
}

/* ── What the member is handed ──────────────────────────────────────────── */

test('/api/tasks marks each row informational or not', async () => {
  const w = await seedWorld();
  const rows = await (await get('/api/tasks', await login('memtest'))).json();
  const by = Object.fromEntries(rows.map(r => [r.id, r.informational]));

  assert.strictEqual(by[w.real1], false, 'an overdue CBT is real work');
  assert.strictEqual(by[w.real2], false);
  assert.strictEqual(by[w.infoUrg], true, "urgency 'info'");
  assert.strictEqual(by[w.upgradeTsk], true, 'Upgrade Training, despite urgency this_uta');
  assert.strictEqual(by[w.upcomingF], true, 'the legacy is_upcoming flag still counts');
  assert.strictEqual(rows.length, 5, 'all five are still delivered — hidden from counts, not from view');
});

/* ── The denominators ───────────────────────────────────────────────────── */

test('a shop roster counts only real work', async () => {
  await seedWorld();
  const rows = await (await get('/api/shop/members', await login('suptest'))).json();
  const m = rows.find(r => r.last_name === 'memtest');
  // Five tasks exist; two are work.
  assert.strictEqual(Number(m.total_tasks), 2);
  assert.strictEqual(Number(m.done_tasks), 0);
});

test('the squadron rollup counts only real work', async () => {
  await seedWorld();
  const cookie = await login('leadtest');
  const shops = await (await get('/api/squadron', cookie)).json();
  const hvac = shops.find(s => s.shop === 'HVAC');
  assert.strictEqual(Number(hvac.total_tasks), 2);

  const members = await (await get('/api/squadron/members', cookie)).json();
  const m = members.find(r => r.last_name === 'memtest');
  assert.strictEqual(Number(m.total_tasks), 2);
});

test('a wholly informational category drops out of the breakdown', async () => {
  await seedWorld();
  const cats = await (await get('/api/squadron/categories', await login('leadtest'))).json();
  const codes = cats.map(c => c.code);
  assert.ok(codes.includes('cbt'), 'CBTs have real work and stay');
  assert.ok(!codes.includes('upgrade'), 'Upgrade Training has no completable work');
  assert.ok(!codes.includes('upcoming'));
  assert.strictEqual(Number(cats.find(c => c.code === 'cbt').total), 2);
});

/* ── Checking off ───────────────────────────────────────────────────────── */

test('an informational task cannot be checked off', async () => {
  const w = await seedWorld();
  const cookie = await login('memtest');
  for (const [label, id] of [['urgency info', w.infoUrg],
                             ['upgrade training', w.upgradeTsk],
                             ['is_upcoming', w.upcomingF]]) {
    const res = await fetch(`${baseUrl}/api/tasks/${id}`, {
      method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'done' }),
    });
    assert.strictEqual(res.status, 400, `${label} should be refused`);
  }
  const { rows } = await pool.query('SELECT COUNT(*)::int n FROM task_completions');
  assert.strictEqual(rows[0].n, 0, 'no completion rows were written');
});

test('a real task is still checked off, and still counts', async () => {
  const w = await seedWorld();
  const cookie = await login('memtest');
  const res = await fetch(`${baseUrl}/api/tasks/${w.real1}`, {
    method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'done' }),
  });
  assert.strictEqual(res.status, 200);

  const rows = await (await get('/api/shop/members', await login('suptest'))).json();
  const m = rows.find(r => r.last_name === 'memtest');
  assert.strictEqual(Number(m.done_tasks), 1);
  assert.strictEqual(Number(m.total_tasks), 2);
});

/* ── The risk this change introduced ────────────────────────────────────── */

test('a member with no tasks is still listed on the roster', async () => {
  await seedWorld();
  // The rollups gained LEFT JOIN task_categories. Making it an inner join — or
  // writing a null-unsafe condition — would silently drop everyone task-free.
  const rows = await (await get('/api/shop/members', await login('suptest'))).json();
  const idle = rows.find(r => r.last_name === 'idletest');
  assert.ok(idle, 'a member with no tasks must still appear');
  assert.strictEqual(Number(idle.total_tasks), 0);

  const shops = await (await get('/api/squadron', await login('leadtest'))).json();
  assert.strictEqual(shops.find(s => s.shop === 'HVAC').member_count, '4',
    'all four members still counted in the shop');
});
