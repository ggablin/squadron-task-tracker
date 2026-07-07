const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');

test.before(applySchema);

test('a task can be linked to a batch', async () => {
  await resetDb();
  const f = await seedFixtures();
  const { rows: [cyc] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('July 2026','draft',false) RETURNING id`);
  const { rows: [b] } = await pool.query(
    `INSERT INTO task_batches (uta_cycle_id, label, kind, created_by_id)
     VALUES ($1,'Update SGLI','new_task',$2) RETURNING id`, [cyc.id, f.leadId]);
  const { rows: [t] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, batch_id)
     VALUES ($1,$2,$3,'Update SGLI',$4) RETURNING batch_id`, [cyc.id, f.m1, f.catId, b.id]);
  assert.strictEqual(t.batch_id, b.id);
});
