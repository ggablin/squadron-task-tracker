// Covers the advisory lock that serializes schema writers (lib/db.js).
//
// The bug this prevents: server.js runs its boot migration on every startup
// without waiting for anyone, and each test file requires server.js while the
// harness applies schema.sql on a separate connection. Both take
// AccessExclusiveLock on the same tables, Postgres picks a deadlock victim, and
// the suite goes red on a coin flip — CI reproduced exactly that, failing run 1
// and passing run 2 of an identical commit.
//
// These tests assert the mechanism itself rather than the symptom, because the
// symptom is by definition intermittent and a test that only fails sometimes is
// worse than no test at all.
const { test } = require('node:test');
const assert = require('node:assert');
const { pool } = require('./helpers/db');
const { acquireMigrationLock, MIGRATION_LOCK_KEY } = require('../lib/db');

// Counts sessions currently holding our advisory key. A single-argument
// pg_advisory_lock(bigint) lands in pg_locks with the high 32 bits in classid
// and the low 32 in objid, so a key below 2^31 reads back as objid directly.
async function holders() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM pg_locks
      WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND granted`,
    [MIGRATION_LOCK_KEY]
  );
  return rows[0].n;
}

test('a second migration queues behind the first instead of racing it', async () => {
  const releaseFirst = await acquireMigrationLock(pool);

  let secondGotIt = false;
  const second = acquireMigrationLock(pool).then((release) => {
    secondGotIt = true;
    return release;
  });

  // Long enough that a non-blocking implementation would have sailed through.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    secondGotIt, false,
    'the second acquire should still be waiting while the first holds the lock'
  );

  await releaseFirst();

  const releaseSecond = await second;   // hangs the test if the lock never frees
  assert.equal(secondGotIt, true);
  await releaseSecond();
});

test('releasing actually frees the lock rather than leaking the session', async () => {
  assert.equal(await holders(), 0, 'no one should hold the lock before we start');

  const release = await acquireMigrationLock(pool);
  assert.equal(await holders(), 1, 'the lock should be visible in pg_locks while held');

  await release();
  assert.equal(await holders(), 0, 'the lock should be gone once released');
});

test('the lock is reentrant across sequential callers, so repeated boots are fine', async () => {
  for (let i = 0; i < 3; i++) {
    const release = await acquireMigrationLock(pool);
    await release();
  }
  assert.equal(await holders(), 0, 'nothing should be left holding the lock');
});
