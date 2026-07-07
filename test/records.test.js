const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');
const records = require('../lib/records');

test.before(applySchema);

test('memberHistory summarizes done/total per cycle, newest first', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [june] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current,created_at) VALUES ('June','archived',false, NOW() - INTERVAL '30 days') RETURNING id`);
  const { rows: [t1] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id,member_id,category_id,title) VALUES ($1,$2,$3,'A') RETURNING id`, [june.id, f.m1, f.catId]);
  await pool.query(`INSERT INTO tasks (uta_cycle_id,member_id,category_id,title) VALUES ($1,$2,$3,'B')`, [june.id, f.m1, f.catId]);
  await pool.query(`INSERT INTO task_completions (task_id, completed_by_id, state) VALUES ($1,$2,'done')`, [t1.id, f.m1]);
  const hist = await records.memberHistory(pool, f.m1);
  assert.strictEqual(hist[0].cycle.name, 'June');
  assert.strictEqual(hist[0].total, 2);
  assert.strictEqual(hist[0].done, 1);
  assert.strictEqual(hist[0].tasks.length, 2);
});
