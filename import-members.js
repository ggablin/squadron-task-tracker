// import-members.js — reads Members.xlsx and upserts all members into the database
// Run: DATABASE_URL=<connection string> node import-members.js

const XLSX   = require('xlsx');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path   = require('path');

const VALID_ROLES = new Set(['member', 'supervisor', 'leadership']);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function run() {
  const xlsxPath = path.join(__dirname, '..', 'Members.xlsx');
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  console.log(`Found ${rows.length} rows in Members.xlsx\n`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const shopCache = {};
    let added = 0, updated = 0, skipped = 0, errors = 0;

    for (const row of rows) {
      const last_name  = String(row.last_name  || '').trim();
      const first_name = String(row.first_name || '').trim();
      const rank       = String(row.rank       || '').trim();
      const shop       = String(row.shop       || '').trim();
      const role       = String(row.role       || '').trim().toLowerCase();
      const slug       = String(row.slug       || '').trim().toLowerCase();
      const active     = String(row.active     || '').trim().toUpperCase() !== 'FALSE';
      const email      = String(row.email      || '').trim() || null;

      if (!last_name || !first_name || !rank || !shop || !slug) {
        console.warn(`  SKIP (missing fields): row ${JSON.stringify({ last_name, first_name, rank, shop, slug })}`);
        skipped++;
        continue;
      }

      if (!VALID_ROLES.has(role)) {
        console.warn(`  SKIP (invalid role "${role}"): ${slug} — must be member, supervisor, or leadership`);
        errors++;
        continue;
      }

      // Upsert shop
      if (!shopCache[shop]) {
        const { rows: [s] } = await client.query(`
          INSERT INTO shops (name) VALUES ($1)
          ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
          RETURNING id
        `, [shop]);
        shopCache[shop] = s.id;
      }
      const shopId = shopCache[shop];

      // Check if member already exists (by slug)
      const { rows: existing } = await client.query(
        'SELECT id FROM members WHERE slug = $1', [slug]
      );

      if (existing.length) {
        // Update name/rank/shop/role/active/email — never overwrite password_hash
        await client.query(`
          UPDATE members
          SET last_name=$1, first_name=$2, rank=$3, shop_id=$4, role=$5, active=$6, email=$7
          WHERE slug=$8
        `, [last_name, first_name, rank, shopId, role, active, email, slug]);
        console.log(`  UPDATE  ${rank.padEnd(6)} ${slug.padEnd(15)} role:${role}`);
        updated++;
      } else {
        // New member — initial password = slug (last name)
        const hash = await bcrypt.hash(slug, 10);
        await client.query(`
          INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active, email)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [last_name, first_name, rank, shopId, role, slug, hash, active, email]);
        console.log(`  INSERT  ${rank.padEnd(6)} ${slug.padEnd(15)} role:${role}  pwd:${slug}`);
        added++;
      }
    }

    await client.query('COMMIT');
    console.log(`\n✅ Done. Added: ${added}  Updated: ${updated}  Skipped: ${skipped}  Errors: ${errors}`);
    if (added > 0) {
      console.log('\n⚠  Initial passwords = slug (last name). Distribute securely before going live.');
    }
    if (errors > 0) {
      console.log(`\n⚠  ${errors} row(s) skipped due to invalid role values — fix in Members.xlsx and re-run.`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Import failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
