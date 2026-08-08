// Pure-logic tests for lib/attendance.js. Deliberately no ./helpers/db import,
// so these run without TEST_DATABASE_URL and cover the rules most likely to be
// silently wrong: drill length, period naming, and what "unmarked" means.

const { test } = require('node:test');
const assert = require('node:assert');
const a = require('../lib/attendance');

// ── period count ───────────────────────────────────────────────────────────

test('period count is two per drill day', () => {
  assert.strictEqual(a.periodCountFromDates('2026-06-06', '2026-06-07'), 4);  // Sat–Sun
  assert.strictEqual(a.periodCountFromDates('2026-06-05', '2026-06-07'), 6);  // Fri–Sun
  assert.strictEqual(a.periodCountFromDates('2026-06-04', '2026-06-07'), 8);  // Thu–Sun
});

test('a single-day drill is two periods', () => {
  assert.strictEqual(a.periodCountFromDates('2026-06-06', '2026-06-06'), 2);
});

test('period count is null when either date is missing', () => {
  // Every builder-created cycle looked like this before the form captured dates.
  assert.strictEqual(a.periodCountFromDates(null, '2026-06-07'), null);
  assert.strictEqual(a.periodCountFromDates('2026-06-05', null), null);
  assert.strictEqual(a.periodCountFromDates(null, null), null);
});

test('an inverted date range yields null rather than a negative count', () => {
  assert.strictEqual(a.periodCountFromDates('2026-06-07', '2026-06-05'), null);
});

test('period count is clamped to the schema ceiling', () => {
  assert.strictEqual(a.periodCountFromDates('2026-06-01', '2026-06-30'), a.MAX_PERIOD);
});

test('a Date at local midnight is read as its own calendar day', () => {
  // node-pg hands back DATE columns as local-midnight Dates. Reading those with
  // UTC getters shifts the day backwards in any positive-offset timezone.
  const start = new Date(2026, 5, 5);   // 5 Jun 2026, local
  const end = new Date(2026, 5, 7);     // 7 Jun 2026, local
  assert.strictEqual(a.periodCountFromDates(start, end), 6);
});

test('periodCountFor prefers the dates, then the stored value, then 4', () => {
  assert.strictEqual(a.periodCountFor({ start_date: '2026-06-04', end_date: '2026-06-07', period_count: 4 }), 8);
  assert.strictEqual(a.periodCountFor({ start_date: null, end_date: null, period_count: 6 }), 6);
  assert.strictEqual(a.periodCountFor({ start_date: null, end_date: null, period_count: null }), 4);
  assert.strictEqual(a.periodCountFor(null), 4);
});

// ── period labels ──────────────────────────────────────────────────────────

test('labels run AM then PM across consecutive days', () => {
  const l = a.periodLabels('2026-06-05', 6);       // Friday
  // Numbered and dated rather than "UTA n · Friday AM": the pay spreadsheet is
  // keyed by period and date, and a supervisor marking Sunday afternoon should
  // not have to work out which UTA number that is.
  assert.deepStrictEqual(l.map(x => x.label), [
    'Period 1 (06/05/2026)', 'Period 2 (06/05/2026)',
    'Period 3 (06/06/2026)', 'Period 4 (06/06/2026)',
    'Period 5 (06/07/2026)', 'Period 6 (06/07/2026)',
  ]);
  // The day name is still carried for anything that wants to show it.
  assert.deepStrictEqual(l.map(x => x.day),
    ['Friday', 'Friday', 'Saturday', 'Saturday', 'Sunday', 'Sunday']);
});

test('an eight-period drill labels four distinct days', () => {
  const l = a.periodLabels('2026-06-04', 8);       // Thursday
  assert.deepStrictEqual([...new Set(l.map(x => x.day))],
    ['Thursday', 'Friday', 'Saturday', 'Sunday']);
  assert.strictEqual(l[7].label, 'Period 8 (06/07/2026)');
});

test('labels do not assume a Friday start', () => {
  const l = a.periodLabels('2026-06-06', 4);       // Saturday
  assert.strictEqual(l[0].label, 'Period 1 (06/06/2026)');
  assert.strictEqual(l[3].label, 'Period 4 (06/07/2026)');
  assert.strictEqual(l[0].day, 'Saturday');
});

test('drill hours are attached, and the last period of the drill ends early', () => {
  const l = a.periodLabels('2026-08-08', 4);
  assert.deepStrictEqual(l.map(x => x.time),
    ['07:00-11:00', '12:00-16:30', '07:00-11:00', '12:00-16:00']);
});

test('labels degrade to a bare period number without a start date', () => {
  const l = a.periodLabels(null, 4);
  assert.deepStrictEqual(l.map(x => x.label),
    ['Period 1', 'Period 2', 'Period 3', 'Period 4']);
  assert.strictEqual(l[0].day, null);
  assert.strictEqual(l[0].date, null);
  assert.strictEqual(l[0].half, 'AM');             // half is still known
});

test('label count is clamped to the ceiling', () => {
  assert.strictEqual(a.periodLabels('2026-06-05', 99).length, a.MAX_PERIOD);
  assert.strictEqual(a.periodLabels('2026-06-05', 0).length, 0);
});

// ── validation ─────────────────────────────────────────────────────────────

test('the nine statuses are accepted and nothing else is', () => {
  for (const s of ['present', 'agr_at_orders', 'ruta_excused', 'unexcused', 'awol',
                   'maternity', 'transfer', 'separated', 'equiv_training']) {
    assert.ok(a.isValidStatus(s), s);
  }
  // Including the four that were retired when pay codes arrived — a stale client
  // must be refused rather than writing a value the constraint no longer allows.
  for (const s of ['Present', 'unmarked', '', null, undefined, 'absent',
                   'at', 'deployed', 'ruta', 'excused']) {
    assert.ok(!a.isValidStatus(s), String(s));
  }
});

test('period 8 is valid on an 8-period cycle and invalid on a 6-period one', () => {
  // Regression guard: the real bound is the cycle's count, not a fixed ceiling.
  assert.ok(a.isValidPeriod(8, 8));
  assert.ok(!a.isValidPeriod(8, 6));
  assert.ok(!a.isValidPeriod(7, 6));
  assert.ok(a.isValidPeriod(6, 6));
});

test('non-integer and out-of-range periods are rejected', () => {
  for (const p of [0, -1, 1.5, 'x', null, undefined, NaN]) {
    assert.ok(!a.isValidPeriod(p, 6), String(p));
  }
});

// ── coverage and unmarked ──────────────────────────────────────────────────

const MEMBERS = [10, 11, 12];

test('coverage counts marked cells out of members × periods', () => {
  const rows = [
    { member_id: 10, period: 1 }, { member_id: 10, period: 2 },
    { member_id: 11, period: 1 },
  ];
  assert.deepStrictEqual(a.coverage(rows, MEMBERS, 4), { marked: 3, total: 12 });
});

test('coverage ignores rows outside the shop or beyond the period count', () => {
  const rows = [
    { member_id: 10, period: 1 },
    { member_id: 99, period: 1 },   // different shop
    { member_id: 11, period: 7 },   // beyond a 6-period drill
  ];
  assert.deepStrictEqual(a.coverage(rows, MEMBERS, 6), { marked: 1, total: 18 });
});

test('coverage does not double-count a re-marked cell', () => {
  const rows = [{ member_id: 10, period: 1 }, { member_id: 10, period: 1 }];
  assert.strictEqual(a.coverage(rows, MEMBERS, 4).marked, 1);
});

test('empty coverage is zero, not NaN', () => {
  assert.deepStrictEqual(a.coverage([], MEMBERS, 4), { marked: 0, total: 12 });
  assert.deepStrictEqual(a.coverage(null, [], 0), { marked: 0, total: 0 });
});

test('unmarkedFor returns only members with no row for that period', () => {
  const rows = [{ member_id: 10, period: 1 }, { member_id: 12, period: 2 }];
  assert.deepStrictEqual(a.unmarkedFor(rows, MEMBERS, 1), [11, 12]);
  assert.deepStrictEqual(a.unmarkedFor(rows, MEMBERS, 2), [10, 11]);
  assert.deepStrictEqual(a.unmarkedFor(rows, MEMBERS, 3), [10, 11, 12]);
});

test('unmarkedFor never returns an already-marked exception', () => {
  // This is what stops "mark all present" from overwriting a recorded absence.
  const rows = [{ member_id: 11, period: 3, status: 'unexcused' }];
  assert.ok(!a.unmarkedFor(rows, MEMBERS, 3).includes(11));
});

test('firstIncompletePeriod finds where to resume', () => {
  const full = p => MEMBERS.map(m => ({ member_id: m, period: p }));
  assert.strictEqual(a.firstIncompletePeriod([...full(1), ...full(2)], MEMBERS, 6), 3);
  assert.strictEqual(a.firstIncompletePeriod([], MEMBERS, 6), 1);
  // Fully marked weekend falls back to period 1 rather than 0 or 7.
  const all = [1, 2, 3, 4].flatMap(full);
  assert.strictEqual(a.firstIncompletePeriod(all, MEMBERS, 4), 1);
});
