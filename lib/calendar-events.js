// Squadron calendar events — the TDY and training rotations (RADR, Silver Flag,
// REOTS, DFT) that the newsletter's MEETs/RADR slide has always listed by hand.
//
// The title carries the kind: the squadron writes 'RADR' and 'Silver Flag', and
// a kind enum on top would only constrain them. Attendees are free text for the
// same reason duty owners are — the roster is written with ranks, initials and
// the occasional "(possibly)". Squadron-wide only; no shop or member scoping.

const DEFAULTS = require('../data/calendar-events');

const STATUSES = ['scheduled', 'complete', 'cancelled'];

const DDL = `
  CREATE TABLE IF NOT EXISTS calendar_events (
    id            SERIAL PRIMARY KEY,
    title         VARCHAR(120) NOT NULL,
    location      VARCHAR(120),
    start_date    DATE NOT NULL,
    end_date      DATE NOT NULL,
    attendees     VARCHAR(600),
    status        VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','complete','cancelled')),
    note          VARCHAR(200),
    updated_by_id INTEGER REFERENCES members(id),
    updated_at    TIMESTAMP DEFAULT NOW(),
    CHECK (end_date >= start_date)
  );
  CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events (start_date);
`;

const COLS = `id, title, location, to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD') AS end_date, attendees, status, note`;

// Seed-on-create; see lib/duties.js for the contract.
async function ensureTable(db, defaults = DEFAULTS) {
  const { rows } = await db.query(`SELECT to_regclass('public.calendar_events') AS t`);
  if (rows[0].t) return { created: false };
  await db.query(DDL);
  for (const e of defaults) {
    await db.query(
      `INSERT INTO calendar_events (title, location, start_date, end_date, attendees, status, note)
       VALUES ($1, $2, $3::date, $4::date, $5, $6, $7)`,
      [e.title, e.location, e.start, e.end, e.attendees, e.status, e.note]);
  }
  return { created: true, seeded: defaults.length };
}

async function listAll(db) {
  const { rows } = await db.query(`SELECT ${COLS} FROM calendar_events ORDER BY start_date, title`);
  return rows;
}

async function get(db, id) {
  const { rows } = await db.query(`SELECT ${COLS} FROM calendar_events WHERE id = $1`, [id]);
  return rows[0] || null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s) => typeof s === 'string' && ISO_DATE_RE.test(s)
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

const clean = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? undefined : (s || null);
};

// Always validates a whole row: the PATCH route merges the body over the stored
// row first, so a one-field edit is checked against the dates it will have.
function validate(body) {
  const title = String(body.title == null ? '' : body.title).trim();
  if (!title) return { ok: false, error: 'A title is required' };
  if (title.length > 120) return { ok: false, error: 'The title must be 120 characters or fewer' };
  if (!realDate(body.start_date)) return { ok: false, error: 'start_date must be a real YYYY-MM-DD date' };
  if (!realDate(body.end_date)) return { ok: false, error: 'end_date must be a real YYYY-MM-DD date' };
  if (body.end_date < body.start_date) return { ok: false, error: 'An event cannot end before it starts' };
  const status = body.status == null || body.status === '' ? 'scheduled' : String(body.status);
  if (!STATUSES.includes(status)) return { ok: false, error: `status must be one of ${STATUSES.join(', ')}` };
  const location = clean(body.location, 120);
  if (location === undefined) return { ok: false, error: 'The location must be 120 characters or fewer' };
  const attendees = clean(body.attendees, 600);
  if (attendees === undefined) return { ok: false, error: 'The attendee list must be 600 characters or fewer' };
  const note = clean(body.note, 200);
  if (note === undefined) return { ok: false, error: 'The note must be 200 characters or fewer' };
  return { ok: true, value: { title, location, start_date: body.start_date, end_date: body.end_date,
                              attendees, status, note } };
}

async function create(db, v, byId) {
  const { rows } = await db.query(
    `INSERT INTO calendar_events (title, location, start_date, end_date, attendees, status, note, updated_by_id)
     VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8) RETURNING ${COLS}`,
    [v.title, v.location, v.start_date, v.end_date, v.attendees, v.status, v.note, byId]);
  return rows[0];
}

async function update(db, id, v, byId) {
  const { rows } = await db.query(
    `UPDATE calendar_events SET title = $2, location = $3, start_date = $4::date, end_date = $5::date,
            attendees = $6, status = $7, note = $8, updated_by_id = $9, updated_at = NOW()
      WHERE id = $1 RETURNING ${COLS}`,
    [id, v.title, v.location, v.start_date, v.end_date, v.attendees, v.status, v.note, byId]);
  return rows[0] || null;
}

async function remove(db, id) {
  const { rowCount } = await db.query(`DELETE FROM calendar_events WHERE id = $1`, [id]);
  return rowCount > 0;
}

module.exports = { STATUSES, DDL, ensureTable, listAll, get, validate, create, update, remove };
