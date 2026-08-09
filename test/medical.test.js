// Unit coverage for the medical services rollup.
//
// Every title below is a real production title from the Aug 2026 UTA. That matters:
// the version this replaces was validated against a preview database seeded from
// the newsletter by the same session that wrote the parser, so it only ever proved
// the code agreed with its own fixture. It shipped, and showed leadership
// "Need to get Height 68" — because on production the service is the task TITLE and
// `details` holds instructions and appointment times.
//
// So these fixtures are copied from production, and nothing here reads `details`.

const { test } = require('node:test');
const assert = require('node:assert');
const { rollup } = require('../lib/medical');

// A row per member, as the endpoint selects them.
const rows = (title, urgency, total, done) =>
  Array.from({ length: total }, (_, i) => ({ title, urgency, done: i < done }));

// Production, Aug 2026 UTA.
const PROD = [
  ...rows('BCA Assessment',     'this_uta', 68, 34),
  ...rows('HIV Blood Draw',     'this_uta', 11, 4),
  ...rows('MHA',                'this_uta', 7, 3),
  ...rows('Audiogram',          'this_uta', 6, 2),
  ...rows('PHAQ',               'this_uta', 6, 1),
  ...rows('Dental Form Due',    'this_uta', 6, 1),
  ...rows('Mil Dental Exam',    'this_uta', 3, 0),
  ...rows('MMR',                'this_uta', 2, 2),
  ...rows('Medical Appointment','this_uta', 1, 1),
  ...rows('Fitness Counseling', 'this_uta', 1, 0),
  ...rows('PT Test',            'this_uta', 4, 1),
  ...rows('PT Test',            'next_uta', 7, 0),   // "schedule for next Drill"
  ...rows('PTL Training',       'this_uta', 1, 1),   // duty qualification
];

test('each service reports x of y done with a percentage', () => {
  const r = rollup(PROD);
  const by = Object.fromEntries(r.services.map(s => [s.service, s]));
  assert.deepStrictEqual(
    { done: by['BCA Assessment'].done, total: by['BCA Assessment'].total, pct: by['BCA Assessment'].pct },
    { done: 34, total: 68, pct: 50 });
  assert.deepStrictEqual(
    { done: by['HIV Blood Draw'].done, total: by['HIV Blood Draw'].total, pct: by['HIV Blood Draw'].pct },
    { done: 4, total: 11, pct: 36 });
  assert.strictEqual(by['MMR'].pct, 100);
  assert.strictEqual(by['Mil Dental Exam'].pct, 0);
});

test('PT tests count only when due or overdue this UTA', () => {
  const r = rollup(PROD);
  const pt = r.services.find(s => s.service === 'PT Test');
  // 4 due this UTA; the 7 told to book at next drill are not this drill's work.
  assert.strictEqual(pt.total, 4);
  assert.strictEqual(pt.done, 1);
  assert.strictEqual(r.deferred, 7);
});

test('deferred work is reported, never silently dropped', () => {
  // The count exists so the card can say so. Losing 7 rows without a word is how
  // a readiness board quietly stops matching the newsletter.
  const r = rollup([...rows('Audiogram', 'next_uta', 3, 0)]);
  assert.deepStrictEqual(r.services, []);
  assert.strictEqual(r.deferred, 3);
});

test('overdue counts as due now', () => {
  const r = rollup(rows('PHAQ', 'overdue', 5, 2));
  assert.strictEqual(r.services[0].total, 5);
  assert.strictEqual(r.deferred, 0);
});

test('PTL Training is excluded as a duty qualification', () => {
  const r = rollup(PROD);
  assert.ok(!r.services.some(s => s.service === 'PTL Training'));
  // and it is not counted as deferred either — it is simply not medical work
  assert.strictEqual(r.deferred, 7);
});

test('fitness items the squadron kept are still counted', () => {
  const r = rollup(PROD);
  const names = r.services.map(s => s.service);
  assert.ok(names.includes('BCA Assessment'), 'height/weight/waist stays');
  assert.ok(names.includes('Fitness Counseling'));
  assert.ok(names.includes('PT Test'));
});

test('the squadron total excludes what the services exclude', () => {
  const r = rollup(PROD);
  // 68+11+7+6+6+6+3+2+1+1+4 = 115 counted; PTL Training and the 7 deferred are out.
  assert.strictEqual(r.total, 115);
  assert.strictEqual(r.done, 49);
  assert.strictEqual(r.pct, 43);
  assert.strictEqual(r.total, r.services.reduce((s, x) => s + x.total, 0),
    'the headline must be the sum of the bars beneath it');
});

test('most outstanding work sorts first', () => {
  const r = rollup(PROD);
  const remaining = r.services.map(s => s.remaining);
  assert.deepStrictEqual(remaining, [...remaining].sort((a, b) => b - a));
  assert.strictEqual(r.services[0].service, 'BCA Assessment', '34 outstanding');
});

test('ties sort stably rather than shuffling between refreshes', () => {
  const a = rollup([...rows('Zebra', 'this_uta', 4, 2), ...rows('Alpha', 'this_uta', 4, 2)]);
  const b = rollup([...rows('Alpha', 'this_uta', 4, 2), ...rows('Zebra', 'this_uta', 4, 2)]);
  assert.deepStrictEqual(a.services.map(s => s.service), b.services.map(s => s.service));
  assert.deepStrictEqual(a.services.map(s => s.service), ['Alpha', 'Zebra']);
});

test('an empty cycle yields zeroes rather than NaN or a throw', () => {
  assert.deepStrictEqual(rollup([]), { services: [], total: 0, done: 0, pct: 0, deferred: 0 });
  assert.deepStrictEqual(rollup(null), { services: [], total: 0, done: 0, pct: 0, deferred: 0 });
});

test('a blank title is skipped rather than becoming an empty bar', () => {
  const r = rollup([{ title: '  ', urgency: 'this_uta', done: false },
                    ...rows('MHA', 'this_uta', 2, 1)]);
  assert.deepStrictEqual(r.services.map(s => s.service), ['MHA']);
  assert.strictEqual(r.total, 2);
});
