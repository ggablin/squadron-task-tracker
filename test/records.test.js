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

test('memberHistory carries drill attendance per cycle, including a cycle with no tasks', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [aug] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current,start_date,end_date,period_count,created_at)
     VALUES ('Aug','archived',false,'2026-08-08','2026-08-09',4, NOW() - INTERVAL '60 days') RETURNING id`);
  const { rows: [sep] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current,created_at) VALUES ('Sep','live',true, NOW()) RETURNING id`);
  // Sep gave the member a task but no marks yet; Aug marked them but built no tasks for them.
  await pool.query(`INSERT INTO tasks (uta_cycle_id,member_id,category_id,title) VALUES ($1,$2,$3,'A')`, [sep.id, f.m1, f.catId]);
  await pool.query(
    `INSERT INTO attendance (uta_cycle_id,member_id,shop_id,period,status,note)
     VALUES ($1,$2,$3,1,'present',NULL), ($1,$2,$3,2,'ruta_excused','dental')`,
    [aug.id, f.m1, f.shopId]);

  const hist = await records.memberHistory(pool, f.m1);
  assert.deepStrictEqual(hist.map(h => h.cycle.name), ['Sep', 'Aug'], 'newest first across both sources');
  assert.deepStrictEqual(hist[0].attendance, []);
  assert.deepStrictEqual(hist[0].periods, [], 'no marks, no strip');
  assert.strictEqual(hist[1].tasks.length, 0);
  assert.strictEqual(hist[1].total, 0);
  assert.strictEqual(hist[1].periods.length, 4, 'labels come from the cycle dates');
  assert.deepStrictEqual(
    hist[1].attendance.map(a => [a.period, a.status, a.pay, a.note]),
    [[1, 'present', '/', null], [2, 'ruta_excused', 'R', 'dental']]);
  assert.strictEqual(hist[1].attendance[1].label, 'RUTA / Excused');
  assert.ok(!('created_at' in hist[1]), 'the sort key does not leak into the payload');
});
