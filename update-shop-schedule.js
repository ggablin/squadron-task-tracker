// update-shop-schedule.js — Prints the complete Shop Schedule rows that should
// be in the template, including pre-filled structural events.
// Output: tab-separated rows you can paste into Excel, or use --write to create
// a standalone .xlsx with just the Shop Schedule tab.
//
// Usage:
//   node update-shop-schedule.js                     (prints to console)
//   node update-shop-schedule.js --write output.xlsx  (writes xlsx)

const XLSX = require('xlsx');
const path = require('path');

const STRUCTURAL_ROWS = [
  // Friday
  { Shop:'ALL', Day:'Friday', 'Start Time':'0700', 'End Time':'0800', Title:"Supervisor's Meeting", Details:'Safety briefing · TBA training', Type:'Schedule', Kind:'meeting', Emphasis:'' },
  { Shop:'ALL', Day:'Friday', 'Start Time':'0800', 'End Time':'0830', Title:'Formation · Roll Call', Details:'Everyone report', Type:'Schedule', Kind:'formation', Emphasis:'' },
  { Shop:'ALL', Day:'Friday', 'Start Time':'0830', 'End Time':'1100', Title:'Admin / In-House Training', Details:'Medical · CBTs · vRED · SGLI · EPBs · UGT · Work Orders · JSTO · Form 55s · PT Testing', Type:'Schedule', Kind:'training', Emphasis:'' },
  { Shop:'ALL', Day:'Friday', 'Start Time':'1100', 'End Time':'1300', Title:'Lunch', Details:'', Type:'Schedule', Kind:'lunch', Emphasis:'' },
  { Shop:'ALL', Day:'Friday', 'Start Time':'1300', 'End Time':'1500', Title:'Work Orders · Shop Training · Admin', Details:'All things work order related · Shop training · Admin items · SrA EPBs', Type:'Schedule', Kind:'work', Emphasis:'' },
  { Shop:'ALL', Day:'Friday', 'Start Time':'1500', 'End Time':'1600', Title:'Formation', Details:'End of day', Type:'Schedule', Kind:'formation', Emphasis:'' },

  // Saturday
  { Shop:'ALL', Day:'Saturday', 'Start Time':'0800', 'End Time':'0830', Title:'Formation · Roll Call', Details:'Everyone report', Type:'Schedule', Kind:'formation', Emphasis:'' },
  { Shop:'ALL', Day:'Saturday', 'Start Time':'1100', 'End Time':'1300', Title:'Lunch', Details:'', Type:'Schedule', Kind:'lunch', Emphasis:'' },
  { Shop:'ALL', Day:'Saturday', 'Start Time':'1600', 'End Time':'', Title:'Formation', Details:'End of day', Type:'Schedule', Kind:'formation', Emphasis:'' },

  // Sunday
  { Shop:'ALL', Day:'Sunday', 'Start Time':'0800', 'End Time':'0830', Title:'Formation · Roll Call', Details:'Everyone report', Type:'Schedule', Kind:'formation', Emphasis:'' },
  { Shop:'ALL', Day:'Sunday', 'Start Time':'1100', 'End Time':'1300', Title:'Lunch', Details:'', Type:'Schedule', Kind:'lunch', Emphasis:'' },
  { Shop:'ALL', Day:'Sunday', 'Start Time':'1500', 'End Time':'', Title:'Formation', Details:'End of UTA', Type:'Schedule', Kind:'formation', Emphasis:'' },
];

// Read existing Shop Schedule rows from the template
const templatePath = path.join(__dirname, '..', 'May 2026 UTA - Sample Template.xlsx');
let existingRows = [];
try {
  const wb = XLSX.readFile(templatePath);
  if (wb.SheetNames.includes('Shop Schedule')) {
    existingRows = XLSX.utils.sheet_to_json(wb.Sheets['Shop Schedule'], { defval: '' });
  }
} catch (e) {
  console.warn('Could not read template:', e.message);
}

// Add Kind and Emphasis columns to existing rows (default empty)
const normalizedExisting = existingRows.map(r => ({
  Shop: String(r.Shop || '').trim(),
  Day: String(r.Day || '').trim(),
  'Start Time': String(r['Start Time'] || '').trim(),
  'End Time': String(r['End Time'] || '').trim(),
  Title: String(r.Title || r.title || '').trim(),
  Details: String(r.Details || r.details || '').trim(),
  Type: String(r.Type || r.type || '').trim(),
  Kind: String(r.Kind || r.kind || '').trim(),
  Emphasis: String(r.Emphasis || r.emphasis || '').trim(),
}));

// Merge: structural rows first, then existing rows that aren't duplicates
function rowKey(r) {
  return `${r.Day}|${r['Start Time']}|${r['End Time']}|${r.Title}`.toLowerCase();
}

const structuralKeys = new Set(STRUCTURAL_ROWS.map(rowKey));
const uniqueExisting = normalizedExisting.filter(r => !structuralKeys.has(rowKey(r)));

// Also fill in Kind for known existing rows
for (const r of uniqueExisting) {
  if (!r.Kind) {
    const title = r.Title.toLowerCase();
    if (title.includes('health risk') || title.includes('medical') || title.includes('dental')) r.Kind = 'medical';
    else if (title.includes('cpr') || title.includes('training')) r.Kind = 'training';
    else if (title.includes('cleanup') || title.includes('work order')) r.Kind = 'work';
    else if (title.includes('recognition') || title.includes('recap')) r.Kind = 'briefing';
    else if (title.includes('lautenberg') || title.includes('family care')) r.Kind = 'briefing';
    else if (title.includes('meeting') || title.includes('how goes it')) r.Kind = 'meeting';
    else if (title.includes('safety binder')) r.Kind = 'admin';
  }
}

// Also add missing events from the hardcoded timeline that weren't in the template
const EXTRA_EVENTS = [
  { Shop:'ALL', Day:'Saturday', 'Start Time':'0830', 'End Time':'1100', Title:'Admin / In-House Training', Details:'Medical · CBTs · vRED · SGLI · EPBs · UGT · Form 55s · PT Testing', Type:'Schedule', Kind:'training', Emphasis:'' },
  { Shop:'ALL', Day:'Saturday', 'Start Time':'1300', 'End Time':'', Title:'Morale Committee Meeting', Details:'Conference Room', Type:'Schedule', Kind:'meeting', Emphasis:'' },
  { Shop:'ALL', Day:'Saturday', 'Start Time':'1400', 'End Time':'1600', Title:'Work Orders · Shop Training · Admin', Details:'All things work order related · Shop training · Admin items · SrA EPBs', Type:'Schedule', Kind:'work', Emphasis:'' },
  { Shop:'ALL', Day:'Sunday', 'Start Time':'0830', 'End Time':'1100', Title:'Supervisors: Finish Safety Binders', Details:'Turn in to SSgt Huertas', Type:'Schedule', Kind:'admin', Emphasis:'' },
  { Shop:'ALL', Day:'Sunday', 'Start Time':'0830', 'End Time':'1100', Title:'Admin / In-House Training', Details:'For everyone else', Type:'Schedule', Kind:'training', Emphasis:'' },
  { Shop:'ALL', Day:'Sunday', 'Start Time':'1300', 'End Time':'', Title:'How Goes It Meeting', Details:'Leadership', Type:'Schedule', Kind:'meeting', Emphasis:'' },
];

const allKeys = new Set([...structuralKeys, ...uniqueExisting.map(rowKey)]);
const extraToAdd = EXTRA_EVENTS.filter(r => !allKeys.has(rowKey(r)));

// Also handle the Emphasis row — convert it to the emphasis field on the training row
const emphasisRow = normalizedExisting.find(r => r.Type.toLowerCase() === 'emphasis');
if (emphasisRow) {
  // Find the matching training row and set its emphasis
  const target = STRUCTURAL_ROWS.find(r =>
    r.Day === emphasisRow.Day && r.Title.toLowerCase().includes(emphasisRow.Title.toLowerCase().split('/')[0].trim().toLowerCase())
  );
  if (target) {
    target.Emphasis = emphasisRow.Details || emphasisRow.Title;
  }
}

// Filter out existing rows that are clearly covered by a structural row with a different title
const coveredTitles = new Set([
  "supervisor's meeting / safety / tba training", // covered by "Supervisor's Meeting" structural row
]);
const allRows = [
  ...STRUCTURAL_ROWS,
  ...extraToAdd,
  ...uniqueExisting.filter(r =>
    r.Type.toLowerCase() !== 'emphasis'
    && !coveredTitles.has(r.Title.toLowerCase())
  ),
];

// Sort by day, start_time
const dayOrd = { Friday: 1, Saturday: 2, Sunday: 3 };
allRows.sort((a, b) =>
  (dayOrd[a.Day] || 9) - (dayOrd[b.Day] || 9)
  || (a['Start Time'] || 'zz').localeCompare(b['Start Time'] || 'zz')
);

const COLS = ['Shop', 'Day', 'Start Time', 'End Time', 'Title', 'Details', 'Type', 'Kind', 'Emphasis'];

if (process.argv.includes('--write')) {
  const outPath = process.argv[process.argv.indexOf('--write') + 1] || 'Shop-Schedule-Updated.xlsx';
  const ws = XLSX.utils.json_to_sheet(allRows, { header: COLS });

  // Set column widths
  ws['!cols'] = [
    { wch: 16 }, // Shop
    { wch: 10 }, // Day
    { wch: 12 }, // Start Time
    { wch: 12 }, // End Time
    { wch: 45 }, // Title
    { wch: 60 }, // Details
    { wch: 10 }, // Type
    { wch: 12 }, // Kind
    { wch: 40 }, // Emphasis
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Shop Schedule');
  XLSX.writeFile(wb, outPath);
  console.log(`✅ Written ${allRows.length} rows to ${outPath}`);
} else {
  console.log(COLS.join('\t'));
  console.log('─'.repeat(120));
  for (const r of allRows) {
    console.log(COLS.map(c => r[c] || '').join('\t'));
  }
  console.log(`\n${allRows.length} total rows`);
}
