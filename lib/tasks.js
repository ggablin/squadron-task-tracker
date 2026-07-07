async function assertTaskInLiveCycle(db, taskId) {
  const { rows } = await db.query(
    `SELECT 1 FROM tasks t JOIN uta_cycles c ON c.id = t.uta_cycle_id
     WHERE t.id = $1 AND c.is_current = true`, [taskId]);
  if (!rows.length) {
    throw Object.assign(new Error('Task is not in the live cycle'), { code: 'NOT_LIVE' });
  }
}

module.exports = { assertTaskInLiveCycle };
