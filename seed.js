// seed.js — run once: node seed.js
// Populates the database with schema + Structures shop data (May 2026 UTA)

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// ── Members (slug = last name, initial password = last name) ──────────────────
const MEMBERS = [
  { last_name:'Becerra',   first_name:'Paula',    rank:'SrA',   role:'member',     slug:'becerra'   },
  { last_name:'DeRose',    first_name:'Matthew',  rank:'AB',    role:'member',     slug:'derose'    },
  { last_name:'Ebbert',    first_name:'Jeffrey',  rank:'TSgt',  role:'supervisor', slug:'ebbert'    },
  { last_name:'Fowler',    first_name:'Omar',     rank:'SrA',   role:'member',     slug:'fowler'    },
  { last_name:'Gablin',    first_name:'Gregory',  rank:'SMSgt', role:'leadership', slug:'gablin'    },
  { last_name:'Glenn',     first_name:'Jacob',    rank:'A1C',   role:'member',     slug:'glenn'     },
  { last_name:'Gradaille', first_name:'Isabella', rank:'AB',    role:'member',     slug:'gradaille' },
  { last_name:'Mesa',      first_name:'Richard',  rank:'SrA',   role:'member',     slug:'mesa'      },
  { last_name:'Uzoma',     first_name:'Spencer',  rank:'SSgt',  role:'supervisor', slug:'uzoma'     },
  { last_name:'McNaughton',first_name:'Cody',     rank:'MSgt',  role:'leadership', slug:'mcnaughton'},
];

// ── Tasks by member slug ───────────────────────────────────────────────────────
// urgency: 'overdue' | 'this_uta' | 'next_uta' | 'future' | 'info'
// is_upcoming: true = read-only informational (not a checkable task)
const TASKS = {
  gablin: [
    { cat:'admin',   title:'Update vRED in vMPF',                       details:'Give update to supervisor when done',                    urgency:'this_uta' },
    { cat:'admin',   title:'EPB Closeout — Start Drafting',              details:'Due 31 Jul 2026 — draft in MyEval',                     urgency:'next_uta' },
    { cat:'admin',   title:'Submit 1206s for 3rd Quarter Awards',        details:'Due Sunday of Jun UTA',                                 urgency:'next_uta' },
    { cat:'cbt',     title:'DAF-Operations Security Awareness CBT',      details:'15 min — Due This Month',                               urgency:'this_uta' },
    { cat:'cbt',     title:'Safety: SST Training',                       details:'Complete CBT and send cert to Safety Office',           urgency:'this_uta' },
    { cat:'upcoming',title:'DFT — Camp Murray, WA',                     details:'15–29 Jun 2026',                                        urgency:'info', is_upcoming:true },
  ],
  ebbert: [
    { cat:'admin',   title:'Update SGLI in MilConnect',                  details:null,                                                    urgency:'this_uta' },
    { cat:'admin',   title:'Update vRED in vMPF',                       details:null,                                                    urgency:'this_uta' },
    { cat:'cbt',     title:'Force Protection CBT',                       details:'1 hr — 5 Months Overdue',                              urgency:'overdue'  },
    { cat:'cbt',     title:'Cyber Awareness CBT',                        details:'1 hr — 3 Months Overdue',                              urgency:'overdue'  },
    { cat:'cbt',     title:'DoD Mandatory CUI CBT',                      details:'45 min — Due Next Month',                              urgency:'next_uta' },
    { cat:'cbt',     title:'DAF-Operations Security Awareness CBT',      details:'15 min — Due Next Month',                              urgency:'next_uta' },
    { cat:'cbt',     title:'Safety: SST Training',                       details:'Complete CBT and send cert to Safety Office',          urgency:'this_uta' },
    { cat:'medical', title:'PT Test — OVERDUE',                          details:'Scheduled 1 May 2026 @ 1000',                          urgency:'overdue', appt_day:'Friday', appt_time:'1000' },
  ],
  uzoma: [
    { cat:'cbt',     title:'Safety: SST Training',                       details:'Complete CBT and send cert to Safety Office',          urgency:'this_uta' },
    { cat:'medical', title:'PT Test',                                    details:'Due Nov 2026 — schedule in MyFitness (test early, never late)', urgency:'next_uta' },
    { cat:'upcoming',title:'DFT — Camp Murray, WA',                     details:'15–29 Jun 2026',                                        urgency:'info', is_upcoming:true },
  ],
  becerra: [
    { cat:'admin',   title:'EPB Closeout — Sign & Route',               details:'31 Mar 2026 sitting at YOU — sign & route to Mrs. Sharp', urgency:'overdue' },
    { cat:'admin',   title:'Form 55 Safety Review',                     details:'Get with supervisor on Safety Form 55 review',           urgency:'this_uta' },
    { cat:'cbt',     title:'DAF-Operations Security Awareness CBT',     details:'15 min — Due Next Month',                               urgency:'next_uta' },
    { cat:'cbt',     title:'Cyber Awareness CBT',                       details:'1 hr — Due Next Month',                                 urgency:'next_uta' },
    { cat:'medical', title:'Medical: Serum',                            details:'Walk-in Saturday 0900–1400',                            urgency:'this_uta', appt_day:'Saturday', appt_time:'0900–1400' },
    { cat:'medical', title:'PT Test',                                   details:'Due Dec 2026 — schedule in MyFitness',                  urgency:'next_uta' },
    { cat:'upgrade', title:'7-Level UGT',                               details:'Awaiting SSgt to start 7-level upgrade training',       urgency:'info', is_upcoming:true },
  ],
  fowler: [
    { cat:'cbt',     title:'Revetments CBT',                            details:'45 min — 1 Month Overdue',                             urgency:'overdue'  },
    { cat:'medical', title:'PT Test',                                   details:'Due Mar 2027 — schedule in MyFitness',                 urgency:'future'   },
    { cat:'upgrade', title:'7-Level UGT',                               details:'Awaiting SSgt to start 7-level upgrade training',      urgency:'info', is_upcoming:true },
    { cat:'upcoming',title:'DFT — Camp Murray, WA',                    details:'15–29 Jun 2026',                                       urgency:'info', is_upcoming:true },
  ],
  glenn: [
    { cat:'cbt',     title:'DoD Mandatory CUI CBT',                     details:'45 min — 5 Months Overdue',                           urgency:'overdue'  },
    { cat:'medical', title:'PT Test',                                   details:'Due Jul 2026 — schedule in MyFitness',                urgency:'next_uta' },
    { cat:'medical', title:'5-Level CDC EOC',                           details:'Show up 15 min early',                                urgency:'this_uta', appt_day:'Sunday', appt_time:'0900' },
    { cat:'medical', title:'CPR Training',                              details:'Classroom w/ Capt Monico',                            urgency:'this_uta', appt_day:'Sunday' },
    { cat:'upgrade', title:'5-Level (Structures)',                      details:'Tasks at 60% — projected completion Dec 2025',        urgency:'info', is_upcoming:true },
    { cat:'upcoming',title:'DFT — Camp Murray, WA',                    details:'15–29 Jun 2026',                                      urgency:'info', is_upcoming:true },
  ],
  mesa: [
    { cat:'cbt',     title:'Cyber Awareness CBT',                       details:'1 hr — Due Next Month',                              urgency:'next_uta' },
    { cat:'medical', title:'Dental Exam',                               details:'13-month mark — schedule exam before turning RED',    urgency:'this_uta' },
    { cat:'medical', title:'PT Test',                                   details:'Due May 2027 — schedule in MyFitness',               urgency:'future'   },
  ],
  gradaille: [
    { cat:'admin',   title:'Update SGLI in MilConnect',                 details:null,                                                  urgency:'this_uta' },
    { cat:'medical', title:'PT Test',                                   details:'Due May 2027 — schedule in MyFitness',               urgency:'future'   },
    { cat:'upcoming',title:'Out-Processing Date',                       details:'6 Jun 2026',                                         urgency:'info', is_upcoming:true },
    { cat:'upcoming',title:'BMT & Technical School',                    details:'29 Jun 2026 – 27 Jan 2027',                          urgency:'info', is_upcoming:true },
  ],
  derose: [
    { cat:'admin',   title:'Update SGLI in MilConnect',                 details:null,                                                  urgency:'this_uta' },
    { cat:'medical', title:'PT Test',                                   details:'Due Mar 2027 — schedule in MyFitness',               urgency:'future'   },
    { cat:'upcoming',title:'Out-Processing Date',                       details:'2 May 2026 (this UTA)',                              urgency:'overdue',  is_upcoming:true },
    { cat:'upcoming',title:'BMT & Technical School',                    details:'12 May 2026 – 24 Nov 2026',                          urgency:'info', is_upcoming:true },
  ],
  mcnaughton: [],
};

// ── Shop events (shop-wide, visible to all Structures members) ────────────────
const SHOP_EVENTS = [
  { event_type:'emphasis',   day:'Friday',          start_time:null,   end_time:null,   title:'Admin/In-house Training',                 details:'FOCUS ON LOTO & FALL PROTECTION',                                                   wo_number:null, sort_order:1 },
  { event_type:'work_order', day:'Friday/Saturday', start_time:null,   end_time:null,   title:'EA Shop Map Room Wall',                   details:'Remove 2 racks holding base drawings, patch wall (Bldg 3301) — POC: MSgt Beljour-Sommer / SSgt Zizzamia', wo_number:'WO# 202600443', sort_order:2 },
  { event_type:'work_order', day:'Friday/Saturday', start_time:null,   end_time:null,   title:'Fabric Wall Repair',                      details:'Fabric wall bowing in 204IS (Bldg 3390) — POC: MSgt Beljour-Sommer / SSgt Zizzamia', wo_number:'WO# 202600445', sort_order:3 },
  { event_type:'schedule',   day:'Saturday',        start_time:'0830', end_time:'1000', title:'Lautenberg & Family Care Plans',           details:'w/ MSgt Burton — ALL HANDS',                                                         wo_number:null, sort_order:4 },
  { event_type:'schedule',   day:'Saturday',        start_time:'1300', end_time:'1400', title:'Electrical & Structures Health Risk Assessment', details:'w/ MSgt Golden',                                                              wo_number:null, sort_order:5 },
  { event_type:'schedule',   day:'Sunday',          start_time:'1300', end_time:'1400', title:'Building Cleanup',                         details:null,                                                                                 wo_number:null, sort_order:6 },
  { event_type:'schedule',   day:'Sunday',          start_time:'1400', end_time:'1500', title:'CE Recognition / Recap of UTA',            details:null,                                                                                 wo_number:null, sort_order:7 },
  { event_type:'work_order', day:'Sunday',          start_time:null,   end_time:null,   title:'Female Restroom Door',                    details:'Door falling off hinge (Bldg 3369) — POC: TSgt Lopez',                               wo_number:'WO# 202600278', sort_order:8 },
  { event_type:'work_order', day:'Sunday',          start_time:null,   end_time:null,   title:'Interior Doors Installation',             details:'Install interior doors at Bldg 3331 Chaplains Office — POC: Maj Ye',                wo_number:'WO# 202600426', sort_order:9 },
];

// ── Squadron-wide timeline events (shared with server.js bootstrap) ─────────
const SQUADRON_EVENTS = require('./data/squadron-events');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Schema
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('✓ Schema applied');

    // Shop
    const { rows: [shop] } = await client.query(`
      INSERT INTO shops (name) VALUES ('Structures')
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    console.log(`✓ Shop: Structures (id=${shop.id})`);

    // UTA cycle
    await client.query('UPDATE uta_cycles SET is_current = false');
    const { rows: [uta] } = await client.query(`
      INSERT INTO uta_cycles (name, start_date, end_date, is_current)
      VALUES ('May 2026 UTA', '2026-05-01', '2026-05-03', true)
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    let utaId = uta?.id;
    if (!utaId) {
      const { rows: [existing] } = await client.query(`SELECT id FROM uta_cycles WHERE name = 'May 2026 UTA'`);
      utaId = existing.id;
      await client.query('UPDATE uta_cycles SET is_current = true WHERE id = $1', [utaId]);
    }
    console.log(`✓ UTA cycle: May 2026 (id=${utaId})`);

    // Categories
    const cats = [
      { code:'admin',    label:'Admin / Records',          sort_order:1 },
      { code:'cbt',      label:'Computer Training (CBTs)', sort_order:2 },
      { code:'medical',  label:'Medical / Fitness',        sort_order:3 },
      { code:'upgrade',  label:'Upgrade Training',         sort_order:4 },
      { code:'upcoming', label:'Upcoming',                 sort_order:5 },
    ];
    const catIds = {};
    for (const c of cats) {
      const { rows: [row] } = await client.query(`
        INSERT INTO task_categories (code, label, sort_order)
        VALUES ($1, $2, $3)
        ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order
        RETURNING id
      `, [c.code, c.label, c.sort_order]);
      catIds[c.code] = row.id;
    }
    console.log('✓ Task categories');

    // Members
    const memberIds = {};
    console.log('\nInitial passwords (distribute securely before going live):');
    console.log('─'.repeat(42));
    for (const m of MEMBERS) {
      const password = m.slug; // initial password = slug (last name)
      const hash = await bcrypt.hash(password, 10);
      const { rows: [row] } = await client.query(`
        INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, true)
        ON CONFLICT (slug) DO UPDATE
          SET last_name=$1, first_name=$2, rank=$3, shop_id=$4, role=$5, password_hash=$7
        RETURNING id
      `, [m.last_name, m.first_name, m.rank, shop.id, m.role, m.slug, hash]);
      memberIds[m.slug] = row.id;
      console.log(`  ${m.rank.padEnd(5)} ${m.last_name.padEnd(12)} slug: ${m.slug.padEnd(12)} password: ${password}`);
    }
    console.log('─'.repeat(42));
    console.log('⚠  Change these passwords before distributing to members.\n');

    // Tasks — clear existing for this UTA cycle first to allow re-seeding
    const memberIdList = Object.values(memberIds);
    await client.query(
      `DELETE FROM task_completions WHERE task_id IN (
        SELECT id FROM tasks WHERE uta_cycle_id = $1 AND member_id = ANY($2)
      )`, [utaId, memberIdList]
    );
    await client.query(
      'DELETE FROM tasks WHERE uta_cycle_id = $1 AND member_id = ANY($2)',
      [utaId, memberIdList]
    );

    let taskCount = 0;
    for (const [slug, taskList] of Object.entries(TASKS)) {
      const memberId = memberIds[slug];
      for (let i = 0; i < taskList.length; i++) {
        const t = taskList[i];
        await client.query(`
          INSERT INTO tasks
            (uta_cycle_id, member_id, category_id, title, details, urgency,
             appt_day, appt_time, appt_location, is_upcoming, sort_order)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [
          utaId, memberId, catIds[t.cat],
          t.title, t.details ?? null, t.urgency,
          t.appt_day ?? null, t.appt_time ?? null, t.appt_location ?? null,
          t.is_upcoming ?? false, i,
        ]);
        taskCount++;
      }
    }
    console.log(`✓ Tasks: ${taskCount} inserted`);

    // Shop events — clear and re-insert
    await client.query(
      'DELETE FROM shop_events WHERE uta_cycle_id = $1 AND shop_id = $2',
      [utaId, shop.id]
    );
    for (const e of SHOP_EVENTS) {
      await client.query(`
        INSERT INTO shop_events
          (uta_cycle_id, shop_id, event_type, day, start_time, end_time,
           title, details, wo_number, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [utaId, shop.id, e.event_type, e.day, e.start_time, e.end_time,
          e.title, e.details, e.wo_number, e.sort_order]);
    }
    console.log(`✓ Shop events: ${SHOP_EVENTS.length} inserted`);

    // Squadron-wide timeline events — clear and re-insert
    await client.query('DELETE FROM squadron_events WHERE uta_cycle_id = $1', [utaId]);
    for (const e of SQUADRON_EVENTS) {
      await client.query(`
        INSERT INTO squadron_events
          (uta_cycle_id, day, start_time, end_time, title, details,
           kind, is_concurrent, emphasis, attendees, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [utaId, e.day, e.start_time, e.end_time, e.title, e.details,
          e.kind, e.is_concurrent, e.emphasis,
          e.attendees ? JSON.stringify(e.attendees) : null,
          e.sort_order]);
    }
    console.log(`✓ Squadron events: ${SQUADRON_EVENTS.length} inserted`);

    await client.query('COMMIT');
    console.log('\n✅ Seed complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
