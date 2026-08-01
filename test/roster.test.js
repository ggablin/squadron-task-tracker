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
