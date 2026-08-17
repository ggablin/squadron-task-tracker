# 108th CES UTA Task Tracker — Project Handoff

> Purpose of this file: give a new engineer/agent everything needed to be productive on this app in one read. It documents scope, architecture, the monthly data-update workflow, what's built, and what's left. Last updated 2026-07-06 (Task Builder + Records feature).

---

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
- **Notifications:** in-app center (bell, 60s polling); an email channel is built but **not configured in production**, so in practice the bell is the only channel members have (see §7). Includes a "your tasks are live" blast when a cycle is imported, and daily completion digests.
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

**Tests:** first automated test tooling in this repo. `node:test` suite in `test/*.test.js` (22 tests across `cycles`, `tasks`, `batches`, `records`, `immutability`), run against a disposable Postgres via `TEST_DATABASE_URL`:
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
> The in-app bell is the only channel members have ever received. **Before configuring SMTP,
> run `UPDATE notifications SET emailed_at = NOW() WHERE emailed_at IS NULL`** — otherwise
> the next flush emails the entire backlog since launch, 200 rows every 5 minutes.

- **In-app:** `notifications` table; the SPA polls the bell every 60s. `notify()` in `server.js` writes rows (e.g., task assigned, tasks-live). There is a second insert site: `notify-digests.js` writes `completion_digest` rows directly.
- **Email:** `mailer.js` = `nodemailer` over SMTP. `notify-emails.js` flushes queued emails; `notify-digests.js` builds daily completion digests. Both are runnable by hand and are driven on a timer by cron in `server.js`:
  - `cron.schedule('0 21 * * *', …)` → **completion digest daily at 21:00**.
  - `cron.schedule('*/5 * * * *', …)` → **flush pending emails every 5 minutes**.
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
  `newsletter/from-sample.js` + `newsletter/render.js`, both of which are on `master`.
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

**Auth / accounts**
- Admin password reset shipped (§5). A **self-service email-based reset** ("forgot password") is a reasonable phase 2 (needs reliable member emails + reset tokens).

**Task Builder / Records — noted future work (out of scope for v1, see the spec §12):**
- Squadron/shop-level rollup reports and completion trends over time in Records (v1 is per-member browsing only).
- Supervisor-facing authoring in `/build` (supervisors keep their existing per-shop add/flag/delete; only leadership can author cycles).
- Code-level guard preventing the legacy destructive CLI from running against a builder-managed cycle (currently a documented convention only — see §6a).

**Ops**
- `must_change_password` currently defaults `true`, so the 2026-06-20 deploy **forces every member to reset on next login** — make sure squadron comms went out.
- Confirm the `/build` and `/records` page-shell posture (served to any logged-in session; mutating APIs are what's actually gated) is the intended design — flagged non-blocking in the final branch review.

---

## 11. Recent work

### 2026-08-10 — Rollout feedback batch
Branch `claude/rollout-feedback-features-q8lj7p`. Four features from the first partial rollout's feedback (First Sergeant + squadron leadership), detailed in §5: Student Flight tracking, Squadron category drill-in, present-vs-all completion percentages (new `lib/presence.js`), My Shop category view, and task helpers (links + attached Resources forms). Schema adds twin-migrated in `schema.sql` + the server.js boot block — note `tasks.document_id`'s ALTER must stay AFTER the `documents` CREATE TABLE in schema.sql (the early DO block swallows errors and would roll back silently). New test file `test/rollout-feedback-http.test.js` (12 tests).

### 2026-07-06 — Task Builder + Records
Branch `claude/task-builder-records` off `origin/master`. Full spec-driven build (see §6a): `uta_cycles.status` + DB-enforced one-live-cycle invariant, `task_batches`, the `lib/` module layer, all cycle/batch/records endpoints, the `/build` and `/records` leadership pages, completion-write immutability gating, and the first automated test suite in this repo (22 `node:test` tests). Not yet merged to `master` at time of writing — see the branch's own progress ledger (`.superpowers/sdd/progress.md`) and spec (`docs/superpowers/specs/2026-07-06-task-builder-and-records-design.md`) for the full task-by-task trail and final-review notes.

### 2026-06-20
Ran `/impeccable critique` and shipped the P1 findings as PR #30 (merged to `master`, deployed, verified live across all three tiers with a stubbed-API render): stored-XSS escaping in the member task renderers, fixed the broken `var(--done)`/`var(--t1)` leadership health colors (now `--ok`/`--warn`/`--urgent`), data-driven UTA label, the password change/forced-first-login/admin-reset trio, checkbox keyboard+ARIA, AA contrast (`--t2` darkened, content off `--t3`), self-hosted General Sans, stronger `--urgent`. PR #29 was an earlier attempt on a stale base and was closed in favor of #30.

---

## 12. Key files
- `server.js` — API routes, auth, roles, boot migrations, cron registration. Task Builder/Records routes are thin wrappers over `lib/`.
- `lib/db.js`, `lib/cycles.js`, `lib/tasks.js`, `lib/batches.js`, `lib/records.js` — Task Builder + Records logic layer (§6a).
- `lib/presence.js` — the "present at drill" rule for the two-way rollup percentages (shared join fragment + expression).
- `public/index.html` — the entire member/supervisor/leadership SPA (styles + markup + JS).
- `public/build.html` — the `/build` Task Builder page (leadership).
- `public/records.html` — the `/records` Records page (leadership + supervisor own-shop).
- `public/fonts/` — self-hosted General Sans woff2.
- `schema.sql` — full data model, including `uta_cycles.status`, `uta_cycles_one_current`, `task_batches`, `tasks.batch_id`.
- `seed.js` — initial DB setup + sample data (destructive).
- `test/*.test.js`, `test/helpers/` — `node:test` suite (22 tests) for the Task Builder + Records data-safety invariants (§6a).
- `import-tasks.js` — legacy/backup **monthly Excel → tasks/schedule import** (destructive per cycle); `/build` is the normal path now.
- `sync-tasks.js` — legacy/backup additive mid-cycle sync; `/build` against the live cycle is the normal path now.
- `import-members.js` — roster import.
- `mailer.js`, `notify-emails.js`, `notify-digests.js` — email + digests.
- `data/squadron-events.js` — default timeline events.
- `DEMO-BRIEFING.md` — leadership-facing feature tour.
- `docs/superpowers/specs/2026-07-06-task-builder-and-records-design.md` — Task Builder + Records design spec.
- `.superpowers/sdd/progress.md` — Task Builder + Records implementation ledger.
