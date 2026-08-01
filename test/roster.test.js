const { test } = require('node:test');
const assert = require('node:assert');
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
