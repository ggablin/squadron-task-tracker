const attendance = require('./attendance');
const events = require('./events');

// Every row this module returns is handed straight to res.json (three routes,
// server.js:1408/1423/1444), so the drill dates must leave Postgres as
// 'YYYY-MM-DD' strings. node-postgres parses a DATE column to LOCAL midnight;
// JSON.stringify then runs that Date through toISOString(), which is UTC, so in
// any timezone ahead of UTC every cycle would report the day BEFORE its drill.
// Same defect as /api/squadron/timeline and /api/export/shop-lists, where the
// printed handout showed 7 August for an 8 August drill under TZ=Asia/Tokyo.
// Dormant here only because production sets no TZ.
//
// RETURNING serialises exactly like SELECT, so createDraft's INSERT and
// setCycleDates' UPDATE below need the same treatment — with an AS alias, or
// the column comes back named `to_char`.
async function listCycles(db) {
  const { rows } = await db.query(`
    SELECT c.id, c.name, c.status, c.is_current,
           to_char(c.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(c.end_date,   'YYYY-MM-DD') AS end_date,
           c.period_count,
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
async function createDraft(db, name, startDate = null, endDate = null, createdById = null) {
  const periodCount = attendance.periodCountFromDates(startDate, endDate);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // A draft sharing its name with the live cycle makes the one sentence that
    // distinguishes them meaningless: "Aug 2026 UTA — draft — members still see
    // Aug 2026 UTA until you press Go live". Every later reference ("Start from
    // Aug 2026 UTA") inherits the ambiguity. Archived cycles are excluded,
    // because reusing a retired name is a legitimate habit; only names that can
    // be on screen at the same time collide.
    //
    // This rejects a NEW name. It never renames or touches an existing row, so
    // any duplicate already in the database stays exactly as it is.
    const { rows: clash } = await client.query(
      `SELECT id, status FROM uta_cycles
       WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
         AND COALESCE(status, 'draft') <> 'archived'
       LIMIT 1`, [name]);
    if (clash.length) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`A ${clash[0].status || 'draft'} cycle is already named "${name}"`),
        { code: 'DUPLICATE_NAME' });
    }

    const { rows } = await client.query(
      `INSERT INTO uta_cycles (name, status, is_current, start_date, end_date, period_count)
       VALUES ($1,'draft',false,$2,$3,COALESCE($4, 4))
       RETURNING id, name, status, is_current,
                 to_char(start_date, 'YYYY-MM-DD') AS start_date,
                 to_char(end_date,   'YYYY-MM-DD') AS end_date,
                 period_count`,
      [name, startDate || null, endDate || null, periodCount]);
    const cycle = rows[0];

    // Unfinished work is outstanding whether or not anyone remembers to press a
    // button, so open and in-progress work orders follow the squadron into the
    // new cycle. Completed ones deliberately do not (see lib/events.js).
    const { rows: live } = await client.query(
      `SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1`);
    let carried = 0;
    if (live.length) {
      ({ carried } = await events.carryOpenWorkOrders(client, {
        fromCycleId: live[0].id, toCycleId: cycle.id, createdById,
      }));
    }

    await client.query('COMMIT');
    return { ...cycle, carried_work_orders: carried };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Editing the dates recomputes period_count. Rows above a shrunk count are
// hidden rather than deleted, so restoring the dates restores the marks.
async function setCycleDates(db, cycleId, startDate, endDate) {
  const periodCount = attendance.periodCountFromDates(startDate, endDate);
  const { rows } = await db.query(
    `UPDATE uta_cycles SET start_date = $2, end_date = $3, period_count = COALESCE($4, period_count, 4)
     WHERE id = $1
     RETURNING id, name, status, is_current,
               to_char(start_date, 'YYYY-MM-DD') AS start_date,
               to_char(end_date,   'YYYY-MM-DD') AS end_date,
               period_count`,
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
    // Five tables key off uta_cycles; this only ever cleared three. Harmless
    // while nothing wrote events to a draft — but createDraft now carries work
    // orders in, so without this a discard orphans them and the cycle delete
    // trips the foreign key.
    await events.deleteCycleEvents(client, cycleId);
    await client.query(`DELETE FROM uta_cycles WHERE id=$1`, [cycleId]);
    await client.query('COMMIT');
    return { deleted: true };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

module.exports = { listCycles, createDraft, setCycleDates, goLive, discardDraft };
