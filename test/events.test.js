// Pure-logic tests for lib/events.js. Deliberately no ./helpers/db import, so
// these run without TEST_DATABASE_URL. carryOpenWorkOrders calls these same
// functions rather than reimplementing the rules in SQL, so this covers the
// real decision path — only the INSERT itself is untested here.

const { test } = require('node:test');
const assert = require('node:assert');
const e = require('../lib/events');

const wo = (over = {}) => ({
  shop_id: 1, event_type: 'work_order', status: 'open',
  wo_number: 'WO-100', title: 'Replace bay door seal', ...over,
});

// ── what qualifies to carry ────────────────────────────────────────────────

test('open and in-progress work orders carry', () => {
  assert.ok(e.isCarryableWorkOrder(wo({ status: 'open' })));
  assert.ok(e.isCarryableWorkOrder(wo({ status: 'in_progress' })));
});

test('completed work orders never carry', () => {
  // A finished job in a new cycle reads as outstanding work that isn't.
  assert.ok(!e.isCarryableWorkOrder(wo({ status: 'complete' })));
});

test('schedule and emphasis events are not work orders', () => {
  assert.ok(!e.isCarryableWorkOrder(wo({ event_type: 'schedule' })));
  assert.ok(!e.isCarryableWorkOrder(wo({ event_type: 'emphasis' })));
});

test('malformed rows are rejected rather than thrown on', () => {
  for (const bad of [null, undefined, {}, { event_type: 'work_order' }]) {
    assert.ok(!e.isCarryableWorkOrder(bad), JSON.stringify(bad));
  }
});

// ── identity ───────────────────────────────────────────────────────────────

test('carry identity is shop + number + title, case and space insensitive', () => {
  assert.strictEqual(
    e.carryKey({ shop_id: 1, wo_number: 'WO-100', title: 'Fix door' }),
    e.carryKey({ shop_id: 1, wo_number: ' wo-100 ', title: '  Fix Door  ' }));
});

test('the same job in different shops is not the same job', () => {
  assert.notStrictEqual(
    e.carryKey({ shop_id: 1, wo_number: 'WO-1', title: 'Fix door' }),
    e.carryKey({ shop_id: 2, wo_number: 'WO-1', title: 'Fix door' }));
});

test('a missing wo_number does not collapse distinct jobs together', () => {
  // wo_number is optional on the schema. Two unnumbered jobs in one shop must
  // stay distinct or only one of them would ever carry.
  assert.notStrictEqual(
    e.carryKey({ shop_id: 1, wo_number: null, title: 'Fix door' }),
    e.carryKey({ shop_id: 1, wo_number: null, title: 'Paint hangar' }));
});

// ── what still needs carrying ──────────────────────────────────────────────

test('carries only the unfinished work orders', () => {
  const source = [
    wo({ wo_number: 'WO-1', status: 'open' }),
    wo({ wo_number: 'WO-2', status: 'in_progress' }),
    wo({ wo_number: 'WO-3', status: 'complete' }),
    wo({ wo_number: 'WO-4', event_type: 'schedule', status: 'open' }),
  ];
  const got = e.pendingCarry(source, []);
  assert.deepStrictEqual(got.map(r => r.wo_number), ['WO-1', 'WO-2']);
});

test('is idempotent: nothing carries twice', () => {
  const source = [wo({ wo_number: 'WO-1' }), wo({ wo_number: 'WO-2' })];
  const first = e.pendingCarry(source, []);
  assert.strictEqual(first.length, 2);
  // Simulate the first run having landed, then run again.
  const second = e.pendingCarry(source, first);
  assert.deepStrictEqual(second, []);
});

test('a partially-carried cycle carries only the remainder', () => {
  const source = [wo({ wo_number: 'WO-1' }), wo({ wo_number: 'WO-2' }), wo({ wo_number: 'WO-3' })];
  const already = [{ shop_id: 1, wo_number: 'WO-2', title: 'Replace bay door seal' }];
  assert.deepStrictEqual(
    e.pendingCarry(source, already).map(r => r.wo_number), ['WO-1', 'WO-3']);
});

test('a job duplicated in the source only carries once', () => {
  const source = [wo({ wo_number: 'WO-9' }), wo({ wo_number: 'WO-9' })];
  assert.strictEqual(e.pendingCarry(source, []).length, 1);
});

test('an existing row matched case-insensitively still blocks the carry', () => {
  const source = [wo({ wo_number: 'WO-7', title: 'Fix Door' })];
  const already = [{ shop_id: 1, wo_number: 'wo-7', title: 'fix door' }];
  assert.deepStrictEqual(e.pendingCarry(source, already), []);
});

test('empty and missing inputs are safe', () => {
  assert.deepStrictEqual(e.pendingCarry([], []), []);
  assert.deepStrictEqual(e.pendingCarry(null, null), []);
  assert.deepStrictEqual(e.pendingCarry(undefined, [wo()]), []);
});

test('status is preserved on the rows selected to carry', () => {
  // An in-progress job stays in progress; it does not reset to open.
  const source = [wo({ wo_number: 'WO-5', status: 'in_progress' })];
  assert.strictEqual(e.pendingCarry(source, [])[0].status, 'in_progress');
});

// ── guard rails on the DB helper ───────────────────────────────────────────

test('carryOpenWorkOrders refuses degenerate cycle pairs without touching the db', async () => {
  const client = { query: () => { throw new Error('should not query'); } };
  for (const args of [{ fromCycleId: null, toCycleId: 2 },
                      { fromCycleId: 1, toCycleId: null },
                      { fromCycleId: 3, toCycleId: 3 }]) {
    assert.deepStrictEqual(await e.carryOpenWorkOrders(client, args), { carried: 0, rows: [] });
  }
});
