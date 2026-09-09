// newsletter/render.js — assembles the full newsletter HTML.
//
// Section order mirrors the August 2026 RSD newsletter page for page, so anyone
// used to the PDF finds the same thing in the same place. Live sections are built
// from Postgres; five remaining partials in static/ are editable by hand, because
// the tracker has no field for them yet. (Additional Training went live in
// September 2026: it is the Percipio half of the CBT category.)

const fs = require('fs');
const path = require('path');
const S = require('./slides');
const { STYLES } = require('./theme');

const STATIC_DIR = path.join(__dirname, 'static');

const STATIC_SLIDES = {
  safety:     { file: 'safety.html',            eyebrow: 'Safety',   title: 'Monthly Safety Review' },
  awards:     { file: 'awards.html',            eyebrow: 'Squadron', title: 'CE / Wing Quarterly Awards' },
  meetsRadr:  { file: 'meets-radr.html',        eyebrow: 'Training', title: 'MEETs / RADR / Silver Flag' },
  measure:    { file: 'measurements.html',      eyebrow: 'Fitness',  title: 'Height / Waist / Weight' },
  dental:     { file: 'dental-buckets.html',    eyebrow: 'Medical',  title: 'Dental Status' },
};

function partial(key) {
  const def = STATIC_SLIDES[key];
  try {
    return fs.readFileSync(path.join(STATIC_DIR, def.file), 'utf8');
  } catch {
    return `<p class="empty">Maintained by hand — edit <code>newsletter/static/${def.file}</code> to populate this page.</p>`;
  }
}

// Sparse partials set larger type (roomy) rather than leaving half a page white.
const ROOMY = new Set(['awards', 'meetsRadr', 'measure', 'dental']);
function staticSlide(key) {
  const def = STATIC_SLIDES[key];
  return S.staticSlide(def.eyebrow, def.title, partial(key), ROOMY.has(key) ? 'roomy' : '');
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
    () => S.additionalDuties(data),               //  9  Additional Duties
    () => S.awards(data, partial('awards')),      // 10  Quarterly Awards — prose by hand, the 1206 list live
    () => staticSlide('meetsRadr'),               // 11  MEETs / RADR / Silver Flag
    () => S.cbts(data),                           // 12  CBTs
    () => S.additional(data),                     // 13  Additional Training (AFI 10-210) — the Percipio CBTs
    () => S.orders(data),                         // 14  Orders / DTS / AROWS
    () => S.gtc(data),                            // 15  Government Travel Card (ref p15)
    () => S.epbs(data),                           // 16  EPBs / OPBs
    () => S.medical(data),                        // 17  Medical & Dental
    () => staticSlide('dental'),                  // 18  Dental Status
    () => S.pt(data),                             // 19  PT Testing
    () => staticSlide('measure'),                 // 20  Height / Waist / Weight — no field in the tracker
    () => S.inbound(data),                        // 21  Inbound / Outbound Airmen
    () => S.upgrade(data),                        // 22  Upgrade Training
    () => S.rsdSchedule(data),                    // 23  RSD Schedule
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
  <button class="back" onclick="location.href='/?view=leadership'">&larr; Tracker</button>
  <strong>108 CES — ${S.esc(data.cover.title)}</strong>
  <button onclick="window.print()">Print / Save as PDF</button>
  <span class="hint">Choose <b>Landscape</b>, paper <b>Letter</b>, and set margins to <b>None</b>.</span>
</div>
<div class="deck">${slides}</div>
</body></html>`;
}

module.exports = { renderNewsletter, sections };
