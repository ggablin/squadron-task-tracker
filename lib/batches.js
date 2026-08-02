const { assertCycleEditable } = require('./tasks');

async function listBatches(db, cycleId) {
  // HAVING COUNT(t.id) > 0: individual task deletes can empty a batch, and a
  // batch with no tasks left would otherwise render in the undo list as
  // "0 members" with an Undo button that does nothing.
  const { rows } = await db.query(`
    SELECT b.id, b.label, b.kind, b.created_at,
           (m.rank || ' ' || m.last_name) AS created_by,
           COUNT(t.id)::int AS member_count
    FROM task_batches b
    LEFT JOIN tasks t ON t.batch_id = b.id
    LEFT JOIN members m ON m.id = b.created_by_id
    WHERE b.uta_cycle_id = $1
    GROUP BY b.id, m.rank, m.last_name
    HAVING COUNT(t.id) > 0
    ORDER BY b.created_at DESC, b.id DESC`, [cycleId]);
  return rows;
}

// Mirrors the "history is frozen, everything else is editable" rule enforced
// on every other write path (deleteTask/deleteGroup/updateTask/updateGroup in
// lib/tasks.js): an archived cycle's batches must stay un-undoable, or
// lib/records.js's "immutable" history changes underneath a leader viewing
// it. undoBatch is keyed by batchId, not cycleId, so the cycle has to be
// resolved off task_batches before the guard can run.
async function undoBatch(db, batchId, { force } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: b } = await client.query(
      `SELECT uta_cycle_id FROM task_batches WHERE id = $1`, [batchId]);
    if (!b.length) throw Object.assign(new Error('Batch not found'), { code: 'NOT_FOUND' });
    await assertCycleEditable(client, b[0].uta_cycle_id);

    const { rows: chk } = await client.query(
      `SELECT COUNT(*)::int n FROM task_completions tc
       JOIN tasks t ON t.id = tc.task_id
       WHERE t.batch_id = $1 AND tc.state <> 'none'`, [batchId]);
    if (chk[0].n > 0 && !force) {
      throw Object.assign(new Error('Batch has completions'),
        { code: 'HAS_COMPLETIONS', checked_off_count: chk[0].n });
    }
    await client.query(
      `DELETE FROM task_completions WHERE task_id IN (SELECT id FROM tasks WHERE batch_id=$1)`, [batchId]);
    await client.query(`DELETE FROM tasks WHERE batch_id=$1`, [batchId]);
    await client.query(`DELETE FROM task_batches WHERE id=$1`, [batchId]);
    await client.query('COMMIT');
    return { deleted: true };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

module.exports = { listBatches, undoBatch };
