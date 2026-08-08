// Builds the CES Drill Roster workbook — the file the admin who enters drill pay
// already works from. The layout, wording, fonts, fills, column widths and the
// period-cell dropdown are all copied from his August 2026 sheet, so what comes
// out of the app drops straight into his existing process rather than asking him
// to change it.
//
// One sheet per shop. Everything above the header row is his attendance key,
// verbatim including its own punctuation.

const ExcelJS = require('exceljs');
const att = require('./attendance');

const FONT = 'Times New Roman';

// Sheet names are his, not ours: the workbook says WFMS where the squadron says
// WFSM, "Heavy " carries a trailing space, and EA is spelled out. Renaming them
// to match the app would be tidier and would break his lookups.
const SHEET_FOR_SHOP = {
  'C2': 'C2',
  'WFSM': 'WFMS',
  'HVAC': 'HVAC',
  'Electrical': 'Electrical',
  'Power Pro': 'Power Pro',
  'Heavy Equipment': 'Heavy ',
  'Structures': 'Structures',
  'Operations': 'OPS',
  'EA': 'Engineering',
  'EM': 'EM',
};
// Sheet order in his workbook, which is not alphabetical.
const SHEET_ORDER = ['C2', 'WFMS', 'HVAC', 'Electrical', 'Power Pro', 'Heavy ',
                     'Structures', 'OPS', 'Engineering', 'UTM', 'EM'];

// The training manager sits in C2 in the app but has his own sheet here.
const UTM_POSITION = 'Unit Training Manager';

const KEY_LINES = [
  'Attendance Key: ',
  'X : Constructively Present (on orders, AGR, etc) ',
  'R : Rescheduled Drill',
  '/ : Present ',
  'A : Absent (AWOL)',
  'P: Maternity Leave',
  'T : Transfer',
  'S : Separated/ Retired',
  'Q : Equivalent Training (Points only!)',
];

// The dropdown offered on every period cell. His list, including the "P" it
// omits and the "Retirenment" spelling — an export that "fixes" either would no
// longer match what he validates against.
const DROPDOWN = [
  '/ - Present in Formation',
  'R - Rescheduled Drill',
  'A - Absent',
  'S - Separation/Retirenment',
  'X - Constructively Present (AGR)',
  'T - Transfer',
  'Q - Equivalent Training (POINTS ONLY)',
].join(', ');

const THIN = { style: 'thin' };
const ALL_BORDERS = { top: THIN, left: THIN, bottom: THIN, right: THIN };

// "LAST, FIRST M" — surname upper-cased, as his sheet has it.
function rosterName(m) {
  const last = String(m.last_name || '').toUpperCase();
  const first = String(m.first_name || '').toUpperCase();
  const mi = m.middle_initial ? ` ${String(m.middle_initial).toUpperCase()}` : '';
  return `${last}, ${first}${mi}`.trim();
}

// Rank order for listing a shop, senior first.
const RANK_ORDER = ['Brig Gen', 'Col', 'Lt Col', 'Maj', 'Capt', '1Lt', '2Lt',
  'CMSgt', 'SMSgt', 'MSgt', 'TSgt', 'SSgt', 'SrA', 'A1C', 'Amn', 'AB'];
const rankIndex = (r) => {
  const i = RANK_ORDER.indexOf(String(r || '').trim());
  return i === -1 ? RANK_ORDER.length : i;
};

// Group a shop's members the way the sheet does: the shop lead alone, then
// everyone else. His file splits the remainder again by crew; the app does not
// record who reports to whom, so that split is the one thing not reproduced.
function groupsFor(members) {
  const lead = members.find(m => /NCOIC|Superintendent|Chief|Commander/i.test(m.position || ''));
  const rest = members.filter(m => m !== lead)
    .sort((a, b) => rankIndex(a.rank) - rankIndex(b.rank)
      || String(a.last_name).localeCompare(String(b.last_name)));
  return lead ? [[lead], rest] : [rest];
}

function sheetFor(member) {
  if (String(member.position || '') === UTM_POSITION) return 'UTM';
  return SHEET_FOR_SHOP[member.shop] || member.shop || 'Unassigned';
}

/**
 * @param {object} cycle    { name, start_date, end_date, period_count }
 * @param {Array}  members  { id, rank, first_name, last_name, position, shop }
 * @param {Array}  rows     attendance { member_id, period, status }
 * @returns {Promise<Buffer>}
 */
async function buildDrillRoster(cycle, members, rows) {
  const periods = att.periodLabels(cycle && cycle.start_date, att.periodCountFor(cycle));
  const statusOf = new Map();
  for (const r of rows || []) statusOf.set(`${r.member_id}:${r.period}`, r.status);

  const bySheet = new Map(SHEET_ORDER.map(n => [n, []]));
  for (const m of members) {
    const name = sheetFor(m);
    if (!bySheet.has(name)) bySheet.set(name, []);
    bySheet.get(name).push(m);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = '108 CES Task Tracker';
  wb.created = new Date();

  for (const sheetName of bySheet.keys()) {
    const roster = bySheet.get(sheetName);
    if (!roster.length) continue;                 // no empty sheets for a shop nobody is in
    const ws = wb.addWorksheet(sheetName);

    ws.columns = [
      { width: 38.4 }, { width: 5.6 },
      ...periods.map((_, i) => ({ width: [24.4, 24.6, 27.4, 24.6][i] ?? 24.6 })),
    ];

    // ── Key block (rows 1–9) ──────────────────────────────────────────────
    KEY_LINES.forEach((text, i) => {
      const cell = ws.getCell(i + 1, 1);
      cell.value = text;
      cell.font = { name: FONT, size: 10, bold: true };
      cell.border = i === 0 ? { left: THIN, top: THIN } : { left: THIN };
      ws.getRow(i + 1).height = i === 0 ? 17.1 : 12.95;
    });

    // Shop banner, merged across the period columns.
    const lastCol = 2 + periods.length;
    ws.mergeCells(1, 3, 1, lastCol);
    ws.mergeCells(2, 3, 5, lastCol);
    const banner = ws.getCell(2, 3);
    banner.value = sheetName.trim().toUpperCase();
    banner.font = { name: FONT, size: 20, bold: true };
    banner.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

    // ── Header row (row 11) ───────────────────────────────────────────────
    const head = ws.getRow(11);
    head.height = 27.95;
    const headCells = ['Name', 'Grade',
      ...periods.map(p => `${p.label}\n${p.time}`)];
    headCells.forEach((text, i) => {
      const cell = head.getCell(i + 1);
      cell.value = text;
      cell.font = { name: FONT, size: i < 2 ? 11 : 10, bold: true, color: { argb: 'FF3F3F3F' } };
      cell.border = ALL_BORDERS;
      cell.alignment = i < 2 ? { wrapText: false } : { horizontal: 'center', wrapText: true };
      if (i >= 2) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA9D3EB' } };
      }
    });

    // ── Roster (row 12 onward) ────────────────────────────────────────────
    let r = 12;
    const groups = groupsFor(roster);
    groups.forEach((group, gi) => {
      if (gi > 0) { ws.getRow(r).height = 11.1; r += 1; }   // separator, as his sheet has
      for (const m of group) {
        const row = ws.getRow(r);
        row.height = 18;

        const name = row.getCell(1);
        name.value = rosterName(m);
        name.font = { name: FONT, size: 10.5 };
        name.border = ALL_BORDERS;
        name.alignment = { wrapText: true };

        const grade = row.getCell(2);
        grade.value = att.gradeFor(m.rank);
        grade.font = { name: FONT, size: 10, bold: true };
        grade.border = ALL_BORDERS;
        grade.alignment = { horizontal: 'center' };
        grade.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };

        periods.forEach((p, i) => {
          const cell = row.getCell(3 + i);
          // An unmarked period is left blank rather than defaulted to present —
          // a blank cell reads as "nobody marked this", which is the truth.
          cell.value = att.sheetTextFor(statusOf.get(`${m.id}:${p.period}`)) || '';
          cell.font = { name: FONT, size: 10, bold: true };
          cell.border = ALL_BORDERS;
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
        });
        r += 1;
      }
    });

    const lastRow = r - 1;
    if (lastRow >= 12) {
      ws.dataValidations.add(`C12:${ws.getColumn(lastCol).letter}${lastRow}`, {
        type: 'list', allowBlank: true, formulae: [`"${DROPDOWN}"`],
      });
    }
    ws.views = [{ state: 'frozen', ySplit: 11 }];
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildDrillRoster, SHEET_FOR_SHOP, SHEET_ORDER, rosterName, groupsFor };
