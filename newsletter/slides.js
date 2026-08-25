// newsletter/slides.js — one function per newsletter slide. Pure (data -> HTML string).
//
// Restyled to the app's design language: the eyebrow + left-aligned title, the
// bordered card, and the urgency badge shapes all come from public/index.html, so
// a member who has used the tracker recognises the newsletter as the same thing.
// Colours and type live in theme.js; this file only decides structure.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const person = (p) => `${esc(p.rank)} ${esc(p.last_name || p.last)}`.trim();

// Slide numbering is assigned at render time so inserting a section can't leave
// the printed footers stale.
let PAGE = 0, TOTAL = 0, CYCLE = '';
function beginDeck(total, cycleName) { PAGE = 0; TOTAL = total; CYCLE = cycleName || ''; }

const BADGE = {
  overdue:  '<span class="badge b-overdue">Overdue</span>',
  this_uta: '<span class="badge b-this">This UTA</span>',
  next_uta: '<span class="badge b-next">Next UTA</span>',
  future:   '<span class="badge b-next">Future</span>',
  info:     '<span class="badge b-info">Info</span>',
};
const URG_CLASS = { overdue: 'overdue', this_uta: 'due-month', next_uta: 'complete', future: 'complete', info: '' };

// Standard slide chrome: eyebrow + title left, meta right, footer with page count.
function chrome(eyebrow, title, body, extraClass = '', right = '') {
  PAGE += 1;
  return `<section class="slide ${extraClass}">
    <header class="slide-hd">
      <div>
        <div class="slide-eyebrow">${esc(eyebrow)}</div>
        <h1 class="slide-title">${esc(title)}</h1>
      </div>
      ${right ? `<div class="slide-hd-right">${right}</div>` : ''}
    </header>
    <div class="slide-body">${body}</div>
    <footer class="slide-ft"><span>108 CES${CYCLE ? ' · ' + esc(CYCLE) : ''}</span><span>${PAGE} / ${TOTAL}</span></footer>
  </section>`;
}

const emptyNote = (what) => `<p class="empty">No ${esc(what)} recorded in the tracker for this UTA.</p>`;

// ── 1. Cover ──────────────────────────────────────────────────────────────
function cover(d) {
  PAGE += 1;
  const s = d.stats || {};
  const stat = (n, l) => `<div class="cover-stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
  const stats = s.members ? `<div class="cover-stats">
      ${stat(s.members, 'Members')}${stat(s.tasks, 'Tasks this UTA')}${stat(s.shops, 'Shops')}
    </div>` : '';
  return `<section class="slide cover">
    <div class="cover-eyebrow">108th Civil Engineer Squadron</div>
    <div class="cover-title">${esc(d.cover.title)}</div>
    <div class="cover-sub">${esc(d.cover.dateRange)}${d.cover.dateRange ? ' · ' : ''}JB McGuire-Dix-Lakehurst</div>
    ${stats}
    <div class="cover-meta">
      <div>Your tasks, your shop and the weekend's schedule — live at<br><span class="cover-url">108ces.up.railway.app</span></div>
      <div>Generated from the Task Tracker${d.generatedAt ? ' · ' + esc(d.generatedAt) : ''}</div>
    </div>
  </section>`;
}

// ── 2–5. Flight ORG charts ────────────────────────────────────────────────
const SHOP_CLASS = {
  'WFSM': 'sh-red', 'HVAC': 'sh-green', 'Electrical': 'sh-gray', 'Power Pro': 'sh-blue',
  'Heavy Equipment': 'sh-orange', 'Structures': 'sh-teal', 'Operations': 'sh-cyan',
  'EA': 'sh-yellow', 'EM': 'sh-purple',
};
function staffBox(p) {
  const cls = { 'Commander': 'b-cmd', 'Chief Enlisted Manager': 'b-chief', 'First Sergeant': 'b-1sg',
    'Admin Support Technician': 'b-admin', 'BCE/Engineering OIC': 'b-oic' }[p.position] || 'b-admin';
  return `<div class="org-box ${cls}"><div class="org-pos">${esc(p.position || '')}</div><div class="org-name">${person(p)}</div></div>`;
}
function orgSlide(flightName, d) {
  const flight = d.org.flights.find(f => f.name === flightName);
  if (!flight) return '';
  const banner = `<div class="org-staff">${d.org.staff.map(staffBox).join('')}</div>`;
  const leaders = flight.leaders.length
    ? `<div class="org-leaders">${flight.leaders.map(p =>
        `<div class="org-box b-supt"><div class="org-pos">${esc(flight.name)} ${esc(p.position)}</div><div class="org-name">${person(p)}</div></div>`).join('')}</div>`
    : '';
  const count = flight.shops.reduce((n, s) => n + s.supervisors.length + s.members.length + (s.ncoic ? 1 : 0), 0);
  const shops = `<div class="org-shops">${flight.shops.map(s => {
    const cls = SHOP_CLASS[s.name] || 'sh-gray';
    const ncoic = s.ncoic ? `<div class="org-box b-ncoic"><div class="org-pos">${esc(s.name)} ${esc(s.ncoic.position)}</div><div class="org-name">${person(s.ncoic)}</div></div>` : '';
    const tile = (p, role) => `<div class="org-tile ${cls}"><div class="org-role">${esc(role)}</div><div class="org-name">${person(p)}</div></div>`;
    const sups = s.supervisors.map(p => tile(p, 'Supervisor')).join('');
    const mems = s.members.map(p => tile(p, 'Member')).join('');
    return `<div class="org-col">${ncoic}<div class="org-tiles">${sups}${mems}</div></div>`;
  }).join('')}</div>`;
  return chrome('Organisation', `${flightName} Flight`, banner + leaders + shops, 'org',
                `${count} assigned`);
}

// ── 6. UTA Timeline ───────────────────────────────────────────────────────
function timeline(d) {
  if (!d.timeline.length) return chrome('Schedule', 'UTA Timeline', emptyNote('schedule events'));
  const body = d.timeline.map(day => {
    const rows = day.events.map(e => {
      const time = e.start ? `${esc(e.start)}${e.end ? '–' + esc(e.end) : ''}` : (e.type === 'emphasis' ? 'Emphasis' : '');
      const who = e.shop && e.shop !== 'ALL' ? ` <span class="tl-shop">${esc(e.shop)}</span>` : '';
      const det = e.details ? `<div class="p-note">${esc(e.details)}</div>` : '';
      return `<div class="tl-row ${e.type === 'emphasis' ? 'tl-emph' : ''}">
        <div class="tl-time">${time}</div>
        <div class="tl-what">${esc(e.title)}${who}${det}</div></div>`;
    }).join('');
    return `<div class="tl-day"><h3>${esc(day.day)}</h3><div class="tl-list">${rows}</div></div>`;
  }).join('');
  return chrome('Schedule', 'UTA Timeline', `<div class="tl-wrap">${body}</div>`, '',
                'Squadron-wide unless a shop is named');
}

// ── 8. Work Schedule ──────────────────────────────────────────────────────
function workSchedule(d) {
  if (!d.workOrders.length) return chrome('Shops', 'UTA Work Schedule', emptyNote('work orders'));
  const n = d.workOrders.reduce((a, s) => a + s.items.length, 0);
  const body = d.workOrders.map(({ shop, items }) => {
    const rows = items.map(i => `<div class="ws-row">
      <span class="ws-wo">${esc(i.wo)}</span>
      <span style="flex:1">${esc(i.title)}${i.details ? `<span class="p-note"> — ${esc(i.details)}</span>` : ''}</span>
    </div>`).join('');
    return `<div class="ws-shop"><h3>${esc(shop)}</h3>${rows}</div>`;
  }).join('');
  return chrome('Shops', 'UTA Work Schedule', `<div class="ws-wrap">${body}</div>`, '', `${n} work orders`);
}

// ── SGLI & vRED ───────────────────────────────────────────────────────────
function sgliVred(d) {
  const col = (head, list) => `<div class="col"><div class="col-hd">${esc(head)} (${list.length})</div>${
    list.length ? list.map(p => `<div class="p-row"><span class="p-name overdue">${person(p)}</span></div>`).join('') : emptyNote('members')
  }</div>`;
  const intro = `<p class="intro">Members below need to log in to MilConnect (SGLI) and/or vMPF (vRED) to update. Tell your supervisor once it is done.</p>`;
  return chrome('Admin', 'SGLI & vRED Updates', intro + `<div class="two-col">${col('SGLI', d.sgliVred.sgli)}${col('vRED', d.sgliVred.vred)}</div>`);
}

// ── 12. CBTs ──────────────────────────────────────────────────────────────
function cbts(d) {
  if (!d.cbts.length) return chrome('Training', 'Computer-Based Training', emptyNote('CBTs'));
  const n = d.cbts.reduce((a, g) => a + g.members.length, 0);
  const blocks = d.cbts.map(g => {
    const lines = g.members.map(m =>
      `<div class="cbt-line"><span class="${URG_CLASS[m.urgency] || ''}">${esc(m.last)}</span> <span class="cbt-status">${esc(m.status)}</span></div>`).join('');
    return `<div class="cbt-block"><div class="cbt-type">${esc(g.type)}${g.duration ? ` <span class="p-note">${esc(g.duration)}</span>` : ''}</div>${lines}</div>`;
  }).join('');
  const note = `<p class="intro">All “HST” CBTs are in MyLearning. Give certs to your supervisor, who forwards them to the training NCO by COB Sunday.
    <span class="overdue">Red = overdue</span> · <span class="due-month">amber = due this month</span> · <span class="complete">green = due next month</span>.</p>`;
  return chrome('Training', 'Computer-Based Training', note + `<div class="cbt-cols">${blocks}</div>`, '', `${n} assignments`);
}


// ── 14. Orders / DTS / AROWS ──────────────────────────────────────────────
function orders(d) {
  const tbl = (head, rows) => rows.length ? `<div class="card"><div class="card-hd">${esc(head)}<span class="count">${rows.length}</span></div>
    <table class="data-table"><thead><tr><th>Rank</th><th>Name</th><th>Action</th></tr></thead><tbody>${
      rows.map(r => `<tr><td>${esc(r.rank)}</td><td class="b">${esc(r.name)}</td><td>${esc(r.issue)}${r.comment ? ` <span class="p-note">— ${esc(r.comment)}</span>` : ''}</td></tr>`).join('')
    }</tbody></table></div>` : '';
  const body = tbl('DTS Vouchers', d.orders.dts) + tbl('AROWS — RMP / RUTA / Orders', d.orders.arows);
  return chrome('Admin', 'Orders / DTS / AROWS', body || emptyNote('orders actions'), '',
                `${d.orders.dts.length + d.orders.arows.length} open`);
}

// ── 16. EPBs / OPBs ───────────────────────────────────────────────────────
function epbs(d) {
  const list = (head, rows, cls) => `<div class="card"><div class="card-hd">${esc(head)}<span class="count">${rows.length}</span></div>${
    rows.length ? rows.map(r =>
      `<div class="p-row"><span class="p-name ${cls}">${person(r)}</span><span class="p-note">${esc(r.detail)}</span></div>`).join('')
      : emptyNote('members')
  }</div>`;
  const intro = `<p class="intro">Check MyEval for anything sitting at your level for coordination.</p>`;
  return chrome('Admin', 'EPBs / OPBs', intro + `<div class="two-col">
    <div class="col">${list('Overdue', d.epbs.overdue, 'overdue')}</div>
    <div class="col">${list('Coming Due', d.epbs.comingDue, '')}</div></div>`);
}

// ── 17. Medical & Dental ──────────────────────────────────────────────────
function medical(d) {
  const lines = d.medical.length ? d.medical.map(m =>
    `<div class="med-line"><span class="b">${esc(m.rank)} ${esc(m.last)}</span> — <span class="red">${esc(m.items.join(' / '))}</span></div>`).join('')
    : emptyNote('medical or dental requirements');
  const steps = `<div class="med-steps"><div class="card"><div class="card-hd">Reminders</div><ul>
    <li>Immunisations &amp; labs: walk-ins Saturday 0900–1400. Anyone IMR <b>red</b> for HIV or an immunisation must come during these times.</li>
    <li>MHA: register at smp.qtcm.com, complete the DRHA, then call RHRP on 1-833-782-7477 to schedule.</li>
    <li>GMI: bring your civilian optometry prescription to order gas-mask inserts.</li></ul></div></div>`;
  return chrome('Medical', 'Medical & Dental Requirements',
    `<div class="med-grid"><div class="med-list">${lines}</div>${steps}</div>`, '', `${d.medical.length} members`);
}

// ── 19. PT Testing ────────────────────────────────────────────────────────
function pt(d) {
  const cards = d.pt.buckets.map(b =>
    `<div class="pt-card"><div class="pt-hd">${esc(b.label)}</div>${b.members.map(m => `<div>${esc(m.rank)} ${esc(m.last)}</div>`).join('')}</div>`).join('');
  const od = d.pt.overdue.map(r => `${esc(r.rank)} ${esc(r.last)}`).join(' · ');
  const note = `<p class="intro">Schedule yourself in MyFitness — you can test early, never late.
    ${od ? `<br><span class="overdue">Overdue: ${od}</span>` : ''}</p>`;
  return chrome('Fitness', 'PT Testing — Due Dates',
    note + (cards ? `<div class="pt-grid">${cards}</div>` : emptyNote('scheduled tests')));
}


// ── 21. Inbound / Outbound Airmen ─────────────────────────────────────────
function inbound(d) {
  const line = (r) => `<div class="io-line"><span class="b">${esc(r.rank)} ${esc(r.last)}</span>
    <span class="p-note">${esc(r.detail)}</span>${r.shop ? ` <span class="tl-shop">${esc(r.shop)}</span>` : ''}</div>`;
  const bmt = d.inbound.bmt.length
    ? `<div class="card"><div class="card-hd">BMT / Tech School / OTS<span class="count">${d.inbound.bmt.length}</span></div>${d.inbound.bmt.map(line).join('')}</div>`
    : emptyNote('inbound or outbound airmen');
  const pme = d.inbound.pme.length
    ? `<div class="card"><div class="card-hd">PME<span class="count">${d.inbound.pme.length}</span></div>${d.inbound.pme.map(line).join('')}</div>` : '';
  const intro = `<p class="intro">Members below should have received their TLN and BMT/Tech School dates. Tell us if you have not, and work with your supervisor on out-processing.</p>`;
  return chrome('People', 'Inbound / Outbound Airmen', intro + bmt + pme);
}

// ── 22. Upgrade Training ──────────────────────────────────────────────────
function upgrade(d) {
  const card = (r) => `<div class="ug-card"><div class="b">${esc(r.rank)} ${esc(r.last)}
    ${r.shop ? `<span class="p-note">${esc(r.shop)}</span>` : ''}</div>
    <div class="p-note">${esc(r.detail)}</div></div>`;
  const col = (head, rows) => `<div class="ug-col"><div class="col-hd">${esc(head)} (${rows.length})</div>${
    rows.length ? rows.map(card).join('') : emptyNote('members')}</div>`;
  const waiting = d.upgrade.waiting.length
    ? `<p class="intro" style="margin-top:10px"><b>Waiting on SSgt to start 7-level UGT:</b> ${d.upgrade.waiting.map(esc).join(', ')}</p>` : '';
  return chrome('Training', 'Upgrade Training — Projected Completion',
    `<div class="ug-cols">${col('5-Level', d.upgrade.fiveLevel)}${col('7-Level', d.upgrade.sevenLevel)}</div>${waiting}`);
}

// ── 9. Additional Duties ──────────────────────────────────────────────────
// Two side-by-side tables, split in half, so ~50 rows fit one printed page —
// the layout the hand-edited partial used. A duty with no primary owner prints
// red: that is what "needs owner" looks like on paper.
function additionalDuties(d) {
  const rows = d.duties || [];
  const half = Math.ceil(rows.length / 2);
  const cell = (v) => esc(v || '—');
  const table = (list) => `<table class="duties-table"><thead><tr><th>Additional Duty</th><th>Primary</th><th>Alternate</th></tr></thead><tbody>${
    list.map(r => `<tr${r.primary_owner ? '' : ' class="red"'}><td>${esc(r.duty)}</td><td>${cell(r.primary_owner)}</td><td>${cell(r.alternate_owner)}</td></tr>`).join('')
  }</tbody></table>`;
  const body = rows.length
    ? `<div class="duties-cols">${table(rows.slice(0, half))}${table(rows.slice(half))}</div>`
    : '<p class="empty">No additional duties recorded in the tracker.</p>';
  return chrome('Squadron', 'Additional Duties List', body, '', `${rows.length} duties`);
}

// ── 23. RSD Schedule ──────────────────────────────────────────────────────
// The calendar year as lib/drill-calendar.js derives it, relative to the cycle
// being printed: past drills struck through, this UTA bold, gaps spelled out.
function rsdSchedule(d) {
  const cal = d.calendar || { year: new Date().getUTCFullYear(), entries: [] };
  const line = (e) => {
    if (e.kind === 'no_uta') return `<li>NO UTA ${esc(e.label.toUpperCase())} ${cal.year}</li>`;
    const text = `${esc(e.label)} ${cal.year}${e.threeDay ? ' (3-Day Drill)' : ''}${e.note ? ` (${esc(e.note)})` : ''}`;
    return `<li>${e.past ? `<s>${text}</s>` : e.next ? `<b>${text}</b>` : text}</li>`;
  };
  // buildYear() fills every uncovered month with a no_uta entry, so cal.entries is
  // never empty on its own — a year with no drills entered would otherwise print
  // twelve "NO UTA <month>" lines instead of the honest empty note. Check for an
  // actual drill instead.
  const hasDrills = cal.entries.some(e => e.kind === 'drill');
  const body = hasDrills
    ? `<p class="intro">Completed drills are struck through; this UTA is in bold.</p><ul class="rsd-list">${cal.entries.map(line).join('')}</ul>`
    : emptyNote('drill dates');
  return chrome('Calendar', `RSD Schedule — CY ${cal.year}`, body);
}

// Wrap an editable static partial's body in standard slide chrome.
function staticSlide(eyebrow, title, bodyHtml) {
  return chrome(eyebrow, title, `<div class="static-body">${bodyHtml}</div>`);
}

module.exports = {
  beginDeck, cover, orgSlide, timeline, workSchedule, sgliVred, cbts,
  orders, epbs, medical, pt, inbound, upgrade, additionalDuties, rsdSchedule, staticSlide, esc,
};
