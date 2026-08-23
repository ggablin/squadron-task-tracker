# 108 CES Task Tracker — Resources: Additional Duties + Drill Calendar

**Date:** 2026-08-22
**Status:** Design approved (brainstorming). Not yet implemented.
**Author/driver:** Greg Gablin
**Base branch for implementation:** `origin/master` at `e13f411`
**Source:** items 7a and 7c of `AUG-2026-NEWSLETTER-FEATURE-SUGGESTIONS.md` (project folder, outside the repo). This is the first of three specs drawn from that analysis; upgrade training (#4) and member availability (#2) follow as their own specs.

---

## 1. Goal

Put two reference slides from the monthly newsletter into the app as data the squadron can read on a phone and two people can maintain in the browser:

- **Additional Duties** — the "who do I see about X" list (AROWS clerk, DTS certifiers, lodging monitor, SAPR rep, …): ~50 duties with a primary and an alternate owner. The functional complement to the org chart, which answers "who is above me".
- **Drill calendar** — the calendar year's RSD (drill) dates, with 3-day drills and no-UTA months marked. Answers "when is the next drill" without opening a PDF.

Both currently exist only as hand-edited HTML partials inside the newsletter generator. After this work each has one home — a table — that the app reads, roster admins edit, and the newsletter renders from. Two fewer things for MSgt McNaughton to keep in sync.

## 2. Background

- The Resources tab has **five** panes: PT Calculator, Promotion, Forms, Useful Links, Org Chart (`public/index.html:3014-3020`, tab strip `.res-tabs`). The 480px rule already shrinks the labels; a sixth tab does not fit. (The comment at `index.html:1900` still says "four tabs" — it is stale.)
- The **Forms** pane is the pattern to copy: data-driven (`documents` table), read by any signed-in member, edited in-app by holders of `members.can_manage_roster` (today: Gablin, McNaughton), write routes gated `requireAuth, requireRosterAdmin, requireOnboarded` (`server.js:783-856`).
- **Org Chart** is data-driven from `GET /api/squadron/org-chart`, rendered by `loadOrgChart()` into `#org-staff-banner` / `#org-flights` (`index.html:3561-3570`). **Useful Links** is static HTML (`index.html:3478-3553`).
- The newsletter (`newsletter/`) renders 23 slides from the live database except for eight **static partials** in `newsletter/static/`. Two of them are the subject here: `additional-duties.html` (52 rows in two side-by-side three-column tables, owners as plain text like `King / Izzo / Gablin`, vacancies marked only by the literal text `TBD` or `—`) and `rsd-schedule.html` (the CY-2026 list with completed drills struck through and the current one bold).
- **Nothing holds the year's drill dates.** `uta_cycles` rows exist only once someone creates a cycle in `/build`; `data/squadron-events.js` is one UTA's timeline template.
- `newsletter/from-sample.js` and `newsletter/preview-server.js` both `require('../generate-sample-template')`, which was deleted on 2026-08-17. Neither has run since; only `from-db.js` is used (`server.js:2955`). `.claude/launch.json` points at `preview-run.cjs`, not the preview server.
- Every `schema.sql` migration has a twin in the `server.js` boot block (`server.js:88-235`), which is what production actually runs.

## 3. Decisions locked (from brainstorming)

| Decision | Choice |
|---|---|
| Duties storage | **Data-backed, free-text owners.** No member linking |
| Drill dates storage | **Table + in-app editor**, not a repo config file |
| Where members see drill dates | **Resources → Useful Links only.** No Timeline line |
| Who edits | **`can_manage_roster`** (the Forms gate), not leadership-wide |
| Where duties live | **Inside the Org Chart pane behind a two-way `.seg-toggle`; the tab is renamed "People"** |
| Ordering | **Alphabetical by duty**, no manual sort |
| Vacancy | **Derived** — blank primary owner = "Needs owner". No typed flag |
| 3-day drills, no-UTA months | **Derived from dates** |
| Initial data | **Seed-on-create** — loaded once, when the boot migration creates each table; deleted rows never return |
| Newsletter | **Both slides go live**; their partials and the dead sample path are deleted |
| Calendar as pre-created draft cycles | **Rejected** — `createDraft` carries open work orders forward at creation time, twelve drafts would clutter the builder's picker, and "draft" means "being authored" everywhere else |

## 4. Scope

**In scope**

- Two tables, twinned migrations, seed data files, seed-on-create.
- `lib/duties.js`, `lib/drill-calendar.js`; eight routes.
- `public/duties.js`, `public/drill-dates.js`; the People pane toggle; the Useful Links card; two editor modals.
- Two live newsletter slides replacing two partials; removal of `from-sample.js`, `preview-server.js`, and the two partials.
- Tests (§12), doc updates (§13).

**Out of scope** (see §14): `/build` pre-fill from the calendar, member-linked owners, a Timeline "next UTA" line, any change to the other six partials.

## 5. Data model

### 5.1 `additional_duties`

```sql
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
```

Uniqueness is case-insensitive via the functional index; a violation surfaces as 409 (§7). Owners are whatever the squadron writes — `King / Izzo / Gablin`, `EVERYONE`, `T. Davis`, a state employee's name. Blank means nobody holds it.

### 5.2 `drill_dates`

```sql
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

A drill is one to seven calendar days. Overlap between two drills is rejected in the API (§7), not the schema — an exclusion constraint needs `btree_gist`, which is not worth enabling for ten rows a year. Nothing links a drill to a `uta_cycles` row; `/build` may read this table to pre-fill a new cycle later (§14).

### 5.3 Migrations and seed-on-create

Both `CREATE TABLE` statements are added to `schema.sql` (after `members`, so the `REFERENCES` resolves) and to the `server.js` boot block. No existing table changes.

The boot block seeds each table **only in the boot that creates it**. Each `lib` module exports `ensureTable(db, defaults)`:

1. `SELECT to_regclass('public.<table>')` — if non-null, return `{ created: false }` and do nothing else.
2. Run the `CREATE TABLE` (and index).
3. Insert `defaults`.
4. Return `{ created: true, seeded: defaults.length }`.

The boot block calls both after its existing migration string, so `members` already exists. Consequences, all intended: production and staging, which lack both tables, get the real data on the first deploy with no script to run; `applySchema()` in tests creates the tables from `schema.sql` first, so the boot block finds them and HTTP tests start empty; an admin who deletes a row never sees it come back, because the table is never "fresh" again.

### 5.4 Seed data files

- `data/additional-duties.js` — the 52 rows of `newsletter/static/additional-duties.html`, transcribed verbatim as `{ duty, primary, alternate }`, with one normalization: a field that is exactly `TBD` or `—` becomes `null`. Compound text keeps its wording (`EVERYONE / TBD` on WAR/WIT stays as written; `EVERYONE` on UTA Newsletter stays).
- `data/drill-dates.js` — the **ten** CY-2026 drills from `rsd-schedule.html` as `{ start, end, note }`: 2026-01-31→02-01 ("Jan & Feb combined"), 03-06→08, 04-11→12, 05-01→03, 06-05→07, 08-08→09, 09-11→13, 10-17→18, 11-14→15, 12-11→13. July has no entry; it renders as "No UTA" by derivation.

Both files are plain `module.exports = [...]`, like `data/squadron-events.js`, and are used by the seed and by tests only.

## 6. Calendar derivation — `lib/drill-calendar.js`

Pure functions, no database, shared by the API and the newsletter so there is one implementation.

`buildYear(rows, year, referenceDate)` returns:

```js
{
  year: 2026,
  entries: [
    { kind: 'drill', id, start_date: '2026-01-31', end_date: '2026-02-01',
      label: '31 Jan–1 Feb', threeDay: false, note: 'Jan & Feb combined',
      past: true, next: false },
    { kind: 'drill', ..., label: '11–13 Sep', threeDay: true, past: false, next: true },
    { kind: 'no_uta', month: 7, label: 'July' },
    ...
  ]
}
```

Rules:

- `rows` is filtered to drills whose `start_date` falls in `year`, ordered by `start_date`.
- A month is **covered** if any drill has `start_date ≤` the month's last day and `end_date ≥` its first day; a 31 Jan–1 Feb drill covers both January and February. Every uncovered month produces one `no_uta` entry, placed in date order at the first of that month. Each drill appears exactly once.
- `label`: same month → `11–13 Sep`; different months → `31 Jan–1 Feb`; single day → `8 Aug`. No year in the label (the card and slide title carry it).
- `threeDay` = `(end_date − start_date) + 1 ≥ 3`.
- `past` = `end_date < referenceDate`. `next` = the first drill in the list that is not past — so a reference date *inside* a drill makes that drill `next`, never past. At most one entry has `next: true`.
- `years(rows)` = distinct years of `start_date`, ascending.
- Validation helpers, used by the API: `validateDrill({start_date, end_date, note})` (ISO `YYYY-MM-DD` via the app's `ISO_DATE_RE`, real calendar dates, `end ≥ start`, `end − start ≤ 6`, note trimmed ≤80); `overlaps(a, b)` = `a.start ≤ b.end && b.start ≤ a.end` (adjacent days do not overlap).

`referenceDate` is the server's date for the API (UTC on Railway — a strike-through may flip a few hours early on the day a drill ends, which is acceptable) and the cycle's `start_date` for the newsletter (§9).

## 7. API surface

Thin routes in `server.js`; logic in `lib/duties.js` and `lib/drill-calendar.js`. Errors are `{ error: '<message>' }` with the usual codes. "admin" below means the exact documents chain: `requireAuth, requireRosterAdmin, requireOnboarded`.

| Route | Gate | Behaviour |
|---|---|---|
| `GET /api/duties` | `requireAuth` | `{ duties: [{ id, duty, primary_owner, alternate_owner }] }` ordered by `lower(duty)` |
| `POST /api/duties` | admin | body `{ duty, primary_owner?, alternate_owner? }` → **201** with the row |
| `PATCH /api/duties/:id` | admin | any subset of the three fields → **200** with the row; **404** unknown id |
| `DELETE /api/duties/:id` | admin | **204**; **404** unknown id |
| `GET /api/drill-dates?year=` | `requireAuth` | `{ year, years, entries }` — `year` defaults to the server's current year; `entries` is `[]` when that year has no drills |
| `POST /api/drill-dates` | admin | body `{ start_date, end_date, note? }` → **201** with the row |
| `PATCH /api/drill-dates/:id` | admin | any subset; validated on the merged row → **200**; **404** unknown id |
| `DELETE /api/drill-dates/:id` | admin | **204**; **404** unknown id |

Validation (**400** with a plain-English message):

- `duty`: trimmed, 1–120 characters, required on create. `primary_owner`/`alternate_owner`: trimmed, ≤200; empty string → `NULL`.
- Drill fields: as `validateDrill` in §6. `year` query: four digits, 2000–2100.

Conflicts (**409**): a duty whose `lower(duty)` already exists (`23505` on the functional index → "A duty with that name already exists"); a drill that overlaps any *other* drill (a PATCH excludes its own row from the check) or shares a `start_date`.

All writes stamp `updated_by_id = req.session.memberId` and `updated_at = NOW()`. Rows return dates as `YYYY-MM-DD` strings (`to_char`), matching the Student Flight routes.

## 8. Frontend surfaces

### 8.1 Files and loading

Two new files, so `index.html` (8,495 lines) does not grow: **`public/duties.js`** and **`public/drill-dates.js`**, loaded with `<script src defer>` beside `ui.js` and `offline.js`. Each exposes exactly one global — `dutiesInit({ canEdit })` and `drillDatesInit({ canEdit })` — invoked lazily from `switchResPane()` the way `pfInit()` and `loadOrgChart()` are. `canEdit` is passed in from `currentMember.can_manage_roster`; the modules do not reach for page state. Both call the page's `openModal`/`closeModal` (focus trap, `role="dialog"`), `uiToast`, and `uiConfirm`. Feature CSS goes in the page `<style>`, scoped under `.duty-list` and `.drill-list`. `switchView('resources')` still resets to the PT Calculator pane; nothing about the strip changes except one label.

### 8.2 People pane (the renamed Org Chart tab)

The tab label becomes **People**; `data-rt="orgchart"` and the pane id stay, so nothing else moves. At the top of the pane, a `.seg-toggle` (`role="group"`, `aria-pressed`, identical to the shop and squadron toggles): **Chain of command** | **Additional duties**. Default is Chain of command, which is today's org chart untouched. The state is not persisted.

The duties view:

- `.search-wrap` / `.search-input` (existing global classes) at the top, filtering client-side, case-insensitive, on duty **and** both owners — so "DTS" finds the certifiers and "Gablin" finds his duties. A count line beneath ("52 duties", "3 of 52 match").
- One row per duty: the duty in bold; beneath it "Primary — King / Izzo" and "Alternate — …" (a blank alternate shows "—"). A blank primary gives the row the warn treatment (`--wrn-bg`/`--warn`) and a **Needs owner** tag, visible to everyone.
- Admins see an "Add duty" `.add-btn` above the list and a pencil `<button aria-label="Edit <duty>">` on each row. Nothing is tappable for a plain member.

### 8.3 Useful Links pane

A new block **above** the links, with its own `.sec-hd` ("RSD Schedule" / "CY 2026") and a `.card`:

- One line per entry from `GET /api/drill-dates`: `11–13 Sep · 3-day`, `No UTA`, the note inline in muted text. Past drills are struck through and muted; the `next` one is highlighted with a **Next** tag.
- Year chips appear whenever more than one year is selectable — the displayed year plus every year in `years` — and are hidden when that set has one member. So McNaughton can enter December's next-year list and members can flip to it, and a 2027 list is reachable even before 2026 has rows. Default is the current year.
- A year with no drills shows "No drill dates entered for 2027" (plus the add button for admins) rather than twelve "No UTA" lines.
- Admins see an "Add drill" `.add-btn` and a pencil per drill row.

The existing "Useful Links" header and the links grid follow unchanged.

### 8.4 Editors

Two modals, injected once into `document.body` by their modules using the existing `.modal-backdrop > .modal-sheet > .modal-hdr / .modal-field / .modal-submit` markup (the `#student-modal` shape):

- **Duty:** Duty (required), Primary owner, Alternate owner. Editing an existing row also shows a secondary **Delete** button, which goes through `uiConfirm` before `DELETE`.
- **Drill:** Start date, End date (native `type="date"`), Note. Same Delete behaviour when editing.

Save → `POST`/`PATCH` → `uiToast` → re-fetch and re-render the list. A 409 or 400 shows the server's message in the toast and leaves the modal open.

### 8.5 Offline and errors

Both views are online-only — nothing in Resources is cached and nothing here is added to the offline scope. A failed fetch renders the same quiet "needs a connection" note the shop views use (`.tl-empty` style), and the page's existing offline toast suppression applies.

## 9. Newsletter

The deck order is unchanged: Additional Duties stays slide 9, RSD Schedule stays slide 23.

- `newsletter/from-db.js` queries both tables (and the current cycle's `start_date`) and emits `data.duties` (ordered by `lower(duty)`) and `data.calendar = buildYear(rows, year, reference)` where `reference` is the cycle's `start_date`, falling back to today when a legacy cycle has none, and `year` is that date's year. Using the cycle's start rather than today reproduces the partial's convention: drills that ended before this UTA are struck through, this UTA's own drill is the `next` one and renders bold, later drills are plain.
- `newsletter/slides.js` gains `additionalDuties(d)`: two side-by-side three-column tables (Additional Duty | Primary | Alternate) at the partial's 8.5px, split at `ceil(n / 2)` so one page still fits; blank owners render as `—`; a needs-owner row carries the deck's existing `.red` class. And `rsdSchedule(d)`: one line per entry — `<s>` for past, `<b>` for `next`, `(3-Day Drill)` when `threeDay`, the note in parentheses, and `NO UTA JULY 2026` for `no_uta` entries. Its title takes the year from `data.calendar.year` instead of the hard-coded "CY 2026".
- `newsletter/render.js` drops `additional` and `rsd` from `STATIC_SLIDES` and calls the two new slide functions at positions 9 and 23. `static/additional-duties.html` and `static/rsd-schedule.html` are deleted; the other six partials are untouched.
- **Dead code removed in the same PR:** `newsletter/from-sample.js`, `newsletter/preview-server.js`, and the references to the sample path in the `shape.js` and `from-db.js` header comments.
- Self-containment (no `src`/`href` outside `data:` URIs) holds by construction — lists and tables only — and the existing assertion in `test/newsletter-http.test.js` keeps enforcing it.

## 10. Key flows

1. **A member looks up who handles DTS.** Resources → People → Additional duties → types "DTS" → sees the certifiers and alternates. Two taps and a word.
2. **McNaughton updates an owner after a PCS.** Same view, pencil on the row, clears the Primary field, saves. The row immediately shows **Needs owner** for everyone, and the next newsletter prints it red.
3. **McNaughton enters next year's dates in December.** Useful Links → Add drill, ten times, two dates and an occasional note each. A **2027** chip appears for everyone; the December newsletter's RSD slide still shows 2026 because that cycle's start date is in 2026.
4. **A member checks the next drill.** Useful Links → the highlighted **Next** line. Past drills are struck through, so the list reads as progress through the year.
5. **Generating the newsletter** needs nothing new: both slides read the tables.
6. **First deploy.** The boot block creates both tables on production and staging and seeds 52 duties and 10 drills. Verify with the usual probes plus `GET /api/drill-dates` as a plain member.

## 11. Edge cases and error handling

- Renaming a duty to a case variant of another → 409, modal stays open with the message.
- Two admins: A deletes a row B is editing → B's PATCH returns 404 → toast "That duty no longer exists" and the list re-fetches.
- A drill edited to overlap another → 409. A PATCH never conflicts with itself.
- The reference date falls inside a drill (drill weekend) → that drill is `next`, shown highlighted, not struck.
- Current year has no rows but another year does → the card shows the empty note for the current year and a chip for the other.
- Names containing `&`, `<`, `/` (`R&O`, `T. Davis`) → escaped on every render path (`escapeHtml` in the app, `esc` in the deck).
- Offline or fetch failure → the note in §8.5, no toast storm.
- A 121-character duty, an 8-day drill, `end_date` before `start_date`, a malformed date → 400 with the field named.

## 12. Testing

Following the repo's two conventions — `<feature>.test.js` for pure `lib/` units, `<feature>-http.test.js` for real HTTP against a throwaway Postgres via `test/helpers/db.js`:

- **`test/drill-calendar.test.js`** (unit): `buildYear` for the 2026 seed yields ten drills and one `no_uta` (July) in date order; 31 Jan–1 Feb covers both months; `threeDay` flips at three days; `past`/`next` relative to a reference date, including a reference date inside a drill; labels `11–13 Sep`, `31 Jan–1 Feb`, `8 Aug`; `years`; `validateDrill` and `overlaps` (adjacent days allowed).
- **`test/duties-http.test.js`** and **`test/drill-dates-http.test.js`**: 401 signed out; a 403 matrix of member / supervisor / leadership-without-the-capability against every write route (table form, as `test/roster-http.test.js` does); admin CRUD round-trip; 400s for empty and 121-character duty, malformed dates, end before start, an 8-day span; 409 for a case-insensitive duplicate and an overlapping drill; 404 on unknown ids; a plain member can `GET` both; `updated_by_id` stamped; `GET /api/drill-dates` returns `entries: []` for an empty year and the right `years`.
- **Seed-on-create** (in each `-http` file, against the test database): drop the table, call `ensureTable(pool, defaults)` → `{ created: true, seeded: 52 }` (or 10) and the rows are present; call again → `{ created: false }` and the count is unchanged; delete one row, call again → still gone.
- **`test/newsletter-http.test.js`** extended: a duty and a drill inserted into the database appear in the rendered deck; a blank-primary duty's row carries `red`; a drill that ended before the cycle's `start_date` is inside `<s>`; the deck still has 23 slides; the self-containment assertion still passes.
- **Front end** has no automated harness in this repo, so verification follows the handoff's practice: the preview server against staging, then a phone at 375px — five tabs with "People" fitting, both toggles, admin versus plain member, dark mode, the offline note.

## 13. Rollout and housekeeping

- One branch (`claude/resources-duties-calendar`, off `e13f411`), one PR; CI gates the deploy as it does today.
- No existing table changes, no data migration. Reverting the PR restores the two partials (deleted in the same PR) and leaves two unused tables behind, which is harmless.
- Docs updated in the PR: `MEMORY.md` §5 (features) and §12 (key files); the stale "four tabs" comment at `index.html:1900`; the `shape.js` / `from-db.js` headers.

## 14. Out of scope / future

- **`/build` pre-fill**: a "New cycle" form that suggests the next drill's name and dates from `drill_dates`. Natural follow-on; not needed for either slide.
- **Member-linked owners**: would enable "your additional duties" on the member view and a vacant-duties readout for leadership. Owners today include state employees, `EVERYONE` and blanks, so the free-text model stays until there is a reason to change it.
- **A Timeline "next UTA" line.** Decided against; the card in Useful Links is the one surface.
- **A leadership vacant-duties readout** beyond the tag everyone already sees.
- **The other six static partials** (safety, awards, MEETs/RADR, additional training, measurements, dental buckets) — unchanged, still hand-edited.
