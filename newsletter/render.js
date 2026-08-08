// newsletter/render.js — assembles the full newsletter HTML.
//
// Section order mirrors the August 2026 RSD newsletter page for page, so anyone
// used to the PDF finds the same thing in the same place. Live sections are built
// from Postgres; the rest are editable partials in static/, because the squadron
// keeps that content by hand and the tracker has no field for it.

const fs = require('fs');
const path = require('path');
const S = require('./slides');
const { STYLES } = require('./theme');

const STATIC_DIR = path.join(__dirname, 'static');

const STATIC_SLIDES = {
  safety:     { file: 'safety.html',            eyebrow: 'Safety',   title: 'Monthly Safety Review' },
  additional: { file: 'additional-duties.html', eyebrow: 'Squadron', title: 'Additional Duties List' },
  awards:     { file: 'awards.html',            eyebrow: 'Squadron', title: 'CE / Wing Quarterly Awards' },
  meetsRadr:  { file: 'meets-radr.html',        eyebrow: 'Training', title: 'MEETs / RADR / Silver Flag' },
  addlTrain:  { file: 'additional-training.html', eyebrow: 'Training', title: 'Additional Training — AFI 10-210' },
  measure:    { file: 'measurements.html',      eyebrow: 'Fitness',  title: 'Height / Waist / Weight' },
  dental:     { file: 'dental-buckets.html',    eyebrow: 'Medical',  title: 'Dental Status' },
  rsd:        { file: 'rsd-schedule.html',      eyebrow: 'Calendar', title: 'RSD Schedule — CY 2026' },
};

function staticSlide(key) {
  const def = STATIC_SLIDES[key];
  let body;
  try {
    body = fs.readFileSync(path.join(STATIC_DIR, def.file), 'utf8');
  } catch {
    body = `<p class="empty">Maintained by hand — edit <code>newsletter/static/${def.file}</code> to populate this page.</p>`;
  }
  return S.staticSlide(def.eyebrow, def.title, body);
}

// The deck, in reference order. Each entry is a thunk so beginDeck() can count
// pages before any of them run.
function sections(data) {
  return [
    () => S.cover(data),                          //  1  Cover
    () => S.orgSlide('Infrastructure', data),     //  2  ORG — Infrastructure
    () => S.orgSlide('Construction', data),       //  3  ORG — Construction
    () => S.orgSlide('R&O', data),                //  4  ORG — R&O
    () => S.orgSlide('EM', data),                 //  5  ORG — EM
    () => S.timeline(data),                       //  6  UTA Timeline
    () => staticSlide('safety'),                  //  7  Monthly Safety
    () => S.workSchedule(data),                   //  8  UTA Work Schedule
    () => staticSlide('additional'),              //  9  Additional Duties
    () => staticSlide('awards'),                  // 10  Quarterly Awards
    () => staticSlide('meetsRadr'),               // 11  MEETs / RADR / Silver Flag
    () => S.cbts(data),                           // 12  CBTs
    () => staticSlide('addlTrain'),               // 13  Additional Training (AFI 10-210) — no field in the tracker
    () => S.orders(data),                         // 14  Orders / DTS / AROWS
    () => S.sgliVred(data),                       // 15  SGLI & vRED  (ref p15: the other admin page)
    () => S.epbs(data),                           // 16  EPBs / OPBs
    () => S.medical(data),                        // 17  Medical & Dental
    () => staticSlide('dental'),                  // 18  Dental Status
    () => S.pt(data),                             // 19  PT Testing
    () => staticSlide('measure'),                 // 20  Height / Waist / Weight — no field in the tracker
    () => S.inbound(data),                        // 21  Inbound / Outbound Airmen
    () => S.upgrade(data),                        // 22  Upgrade Training
    () => staticSlide('rsd'),                     // 23  RSD Schedule CY 2026
  ];
}

function renderNewsletter(data) {
  const list = sections(data);
  S.beginDeck(list.length, data.cover.title);
  const slides = list.map(fn => fn()).filter(Boolean).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${S.esc(data.cover.title)} — 108 CES Newsletter</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLES}</style>
</head><body>
<div class="toolbar no-print">
  <strong>108 CES — ${S.esc(data.cover.title)}</strong>
  <button onclick="window.print()">Print / Save as PDF</button>
  <span class="hint">Choose <b>Landscape</b>, paper <b>Letter</b>, and set margins to <b>None</b>.</span>
</div>
<div class="deck">${slides}</div>
</body></html>`;
}

module.exports = { renderNewsletter, sections };
