const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');
const cycles = require('../lib/cycles');

test.before(applySchema);

test('backfill sets is_current cycle to live and others to archived', async () => {
  await resetDb();
  await pool.query(`INSERT INTO uta_cycles (name, is_current, status) VALUES ('May 2026', false, NULL)`);
  await pool.query(`INSERT INTO uta_cycles (name, is_current, status) VALUES ('June 2026', true, NULL)`);
  await pool.query(`UPDATE uta_cycles SET status = CASE WHEN is_current THEN 'live' ELSE 'archived' END WHERE status IS NULL`);
  const { rows } = await pool.query(`SELECT name, status FROM uta_cycles ORDER BY name`);
  assert.deepStrictEqual(rows, [
    { name: 'June 2026', status: 'live' },
    { name: 'May 2026', status: 'archived' },
  ]);
});

test('backfill is idempotent — a second run is a no-op and leaves values unchanged', async () => {
  await resetDb();
  await pool.query(`INSERT INTO uta_cycles (name, is_current, status) VALUES ('May 2026', false, NULL), ('June 2026', true, NULL)`);
  await pool.query(`UPDATE uta_cycles SET status = CASE WHEN is_current THEN 'live' ELSE 'archived' END WHERE status IS NULL`);
  await pool.query(`UPDATE uta_cycles SET status = CASE WHEN is_current THEN 'live' ELSE 'archived' END WHERE status IS NULL`);
  const { rows } = await pool.query(`SELECT name, status FROM uta_cycles ORDER BY name`);
  assert.deepStrictEqual(rows, [
    { name: 'June 2026', status: 'live' },
    { name: 'May 2026', status: 'archived' },
  ]);
});

test('createDraft creates a draft that is not current', async () => {
  await resetDb(); await seedFixtures();
  const d = await cycles.createDraft(pool, 'July 2026');
  assert.strictEqual(d.status, 'draft');
  assert.strictEqual(d.is_current, false);
});

test('listCycles returns cycles with task counts, newest first', async () => {
  await resetDb(); const f = await seedFixtures();
  const d = await cycles.createDraft(pool, 'July 2026');
  await pool.query(`INSERT INTO tasks (uta_cycle_id, member_id, category_id, title)
                    VALUES ($1,$2,$3,'T')`, [d.id, f.m1, f.catId]);
  const list = await cycles.listCycles(pool);
  assert.strictEqual(list[0].name, 'July 2026');
  assert.strictEqual(Number(list[0].task_count), 1);
});
