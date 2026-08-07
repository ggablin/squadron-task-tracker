const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');
const activity = require('../lib/activity');

test.before(applySchema);

// seedFixtures inserts three members with the schema defaults (must_change_password
// true, last_login_at null), so the baseline is "nobody has ever shown up".
const seenDaysAgo = (id, days) =>
  pool.query(`UPDATE members SET last_login_at = NOW() - ($2 || ' days')::interval WHERE id = $1`,
    [id, String(days)]);

const setOwnPassword = id =>
  pool.query(`UPDATE members SET must_change_password = false WHERE id = $1`, [id]);

const all = () => activity.memberActivity(pool, null);
const find = (r, id) => r.members.find(m => m.id === id);

test('a member with no recorded login and an issued password reads as never', async () => {
  await resetDb(); const f = await seedFixtures();
  const r = await all();
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.never, 3);
  assert.strictEqual(r.seen, 0);
  assert.strictEqual(find(r, f.m1).state, 'never');
});

test('a login date is what makes a member seen', async () => {
  await resetDb(); const f = await seedFixtures();
  await seenDaysAgo(f.m1, 4);

  const r = await all();
  assert.strictEqual(r.seen, 1);
  assert.strictEqual(r.never, 2);
  assert.strictEqual(find(r, f.m1).state, 'seen');
  assert.ok(find(r, f.m1).last_login_at instanceof Date);
});

test('setting their own password proves a sign-in even with no date on file', async () => {
  await resetDb(); const f = await seedFixtures();
  // The pre-tracking case: they onboarded before logins were recorded.
  await setOwnPassword(f.m1);

  const r = await all();
  assert.strictEqual(find(r, f.m1).state, 'unknown');
  assert.strictEqual(r.unknown, 1);
  assert.strictEqual(r.never, 2);
  assert.strictEqual(r.seen, 1, 'unknown-date members are not counted as missing');
});

test('active30 counts only dated logins inside the window', async () => {
  await resetDb(); const f = await seedFixtures();
  await seenDaysAgo(f.m1, 3);
  await seenDaysAgo(f.m2, 45);
  await setOwnPassword(f.leadId); // seen, but undated — cannot be inside any window

  const r = await all();
  assert.strictEqual(r.active30, 1);
  assert.strictEqual(r.seen, 3);
});

test('orders never, then undated, then stalest-dated first', async () => {
  await resetDb(); const f = await seedFixtures();
  await seenDaysAgo(f.m1, 2);      // becerra — most recent
  await setOwnPassword(f.m2);      // derose  — undated
  await seenDaysAgo(f.leadId, 60); // mcnaughton — stale
  // 'zulu' sorts last alphabetically, so leading the list can only come from state.
  await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active)
     VALUES ('zulu','Zed','AB',$1,'member','zulu','x',true)`, [f.shopId]);

  const r = await all();
  assert.deepStrictEqual(
    r.members.map(m => [m.last_name, m.state]),
    [['zulu', 'never'], ['derose', 'unknown'], ['mcnaughton', 'seen'], ['becerra', 'seen']]);
});

test('inactive members are excluded', async () => {
  await resetDb(); const f = await seedFixtures();
  await pool.query(`UPDATE members SET active = false WHERE id = $1`, [f.m2]);

  const r = await all();
  assert.strictEqual(r.total, 2);
  assert.ok(!r.members.some(m => m.id === f.m2));
});

test('rolls up per shop, least-seen shop first', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [hvac] } = await pool.query(`INSERT INTO shops (name) VALUES ('HVAC') RETURNING id`);
  const { rows: [h1] } = await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active)
     VALUES ('alvarez','Ray','SSgt',$1,'member','alvarez','x',true) RETURNING id`, [hvac.id]);
  await seenDaysAgo(h1.id, 1); // HVAC 1/1 seen; Structures 0/3

  const r = await all();
  assert.deepStrictEqual(
    r.shops.map(s => [s.name, s.seen, s.total, s.active30]),
    [['Structures', 0, 3, 0], ['HVAC', 1, 1, 1]]);
  assert.strictEqual(r.scope, 'squadron');
});

test('scoping to one shop excludes every other shop', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [hvac] } = await pool.query(`INSERT INTO shops (name) VALUES ('HVAC') RETURNING id`);
  await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active)
     VALUES ('alvarez','Ray','SSgt',$1,'member','alvarez','x',true)`, [hvac.id]);

  const r = await activity.memberActivity(pool, f.shopId);
  assert.strictEqual(r.scope, 'shop');
  assert.strictEqual(r.total, 3);
  assert.deepStrictEqual(r.shops.map(s => s.name), ['Structures']);
});
