const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');
const batches = require('../lib/batches');
const tasks = require('../lib/tasks');

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

test('listBatches returns this-cycle batches with member counts', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('July','draft',false) RETURNING id`);
  const r = await tasks.addTaskBatch(pool, c.id, {
    title: 'SGLI', category_code: f.catCode, details: null,
    assignments: [{ member_ids: [f.m1, f.m2], urgency: 'this_uta' }], created_by_id: f.leadId });
  const list = await batches.listBatches(pool, c.id);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].member_count, 2);
  assert.strictEqual(list[0].id, r.batch_id);
});

test('undoBatch deletes tasks; warns when checked off unless forced', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('July','draft',false) RETURNING id`);
  const r = await tasks.addTaskBatch(pool, c.id, {
    title: 'SGLI', category_code: f.catCode, details: null,
    assignments: [{ member_ids: [f.m1], urgency: 'this_uta' }], created_by_id: f.leadId });
  const { rows: [t] } = await pool.query(`SELECT id FROM tasks WHERE batch_id=$1`, [r.batch_id]);
  await pool.query(`INSERT INTO task_completions (task_id, completed_by_id, state)
                    VALUES ($1,$2,'done')`, [t.id, f.m1]);
  await assert.rejects(() => batches.undoBatch(pool, r.batch_id, { force: false }),
    (e) => e.code === 'HAS_COMPLETIONS' && e.checked_off_count === 1);
  await batches.undoBatch(pool, r.batch_id, { force: true });
  const { rows } = await pool.query(`SELECT 1 FROM tasks WHERE batch_id=$1`, [r.batch_id]);
  assert.strictEqual(rows.length, 0);
});
