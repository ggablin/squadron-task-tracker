// Urgency is stored as a string, and listGroups collapses it with MIN(), which
// sorts alphabetically: future < info < next_uta < overdue < this_uta. That
// ordering is meaningless — it makes this_uta look more severe than overdue.
// Escalation decisions use this rank instead.
const URGENCY_RANK = { info: 0, future: 1, next_uta: 2, this_uta: 3, overdue: 4 };

function notEditable() {
  return Object.assign(new Error('Cycle is closed to changes'), { code: 'NOT_EDITABLE' });
}

// Guards task DEFINITION edits and deletes: everything except archived.
// Distinct from assertTaskInLiveCycle, which guards member COMPLETIONS and
// must keep meaning "the live cycle only". Both exist; neither replaces the other.
//
// IS DISTINCT FROM, not <>: uta_cycles.status has no NOT NULL constraint, and
// `NULL <> 'archived'` is NULL (falsy), which would reject an editable cycle.
async function assertTaskEditable(db, taskId) {
  const { rows } = await db.query(
    `SELECT 1 FROM tasks t JOIN uta_cycles c ON c.id = t.uta_cycle_id
     WHERE t.id = $1 AND c.status IS DISTINCT FROM 'archived'`, [taskId]);
  if (!rows.length) throw notEditable();
}

async function assertCycleEditable(db, cycleId) {
  const { rows } = await db.query(
    `SELECT 1 FROM uta_cycles WHERE id = $1 AND status IS DISTINCT FROM 'archived'`, [cycleId]);
  if (!rows.length) throw notEditable();
}

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
           -- COUNT(DISTINCT col) ignores NULLs entirely. When a group has members
           -- with NULL and others with non-NULL or differing values, we must detect
           -- this as "mixed". The formula below adds 1 to the distinct count if any
           -- NULLs are present (i.e., when total count exceeds the non-null count).
           -- This correctly identifies all four cases: all NULL -> false, all identical
           -- non-null -> false, one non-null + one NULL -> true, two distinct non-null -> true.
           COUNT(DISTINCT t.urgency) + CASE WHEN COUNT(*) > COUNT(t.urgency) THEN 1 ELSE 0 END > 1 AS urgency_mixed,
           COUNT(DISTINCT t.details) + CASE WHEN COUNT(*) > COUNT(t.details) THEN 1 ELSE 0 END > 1 AS details_mixed,
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

async function copyForward(db, targetCycleId, { from_cycle_id, groups, created_by_id }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = [];
    for (const g of groups) {
      const { rows: cat } = await client.query(
        `SELECT id FROM task_categories WHERE code=$1`, [g.category_code]);
      if (!cat.length) continue;
      // Source members for this group (active only), unless caller supplied member_ids.
      let memberIds = g.member_ids;
      if (!memberIds) {
        const { rows } = await client.query(
          `SELECT DISTINCT t.member_id FROM tasks t JOIN members m ON m.id=t.member_id
           WHERE t.uta_cycle_id=$1 AND t.category_id=$2 AND t.title=$3 AND m.active=true`,
          [from_cycle_id, cat[0].id, g.title]);
        memberIds = rows.map(r => r.member_id);
      }
      const { rows: batch } = await client.query(
        `INSERT INTO task_batches (uta_cycle_id, label, kind, created_by_id)
         VALUES ($1,$2,'copy_forward',$3) RETURNING id`,
        [targetCycleId, `Copy: ${g.title}`, created_by_id]);
      // Group-level fallback details/urgency for members added during review
      // (member_ids that had no row in the source group).
      const { rows: [grp] } = await client.query(
        `SELECT MIN(details) AS details, MIN(urgency) AS urgency
         FROM tasks WHERE uta_cycle_id=$1 AND category_id=$2 AND title=$3::varchar`,
        [from_cycle_id, cat[0].id, g.title]);
      let added = 0;
      for (const memberId of memberIds) {
        // Carry the member's own details/urgency from the source row; fall back
        // to the group default for members added at review time who have none.
        // Never copy appt_* fields.
        const { rowCount } = await client.query(
          `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency, batch_id, created_by_id)
           SELECT $1, $2, $3, $4::varchar,
                  COALESCE(src.details, $8),
                  COALESCE(src.urgency, $9, 'this_uta'),
                  $5, $6
           FROM (SELECT MIN(details) AS details, MIN(urgency) AS urgency
                 FROM tasks WHERE uta_cycle_id=$7 AND category_id=$3 AND title=$4::varchar AND member_id=$2) src
           ON CONFLICT (uta_cycle_id, member_id, category_id, title) DO NOTHING`,
          [targetCycleId, memberId, cat[0].id, g.title, batch[0].id, created_by_id, from_cycle_id, grp.details, grp.urgency]);
        added += rowCount;
      }
      out.push({ category_code: g.category_code, title: g.title, batch_id: batch[0].id, added, skipped: memberIds.length - added });
    }
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Builds "col = $n" fragments for exactly the keys present in `fields`.
// An absent key leaves the column alone; a key holding null clears it.
// `startIndex` is the first free bind position for the caller's query.
function buildSet(fields, allowed, startIndex) {
  const sets = [], vals = [];
  for (const col of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, col)) {
      vals.push(fields[col]);
      sets.push(`${col} = $${startIndex + vals.length - 1}`);
    }
  }
  return { sets, vals };
}

const TASK_FIELDS = ['urgency', 'details', 'appt_day', 'appt_time', 'appt_location'];

async function updateTask(db, taskId, fields) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertTaskEditable(client, taskId);

    // FOR UPDATE so the pre-edit urgency used for the escalation comparison
    // cannot be changed by a concurrent write between read and update.
    const { rows: before } = await client.query(
      `SELECT member_id, urgency FROM tasks WHERE id = $1 FOR UPDATE`, [taskId]);
    if (!before.length) throw Object.assign(new Error('Task not found'), { code: 'NOT_FOUND' });

    const { sets, vals } = buildSet(fields, TASK_FIELDS, 2);
    if (!sets.length) {
      await client.query('COMMIT');
      return { updated: 0, escalated_member_ids: [] };
    }

    const { rowCount } = await client.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, [taskId, ...vals]);

    const escalated =
      Object.prototype.hasOwnProperty.call(fields, 'urgency') &&
      URGENCY_RANK[fields.urgency] > URGENCY_RANK[before[0].urgency]
        ? [before[0].member_id] : [];

    await client.query('COMMIT');
    return { updated: rowCount, escalated_member_ids: escalated };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

const GROUP_FIELDS = ['urgency', 'details'];

// Group identity is the (category_id, title) pair, not an id — that is what
// listGroups buckets on. Appointments are deliberately absent from
// GROUP_FIELDS: copyForward never copies appt_* because they are per-member,
// so a group-wide appointment write would almost always be wrong.
async function updateGroup(db, cycleId, { category_code, title }, fields) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertCycleEditable(client, cycleId);

    const { rows: cat } = await client.query(
      `SELECT id FROM task_categories WHERE code = $1`, [category_code]);
    if (!cat.length) throw Object.assign(new Error('Unknown category'), { code: 'BAD_CATEGORY' });

    const { rows: before } = await client.query(
      `SELECT member_id, urgency FROM tasks
       WHERE uta_cycle_id = $1 AND category_id = $2 AND title = $3::varchar
       FOR UPDATE`, [cycleId, cat[0].id, title]);
    if (!before.length) throw Object.assign(new Error('Group not found'), { code: 'NOT_FOUND' });

    const { sets, vals } = buildSet(fields, GROUP_FIELDS, 4);
    if (!sets.length) {
      await client.query('COMMIT');
      return { updated: 0, escalated_member_ids: [] };
    }

    const { rowCount } = await client.query(
      `UPDATE tasks SET ${sets.join(', ')}
       WHERE uta_cycle_id = $1 AND category_id = $2 AND title = $3::varchar`,
      [cycleId, cat[0].id, title, ...vals]);

    // Compare each member's own pre-edit urgency: a group can hold divergent
    // values (copyForward carries them forward), so only some members move up.
    const escalated = Object.prototype.hasOwnProperty.call(fields, 'urgency')
      ? before.filter(r => URGENCY_RANK[fields.urgency] > URGENCY_RANK[r.urgency])
              .map(r => r.member_id)
      : [];

    await client.query('COMMIT');
    return { updated: rowCount, escalated_member_ids: escalated };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Mirrors undoBatch's guard in lib/batches.js: refuse to destroy work a member
// has recorded unless the caller has confirmed. 'none' is the default state and
// does not count as work.
async function countCompletions(client, taskIds) {
  if (!taskIds.length) return 0;
  const { rows } = await client.query(
    `SELECT COUNT(*)::int n FROM task_completions
     WHERE task_id = ANY($1) AND state <> 'none'`, [taskIds]);
  return rows[0].n;
}

function hasCompletions(n) {
  return Object.assign(new Error('Has completions'),
    { code: 'HAS_COMPLETIONS', checked_off_count: n });
}

async function deleteTask(db, taskId, { force } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertTaskEditable(client, taskId);

    const { rows: exists } = await client.query(
      `SELECT id FROM tasks WHERE id = $1 FOR UPDATE`, [taskId]);
    if (!exists.length) throw Object.assign(new Error('Task not found'), { code: 'NOT_FOUND' });

    const n = await countCompletions(client, [taskId]);
    if (n > 0 && !force) throw hasCompletions(n);

    await client.query(`DELETE FROM task_completions WHERE task_id = $1`, [taskId]);
    const { rowCount } = await client.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    await client.query('COMMIT');
    return { deleted: rowCount };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function deleteGroup(db, cycleId, { category_code, title }, { force } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertCycleEditable(client, cycleId);

    const { rows: cat } = await client.query(
      `SELECT id FROM task_categories WHERE code = $1`, [category_code]);
    if (!cat.length) throw Object.assign(new Error('Unknown category'), { code: 'BAD_CATEGORY' });

    const { rows } = await client.query(
      `SELECT id FROM tasks
       WHERE uta_cycle_id = $1 AND category_id = $2 AND title = $3::varchar
       FOR UPDATE`, [cycleId, cat[0].id, title]);
    if (!rows.length) throw Object.assign(new Error('Group not found'), { code: 'NOT_FOUND' });

    const ids = rows.map(r => r.id);
    const n = await countCompletions(client, ids);
    if (n > 0 && !force) throw hasCompletions(n);

    await client.query(`DELETE FROM task_completions WHERE task_id = ANY($1)`, [ids]);
    const { rowCount } = await client.query(`DELETE FROM tasks WHERE id = ANY($1)`, [ids]);
    await client.query('COMMIT');
    return { deleted: rowCount };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

module.exports = { assertTaskInLiveCycle, assertTaskEditable, assertCycleEditable,
                   URGENCY_RANK, listGroups, addTaskBatch, copyForward, updateTask, updateGroup,
                   deleteTask, deleteGroup };
