// The newsletter page renders the whole squadron's record — every member's medical
// requirements, EPB status and overdue CBTs — server side, in one response.
//
// /build, /export and /roster are gated by requireLeadershipPage, which only proves
// *someone* is signed in; their real protection is the leadership-only API their
// shell calls afterwards. This route has no such second gate, so the role check has
// to be on the route itself. These tests exist to stop anyone "tidying" it back to
// requireLeadershipPage for consistency and silently opening the squadron's record
// to all 70 members.
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
  await applySchema();
  await new Promise((resolve, reject) => {
    server = app.listen(0, err => (err ? reject(err) : resolve()));
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { await new Promise(r => server.close(r)); });

function cookieFrom(res) {
  const c = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return c.length ? c[0].split(';')[0] : null;
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

async function seed() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);
  const { rows: [{ id: shop }] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const add = (slug, role) => pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active, must_change_password)
     VALUES ($1,'Test','SSgt',$2,$3,$4,$5,true,false)`, [slug, shop, role, slug, hash]);
  await add('leadtest', 'leadership');
  await add('suptest', 'supervisor');
  await add('memtest', 'member');
  await pool.query(
    `INSERT INTO uta_cycles (name, start_date, end_date, is_current, status)
     VALUES ('August 2026 UTA', DATE '2026-08-08', DATE '2026-08-09', true, 'live')`);
  await pool.query(`
    INSERT INTO additional_duties (duty, primary_owner, alternate_owner) VALUES
      ('Lodging Monitor', 'Glikin', 'King'),
      ('Records Management / FARM', NULL, NULL)`);
  await pool.query(`
    INSERT INTO drill_dates (start_date, end_date, note) VALUES
      (DATE '2026-06-05', DATE '2026-06-07', NULL),
      (DATE '2026-08-08', DATE '2026-08-09', NULL),
      (DATE '2026-09-11', DATE '2026-09-13', NULL)`);
}

const get = (cookie) => fetch(`${baseUrl}/newsletter`, {
  headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual',
});

test('a signed-out visitor is sent to the login screen, not shown the newsletter', async () => {
  await seed();
  const res = await get(null);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/');
});

test('a plain member cannot read the squadron newsletter', async () => {
  await seed();
  const res = await get(await login('memtest'));
  assert.strictEqual(res.status, 403);
  const body = await res.text();
  assert.ok(!/EPB|Medical & Dental|Computer-Based Training/.test(body),
    'the 403 body must not leak any section of the newsletter');
});

test('a supervisor cannot read it either — it is squadron-wide, not shop-scoped', async () => {
  await seed();
  const res = await get(await login('suptest'));
  assert.strictEqual(res.status, 403);
});

test('leadership gets the full deck, built from the live cycle', async () => {
  await seed();
  const res = await get(await login('leadtest'));
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /August 2026 UTA/, 'renders the cycle that is currently live');
  assert.strictEqual((html.match(/<section class="slide/g) || []).length, 23,
    'all 23 sections render even when the cycle is thinly populated');
  assert.ok(!/(?:src|href)="(?!data:)/.test(html),
    'the page must stay self-contained so it survives being emailed');
});

test('the duties and RSD slides render from the tables, relative to the cycle being printed', async () => {
  await seed();
  const html = await (await get(await login('leadtest'))).text();
  assert.match(html, /Additional Duties List/);
  assert.match(html, /<td>Lodging Monitor<\/td><td>Glikin<\/td><td>King<\/td>/);
  assert.match(html, /<tr class="red"><td>Records Management \/ FARM<\/td><td>—<\/td><td>—<\/td>/,
    'a duty with no primary owner prints red');
  assert.match(html, /RSD Schedule — CY 2026/);
  assert.match(html, /<s>5–7 Jun 2026 \(3-Day Drill\)<\/s>/, 'a drill that ended before this cycle is struck through');
  assert.match(html, /<b>8–9 Aug 2026<\/b>/, "this cycle's own drill is bold");
  assert.match(html, /<li>11–13 Sep 2026 \(3-Day Drill\)<\/li>/, 'a later drill is plain');
  assert.match(html, /NO UTA JULY 2026/);
  assert.strictEqual((html.match(/<section class="slide/g) || []).length, 23);
  assert.ok(!/(?:src|href)="(?!data:)/.test(html), 'still self-contained');
});

test('a malformed ?uta is rejected rather than silently falling back to the live cycle',
  async () => {
    await seed();
    const cookie = await login('leadtest');
    for (const bad of ['abc', '-1', '0']) {
      const res = await fetch(`${baseUrl}/newsletter?uta=${bad}`, { headers: { Cookie: cookie } });
      assert.strictEqual(res.status, 400, `?uta=${bad} should 400`);
    }
  });
