# Resources: Additional Duties, Calendar, and a tab restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Resources tab to five subject-shaped tabs, and fill two of them from three new tables: the Additional Duties list under People, and the year's drill weekends plus TDY/training rotations under a new Calendar.

**Architecture:** Three Postgres tables with twinned migrations (`schema.sql` + the `server.js` boot block) and seed-on-create from three `data/` files. Three `lib/` modules: `duties.js` and `calendar-events.js` (validation + CRUD), and `drill-calendar.js`, whose pure half derives the year and is shared with the newsletter. Eleven thin routes in `server.js` copying the documents-route pattern. Two self-contained front-end modules (`public/duties.js`, `public/calendar.js`) lazily initialised from `switchResPane`. Two newsletter slides replace static partials.

**Spec:** `docs/superpowers/specs/2026-08-22-resources-duties-and-drill-calendar-design.md` (rev. 2). Read §2 before starting: the codebase's design record is specific and this plan depends on it.

**Tech Stack:** Node 24 / Express / `pg` / Postgres; vanilla JS single-page app (`public/index.html`); `node:test` + `node:assert` against a throwaway Postgres (`.env.test` → `TEST_DATABASE_URL`); no build step.

## Global Constraints

- Branch `claude/resources-duties-calendar`, based on `origin/master` at `e13f411`. One PR at the end.
- Every `schema.sql` DDL change has a twin the boot block in `server.js` runs (here: each lib's `ensureTable`).
- Write routes use exactly `requireAuth, requireRosterAdmin, requireOnboarded`; reads use `requireAuth` only.
- Errors are `{ error: '<message>' }`. Dates travel as `YYYY-MM-DD` both ways (`to_char` out, regex in).
- `DELETE` returns **204**; `POST` returns **201** with the row; duplicate duty / overlapping drill returns **409**.
- **Design standards this codebase documents and this plan must not regress** (spec §2, Appendix A):
  - `--t3` is strokes and icons **only**; it fails AA as text. Use `--t3-nav-text` for any muted text.
  - Status chips use the measured pairs: `--ok-bg`/`--ok`, `--wrn-bg`/`--warn`, `--urg-bg`/`--urgent`. Never a solid fill, never an invented pairing.
  - **No side-stripe accents.** No `border-left`, `border-right`, or `inset` box-shadow used as a coloured edge. The codebase is currently clean of them.
  - Interactive targets are **44px** minimum.
  - Toggles are `role="group"` + `aria-pressed` on real `<button>`s, never a fake tablist.
  - Card titles are real `<h2 class="sec-title">`, not styled divs.
  - Em dashes in copy are an accepted deviation here; do not "fix" them.
- Front-end modules expose exactly one global each (`dutiesInit`, `calendarInit`) and take `canEdit` as an argument.
- The newsletter must stay self-contained: no `src`/`href` outside `data:` URIs. The deck stays at 23 slides.
- Run tests with `node --env-file=.env.test --test <file>`, or `npm test` for all. **Never pipe a test run through `tail`** — the exit code becomes `tail`'s.
- Commit after every task: plain-English title, a body saying why, and the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File structure

| File | Responsibility |
|---|---|
| `data/additional-duties.js`, `data/drill-dates.js`, `data/calendar-events.js` (new) | Seed rows, transcribed from the three partials |
| `lib/drill-calendar.js` (new) | Pure: `isoDate`, `label`, `years`, `buildYear`, `buildCalendar`, `validateDrill`, `overlaps`. DB: `DDL`, `ensureTable`, `listAll`, `get`, `findOverlap`, `create`, `update`, `remove` |
| `lib/duties.js` (new) | `DDL`, `ensureTable`, `list`, `validate`, `create`, `update`, `remove` |
| `lib/calendar-events.js` (new) | Same shape as `duties.js`, no uniqueness |
| `schema.sql` (modify, append) | Three `CREATE TABLE`s for tests and `seed.js` |
| `server.js` (modify) | Requires near line 10; three `ensureTable` calls at the end of the boot IIFE (~line 303); eleven routes after the documents routes (~line 868) |
| `public/duties.js` (new) | People → Additional duties: list, filter, admin modal |
| `public/calendar.js` (new) | Calendar tab: year stream, two admin modals |
| `public/index.html` (modify) | Script tags (line 64), CSS (after line 2298), tab strip (3014), calculators wrapper (3034/3242), People pane (3561), Calendar pane (new), `switchResPane` + two view functions (6971), stale comment (1900) |
| `newsletter/from-db.js`, `slides.js`, `theme.js`, `render.js`, `shape.js` (modify) | Slides 9 and 23 go live |
| `newsletter/static/additional-duties.html`, `static/rsd-schedule.html`, `from-sample.js`, `preview-server.js` (delete) | Replaced; sample path dead since 2026-08-17 |
| `test/drill-calendar.test.js` (new) | Pure unit tests |
| `test/duties-http.test.js`, `test/drill-dates-http.test.js`, `test/calendar-events-http.test.js` (new) | HTTP + seed-on-create |
| `test/newsletter-http.test.js` (modify) | Live-slide assertions |
| `MEMORY.md` (modify) | §5 feature entry, §12 key files |

---

### Task 1: Seed data files

**Files:**
- Create: `data/additional-duties.js`, `data/drill-dates.js`, `data/calendar-events.js`
- Test: `test/drill-calendar.test.js` (first three tests; the file grows in Task 2)

**Interfaces:**
- Produces: `require('../data/additional-duties')` → `Array<{ duty: string, primary: string|null, alternate: string|null }>` (52). `require('../data/drill-dates')` → `Array<{ start, end, note }>` (10, ISO strings). `require('../data/calendar-events')` → `Array<{ title, location, start, end, attendees, status, note }>` (10).

- [ ] **Step 1: Write the failing tests**

Create `test/drill-calendar.test.js`:

```js
// Pure tests: the seed data files and lib/drill-calendar.js need no database.
const { test } = require('node:test');
const assert = require('node:assert');

const DUTIES = require('../data/additional-duties');
const DRILLS = require('../data/drill-dates');
const EVENTS = require('../data/calendar-events');

test('the duties seed is the newsletter partial, with TBD and dashes normalised to null', () => {
  assert.strictEqual(DUTIES.length, 52);
  for (const d of DUTIES) {
    assert.ok(d.duty && d.duty.length <= 120, `duty name present: ${JSON.stringify(d)}`);
    for (const k of ['primary', 'alternate']) {
      assert.ok(d[k] === null || (typeof d[k] === 'string' && d[k].length <= 200), `${d.duty}.${k}`);
      assert.notStrictEqual(d[k], 'TBD', `${d.duty}.${k} should be null, not the text TBD`);
      assert.notStrictEqual(d[k], '—', `${d.duty}.${k} should be null, not a dash`);
    }
  }
  assert.strictEqual(new Set(DUTIES.map(d => d.duty.toLowerCase())).size, 52, 'names unique, case-insensitively');
  assert.deepStrictEqual(DUTIES.find(d => d.duty === 'Records Management / FARM'),
    { duty: 'Records Management / FARM', primary: null, alternate: null });
  assert.deepStrictEqual(DUTIES.find(d => d.duty === 'ADUTM'),
    { duty: 'ADUTM', primary: 'McNaughton', alternate: null });
  assert.strictEqual(DUTIES.find(d => d.duty === 'WAR / WIT').alternate, 'EVERYONE / TBD',
    'compound text keeps its wording');
});

test('the drill seed is the ten CY-2026 drills', () => {
  assert.strictEqual(DRILLS.length, 10);
  for (const d of DRILLS) {
    assert.match(d.start, /^2026-\d{2}-\d{2}$/);
    assert.match(d.end, /^2026-\d{2}-\d{2}$/);
    assert.ok(d.end >= d.start, `${d.start} ends on or after it starts`);
    assert.ok(d.note === null || typeof d.note === 'string');
  }
  assert.deepStrictEqual(DRILLS[0], { start: '2026-01-31', end: '2026-02-01', note: 'Jan & Feb combined' });
  assert.ok(!DRILLS.some(d => d.start.startsWith('2026-07')), 'July has no drill');
});

test('the events seed is the MEETs/RADR partial, spanning two years', () => {
  assert.strictEqual(EVENTS.length, 10);
  for (const e of EVENTS) {
    assert.ok(e.title && e.title.length <= 120, `title: ${JSON.stringify(e)}`);
    assert.match(e.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.end >= e.start, `${e.title} ends on or after it starts`);
    assert.ok(['scheduled', 'complete', 'cancelled'].includes(e.status), `${e.title} status`);
    assert.ok(e.attendees === null || e.attendees.length <= 600, `${e.title} attendees fit`);
    assert.ok(e.location === null || e.location.length <= 120, `${e.title} location fits`);
  }
  assert.deepStrictEqual([...new Set(EVENTS.map(e => e.start.slice(0, 4)))].sort(), ['2025', '2026']);
  assert.strictEqual(EVENTS.filter(e => e.status === 'complete').length, 5);
  assert.strictEqual(EVENTS.filter(e => e.status === 'cancelled').length, 1);
  const dft = EVENTS.find(e => e.title === 'FY26 DFT');
  assert.strictEqual(dft.location, 'Camp Murray, WA');
  assert.ok(dft.attendees.includes('MSgt White (possibly)'), 'the roster is verbatim');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --env-file=.env.test --test test/drill-calendar.test.js`
Expected: FAIL — `Cannot find module '../data/additional-duties'`

- [ ] **Step 3: Create `data/additional-duties.js`**

```js
// The squadron's Additional Duties list — who to see about what. Transcribed
// verbatim from the August 2026 newsletter slide (formerly
// newsletter/static/additional-duties.html). Loaded into additional_duties the
// first time the boot migration creates that table (lib/duties.js); after that
// the table is edited in the app under Resources → People, and this file is only
// a record of where the data started. A null owner means "needs owner".
module.exports = [
  { duty: "Add'l Duty Program Responsibilities", primary: 'Maramba / Banks', alternate: 'Monico (Top Cover)' },
  { duty: 'ADUTM', primary: 'McNaughton', alternate: null },
  { duty: 'AFPASS', primary: 'Vasquez', alternate: 'Romer' },
  { duty: 'AROWS — Orders Clerk', primary: 'McNaughton', alternate: 'Glikin' },
  { duty: 'AROWS (Certifier / Validator)', primary: 'Romer / Ye', alternate: 'Romer / Ye' },
  { duty: 'ATAAPs (Timekeepers)', primary: 'Romer', alternate: 'Ye' },
  { duty: 'ATR (Antiterrorism Rep)', primary: 'McNaughton', alternate: 'Tarasewicz' },
  { duty: 'Awards & Decs', primary: 'Monico', alternate: 'Banks / King / Izzo / Gablin / Supervisors' },
  { duty: 'Chief of Training Innovation', primary: 'Sousa / Tarasewicz / Cabbler', alternate: 'Total Force Team' },
  { duty: 'CPR Instructor', primary: 'Monico', alternate: 'Sousa / Conard / De La Cruz / Schoenfeld' },
  { duty: 'Cyber Security Liaison', primary: 'Glikin / Tarasewicz', alternate: 'Vasquez / Whittingham' },
  { duty: 'Designated Rep / Trusted Agent', primary: 'Gorey / Burton', alternate: 'Ye / Romer / King' },
  { duty: 'DRRS / DCAPES', primary: 'McNaughton / Tarasewicz', alternate: 'Romer / Ye / Gorey' },
  { duty: 'DTS — ODTA', primary: 'Tarasewicz', alternate: 'McNaughton' },
  { duty: 'DTS Certifying / Authorizing', primary: 'Ye', alternate: 'Romer' },
  { duty: 'DTS Support / Tracking', primary: 'Brown / Banks / Long', alternate: 'King / Beljour-Sommer' },
  { duty: 'EOC — 87th', primary: 'Tarasewicz / Vasquez', alternate: 'Romer / Ye' },
  { duty: 'EPBs / OPBs / ACAs', primary: 'King / Izzo / Gablin / McNaughton', alternate: 'Romer' },
  { duty: 'Equipment Custodian', primary: 'Huertas / Tarasewicz', alternate: 'McNaughton / Vasquez' },
  { duty: 'Facilities Manager', primary: 'Romer', alternate: 'Joseph' },
  { duty: 'GPC Holder / Purchase Approval', primary: 'Huertas / Joseph', alternate: 'Romer' },
  { duty: 'ITEC', primary: 'Vasquez', alternate: 'Tarasewicz / Sousa' },
  { duty: 'Lodging Monitor', primary: 'Glikin', alternate: 'King / Long / Beljour-Sommer' },
  { duty: 'LODs', primary: 'Gorey', alternate: 'Balint' },
  { duty: 'Manning Doc Manager', primary: 'King / Izzo / McNaughton', alternate: 'Romer' },
  { duty: 'Material Controller', primary: 'Huertas', alternate: 'McNaughton' },
  { duty: 'Morale Committee', primary: 'Cabbler / Huertas / Jenkins / Hill', alternate: 'Beljour-Sommer / Schoenfeld' },
  { duty: 'Mutual CoOp Agreement (MCA)', primary: 'Romer', alternate: 'Joseph / Cisek / Ye' },
  { duty: 'Performance Plans / Appraisals', primary: 'Romer', alternate: 'Tarasewicz / McNaughton' },
  { duty: 'Prime BEEF Manager', primary: 'McNaughton / Tarasewicz', alternate: 'Tarasewicz / McNaughton' },
  { duty: 'Project / Service Contract Mgr', primary: 'Joseph', alternate: 'Ye / Jaimie' },
  { duty: 'Promotion — Mock Board', primary: 'Fernandez G. / Beljour-Sommer / Green / Brown', alternate: 'Santos / Grossmick / Long / Sousa' },
  { duty: 'PTL (Physical Training Leaders)', primary: 'Beljour-Sommer / Hankinson / Vasquez / Becerra', alternate: 'Beltran / Santos / Cabbler / Mattson' },
  { duty: 'RA (Resource Advisor)', primary: 'Romer', alternate: 'Ye' },
  { duty: 'Records Management / FARM', primary: null, alternate: null },
  { duty: 'RUTA Policy Program', primary: 'Romer', alternate: 'Monico / Burton' },
  { duty: 'SAPM / USAP — MICT / IGEMS', primary: 'Deguzeman / McNaughton', alternate: 'Gorey / Ye / Romer / King' },
  { duty: 'SAPR / Suicide Prevention Rep', primary: 'Hankinson', alternate: 'Becerra' },
  { duty: 'Security Manager', primary: 'Tarasewicz', alternate: 'Huertas' },
  { duty: 'Standards + Readiness', primary: 'Monico / Burton', alternate: 'Maramba / Banks' },
  { duty: 'Support Agreements', primary: 'Ye / Gorey', alternate: 'Romer' },
  { duty: 'Timecards (State)', primary: 'Romer', alternate: 'T. Davis' },
  { duty: 'Tuition Waiver Manager', primary: 'Glikin', alternate: 'McNaughton' },
  { duty: 'UDM (Unit Deployment Mgr)', primary: 'McNaughton / Tarasewicz / Vasquez', alternate: 'Sousa' },
  { duty: 'UFAC / UFPM (Fitness)', primary: 'McNaughton / Monico', alternate: 'McNaughton / King' },
  { duty: 'UIF Monitor', primary: 'Monico', alternate: 'King' },
  { duty: 'Unit Career Advisor', primary: 'Gablin / Green', alternate: 'Romer' },
  { duty: 'Unit Health Monitor (UHM)', primary: 'Ye / McNaughton', alternate: 'Gorey / Monico' },
  { duty: 'Unit Safety Rep', primary: 'Schoenfeld', alternate: 'Huertas' },
  { duty: 'UTA Newsletter / Slides', primary: 'McNaughton', alternate: 'EVERYONE' },
  { duty: 'VCO (Vehicle Control Officer)', primary: 'Fitch', alternate: 'Huertas' },
  { duty: 'WAR / WIT', primary: 'Romer / Ye', alternate: 'EVERYONE / TBD' },
];
```

- [ ] **Step 4: Create `data/drill-dates.js`**

```js
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
```

- [ ] **Step 5: Create `data/calendar-events.js`**

```js
// Squadron calendar events — TDY and training rotations. Transcribed from the
// newsletter's MEETs / RADR / Silver Flag slide (newsletter/static/meets-radr.html),
// which stays hand-edited for now: this table feeds the app's Calendar tab only.
// Loaded into calendar_events the first time the boot migration creates that
// table (lib/calendar-events.js).
//
// The title carries the kind — the squadron writes RADR, Silver Flag, REOTS —
// and attendees are free text for the same reason duty owners are: the roster
// includes ranks, initials and "(possibly)".
module.exports = [
  { title: 'HIGH POWER GEN', location: 'New London, NC', start: '2025-12-07', end: '2025-12-12',
    attendees: 'A1C Veal / A1C Whittingham', status: 'complete', note: null },
  { title: 'RADR', location: 'New London, NC', start: '2026-01-11', end: '2026-01-17',
    attendees: 'SrA Hill', status: 'complete', note: null },
  { title: 'Silver Flag', location: 'Tyndall AFB, FL', start: '2026-01-11', end: '2026-01-17',
    attendees: 'TSgt Grossmick / TSgt Price / TSgt Ebbert', status: 'complete', note: null },
  { title: 'RADR', location: 'Tyndall AFB, FL', start: '2026-01-25', end: '2026-01-31',
    attendees: 'SSgt Uzoma / SSgt Huertas / SrA Torres / SrA Mattson', status: 'cancelled', note: null },
  { title: 'REOTS', location: 'FIG, PA', start: '2026-02-01', end: '2026-02-07',
    attendees: 'A1C Padilla', status: 'complete', note: null },
  { title: 'RADR', location: 'Dobbins ARB, GA', start: '2026-04-12', end: '2026-04-18',
    attendees: 'SrA Fowler', status: 'complete', note: null },
  { title: 'RADR', location: 'Fargo, ND', start: '2026-05-03', end: '2026-05-09',
    attendees: 'MSgt Brown', status: 'scheduled', note: null },
  { title: 'RADR', location: 'Tyndall AFB, FL', start: '2026-05-17', end: '2026-05-23',
    attendees: 'MSgt Fernandez G.', status: 'scheduled', note: null },
  { title: 'RADR', location: 'Ft Smith ARB, AR', start: '2026-06-07', end: '2026-06-13',
    attendees: 'A1C Whittingham', status: 'scheduled', note: null },
  { title: 'FY26 DFT', location: 'Camp Murray, WA', start: '2026-06-15', end: '2026-06-29',
    attendees: 'Lt Col Gorey, Maj Ye, Lt Select Maramba, Lt Select Banks, CMSgt Romer, SMSgt King, '
      + 'SMSgt Gablin, MSgt McNaughton, MSgt Fernandez G., MSgt Sousa, MSgt McCullough, '
      + 'MSgt White (possibly), MSgt Beljour-Sommer, MSgt Tarasewicz, TSgt Beltran, SSgt Uzoma, '
      + 'SSgt Hankinson, SrA Palomino, SrA Hill, SrA Torres, SrA Fowler, A1C Glenn, A1C Whittingham',
    status: 'scheduled', note: null },
];
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test test/drill-calendar.test.js`
Expected: `# pass 3`, `# fail 0`

- [ ] **Step 7: Commit**

```bash
git add data/additional-duties.js data/drill-dates.js data/calendar-events.js test/drill-calendar.test.js
git commit -m "Seed data: the duties list, the drill dates, and the TDY roster

Transcribed verbatim from the three newsletter partials they back, with
the duties partial's TBD / dash vacancy markers normalised to null so the
app can derive 'needs owner' instead of string-matching, and the MEETs
slide's COMPLETE / CANCELLED tags mapped to a status. July has no drill
row: months without a UTA are derived, never typed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `lib/drill-calendar.js` — the pure derivation

**Files:**
- Create: `lib/drill-calendar.js` (pure half; the DB half is added in Task 3)
- Test: `test/drill-calendar.test.js` (append)

**Interfaces:**
- Produces:
  - `isoDate(v: Date|string) → 'YYYY-MM-DD'`
  - `label(start, end) → '11–13 Sep' | '31 Jan–1 Feb' | '8 Aug'`
  - `years(...rowLists) → number[]` ascending, distinct years of `start_date` across every list passed
  - `buildYear(drills, year, referenceDate) → { year, entries }`; a drill entry is `{ kind:'drill', id, start_date, end_date, note, label, threeDay, past, next }`, a gap is `{ kind:'no_uta', month, label }`
  - `buildCalendar(drills, events, year, referenceDate) → { year, months }`; a month is `{ month, label, noUta, entries }`; an event entry is `{ kind:'event', id, start_date, end_date, label, title, location, attendees, status, note, past }`
  - `validateDrill({ start_date, end_date, note }) → { ok:true, value } | { ok:false, error }`
  - `overlaps(a, b) → boolean`
- Rows may carry dates as strings or `Date`s (pg returns `Date` for a bare `DATE` column).

- [ ] **Step 1: Append the failing tests**

Append to `test/drill-calendar.test.js`:

```js
const cal = require('../lib/drill-calendar');

const drillRows = DRILLS.map((d, i) => ({ id: i + 1, start_date: d.start, end_date: d.end, note: d.note }));
const eventRows = EVENTS.map((e, i) => ({
  id: i + 1, title: e.title, location: e.location, start_date: e.start, end_date: e.end,
  attendees: e.attendees, status: e.status, note: e.note,
}));

test('buildYear: ten drills plus one July gap, in date order, each drill once', () => {
  const { year, entries } = cal.buildYear(drillRows, 2026, '2026-08-22');
  assert.strictEqual(year, 2026);
  assert.strictEqual(entries.length, 11);
  assert.strictEqual(entries.filter(e => e.kind === 'drill').length, 10);
  assert.deepStrictEqual(entries.find(e => e.kind === 'no_uta'), { kind: 'no_uta', month: 7, label: 'July' });
  assert.deepStrictEqual(entries.map(e => e.label), [
    '31 Jan–1 Feb', '6–8 Mar', '11–12 Apr', '1–3 May', '5–7 Jun', 'July',
    '8–9 Aug', '11–13 Sep', '17–18 Oct', '14–15 Nov', '11–13 Dec',
  ]);
});

test('buildYear: a drill spanning two months covers both, so neither is a gap', () => {
  const { entries } = cal.buildYear(drillRows, 2026, '2026-01-01');
  assert.ok(!entries.some(e => e.kind === 'no_uta' && (e.month === 1 || e.month === 2)));
});

test('buildYear: threeDay flips at three calendar days', () => {
  const { entries } = cal.buildYear(drillRows, 2026, '2026-01-01');
  const by = Object.fromEntries(entries.filter(e => e.kind === 'drill').map(e => [e.label, e.threeDay]));
  assert.strictEqual(by['31 Jan–1 Feb'], false);
  assert.strictEqual(by['8–9 Aug'], false);
  assert.strictEqual(by['6–8 Mar'], true);
  assert.strictEqual(by['11–13 Sep'], true);
});

test('buildYear: past and next are relative to the reference date, and only one entry is next', () => {
  const drills = cal.buildYear(drillRows, 2026, '2026-08-22').entries.filter(e => e.kind === 'drill');
  assert.deepStrictEqual(drills.map(d => d.past),
    [true, true, true, true, true, true, false, false, false, false]);
  assert.strictEqual(drills.filter(d => d.next).length, 1);
  assert.strictEqual(drills.find(d => d.next).label, '11–13 Sep');
});

test('buildYear: a reference date inside a drill makes that drill next, not past', () => {
  const { entries } = cal.buildYear(drillRows, 2026, '2026-09-12');
  const sep = entries.find(e => e.label === '11–13 Sep');
  assert.strictEqual(sep.past, false);
  assert.strictEqual(sep.next, true);
  assert.strictEqual(entries.find(e => e.label === '8–9 Aug').past, true);
});

test('buildYear: Date inputs are accepted (pg returns a bare DATE column as Date)', () => {
  const dated = drillRows.map(r => ({
    ...r, start_date: new Date(r.start_date + 'T00:00:00Z'), end_date: new Date(r.end_date + 'T00:00:00Z'),
  }));
  const { entries } = cal.buildYear(dated, 2026, new Date('2026-08-22T15:00:00Z'));
  assert.strictEqual(entries.find(e => e.next).label, '11–13 Sep');
  assert.strictEqual(entries.find(e => e.next).start_date, '2026-09-11');
});

test('buildYear: other years are ignored; an empty year has no drills', () => {
  const mixed = [...drillRows, { id: 99, start_date: '2027-01-09', end_date: '2027-01-10', note: null }];
  assert.strictEqual(cal.buildYear(mixed, 2026, '2026-01-01').entries.filter(e => e.kind === 'drill').length, 10);
  assert.strictEqual(cal.buildYear(mixed, 2027, '2026-01-01').entries.filter(e => e.kind === 'drill').length, 1);
  assert.strictEqual(cal.buildYear([], 2026, '2026-01-01').entries.filter(e => e.kind === 'drill').length, 0);
});

test('buildCalendar: twelve month groups, noUta on the month rather than as a row', () => {
  const { year, months } = cal.buildCalendar(drillRows, eventRows, 2026, '2026-08-22');
  assert.strictEqual(year, 2026);
  assert.strictEqual(months.length, 12);
  assert.deepStrictEqual(months.map(m => m.month), [1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.strictEqual(months[0].label, 'January');
  // Only July has no drill. February is covered by the 31 Jan–1 Feb drill.
  assert.deepStrictEqual(months.filter(m => m.noUta).map(m => m.month), [7]);
  assert.ok(!months.some(m => m.entries.some(e => e.kind === 'no_uta')), 'no_uta is never an entry here');
});

test('buildCalendar: drills and events interleave by date inside a month', () => {
  const { months } = cal.buildCalendar(drillRows, eventRows, 2026, '2026-08-22');
  const april = months.find(m => m.month === 4);
  assert.deepStrictEqual(april.entries.map(e => [e.kind, e.label]),
    [['drill', '11–12 Apr'], ['event', '12–18 Apr']]);
  const apr = april.entries[1];
  assert.strictEqual(apr.title, 'RADR');
  assert.strictEqual(apr.location, 'Dobbins ARB, GA');
  assert.strictEqual(apr.status, 'complete');
  assert.strictEqual(apr.past, true);
  // January: two rotations on the 11th, one on the 25th, then the 31 Jan drill.
  // The drill sorts LAST because it starts last — that is the point of
  // interleaving, and it is why noUta cannot be inferred from position.
  const jan = months.find(m => m.month === 1);
  assert.deepStrictEqual(jan.entries.map(e => e.kind), ['event', 'event', 'event', 'drill']);
  assert.deepStrictEqual(jan.entries.slice(0, 2).map(e => e.title), ['RADR', 'Silver Flag'],
    'same-day events sort by title');
});

test('buildCalendar: an event is listed once, in the month it starts', () => {
  const { months } = cal.buildCalendar([], eventRows, 2026, '2026-08-22');
  const seen = months.flatMap(m => m.entries).filter(e => e.title === 'FY26 DFT');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(months.find(m => m.entries.includes(seen[0])).month, 6, 'June, where it starts');
});

test('buildCalendar: next marks a drill only, and events never carry it', () => {
  const { months } = cal.buildCalendar(drillRows, eventRows, 2026, '2026-08-22');
  const all = months.flatMap(m => m.entries);
  assert.strictEqual(all.filter(e => e.next).length, 1);
  assert.strictEqual(all.find(e => e.next).kind, 'drill');
  assert.ok(all.filter(e => e.kind === 'event').every(e => e.next === undefined));
});

test('buildCalendar: a year with only events still returns twelve months, all noUta', () => {
  const { months } = cal.buildCalendar([], eventRows, 2025, '2026-08-22');
  assert.strictEqual(months.length, 12);
  assert.ok(months.every(m => m.noUta));
  assert.strictEqual(months.find(m => m.month === 12).entries.length, 1);
  assert.strictEqual(months.flatMap(m => m.entries).length, 1, 'only the Dec 2025 rotation');
});

test('label: same month, across months, single day', () => {
  assert.strictEqual(cal.label('2026-09-11', '2026-09-13'), '11–13 Sep');
  assert.strictEqual(cal.label('2026-01-31', '2026-02-01'), '31 Jan–1 Feb');
  assert.strictEqual(cal.label('2026-08-08', '2026-08-08'), '8 Aug');
});

test('years: distinct and ascending across every list passed', () => {
  assert.deepStrictEqual(cal.years(drillRows, eventRows), [2025, 2026]);
  assert.deepStrictEqual(cal.years([{ start_date: '2027-01-09' }, { start_date: new Date('2026-09-11T00:00:00Z') }]),
    [2026, 2027]);
  assert.deepStrictEqual(cal.years([]), []);
});

test('validateDrill: accepts a real drill and normalises the note', () => {
  assert.deepStrictEqual(cal.validateDrill({ start_date: '2026-09-11', end_date: '2026-09-13', note: '  ' }),
    { ok: true, value: { start_date: '2026-09-11', end_date: '2026-09-13', note: null } });
  assert.strictEqual(cal.validateDrill({ start_date: '2026-08-08', end_date: '2026-08-08', note: ' one day ' }).value.note,
    'one day');
});

test('validateDrill: rejects malformed, impossible, reversed and over-long drills', () => {
  const bad = (body) => { const r = cal.validateDrill(body); assert.strictEqual(r.ok, false, JSON.stringify(body)); return r.error; };
  assert.match(bad({ start_date: '9/11/2026', end_date: '2026-09-13' }), /start_date/);
  assert.match(bad({ start_date: '2026-02-30', end_date: '2026-03-01' }), /start_date/);
  assert.match(bad({ start_date: '2026-09-11' }), /end_date/);
  assert.match(bad({ start_date: '2026-09-13', end_date: '2026-09-11' }), /before/);
  assert.match(bad({ start_date: '2026-09-01', end_date: '2026-09-08' }), /seven days/);
  assert.match(bad({ start_date: '2026-09-11', end_date: '2026-09-13', note: 'x'.repeat(81) }), /80/);
});

test('overlaps: shared days overlap, adjacent days do not', () => {
  const a = { start_date: '2026-09-11', end_date: '2026-09-13' };
  assert.strictEqual(cal.overlaps(a, { start_date: '2026-09-13', end_date: '2026-09-14' }), true);
  assert.strictEqual(cal.overlaps(a, { start_date: '2026-09-01', end_date: '2026-09-11' }), true);
  assert.strictEqual(cal.overlaps(a, { start_date: '2026-09-14', end_date: '2026-09-15' }), false);
  assert.strictEqual(cal.overlaps(a, { start_date: '2026-09-09', end_date: '2026-09-10' }), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --env-file=.env.test --test test/drill-calendar.test.js`
Expected: FAIL — `Cannot find module '../lib/drill-calendar'`

- [ ] **Step 3: Create `lib/drill-calendar.js` (pure half)**

```js
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

module.exports = { isoDate, label, years, buildYear, buildCalendar, validateDrill, overlaps };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test test/drill-calendar.test.js`
Expected: `# pass 20`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/drill-calendar.js test/drill-calendar.test.js
git commit -m "Calendar derivation: the year from dates alone, two views

buildYear is the flat drill list the newsletter prints — each drill once,
a No UTA entry per untouched month, the 3-day tag from the day count, and
past/next against a reference date so the API can use today while the deck
uses the cycle's start. buildCalendar merges drills and events into twelve
month groups for the app, where noUta belongs to the month rather than
being a row, because a month with no drill can still hold a rotation.
Pure functions, tested without a database.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 3: Three tables, three libs, seed-on-create

**Files:**
- Modify: `schema.sql` (append at the end, after `idx_notifications_unpushed`)
- Create: `lib/duties.js`, `lib/calendar-events.js`
- Modify: `lib/drill-calendar.js` (append the DB half)
- Modify: `server.js` — requires after line 10; three `ensureTable` calls before the boot IIFE's `catch` (~line 303)
- Test: `test/duties-http.test.js`, `test/drill-dates-http.test.js`, `test/calendar-events-http.test.js` (new; seed-on-create tests only — the route tests come in Tasks 4–6)

**Interfaces:**
- Consumes: the three `data/` modules (Task 1); `isoDate` (Task 2).
- Produces, `lib/duties.js`:
  - `DDL: string`; `ensureTable(db, defaults?) → Promise<{ created, seeded? }>`
  - `list(db) → Promise<Duty[]>`, `Duty = { id, duty, primary_owner, alternate_owner }`, ordered by `lower(duty)`
  - `validate(body, { partial }) → { ok, value } | { ok: false, error }`
  - `create(db, value, byId) → Promise<Duty>` — throws `err.code === 'DUPLICATE'`
  - `update(db, id, value, byId) → Promise<Duty|null>` — same throw; `remove(db, id) → Promise<boolean>`
- Produces, `lib/calendar-events.js`: identical shape, `Event = { id, title, location, start_date, end_date, attendees, status, note }`, ordered by `start_date, title`; `listAll(db)`; no `DUPLICATE`.
- Produces, `lib/drill-calendar.js` (DB half): `DDL`, `ensureTable`, `listAll(db) → Drill[]` (`{ id, start_date, end_date, note }`, ordered by `start_date`), `get`, `findOverlap(db, value, excludeId)`, `create`, `update`, `remove`.

- [ ] **Step 1: Write the failing seed-on-create tests**

Create `test/duties-http.test.js`:

```js
// Additional duties: read by every signed-in member, written only by roster
// admins (the Forms gate). Also covers seed-on-create — the table is loaded from
// data/additional-duties.js only in the boot that creates it, so rows an admin
// deletes never come back.
//
// DATABASE_URL must point at the same throwaway Postgres as TEST_DATABASE_URL
// before requiring server.js, since the app builds its pool at module-load time.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const { pool, applySchema, resetDb } = require('./helpers/db');
const duties = require('../lib/duties');
const DEFAULTS = require('../data/additional-duties');
const app = require('../server');

let server, baseUrl;

test.before(async () => {
  await applySchema();
  await new Promise((resolve, reject) => {
    server = app.listen(0, err => (err ? reject(err) : resolve()));
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { await new Promise(r => server.close(r)); });

function cookieFrom(res) {
  const c = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return c.length ? c[0].split(';')[0] : null;
}

const PW = 'testpass123';

async function login(slug) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, password: PW }),
  });
  assert.strictEqual(res.status, 200, `login as ${slug} should succeed`);
  return cookieFrom(res);
}

// Four accounts: the roster admin, a leadership member WITHOUT the capability
// (the twenty-one-versus-two distinction), a supervisor and a plain member.
// must_change_password=false so requireOnboarded never confounds a 403.
async function seed() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 10);
  const { rows: [{ id: shop }] } = await pool.query(`INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const add = (slug, role, admin) => pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active,
                          must_change_password, can_manage_roster)
     VALUES ($1,'Test','SSgt',$2,$3,$4,$5,true,false,$6) RETURNING id`, [slug, shop, role, slug, hash, admin]);
  const { rows: [admin] } = await add('admintest', 'leadership', true);
  await add('leadtest', 'leadership', false);
  await add('suptest', 'supervisor', false);
  await add('memtest', 'member', false);
  return { adminId: admin.id };
}

const api = (method, path, cookie, body) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('seed-on-create: a fresh table gets the 52 duties exactly once; deleted rows stay deleted', async () => {
  await pool.query('DROP TABLE IF EXISTS additional_duties');
  assert.deepStrictEqual(await duties.ensureTable(pool, DEFAULTS), { created: true, seeded: 52 });
  const count = async () => Number((await pool.query('SELECT COUNT(*) FROM additional_duties')).rows[0].count);
  assert.strictEqual(await count(), 52);

  assert.deepStrictEqual(await duties.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 52, 'a second boot adds nothing');

  await pool.query(`DELETE FROM additional_duties WHERE duty = 'ADUTM'`);
  assert.deepStrictEqual(await duties.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 51, 'a deleted row never comes back');

  const { rows } = await pool.query(
    `SELECT primary_owner, alternate_owner FROM additional_duties WHERE duty = 'Records Management / FARM'`);
  assert.deepStrictEqual(rows[0], { primary_owner: null, alternate_owner: null });
});
```

Create `test/drill-dates-http.test.js` and `test/calendar-events-http.test.js`. **Copy the whole preamble above verbatim** — from the first `process.env` line through the `api` helper — changing only the header comment and the two feature requires:

- `drill-dates-http.test.js`: header comment `// The calendar: drill dates and the merged year view. Read by every signed-in\n// member, written only by roster admins. Also covers drill seed-on-create.`; requires `const cal = require('../lib/drill-calendar');` and `const DEFAULTS = require('../data/drill-dates');`
- `calendar-events-http.test.js`: header comment `// Calendar events — TDY and training rotations. Read through /api/calendar,\n// written only by roster admins. Also covers event seed-on-create.`; requires `const events = require('../lib/calendar-events');` and `const DEFAULTS = require('../data/calendar-events');`

Then append to `test/drill-dates-http.test.js`:

```js
test('seed-on-create: a fresh table gets the ten 2026 drills exactly once; deleted rows stay deleted', async () => {
  await pool.query('DROP TABLE IF EXISTS drill_dates');
  assert.deepStrictEqual(await cal.ensureTable(pool, DEFAULTS), { created: true, seeded: 10 });
  const count = async () => Number((await pool.query('SELECT COUNT(*) FROM drill_dates')).rows[0].count);
  assert.strictEqual(await count(), 10);
  assert.deepStrictEqual(await cal.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 10);
  await pool.query(`DELETE FROM drill_dates WHERE start_date = DATE '2026-08-08'`);
  assert.deepStrictEqual(await cal.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 9, 'a deleted row never comes back');
  const all = await cal.listAll(pool);
  assert.strictEqual(all[0].start_date, '2026-01-31', 'dates come back as YYYY-MM-DD strings');
  assert.strictEqual(all[0].note, 'Jan & Feb combined');
});
```

And to `test/calendar-events-http.test.js`:

```js
test('seed-on-create: a fresh table gets the ten rotations exactly once; deleted rows stay deleted', async () => {
  await pool.query('DROP TABLE IF EXISTS calendar_events');
  assert.deepStrictEqual(await events.ensureTable(pool, DEFAULTS), { created: true, seeded: 10 });
  const count = async () => Number((await pool.query('SELECT COUNT(*) FROM calendar_events')).rows[0].count);
  assert.strictEqual(await count(), 10);
  assert.deepStrictEqual(await events.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 10);
  await pool.query(`DELETE FROM calendar_events WHERE title = 'REOTS'`);
  assert.deepStrictEqual(await events.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 9, 'a deleted row never comes back');
  const all = await events.listAll(pool);
  assert.strictEqual(all[0].start_date, '2025-12-07', 'ordered by date, as YYYY-MM-DD strings');
  assert.strictEqual(all[0].status, 'complete');
  const dft = all.find(e => e.title === 'FY26 DFT');
  assert.ok(dft.attendees.includes('A1C Whittingham'), 'the 23-name roster survives the round trip');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --env-file=.env.test --test test/duties-http.test.js`
Expected: FAIL — `Cannot find module '../lib/duties'`

- [ ] **Step 3: Append the three tables to `schema.sql`**

```sql
-- ── Resources reference tables ─────────────────────────────────────────────
-- Additional duties ("who do I see about X"), the calendar year's drill dates,
-- and the TDY / training rotations. Every member reads them, roster admins edit
-- them, and the newsletter renders the first two. These CREATEs are the twins of
-- the DDL in lib/duties.js, lib/drill-calendar.js and lib/calendar-events.js,
-- which the server.js boot block runs — with one difference: the boot block also
-- seeds the initial rows the first time it creates each table. This copy creates
-- them empty, which is what the tests and seed.js want.
CREATE TABLE IF NOT EXISTS additional_duties (
  id              SERIAL PRIMARY KEY,
  duty            VARCHAR(120) NOT NULL,
  primary_owner   VARCHAR(200),          -- free text; NULL = needs owner
  alternate_owner VARCHAR(200),
  updated_by_id   INTEGER REFERENCES members(id),
  updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS additional_duties_duty_key
  ON additional_duties (lower(duty));

CREATE TABLE IF NOT EXISTS drill_dates (
  id            SERIAL PRIMARY KEY,
  start_date    DATE NOT NULL UNIQUE,
  end_date      DATE NOT NULL,
  note          VARCHAR(80),             -- 'Jan & Feb combined'
  updated_by_id INTEGER REFERENCES members(id),
  updated_at    TIMESTAMP DEFAULT NOW(),
  CHECK (end_date >= start_date AND end_date - start_date < 7)
);

-- Events legitimately overlap each other and drills, and a DFT runs a fortnight,
-- so there is no overlap check, no uniqueness and no 7-day cap here.
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
```

- [ ] **Step 4: Create `lib/duties.js`**

```js
// Additional duties — the "who do I see about X" list under Resources → People.
//
// Owners are free text on purpose: the squadron's list names state employees,
// 'EVERYONE', and people who are not in the roster. A NULL primary_owner is the
// one structured fact, and it means "needs owner" everywhere it is rendered.

const DEFAULTS = require('../data/additional-duties');

const DDL = `
  CREATE TABLE IF NOT EXISTS additional_duties (
    id              SERIAL PRIMARY KEY,
    duty            VARCHAR(120) NOT NULL,
    primary_owner   VARCHAR(200),
    alternate_owner VARCHAR(200),
    updated_by_id   INTEGER REFERENCES members(id),
    updated_at      TIMESTAMP DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS additional_duties_duty_key
    ON additional_duties (lower(duty));
`;

const COLS = 'id, duty, primary_owner, alternate_owner';

// Seed-on-create. The boot block calls this on every start; it only does
// anything in the boot that finds the table absent. A database that already has
// the table — including one where an admin has since deleted rows — is left
// exactly as it is.
async function ensureTable(db, defaults = DEFAULTS) {
  const { rows } = await db.query(`SELECT to_regclass('public.additional_duties') AS t`);
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
      await client.query(
        `INSERT INTO additional_duties (duty, primary_owner, alternate_owner) VALUES ($1, $2, $3)`,
        [d.duty, d.primary, d.alternate]);
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

async function list(db) {
  const { rows } = await db.query(`SELECT ${COLS} FROM additional_duties ORDER BY lower(duty)`);
  return rows;
}

// Returns undefined when the value is too long, so the caller can 400 on it.
const clean = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? undefined : (s || null);
};

// partial=false: a create, duty required. partial=true: a PATCH, only the keys
// present are validated and at least one must be.
function validate(body, { partial }) {
  const value = {};
  if ('duty' in body || !partial) {
    const s = String(body.duty == null ? '' : body.duty).trim();
    if (!s) return { ok: false, error: 'A duty name is required' };
    if (s.length > 120) return { ok: false, error: 'The duty name must be 120 characters or fewer' };
    value.duty = s;
  }
  for (const k of ['primary_owner', 'alternate_owner']) {
    if (!(k in body)) continue;
    const v = clean(body[k], 200);
    if (v === undefined) {
      return { ok: false, error: `${k === 'primary_owner' ? 'Primary' : 'Alternate'} must be 200 characters or fewer` };
    }
    value[k] = v;
  }
  if (partial && !Object.keys(value).length) return { ok: false, error: 'Nothing to update' };
  return { ok: true, value };
}

function duplicate(err) {
  if (err && err.code === '23505' && err.constraint === 'additional_duties_duty_key') {
    return Object.assign(new Error('A duty with that name already exists'), { code: 'DUPLICATE' });
  }
  return err;
}

async function create(db, value, byId) {
  try {
    const { rows } = await db.query(
      `INSERT INTO additional_duties (duty, primary_owner, alternate_owner, updated_by_id)
       VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
      [value.duty, value.primary_owner ?? null, value.alternate_owner ?? null, byId]);
    return rows[0];
  } catch (err) { throw duplicate(err); }
}

async function update(db, id, value, byId) {
  const sets = [], vals = [];
  const bind = (v) => { vals.push(v); return `$${vals.length}`; };
  for (const k of ['duty', 'primary_owner', 'alternate_owner']) {
    if (k in value) sets.push(`${k} = ${bind(value[k])}`);
  }
  sets.push(`updated_by_id = ${bind(byId)}`, `updated_at = NOW()`);
  try {
    const { rows } = await db.query(
      `UPDATE additional_duties SET ${sets.join(', ')} WHERE id = ${bind(id)} RETURNING ${COLS}`, vals);
    return rows[0] || null;
  } catch (err) { throw duplicate(err); }
}

async function remove(db, id) {
  const { rowCount } = await db.query(`DELETE FROM additional_duties WHERE id = $1`, [id]);
  return rowCount > 0;
}

module.exports = { DDL, ensureTable, list, validate, create, update, remove };
```

- [ ] **Step 5: Create `lib/calendar-events.js`**

```js
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
  // CREATE and seed inside one transaction, on one client. Postgres DDL is
  // transactional, so a crash or a bad row mid-seed rolls the table back with
  // it and the next boot starts clean. Without this, a half-written table
  // would satisfy the to_regclass guard above forever and the missing rows
  // would never arrive — on the first production boot, silently.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(DDL);
    for (const e of defaults) {
      await client.query(
        `INSERT INTO calendar_events (title, location, start_date, end_date, attendees, status, note)
         VALUES ($1, $2, $3::date, $4::date, $5, $6, $7)`,
        [e.title, e.location, e.start, e.end, e.attendees, e.status, e.note]);
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
```

- [ ] **Step 6: Append the DB half to `lib/drill-calendar.js`**

Replace the file's final `module.exports = { … };` line with:

```js
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
```

- [ ] **Step 7: Wire the three `ensureTable` calls into the boot block**

After line 10 (`const { acquireMigrationLock } = require('./lib/db');`) add:

```js
const duties = require('./lib/duties');
const drillCal = require('./lib/drill-calendar');
const calEvents = require('./lib/calendar-events');
```

In the boot IIFE, immediately before `  } catch (e) {` (after the `last_login_at` recovery query, ~line 303), add:

```js
    // Resources reference tables (duties, drill dates, calendar events). Each
    // lib creates its table and seeds it from data/ in the one boot that finds
    // it absent; every later boot is a no-op, so rows an admin deletes stay
    // gone. schema.sql carries the twin CREATEs, empty, for tests and seed.js.
    for (const [name, mod] of [['additional_duties', duties], ['drill_dates', drillCal],
                               ['calendar_events', calEvents]]) {
      const r = await mod.ensureTable(pool);
      if (r.created) console.log(`Created ${name} and seeded ${r.seeded} rows`);
    }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run each, expecting `# pass 1`, `# fail 0`:

```bash
node --env-file=.env.test --test test/duties-http.test.js
node --env-file=.env.test --test test/drill-dates-http.test.js
node --env-file=.env.test --test test/calendar-events-http.test.js
```

Run: `node --env-file=.env.test --test test/drill-calendar.test.js`
Expected: still `# pass 20` — the DB half must not open a connection at require time.

- [ ] **Step 9: Commit**

```bash
git add schema.sql lib/duties.js lib/calendar-events.js lib/drill-calendar.js server.js test/duties-http.test.js test/drill-dates-http.test.js test/calendar-events-http.test.js
git commit -m "Three reference tables, seeded once in the boot that creates them

additional_duties, drill_dates and calendar_events, twinned in schema.sql
and the boot block as every table here is. The boot-side DDL lives in the
lib modules so the same function can seed the initial rows from data/ —
but only in the boot that finds the table absent. Production and staging
lack all three, so the first deploy loads them with no script to run, and
a row an admin later deletes never returns.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `/api/duties` routes

**Files:**
- Modify: `server.js` — insert after the documents `DELETE` route (line ~868, before `// ── Member task history (Records)`)
- Test: `test/duties-http.test.js` (append)

**Interfaces:**
- Consumes: `duties.*` (Task 3); `requireAuth`, `requireRosterAdmin`, `requireOnboarded`, `reqId` (existing).
- Produces: `GET /api/duties → { duties }`; `POST → 201`; `PATCH /:id → 200`; `DELETE /:id → 204`.

- [ ] **Step 1: Append the failing route tests**

```js
test('signed out: every duties route is 401', async () => {
  await seed();
  for (const [m, p] of [['GET', '/api/duties'], ['POST', '/api/duties'],
                        ['PATCH', '/api/duties/1'], ['DELETE', '/api/duties/1']]) {
    // fetch refuses a GET that carries a body, so only the writes get one.
    const body = m === 'GET' ? undefined : {};
    assert.strictEqual((await api(m, p, null, body)).status, 401, `${m} ${p}`);
  }
});

test('403 matrix: member, supervisor and leadership-without-the-capability cannot write; all can read', async () => {
  await seed();
  for (const slug of ['memtest', 'suptest', 'leadtest']) {
    const cookie = await login(slug);
    assert.strictEqual((await api('GET', '/api/duties', cookie)).status, 200, `${slug} can read`);
    for (const [m, p] of [['POST', '/api/duties'], ['PATCH', '/api/duties/1'], ['DELETE', '/api/duties/1']]) {
      assert.strictEqual((await api(m, p, cookie, { duty: 'X' })).status, 403, `${slug} ${m} ${p}`);
    }
  }
});

test('admin CRUD round-trip, ordered case-insensitively, with updated_by stamped', async () => {
  const { adminId } = await seed();
  const admin = await login('admintest');

  let res = await api('POST', '/api/duties', admin,
    { duty: 'Lodging Monitor', primary_owner: ' Glikin ', alternate_owner: '' });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.deepStrictEqual(created,
    { id: created.id, duty: 'Lodging Monitor', primary_owner: 'Glikin', alternate_owner: null });

  assert.strictEqual((await api('POST', '/api/duties', admin, { duty: 'adutm' })).status, 201);

  const { duties: listed } = await (await api('GET', '/api/duties', await login('memtest'))).json();
  assert.deepStrictEqual(listed.map(d => d.duty), ['adutm', 'Lodging Monitor'], 'lower(duty) ordering');

  res = await api('PATCH', `/api/duties/${created.id}`, admin, { primary_owner: '' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).primary_owner, null, 'blank clears the owner');
  const { rows: [row] } = await pool.query('SELECT updated_by_id FROM additional_duties WHERE id = $1', [created.id]);
  assert.strictEqual(row.updated_by_id, adminId);

  assert.strictEqual((await api('DELETE', `/api/duties/${created.id}`, admin)).status, 204);
  assert.strictEqual((await (await api('GET', '/api/duties', admin)).json()).duties.length, 1);
  assert.strictEqual((await api('PATCH', `/api/duties/${created.id}`, admin, { duty: 'Gone' })).status, 404);
  assert.strictEqual((await api('DELETE', `/api/duties/${created.id}`, admin)).status, 404);
  assert.strictEqual((await api('DELETE', '/api/duties/abc', admin)).status, 400);
});

test('400s: empty duty, 121-character duty, 201-character owner, PATCH with nothing to update', async () => {
  await seed();
  const admin = await login('admintest');
  const bad = async (m, p, body) => {
    const r = await api(m, p, admin, body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    return (await r.json()).error;
  };
  assert.match(await bad('POST', '/api/duties', { duty: '   ' }), /required/);
  assert.match(await bad('POST', '/api/duties', { duty: 'x'.repeat(121) }), /120/);
  assert.match(await bad('POST', '/api/duties', { duty: 'ok', primary_owner: 'x'.repeat(201) }), /200/);
  const { id } = await (await api('POST', '/api/duties', admin, { duty: 'ok' })).json();
  assert.match(await bad('PATCH', `/api/duties/${id}`, {}), /Nothing to update/);
});

test('409: a case-insensitive duplicate, on create and on rename', async () => {
  await seed();
  const admin = await login('admintest');
  assert.strictEqual((await api('POST', '/api/duties', admin, { duty: 'ADUTM' })).status, 201);
  const dup = await api('POST', '/api/duties', admin, { duty: 'adutm' });
  assert.strictEqual(dup.status, 409);
  assert.match((await dup.json()).error, /already exists/);
  const { id } = await (await api('POST', '/api/duties', admin, { duty: 'ITEC' })).json();
  assert.strictEqual((await api('PATCH', `/api/duties/${id}`, admin, { duty: 'Adutm' })).status, 409);
  assert.strictEqual((await api('PATCH', `/api/duties/${id}`, admin, { duty: 'ITEC' })).status, 200,
    'renaming to itself is fine');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --env-file=.env.test --test test/duties-http.test.js`
Expected: FAIL — the routes do not exist, so the `/api/*` JSON handler answers **404** where 401/403/200 is asserted.

- [ ] **Step 3: Add the routes to `server.js`**

```js
// ── Additional duties (Resources → People) ───────────────────────────────────
// Everyone reads; the two roster admins write — the same gate as Forms.
app.get('/api/duties', requireAuth, async (req, res) => {
  try {
    res.json({ duties: await duties.list(pool) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

function dutyError(err, res) {
  if (err && err.code === 'DUPLICATE') return res.status(409).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: 'Server error' });
}

app.post('/api/duties', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const v = duties.validate(req.body || {}, { partial: false });
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    res.status(201).json(await duties.create(pool, v.value, req.session.memberId));
  } catch (err) { dutyError(err, res); }
});

app.patch('/api/duties/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid duty id' });
  const v = duties.validate(req.body || {}, { partial: true });
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const row = await duties.update(pool, id, v.value, req.session.memberId);
    if (!row) return res.status(404).json({ error: 'That duty no longer exists' });
    res.json(row);
  } catch (err) { dutyError(err, res); }
});

app.delete('/api/duties/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid duty id' });
  try {
    if (!await duties.remove(pool, id)) return res.status(404).json({ error: 'That duty no longer exists' });
    res.status(204).end();
  } catch (err) { dutyError(err, res); }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test test/duties-http.test.js`
Expected: `# pass 7`, `# fail 0` — Task 3's two seed tests (seed-on-create, atomic rollback) plus the five added here.

- [ ] **Step 5: Commit**

```bash
git add server.js test/duties-http.test.js
git commit -m "Additional duties API: read by everyone, written by roster admins

Four thin routes over lib/duties.js, gated exactly as the Forms routes
are. A case-insensitive duplicate and a rename onto another duty both 409
through the functional index, so 'ADUTM' and 'Adutm' cannot coexist.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `GET /api/calendar` and the drill-date writes

**Files:**
- Modify: `server.js` — insert directly after the `/api/duties` routes
- Test: `test/drill-dates-http.test.js` (append)

**Interfaces:**
- Consumes: `drillCal.*`, `calEvents.listAll` (Tasks 2–3).
- Produces: `GET /api/calendar?year= → { year, years, months }`; `POST /api/drill-dates → 201`; `PATCH /:id → 200`; `DELETE /:id → 204`.

- [ ] **Step 1: Append the failing route tests**

```js
const SEP = { start_date: '2026-09-11', end_date: '2026-09-13', note: null };

test('signed out: the calendar and every drill route is 401', async () => {
  await seed();
  for (const [m, p] of [['GET', '/api/calendar'], ['POST', '/api/drill-dates'],
                        ['PATCH', '/api/drill-dates/1'], ['DELETE', '/api/drill-dates/1']]) {
    // fetch refuses a GET that carries a body, so only the writes get one.
    const body = m === 'GET' ? undefined : {};
    assert.strictEqual((await api(m, p, null, body)).status, 401, `${m} ${p}`);
  }
});

test('403 matrix: member, supervisor and leadership-without-the-capability cannot write; all can read', async () => {
  await seed();
  for (const slug of ['memtest', 'suptest', 'leadtest']) {
    const cookie = await login(slug);
    assert.strictEqual((await api('GET', '/api/calendar', cookie)).status, 200, `${slug} can read`);
    for (const [m, p] of [['POST', '/api/drill-dates'], ['PATCH', '/api/drill-dates/1'],
                          ['DELETE', '/api/drill-dates/1']]) {
      assert.strictEqual((await api(m, p, cookie, SEP)).status, 403, `${slug} ${m} ${p}`);
    }
  }
});

test('GET /api/calendar: twelve months, drills and events together, years across both tables', async () => {
  await seed();
  const admin = await login('admintest');
  for (const d of [SEP, { start_date: '2026-08-08', end_date: '2026-08-09', note: null }]) {
    assert.strictEqual((await api('POST', '/api/drill-dates', admin, d)).status, 201);
  }
  await pool.query(
    `INSERT INTO calendar_events (title, location, start_date, end_date, attendees, status)
     VALUES ('RADR','Fargo, ND',DATE '2026-09-20',DATE '2026-09-26','MSgt Brown','scheduled'),
            ('Silver Flag','Tyndall AFB, FL',DATE '2025-11-03',DATE '2025-11-09','TSgt Price','complete')`);

  const member = await login('memtest');
  let body = await (await api('GET', '/api/calendar?year=2026', member)).json();
  assert.strictEqual(body.year, 2026);
  assert.deepStrictEqual(body.years, [2025, 2026], 'years spans drills and events');
  assert.strictEqual(body.months.length, 12);
  const sep = body.months.find(m => m.month === 9);
  assert.strictEqual(sep.noUta, false);
  assert.deepStrictEqual(sep.entries.map(e => [e.kind, e.label]),
    [['drill', '11–13 Sep'], ['event', '20–26 Sep']]);
  assert.strictEqual(body.months.find(m => m.month === 7).noUta, true);
  assert.strictEqual(body.months.filter(m => m.noUta).length, 10, 'only Aug and Sep have drills');

  body = await (await api('GET', '/api/calendar?year=2025', member)).json();
  assert.strictEqual(body.months.flatMap(m => m.entries).length, 1);
  assert.ok(body.months.every(m => m.noUta), '2025 has events but no drills');

  for (const bad of ['abc', '99', '1999', '2101']) {
    assert.strictEqual((await api('GET', `/api/calendar?year=${bad}`, member)).status, 400, `year=${bad}`);
  }
  const dflt = await (await api('GET', '/api/calendar', member)).json();
  assert.strictEqual(dflt.year, new Date().getUTCFullYear(), 'defaults to the current year');
});

test('admin drill CRUD round-trip with updated_by stamped; 404 on unknown ids', async () => {
  const { adminId } = await seed();
  const admin = await login('admintest');
  let res = await api('POST', '/api/drill-dates', admin, { ...SEP, note: '  3-day  ' });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.deepStrictEqual(created,
    { id: created.id, start_date: '2026-09-11', end_date: '2026-09-13', note: '3-day' });

  res = await api('PATCH', `/api/drill-dates/${created.id}`, admin, { end_date: '2026-09-12', note: '' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(),
    { id: created.id, start_date: '2026-09-11', end_date: '2026-09-12', note: null });
  const { rows: [row] } = await pool.query('SELECT updated_by_id FROM drill_dates WHERE id = $1', [created.id]);
  assert.strictEqual(row.updated_by_id, adminId);

  assert.strictEqual((await api('DELETE', `/api/drill-dates/${created.id}`, admin)).status, 204);
  assert.strictEqual((await api('PATCH', `/api/drill-dates/${created.id}`, admin, { note: 'x' })).status, 404);
  assert.strictEqual((await api('DELETE', `/api/drill-dates/${created.id}`, admin)).status, 404);
  assert.strictEqual((await api('DELETE', '/api/drill-dates/abc', admin)).status, 400);
});

test('400s: malformed date, end before start, an eight-day span, an 81-character note', async () => {
  await seed();
  const admin = await login('admintest');
  const bad = async (body) => {
    const r = await api('POST', '/api/drill-dates', admin, body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    return (await r.json()).error;
  };
  assert.match(await bad({ start_date: '9/11/2026', end_date: '2026-09-13' }), /start_date/);
  assert.match(await bad({ start_date: '2026-09-13', end_date: '2026-09-11' }), /before/);
  assert.match(await bad({ start_date: '2026-09-01', end_date: '2026-09-08' }), /seven days/);
  assert.match(await bad({ ...SEP, note: 'x'.repeat(81) }), /80/);
});

test('409: overlapping another drill, on create and on edit; a PATCH never conflicts with itself', async () => {
  await seed();
  const admin = await login('admintest');
  const { id } = await (await api('POST', '/api/drill-dates', admin, SEP)).json();
  const { id: oct } = await (await api('POST', '/api/drill-dates', admin,
    { start_date: '2026-10-17', end_date: '2026-10-18', note: null })).json();

  const dup = await api('POST', '/api/drill-dates', admin,
    { start_date: '2026-09-13', end_date: '2026-09-14', note: null });
  assert.strictEqual(dup.status, 409);
  assert.match((await dup.json()).error, /overlap/i);
  assert.strictEqual((await api('POST', '/api/drill-dates', admin,
    { start_date: '2026-09-14', end_date: '2026-09-15', note: null })).status, 201, 'adjacent is fine');

  assert.strictEqual((await api('PATCH', `/api/drill-dates/${oct}`, admin,
    { start_date: '2026-09-12', end_date: '2026-09-13' })).status, 409, 'editing onto another drill');
  assert.strictEqual((await api('PATCH', `/api/drill-dates/${id}`, admin,
    { end_date: '2026-09-12' })).status, 200, 'shrinking within itself');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --env-file=.env.test --test test/drill-dates-http.test.js`
Expected: FAIL — route tests answer 404 from the `/api/*` handler.

- [ ] **Step 3: Add the routes to `server.js`**

```js
// ── The calendar (Resources → Calendar) ──────────────────────────────────────
// One read endpoint for the whole year: merging two tables and regrouping them
// by month in the browser would duplicate buildCalendar in a second language.
// The derivation lives in lib/drill-calendar.js, shared with the newsletter.
app.get('/api/calendar', requireAuth, async (req, res) => {
  let year = new Date().getUTCFullYear();
  if (req.query.year !== undefined) {
    const y = String(req.query.year);
    if (!/^\d{4}$/.test(y) || Number(y) < 2000 || Number(y) > 2100) {
      return res.status(400).json({ error: 'year must be a four-digit year between 2000 and 2100' });
    }
    year = Number(y);
  }
  try {
    const [drills, events] = await Promise.all([drillCal.listAll(pool), calEvents.listAll(pool)]);
    const { months } = drillCal.buildCalendar(drills, events, year, new Date());
    res.json({ year, years: drillCal.years(drills, events), months });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/drill-dates', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const v = drillCal.validateDrill(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const clash = await drillCal.findOverlap(pool, v.value, null);
    if (clash) {
      return res.status(409).json({
        error: `Those dates overlap the ${drillCal.label(clash.start_date, clash.end_date)} drill` });
    }
    res.status(201).json(await drillCal.create(pool, v.value, req.session.memberId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/drill-dates/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid drill id' });
  try {
    const existing = await drillCal.get(pool, id);
    if (!existing) return res.status(404).json({ error: 'That drill no longer exists' });
    // Validate the merged row, so a one-field PATCH is checked against the dates
    // it will actually have.
    const body = req.body || {};
    const v = drillCal.validateDrill({
      start_date: 'start_date' in body ? body.start_date : existing.start_date,
      end_date:   'end_date'   in body ? body.end_date   : existing.end_date,
      note:       'note'       in body ? body.note       : existing.note,
    });
    if (!v.ok) return res.status(400).json({ error: v.error });
    const clash = await drillCal.findOverlap(pool, v.value, id);
    if (clash) {
      return res.status(409).json({
        error: `Those dates overlap the ${drillCal.label(clash.start_date, clash.end_date)} drill` });
    }
    const row = await drillCal.update(pool, id, v.value, req.session.memberId);
    if (!row) return res.status(404).json({ error: 'That drill no longer exists' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/drill-dates/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid drill id' });
  try {
    if (!await drillCal.remove(pool, id)) return res.status(404).json({ error: 'That drill no longer exists' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test test/drill-dates-http.test.js`
Expected: `# pass 8`, `# fail 0` — Task 3's two seed tests (seed-on-create, atomic rollback) plus the six added here.

- [ ] **Step 5: Commit**

```bash
git add server.js test/drill-dates-http.test.js
git commit -m "Calendar API: one read for the year, and the drill writes

GET /api/calendar returns the year already derived — twelve month groups,
drills and events interleaved, No-UTA on the month, past/next against
today — plus every year either table has rows in, so the year picker can
offer next year the moment it is entered. Drill writes validate the merged
row and refuse any overlap with another drill, naming it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `/api/calendar-events` routes

**Files:**
- Modify: `server.js` — insert directly after the drill-date routes
- Test: `test/calendar-events-http.test.js` (append)

**Interfaces:**
- Consumes: `calEvents.*` (Task 3).
- Produces: `POST /api/calendar-events → 201`; `PATCH /:id → 200`; `DELETE /:id → 204`.

- [ ] **Step 1: Append the failing route tests**

```js
const RADR = { title: 'RADR', location: 'Fargo, ND', start_date: '2026-05-03',
               end_date: '2026-05-09', attendees: 'MSgt Brown', status: 'scheduled', note: null };

test('signed out: every event route is 401', async () => {
  await seed();
  for (const [m, p] of [['POST', '/api/calendar-events'], ['PATCH', '/api/calendar-events/1'],
                        ['DELETE', '/api/calendar-events/1']]) {
    assert.strictEqual((await api(m, p, null, {})).status, 401, `${m} ${p}`);
  }
});

test('403 matrix: member, supervisor and leadership-without-the-capability cannot write', async () => {
  await seed();
  for (const slug of ['memtest', 'suptest', 'leadtest']) {
    const cookie = await login(slug);
    for (const [m, p] of [['POST', '/api/calendar-events'], ['PATCH', '/api/calendar-events/1'],
                          ['DELETE', '/api/calendar-events/1']]) {
      assert.strictEqual((await api(m, p, cookie, RADR)).status, 403, `${slug} ${m} ${p}`);
    }
  }
});

test('admin CRUD round-trip; status defaults to scheduled; updated_by stamped', async () => {
  const { adminId } = await seed();
  const admin = await login('admintest');

  let res = await api('POST', '/api/calendar-events', admin,
    { title: '  RADR  ', location: 'Fargo, ND', start_date: '2026-05-03', end_date: '2026-05-09',
      attendees: ' MSgt Brown ', note: '' });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.deepStrictEqual(created, { id: created.id, title: 'RADR', location: 'Fargo, ND',
    start_date: '2026-05-03', end_date: '2026-05-09', attendees: 'MSgt Brown',
    status: 'scheduled', note: null });

  // A one-field PATCH keeps everything else, because the route merges over the row.
  res = await api('PATCH', `/api/calendar-events/${created.id}`, admin, { status: 'complete' });
  assert.strictEqual(res.status, 200);
  const patched = await res.json();
  assert.strictEqual(patched.status, 'complete');
  assert.strictEqual(patched.title, 'RADR');
  assert.strictEqual(patched.attendees, 'MSgt Brown');
  const { rows: [row] } = await pool.query('SELECT updated_by_id FROM calendar_events WHERE id = $1', [created.id]);
  assert.strictEqual(row.updated_by_id, adminId);

  // Events may overlap each other and a drill, unlike drills.
  assert.strictEqual((await api('POST', '/api/calendar-events', admin, RADR)).status, 201);
  assert.strictEqual((await api('POST', '/api/drill-dates', admin,
    { start_date: '2026-05-01', end_date: '2026-05-03', note: null })).status, 201);

  assert.strictEqual((await api('DELETE', `/api/calendar-events/${created.id}`, admin)).status, 204);
  assert.strictEqual((await api('PATCH', `/api/calendar-events/${created.id}`, admin, { status: 'complete' })).status, 404);
  assert.strictEqual((await api('DELETE', `/api/calendar-events/${created.id}`, admin)).status, 404);
  assert.strictEqual((await api('DELETE', '/api/calendar-events/abc', admin)).status, 400);
});

test('400s: missing title, bad status, end before start, over-long attendees', async () => {
  await seed();
  const admin = await login('admintest');
  const bad = async (body) => {
    const r = await api('POST', '/api/calendar-events', admin, body);
    assert.strictEqual(r.status, 400, JSON.stringify(body).slice(0, 80));
    return (await r.json()).error;
  };
  assert.match(await bad({ ...RADR, title: '  ' }), /title is required/);
  assert.match(await bad({ ...RADR, title: 'x'.repeat(121) }), /120/);
  assert.match(await bad({ ...RADR, status: 'pending' }), /status must be one of/);
  assert.match(await bad({ ...RADR, start_date: '2026-13-01' }), /start_date/);
  assert.match(await bad({ ...RADR, end_date: '2026-05-01' }), /before/);
  assert.match(await bad({ ...RADR, attendees: 'x'.repeat(601) }), /600/);
  assert.match(await bad({ ...RADR, note: 'x'.repeat(201) }), /200/);
});

test('a fortnight-long event is accepted — the seven-day cap is a drill rule', async () => {
  await seed();
  const admin = await login('admintest');
  const res = await api('POST', '/api/calendar-events', admin,
    { ...RADR, title: 'FY26 DFT', start_date: '2026-06-15', end_date: '2026-06-29' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual((await res.json()).end_date, '2026-06-29');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --env-file=.env.test --test test/calendar-events-http.test.js`
Expected: FAIL — 404s from the `/api/*` handler.

- [ ] **Step 3: Add the routes to `server.js`**

```js
// Calendar events — TDY and training rotations. No overlap rule: two rotations
// in the same week, and a rotation across a drill, are both normal.
app.post('/api/calendar-events', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const v = calEvents.validate(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    res.status(201).json(await calEvents.create(pool, v.value, req.session.memberId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/calendar-events/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid event id' });
  try {
    const existing = await calEvents.get(pool, id);
    if (!existing) return res.status(404).json({ error: 'That event no longer exists' });
    // Merge over the stored row so a one-field PATCH validates as a whole event.
    const v = calEvents.validate({ ...existing, ...(req.body || {}) });
    if (!v.ok) return res.status(400).json({ error: v.error });
    const row = await calEvents.update(pool, id, v.value, req.session.memberId);
    if (!row) return res.status(404).json({ error: 'That event no longer exists' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/calendar-events/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid event id' });
  try {
    if (!await calEvents.remove(pool, id)) return res.status(404).json({ error: 'That event no longer exists' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test test/calendar-events-http.test.js`
Expected: `# pass 7`, `# fail 0` — Task 3's two seed tests (seed-on-create, atomic rollback) plus the five added here.

- [ ] **Step 5: Commit**

```bash
git add server.js test/calendar-events-http.test.js
git commit -m "Calendar events API: the TDY and training rotations

Three write routes over lib/calendar-events.js. Deliberately looser than
the drill rules: events overlap each other and drills, and a DFT runs a
fortnight, so there is no uniqueness, no overlap check and no seven-day
cap. A PATCH merges over the stored row before validating, so editing one
field checks the whole event.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 7: The Resources tab restructure

**Files:**
- Modify: `public/index.html` — tab strip, calculator wrapper, Links label, People toggle, an empty Calendar pane, `switchResPane`, `switchView`, the stale comment, and the new CSS

**Interfaces:**
- Produces: pane `#res-pane-calc` wrapping `#res-pane-pfra` and `#res-pane-promo`; pane `#res-pane-calendar` with mount `#cal-host`; `#duties-view` with mount `#duties-host` inside the People pane; globals `setCalcView(mode)` and `setPeopleView(mode)`; `switchResPane` calls `window.dutiesInit` and `window.calendarInit` when they exist (Tasks 8 and 9 define them).

This task ships the container only: the Calendar pane and the duties view mount empty. A reviewer can accept or reject the restructure — five tabs, both calculators still working, Links renamed — independently of what fills them.

**No automated harness exists for `public/`.** Verification is the browser, via `preview-run.cjs` (`.claude/launch.json`, name `preview`, port 3100), which runs against the staging database with cron off.

- [ ] **Step 1: Rewrite the tab strip**

Replace the five buttons inside `<div class="res-tabs" role="tablist">`:

```html
        <button class="res-tab active" data-rt="calc" onclick="switchResPane('calc')">Calculators</button>
        <button class="res-tab" data-rt="forms" onclick="switchResPane('forms')">Forms</button>
        <button class="res-tab" data-rt="links" onclick="switchResPane('links')">Links</button>
        <button class="res-tab" data-rt="orgchart" onclick="switchResPane('orgchart')">People</button>
        <button class="res-tab" data-rt="calendar" onclick="switchResPane('calendar')">Calendar</button>
```

- [ ] **Step 2: Wrap the two calculators**

Find the opening tag `<div id="res-pane-pfra" class="res-pane active">` and the opening tag `<div id="res-pane-promo" class="res-pane">`. They are adjacent panes: pfra runs to just before promo, and promo runs to just before `<div id="res-pane-links"`. Work from those anchors, not line numbers — earlier tasks may have shifted them.

1. **Immediately before** `<div id="res-pane-pfra"`, insert:

```html
      <!-- ── Calculators: the two score tools behind one tab ──────────────
           PT and Promotion are the same kind of thing — enter numbers, read a
           score — so they share a tab and free a slot for Calendar. The inner
           panes keep their ids (roughly 700 lines of calculator CSS and JS key
           off them) and only swap .res-pane for .calc-view, so switchResPane's
           querySelectorAll('.res-pane') no longer reaches them. -->
      <div id="res-pane-calc" class="res-pane active">
        <div class="seg-toggle calc-toggle" role="group" aria-label="Calculator">
          <button class="seg-btn active" id="calc-vt-pfra" aria-pressed="true" onclick="setCalcView('pfra')">Fitness</button>
          <button class="seg-btn" id="calc-vt-promo" aria-pressed="false" onclick="setCalcView('promo')">Promotion</button>
        </div>
```

2. Change `<div id="res-pane-pfra" class="res-pane active">` to `<div id="res-pane-pfra" class="calc-view active">`.
3. Change `<div id="res-pane-promo" class="res-pane">` to `<div id="res-pane-promo" class="calc-view">`.
4. **Immediately after** the promo pane's closing `</div>` (the last one before `<div id="res-pane-links"`), insert `      </div><!-- /#res-pane-calc -->`.

Verify the nesting before moving on:

```bash
node -e "const h=require('fs').readFileSync('public/index.html','utf8');for(const id of ['res-pane-calc','res-pane-pfra','res-pane-promo']){console.log(id, h.includes('id=\"'+id+'\"'));}console.log('calc-view count', (h.match(/class=\"calc-view/g)||[]).length);"
```
Expected: three `true`, and `calc-view count 2`.

- [ ] **Step 3: Add the People toggle and the duties mount**

Replace the whole `#res-pane-orgchart` pane with:

```html
      <div id="res-pane-orgchart" class="res-pane">
        <!-- People: the chain of command (who is above me) and the additional
             duties list (who do I see about X). A toggle rather than a sixth
             tab — the strip is already at five — and rather than stacking,
             because four flights of chips would bury the list. -->
        <div class="seg-toggle people-toggle" role="group" aria-label="People view">
          <button class="seg-btn active" id="people-vt-chain" aria-pressed="true" onclick="setPeopleView('chain')">Chain of command</button>
          <button class="seg-btn" id="people-vt-duties" aria-pressed="false" onclick="setPeopleView('duties')">Additional duties</button>
        </div>
        <div id="sq-orgchart">
          <div class="sec-hd" style="padding:0 0 12px">
            <h2 class="sec-title">Chain of Command</h2>
            <div class="sec-sub">108th Civil Engineer Squadron</div>
          </div>
          <div id="org-staff-banner"></div>
          <div id="org-flights"></div>
        </div>
        <div id="duties-view" hidden>
          <div class="sec-hd" style="padding:0 0 12px">
            <h2 class="sec-title">Additional Duties</h2>
            <div class="sec-sub">Who to see about what</div>
          </div>
          <div id="duties-host"></div>
        </div>
      </div><!-- /#res-pane-orgchart -->
```

- [ ] **Step 4: Add the Calendar pane**

Immediately after the `#res-pane-orgchart` pane's closing comment, insert:

```html
      <!-- ── Calendar: the year's drills and rotations (public/calendar.js) ── -->
      <div id="res-pane-calendar" class="res-pane">
        <div class="sec-hd" style="padding:0 0 12px">
          <h2 class="sec-title">Calendar</h2>
          <div class="sec-sub" id="cal-sub">Drill weekends and training</div>
        </div>
        <div id="cal-host"></div>
      </div><!-- /#res-pane-calendar -->
```

- [ ] **Step 5: Add the CSS**

After the `.drill-scope-note { … }` rule, insert:

```css
    /* ── Resources: calculators and People behind toggles ────────────────── */
    .calc-toggle, .people-toggle { margin-bottom: 14px; }
    /* Not .res-pane: switchResPane toggles every .res-pane by id, and these two
       are switched by setCalcView instead. */
    .calc-view { display: none; }
    .calc-view.active { display: block; }
```

- [ ] **Step 6: Fix the stale comment**

Replace the two comment lines above the `@media (max-width: 480px)` rule that reads "Four tabs now share the resources tab bar…" with:

```js
    /* Five tabs share the resources tab bar. The set was renamed and
       re-cut in Aug 2026 (Calculators · Forms · Links · People · Calendar),
       which took the strip from 48 characters of label to 35 — but the
       narrow-phone rule still earns its place at 375px. */
```

- [ ] **Step 7: Rewrite `switchResPane` and add the two view functions**

Replace the comment line above `switchResPane` and the function body with:

```js
/* ── Resources sub-tabs (Calculators | Forms | Links | People | Calendar) ── */
function switchResPane(name) {
  document.querySelectorAll('.res-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.rt === name));
  document.querySelectorAll('.res-pane').forEach(p =>
    p.classList.toggle('active', p.id === 'res-pane-' + name));
  if (name === 'calc') setCalcView(document.getElementById('calc-vt-promo')?.classList.contains('active') ? 'promo' : 'pfra');
  if (name === 'orgchart') loadOrgChart();
  if (name === 'forms') loadDocuments();
  if (name === 'calendar' && window.calendarInit) window.calendarInit({ canEdit: !!currentMember?.can_manage_roster });
}

/* Resources → Calculators. Each calculator still builds its gauge and control
   rows on first open only; nothing initialises until it is actually shown. */
function setCalcView(mode) {
  const promo = mode === 'promo';
  document.getElementById('calc-vt-pfra').classList.toggle('active', !promo);
  document.getElementById('calc-vt-pfra').setAttribute('aria-pressed', String(!promo));
  document.getElementById('calc-vt-promo').classList.toggle('active', promo);
  document.getElementById('calc-vt-promo').setAttribute('aria-pressed', String(promo));
  document.getElementById('res-pane-pfra').classList.toggle('active', !promo);
  document.getElementById('res-pane-promo').classList.toggle('active', promo);
  if (promo) { if (window.pmInit) window.pmInit(); }
  else if (window.pfInit) window.pfInit();
}

/* Resources → People: chain of command | additional duties. */
function setPeopleView(mode) {
  const dut = mode === 'duties';
  document.getElementById('people-vt-chain').classList.toggle('active', !dut);
  document.getElementById('people-vt-chain').setAttribute('aria-pressed', String(!dut));
  document.getElementById('people-vt-duties').classList.toggle('active', dut);
  document.getElementById('people-vt-duties').setAttribute('aria-pressed', String(dut));
  document.getElementById('sq-orgchart').hidden = dut;
  document.getElementById('duties-view').hidden = !dut;
  if (dut && window.dutiesInit) window.dutiesInit({ canEdit: !!currentMember?.can_manage_roster });
}
```

- [ ] **Step 8: Point `switchView` at the new default pane**

In `switchView`, change `if (name === 'resources') { switchResPane('pfra'); syncInstallCard(); }` to:

```js
  if (name === 'resources') { switchResPane('calc'); syncInstallCard(); }
```

- [ ] **Step 9: Verify in the browser**

Start the preview (http://localhost:3100), sign in as `gablin` / `preview123`, open Resources:

- Five tabs read **Calculators · Forms · Links · People · Calendar**, all on one line at 375px (DevTools device mode) and at 320px without wrapping.
- Calculators opens by default on **Fitness**, and the PT calculator renders exactly as before — gauge, control rows, results.
- **Promotion** shows the promotion calculator, fully working. Switching back and forth several times leaves both intact.
- Leaving Resources and returning lands on Calculators → Fitness.
- **Forms** and **Links** are unchanged (Links keeps all five link cards).
- **People** shows the toggle, defaults to Chain of command with the org chart unchanged, and **Additional duties** shows the heading over an empty area (Task 8 fills it).
- **Calendar** shows its heading over an empty area (Task 9 fills it).
- No console errors on any tab. Dark mode renders all five tabs legibly.

- [ ] **Step 10: Commit**

```bash
git add public/index.html
git commit -m "Resources: five subject-shaped tabs instead of five task-shaped ones

PT and Promotion are the same kind of thing, so they share a Calculators
tab behind a toggle — which frees the slot Calendar takes rather than
spending one. Org Chart becomes People and gains a toggle for the duties
list; Useful Links becomes Links now that nothing but links is in it. The
strip goes from 48 characters of label to 35, which the 375px rule has
wanted for a while.

The two calculators keep their element ids and only swap .res-pane for
.calc-view, so none of their ~700 lines had to be touched. Calendar and
the duties view mount empty here and are filled next.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: The Additional Duties view (`public/duties.js`)

**Files:**
- Create: `public/duties.js`
- Modify: `public/index.html` — script tag after `offline.js`; CSS after the `.calc-view.active` rule

**Interfaces:**
- Consumes: `/api/duties` (Task 4); the mount `#duties-host` and `setPeopleView` (Task 7); page globals `openModal`, `closeModal`, `showToast`, `uiConfirm`.
- Produces: `window.dutiesInit({ canEdit })` — idempotent; first call renders the shell and fetches, later calls re-render if `canEdit` changed.

- [ ] **Step 1: Create `public/duties.js`**

```js
// public/duties.js — Resources → People → Additional duties.
//
// One global, dutiesInit({ canEdit }), called from setPeopleView() the first
// time a member flips the toggle. Everyone gets the list and the filter; roster
// admins also get Add and a pencil per row. The API enforces the same rule — the
// flag here only keeps controls out of everyone else's way.
//
// Rows are a divider list on the .member-row metrics rather than 52 bordered
// cards: half the scroll height, consistent with the calendar beside it, and
// clear of the identical-card-grid ban. Uses the page's openModal/closeModal
// (focus trap, role=dialog), showToast (quiet offline) and uiConfirm.
(function () {
  let all = [];
  let canEdit = false;
  let shellReady = false;
  let editingId = null;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast = (msg, type) => (typeof showToast === 'function' ? showToast : uiToast)(msg, type);
  const $ = (id) => document.getElementById(id);

  const PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5l2 2L5 13H3v-2z"/><path d="M10 4l2 2"/></svg>';

  function shell() {
    $('duties-host').innerHTML = `
      ${canEdit ? '<div class="duty-admin"><button class="add-btn" type="button" id="duty-add">+ Add duty</button></div>' : ''}
      <div class="search-wrap duties-search">
        <input class="search-input" id="duty-q" type="search" placeholder="Search duties and names" autocomplete="off" aria-label="Filter duties">
        <div class="search-count" id="duty-count"></div>
      </div>
      <div class="duty-list" id="duty-list"><div class="skeleton"></div><div class="skeleton"></div></div>`;
    $('duty-q').addEventListener('input', renderList);
    if (canEdit) $('duty-add').addEventListener('click', () => openEditor(null));
    $('duty-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.duty-edit');
      if (btn) openEditor(Number(btn.dataset.id));
    });
    shellReady = true;
  }

  async function load() {
    try {
      const res = await fetch('/api/duties');
      if (!res.ok) throw new Error('request failed');
      all = (await res.json()).duties;
      renderList();
    } catch (e) {
      console.error('duties', e);
      $('duty-list').innerHTML = '<div class="res-offline">The duties list needs a connection. Try again once you have signal.</div>';
      $('duty-count').textContent = '';
    }
  }

  function renderList() {
    const q = ($('duty-q').value || '').trim().toLowerCase();
    const rows = q
      ? all.filter(d => [d.duty, d.primary_owner, d.alternate_owner]
          .some(v => (v || '').toLowerCase().includes(q)))
      : all;
    $('duty-count').textContent = q ? `${rows.length} of ${all.length} match` : `${all.length} duties`;
    if (!all.length) {
      $('duty-list').innerHTML = `<div class="res-empty">${canEdit
        ? 'No duties yet — add the first one above.'
        : 'No duties have been posted yet.'}</div>`;
      return;
    }
    if (!rows.length) {
      $('duty-list').innerHTML = '<div class="res-empty">Nothing matches that search.</div>';
      return;
    }
    $('duty-list').innerHTML = rows.map(d => `
      <div class="duty-row${d.primary_owner ? '' : ' needs-owner'}">
        <div class="duty-body">
          <div class="duty-name">${esc(d.duty)}${d.primary_owner ? ''
            : ' <span class="duty-tag">Needs owner</span>'}</div>
          <div class="duty-owners">Primary: ${esc(d.primary_owner || '—')} · Alt: ${esc(d.alternate_owner || '—')}</div>
        </div>
        ${canEdit ? `<button class="duty-edit" type="button" aria-label="Edit ${esc(d.duty)}" data-id="${d.id}">${PENCIL}</button>` : ''}
      </div>`).join('');
  }

  // ── Editor modal (admins only) ──────────────────────────────────────────
  function ensureModal() {
    if ($('duty-modal')) return;
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = 'duty-modal';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-hdr">
          <h2 class="modal-title" id="duty-modal-title">Add duty</h2>
          <button class="modal-close" type="button" aria-label="Close" id="duty-close">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <div class="modal-field"><label for="duty-f-name">Duty</label>
          <input id="duty-f-name" type="text" maxlength="120" placeholder="Lodging Monitor"></div>
        <div class="modal-field"><label for="duty-f-primary">Primary</label>
          <input id="duty-f-primary" type="text" maxlength="200" placeholder="Leave blank if nobody holds it"></div>
        <div class="modal-field"><label for="duty-f-alternate">Alternate</label>
          <input id="duty-f-alternate" type="text" maxlength="200"></div>
        <button class="modal-submit" type="button" id="duty-save">Save</button>
        <button class="add-btn" type="button" id="duty-delete" style="display:none;width:100%;margin-top:10px;color:var(--urgent)">Delete duty</button>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) closeModal('duty-modal'); });
    $('duty-close').addEventListener('click', () => closeModal('duty-modal'));
    $('duty-save').addEventListener('click', save);
    $('duty-delete').addEventListener('click', remove);
  }

  function openEditor(id) {
    ensureModal();
    editingId = id;
    const d = id ? all.find(x => x.id === id) : null;
    $('duty-modal-title').textContent = d ? 'Edit duty' : 'Add duty';
    $('duty-f-name').value = d ? d.duty : '';
    $('duty-f-primary').value = d ? (d.primary_owner || '') : '';
    $('duty-f-alternate').value = d ? (d.alternate_owner || '') : '';
    $('duty-delete').style.display = d ? '' : 'none';
    openModal('duty-modal');
    $('duty-f-name').focus();
  }

  async function save() {
    const body = {
      duty: $('duty-f-name').value,
      primary_owner: $('duty-f-primary').value,
      alternate_owner: $('duty-f-alternate').value,
    };
    const btn = $('duty-save');
    btn.disabled = true;
    try {
      const res = await fetch(editingId ? `/api/duties/${editingId}` : '/api/duties', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save');
      closeModal('duty-modal');
      toast(editingId ? 'Duty updated' : 'Duty added', 'success');
      await load();
    } catch (e) {
      // 400 and 409 leave the modal open so the value can be corrected.
      toast(e.message || 'Could not save', 'error');
      if (/no longer exists/.test(e.message || '')) { closeModal('duty-modal'); await load(); }
    }
    btn.disabled = false;
  }

  async function remove() {
    const d = all.find(x => x.id === editingId);
    if (!d) return;
    if (!await uiConfirm({ title: `Delete "${d.duty}"?`,
      message: 'It disappears from the list and from the newsletter.',
      confirmLabel: 'Delete', danger: true })) return;
    try {
      const res = await fetch(`/api/duties/${editingId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        throw new Error((await res.json().catch(() => ({}))).error || 'Could not delete');
      }
      closeModal('duty-modal');
      toast('Duty deleted', 'success');
      await load();
    } catch (e) { toast(e.message || 'Could not delete', 'error'); }
  }

  window.dutiesInit = function ({ canEdit: ce } = {}) {
    const was = canEdit;
    canEdit = !!ce;
    if (!shellReady) { shell(); load(); return; }
    if (was !== canEdit) { shell(); renderList(); }
  };
})();
```

- [ ] **Step 2: Load the script and add the CSS**

After `<script src="/offline.js" defer></script>` add:

```html
  <script src="/duties.js" defer></script>
```

After the `.calc-view.active` rule, insert:

```css
    /* Shared empty / offline notes for the Resources data views. --t3-nav-text,
       never --t3: design.css marks --t3 strokes-and-icons only, and it is the
       documented cause of the contrast failures already logged in Resources. */
    .res-empty, .res-offline { color: var(--t3-nav-text); font-size: 13px; padding: 18px 2px; line-height: 1.5; }

    /* ── People → Additional duties (public/duties.js) ───────────────────── */
    .duties-search.search-wrap { padding: 4px 0 10px; border-bottom: 0; }
    .duty-admin { margin-bottom: 10px; }
    /* Mirrors .member-row's metrics (design.css) rather than reusing the class,
       which carries its own hover, .sel and dark-mode rules for a button row. */
    .duty-row {
      display: flex; align-items: center; gap: 10px;
      padding: 11px 12px; border-bottom: 1px solid var(--border);
    }
    .duty-row:last-child { border-bottom: 0; }
    .duty-row.needs-owner { background: var(--wrn-bg); }
    .duty-body { flex: 1; min-width: 0; }
    .duty-name { font-weight: 600; font-size: 13.5px; }
    .duty-owners { font-size: 12.5px; color: var(--t2); margin-top: 2px; overflow-wrap: anywhere; }
    .duty-tag {
      display: inline-block; margin-left: 6px; padding: 2px 7px; border-radius: 6px;
      background: var(--wrn-bg); color: var(--warn); font-size: 10.5px; font-weight: 700;
      vertical-align: middle; white-space: nowrap;
    }
    .duty-row.needs-owner .duty-tag { background: var(--bg); }
    .duty-edit {
      border: 0; background: none; color: var(--t2); cursor: pointer; padding: 8px;
      min-width: 44px; min-height: 44px; border-radius: 8px; flex: none;
    }
    .duty-edit:hover { color: var(--text); background: var(--s2); }
    .duty-edit svg { width: 16px; height: 16px; }
```

- [ ] **Step 3: Verify in the browser**

Preview at http://localhost:3100 → Resources → People → **Additional duties**, as `gablin` / `preview123`:

- 52 rows alphabetically, two lines each, `52 duties` beneath the search box. Rows are divider-separated with no per-row border.
- **Records Management / FARM** sits on the warn tint with a **Needs owner** chip and reads `Primary: — · Alt: —`.
- Typing `dts` leaves the three DTS rows and the count reads `3 of 52 match`; `gablin` finds his four; `zzz` shows "Nothing matches that search."
- **+ Add duty**: a blank name toasts "A duty name is required" with the modal open; `ADUTM` toasts the 409; a real duty saves and re-sorts into place.
- The pencil opens the row pre-filled; **Delete duty** confirms, then removes it.
- Every pencil measures 44×44 (DevTools → inspect → box model).
- As `becerra` / `becerra`: list and filter, no Add button, no pencils.
- Dark mode: the warn tint and the chip stay legible; check the `Primary:` line against the background with DevTools' contrast readout (≥4.5:1).
- 375px: rows wrap the owners line rather than overflowing; no horizontal scroll.

Delete any test rows you added on staging.

- [ ] **Step 4: Commit**

```bash
git add public/duties.js public/index.html
git commit -m "People: the additional-duties list, filterable, admin-editable

52 duties as a divider list on the .member-row metrics — the app's list
idiom, about half the height of bordered cards, and consistent with the
calendar beside it. Everyone filters by duty or by name; the two roster
admins add, edit and delete through the standard modal. A duty with no
primary owner takes the warn tint and a Needs owner chip in the app's
measured --wrn-bg/--warn pairing, so a vacancy is visible without anyone
typing TBD. Muted text is --t3-nav-text, never --t3.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: The Calendar view (`public/calendar.js`)

**Files:**
- Create: `public/calendar.js`
- Modify: `public/index.html` — script tag after `duties.js`; CSS after the `.duty-edit svg` rule

**Interfaces:**
- Consumes: `GET /api/calendar` (Task 5), `/api/drill-dates` (Task 5), `/api/calendar-events` (Task 6); the mount `#cal-host`, `#cal-sub` and `switchResPane` (Task 7).
- Produces: `window.calendarInit({ canEdit })` — idempotent, same contract as `dutiesInit`.

- [ ] **Step 1: Create `public/calendar.js`**

```js
// public/calendar.js — Resources → Calendar.
//
// One global, calendarInit({ canEdit }), called from switchResPane('calendar').
// The API returns the year already derived (lib/drill-calendar.js): twelve month
// groups, drills and events interleaved, noUta on the month, past/next against
// today. This file only renders — no date logic in the browser.
//
// Roster admins get Add drill, Add event, and a pencil per row; the API enforces
// the same rule.
(function () {
  let data = null;          // { year, years, months }
  let canEdit = false;
  let shellReady = false;
  let editing = null;       // { kind: 'drill'|'event', id } | null

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast = (msg, type) => (typeof showToast === 'function' ? showToast : uiToast)(msg, type);
  const $ = (id) => document.getElementById(id);

  const PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5l2 2L5 13H3v-2z"/><path d="M10 4l2 2"/></svg>';
  const STATUS_LABEL = { complete: 'Complete', cancelled: 'Cancelled' };

  function shell() {
    $('cal-host').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    $('cal-host').addEventListener('click', (e) => {
      const y = e.target.closest('.cal-year');
      if (y) { load(Number(y.dataset.year)); return; }
      if (e.target.closest('#cal-add-drill')) { openEditor('drill', null); return; }
      if (e.target.closest('#cal-add-event')) { openEditor('event', null); return; }
      const edit = e.target.closest('.cal-edit');
      if (edit) openEditor(edit.dataset.kind, Number(edit.dataset.id));
    });
    shellReady = true;
  }

  async function load(year) {
    try {
      const res = await fetch('/api/calendar' + (year ? `?year=${year}` : ''));
      if (!res.ok) throw new Error('request failed');
      data = await res.json();
      render();
    } catch (e) {
      console.error('calendar', e);
      $('cal-host').innerHTML = '<div class="res-offline">The calendar needs a connection. Try again once you have signal.</div>';
    }
  }

  function drillRow(e) {
    return `<div class="cal-row${e.past ? ' past' : ''}">
      <span class="cal-when">${esc(e.label)}</span>
      <span class="cal-what"><span class="cal-kind">UTA</span>${e.threeDay ? ' <span class="cal-meta">· 3-day</span>' : ''}${
        e.note ? ` <span class="cal-meta">· ${esc(e.note)}</span>` : ''}</span>
      ${e.next ? '<span class="cal-chip chip-next">Next</span>' : ''}
      ${canEdit ? `<button class="cal-edit" type="button" aria-label="Edit the ${esc(e.label)} drill" data-kind="drill" data-id="${e.id}">${PENCIL}</button>` : ''}
    </div>`;
  }

  function eventRow(e) {
    const chip = STATUS_LABEL[e.status]
      ? `<span class="cal-chip chip-${e.status}">${STATUS_LABEL[e.status]}</span>` : '';
    return `<div class="cal-row${e.past ? ' past' : ''}">
      <span class="cal-when">${esc(e.label)}</span>
      <span class="cal-what">
        <span class="cal-kind">${esc(e.title)}</span>${e.location ? ` <span class="cal-meta">· ${esc(e.location)}</span>` : ''}
        ${e.attendees ? `<span class="cal-who" title="${esc(e.attendees)}">${esc(e.attendees)}</span>` : ''}
        ${e.note ? `<span class="cal-who">${esc(e.note)}</span>` : ''}
      </span>
      ${chip}
      ${canEdit ? `<button class="cal-edit" type="button" aria-label="Edit ${esc(e.title)}, ${esc(e.label)}" data-kind="event" data-id="${e.id}">${PENCIL}</button>` : ''}
    </div>`;
  }

  function render() {
    $('cal-sub').textContent = `CY ${data.year}`;
    // Chips only when there is more than one year to choose from — the displayed
    // year plus every year with rows. .seg-toggle rather than a new chip type:
    // it is already 44px and already announces state.
    const years = [...new Set([data.year, ...data.years])].sort((a, b) => a - b);
    const picker = years.length > 1
      ? `<div class="seg-toggle cal-years" role="group" aria-label="Year">${years.map(y =>
          `<button class="seg-btn cal-year${y === data.year ? ' active' : ''}" type="button" data-year="${y}" aria-pressed="${y === data.year}">${y}</button>`).join('')}</div>`
      : '';
    const admin = canEdit
      ? `<div class="cal-admin">
           <button class="add-btn" type="button" id="cal-add-drill">+ Add drill</button>
           <button class="add-btn" type="button" id="cal-add-event">+ Add event</button>
         </div>` : '';

    // No drills and no events: a year nobody has filled in yet. Twelve
    // "No UTA" lines would read as a schedule rather than an empty one.
    if (!data.months.some(m => m.entries.length)) {
      $('cal-host').innerHTML = picker + admin
        + `<div class="res-empty">Nothing on the calendar for ${data.year}.</div>`;
      return;
    }
    const body = data.months.map(m => `
      <div class="cal-month">
        <div class="cal-month-hd">
          <span class="cal-month-name">${esc(m.label)}</span>
          ${m.noUta ? '<span class="cal-nouta">No UTA</span>' : ''}
        </div>
        ${m.entries.map(e => (e.kind === 'drill' ? drillRow(e) : eventRow(e))).join('')}
      </div>`).join('');
    $('cal-host').innerHTML = picker + admin + `<div class="card cal-list">${body}</div>`;
  }

  // ── Editor modals (admins only) ─────────────────────────────────────────
  function ensureModal() {
    if ($('cal-modal')) return;
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = 'cal-modal';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-hdr">
          <h2 class="modal-title" id="cal-modal-title">Add drill</h2>
          <button class="modal-close" type="button" aria-label="Close" id="cal-close">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <div class="modal-field" id="cal-f-title-wrap"><label for="cal-f-title">Title</label>
          <input id="cal-f-title" type="text" maxlength="120" placeholder="RADR"></div>
        <div class="modal-field" id="cal-f-location-wrap"><label for="cal-f-location">Location</label>
          <input id="cal-f-location" type="text" maxlength="120" placeholder="Dobbins ARB, GA"></div>
        <div class="field-row">
          <div class="modal-field"><label for="cal-f-start">Start</label><input id="cal-f-start" type="date"></div>
          <div class="modal-field"><label for="cal-f-end">End</label><input id="cal-f-end" type="date"></div>
        </div>
        <div class="modal-field" id="cal-f-attendees-wrap"><label for="cal-f-attendees">Attending</label>
          <textarea id="cal-f-attendees" rows="3" maxlength="600" placeholder="SrA Fowler / MSgt Brown"></textarea></div>
        <div class="modal-field" id="cal-f-status-wrap"><label for="cal-f-status">Status</label>
          <select id="cal-f-status">
            <option value="scheduled">Scheduled</option>
            <option value="complete">Complete</option>
            <option value="cancelled">Cancelled</option>
          </select></div>
        <div class="modal-field"><label for="cal-f-note">Note (optional)</label>
          <input id="cal-f-note" type="text" maxlength="200" placeholder="Jan &amp; Feb combined"></div>
        <button class="modal-submit" type="button" id="cal-save">Save</button>
        <button class="add-btn" type="button" id="cal-delete" style="display:none;width:100%;margin-top:10px;color:var(--urgent)">Delete</button>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) closeModal('cal-modal'); });
    $('cal-close').addEventListener('click', () => closeModal('cal-modal'));
    $('cal-save').addEventListener('click', save);
    $('cal-delete').addEventListener('click', remove);
  }

  function findEntry(kind, id) {
    for (const m of data.months) {
      const hit = m.entries.find(e => e.kind === kind && e.id === id);
      if (hit) return hit;
    }
    return null;
  }

  function openEditor(kind, id) {
    ensureModal();
    editing = { kind, id };
    const isEvent = kind === 'event';
    const e = id ? findEntry(kind, id) : null;
    $('cal-modal-title').textContent = `${e ? 'Edit' : 'Add'} ${isEvent ? 'event' : 'drill'}`;
    // A drill is two dates and a note; an event adds title, location, attendees
    // and status. One sheet, four fields hidden for a drill.
    for (const f of ['title', 'location', 'attendees', 'status']) {
      $(`cal-f-${f}-wrap`).hidden = !isEvent;
    }
    $('cal-f-title').value = e && isEvent ? e.title : '';
    $('cal-f-location').value = e && isEvent ? (e.location || '') : '';
    $('cal-f-start').value = e ? e.start_date : '';
    $('cal-f-end').value = e ? e.end_date : '';
    $('cal-f-attendees').value = e && isEvent ? (e.attendees || '') : '';
    $('cal-f-status').value = e && isEvent ? e.status : 'scheduled';
    $('cal-f-note').value = e ? (e.note || '') : '';
    $('cal-delete').style.display = e ? '' : 'none';
    $('cal-delete').textContent = `Delete ${isEvent ? 'event' : 'drill'}`;
    openModal('cal-modal');
    (isEvent ? $('cal-f-title') : $('cal-f-start')).focus();
  }

  const pathFor = (kind) => (kind === 'event' ? '/api/calendar-events' : '/api/drill-dates');

  async function save() {
    const { kind, id } = editing;
    const body = kind === 'event'
      ? { title: $('cal-f-title').value, location: $('cal-f-location').value,
          start_date: $('cal-f-start').value, end_date: $('cal-f-end').value,
          attendees: $('cal-f-attendees').value, status: $('cal-f-status').value,
          note: $('cal-f-note').value }
      : { start_date: $('cal-f-start').value, end_date: $('cal-f-end').value, note: $('cal-f-note').value };
    const btn = $('cal-save');
    btn.disabled = true;
    try {
      const res = await fetch(id ? `${pathFor(kind)}/${id}` : pathFor(kind), {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(saved.error || 'Could not save');
      closeModal('cal-modal');
      toast(id ? 'Saved' : (kind === 'event' ? 'Event added' : 'Drill added'), 'success');
      // Show the year it belongs to, so a next-year entry is visible at once.
      await load(Number(String(saved.start_date).slice(0, 4)) || data.year);
    } catch (e) {
      // 400 and 409 leave the modal open so the dates can be corrected.
      toast(e.message || 'Could not save', 'error');
      if (/no longer exists/.test(e.message || '')) { closeModal('cal-modal'); await load(data.year); }
    }
    btn.disabled = false;
  }

  async function remove() {
    const { kind, id } = editing;
    const e = findEntry(kind, id);
    if (!e) return;
    const what = kind === 'event' ? `${e.title}, ${e.label}` : `the ${e.label} drill`;
    if (!await uiConfirm({ title: `Delete ${what}?`,
      message: 'It disappears from the calendar for everyone.',
      confirmLabel: 'Delete', danger: true })) return;
    try {
      const res = await fetch(`${pathFor(kind)}/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        throw new Error((await res.json().catch(() => ({}))).error || 'Could not delete');
      }
      closeModal('cal-modal');
      toast('Deleted', 'success');
      await load(data.year);
    } catch (err) { toast(err.message || 'Could not delete', 'error'); }
  }

  window.calendarInit = function ({ canEdit: ce } = {}) {
    const was = canEdit;
    canEdit = !!ce;
    if (!shellReady) { shell(); load(); return; }
    if (was !== canEdit && data) render();
  };
})();
```

- [ ] **Step 2: Load the script and add the CSS**

After the `duties.js` script tag add:

```html
  <script src="/calendar.js" defer></script>
```

After the `.duty-edit svg` rule, insert:

```css
    /* ── Calendar (public/calendar.js) ───────────────────────────────────── */
    .cal-years { margin-bottom: 12px; }
    .cal-admin { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .cal-list { padding: 0 14px; }
    .cal-month + .cal-month { border-top: 1px solid var(--border); }
    .cal-month-hd {
      display: flex; align-items: center; gap: 10px; padding: 9px 0 7px;
      position: sticky; top: 0; background: var(--bg); z-index: 1;
    }
    .cal-month-name {
      font-size: 11.5px; font-weight: 700; letter-spacing: .06em;
      text-transform: uppercase; color: var(--t2);
    }
    .cal-nouta { font-size: 11px; color: var(--t3-nav-text); }
    .cal-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 9px 0; min-height: 44px; font-size: 13.5px;
    }
    .cal-row + .cal-row { border-top: 1px solid var(--border); }
    .cal-when { font-weight: 600; flex: none; min-width: 92px; }
    .cal-what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .cal-kind { font-weight: 600; }
    .cal-meta { color: var(--t2); font-weight: 500; font-size: 12.5px; }
    /* Two lines then ellipsis; the full roster is in the row's title attribute. */
    .cal-who {
      color: var(--t2); font-size: 12px; line-height: 1.35; overflow: hidden;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
    }
    /* Past is weight and colour only. No side stripe, no left border, no inset
       shadow — those are banned here and the codebase is clean of them. */
    .cal-row.past .cal-when, .cal-row.past .cal-kind { font-weight: 500; text-decoration: line-through; }
    .cal-row.past .cal-when, .cal-row.past .cal-kind, .cal-row.past .cal-meta { color: var(--t3-nav-text); }
    .cal-chip {
      flex: none; align-self: center; padding: 2px 8px; border-radius: 6px;
      font-size: 10.5px; font-weight: 700; white-space: nowrap;
    }
    /* The app's measured pairings, never a solid fill. */
    .chip-next, .chip-complete { background: var(--ok-bg); color: var(--ok); }
    .chip-cancelled { background: var(--urg-bg); color: var(--urgent); }
    .cal-edit {
      border: 0; background: none; color: var(--t2); cursor: pointer; padding: 8px;
      min-width: 44px; min-height: 44px; border-radius: 8px; flex: none;
    }
    .cal-edit:hover { color: var(--text); background: var(--s2); }
    .cal-edit svg { width: 16px; height: 16px; }
    @media (max-width: 420px) {
      .cal-row { flex-wrap: wrap; }
      .cal-when { min-width: 84px; }
    }
```

- [ ] **Step 3: Verify in the browser**

Preview → Resources → **Calendar**, as `gablin` / `preview123`:

- Twelve month groups for CY 2026. August and September carry the seeded drills; **July** shows `No UTA` in its header; April shows the 11–12 Apr drill above the 12–18 Apr RADR.
- Drills before today are struck through in muted text; **11–13 Sep** carries the green **Next** chip and is not struck. No coloured stripe or bar anywhere on a row.
- The RADR rows show location and attendee names; **Complete** and **Cancelled** chips appear on the right in green and red respectively.
- The FY26 DFT row clamps its 23 names to two lines; hovering shows the full roster.
- Year chips read **2025 | 2026** (the December 2025 rotation). Tapping 2025 shows twelve months, all `No UTA`, with the one rotation in December.
- **+ Add drill** offers only dates and a note. **+ Add event** offers title, location, dates, attendees and status.
- Adding a drill of `2026-09-12` → `2026-09-14` toasts "Those dates overlap the 11–13 Sep drill" with the modal open. An 8-day drill and an end before the start each toast their 400.
- Adding an event for `2027-03-01` switches the view to CY 2027 and adds a **2027** chip.
- Pencils are 44×44 and pre-fill correctly for both kinds; **Delete** confirms first.
- As `becerra` / `becerra`: the calendar renders, no Add buttons, no pencils.
- Dark mode: chips and struck-through rows stay legible; check the muted text with DevTools' contrast readout (≥4.5:1).
- 375px: month headers stick while scrolling; rows wrap rather than overflow; no horizontal scroll.

Delete the test drill and event from staging afterwards.

- [ ] **Step 4: Commit**

```bash
git add public/calendar.js public/index.html
git commit -m "Calendar: the year's drills and rotations in one stream

Twelve month groups, drills and events interleaved by date, with No UTA
marking the months without one so the year reads as a whole object rather
than a list of what happens to exist. Past entries are struck through and
the next drill takes a chip, so the page answers 'what is coming up' in
one read. Renders what /api/calendar derives — no date logic here.

Emphasis is weight plus the app's measured chip pairings; there is no
coloured edge on any row, and muted text is --t3-nav-text throughout.
Admins add drills and events from the same sheet, four fields hidden for
a drill.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Newsletter — two live slides, four files gone

**Files:**
- Modify: `newsletter/from-db.js`, `slides.js`, `theme.js`, `render.js`, `shape.js`
- Delete: `newsletter/static/additional-duties.html`, `newsletter/static/rsd-schedule.html`, `newsletter/from-sample.js`, `newsletter/preview-server.js`
- Test: `test/newsletter-http.test.js`

**Interfaces:**
- Consumes: `duties.list`, `drillCal.listAll/buildYear/isoDate` (Tasks 2–3).
- Produces: `data.duties`, `data.calendar`; `S.additionalDuties(d)`, `S.rsdSchedule(d)`.

`meets-radr.html` **stays** a hand-edited partial: `calendar_events` feeds the app only this round (spec §14).

- [ ] **Step 1: Extend the newsletter test**

In `test/newsletter-http.test.js`, at the end of `seed()` (after the `uta_cycles` insert), add:

```js
  await pool.query(`
    INSERT INTO additional_duties (duty, primary_owner, alternate_owner) VALUES
      ('Lodging Monitor', 'Glikin', 'King'),
      ('Records Management / FARM', NULL, NULL)`);
  await pool.query(`
    INSERT INTO drill_dates (start_date, end_date, note) VALUES
      (DATE '2026-06-05', DATE '2026-06-07', NULL),
      (DATE '2026-08-08', DATE '2026-08-09', NULL),
      (DATE '2026-09-11', DATE '2026-09-13', NULL)`);
```

Add this test after "leadership gets the full deck":

```js
test('the duties and RSD slides render from the tables, relative to the cycle being printed', async () => {
  await seed();
  const html = await (await get(await login('leadtest'))).text();
  assert.match(html, /Additional Duties List/);
  assert.match(html, /<td>Lodging Monitor<\/td><td>Glikin<\/td><td>King<\/td>/);
  assert.match(html, /<tr class="red"><td>Records Management \/ FARM<\/td><td>—<\/td><td>—<\/td>/,
    'a duty with no primary owner prints red');
  assert.match(html, /RSD Schedule — CY 2026/);
  assert.match(html, /<s>5–7 Jun 2026 \(3-Day Drill\)<\/s>/, 'a drill that ended before this cycle is struck through');
  assert.match(html, /<b>8–9 Aug 2026<\/b>/, "this cycle's own drill is bold");
  assert.match(html, /<li>11–13 Sep 2026 \(3-Day Drill\)<\/li>/, 'a later drill is plain');
  assert.match(html, /NO UTA JULY 2026/);
  assert.strictEqual((html.match(/<section class="slide/g) || []).length, 23);
  assert.ok(!/(?:src|href)="(?!data:)/.test(html), 'still self-contained');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test test/newsletter-http.test.js`
Expected: FAIL on the new test — the static partial renders instead, so `Lodging Monitor` is absent.

- [ ] **Step 3: `newsletter/from-db.js`**

Replace the header (lines 1–4) with:

```js
// newsletter/from-db.js
// Builds the normalized newsletter `data` object from the live Postgres database for the
// current UTA cycle, delegating the task-shaped slides to shape.js. This is the only data
// source: the offline sample path was retired on 2026-08-17 with generate-sample-template.js.
```

Add after the `informationalSql` require:

```js
const duties = require('../lib/duties');
const drillCal = require('../lib/drill-calendar');
```

After the `counts` query, before the `return`, add:

```js
  // Reference tables. The RSD slide is relative to the cycle being printed, not
  // to today: drills that ended before this UTA are struck through and this
  // UTA's own drill is the bold one, which is how the hand-edited partial was
  // kept. calendar_events is deliberately not read here — the MEETs/RADR slide
  // stays hand-edited for now (spec §14).
  const dutyRows = await duties.list(pool);
  const drillRows = await drillCal.listAll(pool);
  const reference = cycle.start_date ? drillCal.isoDate(cycle.start_date) : drillCal.isoDate(new Date());
  const calendar = drillCal.buildYear(drillRows, Number(reference.slice(0, 4)), reference);
```

Add two fields to the returned object, after `upgrade:`:

```js
    duties: dutyRows,
    calendar,
```

- [ ] **Step 4: `newsletter/slides.js`**

Insert before `// Wrap an editable static partial's body in standard slide chrome.`:

```js
// ── 9. Additional Duties ──────────────────────────────────────────────────
// Two side-by-side tables, split in half, so ~50 rows fit one printed page —
// the layout the hand-edited partial used. A duty with no primary owner prints
// red: that is what "needs owner" looks like on paper.
function additionalDuties(d) {
  const rows = d.duties || [];
  const half = Math.ceil(rows.length / 2);
  const cell = (v) => esc(v || '—');
  const table = (list) => `<table class="duties-table"><thead><tr><th>Additional Duty</th><th>Primary</th><th>Alternate</th></tr></thead><tbody>${
    list.map(r => `<tr${r.primary_owner ? '' : ' class="red"'}><td>${esc(r.duty)}</td><td>${cell(r.primary_owner)}</td><td>${cell(r.alternate_owner)}</td></tr>`).join('')
  }</tbody></table>`;
  const body = rows.length
    ? `<div class="duties-cols">${table(rows.slice(0, half))}${table(rows.slice(half))}</div>`
    : emptyNote('additional duties');
  return chrome('Squadron', 'Additional Duties List', body, '', `${rows.length} duties`);
}

// ── 23. RSD Schedule ──────────────────────────────────────────────────────
// The calendar year as lib/drill-calendar.js derives it, relative to the cycle
// being printed: past drills struck through, this UTA bold, gaps spelled out.
function rsdSchedule(d) {
  const cal = d.calendar || { year: new Date().getUTCFullYear(), entries: [] };
  const line = (e) => {
    if (e.kind === 'no_uta') return `<li>NO UTA ${esc(e.label.toUpperCase())} ${cal.year}</li>`;
    const text = `${esc(e.label)} ${cal.year}${e.threeDay ? ' (3-Day Drill)' : ''}${e.note ? ` (${esc(e.note)})` : ''}`;
    return `<li>${e.past ? `<s>${text}</s>` : e.next ? `<b>${text}</b>` : text}</li>`;
  };
  const body = cal.entries.length
    ? `<p class="intro">Completed drills are struck through; this UTA is in bold.</p><ul class="rsd-list">${cal.entries.map(line).join('')}</ul>`
    : emptyNote('drill dates');
  return chrome('Calendar', `RSD Schedule — CY ${cal.year}`, body);
}
```

Add `additionalDuties, rsdSchedule,` to `module.exports`, after `inbound, upgrade,`.

- [ ] **Step 5: `newsletter/theme.js`**

Immediately above the `@media` block near the end (the one containing `.two-col,.ug-cols,.med-grid,.tl-wrap{flex-direction:column`), insert:

```css
/* Additional duties: two half-tables side by side at 8.5px, as the old partial */
.duties-cols{display:flex;gap:14px;align-items:flex-start;}
.duties-table{flex:1;width:100%;border-collapse:collapse;font-size:8.5px;}
.duties-table th{text-align:left;padding:4px 7px;font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--t2);border-bottom:1px solid var(--border);}
.duties-table td{padding:3px 7px;border-bottom:1px solid var(--border);vertical-align:top;}
.duties-table tr.red td{color:var(--urgent);}
/* RSD schedule */
.rsd-list{list-style:none;padding:0;margin:0;font-size:15px;line-height:1.9;}
.rsd-list s{color:var(--t3-nav);}
```

Inside that `@media` block, extend `.data-table,.static-body table{display:block;overflow-x:auto;}` to `.data-table,.static-body table,.duties-table{display:block;overflow-x:auto;}`, and add `.duties-cols` to the `flex-direction:column` selector list.

- [ ] **Step 6: `newsletter/render.js` and `shape.js`**

In `render.js`: delete the `additional:` and `rsd:` entries from `STATIC_SLIDES`; change slide 9 to `() => S.additionalDuties(data),              //  9  Additional Duties` and slide 23 to `() => S.rsdSchedule(data),                   // 23  RSD Schedule`; and change the header comment's last sentence to `Live sections are built from Postgres; six remaining partials in static/ are editable by hand, because the tracker has no field for them yet.`

In `shape.js`, replace lines 1–2 with:

```js
// newsletter/shape.js — pure task-shaping for from-db.js: turns task rows into the
// per-slide structures render.js consumes. Kept free of SQL so it can be unit-tested.
```

- [ ] **Step 7: Delete the four files**

```bash
git rm newsletter/static/additional-duties.html newsletter/static/rsd-schedule.html newsletter/from-sample.js newsletter/preview-server.js
```

Confirm nothing still references them:

```bash
grep -rn "from-sample\|preview-server\|additional-duties.html\|rsd-schedule.html" --include=*.js --include=*.json --include=*.md . --exclude-dir=node_modules --exclude-dir=.claude
```
Expected: only `MEMORY.md` (fixed in Task 11) and the spec.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test test/newsletter-http.test.js`
Expected: `# pass 6`, `# fail 0`

Then open **Generate Newsletter** from the preview (leadership → Tools) and check in print preview that slide 9 fits one landscape page and slide 23 reads like the old partial.

- [ ] **Step 9: Commit**

```bash
git add -A newsletter test/newsletter-http.test.js
git commit -m "Newsletter: the duties and RSD slides read the tables

Slides 9 and 23 were the last two hand-edited partials with a field in the
tracker. They now render from additional_duties and drill_dates; the RSD
slide is relative to the cycle being printed, so earlier drills are struck
through and this UTA is bold, exactly as the partial was kept by hand.
MEETs/RADR stays hand-edited — calendar_events feeds the app only.

from-sample.js and preview-server.js required generate-sample-template.js,
deleted on 2026-08-17, and have not run since. Gone with the partials.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Docs, the full suite, and the PR

**Files:**
- Modify: `MEMORY.md` §5 and §12
- Verify: whole suite, deploy probes

- [ ] **Step 1: MEMORY.md §5 — add after the rollout-feedback bullets**

```markdown
- **Resources restructure + reference data (2026-08-23):** the tab strip became five subject-shaped tabs — **Calculators · Forms · Links · People · Calendar** — and two more newsletter partials became tables.
  - **Calculators:** PT and Promotion now share one tab behind a `.seg-toggle` (`setCalcView`). Their panes keep their ids and only swapped `.res-pane` for `.calc-view`, so no calculator code changed. This freed the slot Calendar took.
  - **People** (the renamed Org Chart tab): chain of command | **additional duties** (`additional_duties`), a filterable divider list; a blank primary owner renders a **Needs owner** chip. `GET /api/duties` (any member), `POST/PATCH/DELETE` (roster admins). Logic `lib/duties.js`, UI `public/duties.js`.
  - **Calendar:** the year as one chronological stream — twelve month groups, drill weekends (`drill_dates`) and TDY/training rotations (`calendar_events`) interleaved, `No UTA` on months without a drill, past struck through, next chipped, year picker once a second year has rows. **One read endpoint,** `GET /api/calendar?year=`, returns the year already derived; writes are `/api/drill-dates` and `/api/calendar-events` (roster admins). Drills refuse to overlap each other and cap at seven days; events do neither, because rotations overlap and a DFT runs a fortnight. Logic `lib/drill-calendar.js` (pure derivation, shared with the newsletter) and `lib/calendar-events.js`, UI `public/calendar.js`.
  - **Seed-on-create:** each table is loaded from `data/additional-duties.js` / `data/drill-dates.js` / `data/calendar-events.js` only in the boot that creates it (`ensureTable`), so production got 52 duties, ten drills and ten rotations on first deploy and deleted rows never return. `schema.sql` carries the CREATEs empty.
  - Newsletter slides 9 (Additional Duties) and 23 (RSD Schedule) render from the tables, relative to the cycle being printed. **MEETs/RADR (11) stays hand-edited** even though `calendar_events` models it — retiring it is a follow-on. `newsletter/from-sample.js` and `preview-server.js` were removed (dead since 2026-08-17).
  - Design constraints this work had to honour, all from `.impeccable/` and `design.css`: `--t3` is strokes/icons only (use `--t3-nav-text`), status chips use the measured `--ok-bg`/`--ok` style pairs, no side-stripe accents, 44px targets, toggles are `role="group"` + `aria-pressed`.
```

- [ ] **Step 2: MEMORY.md §12 — add after the `lib/presence.js` entry**

```markdown
- `lib/duties.js`, `lib/calendar-events.js`, `lib/drill-calendar.js` — the Resources reference data: DDL + seed-on-create (`ensureTable`), validation, CRUD. `drill-calendar.js`'s pure half (`buildYear` for the newsletter's flat drill list, `buildCalendar` for the app's month groups, plus `label`, `years`, `validateDrill`, `overlaps`) is unit-tested without a database.
- `public/duties.js`, `public/calendar.js` — the two Resources data views; one global each (`dutiesInit`, `calendarInit`), initialised lazily from `switchResPane`/`setPeopleView`.
- `data/additional-duties.js`, `data/drill-dates.js`, `data/calendar-events.js` — the initial rows, used only by seed-on-create and the tests.
```

Then run `grep -n "from-sample\|preview-server\|Org Chart\|Useful Links" MEMORY.md` and fix every stale mention: the Resources tab list should read **Calculators · Forms · Links · People · Calendar**.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: `# fail 0`, **398 tests**. Derivation, measured rather than assumed: the branch
baseline on `origin/master` at `e13f411` is **351** (the handoff doc's "346" predates
`test/back-destinations.test.js`, added by PR #81). This branch adds 23 drill-calendar,
7 duties-http, 8 drill-dates-http, 8 calendar-events-http and 1 newsletter = 47.
Counted per file, not inferred — `grep -c '^test(' test/<file>` on each. Two of those
counts moved after this figure was first written: Task 6's review added a direct
`validate` guard test (calendar-events 7 → 8), and Task 10 added the live-slides test
(newsletter 5 → 6). The mid-branch full run measured 397 before Task 10, and 397 + 1
is 398, so the two derivations agree. Note `npm test` prints `ℹ pass 398`, not
`# pass 398` — a grep for `# pass` against a full-suite log finds nothing.
A full run took ~13 minutes against the remote test Postgres — CI is faster.
Do not pipe through `tail`.

- [ ] **Step 4: Commit, push, open the PR**

```bash
git add MEMORY.md
git commit -m "docs: record the Resources restructure and its three tables

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin claude/resources-duties-calendar
gh pr create --title "Resources: a five-tab restructure, the duties list, and a calendar" --body "$(cat <<'EOF'
Three newsletter partials' worth of reference data becomes tables the app reads, roster admins edit, and (for two of them) the deck renders from — and the Resources tab is re-cut to hold them without growing.

- **Calculators** — PT and Promotion share one tab behind a toggle. No calculator code changed; their panes kept their ids. This freed the slot Calendar took, and the strip went from 48 characters of label to 35.
- **People** (was Org Chart) — chain of command, plus the filterable **additional duties** list. A duty with no primary owner shows **Needs owner**.
- **Calendar** (new) — the year as one stream: drill weekends and TDY/training rotations interleaved by month, `No UTA` on the empty months, past struck through, next chipped.
- **Links** (was Useful Links) — unchanged but for the name.
- Three tables seeded from `data/` **only in the boot that creates them**, so production and staging load 52 duties, ten drills and ten rotations on deploy, and deleted rows never return.
- Newsletter slides 9 and 23 now read the tables. MEETs/RADR stays hand-edited. The dead sample path (`from-sample.js`, `preview-server.js`) is removed.

An `/impeccable shape` pass before implementation caught four choices in the first draft that would each have regressed a documented standard — a side-stripe accent, `--t3` as text, invented chip pairings, and 36px targets. See the spec's Appendix A.

Spec: `docs/superpowers/specs/2026-08-22-resources-duties-and-drill-calendar-design.md`
Plan: `docs/superpowers/plans/2026-08-23-resources-duties-and-drill-calendar.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: After merge — verify the deploy**

Once CI is green and Railway has deployed `master`:

```
https://108ces.up.railway.app/                 -> 200, text/html
https://108ces.up.railway.app/api/auth/me      -> 401
```

Check the Railway deploy log for the three `Created … and seeded … rows` lines — they appear exactly once, on this deploy, and never again. Then on a phone as a plain member: five tabs, People → Additional duties shows 52 rows, Calendar shows the year with September marked **Next**. As a roster admin: Add and pencil controls in both. Generate the newsletter and confirm slides 9 and 23.
