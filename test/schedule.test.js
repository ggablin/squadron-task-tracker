// Pure-logic tests for lib/schedule.js. No ./helpers/db import, so these run
// without TEST_DATABASE_URL. The DB functions call these same helpers rather
// than reimplementing the rules in SQL, so this covers the real decision path.

const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../lib/schedule');

// ── references ─────────────────────────────────────────────────────────────

test('refs round-trip for all three storage shapes', () => {
  for (const [type, id] of [['sq', 7], ['grp', 12], ['shop', 3]]) {
    assert.deepStrictEqual(s.parseRef(s.makeRef(type, id)), { type, id });
  }
});

test('malformed refs are rejected, not guessed at', () => {
  for (const bad of ['', null, undefined, 'sq', '12', 'sq:', 'sq:abc', 'bogus:1', 'sq:1:2', 'SQ:1']) {
    assert.strictEqual(s.parseRef(bad), null, JSON.stringify(bad));
  }
});

// ── audience ───────────────────────────────────────────────────────────────

test('audience "all" is distinct from a shop list', () => {
  assert.deepStrictEqual(s.normalizeAudience('all'), { all: true, shopIds: [] });
  assert.deepStrictEqual(s.normalizeAudience([3, 1]), { all: false, shopIds: [1, 3] });
});

test('shop ids are deduped, sorted and coerced from strings', () => {
  assert.deepStrictEqual(s.normalizeAudience(['3', 1, '1', 3, 2]).shopIds, [1, 2, 3]);
});

test('junk shop ids are dropped rather than poisoning the list', () => {
  assert.deepStrictEqual(s.normalizeAudience(['x', 0, -2, null, 4, 1.9]).shopIds, [4, 1].sort((a, b) => a - b));
});

test('an event with no audience is invalid', () => {
  // It would surface nowhere, which is never what was meant.
  for (const bad of [[], null, undefined, 'none', ['x']]) {
    assert.ok(!s.isValidAudience(bad), JSON.stringify(bad));
  }
  assert.ok(s.isValidAudience('all'));
  assert.ok(s.isValidAudience([2]));
});

// ── merging the two tables into one list ───────────────────────────────────

const sq = (id, over = {}) => ({ id, day: 'Friday', start_time: '0800', title: 'Formation', ...over });
const shop = (id, shop_id, over = {}) => ({ id, shop_id, event_group_id: null, day: 'Friday', start_time: '0900', title: 'Bay cleanup', ...over });

test('squadron rows become audience "all"', () => {
  const [ev] = s.mergeSchedule([sq(1)], []);
  assert.strictEqual(ev.audience, 'all');
  assert.strictEqual(ev.ref, 'sq:1');
  assert.deepStrictEqual(ev.shop_ids, []);
});

test('shop rows sharing a group become ONE event with a combined audience', () => {
  const rows = [shop(10, 5, { event_group_id: 10 }), shop(11, 2, { event_group_id: 10 })];
  const merged = s.mergeSchedule([], rows);
  assert.strictEqual(merged.length, 1, 'grouped rows must collapse to one event');
  assert.strictEqual(merged[0].ref, 'grp:10');
  assert.deepStrictEqual(merged[0].shop_ids, [2, 5]);
});

test('ungrouped legacy rows stand alone', () => {
  // Rows authored before event_group_id existed carry NULL and are their own event.
  const merged = s.mergeSchedule([], [shop(20, 1), shop(21, 2)]);
  assert.strictEqual(merged.length, 2);
  assert.deepStrictEqual(merged.map(e => e.ref).sort(), ['shop:20', 'shop:21']);
});

test('grouped and ungrouped rows coexist without merging into each other', () => {
  const merged = s.mergeSchedule([], [
    shop(30, 1, { event_group_id: 30 }), shop(31, 2, { event_group_id: 30 }), shop(40, 3),
  ]);
  assert.strictEqual(merged.length, 2);
  const byRef = Object.fromEntries(merged.map(e => [e.ref, e.shop_ids]));
  assert.deepStrictEqual(byRef['grp:30'], [1, 2]);
  assert.deepStrictEqual(byRef['shop:40'], [3]);
});

// ── ordering ───────────────────────────────────────────────────────────────

test('the merged list reads like the drill weekend: day, then time', () => {
  const merged = s.mergeSchedule(
    [sq(1, { day: 'Sunday', start_time: '0800', title: 'Sun AM' }),
     sq(2, { day: 'Friday', start_time: '1300', title: 'Fri PM' })],
    [shop(3, 1, { day: 'Friday', start_time: '0800', title: 'Fri AM' }),
     shop(4, 1, { day: 'Saturday', start_time: '0900', title: 'Sat' })]);
  assert.deepStrictEqual(merged.map(e => e.title), ['Fri AM', 'Fri PM', 'Sat', 'Sun AM']);
});

test('untimed events sink below timed ones on the same day', () => {
  const merged = s.mergeSchedule(
    [sq(1, { start_time: null, title: 'Whenever' }), sq(2, { start_time: '0700', title: 'Early' })], []);
  assert.deepStrictEqual(merged.map(e => e.title), ['Early', 'Whenever']);
});

test('a spanning day sorts between the days it spans', () => {
  const merged = s.mergeSchedule([], [
    shop(1, 1, { day: 'Saturday', start_time: '0800', title: 'Sat' }),
    shop(2, 1, { day: 'Friday/Saturday', start_time: '0800', title: 'Both' }),
    shop(3, 1, { day: 'Friday', start_time: '0800', title: 'Fri' }),
  ]);
  assert.deepStrictEqual(merged.map(e => e.title), ['Fri', 'Both', 'Sat']);
});

// ── copy-forward identity ──────────────────────────────────────────────────

const ev = (over = {}) => ({ audience: 'all', shop_ids: [], day: 'Friday', start_time: '0800', title: 'Formation', ...over });

test('the same slot and audience is the same event', () => {
  assert.strictEqual(s.scheduleKey(ev()), s.scheduleKey(ev({ title: '  formation  ' })));
});

test('same slot, different audience, is a different event', () => {
  assert.notStrictEqual(
    s.scheduleKey(ev()),
    s.scheduleKey(ev({ audience: 'shops', shop_ids: [1] })));
});

test('audience order does not change identity', () => {
  assert.strictEqual(
    s.scheduleKey(ev({ audience: 'shops', shop_ids: [3, 1] })),
    s.scheduleKey(ev({ audience: 'shops', shop_ids: [1, 3] })));
});

test('copy-forward is idempotent', () => {
  const source = [ev({ title: 'A' }), ev({ title: 'B' })];
  const first = s.pendingScheduleCopy(source, []);
  assert.strictEqual(first.length, 2);
  assert.deepStrictEqual(s.pendingScheduleCopy(source, first), []);
});

test('copy-forward carries only what the target lacks', () => {
  const source = [ev({ title: 'A' }), ev({ title: 'B' }), ev({ title: 'C' })];
  const target = [ev({ title: 'B' })];
  assert.deepStrictEqual(
    s.pendingScheduleCopy(source, target).map(e => e.title), ['A', 'C']);
});

test('a duplicate inside the source only copies once', () => {
  assert.strictEqual(s.pendingScheduleCopy([ev(), ev()], []).length, 1);
});

test('empty and missing inputs are safe', () => {
  assert.deepStrictEqual(s.pendingScheduleCopy(null, null), []);
  assert.deepStrictEqual(s.mergeSchedule(null, null), []);
});
