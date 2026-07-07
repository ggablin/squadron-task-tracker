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
