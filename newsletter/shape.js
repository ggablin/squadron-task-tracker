// newsletter/shape.js — pure task-shaping for from-db.js: turns task rows into the
// per-slide structures render.js consumes. Kept free of SQL so it can be unit-tested.
//
// All shapers take NORMALIZED rows:
//   task:      { rank, last, title, details, urgency, shop }   (urgency = overdue|this_uta|next_uta|future|info)
//   workOrder: { shop, wo, title, details }
//   timeline:  { shop, day, start, end, title, details, type }
//
// Two rules run through every task shaper, both learned from the September 2026 print:
//
//   1. A sentence that most of a group shares is the group's note, not each member's.
//      All 134 CBT rows ended "In MyLearning. Give cert to your supervisor, who gives
//      it to MSgt McNaughton by COB Sunday." — printed 134 times, it pushed the slide
//      off the page. liftCommon() moves it up one level and leaves each member with
//      only what is theirs ("3 Months Overdue").
//
//   2. A title assigned to (nearly) everyone is a notice, not a table. "Sign any RUTA /
//      RMP days in AROWS" sits on 73 of 73 members; a 73-row table says nothing a
//      one-line banner with the count does not.

const URG_ORDER = { overdue: 0, this_uta: 1, next_uta: 2, future: 3, info: 4 };
const MON = { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June',
              Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December' };
const MON_ORDER = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const byLast = (a, b) => a.last.localeCompare(b.last);
const byUrgencyThenLast = (a, b) => (URG_ORDER[a.urgency] ?? 9) - (URG_ORDER[b.urgency] ?? 9) || byLast(a, b);
const who = (t) => `${t.rank || ''} ${t.last}`.trim();
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const unstar = (s) => clean(s).replace(/^\*+\s*|\s*\*+$/g, '');
const noDot = (s) => s.replace(/\.$/, '');
const cap = (s) => s.slice(0, 1).toUpperCase() + s.slice(1).toLowerCase();

// ── liftCommon ─────────────────────────────────────────────────────────────────
// Split each member's details into sentences; a sentence that at least `min` of
// the group share becomes the note, in the order it first appears. What is left is
// each member's own status, trailing full stop dropped since it prints inline.
//
// A status sentence — "3 Months Overdue", "Due This Month", "Due Sep 2026" — is
// never lifted, even when every member of a group happens to share it: it is about
// the member, and a group of one would otherwise turn its only member's status into
// a heading. Only a sentence that is NOTHING BUT a status counts; "ACA feedback
// session due this UTA." is an instruction that mentions a due date.
const STATUS_RE = /^(?:(?:\d+\s+months?\s+)?overdue|due\s+(?:this|next)\s+(?:month|uta)|due\s+[a-z]{3,9}\s+\d{2,4})[.!]?$/i;
const sentences = (s) => clean(s).split(/(?<=[.!?])\s+/).filter(Boolean);

function liftCommon(rows, min = 0.6) {
  const parts = rows.map(r => sentences(r.details));
  const counts = new Map();
  for (const ps of parts) for (const p of new Set(ps)) counts.set(p, (counts.get(p) || 0) + 1);
  const threshold = Math.max(1, Math.ceil(rows.length * min));
  const common = new Set([...counts].filter(([p, n]) => n >= threshold && !STATUS_RE.test(p)).map(([p]) => p));
  const rests = parts.map(ps => ps.filter(p => !common.has(p)).join(' '));
  return { note: [...common].join(' '), statuses: rests.map(noDot), rests };
}

// Attach { status, rest } to each row from the leftovers of a lift, and return the
// note. `rest` keeps its punctuation so a second, narrower lift can run on it.
function lift(rows, min) {
  const { note, statuses, rests } = liftCommon(rows, min);
  rows.forEach((r, i) => { r.status = statuses[i]; r.rest = rests[i]; });
  return note;
}

// ── CBTs ───────────────────────────────────────────────────────────────────────
// Two slides from one category. The title names the platform — "CBT: Cyber
// Awareness = 1 Hr" is MyLearning, "Percipio: Bare Base Overview = 30 Mins" is
// the AFI 10-210 additional training — and the platform decides the slide. The
// Percipio rows are exactly what the hand-edited Additional Training slide used
// to list, a month stale; now it is the same data as the app.
//
// The lift runs twice: once across the whole slide, so the sentence every CBT
// shares prints once in the intro, then within each CBT, so a sentence specific
// to one course heads that course.
const CBT_TITLE_RE = /^\s*(CBT|HST|Percipio|MyLearning)\s*:\s*(.+?)\s*(?:=\s*(.+?))?\s*$/i;
function normDuration(s) {
  const m = clean(s).match(/(\d+(?:\.\d+)?)\s*(hr|hrs|hour|hours|min|mins|minute|minutes)\b/i);
  if (!m) return clean(s).toLowerCase();
  return `${m[1]} ${/^h/i.test(m[2]) ? 'hr' : 'min'}`;
}

function shapeCbts(tasks) {
  const rows = tasks.map(t => {
    const m = t.title.match(CBT_TITLE_RE);
    const platform = m ? m[1] : '', name = m ? m[2] : clean(t.title);
    let duration = m && m[3] ? normDuration(m[3]) : '', details = t.details || '';
    if (!duration && details.includes('—')) {           // August form: "1 hr — 5 Months Overdue"
      const [d, ...rest] = details.split('—');
      duration = normDuration(d); details = rest.join('—').trim();
    }
    return { platform, name, duration, details, rank: t.rank, last: t.last, urgency: t.urgency };
  });
  const build = (list) => {
    const note = lift(list);                              // slide-wide sentence
    const groups = new Map();
    for (const r of list) {
      const key = `${r.platform}|${r.name}`;
      if (!groups.has(key)) groups.set(key, { platform: r.platform, name: r.name, duration: r.duration, note: '', members: [] });
      const g = groups.get(key);
      if (!g.duration && r.duration) g.duration = r.duration;
      g.members.push({ rank: r.rank, last: r.last, urgency: r.urgency, details: r.rest });
    }
    for (const g of groups.values()) {
      g.note = lift(g.members);                           // course-specific sentence
      for (const m of g.members) { delete m.details; delete m.rest; }
      g.members.sort(byUrgencyThenLast);
    }
    return { note, groups: [...groups.values()].sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name)) };
  };
  const additional = build(rows.filter(r => /percipio/i.test(r.platform)));
  const mandatory = build(rows.filter(r => !/percipio/i.test(r.platform)));
  return { mandatory: mandatory.groups, mandatoryNote: mandatory.note,
           additional: additional.groups, additionalNote: additional.note };
}

// ── Medical & Dental ───────────────────────────────────────────────────────────
// One card per requirement with the names inside it, the way the source slide is
// read ("who still owes a PHAQ?"), instead of one red line per member repeating
// the same walk-in hours. PT tests have their own slide. An appointment written
// into the title — "Mil Dental Exam - 11 Sep @ 1020hrs" — belongs to that member,
// so it becomes their status and the card is the plain requirement.
const APPT_RE = /^(.*?)\s+-\s+(\d{1,2}\s+[A-Za-z]{3}\s+@\s+\d{4}\s*hrs)\s*$/i;
function shapeMedical(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    if (/^PT Test/i.test(t.title)) continue;
    let service = clean(t.title).replace(/^Medical:\s*/i, ''), appt = '';
    const m = service.match(APPT_RE);
    if (m) { service = m[1]; appt = m[2]; }
    if (!groups.has(service)) groups.set(service, { service, note: '', overdue: false, members: [] });
    const g = groups.get(service);
    g.members.push({ rank: t.rank, last: t.last, urgency: t.urgency, appt, details: appt ? '' : t.details || '' });
    if (t.urgency === 'overdue' || /overdue/i.test(service)) g.overdue = true;
  }
  for (const g of groups.values()) {
    const plain = g.members.filter(m => !m.appt);
    g.note = lift(plain);
    for (const m of g.members) { if (m.appt) m.status = m.appt; delete m.appt; delete m.details; delete m.rest; }
    g.members.sort(byLast);
  }
  return [...groups.values()].sort((a, b) => (b.overdue - a.overdue) || (b.members.length - a.members.length));
}

// ── PT Testing ─────────────────────────────────────────────────────────────────
// September writes the due month into the title ("PT Test - due September 26");
// August wrote it into the details ("Due Sep 2026") or wrote an appointment there
// instead. All three still land: overdue, a due-month bucket, or `scheduled` for a
// test with a time but no month. The test time everyone in a bucket shares is the
// bucket's note, which is what a member needs off this page on Saturday morning.
function monthKey(mon, year) {
  const abbr = cap(mon.slice(0, 3));
  const idx = MON_ORDER.indexOf(abbr);
  if (idx < 0) return null;
  const yyyy = year.length === 2 ? `20${year}` : year;
  return { key: `${yyyy}-${String(idx).padStart(2, '0')}`, label: `Due ${MON[abbr]} ${yyyy.slice(2)}` };
}
function shapePt(tasks) {
  const overdue = [], scheduled = [];
  const buckets = new Map();
  for (const t of tasks) {
    if (!/^PT Test/i.test(t.title)) continue;
    const row = { rank: t.rank, last: t.last, urgency: t.urgency, detail: t.details || '', details: t.details || '' };
    if (t.urgency === 'overdue' || /overdue/i.test(t.title)) { overdue.push(row); continue; }
    const mt = t.title.match(/due\s+([A-Za-z]+)\s+(\d{2}|\d{4})\b/i) || (t.details || '').match(/Due\s+([A-Za-z]{3})\s+(\d{4})/);
    const mk = mt && monthKey(mt[1], mt[2]);
    if (!mk) { scheduled.push(row); continue; }
    if (!buckets.has(mk.key)) buckets.set(mk.key, { label: mk.label, sort: mk.key, note: '', thisUta: false, members: [] });
    buckets.get(mk.key).members.push(row);
  }
  const list = [...buckets.values()].sort((a, b) => a.sort.localeCompare(b.sort));
  for (const b of list) {
    b.note = lift(b.members);
    b.thisUta = b.members.some(m => m.urgency === 'this_uta');
    b.members.sort(byLast);
    for (const m of b.members) { delete m.details; delete m.rest; }
  }
  for (const r of [...overdue, ...scheduled]) { r.status = noDot(clean(r.details)); delete r.details; }
  overdue.sort(byLast); scheduled.sort(byLast);
  return { overdue, scheduled, buckets: list };
}

// ── Government travel card ─────────────────────────────────────────────────────
// Two name columns: Statement of Understanding, and the GTC CBT certificate. This
// replaced an SGLI & vRED shaper that looked for 'Update SGLI in MilConnect' and
// 'Update vRED in vMPF'; no cycle has ever held a task by either name, so that slide
// printed two empty columns every month while the twenty GTC and SoU tasks it sits
// next to in the newsletter had no slide at all.
function shapeGtc(tasks) {
  const sou = [], cbt = [];
  for (const t of tasks) {
    const row = { rank: t.rank, last: t.last, detail: t.details || '', details: t.details || '' };
    if (/Statement of Understanding|\bSoU\b/i.test(t.title)) sou.push(row);
    else if (/^GTC\b/i.test(t.title)) cbt.push(row);
  }
  const souNote = lift(sou), cbtNote = lift(cbt);
  for (const r of [...sou, ...cbt]) { delete r.details; delete r.rest; }
  return { sou: sou.sort(byLast), cbt: cbt.sort(byLast), souNote, cbtNote };
}

// ── EPBs / OPBs, and the ACA sessions ──────────────────────────────────────────
// September names the ratee in the title — "EPB - SrA Blake - Closeout 31Mar2026
// (sitting at MSgt Fernandez G.)" — and assigns the task to everyone in the routing
// chain, so per-member rows printed each evaluation twice. A title that parses is
// one row, whoever holds it; the August form ("EPB - Closeout", per member) stays
// one row per member. Officer briefs count: startsWith('EPB') once dropped both
// OPBs on the August 2026 cycle.
//
// ACA feedback sessions are the same slide's business (they are the other half of
// the evaluation cycle) and, like the EPBs, sit on both participants.
const EPB_RE = /^([EO]PB)\s*-\s*(.+?)\s*-\s*Closeout\s+(\d{1,2})\s*([A-Za-z]{3})\s*(\d{4})(?:\s*\(sitting at\s+(.+?)\))?\s*$/i;
function shapeEpbs(tasks) {
  const overdue = [], comingDue = [], seen = new Map();
  const aca = new Map();
  for (const t of tasks) {
    if (/^ACA\b/i.test(t.title)) {
      const pair = clean(t.title).replace(/^ACA(\s+due)?\s*-\s*/i, '');
      if (!aca.has(pair)) aca.set(pair, { pair, details: t.details || '' });
      continue;
    }
    const m = t.title.match(EPB_RE);
    if (!m && !/^[EO]PB\b/i.test(t.title)) continue;
    const key = m ? t.title : `${t.title}|${t.last}|${t.urgency}`;
    if (seen.has(key)) { seen.get(key).who.push(t.last); continue; }
    const ratee = m ? clean(m[2]) : who(t);
    const row = {
      type: (m ? m[1] : t.title.slice(0, 3)).toUpperCase(), ratee,
      rank: m ? ratee.split(' ').slice(0, -1).join(' ') : t.rank, last: m ? ratee.split(' ').pop() : t.last,
      closeout: m ? `${m[3]} ${m[4]} ${m[5]}` : '',
      closeoutKey: m ? `${m[5]}-${String(MON_ORDER.indexOf(cap(m[4]))).padStart(2, '0')}-${m[3].padStart(2, '0')}` : '9999',
      sittingAt: m && m[6] ? clean(m[6]) : '', needs: unstar(t.details), detail: t.details || '',
      who: [t.last], urgency: t.urgency,
    };
    seen.set(key, row);
    (t.urgency === 'overdue' ? overdue : comingDue).push(row);
  }
  const order = (a, b) => a.closeoutKey.localeCompare(b.closeoutKey) || a.ratee.localeCompare(b.ratee);
  const acaRows = [...aca.values()].sort((a, b) => a.pair.localeCompare(b.pair));
  const acaNote = lift(acaRows);
  return { overdue: overdue.sort(order), comingDue: comingDue.sort(order),
           aca: { pairs: acaRows.map(r => r.pair), note: acaNote } };
}

// ── Orders / DTS / AROWS ───────────────────────────────────────────────────────
// Matched on the system named in the title rather than a list of whole titles. The
// list this replaced held four strings ('Complete DTS Voucher', 'Sign RMP in AROWS',
// …) and the live cycle had none of them — it stores 'DTS Voucher', 'Sign RUTA',
// 'Sign Orders', 'AROWS' and 'DTS Authorization' — so the August 2026 slide printed
// "0 open" over sixteen real tasks. A word match survives the wording being edited,
// which whole-title equality did not.
//
// A title held by BROADCAST members or more is a squadron-wide notice. Fifteen is
// well past any list of people who personally owe a signature and well short of a
// 70-member squadron, so the September reminder (73 holders) collapses to a banner
// while four real AROWS orders keep their rows.
const ORDER_RE = /\b(DTS|AROWS|RUTA|Orders)\b/i;
const BROADCAST = 15;
function shapeOrders(tasks) {
  const byTitle = new Map();
  for (const t of tasks) {
    if (!ORDER_RE.test(t.title)) continue;
    if (!byTitle.has(t.title)) byTitle.set(t.title, []);
    byTitle.get(t.title).push(t);
  }
  const dts = [], arows = [], notices = [];
  for (const [title, list] of byTitle) {
    if (list.length >= BROADCAST) { notices.push({ title, details: list[0].details || '', count: list.length }); continue; }
    for (const t of list) {
      const row = { rank: t.rank, name: t.last, issue: t.title, comment: t.details || '', details: t.details || '' };
      (/\bDTS\b/i.test(t.title) ? dts : arows).push(row);
    }
  }
  const dtsNote = lift(dts), arowsNote = lift(arows);
  for (const r of [...dts, ...arows]) { r.comment = r.status; delete r.status; delete r.details; delete r.rest; }
  return { dts, arows, notices, dtsNote, arowsNote };
}

// ── Upgrade training ───────────────────────────────────────────────────────────
// September keeps one 'Upgrade training progress' task per trainee and writes the
// state into the details: "5-level, started March 2026 (6 months in training). CDC
// 5/12. Tasks 0%. CDCs are to be accomplished at home…". The level, start, months,
// CDC and task figures are read out so the slide can print a table with a progress
// bar; the sentence every trainee shares is lifted; what one trainee alone is told
// ("NEEDS SUPERVISOR APPROVAL TO SUBMIT 2096") stays with them. August's
// '5-Level (Shop)' / '7-Level UGT' titles still route.
const PROGRESS_RE = /^(\d)-level,\s*started\s+([A-Za-z]+\s+\d{4})\s*\((\d+)\s+months?\s+in\s+training\)\.?\s*(?:CDCs?\s+([^.]+?)\.\s*)?(?:Tasks\s+(\d+)%\.?\s*)?(.*)$/i;
function shapeUpgrade(tasks) {
  const fiveLevel = [], sevenLevel = [], unlevelled = [], waiting = [], progress = [];
  for (const t of tasks) {
    if (t.title === '7-Level UGT' || /waiting on SSgt/i.test(t.title)) { waiting.push(who(t)); continue; }
    const fromTitle = t.title.match(/^(\d)-Level\b/i);
    if (!fromTitle && !/^Upgrade training/i.test(t.title)) continue;
    const shopMatch = t.title.match(/\(([^)]+)\)/);
    const m = (t.details || '').match(PROGRESS_RE);
    const level = m ? m[1] : fromTitle ? fromTitle[1] : '';
    const row = { shop: shopMatch ? shopMatch[1] : t.shop, rank: t.rank, last: t.last, level,
      started: m ? m[2] : '', months: m ? Number(m[3]) : null, cdc: m && m[4] ? m[4].trim() : '',
      tasks: m && m[5] != null ? Number(m[5]) : null, details: unstar(m ? m[6] : t.details), detail: t.details || '' };
    progress.push(row);
    (level === '5' ? fiveLevel : level === '7' ? sevenLevel : unlevelled).push(row);
  }
  const note = lift(progress);
  for (const r of progress) { delete r.details; delete r.rest; }
  fiveLevel.sort(byLast); sevenLevel.sort(byLast); unlevelled.sort(byLast); waiting.sort();
  return { fiveLevel, sevenLevel, unlevelled, waiting, note };
}

// ── Inbound / Outbound ─────────────────────────────────────────────────────────
// The accession pipeline (BMT / tech school / OTS) and PME, selected by subject, not
// by taking the whole Upcoming category. Upcoming is a grab-bag: alongside a
// member's school dates it holds squadron-wide notices, and "Family Day" is assigned
// to all ~70 members — which is how this slide came to print 84 rows against the
// newsletter's 16. Filtering on the informational flag would not help; school dates
// carry urgency 'info' too, so that empties the slide instead.
//
// An allow-list is the right shape here (a new kind of notice must not land on a slide
// about airmen leaving for training), but it can hide a school title nobody thought of.
// So what is left out comes back as `other` rather than vanishing.
const PME_RE = /\bNCOA\b|Academy|\bALS\b|\bNCOLDP\b/i;
const SCHOOL_RE = /\bBMT\b|Tech(nical)? School|\bOTS\b|\bTLN\b|Academy|\bNCOA\b|\bALS\b|\bNCOLDP\b/i;
function shapeInbound(tasks) {
  const bmt = [], pme = [], other = [];
  for (const t of tasks) {
    const row = { rank: t.rank, last: t.last, title: t.title, details: t.details || '', shop: t.shop };
    if (/DFT/.test(t.title) || !SCHOOL_RE.test(t.title)) other.push(row);
    else if (PME_RE.test(t.title)) pme.push(row);
    else bmt.push(row);
  }
  const bmtNote = lift(bmt), pmeNote = lift(pme);
  for (const r of [...bmt, ...pme]) { delete r.details; delete r.rest; }
  return { bmt: bmt.sort(byLast), pme: pme.sort(byLast), other, bmtNote, pmeNote };
}

// TAP — the Transition Assistance Program, i.e. members on their way out. It lives in
// the admin category but belongs beside the airmen coming in.
function shapeTap(tasks) {
  const members = tasks.filter(t => /^TAP\b/i.test(t.title))
    .map(t => ({ rank: t.rank, last: t.last, details: t.details || '' }));
  const note = lift(members);
  for (const r of members) { delete r.details; delete r.rest; }
  return { members: members.sort(byLast), note };
}

// ── Quarterly awards ───────────────────────────────────────────────────────────
// Who still owes a 1206. The awards slide's prose and schedule stay hand-edited;
// the names come off the tracker so the call to action carries a list, not a plea.
function shapeAwards(tasks) {
  const members = tasks.filter(t => /\b1206s?\b/i.test(t.title) || /\b1206'?s\b/i.test(t.title))
    .map(t => ({ rank: t.rank, last: t.last, title: t.title, details: t.details || '' }));
  const titles = new Map();
  for (const m of members) titles.set(m.title, (titles.get(m.title) || 0) + 1);
  const title = [...titles].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const note = lift(members);
  for (const r of members) { delete r.details; delete r.rest; delete r.title; }
  return { members: members.sort(byLast), title, note };
}

// ── Work Orders ────────────────────────────────────────────────────────────────
function shapeWorkOrders(rows) {
  const byShop = new Map();
  for (const r of rows) {
    if (!r.shop || !r.title) continue;
    if (!byShop.has(r.shop)) byShop.set(r.shop, []);
    byShop.get(r.shop).push({ wo: r.wo || '', title: r.title, details: r.details || '' });
  }
  return [...byShop.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([shop, items]) => ({ shop, items }));
}

// UTA Timeline — grouped by day, then laid out as a horizontal time grid: hours across
// the top, each event a bar under the hours it occupies. That is how the newsletter
// draws the UTA, and the shape of it carries information a vertical list cannot — that
// the Manning Doc meeting runs *inside* the afternoon admin block, that BCA
// measurements are staggered against it. Overlapping events are packed into lanes.
//
// The grid is built here rather than in the slide so it can be tested without parsing
// HTML: the slide only turns startMin/endMin/lane into grid-column and grid-row.
const SLOT = 15;   // minutes per grid column — fine enough for :30 starts
const MIN_DRAW = 60;  // minutes a bar is drawn at minimum, so its label has room

// Colour category. Ten of September's 27 events carry no kind at all (Lunch,
// Building Cleanup, PT Testing, the reenlistment…), so the kind is consulted first
// and the title fills in behind it. 'other' is the honest fallback, not grey-by-default.
const CAT_BY_KIND = { formation: 'formation', training: 'training', meeting: 'meeting',
                      briefing: 'meeting', medical: 'medical', emphasis: 'emphasis' };
function categorize(kind, title) {
  if (CAT_BY_KIND[kind]) return CAT_BY_KIND[kind];
  const t = String(title || '').toLowerCase();
  if (/\b(lunch|breakfast|dinner|chow)\b/.test(t)) return 'meal';
  if (/clean-?up/.test(t)) return 'cleanup';
  if (/\bpt\b|fitness/.test(t)) return 'fitness';
  if (/reenlist|ceremony|award|retire/.test(t)) return 'ceremony';
  if (/formation|roll call/.test(t)) return 'formation';
  if (/training|breakout/.test(t)) return 'training';
  if (/meeting|briefing|\bbrief\b/.test(t)) return 'meeting';
  if (/immuni[sz]|\blabs?\b|medical|dental|audiogram/.test(t)) return 'medical';
  return 'other';
}

// One short line per bar. The admin block's details name eleven systems and a LOTO
// reminder; printed whole they were the grey blob the slide was criticised for. A
// detail that fits is kept as is; a long one is cut at a word or slash boundary.
function summarize(details, max = 64) {
  const s = String(details || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const sentence = /^(.{16,}?[.!?])\s/.exec(s);
  if (sentence && sentence[1].length <= max) return sentence[1];
  let cut = Math.max(s.lastIndexOf(' ', max), s.lastIndexOf('/', max));
  if (cut < max / 2) cut = max;
  return s.slice(0, cut).replace(/[\s/,;:\-–]+$/, '') + '…';
}

// '0730' and '07:30' both appear in the schedule tables; both mean 450.
function toMinutes(s) {
  const m = String(s || '').match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const floorHour = (m) => Math.floor(m / 60) * 60;
const ceilHour = (m) => Math.ceil(m / 60) * 60;
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + String(m % 60).padStart(2, '0');

// Greedy interval packing: reuse the first lane whose last bar has already finished.
// Events arrive sorted by start, which is what makes one pass enough. Occupancy is
// the DRAWN end, not the true end: a 0800 formation with no end time is drawn an
// hour wide so its label fits, and the 0830 reenlistment must then take another
// lane rather than land on top of that label — which is exactly what the September
// slide did before this, printing "Reenlistment" across "Formation / Roll Call".
function assignLanes(events) {
  const laneEnds = [];
  for (const e of events) {
    let lane = laneEnds.findIndex(end => end <= e.startMin);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = e.drawEnd;
    e.lane = lane;
  }
  return laneEnds.length;
}

function buildDay(day, rows) {
  const timed = [], untimed = [];
  for (const r of rows) {
    const startMin = toMinutes(r.start);
    if (startMin === null) { untimed.push(r); continue; }
    // A start with no end still has to be visible, so give it one slot — and every
    // bar is DRAWN at least MIN_DRAW wide so a title fits without overflow tricks.
    // endMin stays the true span (the time label prints it); drawEnd is the box.
    const endMin = Math.max(toMinutes(r.end) ?? 0, startMin + SLOT);
    const drawEnd = Math.max(endMin, startMin + MIN_DRAW);
    timed.push({ ...r, startMin, endMin, drawEnd,
      cat: categorize(r.type, r.title), summary: summarize(r.details) });
  }
  // Longer first on a tie, so the squadron-wide block holds lane 0 and the short
  // exception that runs inside it drops to lane 1 — not the other way round.
  timed.sort((a, b) => a.startMin - b.startMin || (b.endMin - b.startMin) - (a.endMin - a.startMin));
  const laneCount = assignLanes(timed);

  const from = timed.length ? floorHour(Math.min(...timed.map(e => e.startMin))) : 0;
  const to = timed.length ? ceilHour(Math.max(...timed.map(e => e.drawEnd))) : 0;
  const ticks = [];
  for (let m = from; m < to; m += 60) ticks.push(hhmm(m));

  return { day, events: timed, untimed, grid: { from, to, ticks, laneCount, slot: SLOT,
    cols: Math.max(1, (to - from) / SLOT) } };
}

function shapeTimeline(rows) {
  const days = { Friday: [], Saturday: [], Sunday: [] };
  for (const r of rows) {
    if (!days[r.day] || !r.title) continue;
    days[r.day].push({ shop: r.shop || '', start: r.start || '', end: r.end || '', title: r.title, details: r.details || '', type: (r.type || '').toLowerCase() });
  }
  return ['Friday', 'Saturday', 'Sunday']
    .filter(d => days[d].length)
    .map(d => buildDay(d, days[d]));
}

module.exports = {
  liftCommon, shapeCbts, shapeMedical, shapePt, shapeGtc, shapeEpbs, shapeOrders, shapeUpgrade,
  shapeInbound, shapeTap, shapeAwards, shapeWorkOrders, shapeTimeline, summarize, categorize,
};
