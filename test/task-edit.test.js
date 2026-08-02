const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');
const tasks = require('../lib/tasks');

test.before(applySchema);

// Creates a cycle with the given status and returns its id.
async function mkCycle(status, isCurrent = false) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ($1,$2,$3) RETURNING id`,
    ['Aug 2026', status, isCurrent]);
  return c.id;
}

// Inserts one task row directly and returns its id.
async function mkTask(cycleId, memberId, catId, title, urgency = 'this_uta') {
  const { rows: [t] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [cycleId, memberId, catId, title, urgency]);
  return t.id;
}

test('URGENCY_RANK orders by severity, not alphabetically', () => {
  const R = tasks.URGENCY_RANK;
  assert.ok(R.overdue > R.this_uta, 'overdue outranks this_uta');
  assert.ok(R.this_uta > R.next_uta, 'this_uta outranks next_uta');
  assert.ok(R.next_uta > R.future,   'next_uta outranks future');
  assert.ok(R.future  > R.info,      'future outranks info');
  // The bug this guards: string MIN() sorts future < info < next_uta < overdue
  // < this_uta, which would make this_uta the most severe value.
  assert.ok(R.overdue > R.this_uta, 'alphabetical ordering would fail here');
});

test('assertTaskEditable allows draft and live, rejects archived', async () => {
  await resetDb(); const f = await seedFixtures();

  const draft = await mkCycle('draft');
  const draftTask = await mkTask(draft, f.m1, f.catId, 'CBT');
  await assert.doesNotReject(() => tasks.assertTaskEditable(pool, draftTask));

  const live = await mkCycle('live', true);
  const liveTask = await mkTask(live, f.m1, f.catId, 'CBT');
  await assert.doesNotReject(() => tasks.assertTaskEditable(pool, liveTask));

  const archived = await mkCycle('archived');
  const archivedTask = await mkTask(archived, f.m1, f.catId, 'CBT');
  await assert.rejects(() => tasks.assertTaskEditable(pool, archivedTask),
    (e) => e.code === 'NOT_EDITABLE');
});

test('assertTaskEditable treats a NULL status as editable', async () => {
  await resetDb(); const f = await seedFixtures();
  // status has no NOT NULL constraint and its backfill lives in a migration
  // block that swallows errors. Under `<> 'archived'` this row would compare
  // NULL (falsy) and be wrongly rejected.
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('Legacy', NULL, false) RETURNING id`);
  const t = await mkTask(c.id, f.m1, f.catId, 'CBT');
  await assert.doesNotReject(() => tasks.assertTaskEditable(pool, t));
});

test('assertCycleEditable rejects an archived cycle by id', async () => {
  await resetDb();
  const archived = await mkCycle('archived');
  await assert.rejects(() => tasks.assertCycleEditable(pool, archived),
    (e) => e.code === 'NOT_EDITABLE');
  const draft = await mkCycle('draft');
  await assert.doesNotReject(() => tasks.assertCycleEditable(pool, draft));
});

test('listGroups flags a group whose members hold different urgencies', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  await mkTask(c, f.m1, f.catId, 'CBT', 'this_uta');
  await mkTask(c, f.m2, f.catId, 'CBT', 'overdue');

  const [g] = await tasks.listGroups(pool, c);
  assert.strictEqual(g.count, 2);
  assert.strictEqual(g.urgency_mixed, true, 'divergent urgency must be reported');
  assert.strictEqual(g.details_mixed, false, 'both details are NULL, so not mixed');
});

test('listGroups reports a uniform group as not mixed', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  await mkTask(c, f.m1, f.catId, 'CBT', 'this_uta');
  await mkTask(c, f.m2, f.catId, 'CBT', 'this_uta');

  const [g] = await tasks.listGroups(pool, c);
  assert.strictEqual(g.urgency_mixed, false);
});

test('listGroups flags a group with different non-null details', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const t1 = await mkTask(c, f.m1, f.catId, 'PT Test', 'this_uta');
  const t2 = await mkTask(c, f.m2, f.catId, 'PT Test', 'this_uta');
  // Set different details on each task
  await pool.query('UPDATE tasks SET details = $1 WHERE id = $2', ['bring your CAC', t1]);
  await pool.query('UPDATE tasks SET details = $1 WHERE id = $2', ['wear PT uniform', t2]);

  const [g] = await tasks.listGroups(pool, c);
  assert.strictEqual(g.count, 2);
  assert.strictEqual(g.details_mixed, true, 'two distinct non-null values must be reported as mixed');
});

test('listGroups flags a group with mixed NULL and non-null details', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const t1 = await mkTask(c, f.m1, f.catId, 'Dental', 'this_uta');
  const t2 = await mkTask(c, f.m2, f.catId, 'Dental', 'this_uta');
  // Set details on only one task, leave the other NULL
  await pool.query('UPDATE tasks SET details = $1 WHERE id = $2', ['appointment at 1400', t1]);

  const [g] = await tasks.listGroups(pool, c);
  assert.strictEqual(g.count, 2);
  assert.strictEqual(g.details_mixed, true, 'NULL and non-null must be reported as mixed (regression for Finding 1)');
});

test('updateTask changes one row and leaves its group siblings alone', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const mine = await mkTask(c, f.m1, f.catId, 'CBT', 'future');
  const theirs = await mkTask(c, f.m2, f.catId, 'CBT', 'future');

  const r = await tasks.updateTask(pool, mine, { urgency: 'overdue' });
  assert.strictEqual(r.updated, 1);

  const { rows } = await pool.query(`SELECT id, urgency FROM tasks WHERE id = ANY($1)`, [[mine, theirs]]);
  const by = Object.fromEntries(rows.map(r => [r.id, r.urgency]));
  assert.strictEqual(by[mine], 'overdue');
  assert.strictEqual(by[theirs], 'future', 'the sibling row must not move');
});

test('updateTask writes all three appointment fields', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const t = await mkTask(c, f.m1, f.catId, 'Dental');

  await tasks.updateTask(pool, t, {
    appt_day: 'Saturday', appt_time: '0900', appt_location: 'Med Group' });

  const { rows: [row] } = await pool.query(
    `SELECT appt_day, appt_time, appt_location FROM tasks WHERE id=$1`, [t]);
  assert.deepStrictEqual(row,
    { appt_day: 'Saturday', appt_time: '0900', appt_location: 'Med Group' });
});

test('updateTask reports escalation only when urgency rises', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);

  const up = await mkTask(c, f.m1, f.catId, 'A', 'this_uta');
  const rUp = await tasks.updateTask(pool, up, { urgency: 'overdue' });
  assert.deepStrictEqual(rUp.escalated_member_ids, [f.m1], 'this_uta -> overdue escalates');

  const down = await mkTask(c, f.m1, f.catId, 'B', 'overdue');
  const rDown = await tasks.updateTask(pool, down, { urgency: 'future' });
  assert.deepStrictEqual(rDown.escalated_member_ids, [], 'overdue -> future does not');

  const same = await mkTask(c, f.m1, f.catId, 'C', 'this_uta');
  const rSame = await tasks.updateTask(pool, same, { details: 'typo fixed' });
  assert.deepStrictEqual(rSame.escalated_member_ids, [], 'a details-only edit does not');
});

test('updateTask leaves omitted fields alone and clears explicit nulls', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const t = await mkTask(c, f.m1, f.catId, 'CBT', 'this_uta');
  await pool.query(`UPDATE tasks SET details='keep me', appt_day='Sunday' WHERE id=$1`, [t]);

  await tasks.updateTask(pool, t, { appt_day: null });

  const { rows: [row] } = await pool.query(
    `SELECT details, appt_day, urgency FROM tasks WHERE id=$1`, [t]);
  assert.strictEqual(row.details, 'keep me', 'omitted field untouched');
  assert.strictEqual(row.appt_day, null, 'explicit null clears');
  assert.strictEqual(row.urgency, 'this_uta', 'omitted urgency untouched');
});

test('updateTask refuses an archived cycle', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('archived');
  const t = await mkTask(c, f.m1, f.catId, 'CBT');
  await assert.rejects(() => tasks.updateTask(pool, t, { urgency: 'overdue' }),
    (e) => e.code === 'NOT_EDITABLE');
});

test('updateTask with no fields is a no-op', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const t = await mkTask(c, f.m1, f.catId, 'CBT');
  const r = await tasks.updateTask(pool, t, {});
  assert.deepStrictEqual(r, { updated: 0, escalated_member_ids: [] });
});

module.exports = { mkCycle, mkTask };
