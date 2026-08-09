// newsletter/from-db.js
// Builds the normalized newsletter `data` object from the live Postgres database for the
// current UTA cycle. Emits the SAME shape as from-sample.js by delegating to shape.js,
// so the in-app "Generate Newsletter" output matches the offline sample exactly.

const { buildOrgChart } = require('./org-chart');
const shape = require('./shape');
const { informationalSql } = require('../lib/informational');

const MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtRange(start, end) {
  const d = (v) => (v instanceof Date ? v : (v ? new Date(v + 'T00:00:00') : null));
  const a = d(start), b = d(end);
  if (!a) return '';
  const day = (x) => x.getUTCDate();
  const mo = (x) => MON_ABBR[x.getUTCMonth()];
  const yr = (x) => x.getUTCFullYear();
  if (b && mo(a) === mo(b) && yr(a) === yr(b)) return `${day(a)}–${day(b)} ${mo(a)} ${yr(a)}`;
  if (b) return `${day(a)} ${mo(a)} – ${day(b)} ${mo(b)} ${yr(b)}`;
  return `${day(a)} ${mo(a)} ${yr(a)}`;
}

async function buildFromDb(pool, utaId) {
  // Resolve current cycle if not given
  if (!utaId) {
    const { rows } = await pool.query('SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1');
    utaId = rows[0] && rows[0].id;
  }
  const { rows: cycleRows } = await pool.query(
    'SELECT name, start_date, end_date FROM uta_cycles WHERE id = $1', [utaId]
  );
  const cycle = cycleRows[0] || { name: 'UTA Newsletter' };

  // Members -> org chart (mirrors the /api/squadron/org-chart query)
  const { rows: memberRows } = await pool.query(`
    SELECT m.rank, m.first_name, m.last_name, m.role, s.name AS shop_name, m.flight, m.position
    FROM members m LEFT JOIN shops s ON s.id = m.shop_id
    WHERE m.active = true
    ORDER BY m.last_name, m.first_name
  `);

  // Tasks for this cycle, normalized for shape.js
  const { rows: taskRows } = await pool.query(`
    SELECT cat.code AS category, t.title, t.details, t.urgency, t.is_upcoming,
           m.rank, m.last_name, s.name AS shop
    FROM tasks t
    JOIN task_categories cat ON cat.id = t.category_id
    JOIN members m ON m.id = t.member_id
    LEFT JOIN shops s ON s.id = m.shop_id
    WHERE t.uta_cycle_id = $1
    ORDER BY m.last_name
  `, [utaId]);

  const tasksByCat = { cbt: [], medical: [], admin: [], upgrade: [], upcoming: [] };
  for (const r of taskRows) {
    const norm = { rank: r.rank, last: r.last_name, title: r.title, details: r.details || '', urgency: r.urgency, shop: r.shop || '' };
    (tasksByCat[r.category] || (tasksByCat[r.category] = [])).push(norm);
  }

  // Work orders (shop_events of type work_order)
  const { rows: woRows } = await pool.query(`
    SELECT s.name AS shop, se.wo_number AS wo, se.title, se.details
    FROM shop_events se JOIN shops s ON s.id = se.shop_id
    WHERE se.uta_cycle_id = $1 AND se.event_type = 'work_order'
    ORDER BY s.name, se.sort_order
  `, [utaId]);

  // Timeline (squadron_events); attendees JSONB -> comma-joined shop chip
  const { rows: tlRows } = await pool.query(`
    SELECT day, start_time AS start, end_time AS "end", title, details, kind AS type, attendees
    FROM squadron_events
    WHERE uta_cycle_id = $1
    ORDER BY start_time NULLS LAST, sort_order
  `, [utaId]);
  const timelineRows = tlRows.map(r => ({
    day: r.day, start: r.start || '', end: r.end || '', title: r.title, details: r.details || '', type: r.type || '',
    shop: Array.isArray(r.attendees) && r.attendees.length ? r.attendees.map(a => a.shop).filter(Boolean).join(', ') : '',
  }));

  // Cover stat strip — the same three numbers leadership reads off the app, which
  // means "Tasks this UTA" has to exclude notices exactly as the app's rollups do.
  // A raw COUNT(*) printed 113 here against the app's 102 on the August cycle.
  const { rows: [counts] } = await pool.query(`
    SELECT (SELECT COUNT(*) FROM members WHERE active) AS members,
           (SELECT COUNT(*) FROM shops)                AS shops,
           (SELECT COUNT(*)
              FROM tasks t
              JOIN task_categories icat ON icat.id = t.category_id
             WHERE t.uta_cycle_id = $1
               AND NOT ${informationalSql()}) AS tasks
  `, [utaId]);

  return {
    cover: { welcome: 'Welcome to the', title: cycle.name, dateRange: fmtRange(cycle.start_date, cycle.end_date), unit: '108 CES' },
    stats: { members: Number(counts.members), shops: Number(counts.shops), tasks: Number(counts.tasks) },
    generatedAt: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    org: buildOrgChart(memberRows),
    timeline: shape.shapeTimeline(timelineRows),
    workOrders: shape.shapeWorkOrders(woRows),
    sgliVred: shape.shapeSgliVred(tasksByCat.admin),
    cbts: shape.shapeCbts(tasksByCat.cbt),
    orders: shape.shapeOrders(tasksByCat.admin),
    epbs: shape.shapeEpbs(tasksByCat.admin),
    medical: shape.shapeMedical(tasksByCat.medical),
    pt: shape.shapePt(tasksByCat.medical),
    inbound: shape.shapeInbound(tasksByCat.upcoming),
    upgrade: shape.shapeUpgrade(tasksByCat.upgrade),
  };
}

module.exports = { buildFromDb };
