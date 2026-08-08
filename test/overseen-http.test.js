// Coverage for /api/shop/overseen — the endpoint that fills the My Shop shop
// switcher, and the only thing deciding which shops a leader is offered.
//
// The rule has two halves and this file pins both, because widening one is the
// easy way to silently break the other:
//   - a flight leader still sees only their own flight (Cody's old behaviour)
//   - a roster admin sees the whole squadron regardless of flight (the fix)
//
// The second case is the regression that prompted this: MSgt McNaughton carries
// flight 'R&O', so the switcher offered him Operations/EA/C2 only, even though
// the Roster page already showed him every member in the squadron.
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

const PW = 'testpass123';

// Shop names must match server.js's SHOP_TO_FLIGHT for flight scoping to mean
// anything: Operations+EA are R&O, HVAC is Infrastructure, C2 is Squadron Staff.
async function seedWorld() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);

  const shops = {};
  for (const name of ['Operations', 'EA', 'HVAC', 'C2']) {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO shops (name) VALUES ($1) RETURNING id`, [name]);
    shops[name] = id;
  }

  const add = async (slug, role, shopId, flight, admin = false) => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug,
                            password_hash, active, must_change_password,
                            flight, can_manage_roster)
       VALUES ($1,'Test','MSgt',$2,$3,$4,$5,true,false,$6,$7) RETURNING id`,
      [slug, shopId, role, slug, hash, flight, admin]);
    return id;
  };

  await add('flightlead', 'leadership', shops.Operations, 'R&O');
  await add('adminlead', 'leadership', shops.Operations, 'R&O', true);
  await add('staff', 'leadership', shops.C2, 'Squadron Staff');
  await add('plainsup', 'supervisor', shops.HVAC, 'Infrastructure');

  return shops;
}

const names = body => body.shops.map(s => s.name).sort();

test('a flight leader is still scoped to their own flight', async () => {
  await seedWorld();
  const res = await fetch(`${baseUrl}/api/shop/overseen`,
    { headers: { Cookie: await login('flightlead', PW) } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  // R&O is Operations + EA. HVAC and C2 belong to other flights.
  assert.deepStrictEqual(names(body), ['EA', 'Operations']);
});

test('a roster admin sees every shop despite a non-squadron flight', async () => {
  const shops = await seedWorld();
  const res = await fetch(`${baseUrl}/api/shop/overseen`,
    { headers: { Cookie: await login('adminlead', PW) } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(names(body), ['C2', 'EA', 'HVAC', 'Operations']);
  // Own shop still drives which entry the dropdown preselects.
  assert.strictEqual(body.ownShopId, shops.Operations);
});

test('squadron staff still see every shop', async () => {
  await seedWorld();
  const res = await fetch(`${baseUrl}/api/shop/overseen`,
    { headers: { Cookie: await login('staff', PW) } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(names(await res.json()),
    ['C2', 'EA', 'HVAC', 'Operations']);
});

test('a supervisor cannot reach the endpoint at all', async () => {
  await seedWorld();
  const res = await fetch(`${baseUrl}/api/shop/overseen`,
    { headers: { Cookie: await login('plainsup', PW) } });
  assert.strictEqual(res.status, 403);
});

test('an unauthenticated request is rejected before any scope logic', async () => {
  await seedWorld();
  assert.strictEqual((await fetch(`${baseUrl}/api/shop/overseen`)).status, 401);
});
