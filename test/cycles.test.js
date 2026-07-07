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

test('goLive promotes a draft, archives the prior live, returns members to notify', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('June 2026','live',true) RETURNING id`);
  const draft = await cycles.createDraft(pool, 'July 2026');
  await pool.query(`INSERT INTO tasks (uta_cycle_id, member_id, category_id, title)
                    VALUES ($1,$2,$3,'T')`, [draft.id, f.m1, f.catId]);
  const r = await cycles.goLive(pool, draft.id, { confirm: false });
  assert.strictEqual(r.cycle.is_current, true);
  const { rows } = await pool.query(`SELECT status,is_current FROM uta_cycles WHERE id=$1`, [live.id]);
  assert.deepStrictEqual(rows[0], { status: 'archived', is_current: false });
  const { rows: liveCount } = await pool.query(`SELECT COUNT(*)::int n FROM uta_cycles WHERE is_current`);
  assert.strictEqual(liveCount[0].n, 1);
  assert.ok(r.notifyMemberIds.includes(f.m1));
});

test('goLive refuses an empty draft unless confirmed', async () => {
  await resetDb(); await seedFixtures();
  const draft = await cycles.createDraft(pool, 'Empty');
  await assert.rejects(() => cycles.goLive(pool, draft.id, { confirm: false }), (e) => e.code === 'EMPTY_DRAFT');
});

test('discardDraft removes a draft but refuses a live cycle', async () => {
  await resetDb(); await seedFixtures();
  const draft = await cycles.createDraft(pool, 'Scratch');
  await cycles.discardDraft(pool, draft.id);
  const { rows } = await pool.query(`SELECT 1 FROM uta_cycles WHERE id=$1`, [draft.id]);
  assert.strictEqual(rows.length, 0);
  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('Live','live',true) RETURNING id`);
  await assert.rejects(() => cycles.discardDraft(pool, live.id), (e) => e.code === 'NOT_DRAFT');
});

test('goLive works with no prior live cycle (bootstrap) — exactly one live after', async () => {
  await resetDb(); const f = await seedFixtures();
  const draft = await cycles.createDraft(pool, 'First Cycle');
  await pool.query(`INSERT INTO tasks (uta_cycle_id, member_id, category_id, title) VALUES ($1,$2,$3,'T')`, [draft.id, f.m1, f.catId]);
  await cycles.goLive(pool, draft.id, { confirm: false });
  const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM uta_cycles WHERE is_current`);
  assert.strictEqual(rows[0].n, 1);
});

test('goLive with confirm:true publishes an empty draft', async () => {
  await resetDb(); await seedFixtures();
  const draft = await cycles.createDraft(pool, 'Empty but confirmed');
  const r = await cycles.goLive(pool, draft.id, { confirm: true });
  assert.strictEqual(r.cycle.is_current, true);
});

test('goLive refuses a non-draft cycle', async () => {
  await resetDb(); await seedFixtures();
  const { rows: [live] } = await pool.query(`INSERT INTO uta_cycles (name,status,is_current) VALUES ('Live','live',true) RETURNING id`);
  await assert.rejects(() => cycles.goLive(pool, live.id, { confirm: true }), (e) => e.code === 'NOT_DRAFT');
});
