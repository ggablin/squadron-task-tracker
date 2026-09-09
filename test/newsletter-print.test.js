// The September 2026 print pass. Every test here pins a shape that the printed deck
// depends on: the blanket sentence lifted off 134 CBT lines, the squadron-wide AROWS
// notice collapsed off 73 identical rows, the title formats September actually uses.
//
// LIVE_*_SEP at the bottom is the September 2026 title inventory, read off production
// the same way the August one in newsletter-shape.test.js was. It is the §8a guard for
// this cycle: two of its titles ('Upgrade training progress', 'PT Test - due October
// 26') reached no slide at all in the August-shaped export, and one slide printed empty
// over 21 real rows because of it.

const { test } = require('node:test');
const assert = require('node:assert');
const shape = require('../newsletter/shape');

const task = (over = {}) => ({
  rank: 'SSgt', last: 'Conard', title: 'Task', details: '', urgency: 'this_uta', shop: 'WFSM', ...over,
});

const MYL = 'In MyLearning. Give cert to your supervisor, who gives it to MSgt McNaughton by COB Sunday.';
const AFI = 'Additional training per AFI 10-210 - counts toward your overall MRA. Found on Percipio.';

// ── liftCommon: the sentence everyone shares moves up a level ─────────────────────
test('sentences shared by most of a group are lifted to one note; the rest stay per member', () => {
  const { note, statuses } = shape.liftCommon([
    { details: `3 Months Overdue. ${MYL}` },
    { details: `Due This Month. ${MYL}` },
    { details: `1 Month Overdue. ${MYL}` },
  ]);
  assert.strictEqual(note, MYL, 'the boilerplate is the note');
  assert.deepStrictEqual(statuses, ['3 Months Overdue', 'Due This Month', '1 Month Overdue'],
    'what is left is each member\'s own status, without its full stop');
});

test('a status sentence is never lifted, even from a group of one', () => {
  const { note, statuses } = shape.liftCommon([{ details: `7 Months Overdue. ${MYL}` }]);
  assert.strictEqual(note, MYL);
  assert.deepStrictEqual(statuses, ['7 Months Overdue'],
    'a single member\'s overdue count is theirs, not a heading');
});

test('a group with nothing in common lifts nothing', () => {
  const { note, statuses } = shape.liftCommon([
    { details: 'Receipts must be attached.' }, { details: 'Needs signature.' }, { details: '' },
  ]);
  assert.strictEqual(note, '');
  assert.deepStrictEqual(statuses, ['Receipts must be attached', 'Needs signature', '']);
});

// ── CBTs: MyLearning on one slide, Percipio on the next ──────────────────────────
// September's 134 CBT rows split 100 / 34 between the two platforms, and the 34 are
// exactly what the hand-edited "Additional Training — AFI 10-210" slide listed by hand
// a month stale. So the platform in the title decides the slide, and the blanket
// sentence that ended every one of the 134 lines prints once per slide, not 134 times.
test('CBTs split by platform, parse "Name = Duration", and lift the blanket sentence', () => {
  const c = shape.shapeCbts([
    task({ last: 'Hill', title: 'CBT: Cyber Awareness = 1 Hr', details: `3 Months Overdue. ${MYL}`, urgency: 'overdue' }),
    task({ last: 'Banks', title: 'CBT: Cyber Awareness = 1 Hr', details: `Due This Month. ${MYL}` }),
    task({ last: 'Veal', title: 'CBT: Cyber Awareness = 1 Hr', details: `Due Next Month. ${MYL}`, urgency: 'next_uta' }),
    task({ last: 'Hill', title: 'CBT: ARC Flash = 30 Mins', details: `Due This Month. ${MYL}` }),
    task({ last: 'Bernard', title: 'Percipio: Bare Base Overview = 30 Mins', details: AFI }),
    task({ last: 'Maramba', title: 'Percipio: Bare Base Overview = 30 Mins', details: AFI }),
    task({ last: 'Sandberg', title: 'Percipio: Unit Type Code Management = 1 Hr', details: AFI }),
  ]);
  assert.deepStrictEqual(c.mandatory.map(g => [g.name, g.duration, g.members.length]),
    [['Cyber Awareness', '1 hr', 3], ['ARC Flash', '30 min', 1]], 'largest group first');
  assert.deepStrictEqual(c.additional.map(g => [g.name, g.duration, g.members.length]),
    [['Bare Base Overview', '30 min', 2], ['Unit Type Code Management', '1 hr', 1]]);
  assert.strictEqual(c.mandatoryNote, MYL, 'the blanket sentence prints once on the slide');
  assert.strictEqual(c.additionalNote, AFI);
  assert.strictEqual(c.mandatory[0].note, '', 'nothing left over for the group header');
  assert.deepStrictEqual(c.mandatory[0].members.map(m => [m.last, m.status]),
    [['Hill', '3 Months Overdue'], ['Banks', 'Due This Month'], ['Veal', 'Due Next Month']],
    'overdue first, then each member carries only their own status');
  assert.deepStrictEqual(c.additional[0].members.map(m => m.status), ['', ''],
    'a Percipio row has no status of its own once the blanket is lifted');
});

test('a sentence shared by one CBT but not the slide lands in that CBT\'s header', () => {
  const c = shape.shapeCbts([
    task({ last: 'A', title: 'CBT: Cyber Awareness = 1 Hr', details: `Due This Month. ${MYL}` }),
    task({ last: 'B', title: 'CBT: Cyber Awareness = 1 Hr', details: `1 Month Overdue. ${MYL}`, urgency: 'overdue' }),
    task({ last: 'C', title: 'CBT: Cyber Awareness = 1 Hr', details: `Due This Month. ${MYL}` }),
    task({ last: 'D', title: 'CBT: RADR Overview = 30 Mins', details: `Due This Month. ${MYL} Bring your RADR card.` }),
    task({ last: 'E', title: 'CBT: RADR Overview = 30 Mins', details: `1 Month Overdue. ${MYL} Bring your RADR card.`, urgency: 'overdue' }),
  ]);
  assert.strictEqual(c.mandatoryNote, MYL);
  const radr = c.mandatory.find(g => g.name === 'RADR Overview');
  assert.strictEqual(radr.note, 'Bring your RADR card.', 'specific to this CBT, so it heads this CBT');
  assert.deepStrictEqual(radr.members.map(m => m.status), ['1 Month Overdue', 'Due This Month']);
});

test('a CBT title without a platform or duration still gets a group', () => {
  const c = shape.shapeCbts([task({ title: 'Cyber Awareness', details: '1 hr — 5 Months Overdue', urgency: 'overdue' })]);
  assert.strictEqual(c.mandatory.length, 1);
  assert.strictEqual(c.mandatory[0].name, 'Cyber Awareness');
  assert.strictEqual(c.mandatory[0].duration, '1 hr', 'the August "duration — status" form still parses');
  assert.strictEqual(c.mandatory[0].members[0].status, '5 Months Overdue');
});

// ── Medical: one card per requirement, names inside it ───────────────────────────
test('medical groups by requirement, lifts the shared instruction, and keeps an appointment on the member', () => {
  const walk = 'Immunizations & labs walk-ins Saturday 0900-1400.';
  const med = shape.shapeMedical([
    task({ last: 'Hill', title: 'Medical: PHAQ', details: walk }),
    task({ last: 'Banks', title: 'Medical: PHAQ', details: walk }),
    task({ last: 'Veal', title: 'Medical: Mil Dental Exam - 11 Sep @ 1020hrs', details: 'Appointment 11 Sep at 1020hrs.' }),
    task({ last: 'Torres', title: 'Medical: Mil Dental Exam', details: walk }),
    task({ last: 'Geant', title: 'Dental exam OVERDUE (13+ months)', details: 'You go RED 13 months after your last exam.', urgency: 'overdue' }),
    task({ last: 'Sousa', title: 'PT Test - due September 26', details: 'Test Saturday @ 0830.' }),
  ]);
  assert.deepStrictEqual(med.map(g => g.service),
    ['Dental exam OVERDUE (13+ months)', 'PHAQ', 'Mil Dental Exam'],
    'overdue first, then by size; PT tests belong to their own slide; the "Medical:" prefix is dropped');
  assert.strictEqual(med[1].note, walk, 'one instruction per card, not per name');
  assert.deepStrictEqual(med[1].members.map(m => m.status), ['', '']);
  const dental = med[2];
  assert.deepStrictEqual(dental.members.map(m => [m.last, m.status]),
    [['Torres', ''], ['Veal', '11 Sep @ 1020hrs']],
    'an appointment written into the title stays with the member who has it');
  assert.strictEqual(med[0].overdue, true);
});

// ── PT: September writes the due month in the title ──────────────────────────────
test('PT tests bucket by the month in the title and lift the shared instruction', () => {
  const sep = 'Test Saturday @ 0830. New PT standards are posted in the hallway.';
  const pt = shape.shapePt([
    task({ last: 'Hill', title: 'PT Test - due September 26', details: sep }),
    task({ last: 'Banks', title: 'PT Test - due September 26', details: sep }),
    task({ last: 'Veal', title: 'PT Test - due October 26', details: 'Schedule yourself ASAP.', urgency: 'next_uta' }),
    task({ last: 'Geant', title: 'PT Test - OVERDUE', details: '2 months overdue. Schedule yourself ASAP.', urgency: 'overdue' }),
    task({ last: 'Sousa', title: 'Medical: PHAQ' }),
  ]);
  assert.deepStrictEqual(pt.buckets.map(b => [b.label, b.thisUta, b.members.length]),
    [['Due September 26', true, 2], ['Due October 26', false, 1]]);
  assert.strictEqual(pt.buckets[0].note, sep, 'the test time prints once on the card');
  assert.strictEqual(pt.buckets[1].note, 'Schedule yourself ASAP.');
  assert.deepStrictEqual(pt.overdue.map(m => [m.last, m.status]), [['Geant', '2 months overdue. Schedule yourself ASAP']]);
  assert.strictEqual(pt.scheduled.length, 0);
});

// ── Orders: a task assigned to the whole squadron is a notice, not 73 rows ────────
test('an AROWS reminder assigned to everyone collapses to one notice with a count', () => {
  const everyone = Array.from({ length: 40 }, (_, i) =>
    task({ last: `M${i}`, title: 'Sign any RUTA / RMP days in AROWS', details: 'If Applicable', urgency: 'info' }));
  const o = shape.shapeOrders([
    ...everyone,
    task({ last: 'Ebbert', title: 'AROWS order ZG7FVX - sign & submit', details: 'Please sign & submit orders in AROWS.' }),
    task({ last: 'Green', title: 'AROWS order ZG5DT8 - sign & submit', details: 'Please sign & submit orders in AROWS.' }),
    task({ last: 'Hill', title: 'DTS voucher 3793MK', details: 'Please complete voucher in DTS. Receipts must be attached.' }),
    task({ last: 'Veal', title: 'DTS voucher 36F0OF - needs signature', details: 'DTS voucher needs to be signed.' }),
  ]);
  assert.deepStrictEqual(o.notices, [{ title: 'Sign any RUTA / RMP days in AROWS', details: 'If Applicable', count: 40 }]);
  assert.deepStrictEqual(o.arows.map(r => [r.name, r.issue, r.comment]),
    [['Ebbert', 'AROWS order ZG7FVX - sign & submit', ''], ['Green', 'AROWS order ZG5DT8 - sign & submit', '']],
    'the instruction both rows share is lifted off them');
  assert.strictEqual(o.arowsNote, 'Please sign & submit orders in AROWS.');
  assert.deepStrictEqual(o.dts.map(r => r.comment),
    ['Please complete voucher in DTS. Receipts must be attached', 'DTS voucher needs to be signed'],
    'two different comments stay on their rows, without the full stop that printed inline');
});

// ── EPBs: one row per evaluation, the ACA sessions beside them ───────────────────
test('an EPB named for its ratee prints once, with closeout and where it sits, however many members hold the task', () => {
  const e = shape.shapeEpbs([
    task({ last: 'Blake', rank: 'SrA', title: 'EPB - SrA Blake - Closeout 31Mar2026 (sitting at MSgt Fernandez G.)', details: '*ROUTE TO BLAKE, HE SIGNS & ROUTES TO MRS. SHARP*' }),
    task({ last: 'Fernandez G.', rank: 'MSgt', title: 'EPB - SrA Blake - Closeout 31Mar2026 (sitting at MSgt Fernandez G.)', details: '*ROUTE TO BLAKE, HE SIGNS & ROUTES TO MRS. SHARP*' }),
    task({ last: 'Ye', rank: 'Maj', title: 'OPB - Maj Ye - Closeout 31May2026 (sitting at Col Balint)', details: '*NEEDS COL BALINT SIGNATURE*' }),
    task({ last: 'Brown', rank: 'MSgt', title: 'ACA due - MSgt Brown with SMSgt Izzo', details: 'ACA feedback session due this UTA. ACA SCOD for MSgt is September (even years).' }),
    task({ last: 'Izzo', rank: 'SMSgt', title: 'ACA due - MSgt Brown with SMSgt Izzo', details: 'ACA feedback session due this UTA. ACA SCOD for MSgt is September (even years).' }),
    task({ last: 'Gablin', title: 'GTC CBT certificate required' }),
  ]);
  assert.deepStrictEqual(e.comingDue.map(r => [r.type, r.ratee, r.closeout, r.sittingAt, r.needs]), [
    ['EPB', 'SrA Blake', '31 Mar 2026', 'MSgt Fernandez G.', 'ROUTE TO BLAKE, HE SIGNS & ROUTES TO MRS. SHARP'],
    ['OPB', 'Maj Ye', '31 May 2026', 'Col Balint', 'NEEDS COL BALINT SIGNATURE'],
  ], 'one row per evaluation, in closeout order, the asterisks gone (the caps are the author’s emphasis)');
  assert.strictEqual(e.overdue.length, 0);
  assert.deepStrictEqual(e.aca.pairs, ['MSgt Brown with SMSgt Izzo'], 'each session once, not once per participant');
  assert.strictEqual(e.aca.note, 'ACA feedback session due this UTA. ACA SCOD for MSgt is September (even years).');
});

test('the August EPB form — no ratee in the title — still prints one row per member', () => {
  const e = shape.shapeEpbs([
    task({ last: 'Gablin', title: 'EPB - Closeout', details: 'Needs everything', urgency: 'overdue' }),
    task({ last: 'Monico', title: 'OPB - Closeout', details: 'Sitting at Col Balint', urgency: 'overdue' }),
    task({ last: 'Burton', title: 'OPB - Closeout', details: 'Needs HLR assessment' }),
  ]);
  assert.deepStrictEqual(e.overdue.map(r => r.ratee), ['SSgt Gablin', 'SSgt Monico']);
  assert.deepStrictEqual(e.comingDue.map(r => [r.ratee, r.needs]), [['SSgt Burton', 'Needs HLR assessment']]);
});

// ── Upgrade training: the September progress line ─────────────────────────────────
test('upgrade progress is read out of the details, and the CDC reminder is lifted', () => {
  const tail = 'CDCs are to be accomplished at home, not just on drill weekends. Track tasks on your CFETP in the supervisor binder.';
  const u = shape.shapeUpgrade([
    task({ last: 'Neal', rank: 'AB', shop: 'HVAC', title: 'Upgrade training progress', details: `5-level, started March 2026 (6 months in training). CDC 5/12. Tasks 0%. ${tail}`, urgency: 'info' }),
    task({ last: 'Farthing', rank: 'SrA', shop: 'Heavy Equipment', title: 'Upgrade training progress', details: `5-level, started August 2025 (14 months in training). CDC PASSED. Tasks 100%. NEEDS SUPERVISOR APPROVAL TO SUBMIT 2096.`, urgency: 'info' }),
    task({ last: 'Uzoma', rank: 'SSgt', shop: 'Structures', title: 'Upgrade training progress', details: `7-level, started September 2024 (13 months in training). Tasks 0%. ${tail}`, urgency: 'info' }),
    task({ last: 'Hill', rank: 'SSgt', title: '7-level UGT - waiting on SSgt to start', details: 'Waiting on SSgt to start 7-level upgrade training.', urgency: 'info' }),
  ]);
  assert.deepStrictEqual(u.fiveLevel.map(r => [r.last, r.started, r.months, r.cdc, r.tasks, r.status]), [
    ['Farthing', 'August 2025', 14, 'PASSED', 100, 'NEEDS SUPERVISOR APPROVAL TO SUBMIT 2096'],
    ['Neal', 'March 2026', 6, '5/12', 0, ''],
  ], 'by name, and the note one trainee alone is given stays with them');
  assert.deepStrictEqual(u.sevenLevel.map(r => [r.last, r.months, r.cdc, r.tasks]), [['Uzoma', 13, '', 0]]);
  assert.deepStrictEqual(u.waiting, ['SSgt Hill']);
  assert.strictEqual(u.note, tail);
});

test('the August upgrade titles still route', () => {
  const u = shape.shapeUpgrade([
    task({ last: 'Neal', title: '5-Level (HVAC)', details: 'CDCs 3/12' }),
    task({ last: 'Uzoma', title: '7-Level (Structures)', details: 'Tasks 40%' }),
    task({ last: 'Hill', title: '7-Level UGT' }),
  ]);
  assert.deepStrictEqual(u.fiveLevel.map(r => [r.last, r.shop, r.status]), [['Neal', 'HVAC', 'CDCs 3/12']]);
  assert.deepStrictEqual(u.sevenLevel.map(r => r.last), ['Uzoma']);
  assert.deepStrictEqual(u.waiting, ['SSgt Hill']);
});

// ── Inbound / outbound: the shared instruction lifts; TAP joins the outbound side ──
test('the school-dates instruction prints once, and TAP training is the outbound list', () => {
  const note = 'You should have received your TLN and/or BMT/Tech School dates - tell leadership if you have not.';
  const io = shape.shapeInbound([
    task({ last: 'Kadiri', rank: 'AB', title: 'Out-processing - BMT / Tech School dates', details: note, shop: 'EA' }),
    task({ last: 'Neal', rank: 'AB', title: 'Out-processing - BMT / Tech School dates', details: note, shop: 'HVAC' }),
    task({ last: 'Veal', title: 'PT Test - due October 26', details: 'Schedule yourself ASAP.', urgency: 'next_uta' }),
  ]);
  assert.deepStrictEqual(io.bmt.map(r => [r.last, r.status, r.shop]), [['Kadiri', '', 'EA'], ['Neal', '', 'HVAC']]);
  assert.strictEqual(io.bmtNote, note);
  assert.deepStrictEqual(io.other.map(r => r.title), ['PT Test - due October 26'], 'still handed back, not lost');

  const tap = shape.shapeTap([
    task({ last: 'Sousa', title: 'TAP training - all required tasks', details: 'Complete at tapevents.mil > Online Courses > TAP Courses.' }),
    task({ last: 'Long', title: 'TAP training - all required tasks', details: 'Complete at tapevents.mil > Online Courses > TAP Courses.' }),
    task({ last: 'King', title: 'TAP training - Transition Day CBT & VA CBT', details: 'Outstanding: Transition Day (CBT) and VA (CBT). tapevents.mil' }),
    task({ last: 'Gablin', title: 'GTC CBT certificate required' }),
  ]);
  assert.deepStrictEqual(tap.members.map(r => [r.last, r.status]),
    [['King', 'Outstanding: Transition Day (CBT) and VA (CBT). tapevents.mil'], ['Long', ''], ['Sousa', '']]);
  assert.strictEqual(tap.note, 'Complete at tapevents.mil > Online Courses > TAP Courses.');
});

// ── Awards and the GTC notes ──────────────────────────────────────────────────────
test('who owes a 1206 comes off the tracker onto the awards slide', () => {
  const a = shape.shapeAwards([
    task({ last: 'Gablin', rank: 'SMSgt', title: 'Submit a 1206 for 3rd Quarter awards', details: 'Due to leadership Sunday of Sep UTA. Use the 1206s in your binder.', urgency: 'info' }),
    task({ last: 'Brown', rank: 'MSgt', title: 'Submit a 1206 for 3rd Quarter awards', details: 'Due to leadership Sunday of Sep UTA. Use the 1206s in your binder.', urgency: 'info' }),
    task({ last: 'Hill', title: "Quarterly Award 1206's" }),
    task({ last: 'Veal', title: 'GTC CBT certificate required' }),
  ]);
  assert.deepStrictEqual(a.members.map(r => r.last), ['Brown', 'Gablin', 'Hill']);
  assert.strictEqual(a.title, 'Submit a 1206 for 3rd Quarter awards', 'the most common title is the heading');
  assert.strictEqual(a.note, 'Due to leadership Sunday of Sep UTA. Use the 1206s in your binder.');
});

test('the travel-card lists carry their shared instruction as a note', () => {
  const g = shape.shapeGtc([
    task({ last: 'Hill', title: 'GTC CBT certificate required', details: "Complete GTC training at defensetravel.dod.mil and place the cert on Chief Cisek's desk." }),
    task({ last: 'Veal', title: 'GTC CBT certificate required', details: "Complete GTC training at defensetravel.dod.mil and place the cert on Chief Cisek's desk." }),
    task({ last: 'Banks', title: 'GTC Statement of Understanding required', details: "Place the SoU on Chief Cisek's desk." }),
  ]);
  assert.deepStrictEqual(g.cbt.map(r => r.last), ['Hill', 'Veal']);
  assert.strictEqual(g.cbtNote, "Complete GTC training at defensetravel.dod.mil and place the cert on Chief Cisek's desk.");
  assert.strictEqual(g.souNote, "Place the SoU on Chief Cisek's desk.");
});

// ── The September 2026 inventory guard ───────────────────────────────────────────
const SEP = {
  cbt: ['CBT: Cyber Awareness = 1 Hr', 'CBT: Force Protection = 1Hr', 'CBT: ARC Flash = 30 Mins',
    'Percipio: Integrated Defense = 1 Hr', 'Percipio: Field Sanitation, Personal Hygiene and Pest Borne Diseases = 45 Mins'],
  medical: ['Medical: PHAQ', 'Medical: HIV Blood Draw', 'Medical: DHA3', 'Medical: MHA', 'Medical: Dental Form Due (12 Month Mark)',
    'Medical: Mil Dental Exam', 'Medical: Mil Dental Exam - 11 Sep @ 1020hrs', 'Dental exam OVERDUE (13+ months)',
    'Medical: Blood Type', 'Medical: Fitness Counseling', 'PT Test - due September 26', 'PT Test - OVERDUE'],
  admin: ['Sign any RUTA / RMP days in AROWS', 'Submit a 1206 for 3rd Quarter awards', 'GTC CBT certificate required',
    'GTC Statement of Understanding required', 'TAP training - all required tasks', 'TAP training - Transition Day CBT & VA CBT',
    'ACA due - MSgt Brown with SMSgt Izzo', 'EPB - SrA Blake - Closeout 31Mar2026 (sitting at MSgt Fernandez G.)',
    'OPB - Maj Ye - Closeout 31May2026 (sitting at Col Balint)', 'DTS voucher 3793MK', 'DTS voucher 36F0OF - needs signature',
    'AROWS order ZG5DT8 - sign & submit'],
  upgrade: ['Upgrade training progress', '7-level UGT - waiting on SSgt to start'],
  upcoming: ['Out-processing - BMT / Tech School dates', 'PT Test - due October 26'],
};

test('every September 2026 title reaches a slide', () => {
  const one = (title, over = {}) => [task({ title, ...over })];
  const count = (o) => Object.values(o).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  const claims = {
    cbt: (t) => { const c = shape.shapeCbts(one(t)); return c.mandatory.length + c.additional.length; },
    medical: (t) => shape.shapeMedical(one(t)).length
      + (p => p.overdue.length + p.scheduled.length + p.buckets.length)(shape.shapePt(one(t, /OVERDUE/.test(t) ? { urgency: 'overdue' } : {}))),
    admin: (t) => {
      const o = shape.shapeOrders(one(t)), e = shape.shapeEpbs(one(t)), g = shape.shapeGtc(one(t));
      return o.dts.length + o.arows.length + o.notices.length + e.overdue.length + e.comingDue.length + e.aca.pairs.length
        + g.sou.length + g.cbt.length + shape.shapeTap(one(t)).members.length + shape.shapeAwards(one(t)).members.length;
    },
    upgrade: (t) => count(shape.shapeUpgrade(one(t))),
    upcoming: (t) => { const io = shape.shapeInbound(one(t)); return io.bmt.length + io.pme.length
      + shape.shapePt(one(t)).buckets.length; },
  };
  const unrouted = [];
  for (const [cat, titles] of Object.entries(SEP)) for (const t of titles) if (!claims[cat](t)) unrouted.push(`${cat}: ${t}`);
  assert.deepStrictEqual(unrouted, [], 'a title nobody claims prints nowhere, and nobody notices');
});
