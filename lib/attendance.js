// Attendance: pure helpers shared by the API and the tests.
//
// Everything here is deliberately free of database access so the rules that
// are easiest to get quietly wrong — how many periods a drill has, what each
// one is called, and which cells are still unmarked — can be unit-tested
// without a Postgres instance.

const STATUSES = ['present', 'excused', 'unexcused', 'ruta', 'at', 'deployed'];

// Every drill day is exactly two periods (AM, PM), so the period count is a
// pure function of the date span and is never entered by hand.
const PERIODS_PER_DAY = 2;

// Sanity ceiling matching the DB CHECK. This is a garbage guard, NOT the real
// limit — the real limit is the cycle's own period_count, enforced per write
// by isValidPeriod(). Putting the true bound in the schema would mean a
// migration every time drill length varies, which is exactly what
// period_count exists to avoid.
const MAX_PERIOD = 12;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86400000;

// Normalize to a UTC-midnight Date. Handles both what node-pg hands back for a
// DATE column (a Date at LOCAL midnight — so read it with local getters, or a
// positive UTC offset silently shifts it a day earlier) and a plain
// 'YYYY-MM-DD' string from a form post.
function toUTCDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  }
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : d;
}

// days × 2. Returns null when either date is missing so the caller can fall
// back to the cycle's stored period_count — every cycle created through the
// task builder had NULL dates before that form captured them.
function periodCountFromDates(startDate, endDate) {
  const a = toUTCDate(startDate);
  const b = toUTCDate(endDate);
  if (!a || !b) return null;
  const days = Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1;
  if (days < 1) return null;
  return Math.min(days * PERIODS_PER_DAY, MAX_PERIOD);
}

// Prefer the count implied by the dates; fall back to whatever is stored, then
// to a two-day drill. Keeps a cycle whose dates were edited self-consistent
// without needing a backfill.
function periodCountFor(cycle) {
  if (!cycle) return PERIODS_PER_DAY * 2;
  return periodCountFromDates(cycle.start_date, cycle.end_date)
    || Math.min(Number(cycle.period_count) || PERIODS_PER_DAY * 2, MAX_PERIOD);
}

// Labels for periods 1..count, two per day, AM then PM.
// With no start date they degrade to a bare "UTA n" rather than rendering
// blank — an undated cycle stays fully markable, it just loses the day name.
function periodLabels(startDate, periodCount) {
  const n = Math.max(0, Math.min(Number(periodCount) || 0, MAX_PERIOD));
  const start = toUTCDate(startDate);
  const out = [];
  for (let period = 1; period <= n; period++) {
    const dayOffset = Math.floor((period - 1) / PERIODS_PER_DAY);
    const half = (period - 1) % PERIODS_PER_DAY === 0 ? 'AM' : 'PM';
    if (!start) {
      out.push({ period, label: `UTA ${period}`, day: null, half });
      continue;
    }
    const d = new Date(start.getTime() + dayOffset * DAY_MS);
    const day = DAY_NAMES[d.getUTCDay()];
    out.push({ period, label: `UTA ${period} · ${day} ${half}`, day, half });
  }
  return out;
}

function isValidStatus(s) {
  return STATUSES.includes(s);
}

// The real period bound: within the cycle's own count, not the DB ceiling.
function isValidPeriod(period, periodCount) {
  const p = Number(period);
  return Number.isInteger(p) && p >= 1 && p <= Math.min(Number(periodCount) || 0, MAX_PERIOD);
}

// How many (member, period) cells are marked, out of how many exist.
// Rows for members outside the shop, or for periods beyond the cycle's count,
// are ignored so a shortened drill can't report >100% coverage.
function coverage(rows, memberIds, periodCount) {
  const n = Math.max(0, Math.min(Number(periodCount) || 0, MAX_PERIOD));
  const ids = new Set(memberIds);
  const seen = new Set();
  for (const r of rows || []) {
    if (!ids.has(r.member_id)) continue;
    if (!isValidPeriod(r.period, n)) continue;
    seen.add(r.member_id + ':' + r.period);
  }
  return { marked: seen.size, total: ids.size * n };
}

// Members with no row yet for this period. "Mark all present" fills only
// these, so an exception already recorded is never overwritten by a later
// bulk tap.
function unmarkedFor(rows, memberIds, period) {
  const marked = new Set(
    (rows || []).filter(r => Number(r.period) === Number(period)).map(r => r.member_id)
  );
  return (memberIds || []).filter(id => !marked.has(id));
}

// First period that isn't fully marked — where the switcher should open, so a
// supervisor resuming mid-weekend lands on the work still to do.
function firstIncompletePeriod(rows, memberIds, periodCount) {
  const n = Math.max(0, Math.min(Number(periodCount) || 0, MAX_PERIOD));
  for (let p = 1; p <= n; p++) {
    if (unmarkedFor(rows, memberIds, p).length) return p;
  }
  return n ? 1 : 0;
}

module.exports = {
  STATUSES, PERIODS_PER_DAY, MAX_PERIOD,
  toUTCDate, periodCountFromDates, periodCountFor, periodLabels,
  isValidStatus, isValidPeriod, coverage, unmarkedFor, firstIncompletePeriod,
};
