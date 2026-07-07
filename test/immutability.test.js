const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');
const { assertTaskInLiveCycle } = require('../lib/tasks');

test.before(applySchema);

test('rejects completion writes on a non-live (archived) cycle', async () => {
  await resetDb();
  const f = await seedFixtures();
  const { rows: [arch] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('May 2026','archived',false) RETURNING id`);
  const { rows: [t] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title) VALUES ($1,$2,$3,'Old') RETURNING id`,
    [arch.id, f.m1, f.catId]);
  await assert.rejects(() => assertTaskInLiveCycle(pool, t.id), (e) => e.code === 'NOT_LIVE');
});

test('allows completion writes on the live cycle', async () => {
  await resetDb();
  const f = await seedFixtures();
  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('June 2026','live',true) RETURNING id`);
  const { rows: [t] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title) VALUES ($1,$2,$3,'Now') RETURNING id`,
    [live.id, f.m1, f.catId]);
  await assert.doesNotReject(() => assertTaskInLiveCycle(pool, t.id));
});

test('a draft cycle\'s tasks are invisible to members (is_current filter)', async () => {
  await resetDb();
  const f = await seedFixtures();
  const { rows: [draft] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('July 2026','draft',false) RETURNING id`);
  await pool.query(`INSERT INTO tasks (uta_cycle_id, member_id, category_id, title)
                    VALUES ($1,$2,$3,'Draft task')`, [draft.id, f.m1, f.catId]);
  // Mirror the member fetch: only tasks in the current cycle.
  const { rows } = await pool.query(
    `SELECT t.id FROM tasks t JOIN uta_cycles c ON c.id = t.uta_cycle_id
     WHERE t.member_id = $1 AND c.is_current = true`, [f.m1]);
  assert.strictEqual(rows.length, 0);
});
