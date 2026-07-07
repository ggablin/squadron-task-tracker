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

module.exports = { makePool };
