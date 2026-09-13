// Leadership Brief — one payload for the end-of-drill dashboard (/brief).
//
// The Sunday leadership meeting walks every shop: what got done, what didn't,
// where the work orders stand, who was here. Today that is someone at a laptop
// clicking through My Shop. This module answers all of it in one read so the
// dashboard can flip between shops instantly and refresh in the background
// while supervisors are still ticking boxes.
//
// loadBrief() runs six flat queries; shapeBrief() is pure and does every
// rollup in JS, so the arithmetic — which is easy to get quietly wrong — is
// unit-tested without Postgres and matches the Squadron tab's rules exactly:
//   · informational tasks (notices, upgrade training, "upcoming") are shown
//     but never counted (lib/informational.js)
//   · critical = due this drill or overdue
//   · a member is at drill unless attendance says otherwise (lib/presence.js)

const attendance = require('./attendance');
const { PRESENT_STATUSES } = require('./presence');
const { informationalSql, criticalSql } = require('./informational');

const WO_STATUSES = ['open', 'in_progress', 'complete'];

async function loadBrief(db) {
  const { rows: [cycle] } = await db.query(
    `SELECT id, name, status, period_count,
            to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(end_date,   'YYYY-MM-DD') AS end_date
     FROM uta_cycles WHERE is_current = true LIMIT 1`);
  if (!cycle) return null;

  const [shops, members, categories, tasks, workOrders, marks] = await Promise.all([
    db.query(`SELECT id, name FROM shops ORDER BY name`).then(r => r.rows),
    db.query(`SELECT id, shop_id, rank, last_name, first_name, role
              FROM members WHERE active = true ORDER BY last_name, first_name`).then(r => r.rows),
    db.query(`SELECT code, label, sort_order FROM task_categories ORDER BY sort_order, code`).then(r => r.rows),
    db.query(`SELECT t.id, t.member_id, cat.code AS category_code, t.title, t.details,
                     t.urgency, t.is_flagged, t.appt_day, t.appt_time,
                     ${informationalSql('cat')} AS informational,
                     ${criticalSql()} AS critical,
                     COALESCE(tc.state, 'none') AS state, tc.note
              FROM tasks t
              JOIN task_categories cat ON cat.id = t.category_id
              LEFT JOIN task_completions tc ON tc.task_id = t.id
              WHERE t.uta_cycle_id = $1
              ORDER BY cat.sort_order, t.is_flagged DESC NULLS LAST, t.sort_order, t.title`, [cycle.id]).then(r => r.rows),
    db.query(`SELECT id, shop_id, wo_number, title, details, status, day, start_time, end_time
              FROM shop_events
              WHERE uta_cycle_id = $1 AND event_type = 'work_order'
              ORDER BY shop_id, wo_number NULLS LAST, sort_order, id`, [cycle.id]).then(r => r.rows),
    db.query(`SELECT member_id, period, status, note FROM attendance WHERE uta_cycle_id = $1`, [cycle.id]).then(r => r.rows),
  ]);

  return shapeBrief({ cycle, shops, members, categories, tasks, workOrders, marks });
}

// ── pure shaping ──────────────────────────────────────────────────────────────

const zeroCounts = () => ({ total: 0, done: 0, critical: 0, critical_done: 0 });

function addTask(counts, t) {
  if (t.informational) return;
  counts.total++;
  if (t.state === 'done') counts.done++;
  if (t.critical) {
    counts.critical++;
    if (t.state === 'done') counts.critical_done++;
  }
}

// Every rollup comes in an all-members and an at-drill flavour, plus a
// per-category split of each, so the dashboard's scope toggle and category
// filter are pure client-side selection over one payload.
function makeRollup(categories) {
  const r = { all: zeroCounts(), present: zeroCounts(), by_category: {} };
  for (const c of categories) r.by_category[c.code] = { all: zeroCounts(), present: zeroCounts() };
  return r;
}
function rollTask(rollup, t, memberPresent) {
  addTask(rollup.all, t);
  if (memberPresent) addTask(rollup.present, t);
  const cat = rollup.by_category[t.category_code]
    || (rollup.by_category[t.category_code] = { all: zeroCounts(), present: zeroCounts() });
  addTask(cat.all, t);
  if (memberPresent) addTask(cat.present, t);
}

function woCounts(list) {
  const c = { open: 0, in_progress: 0, complete: 0, total: list.length };
  for (const w of list) if (WO_STATUSES.includes(w.status)) c[w.status]++;
  return c;
}

function shapeBrief({ cycle, shops, members, categories, tasks, workOrders, marks }) {
  const periodCount = attendance.periodCountFor(cycle);
  const periods = attendance.periodLabels(cycle.start_date, periodCount)
    .map(p => ({ period: p.period, label: p.label, day: p.day, half: p.half }));

  // Attendance per member: marks, presence, and the reason if away.
  const marksBy = new Map();
  for (const m of marks) {
    if (!marksBy.has(m.member_id)) marksBy.set(m.member_id, []);
    marksBy.get(m.member_id).push(m);
  }
  const tasksBy = new Map();
  for (const t of tasks) {
    if (!tasksBy.has(t.member_id)) tasksBy.set(t.member_id, []);
    tasksBy.get(t.member_id).push(t);
  }

  const shapedMembers = members.map(m => {
    const mine = (marksBy.get(m.id) || []).slice().sort((a, b) => a.period - b.period)
      .filter(x => x.period >= 1 && x.period <= periodCount);
    const present = !mine.length || mine.some(x => PRESENT_STATUSES.includes(x.status));
    const awayStatuses = present ? [] : [...new Set(mine.map(x => x.status))];
    const notes = [...new Set(mine.map(x => x.note).filter(Boolean))];
    const myTasks = (tasksBy.get(m.id) || []).map(t => ({
      id: t.id, title: t.title, category_code: t.category_code, urgency: t.urgency,
      state: t.state, informational: !!t.informational, critical: !!t.critical,
      is_flagged: !!t.is_flagged, details: t.details || null, note: t.note || null,
      appt_day: t.appt_day || null, appt_time: t.appt_time || null,
    }));
    const counts = zeroCounts();
    for (const t of myTasks) addTask(counts, t);
    return {
      id: m.id, shop_id: m.shop_id, rank: m.rank, last_name: m.last_name, first_name: m.first_name,
      role: m.role, present,
      away_statuses: awayStatuses,
      away_labels: awayStatuses.map(attendance.statusLabelFor),
      away_note: notes.join('; ') || null,
      marks: mine.map(x => ({ period: x.period, status: x.status, pay: attendance.payCodeFor(x.status) })),
      marked_periods: mine.length,
      tasks: myTasks,
      counts,
    };
  });

  const membersByShop = new Map();
  for (const m of shapedMembers) {
    if (!membersByShop.has(m.shop_id)) membersByShop.set(m.shop_id, []);
    membersByShop.get(m.shop_id).push(m);
  }
  const wosByShop = new Map();
  for (const w of workOrders) {
    if (!wosByShop.has(w.shop_id)) wosByShop.set(w.shop_id, []);
    wosByShop.get(w.shop_id).push(w);
  }

  const squadron = { tasks: makeRollup(categories), members: { total: 0, present: 0 },
                     attendance: { marked: 0, total: 0 }, work_orders: woCounts([]) };
  const allWos = [];

  const shapedShops = shops.map(s => {
    const mems = membersByShop.get(s.id) || [];
    const wos = (wosByShop.get(s.id) || []).map(w => ({
      id: w.id, wo_number: w.wo_number, title: w.title, details: w.details || null,
      status: w.status, day: w.day || null, start_time: w.start_time || null, end_time: w.end_time || null,
      shop_id: s.id, shop_name: s.name,
    }));
    allWos.push(...wos);
    const rollup = makeRollup(categories);
    let marked = 0;
    for (const m of mems) {
      for (const t of m.tasks) rollTask(rollup, t, m.present);
      marked += m.marked_periods;
    }
    const present = mems.filter(m => m.present).length;
    // Squadron totals accumulate from the same member loop so they cannot
    // disagree with the sum of the shop cards.
    for (const m of mems) for (const t of m.tasks) rollTask(squadron.tasks, t, m.present);
    squadron.members.total += mems.length;
    squadron.members.present += present;
    squadron.attendance.marked += marked;
    squadron.attendance.total += mems.length * periodCount;

    return {
      id: s.id, name: s.name,
      supervisors: mems.filter(m => m.role === 'supervisor')
        .map(m => ({ id: m.id, rank: m.rank, last_name: m.last_name, first_name: m.first_name })),
      members: mems,
      member_count: mems.length,
      present_count: present,
      tasks: rollup,
      work_orders: wos,
      work_order_counts: woCounts(wos),
      attendance: { marked, total: mems.length * periodCount },
    };
  });
  squadron.work_orders = woCounts(allWos);
  squadron.away = shapedMembers.filter(m => !m.present).map(m => ({
    id: m.id, rank: m.rank, last_name: m.last_name, first_name: m.first_name,
    shop_id: m.shop_id, shop_name: (shops.find(s => s.id === m.shop_id) || {}).name || null,
    away_labels: m.away_labels, away_note: m.away_note,
  }));

  return {
    cycle: {
      id: cycle.id, name: cycle.name, status: cycle.status,
      start_date: cycle.start_date || null, end_date: cycle.end_date || null,
      period_count: periodCount, periods,
    },
    generated_at: new Date().toISOString(),
    categories: categories.map(c => ({ code: c.code, label: c.label })),
    squadron,
    shops: shapedShops,
  };
}

module.exports = { loadBrief, shapeBrief, WO_STATUSES };
