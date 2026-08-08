// Attendance: pure helpers shared by the API and the tests.
//
// Everything here is deliberately free of database access so the rules that
// are easiest to get quietly wrong — how many periods a drill has, what each
// one is called, and which cells are still unmarked — can be unit-tested
// without a Postgres instance.

// The statuses a supervisor picks, each carrying the pay code the admin who
// enters drill pay needs. Two jobs used to be done in two places — leadership
// tracked who turned up, the admin re-classified the same weekend by hand into
// his own codes — so the mapping lives here and is exported with the data.
//
// `sheetText` is what the drill-roster workbook expects in a period cell; it is
// the workbook's own wording, not ours, so the file drops straight into the
// admin's existing process. Note the pay code is not unique: Unexcused and
// RUTA / Excused are different things to a supervisor and both R for pay.
const STATUS_DEFS = [
  { key: 'agr_at_orders',  label: 'AGR / AT / Orders',    pay: 'X', sheetText: 'X - Constructively Present (AGR)' },
  { key: 'present',        label: 'Present',              pay: '/', sheetText: '/ - Present in Formation' },
  { key: 'ruta_excused',   label: 'RUTA / Excused',       pay: 'R', sheetText: 'R - Rescheduled Drill' },
  { key: 'unexcused',      label: 'Unexcused',            pay: 'R', sheetText: 'R - Rescheduled Drill' },
  { key: 'awol',           label: 'AWOL',                 pay: 'A', sheetText: 'A - Absent' },
  { key: 'maternity',      label: 'Maternity Leave',      pay: 'P', sheetText: 'P - Maternity Leave' },
  { key: 'transfer',       label: 'Transfer',             pay: 'T', sheetText: 'T - Transfer' },
  { key: 'separated',      label: 'Separated / Retired',  pay: 'S', sheetText: 'S - Separation/Retirenment' },
  { key: 'equiv_training', label: 'Equivalent Training',  pay: 'Q', sheetText: 'Q - Equivalent Training (POINTS ONLY)' },
];

const STATUSES = STATUS_DEFS.map(s => s.key);
const STATUS_BY_KEY = Object.fromEntries(STATUS_DEFS.map(s => [s.key, s]));

const payCodeFor    = (status) => (STATUS_BY_KEY[status] || {}).pay || '';
const statusLabelFor = (status) => (STATUS_BY_KEY[status] || {}).label || '';
const sheetTextFor  = (status) => (STATUS_BY_KEY[status] || {}).sheetText || '';

// Rows written before the pay codes existed. 'at' and 'deployed' were both
// "away on orders", which is one thing to the pay clerk; 'ruta' and 'excused'
// were both a rescheduled drill. Applied by the startup migration.
const LEGACY_STATUS_MAP = {
  at: 'agr_at_orders',
  deployed: 'agr_at_orders',
  ruta: 'ruta_excused',
  excused: 'ruta_excused',
};

// Rank to pay grade, for the workbook's Grade column. The app stores the rank a
// member is addressed by; the admin's spreadsheet wants the grade it maps to.
const GRADE_BY_RANK = {
  AB: 'E-1', Amn: 'E-2', A1C: 'E-3', SrA: 'E-4', SSgt: 'E-5', TSgt: 'E-6',
  MSgt: 'E-7', SMSgt: 'E-8', CMSgt: 'E-9',
  '2Lt': 'O-1', '1Lt': 'O-2', Capt: 'O-3', Maj: 'O-4',
  'Lt Col': 'O-5', Col: 'O-6', 'Brig Gen': 'O-7',
};
const gradeFor = (rank) => GRADE_BY_RANK[String(rank || '').trim()] || '';

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

// Drill hours. Fixed rather than stored: every drill runs the same shape, and
// the last period of the weekend finishes half an hour early so people can get
// on the road. The workbook's header shows exactly these.
const PERIOD_TIMES = { am: '07:00-11:00', pm: '12:00-16:30', lastPm: '12:00-16:00' };

const pad2 = (n) => String(n).padStart(2, '0');
const mdY = (d) => `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/${d.getUTCFullYear()}`;

// Labels for periods 1..count, two per day, AM then PM.
//
// "Period 1 (08/08/2026)" rather than "UTA 1": the admin's pay spreadsheet is
// keyed by period and date, and a supervisor marking Sunday afternoon should
// not have to work out which UTA number that is. With no start date they
// degrade to a bare "Period n" rather than rendering blank — an undated cycle
// stays fully markable, it just loses the date.
function periodLabels(startDate, periodCount) {
  const n = Math.max(0, Math.min(Number(periodCount) || 0, MAX_PERIOD));
  const start = toUTCDate(startDate);
  const out = [];
  for (let period = 1; period <= n; period++) {
    const dayOffset = Math.floor((period - 1) / PERIODS_PER_DAY);
    const isAm = (period - 1) % PERIODS_PER_DAY === 0;
    const half = isAm ? 'AM' : 'PM';
    const time = isAm ? PERIOD_TIMES.am
      : (period === n ? PERIOD_TIMES.lastPm : PERIOD_TIMES.pm);
    if (!start) {
      out.push({ period, label: `Period ${period}`, date: null, day: null, half, time });
      continue;
    }
    const d = new Date(start.getTime() + dayOffset * DAY_MS);
    const date = mdY(d);
    out.push({
      period,
      label: `Period ${period} (${date})`,
      date,
      day: DAY_NAMES[d.getUTCDay()],
      half,
      time,
    });
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
  STATUSES, STATUS_DEFS, STATUS_BY_KEY, LEGACY_STATUS_MAP,
  PERIODS_PER_DAY, MAX_PERIOD, PERIOD_TIMES, GRADE_BY_RANK,
  payCodeFor, statusLabelFor, sheetTextFor, gradeFor,
  toUTCDate, periodCountFromDates, periodCountFor, periodLabels,
  isValidStatus, isValidPeriod, coverage, unmarkedFor, firstIncompletePeriod,
};
