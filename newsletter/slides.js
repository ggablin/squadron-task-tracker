// newsletter/slides.js — one function per newsletter slide. Pure (data -> HTML string).
//
// Restyled to the app's design language: the eyebrow + left-aligned title, the
// bordered card, and the urgency badge shapes all come from public/index.html, so
// a member who has used the tracker recognises the newsletter as the same thing.
// Colours and type live in theme.js; this file only decides structure.

const { summarize } = require('./shape');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const person = (p) => `${esc(p.rank)} ${esc(p.last_name || p.last)}`.trim();

// A row of name chips: one per member, tone from `cls`, the member's own status
// (and their shop, when `withShop`) inside the chip in smaller type. A list of
// people printed as chips reads as people; the same names run together as a
// paragraph read as a wall.
function chips(rows, cls = () => '', withShop = false) {
  return `<div class="chips">${rows.map(r => {
    const sub = [r.status, withShop ? r.shop : ''].filter(Boolean).join(' · ');
    return `<span class="chip ${cls(r) || ''}">${person(r)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>`;
  }).join('')}</div>`;
}

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
// Drawn as the source newsletter draws them: a real chart with chain-of-command
// lines. Staff row on a rule beside the Commander; the spine Commander → BCE OIC →
// Flight OIC → Flight Superintendent; a bar fanning out to each shop's NCOIC (and any
// flight-level peer such as the UTM); a two-column grid of members under each shop.
// Connectors are CSS only, so the deck stays a single self-contained HTML file that
// prints identically with no script — see .org-* in theme.js.
//
// A rung with nobody in it prints "Vacant" rather than disappearing: the source
// chart does exactly that for an empty OIC slot, and a chart that quietly drops a
// level misreads as "there is no OIC" rather than "the OIC billet is open".
//
// Member tiles carry rank and name only. The source labels every tile Journeyman /
// Craftsman / Supervisor #N; the tracker knows supervisor vs member and nothing
// about skill level, and a chart must not invent one. Supervisors keep their label.
const SHOP_CLASS = {
  'WFSM': 'sh-red', 'HVAC': 'sh-green', 'Electrical': 'sh-gray', 'Power Pro': 'sh-blue',
  'Heavy Equipment': 'sh-orange', 'Structures': 'sh-teal', 'Operations': 'sh-cyan',
  'EA': 'sh-yellow', 'EM': 'sh-purple',
};
const STAFF_CLASS = { 'Commander': 'b-cmd', 'Chief Enlisted Manager': 'b-chief', 'First Sergeant': 'b-1sg',
  'Admin Support Technician': 'b-admin', 'BCE/Engineering OIC': 'b-oic' };

function orgBox(p, cls, pos, extra = '') {
  const name = p ? person(p) : 'Vacant';
  return `<div class="org-box ${cls}${p ? '' : ' b-vacant'}"${extra}><div class="org-pos">${esc(pos)}</div><div class="org-name">${name}</div></div>`;
}

function orgSlide(flightName, d) {
  const flight = d.org.flights.find(f => f.name === flightName);
  if (!flight) return '';
  const staff = d.org.staff;
  const find = (re) => staff.find(p => re.test(p.position || ''));
  const cmd = find(/^Commander$/i), cem = find(/Chief Enlisted/i), fsg = find(/First Sergeant/i),
        adm = find(/Admin Support/i);
  const bces = staff.filter(p => /BCE/i.test(p.position || ''));

  // Staff row: five equal columns, Commander in the middle so the spine hangs from
  // the page centre; CEM to the left, First Sergeant and Admin to the right, as the
  // source lays it out. The rule behind them runs CEM → Admin (theme: .org-top::before).
  const cell = (p, cls, pos, col) => p ? orgBox(p, cls, pos, ` style="grid-column:${col}"`) : '';
  const top = `<div class="org-top">
    ${cell(cem, 'b-chief', 'Chief Enlisted Manager', 2)}
    ${cell(cmd, 'b-cmd', 'Commander', 3)}
    ${cell(fsg, 'b-1sg', 'First Sergeant', 4)}
    ${cell(adm, 'b-admin', 'Admin Support Technician', 5)}
  </div>`;

  const oic = flight.leaders.find(p => /\bOIC\b/i.test(p.position || ''));
  const supt = flight.leaders.find(p => /Superintendent/i.test(p.position || ''));
  const peers = flight.leaders.filter(p => p !== oic && p !== supt);

  const rung = (html, last = false) => `<div class="org-rung${last ? ' org-rung-last' : ''}">${html}</div>`;
  const spine = `<div class="org-spine">
    ${bces.map(p => rung(orgBox(p, 'b-oic', 'BCE/Engineering OIC'))).join('')}
    ${rung(orgBox(oic, 'b-oic', `${flightName} Flight OIC`))}
    ${rung(orgBox(supt, 'b-supt', `${flightName} Flight Superintendent`), true)}
  </div>`;

  const tile = (p, role) => `<div class="org-tile">${role ? `<div class="org-role">${esc(role)}</div>` : ''}<div class="org-name">${person(p)}</div></div>`;
  const shopBranch = (sh) => {
    const cls = SHOP_CLASS[sh.name] || 'sh-gray';
    const head = orgBox(sh.ncoic, 'b-ncoic', `${sh.name} ${sh.ncoic ? sh.ncoic.position : 'NCOIC'}`);
    const tiles = sh.supervisors.map(p => tile(p, 'Supervisor')).concat(sh.members.map(p => tile(p, '')));
    return `<div class="org-branch ${cls}">${head}${tiles.length ? `<div class="org-grid">${tiles.join('')}</div>` : ''}</div>`;
  };
  const peerBranch = (p) => `<div class="org-branch org-peer">${orgBox(p, 'b-peer', p.position || '')}</div>`;
  const branches = `<div class="org-branches">${flight.shops.map(shopBranch).join('')}${peers.map(peerBranch).join('')}</div>`;

  const count = flight.shops.reduce((n, sh) => n + sh.supervisors.length + sh.members.length + (sh.ncoic ? 1 : 0), 0)
              + flight.leaders.length;
  return chrome('Organisation', `${flightName} Flight`, `<div class="org-chart">${top}${spine}${branches}</div>`,
                'org', `${count} assigned`);
}

// ── 6. UTA Timeline ───────────────────────────────────────────────────────
// Drawn as a horizontal time grid, the way the newsletter draws it: hours across the
// top, each event a bar under the hours it actually occupies, overlapping events
// stacked in lanes. A vertical list of the same events cannot show that the Manning
// Doc meeting runs inside the afternoon admin block, or where the gaps are.
//
// shape.js has already resolved every bar to a start slot, a width and a lane; all
// this does is turn those into grid-column and grid-row.
function timeline(d) {
  if (!d.timeline.length) return chrome('Schedule', 'UTA Timeline', emptyNote('schedule events'));

  const body = d.timeline.map(day => {
    const g = day.grid;
    const perHour = 60 / g.slot;
    const hours = g.ticks.map((t, i) =>
      `<div class="tl-hour" style="grid-column:${i * perHour + 1}/span ${perHour}">${esc(t)}</div>`).join('');

    // The box is the DRAWN span (never under an hour, so a title always fits and
    // wraps rather than clipping); the time label is the true one. Colour comes
    // from the category shape.js derived, one line of summary from the details.
    const bars = day.events.map(e => {
      const col = (e.startMin - g.from) / g.slot + 1;
      const span = (e.drawEnd - e.startMin) / g.slot;
      const who = e.shop && e.shop !== 'ALL' ? `<span class="tl-shop">${esc(e.shop)}</span>` : '';
      const det = e.summary ? `<span class="tl-det">${esc(e.summary)}</span>` : '';
      return `<div class="tl-bar tl-c-${esc(e.cat)}" style="grid-column:${col}/span ${span};grid-row:${e.lane + 2}">
        <span class="tl-t">${esc(e.start)}${e.end ? `–${esc(e.end)}` : ''}</span>
        <span class="tl-n">${esc(e.title)}${who}</span>${det}
      </div>`;
    }).join('');

    const notes = day.untimed.length
      ? `<div class="tl-notes">${day.untimed.map(e =>
          `<span class="tl-note">${esc(e.title)}${e.details ? ` — ${esc(e.details)}` : ''}</span>`).join('')}</div>`
      : '';

    return `<div class="tl-day">
      <h3>${esc(day.day)}</h3>
      <div class="tl-grid" style="--cols:${g.cols};--hourw:calc(100% / ${g.ticks.length})">
        ${hours}${bars}
      </div>${notes}
    </div>`;
  }).join('');

  // Legend for whatever categories this UTA actually uses, in a fixed order.
  const LEGEND = [['formation', 'Formation'], ['training', 'Training'], ['meeting', 'Meeting / Briefing'],
    ['medical', 'Medical'], ['fitness', 'PT'], ['ceremony', 'Ceremony'], ['meal', 'Meals'],
    ['cleanup', 'Cleanup'], ['other', 'Other']];
  const used = new Set(d.timeline.flatMap(day => day.events.map(e => e.cat)));
  const legend = `<div class="tl-legend">${LEGEND.filter(([k]) => used.has(k))
    .map(([k, l]) => `<span><i class="tl-sw tl-c-${k}"></i>${l}</span>`).join('')}</div>`;

  return chrome('Schedule', 'UTA Timeline', `<div class="tl-body"><div class="tl-wrap">${body}</div>${legend}</div>`, '',
                'Squadron-wide unless a shop is named');
}

// ── 8. Work Schedule ──────────────────────────────────────────────────────
// One cream card per shop, three across. A work order is its number, its title
// and one line of its details: the progress notes that follow ("we replaced
// seven LEDs, with two remaining…") belong in the app, not on a schedule.
function workSchedule(d) {
  if (!d.workOrders.length) return chrome('Shops', 'UTA Work Schedule', emptyNote('work orders'));
  const n = d.workOrders.reduce((a, s) => a + s.items.length, 0);
  const body = d.workOrders.map(({ shop, items }) => {
    const rows = items.map(i => `<div class="ws-row">
      ${i.wo ? `<span class="ws-wo">${esc(i.wo)}</span>` : ''}
      <div><div class="ws-t">${esc(i.title)}</div>${i.details ? `<div class="ws-d">${esc(summarize(i.details, 96))}</div>` : ''}</div>
    </div>`).join('');
    return `<div class="ws-shop"><h3>${esc(shop)}<span class="count">${items.length}</span></h3>${rows}</div>`;
  }).join('');
  return chrome('Shops', 'UTA Work Schedule', `<div class="ws-wrap">${body}</div>`, '', `${n} work orders`);
}

// ── 10. Quarterly Awards ──────────────────────────────────────────────────
// The programme text and the FY schedule stay in the hand-edited partial; the
// call to action underneath carries the names of the supervisors who still owe a
// 1206 this quarter, straight off the tracker.
function awards(d, partial) {
  const a = d.awards || { members: [], title: '', note: '' };
  const live = a.members.length ? `<div class="card accent-warn" style="margin-top:10px">
      <div class="card-hd">${esc(a.title || '1206s owed')}<span class="count">${a.members.length} supervisors</span></div>
      ${a.note ? `<p class="note">${esc(a.note)}</p>` : ''}
      ${chips(a.members)}
    </div>` : '';
  return chrome('Squadron', 'CE / Wing Quarterly Awards', `<div class="static-body">${partial}</div>${live}`, 'roomy');
}

// ── 12. CBTs (MyLearning) ─────────────────────────────────────────────────
// One cream card per course, name left and status right. The sentence every
// course shares ("In MyLearning. Give cert to your supervisor…") is printed once
// in the intro; a sentence one course alone carries heads that course. Before
// this, every one of 134 lines ended in the same 100 characters and the slide ran
// off the page.
function cbtBlock(g) {
  const two = g.members.length > 12;
  const lines = g.members.map(m =>
    `<div class="cbt-line"><span class="cbt-name ${URG_CLASS[m.urgency] || ''}">${esc(m.last)}</span>${
      m.status ? `<span class="cbt-status">${esc(m.status)}</span>` : ''}</div>`).join('');
  return `<div class="cbt-block">
    <div class="cbt-type"><span>${esc(g.name)}</span>${g.duration ? `<span class="cbt-dur">${esc(g.duration)}</span>` : ''}</div>
    <div class="cbt-meta">${g.members.length} ${g.members.length === 1 ? 'member' : 'members'}</div>
    ${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}
    <div class="cbt-members${two ? ' two' : ''}">${lines}</div>
  </div>`;
}
const LEGEND = `<span class="overdue">Red = overdue</span> · <span class="due-month">amber = due this month</span> · <span class="complete">green = due next month</span>`;

function cbts(d) {
  const groups = d.cbts.mandatory || [];
  if (!groups.length) return chrome('Training', 'Computer-Based Training', emptyNote('CBTs'));
  const n = groups.reduce((a, g) => a + g.members.length, 0);
  const note = `<p class="intro">${d.cbts.mandatoryNote ? esc(d.cbts.mandatoryNote) + ' ' : ''}${LEGEND}</p>`;
  return chrome('Training', 'Computer-Based Training', note + `<div class="cbt-cols">${groups.map(cbtBlock).join('')}</div>`, '',
                `${n} assignments · ${groups.length} courses`);
}

// ── 13. Additional Training (Percipio, AFI 10-210) ────────────────────────
// Live since September 2026: these are the Percipio rows of the CBT category,
// which the hand-edited partial this replaces used to list a month behind.
function additional(d) {
  const groups = d.cbts.additional || [];
  if (!groups.length) return chrome('Training', 'Additional Training — AFI 10-210', emptyNote('Percipio courses'));
  const n = groups.reduce((a, g) => a + g.members.length, 0);
  const cards = groups.map(g => `<div class="card">
      <div class="card-hd">${esc(g.name)}<span class="count">${esc(g.duration)}</span></div>
      ${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}
      ${chips(g.members)}
    </div>`).join('');
  const intro = `<p class="intro">${esc(d.cbts.additionalNote || 'Counts toward your overall MRA per AFI 10-210. These courses live on Percipio, not MyLearning. Give certificates to your supervisor.')}</p>`;
  return chrome('Training', 'Additional Training — AFI 10-210', intro + `<div class="masonry-3 chips-lg">${cards}</div>`, '',
                `${n} assignments · ${groups.length} courses`);
}

// ── 14. Orders / DTS / AROWS ──────────────────────────────────────────────
// A reminder assigned to the whole squadron is one strip with the count; the
// people who personally owe a voucher or an order signature get a table each.
function orders(d) {
  const notices = (d.orders.notices || []).map(nt => `<div class="card notice">
      <span class="notice-t">${esc(nt.title)}</span><span class="notice-n">Everyone · ${nt.count} members</span>
      ${nt.details ? `<p class="note">${esc(nt.details)}</p>` : ''}
    </div>`).join('');
  const tbl = (head, rows, note, colHead) => `<div class="card"><div class="card-hd">${esc(head)}<span class="count">${rows.length}</span></div>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}${
    rows.length ? `<table class="data-table"><thead><tr><th>Member</th><th>${esc(colHead)}</th><th>Note</th></tr></thead><tbody>${
      rows.map(r => `<tr><td class="b" style="white-space:nowrap">${esc(r.rank)} ${esc(r.name)}</td><td>${esc(r.issue)}</td><td class="muted">${esc(r.comment)}</td></tr>`).join('')
    }</tbody></table>` : emptyNote('members')}</div>`;
  const tables = `<div class="two-col">
    <div class="col">${tbl('DTS Vouchers', d.orders.dts, d.orders.dtsNote, 'Voucher')}</div>
    <div class="col">${tbl('AROWS — Orders / RMP / RUTA', d.orders.arows, d.orders.arowsNote, 'Order')}</div>
  </div>`;
  const total = d.orders.dts.length + d.orders.arows.length;
  const body = notices || total ? `<div class="stack">${notices}${tables}</div>` : emptyNote('orders actions');
  return chrome('Admin', 'Orders / DTS / AROWS', body, 'roomy', `${total} open`);
}

// ── 15. Government Travel Card ────────────────────────────────────────────
// Newsletter page 15. Replaced an SGLI & vRED slide that printed two empty columns
// every cycle — no cycle has ever held a task by either of the names it looked for.
function gtc(d) {
  const list = (head, rows, note, cls) => `<div class="card${cls ? ' ' + cls : ''}"><div class="card-hd">${esc(head)}<span class="count">${rows.length}</span></div>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}${rows.length ? chips(rows, () => 'overdue') : emptyNote('members')}</div>`;
  const steps = `<div class="steps">
    <div class="step"><div class="n">1</div><div><div class="t">Apply</div><div class="s">Every member needs a Government Travel Card. Apply through CitiDirect. A new card: verify it with CitiBank and update the card details in DTS. Moved: change your address in DTS.</div></div></div>
    <div class="step"><div class="n">2</div><div><div class="t">Train</div><div class="s">Complete the GTC training and keep the certificate.</div></div></div>
    <div class="step"><div class="n">3</div><div><div class="t">Turn in</div><div class="s">Hand the certificate <b>and</b> the Statement of Understanding to your supervisor — both go on Chief Cisek's desk.</div></div></div>
  </div>`;
  return chrome('Admin', 'Government Travel Card', steps
    + `<div class="two-col">${list('Statement of Understanding owed', d.gtc.sou, d.gtc.souNote)}${list('GTC CBT certificate owed', d.gtc.cbt, d.gtc.cbtNote)}</div>`,
    'roomy', `${d.gtc.sou.length + d.gtc.cbt.length} outstanding`);
}

// ── 16. EPBs / OPBs ───────────────────────────────────────────────────────
// One row per evaluation — ratee, closeout, where it sits, what it needs — and the
// ACA feedback sessions due this UTA beside them.
function epbs(d) {
  const table = (rows, cls) => `<table class="data-table"><thead><tr><th>Type</th><th>Ratee</th><th>Closeout</th><th>Sitting at</th><th>Needs</th></tr></thead><tbody>${
    rows.map(r => `<tr><td>${esc(r.type)}</td><td class="b ${cls}" style="white-space:nowrap">${esc(r.ratee)}</td><td class="num">${esc(r.closeout || '—')}</td><td style="white-space:nowrap">${esc(r.sittingAt || '—')}</td><td class="muted">${esc(r.needs)}</td></tr>`).join('')
  }</tbody></table>`;
  const overdue = d.epbs.overdue.length
    ? `<div class="card accent-urgent"><div class="card-hd">Overdue<span class="count">${d.epbs.overdue.length}</span></div>${table(d.epbs.overdue, 'overdue')}</div>` : '';
  const routing = `<div class="card"><div class="card-hd">In routing<span class="count">${d.epbs.comingDue.length}</span></div>${
    d.epbs.comingDue.length ? table(d.epbs.comingDue, '') : emptyNote('evaluations')}</div>`;
  const aca = d.epbs.aca && d.epbs.aca.pairs.length
    ? `<div class="card accent-info"><div class="card-hd">ACA feedback sessions due<span class="count">${d.epbs.aca.pairs.length}</span></div>
        ${d.epbs.aca.note ? `<p class="note">${esc(d.epbs.aca.note)}</p>` : ''}
        <div class="chips">${d.epbs.aca.pairs.map(p => `<span class="chip">${esc(p)}</span>`).join('')}</div></div>` : '';
  const intro = `<p class="intro">Check MyEval for anything sitting at your level for coordination.</p>`;
  const n = d.epbs.overdue.length + d.epbs.comingDue.length;
  return chrome('Admin', 'EPBs / OPBs', intro + `<div class="stack">${overdue}${routing}${aca}</div>`, 'roomy', `${n} in routing`);
}

// ── 17. Medical & Dental ──────────────────────────────────────────────────
// One card per requirement with the names in it — "who still owes a PHAQ" is how
// the slide is read — instead of a red line per member repeating the walk-in hours.
function medical(d) {
  if (!d.medical.length) return chrome('Medical', 'Medical & Dental Requirements', emptyNote('medical or dental requirements'));
  const cards = d.medical.map(g => `<div class="card${g.overdue ? ' accent-urgent' : ''}">
      <div class="card-hd">${esc(g.service)}<span class="count">${g.members.length}</span></div>
      ${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}
      ${chips(g.members, m => g.overdue || m.urgency === 'overdue' ? 'overdue' : '')}
    </div>`).join('');
  const people = new Set(d.medical.flatMap(g => g.members.map(m => m.rank + ' ' + m.last))).size;
  const n = d.medical.reduce((a, g) => a + g.members.length, 0);
  return chrome('Medical', 'Medical & Dental Requirements', `<div class="med-cols">${cards}</div>`, '',
                `${n} requirements · ${people} members`);
}

// ── 19. PT Testing ────────────────────────────────────────────────────────
// The tests due this UTA lead — that card carries the Saturday test time — with the
// later months and the overdue list beside it.
function pt(d) {
  const card = (head, rows, note, cls, sub) => `<div class="card${cls ? ' ' + cls : ''}"><div class="card-hd">${esc(head)}<span class="count">${rows.length}</span></div>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}${chips(rows, () => sub || '', true)}</div>`;
  const buckets = [...d.pt.buckets].sort((a, b) => (b.thisUta - a.thisUta) || a.sort.localeCompare(b.sort));
  const cards = [
    ...buckets.map(b => card(b.thisUta ? `${b.label} — this UTA` : b.label, b.members, b.note, b.thisUta ? 'accent-info lead' : '', b.thisUta ? 'this' : 'next')),
    d.pt.scheduled.length ? card('Testing this UTA', d.pt.scheduled, '', 'accent-info lead', 'this') : '',
    d.pt.overdue.length ? card('Overdue', d.pt.overdue, '', 'accent-urgent', 'overdue') : '',
  ].filter(Boolean).join('');
  const note = `<p class="intro">Schedule yourself in MyFitness — you can test early, never late.</p>`;
  const n = d.pt.overdue.length + d.pt.scheduled.length + d.pt.buckets.reduce((a, b) => a + b.members.length, 0);
  return chrome('Fitness', 'PT Testing — Due Dates', note + (cards ? `<div class="pt-grid">${cards}</div>` : emptyNote('scheduled tests')),
                'roomy', `${n} members`);
}

// ── 21. Inbound / Outbound Airmen ─────────────────────────────────────────
// The accession pipeline in, TAP (transition assistance — members separating) out.
function inbound(d) {
  const card = (head, rows, note, cls) => `<div class="card${cls ? ' ' + cls : ''}"><div class="card-hd">${esc(head)}<span class="count">${rows.length}</span></div>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}${chips(rows, () => '', true)}</div>`;
  const tap = d.tap || { members: [], note: '' };
  const cards = [
    d.inbound.bmt.length ? card('BMT / Tech School / OTS', d.inbound.bmt, d.inbound.bmtNote, '') : '',
    d.inbound.pme.length ? card('PME', d.inbound.pme, d.inbound.pmeNote, '') : '',
    tap.members.length ? card('Separating — TAP training', tap.members, tap.note, 'accent-warn') : '',
  ].filter(Boolean).join('');
  const intro = `<p class="intro">Members below should have their TLN and school dates in hand. Tell leadership if you do not, and work with your supervisor on out-processing.</p>`;
  return chrome('People', 'Inbound / Outbound Airmen', intro + (cards ? `<div class="stack">${cards}</div>` : emptyNote('inbound or outbound airmen')),
                'roomy', `${d.inbound.bmt.length + d.inbound.pme.length + tap.members.length} members`);
}

// ── 22. Upgrade Training ──────────────────────────────────────────────────
// A table per level: where each trainee stands, with a bar for task completion.
function upgrade(d) {
  const u = d.upgrade;
  const bar = (pct) => pct == null ? '—' : `<div class="bar"><i><b style="width:${Math.max(0, Math.min(100, pct))}%"></b></i><span>${pct}%</span></div>`;
  const table = (rows) => `<table class="data-table ug-table"><thead><tr><th>Trainee</th><th>Shop</th><th>Started</th><th>Months</th><th>CDC</th><th>Tasks</th><th>Notes</th></tr></thead><tbody>${
    rows.map(r => `<tr><td class="who">${esc(r.rank)} ${esc(r.last)}</td><td>${esc(r.shop || '—')}</td><td>${esc(r.started || '—')}</td><td class="num">${r.months == null ? '—' : r.months}</td><td class="num">${esc(r.cdc || '—')}</td><td>${bar(r.tasks)}</td><td class="muted">${esc(r.status || '')}</td></tr>`).join('')
  }</tbody></table>`;
  const level = (head, rows) => rows.length
    ? `<div class="card"><div class="card-hd">${esc(head)}<span class="count">${rows.length}</span></div>${table(rows)}</div>` : '';
  const waiting = u.waiting.length
    ? `<div class="card accent-warn"><div class="card-hd">Waiting on SSgt to start 7-level UGT<span class="count">${u.waiting.length}</span></div>
        <div class="chips">${u.waiting.map(w => `<span class="chip">${esc(w)}</span>`).join('')}</div></div>` : '';
  const cards = [level('5-Level', u.fiveLevel), level('7-Level', u.sevenLevel), level('Upgrade training', u.unlevelled || []), waiting].filter(Boolean).join('');
  const intro = u.note ? `<p class="intro">${esc(u.note)}</p>` : '';
  const n = u.fiveLevel.length + u.sevenLevel.length + (u.unlevelled || []).length;
  return chrome('Training', 'Upgrade Training — Projected Completion', intro + (cards ? `<div class="stack">${cards}</div>` : emptyNote('upgrade training')),
                'roomy', `${n} in training · ${u.waiting.length} waiting`);
}

// ── 9. Additional Duties ──────────────────────────────────────────────────
// Two side-by-side tables, split in half, so ~50 rows fit one printed page —
// the layout the hand-edited partial used. A duty with no primary owner prints
// red: that is what "needs owner" looks like on paper.
function additionalDuties(d) {
  const rows = d.duties || [];
  const half = Math.ceil(rows.length / 2);
  const cell = (v) => esc(v || '—');
  const table = (list) => `<div class="card"><table class="duties-table"><thead><tr><th>Additional Duty</th><th>Primary</th><th>Alternate</th></tr></thead><tbody>${
    list.map(r => `<tr${r.primary_owner ? '' : ' class="red"'}><td>${esc(r.duty)}</td><td>${cell(r.primary_owner)}</td><td>${cell(r.alternate_owner)}</td></tr>`).join('')
  }</tbody></table></div>`;
  const body = rows.length
    ? `<div class="duties-cols">${table(rows.slice(0, half))}${table(rows.slice(half))}</div>`
    : '<p class="empty">No additional duties recorded in the tracker.</p>';
  return chrome('Squadron', 'Additional Duties List', body, '', `${rows.length} duties`);
}

// ── 23. RSD Schedule ──────────────────────────────────────────────────────
// The calendar year as twelve cards, from lib/drill-calendar.js, relative to the
// cycle being printed: past drills struck through, this UTA outlined, No-UTA
// months said so. A drill that starts in one month and ends in the next (31 Jan–1
// Feb) is listed where it starts and pointed to from the month it runs into.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function rsdSchedule(d) {
  const cal = d.calendar || { year: new Date().getUTCFullYear(), entries: [] };
  const drills = cal.entries.filter(e => e.kind === 'drill');
  const noUta = new Set(cal.entries.filter(e => e.kind === 'no_uta').map(e => e.month));
  const monthOf = (iso) => Number(String(iso).slice(5, 7));
  // The dates carry the mark; the 3-day tag and any note go on their own line so a
  // long label does not wrap mid-parenthesis at display size.
  const text = (e) => `${esc(e.label)} ${cal.year}`;
  const mark = (e) => e.past ? `<s>${text(e)}</s>` : e.next ? `<b>${text(e)}</b>` : text(e);
  const tags = (e) => [e.threeDay ? '3-Day Drill' : '', e.note ? esc(e.note) : ''].filter(Boolean).join(' · ');

  const cards = MONTHS.map((name, i) => {
    const m = i + 1;
    const starts = drills.filter(e => monthOf(e.start_date) === m);
    const runsIn = drills.filter(e => monthOf(e.start_date) !== m && monthOf(e.end_date) === m);
    const cls = ['month'];
    let body;
    if (starts.length) {
      if (starts.every(e => e.past)) cls.push('past');
      if (starts.some(e => e.next)) cls.push('next');
      body = starts.map(e => `<div class="d">${mark(e)}</div>${tags(e) ? `<div class="x">${tags(e)}</div>` : ''}`).join('');
    } else if (runsIn.length) {
      if (runsIn.every(e => e.past)) cls.push('past');
      body = runsIn.map(e => `<div class="x">Runs into ${name} — see ${esc(e.label)}</div>`).join('');
    } else if (noUta.has(m)) {
      cls.push('nouta');
      body = `<div class="d">NO UTA ${name.toUpperCase()} ${cal.year}</div>`;
    } else {
      body = `<div class="x">—</div>`;
    }
    return `<li class="${cls.join(' ')}"><div class="mo">${name}</div>${body}</li>`;
  }).join('');

  // buildYear() fills every uncovered month with a no_uta entry, so cal.entries is
  // never empty on its own — a year with no drills entered would otherwise print
  // twelve "NO UTA <month>" cards instead of the honest empty note.
  const hasDrills = drills.length > 0;
  // `dated` is false when the cycle carries no start_date, in which case nothing is
  // struck or outlined — so the intro must not promise marking that is not there.
  const intro = cal.dated === false
    ? `<p class="intro">The squadron's drill weekends for CY ${cal.year}.
       <span class="p-note">This UTA's dates are not set, so no weekend is marked.</span></p>`
    : `<p class="intro">Completed drills are struck through; this UTA is outlined.</p>`;
  const body = hasDrills ? `${intro}<ul class="rsd-list">${cards}</ul>` : emptyNote('drill dates');
  return chrome('Calendar', `RSD Schedule — CY ${cal.year}`, body, 'roomy');
}

// Wrap an editable static partial's body in standard slide chrome.
function staticSlide(eyebrow, title, bodyHtml, extraClass = '') {
  return chrome(eyebrow, title, `<div class="static-body">${bodyHtml}</div>`, extraClass);
}

module.exports = {
  beginDeck, cover, orgSlide, timeline, workSchedule, awards, gtc, cbts, additional,
  orders, epbs, medical, pt, inbound, upgrade, additionalDuties, rsdSchedule, staticSlide, esc,
};
