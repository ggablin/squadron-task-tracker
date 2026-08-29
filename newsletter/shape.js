// newsletter/shape.js — pure task-shaping for from-db.js: turns task rows into the
// per-slide structures render.js consumes. Kept free of SQL so it can be unit-tested.
//
// All shapers take NORMALIZED rows:
//   task:      { rank, last, title, details, urgency, shop }   (urgency = overdue|this_uta|next_uta|future|info)
//   workOrder: { shop, wo, title, details }
//   timeline:  { shop, day, start, end, title, details, type }

const URG_ORDER = { overdue: 0, this_uta: 1, next_uta: 2, future: 3, info: 4 };
const MON = { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June',
              Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December' };
const MON_ORDER = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const byLast = (a, b) => a.last.localeCompare(b.last);

// CBTs — group by type; split "1 hr — 5 Months Overdue" into duration + status.
function shapeCbts(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    if (!groups.has(t.title)) groups.set(t.title, { type: t.title, duration: '', members: [] });
    const g = groups.get(t.title);
    let duration = '', status = t.details || '';
    if ((t.details || '').includes('—')) {
      const [d, s] = t.details.split('—');
      duration = d.trim(); status = s.trim();
    }
    if (duration && !g.duration) g.duration = duration;
    g.members.push({ rank: t.rank, last: t.last, status, urgency: t.urgency });
  }
  for (const g of groups.values()) {
    g.members.sort((a, b) => (URG_ORDER[a.urgency] ?? 9) - (URG_ORDER[b.urgency] ?? 9) || a.last.localeCompare(b.last));
  }
  return [...groups.values()];
}

// Medical & Dental — per member, excluding PT Test (its own slide).
function shapeMedical(tasks) {
  const byMember = new Map();
  for (const t of tasks) {
    if (t.title.startsWith('PT Test')) continue;
    const key = `${t.rank}|${t.last}|${t.shop}`;
    if (!byMember.has(key)) byMember.set(key, { rank: t.rank, last: t.last, items: [] });
    const det = t.details ? ` ${t.details}` : '';
    byMember.get(key).items.push(`${t.title}${det}`.trim());
  }
  return [...byMember.values()].sort(byLast);
}

// PT Testing — overdue callout, tests booked for this drill, then buckets by due month.
//
// Three destinations, and every PT task reaches one of them. The `continue` that used
// to stand where `scheduled` is now filled dropped any task whose details did not spell
// "Due Mon YYYY", and the live details are appointment times ("PT Test Scheduled
// Saturday @ 1030hrs") — so all eleven were discarded and the slide printed its empty
// note. The newsletter puts the test time beside the name, which is the one thing a
// member needs off this page on drill morning.
function shapePt(tasks) {
  const overdue = [], scheduled = [];
  const buckets = new Map();
  for (const t of tasks) {
    if (!t.title.startsWith('PT Test')) continue;
    const who = { rank: t.rank, last: t.last, detail: t.details || '' };
    if (t.urgency === 'overdue') { overdue.push(who); continue; }
    const mt = (t.details || '').match(/Due (\w{3}) (\d{4})/);
    if (!mt) { scheduled.push(who); continue; }
    const [, mon, year] = mt;
    const key = `${year}-${String(MON_ORDER.indexOf(mon)).padStart(2, '0')}`;
    if (!buckets.has(key)) buckets.set(key, { label: `Due ${MON[mon] || mon} ${year.slice(2)}`, sort: key, members: [] });
    buckets.get(key).members.push({ rank: t.rank, last: t.last });
  }
  const list = [...buckets.values()].sort((a, b) => a.sort.localeCompare(b.sort));
  for (const b of list) b.members.sort(byLast);
  scheduled.sort(byLast);
  return { overdue, scheduled, buckets: list };
}

// Government travel card — two name columns: Statement of Understanding, and the
// GTC CBT certificate. This replaced an SGLI & vRED shaper that looked for 'Update
// SGLI in MilConnect' and 'Update vRED in vMPF'; no cycle has ever held a task by
// either name, so that slide printed two empty columns every month while the twenty
// GTC and SoU tasks it sits next to in the newsletter had no slide at all.
function shapeGtc(tasks) {
  const sou = [], cbt = [];
  for (const t of tasks) {
    const row = { rank: t.rank, last: t.last, detail: t.details || '' };
    if (/Statement of Understanding|\bSoU\b/i.test(t.title)) sou.push(row);
    else if (/^GTC\b/i.test(t.title)) cbt.push(row);
  }
  return { sou: sou.sort(byLast), cbt: cbt.sort(byLast) };
}

// EPBs / OPBs — overdue vs coming due. Officer briefs count: the slide has said
// "EPBs / OPBs" since it was written, but startsWith('EPB') quietly dropped both
// OPB - Closeout rows on the August 2026 cycle.
function shapeEpbs(tasks) {
  const overdue = [], comingDue = [];
  for (const t of tasks) {
    if (!/^[EO]PB\b/.test(t.title)) continue;
    const row = { rank: t.rank, last: t.last, detail: t.details || '' };
    (t.urgency === 'overdue' ? overdue : comingDue).push(row);
  }
  return { overdue, comingDue };
}

// Orders / DTS / AROWS — split into DTS and AROWS tables.
//
// Matched on the system named in the title rather than a list of whole titles. The
// list this replaced held four strings ('Complete DTS Voucher', 'Sign RMP in AROWS',
// …) and the live cycle had none of them — it stores 'DTS Voucher', 'Sign RUTA',
// 'Sign Orders', 'AROWS' and 'DTS Authorization' — so the August 2026 slide printed
// "0 open" over sixteen real tasks. A word match survives the wording being edited,
// which whole-title equality did not.
const ORDER_RE = /\b(DTS|AROWS|RUTA|Orders)\b/i;
function shapeOrders(tasks) {
  const dts = [], arows = [];
  for (const t of tasks) {
    if (!ORDER_RE.test(t.title)) continue;
    const row = { rank: t.rank, name: t.last, issue: t.title, comment: t.details || '' };
    (/\bDTS\b/i.test(t.title) ? dts : arows).push(row);
  }
  return { dts, arows };
}

// Upgrade Training — 5-level / 7-level / waiting list.
function shapeUpgrade(tasks) {
  const fiveLevel = [], sevenLevel = [], waiting = [];
  for (const t of tasks) {
    if (t.title === '7-Level UGT') { waiting.push(t.last); continue; }
    const shopMatch = t.title.match(/\(([^)]+)\)/);
    const shop = shopMatch ? shopMatch[1] : t.shop;
    const row = { shop, rank: t.rank, last: t.last, detail: t.details || '' };
    if (t.title.startsWith('5-Level')) fiveLevel.push(row);
    else if (t.title.startsWith('7-Level')) sevenLevel.push(row);
  }
  return { fiveLevel, sevenLevel, waiting };
}

// Inbound / Outbound — the accession pipeline (BMT / tech school / OTS) and PME.
//
// Selected by subject, not by taking the whole Upcoming category. Upcoming is a
// grab-bag: alongside a member's school dates it holds squadron-wide notices, and
// "Family Day" is assigned to all ~70 members — which is how this slide came to print
// 84 rows against the newsletter's 16. Filtering on the informational flag would not
// help; school dates carry urgency 'info' too, so that empties the slide instead.
//
// An allow-list is the right shape here (a new kind of notice must not land on a slide
// about airmen leaving for training), but it can hide a school title nobody thought of.
// So what is left out comes back as `other` rather than vanishing — the DFT roster,
// which belongs on the MEETs/RADR slide, arrives there too.
const PME_RE = /\bNCOA\b|Academy|\bALS\b|\bNCOLDP\b/i;
const SCHOOL_RE = /\bBMT\b|Tech(nical)? School|\bOTS\b|\bTLN\b|Academy|\bNCOA\b|\bALS\b|\bNCOLDP\b/i;
function shapeInbound(tasks) {
  const bmt = [], pme = [], other = [];
  for (const t of tasks) {
    const row = { rank: t.rank, last: t.last, title: t.title,
      detail: `${t.title} — ${t.details || ''}`.replace(/ — $/, ''), shop: t.shop };
    if (/DFT/.test(t.title) || !SCHOOL_RE.test(t.title)) other.push(row);
    else if (PME_RE.test(t.title)) pme.push(row);
    else bmt.push(row);
  }
  return { bmt, pme, other };
}

// Work Orders — grouped per shop.
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
// Events arrive sorted by start, which is what makes one pass enough.
function assignLanes(events) {
  const laneEnds = [];
  for (const e of events) {
    let lane = laneEnds.findIndex(end => end <= e.startMin);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = e.endMin;
    e.lane = lane;
  }
  return laneEnds.length;
}

function buildDay(day, rows) {
  const timed = [], untimed = [];
  for (const r of rows) {
    const startMin = toMinutes(r.start);
    if (startMin === null) { untimed.push(r); continue; }
    // A start with no end still has to be visible, so give it one slot.
    const endMin = Math.max(toMinutes(r.end) ?? 0, startMin + SLOT);
    timed.push({ ...r, startMin, endMin });
  }
  // Longer first on a tie, so the squadron-wide block holds lane 0 and the short
  // exception that runs inside it drops to lane 1 — not the other way round.
  timed.sort((a, b) => a.startMin - b.startMin || (b.endMin - b.startMin) - (a.endMin - a.startMin));
  const laneCount = assignLanes(timed);

  const from = timed.length ? floorHour(Math.min(...timed.map(e => e.startMin))) : 0;
  const to = timed.length ? ceilHour(Math.max(...timed.map(e => e.endMin))) : 0;
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
  shapeCbts, shapeMedical, shapePt, shapeGtc, shapeEpbs, shapeOrders, shapeUpgrade, shapeInbound,
  shapeWorkOrders, shapeTimeline,
};
