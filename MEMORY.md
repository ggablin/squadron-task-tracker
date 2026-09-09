# 108th CES UTA Task Tracker — Project Handoff

> Purpose of this file: give a new engineer/agent everything needed to be productive on this app in one read. It documents scope, architecture, the monthly data-update workflow, what's built, and what's left. Last updated 2026-08-20 (mobile app, push notifications, offline reads; see the note below).

---

> **The tracker is an installable phone app with push notifications and offline
> reads as of 2026-08-20.** Read [`docs/2026-08-19-mobile-app-handoff.md`](docs/2026-08-19-mobile-app-handoff.md)
> before touching the service worker, icons, notifications, the theme or the
> offline layer — it records the platform traps (Android silhouettes the
> notification badge; this app's SPA catch-all returns 200 + text/html for any
> missing file, so status codes lie; `unregister()` does not terminate a worker
> that is still controlling the page) and what is deliberately still undone.
>
> **The service worker now has a `fetch` handler and caches the app shell.** That
> is the one artifact here that a git revert cannot undo — it lives on each
> member's phone. The only way to retire it is `SW_MODE=kill` on the Railway
> service (§8). **That switch has never been rehearsed on a real device**, which
> is the top open item in §10.

## 1. TL;DR / where things live

- **What it is:** a mobile-first web app that turns the 108th Civil Engineer Squadron's monthly UTA (drill weekend) task newsletter into a per-person, checkable task list, with roll-up dashboards for supervisors and leadership.
- **Live app:** https://108ces.up.railway.app
- **Repo:** https://github.com/ggablin/squadron-task-tracker (default branch `master`)
- **Hosting:** Railway. Project `reasonable-curiosity`, service `squadron-task-tracker`, plus a `Postgres` service, `production` environment. **Auto-deploys on push/merge to `master`** (GitHub integration; no `railway.json`/Procfile — Nixpacks auto-detect + `npm start`).
- **The code repo lives in a subfolder.** The Claude Code project folder is `.../108 CES/Squadron Task Tracker/`, which contains:
  - `squadron-task-tracker/` — **this repo (the app)**
  - `CLAUDE.md` — the original *planning-phase* context doc (now historical; predates the build)
  - `sample newsletter *.pdf`, `Structures_ToDo_May2026_RSD.pdf` — the source newsletters the app replaces
  - `prototype.html` — an early static prototype (not used)
- **Also read:** `DEMO-BRIEFING.md` in this repo — a feature tour / briefing guide aimed at leadership.

---

## 2. Scope & the problem it solves

The squadron (~70 members, 9 shops + squadron staff) gets a ~20-slide PDF newsletter each UTA, organized **by topic** (one slide for CBTs, one for dental, one for PT tests, etc.). Every member has to scan all slides hunting for their last name to build their own to-do list. That's slow and error-prone.

This app re-slices the same data **by person**: each member logs in and sees only their tasks, checks them off (state persists), and supervisors/leadership get live roll-ups. The PDF newsletter can still exist as a formal artifact; the app is the working tool. Hard constraints that shaped the design: free/near-free, no CAC/.mil auth (members use personal phones), nothing sensitive stored (admin tracking only — names, ranks, "PT test due"), and **adoption/low-friction is the binding constraint**, so the maintenance burden on the training NCO (MSgt McNaughton) must go *down*, not up.

---

## 3. Tech stack & architecture

- **Backend:** Node.js + Express (`server.js`, single file, ~1000 lines). PostgreSQL via `pg`. Sessions in Postgres via `express-session` + `connect-pg-simple` (30-day httpOnly cookie; `secure` when `NODE_ENV=production`).
- **Frontend:** a **single-file SPA** at `public/index.html` (~3,600 lines: inline `<style>`, HTML, and one inline `<script>`). No build step, no framework. Served statically by Express; all routes fall back to `index.html`.
- **Auth:** username = `slug` (lowercased last name) + password. `bcrypt` (cost 10). Initial password = the slug (last name). `must_change_password` forces a new one on first login. Three roles: `member` < `supervisor` < `leadership` (`requireAuth` / `requireRole` middleware).
- **Email:** `nodemailer` over SMTP. **Scheduled jobs:** `node-cron` inside `server.js` (see §7).
- **Design system:** warm editorial look — cream/terracotta/sage palette, **self-hosted General Sans** font (`public/fonts/*.woff2`), custom SVG tick-gauge, full dark mode. Mobile-first (bottom tab nav) with a desktop sidebar.

### Data model (`schema.sql`)
`shops` · `uta_cycles` (one is `is_current`) · `task_categories` · `members` · `tasks` · `task_completions` (per-task state: none/partial/done + note) · `shop_events` (per-shop schedule/work-order/emphasis rows, work orders have a `status`) · `squadron_events` (the squadron-wide timeline) · `notifications` (single table backing both in-app + email) · `session` (connect-pg-simple).
Schema is applied by `seed.js`; `server.js` also runs idempotent `ADD COLUMN IF NOT EXISTS` migrations on boot.

---

## 4. The three tiers (what each role sees)

All three nav tabs are visible to everyone; per-section gating hides what a role shouldn't act on.

- **My Tasks (member):** hero gauge + stats + "progress by category" bars, then the member's task list grouped by category with tap-to-complete checkboxes and per-task notes. Sub-tabs: **My Tasks / Timeline / Work Orders**. Timeline = the squadron_events schedule for the UTA.
- **My Shop (supervisor):** shop gauge + per-member bar chart, the shop schedule, and an expandable member roster. Supervisors can add/delete/flag tasks for their shop's members, manage shop schedule items and work orders (status tracking), and **reset a member's password**. Leadership can switch which shop they're viewing (shop switcher).
- **Squadron (leadership):** org chart / chain of command (visible to all), plus leadership-only roll-ups: squadron completion gauge, completion-by-shop and by-category charts, "members most behind," an all-shops list, leadership **bulk task creation**, and a "Generate Newsletter" button (`GET /newsletter` — shipped and live, see §9).

---

## 5. Features built to date

- Per-person task lists with persistent completion state + member notes.
- Supervisor/leadership roll-ups and dashboards (gauges, bar charts, health colors).
- Shop schedule, work orders (with status + history), squadron timeline.
- Org chart / chain of command derived from member `flight`/`position`/shop.
- **Notifications:** in-app center (bell, 60s polling) **and real phone push** (opt-in, added 2026-08-19). The email channel is built but **has never been configured in production**, so push is the first out-of-app channel members actually receive (see §7). Includes a "your tasks are live" blast when a cycle is imported, and daily completion digests (digests are email-only and deliberately do not push).
- Leadership bulk task creation; shop switcher for flight-level leaders.
- Dark mode, self-hosted font, mobile + desktop layouts.
- **Auth hardening (shipped 2026-06-20, PR #30):** all user input escaped in the member task renderers (stored-XSS fix); fixed broken leadership health-color tokens; UTA label now derived from data (not hardcoded); **change-password** flow + **forced change on first login** (`must_change_password`) + **admin password reset** (supervisor: own shop, leadership: any — generates a random one-time temp, forces a change); checkbox keyboard/ARIA; AA contrast fixes; self-hosted General Sans; stronger "overdue" color. See §8.
- **Task Builder + Records (shipped 2026-07-06):** leadership-only `/build` (author a cycle in-browser: copy-forward + new tasks + review + go-live, with undo) and `/records` (per-member historical completion, read-only). Replaces the Excel/CLI workflow as the normal monthly path; retires the destructive full-replace risk for day-to-day use. Full detail in §6a.
- **Rollout-feedback batch (2026-08-10, from the first partial rollout):**
  - **Student Flight (First Sergeant):** `members.is_student_flight` + four pipeline dates (`bmt_start/bmt_grad/tech_start/tech_grad`) + `student_notes`. Managed entirely from a Squadron-tab card (any leadership, no roster-admin needed): add member / edit dates / remove (dates survive removal). API: `GET /api/squadron/students` (also returns `candidates` for the picker), `PATCH /api/squadron/students/:id`. Dates travel as `YYYY-MM-DD` strings both ways (`to_char` out, regex-checked in).
  - **Squadron category drill-in:** every row of the "Squadron by Category" card expands to task titles with done/total and chips naming exactly who hasn't completed each, with an **Away** badge for members attendance marks absent. `GET /api/squadron/categories/:code/tasks` (leadership).
  - **Present-vs-all percentages:** an "All members / At drill" toggle on the Squadron stats pane re-renders gauge, shop chart, category card, and most-behind list. Presence rule lives in `lib/presence.js`: a member is present unless attendance rows exist for the cycle and none is `present`/`agr_at_orders` — unmarked counts present, so both numbers match until attendance is marked. Both flavors ship in the same payloads (`*_present` columns on `/api/squadron` + `/api/squadron/categories`; `/api/squadron/members?present=true` is its own top-10).
  - **My Shop category view:** "By member / By category" toggle on the Members pane (supervisors/leadership only). Category view groups category → task → member chips (tap to toggle done, away badge). `GET /api/shop/tasks` (supervisor own shop; leadership any via `?shop_id`).
  - **Task helpers:** `tasks.link_url` + `tasks.document_id` (FK → Resources documents). Members get "Open link" / form-download pills on the task; bare URLs in details are auto-linkified. Authorable everywhere: supervisor Add Task, leadership bulk add, `/build` new-task + live-add + group editor; carried by copy-forward. Validation shared in `resolveTaskHelpers` (server.js): http(s) only, active documents only.
- **Resources restructure + reference data (2026-08-23):** the tab strip became five subject-shaped tabs — **Calculators · Forms · Links · People · Calendar** — and two more newsletter partials became tables.
  - **Calculators:** PT and Promotion now share one tab behind a `.seg-toggle` (`setCalcView`). Their panes keep their ids and only swapped `.res-pane` for `.calc-view`, so no calculator code changed. This freed the slot Calendar took.
  - **People** (the renamed Org Chart tab): chain of command | **additional duties** (`additional_duties`), a filterable divider list; a blank primary owner renders a **Needs owner** chip. `GET /api/duties` (any member), `POST/PATCH/DELETE` (roster admins). Logic `lib/duties.js`, UI `public/duties.js`.
  - **Calendar:** the year as one chronological stream — twelve month groups, drill weekends (`drill_dates`) and TDY/training rotations (`calendar_events`) interleaved, `No UTA` on months without a drill, past struck through, next chipped, year picker once a second year has rows. **One read endpoint,** `GET /api/calendar?year=`, returns the year already derived; writes are `/api/drill-dates` and `/api/calendar-events` (roster admins). Drills refuse to overlap each other and cap at seven days; events do neither, because rotations overlap and a DFT runs a fortnight. Logic `lib/drill-calendar.js` (pure derivation, shared with the newsletter) and `lib/calendar-events.js`, UI `public/calendar.js`.
  - **Seed-on-create:** each table is loaded from `data/additional-duties.js` / `data/drill-dates.js` / `data/calendar-events.js` only in the boot that creates it (`ensureTable`), so production will get 52 duties, ten drills and ten rotations on the first deploy that carries this branch, and deleted rows never return afterwards. `schema.sql` carries the CREATEs empty for the tests, which apply it directly; the boot block is the only thing that ever seeds these three tables.
  - Newsletter slides 9 (Additional Duties) and 23 (RSD Schedule) render from the tables, relative to the cycle being printed. **MEETs/RADR (11) stays hand-edited** even though `calendar_events` models it — retiring it is a follow-on. `newsletter/from-sample.js` and `newsletter/preview-server.js` were removed (dead since 2026-08-17).
  - Design constraints this work had to honour, all from `.impeccable/` and `design.css`: `--t3` is strokes/icons only (use `--t3-nav-text`), status chips use the measured `--ok-bg`/`--ok` style pairs, no side-stripe accents, 44px targets, toggles are `role="group"` + `aria-pressed`.

---

## 6. ⭐ How the monthly UTA data is uploaded / updated

**The normal path is now the in-browser Task Builder at `/build`** (leadership-only). McNaughton logs in with his leadership account, builds next month's cycle himself, and goes live — no Excel workbook, no CLI, no one else's laptop required. See §6a for the full Task Builder + Records feature; this section keeps the mechanics of the legacy Excel/CLI path, which remains as a backup/bulk-load option.

### Members (one-time / when roster changes) — `import-members.js`
Imports/updates the ~70-member roster from a spreadsheet. Sets each member's initial password to their slug (last name), `bcrypt`-hashed. Run when onboarding the unit or when people join/leave. (Roster import is unaffected by the Task Builder — it's still the CLI path.)

### Legacy/backup: monthly tasks + schedule — `import-tasks.js`
```
node import-tasks.js <template.xlsx> ["Cycle Name"]
# e.g. node import-tasks.js "May 2026 UTA - Sample Template.xlsx" "May 2026 UTA"
# Cycle name defaults to the filename text before " - ".
```
The workbook has one sheet per task category plus schedule sheets:
- **Task sheets:** `Admin`, `CBT`, `Medical`, `Upgrade`, `Mobility`, `Other`. Columns: `slug` (member last name, lowercased), `Title`, `Urgency` (this uta / next uta / overdue / future / info), `Details`, `Appt Day`, `Appt Time`, `Appt Location`. Rows keyed to members by `slug`; unknown slugs are skipped with a warning.
- **`Work Orders`** sheet → `shop_events` (event_type `work_order`), keyed by `Shop`.
- **`Shop Schedule`** sheet → fans out into `shop_events` (per shop; a shop of `ALL` fans to every shop) **and** `squadron_events` (the timeline, grouped by day/time/title, with auto-detection of concurrent events and shop chips).

What the script does: finds/creates the named `uta_cycle` and marks it `is_current` (deactivating others) → ensures categories exist → **deletes all tasks, task_completions, and shop_events for that cycle** → re-imports everything → inserts a per-member "your tasks are live" notification.

**⚠ CRITICAL CAVEAT — it is a destructive full-replace for the cycle.** Re-running `import-tasks.js` for a cycle that's already in progress **wipes members' completion progress** (it deletes `task_completions`). It's designed to be run once when the cycle's data is finalized. To *add* tasks mid-cycle without wiping progress, do NOT re-run this script — use `sync-tasks.js` (additive insert) or, preferably, the `/build` tool's "add task" flow against the live cycle (see §6a).

**Convention: one path per cycle.** Don't mix the Task Builder and the legacy CLI on the same cycle — `import-tasks.js` doesn't know about `task_batches`/draft-live state and its destructive full-replace would blow away builder-authored data. This is a documented convention, not code-enforced in v1 (see §6a "out of scope").

### Where the template comes from
Nowhere, anymore. Two generator scripts (`generate-sample-template.js` for the Excel
template, `generate-sample-newsletter.js` for a sample newsletter) once lived uncommitted in
the maintainer's working copy; both were **deleted on 2026-08-17** as obsolete (see §9).
They were only ever needed for a legacy-CLI bulk load, and `/build` has been the normal path
since 2026-07-06. If a legacy bulk load is ever needed again, hand-build the workbook to the
column spec above, or copy an existing `*.xlsx` from the project folder — do not go looking
for a generator script.

### Other data helpers
- `seed.js` (`npm run seed`) — one-shot initial DB setup: applies `schema.sql` and seeds the Structures shop + sample members/tasks/events. **Destructive** (re-seeding resets seeded members' passwords and tasks). For initial bring-up / local dev only, never against a live cycle.
- `update-shop-schedule.js` — helper for the shop schedule.
- `data/squadron-events.js` — default squadron timeline events used by the seed.

## 6a. Task Builder + Records (shipped 2026-07-06)

A leadership tool to author each UTA cycle in-browser and review member history, replacing the Excel/CLI workflow as the normal monthly path. Full design detail: `docs/superpowers/specs/2026-07-06-task-builder-and-records-design.md`. Implementation ledger (task-by-task): `.superpowers/sdd/progress.md`.

**Schema additions** (idempotent migrations, both in `schema.sql` and the `server.js` boot-migration block):
- `uta_cycles.status` — `draft` / `live` / `archived`. `is_current` keeps its old meaning (the one live cycle members see); `status` layers cycle lifecycle on top. Exactly one row can be `live` at a time, enforced **at the DB level** by a partial unique index, `uta_cycles_one_current` — this is the real backstop against ever having two live cycles, even under a concurrent go-live race.
- `task_batches` table + `tasks.batch_id` (nullable FK) — every add or copy-forward group done through the builder is a "batch," which makes it undoable as a unit. Legacy/imported rows have `batch_id = NULL`.

**New `lib/` module layer** — a first for this codebase (previously everything lived in `server.js`). Express routes are now thin, role-gated wrappers over these:
- `lib/db.js` — shared pg pool (single source of truth for the connection, used by the app and by tests).
- `lib/cycles.js` — `listCycles`, `createDraft`, `goLive` (the draft→live / live→archived atomic cutover), `discardDraft`.
- `lib/tasks.js` — `assertTaskInLiveCycle` (the immutability gate, see below), `listGroups` (copy-forward/recurring catalog), `addTaskBatch`, `copyForward`.
- `lib/batches.js` — `listBatches`, `undoBatch` (deletes a batch's tasks + completions + the batch row; blocks with a count if members already checked things off, unless forced).
- `lib/records.js` — `memberHistory` (per-cycle, newest-first, done/total + drill-down), `getMemberShopId`.

**New endpoints** (all `requireAuth` + `requireOnboarded`; authoring endpoints are `requireRole('leadership')`; Records is leadership-any-member or supervisor-own-shop):
- `GET/POST /api/cycles`, `POST /api/cycles/:id/go-live`, `DELETE /api/cycles/:id` (draft only)
- `GET /api/cycles/:sourceId/groups` (copy-forward/recurring catalog), `POST /api/cycles/:id/copy-forward`
- `POST /api/cycles/:id/tasks` (new task, by member + urgency, batched)
- `GET /api/cycles/:id/batches`, `DELETE /api/batches/:id` (undo)
- `GET /api/members/:id/history` (Records drill-down)

**Two new leadership pages:**
- **`/build`** — the authoring tool (evolved from the earlier static `public/task-builder-mockup.html`). Flow: start a draft cycle → copy forward recurring groups from last cycle (appointment day/time/location intentionally dropped on copy; inactive members skipped) → add new tasks by tapping members and setting urgency (supports multiple urgency groups in one pass) → review → **go live** (atomic cutover + notifies all active members). Any batch can be undone, with a confirm-and-force flow if members already checked off tasks in it. The same tool also works against the **live** cycle for a mid-cycle add — this retires `sync-tasks.js` as the normal path too (kept as backup).
- **`/records`** — browse members (grouped by shop, searchable; supervisors see only their own shop), drill into a member's per-cycle history (done/total, task-level done/not-done + notes). Read-only.
- Both pages are server-gated: only served to a logged-in session, redirect to login otherwise. Note: the page **shell** is served to any logged-in user; it's the mutating APIs underneath that are leadership-gated (a non-leader sees an empty/403'd shell). This is an intentional posture, not an oversight — flagged in the final branch review as a design note to confirm.

**History immutability:** completion writes are gated to the **live** cycle only. `assertTaskInLiveCycle` guards `PUT /api/tasks/:id` (the completion-toggle route) and rejects with `403` if the task's cycle isn't the current live one. Archived cycles are therefore frozen — a permanent, per-member snapshot of where they ended each month, safe for Records to display without fear of retroactive edits.

**Tests:** first automated test tooling in this repo — this branch added 22 tests across `cycles`, `tasks`, `batches`, `records`, `immutability`. (The `test/*.test.js` glob has grown well past that since; see §12 for the current total.) Run against a disposable Postgres via `TEST_DATABASE_URL`:
```
TEST_DATABASE_URL=<pg-connection-string> ENABLE_CRON=false node --test --test-concurrency=1 test/*.test.js
```
`--test-concurrency=1` is required — test files share one DB, so parallel file execution causes cross-file interference. Covers the data-safety invariants: exactly-one-live-cycle after go-live, additive-add dedup counts, copy-forward correctness (drops appointment fields, skips inactive members, one batch per group), batch undo (with checked-off guard), and completion-write rejection on non-live cycles.

**Local preview scaffolding (gitignored, not part of the deployed app):** `preview-run.cjs` runs the app against a throwaway seeded database for manual/browser verification. The outer `.claude/launch.json` (one directory above this repo) has a `"preview"` configuration that launches it on port 3100. Both are dev-only tooling, excluded from version control.

---

## 7. Notifications (in-app + email)

> **⚠ Email has never actually sent in production.** The production service has no `SMTP_*`
> variables set (verified 2026-08-17 — only `DATABASE_URL` and `SESSION_SECRET` are), so
> `mailer.js` no-ops by design and every `notifications` row still has `emailed_at IS NULL`.
> Until push shipped on 2026-08-19 the in-app bell was the only channel members had ever
> received; push is now the first out-of-app one. **Before configuring SMTP,
> run `UPDATE notifications SET emailed_at = NOW() WHERE emailed_at IS NULL`** — otherwise
> the next flush emails the entire backlog since launch, 200 rows every 5 minutes.

- **In-app:** `notifications` table; the SPA polls the bell every 60s. `notify()` in `server.js` writes rows (e.g., task assigned, tasks-live). There is a second insert site: `notify-digests.js` writes `completion_digest` rows directly.
- **Push (added 2026-08-19):** real phone notifications. `lib/push.js` is a *flush* job shaped like `notify-emails.js`, not a send inside `notify()` — so `web-push` never runs in a request, both insert sites are covered, and a failed send simply retries on the next tick. `notify()` kicks a flush via `setImmediate`; a 1-minute cron is the catch-up. Rows are stamped `notifications.pushed_at`. Subscriptions live in `push_subscriptions`, keyed on `endpoint` (browsers rotate them). Digests are deliberately excluded — see `PUSH_TYPES`. No-ops when `VAPID_*` is unset, exactly as email no-ops without SMTP.
- **Email:** `mailer.js` = `nodemailer` over SMTP. `notify-emails.js` flushes queued emails; `notify-digests.js` builds daily completion digests. Both are runnable by hand and are driven on a timer by cron in `server.js`:
  - `cron.schedule('0 21 * * *', …)` → **completion digest daily at 21:00**.
  - `cron.schedule('*/5 * * * *', …)` → **flush pending emails every 5 minutes**.
  - `cron.schedule('* * * * *', …)` → **push catch-up every minute** (covers the digest insert site and any failed send).
  - Disable all cron with `ENABLE_CRON=false` (use for local/dev and one-off scripts so a CLI run doesn't also fire jobs).

---

## 8. Deployment, environment, and running locally

**Deploy:** merge/push to `master` → Railway auto-builds and deploys the `squadron-task-tracker` service. Verify at https://108ces.up.railway.app (`/` → 200, `/api/auth/me` → 401 means healthy). Boot runs idempotent migrations, so schema changes via `ADD COLUMN IF NOT EXISTS` ship safely.

**Environment variables.** The table below is the full set the code *reads*, not the set that
is *configured*. On the production service only **`DATABASE_URL` and `SESSION_SECRET` are
actually set** (verified 2026-08-17); `PORT` is injected by Railway, `NODE_ENV=production`
comes from the Railpack builder's defaults rather than from anyone setting it, and the rest
are absent — which is why email is a no-op (§7) and cron runs (opt-out, so unset = on).
The builder is **Railpack**, which also resolves Node to `lts` unless `engines.node` pins it.

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (SSL auto-enabled when the URL contains `railway`) |
| `SESSION_SECRET` | session cookie signing |
| `NODE_ENV` | `production` → secure cookies |
| `PORT` | set by Railway |
| `ENABLE_CRON` | `false` disables the cron jobs (default: on) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | nodemailer transport (email is a no-op if `SMTP_HOST` is unset) |
| `MAIL_FROM` | email From header |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push. **Production and staging hold DIFFERENT pairs** — a shared pair would let a staging test buzz real members' phones. Push no-ops if unset. |
| `SW_MODE` | `kill` serves the self-destructing service worker instead of the real one. The only way to retire a worker already on members' phones — flippable from a phone, no deploy. |

**Run locally:** needs a Postgres. There's no local Postgres/Docker on the maintainer's machine by default.
```
# with a throwaway local Postgres (e.g. Docker):
$env:DATABASE_URL = "postgres://postgres:dev@localhost:5432/ces"   # PowerShell
npm install
npm run seed      # applies schema + sample data; prints initial passwords (= last names)
$env:ENABLE_CRON = "false"
npm start         # http://localhost:3000
```
Seeded test accounts (local): members `becerra`/`derose`/`fowler`/`glenn`/`gradaille`/`mesa`, supervisors `ebbert`/`uzoma`, leadership `gablin`/`mcnaughton` — password = the slug, then forced change on first login. (Do NOT run `seed.js` or `import-tasks.js` against production — both are destructive.)

**The preview DB is multi-shop as of 2026-07-28.** `seed.js` alone builds a *single-shop* fixture (Structures only, 10 members) — its header says as much. That shape silently hides every multi-shop bug: the leadership shop switcher has nothing to switch to, roll-up ordering can't be distinguished, and cross-shop authorization can't be exercised without hand-built scaffolding. The preview DB has since had `import-members.js` run over the top of the seed (`DATABASE_URL=<preview> node import-members.js`, reading `../Members.xlsx`), giving **10 shops / 61 active members**. Keep it that way; re-running bare `seed.js` reverts to the one-shop fixture. The 51 imported accounts got random one-time passwords printed only to that run's stdout — use the ten seeded accounts above for testing, whose passwords the import preserved.

**Note on the SSL heuristic:** `server.js`/scripts enable Postgres SSL only when `DATABASE_URL` includes the substring `railway`. Railway's public proxy host is `*.rlwy.net` (no "railway"), so connecting a local process to the Railway DB can hit an SSL mismatch — a local Postgres (SSL off) is the clean path.

---

## 8a. Three bug families this codebase keeps producing

The colour family has surfaced four times, the date family **five** — four across PRs #84 and #85 and a fifth on 2026-08-25, found by a review of the branch that documented the family in the first place — and the literal-filter family **four**, all four found at once on 2026-08-28 by diffing the generated newsletter against the newsletter it replaces. Different files, different people, months apart. None is subtle once you know to look, and all three are one `grep` away — provided the `grep` is aimed at the whole codebase, which the date one was not until that fifth instance made the gap obvious. **Check these before writing a colour, serialising a date, or selecting rows by a string you typed.**

### A hardcoded colour on a token-coloured background

The theme tokens **invert**. `--text` is near-black in light mode and near-**white** in dark. So a rule like `background: rgba(255,255,255,.22)` sitting on a `var(--text)` surface is legible in the theme it was authored in and invisible in the other.

Found in: the active-tab notification badge (measured **1.22:1** in dark — invisible, shipped for months); `.duty-owners` as `--t2` on a `--wrn-bg` tint (4.34:1, under AA); `build.html`'s `.btn-ghost-inv` on `.cycle-bar` (the `+ New cycle` button vanishes on `/build`); and `index.html:919` using `--t3` as text.

`design.css:28-32` already states the rule that catches all of these — *"Each foreground is checked against its own `-bg` pairing, not against `--bg`"* — and `build.html:263` shows someone hitting the inversion and correctly flipping white→black for dark. The knowledge exists; it just is not applied consistently.

```
grep -nE "rgba\(0,\s*0,\s*0|rgba\(255,\s*255,\s*255" public/*.html public/*.css
```
For each hit, ask what `var(--…)` surface it sits on and whether that token inverts. **Measure in both themes** — and measure *after* the transition settles (see §8b).

### A bare `DATE` column reaching `res.json` or `toISOString`

node-postgres parses a `DATE` column to **local** midnight, not UTC. Read it back with `toISOString()` — or let `JSON.stringify` do it — and in any timezone ahead of UTC you get the **previous day**.

Found in: the newsletter's cycle reference date (a 1 January cycle would have printed the previous year's RSD schedule); `/api/squadron/timeline`; `/api/export/shop-lists` (the printed handout showed **7 August for an 8 August drill** under `TZ=Asia/Tokyo`); `lib/cycles.js:7,50,79` via `server.js:1624`, still unfixed as of #85; and the newsletter **cover's date range** — `fmtRange` in `newsletter/from-db.js`, which printed **10–12 Sep for the 11–13 Sep 2026 drill** under `TZ=Asia/Tokyo` (fixed 2026-08-25, regression test in `test/newsletter-http.test.js`).

That last one is the family's own lesson and worth reading twice: **`to_char`ing the column is not enough if the consumer re-parses the string.** #85 added `to_char(start_date, …) AS start_iso` to the newsletter's cycle query, and `fmtRange` then undid it with `new Date(v + 'T00:00:00')` — no `Z`, so local midnight again. Its other branch took node-pg's `Date` and read `getUTCDate()` off it. **Both** input shapes lost the day; fixing only the string half leaves the pg-`Date` half broken. The fix is `lib/attendance.js`'s `toUTCDate` — local getters for a `Date`, an explicit `'Z'` for a string — which is the one correct implementation of this normalisation and, as noted below, was already flagged here as a non-instance.

Production has **no `TZ` set** on the Railway service, so it runs UTC and this whole family is dormant there — one environment variable from live. `lib/attendance.js`'s `toUTCDate` handles a pg `Date` correctly with local getters and is **not** an instance; do not "fix" it — it is the fix, and `newsletter/from-db.js` now calls it.

**The rule:** dates leave the database as strings. Every lib `SELECT` uses `to_char(col, 'YYYY-MM-DD')`, and the calendar compares dates as plain ISO strings precisely to avoid this. If a `DATE` column is going to be serialised or formatted, `to_char` it in the query.

```
grep -rnE --include=*.js \
  "\b(start_date|end_date|bmt_start|bmt_grad|tech_start|tech_grad)\b" \
  *.js lib newsletter tools data
```

**Scope it to the whole server-side surface, not `server.js lib/*.js`.** The narrow pair was the check's worst failure: it never looked at `newsletter/`, `notify-digests.js`, `seed.js`, `import-tasks.js`, `sync-tasks.js`, `tools/` or `data/` — and the `fmtRange` bug above sat in that blind spot for months while §8a's own found-list already named the newsletter as an instance. `public/` and `test/` are deliberately out: no pg `DATE` reaches them, dates arrive there as JSON strings.

**Do not add `| grep -v to_char`.** The old check ended that way and it is not merely a noise filter, it is a false-negative machine: the filter is line-oriented, so a line carrying a `to_char` for **one** column drops the **bare** columns sitting next to it. `newsletter/from-db.js:42` is exactly that line — `SELECT name, start_date, end_date, to_char(start_date, …) AS start_iso` — and the filter threw it away. Dropping the filter costs 19 extra lines out of 96 and every one of the 19 is a one-glance dismissal. If you want to triage faster, read the hits and ask *which* column on the line is bare; do not let `grep` decide.

**Do not narrow to `SELECT` either.** The obvious version — `grep "SELECT[^;]*start_date"` — misses **three of the five** instances #85 dealt with, for two reasons worth remembering: the queries are **multiline**, so `SELECT` and the column sit on different lines and a line-oriented grep cannot see both; and two of the three `lib/cycles.js` instances are `INSERT … RETURNING` and `UPDATE … RETURNING`, not `SELECT` at all — `RETURNING` serialises columns exactly the same way. (It *would* have matched the two single-line `SELECT`s in `server.js` that #85 fixed. Three of five, not five of five — the advice stands, the absolute did not.)

**Known limitation — the anchor is a hardcoded list of today's `DATE` columns.** A new `DATE` column under any other name is invisible to this check until someone adds it here. The six above are the complete set as of 2026-08-25, and they are declared in **two different shapes**, which is why the old `start_date|end_date` pair looked complete: `start_date`/`end_date` are inline column definitions inside `CREATE TABLE` (`uta_cycles`, `drill_dates`, `calendar_events`), while `bmt_start`/`bmt_grad`/`tech_start`/`tech_grad` only ever appear as `ALTER TABLE … ADD COLUMN` — at `schema.sql:279-282` and again in `server.js`'s boot migration (`:237-240`). A scan that looks for one shape misses the other, so match both:

```
grep -hiE "^\s+[a-z_]+\s+DATE\b|ADD COLUMN IF NOT EXISTS [a-z_]+ +DATE\b" schema.sql server.js
```

(`drill_dates` is a **table**, not a column — its `DATE` columns are `start_date`/`end_date` and are already covered. Putting the table name in the pattern would match every reference to the table and buy nothing.)

The check is noisy by design, which is the correct trade for a standing grep: a false positive costs a glance, a false negative ships the bug. **Verified 2026-08-25:** 96 hits across nine files; it finds all three `lib/cycles.js` sites, correctly shows the two `server.js` sites fixed in #85 as `to_char`'d, and — the whole point of the widening — it finds `newsletter/from-db.js:42` and `:117`, the `fmtRange` site. The old `server.js lib/*.js | grep -v to_char` form returned 68 hits and **zero** of the newsletter's.

### A literal string filter drifting from the data it selects

A shaper picks rows out of a category by comparing a **free-text column** against a string someone typed months ago. The wording in the database changes — an import is rewritten, a title is shortened — and the comparison quietly stops matching. Nothing throws. The section renders its empty state, which says *"nothing recorded in the tracker for this UTA"* over a database that is full.

**That is what makes this family expensive: an empty section and an absent source look identical.** A page that renders cleanly gets no review, so the defect ships every cycle until someone diffs the output against the document it replaces. All four instances below had survived at least one published cycle.

Found in `newsletter/shape.js`, all fixed 2026-08-28:

| Slide | Filter expected | Live data | Cost |
|---|---|---|---|
| Orders / DTS / AROWS | `'Complete DTS Voucher'`, `'Sign RMP in AROWS'`, … | `DTS Voucher`, `Sign RUTA`, `Sign Orders`, `AROWS`, `DTS Authorization` | 16 tasks → `0 open` |
| PT Testing | details matching `/Due (\w{3}) (\d{4})/` | `PT Test Scheduled Saturday @ 1030hrs` | 11 tasks → empty page |
| SGLI & vRED | `'Update SGLI in MilConnect'`, `'Update vRED in vMPF'` | no such task, ever | empty page every cycle; the 20 `GTC CBT`/`SoU` tasks that belong on newsletter p15 had no slide |
| EPBs / OPBs | `title.startsWith('EPB')` | `EPB - Closeout`, `OPB - Closeout` | both OPBs dropped from a slide named for them |

The same family runs in reverse. `shapeInbound` took the **whole** `upcoming` category, and that category holds squadron-wide notices as well as a member's school dates — `Family Day` is assigned to all ~70 members, so the slide printed **84 rows against the newsletter's 16**, burying twelve real departures. Note what does *not* fix it: filtering on `informational`, because `BMT & Technical School` carries `urgency: 'info'` too and that empties the slide instead. Over-broad and over-narrow are one bug — *the predicate does not describe the data* — and only reading the live rows tells you which way it fails.

**The rules.**
1. Prefer a **stable key** (category code, id) over a human-edited display string. Where a literal is unavoidable, match a **word** (`/\bAROWS\b/`) rather than a whole title, so re-wording around it survives.
2. **Never let a filter discard silently.** Return the residue — `shapeInbound` now returns `other` — or count it. `shapePt` has a test asserting every input reaches exactly one of its three outputs.
3. **Distinguish the two empties.** `N > 0 && M === 0` is a bug; `N === 0` is the truth. They must not render the same sentence.

`test/newsletter-shape.test.js` holds the guard: `LIVE_ADMIN_TITLES` is the real August 2026 title inventory, and the deck must either route each title to a slide or name it in `NO_SLIDE_YET`. A title that is neither fails the suite instead of emptying a page. **Re-read that list against production when the import changes** — it is a snapshot, and a snapshot goes stale exactly the way the filters did.

```
grep -rnE "title (===|!==) '|\.includes\(t\.title\)|title\.startsWith\(" newsletter lib
```

**Related, same root cause:** the deck's queries must agree on **which members exist**. `from-db.js` filtered the org chart on `m.active` but not the task query, so two members retired off the roster had their medical requirements printed in a document that leaves the squadron, and the cover counted their tasks — 478 against the app's 471 on the same cycle, while the cover's own comment promised it showed "the same three numbers leadership reads off the app." `/api/squadron` joins `members m ON … AND m.active = true`; anything claiming to match it must too.

---

## 8b. Verification gotchas — these each cost an hour to rediscover

- **The Browser pane's `left_click` hangs**, even with the tab fronted. It is a tool problem, not a page problem. Use `element.click()` via `javascript_tool` for genuine handler dispatch, and prove hittability with geometry instead: `getBoundingClientRect()` then `document.elementFromPoint(cx, cy)`, asserting it returns the element or a descendant. That catches overlays, zero-size boxes and off-viewport controls, and covers every control rather than the one you clicked. `computer {action:"screenshot"}` also fails intermittently with a compositing error.
- **Theme colours animate.** Measuring contrast immediately after flipping `data-theme` returns nonsense — a stale `--text` once produced a bogus 1.06 ratio that looked like a serious defect. Wait for the transition to settle. The app persists its own preference in `localStorage.theme` and `data-theme` on `documentElement`, which **overrides** the browser/OS colour-scheme setting.
- **The service worker precaches `duties.js` and `calendar.js`** (added in #84 so their offline notices can render). A plain reload after editing either file serves the **stale** module. Unregister the worker and clear caches when verifying front-end changes, or you will debug code that is not running.
- **A green local suite does not predict CI.** Local runs go to a *remote* Railway Postgres (~50-100ms round trips, ~13 min); CI uses a *local* one (sub-millisecond, ~6 min). A DDL race that local timing reliably hid failed on the first CI run of #84 — `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`. **What fixes it is an advisory lock, not `app.ready`.** Both schema writers take `acquireMigrationLock` from `lib/db.js:39` — `applySchema()` at `test/helpers/db.js:27` on one side, `server.js:120` around the boot migration on the other — so they queue instead of colliding. `test/helpers/db.js:11-40` is explicit that retrying alone "made that survivable but not reliable… So both sides now take the advisory lock from `lib/db.js`"; the retry loop stayed only as a second line of defence.

  `app.ready` is a narrower, separate thing: it covers **raw DDL written in a test body**, which no lock reaches (`server.js:109-116` says so). Counted against the tree 2026-08-25, across 40 test files: 22 `require('../server')`, **29** call `applySchema()`, and only **5** await `app.ready` — the three files that issue their own `CREATE`/`DROP TABLE` (`calendar-events-`, `drill-dates-`, `duties-http`) plus two that await it belt-and-braces. That leaves **16** files doing lock-protected DDL via `applySchema()` while requiring `server.js` and never awaiting `app.ready` — which is **correct, not a violation**; `test/cycle-name-http.test.js` is one of them. Do not "fix" them by adding an await, and do not read a missing `app.ready` as a bug. **For anything timing-sensitive, CI is the only real gate.**
- **`TZ=…` does not work in the Bash tool, and fails silently.** Verified 2026-08-25: `TZ=UTC` is honoured, but `TZ=Asia/Tokyo` and `TZ=America/Denver` both resolve to **America/New_York** — the host zone — with no error. PowerShell's `$env:TZ = 'Asia/Tokyo'` works correctly. This matters specifically for the date family in §8a: the host zone is *behind* UTC, which is the one direction where that bug **cannot** manifest, so a Bash-run timezone check reports "no bug" no matter what. Any "verified under `TZ=<somewhere>`" claim made through Bash is a no-op. Use PowerShell, and sanity-check the zone actually took:
  ```
  $env:TZ='Asia/Tokyo'; node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"
  ```
  The date bug reproduces cleanly once the zone is real: `new Date('2026-08-08T00:00:00').toISOString().slice(0,10)` gives `2026-08-07` under Asia/Tokyo and `2026-08-08` under UTC.
- **Suite summary format differs by invocation.** A single-file run prints `# pass N`; the full `npm test` prints `ℹ pass N`. A grep for `# pass` against a full-suite log finds nothing and, with `grep -c`, exits 1 — which has already poisoned a compound command into reporting a passing suite as failed. Match on `pass`, never on `# pass`. And never pipe a test run through `tail`/`head`/`grep`: the exit code becomes the pipe's.
- **The system bars cannot be reasoned about from release notes. Only a handset settles them.** Two attempts have now been lost here, in opposite directions, and the second is the more instructive.

  *Assuming a limitation is permanent.* `b07026a` collapsed a scheme-scoped `theme-color` pair into one because "the app's theme is a MANUAL toggle" — true when written, false from `6bd9079`, which made the theme follow the OS. The comment read as a fact about the platform and was really a dated observation.

  *Assuming a limitation has lifted.* `cb11749` forced `.mob-nav` to `#000` to match a gesture bar it said "a PWA cannot colour". A later change removed that rule, reasoning that [Chrome 135 extends the viewport into the gesture navigation bar](https://developer.chrome.com/docs/css-ui/edge-to-edge) so the page now paints those pixels. **It does not** — verified on a Pixel 9 Pro XL, Android 17, Chrome 152, far past 135. The rule was restored.

  The check that settles it takes ten seconds and needs no tooling: **install the app, set it to LIGHT, and look at the bottom.** Light mode's `--bg` is `#fdfdfa`, so if the band under the tabs is black, those pixels are Android's, whatever the release notes say. The same shape of check works for the status bar. Do the check first; a plausible mechanism read off a changelog is not evidence about one device, and both failures above came from skipping it. **Date the claim** — name the version or commit that made it true — so the next reader knows what to re-check rather than what to assume.

  *Why manifest edits don't reach the phone when you expect them to:* on Android the installed app is a **WebAPK minted by Google's server, with `theme_color` baked into the APK's own AndroidManifest.xml** ([how updates work](https://web.dev/articles/manifest-updates)). Chrome re-checks the manifest ~daily and re-mints only after every window of the app is closed, on WiFi, plugged in — and **uninstall/reinstall does not force a fresh mint**, which is how a cream bar survived a redeploy AND a reinstall on 2026-08-29 while the server was provably serving different bytes. The reliable reset is: uninstall the app, then in Chrome → Settings → Site settings → the origin → **Clear data** (wipes SW caches and localStorage too — logs the member out), then revisit and reinstall. The **#bars diagnostic overlay** in index.html (5 quick taps on the theme toggle, or open the app via a link ending `#bars`) reads out on-device truth — metas, stored theme, safe-area insets, cache-bypassed manifest — so the next bar investigation starts from measurement, not theory. It is marked temporary; delete it once the bars are settled.

  **THE MEASURED VERDICT (2026-08-29, Pixel 9 Pro XL / Android 17 / Chrome 152 — and then AMENDED the same day, see the timeline below):** in the installed WebAPK, **meta theme-color is ignored entirely — TODAY, on this phone.** It was **honoured** on ~19 Aug 2026 on the same phone (dark bar over the dark app; the member has the screenshot), and `git diff` proves the whole theme surface — meta, head script, toggleTheme, manifest — was **byte-identical** from the 19 Aug deploy through the 28 Aug breakage report (PRs #77–#88 touched none of it). The breakage was phone-side: Chrome 152 and/or the Android 17 OTA landed in that window, amid Chromium's in-flight WebAPK edge-to-edge / status-bar rework ([tech-ish, Jul 2026](https://tech-ish.com/2026/07/15/google-chrome-for-android-pwa-edge-to-edge/)) and its long-standing dark-mode theme-color bugs (crbug.com/40634649, crbug.com/40759522). **CONFIRMED FIXED UPSTREAM (2026-08-31):** the member installed **Chrome Beta (153)**, installed the app from it, and the status bar follows theme-color again. The regression is 152-only and the fix is riding the release train — stable should restore it on Chrome's ~4-week cadence (mid-to-late Sep 2026) with **no app-side action**; the media pair + paint() rewrite is exactly what the restored world reads. Two follow-ups when stable catches up: confirm on the daily-driver Chrome, then **delete the temporary #bars overlay** from index.html. NB a Beta-installed WebAPK is a **separate app** with separate storage/login from the Chrome-installed one — two tracker icons can coexist; uninstall one to avoid confusion. The §8b lesson compounds: even a *measurement* is a dated observation — this one held for under a day before "it worked on the 19th" retired "ignores" as a law. The decisive overlay run: a light-theme launch with all three metas `#f6f7ed` produced a **black** status bar — a colour served by nothing on the page. With no manifest `theme_color`, both system bars follow the **phone's** theme (dark OS → black top and bottom), never the app's, and nothing tracks the in-app toggle — not at launch, not after. `safe-area-inset-top/bottom` are both `0`, so the page paints neither bar. The complete web-side control surface is: one static colour baked from manifest `theme_color` at mint (status bar only), or system defaults. It follows that (1) an in-app theme override against the OS **will always** have mismatched bars — unfixable from web code; a TWA/Bubblewrap wrapper with native `navigationBarColor`/`statusBarColor` is the only complete fix and means distributing a real APK; (2) the metas stay for browser-tab Chrome, which does honour them; (3) **the light-OS default bar colour has never been observed** — measure with the overlay on a light-themed phone before styling anything for that case. Two sampling gotchas the overlay itself hit, both §8b classics: `.mob-hdr` transitions for .25s so the 5-tap trigger reads it mid-flip (fixed with a 400ms settle in #93 — and `.mob-nav`, which has no transition, reading correctly in the same run is what proved it was an artifact); and the 5-tap trigger itself flips the theme while opening the report, so `localStorage.theme`/`data-theme` rows describe post-tap state, not what the member was looking at.

---

## 9. Uncommitted local WIP — none (resolved 2026-08-17)

**There is no uncommitted WIP any more. `master` is the whole project.** This section used to
warn that the maintainer's working copy held work a fresh clone wouldn't have. That is no
longer true, and the working copy has been synced to `origin/master` with a clean
`git status`. Resolved as follows:

- **UTA-newsletter generator — shipped.** `newsletter/` (`from-db.js`, `render.js`,
  `slides.js`, `shape.js`, `theme.js`, `org-chart.js`, `static/*`) and the leadership
  `GET /newsletter` route are on `master` and live. The Squadron view's "Generate Newsletter"
  button works.
- **`generate-sample-newsletter.js` — deleted.** A 22-line wrapper around
  `newsletter/from-sample.js` + `newsletter/render.js`, both on `master` at the time.
  `from-sample.js` (and `newsletter/preview-server.js` alongside it) was itself deleted
  2026-08-24 once nothing called it any more — see §5's Resources restructure entry.
- **`generate-sample-template.js` — deleted.** The Excel template generator, built around a
  hardcoded May 2026 roster that had gone stale against Postgres, `/roster`, and
  `import-members.js` (see §6).
- **`build-athoc-template.js`, `sync-athoc.js` — deleted.** One-off AtHoc tooling pinned to
  the **June 2026** cycle, premised on the spreadsheet being the system of record. Superseded
  by `/build` (the normal path) and `sync-tasks.js` (additive mid-cycle inserts).

> If you need any of them back, the pre-sync working copy is preserved in the maintainer's
> local `stash@{0}` ("stale tree before master sync 2026-08-17"). Nothing was pushed, and
> nothing on `master` changed.

---

## 10. What's left to do / open items

**Data workflow — DONE (2026-07-06):** additive mid-cycle sync and the in-browser Task Builder are both shipped (§6a). `import-tasks.js`/`sync-tasks.js` remain only as legacy/backup for bulk loads.
- **Closed 2026-08-17:** the newsletter generator shipped to `master`, and the Excel template
  generator plus the AtHoc scripts were deleted as obsolete. No WIP remains — see §9.

**Product / UX — member-first hierarchy redesign: DONE.** The member-first UI (task list led, dashboard demoted, softened Shop/Squadron tabs for plain members) shipped prior to this feature; see git history around that work if you need the specifics — the design critique that drove it is no longer an open item.
- Read-only rows (info items, schedule, work orders) currently reuse the checkbox-style `.task-item` and look tappable — give them a distinct non-checkbox affordance.
- The three-state checkbox supports `partial`/"in progress" in CSS + data, but no UI ever sets it (dead state) — wire a 3-state tap or remove it.
- Misc polish: `confirm()` vs. the unused styled `.confirm-delete` component; cache data across tab switches (currently refetches every switch); remove the "SSgt Smith, J." placeholder in the desktop subtitle; add an all-clear/empty-state moment at 100%; broader login/onboarding help.

**Cycle dates — the renderer is fixed, the data and the builder are not (2026-08-28)**
- **The Task Builder never sets `start_date`/`end_date`.** `lib/cycles.js:62` accepts both and
  writes NULL when they are absent; the builder UI does not send them, so cycles 4, 5 and 6 all
  have NULL dates while the older May cycles (ids 1–2) carry real ones. The newsletter now
  degrades honestly rather than marking the wrong drill, but **the dates are still missing**:
  the cover prints no date range and no weekend is marked. Two things needed — set the dates on
  the live cycle, and either require them at creation or **derive them from `drill_dates`**,
  which already holds every CY-2026 drill and is what the RSD slide reads. Deriving is the
  better fix: it needs no UI change and cannot be forgotten.
- **Duplicate cycles on production.** Two empty `Aug 2026 UTA` drafts (ids 4, 5 — 0 tasks each)
  and two identical archived `May 2026 UTA` rows (ids 1, 2 — 286 tasks *each*). `lib/cycles.js:49`
  now rejects a new non-archived name clash, so this cannot recur, but the existing rows were
  created before that guard and are still there.
- **No September cycle exists** as of 2026-08-28. The drill is 11–13 Sep (3-day).

**Newsletter export — open after the 2026-08-28 audit (§11)**
- **The six hand-edited partials in `newsletter/static/` are the weak link, and four have
  drifted.** Nothing in the deck signals that a partial is a cycle old, so it prints as
  confidently as the live pages beside it. **MEETs/RADR** is a full cycle behind (FY26 with
  COMPLETE/CANCELLED markers and the June 2026 Camp Murray DFT roster; the August newsletter
  is on FY27, Apr–Jul 2027) — `calendar_events` already models this, so retiring the partial
  is the real fix. **Dental Status** shares no overdue names with the newsletter (partial:
  Hill/Geant/Reneau/Bernard/Cabbler; newsletter: Maramba/Veal) and needs a months-since-exam
  field to go live. **Additional Training** is missing four AFI 10-210 courses. **Safety**
  carries an Ops row the newsletter lacks, drops its C2 row, and has Cabbler at the wrong rank.
- **194 of 222 admin tasks reach no slide:** `Form 55's` (56) and `JSTO` (42) are named on the
  hand-written Safety slide and `Quarterly Award 1206's` (26) on the hand-written Awards slide,
  but as prose — neither slide reads the tasks. `AtHoc` (50) has no slide anywhere. Giving them
  slides is a product decision; `NO_SLIDE_YET` in `test/newsletter-shape.test.js` keeps the
  omission deliberate rather than silent.
- **Two AFI 10-210 Percipio courses are miscategorised as `cbt`** (`Rapid Damage Assessment CBT`,
  `Engineering Contingency Responsibilities CBT`), so they print on slide 12 while the static
  slide 13 lists RDA again by hand — Maramba appears under it twice.
- **The CBT slide's colour contradicts its own text.** Colour comes from `urgency`, the words
  from `details`, and on the August cycle they disagree for roughly half the first block of
  every group (e.g. Ebbert's DAF Ops Security: `urgency: 'overdue'`, details `"15 min — Due
  This Month"` — a red name beside the words "Due This Month"). Fix the import, not the slide.
- **Work Schedule:** HVAC WO# 202600466 prints twice (the newsletter lists it once per day and
  the export dropped the day column), and a shop with no work orders is omitted entirely, so a
  reader cannot tell "EM away on DFT" from "nobody entered anything".
- **PT Testing is fixed but thin.** The 11 live tasks now render; the newsletter publishes the
  *whole year's* roster out to June 2027. Matching it needs a due-date field on the member,
  not one task per cycle.

**Auth / accounts**
- Admin password reset shipped (§5). A **self-service email-based reset** ("forgot password") is a reasonable phase 2 (needs reliable member emails + reset tokens).

**Task Builder / Records — noted future work (out of scope for v1, see the spec §12):**
- Squadron/shop-level rollup reports and completion trends over time in Records (v1 is per-member browsing only).
- Supervisor-facing authoring in `/build` (supervisors keep their existing per-shop add/flag/delete; only leadership can author cycles).
- Code-level guard preventing the legacy destructive CLI from running against a builder-managed cycle (currently a documented convention only — see §6a).

**Ops**
- **Rehearse `SW_MODE=kill` on a real phone — not yet done.** The caching service
  worker went to production on 2026-08-20 and installs on members' phones as they
  open the app. It is the only change here that does not roll back with a revert.
  The kill switch is covered by `test/sw-route-http.test.js`, so the route is
  known to serve the right script, but no one has confirmed a real device
  actually drops the worker and its caches when told to. Do it before a drill
  weekend, not during one: set `SW_MODE=kill` on the production service, open the
  app once on a phone, confirm no worker and no caches remain, then unset it.
- Rotate the preview/staging database password (`preview123`, exposed in a
  working transcript 2026-08-17). Throwaway data, but publicly reachable and it
  holds the imported roster.
- No "send a test notification" affordance exists. Both push defects found so far
  needed a real task assignment to surface, and a member who turns alerts on has
  no way to confirm they work.
- `must_change_password` currently defaults `true`, so the 2026-06-20 deploy **forces every member to reset on next login** — make sure squadron comms went out.
- Confirm the `/build` and `/records` page-shell posture (served to any logged-in session; mutating APIs are what's actually gated) is the intended design — flagged non-blocking in the final branch review.

---

## 11. Recent work

### 2026-08-28 — Newsletter export audited against the real newsletter

The generated deck was compared page by page against MSgt McNaughton's **August 2026
RSD newsletter** on the live August cycle. Both are 23 pages in the same order, and
that structural match had been hiding four slides that misreported their data. Of 23
slides: 9 faithful, 8 degraded, 6 wrong.

Fixed on this branch (`newsletter/shape.js`, `from-db.js`, `slides.js`, `theme.js`):

- **Orders / DTS / AROWS, PT Testing, EPBs / OPBs, Inbound / Outbound** — the literal-filter
  family, now §8a's third entry. See that section for the table and the rules.
- **SGLI & vRED → Government Travel Card.** The old slide printed two empty columns for
  tasks the tracker has never held; newsletter p15 is GTC/SoU, and the tracker holds 10
  `GTC CBT` + 10 `Statement of Understanding (SoU)` tasks that had no slide at all.
- **Inactive members.** The task query now filters `m.active` like the org-chart query,
  and the cover's count joins members so it matches `/api/squadron` (was 478 vs 471).
- **An undated cycle no longer marks the wrong drill.** Every cycle the Task Builder creates
  has `start_date`/`end_date` NULL — ids 4, 5 and 6 on production all do — and the RSD slide
  fell back to `new Date()` for its reference. On 28 August that struck through the **8–9 Aug
  drill the deck was for** and bolded **11–13 Sep** as "this UTA", and the cover's date range
  was blank. `drillEntries` now treats a missing reference as *unknown* (`past:false,
  next:false` for every drill) rather than dating against today, and the slide says why
  nothing is marked. Note an empty string is **not** a safe stand-in for "no reference": every
  real date sorts after `''`, so it silently makes January "next".
- **UTA Timeline is now horizontal** — a to-scale time grid per day, hours across the top,
  events as bars under the hours they occupy, overlapping events packed into lanes, which
  is how the newsletter draws it and how you can see that the Manning Doc meeting runs
  *inside* the afternoon admin block. Layout maths (`startMin`/`endMin`/`lane`, hour ticks,
  15-minute columns) lives in `shape.js` so it is unit-tested without parsing HTML;
  `slides.js` only turns it into `grid-column`/`grid-row`. On a phone the grid scrolls
  (`min-width:660px`) rather than crushing.
- **New:** `test/newsletter-shape.test.js` (12 tests), the first unit coverage of `shape.js`.

**Known-good, left alone:** org charts, Additional Duties, Work Schedule, RSD Schedule.
**Still open** (see §10): four of the six hand-edited partials in `newsletter/static/` have
drifted from the newsletter — MEETs/RADR is a full cycle behind (FY26 + the June DFT
roster; the newsletter is on FY27) and Dental Status shares no overdue names with it.
194 of the 222 admin tasks still have no slide (`Form 55's` 56, `AtHoc` 50, `JSTO` 42,
`Quarterly Award 1206's` 26).

### 2026-08-26 — MCP server (`mcp/`)
Claude (Claude Code / desktop app) can now read and update the tracker —
tasks, shop events/work orders, roster, rollups — through a local stdio MCP
server at `mcp/` (24 tools). It is a thin wrapper over the **HTTP API as a
signed-in member** (cookie login, re-login on 401), so role guards, live-cycle
checks, attribution, and push side effects all behave exactly as in the app;
it never touches the database. Own `package.json` (ESM,
`@modelcontextprotocol/sdk` + `zod`), not part of the Railway deploy or the
root test suite. Unit tests stub fetch; `npm run smoke` runs end-to-end
against **staging only** (it refuses non-staging URLs) with one reversible
write. Deliberately absent: deletions (beyond a confirm-gated event delete),
cycle authoring/go-live, placement/slug edits, anything wrapping
`import-tasks.js`. Setup and the credential story are in `mcp/README.md`.

### 2026-08-17 → 08-19 — The tracker becomes a phone app (PRs #74, #75, #76)
Three phases, all on `master`. **Full detail and the platform traps are in
[`docs/2026-08-19-mobile-app-handoff.md`](docs/2026-08-19-mobile-app-handoff.md)** — read that,
not this summary, before touching any of it.
- **Phase 0:** the repo had no CI at all while merging to `master` auto-deploys to the whole squadron. Added `.github/workflows/test.yml`, `engines.node`, branch protection and Railway "Wait for CI". Also a **migration advisory lock** (`lib/db.js`): the boot migration races the test harness's `schema.sql` and CI failed on a deadlock its first run — this fixes production too, where a deploy briefly runs two instances.
- **Phase 1:** manifest, icons, install card, `?view=` deep links, `rolling: true` sessions, theme follows the phone.
- **Phase 2:** Web Push — `push_subscriptions`, `notifications.pushed_at`, `lib/push.js`, a push-only service worker (**no `fetch` handler**, so it cannot strand anyone) and `SW_MODE=kill`.
- **Phase 3 (2026-08-20, PRs #77/#78/#79):** offline reads — see the entry below.
- **Still not started, deliberately:** the offline check-off queue (plan §9). It
  is the most expensive phase for the narrowest gain (tapping a box with no
  signal instead of twenty minutes later) and stays gated on whether a drill
  shows members actually need it.

### 2026-08-20 — Offline reads (PRs #77, #78, #79)
Members can now open the app with no signal and see their own task list instead
of a login screen. `master` at `198fd56`, 346 tests.
- **The worker gained a `fetch` handler.** Navigation to `/` is network-first
  with a 4s timeout behind a cached shell; fonts/icons are cache-first; the four
  unhashed front-end files are stale-while-revalidate. **`/api/*` is never
  intercepted** — a safety property, not a performance choice, since caching
  member data would let a shared phone serve it to whoever signs in next.
  Everything unlisted falls through untouched.
- **`public/offline.js`** caches the identity and the member's own task list in
  IndexedDB, written by app code only and never by the worker. Records carry
  their owner, so a cache belonging to another member is dropped on sight as well
  as wiped at logout — and that wipe happens even when the logout request itself
  fails, which offline it always does.
- **Scope is deliberately narrow:** the member's own task list. Supervisor
  rollups, attendance, roster, `/build` and `/records` stay online-only and now
  say so instead of failing silently.
- **Three bugs the plan did not anticipate**, all found by testing rather than
  reading: `loadShopEvents` had the same `try/finally`-with-no-`catch` bug the
  plan identified in `loadTasks` (and `loadShopMembers` had no guard at all);
  suppressing error toasts offline also swallowed `cycleTask`'s failure, so a
  checkbox flipped back silently; and `doLogin()` registered neither the worker
  nor the identity, so install — sign in — arrive at drill offline was still
  broken after the first two fixes (#79).
- **`test/sw-policy.test.js` and `test/offline-store.test.js`** load the real
  `sw.js` and `offline.js` into a `node:vm` with a stubbed worker scope, so the
  routing policy is not duplicated and cannot drift from what ships.
  `test/sw-route-http.test.js` covers the kill switch.

### 2026-08-10 — Rollout feedback batch
Branch `claude/rollout-feedback-features-q8lj7p`. Four features from the first partial rollout's feedback (First Sergeant + squadron leadership), detailed in §5: Student Flight tracking, Squadron category drill-in, present-vs-all completion percentages (new `lib/presence.js`), My Shop category view, and task helpers (links + attached Resources forms). Schema adds twin-migrated in `schema.sql` + the server.js boot block — note `tasks.document_id`'s ALTER must stay AFTER the `documents` CREATE TABLE in schema.sql (the early DO block swallows errors and would roll back silently). New test file `test/rollout-feedback-http.test.js` (12 tests).

### 2026-07-06 — Task Builder + Records
Branch `claude/task-builder-records` off `origin/master`. Full spec-driven build (see §6a): `uta_cycles.status` + DB-enforced one-live-cycle invariant, `task_batches`, the `lib/` module layer, all cycle/batch/records endpoints, the `/build` and `/records` leadership pages, completion-write immutability gating, and the first automated test suite in this repo (22 `node:test` tests). Not yet merged to `master` at time of writing — see the branch's own progress ledger (`.superpowers/sdd/progress.md`) and spec (`docs/superpowers/specs/2026-07-06-task-builder-and-records-design.md`) for the full task-by-task trail and final-review notes.

### 2026-06-20
Ran `/impeccable critique` and shipped the P1 findings as PR #30 (merged to `master`, deployed, verified live across all three tiers with a stubbed-API render): stored-XSS escaping in the member task renderers, fixed the broken `var(--done)`/`var(--t1)` leadership health colors (now `--ok`/`--warn`/`--urgent`), data-driven UTA label, the password change/forced-first-login/admin-reset trio, checkbox keyboard+ARIA, AA contrast (`--t2` darkened, content off `--t3`), self-hosted General Sans, stronger `--urgent`. PR #29 was an earlier attempt on a stale base and was closed in favor of #30.

---

## 12. Key files
- `server.js` — API routes, auth, roles, boot migrations, cron registration. Task Builder/Records routes are thin wrappers over `lib/`.
- `mcp/` — the squadron-tracker MCP server (stdio; lets Claude drive the API as a signed-in member). Self-contained sub-package; see `mcp/README.md`.
- `lib/db.js`, `lib/cycles.js`, `lib/tasks.js`, `lib/batches.js`, `lib/records.js` — Task Builder + Records logic layer (§6a).
- `lib/presence.js` — the "present at drill" rule for the two-way rollup percentages (shared join fragment + expression).
- `lib/duties.js`, `lib/calendar-events.js`, `lib/drill-calendar.js` — the Resources reference data: DDL + seed-on-create (`ensureTable`), validation, CRUD. `drill-calendar.js`'s pure half (`buildYear` for the newsletter's flat drill list, `buildCalendar` for the app's month groups, plus `label`, `years`, `validateDrill`, `overlaps`) is unit-tested without a database.
- `public/duties.js`, `public/calendar.js` — the two Resources data views; one global each (`dutiesInit`, `calendarInit`), initialised lazily from `switchResPane`/`setPeopleView`.
- `data/additional-duties.js`, `data/drill-dates.js`, `data/calendar-events.js` — the initial rows, used only by seed-on-create and the tests.
- `public/index.html` — the entire member/supervisor/leadership SPA (styles + markup + JS).
- `public/build.html` — the `/build` Task Builder page (leadership).
- `public/records.html` — the `/records` Records page (leadership + supervisor own-shop).
- `public/fonts/` — self-hosted General Sans woff2.
- `lib/push.js` — Web Push flush + dead-subscription pruning. `PUSH_TYPES` decides what buzzes a phone.
- `lib/sw/sw.js`, `lib/sw/sw-kill.js` — the service worker and its kill switch. Served by the `/sw.js` route in `server.js`, which must stay **before** `express.static`. `sw.js` now has a `fetch` handler; `routeRequest()` is the whole routing policy and is unit-tested against the real file.
- `public/offline.js` — offline identity + task cache (IndexedDB). Its decisions (`bootDecision`, `cacheUsable`, `relativeTime`) are pure functions so they can be tested without a browser; the storage wrapper below them resolves rather than rejects, so a browser with IndexedDB blocked degrades to the ordinary online app instead of breaking.
- `tools/make-badge.py`, `tools/icons.md` — the notification badge (Android silhouettes it; an app icon becomes a white square) and how the app icons were made.
- `schema.sql` — full data model, including `uta_cycles.status`, `uta_cycles_one_current`, `task_batches`, `tasks.batch_id`.
- `seed.js` — initial DB setup + sample data (destructive).
- `test/*.test.js`, `test/helpers/` — `node:test` suite (**398 tests**, run with `--test-concurrency=1` against a disposable Postgres — see §6a's command). Started with the Task Builder + Records data-safety invariants (§6a) and has grown to cover the whole app: the mobile app/offline/push layer, rollout-feedback features, roster/attendance/medical/schedule/work-orders/documents, and — as of this branch — the drill-calendar derivation, the `additional_duties`/`drill_dates`/`calendar_events` CRUD + seed-on-create, and the newsletter's live slides.
- `import-tasks.js` — legacy/backup **monthly Excel → tasks/schedule import** (destructive per cycle); `/build` is the normal path now.
- `sync-tasks.js` — legacy/backup additive mid-cycle sync; `/build` against the live cycle is the normal path now.
- `import-members.js` — roster import.
- `mailer.js`, `notify-emails.js`, `notify-digests.js` — email + digests.
- `data/squadron-events.js` — default timeline events.
- `DEMO-BRIEFING.md` — leadership-facing feature tour.
- `docs/superpowers/specs/2026-07-06-task-builder-and-records-design.md` — Task Builder + Records design spec.
- `.superpowers/sdd/progress.md` — Task Builder + Records implementation ledger.
