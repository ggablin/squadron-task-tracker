# Squadron Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-app group chat (squadron-wide, leadership-only, and one channel per shop) so the squadron can retire TeamApp.

**Architecture:** Three new Postgres tables (`channels`, `messages`, `channel_reads`) behind a new `lib/chat.js`, five Express routes in `server.js` gated by the app's existing `role`/`shop_id` session fields, a standalone `pushToMembers()` addition to `lib/push.js` (not routed through the `notifications` table), and a fifth top-level PWA nav tab (`public/chat.js`) that polls for new messages while open.

**Tech Stack:** Node 24, Express 4 (+ `express-async-errors`), `pg` (raw parameterized SQL, no ORM), `node:test` + `node:assert` for tests, `web-push` for delivery, vanilla JS (no framework) on the frontend.

**Spec:** [docs/superpowers/specs/2026-09-15-squadron-chat-design.md](../specs/2026-09-15-squadron-chat-design.md)

## Global Constraints

- Node engine floor: `24.x` (package.json `engines`). No new npm dependencies — everything needed (`express`, `pg`, `web-push`) is already installed.
- Message body cap: 2000 characters (VARCHAR(2000) column + matching app-level validation).
- Roles are exactly `member` / `supervisor` / `leadership` (existing `members.role` CHECK) — this plan adds no new role and no new capability flag.
- No DMs, no attachments, no @mentions, no flight-level channel, no unhide, no per-channel mute in this plan — all explicitly out of scope per the spec's §14.
- Push delivery for chat MUST NOT write to the `notifications` table (spec §2, §7) — it uses a new standalone `pushToMembers()` so chat can never become emailable via `notify-emails.js`'s unfiltered flush.
- Real-time delivery is client polling only — no WebSockets, no SSE, no new long-lived server connections.
- Every write route follows the existing convention: `requireAuth` (+ `requireOnboarded` on state-changing routes only, never on reads — see `server.js:460-464`).
- One deviation from the spec's exact wording, settled during planning: the spec's §5.4 mentions a `data/channels.js` seed file. There is no such file in this plan — shop channels are generated with `INSERT INTO channels (type, shop_id, name) SELECT 'shop', id, name FROM shops` at table-creation time, because a static file listing shop rows would drift from the live `shops` table. Squadron and leadership channels are two literal `INSERT` values in the same statement. This assumes `shops` is already populated by the time `lib/chat.js`'s `ensureTable` runs in the boot sequence, which holds today (shops is a long-established, already-seeded table).

---

### Task 1: Schema — `channels`, `messages`, `channel_reads` + seed-on-create

**Files:**
- Modify: `schema.sql` (insert after the `members` table block, before `CREATE TABLE IF NOT EXISTS tasks`)
- Create: `lib/chat.js` (DDL + `ensureTable` only in this task)
- Modify: `server.js` (require the new lib; add one entry to the boot's `ensureTable` loop)
- Create: `test/chat-http.test.js`

**Interfaces:**
- Produces: `chat.ensureTable(pool)` → `Promise<{ created: true, seeded: number } | { created: false }>`, exported from `lib/chat.js`. Every later task in this plan requires `../lib/chat` and calls into it.

- [ ] **Step 1: Add the three tables to `schema.sql`**

Open `schema.sql` and find the end of the `members` table block — it ends with:

```sql
CREATE TABLE IF NOT EXISTS members (
  ...
  created_at    TIMESTAMP DEFAULT NOW()
);
```

Immediately after that closing `);` (and before the blank line + `CREATE TABLE IF NOT EXISTS tasks`), insert:

```sql
-- ── Chat ──────────────────────────────────────────────────────────────────
-- Squadron-wide, leadership-only, and one per shop. Not user-creatable: seeded
-- once at table-creation time in lib/chat.js's ensureTable, from the live
-- shops table plus two literal rows. A shop added later needs a manual insert,
-- the same way everything else about a new shop is manual today.
CREATE TABLE IF NOT EXISTS channels (
  id       SERIAL PRIMARY KEY,
  type     VARCHAR(20) NOT NULL CHECK (type IN ('squadron','leadership','shop')),
  shop_id  INTEGER REFERENCES shops(id),
  name     VARCHAR(100) NOT NULL,
  CHECK ((type = 'shop') = (shop_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS channels_shop_key
  ON channels (shop_id) WHERE shop_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channels_singleton_key
  ON channels (type) WHERE type IN ('squadron','leadership');

-- hidden_at IS NULL means visible, same convention as notifications.read_at.
-- A hidden row is never deleted, so who hid what and when is always answerable.
CREATE TABLE IF NOT EXISTS messages (
  id           SERIAL PRIMARY KEY,
  channel_id   INTEGER NOT NULL REFERENCES channels(id),
  author_id    INTEGER NOT NULL REFERENCES members(id),
  body         VARCHAR(2000) NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  hidden_at    TIMESTAMP,
  hidden_by_id INTEGER REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, created_at);

-- Per-member-per-channel read tracking, independent of the notifications
-- table's read_at — chat's unread state is a different concern from a
-- one-shot system alert and deliberately doesn't share that table.
CREATE TABLE IF NOT EXISTS channel_reads (
  member_id    INTEGER NOT NULL REFERENCES members(id),
  channel_id   INTEGER NOT NULL REFERENCES channels(id),
  last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (member_id, channel_id)
);
```

- [ ] **Step 2: Create `lib/chat.js` with the DDL and `ensureTable`**

```javascript
// lib/chat.js — squadron chat: channels, messages, read tracking.
//
// Channels are not user-creatable. They are seeded exactly once, in the boot
// that creates the table: two literal rows (squadron, leadership) plus one
// per row currently in `shops`. A shop added later needs a manual insert into
// channels, the same way everything else about a new shop is manual today.

const DDL = `
  CREATE TABLE IF NOT EXISTS channels (
    id       SERIAL PRIMARY KEY,
    type     VARCHAR(20) NOT NULL CHECK (type IN ('squadron','leadership','shop')),
    shop_id  INTEGER REFERENCES shops(id),
    name     VARCHAR(100) NOT NULL,
    CHECK ((type = 'shop') = (shop_id IS NOT NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS channels_shop_key
    ON channels (shop_id) WHERE shop_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS channels_singleton_key
    ON channels (type) WHERE type IN ('squadron','leadership');

  CREATE TABLE IF NOT EXISTS messages (
    id           SERIAL PRIMARY KEY,
    channel_id   INTEGER NOT NULL REFERENCES channels(id),
    author_id    INTEGER NOT NULL REFERENCES members(id),
    body         VARCHAR(2000) NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    hidden_at    TIMESTAMP,
    hidden_by_id INTEGER REFERENCES members(id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, created_at);

  CREATE TABLE IF NOT EXISTS channel_reads (
    member_id    INTEGER NOT NULL REFERENCES members(id),
    channel_id   INTEGER NOT NULL REFERENCES channels(id),
    last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (member_id, channel_id)
  );
`;

// Seed-on-create. The boot block calls this on every start; it only does
// anything in the boot that finds `channels` absent. Guards on `channels`
// alone — messages/channel_reads never need seed rows, they start empty.
async function ensureTable(db) {
  const { rows } = await db.query(`SELECT to_regclass('public.channels') AS t`);
  if (rows[0].t) return { created: false };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(DDL);
    await client.query(
      `INSERT INTO channels (type, name) VALUES ('squadron', 'Squadron'), ('leadership', 'Leadership')`);
    const { rowCount } = await client.query(
      `INSERT INTO channels (type, shop_id, name) SELECT 'shop', id, name FROM shops`);
    await client.query('COMMIT');
    return { created: true, seeded: 2 + rowCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { DDL, ensureTable };
```

- [ ] **Step 3: Wire `lib/chat.js` into the boot block**

In `server.js`, find the requires block (near the other `lib/` requires, e.g. `const duties = require('./lib/duties');`) and add:

```javascript
const chat = require('./lib/chat');
```

Find the boot loop (inside the `app.ready = (async () => { ... })()` IIFE):

```javascript
for (const [name, mod] of [['additional_duties', duties], ['drill_dates', drillCal],
                           ['calendar_events', calEvents]]) {
  const r = await mod.ensureTable(pool);
  if (r.created) console.log(`Created ${name} and seeded ${r.seeded} rows`);
}
```

Change it to:

```javascript
for (const [name, mod] of [['additional_duties', duties], ['drill_dates', drillCal],
                           ['calendar_events', calEvents], ['channels', chat]]) {
  const r = await mod.ensureTable(pool);
  if (r.created) console.log(`Created ${name} and seeded ${r.seeded} rows`);
}
```

- [ ] **Step 4: Write the failing seed-on-create test**

Create `test/chat-http.test.js`:

```javascript
// Squadron chat: channels, messages, moderation, read tracking.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENABLE_CRON = process.env.ENABLE_CRON || 'false';

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const { pool, applySchema, resetDb } = require('./helpers/db');
const chat = require('../lib/chat');
const app = require('../server');

let server, baseUrl;

test.before(async () => {
  // Requiring server.js above kicked off its boot migration, which creates and
  // seeds channels. This file drops and re-creates that table with raw DDL,
  // which takes no lock, so the boot has to be finished first.
  await app.ready;
  await applySchema();
  await new Promise((resolve, reject) => {
    server = app.listen(0, err => (err ? reject(err) : resolve()));
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { await new Promise(r => server.close(r)); });

test('seed-on-create: two literal channels plus one per shop, exactly once', async () => {
  await pool.query('DROP TABLE IF EXISTS channel_reads, messages, channels CASCADE');
  await pool.query(`DELETE FROM shops`);
  await pool.query(`INSERT INTO shops (name) VALUES ('Structures'), ('EA')`);

  assert.deepStrictEqual(await chat.ensureTable(pool), { created: true, seeded: 4 });
  const count = async () => Number((await pool.query('SELECT COUNT(*) FROM channels')).rows[0].count);
  assert.strictEqual(await count(), 4);

  const { rows: types } = await pool.query(
    `SELECT type, shop_id, name FROM channels ORDER BY type, name`);
  assert.deepStrictEqual(types.map(r => r.type), ['leadership', 'shop', 'shop', 'squadron']);

  assert.deepStrictEqual(await chat.ensureTable(pool), { created: false });
  assert.strictEqual(await count(), 4, 'a second boot adds nothing');

  await pool.query(`DELETE FROM channels WHERE type = 'shop' AND name = 'EA'`);
  assert.deepStrictEqual(await chat.ensureTable(pool), { created: false });
  assert.strictEqual(await count(), 3, 'a deleted channel never comes back');
});

test('at most one squadron channel and one leadership channel', async () => {
  await pool.query('DROP TABLE IF EXISTS channel_reads, messages, channels CASCADE');
  await chat.ensureTable(pool);
  await assert.rejects(
    () => pool.query(`INSERT INTO channels (type, name) VALUES ('squadron', 'Squadron 2')`),
    /duplicate key value|channels_singleton_key/);
});

test('a shop channel requires a shop_id, and a non-shop channel forbids one', async () => {
  await pool.query('DROP TABLE IF EXISTS channel_reads, messages, channels CASCADE');
  await chat.ensureTable(pool);
  await assert.rejects(
    () => pool.query(`INSERT INTO channels (type, name) VALUES ('shop', 'Orphan')`),
    /violates check constraint/);
  const { rows: [shop] } = await pool.query(`SELECT id FROM shops LIMIT 1`);
  await assert.rejects(
    () => pool.query(`INSERT INTO channels (type, shop_id, name) VALUES ('squadron', $1, 'Bad')`, [shop.id]),
    /violates check constraint/);
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test test/chat-http.test.js`
Expected: all three tests PASS. (They exercise real code from step 2 as soon as it's saved — there's no separate "verify it fails first" step here because step 2 and step 4 together are the red/green pair: if you want to see red, comment out the `ensureTable` body's return and re-run before restoring it.)

- [ ] **Step 6: Commit**

```bash
git add schema.sql lib/chat.js server.js test/chat-http.test.js
git commit -m "Add channels/messages/channel_reads schema and seed-on-create"
```

---

### Task 2: Access control — pure functions

**Files:**
- Modify: `lib/chat.js` (add `canAccess`, `visibleChannels`, `canPost`, `canHide`)
- Create: `test/chat.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 (pure functions, no DB).
- Produces: `chat.canAccess(member, channel)` → `boolean`; `chat.visibleChannels(member, channels)` → filtered array; `chat.canPost` (alias of `canAccess`); `chat.canHide(member)` → `boolean`. `member` is always the shape `{ id, role, shopId }`. Task 3 onward calls these before touching the database.

- [ ] **Step 1: Write the failing unit tests**

Create `test/chat.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const chat = require('../lib/chat');

const squadron = { id: 1, type: 'squadron', shop_id: null, name: 'Squadron' };
const leadership = { id: 2, type: 'leadership', shop_id: null, name: 'Leadership' };
const shopA = { id: 3, type: 'shop', shop_id: 10, name: 'Structures' };
const shopB = { id: 4, type: 'shop', shop_id: 20, name: 'EA' };
const all = [squadron, leadership, shopA, shopB];

const member = { id: 1, role: 'member', shopId: 10 };
const supervisor = { id: 2, role: 'supervisor', shopId: 10 };
const leader = { id: 3, role: 'leadership', shopId: 10 };

test('a plain member sees squadron and only their own shop', () => {
  assert.deepStrictEqual(chat.visibleChannels(member, all).map(c => c.id), [1, 3]);
});

test('a supervisor has no more reach than a member', () => {
  assert.deepStrictEqual(chat.visibleChannels(supervisor, all).map(c => c.id), [1, 3]);
});

test('leadership sees every channel, including every shop and the leadership channel', () => {
  assert.deepStrictEqual(chat.visibleChannels(leader, all).map(c => c.id), [1, 2, 3, 4]);
});

test('canAccess matches visibleChannels for every role x channel pair', () => {
  for (const m of [member, supervisor, leader]) {
    for (const c of all) {
      assert.strictEqual(chat.canAccess(m, c), chat.visibleChannels(m, [c]).length === 1,
        `role=${m.role} channel=${c.type}`);
    }
  }
});

test('canPost is the same rule as canAccess in v1', () => {
  assert.strictEqual(chat.canPost, chat.canAccess);
});

test('canHide is leadership-only, independent of any channel', () => {
  assert.strictEqual(chat.canHide(member), false);
  assert.strictEqual(chat.canHide(supervisor), false);
  assert.strictEqual(chat.canHide(leader), true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/chat.test.js`
Expected: FAIL — `chat.canAccess is not a function` (and similar for the others).

- [ ] **Step 3: Implement the access-control functions**

In `lib/chat.js`, add below the `ensureTable` function:

```javascript
// True when `member` ({ id, role, shopId }) may read (and, in v1, post to)
// `channel`. Leadership's reach mirrors mayTouchEvent's precedent in
// server.js: it spans every shop, not just its own.
function canAccess(member, channel) {
  if (channel.type === 'squadron') return true;
  if (channel.type === 'leadership') return member.role === 'leadership';
  return channel.shop_id === member.shopId || member.role === 'leadership';
}

function visibleChannels(member, channels) {
  return channels.filter(c => canAccess(member, c));
}

// Identical to canAccess in v1 — no channel is read-only for anyone who can
// see it. A named export of its own so call sites read as intent, not as a
// coincidence, and so a future v1.1 (e.g. leadership can read but not post
// into a shop it doesn't own) has one place to diverge.
const canPost = canAccess;

function canHide(member) {
  return member.role === 'leadership';
}
```

Update the `module.exports` line to:

```javascript
module.exports = { DDL, ensureTable, canAccess, visibleChannels, canPost, canHide };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/chat.test.js`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/chat.js test/chat.test.js
git commit -m "Add chat access-control rules (canAccess, visibleChannels, canHide)"
```

---

### Task 3: `GET /api/chat/channels` — list with unread counts

**Files:**
- Modify: `lib/chat.js` (add `getChannel`, `listChannels`)
- Modify: `server.js` (add the route)
- Modify: `test/chat-http.test.js` (add `login`/`cookieFrom`/`api`/`seed` helpers and this route's tests)

**Interfaces:**
- Consumes: `canAccess`/`visibleChannels` from Task 2.
- Produces: `chat.getChannel(db, id)` → channel row or `null`; `chat.listChannels(db, member)` → `Promise<Array<{id, type, shop_id, name, unread_count}>>`, ordered squadron, leadership, then shops by name. Tasks 4–6 reuse `getChannel` for their own per-channel access checks.

- [ ] **Step 1: Write the failing tests**

Add to `test/chat-http.test.js`, above the existing tests (helpers first, since later tests in this same file will use them too):

```javascript
function cookieFrom(res) {
  const c = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return c.length ? c[0].split(';')[0] : null;
}

const PW = 'testpass123';

async function login(slug) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, password: PW }),
  });
  assert.strictEqual(res.status, 200, `login as ${slug} should succeed`);
  return cookieFrom(res);
}

const api = (method, path, cookie, body) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// One leadership member, one supervisor and one member in Structures; one
// member in EA (a second shop, to prove cross-shop isolation); plus the four
// channels those shops and roles need. must_change_password=false so
// requireOnboarded never confounds a 403.
async function seed() {
  await resetDb();
  const hash = await bcrypt.hash(PW, 4);
  const { rows: [shopA] } = await pool.query(`INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [shopB] } = await pool.query(`INSERT INTO shops (name) VALUES ('EA') RETURNING id`);
  const add = (slug, role, shopId) => pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active, must_change_password)
     VALUES ($1,'Test','SrA',$2,$3,$1,$4,true,false) RETURNING id`, [slug, shopId, role, hash]);
  const { rows: [leader] } = await add('leadtest', 'leadership', shopA.id);
  const { rows: [sup] } = await add('suptest', 'supervisor', shopA.id);
  const { rows: [memA] } = await add('matest', 'member', shopA.id);
  const { rows: [memB] } = await add('mbtest', 'member', shopB.id);
  const { rows: [squadronCh] } = await pool.query(
    `INSERT INTO channels (type, name) VALUES ('squadron','Squadron') RETURNING id`);
  const { rows: [leadershipCh] } = await pool.query(
    `INSERT INTO channels (type, name) VALUES ('leadership','Leadership') RETURNING id`);
  const { rows: [shopACh] } = await pool.query(
    `INSERT INTO channels (type, shop_id, name) VALUES ('shop',$1,'Structures') RETURNING id`, [shopA.id]);
  const { rows: [shopBCh] } = await pool.query(
    `INSERT INTO channels (type, shop_id, name) VALUES ('shop',$1,'EA') RETURNING id`, [shopB.id]);
  return {
    shopA: shopA.id, shopB: shopB.id,
    leaderId: leader.id, supId: sup.id, memAId: memA.id, memBId: memB.id,
    squadronCh: squadronCh.id, leadershipCh: leadershipCh.id, shopACh: shopACh.id, shopBCh: shopBCh.id,
  };
}

test('signed out: GET /api/chat/channels is 401', async () => {
  await seed();
  assert.strictEqual((await api('GET', '/api/chat/channels', null)).status, 401);
});

test('a shop-A member sees squadron and shop-A only; leadership sees all four', async () => {
  const ids = await seed();
  const memA = await login('matest');
  const listA = await (await api('GET', '/api/chat/channels', memA)).json();
  assert.deepStrictEqual(listA.channels.map(c => c.id).sort((a, b) => a - b),
    [ids.squadronCh, ids.shopACh].sort((a, b) => a - b));

  const memB = await login('mbtest');
  const listB = await (await api('GET', '/api/chat/channels', memB)).json();
  assert.deepStrictEqual(listB.channels.map(c => c.id).sort((a, b) => a - b),
    [ids.squadronCh, ids.shopBCh].sort((a, b) => a - b));

  const leader = await login('leadtest');
  const listL = await (await api('GET', '/api/chat/channels', leader)).json();
  assert.strictEqual(listL.channels.length, 4);
});

test('unread_count is 0 with no messages and no reads', async () => {
  await seed();
  const memA = await login('matest');
  const { channels } = await (await api('GET', '/api/chat/channels', memA)).json();
  assert.ok(channels.every(c => c.unread_count === 0));
});

test('unread_count counts messages after last_read_at, excludes hidden ones', async () => {
  const ids = await seed();
  await pool.query(
    `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'hello')`,
    [ids.shopACh, ids.leaderId]);
  await pool.query(
    `INSERT INTO messages (channel_id, author_id, body, hidden_at, hidden_by_id)
     VALUES ($1, $2, 'bad', NOW(), $2)`, [ids.shopACh, ids.leaderId]);
  const memA = await login('matest');
  const { channels } = await (await api('GET', '/api/chat/channels', memA)).json();
  const shopA = channels.find(c => c.id === ids.shopACh);
  assert.strictEqual(shopA.unread_count, 1, 'the hidden message must not count');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env.test --test test/chat-http.test.js`
Expected: FAIL on the new tests with 404 (route doesn't exist yet) or a thrown error.

- [ ] **Step 3: Implement `getChannel` and `listChannels` in `lib/chat.js`**

Add below `canHide`:

```javascript
async function getChannel(db, id) {
  const { rows } = await db.query(
    `SELECT id, type, shop_id, name FROM channels WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function listChannels(db, member) {
  const { rows: all } = await db.query(
    `SELECT id, type, shop_id, name FROM channels
      ORDER BY CASE type WHEN 'squadron' THEN 0 WHEN 'leadership' THEN 1 ELSE 2 END, name`);
  const mine = visibleChannels(member, all);
  if (!mine.length) return [];
  const ids = mine.map(c => c.id);
  const { rows: unread } = await db.query(
    `SELECT c.id AS channel_id,
            COUNT(m.id) FILTER (
              WHERE m.hidden_at IS NULL
                AND m.created_at > COALESCE(cr.last_read_at, TO_TIMESTAMP(0))
            ) AS unread_count
       FROM channels c
       LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.member_id = $2
       LEFT JOIN messages m ON m.channel_id = c.id
      WHERE c.id = ANY($1)
      GROUP BY c.id`, [ids, member.id]);
  const byId = new Map(unread.map(r => [r.channel_id, Number(r.unread_count)]));
  return mine.map(c => ({ ...c, unread_count: byId.get(c.id) || 0 }));
}
```

Update `module.exports`:

```javascript
module.exports = { DDL, ensureTable, canAccess, visibleChannels, canPost, canHide, getChannel, listChannels };
```

- [ ] **Step 4: Add the route in `server.js`**

Near the other resource route blocks (e.g. after the `/api/duties` block), add:

```javascript
// ── Chat ──────────────────────────────────────────────────────────────────
app.get('/api/chat/channels', requireAuth, async (req, res) => {
  try {
    const member = { id: req.session.memberId, role: req.session.role, shopId: req.session.shopId };
    res.json({ channels: await chat.listChannels(pool, member) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --env-file=.env.test --test test/chat-http.test.js`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/chat.js server.js test/chat-http.test.js
git commit -m "Add GET /api/chat/channels with per-member unread counts"
```

---

### Task 4: Messages — list, post, mark read

**Files:**
- Modify: `lib/chat.js` (add `listMessages`, `validateBody`, `postMessage`, `markRead`)
- Modify: `server.js` (three routes)
- Modify: `test/chat-http.test.js`

**Interfaces:**
- Consumes: `getChannel`, `canAccess`, `canHide` from Tasks 2–3.
- Produces: `chat.listMessages(db, channelId, { since, canSeeHidden })` → array of `{id, channel_id, author_id, author_rank, author_name, body, created_at, hidden}` (body is `null` when `hidden`; author fields are always present so leadership can see who wrote a hidden message); `chat.validateBody(raw)` → `{ok:true, value}` or `{ok:false, error}`; `chat.postMessage(db, channelId, authorId, body)` → inserted row; `chat.markRead(db, memberId, channelId)` → `void`. Task 5 (push) calls `postMessage`'s return value to build the push payload; Task 6 (hide) shares the same `getChannel` access-check pattern.

- [ ] **Step 1: Write the failing tests**

Add to `test/chat-http.test.js`:

```javascript
test('signed out: message routes are 401', async () => {
  const ids = await seed();
  for (const [m, p] of [
    ['GET', `/api/chat/channels/${ids.shopACh}/messages`],
    ['POST', `/api/chat/channels/${ids.shopACh}/messages`],
    ['POST', `/api/chat/channels/${ids.shopACh}/read`],
  ]) {
    const body = m === 'GET' ? undefined : {};
    assert.strictEqual((await api(m, p, null, body)).status, 401, `${m} ${p}`);
  }
});

test('403: a shop-B member cannot read or post into shop-A\'s channel or the leadership channel', async () => {
  const ids = await seed();
  const memB = await login('mbtest');
  assert.strictEqual((await api('GET', `/api/chat/channels/${ids.shopACh}/messages`, memB)).status, 403);
  assert.strictEqual((await api('POST', `/api/chat/channels/${ids.shopACh}/messages`, memB, { body: 'hi' })).status, 403);
  assert.strictEqual((await api('GET', `/api/chat/channels/${ids.leadershipCh}/messages`, memB)).status, 403);
  assert.strictEqual((await api('POST', `/api/chat/channels/${ids.leadershipCh}/messages`, memB, { body: 'hi' })).status, 403);
});

test('leadership can read and post into every channel, including a shop it is not in', async () => {
  const ids = await seed();
  const leader = await login('leadtest');
  for (const ch of [ids.squadronCh, ids.leadershipCh, ids.shopACh, ids.shopBCh]) {
    assert.strictEqual((await api('GET', `/api/chat/channels/${ch}/messages`, leader)).status, 200, `read ${ch}`);
    assert.strictEqual((await api('POST', `/api/chat/channels/${ch}/messages`, leader, { body: 'hi' })).status, 201, `post ${ch}`);
  }
});

test('post/list round-trip, ascending order, and a 400 on empty or oversized body', async () => {
  const ids = await seed();
  const memA = await login('matest');
  let res = await api('POST', `/api/chat/channels/${ids.shopACh}/messages`, memA, { body: '  first  ' });
  assert.strictEqual(res.status, 201);
  const first = await res.json();
  assert.strictEqual(first.body, 'first', 'body is trimmed');

  await api('POST', `/api/chat/channels/${ids.shopACh}/messages`, memA, { body: 'second' });
  const { messages } = await (await api('GET', `/api/chat/channels/${ids.shopACh}/messages`, memA)).json();
  assert.deepStrictEqual(messages.map(m => m.body), ['first', 'second']);

  assert.strictEqual((await api('POST', `/api/chat/channels/${ids.shopACh}/messages`, memA, { body: '   ' })).status, 400);
  assert.strictEqual((await api('POST', `/api/chat/channels/${ids.shopACh}/messages`, memA, { body: 'x'.repeat(2001) })).status, 400);
});

test('?since= returns only messages after that id', async () => {
  const ids = await seed();
  const memA = await login('matest');
  const a = await (await api('POST', `/api/chat/channels/${ids.shopACh}/messages`, memA, { body: 'a' })).json();
  await api('POST', `/api/chat/channels/${ids.shopACh}/messages`, memA, { body: 'b' });
  const { messages } = await (await api('GET', `/api/chat/channels/${ids.shopACh}/messages?since=${a.id}`, memA)).json();
  assert.deepStrictEqual(messages.map(m => m.body), ['b']);
});

test('a hidden message is invisible to a member and redacted-but-visible to leadership', async () => {
  const ids = await seed();
  await pool.query(
    `INSERT INTO messages (channel_id, author_id, body, hidden_at, hidden_by_id)
     VALUES ($1, $2, 'secret', NOW(), $2)`, [ids.shopACh, ids.leaderId]);
  const memA = await login('matest');
  const { messages: forMember } = await (await api('GET', `/api/chat/channels/${ids.shopACh}/messages`, memA)).json();
  assert.strictEqual(forMember.length, 0);
  const leader = await login('leadtest');
  const { messages: forLeader } = await (await api('GET', `/api/chat/channels/${ids.shopACh}/messages`, leader)).json();
  assert.strictEqual(forLeader.length, 1);
  assert.strictEqual(forLeader[0].hidden, true);
  assert.strictEqual(forLeader[0].body, null, 'body is redacted even for leadership');
  assert.ok(forLeader[0].author_rank, 'author_rank is present even on hidden messages');
  assert.ok(forLeader[0].author_name, 'author_name is present even on hidden messages');
});

test('messages include author rank and name', async () => {
  const ids = await seed();
  await api('POST', `/api/chat/channels/${ids.shopACh}/messages`, await login('matest'), { body: 'hello' });
  const leader = await login('leadtest');
  const { messages } = await (await api('GET', `/api/chat/channels/${ids.shopACh}/messages`, leader)).json();
  assert.strictEqual(messages[0].author_rank, 'SrA');
  assert.strictEqual(messages[0].author_name, 'matest');
});

test('marking read updates last_read_at and clears the unread count', async () => {
  const ids = await seed();
  const memA = await login('matest');
  await pool.query(
    `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'hi')`,
    [ids.shopACh, ids.leaderId]);
  let list = await (await api('GET', '/api/chat/channels', memA)).json();
  assert.strictEqual(list.channels.find(c => c.id === ids.shopACh).unread_count, 1);

  assert.strictEqual((await api('POST', `/api/chat/channels/${ids.shopACh}/read`, memA)).status, 200);
  list = await (await api('GET', '/api/chat/channels', memA)).json();
  assert.strictEqual(list.channels.find(c => c.id === ids.shopACh).unread_count, 0);

  // Reads twice without error (upsert, not insert).
  assert.strictEqual((await api('POST', `/api/chat/channels/${ids.shopACh}/read`, memA)).status, 200);
});

test('an unknown channel id is 404 on read and list, 403 is not confused with it', async () => {
  await seed();
  const memA = await login('matest');
  assert.strictEqual((await api('GET', '/api/chat/channels/999999/messages', memA)).status, 404);
  assert.strictEqual((await api('POST', '/api/chat/channels/999999/messages', memA, { body: 'x' })).status, 404);
  assert.strictEqual((await api('GET', '/api/chat/channels/abc/messages', memA)).status, 400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env.test --test test/chat-http.test.js`
Expected: FAIL — the new routes don't exist yet (requests get Express's default 404 HTML, and `res.json()` on it throws, or the route functions are undefined).

- [ ] **Step 3: Implement the lib functions**

Add to `lib/chat.js`, below `listChannels`:

```javascript
async function listMessages(db, channelId, { since, canSeeHidden } = {}) {
  const params = [channelId];
  let where = 'msg.channel_id = $1';
  if (!canSeeHidden) where += ' AND msg.hidden_at IS NULL';
  if (since) { params.push(since); where += ` AND msg.id > $${params.length}`; }
  const { rows } = await db.query(
    `SELECT msg.id, msg.channel_id, msg.author_id, msg.body, msg.created_at,
            msg.hidden_at, msg.hidden_by_id,
            m.rank AS author_rank, m.last_name AS author_name
       FROM messages msg
       JOIN members m ON m.id = msg.author_id
      WHERE ${where} ORDER BY msg.id ASC LIMIT 200`, params);
  return rows.map(r => ({
    id: r.id, channel_id: r.channel_id, author_id: r.author_id,
    author_rank: r.author_rank, author_name: r.author_name,
    created_at: r.created_at,
    hidden: !!r.hidden_at,
    body: r.hidden_at ? null : r.body,
  }));
}

function validateBody(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, error: 'Message cannot be empty' };
  if (s.length > 2000) return { ok: false, error: 'Message must be 2000 characters or fewer' };
  return { ok: true, value: s };
}

async function postMessage(db, channelId, authorId, body) {
  const { rows } = await db.query(
    `INSERT INTO messages (channel_id, author_id, body)
     VALUES ($1, $2, $3) RETURNING id, channel_id, author_id, body, created_at`,
    [channelId, authorId, body]);
  return rows[0];
}

async function markRead(db, memberId, channelId) {
  await db.query(
    `INSERT INTO channel_reads (member_id, channel_id, last_read_at) VALUES ($1, $2, NOW())
     ON CONFLICT (member_id, channel_id) DO UPDATE SET last_read_at = NOW()`,
    [memberId, channelId]);
}
```

Update `module.exports`:

```javascript
module.exports = {
  DDL, ensureTable, canAccess, visibleChannels, canPost, canHide,
  getChannel, listChannels, listMessages, validateBody, postMessage, markRead,
};
```

- [ ] **Step 4: Add the three routes in `server.js`**

Below the `GET /api/chat/channels` route added in Task 3:

```javascript
app.get('/api/chat/channels/:id/messages', requireAuth, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid channel id' });
  try {
    const member = { id: req.session.memberId, role: req.session.role, shopId: req.session.shopId };
    const channel = await chat.getChannel(pool, id);
    if (!channel) return res.status(404).json({ error: 'That channel does not exist' });
    if (!chat.canAccess(member, channel)) return res.status(403).json({ error: 'Forbidden' });
    const since = req.query.since ? reqId(req.query.since) : null;
    if (req.query.since && !since) return res.status(400).json({ error: 'Invalid since id' });
    const messages = await chat.listMessages(pool, id, { since, canSeeHidden: chat.canHide(member) });
    res.json({ messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/chat/channels/:id/messages', requireAuth, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid channel id' });
  const v = chat.validateBody(req.body && req.body.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const member = { id: req.session.memberId, role: req.session.role, shopId: req.session.shopId };
    const channel = await chat.getChannel(pool, id);
    if (!channel) return res.status(404).json({ error: 'That channel does not exist' });
    if (!chat.canPost(member, channel)) return res.status(403).json({ error: 'Forbidden' });
    const message = await chat.postMessage(pool, id, member.id, v.value);
    res.status(201).json(message);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/chat/channels/:id/read', requireAuth, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid channel id' });
  try {
    const member = { id: req.session.memberId, role: req.session.role, shopId: req.session.shopId };
    const channel = await chat.getChannel(pool, id);
    if (!channel) return res.status(404).json({ error: 'That channel does not exist' });
    if (!chat.canAccess(member, channel)) return res.status(403).json({ error: 'Forbidden' });
    await chat.markRead(pool, member.id, id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --env-file=.env.test --test test/chat-http.test.js`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/chat.js server.js test/chat-http.test.js
git commit -m "Add chat message list/post/read routes"
```

---

### Task 5: Push — standalone `pushToMembers`, wired to new messages

**Files:**
- Modify: `lib/push.js` (extract `deliverOne`, add `pushToMembers`)
- Modify: `lib/chat.js` (add `recipientsFor`)
- Modify: `server.js` (add `pushChatMessage`, call it from the POST message route)
- Modify: `test/push-http.test.js`

**Interfaces:**
- Consumes: `postMessage`'s return value and `getChannel`'s channel row from Task 4.
- Produces: `push.pushToMembers(pool, memberIds, payload, { send })` → `Promise<{sent, pruned}|{sent:0,pruned:0,skipped}>`; `chat.recipientsFor(db, channel, excludeMemberId)` → `Promise<number[]>`. Nothing later in this plan depends on these beyond this task's own wiring.

- [ ] **Step 1: Write the failing tests**

Add to `test/push-http.test.js`, after the existing `// ── flush ──` section (add a new `// ── pushToMembers ──` section):

```javascript
const { pushToMembers } = require('../lib/push');

// ── pushToMembers ─────────────────────────────────────────────────────────

test('pushToMembers delivers to every listed member\'s subscriptions, nobody else\'s', async () => {
  const { a, b } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  await api(await login('bravo'), 'POST', '/api/push/subscribe', sub(`${EP}-b`));
  const seen = [];
  const r = await pushToMembers(pool, [a], { title: 'Chat', body: 'hi' },
    { send: (s, payload) => seen.push({ endpoint: s.endpoint, payload }) });
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].endpoint, EP);
  assert.strictEqual(JSON.parse(seen[0].payload).title, 'Chat');
});

test('pushToMembers never touches the notifications table', async () => {
  const { a } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  await pushToMembers(pool, [a], { title: 'Chat', body: 'hi' }, { send: () => {} });
  const { rows } = await pool.query('SELECT COUNT(*)::int n FROM notifications');
  assert.strictEqual(rows[0].n, 0);
});

test('pushToMembers prunes a dead subscription on 410, exactly like flushPush', async () => {
  const { a } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  const r = await pushToMembers(pool, [a], { title: 'Chat' }, {
    send: () => { const e = new Error('gone'); e.statusCode = 410; throw e; },
  });
  assert.strictEqual(r.pruned, 1);
  assert.strictEqual(await subCount(), 0);
});

test('pushToMembers with an empty member list is a no-op', async () => {
  await seed();
  const r = await pushToMembers(pool, [], { title: 'Chat' }, { send: () => assert.fail('must not send') });
  assert.deepStrictEqual(r, { sent: 0, pruned: 0 });
});

test('with no VAPID keys, pushToMembers is a no-op, not an error', async () => {
  const { a } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  const pub = process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PUBLIC_KEY;
  try {
    const r = await pushToMembers(pool, [a], { title: 'Chat' }, { send: () => assert.fail('must not send') });
    assert.strictEqual(r.skipped, 'no VAPID keys');
  } finally {
    process.env.VAPID_PUBLIC_KEY = pub;
  }
});

test('flushPush still behaves exactly as before the deliverOne refactor', async () => {
  const { a } = await seed();
  await api(await login('alpha'), 'POST', '/api/push/subscribe', sub(EP));
  await notif(a);
  const seen = [];
  const r = await flushPush({ pool, send: (s, payload) => seen.push(JSON.parse(payload)) });
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(seen[0].title, 'Your tasks');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env.test --test test/push-http.test.js`
Expected: FAIL — `pushToMembers is not a function` (import will also fail at the top of the file until step 3 updates exports).

- [ ] **Step 3: Refactor `lib/push.js`**

Replace the whole file with:

```javascript
// lib/push.js — Web Push delivery.
//
// Two send paths share one delivery primitive (deliverOne):
//
//   · flushPush — deliberately shaped like notify-emails.js rather than a
//     direct send from notify(): a notification row is written first, then a
//     flush picks up whatever has pushed_at IS NULL. Used for task alerts,
//     which must survive a crash mid-send and never block the request that
//     triggered them.
//   · pushToMembers — a direct send to a fixed list of members, with no
//     notifications-table row at all. Used for chat, specifically so a chat
//     message can never be picked up by notify-emails.js's unfiltered
//     "email every un-emailed notification" flush.
//
// Both must stay out of the request path — see server.js's notify() and
// pushChatMessage() for the setImmediate wrapper each caller is responsible for.
const webpush = require('web-push');

// Digests are a nightly supervisor summary; buzzing phones at 21:00 for them is
// not wanted. Add 'completion_digest' here if that ever changes.
const PUSH_TYPES = ['tasks_live', 'task_assigned', 'task_escalated'];

// Anything older than this is abandoned rather than delivered. A member who
// re-subscribes should not be buzzed for last month's UTA, and a flush that has
// been failing for a day should give up rather than accumulate a backlog that
// arrives all at once.
const MAX_AGE_HOURS = 24;

const enabled = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

// Lazy, so the module can be required before the env is populated (tests do
// exactly that) and so an unset key set is simply a no-op rather than a throw.
let configured = false;
function ensureVapid() {
  if (configured) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'https://108ces.up.railway.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
}

// Attempt delivery to one subscription. Prunes it on 404/410 (dead endpoint —
// uninstalled app or a rotated endpoint), logs anything else, never throws.
// `sub` is { id, endpoint, p256dh, auth }; `id` is only used for pruning, so
// callers with no subscriptions-table row of their own (there are none today)
// could pass null.
async function deliverOne(pool, sub, payload, deliver) {
  try {
    await deliver({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
    return { ok: true, pruned: false };
  } catch (err) {
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      return { ok: false, pruned: true };
    }
    console.error('push send failed:', String(sub.endpoint).slice(0, 48),
                  (err && (err.statusCode || err.message)) || err);
    return { ok: false, pruned: false };
  }
}

// send is injectable so tests can drive the whole flush without a push service.
async function flushPush({ pool, send } = {}) {
  if (!pool) throw new Error('flushPush needs a pool');
  if (!enabled()) return { sent: 0, pruned: 0, skipped: 'no VAPID keys' };
  ensureVapid();
  const deliver = send || ((sub, payload) => webpush.sendNotification(sub, payload));

  const { rows } = await pool.query(`
    SELECT n.id, n.title, n.body, n.link,
           s.id AS sub_id, s.endpoint, s.p256dh, s.auth
      FROM notifications n
      JOIN push_subscriptions s ON s.member_id = n.member_id
     WHERE n.pushed_at IS NULL
       AND n.type = ANY($1)
       AND n.created_at >= s.created_at          -- no backlog for a new subscriber
       AND n.created_at > NOW() - ($2 || ' hours')::interval
     ORDER BY n.created_at
     LIMIT 500
  `, [PUSH_TYPES, String(MAX_AGE_HOURS)]);

  let sent = 0, pruned = 0;
  const done = new Set();
  for (const r of rows) {
    const payload = JSON.stringify({
      title: r.title,
      body: r.body || '',
      // notifications.link already stores the view names the SPA switches on, so
      // a tap can land on the right pane. See applyDeepLink() in index.html.
      url: r.link ? `/?view=${encodeURIComponent(r.link)}` : '/',
      tag: `n-${r.id}`,
    });
    const result = await deliverOne(
      pool, { id: r.sub_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, payload, deliver);
    if (result.ok) sent++;
    if (result.pruned) pruned++;
    // Stamped whether or not the send worked: a row that failed for this
    // subscription should not be retried forever against a broken endpoint. The
    // age window above is the safety net for a transient outage.
    done.add(r.id);
  }
  if (done.size) {
    await pool.query('UPDATE notifications SET pushed_at = NOW() WHERE id = ANY($1)', [[...done]]);
  }
  // Retire anything past the window so the partial index stays small.
  await pool.query(`
    UPDATE notifications SET pushed_at = created_at
     WHERE pushed_at IS NULL AND created_at <= NOW() - ($1 || ' hours')::interval
  `, [String(MAX_AGE_HOURS)]);

  return { sent, pruned };
}

// Direct delivery to a fixed set of members — no notifications-table row, no
// flush, no cron catch-up. Callers (chat) accept that a send failure here is
// simply missed, same as a browser push in general; the in-app unread count
// is the source of truth, this is only the phone buzzing.
async function pushToMembers(pool, memberIds, payload, { send } = {}) {
  if (!memberIds || !memberIds.length) return { sent: 0, pruned: 0 };
  if (!enabled()) return { sent: 0, pruned: 0, skipped: 'no VAPID keys' };
  ensureVapid();
  const deliver = send || ((sub, p) => webpush.sendNotification(sub, p));
  const { rows } = await pool.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = ANY($1)`,
    [memberIds]);
  const body = JSON.stringify(payload);
  let sent = 0, pruned = 0;
  for (const sub of rows) {
    const result = await deliverOne(pool, sub, body, deliver);
    if (result.ok) sent++;
    if (result.pruned) pruned++;
  }
  return { sent, pruned };
}

module.exports = { flushPush, pushToMembers, PUSH_TYPES, MAX_AGE_HOURS, enabled };
```

- [ ] **Step 4: Add `recipientsFor` to `lib/chat.js`**

```javascript
// Who should be pushed for a new message in `channel`, excluding its author.
// Mirrors canAccess's reach exactly: a shop channel's recipients are that
// shop's members plus every leadership member, same as who can read it.
async function recipientsFor(db, channel, excludeMemberId) {
  let sql, params;
  if (channel.type === 'squadron') {
    sql = `SELECT id FROM members WHERE active AND id != $1`;
    params = [excludeMemberId];
  } else if (channel.type === 'leadership') {
    sql = `SELECT id FROM members WHERE active AND role = 'leadership' AND id != $1`;
    params = [excludeMemberId];
  } else {
    sql = `SELECT id FROM members WHERE active AND (shop_id = $2 OR role = 'leadership') AND id != $1`;
    params = [excludeMemberId, channel.shop_id];
  }
  const { rows } = await db.query(sql, params);
  return rows.map(r => r.id);
}
```

Update `module.exports` in `lib/chat.js`:

```javascript
module.exports = {
  DDL, ensureTable, canAccess, visibleChannels, canPost, canHide,
  getChannel, listChannels, listMessages, validateBody, postMessage, markRead, recipientsFor,
};
```

- [ ] **Step 5: Wire the push call into the POST message route**

In `server.js`, near `notify()`, add:

```javascript
// Mirrors notify()'s shape exactly: never awaited in the request path, and a
// push failure is caught and logged, never allowed to fail the message post.
function pushChatMessage(recipientIds, payload) {
  if (!recipientIds.length) return;
  setImmediate(() => {
    require('./lib/push').pushToMembers(pool, recipientIds, payload)
      .catch(e => console.error('chat push failed:', e.message));
  });
}
```

Update the `POST /api/chat/channels/:id/messages` route from Task 4 — replace:

```javascript
    const message = await chat.postMessage(pool, id, member.id, v.value);
    res.status(201).json(message);
```

with:

```javascript
    const message = await chat.postMessage(pool, id, member.id, v.value);
    const recipients = await chat.recipientsFor(pool, channel, member.id);
    pushChatMessage(recipients, {
      title: channel.name,
      body: v.value.slice(0, 120),
      url: `/?view=chat&channel=${id}`,
      tag: `chat-${id}`,
    });
    res.status(201).json(message);
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --env-file=.env.test --test test/push-http.test.js test/chat-http.test.js`
Expected: all tests PASS, including every pre-existing `flushPush` test (the refactor must not change their behavior).

- [ ] **Step 7: Commit**

```bash
git add lib/push.js lib/chat.js server.js test/push-http.test.js
git commit -m "Add standalone pushToMembers and wire it to new chat messages"
```

---

### Task 6: Hide a message (leadership-only, soft-delete)

**Files:**
- Modify: `lib/chat.js` (add `hideMessage`)
- Modify: `server.js` (one route)
- Modify: `test/chat-http.test.js`

**Interfaces:**
- Consumes: `canHide` from Task 2.
- Produces: `chat.hideMessage(db, messageId, hiddenById)` → `Promise<{found: boolean, changed: boolean}>`.

- [ ] **Step 1: Write the failing tests**

Add to `test/chat-http.test.js`:

```javascript
test('403: a supervisor and a plain member cannot hide a message; leadership can', async () => {
  const ids = await seed();
  const { rows: [msg] } = await pool.query(
    `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'oops') RETURNING id`,
    [ids.shopACh, ids.memAId]);
  const sup = await login('suptest');
  assert.strictEqual((await api('POST', `/api/chat/messages/${msg.id}/hide`, sup)).status, 403);
  const memA = await login('matest');
  assert.strictEqual((await api('POST', `/api/chat/messages/${msg.id}/hide`, memA)).status, 403);
  const leader = await login('leadtest');
  assert.strictEqual((await api('POST', `/api/chat/messages/${msg.id}/hide`, leader)).status, 200);
  const { rows: [row] } = await pool.query(
    `SELECT hidden_at, hidden_by_id FROM messages WHERE id = $1`, [msg.id]);
  assert.ok(row.hidden_at);
  assert.strictEqual(row.hidden_by_id, ids.leaderId);
});

test('hiding is idempotent: a second hide is a 200 no-op, not a 404 or 409', async () => {
  const ids = await seed();
  const { rows: [msg] } = await pool.query(
    `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'oops') RETURNING id`,
    [ids.shopACh, ids.memAId]);
  const leader = await login('leadtest');
  const first = await api('POST', `/api/chat/messages/${msg.id}/hide`, leader);
  assert.strictEqual(first.status, 200);
  const { rows: [afterFirst] } = await pool.query(`SELECT hidden_at FROM messages WHERE id = $1`, [msg.id]);
  const second = await api('POST', `/api/chat/messages/${msg.id}/hide`, leader);
  assert.strictEqual(second.status, 200);
  const { rows: [afterSecond] } = await pool.query(`SELECT hidden_at FROM messages WHERE id = $1`, [msg.id]);
  assert.deepStrictEqual(afterFirst.hidden_at, afterSecond.hidden_at, 'the timestamp must not move on a re-hide');
});

test('hiding an unknown message id is 404', async () => {
  await seed();
  const leader = await login('leadtest');
  assert.strictEqual((await api('POST', '/api/chat/messages/999999/hide', leader)).status, 404);
  assert.strictEqual((await api('POST', '/api/chat/messages/abc/hide', leader)).status, 400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env.test --test test/chat-http.test.js`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Implement `hideMessage` in `lib/chat.js`**

```javascript
// Idempotent: hiding an already-hidden message returns found:true,
// changed:false rather than erroring — two leadership members hiding the
// same message moments apart must both see success, not a race-lost 404/409.
async function hideMessage(db, messageId, hiddenById) {
  const { rows } = await db.query(
    `UPDATE messages SET hidden_at = NOW(), hidden_by_id = $2
      WHERE id = $1 AND hidden_at IS NULL
      RETURNING id`, [messageId, hiddenById]);
  if (rows.length) return { found: true, changed: true };
  const { rows: exists } = await db.query(`SELECT id FROM messages WHERE id = $1`, [messageId]);
  return { found: exists.length > 0, changed: false };
}
```

Update `module.exports`:

```javascript
module.exports = {
  DDL, ensureTable, canAccess, visibleChannels, canPost, canHide,
  getChannel, listChannels, listMessages, validateBody, postMessage, markRead, recipientsFor, hideMessage,
};
```

- [ ] **Step 4: Add the route in `server.js`**

```javascript
app.post('/api/chat/messages/:id/hide', requireAuth, requireOnboarded, requireRole('leadership'), async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid message id' });
  try {
    const result = await chat.hideMessage(pool, id, req.session.memberId);
    if (!result.found) return res.status(404).json({ error: 'That message no longer exists' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --env-file=.env.test --test test/chat-http.test.js`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/chat.js server.js test/chat-http.test.js
git commit -m "Add leadership-only message hide (soft-delete)"
```

---

### Task 7: Frontend — nav tab, view pane, `public/chat.js`

**Files:**
- Modify: `public/index.html` (nav buttons ×2, view pane, `switchView`'s title map + chat branch, script tag)
- Create: `public/chat.js`
- Modify: `MEMORY.md` (repo root)

**Interfaces:**
- Consumes: the five routes from Tasks 3–6.
- Produces: `window.chatInit({ canHide })` and `window.chatInit.reset()`, called from `switchView()`'s `chat` branch and from `doLogout()` alongside the other `*Init.reset()` calls.

There is no automated frontend test harness in this app (confirmed by the existing spec's own testing section) — this task is verified manually, per the same practice used for the resources/calendar views.

- [ ] **Step 1: Add the nav buttons**

In `public/index.html`, in the desktop sidebar block (the four `<button class="sb-item" ...>` elements, ending with the `resources` button), add a fifth button immediately after the `resources` button:

```html
      <button class="sb-item" data-view="chat" onclick="switchView(this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        Chat
        <span class="sb-badge" id="navb-chat" hidden></span>
      </button>
```

In the mobile nav block (`<nav class="mob-nav">`, the four `<button class="mob-btn" ...>` elements), add a fifth after `resources`, using the badge-wrapped form (matching the `member` button's shape, since this one also carries a badge):

```html
    <button class="mob-btn" data-view="chat" onclick="switchView(this)">
      <div class="mob-badge-wrap mob-ic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        <span class="mob-badge" id="navb-chat-m" hidden></span>
      </div>
      Chat
    </button>
```

- [ ] **Step 2: Add the view pane**

Immediately after `</div><!-- /#view-resources -->` (and before `</main>`), add:

```html
    <!-- ═══ CHAT VIEW ═════════════════════════════ -->
    <div id="view-chat" class="view">
      <h1 class="vh">Chat</h1>
      <div id="chat-host"><div class="skeleton"></div><div class="skeleton"></div></div>
    </div><!-- /#view-chat -->
```

- [ ] **Step 3: Wire `switchView()`**

In the `titles` object inside `switchView()`, add a `chat` entry:

```javascript
  const titles = {
    member:     [utaLabel,            m ? m.rank+' '+m.last_name+' · '+m.shop : ''],
    supervisor: [viewedShop+' Shop',  'Supervisor View'],
    leadership: ['108th CES',         'Leadership View'],
    resources:  ['Resources',         'Calculators, forms, links, people & calendar'],
    chat:       ['Chat',              'Squadron and shop channels'],
  };
```

After the `if (name === 'resources') { ... }` block, add:

```javascript
  if (name === 'chat') { window.chatInit && window.chatInit({ canHide: currentMember?.role === 'leadership' }); }
```

- [ ] **Step 4: Load the new script**

In the block of `<script src="..." defer></script>` tags, add a sixth line after `promotion-package.js` (the last script in the block):

```html
  <script src="/chat.js" defer></script>
```

- [ ] **Step 5: Write `public/chat.js`**

```javascript
// public/chat.js — squadron chat (squadron-wide, leadership, and per-shop
// channels). One global, chatInit({ canHide }), called from switchView()'s
// chat branch on every entry, mirroring the leadership view's pattern.
//
// Polls the open channel every 12s for new messages — no WebSockets, no SSE.
// Push notifications (already wired server-side) cover the app-closed case.
// Uses the page's openModal/closeModal-free confirm (uiConfirm) for hiding a
// message; unlike duties.js/calendar.js there is no editor modal here.
(function () {
  let channels = [];
  let canHide = false;
  let shellReady = false;
  let activeChannelId = null;
  let messages = [];
  let loaded = false;          // last /api/chat/channels fetch succeeded
  let messagesLoaded = false;  // last messages fetch for the active channel succeeded
  let pollTimer = null;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast = (msg, type) => (typeof showToast === 'function' ? showToast : uiToast)(msg, type);
  const $ = (id) => document.getElementById(id);

  const TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h10M6 4V2.5h4V4M4 4l.6 9.4c0 .6.5 1.1 1.1 1.1h4.6c.6 0 1.1-.5 1.1-1.1L12 4"/></svg>';

  function shell() {
    $('chat-host').innerHTML = `
      <div class="chat-layout">
        <div class="chat-channels" id="chat-channels"><div class="skeleton"></div></div>
        <div class="chat-thread" id="chat-thread">
          <div class="res-empty">Pick a channel to start.</div>
        </div>
      </div>`;
    $('chat-channels').addEventListener('click', (e) => {
      const row = e.target.closest('.chat-channel-row');
      if (row) openChannel(Number(row.dataset.id));
    });
    shellReady = true;
  }

  function updateBadge() {
    const total = channels.reduce((n, c) => n + (c.unread_count || 0), 0);
    const desk = $('navb-chat');
    const mob  = $('navb-chat-m');
    if (desk) { desk.textContent = total; desk.hidden = !total; }
    if (mob)  { mob.textContent  = total; mob.hidden  = !total; }
  }

  async function loadChannels() {
    try {
      const res = await fetch('/api/chat/channels');
      if (!res.ok) throw new Error('request failed');
      channels = (await res.json()).channels;
      loaded = true;
    } catch (e) {
      console.error('chat', e);
      loaded = false;
    }
    renderChannels();
    updateBadge();
  }

  function renderChannels() {
    if (!loaded) {
      $('chat-channels').innerHTML = '<div class="res-offline">Chat needs a connection. Try again once you have signal.</div>';
      return;
    }
    if (!channels.length) {
      $('chat-channels').innerHTML = '<div class="res-empty">No channels yet.</div>';
      return;
    }
    $('chat-channels').innerHTML = channels.map(c => `
      <div class="chat-channel-row${c.id === activeChannelId ? ' active' : ''}" data-id="${c.id}">
        <span class="chat-channel-name">${esc(c.name)}</span>
        ${c.unread_count > 0 ? `<span class="chat-unread-badge">${c.unread_count}</span>` : ''}
      </div>`).join('');
  }

  async function openChannel(id) {
    activeChannelId = id;
    messages = [];
    messagesLoaded = false;
    renderChannels();
    renderThread();
    await loadMessages();
    await fetch(`/api/chat/channels/${id}/read`, { method: 'POST' }).catch(() => {});
    await loadChannels(); // picks up the now-cleared unread badge
    startPolling();
  }

  async function loadMessages() {
    try {
      const res = await fetch(`/api/chat/channels/${activeChannelId}/messages`);
      if (!res.ok) throw new Error('request failed');
      messages = (await res.json()).messages;
      messagesLoaded = true;
    } catch (e) {
      console.error('chat', e);
      messagesLoaded = false;
    }
    renderThread();
  }

  async function pollNewMessages() {
    if (!activeChannelId || document.hidden) return;
    const lastId = messages.length ? messages[messages.length - 1].id : null;
    try {
      const url = `/api/chat/channels/${activeChannelId}/messages` + (lastId ? `?since=${lastId}` : '');
      const res = await fetch(url);
      if (!res.ok) return;
      const { messages: fresh } = await res.json();
      if (fresh.length) {
        messages = messages.concat(fresh);
        renderThread();
        fetch(`/api/chat/channels/${activeChannelId}/read`, { method: 'POST' }).catch(() => {});
      }
    } catch (e) { /* a missed poll tick is not worth surfacing */ }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollNewMessages, 12000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function messageRow(m) {
    if (m.hidden) {
      return `<div class="chat-msg chat-msg-hidden">Message hidden by leadership</div>`;
    }
    return `<div class="chat-msg">
      <div>
        <div class="chat-msg-meta">
          <span class="chat-msg-rank">${esc(m.author_rank)}</span>
          <span class="chat-msg-author">${esc(m.author_name)}</span>
          <span class="chat-msg-time">${fmtTime(m.created_at)}</span>
        </div>
        <div class="chat-msg-body">${esc(m.body)}</div>
      </div>
      ${canHide ? `<button class="chat-hide" type="button" aria-label="Hide message" data-id="${m.id}">${TRASH}</button>` : ''}
    </div>`;
  }

  function renderThread() {
    if (!activeChannelId) return;
    const channel = channels.find(c => c.id === activeChannelId);
    const title = channel ? esc(channel.name) : '';
    if (!messagesLoaded) {
      $('chat-thread').innerHTML = `
        <div class="chat-thread-hd">${title}</div>
        <div class="res-offline">Messages need a connection. Try again once you have signal.</div>`;
      return;
    }
    const body = messages.length
      ? messages.map(messageRow).join('')
      : '<div class="res-empty">No messages yet — say hi.</div>';
    $('chat-thread').innerHTML = `
      <div class="chat-thread-hd">${title}</div>
      <div class="chat-msg-list" id="chat-msg-list">${body}</div>
      <form class="chat-composer" id="chat-composer">
        <input type="text" id="chat-input" maxlength="2000" placeholder="Message ${title}" autocomplete="off">
        <button type="submit">Send</button>
      </form>`;
    $('chat-msg-list').scrollTop = $('chat-msg-list').scrollHeight;
    $('chat-composer').addEventListener('submit', sendMessage);
    if (canHide) {
      $('chat-msg-list').addEventListener('click', (e) => {
        const btn = e.target.closest('.chat-hide');
        if (btn) hideOne(Number(btn.dataset.id));
      });
    }
  }

  async function sendMessage(e) {
    e.preventDefault();
    const input = $('chat-input');
    const body = input.value;
    if (!body.trim()) return;
    input.disabled = true;
    try {
      const res = await fetch(`/api/chat/channels/${activeChannelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send');
      input.value = '';
      await loadMessages();
    } catch (err) {
      toast(err.message || 'Could not send', 'error');
    }
    input.disabled = false;
    input.focus();
  }

  async function hideOne(id) {
    if (!await uiConfirm({ title: 'Hide this message?',
      message: 'It disappears from everyone’s view. This cannot be undone from here.',
      confirmLabel: 'Hide', danger: true })) return;
    try {
      const res = await fetch(`/api/chat/messages/${id}/hide`, { method: 'POST' });
      if (!res.ok && res.status !== 404) {
        throw new Error((await res.json().catch(() => ({}))).error || 'Could not hide');
      }
      await loadMessages();
    } catch (err) { toast(err.message || 'Could not hide', 'error'); }
  }

  window.chatInit = function ({ canHide: ch } = {}) {
    canHide = !!ch;
    if (!shellReady) { shell(); loadChannels(); return; }
    if (!loaded) { loadChannels(); return; }
    renderChannels();
    if (activeChannelId) renderThread();
  };

  // Called from index.html's updateNavBadges() on its regular poll cycle
  // to keep the chat badge current even when the user is on a different tab.
  window.chatInit.badgeCheck = async function () {
    try {
      const res = await fetch('/api/chat/channels');
      if (!res.ok) return;
      channels = (await res.json()).channels;
      loaded = true;
      updateBadge();
    } catch (_) { /* badge stays stale until next poll — acceptable */ }
  };

  // Logout hook (called from index.html's doLogout), same pattern as
  // calendarInit.reset()/dutiesInit.reset(): a same-tab sign-in as a
  // different member must not show the previous member's channels or
  // messages, and must not leave a poll timer running against a channel the
  // new member may not even be allowed to see.
  window.chatInit.reset = function () {
    channels = [];
    canHide = false;
    shellReady = false;
    activeChannelId = null;
    messages = [];
    loaded = false;
    messagesLoaded = false;
    stopPolling();
    updateBadge();
    const host = $('chat-host');
    if (host) host.innerHTML = '';
  };
})();
```

- [ ] **Step 6: Register the reset hook in `doLogout`**

Find `doLogout()` in `public/index.html` (it already calls `calendarInit.reset()` and `dutiesInit.reset()` per Task's earlier research). Add alongside them:

```javascript
  if (window.chatInit && window.chatInit.reset) window.chatInit.reset();
```

- [ ] **Step 6b: Wire the chat badge into `updateNavBadges()`**

Find `updateNavBadges()` in `public/index.html` (around line 5297). It follows a `set(id, n)` pattern for other badge elements. Add at the end of the function body:

```javascript
  if (window.chatInit && window.chatInit.badgeCheck) window.chatInit.badgeCheck();
```

This piggybacks on the existing nav badge polling interval (~12s) so the chat badge stays current even when the user is on Duties, Calendar, etc. — no second timer needed.

- [ ] **Step 7: Add minimal CSS for the new elements**

In the page's `<style>` block, near the other feature-scoped CSS (e.g. after `.cal-list`/`.duty-list` rules), add:

```css
/* ── Chat ────────────────────────────────────────────────────────────────
   Follows the existing design-token vocabulary from design.css (--cream,
   --bm, --border, --urgent, --t2, --t3-nav-text, --text, --bg, --r, --rs).
   Row/badge/button dimensions match the app's 44px touch-target floor and
   the font-size/weight/letter-spacing used by the member-row and duty-row
   patterns. The .rk rank chip mirrors design.css's .member-row .rk exactly.
   ──────────────────────────────────────────────────────────────────────── */
.chat-layout { display: flex; gap: 12px; height: calc(100vh - 180px); min-height: 320px; }
.chat-channels { width: 220px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--border); }
.chat-channel-row { display: flex; justify-content: space-between; align-items: center; padding: 11px 14px; cursor: pointer; border-bottom: 1px solid var(--border); font-size: 13.5px; color: var(--text); }
.chat-channel-row:hover { background: var(--cream); }
.chat-channel-row.active { background: var(--cream); font-weight: 600; }
.chat-unread-badge { background: var(--urgent); color: var(--bg); border-radius: 999px; font-size: 11px; font-weight: 600; padding: 1px 7px; min-width: 18px; text-align: center; }
.chat-thread { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.chat-thread-hd { font-size: 14px; font-weight: 700; letter-spacing: -.01em; padding-bottom: 8px; border-bottom: 1px solid var(--bm); margin-bottom: 8px; }
.chat-msg-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 4px 0; }
.chat-msg { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; padding: 8px 10px; background: var(--cream); border-radius: var(--rs); }
.chat-msg-meta { display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px; }
.chat-msg-author { font-size: 13px; font-weight: 600; color: var(--text); }
.chat-msg-rank { font-size: 10.5px; font-weight: 600; color: var(--t2); background: var(--cream); border-radius: 12px; padding: 2px 7px; }
.chat-msg-time { font-size: 11px; color: var(--t3-nav-text); margin-left: auto; }
.chat-msg-body { font-size: 13.5px; line-height: 1.45; }
.chat-msg-hidden { padding: 8px 10px; color: var(--t3-nav-text); font-size: 13px; font-style: italic; }
.chat-composer { display: flex; gap: 8px; margin-top: 10px; }
.chat-composer input { flex: 1; min-height: 44px; padding: 0 13px; border: 2px solid var(--border); border-radius: var(--rs); font-size: 14px; color: var(--text); background: var(--bg); }
.chat-composer input:focus { border-color: var(--text); outline: none; }
.chat-composer button { min-height: 44px; min-width: 64px; border-radius: var(--rs); border: 2px solid var(--text); background: var(--text); color: var(--bg); font-size: 13px; font-weight: 600; cursor: pointer; }
.chat-composer button:hover { opacity: .88; }
.chat-hide { min-width: 32px; min-height: 32px; background: none; border: none; color: var(--t3-nav-text); cursor: pointer; flex-shrink: 0; }
.chat-hide:hover { color: var(--urgent); }
.chat-hide svg { width: 15px; height: 15px; }
@media (max-width: 480px) {
  .chat-layout { flex-direction: column; height: auto; }
  .chat-channels { width: 100%; max-height: 160px; border-right: none; border-bottom: 1px solid var(--border); }
}
```

- [ ] **Step 8: Manual verification**

1. Start the app against a database that has run the new migration (or a fresh one, so `channels` gets seeded on boot).
2. Sign in as a plain member: confirm the Chat tab appears, the squadron channel and the member's own shop channel are visible, the leadership channel is not.
3. Post a message; confirm it appears immediately in the thread and the unread badge does not show for the poster.
4. In a second browser/session, sign in as a different member of the same shop; confirm the new message appears (via poll, within ~12s) and the unread badge shows before opening the channel.
5. Sign in as a leadership member: confirm all channels are visible (including other shops' and the leadership channel), and a trash/hide icon appears on messages.
6. Hide a message as leadership; confirm it disappears for the plain member and shows "Message hidden" for leadership.
7. Check phone width (375px) and dark mode.
8. Confirm a push notification arrives on a subscribed device/browser when the app is backgrounded and someone else posts.

- [ ] **Step 9: Update the repo's `MEMORY.md`**

Add a short entry (following whatever section/format the file already uses for feature summaries) noting: squadron chat shipped — three channel types, leadership-tier moderation, standalone push path in `lib/push.js` (not via `notifications`), polling-based delivery. Point at the spec and this plan's paths for anyone who needs the full rationale later.

- [ ] **Step 10: Run the full test suite**

Run: `node --env-file=.env.test --test --test-concurrency=1 test/*.test.js`
Expected: every test file passes, including the newly added/modified `chat.test.js`, `chat-http.test.js`, and `push-http.test.js`.

- [ ] **Step 11: Commit**

```bash
git add public/index.html public/chat.js MEMORY.md
git commit -m "Add chat nav tab, view, and public/chat.js frontend module"
```

---

## Self-Review Notes

**Spec coverage:** §5 (data model) → Task 1. §6 (access control) → Task 2. §7 (push) → Task 5. §8 (API surface) → Tasks 3, 4, 6. §9 (frontend) → Task 7. The spec's §3 "flagged for review" item (leadership push volume across all shops) is deliberately NOT auto-mitigated in this plan — it's a product judgment call, not a bug, and the spec says to watch for it in practice rather than pre-solve it.

**Placeholder scan:** no TBD/TODO; every step has real, complete code; every test asserts a concrete value, not "add appropriate assertions."

**Type/signature consistency, checked across tasks:** `member` is always `{ id, role, shopId }` (Tasks 2–6). `chat.canPost` is a direct alias of `chat.canAccess` (Task 2), used consistently in Task 4's POST route. `chat.getChannel` (Task 3) is reused unchanged by Tasks 4 and used implicitly via the channel row already fetched in Task 5's route edit. `push.pushToMembers`'s signature (`pool, memberIds, payload, { send }`) matches every call site in Task 5's tests and in `pushChatMessage`. `hideMessage`'s `{found, changed}` return shape is used correctly by the one route that calls it (Task 6) — `changed` is fetched but intentionally unused by the route (200 either way), which is correct per the idempotency requirement in the spec, not a dead value.
