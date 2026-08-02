# Live-Cycle Task Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Task Builder edit and delete individual tasks in a draft or live cycle, at group level or for one member, without destroying recorded completions.

**Architecture:** Four new operations in `lib/tasks.js` guarded by a new `assertTaskEditable` (archived cycles only are frozen), exposed through three new Express routes plus a repair to the existing `DELETE /api/tasks/:id`, and surfaced as a "Live cycle" section in `public/build.html` that renders the existing `/api/cycles/:id/groups` endpoint.

**Tech Stack:** Node 24 + Express, PostgreSQL via `pg`, vanilla single-file frontend (no build step), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-02-live-cycle-task-editing-design.md`

## Global Constraints

- Run tests with `node --test --test-concurrency=1`. The flag is **mandatory** — all test files share one throwaway Postgres and `resetDb()` truncations collide without it.
- `TEST_DATABASE_URL` must be set. It lives in the gitignored `.env.test`; load with `set -a && . ./.env.test && set +a`.
- No new npm dependencies.
- The five valid urgency values, exactly: `overdue`, `this_uta`, `next_uta`, `future`, `info`.
- Completion-conflict error contract, matching `DELETE /api/batches/:id`: throw `Object.assign(new Error(...), { code: 'HAS_COMPLETIONS', checked_off_count: n })`; the route answers `409 { error: 'HAS_COMPLETIONS', checked_off_count }`; the caller retries with `?force=true`.
- Editable means **not archived**. Use `IS DISTINCT FROM 'archived'`, never `<> 'archived'` — `uta_cycles.status` has no NOT NULL constraint and `<>` yields NULL (falsy) for a NULL status, which would reject an editable cycle.
- Frontend uses existing `public/design.css` tokens and the `uiConfirm` / `uiToast` helpers from `public/ui.js`. No new colour values, no new dependencies.
- Never commit `.superpowers/` — it is gitignored scratch.
- Do not touch `assertTaskInLiveCycle`. It guards member completions and must keep meaning "the live cycle only."

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `schema.sql` | Schema + additive migrations | Modify: extend `notifications.type` CHECK |
| `lib/tasks.js` | Task group/row operations | Modify: add rank, guards, 4 operations; extend `listGroups` |
| `lib/batches.js` | Batch listing and undo | Modify: drop empty batches from `listBatches` |
| `server.js` | HTTP routes | Modify: 3 new routes, repair 1 |
| `public/build.html` | Task Builder UI | Modify: add Live cycle section |
| `test/task-edit.test.js` | Unit coverage for `lib/tasks.js` | Create |
| `test/task-edit-http.test.js` | Route gating and validation | Create |

---

### Task 1: Migration, urgency rank, and the editable guards

**Files:**
- Modify: `schema.sql` (migration block, alongside the existing `ALTER TABLE` statements)
- Modify: `lib/tasks.js`
- Test: `test/task-edit.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `URGENCY_RANK` (object), `assertTaskEditable(db, taskId)`, `assertCycleEditable(db, cycleId)`. Both guards throw `Object.assign(new Error('Cycle is closed to changes'), { code: 'NOT_EDITABLE' })`. All exported from `lib/tasks.js`.

- [ ] **Step 1: Write the failing test**

Create `test/task-edit.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');
const tasks = require('../lib/tasks');

test.before(applySchema);

// Creates a cycle with the given status and returns its id.
async function mkCycle(status, isCurrent = false) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ($1,$2,$3) RETURNING id`,
    ['Aug 2026', status, isCurrent]);
  return c.id;
}

// Inserts one task row directly and returns its id.
async function mkTask(cycleId, memberId, catId, title, urgency = 'this_uta') {
  const { rows: [t] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [cycleId, memberId, catId, title, urgency]);
  return t.id;
}

test('URGENCY_RANK orders by severity, not alphabetically', () => {
  const R = tasks.URGENCY_RANK;
  assert.ok(R.overdue > R.this_uta, 'overdue outranks this_uta');
  assert.ok(R.this_uta > R.next_uta, 'this_uta outranks next_uta');
  assert.ok(R.next_uta > R.future,   'next_uta outranks future');
  assert.ok(R.future  > R.info,      'future outranks info');
  // The bug this guards: string MIN() sorts future < info < next_uta < overdue
  // < this_uta, which would make this_uta the most severe value.
  assert.ok(R.overdue > R.this_uta, 'alphabetical ordering would fail here');
});

test('assertTaskEditable allows draft and live, rejects archived', async () => {
  await resetDb(); const f = await seedFixtures();

  const draft = await mkCycle('draft');
  const draftTask = await mkTask(draft, f.m1, f.catId, 'CBT');
  await assert.doesNotReject(() => tasks.assertTaskEditable(pool, draftTask));

  const live = await mkCycle('live', true);
  const liveTask = await mkTask(live, f.m1, f.catId, 'CBT');
  await assert.doesNotReject(() => tasks.assertTaskEditable(pool, liveTask));

  const archived = await mkCycle('archived');
  const archivedTask = await mkTask(archived, f.m1, f.catId, 'CBT');
  await assert.rejects(() => tasks.assertTaskEditable(pool, archivedTask),
    (e) => e.code === 'NOT_EDITABLE');
});

test('assertTaskEditable treats a NULL status as editable', async () => {
  await resetDb(); const f = await seedFixtures();
  // status has no NOT NULL constraint and its backfill lives in a migration
  // block that swallows errors. Under `<> 'archived'` this row would compare
  // NULL (falsy) and be wrongly rejected.
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('Legacy', NULL, false) RETURNING id`);
  const t = await mkTask(c.id, f.m1, f.catId, 'CBT');
  await assert.doesNotReject(() => tasks.assertTaskEditable(pool, t));
});

test('assertCycleEditable rejects an archived cycle by id', async () => {
  await resetDb();
  const archived = await mkCycle('archived');
  await assert.rejects(() => tasks.assertCycleEditable(pool, archived),
    (e) => e.code === 'NOT_EDITABLE');
  const draft = await mkCycle('draft');
  await assert.doesNotReject(() => tasks.assertCycleEditable(pool, draft));
});

module.exports = { mkCycle, mkTask };
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit.test.js
```

Expected: FAIL — `tasks.URGENCY_RANK` is undefined and `tasks.assertTaskEditable is not a function`.

- [ ] **Step 3: Add the migration to `schema.sql`**

In the migration block, beside the other `ALTER TABLE ... IF NOT EXISTS` statements, add:

```sql
  ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('tasks_live','task_assigned','completion_digest','task_escalated'));
```

- [ ] **Step 4: Add the rank and guards to `lib/tasks.js`**

At the top of the file, above `assertTaskInLiveCycle`:

```js
// Urgency is stored as a string, and listGroups collapses it with MIN(), which
// sorts alphabetically: future < info < next_uta < overdue < this_uta. That
// ordering is meaningless — it makes this_uta look more severe than overdue.
// Escalation decisions use this rank instead.
const URGENCY_RANK = { info: 0, future: 1, next_uta: 2, this_uta: 3, overdue: 4 };

function notEditable() {
  return Object.assign(new Error('Cycle is closed to changes'), { code: 'NOT_EDITABLE' });
}

// Guards task DEFINITION edits and deletes: everything except archived.
// Distinct from assertTaskInLiveCycle, which guards member COMPLETIONS and
// must keep meaning "the live cycle only". Both exist; neither replaces the other.
//
// IS DISTINCT FROM, not <>: uta_cycles.status has no NOT NULL constraint, and
// `NULL <> 'archived'` is NULL (falsy), which would reject an editable cycle.
async function assertTaskEditable(db, taskId) {
  const { rows } = await db.query(
    `SELECT 1 FROM tasks t JOIN uta_cycles c ON c.id = t.uta_cycle_id
     WHERE t.id = $1 AND c.status IS DISTINCT FROM 'archived'`, [taskId]);
  if (!rows.length) throw notEditable();
}

async function assertCycleEditable(db, cycleId) {
  const { rows } = await db.query(
    `SELECT 1 FROM uta_cycles WHERE id = $1 AND status IS DISTINCT FROM 'archived'`, [cycleId]);
  if (!rows.length) throw notEditable();
}
```

Extend the exports at the bottom of the file:

```js
module.exports = { assertTaskInLiveCycle, assertTaskEditable, assertCycleEditable,
                   URGENCY_RANK, listGroups, addTaskBatch, copyForward };
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Run the whole suite to confirm nothing regressed**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1
```

Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add schema.sql lib/tasks.js test/task-edit.test.js
git commit -m "feat: add urgency rank and editable-cycle guards"
```

---

### Task 2: Report mixed groups from `listGroups`

**Files:**
- Modify: `lib/tasks.js` (`listGroups`)
- Test: `test/task-edit.test.js`

**Interfaces:**
- Consumes: `mkCycle`, `mkTask` helpers from Task 1's test file.
- Produces: `listGroups` rows gain `urgency_mixed` and `details_mixed` (booleans). All existing fields keep their names and types.

- [ ] **Step 1: Write the failing test**

Append to `test/task-edit.test.js`:

```js
test('listGroups flags a group whose members hold different urgencies', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  await mkTask(c, f.m1, f.catId, 'CBT', 'this_uta');
  await mkTask(c, f.m2, f.catId, 'CBT', 'overdue');

  const [g] = await tasks.listGroups(pool, c);
  assert.strictEqual(g.count, 2);
  assert.strictEqual(g.urgency_mixed, true, 'divergent urgency must be reported');
  assert.strictEqual(g.details_mixed, false, 'both details are NULL, so not mixed');
});

test('listGroups reports a uniform group as not mixed', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  await mkTask(c, f.m1, f.catId, 'CBT', 'this_uta');
  await mkTask(c, f.m2, f.catId, 'CBT', 'this_uta');

  const [g] = await tasks.listGroups(pool, c);
  assert.strictEqual(g.urgency_mixed, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit.test.js
```

Expected: FAIL — `g.urgency_mixed` is `undefined`, not `true`.

- [ ] **Step 3: Add the two columns**

In `lib/tasks.js`, in `listGroups`, add to the SELECT list after `COUNT(*)::int AS count,`:

```sql
           COUNT(DISTINCT t.urgency)::int > 1 AS urgency_mixed,
           COUNT(DISTINCT t.details)::int > 1 AS details_mixed,
```

Leave `MIN(details)`, `MIN(urgency)`, and every other field exactly as they are — `copyForward`'s caller reads them by name and must not change.

- [ ] **Step 4: Run the test to verify it passes**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Confirm copy-forward still works**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/tasks.test.js
```

Expected: PASS. The copy-forward tests exercise `listGroups`'s existing fields.

- [ ] **Step 6: Commit**

```bash
git add lib/tasks.js test/task-edit.test.js
git commit -m "feat: report mixed urgency and details from listGroups"
```

---

### Task 3: `updateTask` — edit one member's row

**Files:**
- Modify: `lib/tasks.js`
- Test: `test/task-edit.test.js`

**Interfaces:**
- Consumes: `assertTaskEditable`, `URGENCY_RANK` from Task 1.
- Produces: `updateTask(db, taskId, fields) -> { updated: <int>, escalated_member_ids: <int[]> }`. `fields` may contain `urgency`, `details`, `appt_day`, `appt_time`, `appt_location`. A key that is absent leaves the column unchanged; a key present with `null` clears it. An empty `fields` returns `{ updated: 0, escalated_member_ids: [] }` without touching the database.
- Produces: `buildSet(fields, allowed, startIndex) -> { sets: string[], vals: any[] }`, a module-private helper reused by Task 4.

- [ ] **Step 1: Write the failing test**

Append to `test/task-edit.test.js`:

```js
test('updateTask changes one row and leaves its group siblings alone', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const mine = await mkTask(c, f.m1, f.catId, 'CBT', 'future');
  const theirs = await mkTask(c, f.m2, f.catId, 'CBT', 'future');

  const r = await tasks.updateTask(pool, mine, { urgency: 'overdue' });
  assert.strictEqual(r.updated, 1);

  const { rows } = await pool.query(`SELECT id, urgency FROM tasks WHERE id = ANY($1)`, [[mine, theirs]]);
  const by = Object.fromEntries(rows.map(r => [r.id, r.urgency]));
  assert.strictEqual(by[mine], 'overdue');
  assert.strictEqual(by[theirs], 'future', 'the sibling row must not move');
});

test('updateTask writes all three appointment fields', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const t = await mkTask(c, f.m1, f.catId, 'Dental');

  await tasks.updateTask(pool, t, {
    appt_day: 'Saturday', appt_time: '0900', appt_location: 'Med Group' });

  const { rows: [row] } = await pool.query(
    `SELECT appt_day, appt_time, appt_location FROM tasks WHERE id=$1`, [t]);
  assert.deepStrictEqual(row,
    { appt_day: 'Saturday', appt_time: '0900', appt_location: 'Med Group' });
});

test('updateTask reports escalation only when urgency rises', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);

  const up = await mkTask(c, f.m1, f.catId, 'A', 'this_uta');
  const rUp = await tasks.updateTask(pool, up, { urgency: 'overdue' });
  assert.deepStrictEqual(rUp.escalated_member_ids, [f.m1], 'this_uta -> overdue escalates');

  const down = await mkTask(c, f.m1, f.catId, 'B', 'overdue');
  const rDown = await tasks.updateTask(pool, down, { urgency: 'future' });
  assert.deepStrictEqual(rDown.escalated_member_ids, [], 'overdue -> future does not');

  const same = await mkTask(c, f.m1, f.catId, 'C', 'this_uta');
  const rSame = await tasks.updateTask(pool, same, { details: 'typo fixed' });
  assert.deepStrictEqual(rSame.escalated_member_ids, [], 'a details-only edit does not');
});

test('updateTask leaves omitted fields alone and clears explicit nulls', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const t = await mkTask(c, f.m1, f.catId, 'CBT', 'this_uta');
  await pool.query(`UPDATE tasks SET details='keep me', appt_day='Sunday' WHERE id=$1`, [t]);

  await tasks.updateTask(pool, t, { appt_day: null });

  const { rows: [row] } = await pool.query(
    `SELECT details, appt_day, urgency FROM tasks WHERE id=$1`, [t]);
  assert.strictEqual(row.details, 'keep me', 'omitted field untouched');
  assert.strictEqual(row.appt_day, null, 'explicit null clears');
  assert.strictEqual(row.urgency, 'this_uta', 'omitted urgency untouched');
});

test('updateTask refuses an archived cycle', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('archived');
  const t = await mkTask(c, f.m1, f.catId, 'CBT');
  await assert.rejects(() => tasks.updateTask(pool, t, { urgency: 'overdue' }),
    (e) => e.code === 'NOT_EDITABLE');
});

test('updateTask with no fields is a no-op', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const t = await mkTask(c, f.m1, f.catId, 'CBT');
  const r = await tasks.updateTask(pool, t, {});
  assert.deepStrictEqual(r, { updated: 0, escalated_member_ids: [] });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit.test.js
```

Expected: FAIL — `tasks.updateTask is not a function`.

- [ ] **Step 3: Implement `buildSet` and `updateTask`**

Add to `lib/tasks.js`:

```js
// Builds "col = $n" fragments for exactly the keys present in `fields`.
// An absent key leaves the column alone; a key holding null clears it.
// `startIndex` is the first free bind position for the caller's query.
function buildSet(fields, allowed, startIndex) {
  const sets = [], vals = [];
  for (const col of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, col)) {
      vals.push(fields[col]);
      sets.push(`${col} = $${startIndex + vals.length - 1}`);
    }
  }
  return { sets, vals };
}

const TASK_FIELDS = ['urgency', 'details', 'appt_day', 'appt_time', 'appt_location'];

async function updateTask(db, taskId, fields) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertTaskEditable(client, taskId);

    // FOR UPDATE so the pre-edit urgency used for the escalation comparison
    // cannot be changed by a concurrent write between read and update.
    const { rows: before } = await client.query(
      `SELECT member_id, urgency FROM tasks WHERE id = $1 FOR UPDATE`, [taskId]);
    if (!before.length) throw Object.assign(new Error('Task not found'), { code: 'NOT_FOUND' });

    const { sets, vals } = buildSet(fields, TASK_FIELDS, 2);
    if (!sets.length) {
      await client.query('COMMIT');
      return { updated: 0, escalated_member_ids: [] };
    }

    const { rowCount } = await client.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, [taskId, ...vals]);

    const escalated =
      Object.prototype.hasOwnProperty.call(fields, 'urgency') &&
      URGENCY_RANK[fields.urgency] > URGENCY_RANK[before[0].urgency]
        ? [before[0].member_id] : [];

    await client.query('COMMIT');
    return { updated: rowCount, escalated_member_ids: escalated };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
```

Add `updateTask` to `module.exports`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit.test.js
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.js test/task-edit.test.js
git commit -m "feat: add updateTask for a single member's row"
```

---

### Task 4: `updateGroup` — edit every row in a group

**Files:**
- Modify: `lib/tasks.js`
- Test: `test/task-edit.test.js`

**Interfaces:**
- Consumes: `assertCycleEditable`, `URGENCY_RANK`, `buildSet` from Tasks 1 and 3.
- Produces: `updateGroup(db, cycleId, { category_code, title }, fields) -> { updated: <int>, escalated_member_ids: <int[]> }`. `fields` may contain `urgency` and `details` only — appointments are per-member and edited through `updateTask`. Throws `BAD_CATEGORY` for an unknown code and `NOT_FOUND` for a group with no rows.

- [ ] **Step 1: Write the failing test**

Append to `test/task-edit.test.js`:

```js
test('updateGroup changes every row in the group and nothing outside it', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const a1 = await mkTask(c, f.m1, f.catId, 'CBT', 'future');
  const a2 = await mkTask(c, f.m2, f.catId, 'CBT', 'future');
  const other = await mkTask(c, f.m1, f.catId, 'Dental', 'future');

  const r = await tasks.updateGroup(pool, c,
    { category_code: f.catCode, title: 'CBT' }, { urgency: 'this_uta' });
  assert.strictEqual(r.updated, 2);

  const { rows } = await pool.query(`SELECT id, urgency FROM tasks WHERE id = ANY($1)`,
    [[a1, a2, other]]);
  const by = Object.fromEntries(rows.map(r => [r.id, r.urgency]));
  assert.strictEqual(by[a1], 'this_uta');
  assert.strictEqual(by[a2], 'this_uta');
  assert.strictEqual(by[other], 'future', 'a different group must not be touched');
});

test('updateGroup escalates only the members who actually moved up', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  await mkTask(c, f.m1, f.catId, 'CBT', 'future');    // future -> overdue: escalates
  await mkTask(c, f.m2, f.catId, 'CBT', 'overdue');   // overdue -> overdue: no change

  const r = await tasks.updateGroup(pool, c,
    { category_code: f.catCode, title: 'CBT' }, { urgency: 'overdue' });

  assert.deepStrictEqual(r.escalated_member_ids, [f.m1],
    'only the member whose urgency rose is notified');
});

test('updateGroup refuses an archived cycle', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('archived');
  await mkTask(c, f.m1, f.catId, 'CBT', 'future');
  await assert.rejects(() => tasks.updateGroup(pool, c,
    { category_code: f.catCode, title: 'CBT' }, { urgency: 'overdue' }),
    (e) => e.code === 'NOT_EDITABLE');
});

test('updateGroup rejects an unknown category and a missing group', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  await mkTask(c, f.m1, f.catId, 'CBT', 'future');

  await assert.rejects(() => tasks.updateGroup(pool, c,
    { category_code: 'nope', title: 'CBT' }, { urgency: 'overdue' }),
    (e) => e.code === 'BAD_CATEGORY');

  await assert.rejects(() => tasks.updateGroup(pool, c,
    { category_code: f.catCode, title: 'Does Not Exist' }, { urgency: 'overdue' }),
    (e) => e.code === 'NOT_FOUND');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit.test.js
```

Expected: FAIL — `tasks.updateGroup is not a function`.

- [ ] **Step 3: Implement `updateGroup`**

Add to `lib/tasks.js`:

```js
const GROUP_FIELDS = ['urgency', 'details'];

// Group identity is the (category_id, title) pair, not an id — that is what
// listGroups buckets on. Appointments are deliberately absent from
// GROUP_FIELDS: copyForward never copies appt_* because they are per-member,
// so a group-wide appointment write would almost always be wrong.
async function updateGroup(db, cycleId, { category_code, title }, fields) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertCycleEditable(client, cycleId);

    const { rows: cat } = await client.query(
      `SELECT id FROM task_categories WHERE code = $1`, [category_code]);
    if (!cat.length) throw Object.assign(new Error('Unknown category'), { code: 'BAD_CATEGORY' });

    const { rows: before } = await client.query(
      `SELECT member_id, urgency FROM tasks
       WHERE uta_cycle_id = $1 AND category_id = $2 AND title = $3::varchar
       FOR UPDATE`, [cycleId, cat[0].id, title]);
    if (!before.length) throw Object.assign(new Error('Group not found'), { code: 'NOT_FOUND' });

    const { sets, vals } = buildSet(fields, GROUP_FIELDS, 4);
    if (!sets.length) {
      await client.query('COMMIT');
      return { updated: 0, escalated_member_ids: [] };
    }

    const { rowCount } = await client.query(
      `UPDATE tasks SET ${sets.join(', ')}
       WHERE uta_cycle_id = $1 AND category_id = $2 AND title = $3::varchar`,
      [cycleId, cat[0].id, title, ...vals]);

    // Compare each member's own pre-edit urgency: a group can hold divergent
    // values (copyForward carries them forward), so only some members move up.
    const escalated = Object.prototype.hasOwnProperty.call(fields, 'urgency')
      ? before.filter(r => URGENCY_RANK[fields.urgency] > URGENCY_RANK[r.urgency])
              .map(r => r.member_id)
      : [];

    await client.query('COMMIT');
    return { updated: rowCount, escalated_member_ids: escalated };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
```

Add `updateGroup` to `module.exports`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit.test.js
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.js test/task-edit.test.js
git commit -m "feat: add updateGroup for whole-group edits"
```

---

### Task 5: Deletes, and dropping emptied batches

**Files:**
- Modify: `lib/tasks.js`
- Modify: `lib/batches.js` (`listBatches`)
- Test: `test/task-edit.test.js`

**Interfaces:**
- Consumes: `assertTaskEditable`, `assertCycleEditable` from Task 1.
- Produces: `deleteTask(db, taskId, { force }) -> { deleted: <int> }` and `deleteGroup(db, cycleId, { category_code, title }, { force }) -> { deleted: <int> }`. Both throw `HAS_COMPLETIONS` carrying `checked_off_count` when a member has recorded a state other than `none` and `force` is falsy.
- Produces: `listBatches` omits batches whose tasks have all been deleted.

- [ ] **Step 1: Write the failing test**

Append to `test/task-edit.test.js`:

```js
const batches = require('../lib/batches');

test('deleteTask refuses to destroy a completion unless forced', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const t = await mkTask(c, f.m1, f.catId, 'CBT');
  await pool.query(
    `INSERT INTO task_completions (task_id, completed_by_id, state, note)
     VALUES ($1,$2,'done','finished at drill')`, [t, f.m1]);

  await assert.rejects(() => tasks.deleteTask(pool, t, { force: false }),
    (e) => e.code === 'HAS_COMPLETIONS' && e.checked_off_count === 1);

  const { rows: still } = await pool.query(`SELECT 1 FROM tasks WHERE id=$1`, [t]);
  assert.strictEqual(still.length, 1, 'the refused delete must not have removed anything');

  const r = await tasks.deleteTask(pool, t, { force: true });
  assert.strictEqual(r.deleted, 1);
  const { rows: gone } = await pool.query(`SELECT 1 FROM tasks WHERE id=$1`, [t]);
  assert.strictEqual(gone.length, 0);
});

test('deleteTask with no completion needs no force', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const t = await mkTask(c, f.m1, f.catId, 'CBT');
  const r = await tasks.deleteTask(pool, t, {});
  assert.strictEqual(r.deleted, 1);
});

test('a state of none does not count as a completion', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const t = await mkTask(c, f.m1, f.catId, 'CBT');
  await pool.query(`INSERT INTO task_completions (task_id, completed_by_id, state)
                    VALUES ($1,$2,'none')`, [t, f.m1]);
  await assert.doesNotReject(() => tasks.deleteTask(pool, t, {}));
});

test('deleteTask refuses an archived cycle', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('archived');
  const t = await mkTask(c, f.m1, f.catId, 'CBT');
  await assert.rejects(() => tasks.deleteTask(pool, t, { force: true }),
    (e) => e.code === 'NOT_EDITABLE');
});

test('deleteGroup counts completions across every member', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const a = await mkTask(c, f.m1, f.catId, 'CBT');
  const b = await mkTask(c, f.m2, f.catId, 'CBT');
  await pool.query(`INSERT INTO task_completions (task_id, completed_by_id, state)
                    VALUES ($1,$2,'done'), ($3,$4,'done')`, [a, f.m1, b, f.m2]);

  await assert.rejects(() => tasks.deleteGroup(pool, c,
    { category_code: f.catCode, title: 'CBT' }, { force: false }),
    (e) => e.code === 'HAS_COMPLETIONS' && e.checked_off_count === 2);

  const r = await tasks.deleteGroup(pool, c,
    { category_code: f.catCode, title: 'CBT' }, { force: true });
  assert.strictEqual(r.deleted, 2);
});

test('deleting every row individually removes the group from listGroups', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const a = await mkTask(c, f.m1, f.catId, 'CBT');
  const b = await mkTask(c, f.m2, f.catId, 'CBT');

  await tasks.deleteTask(pool, a, {});
  assert.strictEqual((await tasks.listGroups(pool, c)).length, 1, 'one row left, group survives');
  await tasks.deleteTask(pool, b, {});
  assert.strictEqual((await tasks.listGroups(pool, c)).length, 0, 'group disappears on its own');
});

test('listBatches drops a batch whose tasks have all been deleted', async () => {
  await resetDb(); const f = await seedFixtures();
  const c = await mkCycle('live', true);
  const r = await tasks.addTaskBatch(pool, c, {
    title: 'SGLI', category_code: f.catCode, details: null,
    assignments: [{ member_ids: [f.m1], urgency: 'this_uta' }], created_by_id: f.leadId });

  assert.strictEqual((await batches.listBatches(pool, c)).length, 1);

  const { rows: [t] } = await pool.query(`SELECT id FROM tasks WHERE batch_id=$1`, [r.batch_id]);
  await tasks.deleteTask(pool, t.id, {});

  assert.strictEqual((await batches.listBatches(pool, c)).length, 0,
    'a batch with nothing left to undo must not offer an Undo button');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit.test.js
```

Expected: FAIL — `tasks.deleteTask is not a function`.

- [ ] **Step 3: Implement the deletes**

Add to `lib/tasks.js`:

```js
// Mirrors undoBatch's guard in lib/batches.js: refuse to destroy work a member
// has recorded unless the caller has confirmed. 'none' is the default state and
// does not count as work.
async function countCompletions(client, taskIds) {
  if (!taskIds.length) return 0;
  const { rows } = await client.query(
    `SELECT COUNT(*)::int n FROM task_completions
     WHERE task_id = ANY($1) AND state <> 'none'`, [taskIds]);
  return rows[0].n;
}

function hasCompletions(n) {
  return Object.assign(new Error('Has completions'),
    { code: 'HAS_COMPLETIONS', checked_off_count: n });
}

async function deleteTask(db, taskId, { force } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertTaskEditable(client, taskId);

    const { rows: exists } = await client.query(
      `SELECT id FROM tasks WHERE id = $1 FOR UPDATE`, [taskId]);
    if (!exists.length) throw Object.assign(new Error('Task not found'), { code: 'NOT_FOUND' });

    const n = await countCompletions(client, [taskId]);
    if (n > 0 && !force) throw hasCompletions(n);

    await client.query(`DELETE FROM task_completions WHERE task_id = $1`, [taskId]);
    const { rowCount } = await client.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    await client.query('COMMIT');
    return { deleted: rowCount };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function deleteGroup(db, cycleId, { category_code, title }, { force } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertCycleEditable(client, cycleId);

    const { rows: cat } = await client.query(
      `SELECT id FROM task_categories WHERE code = $1`, [category_code]);
    if (!cat.length) throw Object.assign(new Error('Unknown category'), { code: 'BAD_CATEGORY' });

    const { rows } = await client.query(
      `SELECT id FROM tasks
       WHERE uta_cycle_id = $1 AND category_id = $2 AND title = $3::varchar
       FOR UPDATE`, [cycleId, cat[0].id, title]);
    if (!rows.length) throw Object.assign(new Error('Group not found'), { code: 'NOT_FOUND' });

    const ids = rows.map(r => r.id);
    const n = await countCompletions(client, ids);
    if (n > 0 && !force) throw hasCompletions(n);

    await client.query(`DELETE FROM task_completions WHERE task_id = ANY($1)`, [ids]);
    const { rowCount } = await client.query(`DELETE FROM tasks WHERE id = ANY($1)`, [ids]);
    await client.query('COMMIT');
    return { deleted: rowCount };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
```

Add `deleteTask` and `deleteGroup` to `module.exports`.

- [ ] **Step 4: Drop emptied batches from `listBatches`**

In `lib/batches.js`, in `listBatches`, add a HAVING clause after the `GROUP BY` and before the `ORDER BY`:

```sql
    GROUP BY b.id, m.rank, m.last_name
    HAVING COUNT(t.id) > 0
    ORDER BY b.created_at DESC, b.id DESC
```

Add a comment above the query:

```js
// HAVING COUNT(t.id) > 0: individual task deletes can empty a batch, and a
// batch with no tasks left would otherwise render in the undo list as
// "0 members" with an Undo button that does nothing.
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit.test.js
```

Expected: PASS, 23 tests.

- [ ] **Step 6: Confirm the existing batch tests still pass**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/batches.test.js
```

Expected: PASS. `listBatches` is asserted there with a non-empty batch, which the HAVING clause keeps.

- [ ] **Step 7: Commit**

```bash
git add lib/tasks.js lib/batches.js test/task-edit.test.js
git commit -m "feat: add guarded task and group deletes"
```

---

### Task 6: Routes, and repairing `DELETE /api/tasks/:id`

**Files:**
- Modify: `server.js`
- Test: `test/task-edit-http.test.js` (create)

**Interfaces:**
- Consumes: `updateTask`, `updateGroup`, `deleteTask`, `deleteGroup`, `assertTaskEditable` from Tasks 1, 3, 4, 5.
- Produces: `PUT /api/cycles/:id/groups`, `PUT /api/tasks/:id/definition`, `POST /api/cycles/:id/groups/delete`, and a repaired `DELETE /api/tasks/:id`.

- [ ] **Step 1: Write the failing test**

Create `test/task-edit-http.test.js`:

```js
// Route-level coverage for the two claims that unit tests cannot reach:
// that the archived-cycle guard is actually wired into DELETE /api/tasks/:id
// (spec §8 — a live defect: today that route has no guard at all and is
// reachable from public/index.html:5233), and that supervisors are held to
// their own shop while group routes stay leadership-only.
//
// DATABASE_URL must be set before requiring server.js: the app builds its pool
// from it at module-load time.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const { pool, applySchema, resetDb } = require('./helpers/db');
const app = require('../server');

let server, baseUrl;

test.before(async () => {
  await applySchema();
  await new Promise((resolve, reject) => {
    server = app.listen(0, (err) => (err ? reject(err) : resolve()));
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function cookieOf(res) {
  const all = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return all.map(c => c.split(';')[0]).join('; ');
}

async function login(slug, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, password }),
  });
  assert.strictEqual(res.status, 200, `login failed for ${slug}`);
  return cookieOf(res);
}

// Two shops so the supervisor scoping test has somewhere to reach across to.
async function world() {
  const hash = await bcrypt.hash('pw', 10);
  const { rows: [s1] } = await pool.query(`INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [s2] } = await pool.query(`INSERT INTO shops (name) VALUES ('HVAC') RETURNING id`);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO task_categories (code,label,sort_order) VALUES ('admin','Admin',1) RETURNING id`);
  const mk = async (last, shop, role) => {
    const { rows: [m] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active, must_change_password)
       VALUES ($1,'X','SSgt',$2,$3,$1,$4,true,false) RETURNING id`, [last, shop, role, hash]);
    return m.id;
  };
  return {
    catId: cat.id, catCode: 'admin',
    lead: await mk('lead', s1.id, 'leadership'),
    sup1: await mk('sup1', s1.id, 'supervisor'),
    mem1: await mk('mem1', s1.id, 'member'),
    mem2: await mk('mem2', s2.id, 'member'),
  };
}

async function mkCycle(status, isCurrent) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('Aug',$1,$2) RETURNING id`,
    [status, isCurrent]);
  return c.id;
}

async function mkTask(cycleId, memberId, catId, title, urgency = 'this_uta') {
  const { rows: [t] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [cycleId, memberId, catId, title, urgency]);
  return t.id;
}

test('DELETE /api/tasks/:id refuses an archived cycle', async () => {
  await resetDb(); const w = await world();
  const archived = await mkCycle('archived', false);
  const t = await mkTask(archived, w.mem1, w.catId, 'CBT');
  const cookie = await login('lead', 'pw');

  const res = await fetch(`${baseUrl}/api/tasks/${t}`, { method: 'DELETE', headers: { cookie } });
  assert.strictEqual(res.status, 403, 'archived cycles are closed to changes');

  const { rows } = await pool.query(`SELECT 1 FROM tasks WHERE id=$1`, [t]);
  assert.strictEqual(rows.length, 1, 'the task must survive the refused delete');
});

test('DELETE /api/tasks/:id warns before destroying a completion', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const t = await mkTask(live, w.mem1, w.catId, 'CBT');
  await pool.query(`INSERT INTO task_completions (task_id, completed_by_id, state, note)
                    VALUES ($1,$2,'done','my note')`, [t, w.mem1]);
  const cookie = await login('lead', 'pw');

  const res = await fetch(`${baseUrl}/api/tasks/${t}`, { method: 'DELETE', headers: { cookie } });
  assert.strictEqual(res.status, 409);
  assert.strictEqual((await res.json()).checked_off_count, 1);

  const forced = await fetch(`${baseUrl}/api/tasks/${t}?force=true`,
    { method: 'DELETE', headers: { cookie } });
  assert.strictEqual(forced.status, 200);
});

test('a supervisor cannot edit a row outside their shop', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const outside = await mkTask(live, w.mem2, w.catId, 'CBT');
  const cookie = await login('sup1', 'pw');

  const res = await fetch(`${baseUrl}/api/tasks/${outside}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urgency: 'overdue' }),
  });
  assert.strictEqual(res.status, 403);
});

test('a supervisor cannot edit a whole group', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  await mkTask(live, w.mem1, w.catId, 'CBT');
  const cookie = await login('sup1', 'pw');

  const res = await fetch(`${baseUrl}/api/cycles/${live}/groups`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ category_code: w.catCode, title: 'CBT', urgency: 'overdue' }),
  });
  assert.strictEqual(res.status, 403, 'group routes are leadership-only');
});

test('an invalid urgency is a 400, not a 500 from the CHECK constraint', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const t = await mkTask(live, w.mem1, w.catId, 'CBT');
  const cookie = await login('lead', 'pw');

  const res = await fetch(`${baseUrl}/api/tasks/${t}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urgency: 'very_urgent' }),
  });
  assert.strictEqual(res.status, 400);
});

test('leadership can edit a group and a single row on a live cycle', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const a = await mkTask(live, w.mem1, w.catId, 'CBT', 'future');
  const cookie = await login('lead', 'pw');

  const g = await fetch(`${baseUrl}/api/cycles/${live}/groups`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ category_code: w.catCode, title: 'CBT', urgency: 'this_uta' }),
  });
  assert.strictEqual(g.status, 200);

  const d = await fetch(`${baseUrl}/api/tasks/${a}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ appt_time: '0900' }),
  });
  assert.strictEqual(d.status, 200);

  const { rows: [row] } = await pool.query(
    `SELECT urgency, appt_time FROM tasks WHERE id=$1`, [a]);
  assert.deepStrictEqual(row, { urgency: 'this_uta', appt_time: '0900' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit-http.test.js
```

Expected: FAIL — the archived-delete test returns 200 instead of 403 (that is the live defect), and the `/definition` and group routes 404.

- [ ] **Step 3: Add a shared urgency validator and error mapper to `server.js`**

Near `reqId` (around line 191):

```js
const VALID_URGENCY = ['overdue', 'this_uta', 'next_uta', 'future', 'info'];

// Collect only the keys the caller actually sent, so lib/tasks.js can tell
// "leave unchanged" from "set to null".
function pickFields(body, allowed) {
  const out = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }
  return out;
}

// Single mapping from lib/tasks.js error codes to HTTP responses, so all four
// routes answer identically.
function sendTaskError(res, e) {
  if (e.code === 'NOT_EDITABLE')    return res.status(403).json({ error: 'This cycle is closed to changes' });
  if (e.code === 'NOT_FOUND')       return res.status(404).json({ error: 'Not found' });
  if (e.code === 'BAD_CATEGORY')    return res.status(400).json({ error: 'Unknown category' });
  if (e.code === 'HAS_COMPLETIONS') return res.status(409).json({ error: 'HAS_COMPLETIONS', checked_off_count: e.checked_off_count });
  console.error(e);
  return res.status(500).json({ error: 'Server error' });
}
```

- [ ] **Step 4: Add the three new routes**

Place them beside the other cycle routes, after `POST /api/cycles/:id/tasks`:

```js
// ── Edit a whole task group (leadership only) ────────────────────────────────
// Leadership-only because a group can span shops: a supervisor editing one
// would silently do a partial update.
app.put('/api/cycles/:id/groups', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  const cycleId = reqId(req.params.id);
  if (!cycleId) return res.status(400).json({ error: 'Invalid id' });
  const { category_code, title } = req.body || {};
  if (!category_code || !title) return res.status(400).json({ error: 'category_code and title are required' });

  const fields = pickFields(req.body, ['urgency', 'details']);
  if ('urgency' in fields && !VALID_URGENCY.includes(fields.urgency)) {
    return res.status(400).json({ error: `urgency must be one of: ${VALID_URGENCY.join(', ')}` });
  }
  try {
    res.json(await tasksLib.updateGroup(pool, cycleId, { category_code, title }, fields));
  } catch (e) { sendTaskError(res, e); }
});

// ── Edit one member's task row ───────────────────────────────────────────────
// /definition, not /:id — PUT /api/tasks/:id is already the member's completion
// state, and overloading that path would be genuinely confusing to read.
app.put('/api/tasks/:id/definition', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  const taskId = reqId(req.params.id);
  if (!taskId) return res.status(400).json({ error: 'Invalid id' });

  const fields = pickFields(req.body, ['urgency', 'details', 'appt_day', 'appt_time', 'appt_location']);
  if ('urgency' in fields && !VALID_URGENCY.includes(fields.urgency)) {
    return res.status(400).json({ error: `urgency must be one of: ${VALID_URGENCY.join(', ')}` });
  }

  const { rows: tr } = await pool.query(
    `SELECT m.shop_id FROM tasks t JOIN members m ON m.id = t.member_id WHERE t.id = $1`, [taskId]);
  if (!tr.length) return res.status(404).json({ error: 'Task not found' });
  if (req.session.role === 'supervisor' && tr[0].shop_id !== req.session.shopId) {
    return res.status(403).json({ error: 'Cannot edit tasks outside your shop' });
  }

  try {
    res.json(await tasksLib.updateTask(pool, taskId, fields));
  } catch (e) { sendTaskError(res, e); }
});

// ── Delete a whole task group (leadership only) ──────────────────────────────
// POST, not DELETE: a group's identity is a (category, title) pair rather than
// a URL id, matching the existing /copy-forward and /go-live idiom.
app.post('/api/cycles/:id/groups/delete', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  const cycleId = reqId(req.params.id);
  if (!cycleId) return res.status(400).json({ error: 'Invalid id' });
  const { category_code, title, force } = req.body || {};
  if (!category_code || !title) return res.status(400).json({ error: 'category_code and title are required' });

  try {
    res.json(await tasksLib.deleteGroup(pool, cycleId, { category_code, title }, { force: force === true }));
  } catch (e) { sendTaskError(res, e); }
});
```

The existing import at `server.js:8` destructures individual names. Add a namespace import alongside it so the new operations are reachable:

```js
const tasksLib = require('./lib/tasks');
```

- [ ] **Step 5: Repair `DELETE /api/tasks/:id`**

Replace the body of the existing route at `server.js:551` with a delegation to the guarded operation, keeping its gate and shop check:

```js
// Repaired: this route previously had neither an editable-cycle guard nor a
// completions guard, so a supervisor could delete a task out of an ARCHIVED
// cycle (rewriting history Records presents as frozen) and silently destroy a
// member's recorded state and note. It is reachable from public/index.html.
app.delete('/api/tasks/:id', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  const taskId = reqId(req.params.id);
  if (!taskId) return res.status(400).json({ error: 'Invalid id' });

  const { rows: tr } = await pool.query(
    `SELECT m.shop_id FROM tasks t JOIN members m ON m.id = t.member_id WHERE t.id = $1`, [taskId]);
  if (!tr.length) return res.status(404).json({ error: 'Task not found' });
  if (req.session.role === 'supervisor' && tr[0].shop_id !== req.session.shopId) {
    return res.status(403).json({ error: 'Cannot delete tasks outside your shop' });
  }

  try {
    res.json(await tasksLib.deleteTask(pool, taskId, { force: req.query.force === 'true' }));
  } catch (e) { sendTaskError(res, e); }
});
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit-http.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 7: Run the whole suite**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1
```

Expected: PASS, all files.

- [ ] **Step 8: Commit**

```bash
git add server.js test/task-edit-http.test.js
git commit -m "feat: add live-cycle task edit routes; fix unguarded task delete"
```

---

### Task 7: Escalation notifications

**Files:**
- Modify: `server.js` (the two update routes from Task 6)
- Test: `test/task-edit-http.test.js`

**Interfaces:**
- Consumes: `escalated_member_ids` from `updateTask` and `updateGroup`; the existing `notify(memberIds, {type, title, body, link})` helper at `server.js:197`; the `task_escalated` type added in Task 1.
- Produces: rows in `notifications` with `type = 'task_escalated'`.

- [ ] **Step 1: Write the failing test**

Append to `test/task-edit-http.test.js`:

```js
async function notifRows() {
  const { rows } = await pool.query(
    `SELECT member_id, type, title FROM notifications WHERE type='task_escalated'`);
  return rows;
}

test('escalating a row notifies that member', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const t = await mkTask(live, w.mem1, w.catId, 'CBT', 'future');
  const cookie = await login('lead', 'pw');

  await fetch(`${baseUrl}/api/tasks/${t}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urgency: 'overdue' }),
  });

  const rows = await notifRows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].member_id, w.mem1);
});

test('de-escalating and details-only edits notify nobody', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  const down = await mkTask(live, w.mem1, w.catId, 'A', 'overdue');
  const same = await mkTask(live, w.mem1, w.catId, 'B', 'this_uta');
  const cookie = await login('lead', 'pw');

  await fetch(`${baseUrl}/api/tasks/${down}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ urgency: 'future' }),
  });
  await fetch(`${baseUrl}/api/tasks/${same}/definition`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ details: 'typo fixed' }),
  });

  assert.deepStrictEqual(await notifRows(), [],
    'only an escalation is worth interrupting somebody for');
});

test('a group edit notifies only the members who moved up', async () => {
  await resetDb(); const w = await world();
  const live = await mkCycle('live', true);
  await mkTask(live, w.mem1, w.catId, 'CBT', 'future');    // rises
  await mkTask(live, w.mem2, w.catId, 'CBT', 'overdue');   // already there
  const cookie = await login('lead', 'pw');

  await fetch(`${baseUrl}/api/cycles/${live}/groups`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ category_code: w.catCode, title: 'CBT', urgency: 'overdue' }),
  });

  const rows = await notifRows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].member_id, w.mem1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit-http.test.js
```

Expected: FAIL — no `task_escalated` rows are written.

- [ ] **Step 3: Add a label helper and wire the notification**

Near `VALID_URGENCY` in `server.js`:

```js
const URGENCY_LABEL = {
  overdue: 'Overdue', this_uta: 'This UTA', next_uta: 'Next UTA',
  future: 'Future', info: 'Info',
};
```

In `PUT /api/cycles/:id/groups`, replace the `res.json(...)` line with:

```js
    const out = await tasksLib.updateGroup(pool, cycleId, { category_code, title }, fields);
    if (out.escalated_member_ids.length) {
      await notify(out.escalated_member_ids, {
        type: 'task_escalated',
        title: `Urgency changed: ${title}`,
        body: `Now marked ${URGENCY_LABEL[fields.urgency]}.`,
        link: 'member',
      });
    }
    res.json(out);
```

In `PUT /api/tasks/:id/definition`, replace the `res.json(...)` line with:

```js
    const out = await tasksLib.updateTask(pool, taskId, fields);
    if (out.escalated_member_ids.length) {
      const { rows: [t] } = await pool.query(`SELECT title FROM tasks WHERE id=$1`, [taskId]);
      await notify(out.escalated_member_ids, {
        type: 'task_escalated',
        title: `Urgency changed: ${t.title}`,
        body: `Now marked ${URGENCY_LABEL[fields.urgency]}.`,
        link: 'member',
      });
    }
    res.json(out);
```

`notify()` already logs and swallows its own failures, so a mail problem cannot fail the edit.

- [ ] **Step 4: Run the test to verify it passes**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1 test/task-edit-http.test.js
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server.js test/task-edit-http.test.js
git commit -m "feat: notify members when a task's urgency escalates"
```

---

### Task 8: The Live cycle section

**Files:**
- Modify: `public/build.html`

**Interfaces:**
- Consumes: `GET /api/cycles/:id/groups` (now carrying `urgency_mixed` / `details_mixed`), `PUT /api/cycles/:id/groups`, `PUT /api/tasks/:id/definition`, `POST /api/cycles/:id/groups/delete`, `DELETE /api/tasks/:id?force=`, and `uiConfirm` / `uiToast` from `public/ui.js`.
- Produces: no new interface. This is the last task.

- [ ] **Step 1: Confirm `ui.js` and `design.css` are loaded**

`public/build.html` already links both — verify with:

```bash
grep -n 'design.css\|ui.js' public/build.html
```

Expected: both present. If either is missing, add it in `<head>` before the page's own `<style>` block, matching `public/records.html`.

- [ ] **Step 2: Add the section markup**

After the existing batch list container (`#cycle-batches`), add:

```html
      <section id="livecycle" hidden>
        <h2 class="sec-title" id="lc-head">Live cycle</h2>
        <p class="lc-sub" id="lc-sub"></p>
        <div id="lc-list"></div>
      </section>
```

- [ ] **Step 3: Add the styles**

In the page's `<style>` block, using existing tokens only:

```css
      #livecycle { margin-top: 28px; }
      .lc-sub { font-size: 12.5px; color: var(--t2); margin: -4px 0 14px; }
      .lc-group { border: 2px solid var(--border); border-radius: var(--rs); margin-bottom: 10px; }
      .lc-ghead { display: flex; align-items: center; gap: 10px; padding: 12px 14px; }
      .lc-title { font-weight: 700; font-size: 14px; flex: 1; }
      .lc-cat { font-size: 11px; font-weight: 600; color: var(--t2); text-transform: uppercase; letter-spacing: .05em; }
      .lc-count { font-size: 12px; color: var(--t2); }
      .lc-urg { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 12px; }
      .lc-urg-mixed { background: var(--wrn-bg); color: var(--warn); }
      .lc-members { border-top: 1px solid var(--border); }
      .lc-member { display: flex; align-items: center; gap: 10px; padding: 9px 14px 9px 26px; border-top: 1px solid var(--border); font-size: 13px; }
      .lc-member:first-child { border-top: none; }
      .lc-appt { font-size: 11.5px; color: var(--t2); }
      .lc-btn { font-family: inherit; font-size: 12px; font-weight: 600; min-height: 44px; padding: 0 12px; border-radius: var(--rs); border: 2px solid var(--bm); background: transparent; color: var(--text); cursor: pointer; }
      .lc-btn-danger { color: var(--urgent); border-color: var(--urgent); }
```

- [ ] **Step 4: Add the render and handlers**

In the page's script block:

```js
const LC_URG = { overdue:'Overdue', this_uta:'This UTA', next_uta:'Next UTA', future:'Future', info:'Info' };

async function lcRender() {
  const cyc = WORKING_CYCLE;
  const host = document.getElementById('livecycle');
  if (!cyc) { host.hidden = true; return; }
  host.hidden = false;

  const live = cyc.status === 'live';
  document.getElementById('lc-head').textContent = live ? 'Live cycle' : 'Draft cycle';
  const groups = await (await fetch(`/api/cycles/${cyc.id}/groups`)).json();
  const people = new Set(groups.flatMap(g => g.members.map(m => m.id))).size;
  document.getElementById('lc-sub').textContent = live
    ? `${people} members can see this now. Changes apply immediately.`
    : 'Not yet visible to members.';

  const list = document.getElementById('lc-list');
  if (!groups.length) {
    list.innerHTML = '<div class="empty-state">No tasks in this cycle yet.</div>';
    return;
  }
  list.innerHTML = groups.map(g => `
    <div class="lc-group">
      <div class="lc-ghead">
        <span class="lc-cat">${lcEsc(g.category_code)}</span>
        <span class="lc-title">${lcEsc(g.title)}</span>
        <span class="lc-urg ${g.urgency_mixed ? 'lc-urg-mixed' : ''}">${
          g.urgency_mixed ? 'Mixed' : lcEsc(LC_URG[g.urgency] || g.urgency)}</span>
        <span class="lc-count">${g.count} member${g.count === 1 ? '' : 's'}</span>
        <button class="lc-btn" data-lc-edit="${lcEsc(g.category_code)}|${lcEsc(g.title)}">Edit</button>
        <button class="lc-btn lc-btn-danger" data-lc-del="${lcEsc(g.category_code)}|${lcEsc(g.title)}">Delete</button>
      </div>
      <div class="lc-members">${g.members.map(m => `
        <div class="lc-member">
          <span style="flex:1">${lcEsc(m.rank)} ${lcEsc(m.last_name)}</span>
          <button class="lc-btn" data-lc-medit="${m.task_id}">Edit</button>
          <button class="lc-btn lc-btn-danger" data-lc-mdel="${m.task_id}">Delete</button>
        </div>`).join('')}</div>
    </div>`).join('');
}

function lcEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// Group delete: confirm, then re-confirm naming the cost if members have
// already checked it off, mirroring how batch undo behaves.
async function lcDeleteGroup(categoryCode, title) {
  if (!await uiConfirm({ title: 'Delete this task?',
        message: `"${title}" will be removed from every member who has it.`,
        danger: true })) return;

  let res = await fetch(`/api/cycles/${WORKING_CYCLE.id}/groups/delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category_code: categoryCode, title }),
  });

  if (res.status === 409) {
    const { checked_off_count } = await res.json();
    if (!await uiConfirm({ title: 'Members have already done this',
          message: `${checked_off_count} member${checked_off_count === 1 ? ' has' : 's have'} checked this off. Deleting removes their notes too.`,
          confirmText: 'Delete anyway', danger: true })) return;
    res = await fetch(`/api/cycles/${WORKING_CYCLE.id}/groups/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category_code: categoryCode, title, force: true }),
    });
  }

  if (!res.ok) return uiToast('Could not delete that task', 'error');
  uiToast('Task deleted', 'success');
  await lcRender();
}

async function lcDeleteMember(taskId) {
  if (!await uiConfirm({ title: 'Remove this task from this member?',
        message: 'Other members keep theirs.', danger: true })) return;

  let res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
  if (res.status === 409) {
    const { checked_off_count } = await res.json();
    if (!await uiConfirm({ title: 'Already checked off',
          message: `This member has completed it. Deleting removes their note too. (${checked_off_count})`,
          confirmText: 'Delete anyway', danger: true })) return;
    res = await fetch(`/api/tasks/${taskId}?force=true`, { method: 'DELETE' });
  }
  if (!res.ok) return uiToast('Could not delete that task', 'error');
  uiToast('Task removed', 'success');
  await lcRender();
}

// Group edit. An inline editor, not window.prompt(): the builder already edits
// schedule items and work orders inline (SCHED_EDIT_REF, WO_EDIT_ID), and a
// native prompt cannot offer a constrained list of five urgencies, cannot be
// styled, and is unreachable to a screen reader in the way the rest of this app
// is not.
let LC_EDIT = null;   // "categoryCode|title" of the group being edited, or null

function lcEditorHtml(g) {
  return `
    <div class="lc-editor">
      <label class="lc-lbl" for="lc-urg-in">Urgency</label>
      <select id="lc-urg-in" class="lc-input">
        ${Object.entries(LC_URG).map(([v, label]) =>
          `<option value="${v}"${!g.urgency_mixed && g.urgency === v ? ' selected' : ''}>${label}</option>`
        ).join('')}
      </select>
      <label class="lc-lbl" for="lc-det-in">Details</label>
      <input id="lc-det-in" class="lc-input" type="text"
             value="${g.details_mixed ? '' : lcEsc(g.details || '')}"
             placeholder="${g.details_mixed ? 'Members have different details' : 'Optional'}">
      ${g.urgency_mixed ? `<p class="lc-warn" role="note">Members of this group
        currently have different urgencies. Saving applies your choice to all
        ${g.count}.</p>` : ''}
      <div class="lc-actions">
        <button class="lc-btn" data-lc-cancel="1">Cancel</button>
        <button class="lc-btn lc-btn-primary" data-lc-save="1">Save</button>
      </div>
    </div>`;
}

async function lcSaveGroup(categoryCode, title, group) {
  const urgency = document.getElementById('lc-urg-in').value;
  const detailsEl = document.getElementById('lc-det-in');

  const body = { category_code: categoryCode, title, urgency };
  // Only send details when the group is uniform, or when the operator actually
  // typed something. Otherwise an untouched placeholder on a mixed group would
  // silently blank every member's details.
  if (!group.details_mixed || detailsEl.value.trim()) body.details = detailsEl.value || null;

  const res = await fetch(`/api/cycles/${WORKING_CYCLE.id}/groups`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return uiToast('Could not save that change', 'error');
  LC_EDIT = null;
  uiToast('Task updated', 'success');
  await lcRender();
}
```

Render the editor in place of the group header when `LC_EDIT` matches that
group's `"categoryCode|title"` key, so only one group is ever open at a time.

Styles for the editor, appended to the block in Step 3:

```css
      .lc-editor { padding: 14px; border-top: 1px solid var(--border); }
      .lc-lbl { display: block; font-size: 11.5px; font-weight: 700; color: var(--t2);
                text-transform: uppercase; letter-spacing: .05em; margin: 0 0 5px; }
      .lc-input { width: 100%; padding: 10px 12px; margin-bottom: 12px;
                  border: 2px solid var(--border); border-radius: var(--rs);
                  font-family: inherit; font-size: 13.5px;
                  color: var(--text); background: var(--bg); }
      .lc-input:focus { border-color: var(--text); outline: none; }
      .lc-warn { font-size: 12.5px; line-height: 1.45; color: var(--warn);
                 background: var(--wrn-bg); padding: 10px 12px;
                 border-radius: var(--rs); margin: 0 0 12px; }
      .lc-actions { display: flex; gap: 8px; justify-content: flex-end; }
      .lc-btn-primary { background: var(--text); color: var(--bg); border-color: var(--text); }
```

Wire the buttons with one delegated listener on `#lc-list`, and call `lcRender()` wherever the builder already refreshes `#cycle-batches` after a change.

- [ ] **Step 5: Add `task_id` to the group members payload**

`lcRender` reads `m.task_id`, which `listGroups` does not currently return. In `lib/tasks.js`, add it to the `JSON_BUILD_OBJECT` in `listGroups`:

```sql
           JSON_AGG(JSON_BUILD_OBJECT('id', m.id, 'task_id', t.id,
             'last_name', m.last_name, 'first_name', m.first_name,
             'rank', m.rank) ORDER BY m.last_name) AS members
```

- [ ] **Step 6: Verify the payload change did not break copy-forward**

```bash
set -a && . ./.env.test && set +a && node --test --test-concurrency=1
```

Expected: PASS, all files. Copy-forward reads `members[].id`, which is unchanged.

- [ ] **Step 7: Verify in the browser**

Start the preview, log in as a leadership account, open `/build`, and confirm: the section header reads "Live cycle" with a member count; a group with divergent urgencies shows the **Mixed** chip; editing a group updates every member; editing one member leaves siblings alone; deleting something a member has checked off produces the second confirmation.

- [ ] **Step 8: Commit**

```bash
git add public/build.html lib/tasks.js
git commit -m "feat: add Live cycle section to the Task Builder"
```

---

## Self-Review

**Spec coverage.** §4 migration → Task 1. §5.1 `URGENCY_RANK` → Task 1. §5.2 mixed flags → Task 2. §5.3 guards → Task 1. §5.4 operations → Tasks 3, 4, 5. §5.5 `listBatches` → Task 5. §6 routes → Task 6. §6 notifications → Task 7. §7 UI → Task 8. §8 repair → Task 6. §9 edge cases → Tasks 5 and 6. §10 tests 1–12 → Tasks 1–5; tests 13–16 → Task 6.

**Deviation from the spec, recorded deliberately.** Task 8 Step 5 adds `task_id` to the `listGroups` members payload. §5.2 describes only `urgency_mixed` and `details_mixed`, but the member-level Edit and Delete buttons need a task id to address, and the alternative — a second round trip per group — is worse. The change is additive and the copy-forward caller does not read it.

**Placeholder scan.** No TBD, TODO, or "add appropriate error handling". Every code step carries the code.

**Type consistency.** `updateTask` and `updateGroup` both return `{ updated, escalated_member_ids }`, used identically in Task 7. `deleteTask` and `deleteGroup` both return `{ deleted }`. Guards throw `NOT_EDITABLE` uniformly and are mapped once in `sendTaskError`. `URGENCY_RANK` (lib) and `URGENCY_LABEL` / `VALID_URGENCY` (server) and `LC_URG` (browser) all cover exactly the same five values.
