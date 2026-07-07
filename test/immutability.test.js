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
