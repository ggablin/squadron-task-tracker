const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb } = require('./helpers/db');

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
