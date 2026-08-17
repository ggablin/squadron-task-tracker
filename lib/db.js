const { Pool } = require('pg');

// SSL on for Railway (public host *.rlwy.net has no "railway" substring, so
// check both) — off for a plain local Postgres.
function makePool(connectionString) {
  const needsSsl = /railway|rlwy\.net/.test(connectionString || '');
  return new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
  });
}

// ── Migration serialization ─────────────────────────────────────────────────
//
// Schema work can run from more than one process against the same database at
// the same time. Two real cases, both observed:
//
//   1. A Railway deploy briefly runs two instances, and server.js's boot
//      migration block fires unconditionally on every startup.
//   2. Each test file spawns a process that requires server.js — which starts
//      that same migration without waiting for anyone — while the test harness
//      applies schema.sql on its own connection.
//
// Both sides take AccessExclusiveLock on the same tables, so Postgres detects a
// deadlock and kills one of them. Retrying (withDeadlockRetry in server.js, the
// loop in test/helpers/db.js) makes that survivable but not reliable: CI failed
// on run 1 and passed unchanged on run 2 of the same commit.
//
// An advisory lock makes the racers queue instead of collide. It is held on a
// dedicated connection because advisory locks are session-scoped — taking it
// through the pool would let a later query land on a different connection and
// release nothing. The DDL itself still runs on the pool; all that matters is
// that the lock is held for the duration.
//
// If the process dies, Postgres ends the session and drops the lock for us, so
// a crashed migration cannot wedge the next boot.
const MIGRATION_LOCK_KEY = 108108;

async function acquireMigrationLock(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  } catch (err) {
    client.release();
    throw err;
  }
  return async function release() {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch {
      // The session is already gone, which released the lock anyway.
    } finally {
      client.release();
    }
  };
}

module.exports = { makePool, acquireMigrationLock, MIGRATION_LOCK_KEY };
