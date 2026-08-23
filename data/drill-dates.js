// CY-2026 RSD (drill) dates, from the newsletter's RSD Schedule slide (formerly
// newsletter/static/rsd-schedule.html). Loaded into drill_dates the first time
// the boot migration creates that table (lib/drill-calendar.js); later years are
// entered in the app under Resources → Calendar. July has no entry on purpose —
// months without a drill are derived, never typed.
module.exports = [
  { start: '2026-01-31', end: '2026-02-01', note: 'Jan & Feb combined' },
  { start: '2026-03-06', end: '2026-03-08', note: null },
  { start: '2026-04-11', end: '2026-04-12', note: null },
  { start: '2026-05-01', end: '2026-05-03', note: null },
  { start: '2026-06-05', end: '2026-06-07', note: null },
  { start: '2026-08-08', end: '2026-08-09', note: null },
  { start: '2026-09-11', end: '2026-09-13', note: null },
  { start: '2026-10-17', end: '2026-10-18', note: null },
  { start: '2026-11-14', end: '2026-11-15', note: null },
  { start: '2026-12-11', end: '2026-12-13', note: null },
];
