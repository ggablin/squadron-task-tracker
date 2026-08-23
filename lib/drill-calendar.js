// The squadron calendar — derivation, validation and storage.
//
// The pure half (isoDate … overlaps) is shared by GET /api/calendar and the
// newsletter's RSD Schedule slide, so there is exactly one implementation of
// "which months have no UTA", "is this a 3-day drill" and "which drill is next".
// Nothing is typed that can be derived: the app stores two dates and a note.
//
// Two views over the same data:
//   buildYear     — drills only, flat, with no_uta entries. What slide 23 prints.
//   buildCalendar — drills and events merged into twelve month groups. The app's
//                   Calendar tab. noUta is a property of the month here, because
//                   a month can have no drill and still hold a training rotation.
//
// Dates are 'YYYY-MM-DD' strings throughout. ISO strings compare correctly as
// plain strings and never pick up a timezone the way a Date does; the one place
// a Date is accepted (isoDate) converts it at UTC.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
               'August', 'September', 'October', 'November', 'December'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

// Date | 'YYYY-MM-DD…' → 'YYYY-MM-DD'. A pg DATE column arrives as a Date at UTC
// midnight; a to_char'd column or a request body arrives as a string.
function isoDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v == null ? '' : v).slice(0, 10);
}

// 'YYYY-MM-DD' → Date at UTC midnight, or null when it is not a real calendar
// date ('2026-02-30' parses in JS as 2 March; the round-trip check rejects it).
function parseIso(s) {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}

const dayCount = (start, end) => Math.round((parseIso(end) - parseIso(start)) / DAY_MS) + 1;

function label(start, end) {
  const a = parseIso(start), b = parseIso(end);
  if (start === end) return `${a.getUTCDate()} ${MON[a.getUTCMonth()]}`;
  if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) {
    return `${a.getUTCDate()}–${b.getUTCDate()} ${MON[a.getUTCMonth()]}`;
  }
  return `${a.getUTCDate()} ${MON[a.getUTCMonth()]}–${b.getUTCDate()} ${MON[b.getUTCMonth()]}`;
}

// Distinct start years across any number of row lists, ascending.
function years(...lists) {
  const set = new Set();
  for (const rows of lists) for (const r of rows || []) set.add(Number(isoDate(r.start_date).slice(0, 4)));
  return [...set].sort((a, b) => a - b);
}

// Every drill, normalised and in date order. Coverage is computed from ALL of
// them, not just the ones starting in the year being rendered: a drill running
// 30 Dec to 2 Jan occupies days in January, so January is not a No-UTA month
// even though the drill is listed under December, where it starts.
function normalizeDrills(drills) {
  return (drills || [])
    .map(r => ({ id: r.id, start_date: isoDate(r.start_date), end_date: isoDate(r.end_date), note: r.note || null }))
    .sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
}

// Drills of `year`, in date order, each with its label, 3-day tag and past/next.
// Listed under the year they START in, so a drill is never listed twice.
function drillEntries(all, year, ref) {
  const rows = all.filter(r => r.start_date.slice(0, 4) === String(year));
  let nextSeen = false;
  return rows.map(d => {
    const past = d.end_date < ref;
    const next = !past && !nextSeen;
    if (next) nextSeen = true;
    return { kind: 'drill', ...d, label: label(d.start_date, d.end_date),
             threeDay: dayCount(d.start_date, d.end_date) >= 3, past, next };
  });
}

// Months of `year` no drill touches. A 31 Jan–1 Feb drill covers both.
function uncoveredMonths(drillList, year) {
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const first = `${year}-${String(m).padStart(2, '0')}-01`;
    const last = isoDate(new Date(Date.UTC(year, m, 0)));  // day 0 of next month = last of this
    if (!drillList.some(d => d.start_date <= last && d.end_date >= first)) out.push(m);
  }
  return out;
}

function buildYear(drills, year, referenceDate) {
  const y = Number(year);
  const all = normalizeDrills(drills);
  const list = drillEntries(all, y, isoDate(referenceDate));
  const entries = [
    ...list.map(d => ({ ...d, _at: d.start_date })),
    ...uncoveredMonths(all, y).map(m => ({
      kind: 'no_uta', month: m, label: MONTH[m - 1], _at: `${y}-${String(m).padStart(2, '0')}-01`,
    })),
  ].sort((a, b) => (a._at < b._at ? -1 : 1));
  for (const e of entries) delete e._at;
  return { year: y, entries };
}

function buildCalendar(drills, events, year, referenceDate) {
  const y = Number(year);
  const ref = isoDate(referenceDate);
  const all = normalizeDrills(drills);
  const list = drillEntries(all, y, ref);
  const evts = (events || [])
    .map(e => {
      const start_date = isoDate(e.start_date), end_date = isoDate(e.end_date);
      return { kind: 'event', id: e.id, start_date, end_date, label: label(start_date, end_date),
               title: e.title, location: e.location || null, attendees: e.attendees || null,
               status: e.status || 'scheduled', note: e.note || null, past: end_date < ref };
    })
    // An event belongs to the month it STARTS, so a fortnight-long DFT is listed once.
    .filter(e => e.start_date.slice(0, 4) === String(y));

  const gaps = new Set(uncoveredMonths(all, y));
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const inMonth = (e) => e.start_date.slice(5, 7) === mm;
    const entries = [...list.filter(inMonth), ...evts.filter(inMonth)]
      .sort((a, b) => (a.start_date !== b.start_date
        ? (a.start_date < b.start_date ? -1 : 1)
        : String(a.title || '').localeCompare(String(b.title || ''))));
    months.push({ month: m, label: MONTH[m - 1], noUta: gaps.has(m), entries });
  }
  return { year: y, months };
}

// Request-body validation for the drill routes. { ok, value } or { ok, error }.
function validateDrill(body) {
  const start = body.start_date, end = body.end_date;
  if (!parseIso(start)) return { ok: false, error: 'start_date must be a real YYYY-MM-DD date' };
  if (!parseIso(end)) return { ok: false, error: 'end_date must be a real YYYY-MM-DD date' };
  if (end < start) return { ok: false, error: 'A drill cannot end before it starts' };
  if (dayCount(start, end) > 7) return { ok: false, error: 'A drill is at most seven days' };
  let note = body.note == null ? null : String(body.note).trim();
  if (note === '') note = null;
  if (note && note.length > 80) return { ok: false, error: 'The note must be 80 characters or fewer' };
  return { ok: true, value: { start_date: start, end_date: end, note } };
}

// Two drills overlap when they share at least one day. Adjacent days do not.
const overlaps = (a, b) =>
  isoDate(a.start_date) <= isoDate(b.end_date) && isoDate(b.start_date) <= isoDate(a.end_date);

// ── Storage ─────────────────────────────────────────────────────────────────

const DEFAULTS = require('../data/drill-dates');

const DDL = `
  CREATE TABLE IF NOT EXISTS drill_dates (
    id            SERIAL PRIMARY KEY,
    start_date    DATE NOT NULL UNIQUE,
    end_date      DATE NOT NULL,
    note          VARCHAR(80),
    updated_by_id INTEGER REFERENCES members(id),
    updated_at    TIMESTAMP DEFAULT NOW(),
    CHECK (end_date >= start_date AND end_date - start_date < 7)
  );
`;

// to_char so dates leave the database as the same 'YYYY-MM-DD' strings the API
// accepts — a bare DATE column would come back as a Date at UTC midnight.
const COLS = `id, to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD') AS end_date, note`;

// Seed-on-create; see lib/duties.js for the contract.
async function ensureTable(db, defaults = DEFAULTS) {
  const { rows } = await db.query(`SELECT to_regclass('public.drill_dates') AS t`);
  if (rows[0].t) return { created: false };
  // CREATE and seed inside one transaction, on one client. Postgres DDL is
  // transactional, so a crash or a bad row mid-seed rolls the table back with
  // it and the next boot starts clean. Without this, a half-written table
  // would satisfy the to_regclass guard above forever and the missing rows
  // would never arrive — on the first production boot, silently.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(DDL);
    for (const d of defaults) {
      await client.query(`INSERT INTO drill_dates (start_date, end_date, note) VALUES ($1::date, $2::date, $3)`,
        [d.start, d.end, d.note]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { created: true, seeded: defaults.length };
}

async function listAll(db) {
  const { rows } = await db.query(`SELECT ${COLS} FROM drill_dates ORDER BY start_date`);
  return rows;
}

async function get(db, id) {
  const { rows } = await db.query(`SELECT ${COLS} FROM drill_dates WHERE id = $1`, [id]);
  return rows[0] || null;
}

// The drill, if any, sharing a day with the candidate. excludeId lets a PATCH
// ignore the row being edited.
async function findOverlap(db, { start_date, end_date }, excludeId = null) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM drill_dates
      WHERE start_date <= $2::date AND end_date >= $1::date
        AND ($3::int IS NULL OR id <> $3::int)
      ORDER BY start_date LIMIT 1`, [start_date, end_date, excludeId]);
  return rows[0] || null;
}

async function create(db, value, byId) {
  const { rows } = await db.query(
    `INSERT INTO drill_dates (start_date, end_date, note, updated_by_id)
     VALUES ($1::date, $2::date, $3, $4) RETURNING ${COLS}`,
    [value.start_date, value.end_date, value.note, byId]);
  return rows[0];
}

async function update(db, id, value, byId) {
  const { rows } = await db.query(
    `UPDATE drill_dates SET start_date = $2::date, end_date = $3::date, note = $4,
            updated_by_id = $5, updated_at = NOW()
      WHERE id = $1 RETURNING ${COLS}`,
    [id, value.start_date, value.end_date, value.note, byId]);
  return rows[0] || null;
}

async function remove(db, id) {
  const { rowCount } = await db.query(`DELETE FROM drill_dates WHERE id = $1`, [id]);
  return rowCount > 0;
}

module.exports = {
  isoDate, label, years, buildYear, buildCalendar, validateDrill, overlaps,
  DDL, ensureTable, listAll, get, findOverlap, create, update, remove,
};
