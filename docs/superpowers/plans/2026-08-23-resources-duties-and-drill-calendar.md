# Resources: Additional Duties + Drill Calendar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn two hand-edited newsletter partials — the Additional Duties list and the calendar-year drill schedule — into tables that every member reads in Resources, roster admins edit in the browser, and the newsletter renders from.

**Architecture:** Two new Postgres tables with twinned migrations (`schema.sql` + the `server.js` boot block) and seed-on-create from two `data/` files; two small `lib/` modules (`duties.js` for CRUD + validation, `drill-calendar.js` for the pure year derivation, validation and CRUD); eight thin routes in `server.js` copying the documents-route pattern; two self-contained front-end modules (`public/duties.js`, `public/drill-dates.js`) lazily initialised from `switchResPane`; two newsletter slides that replace static partials. Spec: `docs/superpowers/specs/2026-08-22-resources-duties-and-drill-calendar-design.md`.

**Tech Stack:** Node 24 / Express / `pg` / Postgres; vanilla JS single-page app (`public/index.html`); `node:test` + `node:assert` with a throwaway Postgres (`.env.test` → `TEST_DATABASE_URL`); no build step.

## Global Constraints

- Branch `claude/resources-duties-calendar`, based on `origin/master` at `e13f411`. One PR at the end.
- Every `schema.sql` DDL change has a twin the boot block in `server.js` runs (here: the lib modules' `ensureTable`).
- Write routes use exactly `requireAuth, requireRosterAdmin, requireOnboarded`; reads use `requireAuth` only.
- Errors are `{ error: '<message>' }`. Dates travel as `YYYY-MM-DD` strings both ways (`to_char` out, regex in).
- `DELETE` returns **204**; `POST` returns **201** with the row; duplicates/overlaps return **409**.
- Front-end modules expose exactly one global each (`dutiesInit`, `drillDatesInit`) and take `canEdit` as an argument.
- The newsletter must stay self-contained: no `src`/`href` outside `data:` URIs (enforced by `test/newsletter-http.test.js`).
- The deck stays at 23 slides; Additional Duties is slide 9, RSD Schedule is slide 23.
- Run tests with `node --env-file=.env.test --test <file>` (single file) or `npm test` (all, serialised). Never pipe a test run through `tail` — the exit code becomes `tail`'s.
- Commit after every task. Commit messages: a plain-English title line, a body explaining why, and the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File structure

| File | Responsibility |
|---|---|
| `data/additional-duties.js` (new) | The 52 seed rows, `{ duty, primary, alternate }` |
| `data/drill-dates.js` (new) | The ten CY-2026 seed rows, `{ start, end, note }` |
| `lib/drill-calendar.js` (new) | Pure: `isoDate`, `label`, `years`, `buildYear`, `validateDrill`, `overlaps`. DB: `DDL`, `ensureTable`, `listAll`, `get`, `findOverlap`, `create`, `update`, `remove` |
| `lib/duties.js` (new) | `DDL`, `ensureTable`, `list`, `validate`, `create`, `update`, `remove` |
| `schema.sql` (modify, append) | The two `CREATE TABLE`s for tests/seed.js |
| `server.js` (modify) | `require`s near line 10; `ensureTable` calls at the end of the boot IIFE (~line 303); eight routes after the documents routes (~line 868) |
| `public/duties.js` (new) | People → Additional duties view, filter, admin modal |
| `public/drill-dates.js` (new) | Useful Links → RSD Schedule card, year chips, admin modal |
| `public/index.html` (modify) | Script tags (line 64), CSS (after line 2298), People pane markup (3561–3570), Useful Links card (3478), `switchResPane` + `setPeopleView` (6971), tab label (3020), stale comment (1900) |
| `newsletter/from-db.js` (modify) | `data.duties`, `data.calendar` |
| `newsletter/slides.js` (modify) | `additionalDuties(d)`, `rsdSchedule(d)` |
| `newsletter/theme.js` (modify) | `.duties-cols`, `.duties-table`, `.rsd-list` |
| `newsletter/render.js` (modify) | Swap two `staticSlide` entries for the live ones |
| `newsletter/static/additional-duties.html`, `newsletter/static/rsd-schedule.html`, `newsletter/from-sample.js`, `newsletter/preview-server.js` (delete) | Partials replaced; sample path dead since 2026-08-17 |
| `test/drill-calendar.test.js` (new) | Pure unit tests |
| `test/duties-http.test.js`, `test/drill-dates-http.test.js` (new) | HTTP + seed-on-create |
| `test/newsletter-http.test.js` (modify) | Live-slide assertions |
| `MEMORY.md` (modify) | §5 feature entry, §12 key files |

---

### Task 1: Seed data files

**Files:**
- Create: `data/additional-duties.js`
- Create: `data/drill-dates.js`
- Test: `test/drill-calendar.test.js` (first two tests; the file grows in Task 2)

**Interfaces:**
- Produces: `require('../data/additional-duties')` → `Array<{ duty: string, primary: string|null, alternate: string|null }>` (52 rows). `require('../data/drill-dates')` → `Array<{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', note: string|null }>` (10 rows).

- [ ] **Step 1: Write the failing tests**

Create `test/drill-calendar.test.js`:

```js
// Pure tests: the seed data files and lib/drill-calendar.js need no database.
const { test } = require('node:test');
const assert = require('node:assert');

const DUTIES = require('../data/additional-duties');
const DRILLS = require('../data/drill-dates');

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
  const names = DUTIES.map(d => d.duty.toLowerCase());
  assert.strictEqual(new Set(names).size, 52, 'duty names are unique (case-insensitive)');
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
// the table is edited in the app under Resources → People, and this file is
// only a record of where the data started. A null owner means "needs owner".
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
// entered in the app under Resources → Useful Links. July has no entry on
// purpose — months without a drill are derived, never typed.
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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test test/drill-calendar.test.js`
Expected: `# pass 2`, `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add data/additional-duties.js data/drill-dates.js test/drill-calendar.test.js
git commit -m "Seed data: the Additional Duties list and the CY-2026 drill dates

Transcribed verbatim from the two newsletter partials they will replace,
with the partial's TBD / dash vacancy markers normalised to null so the
app can derive 'needs owner' instead of string-matching. July has no
drill row: months without a UTA are derived, never typed.

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
  - `years(rows) → number[]` ascending, distinct years of `start_date`
  - `buildYear(rows, year, referenceDate) → { year, entries }` where a drill entry is `{ kind:'drill', id, start_date, end_date, note, label, threeDay, past, next }` and a gap is `{ kind:'no_uta', month, label }`
  - `validateDrill({ start_date, end_date, note }) → { ok:true, value } | { ok:false, error }`
  - `overlaps(a, b) → boolean` on `{ start_date, end_date }`
- `rows` may carry `start_date`/`end_date` as strings or `Date`s (pg returns `Date` for `DATE` columns unless `to_char` is used).

- [ ] **Step 1: Append the failing tests**

Append to `test/drill-calendar.test.js`:

```js
const cal = require('../lib/drill-calendar');

const rows2026 = DRILLS.map((d, i) => ({ id: i + 1, start_date: d.start, end_date: d.end, note: d.note }));

test('buildYear: ten drills plus one July gap, in date order, each drill once', () => {
  const { year, entries } = cal.buildYear(rows2026, 2026, '2026-08-22');
  assert.strictEqual(year, 2026);
  assert.strictEqual(entries.length, 11);
  assert.strictEqual(entries.filter(e => e.kind === 'drill').length, 10);
  const gap = entries.find(e => e.kind === 'no_uta');
  assert.deepStrictEqual(gap, { kind: 'no_uta', month: 7, label: 'July' });
  assert.strictEqual(entries.indexOf(gap), 5, 'July sits between June and August');
  assert.deepStrictEqual(entries.map(e => e.label), [
    '31 Jan–1 Feb', '6–8 Mar', '11–12 Apr', '1–3 May', '5–7 Jun', 'July',
    '8–9 Aug', '11–13 Sep', '17–18 Oct', '14–15 Nov', '11–13 Dec',
  ]);
});

test('buildYear: a drill that spans two months covers both, so neither is a gap', () => {
  const { entries } = cal.buildYear(rows2026, 2026, '2026-01-01');
  assert.ok(!entries.some(e => e.kind === 'no_uta' && (e.month === 1 || e.month === 2)));
});

test('buildYear: threeDay flips at three calendar days', () => {
  const { entries } = cal.buildYear(rows2026, 2026, '2026-01-01');
  const by = Object.fromEntries(entries.filter(e => e.kind === 'drill').map(e => [e.label, e.threeDay]));
  assert.strictEqual(by['31 Jan–1 Feb'], false);
  assert.strictEqual(by['8–9 Aug'], false);
  assert.strictEqual(by['6–8 Mar'], true);
  assert.strictEqual(by['11–13 Sep'], true);
});

test('buildYear: past and next are relative to the reference date, and only one entry is next', () => {
  const { entries } = cal.buildYear(rows2026, 2026, '2026-08-22');
  const drills = entries.filter(e => e.kind === 'drill');
  assert.deepStrictEqual(drills.map(d => d.past), [true, true, true, true, true, true, false, false, false, false]);
  assert.strictEqual(drills.filter(d => d.next).length, 1);
  assert.strictEqual(drills.find(d => d.next).label, '11–13 Sep');
});

test('buildYear: a reference date inside a drill makes that drill next, not past', () => {
  const { entries } = cal.buildYear(rows2026, 2026, '2026-09-12');
  const sep = entries.find(e => e.label === '11–13 Sep');
  assert.strictEqual(sep.past, false);
  assert.strictEqual(sep.next, true);
  assert.strictEqual(entries.find(e => e.label === '8–9 Aug').past, true);
});

test('buildYear: a Date reference and Date row columns are accepted (pg returns DATE as Date)', () => {
  const dated = rows2026.map(r => ({ ...r, start_date: new Date(r.start_date + 'T00:00:00Z'), end_date: new Date(r.end_date + 'T00:00:00Z') }));
  const { entries } = cal.buildYear(dated, 2026, new Date('2026-08-22T15:00:00Z'));
  assert.strictEqual(entries.find(e => e.next).label, '11–13 Sep');
  assert.strictEqual(entries.find(e => e.next).start_date, '2026-09-11');
});

test('buildYear: rows from other years are ignored; an empty year has no drills', () => {
  const mixed = [...rows2026, { id: 99, start_date: '2027-01-09', end_date: '2027-01-10', note: null }];
  assert.strictEqual(cal.buildYear(mixed, 2026, '2026-01-01').entries.filter(e => e.kind === 'drill').length, 10);
  assert.strictEqual(cal.buildYear(mixed, 2027, '2026-01-01').entries.filter(e => e.kind === 'drill').length, 1);
  assert.strictEqual(cal.buildYear([], 2026, '2026-01-01').entries.filter(e => e.kind === 'drill').length, 0);
});

test('label: same month, across months, single day', () => {
  assert.strictEqual(cal.label('2026-09-11', '2026-09-13'), '11–13 Sep');
  assert.strictEqual(cal.label('2026-01-31', '2026-02-01'), '31 Jan–1 Feb');
  assert.strictEqual(cal.label('2026-08-08', '2026-08-08'), '8 Aug');
});

test('years: distinct, ascending', () => {
  assert.deepStrictEqual(cal.years([
    { start_date: '2027-01-09' }, { start_date: '2026-03-06' }, { start_date: new Date('2026-09-11T00:00:00Z') },
  ]), [2026, 2027]);
  assert.deepStrictEqual(cal.years([]), []);
});

test('validateDrill: accepts a real drill and normalises the note', () => {
  assert.deepStrictEqual(cal.validateDrill({ start_date: '2026-09-11', end_date: '2026-09-13', note: '  ' }),
    { ok: true, value: { start_date: '2026-09-11', end_date: '2026-09-13', note: null } });
  assert.deepStrictEqual(cal.validateDrill({ start_date: '2026-08-08', end_date: '2026-08-08', note: ' one day ' }).value.note, 'one day');
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
// The calendar year's drill dates — derivation, validation and storage.
//
// The pure half (isoDate … overlaps) is shared by GET /api/drill-dates and the
// newsletter's RSD Schedule slide, so there is exactly one implementation of
// "which months have no UTA", "is this a 3-day drill" and "which drill is next".
// Nothing is typed that can be derived: the app stores two dates and a note.
//
// Dates are handled as 'YYYY-MM-DD' strings throughout. ISO date strings compare
// correctly as plain strings, and a string never picks up a timezone the way a
// Date does — the one place a Date is accepted (isoDate) converts it at UTC.

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

// 'YYYY-MM-DD' → Date at UTC midnight, or null when it is not a real calendar date
// ('2026-02-30' parses in JS as 2 March; the round-trip check rejects it).
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

function years(rows) {
  return [...new Set(rows.map(r => Number(isoDate(r.start_date).slice(0, 4))))].sort((x, y) => x - y);
}

function buildYear(rows, year, referenceDate) {
  const y = Number(year);
  const ref = isoDate(referenceDate);
  const drills = rows
    .map(r => ({ id: r.id, start_date: isoDate(r.start_date), end_date: isoDate(r.end_date), note: r.note || null }))
    .filter(r => r.start_date.slice(0, 4) === String(y))
    .sort((a, b) => (a.start_date < b.start_date ? -1 : 1));

  const entries = [];
  let nextSeen = false;
  for (const d of drills) {
    const past = d.end_date < ref;
    const next = !past && !nextSeen;
    if (next) nextSeen = true;
    entries.push({ kind: 'drill', ...d, label: label(d.start_date, d.end_date),
                   threeDay: dayCount(d.start_date, d.end_date) >= 3, past, next, _at: d.start_date });
  }
  for (let m = 1; m <= 12; m++) {
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = isoDate(new Date(Date.UTC(y, m, 0)));   // day 0 of next month = last day of this one
    const covered = drills.some(d => d.start_date <= last && d.end_date >= first);
    if (!covered) entries.push({ kind: 'no_uta', month: m, label: MONTH[m - 1], _at: first });
  }
  entries.sort((a, b) => (a._at < b._at ? -1 : 1));
  for (const e of entries) delete e._at;
  return { year: y, entries };
}

// Request-body validation for POST/PATCH. Returns { ok, value } or { ok, error }.
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
const overlaps = (a, b) => isoDate(a.start_date) <= isoDate(b.end_date) && isoDate(b.start_date) <= isoDate(a.end_date);

module.exports = { isoDate, label, years, buildYear, validateDrill, overlaps };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test test/drill-calendar.test.js`
Expected: `# pass 14`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/drill-calendar.js test/drill-calendar.test.js
git commit -m "Drill calendar: derive the year's schedule from dates alone

buildYear turns a list of drills into the year as the RSD slide shows it:
each drill once, a 'No UTA' entry for every month no drill touches, the
3-day tag from the day count, and past/next relative to a reference date
so the API can use today while the newsletter uses the cycle's start.
Pure functions, tested without a database.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 3: Tables, `lib/duties.js`, the DB half of `lib/drill-calendar.js`, seed-on-create

**Files:**
- Modify: `schema.sql` (append at the end, after `idx_notifications_unpushed`)
- Create: `lib/duties.js`
- Modify: `lib/drill-calendar.js` (append the DB half)
- Modify: `server.js` — `require`s after line 10; `ensureTable` calls before the boot IIFE's `catch` (line ~303)
- Test: `test/duties-http.test.js` (new), `test/drill-dates-http.test.js` (new) — seed-on-create tests only; Tasks 4 and 5 add the route tests

**Interfaces:**
- Consumes: `require('../data/additional-duties')`, `require('../data/drill-dates')` (Task 1); `isoDate`, `overlaps` (Task 2).
- Produces (`lib/duties.js`):
  - `DDL: string`
  - `ensureTable(db, defaults = DEFAULTS) → Promise<{ created: boolean, seeded?: number }>`
  - `list(db) → Promise<Row[]>` where `Row = { id, duty, primary_owner, alternate_owner }` ordered by `lower(duty)`
  - `validate(body, { partial }) → { ok: true, value: { duty?, primary_owner?, alternate_owner? } } | { ok: false, error }`
  - `create(db, value, byId) → Promise<Row>`; throws `err.code === 'DUPLICATE'` with a user-facing `message`
  - `update(db, id, value, byId) → Promise<Row|null>` (null = not found); same `DUPLICATE` throw
  - `remove(db, id) → Promise<boolean>`
- Produces (`lib/drill-calendar.js`, DB half):
  - `DDL: string`
  - `ensureTable(db, defaults = DEFAULTS) → Promise<{ created, seeded? }>`
  - `listAll(db) → Promise<Drill[]>` where `Drill = { id, start_date: 'YYYY-MM-DD', end_date, note }`, ordered by `start_date`
  - `get(db, id) → Promise<Drill|null>`
  - `findOverlap(db, { start_date, end_date }, excludeId) → Promise<Drill|null>`
  - `create(db, value, byId) → Promise<Drill>`; `update(db, id, value, byId) → Promise<Drill|null>`; `remove(db, id) → Promise<boolean>`

- [ ] **Step 1: Write the failing seed-on-create tests**

Create `test/duties-http.test.js`:

```js
// Additional duties: read by every signed-in member, written only by roster
// admins (the Forms gate). Also covers seed-on-create — the table is loaded
// from data/additional-duties.js only in the boot that creates it, so rows an
// admin deletes never come back.
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
// (the twenty-one-versus-two distinction), a supervisor and a member.
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
  const first = await duties.ensureTable(pool, DEFAULTS);
  assert.deepStrictEqual(first, { created: true, seeded: 52 });
  const count = async () => Number((await pool.query('SELECT COUNT(*) FROM additional_duties')).rows[0].count);
  assert.strictEqual(await count(), 52);

  assert.deepStrictEqual(await duties.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 52, 'a second boot adds nothing');

  await pool.query(`DELETE FROM additional_duties WHERE duty = 'ADUTM'`);
  assert.deepStrictEqual(await duties.ensureTable(pool, DEFAULTS), { created: false });
  assert.strictEqual(await count(), 51, 'a deleted row never comes back');
  const { rows } = await pool.query(`SELECT primary_owner, alternate_owner FROM additional_duties WHERE duty = 'Records Management / FARM'`);
  assert.deepStrictEqual(rows[0], { primary_owner: null, alternate_owner: null });
});
```

Create `test/drill-dates-http.test.js` with the same preamble (copy everything above from the first line down to and including the `api` helper, replacing the header comment with the one below and the `duties`/`DEFAULTS` requires with `const cal = require('../lib/drill-calendar'); const DEFAULTS = require('../data/drill-dates');`), then this test:

```js
// Drill dates: the calendar year's RSD schedule. Read by every signed-in member,
// written only by roster admins. Also covers seed-on-create — loaded from
// data/drill-dates.js only in the boot that creates the table.
```

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

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --env-file=.env.test --test test/duties-http.test.js`
Expected: FAIL — `Cannot find module '../lib/duties'`

Run: `node --env-file=.env.test --test test/drill-dates-http.test.js`
Expected: FAIL — `cal.ensureTable is not a function`

- [ ] **Step 3: Append the tables to `schema.sql`**

Append at the very end of `schema.sql`:

```sql
-- ── Resources reference tables ─────────────────────────────────────────────
-- Additional duties ("who do I see about X") and the calendar year's drill
-- dates. Every member reads them, roster admins edit them, the newsletter
-- renders them. These CREATEs are the twins of the DDL in lib/duties.js and
-- lib/drill-calendar.js, which the server.js boot block runs — with one
-- difference: the boot block also seeds the initial rows the first time it
-- creates each table. This copy creates them empty, which is what the tests
-- and seed.js want.
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
// anything in the boot that finds the table absent. A database that already
// has the table — including one where an admin has since deleted rows — is
// left exactly as it is.
async function ensureTable(db, defaults = DEFAULTS) {
  const { rows } = await db.query(`SELECT to_regclass('public.additional_duties') AS t`);
  if (rows[0].t) return { created: false };
  await db.query(DDL);
  for (const d of defaults) {
    await db.query(
      `INSERT INTO additional_duties (duty, primary_owner, alternate_owner) VALUES ($1, $2, $3)`,
      [d.duty, d.primary, d.alternate]);
  }
  return { created: true, seeded: defaults.length };
}

async function list(db) {
  const { rows } = await db.query(`SELECT ${COLS} FROM additional_duties ORDER BY lower(duty)`);
  return rows;
}

const clean = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? undefined : (s || null);
};

// partial=false: a create — duty is required. partial=true: a PATCH — only the
// keys present are validated, and at least one must be.
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
    if (v === undefined) return { ok: false, error: `${k === 'primary_owner' ? 'Primary' : 'Alternate'} must be 200 characters or fewer` };
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

- [ ] **Step 5: Append the DB half to `lib/drill-calendar.js`**

Replace the final `module.exports` line of `lib/drill-calendar.js` with:

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

// to_char so dates leave the database as the same 'YYYY-MM-DD' strings the
// API accepts — a bare DATE column would come back as a Date at UTC midnight.
const COLS = `id, to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD') AS end_date, note`;

// Seed-on-create; see lib/duties.js for the contract.
async function ensureTable(db, defaults = DEFAULTS) {
  const { rows } = await db.query(`SELECT to_regclass('public.drill_dates') AS t`);
  if (rows[0].t) return { created: false };
  await db.query(DDL);
  for (const d of defaults) {
    await db.query(`INSERT INTO drill_dates (start_date, end_date, note) VALUES ($1::date, $2::date, $3)`,
      [d.start, d.end, d.note]);
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

// The drill, if any, that shares a day with the candidate. excludeId lets a
// PATCH ignore the row being edited.
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
  isoDate, label, years, buildYear, validateDrill, overlaps,
  DDL, ensureTable, listAll, get, findOverlap, create, update, remove,
};
```

- [ ] **Step 6: Wire `ensureTable` into the boot block in `server.js`**

After line 10 (`const { acquireMigrationLock } = require('./lib/db');`) add:

```js
const duties = require('./lib/duties');
const drillCal = require('./lib/drill-calendar');
```

In the boot IIFE, immediately before the line `  } catch (e) {` / `console.error('Migration warning:', e.message);` (after the `last_login_at` recovery query, around line 303), add:

```js
    // Resources reference tables (additional duties, drill dates). Each lib
    // creates its table and seeds it from data/ in the one boot that finds it
    // absent; every later boot is a no-op, so rows an admin deletes stay gone.
    // schema.sql carries the twin CREATEs, empty, for the tests and seed.js.
    for (const [name, mod] of [['additional_duties', duties], ['drill_dates', drillCal]]) {
      const r = await mod.ensureTable(pool);
      if (r.created) console.log(`Created ${name} and seeded ${r.seeded} rows`);
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test test/duties-http.test.js`
Expected: `# pass 1`, `# fail 0`

Run: `node --env-file=.env.test --test test/drill-dates-http.test.js`
Expected: `# pass 1`, `# fail 0`

Run: `node --env-file=.env.test --test test/drill-calendar.test.js`
Expected: `# pass 14` (the pure tests still pass with the DB half appended — the module must not open a connection at require time)

- [ ] **Step 8: Commit**

```bash
git add schema.sql lib/duties.js lib/drill-calendar.js server.js test/duties-http.test.js test/drill-dates-http.test.js
git commit -m "Two reference tables, seeded once in the boot that creates them

additional_duties and drill_dates, twinned in schema.sql and the boot
block as every table here is. The boot-side DDL lives in the lib modules
so the same function can seed the initial rows from data/ — but only in
the boot that finds the table absent. Production and staging both lack
the tables, so the first deploy loads the 52 duties and ten drills with
no script to run, and a row an admin later deletes never returns.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `/api/duties` routes

**Files:**
- Modify: `server.js` — insert the routes after the documents `DELETE` route (after line 868, before the `// ── Member task history (Records)` comment)
- Test: `test/duties-http.test.js` (append)

**Interfaces:**
- Consumes: `duties.list/validate/create/update/remove` (Task 3); `requireAuth`, `requireRosterAdmin`, `requireOnboarded`, `reqId` (existing).
- Produces: `GET /api/duties → { duties: Row[] }`; `POST /api/duties → 201 Row`; `PATCH /api/duties/:id → 200 Row`; `DELETE /api/duties/:id → 204`.

- [ ] **Step 1: Append the failing route tests**

Append to `test/duties-http.test.js`:

```js
test('signed out: every duties route is 401', async () => {
  await seed();
  for (const [m, p] of [['GET', '/api/duties'], ['POST', '/api/duties'], ['PATCH', '/api/duties/1'], ['DELETE', '/api/duties/1']]) {
    assert.strictEqual((await api(m, p, null, {})).status, 401, `${m} ${p}`);
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

  let res = await api('POST', '/api/duties', admin, { duty: 'Lodging Monitor', primary_owner: ' Glikin ', alternate_owner: '' });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.deepStrictEqual(created, { id: created.id, duty: 'Lodging Monitor', primary_owner: 'Glikin', alternate_owner: null });

  res = await api('POST', '/api/duties', admin, { duty: 'adutm' });
  assert.strictEqual(res.status, 201);

  res = await api('GET', '/api/duties', await login('memtest'));
  const { duties: listed } = await res.json();
  assert.deepStrictEqual(listed.map(d => d.duty), ['adutm', 'Lodging Monitor'], 'lower(duty) ordering');

  res = await api('PATCH', `/api/duties/${created.id}`, admin, { primary_owner: '' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).primary_owner, null, 'blank clears the owner');
  const { rows: [row] } = await pool.query('SELECT updated_by_id FROM additional_duties WHERE id = $1', [created.id]);
  assert.strictEqual(row.updated_by_id, adminId);

  res = await api('DELETE', `/api/duties/${created.id}`, admin);
  assert.strictEqual(res.status, 204);
  assert.strictEqual((await (await api('GET', '/api/duties', admin)).json()).duties.length, 1);

  assert.strictEqual((await api('PATCH', `/api/duties/${created.id}`, admin, { duty: 'Gone' })).status, 404);
  assert.strictEqual((await api('DELETE', `/api/duties/${created.id}`, admin)).status, 404);
  assert.strictEqual((await api('DELETE', `/api/duties/abc`, admin)).status, 400);
});

test('400s: empty duty, 121-character duty, 201-character owner, PATCH with nothing to update', async () => {
  await seed();
  const admin = await login('admintest');
  const bad = async (m, p, body) => { const r = await api(m, p, admin, body); assert.strictEqual(r.status, 400, JSON.stringify(body)); return (await r.json()).error; };
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
  assert.strictEqual((await api('PATCH', `/api/duties/${id}`, admin, { duty: 'ITEC' })).status, 200, 'renaming to itself is fine');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --env-file=.env.test --test test/duties-http.test.js`
Expected: FAIL — the 401 test passes (the `/api/*` JSON 404 handler answers 404, not 401 — so expect `401 !== 404` failures) and the rest fail with 404s.

- [ ] **Step 3: Add the routes to `server.js`**

Insert after the documents `DELETE` route's closing `});` (line 868), before `// ── Member task history (Records)`:

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
Expected: `# pass 6`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add server.js test/duties-http.test.js
git commit -m "Additional duties API: read by everyone, written by roster admins

Four thin routes over lib/duties.js, gated exactly as the Forms routes
are. A case-insensitive duplicate and a rename onto another duty both
409 through the functional index, so 'ADUTM' and 'Adutm' cannot coexist.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 5: `/api/drill-dates` routes

**Files:**
- Modify: `server.js` — insert directly after the `/api/duties` routes from Task 4
- Test: `test/drill-dates-http.test.js` (append)

**Interfaces:**
- Consumes: `drillCal.listAll/get/findOverlap/create/update/remove/validateDrill/buildYear/years` (Tasks 2–3).
- Produces: `GET /api/drill-dates?year= → { year, years, entries }`; `POST → 201 Drill`; `PATCH /:id → 200 Drill`; `DELETE /:id → 204`.

- [ ] **Step 1: Append the failing route tests**

Append to `test/drill-dates-http.test.js`:

```js
const SEP = { start_date: '2026-09-11', end_date: '2026-09-13', note: null };

test('signed out: every drill-dates route is 401', async () => {
  await seed();
  for (const [m, p] of [['GET', '/api/drill-dates'], ['POST', '/api/drill-dates'], ['PATCH', '/api/drill-dates/1'], ['DELETE', '/api/drill-dates/1']]) {
    assert.strictEqual((await api(m, p, null, {})).status, 401, `${m} ${p}`);
  }
});

test('403 matrix: member, supervisor and leadership-without-the-capability cannot write; all can read', async () => {
  await seed();
  for (const slug of ['memtest', 'suptest', 'leadtest']) {
    const cookie = await login(slug);
    assert.strictEqual((await api('GET', '/api/drill-dates', cookie)).status, 200, `${slug} can read`);
    for (const [m, p] of [['POST', '/api/drill-dates'], ['PATCH', '/api/drill-dates/1'], ['DELETE', '/api/drill-dates/1']]) {
      assert.strictEqual((await api(m, p, cookie, SEP)).status, 403, `${slug} ${m} ${p}`);
    }
  }
});

test('GET: the requested year as entries, every year with rows, and an empty year as entries: []', async () => {
  await seed();
  const admin = await login('admintest');
  for (const d of [SEP, { start_date: '2026-08-08', end_date: '2026-08-09', note: null },
                   { start_date: '2027-01-09', end_date: '2027-01-10', note: 'First of the year' }]) {
    assert.strictEqual((await api('POST', '/api/drill-dates', admin, d)).status, 201);
  }
  const member = await login('memtest');
  let body = await (await api('GET', '/api/drill-dates?year=2026', member)).json();
  assert.strictEqual(body.year, 2026);
  assert.deepStrictEqual(body.years, [2026, 2027]);
  assert.deepStrictEqual(body.entries.filter(e => e.kind === 'drill').map(e => e.label), ['8–9 Aug', '11–13 Sep']);
  assert.strictEqual(body.entries.filter(e => e.kind === 'no_uta').length, 10);

  body = await (await api('GET', '/api/drill-dates?year=2027', member)).json();
  assert.strictEqual(body.entries.find(e => e.kind === 'drill').note, 'First of the year');

  body = await (await api('GET', '/api/drill-dates?year=2031', member)).json();
  assert.deepStrictEqual(body, { year: 2031, years: [2026, 2027], entries: [] });

  for (const bad of ['abc', '99', '1999', '2101']) {
    assert.strictEqual((await api('GET', `/api/drill-dates?year=${bad}`, member)).status, 400, `year=${bad}`);
  }
  const dflt = await (await api('GET', '/api/drill-dates', member)).json();
  assert.strictEqual(dflt.year, new Date().getUTCFullYear(), 'defaults to the current year');
});

test('admin CRUD round-trip with updated_by stamped; 404 on unknown ids', async () => {
  const { adminId } = await seed();
  const admin = await login('admintest');
  let res = await api('POST', '/api/drill-dates', admin, { ...SEP, note: '  3-day  ' });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.deepStrictEqual(created, { id: created.id, start_date: '2026-09-11', end_date: '2026-09-13', note: '3-day' });

  res = await api('PATCH', `/api/drill-dates/${created.id}`, admin, { end_date: '2026-09-12', note: '' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { id: created.id, start_date: '2026-09-11', end_date: '2026-09-12', note: null });
  const { rows: [row] } = await pool.query('SELECT updated_by_id FROM drill_dates WHERE id = $1', [created.id]);
  assert.strictEqual(row.updated_by_id, adminId);

  assert.strictEqual((await api('DELETE', `/api/drill-dates/${created.id}`, admin)).status, 204);
  assert.strictEqual((await api('PATCH', `/api/drill-dates/${created.id}`, admin, { note: 'x' })).status, 404);
  assert.strictEqual((await api('DELETE', `/api/drill-dates/${created.id}`, admin)).status, 404);
  assert.strictEqual((await api('DELETE', `/api/drill-dates/abc`, admin)).status, 400);
});

test('400s: malformed date, end before start, an eight-day span, an 81-character note', async () => {
  await seed();
  const admin = await login('admintest');
  const bad = async (body) => { const r = await api('POST', '/api/drill-dates', admin, body); assert.strictEqual(r.status, 400, JSON.stringify(body)); return (await r.json()).error; };
  assert.match(await bad({ start_date: '9/11/2026', end_date: '2026-09-13' }), /start_date/);
  assert.match(await bad({ start_date: '2026-09-13', end_date: '2026-09-11' }), /before/);
  assert.match(await bad({ start_date: '2026-09-01', end_date: '2026-09-08' }), /seven days/);
  assert.match(await bad({ ...SEP, note: 'x'.repeat(81) }), /80/);
});

test('409: overlapping another drill, on create and on edit; a PATCH never conflicts with itself', async () => {
  await seed();
  const admin = await login('admintest');
  const { id } = await (await api('POST', '/api/drill-dates', admin, SEP)).json();
  const { id: oct } = await (await api('POST', '/api/drill-dates', admin, { start_date: '2026-10-17', end_date: '2026-10-18', note: null })).json();

  const dup = await api('POST', '/api/drill-dates', admin, { start_date: '2026-09-13', end_date: '2026-09-14', note: null });
  assert.strictEqual(dup.status, 409);
  assert.match((await dup.json()).error, /overlap/i);
  assert.strictEqual((await api('POST', '/api/drill-dates', admin, { start_date: '2026-09-14', end_date: '2026-09-15', note: null })).status, 201, 'adjacent is fine');

  assert.strictEqual((await api('PATCH', `/api/drill-dates/${oct}`, admin, { start_date: '2026-09-12' })).status, 409, 'editing onto another drill');
  assert.strictEqual((await api('PATCH', `/api/drill-dates/${id}`, admin, { end_date: '2026-09-12' })).status, 200, 'shrinking within itself');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --env-file=.env.test --test test/drill-dates-http.test.js`
Expected: FAIL — route tests answer 404 from the `/api/*` handler

- [ ] **Step 3: Add the routes to `server.js`**

Insert directly after the `/api/duties` DELETE route:

```js
// ── Drill dates (Resources → Useful Links) ───────────────────────────────────
// The calendar year's RSD schedule. The year derivation (gaps, 3-day tag,
// past/next) is lib/drill-calendar.js, shared with the newsletter slide.
app.get('/api/drill-dates', requireAuth, async (req, res) => {
  let year = new Date().getUTCFullYear();
  if (req.query.year !== undefined) {
    const y = String(req.query.year);
    if (!/^\d{4}$/.test(y) || Number(y) < 2000 || Number(y) > 2100) {
      return res.status(400).json({ error: 'year must be a four-digit year between 2000 and 2100' });
    }
    year = Number(y);
  }
  try {
    const rows = await drillCal.listAll(pool);
    // A year with no drills answers entries: [] — twelve "No UTA" lines would
    // read as a schedule nobody entered.
    const hasRows = rows.some(r => r.start_date.slice(0, 4) === String(year));
    const entries = hasRows ? drillCal.buildYear(rows, year, new Date()).entries : [];
    res.json({ year, years: drillCal.years(rows), entries });
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
    if (clash) return res.status(409).json({ error: `Those dates overlap the ${drillCal.label(clash.start_date, clash.end_date)} drill` });
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
    // Validate the merged row, so a one-field PATCH is checked against the
    // dates it will actually have.
    const body = req.body || {};
    const v = drillCal.validateDrill({
      start_date: 'start_date' in body ? body.start_date : existing.start_date,
      end_date:   'end_date'   in body ? body.end_date   : existing.end_date,
      note:       'note'       in body ? body.note       : existing.note,
    });
    if (!v.ok) return res.status(400).json({ error: v.error });
    const clash = await drillCal.findOverlap(pool, v.value, id);
    if (clash) return res.status(409).json({ error: `Those dates overlap the ${drillCal.label(clash.start_date, clash.end_date)} drill` });
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
Expected: `# pass 7`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add server.js test/drill-dates-http.test.js
git commit -m "Drill dates API: the year as the RSD slide reads it

GET returns the requested year already derived — gaps, 3-day tags,
past/next against today — plus every year that has rows, so the card
can offer next year the moment it is entered. Writes validate the
merged row and refuse any overlap with another drill, naming it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: People pane — Additional duties view (`public/duties.js`)

**Files:**
- Create: `public/duties.js`
- Modify: `public/index.html` — script tag after line 64; CSS after the `.drill-scope-note` rule (line 2298); tab label (line 3020); People pane markup (lines 3561–3570); `switchResPane` comment + `setPeopleView` (line 6971); stale comment (line 1900)

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /api/duties` (Task 4); page globals `openModal(id)`, `closeModal(id)`, `showToast(msg, type)`, `uiConfirm(opts)`, `currentMember`.
- Produces: `window.dutiesInit({ canEdit })` — idempotent; first call renders the shell and fetches, later calls re-render with the new `canEdit`. `setPeopleView('chain'|'duties')` in `index.html`.

No automated harness exists for `public/` (nothing but the pure modules is unit-tested), so this task's verification is the browser. Start the preview with `preview-run.cjs` (`.claude/launch.json`, name `preview`, port 3100) — it runs against the staging database with cron off.

- [ ] **Step 1: Create `public/duties.js`**

```js
// public/duties.js — Resources → People → Additional duties.
//
// One global, dutiesInit({ canEdit }), called from setPeopleView() the first
// time the member flips the toggle. Everyone gets the list and the filter;
// roster admins (canEdit) also get Add and a pencil per row. The API enforces
// the same rule — the flag here only keeps controls out of everyone else's way.
//
// Uses the page's openModal/closeModal (focus trap, role=dialog), showToast
// (which stays quiet offline) and uiConfirm. The modal is injected once.
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
      ${canEdit ? '<div class="duty-admin"><button class="add-btn" id="duty-add">+ Add duty</button></div>' : ''}
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
      $('duty-list').innerHTML = '<div class="tl-empty">Could not load the duties list. It needs a connection.</div>';
      $('duty-count').textContent = '';
    }
  }

  function renderList() {
    const q = ($('duty-q').value || '').trim().toLowerCase();
    const rows = q
      ? all.filter(d => [d.duty, d.primary_owner, d.alternate_owner].some(v => (v || '').toLowerCase().includes(q)))
      : all;
    $('duty-count').textContent = q ? `${rows.length} of ${all.length} match` : `${all.length} duties`;
    if (!all.length) {
      $('duty-list').innerHTML = `<div class="tl-empty">${canEdit ? 'No duties yet — add the first one above.' : 'No duties have been posted yet.'}</div>`;
      return;
    }
    if (!rows.length) { $('duty-list').innerHTML = '<div class="tl-empty">Nothing matches.</div>'; return; }
    $('duty-list').innerHTML = rows.map(d => `
      <div class="duty-row${d.primary_owner ? '' : ' needs-owner'}">
        <div class="duty-body">
          <div class="duty-name">${esc(d.duty)}${d.primary_owner ? '' : ' <span class="duty-tag">Needs owner</span>'}</div>
          <div class="duty-owners"><span class="duty-k">Primary</span> — ${esc(d.primary_owner || '—')}</div>
          <div class="duty-owners"><span class="duty-k">Alternate</span> — ${esc(d.alternate_owner || '—')}</div>
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
      toast(e.message || 'Could not save', 'error');   // 400/409: modal stays open
      if (/no longer exists/.test(e.message || '')) { closeModal('duty-modal'); await load(); }
    }
    btn.disabled = false;
  }

  async function remove() {
    const d = all.find(x => x.id === editingId);
    if (!d) return;
    if (!await uiConfirm({ title: `Delete "${d.duty}"?`, message: 'It disappears from the list and the newsletter.', confirmLabel: 'Delete', danger: true })) return;
    try {
      const res = await fetch(`/api/duties/${editingId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error((await res.json().catch(() => ({}))).error || 'Could not delete');
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

- [ ] **Step 2: Load the script and add the CSS in `index.html`**

After line 64 (`<script src="/offline.js" defer></script>`) add:

```html
  <script src="/duties.js" defer></script>
```

After the `.drill-scope-note { … }` rule (line 2298), add:

```css
    /* ── People → Additional duties (public/duties.js) ───────────────────── */
    .people-toggle { margin-bottom: 14px; }
    .duties-search.search-wrap { padding: 4px 0 10px; border-bottom: 0; }
    .duty-admin { margin-bottom: 10px; }
    .duty-list { display: flex; flex-direction: column; gap: 8px; }
    .duty-row {
      display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px;
      background: var(--bg); border: 2px solid var(--border); border-radius: var(--rs);
    }
    .duty-row.needs-owner { background: var(--wrn-bg); border-color: var(--warn); }
    .duty-body { flex: 1; min-width: 0; }
    .duty-name { font-weight: 600; font-size: 14px; }
    .duty-owners { font-size: 12.5px; color: var(--t2); margin-top: 3px; overflow-wrap: anywhere; }
    .duty-k { color: var(--t3); font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; }
    .duty-tag {
      display: inline-block; margin-left: 6px; padding: 2px 7px; border-radius: 6px;
      background: var(--warn); color: var(--bg); font-size: 10.5px; font-weight: 700; vertical-align: middle;
    }
    .duty-edit {
      border: 0; background: none; color: var(--t2); cursor: pointer; padding: 8px;
      min-width: 44px; min-height: 44px; border-radius: 8px; flex: none;
    }
    .duty-edit:hover { color: var(--text); background: var(--s2); }
    .duty-edit svg { width: 16px; height: 16px; }
```

- [ ] **Step 3: Rename the tab, add the toggle, and fix the stale comment**

Line 3020 — change the label only:

```html
        <button class="res-tab" data-rt="orgchart" onclick="switchResPane('orgchart')">People</button>
```

Replace the pane (lines 3561–3570) with:

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

Line 1900–1901 comment — replace the two comment lines with:

```js
    /* Five tabs share the resources tab bar — give the labels a little
       more room on narrow phones so "PT Calculator" doesn't wrap. */
```

- [ ] **Step 4: Wire `setPeopleView` next to `switchResPane`**

Replace the comment on line 6970 and add the function after `switchResPane`:

```js
/* ── Resources sub-tabs (PT Calculator | Promotion | Forms | Useful Links | People) ── */
```

```js
/* ── Resources → People: chain of command | additional duties ── */
function setPeopleView(mode) {
  const duties = mode === 'duties';
  document.getElementById('people-vt-chain').classList.toggle('active', !duties);
  document.getElementById('people-vt-chain').setAttribute('aria-pressed', String(!duties));
  document.getElementById('people-vt-duties').classList.toggle('active', duties);
  document.getElementById('people-vt-duties').setAttribute('aria-pressed', String(duties));
  document.getElementById('sq-orgchart').hidden = duties;
  document.getElementById('duties-view').hidden = !duties;
  if (duties && window.dutiesInit) window.dutiesInit({ canEdit: !!currentMember?.can_manage_roster });
}
```

- [ ] **Step 5: Verify in the browser**

Start the preview (`preview-run.cjs` → http://localhost:3100). Sign in as `gablin` / `preview123` (a roster admin on staging), open Resources → **People**:

- The toggle shows; **Chain of command** is the default and the org chart is unchanged.
- **Additional duties** shows the 52 seeded rows alphabetically, "52 duties", the **Records Management / FARM** row in the warn style with **Needs owner**.
- Typing `dts` in the filter leaves the three DTS rows and the count reads "3 of 52 match"; typing `gablin` finds his duties.
- **+ Add duty** opens the modal; saving a blank name shows the "required" toast with the modal still open; saving `ADUTM` shows the 409 toast; saving a real duty adds it and re-sorts.
- The pencil opens the row pre-filled; **Delete duty** asks for confirmation, then removes it.
- Sign in as `becerra` / `becerra` (plain member): the list and filter appear, no Add button, no pencils.
- Dark mode (theme toggle) and 375px width (DevTools device mode): the five tab labels fit on one line; rows wrap cleanly.
- Resources → any other tab → back to People: the duties toggle state resets to Chain of command (not persisted, by design).

Then undo the test rows you added on staging (delete them through the UI).

- [ ] **Step 6: Commit**

```bash
git add public/duties.js public/index.html
git commit -m "People tab: the additional-duties list, with a filter and admin editing

The Org Chart tab becomes People and gains a two-way toggle: the chain
of command (who is above me) and the additional duties (who do I see
about X). Everyone can filter by duty or name; the two roster admins add,
edit and delete through a modal. A duty with no primary owner wears the
warn style and a Needs owner tag, so a vacancy is visible without anyone
typing TBD. Lives in public/duties.js so index.html does not grow.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 7: Useful Links — RSD Schedule card (`public/drill-dates.js`)

**Files:**
- Create: `public/drill-dates.js`
- Modify: `public/index.html` — script tag after the `duties.js` tag; CSS after the `.duty-edit svg` rule; card markup at the top of `#res-pane-links` (line 3478); `switchResPane` (line 6971)

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /api/drill-dates` (Task 5); page globals `openModal`, `closeModal`, `showToast`, `uiConfirm`, `currentMember`.
- Produces: `window.drillDatesInit({ canEdit })` — idempotent, same contract as `dutiesInit`.

- [ ] **Step 1: Create `public/drill-dates.js`**

```js
// public/drill-dates.js — Resources → Useful Links → RSD Schedule.
//
// One global, drillDatesInit({ canEdit }), called from switchResPane('links').
// The API returns the year already derived (lib/drill-calendar.js): each drill
// with its label, 3-day tag and past/next flags, plus a 'No UTA' entry for
// every month without one. This file only renders. Roster admins (canEdit)
// get Add and a pencil per drill; the API enforces the same rule.
(function () {
  let data = null;          // { year, years, entries }
  let canEdit = false;
  let shellReady = false;
  let editingId = null;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast = (msg, type) => (typeof showToast === 'function' ? showToast : uiToast)(msg, type);
  const $ = (id) => document.getElementById(id);

  const PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5l2 2L5 13H3v-2z"/><path d="M10 4l2 2"/></svg>';

  function shell() {
    const host = $('drill-card');
    host.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    host.addEventListener('click', (e) => {
      const year = e.target.closest('.drill-year');
      if (year) { load(Number(year.dataset.year)); return; }
      if (e.target.closest('#drill-add')) { openEditor(null); return; }
      const edit = e.target.closest('.drill-edit');
      if (edit) openEditor(Number(edit.dataset.id));
    });
    shellReady = true;
  }

  async function load(year) {
    try {
      const res = await fetch('/api/drill-dates' + (year ? `?year=${year}` : ''));
      if (!res.ok) throw new Error('request failed');
      data = await res.json();
      render();
    } catch (e) {
      console.error('drill-dates', e);
      $('drill-card').innerHTML = '<div class="tl-empty">Could not load the drill schedule. It needs a connection.</div>';
    }
  }

  function row(e) {
    if (e.kind === 'no_uta') {
      return `<div class="drill-row no-uta"><span class="drill-label">No UTA</span><span class="drill-note">${esc(e.label)}</span></div>`;
    }
    return `<div class="drill-row${e.past ? ' past' : ''}${e.next ? ' next' : ''}">
      <span class="drill-label">${esc(e.label)}${e.threeDay ? ' <span class="drill-meta">· 3-day</span>' : ''}</span>
      ${e.note ? `<span class="drill-note">${esc(e.note)}</span>` : ''}
      ${e.next ? '<span class="drill-tag">Next</span>' : ''}
      ${canEdit ? `<button class="drill-edit" type="button" aria-label="Edit the ${esc(e.label)} drill" data-id="${e.id}">${PENCIL}</button>` : ''}
    </div>`;
  }

  function render() {
    $('drill-sub').textContent = `CY ${data.year}`;
    // Chips only when there is more than one year to choose from — the
    // displayed year plus every year that has rows.
    const years = [...new Set([data.year, ...data.years])].sort((a, b) => a - b);
    const chips = years.length > 1
      ? `<div class="drill-years" role="group" aria-label="Year">${years.map(y =>
          `<button class="drill-year${y === data.year ? ' active' : ''}" type="button" data-year="${y}" aria-pressed="${y === data.year}">${y}</button>`).join('')}</div>`
      : '';
    const admin = canEdit ? '<div class="drill-admin"><button class="add-btn" id="drill-add" type="button">+ Add drill</button></div>' : '';
    const list = data.entries.length
      ? `<div class="drill-list">${data.entries.map(row).join('')}</div>`
      : `<div class="tl-empty">No drill dates entered for ${data.year}.</div>`;
    $('drill-card').innerHTML = chips + admin + list;
  }

  // ── Editor modal (admins only) ──────────────────────────────────────────
  function ensureModal() {
    if ($('drill-modal')) return;
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = 'drill-modal';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-hdr">
          <h2 class="modal-title" id="drill-modal-title">Add drill</h2>
          <button class="modal-close" type="button" aria-label="Close" id="drill-close">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <div class="field-row">
          <div class="modal-field"><label for="drill-f-start">Start</label><input id="drill-f-start" type="date"></div>
          <div class="modal-field"><label for="drill-f-end">End</label><input id="drill-f-end" type="date"></div>
        </div>
        <div class="modal-field"><label for="drill-f-note">Note (optional)</label>
          <input id="drill-f-note" type="text" maxlength="80" placeholder="Jan &amp; Feb combined"></div>
        <button class="modal-submit" type="button" id="drill-save">Save</button>
        <button class="add-btn" type="button" id="drill-delete" style="display:none;width:100%;margin-top:10px;color:var(--urgent)">Delete drill</button>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) closeModal('drill-modal'); });
    $('drill-close').addEventListener('click', () => closeModal('drill-modal'));
    $('drill-save').addEventListener('click', save);
    $('drill-delete').addEventListener('click', remove);
  }

  function openEditor(id) {
    ensureModal();
    editingId = id;
    const d = id ? data.entries.find(e => e.kind === 'drill' && e.id === id) : null;
    $('drill-modal-title').textContent = d ? 'Edit drill' : 'Add drill';
    $('drill-f-start').value = d ? d.start_date : '';
    $('drill-f-end').value = d ? d.end_date : '';
    $('drill-f-note').value = d ? (d.note || '') : '';
    $('drill-delete').style.display = d ? '' : 'none';
    openModal('drill-modal');
    $('drill-f-start').focus();
  }

  async function save() {
    const body = { start_date: $('drill-f-start').value, end_date: $('drill-f-end').value, note: $('drill-f-note').value };
    const btn = $('drill-save');
    btn.disabled = true;
    try {
      const res = await fetch(editingId ? `/api/drill-dates/${editingId}` : '/api/drill-dates', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(saved.error || 'Could not save');
      closeModal('drill-modal');
      toast(editingId ? 'Drill updated' : 'Drill added', 'success');
      // Show the year the saved drill belongs to, so a next-year entry is visible at once.
      await load(Number(saved.start_date.slice(0, 4)));
    } catch (e) {
      toast(e.message || 'Could not save', 'error');   // 400/409: modal stays open
      if (/no longer exists/.test(e.message || '')) { closeModal('drill-modal'); await load(data.year); }
    }
    btn.disabled = false;
  }

  async function remove() {
    const d = data.entries.find(e => e.kind === 'drill' && e.id === editingId);
    if (!d) return;
    if (!await uiConfirm({ title: `Delete the ${d.label} drill?`, message: 'It disappears from the schedule and the newsletter.', confirmLabel: 'Delete', danger: true })) return;
    try {
      const res = await fetch(`/api/drill-dates/${editingId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error((await res.json().catch(() => ({}))).error || 'Could not delete');
      closeModal('drill-modal');
      toast('Drill deleted', 'success');
      await load(data.year);
    } catch (e) { toast(e.message || 'Could not delete', 'error'); }
  }

  window.drillDatesInit = function ({ canEdit: ce } = {}) {
    const was = canEdit;
    canEdit = !!ce;
    if (!shellReady) { shell(); load(); return; }
    if (was !== canEdit && data) render();
  };
})();
```

- [ ] **Step 2: Load the script, add the CSS and the card markup in `index.html`**

After the `duties.js` script tag add:

```html
  <script src="/drill-dates.js" defer></script>
```

After the `.duty-edit svg { … }` rule add:

```css
    /* ── Useful Links → RSD schedule (public/drill-dates.js) ─────────────── */
    .drill-years { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
    .drill-year {
      border: 1px solid var(--border); background: var(--bg); color: var(--t2); font-family: inherit;
      font-size: 12.5px; font-weight: 600; padding: 6px 12px; border-radius: 999px; cursor: pointer; min-height: 36px;
    }
    .drill-year.active { background: var(--text); color: var(--bg); border-color: var(--text); }
    .drill-admin { margin-bottom: 10px; }
    .drill-list { display: flex; flex-direction: column; }
    .drill-row {
      display: flex; align-items: center; gap: 10px; padding: 10px 0;
      border-bottom: 1px solid var(--border); font-size: 14px; min-height: 44px;
    }
    .drill-row:last-child { border-bottom: 0; }
    .drill-label { font-weight: 600; flex: 1; min-width: 0; }
    .drill-meta, .drill-note { color: var(--t2); font-size: 12px; font-weight: 500; }
    .drill-row.past .drill-label, .drill-row.past .drill-note { text-decoration: line-through; color: var(--t3); font-weight: 500; }
    .drill-row.no-uta .drill-label { color: var(--t3); font-weight: 500; }
    .drill-row.next { box-shadow: inset 3px 0 0 var(--ok); padding-left: 10px; }
    .drill-tag {
      padding: 2px 8px; border-radius: 6px; background: var(--ok); color: var(--bg);
      font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    }
    .drill-edit {
      border: 0; background: none; color: var(--t2); cursor: pointer; padding: 8px;
      min-width: 44px; min-height: 44px; border-radius: 8px; flex: none;
    }
    .drill-edit:hover { color: var(--text); background: var(--s2); }
    .drill-edit svg { width: 16px; height: 16px; }
```

At the top of `#res-pane-links` (line 3478), insert **before** the existing `<div class="sec-hd" …><h2 class="sec-title">Useful Links</h2>` block:

```html
        <!-- RSD schedule for the calendar year, above the links. Rendered by
             public/drill-dates.js from /api/drill-dates; roster admins edit. -->
        <div class="sec-hd" style="padding:0 0 12px">
          <h2 class="sec-title">RSD Schedule</h2>
          <div class="sec-sub" id="drill-sub">Drill weekends this year</div>
        </div>
        <div class="card card-pad mb-md" id="drill-card"><div class="skeleton"></div></div>
```

- [ ] **Step 3: Wire it into `switchResPane`**

In `switchResPane(name)` add, after the `forms` line:

```js
  if (name === 'links' && window.drillDatesInit) window.drillDatesInit({ canEdit: !!currentMember?.can_manage_roster });
```

- [ ] **Step 4: Verify in the browser**

Preview at http://localhost:3100, Resources → **Useful Links**, as `gablin` / `preview123`:

- The card lists the ten 2026 drills and **No UTA — July** in date order; drills before today are struck through; the next one carries the green edge and a **Next** tag; 3-day drills say "· 3-day"; the Jan–Feb row shows its note.
- No year chips (only 2026 has rows). **+ Add drill** with `2027-01-09` → `2027-01-10` saves, the card switches to CY 2027 with one drill and eleven gaps, and **2026 / 2027** chips appear; tapping 2026 returns.
- Adding `2026-09-12` → `2026-09-14` shows the "overlap the 11–13 Sep drill" toast with the modal open; an end before the start, or an 8-day span, shows its 400 message.
- The pencil on a drill pre-fills both dates; **Delete drill** confirms then removes it.
- As `becerra` / `becerra`: the card, no Add, no pencils, no chips (after you delete the 2027 row).
- Dark mode and 375px: rows stay on one line or wrap the note under the label; the links grid below is unchanged.

Delete the 2027 test drill on staging afterwards.

- [ ] **Step 5: Commit**

```bash
git add public/drill-dates.js public/index.html
git commit -m "Useful Links: the year's drill schedule, struck through as it goes

A card above the links lists every drill and every month without one,
with the next drill marked and finished ones struck through, so the
list reads as progress through the year. Roster admins add next year's
dates in the same card, and a year chip appears for everyone the moment
a second year has rows. Renders what /api/drill-dates derives; no date
logic in the browser.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Newsletter — two live slides, four files gone

**Files:**
- Modify: `newsletter/from-db.js` (header comment; two queries; two fields)
- Modify: `newsletter/slides.js` (two slide functions + exports)
- Modify: `newsletter/theme.js` (three rules, before the `@media` block at line 277)
- Modify: `newsletter/render.js` (`STATIC_SLIDES`, `sections`, header comment)
- Modify: `newsletter/shape.js` (header comment, lines 1–2)
- Delete: `newsletter/static/additional-duties.html`, `newsletter/static/rsd-schedule.html`, `newsletter/from-sample.js`, `newsletter/preview-server.js`
- Test: `test/newsletter-http.test.js` (modify `seed()`, add one test)

**Interfaces:**
- Consumes: `duties.list(pool)`, `drillCal.listAll/buildYear/isoDate` (Tasks 2–3).
- Produces: `data.duties: Row[]`, `data.calendar: { year, entries }`; `S.additionalDuties(d)`, `S.rsdSchedule(d)`.

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

Then add this test after the "leadership gets the full deck" test:

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
  assert.match(html, /<b>8–9 Aug 2026<\/b>/, 'this cycle\'s own drill is bold');
  assert.match(html, /<li>11–13 Sep 2026 \(3-Day Drill\)<\/li>/, 'a later drill is plain');
  assert.match(html, /NO UTA JULY 2026/);
  assert.strictEqual((html.match(/<section class="slide/g) || []).length, 23);
  assert.ok(!/(?:src|href)="(?!data:)/.test(html), 'still self-contained');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test test/newsletter-http.test.js`
Expected: FAIL on the new test — `Lodging Monitor` is absent (the static partial renders instead).

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

After the `counts` query and before the `return`, add:

```js
  // Reference tables. The RSD slide is relative to the cycle being printed,
  // not to today: drills that ended before this UTA are struck through and this
  // UTA's own drill is the bold one — the convention the hand-edited partial used.
  const dutyRows = await duties.list(pool);
  const drillRows = await drillCal.listAll(pool);
  const reference = cycle.start_date ? drillCal.isoDate(cycle.start_date) : drillCal.isoDate(new Date());
  const calendar = drillCal.buildYear(drillRows, Number(reference.slice(0, 4)), reference);
```

And add two fields to the returned object, after `upgrade:`:

```js
    duties: dutyRows,
    calendar,
```

- [ ] **Step 4: `newsletter/slides.js`**

Insert before `// Wrap an editable static partial's body in standard slide chrome.`:

```js
// ── 9. Additional Duties ──────────────────────────────────────────────────
// Two side-by-side tables, split in half, so ~50 rows fit one printed page —
// the layout the hand-edited partial used. A duty with no primary owner
// prints red: that is what "needs owner" looks like on paper.
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

Add `additionalDuties, rsdSchedule,` to `module.exports` (after `inbound, upgrade,`).

- [ ] **Step 5: `newsletter/theme.js`**

Insert before the `@media` block (the line beginning `  .two-col,.ug-cols,.med-grid,.tl-wrap{flex-direction:column` is inside it; put these rules just above that `@media` opening line):

```css
/* Additional duties: two half-tables side by side, 8.5px, as the old partial */
.duties-cols{display:flex;gap:14px;align-items:flex-start;}
.duties-table{flex:1;width:100%;border-collapse:collapse;font-size:8.5px;}
.duties-table th{text-align:left;padding:4px 7px;font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--t2);border-bottom:1px solid var(--border);}
.duties-table td{padding:3px 7px;border-bottom:1px solid var(--border);vertical-align:top;}
.duties-table tr.red td{color:var(--urgent);}
/* RSD schedule */
.rsd-list{list-style:none;padding:0;margin:0;font-size:15px;line-height:1.9;}
.rsd-list s{color:var(--t3-nav);}
```

Inside the `@media` block, extend the existing `.data-table,.static-body table{display:block;overflow-x:auto;}` rule to `.data-table,.static-body table,.duties-table{display:block;overflow-x:auto;}` and add `.duties-cols` to the `flex-direction:column` selector list.

- [ ] **Step 6: `newsletter/render.js` and `shape.js`**

In `render.js`: delete the `additional:` and `rsd:` lines from `STATIC_SLIDES`; change slide 9 to `() => S.additionalDuties(data),              //  9  Additional Duties` and slide 23 to `() => S.rsdSchedule(data),                   // 23  RSD Schedule`; and change the header comment's last sentence to: `Live sections are built from Postgres; six remaining partials in static/ are editable by hand, because the tracker has no field for them yet.`

In `shape.js`, replace lines 1–2 with:

```js
// newsletter/shape.js — pure task-shaping for from-db.js: turns task rows into the
// per-slide structures render.js consumes. Kept free of SQL so it can be unit-tested.
```

- [ ] **Step 7: Delete the four files**

```bash
git rm newsletter/static/additional-duties.html newsletter/static/rsd-schedule.html newsletter/from-sample.js newsletter/preview-server.js
```

Then confirm nothing references them: `grep -rn "from-sample\|preview-server\|additional-duties.html\|rsd-schedule.html" --include=*.js --include=*.json --include=*.md . --exclude-dir=node_modules --exclude-dir=.claude` should return only `MEMORY.md` lines (fixed in Task 9) and the spec.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test test/newsletter-http.test.js`
Expected: `# pass 6`, `# fail 0`

Open the preview's **Generate Newsletter** (leadership → Tools) and check slide 9 fits one landscape page at print preview and slide 23 reads like the old partial.

- [ ] **Step 9: Commit**

```bash
git add -A newsletter test/newsletter-http.test.js
git commit -m "Newsletter: the duties and RSD slides read the tables

Slides 9 and 23 were the last two hand-edited partials with a field in
the tracker. They now render from additional_duties and drill_dates; the
RSD slide is relative to the cycle being printed, so earlier drills are
struck through and this UTA is bold, as the partial was kept by hand.
from-sample.js and preview-server.js required generate-sample-template.js,
deleted on 2026-08-17, and have not run since — gone with the partials.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, the full suite, and the PR

**Files:**
- Modify: `MEMORY.md` §5 (after the "Rollout-feedback batch" bullet block), §12 (key files)
- Verify: whole suite, deploy probes

- [ ] **Step 1: MEMORY.md §5 — add after the rollout-feedback bullets**

```markdown
- **Resources reference data (2026-08-23):** two newsletter partials became tables.
  - **Additional duties** (`additional_duties`): Resources → **People** (the renamed Org Chart tab) → "Additional duties" toggle; filter by duty or name; a blank primary owner renders as **Needs owner**. `GET /api/duties` (any member); `POST/PATCH/DELETE` (roster admins). Logic `lib/duties.js`, UI `public/duties.js`.
  - **Drill calendar** (`drill_dates`): Resources → Useful Links, an "RSD Schedule" card — every drill plus a "No UTA" line per empty month, 3-day tag, past struck through, next highlighted, year chips once a second year has rows. `GET /api/drill-dates?year=` returns the year already derived; writes reject overlaps. Logic `lib/drill-calendar.js` (pure derivation shared with the newsletter), UI `public/drill-dates.js`.
  - **Seed-on-create:** each table is loaded from `data/additional-duties.js` / `data/drill-dates.js` only in the boot that creates it (`ensureTable`), so production got the 52 duties and ten 2026 drills on first deploy and deleted rows never return. `schema.sql` carries the CREATEs empty.
  - The newsletter's Additional Duties (9) and RSD Schedule (23) slides now render from these tables, relative to the cycle being printed. `newsletter/from-sample.js` and `preview-server.js` were removed (dead since 2026-08-17).
```

- [ ] **Step 2: MEMORY.md §12 — add these lines after the `lib/presence.js` entry, and delete any line mentioning `from-sample.js` or `preview-server.js`**

```markdown
- `lib/duties.js`, `lib/drill-calendar.js` — additional duties and the drill calendar: DDL + seed-on-create (`ensureTable`), validation, CRUD; `drill-calendar.js`'s pure half (`buildYear`, `years`, `label`, `validateDrill`, `overlaps`) is shared with the newsletter and unit-tested.
- `public/duties.js`, `public/drill-dates.js` — the two Resources views; one global each (`dutiesInit`, `drillDatesInit`), initialised lazily from `switchResPane`/`setPeopleView`.
- `data/additional-duties.js`, `data/drill-dates.js` — the initial rows, used only by seed-on-create and the tests.
```

Run `grep -n "from-sample\|preview-server\|Org Chart" MEMORY.md` and fix any remaining stale mention (the Resources tab list in §5's first bullets should say **People**, not Org Chart).

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: every file passes; the count is 346 + 14 (drill-calendar) + 6 (duties) + 7 (drill-dates) + 1 (newsletter) = **374 tests**, `# fail 0`. Do not pipe through `tail`.

- [ ] **Step 4: Commit and open the PR**

```bash
git add MEMORY.md
git commit -m "docs: record the duties list and drill calendar, and what seed-on-create means

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin claude/resources-duties-calendar
gh pr create --title "Resources: Additional Duties list and drill calendar" --body "$(cat <<'EOF'
Two newsletter partials become tables the app reads, roster admins edit, and the deck renders from.

- **People** (the renamed Org Chart tab): chain of command | additional duties, with a filter; a blank primary owner shows **Needs owner**.
- **Useful Links**: the year's RSD schedule — every drill, every no-UTA month, 3-day tags, past struck through, next highlighted; year chips once next year is entered.
- `additional_duties` + `drill_dates`, seeded from `data/` only in the boot that creates them (production and staging both get the 52 duties and ten 2026 drills on deploy; deleted rows never return).
- Newsletter slides 9 and 23 now read the tables, relative to the cycle being printed. The dead sample path (`from-sample.js`, `preview-server.js`) is removed.

Spec: `docs/superpowers/specs/2026-08-22-resources-duties-and-drill-calendar-design.md`. Plan: `docs/superpowers/plans/2026-08-23-resources-duties-and-drill-calendar.md`.

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

Then sign in on a phone as a plain member: Resources → People → Additional duties shows 52 rows; Useful Links shows the ten 2026 drills with September marked **Next**. Sign in as a roster admin: Add/pencil controls appear in both. Check the Railway deploy log for the two `Created … and seeded … rows` lines — they appear exactly once, on this deploy, and never again. Generate the newsletter and confirm slides 9 and 23.
