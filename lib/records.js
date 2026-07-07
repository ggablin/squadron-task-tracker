// Member task history — used by the Records feature (GET /api/members/:id/history)
// to show a member's own tasks across every UTA cycle they've had, newest cycle first.

async function getMemberShopId(db, memberId) {
  const { rows } = await db.query(`SELECT shop_id FROM members WHERE id=$1`, [memberId]);
  return rows.length ? rows[0].shop_id : null;
}

async function memberHistory(db, memberId) {
  const { rows } = await db.query(`
    SELECT c.id AS cycle_id, c.name, c.status, c.is_current,
           t.id AS task_id, cat.code AS category_code, t.title, t.urgency,
           COALESCE(tc.state,'none') AS state, tc.note
    FROM tasks t
    JOIN uta_cycles c ON c.id = t.uta_cycle_id
    JOIN task_categories cat ON cat.id = t.category_id
    LEFT JOIN task_completions tc ON tc.task_id = t.id
    WHERE t.member_id = $1
    ORDER BY c.created_at DESC, c.id DESC, cat.sort_order, t.title`, [memberId]);
  const byCycle = new Map();
  for (const r of rows) {
    if (!byCycle.has(r.cycle_id)) {
      byCycle.set(r.cycle_id, {
        cycle: { id: r.cycle_id, name: r.name, status: r.status, is_current: r.is_current },
        done: 0, total: 0, tasks: [],
      });
    }
    const c = byCycle.get(r.cycle_id);
    c.total++;
    if (r.state === 'done') c.done++;
    c.tasks.push({ id: r.task_id, category_code: r.category_code, title: r.title, urgency: r.urgency, state: r.state, note: r.note });
  }
  return [...byCycle.values()];
}

module.exports = { memberHistory, getMemberShopId };
