const attendance = require('./attendance');

async function listCycles(db) {
  const { rows } = await db.query(`
    SELECT c.id, c.name, c.status, c.is_current,
           c.start_date, c.end_date, c.period_count,
           COUNT(t.id)::int AS task_count
    FROM uta_cycles c LEFT JOIN tasks t ON t.uta_cycle_id = c.id
    GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC`);
  return rows;
}

// Drill dates are captured here so period_count can be derived rather than
// typed. Before this, nothing outside seed.js ever wrote start_date, which left
// every builder-created cycle undated — breaking attendance period labels and
// silently printing an empty date range in the generated newsletter.
// Dates stay optional: an undated cycle still works, it just falls back to a
// 4-period drill with bare "UTA n" labels.
async function createDraft(db, name, startDate = null, endDate = null) {
  const periodCount = attendance.periodCountFromDates(startDate, endDate);
  const { rows } = await db.query(
    `INSERT INTO uta_cycles (name, status, is_current, start_date, end_date, period_count)
     VALUES ($1,'draft',false,$2,$3,COALESCE($4, 4))
     RETURNING id, name, status, is_current, start_date, end_date, period_count`,
    [name, startDate || null, endDate || null, periodCount]);
  return rows[0];
}

// Editing the dates recomputes period_count. Rows above a shrunk count are
// hidden rather than deleted, so restoring the dates restores the marks.
async function setCycleDates(db, cycleId, startDate, endDate) {
  const periodCount = attendance.periodCountFromDates(startDate, endDate);
  const { rows } = await db.query(
    `UPDATE uta_cycles SET start_date = $2, end_date = $3, period_count = COALESCE($4, period_count, 4)
     WHERE id = $1
     RETURNING id, name, status, is_current, start_date, end_date, period_count`,
    [cycleId, startDate || null, endDate || null, periodCount]);
  if (!rows.length) throw Object.assign(new Error('No such cycle'), { code: 'NO_CYCLE' });
  return rows[0];
}

async function goLive(db, cycleId, { confirm } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(
      `SELECT id, name, status FROM uta_cycles WHERE id = $1 FOR UPDATE`, [cycleId]);
    if (!cur.length || cur[0].status !== 'draft') {
      throw Object.assign(new Error('Not a draft'), { code: 'NOT_DRAFT' });
    }
    const { rows: cnt } = await client.query(
      `SELECT COUNT(*)::int n FROM tasks WHERE uta_cycle_id = $1`, [cycleId]);
    if (cnt[0].n === 0 && !confirm) {
      throw Object.assign(new Error('Draft has no tasks'), { code: 'EMPTY_DRAFT' });
    }
    await client.query(
      `UPDATE uta_cycles SET status='archived', is_current=false WHERE is_current = true`);
    const { rows: promoted } = await client.query(
      `UPDATE uta_cycles SET status='live', is_current=true WHERE id=$1
       RETURNING id, name, status, is_current`, [cycleId]);
    const { rows: members } = await client.query(
      `SELECT id FROM members WHERE active = true`);
    await client.query('COMMIT');
    return { cycle: promoted[0], notifyMemberIds: members.map(m => m.id) };
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

async function discardDraft(db, cycleId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT status FROM uta_cycles WHERE id=$1 FOR UPDATE`, [cycleId]);
    if (!rows.length || rows[0].status !== 'draft') {
      throw Object.assign(new Error('Not a draft'), { code: 'NOT_DRAFT' });
    }
    await client.query(`DELETE FROM task_completions WHERE task_id IN (SELECT id FROM tasks WHERE uta_cycle_id=$1)`, [cycleId]);
    await client.query(`DELETE FROM tasks WHERE uta_cycle_id=$1`, [cycleId]);
    await client.query(`DELETE FROM task_batches WHERE uta_cycle_id=$1`, [cycleId]);
    await client.query(`DELETE FROM uta_cycles WHERE id=$1`, [cycleId]);
    await client.query('COMMIT');
    return { deleted: true };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

module.exports = { listCycles, createDraft, setCycleDates, goLive, discardDraft };
