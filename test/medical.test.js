// Unit coverage for the medical service rollup.
//
// This code parses prose — the service names come out of the free-text details
// field McNaughton types, not a column — so these tests are the specification for
// what the parser is allowed to assume. Every literal string below is copied from
// the real August 2026 newsletter rather than invented.

const { test } = require('node:test');
const assert = require('node:assert');
const { splitServices, groupFor, rollup } = require('../lib/medical');

/* ── Splitting the details field ────────────────────────────────────────── */

test('a single service is taken as-is', () => {
  assert.deepStrictEqual(splitServices('Medical / Dental', 'MHA'), ['MHA']);
  assert.deepStrictEqual(splitServices('Medical / Dental', 'Audiogram'), ['Audiogram']);
});

test('slash-separated services are split, since one member owes several', () => {
  assert.deepStrictEqual(splitServices('Medical / Dental', 'PHAQ / DHA3'), ['PHAQ', 'DHA3']);
  assert.deepStrictEqual(splitServices('Medical / Dental', 'MMR / HIV Blood Draw'),
    ['MMR', 'HIV Blood Draw']);
  assert.deepStrictEqual(splitServices('Medical / Dental', 'Audiogram / DHA3 / PHAQ'),
    ['Audiogram', 'DHA3', 'PHAQ']);
});

test('an appointment riding along with the service name is stripped', () => {
  // Otherwise the same exam at two times becomes two services, and the count of
  // people needing a dental exam is silently split in half.
  assert.deepStrictEqual(
    splitServices('Medical / Dental', 'PHAQ / Mil Dental Exam 11 Sep @ 1020hrs'),
    ['PHAQ', 'Mil Dental Exam']);
  assert.deepStrictEqual(
    splitServices('Medical / Dental', 'Mil Dental Exam 9 Aug @ 1040hrs'),
    ['Mil Dental Exam']);
  assert.deepStrictEqual(
    splitServices('Medical / Dental', 'Mil Dental Exam'),
    ['Mil Dental Exam']);
});

test("a PT test's details hold a due month, not a service", () => {
  // "Due Sep 2026" must not become a service called "Due Sep 2026".
  assert.deepStrictEqual(splitServices('PT Test', 'Due Sep 2026'), ['PT Test']);
  assert.deepStrictEqual(splitServices('PT Test', 'Due Aug 2026 — Sat @ 1030hrs'), ['PT Test']);
  assert.deepStrictEqual(splitServices('PT Test', null), ['PT Test']);
});

test('a missing detail surfaces rather than vanishing', () => {
  // Dropping it would quietly shrink the squadron's medical count.
  assert.deepStrictEqual(splitServices('Medical / Dental', ''), ['Unspecified']);
  assert.deepStrictEqual(splitServices('Medical / Dental', null), ['Unspecified']);
  assert.deepStrictEqual(splitServices('Medical / Dental', '  /  '), ['Unspecified']);
});

/* ── Grouping ───────────────────────────────────────────────────────────── */

test('services map to the buckets the Chief asked in', () => {
  assert.strictEqual(groupFor('MMR'), 'Immunizations');
  assert.strictEqual(groupFor('HIV Blood Draw'), 'Labs & Bloodwork');
  assert.strictEqual(groupFor('PHAQ'), 'Health Assessments');
  assert.strictEqual(groupFor('MHA'), 'Health Assessments');
  assert.strictEqual(groupFor('Mil Dental Exam'), 'Dental');
  assert.strictEqual(groupFor('PT Test'), 'Fitness');
  assert.strictEqual(groupFor('Fitness Counseling'), 'Fitness');
  assert.strictEqual(groupFor('Audiogram'), 'Screenings');
});

test('DHA3 is an assessment, not dental work', () => {
  // The source newsletter never says whether DHA is Dental or Deployment Health
  // Assessment. "Assessment" is true either way; "Dental" would be a guess with
  // a clinical meaning attached. If the squadron confirms it is dental, the fix
  // is one line in lib/medical.js — and this test is the reminder.
  assert.strictEqual(groupFor('DHA3'), 'Health Assessments');
  assert.strictEqual(groupFor('DHA'), 'Health Assessments');
});

test('an unrecognised service keeps its name instead of being dropped', () => {
  assert.strictEqual(groupFor('Sleep Study'), 'Other');
  assert.strictEqual(groupFor('Unspecified'), 'Other');
});

/* ── The rollup ─────────────────────────────────────────────────────────── */

const AUGUST = [
  { member_id: 1, title: 'Medical / Dental', details: 'PHAQ / DHA3', done: false },
  { member_id: 2, title: 'Medical / Dental', details: 'PHAQ / DHA3', done: false },
  { member_id: 3, title: 'Medical / Dental', details: 'MMR / HIV Blood Draw', done: false },
  { member_id: 4, title: 'Medical / Dental', details: 'Mil Dental Exam 9 Aug @ 1020hrs', done: false },
  { member_id: 5, title: 'Medical / Dental', details: 'Mil Dental Exam', done: true },
  { member_id: 1, title: 'PT Test', details: 'Due Sep 2026', done: false },
];

test('counts people, not task rows', () => {
  const r = rollup(AUGUST);
  const g = Object.fromEntries(r.groups.map(x => [x.group, x.people]));
  // Member 1 owes PHAQ and DHA3 — that is one person needing assessments.
  assert.strictEqual(g['Health Assessments'], 2);
  assert.strictEqual(g['Dental'], 2);
  assert.strictEqual(g['Immunizations'], 1);
  assert.strictEqual(g['Labs & Bloodwork'], 1);
  assert.strictEqual(g['Fitness'], 1);
  // Five distinct members hold a medical task; member 1 holds two of them.
  assert.strictEqual(r.totalMembers, 5);
});

test('the same exam at two appointment times is one service', () => {
  const dental = rollup(AUGUST).groups.find(g => g.group === 'Dental');
  assert.deepStrictEqual(dental.services.map(s => s.service), ['Mil Dental Exam']);
  assert.strictEqual(dental.services[0].people, 2);
  assert.strictEqual(dental.services[0].done, 1);
});

test('groups and services are ordered biggest first', () => {
  const r = rollup(AUGUST);
  const people = r.groups.map(g => g.people);
  assert.deepStrictEqual(people, [...people].sort((a, b) => b - a),
    'the number being read for should be at the top');
  const ha = r.groups.find(g => g.group === 'Health Assessments');
  assert.deepStrictEqual(ha.services.map(s => s.service).sort(), ['DHA3', 'PHAQ']);
});

test('no medical tasks yields an empty rollup rather than throwing', () => {
  assert.deepStrictEqual(rollup([]), { groups: [], totalMembers: 0 });
  assert.deepStrictEqual(rollup(null), { groups: [], totalMembers: 0 });
});
