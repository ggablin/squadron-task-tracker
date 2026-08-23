// Pure tests: the seed data files and lib/drill-calendar.js need no database.
const { test } = require('node:test');
const assert = require('node:assert');

const DUTIES = require('../data/additional-duties');
const DRILLS = require('../data/drill-dates');
const EVENTS = require('../data/calendar-events');

test('the duties seed is the newsletter partial, with TBD and dashes normalised to null', () => {
  assert.strictEqual(DUTIES.length, 52);
  for (const d of DUTIES) {
    assert.ok(d.duty && d.duty.length <= 120, `duty name present: ${JSON.stringify(d)}`);
    for (const k of ['primary', 'alternate']) {
      assert.ok(d[k] === null || (typeof d[k] === 'string' && d[k].length <= 200), `${d.duty}.${k}`);
      assert.notStrictEqual(d[k], 'TBD', `${d.duty}.${k} should be null, not the text TBD`);
      assert.notStrictEqual(d[k], '—', `${d.duty}.${k} should be null, not a dash`);
    }
  }
  assert.strictEqual(new Set(DUTIES.map(d => d.duty.toLowerCase())).size, 52, 'names unique, case-insensitively');
  assert.deepStrictEqual(DUTIES.find(d => d.duty === 'Records Management / FARM'),
    { duty: 'Records Management / FARM', primary: null, alternate: null });
  assert.deepStrictEqual(DUTIES.find(d => d.duty === 'ADUTM'),
    { duty: 'ADUTM', primary: 'McNaughton', alternate: null });
  assert.strictEqual(DUTIES.find(d => d.duty === 'WAR / WIT').alternate, 'EVERYONE / TBD',
    'compound text keeps its wording');
});

test('the drill seed is the ten CY-2026 drills', () => {
  assert.strictEqual(DRILLS.length, 10);
  for (const d of DRILLS) {
    assert.match(d.start, /^2026-\d{2}-\d{2}$/);
    assert.match(d.end, /^2026-\d{2}-\d{2}$/);
    assert.ok(d.end >= d.start, `${d.start} ends on or after it starts`);
    assert.ok(d.note === null || typeof d.note === 'string');
  }
  assert.deepStrictEqual(DRILLS[0], { start: '2026-01-31', end: '2026-02-01', note: 'Jan & Feb combined' });
  assert.ok(!DRILLS.some(d => d.start.startsWith('2026-07')), 'July has no drill');
});

test('the events seed is the MEETs/RADR partial, spanning two years', () => {
  assert.strictEqual(EVENTS.length, 10);
  for (const e of EVENTS) {
    assert.ok(e.title && e.title.length <= 120, `title: ${JSON.stringify(e)}`);
    assert.match(e.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.end >= e.start, `${e.title} ends on or after it starts`);
    assert.ok(['scheduled', 'complete', 'cancelled'].includes(e.status), `${e.title} status`);
    assert.ok(e.attendees === null || e.attendees.length <= 600, `${e.title} attendees fit`);
    assert.ok(e.location === null || e.location.length <= 120, `${e.title} location fits`);
  }
  assert.deepStrictEqual([...new Set(EVENTS.map(e => e.start.slice(0, 4)))].sort(), ['2025', '2026']);
  assert.strictEqual(EVENTS.filter(e => e.status === 'complete').length, 5);
  assert.strictEqual(EVENTS.filter(e => e.status === 'cancelled').length, 1);
  const dft = EVENTS.find(e => e.title === 'FY26 DFT');
  assert.strictEqual(dft.location, 'Camp Murray, WA');
  assert.ok(dft.attendees.includes('MSgt White (possibly)'), 'the roster is verbatim');
});
