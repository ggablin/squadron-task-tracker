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

test('escalating a group notifies only members whose urgency rose', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  // Two members: mem1 at 'future' (will rise), mem2 at 'overdue' (will stay same)
  await mkTask(live, w.mem1, w.catId, 'CBT', 'future');
  await mkTask(live, w.mem2, w.catId, 'CBT', 'overdue');
  const cookie = await login('lead', 'pw');

  // Escalate the group to 'overdue'
  const res = await fetch(`${baseUrl}/api/cycles/${live}/groups`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ category_code: w.catCode, title: 'CBT', urgency: 'overdue' }),
  });
  assert.strictEqual(res.status, 200);

  // Only mem1 should be notified (mem2's urgency did not rise)
  const { rows: notifs } = await pool.query(
    `SELECT member_id, type, title, body, link FROM notifications WHERE type = 'task_escalated' ORDER BY member_id`);
  assert.strictEqual(notifs.length, 1, 'only one member escalated');
  assert.strictEqual(notifs[0].member_id, w.mem1);
  assert.strictEqual(notifs[0].type, 'task_escalated');
  assert.strictEqual(notifs[0].title, 'Urgency changed: CBT');
  assert.strictEqual(notifs[0].body, 'Now marked Overdue.');
  assert.strictEqual(notifs[0].link, 'member');
});

test('escalating a single task sends notification with title and urgency label', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const t = await mkTask(live, w.mem1, w.catId, 'CBT', 'future');
  const cookie = await login('sup1', 'pw');

  const res = await fetch(`${baseUrl}/api/tasks/${t}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urgency: 'overdue' }),
  });
  assert.strictEqual(res.status, 200);

  const { rows: [notif] } = await pool.query(
    `SELECT member_id, type, title, body, link FROM notifications WHERE type = 'task_escalated'`);
  assert.strictEqual(notif.member_id, w.mem1);
  assert.strictEqual(notif.type, 'task_escalated');
  assert.strictEqual(notif.title, 'Urgency changed: CBT');
  assert.strictEqual(notif.body, 'Now marked Overdue.');
  assert.strictEqual(notif.link, 'member');
});

test('de-escalation and details-only edits do not send notifications', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const t = await mkTask(live, w.mem1, w.catId, 'CBT', 'this_uta');
  const cookie = await login('sup1', 'pw');

  // De-escalate: should not notify
  const de = await fetch(`${baseUrl}/api/tasks/${t}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urgency: 'future' }),
  });
  assert.strictEqual(de.status, 200);

  // Details-only edit: should not notify
  const det = await fetch(`${baseUrl}/api/tasks/${t}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ details: 'New details', appt_time: '1000' }),
  });
  assert.strictEqual(det.status, 200);

  const { rows: notifs } = await pool.query(
    `SELECT COUNT(*)::int as count FROM notifications WHERE type = 'task_escalated'`);
  assert.strictEqual(notifs[0].count, 0, 'no escalation notifications should be sent');
});

// POST /api/cycles/:id/groups/delete: no route-level coverage existed before
// this, despite it being the most destructive route in the branch (up to a
// whole group's worth of task rows plus every completion against them).
test('a supervisor cannot delete a whole group', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  await mkTask(live, w.mem1, w.catId, 'CBT');
  const cookie = await login('sup1', 'pw');

  const res = await fetch(`${baseUrl}/api/cycles/${live}/groups/delete`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ category_code: w.catCode, title: 'CBT' }),
  });
  assert.strictEqual(res.status, 403, 'group delete is leadership-only');
});

test('deleting a group with completions warns with the checked-off count', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const a = await mkTask(live, w.mem1, w.catId, 'CBT');
  const b = await mkTask(live, w.mem2, w.catId, 'CBT');
  await pool.query(`INSERT INTO task_completions (task_id, completed_by_id, state)
                    VALUES ($1,$2,'done'), ($3,$4,'done')`, [a, w.mem1, b, w.mem2]);
  const cookie = await login('lead', 'pw');

  const res = await fetch(`${baseUrl}/api/cycles/${live}/groups/delete`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ category_code: w.catCode, title: 'CBT' }),
  });
  assert.strictEqual(res.status, 409);
  assert.strictEqual((await res.json()).checked_off_count, 2);

  const { rows } = await pool.query(`SELECT 1 FROM tasks WHERE id = ANY($1)`, [[a, b]]);
  assert.strictEqual(rows.length, 2, 'the refused delete must not have removed anything');
});

test('retrying a checked-off group delete with force in the body succeeds', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const a = await mkTask(live, w.mem1, w.catId, 'CBT');
  await pool.query(`INSERT INTO task_completions (task_id, completed_by_id, state)
                    VALUES ($1,$2,'done')`, [a, w.mem1]);
  const cookie = await login('lead', 'pw');

  const res = await fetch(`${baseUrl}/api/cycles/${live}/groups/delete`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ category_code: w.catCode, title: 'CBT', force: true }),
  });
  assert.strictEqual(res.status, 200, 'force in the JSON body is this route\'s own established idiom');

  const { rows } = await pool.query(`SELECT 1 FROM tasks WHERE id=$1`, [a]);
  assert.strictEqual(rows.length, 0);
});

test('retrying a checked-off group delete with ?force=true in the query also succeeds', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const a = await mkTask(live, w.mem1, w.catId, 'CBT');
  await pool.query(`INSERT INTO task_completions (task_id, completed_by_id, state)
                    VALUES ($1,$2,'done')`, [a, w.mem1]);
  const cookie = await login('lead', 'pw');

  // Every sibling force-capable route (DELETE /api/tasks/:id, DELETE
  // /api/batches/:id) reads force from the query string. A caller reaching
  // for that same idiom here must not be silently un-forced.
  const res = await fetch(`${baseUrl}/api/cycles/${live}/groups/delete?force=true`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ category_code: w.catCode, title: 'CBT' }),
  });
  assert.strictEqual(res.status, 200, 'the ?force=true query idiom must work here too');

  const { rows } = await pool.query(`SELECT 1 FROM tasks WHERE id=$1`, [a]);
  assert.strictEqual(rows.length, 0);
});
