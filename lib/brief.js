// Leadership Brief — one payload for the end-of-drill dashboard (/brief).
//
// The Sunday leadership meeting walks every shop: what got done, what didn't,
// where the work orders stand, who was here. Today that is someone at a laptop
// clicking through My Shop. This module answers all of it in one read so the
// dashboard can flip between shops instantly and refresh in the background
// while supervisors are still ticking boxes.
//
// loadBrief() runs a handful of flat queries; shapeBrief() is pure and does
// every rollup in JS, so the arithmetic — which is easy to get quietly wrong —
// is unit-tested without Postgres and matches the Squadron tab's rules exactly:
//   · informational tasks (notices, upgrade training, "upcoming") are shown
//     but never counted (lib/informational.js)
//   · critical = due this drill or overdue
//   · a member is at drill unless attendance says otherwise (lib/presence.js)
//
// Beyond the current cycle it also carries: end-of-cycle completion for the
// last HISTORY_CYCLES archived drills (deltas and trend lines), when this
// drill's boxes were ticked (a timeline by drill period), the work-order
// status log (what closed this weekend, and the closing notes), and each
// member's sign-in state (adoption).

const attendance = require('./attendance');
const { PRESENT_STATUSES } = require('./presence');
const { informationalSql, criticalSql } = require('./informational');

const WO_STATUSES = ['open', 'in_progress', 'complete'];
const HISTORY_CYCLES = 6;
// Timestamps are stored as UTC (production sets no TZ); the drill happens here.
const LOCAL_TZ = 'America/New_York';

async function loadBrief(db) {
  const { rows: [cycle] } = await db.query(
    `SELECT id, name, status, period_count,
            to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(end_date,   'YYYY-MM-DD') AS end_date
     FROM uta_cycles WHERE is_current = true LIMIT 1`);
  if (!cycle) return null;

  const [shops, members, categories, tasks, workOrders, marks, history, completions, woLog] = await Promise.all([
    db.query(`SELECT id, name FROM shops ORDER BY name`).then(r => r.rows),
    db.query(`SELECT id, shop_id, rank, last_name, first_name, role,
                     NOT must_change_password AS activated,
                     to_char(last_login_at AT TIME ZONE 'UTC' AT TIME ZONE '${LOCAL_TZ}', 'YYYY-MM-DD') AS last_login_day
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
    db.query(`SELECT id, shop_id, wo_number, title, details, status, day, start_time, end_time,
                     to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE '${LOCAL_TZ}', 'YYYY-MM-DD') AS created_day
              FROM shop_events
              WHERE uta_cycle_id = $1 AND event_type = 'work_order'
              ORDER BY shop_id, wo_number NULLS LAST, sort_order, id`, [cycle.id]).then(r => r.rows),
    db.query(`SELECT member_id, period, status, note FROM attendance WHERE uta_cycle_id = $1`, [cycle.id]).then(r => r.rows),
    // End-of-cycle completion for archived drills, per shop. Members are joined
    // as they are today for shop placement; a member who has since left still
    // counts toward the shop they were in (their shop_id is what it is now).
    db.query(`SELECT c.id AS cycle_id, c.name, c.created_at, m.shop_id,
                     COUNT(t.id) FILTER (WHERE NOT ${informationalSql('cat')})::int AS total,
                     COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql('cat')})::int AS done
              FROM uta_cycles c
              JOIN tasks t ON t.uta_cycle_id = c.id
              JOIN task_categories cat ON cat.id = t.category_id
              JOIN members m ON m.id = t.member_id
              LEFT JOIN task_completions tc ON tc.task_id = t.id
              WHERE c.status = 'archived'
              GROUP BY c.id, c.name, c.created_at, m.shop_id
              ORDER BY c.created_at DESC, c.id DESC`).then(r => r.rows),
    // When each box was ticked, in local time, so the timeline can bucket by
    // drill period. Only current-cycle, countable, done tasks.
    db.query(`SELECT m.shop_id,
                     to_char(tc.updated_at AT TIME ZONE 'UTC' AT TIME ZONE '${LOCAL_TZ}', 'YYYY-MM-DD') AS day,
                     EXTRACT(HOUR FROM tc.updated_at AT TIME ZONE 'UTC' AT TIME ZONE '${LOCAL_TZ}')::int AS hour
              FROM task_completions tc
              JOIN tasks t ON t.id = tc.task_id
              JOIN task_categories cat ON cat.id = t.category_id
              JOIN members m ON m.id = t.member_id
              WHERE t.uta_cycle_id = $1 AND tc.state = 'done' AND NOT ${informationalSql('cat')}`, [cycle.id]).then(r => r.rows),
    db.query(`SELECT l.shop_event_id, l.status, l.note,
                     to_char(l.created_at AT TIME ZONE 'UTC' AT TIME ZONE '${LOCAL_TZ}', 'YYYY-MM-DD') AS day,
                     to_char(l.created_at AT TIME ZONE 'UTC' AT TIME ZONE '${LOCAL_TZ}', 'HH24:MI') AS time,
                     m.rank, m.last_name
              FROM shop_event_status_log l
              JOIN shop_events e ON e.id = l.shop_event_id
              LEFT JOIN members m ON m.id = l.updated_by_id
              WHERE e.uta_cycle_id = $1
              ORDER BY l.created_at ASC, l.id ASC`, [cycle.id]).then(r => r.rows),
  ]);

  return shapeBrief({ cycle, shops, members, categories, tasks, workOrders, marks, history, completions, woLog });
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

const pct = (done, total) => total ? Math.round(done / total * 100) : null;

// 'YYYY-MM-DD' arithmetic without Date-and-timezone surprises.
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return t.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const p = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86400000);
}

// Archived cycles newest first, each with squadron and per-shop done/total.
function shapeHistory(rows, shops) {
  const byCycle = new Map();
  for (const r of rows) {
    if (!byCycle.has(r.cycle_id)) byCycle.set(r.cycle_id, { id: r.cycle_id, name: r.name, created_at: r.created_at, total: 0, done: 0, shops: {} });
    const c = byCycle.get(r.cycle_id);
    c.total += r.total; c.done += r.done;
    c.shops[r.shop_id] = { total: r.total, done: r.done, pct: pct(r.done, r.total) };
  }
  return [...byCycle.values()]
    .sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || (b.id - a.id))
    .slice(0, HISTORY_CYCLES)
    .map(c => ({ id: c.id, name: c.name, total: c.total, done: c.done, pct: pct(c.done, c.total),
                 shops: Object.fromEntries(shops.map(s => [s.id, c.shops[s.id] || { total: 0, done: 0, pct: null }])) }));
}

// Buckets: before the drill, one per period, after the drill. A tick at 11:30
// on a drill day lands in that day's PM bucket — the AM block ends at 11:00.
function shapeTimeline(completions, cycle, periods, shops) {
  const bucketFor = (day, hour) => {
    if (!cycle.start_date || !cycle.end_date) return 'during';
    if (day < cycle.start_date) return 'before';
    if (day > cycle.end_date) return 'after';
    const dayIndex = daysBetween(cycle.start_date, day);
    const period = dayIndex * 2 + (hour < 12 ? 1 : 2);
    return period <= periods.length ? 'p' + period : 'after';
  };
  const mk = (key, label) => ({ key, label, count: 0, by_shop: Object.fromEntries(shops.map(s => [s.id, 0])) });
  const buckets = [mk('before', 'Before drill')];
  if (cycle.start_date && cycle.end_date) {
    for (const p of periods) buckets.push(mk('p' + p.period, p.day ? `${p.day.slice(0, 3)} ${p.half}` : `U${p.period}`));
  } else {
    buckets.push(mk('during', 'During drill'));
  }
  buckets.push(mk('after', 'After drill'));
  const idx = Object.fromEntries(buckets.map(b => [b.key, b]));
  for (const c of completions) {
    const b = idx[bucketFor(c.day, c.hour)];
    if (!b) continue;
    b.count++;
    if (c.shop_id in b.by_shop) b.by_shop[c.shop_id]++;
  }
  return buckets;
}

function shapeBrief({ cycle, shops, members, categories, tasks, workOrders, marks, history = [], completions = [], woLog = [] }) {
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
  const logBy = new Map();
  for (const l of woLog) {
    if (!logBy.has(l.shop_event_id)) logBy.set(l.shop_event_id, []);
    logBy.get(l.shop_event_id).push(l);
  }

  // "Opened this cycle" means signed in on or after the drill's start date; on
  // an undated cycle, within the last 35 days (one drill cycle) of today.
  const sinceDay = cycle.start_date || addDays(new Date().toISOString().slice(0, 10), -35);

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
    const activated = m.activated !== false;
    const lastLogin = m.last_login_day || null;
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
      // Adoption: never signed in (still on the initial password, or no login
      // ever recorded), or signed in but not since this drill opened.
      signin: !activated || !lastLogin ? 'never' : (lastLogin >= sinceDay ? 'this_cycle' : 'stale'),
      last_login_day: lastLogin,
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

  const inDrill = (day) => !!day && (!cycle.start_date || day >= cycle.start_date) && (!cycle.end_date || day <= cycle.end_date);

  const squadron = { tasks: makeRollup(categories), members: { total: 0, present: 0 },
                     attendance: { marked: 0, total: 0 }, work_orders: woCounts([]),
                     signin: { never: 0, stale: 0, this_cycle: 0 },
                     present_by_period: periods.map(p => ({ period: p.period, label: p.day ? `${p.day.slice(0, 3)} ${p.half}` : `U${p.period}`, present: 0, marked: 0, total: 0 })) };
  const allWos = [];

  const shapedShops = shops.map(s => {
    const mems = membersByShop.get(s.id) || [];
    const wos = (wosByShop.get(s.id) || []).map(w => {
      const log = (logBy.get(w.id) || []).map(l => ({ status: l.status, note: l.note, day: l.day, time: l.time,
        by: l.last_name ? `${l.rank || ''} ${l.last_name}`.trim() : null }));
      const closed = w.status === 'complete' ? [...log].reverse().find(l => l.status === 'complete') || null : null;
      const closedDay = closed ? closed.day : null;
      return {
        id: w.id, wo_number: w.wo_number, title: w.title, details: w.details || null,
        status: w.status, day: w.day || null, start_time: w.start_time || null, end_time: w.end_time || null,
        shop_id: s.id, shop_name: s.name,
        created_day: w.created_day || null,
        log,
        closed_day: closedDay,
        closed_this_drill: w.status === 'complete' && (closedDay ? inDrill(closedDay) : false),
        closing_note: closed ? closed.note : null,
        closed_by: closed ? closed.by : null,
        days_open: closedDay && w.created_day ? Math.max(0, daysBetween(w.created_day, closedDay)) : null,
      };
    });
    allWos.push(...wos);
    const rollup = makeRollup(categories);
    let marked = 0;
    const signin = { never: 0, stale: 0, this_cycle: 0 };
    const presentByPeriod = periods.map(p => ({ period: p.period, present: 0, marked: 0, total: mems.length }));
    for (const m of mems) {
      for (const t of m.tasks) rollTask(rollup, t, m.present);
      marked += m.marked_periods;
      signin[m.signin]++;
      for (const x of m.marks) {
        const slot = presentByPeriod[x.period - 1];
        if (!slot) continue;
        slot.marked++;
        if (PRESENT_STATUSES.includes(x.status)) slot.present++;
      }
    }
    const present = mems.filter(m => m.present).length;
    // Squadron totals accumulate from the same member loop so they cannot
    // disagree with the sum of the shop cards.
    for (const m of mems) for (const t of m.tasks) rollTask(squadron.tasks, t, m.present);
    squadron.members.total += mems.length;
    squadron.members.present += present;
    squadron.attendance.marked += marked;
    squadron.attendance.total += mems.length * periodCount;
    for (const k of Object.keys(signin)) squadron.signin[k] += signin[k];
    presentByPeriod.forEach((p, i) => { squadron.present_by_period[i].present += p.present; squadron.present_by_period[i].marked += p.marked; squadron.present_by_period[i].total += p.total; });

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
      signin,
      present_by_period: presentByPeriod,
    };
  });
  squadron.work_orders = woCounts(allWos);
  squadron.away = shapedMembers.filter(m => !m.present).map(m => ({
    id: m.id, rank: m.rank, last_name: m.last_name, first_name: m.first_name,
    shop_id: m.shop_id, shop_name: (shops.find(s => s.id === m.shop_id) || {}).name || null,
    away_labels: m.away_labels, away_note: m.away_note,
  }));

  const hist = shapeHistory(history, shops);
  const prior = hist[0] || null;
  const timeline = shapeTimeline(completions, cycle, periods, shops);

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
    history: hist,
    prior: prior ? { id: prior.id, name: prior.name, pct: prior.pct, shops: prior.shops } : null,
    timeline,
  };
}

module.exports = { loadBrief, shapeBrief, shapeHistory, shapeTimeline, WO_STATUSES, HISTORY_CYCLES };
