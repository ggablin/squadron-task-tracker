// sync-tasks.js — ADDITIVE mid-cycle task sync (companion to import-tasks.js)
//
// Unlike import-tasks.js (which DELETEs and reloads a whole cycle, wiping every
// member's check-offs), this script only INSERTs task rows that don't already
// exist. Nobody's task_completions are ever touched, so it is safe to run in the
// middle of a drill weekend to add a task or two.
//
// Idempotency comes from the UNIQUE(uta_cycle_id, member_id, category_id, title)
// constraint on `tasks` (added in schema.sql / the server.js boot migration for
// BUILD-PLAN C7 + TASK-BUILDER TB1). That constraint MUST exist before this runs
// — otherwise the `ON CONFLICT` clause errors (safely, with no data written).
// Check it with:
//   SELECT 1 FROM pg_constraint WHERE conname = 'tasks_cycle_member_cat_title_uniq';
// If the ALTER failed to apply, it is because the cycle already has duplicate
// (member, category, title) rows — de-dupe those first, then redeploy.
//
// Usage:
//   ENABLE_CRON=false DATABASE_URL=<conn> node sync-tasks.js <file.xlsx> ["Cycle Name"]
//   - Run import-tasks.js FIRST to create/populate the cycle; this only adds to it.
//   - If "Cycle Name" is omitted, the CURRENT cycle (is_current = true) is used.
//   - It does NOT create cycles and does NOT change which cycle is current.
//   - ENABLE_CRON=false is belt-and-suspenders (this script never loads server.js,
//     so the scheduled email/digest jobs don't run here regardless).
//
// Only the task sheets (Admin, CBT, Medical, Upgrade, Mobility, Other) are read.
// Work Orders / Shop Schedule stay with import-tasks.js.

const XLSX = require('xlsx');
const { Pool } = require('pg');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

const TASK_SHEETS = [
  { sheet: 'Admin',    category: 'admin',    label: 'Admin / Records',          sortOrder: 1, isUpcoming: false },
  { sheet: 'CBT',      category: 'cbt',      label: 'Computer Training (CBTs)', sortOrder: 2, isUpcoming: false },
  { sheet: 'Medical',  category: 'medical',  label: 'Medical / Fitness',        sortOrder: 3, isUpcoming: false },
  { sheet: 'Upgrade',  category: 'upgrade',  label: 'Upgrade Training',         sortOrder: 4, isUpcoming: true  },
  { sheet: 'Mobility', category: 'upcoming', label: 'Upcoming',                 sortOrder: 5, isUpcoming: true  },
  { sheet: 'Other',    category: 'other',    label: 'Other',                    sortOrder: 6, isUpcoming: false },
];

const URGENCY_MAP = {
  'this uta': 'this_uta',
  'next uta': 'next_uta',
  'overdue':  'overdue',
  'future':   'future',
  'info':     'info',
};

function str(val) {
  if (val === null || val === undefined || (typeof val === 'number' && isNaN(val))) return '';
  return String(val).trim();
}

async function run() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node sync-tasks.js <file.xlsx> ["Cycle Name"]');
    process.exit(1);
  }
  const cycleArg = process.argv[3] ? process.argv[3].trim() : null;

  console.log(`Additive task sync`);
  console.log(`From:      ${path.resolve(filePath)}`);

  const wb = XLSX.readFile(path.resolve(filePath));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Resolve the target cycle (never create it, never flip is_current) ──
    let utaId, cycleName;
    if (cycleArg) {
      const { rows } = await client.query('SELECT id, name FROM uta_cycles WHERE name = $1', [cycleArg]);
      if (!rows.length) {
        console.error(`❌ Cycle not found: "${cycleArg}". Run import-tasks.js first to create it.`);
        await client.query('ROLLBACK');
        process.exit(1);
      }
      utaId = rows[0].id; cycleName = rows[0].name;
    } else {
      const { rows } = await client.query('SELECT id, name FROM uta_cycles WHERE is_current = true LIMIT 1');
      if (!rows.length) {
        console.error('❌ Cycle not found: no current cycle set. Pass a cycle name or run import-tasks.js first.');
        await client.query('ROLLBACK');
        process.exit(1);
      }
      utaId = rows[0].id; cycleName = rows[0].name;
    }
    console.log(`Cycle:     ${cycleName} (id=${utaId}) — adding only, no deletes\n`);

    // ── 2. Lookup caches ─────────────────────────────────────────────────────
    const { rows: members } = await client.query(
      'SELECT id, slug FROM members WHERE active = true'
    );
    const memberMap = {};
    for (const m of members) memberMap[m.slug] = m.id;

    // ── 3. Ensure categories exist (idempotent) ──────────────────────────────
    const catIds = {};
    for (const ts of TASK_SHEETS) {
      const { rows: [cat] } = await client.query(`
        INSERT INTO task_categories (code, label, sort_order)
        VALUES ($1, $2, $3)
        ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order
        RETURNING id
      `, [ts.category, ts.label, ts.sortOrder]);
      catIds[ts.category] = cat.id;
    }

    // ── 4. Additively insert task rows (dedupe via UNIQUE constraint) ─────────
    let inserted = 0, skipped = 0, unknown = 0;

    for (const ts of TASK_SHEETS) {
      if (!wb.SheetNames.includes(ts.sheet)) continue;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[ts.sheet], { defval: '' });
      if (!rows.length) continue;

      let sheetInserted = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const slug  = str(row.slug).toLowerCase();
        const title = str(row.Title || row.title);
        if (!slug || !title) { continue; }

        const memberId = memberMap[slug];
        if (!memberId) {
          console.warn(`  SKIP (unknown slug "${slug}"): ${title}`);
          unknown++;
          continue;
        }

        const rawUrgency = str(row.Urgency || row.urgency).toLowerCase();
        const urgency    = URGENCY_MAP[rawUrgency] || rawUrgency || 'this_uta';
        const details      = str(row.Details || row.details) || null;
        const apptDay      = str(row['Appt Day'] || row.appt_day) || null;
        const apptTime     = str(row['Appt Time'] || row.appt_time) || null;
        const apptLocation = str(row['Appt Location'] || row.appt_location) || null;

        const r = await client.query(`
          INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency,
                             appt_day, appt_time, appt_location, is_upcoming, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (uta_cycle_id, member_id, category_id, title) DO NOTHING
          RETURNING id
        `, [utaId, memberId, catIds[ts.category], title, details, urgency,
            apptDay, apptTime, apptLocation, ts.isUpcoming, i]);
        if (r.rowCount) { inserted++; sheetInserted++; } else { skipped++; }
      }

      if (sheetInserted) console.log(`  ${ts.sheet.padEnd(12)} +${sheetInserted} new`);
    }

    // ── 5. Notify members who received new (non-upcoming) tasks this run ──────
    // Groups by member; one notification per affected member. Transactional
    // (client.query), and NO ON CONFLICT (the notifications table has no matching
    // unique key — duplicates are an intentional audit trail, matching import-tasks.js).
    const { rowCount: notified } = await client.query(`
      INSERT INTO notifications (member_id, type, title, body, link)
      SELECT m.id, 'tasks_live', $2,
             'New task' || CASE WHEN COUNT(*) = 1 THEN '' ELSE 's' END || ' added to ' || $3 || ' — ' || COUNT(*) || ' item' ||
               CASE WHEN COUNT(*) = 1 THEN '' ELSE 's' END || '.',
             'member'
      FROM members m
      JOIN tasks t ON t.member_id = m.id
      WHERE t.uta_cycle_id = $1 AND t.is_upcoming = false AND m.active = true
        AND t.created_at > NOW() - INTERVAL '1 minute'
      GROUP BY m.id
    `, [utaId, 'New tasks added to ' + cycleName, cycleName]);

    await client.query('COMMIT');
    console.log(`\n✅ Sync complete for ${cycleName}`);
    console.log(`   Inserted:  ${inserted} new task(s)`);
    console.log(`   Skipped:   ${skipped} already existed (no change)`);
    if (unknown) console.log(`   Unknown:   ${unknown} row(s) had a slug not in the roster`);
    console.log(`   Notified:  ${notified} member(s) (pending email flush by the running server)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Sync failed:', err.message);
    if (/no unique or exclusion constraint/i.test(err.message) || /ON CONFLICT/i.test(err.message)) {
      console.error('   → The UNIQUE(uta_cycle_id, member_id, category_id, title) constraint is missing.');
      console.error('     Apply the C7/TB1 schema migration (or redeploy) before running sync-tasks.js.');
    }
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
