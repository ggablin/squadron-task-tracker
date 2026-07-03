// reset-default-passwords.js — one-time C1 companion: close the takeover window
// for EXISTING members who are still on their guessable last-name (slug) password.
//
// Why this exists: the C1 change to import-members.js only randomizes NEW members'
// passwords. Members already in the DB keep whatever password_hash they have, and
// requireOnboarded gates *mutations* — not login or POST /api/auth/password. So any
// member still on their slug default can be logged into by anyone who reads the
// newsletter, who can then change the password and lock out the real member. This
// script reissues a random one-time password for every member STILL on their slug,
// and forces a change at next login. Members who already set their own password
// (i.e., not on the slug) are left untouched.
//
// Detection is exact: bcrypt.compare(slug, password_hash). Only true-on-slug rows
// are reset, so this is idempotent — a second run touches nobody.
//
// Usage:
//   DATABASE_URL=<conn> node reset-default-passwords.js --dry-run   # preview only
//   DATABASE_URL=<conn> node reset-default-passwords.js             # apply
//
// The new temp passwords are printed ONCE to stdout (pwd:XXXXXXXX per member) and
// stored nowhere else. Capture the log and distribute securely (supervisors ->
// members), same as import-members.js. TAKE A DB BACKUP FIRST.

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

function randomTemp() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
  const bytes = crypto.randomBytes(8);
  let temp = '';
  for (let i = 0; i < 8; i++) temp += alphabet[bytes[i] % alphabet.length];
  return temp;
}

async function run() {
  console.log(DRY_RUN ? 'DRY RUN — no changes will be written\n' : 'APPLYING — resetting default passwords\n');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: members } = await client.query(
      'SELECT id, rank, slug, password_hash FROM members WHERE active = true ORDER BY slug'
    );

    let onDefault = 0, reset = 0, safe = 0;
    for (const m of members) {
      const stillDefault = await bcrypt.compare(m.slug, m.password_hash);
      if (!stillDefault) { safe++; continue; }
      onDefault++;

      if (DRY_RUN) {
        console.log(`  ON DEFAULT  ${String(m.rank).padEnd(6)} ${m.slug}`);
        continue;
      }

      const temp = randomTemp();
      const hash = await bcrypt.hash(temp, 10);
      await client.query(
        'UPDATE members SET password_hash = $1, must_change_password = true WHERE id = $2',
        [hash, m.id]
      );
      console.log(`  RESET  ${String(m.rank).padEnd(6)} ${m.slug.padEnd(15)} pwd:${temp}`);
      reset++;
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log(`\n✅ Dry run complete. ${onDefault} member(s) still on their slug default; ${safe} already have their own password.`);
      console.log('   Re-run without --dry-run to reset the on-default accounts.');
    } else {
      await client.query('COMMIT');
      console.log(`\n✅ Done. Reset: ${reset}  Already safe: ${safe}`);
      if (reset > 0) {
        console.log('\n⚠  The temp passwords above are the ONLY copy — capture this log and distribute securely.');
        console.log('   Every reset member must set their own password at first login.');
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
