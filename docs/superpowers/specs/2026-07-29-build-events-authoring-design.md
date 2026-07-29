# 108 CES Task Tracker — Authoring Timeline, Schedule and Work Orders in the Task Builder

**Date:** 2026-07-29
**Status:** Design approved (brainstorming). Not yet implemented.
**Author/driver:** Greg Gablin
**Base branch for implementation:** `origin/master`

---

## 1. Goal

`/build` authors tasks and nothing else. Everything else a UTA cycle needs — the squadron timeline, each shop's schedule, and work orders — has no authoring path that targets a new cycle. This closes that gap so McNaughton can build a complete cycle in one place.

## 2. The problem, precisely

Two separate failures, found by tracing the code rather than the UI.

**The timeline has no write path at all.** `GET /api/squadron/timeline` is the only endpoint touching `squadron_events`. No POST, PUT, PATCH or DELETE exists anywhere. The table is populated exclusively by `seed.js` and `import-tasks.js` — the destructive Excel importer that PR #32 was built to retire. Setting a timeline today means running the legacy CLI.

**Schedule and work orders can only be edited on the live cycle.** `POST /api/shop/events` has full CRUD and works, but it hardcodes the target:

```sql
VALUES ((SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1), ...)
```

So a supervisor can fix *this* month's schedule, but nobody can pre-build next month's into a draft.

**Nothing carries forward.** `lib/` has zero event handling; `goLive` and `copyForward` touch only `uta_cycles`, `tasks` and `task_batches`. Confirmed against live data — every event in the database belongs to cycle 1:

```
cycles:          [ May 2026 UTA (live) ]
squadron_events: cycle 1 -> 22
shop_events:     cycle 1 -> 4 schedule, 4 work_order, 1 emphasis
```

**Consequence:** publish a new cycle today and every member's Timeline tab renders empty, and every shop's Schedule and Work Orders tabs render empty. Tasks carry forward; nothing else does. This surfaces at the worst possible moment, the first drill weekend after rollover.

## 3. Decisions locked (from brainstorming)

| Decision | Choice |
|---|---|
| `/build` structure | **Four sections**: Tasks, Timeline, Schedule, Work Orders |
| Automatic carry-forward on cycle creation | **Open work orders only** (`open` + `in_progress`). Nothing else clones itself silently |
| Timeline, schedule carry-forward | **Reviewable "copy forward" button inside each section**, mirroring how tasks already work (§6) |
| Completed work orders | **Never carried forward.** A finished job in a new cycle reads as outstanding work and inflates every shop's count |
| Timeline editing | **In scope.** Write endpoints do not exist and must be built |
| Schema changes | **None.** Both tables already have `uta_cycle_id` |

### Terminology, because the two are easy to confuse

- **Schedule** = `shop_events` with `event_type='schedule'`. Per-shop Fri/Sat/Sun blocks. Surfaces in My Shop → Schedule.
- **Timeline** = `squadron_events`. The squadron-wide day plan, 22 rows this cycle. Surfaces in My Tasks → Timeline.

They are different tables with different shapes and are treated separately throughout.

## 4. Scope

**In scope**
- Write endpoints for `squadron_events` (create, update, delete, reorder) — leadership-gated, cycle-targeted.
- Cycle-targeted variants for `shop_events` writes so a draft can be authored.
- Cycle-targeted reads for both, so `/build` can show a draft's contents.
- Four-section navigation in `/build`; the existing task flow is not restructured.
- Copy-forward within the Timeline, Schedule and Work Orders sections.
- Automatic carry of open/in-progress work orders at cycle creation.
- Tests for the carry-forward rules and the cycle-targeting guards.

**Out of scope**
- Changing what members see. All member-facing reads stay filtered to `is_current`, so draft content stays invisible until go-live. No member-facing query changes.
- Supervisors' existing My Shop editing. It keeps working exactly as now, on the live cycle.
- Retiring `import-tasks.js`. It stays available as a bulk/backup path.
- Attendance, which is unrelated.

## 5. Data model

**No schema changes.** `squadron_events` and `shop_events` both already carry `uta_cycle_id`; they have simply never been written for anything but the current cycle.

Relevant existing shapes:

```
squadron_events: day, start_time, end_time, title, details,
                 kind (formation|training|meeting|briefing|medical|work|admin|lunch),
                 is_concurrent, emphasis, attendees JSONB, sort_order

shop_events:     shop_id, event_type (schedule|work_order|emphasis),
                 day, start_time, end_time, title, details, wo_number,
                 status (open|in_progress|complete), sort_order
```

One note on carry-forward: `shop_event_status_log` is keyed to `shop_event_id`. A carried-forward work order is a **new row**, so it starts with an empty status history while keeping its `status` value. That is correct — the log records what happened during a given cycle, and the new cycle's history begins empty.

## 6. Carry-forward semantics

Two distinct mechanisms, deliberately.

**Automatic, at cycle creation — open work orders only.** When `createDraft` runs, work orders on the live cycle with status `open` or `in_progress` are copied into the draft, preserving status, `wo_number`, shop and details. Completed ones are not. This is automatic because an unfinished job is outstanding whether or not anyone remembers to press a button.

Must be idempotent: re-running cannot duplicate. Guard on `(uta_cycle_id, shop_id, wo_number, title)`.

**Manual and reviewable — timeline and schedule.** Each section gets a "Copy forward from <last cycle>" action that lists what would be copied and lets McNaughton deselect rows before committing, the same shape as the existing task copy-forward with its review step.

The reason for the split: a timeline is *nearly* the same each month but the times move, and a schedule is *nearly* the same but shop tasking shifts. Copying either silently would produce a confidently wrong artifact. Copying neither would mean re-entering 22 timeline rows a month by hand, which is the workload problem this project exists to solve. A reviewable copy is the honest middle.

## 7. API surface

All leadership-gated (`requireAuth` + `requireRole('leadership')` + `requireOnboarded`), all cycle-targeted, all following the existing route conventions.

```
Timeline (new table for writes — none of these exist today)
GET    /api/cycles/:id/timeline          -> events for that cycle
POST   /api/cycles/:id/timeline          -> create one
PUT    /api/timeline/:eventId            -> update one
DELETE /api/timeline/:eventId            -> remove one
POST   /api/cycles/:id/timeline/copy-forward   -> { from_cycle_id, event_ids }

Shop events (schedule + work orders) targeted at a cycle
GET    /api/cycles/:id/shop-events?shop_id=&type=
POST   /api/cycles/:id/shop-events
POST   /api/cycles/:id/shop-events/copy-forward -> { from_cycle_id, event_ids }
```

Existing `PUT`/`DELETE /api/shop/events/:id` are reused for edits, with their supervisor-shop guard intact; leadership already passes it.

**Write-window rule.** These endpoints accept `draft` and `live` cycles and reject `archived` with 403, matching the attendance precedent. Authoring a draft is the point; rewriting history is not.

**Member-facing reads are untouched.** `GET /api/squadron/timeline` and `GET /api/shop/events` keep filtering to `is_current`, so draft content cannot leak to members before go-live.

## 8. `/build` structure

The home screen gains a four-way section nav. The existing task flow (`copyfwd` → `cfreview` → `builder` → `review` → `success`) is untouched and becomes the Tasks section.

```
/build  —  <cycle name>  [draft]

[ Tasks ]  [ Timeline ]  [ Schedule ]  [ Work Orders ]

Tasks        existing flow, unchanged
Timeline     day-grouped list (Fri/Sat/Sun), add/edit/remove a row,
             kind + times + concurrent flag, copy-forward
Schedule     shop picker, then that shop's schedule blocks, copy-forward
Work Orders  shop picker, then that shop's WOs (number, title, details,
             status), copy-forward, carried-forward items marked as such
```

Reuse rather than reinvent: `/build` already has the section/screen switcher (`go()`), the member-picker chip pattern from copy-forward review, and the shop grouping used by the roster. The timeline editor's day grouping mirrors the read-only renderer already in `index.html` (`TL_DAY_ORDER`, `TL_KIND_PILL`).

Carried-forward work orders are visually marked in the Work Orders section, so McNaughton does not re-add a job that came across automatically. This is the main duplication risk in the design.

## 9. Key flows

1. **Build next month.** New cycle → open WOs arrive automatically → Timeline: copy forward, adjust times → Schedule: copy forward per shop, adjust → Work Orders: review carried items, add new → Tasks: existing flow → Go live.
2. **Mid-cycle schedule fix.** Unchanged: a supervisor edits in My Shop against the live cycle.
3. **Correcting a timeline time after go-live.** Timeline section targets the live cycle too, so this now works in-app instead of requiring the CLI.

## 10. Edge cases

| Case | Handling |
|---|---|
| Copy-forward run twice | Idempotent on `(cycle, shop, wo_number, title)` / `(cycle, day, start_time, title)`; already-present rows are skipped and reported |
| No previous cycle | Copy-forward actions disabled with an explanatory empty state |
| Archived cycle | Readable; all writes 403 |
| A shop with no events | Section shows an empty state, not a blank panel |
| Work order completed *after* carry-forward | Independent rows; the old cycle's record is frozen, the new one tracks its own status |
| Draft deleted | `discardDraft` must also delete that cycle's `squadron_events` and `shop_events`, or they orphan. **This is a required change to `lib/cycles.js`** |

That last row matters: `discardDraft` currently deletes `task_completions`, `tasks`, `task_batches` and the cycle. Adding events without extending it would leave orphaned rows and an FK violation on cycle delete.

## 11. Testing

- **`lib/` unit tests:** copy-forward idempotency for both tables; open-WO filter excludes `complete`; status preserved on carry; `discardDraft` removes events.
- **Endpoint tests:** archived cycles reject writes; a non-leadership member gets 403 on every new route; member-facing reads never return draft-cycle events (the draft-invisibility invariant, which is the one with real blast radius).
- Requires `TEST_DATABASE_URL`, still unset. Same prerequisite flagged in the attendance spec.

## 12. Rollout risk

The draft-invisibility invariant is the thing to get right. Members must not see next month's timeline or schedule before go-live. Existing member reads filter on `is_current` and this design does not change them, but it is worth an explicit test rather than an assumption, because the failure is silent and squadron-visible.

Recommended sequencing, each its own PR:

1. Carry-forward of open work orders + `discardDraft` fix. Small, stops the rollover cliff.
2. Shop-events cycle targeting + Schedule and Work Orders sections in `/build`.
3. Timeline write endpoints + Timeline section. Largest piece, and the one that finally retires the CLI dependency.
