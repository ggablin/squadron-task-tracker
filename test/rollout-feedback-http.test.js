// Coverage for the August 2026 rollout-feedback features:
//
//   1. Present-vs-all rollups — the lib/presence.js rule (a member is present
//      unless attendance marks them away in every marked period; unmarked
//      counts as present) as it surfaces through /api/squadron and
//      /api/squadron/members?present=true.
//   2. Category drill-in — /api/squadron/categories/:code/tasks names each
//      task and exactly who still owes it, with the away flag.
//   3. Student Flight — the First Sergeant's list: add / edit dates / remove,
//      date validation, and the leadership gate.
//   4. My Shop category view — /api/shop/tasks scoping (own shop for
//      supervisors, ?shop_id for leadership, 403 for members).
//   5. Task helpers — link/form validation and that every authoring surface
//      (supervisor add, builder add, group edit, copy-forward) carries them.
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

async function login(slug) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, password: PW }),
  });
  assert.strictEqual(res.status, 200, `login as ${slug} should succeed`);
  return cookieFrom(res);
}

const api = (cookie, method, path, body) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const PW = 'testpass123';

// One live cycle, two shops. Alpha is marked away (RUTA in the only marked
// period), Charlie is positively present, everyone else is unmarked. The
// 'upgrade' category is informational by lib/informational.js's rule, so
// Bravo's notice must stay out of every denominator.
async function seedWorld() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);

  const { rows: [cycle] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status, period_count)
     VALUES ('Test UTA', true, 'live', 4) RETURNING id`);

  const shops = {};
  for (const name of ['Structures', 'HVAC']) {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO shops (name) VALUES ($1) RETURNING id`, [name]);
    shops[name] = id;
  }

  const cats = {};
  for (const [code, label, sort] of [['admin', 'Admin', 1], ['cbt', 'CBT', 2], ['upgrade', 'Upgrade Training', 3]]) {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO task_categories (code, label, sort_order) VALUES ($1,$2,$3) RETURNING id`,
      [code, label, sort]);
    cats[code] = id;
  }

  const add = async (slug, role, shopId) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug,
                            password_hash, active, must_change_password)
       VALUES ($1,'Test','SSgt',$2,$3,$4,$5,true,false) RETURNING id`,
      [slug, shopId, role, slug, hash]);
    return id;
  };

  const ids = {
    cycle: cycle.id, shops, cats,
    lead: await add('lead', 'leadership', shops.Structures),
    sup: await add('sup', 'supervisor', shops.Structures),
    supB: await add('supb', 'supervisor', shops.HVAC),
    alpha: await add('alpha', 'member', shops.Structures),
    bravo: await add('bravo', 'member', shops.Structures),
    charlie: await add('charlie', 'member', shops.HVAC),
  };

  const task = async (memberId, catId, title, urgency = 'this_uta') => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [cycle.id, memberId, catId, title, urgency]);
    return id;
  };
  ids.tAlphaAdmin   = await task(ids.alpha, cats.admin, 'File eval');
  ids.tBravoAdmin   = await task(ids.bravo, cats.admin, 'File eval');
  ids.tAlphaCbt     = await task(ids.alpha, cats.cbt, 'Cyber CBT');
  ids.tBravoNotice  = await task(ids.bravo, cats.upgrade, 'CDC notice');
  ids.tCharlieAdmin = await task(ids.charlie, cats.admin, 'File eval');

  await pool.query(
    `INSERT INTO task_completions (task_id, completed_by_id, state)
     VALUES ($1,$2,'done')`, [ids.tBravoAdmin, ids.bravo]);

  // Alpha away, Charlie present, everyone else unmarked.
  await pool.query(
    `INSERT INTO attendance (uta_cycle_id, member_id, shop_id, period, status)
     VALUES ($1,$2,$3,1,'ruta_excused'), ($1,$4,$5,1,'present')`,
    [cycle.id, ids.alpha, shops.Structures, ids.charlie, shops.HVAC]);

  const doc = async (title, active) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO documents (title, category, filename, mime, byte_size, content, active)
       VALUES ($1,'Forms','form.pdf','application/pdf',8,$2,$3) RETURNING id`,
      [title, Buffer.from('%PDF-1.4'), active]);
    return id;
  };
  ids.docActive = await doc('Dental Form', true);
  ids.docGone = await doc('Old Form', false);

  return ids;
}

/* ── 1. Present-vs-all rollups ─────────────────────────────────────────── */

test('squadron rollup carries both flavors and applies the presence rule', async () => {
  const w = await seedWorld();
  const res = await api(await login('lead'), 'GET', '/api/squadron');
  assert.strictEqual(res.status, 200);
  const rows = await res.json();

  const structures = rows.find(r => r.shop === 'Structures');
  // 4 members; only Alpha is marked away (RUTA, no present period).
  assert.strictEqual(+structures.member_count, 4);
  assert.strictEqual(+structures.present_count, 3);
  // 3 checkable tasks (the CDC notice is informational), 1 done.
  assert.strictEqual(+structures.total_tasks, 3);
  assert.strictEqual(+structures.done_tasks, 1);
  // Present-only drops Alpha's two open tasks; Bravo's done one remains.
  assert.strictEqual(+structures.total_tasks_present, 1);
  assert.strictEqual(+structures.done_tasks_present, 1);

  const hvac = rows.find(r => r.shop === 'HVAC');
  // Charlie is positively present, Supb unmarked — both count as present.
  assert.strictEqual(+hvac.present_count, 2);
  assert.strictEqual(+hvac.total_tasks_present, 1);
});

test('a member with one present period among away marks still counts present', async () => {
  const w = await seedWorld();
  // Alpha gains a present period alongside the RUTA one → present again.
  await pool.query(
    `INSERT INTO attendance (uta_cycle_id, member_id, shop_id, period, status)
     VALUES ($1,$2,$3,2,'present')`, [w.cycle, w.alpha, w.shops.Structures]);
  const rows = await (await api(await login('lead'), 'GET', '/api/squadron')).json();
  const structures = rows.find(r => r.shop === 'Structures');
  assert.strictEqual(+structures.present_count, 4);
  assert.strictEqual(+structures.total_tasks_present, 3);
});

test('categories rollup gets present columns and members?present=true excludes the away', async () => {
  await seedWorld();
  const cookie = await login('lead');

  const cats = await (await api(cookie, 'GET', '/api/squadron/categories')).json();
  const admin = cats.find(c => c.code === 'admin');
  assert.strictEqual(+admin.total, 3);
  assert.strictEqual(+admin.done, 1);
  assert.strictEqual(+admin.total_present, 2);   // Alpha's row drops
  assert.strictEqual(+admin.done_present, 1);
  // Informational category never appears.
  assert.ok(!cats.find(c => c.code === 'upgrade'));

  const behindAll = await (await api(cookie, 'GET', '/api/squadron/members')).json();
  assert.ok(behindAll.find(m => m.last_name === 'alpha'));
  assert.strictEqual(behindAll.find(m => m.last_name === 'alpha').present, false);

  const behindPresent = await (await api(cookie, 'GET', '/api/squadron/members?present=true')).json();
  assert.ok(!behindPresent.find(m => m.last_name === 'alpha'),
    'away members must not appear in the present-only most-behind list');
});

/* ── 2. Category drill-in ──────────────────────────────────────────────── */

test('category drill-in names each task and exactly who still owes it', async () => {
  await seedWorld();
  const res = await api(await login('lead'), 'GET', '/api/squadron/categories/admin/tasks');
  assert.strictEqual(res.status, 200);
  const rows = await res.json();
  assert.strictEqual(rows.length, 1);

  const fileEval = rows[0];
  assert.strictEqual(fileEval.title, 'File eval');
  assert.strictEqual(+fileEval.total, 3);
  assert.strictEqual(+fileEval.done, 1);
  const owed = fileEval.not_done.map(m => m.last_name).sort();
  assert.deepStrictEqual(owed, ['alpha', 'charlie']);
  assert.strictEqual(fileEval.not_done.find(m => m.last_name === 'alpha').present, false);
  assert.strictEqual(fileEval.not_done.find(m => m.last_name === 'charlie').present, true);
  assert.strictEqual(fileEval.not_done.find(m => m.last_name === 'charlie').shop, 'HVAC');
});

test('drill-in excludes informational rows and is leadership-only', async () => {
  await seedWorld();
  const lead = await login('lead');
  const upgrade = await (await api(lead, 'GET', '/api/squadron/categories/upgrade/tasks')).json();
  assert.deepStrictEqual(upgrade, []);

  const asSup = await api(await login('sup'), 'GET', '/api/squadron/categories/admin/tasks');
  assert.strictEqual(asSup.status, 403);
});

/* ── 3. Student Flight ─────────────────────────────────────────────────── */

test('student flight: add with dates, list, candidates shrink, edit survives removal', async () => {
  const w = await seedWorld();
  const cookie = await login('lead');

  let res = await api(cookie, 'PATCH', `/api/squadron/students/${w.alpha}`, {
    is_student_flight: true,
    bmt_start: '2026-09-14', bmt_grad: '2026-11-06',
    tech_start: '2026-11-10',
    student_notes: '3E3X1 pipeline',
  });
  assert.strictEqual(res.status, 200);

  let body = await (await api(cookie, 'GET', '/api/squadron/students')).json();
  assert.strictEqual(body.students.length, 1);
  const s = body.students[0];
  assert.strictEqual(s.last_name, 'alpha');
  assert.strictEqual(s.bmt_start, '2026-09-14');
  assert.strictEqual(s.bmt_grad, '2026-11-06');
  assert.strictEqual(s.tech_start, '2026-11-10');
  assert.strictEqual(s.tech_grad, null);
  assert.strictEqual(s.student_notes, '3E3X1 pipeline');
  assert.ok(!body.candidates.find(c => c.id === w.alpha),
    'a current student must not appear in the add picker');

  // Remove keeps the dates for a later return to the pipeline.
  res = await api(cookie, 'PATCH', `/api/squadron/students/${w.alpha}`, { is_student_flight: false });
  assert.strictEqual(res.status, 200);
  body = await (await api(cookie, 'GET', '/api/squadron/students')).json();
  assert.strictEqual(body.students.length, 0);

  res = await api(cookie, 'PATCH', `/api/squadron/students/${w.alpha}`, { is_student_flight: true });
  assert.strictEqual(res.status, 200);
  body = await (await api(cookie, 'GET', '/api/squadron/students')).json();
  assert.strictEqual(body.students[0].bmt_start, '2026-09-14');
});

test('student flight: malformed dates are rejected, and the gate is leadership', async () => {
  const w = await seedWorld();
  const lead = await login('lead');

  const bad = await api(lead, 'PATCH', `/api/squadron/students/${w.alpha}`, { bmt_grad: 'Nov 6' });
  assert.strictEqual(bad.status, 400);

  const noop = await api(lead, 'PATCH', `/api/squadron/students/${w.alpha}`, {});
  assert.strictEqual(noop.status, 400);

  const sup = await login('sup');
  assert.strictEqual((await api(sup, 'GET', '/api/squadron/students')).status, 403);
  assert.strictEqual(
    (await api(sup, 'PATCH', `/api/squadron/students/${w.alpha}`, { is_student_flight: true })).status, 403);
});

/* ── 4. My Shop category view ──────────────────────────────────────────── */

test('shop tasks: supervisors get their own shop, leadership can switch, members get 403', async () => {
  const w = await seedWorld();

  const sup = await login('sup');
  let rows = await (await api(sup, 'GET', '/api/shop/tasks')).json();
  // Structures only, informational excluded: alpha×2 + bravo×1.
  assert.strictEqual(rows.length, 3);
  assert.ok(rows.every(r => ['alpha', 'bravo'].includes(r.last_name)));
  assert.ok(!rows.find(r => r.title === 'CDC notice'));
  const alphaRow = rows.find(r => r.last_name === 'alpha');
  assert.strictEqual(alphaRow.present, false, 'away member is flagged for the chip badge');
  assert.strictEqual(rows.find(r => r.last_name === 'bravo').state, 'done');

  // A supervisor asking for another shop still gets their own (param is
  // leadership-only, mirroring /api/shop/members).
  rows = await (await api(sup, 'GET', `/api/shop/tasks?shop_id=${w.shops.HVAC}`)).json();
  assert.ok(rows.every(r => ['alpha', 'bravo'].includes(r.last_name)));

  const lead = await login('lead');
  rows = await (await api(lead, 'GET', `/api/shop/tasks?shop_id=${w.shops.HVAC}`)).json();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].last_name, 'charlie');

  assert.strictEqual((await api(await login('alpha'), 'GET', '/api/shop/tasks')).status, 403);
});

/* ── 5. Task helpers ───────────────────────────────────────────────────── */

test('helpers are validated on create: scheme-checked link, live document only', async () => {
  const w = await seedWorld();
  const sup = await login('sup');
  const base = { member_id: w.alpha, category_code: 'cbt', title: 'Helper task' };

  let res = await api(sup, 'POST', '/api/tasks', { ...base, link_url: 'javascript:alert(1)' });
  assert.strictEqual(res.status, 400);
  res = await api(sup, 'POST', '/api/tasks', { ...base, link_url: 'ftp://files.example.mil' });
  assert.strictEqual(res.status, 400);
  res = await api(sup, 'POST', '/api/tasks', { ...base, document_id: w.docGone });
  assert.strictEqual(res.status, 400, 'an inactive document must not attach');

  res = await api(sup, 'POST', '/api/tasks', {
    ...base, link_url: 'https://cbt.example.mil/course', document_id: w.docActive,
  });
  assert.strictEqual(res.status, 200);

  // The member sees both helpers, with the form's display title resolved.
  const mine = await (await api(await login('alpha'), 'GET', '/api/tasks')).json();
  const t = mine.find(x => x.title === 'Helper task');
  assert.strictEqual(t.link_url, 'https://cbt.example.mil/course');
  assert.strictEqual(t.document_id, w.docActive);
  assert.strictEqual(t.document_title, 'Dental Form');
});

test('definition edit updates and clears helpers', async () => {
  const w = await seedWorld();
  const sup = await login('sup');

  let res = await api(sup, 'PUT', `/api/tasks/${w.tAlphaCbt}/definition`, {
    link_url: 'https://mypers.example.mil', document_id: w.docActive,
  });
  assert.strictEqual(res.status, 200);
  let { rows: [row] } = await pool.query(
    `SELECT link_url, document_id FROM tasks WHERE id = $1`, [w.tAlphaCbt]);
  assert.strictEqual(row.link_url, 'https://mypers.example.mil');
  assert.strictEqual(row.document_id, w.docActive);

  res = await api(sup, 'PUT', `/api/tasks/${w.tAlphaCbt}/definition`, {
    link_url: null, document_id: null,
  });
  assert.strictEqual(res.status, 200);
  ({ rows: [row] } = await pool.query(
    `SELECT link_url, document_id FROM tasks WHERE id = $1`, [w.tAlphaCbt]));
  assert.strictEqual(row.link_url, null);
  assert.strictEqual(row.document_id, null);

  res = await api(sup, 'PUT', `/api/tasks/${w.tAlphaCbt}/definition`, { link_url: 'not-a-url' });
  assert.strictEqual(res.status, 400);
});

test('group edit applies helpers to every row in the group', async () => {
  const w = await seedWorld();
  const res = await api(await login('lead'), 'PUT', `/api/cycles/${w.cycle}/groups`, {
    category_code: 'admin', title: 'File eval',
    link_url: 'https://myeval.example.mil', document_id: w.docActive,
  });
  assert.strictEqual(res.status, 200);
  const { rows } = await pool.query(
    `SELECT link_url, document_id FROM tasks
     WHERE uta_cycle_id = $1 AND title = 'File eval'`, [w.cycle]);
  assert.strictEqual(rows.length, 3);
  assert.ok(rows.every(r => r.link_url === 'https://myeval.example.mil' && r.document_id === w.docActive));
});

test('builder add and copy-forward both carry helpers', async () => {
  const w = await seedWorld();
  const lead = await login('lead');

  let res = await api(lead, 'POST', `/api/cycles/${w.cycle}/tasks`, {
    title: 'SGLI update', category_code: 'admin',
    link_url: 'https://milconnect.example.mil', document_id: w.docActive,
    assignments: [{ member_ids: [w.alpha, w.bravo], urgency: 'this_uta' }],
  });
  assert.strictEqual(res.status, 200);
  const { rows: added } = await pool.query(
    `SELECT link_url, document_id FROM tasks WHERE title = 'SGLI update'`);
  assert.strictEqual(added.length, 2);
  assert.ok(added.every(r => r.link_url === 'https://milconnect.example.mil' && r.document_id === w.docActive));

  res = await api(lead, 'POST', `/api/cycles/${w.cycle}/tasks`, {
    title: 'Bad helper', category_code: 'admin', link_url: 'javascript:x',
    assignments: [{ member_ids: [w.alpha], urgency: 'this_uta' }],
  });
  assert.strictEqual(res.status, 400, 'builder add validates helpers like every other route');

  // Copy the helper-carrying group into a fresh draft: the rows keep both.
  const { rows: [draft] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, period_count) VALUES ('Next UTA','draft',4) RETURNING id`);
  res = await api(lead, 'POST', `/api/cycles/${draft.id}/copy-forward`, {
    from_cycle_id: w.cycle,
    groups: [{ category_code: 'admin', title: 'SGLI update' }],
  });
  assert.strictEqual(res.status, 200);
  const { rows: copied } = await pool.query(
    `SELECT link_url, document_id FROM tasks WHERE uta_cycle_id = $1 AND title = 'SGLI update'`, [draft.id]);
  assert.strictEqual(copied.length, 2);
  assert.ok(copied.every(r => r.link_url === 'https://milconnect.example.mil' && r.document_id === w.docActive));
});
