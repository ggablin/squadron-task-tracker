// Route-level coverage for the two claims that unit tests cannot reach:
// that the archived-cycle guard is actually wired into DELETE /api/tasks/:id
// (spec §8 — a live defect: today that route has no guard at all and is
// reachable from public/index.html:5233), and that supervisors are held to
// their own shop while group routes stay leadership-only.
//
// DATABASE_URL must be set before requiring server.js: the app builds its pool
// from it at module-load time.
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

function cookieOf(res) {
  const all = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return all.map(c => c.split(';')[0]).join('; ');
}

async function login(slug, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, password }),
  });
  assert.strictEqual(res.status, 200, `login failed for ${slug}`);
  return cookieOf(res);
}

// Two shops so the supervisor scoping test has somewhere to reach across to.
async function world() {
  const hash = await bcrypt.hash('pw', 10);
  const { rows: [s1] } = await pool.query(`INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [s2] } = await pool.query(`INSERT INTO shops (name) VALUES ('HVAC') RETURNING id`);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO task_categories (code,label,sort_order) VALUES ('admin','Admin',1) RETURNING id`);
  const mk = async (last, shop, role) => {
    const { rows: [m] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active, must_change_password)
       VALUES ($1,'X','SSgt',$2,$3,$1,$4,true,false) RETURNING id`, [last, shop, role, hash]);
    return m.id;
  };
  return {
    catId: cat.id, catCode: 'admin',
    lead: await mk('lead', s1.id, 'leadership'),
    sup1: await mk('sup1', s1.id, 'supervisor'),
    mem1: await mk('mem1', s1.id, 'member'),
    mem2: await mk('mem2', s2.id, 'member'),
  };
}

async function mkCycle(status, isCurrent) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('Aug',$1,$2) RETURNING id`,
    [status, isCurrent]);
  return c.id;
}

async function mkTask(cycleId, memberId, catId, title, urgency = 'this_uta') {
  const { rows: [t] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [cycleId, memberId, catId, title, urgency]);
  return t.id;
}

test('DELETE /api/tasks/:id refuses an archived cycle', async () => {
  await resetDb(); const w = await world();
  const archived = await mkCycle('archived', false);
  const t = await mkTask(archived, w.mem1, w.catId, 'CBT');
  const cookie = await login('lead', 'pw');

  const res = await fetch(`${baseUrl}/api/tasks/${t}`, { method: 'DELETE', headers: { cookie } });
  assert.strictEqual(res.status, 403, 'archived cycles are closed to changes');

  const { rows } = await pool.query(`SELECT 1 FROM tasks WHERE id=$1`, [t]);
  assert.strictEqual(rows.length, 1, 'the task must survive the refused delete');
});

test('DELETE /api/tasks/:id warns before destroying a completion', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const t = await mkTask(live, w.mem1, w.catId, 'CBT');
  await pool.query(`INSERT INTO task_completions (task_id, completed_by_id, state, note)
                    VALUES ($1,$2,'done','my note')`, [t, w.mem1]);
  const cookie = await login('lead', 'pw');

  const res = await fetch(`${baseUrl}/api/tasks/${t}`, { method: 'DELETE', headers: { cookie } });
  assert.strictEqual(res.status, 409);
  assert.strictEqual((await res.json()).checked_off_count, 1);

  const forced = await fetch(`${baseUrl}/api/tasks/${t}?force=true`,
    { method: 'DELETE', headers: { cookie } });
  assert.strictEqual(forced.status, 200);
});

test('a supervisor cannot edit a row outside their shop', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const outside = await mkTask(live, w.mem2, w.catId, 'CBT');
  const cookie = await login('sup1', 'pw');

  const res = await fetch(`${baseUrl}/api/tasks/${outside}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urgency: 'overdue' }),
  });
  assert.strictEqual(res.status, 403);
});

test('a supervisor cannot edit a whole group', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  await mkTask(live, w.mem1, w.catId, 'CBT');
  const cookie = await login('sup1', 'pw');

  const res = await fetch(`${baseUrl}/api/cycles/${live}/groups`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ category_code: w.catCode, title: 'CBT', urgency: 'overdue' }),
  });
  assert.strictEqual(res.status, 403, 'group routes are leadership-only');
});

test('an invalid urgency is a 400, not a 500 from the CHECK constraint', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const t = await mkTask(live, w.mem1, w.catId, 'CBT');
  const cookie = await login('lead', 'pw');

  const res = await fetch(`${baseUrl}/api/tasks/${t}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urgency: 'very_urgent' }),
  });
  assert.strictEqual(res.status, 400);
});

test('leadership can edit a group and a single row on a live cycle', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const a = await mkTask(live, w.mem1, w.catId, 'CBT', 'future');
  const cookie = await login('lead', 'pw');

  const g = await fetch(`${baseUrl}/api/cycles/${live}/groups`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ category_code: w.catCode, title: 'CBT', urgency: 'this_uta' }),
  });
  assert.strictEqual(g.status, 200);

  const d = await fetch(`${baseUrl}/api/tasks/${a}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ appt_time: '0900' }),
  });
  assert.strictEqual(d.status, 200);

  const { rows: [row] } = await pool.query(
    `SELECT urgency, appt_time FROM tasks WHERE id=$1`, [a]);
  assert.deepStrictEqual(row, { urgency: 'this_uta', appt_time: '0900' });
});
