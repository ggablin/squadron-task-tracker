# Task Builder + Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give leadership a browser-based tool to author each UTA cycle (draft → publish), add/undo tasks additively, and review any member's historical task completion — replacing the destructive Excel + CLI workflow.

**Architecture:** Extract cycle/task/batch/records logic into a thin `lib/` module layer (pure functions taking a `pg` client) so it's unit-testable against a real Postgres without HTTP/session; Express routes in `server.js` become thin, role-gated wrappers over `lib/`. Two new standalone leadership pages (`/build`, `/records`) reuse the SPA's session cookie, self-hosted font, and CSS tokens. Draft cycles are layered around the existing `is_current` pointer so **no member-facing query changes**.

**Tech Stack:** Node.js + Express, PostgreSQL via `pg`, `node:test` (built-in) for the test suite, `bcrypt`/`express-session`/`connect-pg-simple` (existing), `node-cron`/`nodemailer` (existing). No new runtime dependencies.

## Global Constraints

- **Base branch:** implement on a fresh branch off freshly-fetched `origin/master` — NOT the current `claude/impeccable-critical-fixes` checkout (~34 commits behind). See Task 1.
- **Additive safety:** every task insert uses `ON CONFLICT DO NOTHING` on the existing `tasks_cycle_member_cat_title_uniq` constraint (`uta_cycle_id, member_id, category_id, title`). Never `DELETE` task_completions on an add. Report real `added`/`skipped` counts from `RETURNING`.
- **One live cycle invariant:** exactly one `uta_cycles` row has `is_current = true` / `status = 'live'` at any time. Go-live is transactional.
- **Immutability:** completion writes are allowed only on the live cycle.
- **Auth:** authoring endpoints/pages are `requireRole('leadership')`; Records is leadership (any member) or supervisor (own shop only). All are `requireAuth` + `requireOnboarded`.
- **Migrations:** idempotent, in the `server.js` boot block, mirrored in `schema.sql`. Pattern: `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`.
- **Tests never fire cron/email:** run with `ENABLE_CRON=false`; tests call `lib/` functions directly and never `require` `server.js`.
- **Test DB SSL:** the test Postgres is a dedicated Railway database. Railway's public host is `*.rlwy.net` (no "railway" substring), so the existing SSL heuristic won't trigger — the test helper sets `ssl: { rejectUnauthorized: false }` explicitly.
- **Frontend:** reuse existing CSS tokens and self-hosted General Sans (`public/fonts/*.woff2`); no build step, no framework, no external CDN.

---

## File Structure

**Create:**
- `lib/db.js` — shared pool factory (used by `server.js` and tests).
- `lib/cycles.js` — `listCycles`, `createDraft`, `goLive`, `discardDraft`.
- `lib/tasks.js` — `listGroups`, `addTaskBatch`, `copyForward`.
- `lib/batches.js` — `listBatches`, `undoBatch`.
- `lib/records.js` — `memberHistory`, `getMemberShopId`.
- `test/helpers/db.js` — test pool + `resetDb()` + `seedFixtures()`.
- `test/cycles.test.js`, `test/tasks.test.js`, `test/batches.test.js`, `test/records.test.js`, `test/immutability.test.js`.
- `public/build.html` — authoring page (evolved from `public/task-builder-mockup.html`).
- `public/records.html` — records page.

**Modify:**
- `schema.sql` — `uta_cycles.status`, `task_batches`, `tasks.batch_id`.
- `server.js` — boot migrations; import `lib/`; new routes; immutability gate on `PUT /api/tasks/:id`; serve `/build` and `/records` gated.
- `package.json` — `"test": "node --test"`.
- `MEMORY.md` — document the new workflow (final task).

---

## Phase 0 — Setup & git base

### Task 1: Establish clean branch off origin/master

**Files:** none (git/environment only).

- [ ] **Step 1: Fetch and inspect**

```bash
cd squadron-task-tracker
git fetch origin
git status                       # note modified: server.js, public/index.html; untracked WIP: newsletter/, *athoc*, generate-sample-*.js, MEMORY.md
git log --oneline -1 origin/master
```

- [ ] **Step 2: Park the current branch's uncommitted tracked edits so nothing is lost**

```bash
git stash push -u -m "pre-taskbuilder WIP (index.html/server.js + untracked)" -- server.js public/index.html
# untracked WIP (newsletter/, athoc scripts, generators, MEMORY.md) is NOT branch-specific and stays in the working tree
```

- [ ] **Step 3: Create the implementation branch from origin/master**

```bash
git checkout -B claude/task-builder-records origin/master
git log --oneline -3           # confirm you are on the origin/master tip (Phase 2+3 / hotfix commits present)
```

- [ ] **Step 4: Move the spec + this plan onto the new branch and commit them**

The `docs/superpowers/specs/2026-07-06-*.md` and `docs/superpowers/plans/2026-07-06-*.md` files are untracked and followed the checkout. Commit them as the branch's first commit.

```bash
git add docs/superpowers/specs/2026-07-06-task-builder-and-records-design.md docs/superpowers/plans/2026-07-06-task-builder-and-records.md
git commit -m "docs: task builder + records design and plan"
```

Expected: clean commit on `claude/task-builder-records`.

### Task 2: Test harness

**Files:**
- Create: `test/helpers/db.js`
- Create: `lib/db.js`
- Modify: `package.json`
- Test: `test/helpers/db.js` self-check via a smoke test in `test/cycles.test.js` (added in Task 7); here just wire the harness.

**Interfaces:**
- Produces: `makePool(connectionString)` → `pg.Pool`; `resetDb(pool)` → truncates all data tables; `seedFixtures(pool)` → inserts a known shop/member/category/cycle set and returns their ids.

- [ ] **Step 1: Add the test script**

In `package.json` `scripts`, add:

```json
"test": "node --test"
```

- [ ] **Step 2: Create the shared pool factory**

`lib/db.js`:

```js
const { Pool } = require('pg');

// SSL on for Railway (public host *.rlwy.net has no "railway" substring, so
// check both) — off for a plain local Postgres.
function makePool(connectionString) {
  const needsSsl = /railway|rlwy\.net/.test(connectionString || '');
  return new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
  });
}

module.exports = { makePool };
```

- [ ] **Step 3: Create the test DB helper**

`test/helpers/db.js`:

```js
const fs = require('fs');
const path = require('path');
const { makePool } = require('../../lib/db');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to a throwaway Railway/local Postgres');

const pool = makePool(url);

async function applySchema() {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function resetDb() {
  await pool.query(`
    TRUNCATE task_completions, task_batches, tasks, shop_events, squadron_events,
             members, task_categories, uta_cycles, shops RESTART IDENTITY CASCADE
  `);
}

// Inserts a minimal known world; returns ids for assertions.
async function seedFixtures() {
  const { rows: [shop] } = await pool.query(
    `INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO task_categories (code, label, sort_order) VALUES ('admin','Admin',1) RETURNING id`);
  const { rows: [lead] } = await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active)
     VALUES ('mcnaughton','Ann','MSgt',$1,'leadership','mcnaughton','x',true) RETURNING id`, [shop.id]);
  const { rows: [m1] } = await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active)
     VALUES ('becerra','Joe','SrA',$1,'member','becerra','x',true) RETURNING id`, [shop.id]);
  const { rows: [m2] } = await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active)
     VALUES ('derose','Kim','SSgt',$1,'member','derose','x',true) RETURNING id`, [shop.id]);
  return { shopId: shop.id, catId: cat.id, catCode: 'admin', leadId: lead.id, m1: m1.id, m2: m2.id };
}

module.exports = { pool, applySchema, resetDb, seedFixtures };
```

- [ ] **Step 4: Document the test DB requirement**

Add to `package.json` no-op is fine; the harness throws a clear message if `TEST_DATABASE_URL` is unset. Verify the harness loads:

```bash
TEST_DATABASE_URL="<railway test db url>" node -e "require('./test/helpers/db.js'); console.log('harness ok')"
```

Expected: `harness ok`.

- [ ] **Step 5: Commit**

```bash
git add package.json lib/db.js test/helpers/db.js
git commit -m "test: add node:test harness and shared pg pool factory"
```

---

## Phase 1 — Data model foundation

### Task 3: Cycle `status` column + backfill

**Files:**
- Modify: `schema.sql` (uta_cycles + a boot-migration DO block)
- Modify: `server.js` (boot migration block — mirror the same ALTER/backfill)
- Test: `test/cycles.test.js`

**Interfaces:**
- Produces: `uta_cycles.status IN ('draft','live','archived')`; existing `is_current=true` row backfilled to `'live'`, all others `'archived'`.

- [ ] **Step 1: Write the failing test**

`test/cycles.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb } = require('./helpers/db');

test.before(applySchema);

test('backfill sets is_current cycle to live and others to archived', async () => {
  await resetDb();
  await pool.query(`INSERT INTO uta_cycles (name, is_current) VALUES ('May 2026', false)`);
  await pool.query(`INSERT INTO uta_cycles (name, is_current) VALUES ('June 2026', true)`);
  // Simulate the backfill migration:
  await pool.query(`UPDATE uta_cycles SET status = CASE WHEN is_current THEN 'live' ELSE 'archived' END`);
  const { rows } = await pool.query(`SELECT name, status FROM uta_cycles ORDER BY name`);
  assert.deepStrictEqual(rows, [
    { name: 'June 2026', status: 'live' },
    { name: 'May 2026', status: 'archived' },
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="<url>" node --test test/cycles.test.js`
Expected: FAIL — `column "status" of relation "uta_cycles" does not exist`.

- [ ] **Step 3: Add the column + backfill to schema.sql**

In `schema.sql`, inside the existing `DO $$ BEGIN ... END $$;` migration block (the one with the other `ADD COLUMN IF NOT EXISTS` lines), add:

```sql
  ALTER TABLE uta_cycles ADD COLUMN IF NOT EXISTS status VARCHAR(20)
    CHECK (status IN ('draft','live','archived')) DEFAULT 'draft';
  UPDATE uta_cycles SET status = CASE WHEN is_current THEN 'live' ELSE 'archived' END
    WHERE status IS NULL OR status = 'draft' AND (is_current = true OR NOT EXISTS (
      SELECT 1 FROM uta_cycles c2 WHERE c2.id = uta_cycles.id AND c2.status IN ('live','archived')));
```

Simplify the backfill to run once safely: gate it so it only touches pre-existing rows (those created before this migration). Use:

```sql
  ALTER TABLE uta_cycles ADD COLUMN IF NOT EXISTS status VARCHAR(20)
    CHECK (status IN ('draft','live','archived'));
  UPDATE uta_cycles SET status = CASE WHEN is_current THEN 'live' ELSE 'archived' END
    WHERE status IS NULL;
  ALTER TABLE uta_cycles ALTER COLUMN status SET DEFAULT 'draft';
```

(Null-guarded `UPDATE` is idempotent; new rows default to `'draft'`.)

- [ ] **Step 4: Mirror the same block in server.js boot migrations**

In `server.js`, locate the boot migration section (the `ADD COLUMN IF NOT EXISTS` block that runs on startup) and add the identical three statements so deployed instances migrate on boot.

- [ ] **Step 5: Update the test to run the real schema, then pass**

Replace the "Simulate the backfill" line in the test with a call that applies the real migration. Since `applySchema()` runs `schema.sql` (which now includes the backfill), change the test to insert rows, then run only the backfill statement from schema (or re-run `applySchema()`):

```js
  await pool.query(`UPDATE uta_cycles SET status = CASE WHEN is_current THEN 'live' ELSE 'archived' END WHERE status IS NULL`);
```

Run: `TEST_DATABASE_URL="<url>" node --test test/cycles.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add schema.sql server.js test/cycles.test.js
git commit -m "feat: add uta_cycles.status with live/archived backfill"
```

### Task 4: `task_batches` table + `tasks.batch_id`

**Files:**
- Modify: `schema.sql`, `server.js` (boot migrations)
- Test: `test/batches.test.js`

**Interfaces:**
- Produces: table `task_batches(id, uta_cycle_id, label, kind, created_by_id, created_at)`; `tasks.batch_id` nullable FK.

- [ ] **Step 1: Write the failing test**

`test/batches.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');

test.before(applySchema);

test('a task can be linked to a batch', async () => {
  await resetDb();
  const f = await seedFixtures();
  const { rows: [cyc] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('July 2026','draft',false) RETURNING id`);
  const { rows: [b] } = await pool.query(
    `INSERT INTO task_batches (uta_cycle_id, label, kind, created_by_id)
     VALUES ($1,'Update SGLI','new_task',$2) RETURNING id`, [cyc.id, f.leadId]);
  const { rows: [t] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, batch_id)
     VALUES ($1,$2,$3,'Update SGLI',$4) RETURNING batch_id`, [cyc.id, f.m1, f.catId, b.id]);
  assert.strictEqual(t.batch_id, b.id);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL="<url>" node --test test/batches.test.js`
Expected: FAIL — `relation "task_batches" does not exist`.

- [ ] **Step 3: Add table + column to schema.sql**

Add to `schema.sql` (top-level `CREATE TABLE IF NOT EXISTS`, and the column in the migration block):

```sql
CREATE TABLE IF NOT EXISTS task_batches (
  id            SERIAL PRIMARY KEY,
  uta_cycle_id  INTEGER REFERENCES uta_cycles(id),
  label         VARCHAR(255) NOT NULL,
  kind          VARCHAR(20) CHECK (kind IN ('new_task','copy_forward')),
  created_by_id INTEGER REFERENCES members(id),
  created_at    TIMESTAMP DEFAULT NOW()
);
```

And in the migration `DO` block:

```sql
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES task_batches(id);
```

- [ ] **Step 4: Mirror in server.js boot migrations** (same two additions).

- [ ] **Step 5: Run to verify it passes**

Run: `TEST_DATABASE_URL="<url>" node --test test/batches.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add schema.sql server.js test/batches.test.js
git commit -m "feat: add task_batches table and tasks.batch_id"
```

### Task 5: Completion immutability gate

**Files:**
- Create: `lib/tasks.js` (first function)
- Modify: `server.js` (`PUT /api/tasks/:id` — add the guard before the `task_completions` upsert at ~line 319)
- Test: `test/immutability.test.js`

**Interfaces:**
- Produces: `assertTaskInLiveCycle(db, taskId)` → resolves if the task's cycle `is_current`, else throws `Object.assign(new Error('not live'), { code: 'NOT_LIVE' })`.

- [ ] **Step 1: Write the failing test**

`test/immutability.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');
const { assertTaskInLiveCycle } = require('../lib/tasks');

test.before(applySchema);

test('rejects completion writes on a non-live (archived) cycle', async () => {
  await resetDb();
  const f = await seedFixtures();
  const { rows: [arch] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('May 2026','archived',false) RETURNING id`);
  const { rows: [t] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title) VALUES ($1,$2,$3,'Old') RETURNING id`,
    [arch.id, f.m1, f.catId]);
  await assert.rejects(() => assertTaskInLiveCycle(pool, t.id), (e) => e.code === 'NOT_LIVE');
});

test('allows completion writes on the live cycle', async () => {
  await resetDb();
  const f = await seedFixtures();
  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('June 2026','live',true) RETURNING id`);
  const { rows: [t] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title) VALUES ($1,$2,$3,'Now') RETURNING id`,
    [live.id, f.m1, f.catId]);
  await assert.doesNotReject(() => assertTaskInLiveCycle(pool, t.id));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL="<url>" node --test test/immutability.test.js`
Expected: FAIL — `Cannot find module '../lib/tasks'`.

- [ ] **Step 3: Implement the guard**

`lib/tasks.js` (create):

```js
async function assertTaskInLiveCycle(db, taskId) {
  const { rows } = await db.query(
    `SELECT 1 FROM tasks t JOIN uta_cycles c ON c.id = t.uta_cycle_id
     WHERE t.id = $1 AND c.is_current = true`, [taskId]);
  if (!rows.length) {
    throw Object.assign(new Error('Task is not in the live cycle'), { code: 'NOT_LIVE' });
  }
}

module.exports = { assertTaskInLiveCycle };
```

- [ ] **Step 4: Run to verify it passes**

Run: `TEST_DATABASE_URL="<url>" node --test test/immutability.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the guard into the route**

In `server.js`, in `PUT /api/tasks/:id` (the member completion upsert), immediately after resolving `taskId` and before the `INSERT INTO task_completions ... ON CONFLICT` statement, add:

```js
const { assertTaskInLiveCycle } = require('./lib/tasks'); // ensure imported at top of file
try {
  await assertTaskInLiveCycle(pool, taskId);
} catch (e) {
  if (e.code === 'NOT_LIVE') return res.status(403).json({ error: 'This cycle is closed to changes' });
  throw e;
}
```

(Move the `require` to the top-of-file imports.)

- [ ] **Step 6: Commit**

```bash
git add lib/tasks.js server.js test/immutability.test.js
git commit -m "feat: freeze completions on non-live cycles (history immutability)"
```

### Task 6: Draft-invisibility regression test

**Files:**
- Test: `test/immutability.test.js` (add a case)

**Interfaces:** Consumes: the member task-fetch query shape (`GET /api/tasks` filters `is_current = true`).

- [ ] **Step 1: Add the failing/guard test**

Append to `test/immutability.test.js`:

```js
test('a draft cycle\'s tasks are invisible to members (is_current filter)', async () => {
  await resetDb();
  const f = await seedFixtures();
  const { rows: [draft] } = await pool.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ('July 2026','draft',false) RETURNING id`);
  await pool.query(`INSERT INTO tasks (uta_cycle_id, member_id, category_id, title)
                    VALUES ($1,$2,$3,'Draft task')`, [draft.id, f.m1, f.catId]);
  // Mirror the member fetch: only tasks in the current cycle.
  const { rows } = await pool.query(
    `SELECT t.id FROM tasks t JOIN uta_cycles c ON c.id = t.uta_cycle_id
     WHERE t.member_id = $1 AND c.is_current = true`, [f.m1]);
  assert.strictEqual(rows.length, 0);
});
```

- [ ] **Step 2: Run to verify it passes** (documents the invariant)

Run: `TEST_DATABASE_URL="<url>" node --test test/immutability.test.js`
Expected: PASS (no draft rows leak).

- [ ] **Step 3: Commit**

```bash
git add test/immutability.test.js
git commit -m "test: assert draft cycle tasks stay invisible to members"
```

---

## Phase 2 — Builder backend

### Task 7: List cycles + create draft

**Files:**
- Modify: `lib/cycles.js` (create), `server.js` (routes)
- Test: `test/cycles.test.js`

**Interfaces:**
- Produces:
  - `listCycles(db)` → `[{ id, name, status, is_current, task_count }]` (newest first)
  - `createDraft(db, name)` → `{ id, name, status:'draft', is_current:false }`
- Routes: `GET /api/cycles` (leadership), `POST /api/cycles` `{name}` (leadership).

- [ ] **Step 1: Write failing tests**

Append to `test/cycles.test.js`:

```js
const cycles = require('../lib/cycles');

test('createDraft creates a draft that is not current', async () => {
  await resetDb(); await seedFixtures();
  const d = await cycles.createDraft(pool, 'July 2026');
  assert.strictEqual(d.status, 'draft');
  assert.strictEqual(d.is_current, false);
});

test('listCycles returns cycles with task counts, newest first', async () => {
  await resetDb(); const f = await seedFixtures();
  const d = await cycles.createDraft(pool, 'July 2026');
  await pool.query(`INSERT INTO tasks (uta_cycle_id, member_id, category_id, title)
                    VALUES ($1,$2,$3,'T')`, [d.id, f.m1, f.catId]);
  const list = await cycles.listCycles(pool);
  assert.strictEqual(list[0].name, 'July 2026');
  assert.strictEqual(Number(list[0].task_count), 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL="<url>" node --test test/cycles.test.js`
Expected: FAIL — `Cannot find module '../lib/cycles'`.

- [ ] **Step 3: Implement**

`lib/cycles.js`:

```js
async function listCycles(db) {
  const { rows } = await db.query(`
    SELECT c.id, c.name, c.status, c.is_current,
           COUNT(t.id)::int AS task_count
    FROM uta_cycles c LEFT JOIN tasks t ON t.uta_cycle_id = c.id
    GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC`);
  return rows;
}

async function createDraft(db, name) {
  const { rows } = await db.query(
    `INSERT INTO uta_cycles (name, status, is_current) VALUES ($1,'draft',false)
     RETURNING id, name, status, is_current`, [name]);
  return rows[0];
}

module.exports = { listCycles, createDraft };
```

- [ ] **Step 4: Run to verify it passes**

Run: `TEST_DATABASE_URL="<url>" node --test test/cycles.test.js`
Expected: PASS.

- [ ] **Step 5: Add the routes**

In `server.js` (after the existing task routes), with `const cycles = require('./lib/cycles')` at top:

```js
app.get('/api/cycles', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try { res.json(await cycles.listCycles(pool)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/cycles', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    res.json(await cycles.createDraft(pool, name));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
```

- [ ] **Step 6: Commit**

```bash
git add lib/cycles.js server.js test/cycles.test.js
git commit -m "feat: list cycles and create draft cycle endpoints"
```

### Task 8: Go-live + discard draft

**Files:** Modify `lib/cycles.js`, `server.js`; Test `test/cycles.test.js`.

**Interfaces:**
- Produces:
  - `goLive(db, cycleId, { confirm })` → `{ cycle:{id,name,status,is_current}, notifyMemberIds:[int] }`. Throws `{code:'NOT_DRAFT'}` if the cycle isn't a draft; `{code:'EMPTY_DRAFT'}` if it has 0 tasks and `!confirm`. Transactional: target → live/current, prior live → archived.
  - `discardDraft(db, cycleId)` → `{ deleted:true }`. Throws `{code:'NOT_DRAFT'}` if not a draft.
- Routes: `POST /api/cycles/:id/go-live`, `DELETE /api/cycles/:id`.

- [ ] **Step 1: Write failing tests**

```js
test('goLive promotes a draft, archives the prior live, returns members to notify', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('June 2026','live',true) RETURNING id`);
  const draft = await cycles.createDraft(pool, 'July 2026');
  await pool.query(`INSERT INTO tasks (uta_cycle_id, member_id, category_id, title)
                    VALUES ($1,$2,$3,'T')`, [draft.id, f.m1, f.catId]);
  const r = await cycles.goLive(pool, draft.id, { confirm: false });
  assert.strictEqual(r.cycle.is_current, true);
  const { rows } = await pool.query(`SELECT status,is_current FROM uta_cycles WHERE id=$1`, [live.id]);
  assert.deepStrictEqual(rows[0], { status: 'archived', is_current: false });
  const { rows: liveCount } = await pool.query(`SELECT COUNT(*)::int n FROM uta_cycles WHERE is_current`);
  assert.strictEqual(liveCount[0].n, 1);
  assert.ok(r.notifyMemberIds.includes(f.m1));
});

test('goLive refuses an empty draft unless confirmed', async () => {
  await resetDb(); await seedFixtures();
  const draft = await cycles.createDraft(pool, 'Empty');
  await assert.rejects(() => cycles.goLive(pool, draft.id, { confirm: false }), (e) => e.code === 'EMPTY_DRAFT');
});

test('discardDraft removes a draft but refuses a live cycle', async () => {
  await resetDb(); await seedFixtures();
  const draft = await cycles.createDraft(pool, 'Scratch');
  await cycles.discardDraft(pool, draft.id);
  const { rows } = await pool.query(`SELECT 1 FROM uta_cycles WHERE id=$1`, [draft.id]);
  assert.strictEqual(rows.length, 0);
  const { rows: [live] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('Live','live',true) RETURNING id`);
  await assert.rejects(() => cycles.discardDraft(pool, live.id), (e) => e.code === 'NOT_DRAFT');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL="<url>" node --test test/cycles.test.js`
Expected: FAIL — `cycles.goLive is not a function`.

- [ ] **Step 3: Implement (transactional)**

Add to `lib/cycles.js`:

```js
async function goLive(db, cycleId, { confirm } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(
      `SELECT id, name, status FROM uta_cycles WHERE id = $1 FOR UPDATE`, [cycleId]);
    if (!cur.length || cur[0].status !== 'draft') {
      throw Object.assign(new Error('Not a draft'), { code: 'NOT_DRAFT' });
    }
    const { rows: cnt } = await client.query(
      `SELECT COUNT(*)::int n FROM tasks WHERE uta_cycle_id = $1`, [cycleId]);
    if (cnt[0].n === 0 && !confirm) {
      throw Object.assign(new Error('Draft has no tasks'), { code: 'EMPTY_DRAFT' });
    }
    await client.query(
      `UPDATE uta_cycles SET status='archived', is_current=false WHERE is_current = true`);
    const { rows: promoted } = await client.query(
      `UPDATE uta_cycles SET status='live', is_current=true WHERE id=$1
       RETURNING id, name, status, is_current`, [cycleId]);
    const { rows: members } = await client.query(
      `SELECT id FROM members WHERE active = true`);
    await client.query('COMMIT');
    return { cycle: promoted[0], notifyMemberIds: members.map(m => m.id) };
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

async function discardDraft(db, cycleId) {
  const { rows } = await db.query(`SELECT status FROM uta_cycles WHERE id=$1`, [cycleId]);
  if (!rows.length || rows[0].status !== 'draft') {
    throw Object.assign(new Error('Not a draft'), { code: 'NOT_DRAFT' });
  }
  await db.query(`DELETE FROM tasks WHERE uta_cycle_id=$1`, [cycleId]);
  await db.query(`DELETE FROM uta_cycles WHERE id=$1`, [cycleId]);
  return { deleted: true };
}

module.exports = { listCycles, createDraft, goLive, discardDraft };
```

- [ ] **Step 4: Run to verify it passes**

Run: `TEST_DATABASE_URL="<url>" node --test test/cycles.test.js`
Expected: PASS.

- [ ] **Step 5: Add routes (route fires the notification)**

```js
app.post('/api/cycles/:id/go-live', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const { cycle, notifyMemberIds } = await cycles.goLive(pool, +req.params.id, { confirm: !!req.body.confirm });
    await notify(notifyMemberIds, { type: 'tasks_live', title: `Your ${cycle.name} tasks are live`, link: 'member' });
    res.json(cycle);
  } catch (e) {
    if (e.code === 'NOT_DRAFT') return res.status(409).json({ error: 'That cycle is not a draft' });
    if (e.code === 'EMPTY_DRAFT') return res.status(409).json({ error: 'EMPTY_DRAFT', message: 'This draft has no tasks yet.' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/cycles/:id', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try { res.json(await cycles.discardDraft(pool, +req.params.id)); }
  catch (e) {
    if (e.code === 'NOT_DRAFT') return res.status(409).json({ error: 'Only a draft can be discarded' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});
```

- [ ] **Step 6: Commit**

```bash
git add lib/cycles.js server.js test/cycles.test.js
git commit -m "feat: go-live cutover (transactional) and discard-draft endpoints"
```

### Task 9: Recurring groups (copy-forward source)

**Files:** Modify `lib/tasks.js`, `server.js`; Test `test/tasks.test.js`.

**Interfaces:**
- Produces: `listGroups(db, sourceCycleId)` → `[{ category_id, category_code, title, details, urgency, members:[{id,last_name,first_name,rank}], count }]`, grouped by (category, title).
- Route: `GET /api/cycles/:sourceId/groups` (leadership).

- [ ] **Step 1: Write failing test**

`test/tasks.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');
const tasks = require('../lib/tasks');

test.before(applySchema);

test('listGroups groups a cycle\'s tasks by category+title with members', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('June','archived',false) RETURNING id`);
  await pool.query(`INSERT INTO tasks (uta_cycle_id,member_id,category_id,title,urgency)
                    VALUES ($1,$2,$3,'SGLI','this_uta'),($1,$4,$3,'SGLI','this_uta')`,
                   [c.id, f.m1, f.catId, f.m2]);
  const groups = await tasks.listGroups(pool, c.id);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].title, 'SGLI');
  assert.strictEqual(groups[0].count, 2);
  assert.strictEqual(groups[0].members.length, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL="<url>" node --test test/tasks.test.js`
Expected: FAIL — `tasks.listGroups is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/tasks.js`:

```js
async function listGroups(db, sourceCycleId) {
  const { rows } = await db.query(`
    SELECT t.category_id, cat.code AS category_code, t.title,
           MIN(t.details) AS details, MIN(t.urgency) AS urgency,
           COUNT(*)::int AS count,
           JSON_AGG(JSON_BUILD_OBJECT('id', m.id, 'last_name', m.last_name,
             'first_name', m.first_name, 'rank', m.rank) ORDER BY m.last_name) AS members
    FROM tasks t
    JOIN task_categories cat ON cat.id = t.category_id
    JOIN members m ON m.id = t.member_id
    WHERE t.uta_cycle_id = $1
    GROUP BY t.category_id, cat.code, t.title
    ORDER BY cat.code, t.title`, [sourceCycleId]);
  return rows;
}
```

Add `listGroups` to `module.exports`.

- [ ] **Step 4: Run to verify it passes**

Run: `TEST_DATABASE_URL="<url>" node --test test/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Add route**

```js
app.get('/api/cycles/:sourceId/groups', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try { res.json(await require('./lib/tasks').listGroups(pool, +req.params.sourceId)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
```

- [ ] **Step 6: Commit**

```bash
git add lib/tasks.js server.js test/tasks.test.js
git commit -m "feat: group a cycle's tasks for the recurring/copy-forward picker"
```

### Task 10: Add task batch (new-task, additive)

**Files:** Modify `lib/tasks.js`, `server.js`; Test `test/tasks.test.js`.

**Interfaces:**
- Produces: `addTaskBatch(db, cycleId, { title, category_code, details, assignments:[{member_ids:[int], urgency}], created_by_id })` → `{ batch_id, added, skipped }`. One `new_task` batch; `ON CONFLICT DO NOTHING`; `added` = rows actually inserted, `skipped` = requested − added.
- Route: `POST /api/cycles/:id/tasks` (leadership).

- [ ] **Step 1: Write failing tests**

```js
test('addTaskBatch inserts one row per member per assignment, additively', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('July','draft',false) RETURNING id`);
  const r = await tasks.addTaskBatch(pool, c.id, {
    title: 'SGLI', category_code: f.catCode, details: null,
    assignments: [{ member_ids: [f.m1, f.m2], urgency: 'this_uta' }], created_by_id: f.leadId,
  });
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.skipped, 0);
  const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM tasks WHERE batch_id=$1`, [r.batch_id]);
  assert.strictEqual(rows[0].n, 2);
});

test('addTaskBatch skips duplicates via ON CONFLICT and reports skipped', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('July','draft',false) RETURNING id`);
  const base = { title: 'SGLI', category_code: f.catCode, details: null, created_by_id: f.leadId };
  await tasks.addTaskBatch(pool, c.id, { ...base, assignments: [{ member_ids: [f.m1], urgency: 'this_uta' }] });
  const r = await tasks.addTaskBatch(pool, c.id, { ...base, assignments: [{ member_ids: [f.m1, f.m2], urgency: 'this_uta' }] });
  assert.strictEqual(r.added, 1);   // m2 only
  assert.strictEqual(r.skipped, 1); // m1 already existed
});
```

> Note: the `tasks_cycle_member_cat_title_uniq` constraint must exist for `ON CONFLICT` to work. It is created on `origin/master` (schema.sql / boot migration). Confirm it is present in `applySchema()`; if absent from `schema.sql`, add `ALTER TABLE tasks ADD CONSTRAINT tasks_cycle_member_cat_title_uniq UNIQUE (uta_cycle_id, member_id, category_id, title);` guarded in the migration block.

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL="<url>" node --test test/tasks.test.js`
Expected: FAIL — `tasks.addTaskBatch is not a function`.

- [ ] **Step 3: Implement (transactional; resolves category once)**

```js
async function addTaskBatch(db, cycleId, { title, category_code, details, assignments, created_by_id }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: cat } = await client.query(
      `SELECT id FROM task_categories WHERE code=$1`, [category_code]);
    if (!cat.length) throw Object.assign(new Error('bad category'), { code: 'BAD_CATEGORY' });
    const { rows: batch } = await client.query(
      `INSERT INTO task_batches (uta_cycle_id, label, kind, created_by_id)
       VALUES ($1,$2,'new_task',$3) RETURNING id`, [cycleId, title, created_by_id]);
    let added = 0, requested = 0;
    for (const a of assignments) {
      for (const memberId of a.member_ids) {
        requested++;
        const { rowCount } = await client.query(
          `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency, batch_id, created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (uta_cycle_id, member_id, category_id, title) DO NOTHING`,
          [cycleId, memberId, cat[0].id, title, details || null, a.urgency || 'this_uta', batch.id, created_by_id]);
        added += rowCount;
      }
    }
    await client.query('COMMIT');
    return { batch_id: batch.id, added, skipped: requested - added };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
```

Add `addTaskBatch` to exports.

- [ ] **Step 4: Run to verify it passes**

Run: `TEST_DATABASE_URL="<url>" node --test test/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Add route**

```js
app.post('/api/cycles/:id/tasks', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const { title, category_code, details, assignments } = req.body;
    if (!title || !category_code || !Array.isArray(assignments) || !assignments.length) {
      return res.status(400).json({ error: 'title, category_code, and assignments are required' });
    }
    const r = await require('./lib/tasks').addTaskBatch(pool, +req.params.id, {
      title, category_code, details, assignments, created_by_id: req.session.memberId,
    });
    res.json(r);
  } catch (e) {
    if (e.code === 'BAD_CATEGORY') return res.status(400).json({ error: 'Invalid category' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});
```

- [ ] **Step 6: Commit**

```bash
git add lib/tasks.js server.js test/tasks.test.js
git commit -m "feat: additive add-task batch endpoint with skip counts"
```

### Task 11: Copy-forward

**Files:** Modify `lib/tasks.js`, `server.js`; Test `test/tasks.test.js`.

**Interfaces:**
- Produces: `copyForward(db, targetCycleId, { from_cycle_id, groups:[{category_code, title, member_ids?}], created_by_id })` → `[{ category_code, title, batch_id, added, skipped }]`. One `copy_forward` batch per group; appointment fields dropped; inactive members skipped. If `member_ids` omitted for a group, uses the source group's members.

- [ ] **Step 1: Write failing test**

```js
test('copyForward carries a group to a new cycle, drops appts, skips inactive', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [src] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('June','archived',false) RETURNING id`);
  await pool.query(`UPDATE members SET active=false WHERE id=$1`, [f.m2]); // m2 left the unit
  await pool.query(`INSERT INTO tasks (uta_cycle_id,member_id,category_id,title,urgency,appt_day,appt_time)
                    VALUES ($1,$2,$3,'SGLI','this_uta','Sat','0900'),($1,$4,$3,'SGLI','this_uta','Sat','0930')`,
                   [src.id, f.m1, f.catId, f.m2]);
  const { rows: [dst] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('July','draft',false) RETURNING id`);
  const res = await tasks.copyForward(pool, dst.id, {
    from_cycle_id: src.id,
    groups: [{ category_code: f.catCode, title: 'SGLI' }],
    created_by_id: f.leadId,
  });
  assert.strictEqual(res[0].added, 1);   // only active m1
  const { rows } = await pool.query(
    `SELECT appt_day, appt_time FROM tasks WHERE uta_cycle_id=$1`, [dst.id]);
  assert.strictEqual(rows[0].appt_day, null);
  assert.strictEqual(rows[0].appt_time, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL="<url>" node --test test/tasks.test.js`
Expected: FAIL — `tasks.copyForward is not a function`.

- [ ] **Step 3: Implement**

```js
async function copyForward(db, targetCycleId, { from_cycle_id, groups, created_by_id }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = [];
    for (const g of groups) {
      const { rows: cat } = await client.query(
        `SELECT id FROM task_categories WHERE code=$1`, [g.category_code]);
      if (!cat.length) continue;
      // Source members for this group (active only), unless caller supplied member_ids.
      let memberIds = g.member_ids;
      if (!memberIds) {
        const { rows } = await client.query(
          `SELECT DISTINCT t.member_id FROM tasks t JOIN members m ON m.id=t.member_id
           WHERE t.uta_cycle_id=$1 AND t.category_id=$2 AND t.title=$3 AND m.active=true`,
          [from_cycle_id, cat[0].id, g.title]);
        memberIds = rows.map(r => r.member_id);
      }
      const { rows: batch } = await client.query(
        `INSERT INTO task_batches (uta_cycle_id, label, kind, created_by_id)
         VALUES ($1,$2,'copy_forward',$3) RETURNING id`,
        [targetCycleId, `Copy: ${g.title}`, created_by_id]);
      let added = 0;
      for (const memberId of memberIds) {
        // Carry title/details/urgency from the source row; never appt_* fields.
        const { rowCount } = await client.query(
          `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency, batch_id, created_by_id)
           SELECT $1, $2, $3, $4, MIN(details), MIN(urgency), $5, $6
           FROM tasks WHERE uta_cycle_id=$7 AND category_id=$3 AND title=$4 AND member_id=$2
           GROUP BY title
           ON CONFLICT (uta_cycle_id, member_id, category_id, title) DO NOTHING`,
          [targetCycleId, memberId, cat[0].id, g.title, batch.id, created_by_id, from_cycle_id]);
        added += rowCount;
      }
      out.push({ category_code: g.category_code, title: g.title, batch_id: batch.id, added, skipped: memberIds.length - added });
    }
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
```

Add `copyForward` to exports.

- [ ] **Step 4: Run to verify it passes**

Run: `TEST_DATABASE_URL="<url>" node --test test/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Add route**

```js
app.post('/api/cycles/:id/copy-forward', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const { from_cycle_id, groups } = req.body;
    if (!from_cycle_id || !Array.isArray(groups) || !groups.length) {
      return res.status(400).json({ error: 'from_cycle_id and groups are required' });
    }
    res.json(await require('./lib/tasks').copyForward(pool, +req.params.id, {
      from_cycle_id, groups, created_by_id: req.session.memberId,
    }));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
```

- [ ] **Step 6: Commit**

```bash
git add lib/tasks.js server.js test/tasks.test.js
git commit -m "feat: copy-forward recurring task groups into a draft cycle"
```

### Task 12: Batches list + undo

**Files:** Create `lib/batches.js`; Modify `server.js`; Test `test/batches.test.js`.

**Interfaces:**
- Produces:
  - `listBatches(db, cycleId)` → `[{ id, label, kind, member_count, created_by, created_at }]` (newest first).
  - `undoBatch(db, batchId, { force })` → `{ deleted }`. Throws `Object.assign(new Error(...), { code:'HAS_COMPLETIONS', checked_off_count })` if any task in the batch has completion `state != 'none'` and `!force`. Deletes completions + tasks + batch row in a transaction.
- Routes: `GET /api/cycles/:id/batches`, `DELETE /api/batches/:id?force=`.

- [ ] **Step 1: Write failing tests**

```js
const batches = require('../lib/batches');
const tasks = require('../lib/tasks');

test('listBatches returns this-cycle batches with member counts', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('July','draft',false) RETURNING id`);
  const r = await tasks.addTaskBatch(pool, c.id, {
    title: 'SGLI', category_code: f.catCode, details: null,
    assignments: [{ member_ids: [f.m1, f.m2], urgency: 'this_uta' }], created_by_id: f.leadId });
  const list = await batches.listBatches(pool, c.id);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].member_count, 2);
  assert.strictEqual(list[0].id, r.batch_id);
});

test('undoBatch deletes tasks; warns when checked off unless forced', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [c] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current) VALUES ('July','draft',false) RETURNING id`);
  const r = await tasks.addTaskBatch(pool, c.id, {
    title: 'SGLI', category_code: f.catCode, details: null,
    assignments: [{ member_ids: [f.m1], urgency: 'this_uta' }], created_by_id: f.leadId });
  const { rows: [t] } = await pool.query(`SELECT id FROM tasks WHERE batch_id=$1`, [r.batch_id]);
  await pool.query(`INSERT INTO task_completions (task_id, completed_by_id, state)
                    VALUES ($1,$2,'done')`, [t.id, f.m1]);
  await assert.rejects(() => batches.undoBatch(pool, r.batch_id, { force: false }),
    (e) => e.code === 'HAS_COMPLETIONS' && e.checked_off_count === 1);
  await batches.undoBatch(pool, r.batch_id, { force: true });
  const { rows } = await pool.query(`SELECT 1 FROM tasks WHERE batch_id=$1`, [r.batch_id]);
  assert.strictEqual(rows.length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL="<url>" node --test test/batches.test.js`
Expected: FAIL — `Cannot find module '../lib/batches'`.

- [ ] **Step 3: Implement**

`lib/batches.js`:

```js
async function listBatches(db, cycleId) {
  const { rows } = await db.query(`
    SELECT b.id, b.label, b.kind, b.created_at,
           (m.rank || ' ' || m.last_name) AS created_by,
           COUNT(t.id)::int AS member_count
    FROM task_batches b
    LEFT JOIN tasks t ON t.batch_id = b.id
    LEFT JOIN members m ON m.id = b.created_by_id
    WHERE b.uta_cycle_id = $1
    GROUP BY b.id, m.rank, m.last_name
    ORDER BY b.created_at DESC, b.id DESC`, [cycleId]);
  return rows;
}

async function undoBatch(db, batchId, { force } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: chk } = await client.query(
      `SELECT COUNT(*)::int n FROM task_completions tc
       JOIN tasks t ON t.id = tc.task_id
       WHERE t.batch_id = $1 AND tc.state <> 'none'`, [batchId]);
    if (chk[0].n > 0 && !force) {
      throw Object.assign(new Error('Batch has completions'),
        { code: 'HAS_COMPLETIONS', checked_off_count: chk[0].n });
    }
    await client.query(
      `DELETE FROM task_completions WHERE task_id IN (SELECT id FROM tasks WHERE batch_id=$1)`, [batchId]);
    await client.query(`DELETE FROM tasks WHERE batch_id=$1`, [batchId]);
    await client.query(`DELETE FROM task_batches WHERE id=$1`, [batchId]);
    await client.query('COMMIT');
    return { deleted: true };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

module.exports = { listBatches, undoBatch };
```

- [ ] **Step 4: Run to verify it passes**

Run: `TEST_DATABASE_URL="<url>" node --test test/batches.test.js`
Expected: PASS.

- [ ] **Step 5: Add routes**

```js
const batches = require('./lib/batches'); // at top
app.get('/api/cycles/:id/batches', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try { res.json(await batches.listBatches(pool, +req.params.id)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
app.delete('/api/batches/:id', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try { res.json(await batches.undoBatch(pool, +req.params.id, { force: req.query.force === 'true' })); }
  catch (e) {
    if (e.code === 'HAS_COMPLETIONS') return res.status(409).json({ error: 'HAS_COMPLETIONS', checked_off_count: e.checked_off_count });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});
```

- [ ] **Step 6: Commit**

```bash
git add lib/batches.js server.js test/batches.test.js
git commit -m "feat: list batches and undo-batch with checked-off guard"
```

---

## Phase 3 — Builder frontend (`/build`)

> Frontend tasks are verified via the preview workflow (login as leadership, exercise the flow), not node:test. Reuse the existing markup in `public/task-builder-mockup.html`; replace its `toast()` stubs and hardcoded sample data with real `fetch()` calls to the Phase 2 endpoints. Keep the same CSS/markup; the work is JS wiring.

### Task 13: Serve `/build` gated, seeded from the mockup

**Files:** Create `public/build.html`; Modify `server.js`.

- [ ] **Step 1:** Copy `public/task-builder-mockup.html` → `public/build.html`. Remove the `.mock-pill` "Mockup — not live" element and the footer "no real data" line.

- [ ] **Step 2:** Add a server-side gated route in `server.js` (before the SPA catch-all):

```js
function requireLeadershipPage(req, res, next) {
  if (!req.session.memberId) return res.redirect('/');
  next(); // client-side fetches are role-checked by the API; page shell is harmless
}
app.get('/build', requireLeadershipPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'build.html')));
```

> The APIs enforce `requireRole('leadership')`, so a non-leader who loads the shell gets 403s and an empty page. That's acceptable; optionally hard-gate by checking role in `requireLeadershipPage` via a DB lookup on `req.session.memberId`.

- [ ] **Step 3: Verify (preview).** Start the dev server (preview_start), log in as a leadership account, navigate to `/build`. Expected: page renders with the mockup UI, no "not live" pill. Confirm via preview_snapshot.

- [ ] **Step 4: Commit**

```bash
git add public/build.html server.js
git commit -m "feat: serve /build page (leadership) from the former mockup"
```

### Task 14: Wire home — cycle bar, new cycle, go-live

**Files:** Modify `public/build.html` (inline `<script>`).

- [ ] **Step 1:** Replace the hardcoded cycle bar + catalog population with a load function:

```js
async function loadHome() {
  const cycles = await fetch('/api/cycles').then(r => r.json());
  const live = cycles.find(c => c.is_current);
  const draft = cycles.find(c => c.status === 'draft');
  renderCycleBar({ live, draft });        // existing render targets in the markup
  if (live) {
    const groups = await fetch(`/api/cycles/${live.id}/groups`).then(r => r.json());
    renderCatalog(groups);                // "Recurring tasks" list
  }
  if (draft) renderBatches(await fetch(`/api/cycles/${draft.id}/batches`).then(r => r.json()));
}
```

- [ ] **Step 2:** Wire "+ New cycle" → `POST /api/cycles {name}` (prompt for month name), then `loadHome()`. Wire "Go live →" → `POST /api/cycles/:id/go-live`; on `409 EMPTY_DRAFT`, confirm and retry with `{confirm:true}`; on success show the "tasks are live" toast and `loadHome()`.

- [ ] **Step 3: Verify (preview).** Create a draft cycle, confirm it appears as the working cycle; press Go live on an empty draft → see the confirm; confirm → cycle becomes live. Use preview_snapshot / preview_network to confirm the POSTs return 200.

- [ ] **Step 4: Commit**

```bash
git add public/build.html
git commit -m "feat: wire /build home to cycles + go-live"
```

### Task 15: Wire the new-task builder

**Files:** Modify `public/build.html`.

- [ ] **Step 1:** Load roster + categories on entering the builder screen:

```js
async function loadBuilderRefData() {
  const [members, cats] = await Promise.all([
    fetch('/api/squadron/members').then(r => r.json()),
    fetch('/api/categories').then(r => r.json()),
  ]);
  renderRoster(members);       // grouped by shop; tap to select
  renderCategoryOptions(cats); // populate #f-cat
}
```

- [ ] **Step 2:** Keep the existing client-side "batches so far" (per-urgency member groups) as an in-memory array `assignments = [{ member_ids, urgency }]`. On "Add task for N members", POST:

```js
async function commitNewTask(cycleId) {
  const body = {
    title: val('#f-title'), category_code: selectedCategoryCode(),
    details: val('#f-det'), assignments,
  };
  const r = await fetch(`/api/cycles/${cycleId}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());
  toast(`Added for ${r.added} members${r.skipped ? ` (${r.skipped} already had it)` : ''}`);
  goHome();
}
```

The working `cycleId` is the draft if one exists, else the live cycle (from `loadHome`).

- [ ] **Step 3: Verify (preview).** Build a task, tap two members at one urgency, save batch, tap another at a different urgency, review, add. Confirm `added` count and that re-adding the same task reports `skipped`. preview_network to inspect the POST payload/response.

- [ ] **Step 4: Commit**

```bash
git add public/build.html
git commit -m "feat: wire new-task builder to additive add endpoint"
```

### Task 16: Wire copy-forward

**Files:** Modify `public/build.html`.

- [ ] **Step 1:** On "Start from [last cycle]", load the source groups and render the untickable list:

```js
async function loadCopyForward(sourceCycleId) {
  const groups = await fetch(`/api/cycles/${sourceCycleId}/groups`).then(r => r.json());
  renderCopyForwardList(groups); // each row tickable; default ticked
}
```

- [ ] **Step 2:** On "Copy N groups → [month]", POST the ticked groups:

```js
async function commitCopyForward(targetCycleId, sourceCycleId, tickedGroups) {
  const res = await fetch(`/api/cycles/${targetCycleId}/copy-forward`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_cycle_id: sourceCycleId,
      groups: tickedGroups.map(g => ({ category_code: g.category_code, title: g.title })) }),
  }).then(r => r.json());
  const total = res.reduce((n, g) => n + g.added, 0);
  toast(`Copied ${total} tasks into the draft`);
  goHome();
}
```

- [ ] **Step 3: Verify (preview).** With a prior cycle present, create a draft, copy 2 groups forward, confirm they appear as batches in "Added this cycle" and the tasks exist (preview_network).

- [ ] **Step 4: Commit**

```bash
git add public/build.html
git commit -m "feat: wire copy-forward picker to the draft cycle"
```

### Task 17: Wire "Added this cycle" + undo

**Files:** Modify `public/build.html`.

- [ ] **Step 1:** Render batches from `GET /api/cycles/:id/batches`; each row's Undo calls:

```js
async function undoBatch(batchId) {
  let res = await fetch(`/api/batches/${batchId}`, { method: 'DELETE' });
  if (res.status === 409) {
    const { checked_off_count } = await res.json();
    if (!confirm(`${checked_off_count} member(s) already checked this off. Remove anyway?`)) return;
    res = await fetch(`/api/batches/${batchId}?force=true`, { method: 'DELETE' });
  }
  if (res.ok) { toast('Removed'); loadHome(); }
}
```

- [ ] **Step 2: Verify (preview).** Add a batch, undo it (no check-offs → immediate). On the live cycle, check one off as a member, then undo as leadership → confirm the warning path. preview_network to confirm the 409 then forced 200.

- [ ] **Step 3: Commit**

```bash
git add public/build.html
git commit -m "feat: wire added-this-cycle list and batch undo"
```

---

## Phase 4 — Records backend

### Task 18: Member history endpoint

**Files:** Create `lib/records.js`; Modify `server.js`; Test `test/records.test.js`.

**Interfaces:**
- Produces:
  - `memberHistory(db, memberId)` → `[{ cycle:{id,name,status,is_current}, done, total, tasks:[{id,category_code,title,urgency,state,note}] }]` newest-first.
  - `getMemberShopId(db, memberId)` → `int|null`.
- Route: `GET /api/members/:id/history` — leadership any; supervisor only if the target's `shop_id` equals the requester's `shop_id`, else 403.

- [ ] **Step 1: Write failing test**

`test/records.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb, seedFixtures } = require('./helpers/db');
const records = require('../lib/records');

test.before(applySchema);

test('memberHistory summarizes done/total per cycle, newest first', async () => {
  await resetDb(); const f = await seedFixtures();
  const { rows: [june] } = await pool.query(
    `INSERT INTO uta_cycles (name,status,is_current,created_at) VALUES ('June','archived',false, NOW() - INTERVAL '30 days') RETURNING id`);
  const { rows: [t1] } = await pool.query(
    `INSERT INTO tasks (uta_cycle_id,member_id,category_id,title) VALUES ($1,$2,$3,'A') RETURNING id`, [june.id, f.m1, f.catId]);
  await pool.query(`INSERT INTO tasks (uta_cycle_id,member_id,category_id,title) VALUES ($1,$2,$3,'B')`, [june.id, f.m1, f.catId]);
  await pool.query(`INSERT INTO task_completions (task_id, completed_by_id, state) VALUES ($1,$2,'done')`, [t1.id, f.m1]);
  const hist = await records.memberHistory(pool, f.m1);
  assert.strictEqual(hist[0].cycle.name, 'June');
  assert.strictEqual(hist[0].total, 2);
  assert.strictEqual(hist[0].done, 1);
  assert.strictEqual(hist[0].tasks.length, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL="<url>" node --test test/records.test.js`
Expected: FAIL — `Cannot find module '../lib/records'`.

- [ ] **Step 3: Implement**

`lib/records.js`:

```js
async function getMemberShopId(db, memberId) {
  const { rows } = await db.query(`SELECT shop_id FROM members WHERE id=$1`, [memberId]);
  return rows.length ? rows[0].shop_id : null;
}

async function memberHistory(db, memberId) {
  const { rows } = await db.query(`
    SELECT c.id AS cycle_id, c.name, c.status, c.is_current,
           t.id AS task_id, cat.code AS category_code, t.title, t.urgency,
           COALESCE(tc.state,'none') AS state, tc.note
    FROM tasks t
    JOIN uta_cycles c ON c.id = t.uta_cycle_id
    JOIN task_categories cat ON cat.id = t.category_id
    LEFT JOIN task_completions tc ON tc.task_id = t.id
    WHERE t.member_id = $1
    ORDER BY c.created_at DESC, c.id DESC, cat.sort_order, t.title`, [memberId]);
  const byCycle = new Map();
  for (const r of rows) {
    if (!byCycle.has(r.cycle_id)) {
      byCycle.set(r.cycle_id, {
        cycle: { id: r.cycle_id, name: r.name, status: r.status, is_current: r.is_current },
        done: 0, total: 0, tasks: [],
      });
    }
    const c = byCycle.get(r.cycle_id);
    c.total++;
    if (r.state === 'done') c.done++;
    c.tasks.push({ id: r.task_id, category_code: r.category_code, title: r.title, urgency: r.urgency, state: r.state, note: r.note });
  }
  return [...byCycle.values()];
}

module.exports = { memberHistory, getMemberShopId };
```

- [ ] **Step 4: Run to verify it passes**

Run: `TEST_DATABASE_URL="<url>" node --test test/records.test.js`
Expected: PASS.

- [ ] **Step 5: Add the role-scoped route**

```js
const records = require('./lib/records'); // at top
app.get('/api/members/:id/history', requireAuth, requireOnboarded, async (req, res) => {
  try {
    const targetId = +req.params.id;
    const role = req.session.role; // set at login; if unavailable, look up member
    if (role !== 'leadership') {
      if (role !== 'supervisor') return res.status(403).json({ error: 'Forbidden' });
      const [mineShop, theirShop] = await Promise.all([
        records.getMemberShopId(pool, req.session.memberId),
        records.getMemberShopId(pool, targetId),
      ]);
      if (!mineShop || mineShop !== theirShop) return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(await records.memberHistory(pool, targetId));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
```

> If `req.session.role` isn't populated at login, add it in the login handler (`req.session.role = member.role`) or look it up here from `members`. Verify against the existing `requireRole` implementation to match how role is read.

- [ ] **Step 6: Commit**

```bash
git add lib/records.js server.js test/records.test.js
git commit -m "feat: member task history endpoint with supervisor own-shop scoping"
```

---

## Phase 5 — Records frontend (`/records`)

### Task 19: Serve `/records` gated + member browser

**Files:** Create `public/records.html`; Modify `server.js`.

- [ ] **Step 1:** Create `public/records.html` reusing the SPA's CSS tokens + General Sans (copy the `<style>`/font `@font-face` from `build.html`). Layout: left = member list grouped by shop (search box); right = selected member's history (empty initially).

- [ ] **Step 2:** Serve it gated (same helper as `/build`):

```js
app.get('/records', requireLeadershipPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'records.html')));
```

- [ ] **Step 3:** Populate the member list from `/api/squadron/members` (leadership) or `/api/shop/members` (supervisor). Clicking a member calls Task 20's loader.

- [ ] **Step 4: Verify (preview).** Log in as leadership → `/records` shows all members by shop; as a supervisor → only own shop. preview_snapshot to confirm.

- [ ] **Step 5: Commit**

```bash
git add public/records.html server.js
git commit -m "feat: serve /records page with member browser"
```

### Task 20: Member history drill-down

**Files:** Modify `public/records.html`.

- [ ] **Step 1:** On member click, load and render history:

```js
async function loadMemberHistory(memberId, name) {
  const hist = await fetch(`/api/members/${memberId}/history`).then(r => r.json());
  renderHistoryHeader(name);
  // Each cycle: summary row "June 2026 — 8/10 done" expands to its task list.
  renderCycles(hist.map(h => ({
    title: h.cycle.name, badge: h.cycle.is_current ? 'current' : h.cycle.status,
    summary: `${h.done}/${h.total} done`,
    tasks: h.tasks, // {title, category_code, urgency, state, note}
  })));
}
```

- [ ] **Step 2:** Render each cycle collapsed with the summary; expand to show tasks with a done/not-done marker and any note. Archived cycles read-only (no checkboxes — display markers only).

- [ ] **Step 3: Verify (preview).** Pick a member with history → see per-cycle summaries → expand June → see which tasks were done. preview_snapshot.

- [ ] **Step 4: Commit**

```bash
git add public/records.html
git commit -m "feat: per-member cycle history drill-down in /records"
```

---

## Phase 6 — Docs & rollout

### Task 21: Update handoff docs + verify deploy

**Files:** Modify `MEMORY.md` (and `DEMO-BRIEFING.md` if present).

- [ ] **Step 1:** In `MEMORY.md`, update §6 (data workflow) and §9/§10: the builder (`/build`) is now the normal monthly path (draft → copy-forward → add → go-live); `import-tasks.js`/`sync-tasks.js` are the legacy/backup CLI (one path per cycle); add the `/records` reviewer and the `status`/`task_batches` schema additions; note the `lib/` module layer and the `node:test` suite (`TEST_DATABASE_URL`).

- [ ] **Step 2:** Run the full suite once:

Run: `TEST_DATABASE_URL="<url>" ENABLE_CRON=false npm test`
Expected: all tests PASS.

- [ ] **Step 3:** Open a PR to `master`; on merge, Railway auto-deploys. Verify live: `/` 200, `/api/auth/me` 401 unauthed, `/build` redirects when logged out, boot migrations applied (no errors in Railway logs).

- [ ] **Step 4: Commit**

```bash
git add MEMORY.md
git commit -m "docs: document task builder + records workflow and schema"
```

---

## Self-Review

**Spec coverage:** §5.1 cycle status → Task 3; §5.2 batches → Task 4; §5.3 unique-constraint reuse → Task 10 (note); §5.4 retention/immutability → Tasks 5–6; §5.5 migrations → Tasks 3–4; §6 cycles → Tasks 7–8; copy-forward/groups → Tasks 9, 11; new task → Task 10; batches/undo → Task 12; records → Task 18; supporting reads (reuse) → Tasks 15/19; completion gating → Task 5; §7.1 /build → Tasks 13–17; §7.2 /records → Tasks 19–20; §7.3 member app (only gating) → Task 5; §10 tests → Phases 1–2, 4; §11 git base/rollout → Tasks 1, 21. No uncovered spec sections.

**Placeholder scan:** every code step contains real code; no TBD/TODO-as-requirement. Frontend "render*" helpers reference the existing mockup markup and are wired with concrete fetch code; the one soft spot (exact completion route line, `req.session.role` availability) is flagged with a verify-against-existing-code instruction, not left blank.

**Type consistency:** `addTaskBatch` returns `{batch_id, added, skipped}` (Task 10) consumed in Task 15; `undoBatch` throws `{code:'HAS_COMPLETIONS', checked_off_count}` (Task 12) consumed in Task 17; `memberHistory` shape (Task 18) consumed in Task 20; `goLive` returns `{cycle, notifyMemberIds}` (Task 8) consumed by the route + `notify()` signature (`memberIds, {type,title,body,link}`). Consistent.
