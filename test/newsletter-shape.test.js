// Unit tests for newsletter/shape.js — the layer between the task rows and the slides.
//
// Every one of these tests exists because the August 2026 export got the slide wrong
// while the database held the right data. The shapers selected rows by exact match
// against title strings that had drifted, so three slides printed "nothing recorded
// for this UTA" over a full database and one printed five times too many rows. A
// filter that matches nothing and a source that holds nothing render identically,
// which is why nobody caught it for a cycle.
//
// LIVE_TITLES at the bottom is the actual title inventory of the August 2026 cycle,
// pulled from production. It is the regression guard: if a shaper stops recognising
// a title that is really in use, that test fails rather than a slide quietly emptying.

const { test } = require('node:test');
const assert = require('node:assert');
const shape = require('../newsletter/shape');

const task = (over = {}) => ({
  rank: 'SSgt', last: 'Conard', title: 'Task', details: '', urgency: 'this_uta', shop: 'WFSM',
  informational: false, ...over,
});

test('the orders slide keeps the DTS and AROWS tasks the tracker actually stores', () => {
  const rows = shape.shapeOrders([
    task({ last: 'Whittingham', title: 'DTS Voucher', details: 'Receipts must be attached' }),
    task({ last: 'Green', title: 'DTS Authorization' }),
    task({ last: 'Ebbert', title: 'Sign RUTA', details: "Sign RUTA's in AROWS" }),
    task({ last: 'Green', title: 'Sign Orders' }),
    task({ last: 'Banks', title: 'AROWS' }),
    task({ last: 'Gablin', title: 'Form 55\'s' }),
    task({ last: 'Gablin', title: 'EPB - Closeout' }),
  ]);

  assert.deepStrictEqual(rows.dts.map(r => r.name), ['Whittingham', 'Green'],
    'both DTS titles belong in the DTS table');
  assert.deepStrictEqual(rows.arows.map(r => r.name), ['Ebbert', 'Green', 'Banks'],
    'RUTAs, order signatures and bare AROWS rows belong in the AROWS table');
  assert.strictEqual(rows.dts[0].comment, 'Receipts must be attached',
    'the detail text is carried through as the row comment');
});

// The PT shaper matched the title fine and then dropped every row one line later:
// a task that was not overdue had to yield a "Due Mon YYYY" out of its detail text,
// and the live details are appointment times. Eleven tasks, four with real Saturday
// slots, rendered as "No scheduled tests recorded in the tracker for this UTA."
test('the PT slide keeps a scheduled test, which carries an appointment time not a due month', () => {
  const pt = shape.shapePt([
    task({ last: 'Ebbert', title: 'PT Test', details: 'PT Test Scheduled Saturday @ 1030hrs' }),
    task({ last: 'Tarasewicz', title: 'PT Test', details: 'Need to schedule' }),
    task({ last: 'Conard', title: 'PT Test', details: 'Due Sep 2026' }),
    task({ last: 'Maitima', title: 'PT Test', details: 'Overdue since May', urgency: 'overdue' }),
    task({ last: 'Gablin', title: 'Audiogram' }),
  ]);

  assert.deepStrictEqual(pt.scheduled.map(m => m.last), ['Ebbert', 'Tarasewicz'],
    'a test with an appointment time is scheduled, not discarded');
  assert.strictEqual(pt.scheduled[0].detail, 'PT Test Scheduled Saturday @ 1030hrs',
    'the appointment time is what the member needs off this slide');
  assert.deepStrictEqual(pt.buckets.map(b => b.label), ['Due September 26'],
    'a task that does name a due month still buckets by it');
  assert.deepStrictEqual(pt.overdue.map(m => m.last), ['Maitima']);
});

test('no PT task is dropped, whatever its detail text says', () => {
  const details = ['PT Test Scheduled Saturday @ 1030hrs', 'Due Sep 2026', 'Need to schedule',
    '', 'Sat @ 1030hrs', 'Due Jan 2027'];
  const pt = shape.shapePt(details.map((d, i) => task({ last: `M${i}`, title: 'PT Test', details: d })));

  const out = pt.overdue.length + pt.scheduled.length
    + pt.buckets.reduce((n, b) => n + b.members.length, 0);
  assert.strictEqual(out, details.length,
    'every PT task reaches exactly one of overdue, scheduled or a due-month bucket');
});

test('a slide headed "EPBs / OPBs" prints the OPBs too', () => {
  const epbs = shape.shapeEpbs([
    task({ last: 'Gablin', title: 'EPB - Closeout', details: 'Needs everything', urgency: 'overdue' }),
    task({ last: 'Monico', title: 'OPB - Closeout', details: 'Sitting at Col Balint', urgency: 'overdue' }),
    task({ last: 'Burton', title: 'OPB - Closeout', details: 'Needs HLR assessment' }),
    task({ last: 'Gablin', title: 'AtHoc' }),
  ]);

  assert.deepStrictEqual(epbs.overdue.map(r => r.last), ['Gablin', 'Monico'],
    'an overdue OPB is as overdue as an overdue EPB');
  assert.deepStrictEqual(epbs.comingDue.map(r => r.last), ['Burton']);
});

// The Upcoming category is a grab-bag of notices. "Family Day" is assigned to every
// member of the squadron, so sweeping the whole category onto this slide printed 84
// rows where the newsletter has 16, burying twelve real departures. Filtering on the
// informational flag is not the fix — "BMT & Technical School" carries urgency 'info'
// too, so that would empty the slide instead. What separates them is the subject.
test('the airmen slide takes school and PME dates, not squadron-wide notices', () => {
  const io = shape.shapeInbound([
    task({ last: 'Kadiri', title: 'BMT & Technical School', details: '5 May 2026 - 21 Oct 2026', urgency: 'info' }),
    task({ last: 'Deguzman', title: 'OTS', details: '30 Jun - 28 Aug 2026', urgency: 'info' }),
    task({ last: 'Santos', title: 'NCOA In-Residence', details: '7 Jul - 12 Aug 2026', urgency: 'info' }),
    task({ last: 'Ebbert', title: 'Family Day', details: 'Friday, September 11', urgency: 'info' }),
    task({ last: 'Gablin', title: 'Family Day', details: 'Friday, September 11', urgency: 'info' }),
    task({ last: 'Brown', title: 'FY26 DFT', details: 'Camp Murray', urgency: 'info' }),
  ]);

  assert.deepStrictEqual(io.bmt.map(r => r.last), ['Kadiri', 'Deguzman'],
    'BMT, tech school and OTS are the accession pipeline');
  assert.deepStrictEqual(io.pme.map(r => r.last), ['Santos'], 'NCOA is PME');
  assert.deepStrictEqual(io.other.map(r => r.title).sort(), ['FY26 DFT', 'Family Day', 'Family Day'],
    'what this slide will not print is returned rather than silently discarded');
});

// Page 15 of the newsletter is the government travel card: who still owes a Statement
// of Understanding and who still owes the GTC CBT certificate. The export gave that
// page to SGLI & vRED instead — tasks the tracker has never held — so it printed two
// empty columns while twenty live GTC and SoU tasks had nowhere to go.
test('the travel card slide lists who owes an SoU and who owes the card CBT', () => {
  const gtc = shape.shapeGtc([
    task({ last: 'Sandberg', title: 'Statement of Understanding (SoU)' }),
    task({ last: 'Bernard', title: 'Statement of Understanding (SoU)' }),
    task({ last: 'Bernard', title: 'GTC CBT', details: 'Turn cert in to your supervisor' }),
    task({ last: 'Hill', title: 'GTC CBT' }),
    task({ last: 'Gablin', title: 'Form 55\'s' }),
    task({ last: 'Gablin', title: 'DTS Voucher' }),
  ]);

  assert.deepStrictEqual(gtc.sou.map(r => r.last), ['Bernard', 'Sandberg'], 'SoU column, sorted by name');
  assert.deepStrictEqual(gtc.cbt.map(r => r.last), ['Bernard', 'Hill'], 'GTC CBT column');
});

// The regression guard. Every admin title really in use on the August 2026 cycle,
// read off production. The bug this suite exists for was invisible precisely because
// an unrecognised title and an absent title render the same way, so the deck has to
// account for all of them: either a shaper claims a title, or it is named below as
// having no slide. A title that is neither fails here rather than emptying a page.
const LIVE_ADMIN_TITLES = [
  "Form 55's", 'AtHoc', 'JSTO', "Quarterly Award 1206's", 'EPB - Closeout', 'GTC CBT',
  'DTS Voucher', 'Statement of Understanding (SoU)', 'OPB - Closeout', 'Sign Orders',
  'Sign RUTA', 'AROWS', 'DTS Authorization',
];

// Tracked, printed nowhere. Form 55s and JSTO are named on the hand-written Safety
// slide and the 1206s on the hand-written Awards slide, but as prose — none of them
// read these tasks. Giving them a slide is a product decision, not a bug fix; what
// matters here is that the omission stays deliberate.
const NO_SLIDE_YET = ["Form 55's", 'AtHoc', 'JSTO', "Quarterly Award 1206's"];

test('every admin title in use either reaches a slide or is a known omission', () => {
  const claims = (title) => {
    const t = [task({ title })];
    const o = shape.shapeOrders(t), e = shape.shapeEpbs(t), g = shape.shapeGtc(t);
    return o.dts.length + o.arows.length + e.overdue.length + e.comingDue.length
         + g.sou.length + g.cbt.length > 0;
  };
  const unrouted = LIVE_ADMIN_TITLES.filter(t => !claims(t));

  assert.deepStrictEqual(unrouted.sort(), [...NO_SLIDE_YET].sort(),
    'a new admin title must be given a slide, or added to NO_SLIDE_YET on purpose');
  assert.strictEqual(LIVE_ADMIN_TITLES.length - unrouted.length, 9,
    'the nine titles that do have a slide still reach it');
});

// The newsletter draws the UTA as a time grid — hours across the top, events as bars
// under the hours they occupy — so a member can see at a glance what overlaps lunch.
// The export listed the same events vertically, which loses exactly that. Laying them
// out horizontally means knowing where each bar starts, how wide it is, and which
// events collide and so need a lane of their own.
const ev = (start, end, title, over = {}) =>
  ({ day: 'Saturday', start, end, title, details: '', type: '', shop: '', ...over });

test('the timeline places each event on an hourly grid spanning the day', () => {
  const [sat] = shape.shapeTimeline([
    ev('0800', '0900', 'Formation / Roll Call'),
    ev('0900', '1200', 'Admin / In-house Training'),
    ev('1200', '1330', 'Lunch'),
  ]);

  assert.strictEqual(sat.grid.from, 8 * 60, 'the grid opens on the hour the day starts');
  assert.strictEqual(sat.grid.to, 14 * 60, 'and closes on the hour after the last event ends');
  assert.deepStrictEqual(sat.grid.ticks, ['0800', '0900', '1000', '1100', '1200', '1300'],
    'one tick per hour, which is the header row of the printed grid');
  assert.deepStrictEqual(sat.events.map(e => [e.startMin, e.endMin]),
    [[480, 540], [540, 720], [720, 810]]);
});

test('events that overlap are stacked into separate lanes, not overwritten', () => {
  const [sat] = shape.shapeTimeline([
    ev('0900', '1200', 'Admin / In-house Training'),
    ev('1000', '1030', 'BCA Measurements'),
    ev('1030', '1100', 'Manning Doc Meeting'),
    ev('1200', '1330', 'Lunch'),
  ]);

  const lane = (title) => sat.events.find(e => e.title === title).lane;
  assert.strictEqual(lane('Admin / In-house Training'), 0);
  assert.strictEqual(lane('BCA Measurements'), 1, 'it runs inside Admin, so it needs its own lane');
  assert.strictEqual(lane('Manning Doc Meeting'), 1,
    'it clears BCA, so it reuses that lane rather than opening a third');
  assert.strictEqual(lane('Lunch'), 0, 'Lunch starts as Admin ends, so lane 0 is free again');
  assert.strictEqual(sat.grid.laneCount, 2);
});

// Lane 0 is the one a reader scans first, so when two events start together the
// longer one belongs there: Lunch is the squadron's afternoon, the 30-minute C2
// measurement slot inside it is the exception.
test('when two events start together the longer one takes the top lane', () => {
  const [sat] = shape.shapeTimeline([
    ev('1200', '1230', 'BCA Measurements — C2'),
    ev('1200', '1330', 'Lunch'),
  ]);
  const lane = (title) => sat.events.find(e => e.title === title).lane;
  assert.strictEqual(lane('Lunch'), 0);
  assert.strictEqual(lane('BCA Measurements — C2'), 1);
});

test('an event with no end time still gets a bar, and an untimed one is kept aside', () => {
  const [sat] = shape.shapeTimeline([
    ev('1600', '', 'Formation'),
    ev('', '', 'Focus on LOTO and fall protection', { type: 'emphasis' }),
  ]);

  assert.deepStrictEqual(sat.events.map(e => e.title), ['Formation'],
    'only events that can be placed go on the grid');
  assert.ok(sat.events[0].endMin > sat.events[0].startMin, 'a bar must have width to be visible');
  assert.deepStrictEqual(sat.untimed.map(e => e.title), ['Focus on LOTO and fall protection'],
    'an emphasis note has no time, so it prints under the grid instead of vanishing');
});

test('days are ordered Friday, Saturday, Sunday and empty days are dropped', () => {
  const days = shape.shapeTimeline([
    ev('0800', '0900', 'Sunday formation', { day: 'Sunday' }),
    ev('0800', '0900', 'Saturday formation', { day: 'Saturday' }),
  ]);
  assert.deepStrictEqual(days.map(d => d.day), ['Saturday', 'Sunday']);
});
