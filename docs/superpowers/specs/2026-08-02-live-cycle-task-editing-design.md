# Live-cycle task editing — design

**Date:** 2026-08-02
**Status:** Approved, ready for implementation planning

## 1. Problem

Once a cycle is published there is no way to correct a task. The Task Builder's
task surface is batch-only: it can add a batch (`POST /api/cycles/:id/tasks`),
list batches, and undo a whole batch (`DELETE /api/batches/:id`). The finest
available correction is discarding an entire batch, which is useless when one
task on one person has the wrong urgency.

The gap looks like an oversight rather than a decision, because the builder
already does per-item editing for everything else in a cycle: schedule items via
`PUT /api/cycles/:id/schedule/:ref` and work orders via
`PUT /api/cycles/:id/work-orders/:id`. Tasks are the only object that got
batch granularity only.

Concretely: tasks published in the live August cycle carry urgencies that are
wrong and cannot be fixed without destroying and rebuilding the batch that
contains them, which would also erase any completions members have recorded
against the other tasks in that batch.

## 2. Scope

**In scope**

- Edit `urgency` and `details` for a whole task group.
- Edit `urgency`, `details`, and the three appointment fields for one member's
  task row.
- Delete a whole group, or one member's row, with a guard against destroying
  recorded completions.
- Editing works on draft and live cycles. Archived cycles stay frozen.
- Notify affected members when, and only when, a task's urgency escalates.
- Repair `DELETE /api/tasks/:id`, which today has neither guard (see §8).

**Out of scope**

- Editing `title` or `category_id`. These form the group's identity and
  participate in the dedupe key `UNIQUE (uta_cycle_id, member_id, category_id,
  title)`, so renaming can collide with an existing task for some or all
  affected members. Changing either remains a delete-and-re-add, which the
  builder already handles well.
- An audit trail for edits. Work orders have `shop_event_status_log` because a
  work order *is* a running record; a task's urgency is a field, and Records
  already captures where a cycle landed.
- Optimistic locking. Concurrent edits are last-write-wins.
- Any new member-facing UI.

## 3. Decisions and rationale

| Decision | Rationale |
|---|---|
| Group edit, with drill-down to a single member | Covers both the "my own copy is wrong" case and the "this went out wrong to everyone" case on one screen. |
| Editable fields: urgency, details, appointment | Avoids the dedupe-key collision that title and category would introduce. |
| Appointments editable at member level only | `copyForward` explicitly never copies `appt_*` fields; appointments are inherently per-member, so a group-level appointment edit would almost always be wrong. |
| Group operations are leadership-only | A group can span shops. A supervisor editing one would either do a silent partial update or need carve-outs. Supervisors work at row level, matching the existing `POST /api/tasks` and `DELETE /api/tasks/:id` gates. |
| Notify only on urgency escalation | Notifying everyone that a typo was fixed trains members to ignore the channel. An escalation to Overdue or This UTA is genuinely actionable. |
| Draft and live both editable; only archived frozen | Editing available after publishing to 70 people but not while still a private draft would be backwards. The rule becomes "history is frozen, everything else is editable." |
| Surface as a new "Live cycle" section in the builder | `/api/cycles/:id/groups` already returns exactly the needed shape, so no new read query. Organises by what members see rather than by when it was authored, and leaves the batch list as a pure undo log. |

## 4. Data model

One migration, following the additive `DO $$ ... ALTER TABLE` pattern already
used in `schema.sql`: extend the `notifications.type` CHECK constraint to admit
`task_escalated` alongside `tasks_live`, `task_assigned`, and
`completion_digest`.

No other schema change. No new tables.

## 5. `lib/tasks.js`

### 5.1 `URGENCY_RANK`

```js
const URGENCY_RANK = { info: 0, future: 1, next_uta: 2, this_uta: 3, overdue: 4 };
```

Escalation is `URGENCY_RANK[next] > URGENCY_RANK[prev]`.

This constant is necessary because urgency is stored as a string and the
existing group query collapses it with `MIN()`, which sorts alphabetically:
`future < info < next_uta < overdue < this_uta`. That ordering is semantically
meaningless and is the root of the display bug in §5.2.

### 5.2 `listGroups` — additive change

`listGroups` currently returns `MIN(details)` and `MIN(urgency)`, so a group
whose members hold different urgencies displays one arbitrary member's value
with no indication that it is unrepresentative. Mixed groups are not
hypothetical: `copyForward` deliberately carries each member's own urgency
forward.

Add two boolean columns:

```sql
COUNT(DISTINCT t.urgency)::int > 1 AS urgency_mixed,
COUNT(DISTINCT t.details)::int > 1 AS details_mixed
```

Adding columns is safe for the existing copy-forward caller, which reads the
result by field name.

### 5.3 `assertTaskEditable(db, taskId)`

New guard, parallel to the existing `assertTaskInLiveCycle`:

```js
async function assertTaskEditable(db, taskId) {
  const { rows } = await db.query(
    `SELECT 1 FROM tasks t JOIN uta_cycles c ON c.id = t.uta_cycle_id
     WHERE t.id = $1 AND c.status IS DISTINCT FROM 'archived'`, [taskId]);
  if (!rows.length) {
    throw Object.assign(new Error('Cycle is closed to changes'), { code: 'NOT_EDITABLE' });
  }
}
```

`IS DISTINCT FROM`, not `<>`. `uta_cycles.status` carries a `DEFAULT 'draft'`
and `schema.sql:145` backfills existing NULLs, but the column has **no NOT NULL
constraint**, and that backfill runs inside the migration IIFE that logs and
swallows its own errors. Under `<>`, a NULL status evaluates to NULL, which is
falsy, and the guard would reject an editable cycle with "closed to changes" —
a confusing failure with no obvious cause. `IS DISTINCT FROM` treats NULL as
"not archived", which is the safe reading: a cycle is frozen only when
explicitly marked archived.

The two guards coexist and mean different things, and neither replaces the
other:

- `assertTaskInLiveCycle` guards **completions**. Members may only check off the
  live cycle. Unchanged.
- `assertTaskEditable` guards **definition edits and deletes**. Rejects archived
  only.

A cycle-level variant, `assertCycleEditable(db, cycleId)`, applies the same rule
for the two group routes, which address a group rather than a task id.

### 5.4 Operations

All four resolve their target, run the appropriate guard, and act in a
transaction.

- **`updateGroup(db, cycleId, { category_code, title }, { urgency, details })`**
  Updates every row in the group.
  Returns `{ updated: <int>, escalated_member_ids: <int[]> }`.
- **`updateTask(db, taskId, { urgency, details, appt_day, appt_time, appt_location })`**
  Updates one row. Only operation that writes `appt_*`.
  Returns `{ updated: <int>, escalated_member_ids: <int[]> }` — the same shape as
  `updateGroup`, with at most one id, so both routes notify through identical
  code rather than branching on a boolean in one case and a list in the other.
- **`deleteGroup(db, cycleId, { category_code, title }, { force })`**
  Returns `{ deleted: <int> }`.
- **`deleteTask(db, taskId, { force })`**
  Returns `{ deleted: <int> }`.

A field omitted from the update object is left unchanged; passing `null`
explicitly clears it. Passing an empty object is a no-op returning
`{ updated: 0, escalated_member_ids: [] }`, not an error.

Both deletes reuse the `HAS_COMPLETIONS` pattern from `lib/batches.js`
verbatim: count `task_completions` rows with `state <> 'none'`; if any exist and
`force` is not set, throw

```js
Object.assign(new Error('Has completions'), { code: 'HAS_COMPLETIONS', checked_off_count: n })
```

Both update operations compute which rows actually moved upward by
`URGENCY_RANK` before writing, and return those member ids so the route can
notify them.

### 5.5 `lib/batches.js` — minor change

Deleting individual tasks can leave a `task_batches` row whose tasks are all
gone. `listBatches` LEFT JOINs, so such a batch renders in the undo list as
"0 members" with an Undo button that does nothing. Add `HAVING COUNT(t.id) > 0`
so batches with nothing left to undo drop out.

## 6. API surface

All errors follow the contract the batch route already established:
`409 { error: 'HAS_COMPLETIONS', checked_off_count }`, cleared with
`?force=true`.

| Route | Gate | Body | Notes |
|---|---|---|---|
| `PUT /api/cycles/:id/groups` | leadership | `{ category_code, title, urgency?, details? }` | Updates every row in the group. |
| `PUT /api/tasks/:id/definition` | supervisor (own shop) / leadership (any) | `{ urgency?, details?, appt_day?, appt_time?, appt_location? }` | Only route that edits appointments. Named `/definition` because `PUT /api/tasks/:id` is already the member's completion state. |
| `POST /api/cycles/:id/groups/delete` | leadership | `{ category_code, title, force? }` | POST because a group's identity is a `(category, title)` pair, not a URL id. Matches the existing `/copy-forward` and `/go-live` idiom. |
| `DELETE /api/tasks/:id` | supervisor (own shop) / leadership (any) | — | **Existing route, repaired.** See §8. |

Validation, in the route rather than left to the database CHECK so the message
is useful:

- `urgency`, when present, must be one of the five valid values, else `400`.
- Ids parse through the existing `reqId` helper, else `400`.
- `category_code` and `title` are required for both group routes, else `400`.

Responses: `403` with "This cycle is closed to changes" on `NOT_EDITABLE`;
`403` on a supervisor reaching outside their shop; `404` when the group or task
does not exist.

Escalation notifications fire from the two update routes after the write, using
the member ids the operation returned:

```js
notify(escalatedIds, {
  type: 'task_escalated',
  title: `Urgency changed: ${title}`,
  body: `Now marked ${label(urgency)}.`,
  link: 'member',
});
```

`notify()` already logs and swallows its own failures, so a mail problem can
never fail the edit.

## 7. The Live cycle section (`public/build.html`)

Shown whenever a working cycle exists. The header states which, unmissably,
because the consequences of an edit differ completely:

- *Draft cycle — not yet visible to members*
- *Live cycle — N members can see this now*

Renders `/api/cycles/:id/groups`, already ordered by category code then title.

**Group row:** category chip, title, urgency chip, member count, Edit, Delete,
expand caret. When `urgency_mixed` is true the chip reads **Mixed** rather than
inventing a value.

**Expanded:** one row per member showing rank and last name, that member's own
urgency chip, their appointment if set, and their own Edit and Delete.

**Group edit** offers urgency and details. When the group is mixed, it says so
before saving:

> 3 of 14 members have a different urgency. Saving applies this to all 14.

Silently flattening divergence that `copyForward` deliberately preserved would
be the worst available outcome.

**Member edit** adds `appt_day`, `appt_time`, `appt_location`.

**Deletes** route through `uiConfirm` from `public/ui.js`. On `409`, a second
confirm names the cost:

> 4 members have already checked this off. Deleting removes their notes too.

then retries with `?force=true`. Success and failure surface through
`uiToast`, which is already an `aria-live` region.

Styling uses the existing `design.css` tokens. No new colour values.

## 8. Repairing `DELETE /api/tasks/:id`

The route at `server.js:551` has **no live-cycle guard and no completions
guard**. It deletes `task_completions` and then the task, unconditionally. It is
reachable: `public/index.html:5233` calls it from the supervisor shop view.

Two live defects follow:

1. A supervisor can delete a task from an **archived** cycle, rewriting history
   that Records presents as frozen and that `immutability.test.js` asserts is
   closed to completion writes.
2. Deleting a task a member has completed **silently destroys their state and
   their note**, with no warning. This is precisely what `undoBatch` refuses to
   do.

The repair adds `assertTaskEditable` and the `HAS_COMPLETIONS` guard, so the
existing caller now receives a confirmation prompt instead of destroying work,
and archived cycles become unreachable.

This changes existing behaviour and is therefore called out explicitly rather
than folded in silently.

## 9. Edge cases

**Groups need no cleanup.** `listGroups` is a `GROUP BY`. Deleting every
member's row individually makes the group disappear on its own. No orphan
state.

**Empty batches.** Handled by §5.5.

**Concurrency.** Last-write-wins. With two capability holders, contention is not
realistic and version conflicts would cost more than they would prevent.

**Repeat escalation.** A task escalated twice produces two notifications. This
is correct; each is a real change.

**Appointment fields** are free-text `VARCHAR` and stay unvalidated beyond
length, matching how the add path already treats them.

## 10. Testing

New file `test/task-edit.test.js`, following the established pattern: `node
--test --test-concurrency=1` against the shared throwaway Postgres, with
`resetDb()` between cases. The concurrency flag is mandatory — test files share
one database and `resetDb()` truncations collide without it.

Load-bearing cases:

1. `URGENCY_RANK` orders semantically, not alphabetically. Direct guard against
   regressing to `MIN()` behaviour.
2. `updateGroup` updates every row in its group and **nothing outside it**.
   Asserted with a second group present that must remain untouched.
3. `updateTask` updates one row and leaves its siblings in the same group
   unchanged. The drill-down's whole premise.
4. `updateTask` writes all three appointment fields.
5. A **draft** cycle accepts edits.
6. An **archived** cycle throws `NOT_EDITABLE`.
7. `deleteTask` with a completion throws `HAS_COMPLETIONS` carrying the correct
   count; with `force` it deletes.
8. `deleteGroup` behaves the same across multiple members' completions.
9. Deleting every member's row individually removes the group from
   `listGroups`.
10. `listGroups` reports `urgency_mixed` true only when the group actually
    diverges, false when uniform.
11. Escalation fires on `this_uta → overdue`; does **not** fire on
    `overdue → future`; does **not** fire on a details-only edit.
12. `listBatches` omits a batch whose tasks have all been individually deleted.

HTTP-level, in `test/task-edit-http.test.js`:

13. **`DELETE /api/tasks/:id` against an archived cycle returns 403.** The
    regression test for §8. This test fails against the current code, which is
    the point.
14. A supervisor editing a row outside their shop gets `403`.
15. A supervisor calling `PUT /api/cycles/:id/groups` gets `403`.
16. An invalid `urgency` returns `400`, not a 500 from the database CHECK.
