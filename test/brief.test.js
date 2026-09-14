// shapeBrief is pure: feed it the six row sets and check every rollup the
// dashboard shows. The rules must match the Squadron tab's — informational
// tasks shown but never counted, critical = this drill or overdue, a member is
// at drill unless attendance says otherwise — so the room never sees two
// numbers for one thing.
const { test } = require('node:test');
const assert = require('node:assert');
const { shapeBrief, shapeHistory, shapeTimeline, WO_STATUSES, HISTORY_CYCLES } = require('../lib/brief');

const cycle = { id: 7, name: 'Sep 2026 UTA', status: 'live', start_date: '2026-09-12', end_date: '2026-09-13', period_count: 4 };
const shops = [{ id: 1, name: 'Structures' }, { id: 2, name: 'HVAC' }];
const members = [
  { id: 10, shop_id: 1, rank: 'TSgt', last_name: 'Ebbert',   first_name: 'Jeff',  role: 'supervisor' },
  { id: 11, shop_id: 1, rank: 'SrA',  last_name: 'Becerra',  first_name: 'Paula', role: 'member' },
  { id: 12, shop_id: 1, rank: 'AB',   last_name: 'DeRose',   first_name: 'Matt',  role: 'member' },
  { id: 20, shop_id: 2, rank: 'SrA',  last_name: 'Torres',   first_name: 'Jer',   role: 'member' },
];
const categories = [{ code: 'admin', label: 'Admin', sort_order: 1 }, { code: 'cbt', label: 'CBTs', sort_order: 2 }, { code: 'medical', label: 'Medical', sort_order: 3 }];
const T = (id, member_id, code, title, extra = {}) => ({
  id, member_id, category_code: code, title, details: null, urgency: 'this_uta', is_flagged: false,
  appt_day: null, appt_time: null, informational: false, critical: true, state: 'none', note: null, ...extra,
});
const tasks = [
  T(1, 10, 'cbt', 'Cyber Awareness', { state: 'done' }),
  T(2, 11, 'cbt', 'Cyber Awareness'),
  T(3, 12, 'cbt', 'Cyber Awareness'),
  T(4, 11, 'medical', 'Dental', { urgency: 'next_uta', critical: false }),
  T(5, 12, 'admin', 'Sleep study', { urgency: 'info', informational: true }),   // shown, never counted
  T(6, 20, 'cbt', 'Cyber Awareness', { state: 'done' }),
  T(7, 20, 'admin', 'EPB routing', { urgency: 'overdue', is_flagged: true }),
];
const workOrders = [
  { id: 1, shop_id: 1, wo_number: 'WO-1', title: 'Fix door', details: null, status: 'complete', day: 'Saturday', start_time: '0900', end_time: '1100' },
  { id: 2, shop_id: 1, wo_number: 'WO-2', title: 'Paint bay', details: 'Bay 3', status: 'in_progress', day: null, start_time: null, end_time: null },
  { id: 3, shop_id: 2, wo_number: null,   title: 'Filter swap', details: null, status: 'open', day: null, start_time: null, end_time: null },
];
// DeRose is at tech school all weekend; Becerra has one present mark; Ebbert and Torres are unmarked.
const marks = [
  { member_id: 12, period: 1, status: 'orders_away', note: 'Tech school' },
  { member_id: 12, period: 2, status: 'orders_away', note: 'Tech school' },
  { member_id: 12, period: 3, status: 'orders_away', note: null },
  { member_id: 12, period: 4, status: 'orders_away', note: null },
  { member_id: 11, period: 1, status: 'present', note: null },
];

const brief = () => shapeBrief({ cycle, shops, members, categories, tasks, workOrders, marks });

test('cycle carries derived periods and labels', () => {
  const b = brief();
  assert.strictEqual(b.cycle.period_count, 4);
  assert.strictEqual(b.cycle.periods.length, 4);
  assert.strictEqual(b.cycle.periods[0].day, 'Saturday');
  assert.deepStrictEqual(b.categories.map(c => c.code), ['admin', 'cbt', 'medical']);
});

test('squadron rollup counts countable tasks in all-members and at-drill flavours', () => {
  const b = brief();
  // Countable: 1,2,3,4,6,7 (5 is informational). Done: 1 and 6.
  assert.deepStrictEqual(b.squadron.tasks.all, { total: 6, done: 2, critical: 5, critical_done: 2 });
  // DeRose (12) is away: his Cyber Awareness leaves the present flavour.
  assert.deepStrictEqual(b.squadron.tasks.present, { total: 5, done: 2, critical: 4, critical_done: 2 });
  assert.deepStrictEqual(b.squadron.tasks.by_category.cbt.all, { total: 4, done: 2, critical: 4, critical_done: 2 });
  assert.deepStrictEqual(b.squadron.tasks.by_category.medical.all, { total: 1, done: 0, critical: 0, critical_done: 0 });
  assert.deepStrictEqual(b.squadron.tasks.by_category.admin.all, { total: 1, done: 0, critical: 1, critical_done: 0 }, 'the informational admin task is not counted');
});

test('shop rollups sum to the squadron, and members/attendance/work orders roll per shop', () => {
  const b = brief();
  const st = b.shops.find(s => s.name === 'Structures'), hv = b.shops.find(s => s.name === 'HVAC');
  // Structures: Cyber ×3 (one done) + Dental (next UTA, not critical); the sleep-study notice is not counted.
  assert.deepStrictEqual(st.tasks.all, { total: 4, done: 1, critical: 3, critical_done: 1 });
  assert.deepStrictEqual(hv.tasks.all, { total: 2, done: 1, critical: 2, critical_done: 1 });
  assert.strictEqual(st.tasks.all.total + hv.tasks.all.total, b.squadron.tasks.all.total);
  assert.deepStrictEqual([st.member_count, st.present_count], [3, 2]);
  assert.deepStrictEqual([hv.member_count, hv.present_count], [1, 1]);
  assert.deepStrictEqual(b.squadron.members, { total: 4, present: 3 });
  // Attendance coverage: Structures 5 marks over 3 × 4; HVAC 0 over 4.
  assert.deepStrictEqual(st.attendance, { marked: 5, total: 12 });
  assert.deepStrictEqual(hv.attendance, { marked: 0, total: 4 });
  assert.deepStrictEqual(b.squadron.attendance, { marked: 5, total: 16 });
  assert.deepStrictEqual(st.work_order_counts, { open: 0, in_progress: 1, complete: 1, total: 2 });
  assert.deepStrictEqual(b.squadron.work_orders, { open: 1, in_progress: 1, complete: 1, total: 3 });
  assert.strictEqual(st.work_orders[0].shop_name, 'Structures');
  assert.deepStrictEqual(st.supervisors.map(s => s.last_name), ['Ebbert']);
});

test('members carry presence, the reason when away, marks with pay codes, and their tasks', () => {
  const b = brief();
  const st = b.shops.find(s => s.name === 'Structures');
  const derose = st.members.find(m => m.id === 12);
  assert.strictEqual(derose.present, false);
  assert.deepStrictEqual(derose.away_statuses, ['orders_away']);
  assert.deepStrictEqual(derose.away_labels, ['Orders / School – Away']);
  assert.strictEqual(derose.away_note, 'Tech school');
  assert.deepStrictEqual(derose.marks.map(m => m.pay), ['X', 'X', 'X', 'X']);
  assert.strictEqual(derose.marked_periods, 4);
  assert.deepStrictEqual(derose.counts, { total: 1, done: 0, critical: 1, critical_done: 0 });
  assert.strictEqual(derose.tasks.length, 2, 'the informational task is still listed');
  assert.ok(derose.tasks.find(t => t.title === 'Sleep study').informational);

  const ebbert = st.members.find(m => m.id === 10);
  assert.strictEqual(ebbert.present, true, 'unmarked is present');
  assert.deepStrictEqual(ebbert.marks, []);

  const torres = b.shops.find(s => s.name === 'HVAC').members[0];
  const epb = torres.tasks.find(t => t.title === 'EPB routing');
  assert.ok(epb.critical && epb.is_flagged);
  assert.strictEqual(epb.urgency, 'overdue');
});

test('the squadron away list names shop and reason, and marks outside the drill are ignored', () => {
  const b = shapeBrief({ cycle, shops, members, categories, tasks, workOrders,
    marks: marks.concat([{ member_id: 11, period: 9, status: 'awol', note: null }]) });
  assert.deepStrictEqual(b.squadron.away.map(m => [m.last_name, m.shop_name, m.away_labels[0]]),
    [['DeRose', 'Structures', 'Orders / School – Away']]);
  const becerra = b.shops[0].members.find(m => m.id === 11);
  assert.strictEqual(becerra.marked_periods, 1, 'a period 9 mark on a 4-period drill does not count');
});

test('work order statuses are the three the schema allows', () => {
  assert.deepStrictEqual(WO_STATUSES, ['open', 'in_progress', 'complete']);
});

// ── the insight data ────────────────────────────────────────────────────────

test('history keeps the newest archived drills, per shop, and prior is the latest', () => {
  const rows = [];
  for (let i = 1; i <= HISTORY_CYCLES + 2; i++) {
    rows.push({ cycle_id: 100 + i, name: 'Cycle ' + i, created_at: new Date(2026, 0, i).toISOString(), shop_id: 1, total: 10, done: i });
    rows.push({ cycle_id: 100 + i, name: 'Cycle ' + i, created_at: new Date(2026, 0, i).toISOString(), shop_id: 2, total: 5, done: 5 });
  }
  const h = shapeHistory(rows, shops);
  assert.strictEqual(h.length, HISTORY_CYCLES);
  assert.strictEqual(h[0].name, 'Cycle 8', 'newest first');
  assert.strictEqual(h[0].shops[1].pct, 80);
  assert.strictEqual(h[0].shops[2].pct, 100);
  assert.strictEqual(h[0].pct, Math.round(13 / 15 * 100));
  const b = shapeBrief({ cycle, shops, members, categories, tasks, workOrders, marks, history: rows });
  assert.strictEqual(b.prior.name, 'Cycle 8');
  assert.strictEqual(b.prior.shops[1].pct, 80);
  // A shop with no rows in a past cycle is present with null, not missing.
  const one = shapeHistory([rows[0]], shops);
  assert.deepStrictEqual(one[0].shops[2], { total: 0, done: 0, pct: null });
});

test('the timeline buckets ticks by drill period in local time, before and after the drill', () => {
  const periods = [
    { period: 1, day: 'Saturday', half: 'AM' }, { period: 2, day: 'Saturday', half: 'PM' },
    { period: 3, day: 'Sunday', half: 'AM' },   { period: 4, day: 'Sunday', half: 'PM' },
  ];
  const ticks = [
    { shop_id: 1, day: '2026-09-01', hour: 20 },   // weeks before
    { shop_id: 1, day: '2026-09-12', hour: 8 },    // Sat AM
    { shop_id: 2, day: '2026-09-12', hour: 13 },   // Sat PM (the split is noon)
    { shop_id: 1, day: '2026-09-13', hour: 15 },   // Sun PM
    { shop_id: 1, day: '2026-09-14', hour: 9 },    // the Monday after
  ];
  const t = shapeTimeline(ticks, cycle, periods, shops);
  assert.deepStrictEqual(t.map(b => [b.key, b.count]), [['before', 1], ['p1', 1], ['p2', 1], ['p3', 0], ['p4', 1], ['after', 1]]);
  assert.strictEqual(t[1].label, 'Sat AM');
  assert.deepStrictEqual(t[2].by_shop, { 1: 0, 2: 1 });
  // An undated cycle collapses to a single "during" bucket rather than guessing.
  const u = shapeTimeline(ticks, { ...cycle, start_date: null, end_date: null }, periods, shops);
  assert.deepStrictEqual(u.map(b => [b.key, b.count]), [['before', 0], ['during', 5], ['after', 0]]);
});

test('sign-in state per member rolls up per shop and squadron', () => {
  const mem = members.map(m => ({ ...m, activated: true, last_login_day: '2026-09-12' }));
  mem[0].activated = false;                    // Ebbert never changed his password
  mem[1].last_login_day = '2026-08-30';         // Becerra: before this drill opened
  mem[2].last_login_day = null;                 // DeRose: activated but never seen
  const b = shapeBrief({ cycle, shops, members: mem, categories, tasks, workOrders, marks });
  const st = b.shops.find(s => s.name === 'Structures');
  assert.deepStrictEqual(st.members.map(m => m.signin), ['never', 'stale', 'never']);
  assert.deepStrictEqual(st.signin, { never: 2, stale: 1, this_cycle: 0 });
  assert.deepStrictEqual(b.squadron.signin, { never: 2, stale: 1, this_cycle: 1 });
});

test('attendance by period counts present marks against marked and members', () => {
  const b = brief();
  const st = b.shops.find(s => s.name === 'Structures');
  // Period 1: Becerra present, DeRose away → 1 present of 2 marked, 3 members.
  assert.deepStrictEqual(st.present_by_period[0], { period: 1, present: 1, marked: 2, total: 3 });
  assert.deepStrictEqual(st.present_by_period[1], { period: 2, present: 0, marked: 1, total: 3 });
  assert.strictEqual(b.squadron.present_by_period[0].label, 'Sat AM');
  assert.deepStrictEqual([b.squadron.present_by_period[0].present, b.squadron.present_by_period[0].marked, b.squadron.present_by_period[0].total], [1, 2, 4]);
});

test('the work-order log yields closed-this-drill, the closing note, and days open', () => {
  const wos = workOrders.map(w => ({ ...w, created_day: '2026-09-01' }));
  const woLog = [
    { shop_event_id: 1, status: 'in_progress', note: 'started', day: '2026-09-12', time: '08:10', rank: 'TSgt', last_name: 'Ebbert' },
    { shop_event_id: 1, status: 'complete', note: 'Door hung and tested', day: '2026-09-12', time: '10:40', rank: 'TSgt', last_name: 'Ebbert' },
    { shop_event_id: 2, status: 'in_progress', note: 'primed', day: '2026-09-13', time: '09:00', rank: null, last_name: null },
  ];
  const b = shapeBrief({ cycle, shops, members, categories, tasks, workOrders: wos, marks, woLog });
  const st = b.shops.find(s => s.name === 'Structures');
  const door = st.work_orders.find(w => w.title === 'Fix door'), paint = st.work_orders.find(w => w.title === 'Paint bay');
  assert.strictEqual(door.closed_this_drill, true);
  assert.strictEqual(door.closing_note, 'Door hung and tested');
  assert.strictEqual(door.closed_by, 'TSgt Ebbert');
  assert.strictEqual(door.days_open, 11);
  assert.strictEqual(door.log.length, 2);
  assert.strictEqual(paint.closed_this_drill, false);
  assert.strictEqual(paint.log[0].by, null);
  // Complete with no log at all (legacy rows) is not claimed as closed this drill.
  const legacy = shapeBrief({ cycle, shops, members, categories, tasks, workOrders: wos, marks, woLog: [] });
  assert.strictEqual(legacy.shops[0].work_orders.find(w => w.title === 'Fix door').closed_this_drill, false);
});
