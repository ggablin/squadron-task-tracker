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

// Drills of `year`, in date order, each with its label, 3-day tag and past/next.
function drillEntries(drills, year, ref) {
  const rows = (drills || [])
    .map(r => ({ id: r.id, start_date: isoDate(r.start_date), end_date: isoDate(r.end_date), note: r.note || null }))
    .filter(r => r.start_date.slice(0, 4) === String(year))
    .sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
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
  const list = drillEntries(drills, y, isoDate(referenceDate));
  const entries = [
    ...list.map(d => ({ ...d, _at: d.start_date })),
    ...uncoveredMonths(list, y).map(m => ({
      kind: 'no_uta', month: m, label: MONTH[m - 1], _at: `${y}-${String(m).padStart(2, '0')}-01`,
    })),
  ].sort((a, b) => (a._at < b._at ? -1 : 1));
  for (const e of entries) delete e._at;
  return { year: y, entries };
}

function buildCalendar(drills, events, year, referenceDate) {
  const y = Number(year);
  const ref = isoDate(referenceDate);
  const list = drillEntries(drills, y, ref);
  const evts = (events || [])
    .map(e => {
      const start_date = isoDate(e.start_date), end_date = isoDate(e.end_date);
      return { kind: 'event', id: e.id, start_date, end_date, label: label(start_date, end_date),
               title: e.title, location: e.location || null, attendees: e.attendees || null,
               status: e.status || 'scheduled', note: e.note || null, past: end_date < ref };
    })
    // An event belongs to the month it STARTS, so a fortnight-long DFT is listed once.
    .filter(e => e.start_date.slice(0, 4) === String(y));

  const gaps = new Set(uncoveredMonths(list, y));
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

module.exports = { isoDate, label, years, buildYear, buildCalendar, validateDrill, overlaps };
