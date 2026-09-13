// public/promotion-package.js — Resources → Calculators → Promotion → Package Checklist.
//
// The FSS Promotion Package Checklist, transcribed from the FSS slide (Sep 2026),
// rendered live instead of photographed: eligibility gates, the package in the
// order FSS wants it, each item's sub-checks, and — the reason it lives here
// rather than as a PDF — a link straight to the blank form once one is uploaded
// under Resources → Forms. Items that are pulled from a system (MyFitness, vMPF)
// link to that system instead.
//
// Two globals: window.promoPackageInit() draws the section into #promo-pkg
// the first time the Promotion tab opens; window.PromoPackage carries the data
// and the matcher for the printable page and the tests. Written UMD-style so
// test/promotion-package.test.js can require() the same file the browser runs.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PromoPackage = factory();
}(typeof window !== 'undefined' ? window : this, function () {

  const REQUIREMENTS = [
    { key: 'tis', label: 'Time in Service (TIS)' },
    { key: 'tig', label: 'Time in Grade (TIG)' },
    { key: 'pme', label: 'PME complete' },
    { key: 'edu', label: 'Civilian education', note: 'SMSgt / CMSgt only' },
  ];

  // `match` is tested against uploaded document titles, case-insensitively.
  // `pull` items come from a system rather than a blank form; `href` is where.
  const ITEMS = [
    { n: 1,  key: 'cover',   title: 'Cover sheet',
      match: /cover\s*sheet/i, checks: [] },
    { n: 2,  key: 'imt002',  title: 'IMT 002',
      match: /\bIMT\s*0*02\b/i,
      checks: ['Correct information', 'All signatures uniformed', 'All boxes checked'] },
    { n: 3,  key: 'imt004',  title: 'IMT 004',
      match: /\bIMT\s*0*04\b/i,
      checks: ['Correct form used (no commas)', 'Form filled out correctly', 'Supervisor signed'] },
    { n: 4,  key: 'imt006',  title: 'Promotion Documentation Review', sub: 'IMT 006 / 007',
      match: /\bIMT\s*0*0[67]\b|documentation\s*review/i,
      checks: ['Signed by supervisor', 'Correctly calculated'] },
    { n: 5,  key: 'adverse', title: 'Adverse Memo',
      match: /adverse\s*memo/i,
      checks: ['Format correct', 'Signed by GP/CC'] },
    { n: 6,  key: 'fitness', title: 'Fitness Report', sub: 'MyFitness',
      pull: 'MyFitness', href: 'https://myfitness.af.mil/',
      checks: ['Current: within 30 days beyond the board', 'Passing'] },
    { n: 7,  key: 'epb',     title: 'EPB',
      pull: 'myEval / vMPF', href: 'https://vmpf.us.af.mil/vMPFNet40/Hub.aspx',
      checks: ['Closeout correct', 'Projected on vMPF RIP'] },
    { n: 8,  key: 'rip',     title: 'vMPF RIP',
      pull: 'vMPF', href: 'https://vmpf.us.af.mil/vMPFNet40/Hub.aspx',
      checks: ['Current: within 60 days of the board'] },
    { n: 9,  key: 'sou',     title: 'Retraining SOU',
      match: /retraining|\bSOU\b/i, checks: [] },
    { n: 10, key: 'ngb1212', title: 'NGB 1212', sub: 'MSgt and above',
      match: /\bNGB\s*1212\b/i, checks: [] },
    { n: 11, key: 'query',   title: 'Adverse information query', sub: 'Excel',
      match: /adverse\s*info/i, checks: [] },
  ];

  // The FSS-side block at the foot of the sheet. Kept for the printable page;
  // the app has no CSS users, so it is not rendered in Resources.
  const TRACKER = [
    'Corrections sent to CSS on:',
    'Corrections required to be submitted by:',
    'Package complete and ready for review',
  ];

  // Pair each form item with the first uploaded document whose title matches.
  // Pull items never match a document. Returns a new array; the source data
  // is never mutated, so a re-render after an upload starts clean.
  function matchDocuments(items, docs) {
    const list = Array.isArray(docs) ? docs : [];
    return items.map(it => {
      if (it.pull || !it.match) return { ...it, doc: null };
      const doc = list.find(d => d && it.match.test(String(d.title || ''))) || null;
      return { ...it, doc };
    });
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const EXT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3H3v10h10v-3"/><path d="M9.5 2.5H13.5V6.5"/><path d="M13.5 2.5L7.5 8.5"/></svg>';

  function itemActionHTML(it) {
    if (it.pull) {
      return `<a class="pp-act pp-act-pull" href="${esc(it.href)}" target="_blank" rel="noopener noreferrer">${esc(it.pull)}${EXT}</a>`;
    }
    if (it.doc) {
      return `<a class="pp-act pp-act-open" href="/api/documents/${it.doc.id}/file" target="_blank" rel="noopener">Open form</a>`;
    }
    return `<span class="pp-act pp-act-missing" title="Upload it under Resources → Forms and it links here">Not uploaded yet</span>`;
  }

  function sectionHTML(items) {
    const reqs = REQUIREMENTS.map(r =>
      `<li class="pp-req"><span class="pp-circle" aria-hidden="true"></span>${esc(r.label)}${r.note ? ` <span class="pf-of">· ${esc(r.note)}</span>` : ''}</li>`
    ).join('');
    const rows = items.map(it => `
      <li class="pp-item">
        <span class="pp-n" aria-hidden="true">${it.n}</span>
        <div class="pp-body">
          <div class="pp-head">
            <span class="pp-title">${esc(it.title)}${it.sub ? ` <span class="pf-of">· ${esc(it.sub)}</span>` : ''}</span>
            ${itemActionHTML(it)}
          </div>
          ${it.checks.length ? `<ul class="pp-checks">${it.checks.map(c =>
            `<li><span class="pp-circle sm" aria-hidden="true"></span>${esc(c)}</li>`).join('')}</ul>` : ''}
        </div>
      </li>`).join('');
    const uploaded = items.filter(it => it.doc).length;
    const forms = items.filter(it => !it.pull).length;
    return `
      <section class="pf-card pp-card">
        <div class="pf-cardhead">
          <h3 class="pf-microlabel">Promotion Package Checklist</h3>
          <span class="pf-of">${uploaded} of ${forms} forms posted</span>
        </div>
        <div class="pp-intro">What FSS expects in your package, in the order they want it. Blank forms open
          from here once they are posted under Resources → Forms; the rest come from the system named.</div>

        <div class="pf-microlabel pp-sub">Requirements to be promoted</div>
        <ul class="pp-reqs">${reqs}</ul>

        <div class="pf-microlabel pp-sub">Package order</div>
        <ol class="pp-items">${rows}</ol>

        <div class="pp-foot">
          <a class="add-btn" href="/promotion-checklist.html" target="_blank" rel="noopener">Print blank checklist</a>
          <span class="pf-hint">Source: FSS Promotion Package Checklist. Questions on a specific item go to your supervisor, then FSS.</span>
        </div>
      </section>`;
  }

  // Printable page body: the sheet as FSS lays it out, circles left blank,
  // built from the same cards, badges and microlabels the app uses so a
  // printed copy reads as the tracker's, not a photocopy of the slide.
  function printableHTML() {
    const circle = (sm) => `<span class="pc-circle${sm ? ' sm' : ''}" aria-hidden="true"></span>`;
    const sub = (t) => t ? ` <span class="pc-sub">· ${esc(t)}</span>` : '';
    const reqs = REQUIREMENTS.map(r =>
      `<li class="pc-row">${circle()}<span>${esc(r.label)}${sub(r.note)}</span></li>`).join('');
    const items = ITEMS.map(it => `
      <li class="pc-item">
        <span class="pc-n" aria-hidden="true">${it.n}</span>
        <div class="pc-body">
          <div class="pc-title">${circle()}<span>${esc(it.title)}${sub(it.sub)}</span></div>
          ${it.checks.length ? `<ul class="pc-checks">${it.checks.map(c =>
            `<li>${circle(true)}${esc(c)}</li>`).join('')}</ul>` : ''}
        </div>
      </li>`).join('');
    const order = ITEMS.map(it =>
      `<li class="pc-order"><span class="pc-n" aria-hidden="true">${it.n}</span><span>${esc(it.title)}${sub(it.sub)}</span></li>`).join('');
    const tracker = TRACKER.map(t => `<li class="pc-row">${circle()}<span>${esc(t)}</span></li>`).join('');
    return `
      <div class="pc-grid">
        <div class="pc-col">
          <section class="pc-card">
            <div class="pc-microlabel">Member</div>
            <div class="pc-field"><span class="pc-field-lbl">Member's Rank / Name</span><span class="pc-blank"></span></div>
            <div class="pc-field"><span class="pc-field-lbl">Member's Supervisor</span><span class="pc-blank"></span></div>
          </section>
          <section class="pc-card">
            <div class="pc-microlabel">Requirements to be promoted</div>
            <ul class="pc-list pc-reqs">${reqs}</ul>
          </section>
          <section class="pc-card">
            <div class="pc-microlabel">Package</div>
            <ol class="pc-list pc-items">${items}</ol>
          </section>
        </div>
        <div class="pc-col">
          <section class="pc-card">
            <div class="pc-microlabel">Package order</div>
            <ol class="pc-list pc-orders">${order}</ol>
          </section>
          <section class="pc-card">
            <div class="pc-microlabel">Pending corrections</div>
            <div class="pc-box"></div>
          </section>
          <section class="pc-card">
            <div class="pc-microlabel">Remarks</div>
            <div class="pc-box"></div>
          </section>
          <section class="pc-card">
            <div class="pc-microlabel">Package tracker</div>
            <ul class="pc-list pc-tracker">${tracker}</ul>
          </section>
        </div>
      </div>`;
  }

  let drawn = false;
  async function init() {
    const host = typeof document !== 'undefined' && document.getElementById('promo-pkg');
    if (!host || drawn) return;
    drawn = true;
    host.innerHTML = sectionHTML(matchDocuments(ITEMS, []));
    try {
      const res = await fetch('/api/documents');
      if (!res.ok) return;                       // the section still stands, just unlinked
      host.innerHTML = sectionHTML(matchDocuments(ITEMS, await res.json()));
    } catch (e) { /* offline: leave the unlinked version up */ }
  }
  // A fresh upload on the Forms tab should link through on the next visit.
  function refresh() { drawn = false; return init(); }

  if (typeof window !== 'undefined') {
    window.promoPackageInit = init;
    window.promoPackageRefresh = refresh;
  }

  return { REQUIREMENTS, ITEMS, TRACKER, matchDocuments, sectionHTML, printableHTML };
}));
