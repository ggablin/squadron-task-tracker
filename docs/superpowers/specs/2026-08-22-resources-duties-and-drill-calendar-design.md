# 108 CES Task Tracker — Resources: Additional Duties, Calendar, and a tab restructure

**Date:** 2026-08-22, revised 2026-08-23 (rev. 2)
**Status:** Design approved (brainstorming + `/impeccable shape`). Not yet implemented.
**Author/driver:** Greg Gablin
**Base branch for implementation:** `origin/master` at `e13f411`
**Source:** items 7a and 7c of `AUG-2026-NEWSLETTER-FEATURE-SUGGESTIONS.md` (project folder, outside the repo). First of three specs from that analysis; upgrade training (#4) and member availability (#2) follow as their own specs.
**What rev. 2 changed:** see Appendix A. Short version: the Resources tab is restructured rather than extended, the drill dates moved from Useful Links into a new Calendar tab that also carries TDY/training events, the duty rows became a divider list, and four of rev. 1's CSS choices were caught regressing documented standards.

---

## 1. Goal

Two reference slides from the monthly newsletter become data the squadron reads on a phone and two people maintain in the browser, and the Resources tab is reorganised to hold them without growing:

- **Additional Duties** — the "who do I see about X" list: ~50 duties with a primary and alternate owner. The functional complement to the org chart, which answers "who is above me".
- **The calendar** — the year's drill weekends plus the TDY and training rotations (RADR, Silver Flag, DFT), in one chronological view. Answers "what is coming up" without opening a PDF.

Each gets one home — a table — that the app reads, roster admins edit, and (for the duties and drill dates) the newsletter renders from. Fewer things for MSgt McNaughton to keep in sync.

## 2. Background

### The Resources tab

Five panes today: PT Calculator, Promotion, Forms, Useful Links, Org Chart (`public/index.html:3014-3020`, `.res-tabs`). The 480px rule already shrinks the labels to 11.5px with 3px padding, and the comment above it still says "four tabs" — it is stale by one. A sixth tab does not fit.

Two of those five are the same kind of thing: enter numbers, read a score. Merging them frees a slot without spending one.

### What the codebase already decided

There is no `PRODUCT.md` or `DESIGN.md`. The design record is four prior `/impeccable` runs in `.impeccable/` plus the token comments in `public/design.css`, and it is specific:

- **Register is product**, stated in `.impeccable/critique/ignore.md`.
- **One typeface**, General Sans, self-hosted because base networks block `api.fontshare.com`. A second family was flagged and dismissed twice.
- **44px is the app-wide tap-target norm.** Two audits enforced it (`2026-08-11__combined-fix-list.md` items 5 and 13).
- **`--t3` is strokes and icons only** — `design.css:26` says so outright, and the July critique traced 13 contrast failures in Resources to `--t3` used as text. `--t3-nav-text` is the legible token.
- **Status colours are measured pairs**: `--urgent`/`--urg-bg` 4.88:1, `--warn`/`--wrn-bg` 5.04:1, `--ok`/`--ok-bg` 4.75:1. Each foreground is verified against its own background, not against `--bg`.
- **Absolute bans are currently clean** — the July critique confirms no gradient text, glassmorphism, hero-metric template, identical card grids, or side-stripe borders anywhere.
- **Em dashes in copy are a documented accepted deviation** (137 counted, July; noted again in August). Not a defect here.
- **Toggles use `role="group"` + `aria-pressed`**, not a fake tablist — audit item 8 fixed exactly that.
- `.member-row` in `design.css:254` is the established list-row idiom: 1px divider, `11px 18px` padding, hover `--cream`, no per-row border.

### The data

- The newsletter renders 23 slides from Postgres except for eight **static partials** in `newsletter/static/`. Three matter here:
  - `additional-duties.html` — 52 rows, two side-by-side three-column tables, owners as plain text (`King / Izzo / Gablin`), vacancies marked only by the literal text `TBD` or `—`.
  - `rsd-schedule.html` — the CY-2026 drill list, completed drills struck through, the current one bold.
  - `meets-radr.html` — nine TDY/training rotations in the form `RADR @ New London, NC (11–17 Jan 2026): SrA Hill [COMPLETE]`, plus the FY26 DFT block (Camp Murray WA, 15–29 June 2026, 23 names). Already a dated event list in prose.
- **Nothing holds the year's drill dates.** `uta_cycles` rows exist only once someone builds a cycle in `/build`; `data/squadron-events.js` is one UTA's Friday/Saturday/Sunday template.
- `newsletter/from-sample.js` and `newsletter/preview-server.js` both `require('../generate-sample-template')`, deleted 2026-08-17. Neither has run since; only `from-db.js` is used (`server.js:2955`).
- Every `schema.sql` migration has a twin in the `server.js` boot block (`server.js:88-235`), which is what production runs.
- The **Forms** pane is the gate to copy: read by any signed-in member, written by holders of `members.can_manage_roster` (today Gablin and McNaughton) behind `requireAuth, requireRosterAdmin, requireOnboarded` (`server.js:783-856`).

## 3. Decisions locked

| Decision | Choice |
|---|---|
| Duties storage | **Data-backed, free-text owners.** No member linking |
| Drill dates storage | **Table + in-app editor**, not a repo config file |
| Events storage | **A `calendar_events` table**, squadron-wide only, seeded from the MEETs/RADR partial |
| Who edits | **`can_manage_roster`** (the Forms gate), not leadership-wide |
| Resources tabs | **Calculators · Forms · Links · People · Calendar** — PT and Promotion merge behind one tab, freeing the slot Calendar takes |
| "Useful Links" | **Renamed "Links"** — the drill dates leave it, and the shorter label buys room for "Calculators" at 375px |
| Duties placement | **Inside the People pane** (the renamed Org Chart tab) behind a two-way `.seg-toggle` |
| Duty row shape | **Compact divider rows** on the `.member-row` idiom: name line, then `Primary: … · Alt: …` |
| Calendar shape | **One chronological stream grouped by month**, drills and events interleaved |
| Ordering | Duties **alphabetical**; calendar **by date**. No manual sort anywhere |
| Vacancy | **Derived** — blank primary owner renders a `Needs owner` tag. No typed flag, and no squadron-wide vacancy count |
| 3-day drills, no-UTA months | **Derived from dates** |
| Initial data | **Seed-on-create** — loaded once, in the boot that creates each table; deleted rows never return |
| Newsletter | Slides **9 and 23 go live**; their partials are deleted. **MEETs/RADR (11) stays hand-edited** this round |
| Calendar as pre-created draft cycles | **Rejected** — `createDraft` carries open work orders forward at creation time, twelve drafts would clutter the builder's picker, and "draft" means "being authored" everywhere else |

## 4. Scope

**In scope**

- Three tables (`additional_duties`, `drill_dates`, `calendar_events`), twinned migrations, seed files, seed-on-create.
- `lib/duties.js`, `lib/drill-calendar.js`, `lib/calendar-events.js`; eleven routes.
- The Resources tab restructure: calculators merged, Links renamed, People renamed and split, Calendar added.
- `public/duties.js`, `public/calendar.js`; three editor modals.
- Two live newsletter slides replacing two partials; removal of the dead sample path.
- Tests (§12), doc updates (§13).

**Out of scope** — see §14.

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

Uniqueness is case-insensitive via the functional index; a violation surfaces as 409. Owners are whatever the squadron writes — `King / Izzo`, `EVERYONE`, `T. Davis`, a state employee. A NULL primary is the one structured fact and means "needs owner" everywhere it renders.

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

One to seven days. Overlap between two drills is rejected in the API, not the schema — an exclusion constraint needs `btree_gist`, not worth enabling for ten rows a year. Nothing links a drill to a `uta_cycles` row.

### 5.3 `calendar_events`

```sql
CREATE TABLE IF NOT EXISTS calendar_events (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(120) NOT NULL,   -- 'RADR', 'Silver Flag', 'FY26 DFT'
  location      VARCHAR(120),            -- 'Dobbins ARB, GA'
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  attendees     VARCHAR(600),            -- free text, same reasoning as duty owners
  status        VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','complete','cancelled')),
  note          VARCHAR(200),
  updated_by_id INTEGER REFERENCES members(id),
  updated_at    TIMESTAMP DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events (start_date);
```

The title carries the kind — the squadron writes `RADR`, `Silver Flag`, `REOTS`, `FY26 DFT`, and inventing a kind enum on top would only constrain them. `attendees` is 600 characters because the DFT block names 23 people. Events legitimately overlap each other and drills, so there is no overlap check and no uniqueness. No shop or member scoping: these are squadron-wide announcements. The 7-day cap on drills does not apply — a DFT runs a fortnight.

### 5.4 Migrations and seed-on-create

All three `CREATE TABLE`s go in `schema.sql` (after `members`, so the `REFERENCES` resolves) and in the `server.js` boot block. No existing table changes.

The boot block seeds each table **only in the boot that creates it**. Each lib exports `ensureTable(db, defaults)`:

1. `SELECT to_regclass('public.<table>')` — if non-null, return `{ created: false }` and stop.
2. Run the `CREATE TABLE` and its index.
3. Insert `defaults`.
4. Return `{ created: true, seeded: n }`.

Consequences, all intended: production and staging, which lack all three tables, get the real data on the first deploy with no script; `applySchema()` in tests creates the tables from `schema.sql` first, so the boot block finds them and HTTP tests start empty; a row an admin deletes never returns, because the table is never fresh again.

### 5.5 Seed data files

- `data/additional-duties.js` — the 52 rows of `additional-duties.html`, verbatim, with one normalisation: a field that is exactly `TBD` or `—` becomes `null`. Compound text keeps its wording (`EVERYONE / TBD` stays).
- `data/drill-dates.js` — the ten CY-2026 drills from `rsd-schedule.html`. July has no entry; it is derived.
- `data/calendar-events.js` — the nine rotations and the FY26 DFT block from `meets-radr.html`, with `COMPLETE`/`CANCELLED` mapped to `status`. Note the first is December 2025, so two years have rows from day one.

All three are plain `module.exports = [...]`, like `data/squadron-events.js`, used by seed-on-create and the tests only.

## 6. Derivation — `lib/drill-calendar.js`

Pure functions, no database, so the API and the newsletter share one implementation and it is testable without a browser. Dates are `YYYY-MM-DD` strings throughout: ISO strings compare correctly as strings and never pick up a timezone the way a `Date` does.

**Shared helpers:** `isoDate(v)` (accepts a `Date` or a string, returns `YYYY-MM-DD` at UTC), `label(start, end)` (`11–13 Sep`, `31 Jan–1 Feb`, `8 Aug`), `years(rows)` (distinct, ascending), `validateDrill(body)`, `overlaps(a, b)` (shared day; adjacent days do not overlap).

**`buildYear(drills, year, referenceDate)` → `{ year, entries }`** — the flat drill-only view the newsletter's slide 23 prints. Each drill appears once with `label`, `threeDay` (`≥ 3` days), `past` (`end_date < referenceDate`) and `next` (the first drill that is not past — so a reference date *inside* a drill makes that drill next, never past). Every month no drill touches yields one `{ kind: 'no_uta', month, label }`, placed in date order.

**`buildCalendar(drills, events, year, referenceDate)` → `{ year, months }`** — the app's Calendar view. Twelve month groups, each `{ month, label, noUta, entries }`:

- `noUta` is a property of the month, not a row — a month can have no drill and still have a RADR in it.
- `entries` merges that month's drill entries and event entries, sorted by `start_date` then title. A drill entry is what `buildYear` produces; an event entry is `{ kind: 'event', id, start_date, end_date, label, title, location, attendees, status, note, past }`.
- An event spanning two months appears in the month it **starts**, so it is listed once.
- `next` marks the next *drill* only. "When is the next drill" is the question the marker answers; a training rotation four people attend is not the squadron's next milestone.

## 7. API surface

Thin routes in `server.js` over the libs. Reads are `requireAuth`; writes use exactly the documents chain, `requireAuth, requireRosterAdmin, requireOnboarded` ("admin" below). Errors are `{ error: '<message>' }`. Dates travel as `YYYY-MM-DD` (`to_char` out, `ISO_DATE_RE` in).

| Route | Gate | Behaviour |
|---|---|---|
| `GET /api/duties` | auth | `{ duties: [...] }` ordered by `lower(duty)` |
| `POST /api/duties` | admin | **201** with the row |
| `PATCH /api/duties/:id` | admin | partial update; **404** unknown |
| `DELETE /api/duties/:id` | admin | **204**; **404** unknown |
| `GET /api/calendar?year=` | auth | `{ year, years, months }` from `buildCalendar`. `year` defaults to the server's current year; `years` spans drills **and** events |
| `POST /api/drill-dates` | admin | **201**; **409** on overlap with another drill |
| `PATCH /api/drill-dates/:id` | admin | validated on the merged row; **409** on overlap excluding itself |
| `DELETE /api/drill-dates/:id` | admin | **204** |
| `POST /api/calendar-events` | admin | **201** |
| `PATCH /api/calendar-events/:id` | admin | partial update on the merged row |
| `DELETE /api/calendar-events/:id` | admin | **204** |

There is deliberately **one read endpoint** for the calendar. Merging two lists and regrouping them by month in the browser would duplicate `buildCalendar` in a second language.

Validation (**400**, message names the field): duty trimmed 1–120, owners ≤200 (empty → NULL); drill dates real ISO calendar dates, `end ≥ start`, span ≤ 7 days, note ≤80; event title 1–120 required, location ≤120, `end ≥ start`, attendees ≤600, note ≤200, `status` one of the three; `year` four digits 2000–2100.

Conflicts (**409**): a duty whose `lower(duty)` exists; a drill overlapping another drill or sharing a `start_date`. Events never conflict.

All writes stamp `updated_by_id` and `updated_at`.

## 8. Frontend

### 8.1 The tab strip

`Calculators · Forms · Links · People · Calendar`. Five tabs, 35 characters of label against today's 48, so the 480px rule gets easier rather than harder. Resources still opens on the first tab, so the default path is unchanged.

| Tab | `data-rt` | Contents |
|---|---|---|
| Calculators | `calc` | The two existing calculators behind a `.seg-toggle`, PT first |
| Forms | `forms` | Unchanged |
| Links | `links` | Unchanged but for the label; the drill dates are **not** here |
| People | `orgchart` | Chain of command \| Additional duties, behind a `.seg-toggle` |
| Calendar | `calendar` | The year, one chronological stream |

`data-rt` and the pane ids for the four existing panes do not change, so only labels and one new pane move.

### 8.2 Calculators

`#res-pane-pfra` and `#res-pane-promo` become children of a new `#res-pane-calc`, with a `.seg-toggle` above them (`Fitness | Promotion`, `role="group"`, `aria-pressed`). Their **element ids stay** and only their class changes from `.res-pane` to `.calc-view` (`display:none`, `.active` shows), so roughly 700 lines of calculator CSS and JS are untouched and `pfInit()`/`pmInit()` still find their mounts. Each still initialises lazily, on first selection rather than on pane entry. The selected calculator is not persisted.

### 8.3 People

Tab renamed from Org Chart; `.seg-toggle` at the top: **Chain of command | Additional duties**, defaulting to the chain, not persisted. The chain view is today's org chart, untouched.

The duties view is a **divider list**, not cards:

- `.search-wrap` / `.search-input` at the top, filtering case-insensitively on the duty **and** both owners, so "DTS" finds the certifiers and "Gablin" finds his duties. A count line reads `52 duties` or `3 of 52 match`.
- Each row is two lines on the `.member-row` idiom — 1px divider, `11px 18px`, hover `--cream`, no per-row border: the duty name at 600, then `Primary: King / Izzo · Alt: Romer` in `--t2`. Missing owners render `—`.
- A row with no primary owner gets a `--wrn-bg` tint and a `Needs owner` chip in the app's paired badge idiom (`--wrn-bg` on `--warn`), never a solid fill and never a side stripe.
- Admins additionally see `+ Add duty` above the list and a 44px pencil button per row, labelled `Edit <duty>`.

### 8.4 Calendar

A year of drills and events in one stream:

- Year `.seg-toggle` when more than one year is selectable — the displayed year plus every year in `years`, hidden when that set has one member. The seeded data has 2025 and 2026 from the start. `.seg-btn` is already 44px and already announces state, so the years reuse it rather than inventing a chip.
- Twelve month groups, each headed by the month name in the `.member-list .shop-group-hd` treatment (sticky, uppercase, `--t2`). A month with no drill carries a quiet `No UTA` marker in its header.
- Drill rows: `11–13 Sep` at 600, then `UTA` and `· 3-day` when it applies. Past drills are struck through in `--t3-nav-text` (never `--t3`, which fails AA as text). The next drill is marked by weight plus a `Next` chip on `--ok-bg`/`--ok` — **no side stripe, no left border, no inset shadow**.
- Event rows: `12–18 Apr`, then the title and location (`RADR · Dobbins ARB, GA`), attendees on a second line in `--t2`, truncated to two lines with the full text in `title=`. A `Complete` chip on `--ok-bg`/`--ok`, `Cancelled` on `--urg-bg`/`--urgent`; a scheduled event carries no chip, since scheduled is the unremarkable case.
- Admins see `+ Add drill` and `+ Add event`, and a 44px pencil per row.

### 8.5 Editors

Three modals, injected once into `document.body` by their modules, on the existing `.modal-backdrop > .modal-sheet > .modal-hdr / .modal-field / .modal-submit` markup (the `#student-modal` shape), using the page's `openModal`/`closeModal` (focus trap, `role="dialog"`), `uiToast` and `uiConfirm`:

- **Duty:** name (required), primary, alternate.
- **Drill:** start, end (native `type="date"`), note.
- **Event:** title (required), location, start, end, attendees (textarea), status (select), note.

Each shows a secondary **Delete** when editing, behind `uiConfirm`. Save → `POST`/`PATCH` → toast → re-fetch. A 400 or 409 shows the server's message and leaves the modal open. Saving a drill or event switches the view to the year it belongs to, so a 2027 entry is visible at once.

Modals rather than inline editing: the app already edits this way in five places, and the product register puts consistency above novelty for a surface two people touch monthly.

### 8.6 Files, states and motion

Two new modules, `public/duties.js` and `public/calendar.js`, loaded `defer` beside `ui.js`, each exposing exactly one global (`dutiesInit({ canEdit })`, `calendarInit({ canEdit })`) and taking `canEdit` as an argument rather than reaching for page state. `index.html` (8,495 lines) does not grow beyond markup, CSS and the two toggle functions. Feature CSS lives in the page `<style>`, scoped under `.duty-list` and `.cal-list`.

Every view has four states: `.skeleton` while loading (never a spinner), a quiet "needs a connection" note on failure, an empty state that teaches (`No duties yet — add the first one above` for an admin, `Nothing on the calendar for 2027` for an empty year rather than twelve No-UTA lines), and the populated list. Both views are online-only; nothing here joins the offline cache, and the page's existing offline toast suppression applies.

No new motion. The `.seg-btn` transitions already exist; nothing animates a layout property.

## 9. Newsletter

Deck order unchanged: Additional Duties stays slide 9, RSD Schedule stays slide 23.

- `from-db.js` emits `data.duties` and `data.calendar = buildYear(drills, year, reference)` where `reference` is the **cycle's `start_date`**, falling back to today for a legacy cycle with none. That reproduces the partial's own convention: drills that ended before this UTA are struck through, this UTA's drill is bold, later ones plain.
- `slides.js` gains `additionalDuties(d)` — two side-by-side three-column tables split at `ceil(n/2)` at the partial's 8.5px, blank owners as `—`, a needs-owner row in the deck's existing `.red` — and `rsdSchedule(d)`, one line per entry with `<s>` for past, `<b>` for next, `(3-Day Drill)`, the note, and `NO UTA JULY 2026` for gaps. The title takes its year from the data instead of the hard-coded "CY 2026".
- `render.js` drops `additional` and `rsd` from `STATIC_SLIDES`; those two partials are deleted.
- **`meets-radr.html` stays a hand-edited partial.** `calendar_events` feeds the app only this round; see §14.
- **Dead code removed in the same PR:** `from-sample.js`, `preview-server.js`, and the sample-path references in the `shape.js` and `from-db.js` headers.
- Self-containment holds by construction — tables and lists — and `test/newsletter-http.test.js` keeps enforcing it.

## 10. Key flows

1. **Who handles DTS?** Resources → People → Additional duties → type "dts" → the certifiers, the ODTA and the support trio. Two taps and a word.
2. **An owner PCSes.** Admin opens the row's pencil, clears Primary, saves. Everyone sees `Needs owner` immediately; the next newsletter prints the row red.
3. **When is the next drill?** Resources → Calendar → the `Next` chip. Past drills struck through, so the year reads as progress.
4. **Is Fowler at RADR in April?** Same view, April group, the event row names him.
5. **December: next year's dates.** Admin adds ten drills; a `2027` chip appears for everyone. The December newsletter still prints CY 2026, because that cycle's start date is in 2026.
6. **First deploy.** The boot block creates three tables and seeds 52 duties, ten drills and ten events. Nothing to run by hand.

## 11. Edge cases

- Renaming a duty onto a case variant of another → 409, modal stays open. Renaming to itself → 200.
- A deletes a row B is editing → B's PATCH 404s → "no longer exists", modal closes, list re-fetches.
- A drill edited to overlap another → 409 naming the other drill. A PATCH never conflicts with itself.
- Reference date inside a drill (drill weekend) → that drill is `next`, highlighted, not struck.
- An event spanning two months is listed once, in the month it starts. An event in a month with no drill sits under a header that still says `No UTA`.
- An event whose `end_date` is in a different year from its start appears under its start year only.
- Current year empty but another year has rows → the empty note plus a chip for the other year.
- 23 names in `attendees` → two lines, ellipsis, full text in `title=`.
- `&`, `<`, `/` in names (`R&O`, `T. Davis`) → escaped on every path.
- Offline → the connection note, no toast storm.
- Over-long or malformed input → 400 naming the field.

## 12. Testing

Repo conventions: `<feature>.test.js` for pure `lib/` units, `<feature>-http.test.js` for real HTTP against a throwaway Postgres via `test/helpers/db.js`.

- **`test/drill-calendar.test.js`** (unit): the seed shapes; `buildYear` (ten drills, one July gap, order, two-month coverage, `threeDay`, `past`/`next` including a reference date inside a drill, `Date` inputs, other years ignored, empty year); `label`; `years`; `validateDrill`; `overlaps`. Plus `buildCalendar`: twelve month groups, `noUta` on the month not as a row, an event and a drill in one month sorted by date, a two-month event listed once under its start, `next` on drills only, events pulling extra years into `years`.
- **`test/duties-http.test.js`**, **`test/drill-dates-http.test.js`**, **`test/calendar-events-http.test.js`**: 401 signed out; a 403 matrix of member / supervisor / leadership-without-the-capability against every write route, table-driven as `test/roster-http.test.js` does; admin CRUD round-trips; the 400s and 409s of §7; 404s on unknown ids; a plain member can read; `updated_by_id` stamped. `GET /api/calendar` returns the right months, `years` across both tables, and an empty year.
- **Seed-on-create**, per table: drop it, `ensureTable` → `{ created: true, seeded: n }`; again → `{ created: false }` and no change; delete a row, again → still gone.
- **`test/newsletter-http.test.js`** extended: a duty and a drill inserted appear in the deck; a blank-primary duty carries `red`; a drill that ended before the cycle's start is inside `<s>`; still 23 slides; still self-contained.
- **Front end** has no automated harness, so verification is the handoff's practice: preview server against staging, then a phone at 375px — five tab labels on one line, both toggles, admin versus member, dark mode, the offline note, and a contrast check on the new text roles in both themes.

## 13. Rollout and housekeeping

One branch (`claude/resources-duties-calendar`, off `e13f411`), one PR; CI gates the deploy. No existing table changes, no data migration. Reverting restores the two deleted partials and leaves three unused tables, which is harmless.

Docs in the same PR: `MEMORY.md` §5 and §12; the stale "four tabs" comment at `index.html:1900`; the `shape.js` and `from-db.js` headers.

## 14. Out of scope / future

- **Retiring `meets-radr.html`.** `calendar_events` models it, so slide 11 could read the table — deferred by decision this round. The DFT block's 23-name paragraph and the slide's intro prose need their own look.
- **`/build` pre-fill** from `drill_dates` when creating a cycle. Natural follow-on.
- **Member-linked owners and attendees.** Would enable "your additional duties" and "your TDYs". Owners include state employees, `EVERYONE` and blanks, so free text stays until there is a reason.
- **Per-member or per-shop calendar scoping.** Everything here is squadron-wide. Member availability (spec #2 of three) is the per-person axis and will render on this calendar when it lands.
- **A leadership vacant-duties readout** beyond the tag everyone sees.
- **The other six partials** — safety, awards, MEETs/RADR, additional training, measurements, dental buckets — unchanged.

## Appendix A — What rev. 2 changed, and why

Rev. 1 put the drill dates in Useful Links and the duties in bordered cards. A `/impeccable shape` pass on the implementation plan, run against the codebase's own design record, changed five things.

**The tab restructure (owner's proposal).** Rev. 1 spent no tab and hid a calendar inside "Useful Links". Merging the two calculators frees a slot for a real Calendar tab and shortens the strip from 48 to 35 characters of label. The Calendar then earns TDY and training events, because `meets-radr.html` turned out to be a dated event list already.

**Four regressions caught in rev. 1's CSS**, each against a standard this codebase documents:

| Rev. 1 | Problem | Rev. 2 |
|---|---|---|
| `box-shadow: inset 3px 0 0 var(--ok)` on the next drill | The banned side-stripe accent. The July critique records the codebase as clean of them | Weight plus an `--ok-bg`/`--ok` chip |
| `--t3` for past drills, no-UTA months and field labels | `design.css:26`: strokes and icons only, fails AA as text. Already the cause of 13 flagged Resources failures | `--t3-nav-text` |
| `background: var(--warn); color: var(--bg)` chips | Invented pairing, unverified contrast, unlike every other badge | The measured `--wrn-bg`/`--warn` pairs |
| 36px year chips | Below the 44px norm two audits enforced | `.seg-toggle`, already 44px and already announcing state |

**52 bordered cards became a divider list**, on the `.member-row` idiom — roughly half the scroll height, consistent with the calendar rows beside it, and clear of the identical-card-grid ban.

**No vacancy count.** Rev. 1's shape pass proposed `52 duties · 2 need owners`; the owner chose the inline tag alone.
