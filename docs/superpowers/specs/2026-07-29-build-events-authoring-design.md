# 108 CES Task Tracker — Authoring Schedule and Work Orders in the Task Builder

**Date:** 2026-07-29
**Status:** Design approved (brainstorming). Not yet implemented.
**Author/driver:** Greg Gablin
**Base branch for implementation:** `origin/master`

---

## 1. Goal

`/build` authors tasks and nothing else. Everything else a UTA cycle needs — the schedule and work orders — has no authoring path that targets a new cycle. This closes that gap so McNaughton can build a complete cycle in one place.

## 2. The problem, precisely

Two failures, found by tracing the code rather than the UI.

**The squadron timeline has no write path at all.** `GET /api/squadron/timeline` is the only endpoint touching `squadron_events`. No POST, PUT, PATCH or DELETE exists anywhere. The table is populated exclusively by `seed.js` and `import-tasks.js` — the destructive Excel importer that PR #32 was built to retire. Setting a timeline today means running the legacy CLI.

**Schedule and work orders can only be edited on the live cycle.** `POST /api/shop/events` has full CRUD and works, but hardcodes its target:

```sql
VALUES ((SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1), ...)
```

A supervisor can fix *this* month's schedule; nobody can pre-build next month's into a draft.

**Nothing carries forward.** `lib/` has zero event handling; `goLive` and `copyForward` touch only `uta_cycles`, `tasks` and `task_batches`. Confirmed against live data — every event belongs to cycle 1:

```
cycles:          [ May 2026 UTA (live) ]
squadron_events: cycle 1 -> 22
shop_events:     cycle 1 -> 4 schedule, 4 work_order, 1 emphasis
```

**Consequence:** publish a new cycle today and every member's Timeline tab renders empty, and every shop's Schedule and Work Orders tabs render empty. Tasks carry forward; nothing else does. It surfaces at the worst moment — the first drill weekend after rollover.

## 3. The organising idea: one event, an audience

Timeline and schedule are not two things to author. They are **one thing — a scheduled event — with an audience**:

- **Audience = All** → the squadron timeline. Everyone sees it in My Tasks → Timeline.
- **Audience = one or more shops** → those shops' schedules. Surfaces in My Shop → Schedule.

McNaughton fills in one form — day, times, title, details, kind — and picks who it applies to. Where it surfaces follows from that choice. He never has to know that two database tables exist.

This is the whole design decision. Everything below serves it.

## 4. Decisions locked (from brainstorming)

| Decision | Choice |
|---|---|
| `/build` structure | **Three sections**: Tasks, Schedule, Work Orders |
| Timeline vs schedule | **Synonymous.** One authoring surface; audience decides where an event surfaces |
| Audience control | "All" or a multi-select of shops |
| Storage | **Keep both existing tables.** Audience routes the write (§5) |
| Automatic carry-forward at cycle creation | **Open work orders only** (`open` + `in_progress`) |
| Schedule carry-forward | **Reviewable copy-forward inside the section**, mirroring tasks |
| Completed work orders | **Never carried forward.** A finished job in a new cycle reads as outstanding and inflates every shop's count |
| Member-facing behaviour | **Unchanged.** Same two views, same content, same reads |

## 5. Data model

### 5.1 Storage follows audience

The unified authoring surface writes to the existing tables rather than merging them:

| Audience | Written to |
|---|---|
| All | one row in `squadron_events` |
| N shops | N rows in `shop_events`, `event_type='schedule'`, one per shop |

**Why not one table.** Unifying would mean migrating live data and rewriting both member-facing renderers on a system ~70 people depend on, to produce output identical to what already renders correctly. The user-facing model is what needed unifying, and that happens in the authoring layer. Merging the tables stays available later as a pure refactor with no visible change; it is not a prerequisite for this.

### 5.2 Two additive columns

```sql
ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS event_group_id INTEGER;
ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS kind VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_shop_events_group ON shop_events (event_group_id);
```

Both nullable, both idempotent, in the existing `DO $$ ... EXCEPTION WHEN others THEN NULL; END $$;` block. No member-facing query changes; existing renderers ignore them.

**`event_group_id`** ties the N rows of a multi-shop event together. Without it, "edit this event" degrades into "find and edit three rows and hope" — and deleting one shop from the audience becomes unexpressible. Existing rows keep `NULL` and behave as standalone, which is what they are.

**`kind`** preserves the `formation | training | meeting | briefing | medical | work | admin | lunch` value on shop rows. `squadron_events` already has it and the timeline renders it as a pill. Without it here, switching an event's audience from All to a shop silently discards the field. My Shop's schedule need not render it today; the column exists so the round trip is lossless.

## 6. Carry-forward semantics

Two mechanisms, deliberately split.

**Automatic, at cycle creation — open work orders only.** `createDraft` copies work orders from the live cycle with status `open` or `in_progress`, preserving status, `wo_number`, shop and details. Completed ones are not copied. Automatic because unfinished work is outstanding whether or not anyone remembers to press a button.

Idempotent: guarded on `(uta_cycle_id, shop_id, wo_number, title)`, so re-running cannot duplicate.

**Manual and reviewable — schedule.** The Schedule section gets a "Copy forward from &lt;last cycle&gt;" action listing what would be copied, with rows deselectable before committing — the same shape as the existing task copy-forward and its review step. Copies both the squadron-audience and shop-audience events, preserving audience.

The reason for the split: a schedule is *nearly* the same each month but times move and tasking shifts. Copying it silently produces a confidently wrong artifact. Copying nothing means re-entering ~26 rows a month by hand, which is the workload problem this project exists to solve. A reviewable copy is the honest middle.

One note: `shop_event_status_log` is keyed to `shop_event_id`, so a carried-forward work order is a **new row** with an empty status history but its `status` preserved. Correct — the log records what happened during a given cycle.

## 7. API surface

Leadership-gated (`requireAuth` + `requireRole('leadership')` + `requireOnboarded`), cycle-targeted, following existing route conventions.

```
Schedule — one endpoint pair, audience in the payload
GET    /api/cycles/:id/schedule            -> merged squadron + shop events for the cycle
POST   /api/cycles/:id/schedule            -> { audience: 'all' | [shop_id...], day,
                                               start_time, end_time, title, details, kind }
PUT    /api/schedule/:groupRef             -> update every row of the event
DELETE /api/schedule/:groupRef             -> remove every row of the event
POST   /api/cycles/:id/schedule/copy-forward -> { from_cycle_id, event_refs }

Work orders
GET    /api/cycles/:id/work-orders?shop_id=
POST   /api/cycles/:id/work-orders
POST   /api/cycles/:id/work-orders/copy-forward -> { from_cycle_id, event_ids }
```

`GET /api/cycles/:id/schedule` returns one logical event per row with an `audience` field, merging `squadron_events` (audience `all`) and `event_group_id`-grouped `shop_events`. The builder never sees two shapes.

**Audience changes on edit.** Moving an event between All and shops crosses tables. `PUT` handles this by deleting the old rows and inserting the new set inside one transaction, preserving `kind`, times and title. This is the main correctness risk in the design and needs a test.

**Write window.** Accepts `draft` and `live`, rejects `archived` with 403, matching the attendance precedent.

**Member-facing reads untouched.** `GET /api/squadron/timeline` and `GET /api/shop/events` keep filtering on `is_current`, so draft content cannot leak before go-live.

## 8. `/build` structure

Home gains a three-way section nav. The existing task flow (`copyfwd` → `cfreview` → `builder` → `review` → `success`) is untouched and becomes the Tasks section.

```
/build  —  <cycle name>  [draft]

[ Tasks ]  [ Schedule ]  [ Work Orders ]

Tasks        existing flow, unchanged
Schedule     day-grouped list (Fri/Sat/Sun) of every event regardless of
             audience, each row showing its audience as a chip:
                0800–0830  Formation / Roll Call        [ All ]
                0900–1100  Bay cleanup                  [ HVAC ] [ Electrical ]
             add/edit/remove; audience is All or a shop multi-select;
             copy-forward
Work Orders  shop picker, then that shop's WOs (number, title, details,
             status); carried-forward items marked as such; copy-forward
```

Showing every event in one day-grouped list — squadron and shop side by side — is what makes the model legible. McNaughton reads the drill weekend top to bottom and sees who each item is for.

Reuse rather than reinvent: `/build` already has the screen switcher (`go()`), the chip multi-select from copy-forward review (reusable verbatim for audience), and shop grouping from the roster. Day grouping and kind pills mirror the read-only renderer in `index.html` (`TL_DAY_ORDER`, `TL_KIND_PILL`).

Carried-forward work orders are visually marked so McNaughton does not re-add a job that arrived automatically. That is the main duplication risk.

## 9. Key flows

1. **Build next month.** New cycle → open WOs arrive automatically → Schedule: copy forward, adjust times, set audiences → Work Orders: review carried items, add new → Tasks: existing flow → Go live.
2. **Mid-cycle schedule fix.** Unchanged: a supervisor edits in My Shop against the live cycle.
3. **Correcting a timeline time after go-live.** The Schedule section targets the live cycle too, so this now works in-app instead of requiring the CLI.
4. **Widening an audience.** An event set to HVAC becomes All: the PUT deletes the shop row and inserts a squadron row in one transaction.

## 10. Edge cases

| Case | Handling |
|---|---|
| Copy-forward run twice | Idempotent on `(cycle, shop, wo_number, title)` / `(cycle, day, start_time, title, audience)`; existing rows skipped and reported |
| Audience changed on edit | Delete + insert in one transaction; `kind`, times and title preserved (§7) |
| Audience emptied to zero shops | Rejected with 400. An event with no audience surfaces nowhere |
| Event assigned to an inactive/removed shop | Row retained, flagged in the builder; no silent deletion |
| No previous cycle | Copy-forward disabled with an explanatory empty state |
| Archived cycle | Readable; writes 403 |
| Draft deleted | `discardDraft` must also delete that cycle's `squadron_events` and `shop_events`. **Required change to `lib/cycles.js`** |

That last row matters: `discardDraft` currently deletes `task_completions`, `tasks`, `task_batches` and the cycle. Adding events without extending it orphans rows and hits an FK violation on cycle delete.

## 11. Testing

- **`lib/` unit tests:** copy-forward idempotency; open-WO filter excludes `complete`; status preserved on carry; audience-change round trip across tables preserves every field; `discardDraft` removes events.
- **Endpoint tests:** archived cycles reject writes; non-leadership gets 403 on every new route; empty audience rejected; and the invariant with real blast radius — **member-facing reads never return draft-cycle events**.
- Requires `TEST_DATABASE_URL`, still unset. Same prerequisite flagged in the attendance spec.

## 12. Rollout risk

**Draft invisibility is the thing to get right.** Members must not see next month's schedule before go-live. Existing member reads filter on `is_current` and this design does not change them, but that deserves an explicit test rather than an assumption: the failure is silent and squadron-visible.

Recommended sequencing, each its own PR:

1. Open-WO carry-forward + the `discardDraft` fix. Small, and stops the rollover cliff on its own.
2. The two additive columns + cycle-targeted schedule endpoints + the Schedule section, audience and all.
3. Work Orders section. Smallest of the three, and independent of the schedule work.
