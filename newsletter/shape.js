// newsletter/shape.js — pure task-shaping shared by from-sample.js (offline) and
// from-db.js (live), so both produce an identical `data` object for render.js.
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

// PT Testing — overdue callout + buckets by due month parsed from details.
function shapePt(tasks) {
  const overdue = [];
  const buckets = new Map();
  for (const t of tasks) {
    if (!t.title.startsWith('PT Test')) continue;
    if (t.urgency === 'overdue') { overdue.push({ rank: t.rank, last: t.last, detail: t.details || '' }); continue; }
    const mt = (t.details || '').match(/Due (\w{3}) (\d{4})/);
    if (!mt) continue;
    const [, mon, year] = mt;
    const key = `${year}-${String(MON_ORDER.indexOf(mon)).padStart(2, '0')}`;
    if (!buckets.has(key)) buckets.set(key, { label: `Due ${MON[mon] || mon} ${year.slice(2)}`, sort: key, members: [] });
    buckets.get(key).members.push({ rank: t.rank, last: t.last });
  }
  const list = [...buckets.values()].sort((a, b) => a.sort.localeCompare(b.sort));
  for (const b of list) b.members.sort(byLast);
  return { overdue, buckets: list };
}

// SGLI & vRED — two name columns.
function shapeSgliVred(tasks) {
  const sgli = [], vred = [];
  for (const t of tasks) {
    if (t.title === 'Update SGLI in MilConnect') sgli.push({ rank: t.rank, last: t.last });
    else if (t.title === 'Update vRED in vMPF')   vred.push({ rank: t.rank, last: t.last });
  }
  return { sgli: sgli.sort(byLast), vred: vred.sort(byLast) };
}

// EPBs / OPBs — overdue vs coming due.
function shapeEpbs(tasks) {
  const overdue = [], comingDue = [];
  for (const t of tasks) {
    if (!t.title.startsWith('EPB')) continue;
    const row = { rank: t.rank, last: t.last, detail: t.details || '' };
    (t.urgency === 'overdue' ? overdue : comingDue).push(row);
  }
  return { overdue, comingDue };
}

// Orders / DTS / AROWS — split into DTS and AROWS tables.
const ORDER_TITLES = ['Complete DTS Voucher', 'Sign RMP in AROWS', 'Sign RUTA in AROWS', 'Sign & Submit Orders in AROWS'];
function shapeOrders(tasks) {
  const dts = [], arows = [];
  for (const t of tasks) {
    if (!ORDER_TITLES.includes(t.title)) continue;
    const row = { rank: t.rank, name: t.last, issue: t.title, comment: t.details || '' };
    (t.title.includes('DTS') ? dts : arows).push(row);
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

// Inbound / Outbound — BMT/TS/OTS/Academy + PME (DFT roster lives on the static MEETs/RADR slide).
function shapeInbound(tasks) {
  const bmt = [], pme = [];
  for (const t of tasks) {
    if (/DFT/.test(t.title)) continue;
    const row = { rank: t.rank, last: t.last, detail: `${t.title} — ${t.details || ''}`.replace(/ — $/, ''), shop: t.shop };
    if (/NCOA|Academy/.test(t.title)) pme.push(row);
    else bmt.push(row);
  }
  return { bmt, pme };
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

// UTA Timeline — grouped by day, sorted by start time.
function shapeTimeline(rows) {
  const days = { Friday: [], Saturday: [], Sunday: [] };
  for (const r of rows) {
    if (!days[r.day] || !r.title) continue;
    days[r.day].push({ shop: r.shop || '', start: r.start || '', end: r.end || '', title: r.title, details: r.details || '', type: (r.type || '').toLowerCase() });
  }
  const order = (a, b) => (a.start || '').localeCompare(b.start || '');
  return ['Friday', 'Saturday', 'Sunday'].filter(d => days[d].length).map(d => ({ day: d, events: days[d].sort(order) }));
}

module.exports = {
  shapeCbts, shapeMedical, shapePt, shapeSgliVred, shapeEpbs, shapeOrders, shapeUpgrade, shapeInbound,
  shapeWorkOrders, shapeTimeline,
};
