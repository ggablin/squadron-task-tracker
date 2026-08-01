# Roster Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/roster`, a capability-gated leadership page for adding, deactivating and editing members, replacing `import-members.js` as the normal path.

**Architecture:** A new `can_manage_roster` boolean on `members` gates a `/api/roster/*` route group via a `requireRosterAdmin` middleware. All logic lives in a new `lib/roster.js` following the existing `lib/*` convention (every function takes `db` as its first argument). The org chart's `role`/`flight`/`position` triple is never edited directly — the client sends one `placement` value and the server derives and validates the triple. The shop-grouped member browser is extracted from `records.html` into a shared `public/member-browser.js` used by both `/records` and `/roster`.

**Tech Stack:** Node 20+, Express 4, PostgreSQL via `pg`, `bcrypt` (cost 10), `node:test`, vanilla single-file frontend (no build step).

**Spec:** `docs/superpowers/specs/2026-08-01-member-management-design.md`

## Global Constraints

- Every `lib/roster.js` function takes `db` (a pool or client) as its first argument, matching `lib/cycles.js` and `lib/tasks.js`.
- Migrations are idempotent `ADD COLUMN IF NOT EXISTS`, added to **both** `schema.sql` and the `server.js` boot-migration block.
- No member-facing query changes. `active` keeps its current meaning.
- Initial password is the member's slug, hashed with `bcrypt` cost 10, `must_change_password = true`.
- Position strings must match the org chart's exact values: `NCOIC`, `SNCOIC`, `Flight Superintendent`, `Flight OIC`, `Unit Training Manager`, `Commander`, `Chief Enlisted Manager`, `First Sergeant`, `BCE/Engineering OIC`, `Admin Support Technician`.
- Valid flights: `Infrastructure`, `Construction`, `R&O`, `EM`, plus `Squadron Staff`.
- At least one **active** member must hold `can_manage_roster` at all times.
- Tests run with `node --env-file=.env.test --test --test-concurrency=1 test/*.test.js`.
- New pages link `/design.css` and `/ui.js` and use `uiConfirm` for destructive actions.

---

## File Structure

| File | Responsibility |
|---|---|
| `schema.sql` | Add `can_manage_roster`, `updated_at`, `updated_by_id` to `members` |
| `server.js` | Boot migration, session field, `requireRosterAdmin`, `/api/roster/*` routes, `/roster` page route |
| `lib/roster.js` | **New.** Placement derivation, slug generation, admin invariant, member CRUD |
| `test/roster.test.js` | **New.** All `lib/roster.js` coverage |
| `public/member-browser.js` | **New.** Extracted shop-grouped searchable member list |
| `public/design.css` | Member browser styles (moved from `records.html`) |
| `public/records.html` | Consume the extracted browser; behaviour unchanged |
| `public/roster.html` | **New.** The roster page |
| `public/index.html` | Roster button in Leadership Tools |

---

### Task 1: Migration

**Files:**
- Modify: `schema.sql` (members table)
- Modify: `server.js` (boot-migration block)
- Test: `test/roster.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `members.can_manage_roster BOOLEAN NOT NULL DEFAULT false`, `members.updated_at TIMESTAMP`, `members.updated_by_id INTEGER REFERENCES members(id)`

- [ ] **Step 1: Write the failing test**

Create `test/roster.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { pool, applySchema, resetDb } = require('./helpers/db');

test.before(applySchema);

test('migration adds can_manage_roster defaulting to false', async () => {
  await resetDb();
  const { rows: [shop] } = await pool.query(`INSERT INTO shops (name) VALUES ('Structures') RETURNING id`);
  const { rows: [m] } = await pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash)
     VALUES ('smith','Ann','SrA',$1,'member','smith','x')
     RETURNING can_manage_roster, updated_at, updated_by_id`, [shop.id]);
  assert.strictEqual(m.can_manage_roster, false);
  assert.strictEqual(m.updated_at, null);
  assert.strictEqual(m.updated_by_id, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: FAIL — `column "can_manage_roster" does not exist`

- [ ] **Step 3: Add the columns to schema.sql**

In `schema.sql`, inside the existing `DO $$ ... END $$;` migration block that already contains the `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ...` statements, append:

```sql
  ALTER TABLE members ADD COLUMN IF NOT EXISTS can_manage_roster BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;
  ALTER TABLE members ADD COLUMN IF NOT EXISTS updated_by_id INTEGER REFERENCES members(id);
```

- [ ] **Step 4: Mirror it in the server.js boot migration**

Find the boot-migration block in `server.js` (the one running `ADD COLUMN IF NOT EXISTS` on startup) and add the same three statements.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add schema.sql server.js test/roster.test.js
git commit -m "feat: add can_manage_roster and update-tracking columns to members"
```

---

### Task 2: Placement derivation

**Files:**
- Create: `lib/roster.js`
- Test: `test/roster.test.js`

**Interfaces:**
- Consumes: nothing (pure)
- Produces: `PLACEMENTS` (object), `FLIGHTS` (array), `RosterError` (class, has `.status` and `.code`), `derivePlacement(placement, { position, flight }) -> { role, flight, position }`, `placementOf(member) -> string`

- [ ] **Step 1: Write the failing test**

Append to `test/roster.test.js`:

```js
const roster = require('../lib/roster');

test('derivePlacement writes the correct triple for each placement', () => {
  assert.deepStrictEqual(roster.derivePlacement('shop_member'),
    { role: 'member', flight: null, position: null });
  assert.deepStrictEqual(roster.derivePlacement('shop_supervisor'),
    { role: 'supervisor', flight: null, position: null });
  assert.deepStrictEqual(roster.derivePlacement('shop_lead', { position: 'SNCOIC' }),
    { role: 'leadership', flight: null, position: 'SNCOIC' });
  assert.deepStrictEqual(
    roster.derivePlacement('flight_leader', { position: 'Flight Superintendent', flight: 'Infrastructure' }),
    { role: 'leadership', flight: 'Infrastructure', position: 'Flight Superintendent' });
  assert.deepStrictEqual(roster.derivePlacement('squadron_staff', { position: 'Commander' }),
    { role: 'leadership', flight: 'Squadron Staff', position: 'Commander' });
});

test('derivePlacement rejects positions outside the allowed set', () => {
  assert.throws(() => roster.derivePlacement('shop_lead', { position: 'Ncoic' }), /position/i);
  assert.throws(() => roster.derivePlacement('shop_lead', { position: 'Commander' }), /position/i);
  assert.throws(() => roster.derivePlacement('nonsense'), /placement/i);
});

test('derivePlacement requires a valid flight for flight_leader', () => {
  assert.throws(
    () => roster.derivePlacement('flight_leader', { position: 'Flight OIC', flight: 'Nope' }), /flight/i);
});

test('placementOf round-trips every placement', () => {
  const cases = [
    ['shop_member', {}],
    ['shop_supervisor', {}],
    ['shop_lead', { position: 'NCOIC' }],
    ['flight_leader', { position: 'Flight OIC', flight: 'R&O' }],
    ['squadron_staff', { position: 'First Sergeant' }],
  ];
  for (const [name, opts] of cases) {
    assert.strictEqual(roster.placementOf(roster.derivePlacement(name, opts)), name, name);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: FAIL — `Cannot find module '../lib/roster'`

- [ ] **Step 3: Write lib/roster.js**

```js
// lib/roster.js — roster management: placement derivation, slug generation,
// the admin-capability invariant, and member CRUD.
//
// The org chart (GET /api/squadron/org-chart) classifies members from the
// combination of role, flight and position, and those fields fail silently when
// set inconsistently: position is free text compared against exact strings, and
// shop.ncoic is a single slot, so two leads in one shop makes one disappear.
// Callers therefore never set the triple directly — they send a placement and
// this module derives it.

class RosterError extends Error {
  constructor(message, code = 'ROSTER_ERROR', status = 400) {
    super(message);
    this.name = 'RosterError';
    this.code = code;
    this.status = status;
  }
}

const FLIGHTS = ['Infrastructure', 'Construction', 'R&O', 'EM'];

const PLACEMENTS = {
  shop_member:     { role: 'member',     positions: [] },
  shop_supervisor: { role: 'supervisor', positions: [] },
  shop_lead:       { role: 'leadership', positions: ['NCOIC', 'SNCOIC'] },
  flight_leader:   { role: 'leadership', needsFlight: true,
                     positions: ['Flight Superintendent', 'Flight OIC', 'Unit Training Manager'] },
  squadron_staff:  { role: 'leadership', fixedFlight: 'Squadron Staff',
                     positions: ['Commander', 'Chief Enlisted Manager', 'First Sergeant',
                                 'BCE/Engineering OIC', 'Admin Support Technician'] },
};

function derivePlacement(placement, { position = null, flight = null } = {}) {
  const p = PLACEMENTS[placement];
  if (!p) throw new RosterError(`Unknown placement: ${placement}`, 'BAD_PLACEMENT');

  let outPosition = null;
  if (p.positions.length) {
    if (!p.positions.includes(position)) {
      throw new RosterError(
        `position must be one of: ${p.positions.join(', ')}`, 'BAD_POSITION');
    }
    outPosition = position;
  }

  let outFlight = null;
  if (p.fixedFlight) outFlight = p.fixedFlight;
  else if (p.needsFlight) {
    if (!FLIGHTS.includes(flight)) {
      throw new RosterError(`flight must be one of: ${FLIGHTS.join(', ')}`, 'BAD_FLIGHT');
    }
    outFlight = flight;
  }

  return { role: p.role, flight: outFlight, position: outPosition };
}

// Reverse of derivePlacement, for populating the edit form. Mirrors the order of
// checks in the org-chart endpoint: the NCOIC/SNCOIC test must come before the
// flight-leader test, exactly as the org chart's !['NCOIC','SNCOIC'] guard does.
function placementOf(m) {
  if (m.flight === 'Squadron Staff') return 'squadron_staff';
  if (m.role === 'leadership' && ['NCOIC', 'SNCOIC'].includes(m.position)) return 'shop_lead';
  if (m.role === 'leadership' && m.flight) return 'flight_leader';
  if (m.role === 'supervisor') return 'shop_supervisor';
  return 'shop_member';
}

module.exports = { RosterError, FLIGHTS, PLACEMENTS, derivePlacement, placementOf };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/roster.js test/roster.test.js
git commit -m "feat: derive org chart role/flight/position from a single placement"
```

---

### Task 3: Slug generation

**Files:**
- Modify: `lib/roster.js`
- Test: `test/roster.test.js`

**Interfaces:**
- Consumes: `RosterError` from Task 2
- Produces: `nextSlug(db, lastName, firstName) -> Promise<string>`

- [ ] **Step 1: Write the failing test**

```js
test('nextSlug disambiguates duplicate surnames', async () => {
  await resetDb();
  const { rows: [shop] } = await pool.query(`INSERT INTO shops (name) VALUES ('Electrical') RETURNING id`);
  const add = (last, first, slug) => pool.query(
    `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash)
     VALUES ($1,$2,'SrA',$3,'member',$4,'x')`, [last, first, shop.id, slug]);

  assert.strictEqual(await roster.nextSlug(pool, 'Fowler', 'Omar'), 'fowler');
  await add('Fowler', 'Omar', 'fowler');
  assert.strictEqual(await roster.nextSlug(pool, 'Fowler', 'Gina'), 'fowler-g');
  await add('Fowler', 'Gina', 'fowler-g');
  // Third Fowler whose initial is also taken falls through to a numeral.
  assert.strictEqual(await roster.nextSlug(pool, 'Fowler', 'Greg'), 'fowler-2');
});

test('nextSlug handles a member with no first name', async () => {
  await resetDb();
  await pool.query(`INSERT INTO shops (name) VALUES ('EM')`);
  assert.strictEqual(await roster.nextSlug(pool, 'Fowler', ''), 'fowler');
});

test('nextSlug preserves hyphenated surnames and rejects empty', async () => {
  await resetDb();
  assert.strictEqual(await roster.nextSlug(pool, 'Beljour-Sommer', 'Rose'), 'beljour-sommer');
  await assert.rejects(() => roster.nextSlug(pool, '   ', 'Rose'), /last name/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: FAIL — `roster.nextSlug is not a function`

- [ ] **Step 3: Add nextSlug to lib/roster.js**

```js
// Sign-in names must be unique (members.slug UNIQUE). The live roster already
// contains two Fowlers and two Fernandezes, and one member with no first_name,
// so neither the bare surname nor the initial can be assumed available.
async function nextSlug(db, lastName, firstName) {
  const base = String(lastName || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!base) throw new RosterError('Last name is required', 'BAD_NAME');

  const initial = String(firstName || '').trim().toLowerCase().charAt(0);
  const candidates = [base];
  if (initial) candidates.push(`${base}-${initial}`);
  for (let n = 2; n <= 99; n++) candidates.push(`${base}-${n}`);

  const { rows } = await db.query(`SELECT slug FROM members WHERE slug = ANY($1)`, [candidates]);
  const taken = new Set(rows.map(r => r.slug));
  const free = candidates.find(c => !taken.has(c));
  if (!free) throw new RosterError('Could not generate a unique sign-in name', 'SLUG_EXHAUSTED');
  return free;
}
```

Add `nextSlug` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/roster.js test/roster.test.js
git commit -m "feat: generate unique sign-in names, disambiguating duplicate surnames"
```

---

### Task 4: The at-least-one-active-holder invariant

**Files:**
- Modify: `lib/roster.js`
- Test: `test/roster.test.js`

**Interfaces:**
- Consumes: `RosterError`
- Produces: `LAST_ADMIN_MESSAGE` (string), `lockActiveAdminIds(client) -> Promise<number[]>`, `assertNotLastAdmin(client, memberId) -> Promise<void>`

- [ ] **Step 1: Write the failing test**

```js
async function seedAdmins() {
  await resetDb();
  const { rows: [shop] } = await pool.query(`INSERT INTO shops (name) VALUES ('C2') RETURNING id`);
  const mk = async (slug, isAdmin, active = true) => {
    const { rows: [m] } = await pool.query(
      `INSERT INTO members (last_name, first_name, rank, shop_id, role, slug, password_hash, active, can_manage_roster)
       VALUES ($1,'A','MSgt',$2,'leadership',$1,'x',$3,$4) RETURNING id`,
      [slug, shop.id, active, isAdmin]);
    return m.id;
  };
  return { shopId: shop.id, gablin: await mk('gablin', true), mcnaughton: await mk('mcnaughton', true),
           plain: await mk('gorey', false) };
}

test('assertNotLastAdmin allows removing a non-last holder', async () => {
  const f = await seedAdmins();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await roster.assertNotLastAdmin(client, f.gablin);   // two holders, fine
    await client.query('ROLLBACK');
  } finally { client.release(); }
});

test('assertNotLastAdmin refuses the last active holder', async () => {
  const f = await seedAdmins();
  await pool.query(`UPDATE members SET can_manage_roster = false WHERE id = $1`, [f.mcnaughton]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(() => roster.assertNotLastAdmin(client, f.gablin), /only person/i);
    await client.query('ROLLBACK');
  } finally { client.release(); }
});

test('an inactive holder does not count toward the invariant', async () => {
  const f = await seedAdmins();
  await pool.query(`UPDATE members SET active = false WHERE id = $1`, [f.mcnaughton]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(() => roster.assertNotLastAdmin(client, f.gablin), /only person/i);
    await client.query('ROLLBACK');
  } finally { client.release(); }
});

test('a non-holder is never treated as the last holder', async () => {
  const f = await seedAdmins();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await roster.assertNotLastAdmin(client, f.plain);
    await client.query('ROLLBACK');
  } finally { client.release(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: FAIL — `roster.assertNotLastAdmin is not a function`

- [ ] **Step 3: Add the invariant helpers to lib/roster.js**

```js
const LAST_ADMIN_MESSAGE =
  "You're the only person who can manage the roster. Grant it to someone else first.";

// "At least one row is true" has no clean declarative form in Postgres, unlike
// the one-live-cycle rule that uta_cycles_one_current enforces with a partial
// unique index. So the invariant is enforced here, inside the caller's
// transaction. FOR UPDATE is what stops two concurrent revocations from both
// observing a count of two and both proceeding.
async function lockActiveAdminIds(client) {
  const { rows } = await client.query(
    `SELECT id FROM members WHERE can_manage_roster = true AND active = true ORDER BY id FOR UPDATE`);
  return rows.map(r => r.id);
}

// Throws if removing this member's capability (by revoke, deactivate or delete)
// would leave zero active holders.
async function assertNotLastAdmin(client, memberId) {
  const ids = await lockActiveAdminIds(client);
  if (ids.length === 1 && ids[0] === Number(memberId)) {
    throw new RosterError(LAST_ADMIN_MESSAGE, 'LAST_ADMIN', 409);
  }
}
```

Add `LAST_ADMIN_MESSAGE`, `lockActiveAdminIds` and `assertNotLastAdmin` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/roster.js test/roster.test.js
git commit -m "feat: enforce at-least-one-active-roster-admin inside the write transaction"
```

---

### Task 5: List and create members

**Files:**
- Modify: `lib/roster.js`
- Test: `test/roster.test.js`

**Interfaces:**
- Consumes: `derivePlacement`, `placementOf`, `nextSlug`, `RosterError`. The tests reuse the `seedAdmins()` helper defined in Task 4's test block — it returns `{ shopId, gablin, mcnaughton, plain }`, where all three members are `role='leadership'` with no flight or position and the first two hold `can_manage_roster`.
- Produces: `listRoster(db) -> Promise<Member[]>` where each member carries `{ id, last_name, first_name, rank, shop_id, shop_name, role, flight, position, placement, slug, email, active, can_manage_roster }`; `getMember(db, id) -> Promise<Member>`; `createMember(db, input, actorId) -> Promise<Member>` where `input` is `{ last_name, first_name, rank, shop_id, placement, position, flight, email }`

- [ ] **Step 1: Write the failing test**

```js
const bcrypt = require('bcrypt');

test('createMember provisions a member with slug-as-password and forced change', async () => {
  const f = await seedAdmins();
  const m = await roster.createMember(pool, {
    last_name: 'Fernandez', first_name: 'Gabriel', rank: 'MSgt',
    shop_id: f.shopId, placement: 'shop_lead', position: 'SNCOIC', email: '',
  }, f.gablin);

  assert.strictEqual(m.slug, 'fernandez');
  assert.strictEqual(m.role, 'leadership');
  assert.strictEqual(m.position, 'SNCOIC');
  assert.strictEqual(m.flight, null);
  assert.strictEqual(m.active, true);
  assert.strictEqual(m.can_manage_roster, false);

  const { rows: [row] } = await pool.query(
    `SELECT password_hash, must_change_password, updated_by_id FROM members WHERE id = $1`, [m.id]);
  assert.strictEqual(row.must_change_password, true);
  assert.strictEqual(row.updated_by_id, f.gablin);
  assert.strictEqual(await bcrypt.compare('fernandez', row.password_hash), true);
});

test('createMember rejects an invalid placement before touching the database', async () => {
  const f = await seedAdmins();
  await assert.rejects(() => roster.createMember(pool, {
    last_name: 'Smith', first_name: 'Ann', rank: 'SrA',
    shop_id: f.shopId, placement: 'shop_lead', position: 'Ncoic',
  }, f.gablin), /position/i);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM members WHERE last_name = 'Smith'`);
  assert.strictEqual(rows[0].n, 0);
});

test('listRoster returns active and inactive members with their placement', async () => {
  const f = await seedAdmins();
  await pool.query(`UPDATE members SET active = false WHERE id = $1`, [f.plain]);
  const all = await roster.listRoster(pool);
  assert.strictEqual(all.length, 3);
  const inactive = all.find(m => m.id === f.plain);
  assert.strictEqual(inactive.active, false);
  // seedAdmins gives everyone role='leadership' with no flight and no position,
  // which placementOf resolves to shop_member — leadership alone is not enough
  // to be a lead or a flight leader.
  assert.strictEqual(inactive.placement, 'shop_member');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: FAIL — `roster.createMember is not a function`

- [ ] **Step 3: Add listRoster and createMember**

Add `const bcrypt = require('bcrypt');` at the top of `lib/roster.js`, then:

```js
const ROSTER_COLUMNS = `
  m.id, m.last_name, m.first_name, m.rank, m.shop_id, s.name AS shop_name,
  m.role, m.flight, m.position, m.slug, m.email, m.active, m.can_manage_roster`;

async function listRoster(db) {
  const { rows } = await db.query(
    `SELECT ${ROSTER_COLUMNS} FROM members m
     LEFT JOIN shops s ON s.id = m.shop_id
     ORDER BY m.active DESC, s.name NULLS LAST, m.last_name, m.first_name`);
  return rows.map(r => ({ ...r, placement: placementOf(r) }));
}

async function getMember(db, id) {
  const { rows } = await db.query(
    `SELECT ${ROSTER_COLUMNS} FROM members m
     LEFT JOIN shops s ON s.id = m.shop_id WHERE m.id = $1`, [id]);
  if (!rows.length) throw new RosterError('Member not found', 'NOT_FOUND', 404);
  return { ...rows[0], placement: placementOf(rows[0]) };
}

async function createMember(db, input, actorId) {
  // Derive first: an invalid placement must fail before any write.
  const triple = derivePlacement(input.placement, {
    position: input.position ?? null,
    flight: input.flight ?? null,
  });
  const slug = await nextSlug(db, input.last_name, input.first_name);
  const hash = await bcrypt.hash(slug, 10);

  try {
    const { rows: [row] } = await db.query(
      `INSERT INTO members
         (last_name, first_name, rank, shop_id, role, flight, position,
          slug, password_hash, must_change_password, active, email, updated_at, updated_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,true,$10,NOW(),$11)
       RETURNING id`,
      [String(input.last_name || '').trim(), String(input.first_name || '').trim(),
       String(input.rank || '').trim(), input.shop_id || null,
       triple.role, triple.flight, triple.position,
       slug, hash, input.email || null, actorId || null]);
    return await getMember(db, row.id);
  } catch (e) {
    if (e.code === '23505') {
      throw new RosterError('That sign-in name is already taken', 'SLUG_TAKEN', 409);
    }
    throw e;
  }
}
```

Add `listRoster`, `getMember` and `createMember` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/roster.js test/roster.test.js
git commit -m "feat: list the roster and create members with derived placement"
```

---

### Task 6: Update a member

**Files:**
- Modify: `lib/roster.js`
- Test: `test/roster.test.js`

**Interfaces:**
- Consumes: `derivePlacement`, `getMember`, `assertNotLastAdmin`, `RosterError`
- Produces: `updateMember(db, id, input, actorId) -> Promise<Member>` where `input` may carry `{ last_name, first_name, rank, shop_id, placement, position, flight, email, slug, active }`. Never accepts `can_manage_roster`.

- [ ] **Step 1: Write the failing test**

```js
test('updateMember changes placement by rewriting the whole triple', async () => {
  const f = await seedAdmins();
  const m = await roster.createMember(pool, {
    last_name: 'Green', first_name: 'Jo', rank: 'SSgt',
    shop_id: f.shopId, placement: 'shop_member',
  }, f.gablin);

  const up = await roster.updateMember(pool, m.id,
    { placement: 'shop_lead', position: 'NCOIC' }, f.gablin);
  assert.deepStrictEqual(
    { role: up.role, flight: up.flight, position: up.position },
    { role: 'leadership', flight: null, position: 'NCOIC' });

  const back = await roster.updateMember(pool, m.id, { placement: 'shop_supervisor' }, f.gablin);
  assert.deepStrictEqual(
    { role: back.role, flight: back.flight, position: back.position },
    { role: 'supervisor', flight: null, position: null });
});

test('updateMember refuses to deactivate the last active admin', async () => {
  const f = await seedAdmins();
  await pool.query(`UPDATE members SET can_manage_roster = false WHERE id = $1`, [f.mcnaughton]);
  await assert.rejects(
    () => roster.updateMember(pool, f.gablin, { active: false }, f.gablin), /only person/i);
  const { rows: [row] } = await pool.query(`SELECT active FROM members WHERE id = $1`, [f.gablin]);
  assert.strictEqual(row.active, true);
});

test('updateMember ignores can_manage_roster in the payload', async () => {
  const f = await seedAdmins();
  await roster.updateMember(pool, f.plain, { can_manage_roster: true, rank: 'TSgt' }, f.gablin);
  const { rows: [row] } = await pool.query(
    `SELECT rank, can_manage_roster FROM members WHERE id = $1`, [f.plain]);
  assert.strictEqual(row.rank, 'TSgt');
  assert.strictEqual(row.can_manage_roster, false);
});

test('updateMember reports a slug collision rather than throwing a raw error', async () => {
  const f = await seedAdmins();
  await assert.rejects(
    () => roster.updateMember(pool, f.plain, { slug: 'gablin' }, f.gablin), /already taken/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: FAIL — `roster.updateMember is not a function`

- [ ] **Step 3: Add updateMember**

```js
// can_manage_roster is deliberately absent from this list. The capability is
// changed only through setRosterAdmin, so the ordinary edit path cannot alter
// access control even if a payload carries the field.
const EDITABLE = ['last_name', 'first_name', 'rank', 'shop_id', 'email', 'slug'];

async function updateMember(db, id, input, actorId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (input.active === false) await assertNotLastAdmin(client, id);

    const sets = [];
    const vals = [];
    for (const col of EDITABLE) {
      if (input[col] === undefined) continue;
      vals.push(col === 'shop_id' ? (input[col] || null) : String(input[col]).trim());
      sets.push(`${col} = $${vals.length}`);
    }
    if (input.active !== undefined) {
      vals.push(!!input.active);
      sets.push(`active = $${vals.length}`);
    }
    if (input.placement !== undefined) {
      const t = derivePlacement(input.placement, {
        position: input.position ?? null,
        flight: input.flight ?? null,
      });
      vals.push(t.role);     sets.push(`role = $${vals.length}`);
      vals.push(t.flight);   sets.push(`flight = $${vals.length}`);
      vals.push(t.position); sets.push(`position = $${vals.length}`);
    }
    if (!sets.length) { await client.query('ROLLBACK'); return await getMember(db, id); }

    vals.push(actorId || null);
    sets.push(`updated_by_id = $${vals.length}`);
    sets.push(`updated_at = NOW()`);

    vals.push(id);
    const { rowCount } = await client.query(
      `UPDATE members SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    if (!rowCount) throw new RosterError('Member not found', 'NOT_FOUND', 404);

    await client.query('COMMIT');
    return await getMember(db, id);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') {
      throw new RosterError('That sign-in name is already taken', 'SLUG_TAKEN', 409);
    }
    throw e;
  } finally { client.release(); }
}
```

Add `updateMember` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/roster.js test/roster.test.js
git commit -m "feat: update member attributes, placement and active state"
```

---

### Task 7: Guarded hard delete

**Files:**
- Modify: `lib/roster.js`
- Test: `test/roster.test.js`

**Interfaces:**
- Consumes: `assertNotLastAdmin`, `RosterError`
- Produces: `deleteMember(db, id) -> Promise<{ deleted: true }>`, throwing `RosterError` with `code: 'HAS_HISTORY'` when referenced

- [ ] **Step 1: Write the failing test**

```js
test('deleteMember removes an unreferenced member', async () => {
  const f = await seedAdmins();
  const m = await roster.createMember(pool, {
    last_name: 'Typo', first_name: 'Ann', rank: 'AB',
    shop_id: f.shopId, placement: 'shop_member',
  }, f.gablin);
  assert.deepStrictEqual(await roster.deleteMember(pool, m.id), { deleted: true });
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM members WHERE id = $1`, [m.id]);
  assert.strictEqual(rows[0].n, 0);
});

test('deleteMember refuses a member with history and leaves them intact', async () => {
  const f = await seedAdmins();
  const m = await roster.createMember(pool, {
    last_name: 'Hasty', first_name: 'Bob', rank: 'SrA',
    shop_id: f.shopId, placement: 'shop_member',
  }, f.gablin);
  const { rows: [cyc] } = await pool.query(
    `INSERT INTO uta_cycles (name, is_current, status) VALUES ('Aug 2026', true, 'live') RETURNING id`);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO task_categories (code, label, sort_order) VALUES ('admin','Admin',1) RETURNING id`);
  await pool.query(
    `INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, urgency)
     VALUES ($1,$2,$3,'Update vRED','this_uta')`, [cyc.id, m.id, cat.id]);

  await assert.rejects(() => roster.deleteMember(pool, m.id), /history/i);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM members WHERE id = $1`, [m.id]);
  assert.strictEqual(rows[0].n, 1);
});

test('deleteMember refuses the last active admin', async () => {
  const f = await seedAdmins();
  await pool.query(`UPDATE members SET can_manage_roster = false WHERE id = $1`, [f.mcnaughton]);
  await assert.rejects(() => roster.deleteMember(pool, f.gablin), /only person/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: FAIL — `roster.deleteMember is not a function`

- [ ] **Step 3: Add deleteMember**

```js
// members(id) is referenced by thirteen columns across eight tables, and that
// list will grow. Rather than enumerating them — a list guaranteed to drift —
// attempt the delete and let Postgres answer. Every one of those constraints is
// NO ACTION by default, including the nullable *_by_id columns, so any
// referencing row anywhere raises 23503.
async function deleteMember(db, id) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertNotLastAdmin(client, id);
    const { rowCount } = await client.query(`DELETE FROM members WHERE id = $1`, [id]);
    if (!rowCount) throw new RosterError('Member not found', 'NOT_FOUND', 404);
    await client.query('COMMIT');
    return { deleted: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23503') {
      throw new RosterError(
        "This member has history and can't be deleted. Deactivate instead.", 'HAS_HISTORY', 409);
    }
    throw e;
  } finally { client.release(); }
}
```

Add `deleteMember` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/roster.js test/roster.test.js
git commit -m "feat: hard-delete unreferenced members, refusing those with history"
```

---

### Task 8: Grant and revoke the capability

**Files:**
- Modify: `lib/roster.js`
- Test: `test/roster.test.js`

**Interfaces:**
- Consumes: `assertNotLastAdmin`, `getMember`, `RosterError`
- Produces: `setRosterAdmin(db, id, grant, actorId) -> Promise<Member>`

- [ ] **Step 1: Write the failing test**

```js
test('setRosterAdmin grants and revokes the capability', async () => {
  const f = await seedAdmins();
  const granted = await roster.setRosterAdmin(pool, f.plain, true, f.gablin);
  assert.strictEqual(granted.can_manage_roster, true);
  const revoked = await roster.setRosterAdmin(pool, f.plain, false, f.gablin);
  assert.strictEqual(revoked.can_manage_roster, false);
});

test('setRosterAdmin refuses to revoke the last active holder', async () => {
  const f = await seedAdmins();
  await roster.setRosterAdmin(pool, f.mcnaughton, false, f.gablin);
  await assert.rejects(
    () => roster.setRosterAdmin(pool, f.gablin, false, f.gablin), /only person/i);
  const { rows: [row] } = await pool.query(
    `SELECT can_manage_roster FROM members WHERE id = $1`, [f.gablin]);
  assert.strictEqual(row.can_manage_roster, true);
});

test('granting is never blocked by the invariant', async () => {
  const f = await seedAdmins();
  await roster.setRosterAdmin(pool, f.mcnaughton, false, f.gablin);
  const m = await roster.setRosterAdmin(pool, f.mcnaughton, true, f.gablin);
  assert.strictEqual(m.can_manage_roster, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: FAIL — `roster.setRosterAdmin is not a function`

- [ ] **Step 3: Add setRosterAdmin**

```js
async function setRosterAdmin(db, id, grant, actorId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (!grant) await assertNotLastAdmin(client, id);
    const { rowCount } = await client.query(
      `UPDATE members SET can_manage_roster = $1, updated_at = NOW(), updated_by_id = $2
       WHERE id = $3`, [!!grant, actorId || null, id]);
    if (!rowCount) throw new RosterError('Member not found', 'NOT_FOUND', 404);
    await client.query('COMMIT');
    return await getMember(db, id);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}
```

Add `setRosterAdmin` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env.test --test test/roster.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/roster.js test/roster.test.js
git commit -m "feat: grant and revoke roster-management capability"
```

---

### Task 9: API routes and the gate

**Files:**
- Modify: `server.js`
- Test: manual (`curl`); the logic is already covered by Tasks 2–8

**Interfaces:**
- Consumes: everything exported by `lib/roster.js`
- Produces: `requireRosterAdmin` middleware; `GET /api/roster`, `POST /api/roster/members`, `PATCH /api/roster/members/:id`, `DELETE /api/roster/members/:id`, `PATCH /api/roster/members/:id/admin`; `req.session.canManageRoster`

- [ ] **Step 1: Add the session field**

In the login handler in `server.js`, the query already selects member columns. Add `m.can_manage_roster` to its `SELECT`, then alongside the existing `req.session.role = ...` assignment add:

```js
req.session.canManageRoster = !!member.can_manage_roster;
```

- [ ] **Step 2: Add the middleware**

Directly below `requireRole` in `server.js`:

```js
// Roster management is a capability, not a rank. Twenty-one members hold
// role='leadership' — the Commander, the Chief, the First Sergeant, four flight
// superintendents and all nine shop NCOICs — so requireRole('leadership') would
// grant roster control to twenty-one people rather than two.
function requireRosterAdmin(req, res, next) {
  if (req.session.canManageRoster) return next();
  res.status(403).json({ error: 'Forbidden' });
}
```

- [ ] **Step 3: Add the routes**

Place these with the other `/api` routes in `server.js`, before the static/catch-all block. Add `const roster = require('./lib/roster');` alongside the existing `lib` requires.

```js
// ── Roster management (capability-gated: members.can_manage_roster) ──────────
function rosterFail(res, e) {
  if (e instanceof roster.RosterError) {
    return res.status(e.status).json({ error: e.code, message: e.message });
  }
  console.error(e);
  res.status(500).json({ error: 'Server error' });
}

app.get('/api/roster', requireAuth, requireRosterAdmin, async (req, res) => {
  try {
    res.json({
      members: await roster.listRoster(pool),
      shops: (await pool.query(`SELECT id, name FROM shops ORDER BY name`)).rows,
      flights: roster.FLIGHTS,
      placements: Object.fromEntries(
        Object.entries(roster.PLACEMENTS).map(([k, v]) => [k, v.positions])),
    });
  } catch (e) { rosterFail(res, e); }
});

app.post('/api/roster/members', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  try { res.json(await roster.createMember(pool, req.body, req.session.memberId)); }
  catch (e) { rosterFail(res, e); }
});

app.patch('/api/roster/members/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  try { res.json(await roster.updateMember(pool, req.params.id, req.body, req.session.memberId)); }
  catch (e) { rosterFail(res, e); }
});

app.delete('/api/roster/members/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  try { res.json(await roster.deleteMember(pool, req.params.id)); }
  catch (e) { rosterFail(res, e); }
});

app.patch('/api/roster/members/:id/admin', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  try {
    res.json(await roster.setRosterAdmin(pool, req.params.id, !!req.body.grant, req.session.memberId));
  } catch (e) { rosterFail(res, e); }
});
```

- [ ] **Step 4: Add the page route**

Next to the existing `/build` and `/records` routes, and **before** the SPA catch-all:

```js
// Unlike /build and /records, the shell itself is gated: this page lists every
// member including inactive ones, so there is no reason to serve the frame to
// members who cannot use it.
app.get('/roster', requireAuth, (req, res) => {
  if (!req.session.canManageRoster) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'roster.html'));
});
```

- [ ] **Step 5: Verify the gate manually**

Start the preview server, sign in as a leadership account **without** the flag, and run:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3101/api/roster
```

Expected: `403`. Then grant the flag with
`UPDATE members SET can_manage_roster = true WHERE slug = 'gablin';`, sign in again, and expect `200`.

- [ ] **Step 6: Run the full suite and commit**

```bash
node --env-file=.env.test --test --test-concurrency=1 test/*.test.js
git add server.js
git commit -m "feat: capability-gated /api/roster endpoints and /roster page route"
```

---

### Task 10: Extract the member browser

**Files:**
- Create: `public/member-browser.js`
- Modify: `public/design.css` (browser styles), `public/records.html` (consume it)
- Test: manual DOM comparison

**Interfaces:**
- Consumes: nothing
- Produces: global `renderMemberBrowser(host, members, opts)` where `opts` is `{ onSelect(member), showInactive = false, groupBadge(shopName, membersInShop) -> string|null }`

- [ ] **Step 1: Capture the current /records DOM as the regression baseline**

With the preview server running and signed in, open `/records` and run in the browser console:

```js
copy(document.getElementById('member-list').innerHTML)
```

Save it to `/tmp/records-baseline.html`. This is the bar: the extraction must reproduce it exactly.

- [ ] **Step 2: Create public/member-browser.js**

Move the rendering and filtering logic out of `records.html` into this file, parameterised:

```js
/* member-browser.js — the shop-grouped, searchable member list shared by
   /records and /roster. Extracted from records.html so there is one
   implementation to change when the 73-member list needs to change.

   Self-contained on purpose: it carries its own escapeHtml rather than relying
   on the host page defining one, so a new page can use it by adding a single
   script tag. */

function mbEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMemberBrowser(host, members, opts = {}) {
  const { onSelect, showInactive = false, groupBadge = () => null } = opts;
  const visible = members.filter(m => showInactive || m.active);

  const groups = new Map();
  for (const m of visible) {
    const shop = m.shop_name || 'Unassigned';
    if (!groups.has(shop)) groups.set(shop, []);
    groups.get(shop).push(m);
  }

  host.innerHTML = [...groups.entries()].map(([shop, list]) => {
    const badge = groupBadge(shop, list);
    return `<div class="shop-group">
      <div class="shop-group-hd">
        <span>${mbEscape(shop)}</span>
        <span class="sg-count">${list.length}</span>
        ${badge ? `<span class="sg-badge">${mbEscape(badge)}</span>` : ''}
      </div>
      ${list.map(m => `
        <button class="member-row${m.active ? '' : ' inactive'}" data-id="${m.id}">
          <span class="mr-rank">${mbEscape(m.rank)}</span>
          <span class="mr-name">${mbEscape(m.last_name)}, ${mbEscape(m.first_name)}</span>
        </button>`).join('')}
    </div>`;
  }).join('');

  host.querySelectorAll('.member-row').forEach(btn => {
    btn.addEventListener('click', () => {
      host.querySelectorAll('.member-row.sel').forEach(x => x.classList.remove('sel'));
      btn.classList.add('sel');
      const m = visible.find(x => String(x.id) === btn.dataset.id);
      if (onSelect && m) onSelect(m);
    });
  });
}

function filterMemberBrowser(host, query) {
  const q = String(query || '').trim().toLowerCase();
  let shown = 0;
  host.querySelectorAll('.member-row').forEach(row => {
    const hit = !q || row.textContent.toLowerCase().includes(q);
    row.style.display = hit ? '' : 'none';
    if (hit) shown++;
  });
  host.querySelectorAll('.shop-group').forEach(g => {
    const any = [...g.querySelectorAll('.member-row')].some(r => r.style.display !== 'none');
    g.style.display = any ? '' : 'none';
  });
  return shown;
}
```

- [ ] **Step 3: Move the styles into design.css**

Cut `.member-list`, `.member-row`, `.shop-group-hd`, `.sg-count`, `.search-wrap`, `.search-input` and `.search-count` from `records.html`'s `<style>` block and paste them into `design.css` under a `/* ── Member browser ── */` heading. Add two new rules:

```css
.member-row.inactive { opacity: .55; }
.sg-badge { font-size: 11px; font-weight: 600; color: var(--warn); margin-left: auto; }
```

- [ ] **Step 4: Point records.html at the shared component**

Add `<script src="/member-browser.js" defer></script>` to the `<head>` beside the existing `ui.js` tag, delete the now-duplicated render/filter functions, and call the shared ones:

```js
renderMemberBrowser(document.getElementById('member-list'), ROSTER, {
  onSelect: m => selectMember(m.id),
});
```

Wire the search input to `filterMemberBrowser` and write its return value into `#search-count`.

- [ ] **Step 5: Verify /records is byte-identical**

Reload `/records`, re-run `copy(document.getElementById('member-list').innerHTML)` and diff against `/tmp/records-baseline.html`.
Expected: no differences. Confirm 61 members still render, search still filters, and selecting a member still loads their history.

- [ ] **Step 6: Commit**

```bash
git add public/member-browser.js public/design.css public/records.html
git commit -m "refactor: extract the shop-grouped member browser into a shared component"
```

---

### Task 11: The /roster page

**Files:**
- Create: `public/roster.html`
- Modify: `public/index.html` (Leadership Tools button)
- Test: manual

**Interfaces:**
- Consumes: `renderMemberBrowser`, `filterMemberBrowser`, `uiConfirm`, `uiToast`, and all `/api/roster/*` endpoints
- Produces: nothing

- [ ] **Step 1: Create public/roster.html**

Model the shell on `records.html`: same `<head>` (theme script, `/design.css`, `/ui.js`, plus `/member-browser.js`), same `<header class="topbar">`, an `<h1 class="vh">Roster</h1>`, and a `<main class="records-grid">` with the browser on the left and a detail card on the right.

The detail card is one form with: last name, first name, rank, shop (`<select>` from `/api/roster` shops), **placement** (`<select>` over the five placements), position (`<select>`, options repopulated from `placements[placement]`, hidden when that list is empty), flight (`<select>` over `flights`, shown only for `flight_leader`), email, sign-in name, and an active checkbox.

Below the form, outside it, the roster-admin toggle.

- [ ] **Step 2: Wire the shop composition warnings**

```js
// Two active leads in one shop makes one of them silently vanish from the org
// chart, because shop.ncoic is a single slot. Surface it; never block it —
// mid-succession is a legitimate temporary state.
function shopBadge(shopName, list) {
  const leads = list.filter(m =>
    m.active && m.role === 'leadership' && ['NCOIC', 'SNCOIC'].includes(m.position));
  if (leads.length === 0) return 'no lead';
  if (leads.length > 1) return `${leads.length} leads`;
  return null;
}
```

Pass it as `groupBadge` to `renderMemberBrowser`.

- [ ] **Step 3: Wire the destructive actions through uiConfirm**

```js
async function doDeactivate(m) {
  if (!await uiConfirm({
    title: `Deactivate ${m.rank} ${m.last_name}?`,
    message: 'They will no longer be able to sign in and will drop off rosters and the org chart. All of their task history is kept.',
    confirmLabel: 'Deactivate', danger: true,
  })) return;
  await save(m.id, { active: false });
}

// Delete is always offered: the server detects "unreferenced" by attempting the
// delete and catching the foreign-key violation, so deletability cannot be known
// in advance without a second, drift-prone source of truth.
async function doDelete(m) {
  if (!await uiConfirm({
    title: `Delete ${m.last_name} permanently?`,
    message: 'This removes the record entirely. Only possible for a member with no history.',
    confirmLabel: 'Delete', danger: true,
  })) return;
  const res = await fetch(`/api/roster/members/${m.id}`, { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
  if (res.ok) { uiToast('Member deleted', 'success'); return reload(); }
  if (body.error === 'HAS_HISTORY') {
    if (await uiConfirm({
      title: 'This member has history',
      message: "They can't be deleted, but they can be deactivated — which keeps their record and history intact.",
      confirmLabel: 'Deactivate instead',
    })) return save(m.id, { active: false });
    return;
  }
  uiToast(body.message || 'Could not delete', 'error');
}
```

Granting `leadership` placement and granting the admin capability each get their own `uiConfirm` naming what it unlocks.

- [ ] **Step 4: Add the Leadership Tools button**

In `public/index.html`, beside the existing Task Builder and Records buttons:

```html
<button class="add-btn" id="tool-roster" style="display:none" onclick="window.location.href='/roster'">
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4"/><path d="M12 6h3M13.5 4.5v3"/></svg>
  Roster
</button>
```

Reveal it where the app already handles the `/api/auth/me` response:

```js
if (currentMember?.can_manage_roster) {
  const b = document.getElementById('tool-roster');
  if (b) b.style.display = '';
}
```

Expose the field on `GET /api/auth/me` **from the session, not from the query** — Task 9 Step 1 already put it there at login:

```js
can_manage_roster: !!req.session.canManageRoster,
```

This keeps the spec's guarantee intact: no member-facing SQL changes, and the only member-app change is one additive boolean on a response plus a button that stays hidden for everyone without the capability.

- [ ] **Step 5: Verify the full flow**

With the preview server running and the flag granted to `gablin`:

1. Leadership Tools shows Roster; a leadership account without the flag does not, and `/roster` redirects for them.
2. Create a member — confirm the generated slug is shown, and that they can sign in with their last name and are forced to change it.
3. Run the Fernandez succession: deactivate the Electrical lead, promote a member to Shop lead / SNCOIC, set another to Shop supervisor. Confirm the Electrical group shows `no lead` then `1` and that `/api/squadron/org-chart` places everyone correctly.
4. Attempt to delete a member with tasks — confirm the "has history" dialog offers deactivate.
5. Revoke the flag from `mcnaughton`, then attempt to revoke it from `gablin` — confirm the refusal message.
6. Check both themes and that the page has headings and landmarks.

- [ ] **Step 6: Run the full suite and commit**

```bash
node --env-file=.env.test --test --test-concurrency=1 test/*.test.js
git add public/roster.html public/index.html server.js
git commit -m "feat: /roster page for adding, editing and deactivating members"
```

---

## Deployment

After merge, run once against production:

```sql
UPDATE members SET can_manage_roster = true WHERE slug IN ('gablin', 'mcnaughton');
```

Then verify both accounts see the Roster button and no other leadership account does. The migration is additive and ignored by every existing query, so rollback is just reverting the deploy.
