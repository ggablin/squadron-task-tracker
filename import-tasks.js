// import-tasks.js — reads a UTA template Excel and imports tasks + shop events
// Usage: node import-tasks.js <template.xlsx> ["Cycle Name"]
// Example: node import-tasks.js "../May 2026 UTA - Sample Template.xlsx" "May 2026 UTA"
// If cycle name is omitted, it's derived from the filename (everything before " - ").

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
    console.error('Usage: node import-tasks.js <template.xlsx> ["Cycle Name"]');
    process.exit(1);
  }

  const cycleName = process.argv[3]
    || path.basename(filePath, '.xlsx').split(' - ')[0].trim();

  console.log(`Importing: ${cycleName}`);
  console.log(`From:      ${path.resolve(filePath)}\n`);

  const wb = XLSX.readFile(path.resolve(filePath));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 0. Ensure squadron_events table exists ────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS squadron_events (
        id            SERIAL PRIMARY KEY,
        uta_cycle_id  INTEGER REFERENCES uta_cycles(id),
        day           VARCHAR(20),
        start_time    VARCHAR(10),
        end_time      VARCHAR(10),
        title         VARCHAR(255) NOT NULL,
        details       TEXT,
        kind          VARCHAR(20) CHECK (kind IN
                        ('formation','training','meeting','briefing','medical','work','admin','lunch')),
        is_concurrent BOOLEAN DEFAULT false,
        emphasis      TEXT,
        attendees     JSONB,
        created_by_id INTEGER REFERENCES members(id),
        sort_order    INTEGER DEFAULT 99,
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── 1. Find or create UTA cycle ──────────────────────────────────────────
    await client.query('UPDATE uta_cycles SET is_current = false WHERE is_current = true');
    const { rows: existingCycles } = await client.query(
      'SELECT id FROM uta_cycles WHERE name = $1', [cycleName]
    );
    let utaId;
    if (existingCycles.length) {
      utaId = existingCycles[0].id;
      await client.query('UPDATE uta_cycles SET is_current = true WHERE id = $1', [utaId]);
    } else {
      const { rows: [newCycle] } = await client.query(
        'INSERT INTO uta_cycles (name, is_current) VALUES ($1, true) RETURNING id',
        [cycleName]
      );
      utaId = newCycle.id;
    }
    console.log(`UTA cycle: ${cycleName} (id=${utaId}, set as current)\n`);

    // ── 2. Build lookup caches ───────────────────────────────────────────────
    const { rows: members } = await client.query(
      'SELECT id, slug FROM members WHERE active = true'
    );
    const memberMap = {};
    for (const m of members) memberMap[m.slug] = m.id;

    const { rows: shops } = await client.query('SELECT id, name FROM shops');
    const shopMap = {};
    for (const s of shops) shopMap[s.name] = s.id;
    const allShopIds = shops.map(s => s.id);

    // ── 3. Ensure categories exist ───────────────────────────────────────────
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

    // ── 4. Clear existing data for this cycle ────────────────────────────────
    const { rows: [{ count: completionCount }] } = await client.query(`
      SELECT COUNT(*) AS count FROM task_completions
      WHERE task_id IN (SELECT id FROM tasks WHERE uta_cycle_id = $1)
        AND state != 'none'
    `, [utaId]);

    if (parseInt(completionCount) > 0) {
      console.warn(`⚠  Clearing ${completionCount} existing task completion(s) for this cycle\n`);
    }

    await client.query(`
      DELETE FROM task_completions WHERE task_id IN (
        SELECT id FROM tasks WHERE uta_cycle_id = $1
      )
    `, [utaId]);
    await client.query('DELETE FROM tasks WHERE uta_cycle_id = $1', [utaId]);
    await client.query('DELETE FROM shop_events WHERE uta_cycle_id = $1', [utaId]);

    // ── 5. Import task sheets ────────────────────────────────────────────────
    let taskCount = 0, taskSkip = 0;

    for (const ts of TASK_SHEETS) {
      if (!wb.SheetNames.includes(ts.sheet)) continue;
      const ws = wb.Sheets[ts.sheet];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (!rows.length) continue;

      let sheetCount = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const slug  = str(row.slug).toLowerCase();
        const title = str(row.Title || row.title);
        if (!slug || !title) { taskSkip++; continue; }

        const memberId = memberMap[slug];
        if (!memberId) {
          console.warn(`  SKIP (unknown slug "${slug}"): ${title}`);
          taskSkip++;
          continue;
        }

        const rawUrgency = str(row.Urgency || row.urgency).toLowerCase();
        const urgency    = URGENCY_MAP[rawUrgency] || rawUrgency || 'this_uta';
        const details      = str(row.Details || row.details) || null;
        const apptDay      = str(row['Appt Day'] || row.appt_day) || null;
        const apptTime     = str(row['Appt Time'] || row.appt_time) || null;
        const apptLocation = str(row['Appt Location'] || row.appt_location) || null;

        await client.query(`
          INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency,
                             appt_day, appt_time, appt_location, is_upcoming, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [utaId, memberId, catIds[ts.category], title, details, urgency,
            apptDay, apptTime, apptLocation, ts.isUpcoming, i]);
        sheetCount++;
      }

      if (sheetCount) console.log(`  ${ts.sheet.padEnd(12)} ${sheetCount} tasks`);
      taskCount += sheetCount;
    }

    // ── 6. Import Work Orders ────────────────────────────────────────────────
    let woCount = 0;
    if (wb.SheetNames.includes('Work Orders')) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets['Work Orders'], { defval: '' });
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const shopName = str(row.Shop || row.shop);
        const title    = str(row.Title || row.title);
        if (!shopName || !title) continue;

        const shopId = shopMap[shopName];
        if (!shopId) {
          console.warn(`  SKIP WO (unknown shop "${shopName}"): ${title}`);
          continue;
        }

        const woNumber = str(row['WO Number'] || row.wo_number) || null;
        const details  = str(row.Details || row.details) || null;
        const day      = str(row.Day || row.day) || null;

        await client.query(`
          INSERT INTO shop_events (uta_cycle_id, shop_id, event_type, day, title, details, wo_number, sort_order)
          VALUES ($1, $2, 'work_order', $3, $4, $5, $6, $7)
        `, [utaId, shopId, day, title, details, woNumber, i]);
        woCount++;
      }
    }

    // ── 7. Import Shop Schedule → shop_events + squadron_events ────────────
    let schedCount = 0, timelineCount = 0;
    if (wb.SheetNames.includes('Shop Schedule')) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets['Shop Schedule'], { defval: '' });

      // Build grouped timeline entries: key = day|start|end|title
      const timelineMap = new Map();

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const shopName  = str(row.Shop || row.shop);
        const title     = str(row.Title || row.title);
        if (!title) continue;

        const rawType   = str(row.Type || row.type).toLowerCase();
        const eventType = rawType === 'emphasis' ? 'emphasis' : 'schedule';
        const day       = str(row.Day || row.day) || null;
        const startTime = str(row['Start Time'] || row.start_time) || null;
        const endTime   = str(row['End Time'] || row.end_time) || null;
        const details   = str(row.Details || row.details) || null;
        const kind      = str(row.Kind || row.kind).toLowerCase() || null;
        const emphasis  = str(row.Emphasis || row.emphasis) || null;
        const isAll     = shopName.toUpperCase() === 'ALL';

        // ── shop_events: fan out ALL → every shop ──
        const targetIds = isAll
          ? allShopIds
          : [shopMap[shopName]].filter(Boolean);

        if (!targetIds.length && !isAll) {
          console.warn(`  SKIP schedule (unknown shop "${shopName}"): ${title}`);
          continue;
        }

        for (const sid of targetIds) {
          await client.query(`
            INSERT INTO shop_events (uta_cycle_id, shop_id, event_type, day, start_time, end_time,
                                     title, details, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [utaId, sid, eventType, day, startTime, endTime, title, details, i]);
          schedCount++;
        }

        // ── squadron_events: group by (day, start, end, title) ──
        // Skip emphasis-type rows from the timeline (their content goes in the Emphasis column)
        if (eventType === 'emphasis') continue;
        const tlKey = `${day}|${startTime}|${endTime}|${title}`;
        if (!timelineMap.has(tlKey)) {
          timelineMap.set(tlKey, {
            day, startTime, endTime, title, details, kind, emphasis,
            eventType, shops: [], sortOrder: i, isAll,
          });
        }
        const entry = timelineMap.get(tlKey);
        if (!isAll && shopName) {
          entry.shops.push(shopName);
        }
        if (isAll) entry.isAll = true;
        if (details && !entry.details) entry.details = details;
        if (kind && !entry.kind) entry.kind = kind;
        if (emphasis && !entry.emphasis) entry.emphasis = emphasis;
      }

      // ── Write squadron_events from grouped map ──
      await client.query('DELETE FROM squadron_events WHERE uta_cycle_id = $1', [utaId]);

      const tlEntries = [...timelineMap.values()];
      // Sort: by day order, then start_time, then original sort_order
      const dayOrd = { Friday: 1, Saturday: 2, Sunday: 3 };
      tlEntries.sort((a, b) =>
        (dayOrd[a.day] || 9) - (dayOrd[b.day] || 9)
        || (a.startTime || '').localeCompare(b.startTime || '')
        || a.sortOrder - b.sortOrder
      );

      // Auto-detect is_concurrent: within same (day, start_time), first = primary, rest = concurrent
      const seenSlots = new Set();
      for (const e of tlEntries) {
        const slotKey = `${e.day}|${e.startTime}`;
        e.isConcurrent = seenSlots.has(slotKey);
        seenSlots.add(slotKey);
      }

      for (let i = 0; i < tlEntries.length; i++) {
        const e = tlEntries[i];
        // Shop chips: only for non-ALL entries that had specific shops
        const attendees = (!e.isAll && e.shops.length)
          ? JSON.stringify(e.shops.map(s => ({ shop: s })))
          : null;

        // Default kind from event type if not specified
        const resolvedKind = e.kind
          || (e.eventType === 'emphasis' ? 'training' : null);

        await client.query(`
          INSERT INTO squadron_events
            (uta_cycle_id, day, start_time, end_time, title, details,
             kind, is_concurrent, emphasis, attendees, sort_order)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [utaId, e.day, e.startTime, e.endTime, e.title, e.details,
            resolvedKind, e.isConcurrent, e.emphasis, attendees, i]);
        timelineCount++;
      }
    }

    await client.query('COMMIT');
    console.log(`\n✅ Import complete for ${cycleName}`);
    console.log(`   Tasks:         ${taskCount} imported (${taskSkip} skipped)`);
    console.log(`   Work Orders:   ${woCount}`);
    console.log(`   Shop Schedule: ${schedCount} shop_events (includes ALL→per-shop fan-out)`);
    console.log(`   Timeline:      ${timelineCount} squadron_events`);
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
