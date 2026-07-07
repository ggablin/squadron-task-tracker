const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');
const tasks = require('../lib/tasks');

test.before(applySchema);

test('listGroups groups a cycle\'s tasks by category+title with members', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('June','archived',false) RETURNING id`);
  await pool.query(`INSERT INTO tasks (uta_cycle_id,member_id,category_id,title,urgency)
                    VALUES ($1,$2,$3,'SGLI','this_uta'),($1,$4,$3,'SGLI','this_uta')`,
                   [c.id, f.m1, f.catId, f.m2]);
  const groups = await tasks.listGroups(pool, c.id);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].title, 'SGLI');
  assert.strictEqual(groups[0].count, 2);
  assert.strictEqual(groups[0].members.length, 2);
});

test('addTaskBatch inserts one row per member per assignment, additively', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('July','draft',false) RETURNING id`);
  const r = await tasks.addTaskBatch(pool, c.id, {
    title: 'SGLI', category_code: f.catCode, details: null,
    assignments: [{ member_ids: [f.m1, f.m2], urgency: 'this_uta' }], created_by_id: f.leadId,
  });
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.skipped, 0);
  const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM tasks WHERE batch_id=$1`, [r.batch_id]);
  assert.strictEqual(rows[0].n, 2);
});

test('addTaskBatch skips duplicates via ON CONFLICT and reports skipped', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('July','draft',false) RETURNING id`);
  const base = { title: 'SGLI', category_code: f.catCode, details: null, created_by_id: f.leadId };
  await tasks.addTaskBatch(pool, c.id, { ...base, assignments: [{ member_ids: [f.m1], urgency: 'this_uta' }] });
  const r = await tasks.addTaskBatch(pool, c.id, { ...base, assignments: [{ member_ids: [f.m1, f.m2], urgency: 'this_uta' }] });
  assert.strictEqual(r.added, 1);   // m2 only
  assert.strictEqual(r.skipped, 1); // m1 already existed
});
