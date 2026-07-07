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

async function addTaskBatch(db, cycleId, { title, category_code, details, assignments, created_by_id }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: cat } = await client.query(
      `SELECT id FROM task_categories WHERE code=$1`, [category_code]);
    if (!cat.length) throw Object.assign(new Error('bad category'), { code: 'BAD_CATEGORY' });
    const { rows: batch } = await client.query(
      `INSERT INTO task_batches (uta_cycle_id, label, kind, created_by_id)
       VALUES ($1,$2,'new_task',$3) RETURNING id`, [cycleId, title, created_by_id]);
    let added = 0, requested = 0;
    for (const a of assignments) {
      for (const memberId of a.member_ids) {
        requested++;
        const { rowCount } = await client.query(
          `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency, batch_id, created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (uta_cycle_id, member_id, category_id, title) DO NOTHING`,
          [cycleId, memberId, cat[0].id, title, details || null, a.urgency || 'this_uta', batch[0].id, created_by_id]);
        added += rowCount;
      }
    }
    await client.query('COMMIT');
    return { batch_id: batch[0].id, added, skipped: requested - added };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

module.exports = { assertTaskInLiveCycle, listGroups, addTaskBatch };
