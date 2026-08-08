// The drill roster workbook has to land on the pay admin's desk in the shape he
// already works from — same sheets, same key block, same header wording, same
// dropdown, same cell text. These assertions are transcribed from his August 2026
// file; if one fails, the export has drifted from the thing it has to match.

const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const att = require('../lib/attendance');
const { buildDrillRoster, rosterName, groupsFor } = require('../lib/drill-roster');

const CYCLE = { name: 'August 2026 UTA', start_date: '2026-08-08', end_date: '2026-08-09', period_count: 4 };

const MEMBERS = [
  { id: 1, rank: 'SMSgt', first_name: 'Gregory', last_name: 'Gablin', position: 'Structures SNCOIC', shop: 'Structures' },
  { id: 2, rank: 'TSgt',  first_name: 'Jeffrey', last_name: 'Ebbert', position: 'Supervisor', shop: 'Structures' },
  { id: 3, rank: 'SrA',   first_name: 'Paula',   last_name: 'Becerra', position: 'Member', shop: 'Structures' },
  { id: 4, rank: 'MSgt',  first_name: 'John',    last_name: 'Sousa',  position: 'Unit Training Manager', shop: 'C2' },
  { id: 5, rank: 'Lt Col', first_name: 'Nathan', last_name: 'Gorey',  position: 'Commander', shop: 'C2' },
  { id: 6, rank: 'MSgt',  first_name: 'Rose',    last_name: 'Beljour-Sommer', position: 'EA NCOIC', shop: 'EA' },
  { id: 7, rank: 'TSgt',  first_name: 'Roppert', last_name: 'Beltran', position: 'Supervisor', shop: 'WFSM' },
];

const ROWS = [
  { member_id: 1, period: 1, status: 'present' },
  { member_id: 2, period: 1, status: 'agr_at_orders' },
  { member_id: 3, period: 1, status: 'ruta_excused' },
  { member_id: 3, period: 2, status: 'awol' },
  { member_id: 5, period: 1, status: 'maternity' },
];

async function build(members = MEMBERS, rows = ROWS, cycle = CYCLE) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildDrillRoster(cycle, members, rows));
  return wb;
}

test('one sheet per shop, named the way the admin\'s workbook names them', async () => {
  const wb = await build();
  const names = wb.worksheets.map(w => w.name);
  // His spellings, not the squadron's: WFMS not WFSM, Engineering not EA, and
  // "Heavy " carries a trailing space.
  assert.ok(names.includes('WFMS'), 'WFSM must be written WFMS');
  assert.ok(names.includes('Engineering'), 'EA must be written Engineering');
  assert.ok(names.includes('Structures'));
  assert.ok(names.includes('C2'));
  assert.ok(!names.includes('WFSM') && !names.includes('EA'));
});

test('the training manager gets his own sheet, not the C2 one', async () => {
  const wb = await build();
  assert.ok(wb.worksheets.map(w => w.name).includes('UTM'));
  const utm = wb.getWorksheet('UTM');
  assert.strictEqual(utm.getCell('A12').value, 'SOUSA, JOHN');
  const c2Names = [];
  for (let r = 12; r <= 20; r++) {
    const v = wb.getWorksheet('C2').getCell(`A${r}`).value;
    if (v) c2Names.push(v);
  }
  assert.ok(!c2Names.some(n => /SOUSA/.test(n)), 'Sousa must not also appear on C2');
});

test('the attendance key block is reproduced verbatim, punctuation included', async () => {
  const ws = (await build()).getWorksheet('Structures');
  assert.strictEqual(ws.getCell('A1').value, 'Attendance Key: ');
  assert.strictEqual(ws.getCell('A2').value, 'X : Constructively Present (on orders, AGR, etc) ');
  assert.strictEqual(ws.getCell('A3').value, 'R : Rescheduled Drill');
  assert.strictEqual(ws.getCell('A4').value, '/ : Present ');
  assert.strictEqual(ws.getCell('A5').value, 'A : Absent (AWOL)');
  assert.strictEqual(ws.getCell('A6').value, 'P: Maternity Leave');
  assert.strictEqual(ws.getCell('A7').value, 'T : Transfer');
  assert.strictEqual(ws.getCell('A8').value, 'S : Separated/ Retired');
  assert.strictEqual(ws.getCell('A9').value, 'Q : Equivalent Training (Points only!)');
});

test('the header row carries period, date and drill hours', async () => {
  const ws = (await build()).getWorksheet('Structures');
  assert.strictEqual(ws.getCell('A11').value, 'Name');
  assert.strictEqual(ws.getCell('B11').value, 'Grade');
  assert.strictEqual(ws.getCell('C11').value, 'Period 1 (08/08/2026)\n07:00-11:00');
  assert.strictEqual(ws.getCell('D11').value, 'Period 2 (08/08/2026)\n12:00-16:30');
  assert.strictEqual(ws.getCell('E11').value, 'Period 3 (08/09/2026)\n07:00-11:00');
  // The weekend's last period finishes half an hour early.
  assert.strictEqual(ws.getCell('F11').value, 'Period 4 (08/09/2026)\n12:00-16:00');
});

test('names are LAST, FIRST and grades are pay grades, not ranks', async () => {
  const ws = (await build()).getWorksheet('Structures');
  assert.strictEqual(ws.getCell('A12').value, 'GABLIN, GREGORY');
  assert.strictEqual(ws.getCell('B12').value, 'E-8');
  const c2 = (await build()).getWorksheet('C2');
  assert.strictEqual(c2.getCell('B12').value, 'O-5', 'Lt Col is an officer grade');
});

test('each status writes the wording his sheet expects', async () => {
  const ws = (await build()).getWorksheet('Structures');
  const col = {};
  for (let r = 12; r <= 20; r++) {
    const n = ws.getCell(`A${r}`).value;
    if (n) col[n] = { p1: ws.getCell(`C${r}`).value, p2: ws.getCell(`D${r}`).value };
  }
  assert.strictEqual(col['GABLIN, GREGORY'].p1, '/ - Present in Formation');
  assert.strictEqual(col['EBBERT, JEFFREY'].p1, 'X - Constructively Present (AGR)');
  assert.strictEqual(col['BECERRA, PAULA'].p1, 'R - Rescheduled Drill');
  assert.strictEqual(col['BECERRA, PAULA'].p2, 'A - Absent');
  // Unmarked stays blank: an empty cell reads as "nobody marked this", which is
  // the truth. Defaulting it to present would invent attendance.
  assert.strictEqual(col['GABLIN, GREGORY'].p2, '');
});

test('every period cell offers the admin\'s own dropdown', async () => {
  const ws = (await build()).getWorksheet('Structures');
  const dv = ws.dataValidations.model ? ws.dataValidations.model['C12:F14'] : null;
  const found = dv || Object.values(ws.dataValidations.model || {})[0];
  assert.ok(found, 'the period cells must carry a list validation');
  const list = String(found.formulae[0]);
  for (const opt of ['/ - Present in Formation', 'R - Rescheduled Drill', 'A - Absent',
                     'S - Separation/Retirenment', 'X - Constructively Present (AGR)',
                     'T - Transfer', 'Q - Equivalent Training (POINTS ONLY)']) {
    assert.ok(list.includes(opt), `dropdown must offer "${opt}"`);
  }
});

test('the sheet keeps his layout: banner, frozen header, column widths', async () => {
  const ws = (await build()).getWorksheet('Structures');
  assert.strictEqual(ws.getCell('C2').value, 'STRUCTURES');
  assert.strictEqual(ws.views[0].state, 'frozen');
  assert.strictEqual(ws.views[0].ySplit, 11, 'the roster scrolls under the header');
  assert.strictEqual(Math.round(ws.getColumn(1).width * 10) / 10, 38.4);
  assert.strictEqual(Math.round(ws.getColumn(2).width * 10) / 10, 5.6);
});

test('a shop with nobody in it produces no sheet at all', async () => {
  const wb = await build([MEMBERS[0]], []);
  assert.deepStrictEqual(wb.worksheets.map(w => w.name), ['Structures']);
});

test('the shop lead is separated from the rest, as his sheet has it', () => {
  const [lead, rest] = groupsFor(MEMBERS.filter(m => m.shop === 'Structures'));
  assert.deepStrictEqual(lead.map(m => m.last_name), ['Gablin']);
  assert.deepStrictEqual(rest.map(m => m.last_name), ['Ebbert', 'Becerra'], 'senior first');
});

test('rosterName upper-cases the surname and drops nothing', () => {
  assert.strictEqual(rosterName({ last_name: 'Beljour-Sommer', first_name: 'Rose' }),
    'BELJOUR-SOMMER, ROSE');
});

// ── The mapping the whole feature exists for ──────────────────────────────
test('every status maps to the pay code the admin enters', () => {
  const expected = {
    agr_at_orders: 'X', present: '/', ruta_excused: 'R', unexcused: 'R',
    awol: 'A', maternity: 'P', transfer: 'T', separated: 'S', equiv_training: 'Q',
  };
  for (const [status, code] of Object.entries(expected)) {
    assert.strictEqual(att.payCodeFor(status), code, `${status} pays as ${code}`);
  }
  assert.deepStrictEqual(att.STATUSES.slice().sort(), Object.keys(expected).sort(),
    'the app must offer exactly these statuses — no more, no fewer');
});

test('Unexcused and RUTA / Excused are different states that pay the same', () => {
  assert.notStrictEqual(att.statusLabelFor('unexcused'), att.statusLabelFor('ruta_excused'));
  assert.strictEqual(att.payCodeFor('unexcused'), att.payCodeFor('ruta_excused'));
});

test('the statuses that were removed are gone, and map to their replacement', () => {
  for (const old of ['at', 'deployed', 'ruta', 'excused']) {
    assert.strictEqual(att.isValidStatus(old), false, `${old} must no longer be accepted`);
  }
  assert.strictEqual(att.LEGACY_STATUS_MAP.at, 'agr_at_orders');
  assert.strictEqual(att.LEGACY_STATUS_MAP.deployed, 'agr_at_orders');
  assert.strictEqual(att.LEGACY_STATUS_MAP.ruta, 'ruta_excused');
  assert.strictEqual(att.LEGACY_STATUS_MAP.excused, 'ruta_excused');
});

test('periods are labelled by number and date, not by UTA number', () => {
  const labels = att.periodLabels('2026-08-08', 4);
  assert.deepStrictEqual(labels.map(l => l.label), [
    'Period 1 (08/08/2026)', 'Period 2 (08/08/2026)',
    'Period 3 (08/09/2026)', 'Period 4 (08/09/2026)',
  ]);
  // An undated cycle stays markable; it just loses the date.
  assert.strictEqual(att.periodLabels(null, 2)[0].label, 'Period 1');
});
