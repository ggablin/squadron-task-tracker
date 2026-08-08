// Coverage for work control — the Operations shop's reach over every shop's work
// orders, granted by shops.manages_work_orders rather than by rank.
//
// The rule has two edges and the dangerous one is the second:
//   - work control reaches every shop's WORK ORDERS, at any rank
//   - work control reaches NOTHING ELSE, including in its own shop
//
// The second edge is what these tests are mostly about. The flag is held by a
// SrA, so if the scope leaked, a plain Airman would be rewriting all ten shops'
// schedules. The subtlest leak is via PUT: edit a work order and set event_type
// to 'schedule', and a caller walks out of its own scope one edit at a time —
// which is why the edit test below exists.
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

const PW = 'testpass123';
const send = (method, path, cookie, body) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const get = (path, cookie) => fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });

async function seedWorld() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);

  const shop = async (name, managesWo = false) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO shops (name, manages_work_orders) VALUES ($1,$2) RETURNING id`,
      [name, managesWo]);
    return id;
  };
  const ops = await shop('Operations', true);
  const hvac = await shop('HVAC');
  const structures = await shop('Structures');

  const add = async (slug, role, shopId) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug,
                            password_hash, active, must_change_password)
       VALUES ($1,'Test','SrA',$2,$3,$4,$5,true,false) RETURNING id`,
      [slug, shopId, role, slug, hash]);
    return id;
  };
  await add('opsmem', 'member', ops);          // the case that matters: rank 0
  await add('opssup', 'supervisor', ops);
  await add('hvacsup', 'supervisor', hvac);
  await add('hvacmem', 'member', hvac);
  await add('lead', 'leadership', structures);

  const { rows: [{ id: cycleId }] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('Aug 2026','live',true)
     RETURNING id`);

  const event = async (shopId, type, title) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO shop_events (uta_cycle_id, shop_id, event_type, title, status)
       VALUES ($1,$2,$3,$4,'open') RETURNING id`, [cycleId, shopId, type, title]);
    return id;
  };

  return {
    ops, hvac, structures, cycleId,
    hvacWo:    await event(hvac, 'work_order', 'Replace AHU belt'),
    hvacSched: await event(hvac, 'schedule',   'HVAC recall roster'),
    structWo:  await event(structures, 'work_order', 'Patch bay door'),
    opsSched:  await event(ops, 'schedule', 'Work Control turnover'),
  };
}

/* ── The board ──────────────────────────────────────────────────────────── */

test('work control sees every shop\'s work orders, with the shop named', async () => {
  const w = await seedWorld();
  const res = await get('/api/work-orders', await login('opsmem'));
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.deepStrictEqual(
    body.work_orders.map(r => `${r.shop}: ${r.title}`).sort(),
    ['HVAC: Replace AHU belt', 'Structures: Patch bay door']);
  // Schedules are not work orders and must not appear on the board.
  assert.ok(body.work_orders.every(r => r.event_type === 'work_order'));
  // Shops ride along so the create form can offer a target without a second call.
  assert.deepStrictEqual(body.shops.map(s => s.name), ['HVAC', 'Operations', 'Structures']);
  assert.ok(body.shops.some(s => s.id === w.hvac));
});

test('a supervisor outside work control cannot open the board', async () => {
  await seedWorld();
  assert.strictEqual((await get('/api/work-orders', await login('hvacsup'))).status, 403);
});

/* ── Reach across shops ─────────────────────────────────────────────────── */

test('work control files a work order against another shop', async () => {
  const w = await seedWorld();
  const res = await send('POST', '/api/shop/events', await login('opsmem'), {
    event_type: 'work_order', title: 'Replace exhaust fan', shop_id: w.hvac,
  });
  assert.strictEqual(res.status, 200);
  const created = await res.json();
  assert.strictEqual(created.shop_id, w.hvac, 'must land in HVAC, not Operations');
});

test('work control edits and then deletes another shop\'s work order', async () => {
  const w = await seedWorld();
  const cookie = await login('opsmem');

  const put = await send('PUT', `/api/shop/events/${w.hvacWo}`, cookie, {
    event_type: 'work_order', title: 'Replace AHU belt (parts on order)',
  });
  assert.strictEqual(put.status, 200);
  assert.strictEqual((await put.json()).title, 'Replace AHU belt (parts on order)');

  const del = await send('DELETE', `/api/shop/events/${w.hvacWo}`, cookie);
  assert.strictEqual(del.status, 200);
  const { rows } = await pool.query('SELECT 1 FROM shop_events WHERE id = $1', [w.hvacWo]);
  assert.strictEqual(rows.length, 0);
});

test('work control closes another shop\'s work order and can read the history', async () => {
  const w = await seedWorld();
  const cookie = await login('opsmem');

  const res = await send('PUT', `/api/shop/events/${w.hvacWo}/status`, cookie,
    { status: 'complete', note: 'Belt replaced, unit back on line.' });
  assert.strictEqual(res.status, 200);

  const { rows } = await pool.query(
    'SELECT status FROM shop_events WHERE id = $1', [w.hvacWo]);
  assert.strictEqual(rows[0].status, 'complete');

  const log = await get(`/api/shop/events/${w.hvacWo}/log`, cookie);
  assert.strictEqual(log.status, 200);
  const entries = await log.json();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].note, 'Belt replaced, unit back on line.');
});

/* ── The scope, which is the part that can go wrong quietly ─────────────── */

test('work control cannot create a schedule in another shop', async () => {
  const w = await seedWorld();
  const res = await send('POST', '/api/shop/events', await login('opsmem'), {
    event_type: 'schedule', title: 'Mandatory HVAC formation', shop_id: w.hvac,
  });
  assert.strictEqual(res.status, 403);
});

test('work control cannot create a schedule in its OWN shop either', async () => {
  await seedWorld();
  // The flag is a job description, not a promotion: it grants work orders
  // everywhere and nothing else anywhere, including at home.
  const res = await send('POST', '/api/shop/events', await login('opsmem'), {
    event_type: 'schedule', title: 'Work Control shift change',
  });
  assert.strictEqual(res.status, 403);
});

test('work control cannot edit or delete another shop\'s schedule', async () => {
  const w = await seedWorld();
  const cookie = await login('opsmem');
  const put = await send('PUT', `/api/shop/events/${w.hvacSched}`, cookie,
    { event_type: 'schedule', title: 'Rewritten by work control' });
  assert.strictEqual(put.status, 403);
  assert.strictEqual((await send('DELETE', `/api/shop/events/${w.hvacSched}`, cookie)).status, 403);
});

test('work control cannot convert a work order into a schedule', async () => {
  const w = await seedWorld();
  // The escape hatch: the stored row is a work order, so a check on the stored
  // type alone would allow this, and the row would land in HVAC's schedule.
  const res = await send('PUT', `/api/shop/events/${w.hvacWo}`, await login('opsmem'),
    { event_type: 'schedule', title: 'Now a schedule item' });
  assert.strictEqual(res.status, 403);

  const { rows } = await pool.query(
    'SELECT event_type FROM shop_events WHERE id = $1', [w.hvacWo]);
  assert.strictEqual(rows[0].event_type, 'work_order', 'row must be untouched');
});

test('work control cannot touch another shop\'s schedule log', async () => {
  const w = await seedWorld();
  assert.strictEqual(
    (await get(`/api/shop/events/${w.hvacSched}/log`, await login('opsmem'))).status, 403);
});

/* ── No regression for everyone else ────────────────────────────────────── */

test('a shop supervisor still cannot reach another shop', async () => {
  const w = await seedWorld();
  const cookie = await login('hvacsup');
  assert.strictEqual((await send('POST', '/api/shop/events', cookie,
    { event_type: 'work_order', title: 'Not mine', shop_id: w.structures })).status, 403);
  assert.strictEqual((await send('DELETE', `/api/shop/events/${w.structWo}`, cookie)).status, 403);
});

test('a shop supervisor keeps full control of their own shop', async () => {
  const w = await seedWorld();
  const cookie = await login('hvacsup');
  const res = await send('POST', '/api/shop/events', cookie,
    { event_type: 'schedule', title: 'HVAC safety brief' });
  assert.strictEqual(res.status, 200, 'schedules in your own shop are unchanged');
  assert.strictEqual((await send('PUT', `/api/shop/events/${w.hvacSched}`, cookie,
    { event_type: 'schedule', title: 'Updated roster' })).status, 200);
});

test('a plain member outside work control still cannot write anything', async () => {
  await seedWorld();
  const res = await send('POST', '/api/shop/events', await login('hvacmem'),
    { event_type: 'work_order', title: 'Should be refused' });
  assert.strictEqual(res.status, 403);
});

test('leadership reach is unchanged', async () => {
  const w = await seedWorld();
  const cookie = await login('lead');
  assert.strictEqual((await send('POST', '/api/shop/events', cookie,
    { event_type: 'schedule', title: 'Squadron brief', shop_id: w.hvac })).status, 200);
});

/* ── The flag is read from the shop, not from the session ───────────────── */

test('moving someone out of Operations revokes the reach on the next request', async () => {
  const w = await seedWorld();
  const cookie = await login('opsmem');
  assert.strictEqual((await get('/api/work-orders', cookie)).status, 200);

  // Same session, same cookie — only the roster changed. The session flag says
  // they are still work control; the endpoints must not believe it.
  await pool.query(`UPDATE members SET shop_id = $1 WHERE slug = 'opsmem'`, [w.hvac]);

  assert.strictEqual((await get('/api/work-orders', cookie)).status, 403);
  assert.strictEqual((await send('POST', '/api/shop/events', cookie,
    { event_type: 'work_order', title: 'After the move', shop_id: w.structures })).status, 403);
});
