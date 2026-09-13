// Member history — used by the Records feature (GET /api/members/:id/history)
// to show a member's own tasks and drill attendance across every UTA cycle
// they've had, newest cycle first.

const attendance = require('./attendance');

async function getMemberShopId(db, memberId) {
  const { rows } = await db.query(`SELECT shop_id FROM members WHERE id=$1`, [memberId]);
  return rows.length ? rows[0].shop_id : null;
}

async function memberHistory(db, memberId) {
  const { rows } = await db.query(`
    SELECT c.id AS cycle_id, c.name, c.status, c.is_current, c.created_at,
           t.id AS task_id, cat.code AS category_code, t.title, t.urgency,
           COALESCE(tc.state,'none') AS state, tc.note
    FROM tasks t
    JOIN uta_cycles c ON c.id = t.uta_cycle_id
    JOIN task_categories cat ON cat.id = t.category_id
    LEFT JOIN task_completions tc ON tc.task_id = t.id
    WHERE t.member_id = $1
    ORDER BY c.created_at DESC, c.id DESC, cat.sort_order, t.title`, [memberId]);
  // Attendance is a second query, not a join: a member can be marked in a
  // cycle that gave them no tasks (a new arrival, a cycle built before they
  // were on the roster), and joining would multiply task rows by periods.
  const { rows: marks } = await db.query(`
    SELECT c.id AS cycle_id, c.name, c.status, c.is_current, c.created_at,
           c.start_date, c.end_date, c.period_count,
           a.period, a.status AS att_status, a.note
    FROM attendance a
    JOIN uta_cycles c ON c.id = a.uta_cycle_id
    WHERE a.member_id = $1
    ORDER BY c.created_at DESC, c.id DESC, a.period`, [memberId]);

  const byCycle = new Map();
  const bucket = (r) => {
    if (!byCycle.has(r.cycle_id)) {
      byCycle.set(r.cycle_id, {
        cycle: { id: r.cycle_id, name: r.name, status: r.status, is_current: r.is_current },
        created_at: r.created_at,
        done: 0, total: 0, tasks: [],
        // Period labels are set when the first mark for the cycle is seen; a
        // cycle with tasks but no marks has nothing to draw a strip for.
        periods: [], attendance: [],
      });
    }
    return byCycle.get(r.cycle_id);
  };
  for (const r of rows) {
    const c = bucket(r);
    c.total++;
    if (r.state === 'done') c.done++;
    c.tasks.push({ id: r.task_id, category_code: r.category_code, title: r.title, urgency: r.urgency, state: r.state, note: r.note });
  }
  for (const r of marks) {
    const c = bucket(r);
    if (!c.periods.length) {
      c.periods = attendance.periodLabels(r.start_date, attendance.periodCountFor(r))
        .map(p => ({ period: p.period, label: p.label }));
    }
    c.attendance.push({
      period: r.period, status: r.att_status,
      label: attendance.statusLabelFor(r.att_status),
      pay: attendance.payCodeFor(r.att_status),
      note: r.note,
    });
  }
  // Newest cycle first across both sources; created_at is the same ordering
  // the two queries used, so mixed cycles interleave correctly.
  return [...byCycle.values()]
    .sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || (b.cycle.id - a.cycle.id))
    .map(({ created_at, ...c }) => c);
}

module.exports = { memberHistory, getMemberShopId };
