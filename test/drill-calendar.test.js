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

const cal = require('../lib/drill-calendar');

const drillRows = DRILLS.map((d, i) => ({ id: i + 1, start_date: d.start, end_date: d.end, note: d.note }));
const eventRows = EVENTS.map((e, i) => ({
  id: i + 1, title: e.title, location: e.location, start_date: e.start, end_date: e.end,
  attendees: e.attendees, status: e.status, note: e.note,
}));

test('buildYear: ten drills plus one July gap, in date order, each drill once', () => {
  const { year, entries } = cal.buildYear(drillRows, 2026, '2026-08-22');
  assert.strictEqual(year, 2026);
  assert.strictEqual(entries.length, 11);
  assert.strictEqual(entries.filter(e => e.kind === 'drill').length, 10);
  assert.deepStrictEqual(entries.find(e => e.kind === 'no_uta'), { kind: 'no_uta', month: 7, label: 'July' });
  assert.deepStrictEqual(entries.map(e => e.label), [
    '31 Jan–1 Feb', '6–8 Mar', '11–12 Apr', '1–3 May', '5–7 Jun', 'July',
    '8–9 Aug', '11–13 Sep', '17–18 Oct', '14–15 Nov', '11–13 Dec',
  ]);
});

test('buildYear: a drill spanning two months covers both, so neither is a gap', () => {
  const { entries } = cal.buildYear(drillRows, 2026, '2026-01-01');
  assert.ok(!entries.some(e => e.kind === 'no_uta' && (e.month === 1 || e.month === 2)));
});

test('buildYear: threeDay flips at three calendar days', () => {
  const { entries } = cal.buildYear(drillRows, 2026, '2026-01-01');
  const by = Object.fromEntries(entries.filter(e => e.kind === 'drill').map(e => [e.label, e.threeDay]));
  assert.strictEqual(by['31 Jan–1 Feb'], false);
  assert.strictEqual(by['8–9 Aug'], false);
  assert.strictEqual(by['6–8 Mar'], true);
  assert.strictEqual(by['11–13 Sep'], true);
});

test('buildYear: past and next are relative to the reference date, and only one entry is next', () => {
  const drills = cal.buildYear(drillRows, 2026, '2026-08-22').entries.filter(e => e.kind === 'drill');
  assert.deepStrictEqual(drills.map(d => d.past),
    [true, true, true, true, true, true, false, false, false, false]);
  assert.strictEqual(drills.filter(d => d.next).length, 1);
  assert.strictEqual(drills.find(d => d.next).label, '11–13 Sep');
});

// A cycle created through the Task Builder has no start_date — cycles 4, 5 and 6 on
// production all do — and the newsletter used to fall back to `new Date()` for the
// reference. On 28 August that struck through the 8–9 Aug drill the deck was FOR and
// bolded 11–13 Sep as "this UTA". A calendar that cannot know which drill it is for
// must mark none of them rather than confidently mark the wrong one; an empty string
// is not a safe stand-in either, since every real date sorts after it and that quietly
// makes January "next".
test('buildYear: with no reference date, no drill is marked past or next', () => {
  for (const ref of [null, undefined, '']) {
    const drills = cal.buildYear(drillRows, 2026, ref).entries.filter(e => e.kind === 'drill');
    assert.strictEqual(drills.length, 10, `ref=${JSON.stringify(ref)}: every drill still listed`);
    assert.ok(drills.every(d => d.past === false), `ref=${JSON.stringify(ref)}: nothing struck through`);
    assert.ok(drills.every(d => d.next === false), `ref=${JSON.stringify(ref)}: nothing bolded`);
  }
});

test('buildYear: a reference date inside a drill makes that drill next, not past', () => {
  const { entries } = cal.buildYear(drillRows, 2026, '2026-09-12');
  const sep = entries.find(e => e.label === '11–13 Sep');
  assert.strictEqual(sep.past, false);
  assert.strictEqual(sep.next, true);
  assert.strictEqual(entries.find(e => e.label === '8–9 Aug').past, true);
});

test('buildYear: Date inputs are accepted (pg returns a bare DATE column as Date)', () => {
  const dated = drillRows.map(r => ({
    ...r, start_date: new Date(r.start_date + 'T00:00:00Z'), end_date: new Date(r.end_date + 'T00:00:00Z'),
  }));
  const { entries } = cal.buildYear(dated, 2026, new Date('2026-08-22T15:00:00Z'));
  assert.strictEqual(entries.find(e => e.next).label, '11–13 Sep');
  assert.strictEqual(entries.find(e => e.next).start_date, '2026-09-11');
});

test('buildYear: other years are ignored; an empty year has no drills', () => {
  const mixed = [...drillRows, { id: 99, start_date: '2027-01-09', end_date: '2027-01-10', note: null }];
  assert.strictEqual(cal.buildYear(mixed, 2026, '2026-01-01').entries.filter(e => e.kind === 'drill').length, 10);
  assert.strictEqual(cal.buildYear(mixed, 2027, '2026-01-01').entries.filter(e => e.kind === 'drill').length, 1);
  assert.strictEqual(cal.buildYear([], 2026, '2026-01-01').entries.filter(e => e.kind === 'drill').length, 0);
});

test('buildCalendar: twelve month groups, noUta on the month rather than as a row', () => {
  const { year, months } = cal.buildCalendar(drillRows, eventRows, 2026, '2026-08-22');
  assert.strictEqual(year, 2026);
  assert.strictEqual(months.length, 12);
  assert.deepStrictEqual(months.map(m => m.month), [1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.strictEqual(months[0].label, 'January');
  // Only July has no drill. February is covered by the 31 Jan–1 Feb drill.
  assert.deepStrictEqual(months.filter(m => m.noUta).map(m => m.month), [7]);
  assert.ok(!months.some(m => m.entries.some(e => e.kind === 'no_uta')), 'no_uta is never an entry here');
});

test('buildCalendar: drills and events interleave by date inside a month', () => {
  const { months } = cal.buildCalendar(drillRows, eventRows, 2026, '2026-08-22');
  const april = months.find(m => m.month === 4);
  assert.deepStrictEqual(april.entries.map(e => [e.kind, e.label]),
    [['drill', '11–12 Apr'], ['event', '12–18 Apr']]);
  const apr = april.entries[1];
  assert.strictEqual(apr.title, 'RADR');
  assert.strictEqual(apr.location, 'Dobbins ARB, GA');
  assert.strictEqual(apr.status, 'complete');
  assert.strictEqual(apr.past, true);
  // January: two rotations on the 11th, one on the 25th, then the 31 Jan drill.
  // The drill sorts LAST because it starts last — that is the point of
  // interleaving, and it is why noUta cannot be inferred from position.
  const jan = months.find(m => m.month === 1);
  assert.deepStrictEqual(jan.entries.map(e => e.kind), ['event', 'event', 'event', 'drill']);
  assert.deepStrictEqual(jan.entries.slice(0, 2).map(e => e.title), ['RADR', 'Silver Flag'],
    'same-day events sort by title');
});

test('buildCalendar: an event is listed once, in the month it starts', () => {
  const { months } = cal.buildCalendar([], eventRows, 2026, '2026-08-22');
  const seen = months.flatMap(m => m.entries).filter(e => e.title === 'FY26 DFT');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(months.find(m => m.entries.includes(seen[0])).month, 6, 'June, where it starts');
});

test('buildCalendar: next marks a drill only, and events never carry it', () => {
  const { months } = cal.buildCalendar(drillRows, eventRows, 2026, '2026-08-22');
  const all = months.flatMap(m => m.entries);
  assert.strictEqual(all.filter(e => e.next).length, 1);
  assert.strictEqual(all.find(e => e.next).kind, 'drill');
  assert.ok(all.filter(e => e.kind === 'event').every(e => e.next === undefined));
});

test('buildCalendar: a year with only events still returns twelve months, all noUta', () => {
  const { months } = cal.buildCalendar([], eventRows, 2025, '2026-08-22');
  assert.strictEqual(months.length, 12);
  assert.ok(months.every(m => m.noUta));
  assert.strictEqual(months.find(m => m.month === 12).entries.length, 1);
  assert.strictEqual(months.flatMap(m => m.entries).length, 1, 'only the Dec 2025 rotation');
});

test('label: same month, across months, single day', () => {
  assert.strictEqual(cal.label('2026-09-11', '2026-09-13'), '11–13 Sep');
  assert.strictEqual(cal.label('2026-01-31', '2026-02-01'), '31 Jan–1 Feb');
  assert.strictEqual(cal.label('2026-08-08', '2026-08-08'), '8 Aug');
});

test('years: distinct and ascending across every list passed', () => {
  assert.deepStrictEqual(cal.years(drillRows, eventRows), [2025, 2026]);
  assert.deepStrictEqual(cal.years([{ start_date: '2027-01-09' }, { start_date: new Date('2026-09-11T00:00:00Z') }]),
    [2026, 2027]);
  assert.deepStrictEqual(cal.years([]), []);
});

test('validateDrill: accepts a real drill and normalises the note', () => {
  assert.deepStrictEqual(cal.validateDrill({ start_date: '2026-09-11', end_date: '2026-09-13', note: '  ' }),
    { ok: true, value: { start_date: '2026-09-11', end_date: '2026-09-13', note: null } });
  assert.strictEqual(cal.validateDrill({ start_date: '2026-08-08', end_date: '2026-08-08', note: ' one day ' }).value.note,
    'one day');
});

test('validateDrill: rejects malformed, impossible, reversed and over-long drills', () => {
  const bad = (body) => { const r = cal.validateDrill(body); assert.strictEqual(r.ok, false, JSON.stringify(body)); return r.error; };
  assert.match(bad({ start_date: '9/11/2026', end_date: '2026-09-13' }), /start_date/);
  assert.match(bad({ start_date: '2026-02-30', end_date: '2026-03-01' }), /start_date/);
  assert.match(bad({ start_date: '2026-09-11' }), /end_date/);
  assert.match(bad({ start_date: '2026-09-13', end_date: '2026-09-11' }), /before/);
  assert.match(bad({ start_date: '2026-09-01', end_date: '2026-09-08' }), /seven days/);
  assert.match(bad({ start_date: '2026-09-11', end_date: '2026-09-13', note: 'x'.repeat(81) }), /80/);
});

test('overlaps: shared days overlap, adjacent days do not', () => {
  const a = { start_date: '2026-09-11', end_date: '2026-09-13' };
  assert.strictEqual(cal.overlaps(a, { start_date: '2026-09-13', end_date: '2026-09-14' }), true);
  assert.strictEqual(cal.overlaps(a, { start_date: '2026-09-01', end_date: '2026-09-11' }), true);
  assert.strictEqual(cal.overlaps(a, { start_date: '2026-09-14', end_date: '2026-09-15' }), false);
  assert.strictEqual(cal.overlaps(a, { start_date: '2026-09-09', end_date: '2026-09-10' }), false);
});

test('a drill straddling New Year covers January, but is listed only under the year it starts', () => {
  const straddle = [{ id: 1, start_date: '2026-12-30', end_date: '2027-01-02', note: null }];

  const y2027 = cal.buildYear(straddle, 2027, '2026-06-01');
  assert.ok(!y2027.entries.some(e => e.kind === 'no_uta' && e.month === 1),
    'January 2027 has drill days in it, so it is not a No-UTA month');
  assert.strictEqual(y2027.entries.filter(e => e.kind === 'drill').length, 0,
    'but the drill itself is not listed under 2027 — it starts in 2026');

  const y2026 = cal.buildYear(straddle, 2026, '2026-06-01');
  assert.strictEqual(y2026.entries.filter(e => e.kind === 'drill').length, 1, 'listed once, under 2026');
  assert.ok(!y2026.entries.some(e => e.kind === 'no_uta' && e.month === 12));

  const c2027 = cal.buildCalendar(straddle, [], 2027, '2026-06-01');
  assert.strictEqual(c2027.months.find(m => m.month === 1).noUta, false, 'January covered');
  assert.strictEqual(c2027.months.find(m => m.month === 2).noUta, true, 'February still a gap');
  assert.strictEqual(c2027.months.flatMap(m => m.entries).length, 0, 'and still listed nowhere in 2027');
});

test('validateDrill accepts exactly seven days and rejects eight', () => {
  assert.strictEqual(cal.validateDrill({ start_date: '2026-09-07', end_date: '2026-09-13' }).ok, true);
  assert.strictEqual(cal.validateDrill({ start_date: '2026-09-07', end_date: '2026-09-14' }).ok, false);
});

test('past is false on the day an entry ends, for events as well as drills', () => {
  const ev = [{ id: 1, title: 'RADR', start_date: '2026-05-03', end_date: '2026-05-09', status: 'scheduled' }];
  const at = (ref) => cal.buildCalendar([], ev, 2026, ref).months.find(m => m.month === 5).entries[0];
  assert.strictEqual(at('2026-05-09').past, false, 'still running on its last day');
  assert.strictEqual(at('2026-05-10').past, true);
});
