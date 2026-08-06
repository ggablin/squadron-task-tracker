// password-status.js — read-only report: who has set their own password, and who
// is still sitting on the temp password they were issued.
//
// The signal is members.must_change_password. It starts true for every account
// (import-members.js sets it on INSERT; reset-default-passwords.js and the admin
// reset endpoint set it back to true), and the ONLY thing that clears it is the
// member changing their own password via POST /api/auth/password. So
// must_change_password = false means that member logged in and set a password.
//
// Caveat worth knowing when you read the numbers: the reverse is not true. A
// member who logged in but never changed their password looks identical to one
// who never logged in at all — nothing records logins. So "Changed" is a floor on
// how many people have actually been in the app, not an exact count.
//
// Usage:
//   DATABASE_URL=<conn> node password-status.js              # active members
//   DATABASE_URL=<conn> node password-status.js --all        # include inactive
//   DATABASE_URL=<conn> node password-status.js --csv        # CSV to stdout
//
// Writes nothing — safe to run against production any time.

const { Pool } = require('pg');

const INCLUDE_INACTIVE = process.argv.includes('--all');
const AS_CSV = process.argv.includes('--csv');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function run() {
  const { rows } = await pool.query(`
    SELECT m.rank, m.last_name, m.first_name, m.slug, m.role, m.active,
           m.must_change_password,
           COALESCE(s.name, '(no shop)') AS shop
    FROM members m
    LEFT JOIN shops s ON s.id = m.shop_id
    ${INCLUDE_INACTIVE ? '' : 'WHERE m.active = true'}
    ORDER BY shop, m.last_name, m.first_name
  `);

  const changed = rows.filter((r) => !r.must_change_password);
  const pending = rows.filter((r) => r.must_change_password);

  if (AS_CSV) {
    console.log('status,rank,last_name,first_name,slug,shop,role,active');
    for (const r of rows) {
      console.log([
        r.must_change_password ? 'on-temp-password' : 'changed',
        r.rank, r.last_name, r.first_name, r.slug, r.shop, r.role, r.active,
      ].map(csvCell).join(','));
    }
    return;
  }

  const line = (r) =>
    `  ${String(r.rank).padEnd(6)} ${`${r.last_name}, ${r.first_name}`.padEnd(26)} ` +
    `${String(r.slug).padEnd(15)} ${r.shop}${r.active ? '' : '  [inactive]'}`;

  console.log(`CHANGED THEIR PASSWORD — ${changed.length} member(s)\n`);
  if (changed.length) changed.forEach((r) => console.log(line(r)));
  else console.log('  (none)');

  console.log(`\nSTILL ON THE ISSUED TEMP PASSWORD — ${pending.length} member(s)\n`);
  if (pending.length) pending.forEach((r) => console.log(line(r)));
  else console.log('  (none)');

  const pct = rows.length ? Math.round((changed.length / rows.length) * 100) : 0;
  console.log(
    `\n${changed.length} of ${rows.length} ${INCLUDE_INACTIVE ? '' : 'active '}` +
    `member(s) have set their own password (${pct}%).`
  );
}

run()
  .catch((err) => {
    console.error('❌ Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
