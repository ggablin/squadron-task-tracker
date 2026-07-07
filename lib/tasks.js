async function assertTaskInLiveCycle(db, taskId) {
  const { rows } = await db.query(
    `SELECT 1 FROM tasks t JOIN uta_cycles c ON c.id = t.uta_cycle_id
     WHERE t.id = $1 AND c.is_current = true`, [taskId]);
  if (!rows.length) {
    throw Object.assign(new Error('Task is not in the live cycle'), { code: 'NOT_LIVE' });
  }
}

async function listGroups(db, sourceCycleId) {
  const { rows } = await db.query(`
    SELECT t.category_id, cat.code AS category_code, t.title,
           MIN(t.details) AS details, MIN(t.urgency) AS urgency,
           COUNT(*)::int AS count,
           JSON_AGG(JSON_BUILD_OBJECT('id', m.id, 'last_name', m.last_name,
             'first_name', m.first_name, 'rank', m.rank) ORDER BY m.last_name) AS members
    FROM tasks t
    JOIN task_categories cat ON cat.id = t.category_id
    JOIN members m ON m.id = t.member_id
    WHERE t.uta_cycle_id = $1
    GROUP BY t.category_id, cat.code, t.title
    ORDER BY cat.code, t.title`, [sourceCycleId]);
  return rows;
}

module.exports = { assertTaskInLiveCycle, listGroups };
