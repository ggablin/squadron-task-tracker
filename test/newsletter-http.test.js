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
const { fmtRange } = require('../newsletter/from-db');
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

// The other half of rsdSchedule's gate. buildYear() fills every month no drill
// touches with a no_uta entry, so cal.entries is never empty on its own: an
// ungated slide prints twelve "NO UTA" lines for a year nobody has entered drills
// for yet, which is what would have gone out to ~70 readers. The populated year
// above exercises the true branch; this one exercises the false branch.
test('a year with no drills prints the empty note, not twelve NO UTA lines', async () => {
  await seed();   // seeds drill_dates for 2026 only
  const { rows: [cycle] } = await pool.query(
    `INSERT INTO uta_cycles (name, start_date, end_date, is_current, status)
     VALUES ('February 2027 UTA', DATE '2027-02-05', DATE '2027-02-07', false, 'live')
     RETURNING id`);
  const res = await fetch(`${baseUrl}/newsletter?uta=${cycle.id}`,
    { headers: { Cookie: await login('leadtest') } });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /RSD Schedule — CY 2027/, 'the slide is printed for the cycle asked for');
  assert.match(html, /No drill dates recorded in the tracker for this UTA\./,
    'the empty note stands in for the whole list');
  assert.doesNotMatch(html, /NO UTA/,
    'not one no_uta line may escape the gate, let alone twelve');
  assert.strictEqual((html.match(/<section class="slide/g) || []).length, 23,
    'the slide still renders — an empty year is not a missing slide');
});

// The cover's date range is the one place the newsletter prints the drill's own
// dates, and fmtRange used to read getUTC* fields off a LOCAL-midnight Date. Both
// shapes that reach it produced one: node-pg parses a DATE column to local
// midnight, and `new Date(str + 'T00:00:00')` — no Z — parses the to_char'd
// string the same way, which quietly undid the start_iso fix from #85. Under
// TZ=Asia/Tokyo the cover of the 11–13 Sep 2026 drill printed "10–12 Sep 2026".
//
// The zone has to be forced here or this test proves nothing: production runs UTC
// and the CI/dev host zone is *behind* UTC, the one direction where this family
// cannot appear (MEMORY.md §8a, §8b).
test('the cover prints the drill it is for, not the day before, in a zone ahead of UTC',
  async () => {
    await seed();
    const { rows: [cycle] } = await pool.query(
      `INSERT INTO uta_cycles (name, start_date, end_date, is_current, status)
       VALUES ('September 2026 UTA', DATE '2026-09-11', DATE '2026-09-13', false, 'live')
       RETURNING id`);
    const cookie = await login('leadtest');

    // process.env.TZ is honoured at runtime, but deleting it does NOT restore the
    // host zone — so put back the resolved name, not the (unset) variable.
    const prevTz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      process.env.TZ = 'Asia/Tokyo';
      assert.strictEqual(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Tokyo',
        'the forced zone must actually take, or the rest of this test is a no-op');

      // Shape 1: a to_char'd 'YYYY-MM-DD' string.
      assert.strictEqual(fmtRange('2026-09-11', '2026-09-13'), '11–13 Sep 2026');
      // Shape 2: what node-pg hands back for a bare DATE — a Date at LOCAL
      // midnight, so it is built inside the forced zone to be representative.
      assert.strictEqual(fmtRange(new Date(2026, 8, 11), new Date(2026, 8, 13)), '11–13 Sep 2026');

      // …and end to end, with node-pg doing the parsing for real.
      const res = await fetch(`${baseUrl}/newsletter?uta=${cycle.id}`, { headers: { Cookie: cookie } });
      assert.strictEqual(res.status, 200);
      assert.match(await res.text(), /<div class="cover-sub">11–13 Sep 2026 ·/,
        'the rendered cover carries the cycle\'s own dates');
    } finally {
      process.env.TZ = prevTz;
    }
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
