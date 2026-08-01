const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const { pool, applySchema, resetDb } = require('./helpers/db');

test.before(applySchema);

test('migration adds can_manage_roster defaulting to false', async () => {
  await resetDb();
  const { rows: [shop] } = await pool.query(`INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [m] } = await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash)
     VALUES ('smith','Ann','SrA',$1,'member','smith','x')
     RETURNING can_manage_roster, updated_at, updated_by_id`, [shop.id]);
  assert.strictEqual(m.can_manage_roster, false);
  assert.strictEqual(m.updated_at, null);
  assert.strictEqual(m.updated_by_id, null);
});

const roster = require('../lib/roster');

test('derivePlacement writes the correct triple for each placement', () => {
  assert.deepStrictEqual(roster.derivePlacement('shop_member'),
    { role: 'member', flight: null, position: null });
  assert.deepStrictEqual(roster.derivePlacement('shop_supervisor'),
    { role: 'supervisor', flight: null, position: null });
  assert.deepStrictEqual(roster.derivePlacement('shop_lead', { position: 'SNCOIC' }),
    { role: 'leadership', flight: null, position: 'SNCOIC' });
  assert.deepStrictEqual(
    roster.derivePlacement('flight_leader', { position: 'Flight Superintendent', flight: 'Infrastructure' }),
    { role: 'leadership', flight: 'Infrastructure', position: 'Flight Superintendent' });
  assert.deepStrictEqual(roster.derivePlacement('squadron_staff', { position: 'Commander' }),
    { role: 'leadership', flight: 'Squadron Staff', position: 'Commander' });
});

test('derivePlacement rejects positions outside the allowed set', () => {
  assert.throws(() => roster.derivePlacement('shop_lead', { position: 'Ncoic' }), /position/i);
  assert.throws(() => roster.derivePlacement('shop_lead', { position: 'Commander' }), /position/i);
  assert.throws(() => roster.derivePlacement('nonsense'), /placement/i);
});

test('derivePlacement requires a valid flight for flight_leader', () => {
  assert.throws(
    () => roster.derivePlacement('flight_leader', { position: 'Flight OIC', flight: 'Nope' }), /flight/i);
});

test('placementOf round-trips every placement', () => {
  const cases = [
    ['shop_member', {}],
    ['shop_supervisor', {}],
    ['shop_lead', { position: 'NCOIC' }],
    ['flight_leader', { position: 'Flight OIC', flight: 'R&O' }],
    ['squadron_staff', { position: 'First Sergeant' }],
  ];
  for (const [name, opts] of cases) {
    assert.strictEqual(roster.placementOf(roster.derivePlacement(name, opts)), name, name);
  }
});

test('placementOf prefers shop_lead over flight_leader when both could match', () => {
  // Mirrors the org chart's guard at server.js:1503 — a leadership member with a
  // flight set AND an NCOIC/SNCOIC position is a shop lead, not a flight leader.
  // derivePlacement never produces this combination, so the round-trip cases
  // above cannot catch a reordering of the two checks in placementOf.
  assert.strictEqual(
    roster.placementOf({ role: 'leadership', flight: 'Infrastructure', position: 'NCOIC' }),
    'shop_lead');
  assert.strictEqual(
    roster.placementOf({ role: 'leadership', flight: 'Construction', position: 'SNCOIC' }),
    'shop_lead');
});

test('nextSlug disambiguates duplicate surnames', async () => {
  await resetDb();
  const { rows: [shop] } = await pool.query(`INSERT INTO shops (name) VALUES ('Electrical') RETURNING id`);
  const add = (last, first, slug) => pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash)
     VALUES ($1,$2,'SrA',$3,'member',$4,'x')`, [last, first, shop.id, slug]);

  assert.strictEqual(await roster.nextSlug(pool, 'Fowler', 'Omar'), 'fowler');
  await add('Fowler', 'Omar', 'fowler');
  assert.strictEqual(await roster.nextSlug(pool, 'Fowler', 'Gina'), 'fowler-g');
  await add('Fowler', 'Gina', 'fowler-g');
  // Third Fowler whose initial is also taken falls through to a numeral.
  assert.strictEqual(await roster.nextSlug(pool, 'Fowler', 'Greg'), 'fowler-2');
});

test('nextSlug handles a member with no first name', async () => {
  await resetDb();
  await pool.query(`INSERT INTO shops (name) VALUES ('EM')`);
  assert.strictEqual(await roster.nextSlug(pool, 'Fowler', ''), 'fowler');
});

test('nextSlug preserves hyphenated surnames and rejects empty', async () => {
  await resetDb();
  assert.strictEqual(await roster.nextSlug(pool, 'Beljour-Sommer', 'Rose'), 'beljour-sommer');
  await assert.rejects(() => roster.nextSlug(pool, '   ', 'Rose'), /last name/i);
});

test('nextSlug falls through to a numeral when there is no first name and the surname is taken', async () => {
  await resetDb();
  const { rows: [shop] } = await pool.query(`INSERT INTO shops (name) VALUES ('Electrical') RETURNING id`);
  await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash)
     VALUES ('Fowler','','AB',$1,'member','fowler','x')`, [shop.id]);
  // No initial to disambiguate with, so the 'fowler-<initial>' candidate is
  // never generated and the numeral is the only remaining option.
  assert.strictEqual(await roster.nextSlug(pool, 'Fowler', ''), 'fowler-2');
});

async function seedAdmins() {
  await resetDb();
  const { rows: [shop] } = await pool.query(`INSERT INTO shops (name) VALUES ('C2') RETURNING id`);
  const mk = async (slug, isAdmin, active = true) => {
    const { rows: [m] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active, can_manage_roster)
       VALUES ($1,'A','MSgt',$2,'leadership',$1,'x',$3,$4) RETURNING id`,
      [slug, shop.id, active, isAdmin]);
    return m.id;
  };
  return { shopId: shop.id, gablin: await mk('gablin', true), mcnaughton: await mk('mcnaughton', true),
           plain: await mk('gorey', false) };
}

test('assertNotLastAdmin allows removing a non-last holder', async () => {
  const f = await seedAdmins();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await roster.assertNotLastAdmin(client, f.gablin);   // two holders, fine
    await client.query('ROLLBACK');
  } finally { client.release(); }
});

test('assertNotLastAdmin refuses the last active holder', async () => {
  const f = await seedAdmins();
  await pool.query(`UPDATE members SET can_manage_roster = false WHERE id = $1`, [f.mcnaughton]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(() => roster.assertNotLastAdmin(client, f.gablin), /only person/i);
    await client.query('ROLLBACK');
  } finally { client.release(); }
});

test('an inactive holder does not count toward the invariant', async () => {
  const f = await seedAdmins();
  await pool.query(`UPDATE members SET active = false WHERE id = $1`, [f.mcnaughton]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(() => roster.assertNotLastAdmin(client, f.gablin), /only person/i);
    await client.query('ROLLBACK');
  } finally { client.release(); }
});

test('a non-holder is never treated as the last holder', async () => {
  const f = await seedAdmins();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await roster.assertNotLastAdmin(client, f.plain);
    await client.query('ROLLBACK');
  } finally { client.release(); }
});

test('FOR UPDATE serialises two concurrent revocations so they cannot both succeed', async () => {
  const f = await seedAdmins();               // gablin + mcnaughton both hold it
  const c1 = await pool.connect();
  const c2 = await pool.connect();
  try {
    await c1.query('BEGIN');
    await roster.assertNotLastAdmin(c1, f.mcnaughton);   // 2 holders — passes
    await c1.query(`UPDATE members SET can_manage_roster = false WHERE id = $1`, [f.mcnaughton]);
    // c1 has written but NOT committed. c2 must block on the row lock rather
    // than reading a stale count of two and also proceeding.
    await c2.query('BEGIN');
    const pending = roster.assertNotLastAdmin(c2, f.gablin);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual(settled, false, 'second revocation should block while the first transaction is open');

    await c1.query('COMMIT');
    // Now c2 re-reads post-commit state and sees itself as the last holder.
    await assert.rejects(() => pending, /only person/i);
    await c2.query('ROLLBACK');
  } finally {
    c1.release();
    c2.release();
  }
});

test('createMember provisions a member with slug-as-password and forced change', async () => {
  const f = await seedAdmins();
  const m = await roster.createMember(pool, {
    last_name: 'Fernandez', first_name: 'Gabriel', rank: 'MSgt',
    shop_id: f.shopId, placement: 'shop_lead', position: 'SNCOIC', email: '',
  }, f.gablin);

  assert.strictEqual(m.slug, 'fernandez');
  assert.strictEqual(m.role, 'leadership');
  assert.strictEqual(m.position, 'SNCOIC');
  assert.strictEqual(m.flight, null);
  assert.strictEqual(m.active, true);
  assert.strictEqual(m.can_manage_roster, false);

  const { rows: [row] } = await pool.query(
    `SELECT password_hash, must_change_password, updated_by_id FROM members WHERE id = $1`, [m.id]);
  assert.strictEqual(row.must_change_password, true);
  assert.strictEqual(row.updated_by_id, f.gablin);
  assert.strictEqual(await bcrypt.compare('fernandez', row.password_hash), true);
});

test('createMember rejects an invalid placement before touching the database', async () => {
  const f = await seedAdmins();
  await assert.rejects(() => roster.createMember(pool, {
    last_name: 'Smith', first_name: 'Ann', rank: 'SrA',
    shop_id: f.shopId, placement: 'shop_lead', position: 'Ncoic',
  }, f.gablin), /position/i);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM members WHERE last_name = 'Smith'`);
  assert.strictEqual(rows[0].n, 0);
});

test('listRoster returns active and inactive members with their placement', async () => {
  const f = await seedAdmins();
  await pool.query(`UPDATE members SET active = false WHERE id = $1`, [f.plain]);
  const all = await roster.listRoster(pool);
  assert.strictEqual(all.length, 3);
  const inactive = all.find(m => m.id === f.plain);
  assert.strictEqual(inactive.active, false);
  // seedAdmins gives everyone role='leadership' with no flight and no position,
  // which placementOf resolves to shop_member — leadership alone is not enough
  // to be a lead or a flight leader.
  assert.strictEqual(inactive.placement, 'shop_member');
});

test('updateMember changes placement by rewriting the whole triple', async () => {
  const f = await seedAdmins();
  const m = await roster.createMember(pool, {
    last_name: 'Green', first_name: 'Jo', rank: 'SSgt',
    shop_id: f.shopId, placement: 'shop_member',
  }, f.gablin);

  const up = await roster.updateMember(pool, m.id,
    { placement: 'shop_lead', position: 'NCOIC' }, f.gablin);
  assert.deepStrictEqual(
    { role: up.role, flight: up.flight, position: up.position },
    { role: 'leadership', flight: null, position: 'NCOIC' });

  const back = await roster.updateMember(pool, m.id, { placement: 'shop_supervisor' }, f.gablin);
  assert.deepStrictEqual(
    { role: back.role, flight: back.flight, position: back.position },
    { role: 'supervisor', flight: null, position: null });
});

test('updateMember refuses to deactivate the last active admin', async () => {
  const f = await seedAdmins();
  await pool.query(`UPDATE members SET can_manage_roster = false WHERE id = $1`, [f.mcnaughton]);
  await assert.rejects(
    () => roster.updateMember(pool, f.gablin, { active: false }, f.gablin), /only person/i);
  const { rows: [row] } = await pool.query(`SELECT active FROM members WHERE id = $1`, [f.gablin]);
  assert.strictEqual(row.active, true);
});

test('updateMember ignores can_manage_roster in the payload', async () => {
  const f = await seedAdmins();
  await roster.updateMember(pool, f.plain, { can_manage_roster: true, rank: 'TSgt' }, f.gablin);
  const { rows: [row] } = await pool.query(
    `SELECT rank, can_manage_roster FROM members WHERE id = $1`, [f.plain]);
  assert.strictEqual(row.rank, 'TSgt');
  assert.strictEqual(row.can_manage_roster, false);
});

test('updateMember reports a slug collision rather than throwing a raw error', async () => {
  const f = await seedAdmins();
  await assert.rejects(
    () => roster.updateMember(pool, f.plain, { slug: 'gablin' }, f.gablin), /already taken/i);
});

test('updateMember deactivates a member who is not the last active admin', async () => {
  const f = await seedAdmins();   // gablin + mcnaughton both hold can_manage_roster
  const updated = await roster.updateMember(pool, f.mcnaughton, { active: false }, f.gablin);
  assert.strictEqual(updated.active, false);
  const { rows: [row] } = await pool.query(
    `SELECT active, can_manage_roster FROM members WHERE id = $1`, [f.mcnaughton]);
  assert.strictEqual(row.active, false);
  // The capability itself is untouched by this path — only setRosterAdmin changes it.
  assert.strictEqual(row.can_manage_roster, true);
});

// Regression coverage for the fix-round-1 critical finding: the guard used to
// branch on `input.active === false` while the write used `!!input.active`, so
// 0 / null / "" all skipped assertNotLastAdmin yet still wrote active = false —
// a reachable full lockout. Every falsy-but-not-strictly-false value must now
// be refused identically to `active: false`.
test('updateMember refuses to deactivate the last active admin for every falsy active value, not just false', async () => {
  for (const falsyActive of [0, null, '']) {
    const f = await seedAdmins();
    await pool.query(`UPDATE members SET can_manage_roster = false WHERE id = $1`, [f.mcnaughton]);
    await assert.rejects(
      () => roster.updateMember(pool, f.gablin, { active: falsyActive }, f.gablin),
      /only person/i,
      `active: ${JSON.stringify(falsyActive)} should have been refused`);
    const { rows: [row] } = await pool.query(`SELECT active FROM members WHERE id = $1`, [f.gablin]);
    assert.strictEqual(row.active, true,
      `active: ${JSON.stringify(falsyActive)} should not have been written`);
  }
});

test('updateMember stores SQL NULL for an explicit null, not the string "null"', async () => {
  const f = await seedAdmins();
  await roster.updateMember(pool, f.plain, { email: 'gorey@example.mil' }, f.gablin);
  const before = await pool.query(`SELECT email FROM members WHERE id = $1`, [f.plain]);
  assert.strictEqual(before.rows[0].email, 'gorey@example.mil');

  await roster.updateMember(pool, f.plain, { email: null }, f.gablin);
  const { rows: [row] } = await pool.query(`SELECT email FROM members WHERE id = $1`, [f.plain]);
  assert.strictEqual(row.email, null);
});

test('deleteMember removes an unreferenced member', async () => {
  const f = await seedAdmins();
  const m = await roster.createMember(pool, {
    last_name: 'Typo', first_name: 'Ann', rank: 'AB',
    shop_id: f.shopId, placement: 'shop_member',
  }, f.gablin);
  assert.deepStrictEqual(await roster.deleteMember(pool, m.id), { deleted: true });
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM members WHERE id = $1`, [m.id]);
  assert.strictEqual(rows[0].n, 0);
});

test('deleteMember refuses a member with history and leaves them intact', async () => {
  const f = await seedAdmins();
  const m = await roster.createMember(pool, {
    last_name: 'Hasty', first_name: 'Bob', rank: 'SrA',
    shop_id: f.shopId, placement: 'shop_member',
  }, f.gablin);
  const { rows: [cyc] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status) VALUES ('Aug 2026', true, 'live') RETURNING id`);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO task_categories (code, label, sort_order) VALUES ('admin','Admin',1) RETURNING id`);
  await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency)
     VALUES ($1,$2,$3,'Update vRED','this_uta')`, [cyc.id, m.id, cat.id]);

  await assert.rejects(() => roster.deleteMember(pool, m.id), /history/i);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM members WHERE id = $1`, [m.id]);
  assert.strictEqual(rows[0].n, 1);
});

// Regression coverage for fix-round-1: the only other history test references
// the member via tasks.member_id, the obvious non-nullable case. This one
// proves the catch-based mechanism also catches a nullable *_by_id column —
// the member under test owns no task (member_id points at someone else) and is
// referenced solely via flagged_by_id, an audit-trail column that is NULL for
// almost every row.
test('deleteMember refuses a member referenced only via a nullable *_by_id column, and leaves them intact', async () => {
  const f = await seedAdmins();
  const owner = await roster.createMember(pool, {
    last_name: 'Owner', first_name: 'Rick', rank: 'SSgt',
    shop_id: f.shopId, placement: 'shop_member',
  }, f.gablin);
  const flagger = await roster.createMember(pool, {
    last_name: 'Flagger', first_name: 'Sam', rank: 'SrA',
    shop_id: f.shopId, placement: 'shop_member',
  }, f.gablin);
  const { rows: [cyc] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status) VALUES ('Aug 2026', true, 'live') RETURNING id`);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO task_categories (code, label, sort_order) VALUES ('admin','Admin',1) RETURNING id`);
  // owner is the task's member_id (the obvious case, covered by the test
  // above); flagger is referenced only through flagged_by_id.
  await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency, is_flagged, flagged_by_id)
     VALUES ($1,$2,$3,'Update vRED','this_uta',true,$4)`, [cyc.id, owner.id, cat.id, flagger.id]);

  await assert.rejects(() => roster.deleteMember(pool, flagger.id), /history/i);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM members WHERE id = $1`, [flagger.id]);
  assert.strictEqual(rows[0].n, 1);
});

test('deleteMember refuses the last active admin', async () => {
  const f = await seedAdmins();
  await pool.query(`UPDATE members SET can_manage_roster = false WHERE id = $1`, [f.mcnaughton]);
  await assert.rejects(() => roster.deleteMember(pool, f.gablin), /only person/i);
});

test('setRosterAdmin grants and revokes the capability', async () => {
  const f = await seedAdmins();
  const granted = await roster.setRosterAdmin(pool, f.plain, true, f.gablin);
  assert.strictEqual(granted.can_manage_roster, true);
  const revoked = await roster.setRosterAdmin(pool, f.plain, false, f.gablin);
  assert.strictEqual(revoked.can_manage_roster, false);
});

test('setRosterAdmin refuses to revoke the last active holder', async () => {
  const f = await seedAdmins();
  await roster.setRosterAdmin(pool, f.mcnaughton, false, f.gablin);
  await assert.rejects(
    () => roster.setRosterAdmin(pool, f.gablin, false, f.gablin), /only person/i);
  const { rows: [row] } = await pool.query(
    `SELECT can_manage_roster FROM members WHERE id = $1`, [f.gablin]);
  assert.strictEqual(row.can_manage_roster, true);
});

test('granting is never blocked by the invariant', async () => {
  const f = await seedAdmins();
  await roster.setRosterAdmin(pool, f.mcnaughton, false, f.gablin);
  const m = await roster.setRosterAdmin(pool, f.mcnaughton, true, f.gablin);
  assert.strictEqual(m.can_manage_roster, true);
});

test('granting to the sole remaining admin is not blocked by the invariant', async () => {
  const f = await seedAdmins();
  await roster.setRosterAdmin(pool, f.mcnaughton, false, f.gablin);  // gablin is now the only holder
  // Granting cannot strand the capability, so the invariant must not apply here.
  // This is the ONLY case where ids[0] === Number(memberId) holds, so it is the
  // only test that would catch a regression to an unconditional guard.
  const m = await roster.setRosterAdmin(pool, f.gablin, true, f.gablin);
  assert.strictEqual(m.can_manage_roster, true);
});

// ── Fix-round-2 CRITICAL 1: editing a sign-in name could silently lock the
// member out. `slug` was written verbatim (trimmed only), while nextSlug,
// import-members.js and login's `WHERE m.slug = $1` all lowercase/normalise.
// An admin retyping "Beltran" over a stored "beltran" produced a slug that
// login could never match. normalizeSlug() is now the single source of truth
// for both generation (nextSlug) and editing (updateMember).

test('normalizeSlug lowercases, folds diacritics, and strips disallowed characters', () => {
  assert.strictEqual(roster.normalizeSlug('Beltran'), 'beltran');
  assert.strictEqual(roster.normalizeSlug('  Beltran  '), 'beltran');
  assert.strictEqual(roster.normalizeSlug('Fernández'), 'fernandez');
  assert.strictEqual(roster.normalizeSlug('Beltrán Jr.'), 'beltranjr');
  assert.strictEqual(roster.normalizeSlug('Beljour-Sommer'), 'beljour-sommer');
  assert.strictEqual(roster.normalizeSlug('   '), '');
  assert.strictEqual(roster.normalizeSlug(null), '');
});

test('nextSlug folds a diacritic surname to its base letter rather than dropping it', async () => {
  await resetDb();
  await pool.query(`INSERT INTO shops (name) VALUES ('Electrical')`);
  // Before the fix, the accented character fell outside [a-z0-9-] and was
  // stripped by the character-class filter alone, producing "fernndez" — a
  // dropped letter in the generated sign-in name, not just a missed accent.
  assert.strictEqual(await roster.nextSlug(pool, 'Fernández', 'Jon'), 'fernandez');
});

test('updateMember normalises an edited slug so a differently-cased retype still resolves at login', async () => {
  const f = await seedAdmins();   // f.plain's slug starts as 'gorey'
  const updated = await roster.updateMember(pool, f.plain, { slug: 'Beltran' }, f.gablin);
  assert.strictEqual(updated.slug, 'beltran');
  const { rows: [row] } = await pool.query(`SELECT slug FROM members WHERE id = $1`, [f.plain]);
  // Assert the stored value directly — login itself lowercases the typed
  // slug before comparing, so a stored 'Beltran' would already never match
  // regardless of what the user types.
  assert.strictEqual(row.slug, 'beltran');
});

test('updateMember folds diacritics and strips punctuation in an edited slug', async () => {
  const f = await seedAdmins();
  const updated = await roster.updateMember(pool, f.plain, { slug: 'Beltrán Jr.' }, f.gablin);
  assert.strictEqual(updated.slug, 'beltranjr');
});

test('updateMember rejects a slug that normalises to empty, leaving the stored slug unchanged', async () => {
  const f = await seedAdmins();
  for (const badSlug of ['   ', '!!!', '...']) {
    await assert.rejects(
      () => roster.updateMember(pool, f.plain, { slug: badSlug }, f.gablin),
      /sign-in name/i,
      `slug: ${JSON.stringify(badSlug)} should have been rejected`);
  }
  const { rows: [row] } = await pool.query(`SELECT slug FROM members WHERE id = $1`, [f.plain]);
  assert.strictEqual(row.slug, 'gorey');
});

// ── Fix-round-2 CRITICAL 2: placementOf silently escalated a member to
// leadership. It tested only `m.flight === 'Squadron Staff'`, with no role
// check — unlike the org chart's own equivalent (server.js), which tests the
// flight and THEN `if (r.role === 'leadership')`. A stored
// {role:'member', flight:'Squadron Staff'} reported placement
// 'squadron_staff', and because the UI resends `placement` on every save,
// correcting an unrelated field (e.g. email) on such a member would have
// saved them back as role:'leadership' — unlocking every
// requireRole('leadership') endpoint, silently and without the UI's
// leadership-grant confirmation dialog (which itself relied on the same
// broken signal, see public/roster.html).

test('placementOf does not escalate a non-leadership member whose flight happens to be Squadron Staff', () => {
  const anomaly = { role: 'member', flight: 'Squadron Staff', position: null };
  assert.strictEqual(roster.placementOf(anomaly), 'shop_member');
  assert.notStrictEqual(roster.placementOf(anomaly), 'squadron_staff');
});

test('a round-trip save of that anomalous member does not escalate their role to leadership', async () => {
  const f = await seedAdmins();
  const m = await roster.createMember(pool, {
    last_name: 'Odd', first_name: 'Case', rank: 'AB',
    shop_id: f.shopId, placement: 'shop_member',
  }, f.gablin);
  // derivePlacement can never produce role:'member' + flight:'Squadron Staff'
  // — this simulates the stored anomaly directly, exactly as a hand-edit or a
  // legacy import row could.
  await pool.query(`UPDATE members SET flight = 'Squadron Staff' WHERE id = $1`, [m.id]);

  const fetched = await roster.getMember(pool, m.id);
  assert.strictEqual(fetched.placement, 'shop_member');

  // Round-trip exactly as the browser would: it always resends `placement`
  // on save (public/roster.html), so replay that here and confirm role is
  // untouched by a save that never intended to touch it.
  const saved = await roster.updateMember(pool, m.id, { placement: fetched.placement }, f.gablin);
  assert.strictEqual(saved.role, 'member');
});
