# 108 CES Task Tracker — Leadership Cycle Authoring (Task Builder) + Member History (Records)

**Date:** 2026-07-06
**Status:** Design approved (brainstorming). Not yet implemented.
**Author/driver:** Greg Gablin
**Base branch for implementation:** `origin/master` (see §11 — the current working copy is stale)

---

## 1. Goal

Replace the monthly Excel-workbook + CLI workflow (`import-tasks.js` / `sync-tasks.js`) with a browser-based authoring tool MSgt McNaughton can operate himself, and preserve every member's per-cycle task history as a permanent, leadership-viewable record. This directly serves the project's binding constraint: **McNaughton's maintenance workload must go down, not up.**

Two leadership surfaces, one shared data foundation:

- **`/build`** — the Task Builder: author next month's cycle (or add to the live one), then publish.
- **`/records`** — the Records reviewer: look back at any member's historical tasks and completion.

## 2. Background

The deployed app (`108ces.up.railway.app`, `origin/master`) already turns the monthly UTA newsletter into per-person, checkable task lists with supervisor/leadership roll-ups. Today the monthly data load is a developer-shaped workflow: fill a multi-sheet `.xlsx`, run `import-tasks.js` against the production `DATABASE_URL` (a **destructive full-replace** per cycle), and use `sync-tasks.js` for additive mid-cycle adds. Realistically only the maintainer (Greg) runs this — not McNaughton — so the workload goal isn't truly met.

A polished, non-functional mockup already exists and is deployed at `/task-builder-mockup` (`public/task-builder-mockup.html`). This spec turns that mockup into a real feature and adds the history/records capability.

## 3. Decisions locked (from brainstorming)

| Decision | Choice |
|---|---|
| First-version scope | **Full monthly authoring** — McNaughton builds the whole cycle in-browser; Excel/CLI retired as the normal path |
| Draft vs live behavior | **Draft + "Go live" cutover** — members keep seeing the current live cycle until publish; one atomic switch + notification |
| Batch/undo | **Real batches + undo** — each add / copied group is an undoable batch; warn on check-offs |
| Who operates it | **Leadership only**; McNaughton uses his existing leadership account. Supervisors keep their current per-shop task actions |
| Builder placement | **Standalone `/build` page** (evolve the mockup), sharing session/theme with the SPA |
| History storage | Retain archived cycles (never delete); history is derived from existing `tasks` + `task_completions` |
| History view placement | **Dedicated `/records` leadership surface** |
| Spec scope | **One combined spec** (this doc); implementation plan phases it internally |
| Testing | **Automated** `node:test` against a local Postgres, covering the data-safety invariants |

## 4. Scope

**In scope**
- Cycle draft / live / archived state and the atomic Go-live transaction.
- Retention + immutability of archived history.
- Batches (`task_batches` + `tasks.batch_id`) and undo.
- `/build` authoring tool (copy-forward, recurring catalog, new-task with member/urgency selection, review, undo, go-live), working on a **draft or the live** cycle.
- `/records` per-member history reviewer.
- One member-app change: gate completion writes to the live cycle.

**Out of scope (noted future work)**
- Squadron/shop-level rollup *reports* and completion trends over time (Records v1 is per-member browsing only).
- Self-service "forgot password" reset.
- Supervisor-facing authoring in `/build` (supervisors keep existing per-shop add/flag/delete).
- Hard code-guards preventing the legacy destructive CLI from running against a builder-managed cycle (documented convention only in v1).

## 5. Data model changes

Guiding principle: **do not change any member-facing query.** Every member/supervisor read already filters `uta_cycles.is_current = true`; drafts are layered around that so all risk lands in new leadership code.

### 5.1 Cycle state
Add to `uta_cycles`:
- `status VARCHAR(20) CHECK (status IN ('draft','live','archived')) DEFAULT 'draft'`

`is_current` keeps its exact meaning: the single **live** cycle members see.
- **draft** — being built; `is_current = false`; invisible to members.
- **live** — the published current cycle; `is_current = true`; exactly one at any time.
- **archived** — a past cycle; `is_current = false`; retained forever.

**Go-live** (transaction, `POST /api/cycles/:id/go-live`): set the draft → `status='live', is_current=true`; set the previously-live cycle → `status='archived', is_current=false`; then notify all active members ("your [name] tasks are live"). Atomic — there is never more than one live cycle.

### 5.2 Batches
New table:
```
task_batches (
  id            SERIAL PRIMARY KEY,
  uta_cycle_id  INTEGER REFERENCES uta_cycles(id),
  label         VARCHAR(255) NOT NULL,
  kind          VARCHAR(20) CHECK (kind IN ('new_task','copy_forward')),
  created_by_id INTEGER REFERENCES members(id),
  created_at    TIMESTAMP DEFAULT NOW()
)
```
Add `batch_id INTEGER REFERENCES task_batches(id)` to `tasks` (nullable; legacy/import rows stay null). One "Add" = one `new_task` batch; each selected copy-forward group = one `copy_forward` batch. Undo deletes the batch's task rows + their `task_completions` + the batch row.

### 5.3 Reused, unchanged
The existing `tasks_cycle_member_cat_title_uniq` unique constraint (`uta_cycle_id, member_id, category_id, title`) stays the additive-safety net. Every builder insert is `ON CONFLICT DO NOTHING`, and endpoints report the real inserted-row count so the UI can show "X added, Y already existed." This is the same guarantee `sync-tasks.js` relies on — members' check-offs can never be clobbered by an add.

### 5.4 Retention + immutability
- Go-live **archives, never deletes** — so `tasks` + `task_completions` for past cycles remain a permanent, per-member record keyed by `member_id` + `uta_cycle_id`. No separate history/snapshot table.
- **New invariant:** completion writes are gated to the **live** cycle. The completion-toggle endpoint must reject (`403`) a task whose cycle is not `is_current`. Members already only *see* the live cycle; this closes the back door so archived completion rows are frozen — a faithful snapshot of where each member ended the month.

### 5.5 Migrations
All additions are idempotent and run in the `server.js` boot-migration block, consistent with the existing pattern:
- `ALTER TABLE uta_cycles ADD COLUMN IF NOT EXISTS status ...`
- `CREATE TABLE IF NOT EXISTS task_batches ...`
- `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS batch_id ...`
- One-time backfill: existing `is_current = true` cycle → `status='live'`; all others → `status='archived'`.

## 6. API surface

All endpoints are `requireAuth` + `requireOnboarded`. Authoring endpoints are `requireRole('leadership')`. Records endpoints are leadership (any member) or supervisor (own shop only).

**Key generalization:** the builder operates on a **selected working cycle** identified by `:id`, which may be a **draft** (building next month) or the **live** cycle (adding mid-month). The same add/copy/undo endpoints serve both — this retires *both* `import-tasks.js` and `sync-tasks.js`. Go-live applies only to a draft.

### Cycles
- `GET /api/cycles` → `[{id, name, status, is_current, task_count}]`
- `POST /api/cycles` `{name}` → creates a draft
- `POST /api/cycles/:id/go-live` → the §5.1 transaction; refuses a zero-task draft unless `{confirm:true}`; errors if `:id` is not a draft
- `DELETE /api/cycles/:id` → discard a draft only (refuses live/archived)

### Copy-forward & recurring catalog
- `GET /api/cycles/:sourceId/groups` → source cycle's tasks grouped by (category, title): `[{category_code, title, details, urgency, members:[{id,name}], count}]`. Feeds both "Start from [last cycle]" and the "Use again" catalog.
- `POST /api/cycles/:id/copy-forward` `{from_cycle_id, groups:[{category_code, title, member_ids?}]}` → additive insert into the working cycle, **appointment fields (day/time/location) dropped**, skips inactive members, **one batch per group**; returns per-group `{added, skipped}`.

### New task
- `POST /api/cycles/:id/tasks` `{title, category_code, details, assignments:[{member_ids:[...], urgency}]}` → one row per member per assignment into the working cycle, additive (`ON CONFLICT DO NOTHING`), all under **one** `new_task` batch; returns `{batch_id, added, skipped}`. Member-list, cycle-scoped generalization of the existing `POST /api/squadron/tasks`.

### Batches / undo
- `GET /api/cycles/:id/batches` → the "Added this cycle" list `[{id, label, kind, member_count, created_by, created_at}]`
- `DELETE /api/batches/:id` → deletes the batch's tasks + completions + batch row. If any task's completion `state != 'none'`, returns `409 {checked_off_count}` unless `?force=true`.

### Records
- `GET /api/members/:id/history` → the member's cycles (live + archived) newest-first with per-cycle summary `{cycle:{id,name,status}, done, total}` and drill-down to the actual tasks + completion state + note. Leadership: any member. Supervisor: only members in their own `shop_id` (else `403`).

### Supporting reads
- Reuse existing roster/category data the SPA already renders; add light `GET /api/roster` (active members grouped by shop) and `GET /api/categories` only if no equivalent exists.

### Member-app change (only one)
- Completion-toggle endpoint (`PUT /api/tasks/:id` / the completion route): reject with `403` if the task's cycle is not `is_current`. Enforces §5.4 immutability.

## 7. Frontend surfaces

### 7.1 `/build` (leadership) — evolve `public/task-builder-mockup.html`
Served only to a leadership session (server-side role check before `sendFile`; otherwise redirect to login/app). Reuses the SPA's origin/session cookie, self-hosted General Sans font, and CSS tokens. The mockup's existing screens map to §6:
- **Home / cycle bar** ← `GET /api/cycles`; "+ New cycle" ← `POST /api/cycles`; "Go live" ← `POST /api/cycles/:id/go-live`.
- **Recurring catalog + "Start from [last cycle]"** ← `GET /api/cycles/:sourceId/groups`; "Copy N groups" ← `POST /api/cycles/:id/copy-forward`.
- **Builder** (title/category/details/urgency + roster tap-select, multiple urgency groups) ← `GET /api/roster` + `GET /api/categories`; assembled client-side into `assignments`, committed via `POST /api/cycles/:id/tasks`.
- **Review** — client-side summary + live per-member preview; commit button calls the add endpoint.
- **Added this cycle** ← `GET /api/cycles/:id/batches`; "Undo" ← `DELETE /api/batches/:id` (confirm dialog on `409`).

### 7.2 `/records` (leadership; supervisor own-shop) — new page
Same standalone/gated pattern as `/build`. Member browser (grouped by shop, searchable; supervisor sees only their shop) → select a member → cycles newest-first with completion summaries → drill into a cycle to see that member's tasks with done/not-done and notes. Live cycle shows current progress; archived cycles are the frozen record.

### 7.3 Member app (`public/index.html`)
No UI change. Only the completion-write gating (§6, §5.4).

## 8. Key flows

**Monthly build (primary):** New draft cycle → "Start from [last cycle]," deselect non-recurring groups, copy forward → add any new tasks (tap members, set urgency, save; repeat for other urgency groups) → review → **Go live** (members switch atomically + get notified).

**Mid-cycle add (replaces `sync-tasks.js`):** Select the live cycle as working cycle → New task → add → done. Undo warns if members already checked it off.

**History review:** `/records` → pick member → pick cycle → view tasks + completion.

## 9. Edge cases & error handling
- Go-live is transactional (exactly one live cycle; previous archived atomically); refuses a zero-task draft unless confirmed; clear error when no draft exists.
- Additive inserts always report `added` vs `skipped` (duplicates silently skipped via `ON CONFLICT`) so counts are never a mystery.
- Undo on the live cycle warns with `checked_off_count`; undo on a draft can't hit a check-off (members can't see drafts).
- Copy-forward never copies appointment day/time/location; skips inactive members.
- History persists by `member_id` through shop moves and deactivation; supervisor scoping is by *current* `shop_id`; leadership sees all.
- Completion write to a non-live cycle → `403`.
- A test asserts a member cannot fetch a draft cycle's tasks (no draft leak).
- Legacy `import-tasks.js` against a builder-managed cycle is destructive — documented "one path per cycle," not code-guarded in v1.

## 10. Testing

Automated `node:test` suite (introduce as the first test tooling in this repo) run against a **disposable local Postgres** (Docker container or a throwaway Railway DB). TDD: write the invariant tests first. Cover the five data-safety invariants:
1. **Go-live transaction** — exactly one live cycle afterward; previous cycle archived; notifications enqueued to all active members.
2. **Additive add** — `ON CONFLICT` skips duplicates; `added`/`skipped` counts correct; no `task_completions` touched.
3. **Copy-forward** — omits appointment fields; targets the right (active) members; one batch per group.
4. **Batch undo** — deletes tasks + completions; `409` + count when check-offs exist; `force` overrides.
5. **History immutability** — completion write to a non-live cycle is rejected; members cannot read a draft cycle.

Frontend wiring (`/build`, `/records`) verified via the preview workflow, not automated tests, in v1.

## 11. Migration, rollout & git base

- **Git base:** the current working copy is on `claude/impeccable-critical-fixes`, ~34 commits behind `origin/master`, with uncommitted edits (`server.js`, `public/index.html`) and untracked WIP (`newsletter/`, AtHoc scripts, sample generators). Implementation must branch from a freshly fetched `origin/master`, not this checkout. This spec file is untracked so it carries onto the new branch cleanly.
- **Deploy:** merge to `master` → Railway auto-builds. Boot migrations apply the §5.5 schema changes idempotently and safely.
- **Legacy coexistence:** `import-tasks.js` / `sync-tasks.js` remain for backup/bulk; the builder is the normal path. Convention: one path per cycle.
- **Backfill:** existing cycles get a `status` on first boot (current → live, rest → archived), so history and Records work immediately over past data.

## 12. Out of scope / future
- Squadron/shop rollup reports and completion trends in Records.
- Self-service password reset.
- Supervisor authoring in `/build`.
- Code-guarding the legacy destructive CLI against builder-managed cycles.

## 13. Confirmed assumptions (approved 2026-07-06)
1. **Confirmed.** McNaughton will be given a **leadership** account.
2. **Confirmed.** Supervisors can view **their own shop's** members in Records; leadership sees all. (Mirrors the existing password-reset permission scoping.)
3. **Confirmed.** Automated tests run against a dedicated **Railway Postgres** (a throwaway/test database, not production).
