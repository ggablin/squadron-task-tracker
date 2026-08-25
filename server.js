const express = require('express');
// Patches Express 4's router so a rejected async handler is handed to the error
// middleware at the bottom of this file instead of vanishing. On stock Express 4
// a throw inside an `async` route handler leaves the returned promise rejected
// with nothing listening: no error middleware runs and NO RESPONSE IS EVER SENT,
// so the request hangs until the client gives up. That is not hypothetical here
// — lib/calendar-events.js once threw out of `validate`, which every write route
// calls OUTSIDE its try, and a test sat for 305 seconds instead of failing.
// Fixing that one throw did not remove the mechanism, so this closes the class.
// Must be required before any route is defined; see test/async-errors-http.test.js.
require('express-async-errors');
const compression = require('compression');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { acquireMigrationLock } = require('./lib/db');
const duties = require('./lib/duties');
const drillCal = require('./lib/drill-calendar');
const calEvents = require('./lib/calendar-events');
const { assertTaskInLiveCycle, listGroups, addTaskBatch, copyForward } = require('./lib/tasks');
const tasksLib = require('./lib/tasks');
const cycles = require('./lib/cycles');
// Shared with the newsletter so the app and the printed cover stat never disagree
// about what counts as work — see lib/informational.js.
const { informationalSql, criticalSql } = require('./lib/informational');
// Who counts as "present at drill" for the two-way rollup percentages.
const { presenceJoinSql, presentExpr } = require('./lib/presence');
const medical = require('./lib/medical');
const attendance = require('./lib/attendance');
const drillRoster = require('./lib/drill-roster');
const schedule = require('./lib/schedule');
const events = require('./lib/events');
const batches = require('./lib/batches');
const records = require('./lib/records');
const roster = require('./lib/roster');
const activity = require('./lib/activity');
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// Registered first so every response body — the ~400KB single-file SPA above
// all — goes out gzipped. Express doesn't compress by default and Railway's
// proxy passes bodies through as-is, so without this, members on base wifi
// were pulling the full uncompressed page on every cold load.
app.use(compression());

app.use(express.json());

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  // Re-issue the cookie on activity, so the 30 days run from LAST USE rather than
  // from sign-in. Without this the store row is touched but the cookie is not, so
  // a member is signed out 30 days after logging in no matter how often they open
  // the app — and on a monthly drill cadence that lands on roughly every other
  // UTA. An installed home-screen app that demands a password each drill is a
  // bookmark with extra steps.
  rolling: true,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days, now sliding
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  },
}));

// Retry a statement that lost a deadlock or a lock-timeout race. Postgres picks a
// victim and aborts it; the work itself is still valid, so the loser should simply
// try again rather than surface a warning and leave the schema half-migrated.
const DEADLOCK_CODES = new Set(['40P01', '55P03', '40001']);
async function withDeadlockRetry(what, fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!DEADLOCK_CODES.has(err && err.code) || i >= attempts) throw err;
      const wait = 150 * i;
      console.warn(`${what}: ${err.code}, retrying in ${wait}ms (attempt ${i} of ${attempts - 1})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// ── Auto-migration (runs once on startup) ──────────────────────────────────
// Held under an advisory lock so a second instance booting mid-deploy — or a
// test process applying schema.sql at the same moment — queues behind this one
// instead of deadlocking against it. withDeadlockRetry below stays as a second
// line of defence for anything the lock doesn't cover. See lib/db.js.
//
// Exposed as app.ready because this is fire-and-forget: requiring server.js
// starts it and nothing could wait for it. A test that then runs its own DDL
// races these ensureTable calls — the lock orders this block against
// applySchema(), but raw DDL in a test body is not lock-protected, so if the
// test side wins the lock first (fast local Postgres, i.e. CI) the CREATEs here
// land in the middle of the test and collide. Awaiting app.ready first removes
// the overlap entirely. Resolves rather than rejects: the catch below turns any
// migration failure into a warning, so awaiting it never throws.
app.ready = (async () => {
  let releaseMigrationLock = null;
  try {
    releaseMigrationLock = await acquireMigrationLock(pool);
    await withDeadlockRetry('schema migration', () => pool.query(`
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS manages_work_orders BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT false;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS flagged_by_id INTEGER REFERENCES members(id);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by_id INTEGER REFERENCES members(id);
      ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS created_by_id INTEGER REFERENCES members(id);
      ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'open';
      ALTER TABLE members ADD COLUMN IF NOT EXISTS flight VARCHAR(30);
      ALTER TABLE members ADD COLUMN IF NOT EXISTS position VARCHAR(50);
      ALTER TABLE members ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT true;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS can_manage_roster BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS updated_by_id INTEGER REFERENCES members(id);
      ALTER TABLE uta_cycles ADD COLUMN IF NOT EXISTS status VARCHAR(20) CHECK (status IN ('draft','live','archived'));
      UPDATE uta_cycles SET status = CASE WHEN is_current THEN 'live' ELSE 'archived' END WHERE status IS NULL;
      ALTER TABLE uta_cycles ALTER COLUMN status SET DEFAULT 'draft';
      CREATE TABLE IF NOT EXISTS task_batches (
        id            SERIAL PRIMARY KEY,
        uta_cycle_id  INTEGER REFERENCES uta_cycles(id),
        label         VARCHAR(255) NOT NULL,
        kind          VARCHAR(20) CHECK (kind IN ('new_task','copy_forward')),
        created_by_id INTEGER REFERENCES members(id),
        created_at    TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES task_batches(id);
      CREATE TABLE IF NOT EXISTS shop_event_status_log (
        id            SERIAL PRIMARY KEY,
        shop_event_id INTEGER REFERENCES shop_events(id) ON DELETE CASCADE,
        status        VARCHAR(20) NOT NULL CHECK (status IN ('open','in_progress','complete')),
        note          TEXT NOT NULL,
        updated_by_id INTEGER REFERENCES members(id),
        created_at    TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_se_status_log_event ON shop_event_status_log (shop_event_id);
      CREATE TABLE IF NOT EXISTS squadron_events (
        id            SERIAL PRIMARY KEY,
        uta_cycle_id  INTEGER REFERENCES uta_cycles(id),
        day           VARCHAR(20),
        start_time    VARCHAR(10),
        end_time      VARCHAR(10),
        title         VARCHAR(255) NOT NULL,
        details       TEXT,
        kind          VARCHAR(20) CHECK (kind IN
                        ('formation','training','meeting','briefing','medical','work','admin','lunch')),
        is_concurrent BOOLEAN DEFAULT false,
        emphasis      TEXT,
        attendees     JSONB,
        created_by_id INTEGER REFERENCES members(id),
        sort_order    INTEGER DEFAULT 99,
        created_at    TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id            SERIAL PRIMARY KEY,
        member_id     INTEGER NOT NULL REFERENCES members(id),
        type          VARCHAR(30) NOT NULL
                        CHECK (type IN ('tasks_live','task_assigned','completion_digest')),
        title         VARCHAR(255) NOT NULL,
        body          TEXT,
        link          VARCHAR(50),
        read_at       TIMESTAMP,
        emailed_at    TIMESTAMP,
        created_at    TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications (member_id, read_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_unemailed ON notifications (emailed_at) WHERE emailed_at IS NULL;
      ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
      ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
        CHECK (type IN ('tasks_live','task_assigned','completion_digest','task_escalated'));
      DO $$ BEGIN
        ALTER TABLE tasks ADD CONSTRAINT tasks_cycle_member_cat_title_uniq
          UNIQUE (uta_cycle_id, member_id, category_id, title);
      EXCEPTION WHEN others THEN NULL;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS uta_cycles_one_current ON uta_cycles (is_current) WHERE is_current;
      ALTER TABLE uta_cycles ADD COLUMN IF NOT EXISTS period_count SMALLINT DEFAULT 4;
      CREATE TABLE IF NOT EXISTS attendance (
        id            SERIAL PRIMARY KEY,
        uta_cycle_id  INTEGER NOT NULL REFERENCES uta_cycles(id),
        member_id     INTEGER NOT NULL REFERENCES members(id),
        shop_id       INTEGER REFERENCES shops(id),
        period        SMALLINT NOT NULL CHECK (period BETWEEN 1 AND 12),
        status        VARCHAR(20) NOT NULL CHECK (status IN
                        ('agr_at_orders','present','ruta_excused','unexcused','awol','maternity','transfer','separated','equiv_training')),
        note          TEXT,
        marked_by_id  INTEGER REFERENCES members(id),
        updated_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE (uta_cycle_id, member_id, period)
      );
      CREATE INDEX IF NOT EXISTS idx_attendance_cycle_shop ON attendance (uta_cycle_id, shop_id);
      ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS event_group_id INTEGER;
      ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS kind VARCHAR(20);
      CREATE INDEX IF NOT EXISTS idx_shop_events_group ON shop_events (event_group_id);
      CREATE TABLE IF NOT EXISTS documents (
        id             SERIAL PRIMARY KEY,
        title          VARCHAR(120) NOT NULL,
        description    VARCHAR(300),
        category       VARCHAR(60)  NOT NULL DEFAULT 'Forms',
        filename       VARCHAR(200) NOT NULL,
        mime           VARCHAR(120) NOT NULL DEFAULT 'application/pdf',
        byte_size      INTEGER      NOT NULL,
        content        BYTEA        NOT NULL,
        uploaded_by_id INTEGER REFERENCES members(id),
        sort_order     INTEGER      DEFAULT 99,
        active         BOOLEAN      DEFAULT true,
        created_at     TIMESTAMP    DEFAULT NOW(),
        updated_at     TIMESTAMP    DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_documents_listing
        ON documents (active, category, sort_order, title);
      -- CREATE TABLE IF NOT EXISTS above is a no-op once the table exists, so a
      -- column added after the first deploy needs its own ALTER or it is simply
      -- absent on every database that already ran the earlier version.
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS mime VARCHAR(120) NOT NULL DEFAULT 'application/pdf';
      -- Student Flight tracking (First Sergeant): flagged on the member, dates ride along.
      ALTER TABLE members ADD COLUMN IF NOT EXISTS is_student_flight BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS bmt_start     DATE;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS bmt_grad      DATE;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS tech_start    DATE;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS tech_grad     DATE;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS student_notes VARCHAR(500);
      -- Task helpers: optional link and/or attached Resources form per task.
      -- document_id's REFERENCES needs the documents table, created just above.
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS link_url    VARCHAR(500);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS document_id INTEGER REFERENCES documents(id);
      -- Web Push. Twinned from schema.sql; see the comment there for why endpoint
      -- is the key. Placed last so members and notifications both already exist —
      -- this block runs top to bottom and a REFERENCES to a table created later
      -- in the same statement would fail.
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id          SERIAL PRIMARY KEY,
        member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        endpoint    TEXT NOT NULL UNIQUE,
        p256dh      TEXT NOT NULL,
        auth        TEXT NOT NULL,
        user_agent  TEXT,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_push_subs_member ON push_subscriptions (member_id);
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed_at TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_notifications_unpushed
        ON notifications (pushed_at) WHERE pushed_at IS NULL;
    `));
    console.log('Migration check complete');

    // Attendance statuses gained pay codes, so the set changed. Rows are remapped
    // BEFORE the constraint is replaced, or ADD CONSTRAINT fails on the app's own
    // data: 'at' and 'deployed' were both "away on orders" — one thing to the pay
    // clerk — and 'ruta' and 'excused' were both a rescheduled drill.
    //
    // schema.sql deliberately carries no copy: its CREATE TABLE already declares the
    // new constraint, so a fresh database needs no upgrade and only this path ever
    // takes the lock.
    //
    // Guarded, so it is a no-op once applied — and retried, because ALTER TABLE takes
    // an AccessExclusiveLock that can deadlock against anything else touching these
    // tables at the same moment. That is not hypothetical: the HTTP tests boot this
    // block while applying schema.sql, and a Railway deploy can have two instances
    // starting at once. A deadlock is transient by definition — Postgres kills one
    // side — so the fix is to come back, not to give up and leave the constraint
    // un-migrated behind a logged warning.
    await withDeadlockRetry('attendance status migration', () => pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'attendance'::regclass
             AND conname  = 'attendance_status_check'
             AND pg_get_constraintdef(oid) LIKE '%agr_at_orders%'
        ) THEN
          ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_status_check;
          ALTER TABLE attendance ALTER COLUMN status TYPE VARCHAR(20);
          UPDATE attendance SET status = 'agr_at_orders' WHERE status IN ('at', 'deployed');
          UPDATE attendance SET status = 'ruta_excused'  WHERE status IN ('ruta', 'excused');
          ALTER TABLE attendance ADD CONSTRAINT attendance_status_check
            CHECK (status IN ('agr_at_orders','present','ruta_excused','unexcused',
                              'awol','maternity','transfer','separated','equiv_training'));
        END IF;
      END $$;
    `));

    // Work control belongs to Operations, so turn the flag on there once. The NOT
    // EXISTS guard is what makes this safe to run on every boot: it fires only
    // while no shop holds the flag, so moving work control to another shop — or
    // deliberately switching it off — survives the next deploy instead of being
    // silently undone. Named 'Operations' to match the roster; if that shop is
    // absent or renamed this simply does nothing and the flag can be set by hand.
    await pool.query(`
      UPDATE shops SET manages_work_orders = true
       WHERE name = 'Operations'
         AND NOT EXISTS (SELECT 1 FROM shops WHERE manages_work_orders)
    `);

    // Recover sign-ins that predate last_login_at. connect-pg-simple keeps a row
    // per live session with expire = last activity + the 30-day cookie maxAge, so
    // expire - 30 days reconstructs roughly when that session was last used.
    // Approximate by design, and only ever fills NULLs — a real stamp always wins
    // and re-running is a no-op. Separate query with its own guard so a missing
    // session table (first boot, before the store initialises) can't roll back
    // the schema migration above.
    await pool.query(`
      DO $$ BEGIN
        IF to_regclass('public.session') IS NOT NULL THEN
          UPDATE members m SET last_login_at = s.approx
          FROM (
            SELECT (sess->>'memberId')::int AS mid,
                   MAX(expire) - INTERVAL '30 days' AS approx
            FROM session
            WHERE sess->>'memberId' ~ '^[0-9]+$'
            GROUP BY 1
          ) s
          WHERE m.id = s.mid AND m.last_login_at IS NULL;
        END IF;
      END $$;
    `);

    // Resources reference tables (duties, drill dates, calendar events). Each
    // lib creates its table and seeds it from data/ in the one boot that finds
    // it absent; every later boot is a no-op, so rows an admin deletes stay
    // gone. schema.sql carries the twin CREATEs, empty, for tests and seed.js.
    for (const [name, mod] of [['additional_duties', duties], ['drill_dates', drillCal],
                               ['calendar_events', calEvents]]) {
      const r = await mod.ensureTable(pool);
      if (r.created) console.log(`Created ${name} and seeded ${r.seeded} rows`);
    }
  } catch (e) {
    console.error('Migration warning:', e.message);
  } finally {
    if (releaseMigrationLock) await releaseMigrationLock();
  }
})();

// ── Middleware ───────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.memberId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireRole(minRole) {
  const levels = { member: 0, supervisor: 1, leadership: 2 };
  return (req, res, next) => {
    if ((levels[req.session.role] ?? -1) >= levels[minRole]) return next();
    res.status(403).json({ error: 'Forbidden' });
  };
}

// Roster management is a capability, not a rank. Twenty-one members hold
// role='leadership' — the Commander, the Chief, the First Sergeant, four flight
// superintendents and all nine shop NCOICs — so requireRole('leadership') would
// grant roster control to twenty-one people rather than two.
//
// Reads can_manage_roster and active live from members on every request,
// rather than trusting req.session.canManageRoster — which is written only at
// login and good for the cookie's full 30-day life (see the session config
// above). A session-only gate meant a revoked admin kept full roster control,
// including granting the capability back to themselves, until their cookie
// happened to expire. The session field still exists and is still set at
// login, but only for the cheap UI hint (/api/auth/me, showing the Roster
// button) — it must never be used to gate a request.
async function requireRosterAdmin(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT can_manage_roster, active FROM members WHERE id = $1`, [req.session.memberId]);
    if (!rows.length || !rows[0].active || !rows[0].can_manage_roster) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ── Work control ─────────────────────────────────────────────────────────────
// Operations creates, distributes and closes work orders for the whole squadron,
// so its members reach every shop's work orders regardless of rank — Work Control
// includes an Airman, and rank is the wrong axis for a job description.
//
// Read from the shop on each request rather than from req.session, for the same
// reason requireRosterAdmin does: moving someone out of Operations then takes
// their reach away immediately instead of whenever their session happens to end.
async function managesWorkOrders(memberId) {
  const { rows } = await pool.query(
    `SELECT s.manages_work_orders
       FROM members m JOIN shops s ON s.id = m.shop_id
      WHERE m.id = $1 AND m.active`, [memberId]);
  return rows.length ? rows[0].manages_work_orders === true : false;
}

// Gate for the shop_events write endpoints, which carry schedules and emphasis
// items as well as work orders.
//
// A supervisor or leader passes on rank and keeps exactly the reach they had.
// Work control passes on the shop flag alone, so req.woOnly marks a caller whose
// only claim is work control — every handler below must then refuse anything
// that is not a work order, in their own shop as much as anyone else's. Without
// that check the flag would hand an Operations Airman the squadron's schedules.
async function requireWorkOrderWriter(req, res, next) {
  try {
    const rank = { member: 0, supervisor: 1, leadership: 2 }[req.session.role] ?? -1;
    req.woManager = await managesWorkOrders(req.session.memberId);
    if (rank >= 1) return next();
    if (req.woManager) { req.woOnly = true; return next(); }
    return res.status(403).json({ error: 'Forbidden' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

// True when this caller may act on a work order belonging to `shopId`. Leadership
// keeps its existing reach over every event in every shop; work control gets the
// same reach but only for work orders; everyone else is held to their own shop.
function mayTouchEvent(req, shopId, eventType) {
  if (shopId === req.session.shopId) return !req.woOnly || eventType === 'work_order';
  if (req.session.role === 'leadership') return true;
  return !!req.woManager && eventType === 'work_order';
}

// Blocks every state-changing endpoint until a defaulted account sets its own
// password. Session flag is set from members.must_change_password at login and
// cleared by POST /api/auth/password. Read-only endpoints are intentionally
// exempt so a not-yet-onboarded member can still see their tasks.
function requireOnboarded(req, res, next) {
  if (req.session.mustChange) return res.status(403).json({ error: 'You must change your password before continuing' });
  next();
}

// Parse a route :id param to a positive integer, or null if malformed. Capped at
// int4: every id column here is INTEGER, so a larger number reaches Postgres and
// raises 22003 — a 500 where the honest answer is 404.
function reqId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

const VALID_URGENCY = ['overdue', 'this_uta', 'next_uta', 'future', 'info'];
const URGENCY_LABEL = {
  overdue: 'Overdue', this_uta: 'This UTA', next_uta: 'Next UTA',
  future: 'Future', info: 'Info',
};

// Collect only the keys the caller actually sent, so lib/tasks.js can tell
// "leave unchanged" from "set to null".
function pickFields(body, allowed) {
  const out = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }
  return out;
}

// ── Task helpers (link + attached form) ──────────────────────────────────────
// Shared by every task-authoring route so a link or form behaves identically
// whether the task came from a supervisor, a leadership bulk add, or /build.
// Returns { link_url, document_id } normalized, or { error } for a 400.
//
// The URL scheme check matters: these strings are rendered as anchors in the
// member's list, and http(s)-only keeps a stray "javascript:" out of an href.
async function resolveTaskHelpers(body) {
  const out = { link_url: null, document_id: null };
  const link = trimOrNull(body.link_url, 500);
  if (link) {
    if (!/^https?:\/\//i.test(link)) return { error: 'Link must start with http:// or https://' };
    out.link_url = link;
  }
  if (body.document_id != null && body.document_id !== '') {
    const docId = reqId(body.document_id);
    if (!docId) return { error: 'Invalid document' };
    const { rows } = await pool.query(
      'SELECT id FROM documents WHERE id = $1 AND active = true', [docId]);
    if (!rows.length) return { error: 'That form is no longer in the Resources library' };
    out.document_id = docId;
  }
  return out;
}

// Edit-flavored twin for the pickFields routes: validates and normalizes only
// the helper keys the caller actually sent (absent = leave alone, null/'' =
// clear), mutating `fields` in place. Returns an error string or null.
async function validateHelperFields(fields) {
  if ('link_url' in fields) {
    const link = trimOrNull(fields.link_url, 500);
    if (link && !/^https?:\/\//i.test(link)) return 'Link must start with http:// or https://';
    fields.link_url = link;
  }
  if ('document_id' in fields) {
    const h = await resolveTaskHelpers({ document_id: fields.document_id });
    if (h.error) return h.error;
    fields.document_id = h.document_id;
  }
  return null;
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

// ── Notifications ────────────────────────────────────────────────────────────
// Single source of truth for both the in-app center and the email channel.
// One parameterized multi-row INSERT; failures are logged but never block the
// request that triggered them.
async function notify(memberIds, { type, title, body = null, link = null }) {
  const ids = (memberIds || []).filter(id => id != null);
  if (!ids.length) return;
  try {
    await pool.query(
      `INSERT INTO notifications (member_id, type, title, body, link)
       SELECT id, $2, $3, $4, $5 FROM unnest($1::int[]) AS id`,
      [ids, type, title, body, link]
    );
    // Deliver immediately, but never in the request path: setImmediate detaches
    // it and the catch means a push failure cannot break whatever wrote the
    // notification. The cron tick below is the catch-up for anything missed.
    setImmediate(() => {
      require('./lib/push').flushPush({ pool })
        .catch(e => console.error('push flush failed:', e.message));
    });
  } catch (err) {
    console.error('notify() failed:', err.message);
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const { slug, password } = req.body;
    if (!slug || !password) return res.status(400).json({ error: 'Missing credentials' });

    const { rows } = await pool.query(
      `SELECT m.*, s.name AS shop_name, s.manages_work_orders,
              (SELECT name FROM uta_cycles WHERE is_current = true LIMIT 1) AS uta_name
       FROM members m JOIN shops s ON s.id = m.shop_id
       WHERE m.slug = $1 AND m.active = true`,
      [slug.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid username or password' });

    const member = rows[0];
    const valid = await bcrypt.compare(password, member.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    // Stamp the sign-in. This is what lets /api/activity distinguish "signed in
    // but never set a password" from "never opened the app at all" —
    // must_change_password alone collapses the two. A failure here must not cost
    // the member their login, so it's logged and swallowed.
    pool.query('UPDATE members SET last_login_at = NOW() WHERE id = $1', [member.id])
      .catch(err => console.error('last_login_at stamp failed:', err.message));

    req.session.memberId = member.id;
    req.session.role     = member.role;
    req.session.shopId   = member.shop_id;
    req.session.shopName = member.shop_name;
    req.session.mustChange = member.must_change_password;
    // Capability, not derived from role — see requireRosterAdmin. member.* comes
    // from `SELECT m.*` above, so can_manage_roster is already present here.
    req.session.canManageRoster = !!member.can_manage_roster;
    // Drives the UI only. Every work-order endpoint re-reads the shop flag from
    // the database (see managesWorkOrders), so moving someone out of Operations
    // takes their powers away without waiting for their session to expire.
    req.session.managesWorkOrders = !!member.manages_work_orders;

    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session save failed' });
      res.json({
        id:         member.id,
        first_name: member.first_name,
        last_name:  member.last_name,
        rank:       member.rank,
        role:       member.role,
        shop:       member.shop_name,
        slug:       member.slug,
        uta_name:   member.uta_name,
        must_change_password: member.must_change_password,
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ── Change Password ──────────────────────────────────────────────────────────

app.post('/api/auth/password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Missing fields' });
    if (String(new_password).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const { rows } = await pool.query('SELECT password_hash FROM members WHERE id = $1', [req.session.memberId]);
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });

    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(403).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query(
      'UPDATE members SET password_hash = $1, must_change_password = false WHERE id = $2',
      [hash, req.session.memberId]
    );
    req.session.mustChange = false;
    // Persist the cleared flag before responding (same as the login handler), so a
    // request the client fires right after onboarding isn't blocked by a stale session.
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session save failed' });
      res.json({ success: true });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Reset a member's password (supervisor: own shop, leadership: any) ─────────
// Sets a random one-time temp password and forces a change at next login, so the
// reset never leaves the account guessable. Returns the temp for the resetter to
// hand to the member.
app.post('/api/members/:id/reset-password', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  try {
    const memberId = parseInt(req.params.id);
    const { rows: mr } = await pool.query(
      'SELECT id, shop_id FROM members WHERE id = $1 AND active = true', [memberId]
    );
    if (!mr.length) return res.status(404).json({ error: 'Member not found' });
    if (req.session.role === 'supervisor' && mr[0].shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Cannot reset members outside your shop' });
    }

    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
    const bytes = crypto.randomBytes(8);
    let temp = '';
    for (let i = 0; i < 8; i++) temp += alphabet[bytes[i] % alphabet.length];

    const hash = await bcrypt.hash(temp, 10);
    await pool.query(
      'UPDATE members SET password_hash = $1, must_change_password = true WHERE id = $2',
      [hash, memberId]
    );
    res.json({ success: true, temp_password: temp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Member activity ──────────────────────────────────────────────────────────
// When each member was last in the app. Scope follows the same rule as the rest
// of the app: leadership sees the whole squadron (optionally one shop via
// ?shop_id), a supervisor sees only their own. No password material is returned
// — see lib/activity.js for what each state means.
app.get('/api/activity', requireAuth, requireRole('supervisor'), async (req, res) => {
  try {
    const isLead = req.session.role === 'leadership';
    let filterShop = isLead ? null : req.session.shopId;
    if (isLead && req.query.shop_id) {
      filterShop = reqId(req.query.shop_id);
      if (!filterShop) return res.status(400).json({ error: 'Invalid shop id' });
    }
    if (!isLead && !filterShop) return res.status(403).json({ error: 'Forbidden' });

    res.json(await activity.memberActivity(pool, filterShop));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Squadron documents (Resources → Forms) ───────────────────────────────────
// Blank forms every member needs: RUTA request, excusal, dental, and so on.
// Squadron admins upload; everyone reads.
//
// Bytes live in Postgres, not on disk — see the documents table in schema.sql for
// why. `content` is never selected by the listing query, so the roster of forms
// stays cheap no matter how large the files are.

const MAX_DOC_BYTES = 10 * 1024 * 1024;

// Serving a file someone uploaded, from the same origin as the app, is the risky
// part of this feature: if a browser can be talked into treating it as HTML, any
// script inside runs with the app's cookies.
//
// So a file clears three checks, not one. Its extension must be on this list; its
// leading bytes must match the signature that extension implies; and it is served
// back with the mime named here and nothing else. A .docx that is really an HTML
// page fails the second check, and anything that somehow passed would still be
// handed to Word rather than rendered.
//
// `inline` is a deliberately short list: only the formats a browser renders in a
// way that cannot execute script. Everything else is forced to download, so it
// opens in Word or Excel — outside the browser's origin entirely.
//
// SVG is absent on purpose. It is an image everywhere else, but here it is a
// script container, and there is no safe way to show a user-supplied one inline.
const DOC_TYPES = {
  pdf:  { mime: 'application/pdf', inline: true, sig: [[0x25, 0x50, 0x44, 0x46, 0x2d]] },   // %PDF-
  png:  { mime: 'image/png',  inline: true, sig: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  jpg:  { mime: 'image/jpeg', inline: true, sig: [[0xff, 0xd8, 0xff]] },
  jpeg: { mime: 'image/jpeg', inline: true, sig: [[0xff, 0xd8, 0xff]] },
  // Office Open XML is a zip; the legacy formats are OLE compound files. Neither
  // signature tells Word from Excel, so the extension picks the mime and the
  // signature only proves the container belongs to that family.
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   sig: [[0x50, 0x4b, 0x03, 0x04]] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         sig: [[0x50, 0x4b, 0x03, 0x04]] },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sig: [[0x50, 0x4b, 0x03, 0x04]] },
  doc:  { mime: 'application/msword',            sig: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]] },
  xls:  { mime: 'application/vnd.ms-excel',      sig: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]] },
  ppt:  { mime: 'application/vnd.ms-powerpoint', sig: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]] },
};
const DOC_EXTS = Object.keys(DOC_TYPES);

const extOf = (name) => (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';

// The matching DOC_TYPES entry, or null when the bytes and the extension disagree
// — which is exactly the case worth refusing.
function classifyDoc(buf, filename) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  const type = DOC_TYPES[extOf(filename)];
  if (!type) return null;
  const head = buf.subarray(0, 8);
  return type.sig.some(sig => sig.every((b, i) => head[i] === b)) ? type : null;
}

// Header-safe filename: no quotes, no CR/LF (header injection), no path parts.
// The extension is preserved when it is one we accept, so the browser and the
// operating system agree with the Content-Type we send.
function safeFilename(name) {
  const base = String(name || 'document').split(/[\\/]/).pop();
  const ext = extOf(base);
  const clean = base.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (DOC_TYPES[ext]) return clean;
  return `${clean.replace(/\.[a-z0-9]+$/i, '') || 'document'}.pdf`;
}

const trimOrNull = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : null;
};

// List — metadata only, for any signed-in member.
app.get('/api/documents', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.id, d.title, d.description, d.category, d.filename, d.byte_size, d.mime,
             d.sort_order, d.created_at,
             m.rank AS uploaded_by_rank, m.last_name AS uploaded_by_last
      FROM documents d
      LEFT JOIN members m ON m.id = d.uploaded_by_id
      WHERE d.active = true
      ORDER BY d.category, d.sort_order, d.title
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Download / view. Any signed-in member; these are blank forms, not records.
app.get('/api/documents/:id/file', requireAuth, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid document id' });
    const { rows } = await pool.query(
      'SELECT filename, content, byte_size, mime FROM documents WHERE id = $1 AND active = true', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const { filename, content, mime } = rows[0];
    // Only the handful of formats a browser renders without being able to run
    // script may open in a tab. A Word or Excel file is always a download, so it
    // is opened by the desktop application rather than anywhere near this origin.
    const type = DOC_TYPES[extOf(filename)];
    const inline = !!(type && type.inline) && !req.query.download;
    res.set({
      'Content-Type': mime || 'application/octet-stream',
      // Without nosniff a browser may sniff the body and render it as HTML, which
      // would put attacker-controlled script on this origin.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; object-src 'none'; sandbox",
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeFilename(filename)}"`,
      'Content-Length': content.length,
      'Cache-Control': 'private, max-age=300',
    });
    res.end(content);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload. Raw body rather than multipart so the feature needs no new dependency;
// the metadata rides on the query string.
app.post('/api/documents',
  requireAuth, requireRosterAdmin, requireOnboarded,
  express.raw({ type: () => true, limit: MAX_DOC_BYTES }),
  async (req, res) => {
    try {
      const title = trimOrNull(req.query.title, 120);
      if (!title) return res.status(400).json({ error: 'A title is required' });
      const filename = safeFilename(req.query.filename);
      const type = classifyDoc(req.body, filename);
      if (!type) {
        return res.status(400).json({
          error: `That file's contents do not match its type. Accepted: ${DOC_EXTS.join(', ')}.`,
        });
      }
      const { rows } = await pool.query(`
        INSERT INTO documents (title, description, category, filename, mime, byte_size, content,
                               uploaded_by_id, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING id, title, description, category, filename, mime, byte_size, sort_order, created_at
      `, [
        title,
        trimOrNull(req.query.description, 300),
        trimOrNull(req.query.category, 60) || 'Forms',
        filename,
        type.mime,
        req.body.length,
        req.body,
        req.session.memberId,
        Number.isInteger(Number(req.query.sort_order)) ? Number(req.query.sort_order) : 99,
      ]);
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

// Rename / recategorise / reorder. Metadata only — replacing the file means a new
// upload, so a link someone saved can never quietly start returning a different form.
app.patch('/api/documents/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid document id' });
    const { title, description, category, sort_order } = req.body || {};
    if (title !== undefined && !trimOrNull(title, 120)) {
      return res.status(400).json({ error: 'A title is required' });
    }
    const { rows } = await pool.query(`
      UPDATE documents SET
        title       = COALESCE($2, title),
        description = CASE WHEN $3::text IS NULL THEN description ELSE NULLIF($3, '') END,
        category    = COALESCE($4, category),
        sort_order  = COALESCE($5, sort_order),
        updated_at  = NOW()
      WHERE id = $1 AND active = true
      RETURNING id, title, description, category, filename, mime, byte_size, sort_order
    `, [
      id,
      title !== undefined ? trimOrNull(title, 120) : null,
      description !== undefined ? String(description).trim().slice(0, 300) : null,
      category !== undefined ? trimOrNull(category, 60) : null,
      sort_order !== undefined && Number.isInteger(Number(sort_order)) ? Number(sort_order) : null,
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Soft delete — the row keeps its bytes so a form removed by mistake can be put
// back from the database without hunting for the original file.
app.delete('/api/documents/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid document id' });
    const { rowCount } = await pool.query(
      'UPDATE documents SET active = false, updated_at = NOW() WHERE id = $1 AND active = true', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Additional duties (Resources → People) ───────────────────────────────────
// Everyone reads; the two roster admins write — the same gate as Forms.
app.get('/api/duties', requireAuth, async (req, res) => {
  try {
    res.json({ duties: await duties.list(pool) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

function dutyError(err, res) {
  if (err && err.code === 'DUPLICATE') return res.status(409).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: 'Server error' });
}

app.post('/api/duties', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const v = duties.validate(req.body || {}, { partial: false });
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    res.status(201).json(await duties.create(pool, v.value, req.session.memberId));
  } catch (err) { dutyError(err, res); }
});

app.patch('/api/duties/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid duty id' });
  const v = duties.validate(req.body || {}, { partial: true });
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const row = await duties.update(pool, id, v.value, req.session.memberId);
    if (!row) return res.status(404).json({ error: 'That duty no longer exists' });
    res.json(row);
  } catch (err) { dutyError(err, res); }
});

app.delete('/api/duties/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid duty id' });
  try {
    if (!await duties.remove(pool, id)) return res.status(404).json({ error: 'That duty no longer exists' });
    res.status(204).end();
  } catch (err) { dutyError(err, res); }
});

// ── The calendar (Resources → Calendar) ──────────────────────────────────────
// One read endpoint for the whole year: merging two tables and regrouping them
// by month in the browser would duplicate buildCalendar in a second language.
// The derivation lives in lib/drill-calendar.js, shared with the newsletter.
app.get('/api/calendar', requireAuth, async (req, res) => {
  let year = new Date().getUTCFullYear();
  if (req.query.year !== undefined) {
    const y = String(req.query.year);
    if (!/^\d{4}$/.test(y) || Number(y) < 2000 || Number(y) > 2100) {
      return res.status(400).json({ error: 'year must be a four-digit year between 2000 and 2100' });
    }
    year = Number(y);
  }
  try {
    const [drills, events] = await Promise.all([drillCal.listAll(pool), calEvents.listAll(pool)]);
    const { months } = drillCal.buildCalendar(drills, events, year, new Date());
    res.json({ year, years: drillCal.years(drills, events), months });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/drill-dates', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const v = drillCal.validateDrill(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const clash = await drillCal.findOverlap(pool, v.value, null);
    if (clash) {
      return res.status(409).json({
        error: `Those dates overlap the ${drillCal.label(clash.start_date, clash.end_date)} drill` });
    }
    res.status(201).json(await drillCal.create(pool, v.value, req.session.memberId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/drill-dates/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid drill id' });
  try {
    const existing = await drillCal.get(pool, id);
    if (!existing) return res.status(404).json({ error: 'That drill no longer exists' });
    // Validate the merged row, so a one-field PATCH is checked against the dates
    // it will actually have.
    const body = req.body || {};
    const v = drillCal.validateDrill({
      start_date: 'start_date' in body ? body.start_date : existing.start_date,
      end_date:   'end_date'   in body ? body.end_date   : existing.end_date,
      note:       'note'       in body ? body.note       : existing.note,
    });
    if (!v.ok) return res.status(400).json({ error: v.error });
    const clash = await drillCal.findOverlap(pool, v.value, id);
    if (clash) {
      return res.status(409).json({
        error: `Those dates overlap the ${drillCal.label(clash.start_date, clash.end_date)} drill` });
    }
    const row = await drillCal.update(pool, id, v.value, req.session.memberId);
    if (!row) return res.status(404).json({ error: 'That drill no longer exists' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/drill-dates/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid drill id' });
  try {
    if (!await drillCal.remove(pool, id)) return res.status(404).json({ error: 'That drill no longer exists' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Calendar events — TDY and training rotations. No overlap rule: two rotations
// in the same week, and a rotation across a drill, are both normal.
app.post('/api/calendar-events', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const v = calEvents.validate(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    res.status(201).json(await calEvents.create(pool, v.value, req.session.memberId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/calendar-events/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid event id' });
  try {
    const existing = await calEvents.get(pool, id);
    if (!existing) return res.status(404).json({ error: 'That event no longer exists' });
    // Merge over the stored row so a one-field PATCH validates as a whole event.
    const v = calEvents.validate({ ...existing, ...(req.body || {}) });
    if (!v.ok) return res.status(400).json({ error: v.error });
    const row = await calEvents.update(pool, id, v.value, req.session.memberId);
    if (!row) return res.status(404).json({ error: 'That event no longer exists' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/calendar-events/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid event id' });
  try {
    if (!await calEvents.remove(pool, id)) return res.status(404).json({ error: 'That event no longer exists' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Member task history (Records) ────────────────────────────────────────────
// Leadership can view any member's cross-cycle history; a supervisor is limited
// to members in their own shop (checked via getMemberShopId, same own-shop
// pattern used elsewhere — e.g. /api/shop/members/:id/tasks); plain members 403.
app.get('/api/members/:id/history', requireAuth, requireOnboarded, async (req, res) => {
  try {
    const targetId = reqId(req.params.id);
    if (!targetId) return res.status(400).json({ error: 'Invalid member id' });

    if (req.session.role !== 'leadership') {
      if (req.session.role !== 'supervisor') return res.status(403).json({ error: 'Forbidden' });
      const theirShop = await records.getMemberShopId(pool, targetId);
      if (!theirShop || theirShop !== req.session.shopId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    res.json(await records.memberHistory(pool, targetId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.first_name, m.last_name, m.rank, m.role, m.slug, m.must_change_password, s.name AS shop, m.shop_id,
              s.manages_work_orders,
              (SELECT name FROM uta_cycles WHERE is_current = true LIMIT 1) AS uta_name
       FROM members m JOIN shops s ON s.id = m.shop_id
       WHERE m.id = $1`,
      [req.session.memberId]
    );
    if (!rows.length) return res.status(401).json({ error: 'Session invalid' });
    // Sourced from the session (set at login from members.can_manage_roster), not
    // from this query — keeps this endpoint's SQL member-facing and unchanged, per
    // the roster-management spec, while still surfacing the flag for the
    // Leadership Tools button.
    res.json({ ...rows[0], can_manage_roster: !!req.session.canManageRoster });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── My Tasks ─────────────────────────────────────────────────────────────────

app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.title, t.details, t.urgency,
             t.appt_day, t.appt_time, t.appt_location, t.is_upcoming,
             t.is_flagged,
             t.link_url, t.document_id, d.title AS document_title,
             cat.code  AS category_code,
             cat.label AS category_label,
             ${informationalSql('cat')} AS informational,
             COALESCE(tc.state, 'none') AS state,
             tc.note
      FROM tasks t
      JOIN task_categories cat ON cat.id = t.category_id
      LEFT JOIN documents d ON d.id = t.document_id AND d.active = true
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE t.member_id = $1
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      ORDER BY cat.sort_order, t.is_flagged DESC NULLS LAST, t.sort_order, t.id
    `, [req.session.memberId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/tasks/:id', requireAuth, requireOnboarded, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const { state, note } = req.body;

    const { rows: tr } = await pool.query(`
      SELECT t.member_id, m.shop_id, ${informationalSql('cat')} AS informational
      FROM tasks t
      JOIN members m ON m.id = t.member_id
      JOIN task_categories cat ON cat.id = t.category_id
      WHERE t.id = $1
    `, [taskId]);
    if (!tr.length) return res.status(404).json({ error: 'Task not found' });

    // Informational rows carry no completion. The member's list renders them
    // without a checkbox, but that is presentation — refusing here is what makes
    // "does not get checked off" true rather than merely hidden. A note is still
    // allowed through, so this blocks only a state change.
    if (tr[0].informational && state && state !== 'none') {
      return res.status(400).json({
        error: 'This item is informational and does not get checked off',
      });
    }

    // Members only own task; supervisors only own-shop; leadership any
    if (tr[0].member_id !== req.session.memberId && req.session.role === 'supervisor' && tr[0].shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Cannot update tasks outside your shop' });
    }
    if (tr[0].member_id !== req.session.memberId && !['supervisor', 'leadership'].includes(req.session.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      await assertTaskInLiveCycle(pool, taskId);
    } catch (e) {
      if (e.code === 'NOT_LIVE') return res.status(403).json({ error: 'This cycle is closed to changes' });
      throw e;
    }

    await pool.query(`
      INSERT INTO task_completions (task_id, completed_by_id, state, note, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (task_id) DO UPDATE
        SET state = EXCLUDED.state, note = EXCLUDED.note,
            completed_by_id = EXCLUDED.completed_by_id, updated_at = NOW()
    `, [taskId, req.session.memberId, state || 'none', note || null]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Create Task (supervisor: own shop, leadership: any) ─────────────────────

app.post('/api/tasks', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  try {
    const { member_id, category_code, title, details, urgency, appt_day, appt_time, appt_location, is_upcoming } = req.body;
    if (!member_id || !category_code || !title) {
      return res.status(400).json({ error: 'member_id, category_code, and title are required' });
    }

    // Check target member exists and is in caller's shop (unless leadership)
    const { rows: mr } = await pool.query(
      'SELECT shop_id FROM members WHERE id = $1 AND active = true', [member_id]
    );
    if (!mr.length) return res.status(404).json({ error: 'Member not found' });
    if (req.session.role === 'supervisor' && mr[0].shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Cannot add tasks for members outside your shop' });
    }

    // Resolve category
    const { rows: catRows } = await pool.query(
      'SELECT id FROM task_categories WHERE code = $1', [category_code]
    );
    if (!catRows.length) return res.status(400).json({ error: 'Invalid category_code' });

    const helpers = await resolveTaskHelpers(req.body);
    if (helpers.error) return res.status(400).json({ error: helpers.error });

    const { rows: [task] } = await pool.query(`
      INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency,
                         appt_day, appt_time, appt_location, is_upcoming, link_url, document_id,
                         created_by_id, sort_order)
      VALUES ((SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1),
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 99)
      RETURNING *
    `, [member_id, catRows[0].id, title, details || null, urgency || 'this_uta',
        appt_day || null, appt_time || null, appt_location || null,
        is_upcoming || false, helpers.link_url, helpers.document_id, req.session.memberId]);

    // Notify the assignee (but not a supervisor assigning a task to themselves).
    if (member_id !== req.session.memberId) {
      await notify([member_id], {
        type: 'task_assigned',
        title: 'New task assigned',
        body: title,
        link: 'member',
      });
    }

    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Bulk Create Task (leadership: a shop or the whole squadron) ─────────────

app.post('/api/squadron/tasks', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const { scope, shop_id, category_code, title, details, urgency,
            appt_day, appt_time, appt_location } = req.body;
    if (!category_code || !title) {
      return res.status(400).json({ error: 'category_code and title are required' });
    }
    if (scope !== 'squadron' && scope !== 'shop') {
      return res.status(400).json({ error: "scope must be 'squadron' or 'shop'" });
    }

    // For a shop-scoped task, verify the shop exists; squadron scope targets all shops.
    let shopId = null;
    if (scope === 'shop') {
      if (!shop_id) return res.status(400).json({ error: 'shop_id is required for shop scope' });
      const { rows: sr } = await pool.query('SELECT id FROM shops WHERE id = $1', [shop_id]);
      if (!sr.length) return res.status(404).json({ error: 'Shop not found' });
      shopId = sr[0].id;
    }

    // Resolve category
    const { rows: catRows } = await pool.query(
      'SELECT id FROM task_categories WHERE code = $1', [category_code]
    );
    if (!catRows.length) return res.status(400).json({ error: 'Invalid category_code' });

    const helpers = await resolveTaskHelpers(req.body);
    if (helpers.error) return res.status(400).json({ error: helpers.error });

    // Insert one task per active recipient in a single statement.
    // shopId NULL ⇒ every active member (whole squadron).
    const { rows } = await pool.query(`
      INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency,
                         appt_day, appt_time, appt_location, is_upcoming, link_url, document_id,
                         created_by_id, sort_order)
      SELECT (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1),
             m.id, $1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, 99
      FROM members m
      WHERE m.active = true AND ($11::int IS NULL OR m.shop_id = $11)
      RETURNING member_id
    `, [catRows[0].id, title, details || null, urgency || 'this_uta',
        appt_day || null, appt_time || null, appt_location || null,
        helpers.link_url, helpers.document_id, req.session.memberId, shopId]);

    // Notify every recipient except the leader who issued the bulk task.
    await notify(
      rows.map(r => r.member_id).filter(id => id !== req.session.memberId),
      { type: 'task_assigned', title: 'New task assigned', body: title, link: 'member' }
    );

    res.json({ created: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Delete Task (supervisor: own shop, leadership: any) ─────────────────────

// Repaired: this route previously had neither an editable-cycle guard nor a
// completions guard, so a supervisor could delete a task out of an ARCHIVED
// cycle (rewriting history Records presents as frozen) and silently destroy a
// member's recorded state and note. It is reachable from public/index.html.
app.delete('/api/tasks/:id', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  const taskId = reqId(req.params.id);
  if (!taskId) return res.status(400).json({ error: 'Invalid id' });

  // The pre-check query and its 404/403 responses live inside this try, not
  // before it: Express 4 does not adopt a handler's returned promise, and
  // there is no process-level unhandledRejection handler, so an unguarded
  // await that rejects (a pool timeout, a Postgres failover) would crash the
  // whole process instead of just failing this request.
  try {
    const { rows: tr } = await pool.query(
      `SELECT m.shop_id FROM tasks t JOIN members m ON m.id = t.member_id WHERE t.id = $1`, [taskId]);
    if (!tr.length) return res.status(404).json({ error: 'Task not found' });
    if (req.session.role === 'supervisor' && tr[0].shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Cannot delete tasks outside your shop' });
    }

    res.json(await tasksLib.deleteTask(pool, taskId, { force: req.query.force === 'true' }));
  } catch (e) { sendTaskError(res, e); }
});

// ── Flag Task (supervisor: own shop, leadership: any) ───────────────────────

app.put('/api/tasks/:id/flag', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const { is_flagged } = req.body;

    const { rows: tr } = await pool.query(`
      SELECT t.member_id, m.shop_id FROM tasks t
      JOIN members m ON m.id = t.member_id
      WHERE t.id = $1
    `, [taskId]);
    if (!tr.length) return res.status(404).json({ error: 'Task not found' });
    if (req.session.role === 'supervisor' && tr[0].shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await pool.query(
      'UPDATE tasks SET is_flagged = $1, flagged_by_id = $2 WHERE id = $3',
      [!!is_flagged, req.session.memberId, taskId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Get Task Categories (for add-task form) ─────────────────────────────────

app.get('/api/categories', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT code, label FROM task_categories ORDER BY sort_order'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── UTA Cycles (leadership only) ─────────────────────────────────────────────

app.get('/api/cycles', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try { res.json(await cycles.listCycles(pool)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/cycles', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { start_date, end_date } = req.body;
    if ((start_date && !end_date) || (end_date && !start_date)) {
      return res.status(400).json({ error: 'Provide both drill dates, or neither' });
    }
    if (start_date && end_date && !attendance.periodCountFromDates(start_date, end_date)) {
      return res.status(400).json({ error: 'End date must be on or after the start date' });
    }
    res.json(await cycles.createDraft(pool, name, start_date, end_date, req.session.memberId));
  } catch (e) {
    // 409, not 400: the request is well-formed, it conflicts with existing
    // state. `message` names which cycle already holds it; the builder shows
    // that string verbatim.
    if (e.code === 'DUPLICATE_NAME') {
      return res.status(409).json({ error: 'DUPLICATE_NAME', message: e.message });
    }
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

// Set/correct a cycle's drill dates; period_count is recomputed from the span.
app.patch('/api/cycles/:id/dates', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { start_date, end_date } = req.body;
    if (start_date && end_date && !attendance.periodCountFromDates(start_date, end_date)) {
      return res.status(400).json({ error: 'End date must be on or after the start date' });
    }
    res.json(await cycles.setCycleDates(pool, id, start_date, end_date));
  } catch (e) {
    if (e.code === 'NO_CYCLE') return res.status(404).json({ error: 'No such cycle' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

/* ── Schedule authoring ──────────────────────────────────────────────────────
   One event, one audience. "all" writes the squadron timeline; a shop list
   writes those shops' schedules. lib/schedule.js owns the routing so these
   handlers stay thin and the builder never sees two shapes.
   Member-facing reads are untouched and still filter on is_current, so draft
   content cannot reach members before go-live. */

// Authoring targets a draft (the point) or the live cycle (mid-cycle fixes).
// Archived cycles are readable but frozen, matching the attendance rule.
async function loadWritableCycle(cycleId) {
  const { rows } = await pool.query('SELECT id, name, status FROM uta_cycles WHERE id = $1', [cycleId]);
  if (!rows.length) return { error: 404, message: 'No such cycle' };
  if (rows[0].status === 'archived') return { error: 403, message: 'This cycle is archived' };
  return { cycle: rows[0] };
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

function scheduleError(res, err) {
  if (err.code === 'BAD_REQUEST') return res.status(400).json({ error: err.message });
  if (err.code === 'NO_EVENT')    return res.status(404).json({ error: 'No such event' });
  console.error(err);
  return res.status(500).json({ error: 'Server error' });
}

app.get('/api/cycles/:id/schedule', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    // 404 rather than an empty list: a mistyped cycle id should not read as
    // "this cycle has no events yet".
    const { rows: cyc } = await pool.query(
      'SELECT id, name, status FROM uta_cycles WHERE id = $1', [id]);
    if (!cyc.length) return res.status(404).json({ error: 'No such cycle' });
    const { rows: shops } = await pool.query('SELECT id, name FROM shops ORDER BY name');
    res.json({ cycle: cyc[0], events: await schedule.listSchedule(pool, id), shops });
  } catch (e) { scheduleError(res, e); }
});

app.post('/api/cycles/:id/schedule', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const gate = await loadWritableCycle(id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    const created = await inTransaction(c =>
      schedule.createEvent(c, id, req.body, req.session.memberId));
    res.json(created);
  } catch (e) { scheduleError(res, e); }
});

app.put('/api/cycles/:id/schedule/:ref', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const gate = await loadWritableCycle(id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    // An audience change crosses tables, so this is a delete + create inside
    // one transaction and the caller gets a new ref back.
    const updated = await inTransaction(c =>
      schedule.updateEvent(c, id, req.params.ref, req.body, req.session.memberId));
    res.json(updated);
  } catch (e) { scheduleError(res, e); }
});

app.delete('/api/cycles/:id/schedule/:ref', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const gate = await loadWritableCycle(id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    const removed = await inTransaction(c => schedule.deleteEvent(c, req.params.ref));
    if (!removed) return res.status(404).json({ error: 'No such event' });
    res.json({ deleted: removed });
  } catch (e) { scheduleError(res, e); }
});

app.post('/api/cycles/:id/schedule/copy-forward', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const gate = await loadWritableCycle(id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    const from = reqId(req.body.from_cycle_id);
    if (!from) return res.status(400).json({ error: 'from_cycle_id is required' });
    const out = await inTransaction(c => schedule.copyForward(c, {
      fromCycleId: from, toCycleId: id,
      refs: Array.isArray(req.body.refs) ? req.body.refs : null,
      createdById: req.session.memberId,
    }));
    res.json(out);
  } catch (e) { scheduleError(res, e); }
});

/* ── Work-order authoring ────────────────────────────────────────────────────
   Same cycle-targeting and write window as the schedule routes. Work orders are
   one row per shop, so plain ids address them; no group ref is needed. */

app.get('/api/cycles/:id/work-orders', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { rows: cyc } = await pool.query(
      'SELECT id, name, status FROM uta_cycles WHERE id = $1', [id]);
    if (!cyc.length) return res.status(404).json({ error: 'No such cycle' });
    // Compare against the live cycle so rows that arrived via carry-forward can
    // be flagged, and McNaughton doesn't re-add a job that came across already.
    const { rows: live } = await pool.query(
      'SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1');
    const compareTo = live.length && live[0].id !== id ? live[0].id : null;
    const { rows: shops } = await pool.query('SELECT id, name FROM shops ORDER BY name');
    res.json({
      cycle: cyc[0], shops,
      work_orders: await events.listWorkOrders(pool, id, compareTo),
    });
  } catch (e) { scheduleError(res, e); }
});

app.post('/api/cycles/:id/work-orders', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const gate = await loadWritableCycle(id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    res.json(await inTransaction(c => events.createWorkOrder(c, id, req.body, req.session.memberId)));
  } catch (e) { scheduleError(res, e); }
});

app.put('/api/cycles/:id/work-orders/:woId', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id), woId = reqId(req.params.woId);
    if (!id || !woId) return res.status(400).json({ error: 'Invalid id' });
    const gate = await loadWritableCycle(id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    res.json(await inTransaction(c => events.updateWorkOrder(c, id, woId, req.body)));
  } catch (e) { scheduleError(res, e); }
});

app.delete('/api/cycles/:id/work-orders/:woId', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id), woId = reqId(req.params.woId);
    if (!id || !woId) return res.status(400).json({ error: 'Invalid id' });
    const gate = await loadWritableCycle(id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    const removed = await inTransaction(c => events.deleteWorkOrder(c, id, woId));
    if (!removed) return res.status(404).json({ error: 'No such work order' });
    res.json({ deleted: removed });
  } catch (e) { scheduleError(res, e); }
});

app.post('/api/cycles/:id/work-orders/copy-forward', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const gate = await loadWritableCycle(id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    const from = reqId(req.body.from_cycle_id);
    if (!from) return res.status(400).json({ error: 'from_cycle_id is required' });
    // Same rule as the automatic carry at cycle creation: unfinished only.
    res.json(await inTransaction(c => events.carryOpenWorkOrders(c, {
      fromCycleId: from, toCycleId: id, createdById: req.session.memberId,
    })));
  } catch (e) { scheduleError(res, e); }
});

app.post('/api/cycles/:id/go-live', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { cycle, notifyMemberIds } = await cycles.goLive(pool, id, { confirm: !!req.body.confirm });
    await notify(notifyMemberIds, { type: 'tasks_live', title: `Your ${cycle.name} tasks are live`, link: 'member' });
    res.json(cycle);
  } catch (e) {
    if (e.code === 'NOT_DRAFT') return res.status(409).json({ error: 'That cycle is not a draft' });
    if (e.code === 'EMPTY_DRAFT') return res.status(409).json({ error: 'EMPTY_DRAFT', message: 'This draft has no tasks yet.' });
    if (e.code === '23505') return res.status(409).json({ error: 'Another cycle just went live — please reload.' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/cycles/:id', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    res.json(await cycles.discardDraft(pool, id));
  }
  catch (e) {
    if (e.code === 'NOT_DRAFT') return res.status(409).json({ error: 'Only a draft can be discarded' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/cycles/:sourceId/groups', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const sourceId = reqId(req.params.sourceId);
    if (!sourceId) return res.status(400).json({ error: 'Invalid id' });
    res.json(await listGroups(pool, sourceId));
  }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/cycles/:id/tasks', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { title, category_code, details, assignments } = req.body;
    if (!title || !category_code || !Array.isArray(assignments) || !assignments.length) {
      return res.status(400).json({ error: 'title, category_code, and assignments are required' });
    }
    if (!assignments.every(a => Array.isArray(a.member_ids) && a.member_ids.length && a.member_ids.every(Number.isInteger))) {
      return res.status(400).json({ error: 'each assignment needs a non-empty member_ids array of integers' });
    }
    const helpers = await resolveTaskHelpers(req.body);
    if (helpers.error) return res.status(400).json({ error: helpers.error });
    const r = await addTaskBatch(pool, id, {
      title, category_code, details, link_url: helpers.link_url, document_id: helpers.document_id,
      assignments, created_by_id: req.session.memberId,
    });

    // A task added to the LIVE cycle is visible to its members the moment it
    // lands, so tell them. Without this the row appears silently and is only
    // discovered if someone happens to reopen the app — which is the whole
    // failure mode the tracker exists to fix. Draft adds stay silent on
    // purpose: the cycle's go-live blast is what announces those, and nobody
    // should be pinged about work that isn't visible yet.
    //
    // Only the members who actually received a row are notified: addTaskBatch
    // dedupes via ON CONFLICT, so someone who already had this exact task is
    // not told about it a second time.
    if (r.added > 0) {
      const { rows: [cyc] } = await pool.query(
        `SELECT status FROM uta_cycles WHERE id = $1`, [id]);
      if (cyc && cyc.status === 'live') {
        const { rows: recipients } = await pool.query(
          `SELECT member_id FROM tasks WHERE batch_id = $1`, [r.batch_id]);
        await notify(recipients.map(x => x.member_id), {
          type: 'task_assigned',
          title: 'New task assigned',
          body: title,
          link: '/',
        });
      }
    }

    res.json(r);
  } catch (e) {
    if (e.code === 'BAD_CATEGORY') return res.status(400).json({ error: 'Invalid category' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

// ── Edit a whole task group (leadership only) ────────────────────────────────
// Leadership-only because a group can span shops: a supervisor editing one
// would silently do a partial update.
app.put('/api/cycles/:id/groups', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  const cycleId = reqId(req.params.id);
  if (!cycleId) return res.status(400).json({ error: 'Invalid id' });
  const { category_code, title } = req.body || {};
  if (!category_code || !title) return res.status(400).json({ error: 'category_code and title are required' });

  const fields = pickFields(req.body, ['urgency', 'details', 'link_url', 'document_id']);
  if ('urgency' in fields && !VALID_URGENCY.includes(fields.urgency)) {
    return res.status(400).json({ error: `urgency must be one of: ${VALID_URGENCY.join(', ')}` });
  }
  try {
    const helperErr = await validateHelperFields(fields);
    if (helperErr) return res.status(400).json({ error: helperErr });
    const out = await tasksLib.updateGroup(pool, cycleId, { category_code, title }, fields);
    if (out.escalated_member_ids?.length) {
      await notify(out.escalated_member_ids, {
        type: 'task_escalated',
        title: `Urgency changed: ${title}`,
        body: `Now marked ${URGENCY_LABEL[fields.urgency]}.`,
        link: 'member',
      });
    }
    res.json(out);
  } catch (e) { sendTaskError(res, e); }
});

// ── Edit one member's task row ───────────────────────────────────────────────
// /definition, not /:id — PUT /api/tasks/:id is already the member's completion
// state, and overloading that path would be genuinely confusing to read.
app.put('/api/tasks/:id/definition', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  const taskId = reqId(req.params.id);
  if (!taskId) return res.status(400).json({ error: 'Invalid id' });

  const fields = pickFields(req.body, ['urgency', 'details', 'appt_day', 'appt_time', 'appt_location', 'link_url', 'document_id']);
  if ('urgency' in fields && !VALID_URGENCY.includes(fields.urgency)) {
    return res.status(400).json({ error: `urgency must be one of: ${VALID_URGENCY.join(', ')}` });
  }

  // The pre-check query and its 404/403 responses live inside this try, not
  // before it — see the matching comment on DELETE /api/tasks/:id above: an
  // unguarded await that rejects would otherwise crash the whole process.
  try {
    const { rows: tr } = await pool.query(
      `SELECT m.shop_id FROM tasks t JOIN members m ON m.id = t.member_id WHERE t.id = $1`, [taskId]);
    if (!tr.length) return res.status(404).json({ error: 'Task not found' });
    if (req.session.role === 'supervisor' && tr[0].shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Cannot edit tasks outside your shop' });
    }

    const helperErr = await validateHelperFields(fields);
    if (helperErr) return res.status(400).json({ error: helperErr });
    const out = await tasksLib.updateTask(pool, taskId, fields);
    if (out.escalated_member_ids?.length) {
      const { rows: [t] } = await pool.query(`SELECT title FROM tasks WHERE id=$1`, [taskId]);
      await notify(out.escalated_member_ids, {
        type: 'task_escalated',
        title: `Urgency changed: ${t.title}`,
        body: `Now marked ${URGENCY_LABEL[fields.urgency]}.`,
        link: 'member',
      });
    }
    res.json(out);
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

  // Accept force from either the JSON body (this route's own idiom) or the
  // query string (?force=true, the idiom every other force-capable route in
  // this file uses). A caller reaching for the established query idiom here
  // would otherwise silently not force and loop on 409 forever.
  const forced = force === true || req.query.force === 'true';

  try {
    res.json(await tasksLib.deleteGroup(pool, cycleId, { category_code, title }, { force: forced }));
  } catch (e) { sendTaskError(res, e); }
});

app.post('/api/cycles/:id/copy-forward', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { from_cycle_id, groups } = req.body;
    if (!from_cycle_id || !Array.isArray(groups) || !groups.length) {
      return res.status(400).json({ error: 'from_cycle_id and groups are required' });
    }
    res.json(await copyForward(pool, id, {
      from_cycle_id, groups, created_by_id: req.session.memberId,
    }));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/cycles/:id/batches', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    res.json(await batches.listBatches(pool, id));
  }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/batches/:id', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const id = reqId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    res.json(await batches.undoBatch(pool, id, { force: req.query.force === 'true' }));
  }
  // Shares sendTaskError with the task/group routes so a NOT_EDITABLE (archived
  // cycle) answers identically everywhere, not just HAS_COMPLETIONS here.
  catch (e) { sendTaskError(res, e); }
});

// ── My Shop ───────────────────────────────────────────────────────────────────

app.get('/api/shop/events', requireAuth, async (req, res) => {
  try {
    // Leadership may view another shop via ?shop_id (drives the My Shop switcher);
    // everyone else is pinned to their own shop.
    const targetShopId = req.session.role === 'leadership' && req.query.shop_id
      ? parseInt(req.query.shop_id) : req.session.shopId;
    const { rows } = await pool.query(`
      SELECT id, event_type, day, start_time, end_time, title, details, wo_number, status, sort_order FROM shop_events
      WHERE shop_id = $1
        AND uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      ORDER BY sort_order
    `, [targetShopId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Work-order board (work control only) ─────────────────────────────────────
// Every shop's work orders for the live cycle in one list, with the shop named on
// each row. Operations works from this rather than the My Shop switcher, which is
// scoped to a leader's flight and would show them three shops out of ten — and is
// closed to a plain member entirely.
//
// Deliberately separate from /api/shop/events: that endpoint answers "what is
// happening in one shop" and feeds the schedule pane too, so widening it to every
// shop would drag other shops' schedules into views that are meant to be local.
app.get('/api/work-orders', requireAuth, async (req, res) => {
  try {
    if (!(await managesWorkOrders(req.session.memberId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await pool.query(`
      SELECT se.id, se.shop_id, s.name AS shop, se.event_type, se.day,
             se.start_time, se.end_time, se.title, se.details, se.wo_number,
             se.status, se.sort_order
        FROM shop_events se
        JOIN shops s ON s.id = se.shop_id
       WHERE se.event_type = 'work_order'
         AND se.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
       ORDER BY s.name, se.sort_order, se.id
    `);
    const { rows: shops } = await pool.query(
      'SELECT id, name FROM shops ORDER BY name');
    res.json({ work_orders: rows, shops });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Create Shop Event ────────────────────────────────────────────────────────
// Supervisor: own shop. Leadership: any shop. Work control: work orders in any
// shop, and nothing else anywhere — see requireWorkOrderWriter.

app.post('/api/shop/events', requireAuth, requireWorkOrderWriter, requireOnboarded, async (req, res) => {
  try {
    const { event_type, day, start_time, end_time, title, details, wo_number, shop_id } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!event_type || !['schedule','work_order','emphasis'].includes(event_type)) {
      return res.status(400).json({ error: 'event_type must be schedule, work_order, or emphasis' });
    }

    // An explicit shop_id is honoured or refused — never quietly rewritten to the
    // caller's own shop, which would file a work order against the wrong shop and
    // look like it worked.
    const targetShopId = shop_id ? reqId(shop_id) : req.session.shopId;
    if (!targetShopId) return res.status(400).json({ error: 'Invalid shop_id' });
    if (!mayTouchEvent(req, targetShopId, event_type)) {
      return res.status(403).json({ error: 'Cannot add that event to that shop' });
    }

    const { rows: [event] } = await pool.query(`
      INSERT INTO shop_events (uta_cycle_id, shop_id, event_type, day, start_time, end_time,
                               title, details, wo_number, created_by_id, sort_order)
      VALUES ((SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1),
              $1, $2, $3, $4, $5, $6, $7, $8, $9, 99)
      RETURNING *
    `, [targetShopId, event_type, day || null, start_time || null, end_time || null,
        title, details || null, wo_number || null, req.session.memberId]);

    res.json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Delete Shop Event ─────────────────────────────────────────────────
// Same reach as create: work control may delete a work order in any shop, and
// nothing that is not a work order.────

app.delete('/api/shop/events/:id', requireAuth, requireWorkOrderWriter, requireOnboarded, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id);
    const { rows: er } = await pool.query(
      'SELECT shop_id, event_type FROM shop_events WHERE id = $1', [eventId]);
    if (!er.length) return res.status(404).json({ error: 'Event not found' });
    if (!mayTouchEvent(req, er[0].shop_id, er[0].event_type)) {
      return res.status(403).json({ error: 'Cannot delete that event' });
    }

    await pool.query('DELETE FROM shop_events WHERE id = $1', [eventId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Edit Shop Event ──────────────────────────────────────────────────────
// Status is intentionally not editable here — it changes only via the status
// endpoint so the history log stays authoritative.

app.put('/api/shop/events/:id', requireAuth, requireWorkOrderWriter, requireOnboarded, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id);
    const { event_type, day, start_time, end_time, title, details, wo_number } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!event_type || !['schedule','work_order','emphasis'].includes(event_type)) {
      return res.status(400).json({ error: 'event_type must be schedule, work_order, or emphasis' });
    }

    const { rows: er } = await pool.query(
      'SELECT shop_id, event_type FROM shop_events WHERE id = $1', [eventId]);
    if (!er.length) return res.status(404).json({ error: 'Event not found' });
    // Both the stored type and the submitted one are checked. Testing only the
    // stored type would let work control rewrite a work order into that shop's
    // schedule — a row it could never have created — and so walk out of its own
    // scope one edit at a time.
    if (!mayTouchEvent(req, er[0].shop_id, er[0].event_type)
        || !mayTouchEvent(req, er[0].shop_id, event_type)) {
      return res.status(403).json({ error: 'Cannot edit that event' });
    }

    const { rows: [event] } = await pool.query(`
      UPDATE shop_events
         SET event_type = $1, day = $2, start_time = $3, end_time = $4,
             title = $5, details = $6, wo_number = $7
       WHERE id = $8
      RETURNING *
    `, [event_type, day || null, start_time || null, end_time || null,
        title, details || null, wo_number || null, eventId]);

    res.json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Update Work Order Status (all users: own shop; leadership: any) ───────────
// Appends a row to the history log and updates the current status. Note is
// mandatory.

app.put('/api/shop/events/:id/status', requireAuth, requireOnboarded, async (req, res) => {
  const client = await pool.connect();
  try {
    const eventId = parseInt(req.params.id);
    const { status, note } = req.body;
    if (!['open','in_progress','complete'].includes(status)) {
      return res.status(400).json({ error: 'status must be open, in_progress, or complete' });
    }
    if (!note || !note.trim()) {
      return res.status(400).json({ error: 'A details note is required' });
    }

    const { rows: er } = await pool.query(
      'SELECT shop_id, event_type FROM shop_events WHERE id = $1', [eventId]);
    if (!er.length) return res.status(404).json({ error: 'Event not found' });
    // Members and supervisors may only touch their own shop; leadership any shop;
    // work control any shop's work orders — closing them is the last third of
    // "create, distribute and close" and is the whole point of the flag.
    if (er[0].shop_id !== req.session.shopId && req.session.role !== 'leadership'
        && !(er[0].event_type === 'work_order'
             && await managesWorkOrders(req.session.memberId))) {
      return res.status(403).json({ error: 'Cannot update events outside your shop' });
    }

    await client.query('BEGIN');
    await client.query(`
      INSERT INTO shop_event_status_log (shop_event_id, status, note, updated_by_id)
      VALUES ($1, $2, $3, $4)
    `, [eventId, status, note.trim(), req.session.memberId]);
    await client.query('UPDATE shop_events SET status = $1 WHERE id = $2', [status, eventId]);
    await client.query('COMMIT');

    res.json({ success: true, status });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── Work Order Status History (all users: own shop; leadership: any) ─────────

app.get('/api/shop/events/:id/log', requireAuth, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id);
    const { rows: er } = await pool.query(
      'SELECT shop_id, event_type FROM shop_events WHERE id = $1', [eventId]);
    if (!er.length) return res.status(404).json({ error: 'Event not found' });
    // Matches the status endpoint's rule — work control can write this history for
    // any shop's work order, so it has to be able to read it back.
    if (er[0].shop_id !== req.session.shopId && req.session.role !== 'leadership'
        && !(er[0].event_type === 'work_order'
             && await managesWorkOrders(req.session.memberId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { rows } = await pool.query(`
      SELECT l.status, l.note, l.created_at,
             m.rank, m.first_name, m.last_name
        FROM shop_event_status_log l
        LEFT JOIN members m ON m.id = l.updated_by_id
       WHERE l.shop_event_id = $1
       ORDER BY l.created_at DESC
    `, [eventId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/shop/members', requireAuth, async (req, res) => {
  try {
    // Leadership may view another shop via ?shop_id (drives the My Shop switcher);
    // everyone else is pinned to their own shop.
    const targetShopId = req.session.role === 'leadership' && req.query.shop_id
      ? parseInt(req.query.shop_id) : req.session.shopId;
    const { rows } = await pool.query(`
      SELECT m.id, m.last_name, m.first_name, m.rank, m.role,
             NOT m.must_change_password AS activated,
             m.last_login_at,
             COUNT(t.id) FILTER (WHERE NOT ${informationalSql()})                    AS total_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql()})   AS done_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'partial' AND NOT ${informationalSql()}) AS partial_tasks
      FROM members m
      LEFT JOIN tasks t ON t.member_id = m.id
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      LEFT JOIN task_categories icat ON icat.id = t.category_id
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE m.shop_id = $1 AND m.active = true
      GROUP BY m.id, m.last_name, m.first_name, m.rank, m.role,
               m.must_change_password, m.last_login_at
      ORDER BY m.last_name
    `, [targetShopId]);
    // Every member can read their shop roster, but whether a peer has opened the
    // app is supervisor business — strip it for plain members rather than relying
    // on the UI not to render it.
    if (req.session.role === 'member') {
      for (const r of rows) { delete r.activated; delete r.last_login_at; }
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/shop/members/:id/tasks', requireAuth, requireRole('supervisor'), async (req, res) => {
  try {
    const memberId = parseInt(req.params.id);
    const { rows: mr } = await pool.query(
      'SELECT shop_id FROM members WHERE id = $1 AND active = true', [memberId]
    );
    if (!mr.length) return res.status(404).json({ error: 'Member not found' });
    // Leadership can view any shop's members (My Shop switcher); supervisors are
    // limited to their own shop.
    if (req.session.role !== 'leadership' && mr[0].shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { rows } = await pool.query(`
      SELECT t.id, t.title, t.details, t.urgency, t.is_upcoming, t.is_flagged,
             t.link_url, t.document_id, d.title AS document_title,
             cat.code  AS category_code,
             cat.label AS category_label,
             ${informationalSql('cat')} AS informational,
             COALESCE(tc.state, 'none') AS state,
             tc.note
      FROM tasks t
      JOIN task_categories cat ON cat.id = t.category_id
      LEFT JOIN documents d ON d.id = t.document_id AND d.active = true
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE t.member_id = $1
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      ORDER BY cat.sort_order, t.is_flagged DESC NULLS LAST, t.sort_order, t.id
    `, [memberId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Shop tasks by category (supervisor: own shop, leadership: any via switcher) ─
// The "category view" of My Shop: the same work the member list holds, re-cut
// as category → task → who's done it. Informational rows are excluded — this
// view exists to chase completable work. Members marked away by attendance are
// flagged so "not done" can be read fairly on the drill floor.
app.get('/api/shop/tasks', requireAuth, requireRole('supervisor'), async (req, res) => {
  try {
    const targetShopId = req.session.role === 'leadership' && req.query.shop_id
      ? parseInt(req.query.shop_id) : req.session.shopId;
    const { rows } = await pool.query(`
      SELECT t.id, t.title, t.details, t.urgency, t.is_flagged,
             cat.code  AS category_code,
             cat.label AS category_label,
             m.id AS member_id, m.rank, m.last_name, m.first_name,
             ${presentExpr()} AS present,
             COALESCE(tc.state, 'none') AS state,
             tc.note
      FROM tasks t
      JOIN task_categories cat ON cat.id = t.category_id
      JOIN members m ON m.id = t.member_id AND m.active = true AND m.shop_id = $1
      ${presenceJoinSql()}
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
        AND NOT ${informationalSql('cat')}
      ORDER BY cat.sort_order, t.title, m.last_name, m.first_name
    `, [targetShopId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── Attendance ──────────────────────────────────────────────────────────────
   Supervisors mark their own shop; leadership may target any shop via the
   ?shop_id / shop_id switcher, exactly as the shop task routes already do.
   Writes are confined to the LIVE cycle so archived history can't be quietly
   rewritten by a stray tap months later. */

// Resolve the shop a request may act on, or null if it isn't allowed to.
function attendanceShopId(req, requested) {
  if (req.session.role === 'leadership') {
    const asked = requested ? parseInt(requested, 10) : null;
    return Number.isInteger(asked) && asked > 0 ? asked : req.session.shopId;
  }
  // Supervisors are pinned to their own shop; an explicit mismatch is a 403.
  const asked = requested ? parseInt(requested, 10) : null;
  if (asked && asked !== req.session.shopId) return null;
  return req.session.shopId;
}

async function loadCurrentCycle() {
  const { rows } = await pool.query(
    `SELECT id, name, start_date, end_date, period_count, status
     FROM uta_cycles WHERE is_current = true LIMIT 1`);
  return rows[0] || null;
}

app.get('/api/shop/attendance', requireAuth, requireRole('supervisor'), async (req, res) => {
  try {
    const shopId = attendanceShopId(req, req.query.shop_id);
    if (!shopId) return res.status(403).json({ error: 'Forbidden' });
    const cycle = await loadCurrentCycle();
    if (!cycle) return res.status(404).json({ error: 'No current UTA cycle' });

    const { rows: shopRows } = await pool.query('SELECT name FROM shops WHERE id = $1', [shopId]);
    const { rows: members } = await pool.query(
      `SELECT id, last_name, first_name, rank FROM members
       WHERE shop_id = $1 AND active = true ORDER BY last_name, first_name`, [shopId]);
    const { rows } = await pool.query(
      `SELECT member_id, period, status, note, updated_at FROM attendance
       WHERE uta_cycle_id = $1 AND member_id = ANY($2::int[])`,
      [cycle.id, members.map(m => m.id)]);

    const periodCount = attendance.periodCountFor(cycle);
    const memberIds = members.map(m => m.id);
    res.json({
      cycle: { id: cycle.id, name: cycle.name, status: cycle.status, period_count: periodCount },
      shop_id: shopId,
      shop_name: shopRows[0]?.name || '',
      editable: cycle.status === 'live',
      periods: attendance.periodLabels(cycle.start_date, periodCount),
      members,
      rows,
      coverage: attendance.coverage(rows, memberIds, periodCount),
      first_incomplete: attendance.firstIncompletePeriod(rows, memberIds, periodCount),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/shop/attendance', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  try {
    const { member_id, period, status } = req.body;
    const note = (req.body.note || '').trim() || null;
    if (!attendance.isValidStatus(status)) return res.status(400).json({ error: 'Invalid status' });

    const cycle = await loadCurrentCycle();
    if (!cycle) return res.status(404).json({ error: 'No current UTA cycle' });
    if (cycle.status !== 'live') return res.status(403).json({ error: 'This cycle is not live' });
    if (!attendance.isValidPeriod(period, attendance.periodCountFor(cycle))) {
      return res.status(400).json({ error: 'Period is outside this drill' });
    }

    // Authorize against the MEMBER's shop, not a client-supplied one.
    const { rows: mr } = await pool.query(
      'SELECT shop_id FROM members WHERE id = $1 AND active = true', [member_id]);
    if (!mr.length) return res.status(404).json({ error: 'Member not found' });
    if (req.session.role !== 'leadership' && mr[0].shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { rows } = await pool.query(
      `INSERT INTO attendance (uta_cycle_id, member_id, shop_id, period, status, note, marked_by_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (uta_cycle_id, member_id, period) DO UPDATE
         SET status = EXCLUDED.status, note = EXCLUDED.note,
             marked_by_id = EXCLUDED.marked_by_id, updated_at = NOW()
       RETURNING member_id, period, status, note, updated_at`,
      [cycle.id, member_id, mr[0].shop_id, period, status, note, req.session.memberId]);
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Fill one period's UNMARKED members with 'present'. Never overwrites an
// exception already recorded — that's what ON CONFLICT DO NOTHING buys us.
app.post('/api/shop/attendance/present', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  try {
    const shopId = attendanceShopId(req, req.body.shop_id);
    if (!shopId) return res.status(403).json({ error: 'Forbidden' });
    const cycle = await loadCurrentCycle();
    if (!cycle) return res.status(404).json({ error: 'No current UTA cycle' });
    if (cycle.status !== 'live') return res.status(403).json({ error: 'This cycle is not live' });
    const period = Number(req.body.period);
    if (!attendance.isValidPeriod(period, attendance.periodCountFor(cycle))) {
      return res.status(400).json({ error: 'Period is outside this drill' });
    }
    const { rows } = await pool.query(
      `INSERT INTO attendance (uta_cycle_id, member_id, shop_id, period, status, marked_by_id, updated_at)
       SELECT $1, m.id, m.shop_id, $2, 'present', $3, NOW()
       FROM members m WHERE m.shop_id = $4 AND m.active = true
       ON CONFLICT (uta_cycle_id, member_id, period) DO NOTHING
       RETURNING member_id, period, status, note, updated_at`,
      [cycle.id, period, req.session.memberId, shopId]);
    res.json({ created: rows.length, rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Which shops still owe attendance for the live cycle.
app.get('/api/squadron/attendance', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const cycle = await loadCurrentCycle();
    if (!cycle) return res.status(404).json({ error: 'No current UTA cycle' });
    const periodCount = attendance.periodCountFor(cycle);
    const { rows } = await pool.query(
      `SELECT s.id, s.name,
              COUNT(DISTINCT m.id)::int AS member_count,
              COUNT(DISTINCT (a.member_id, a.period))
                FILTER (WHERE a.period <= $2)::int AS marked
       FROM shops s
       LEFT JOIN members m ON m.shop_id = s.id AND m.active = true
       LEFT JOIN attendance a ON a.member_id = m.id AND a.uta_cycle_id = $1
       GROUP BY s.id, s.name ORDER BY s.name`, [cycle.id, periodCount]);
    res.json({
      cycle: { id: cycle.id, name: cycle.name, period_count: periodCount },
      shops: rows.map(r => ({ ...r, total: r.member_count * periodCount }))
                 .sort((x, y) => (x.marked / (x.total || 1)) - (y.marked / (y.total || 1))),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// The full squadron-wide grid: every active member's per-period marks, grouped
// by shop. Read-only — marking still happens through the shop routes above.
// The drill roster workbook, in the exact shape the pay admin already works
// from — one sheet per shop, his attendance key, his dropdown, his wording.
// See lib/drill-roster.js for why the sheet names and typos are preserved.
app.get('/api/squadron/attendance/xlsx', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const cycle = await loadCurrentCycle();
    if (!cycle) return res.status(404).json({ error: 'No current UTA cycle' });

    const { rows: members } = await pool.query(
      `SELECT m.id, m.rank, m.first_name, m.last_name, m.position, s.name AS shop
       FROM members m LEFT JOIN shops s ON s.id = m.shop_id
       WHERE m.active = true
       ORDER BY s.name, m.last_name, m.first_name`);
    const { rows } = await pool.query(
      'SELECT member_id, period, status FROM attendance WHERE uta_cycle_id = $1', [cycle.id]);

    const buf = await drillRoster.buildDrillRoster(cycle, members, rows);
    const stamp = String(cycle.name || 'UTA').replace(/[^\w -]+/g, '').trim() || 'UTA';
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="CES Drill Roster ${stamp}.xlsx"`,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (err) {
    console.error('drill roster export failed:', err);
    res.status(500).json({ error: 'Could not build the drill roster' });
  }
});

app.get('/api/squadron/attendance/grid', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const cycle = await loadCurrentCycle();
    if (!cycle) return res.status(404).json({ error: 'No current UTA cycle' });
    const periodCount = attendance.periodCountFor(cycle);

    // LEFT JOIN keeps zero-member shops visible rather than silently complete.
    const { rows: roster } = await pool.query(
      `SELECT s.id AS shop_id, s.name AS shop_name,
              m.id, m.last_name, m.first_name, m.rank
       FROM shops s
       LEFT JOIN members m ON m.shop_id = s.id AND m.active = true
       ORDER BY s.name, m.last_name, m.first_name`);
    const { rows } = await pool.query(
      `SELECT member_id, period, status, note, updated_at FROM attendance
       WHERE uta_cycle_id = $1`, [cycle.id]);

    const shops = [];
    for (const r of roster) {
      let shop = shops[shops.length - 1];
      if (!shop || shop.id !== r.shop_id) {
        shop = { id: r.shop_id, name: r.shop_name, members: [] };
        shops.push(shop);
      }
      if (r.id != null) {
        shop.members.push({ id: r.id, last_name: r.last_name, first_name: r.first_name, rank: r.rank });
      }
    }

    res.json({
      cycle: { id: cycle.id, name: cycle.name, status: cycle.status, period_count: periodCount },
      periods: attendance.periodLabels(cycle.start_date, periodCount),
      shops,
      rows,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Squadron Timeline (all members) ──────────────────────────────────────────

app.get('/api/squadron/timeline', requireAuth, async (req, res) => {
  try {
    // to_char, not the bare DATE columns: node-postgres parses DATE to LOCAL
    // midnight, and `uta` is serialised straight to the client, where
    // renderTimeline does start_date.slice(0, 10). JSON.stringify runs a Date
    // through toISOString() (UTC), so in any zone ahead of UTC the client would
    // read the day BEFORE the drill. Dormant only because production has no TZ set.
    const { rows: utaRows } = await pool.query(
      `SELECT id, name, to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD') AS end_date
         FROM uta_cycles WHERE is_current = true LIMIT 1`
    );
    const uta = utaRows[0] || null;

    const { rows: events } = await pool.query(`
      SELECT id, day, start_time, end_time, title, details, kind,
             is_concurrent, emphasis, attendees, sort_order
      FROM squadron_events
      WHERE uta_cycle_id = $1
      ORDER BY
        CASE day WHEN 'Friday' THEN 1 WHEN 'Saturday' THEN 2 WHEN 'Sunday' THEN 3 ELSE 4 END,
        start_time NULLS LAST,
        is_concurrent ASC,
        sort_order
    `, [uta ? uta.id : null]);

    res.json({ uta, events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Squadron (leadership only) ────────────────────────────────────────────────

// Each count comes in an all-members and a present-members flavor (same rule
// everywhere: lib/presence.js). The client renders whichever the Present/All
// toggle selects; nothing is recomputed server-side on toggle.
app.get('/api/squadron', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.name AS shop,
             COUNT(DISTINCT m.id)                                                           AS member_count,
             COUNT(DISTINCT m.id) FILTER (WHERE ${presentExpr()})                           AS present_count,
             COUNT(t.id) FILTER (WHERE NOT ${informationalSql()})                                  AS total_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql()})            AS done_tasks,
             COUNT(t.id) FILTER (WHERE NOT ${informationalSql()} AND ${presentExpr()})              AS total_tasks_present,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql()} AND ${presentExpr()}) AS done_tasks_present,
             COUNT(t.id) FILTER (WHERE NOT ${informationalSql()} AND ${criticalSql()})              AS crit_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql()} AND ${criticalSql()}) AS crit_done,
             COUNT(t.id) FILTER (WHERE NOT ${informationalSql()} AND ${criticalSql()} AND ${presentExpr()})   AS crit_tasks_present,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql()} AND ${criticalSql()} AND ${presentExpr()}) AS crit_done_present
      FROM shops s
      LEFT JOIN members m ON m.shop_id = s.id AND m.active = true
      ${presenceJoinSql()}
      LEFT JOIN tasks t ON t.member_id = m.id
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      LEFT JOIN task_categories icat ON icat.id = t.category_id
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      GROUP BY s.id, s.name
      ORDER BY s.name
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/squadron/categories', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cat.code, cat.label,
             COUNT(t.id) FILTER (WHERE NOT ${informationalSql('cat')})                         AS total,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql('cat')})  AS done,
             COUNT(t.id) FILTER (WHERE NOT ${informationalSql('cat')} AND ${presentExpr()})    AS total_present,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql('cat')} AND ${presentExpr()}) AS done_present
      FROM task_categories cat
      JOIN tasks t ON t.category_id = cat.id
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      -- Inactive members leave every rollup. Without this filter a mid-cycle
      -- separation kept its tasks in these counts while the shops rollup and
      -- this card's own drill-in (both of which do filter) dropped them, so the
      -- header contradicted the detail beneath it.
      JOIN members m ON m.id = t.member_id AND m.active = true
      ${presenceJoinSql('att', 't.member_id')}
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      GROUP BY cat.code, cat.label, cat.sort_order
      -- Upgrade Training and Upcoming now total zero, so HAVING drops them from the
      -- breakdown entirely rather than showing a category stuck at 0%.
      HAVING COUNT(t.id) FILTER (WHERE NOT ${informationalSql('cat')}) > 0
      ORDER BY cat.sort_order
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Category drill-in (leadership only) ──────────────────────────────────────
// "63% on CBTs" begs the next question — which CBTs, and who exactly hasn't
// done them. One row per task title in the category, carrying done/total and
// the members still outstanding. Members marked away by attendance are flagged
// so a reader can tell "not done, not here" from "not done, no excuse".
app.get('/api/squadron/categories/:code/tasks', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.title,
             COUNT(t.id)                                    AS total,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done')  AS done,
             COALESCE(json_agg(
               json_build_object(
                 'id', m.id, 'rank', m.rank, 'last_name', m.last_name,
                 'first_name', m.first_name, 'shop', s.name,
                 'present', ${presentExpr()}
               ) ORDER BY m.last_name, m.first_name
             ) FILTER (WHERE tc.state IS DISTINCT FROM 'done'), '[]') AS not_done
      FROM tasks t
      JOIN task_categories cat ON cat.id = t.category_id AND cat.code = $1
      JOIN members m ON m.id = t.member_id AND m.active = true
      LEFT JOIN shops s ON s.id = m.shop_id
      ${presenceJoinSql()}
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
        AND NOT ${informationalSql('cat')}
      GROUP BY t.title
      ORDER BY (COUNT(t.id) - COUNT(tc.id) FILTER (WHERE tc.state = 'done')) DESC, t.title
    `, [req.params.code]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Medical services rollup (leadership only) ────────────────────────────────
// "How many of each service do we need, and how many are done?" — the Chief's
// question, which the category card cannot answer because it reports Medical /
// Fitness as one percentage across PT tests, blood draws, dental and assessments
// alike.
//
// The service is the task TITLE. `details` is deliberately not read: on production
// it holds instructions and appointment times, never a service name.
//
// Informational rows are excluded on the same rule as every other rollup, and
// lib/medical.js additionally drops duty qualifications and anything flagged for a
// later UTA — reporting the latter as `deferred` rather than swallowing it.
app.get('/api/squadron/medical', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.title, t.urgency, (tc.state = 'done') AS done
        FROM tasks t
        JOIN task_categories cat ON cat.id = t.category_id
        -- Same rule as every rollup: inactive members' tasks don't count.
        JOIN members m ON m.id = t.member_id AND m.active = true
        LEFT JOIN task_completions tc ON tc.task_id = t.id
       WHERE cat.code = 'medical'
         AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
         AND NOT ${informationalSql('cat')}
    `);
    res.json(medical.rollup(rows));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Student Flight (leadership only) ─────────────────────────────────────────
// The First Sergeant's centralized list of trainees awaiting BMT / Tech School.
// The flag lives on the member — they keep their shop, login and tasks — and
// the pipeline dates ride along on the same row. Managed entirely from the
// Squadron tab so any leader can maintain it without roster-admin rights;
// these fields are tracking data, not identity, so the lighter gate fits.

// Dates travel as 'YYYY-MM-DD' strings in both directions: to_char on the way
// out (a bare DATE would leave here as local-midnight and could shift a day in
// JSON), a shape check on the way in.
const STUDENT_DATE_FIELDS = ['bmt_start', 'bmt_grad', 'tech_start', 'tech_grad'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.get('/api/squadron/students', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const { rows: students } = await pool.query(`
      SELECT m.id, m.last_name, m.first_name, m.rank, s.name AS shop,
             to_char(m.bmt_start,  'YYYY-MM-DD') AS bmt_start,
             to_char(m.bmt_grad,   'YYYY-MM-DD') AS bmt_grad,
             to_char(m.tech_start, 'YYYY-MM-DD') AS tech_start,
             to_char(m.tech_grad,  'YYYY-MM-DD') AS tech_grad,
             m.student_notes
      FROM members m
      LEFT JOIN shops s ON s.id = m.shop_id
      WHERE m.active = true AND m.is_student_flight = true
      ORDER BY m.last_name, m.first_name
    `);
    // Everyone who could be added — feeds the "Add member" picker.
    const { rows: candidates } = await pool.query(`
      SELECT m.id, m.last_name, m.first_name, m.rank, s.name AS shop
      FROM members m
      LEFT JOIN shops s ON s.id = m.shop_id
      WHERE m.active = true AND m.is_student_flight = false
      ORDER BY m.last_name, m.first_name
    `);
    res.json({ students, candidates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// One route covers add (is_student_flight: true), edit (dates/notes) and
// remove (is_student_flight: false). Absent keys leave the column alone, so
// removing someone keeps their dates for the day they re-enter the pipeline.
app.patch('/api/squadron/students/:id', requireAuth, requireRole('leadership'), requireOnboarded, async (req, res) => {
  try {
    const memberId = reqId(req.params.id);
    if (!memberId) return res.status(400).json({ error: 'Invalid member id' });
    const body = req.body || {};

    const sets = [], vals = [];
    const bind = (v) => { vals.push(v); return `$${vals.length}`; };
    if ('is_student_flight' in body) sets.push(`is_student_flight = ${bind(body.is_student_flight === true)}`);
    for (const f of STUDENT_DATE_FIELDS) {
      if (!(f in body)) continue;
      const v = body[f];
      if (v != null && v !== '' && !ISO_DATE_RE.test(String(v))) {
        return res.status(400).json({ error: `${f} must be a YYYY-MM-DD date` });
      }
      sets.push(`${f} = ${bind(v ? String(v) : null)}::date`);
    }
    if ('student_notes' in body) sets.push(`student_notes = ${bind(trimOrNull(body.student_notes, 500))}`);
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    const { rowCount } = await pool.query(
      `UPDATE members SET ${sets.join(', ')} WHERE id = ${bind(memberId)} AND active = true`, vals);
    if (!rowCount) return res.status(404).json({ error: 'Member not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fetches 10 of each flavor: the "most behind" ranking changes when members
// marked away are excluded, so the present-only list is its own top-10 rather
// than a client-side filter that could leave 3 rows standing.
app.get('/api/squadron/members', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const presentOnly = req.query.present === 'true';
    const { rows } = await pool.query(`
      SELECT m.id, m.last_name, m.first_name, m.rank, s.name AS shop,
             ${presentExpr()} AS present,
             COUNT(t.id) FILTER (WHERE NOT ${informationalSql()})                         AS total_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql()})  AS done_tasks
      FROM members m
      JOIN shops s ON s.id = m.shop_id
      ${presenceJoinSql()}
      LEFT JOIN tasks t ON t.member_id = m.id
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      LEFT JOIN task_categories icat ON icat.id = t.category_id
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE m.active = true AND ($1::bool = false OR ${presentExpr()})
      GROUP BY m.id, m.last_name, m.first_name, m.rank, s.name, att.any_present
      HAVING COUNT(t.id) FILTER (WHERE NOT ${informationalSql()}) > 0
      ORDER BY
        (COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql()})::float
          / NULLIF(COUNT(t.id) FILTER (WHERE NOT ${informationalSql()}), 0)) ASC NULLS FIRST,
        (COUNT(t.id) FILTER (WHERE NOT ${informationalSql()})
          - COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql()})) DESC
      LIMIT 10
    `, [presentOnly]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/squadron/shops/:shopId/members', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.last_name, m.first_name, m.rank,
             ${presentExpr()} AS present,
             COUNT(t.id) FILTER (WHERE NOT ${informationalSql()})                         AS total_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT ${informationalSql()})  AS done_tasks
      FROM members m
      ${presenceJoinSql()}
      LEFT JOIN tasks t ON t.member_id = m.id
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      LEFT JOIN task_categories icat ON icat.id = t.category_id
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE m.active = true AND m.shop_id = $1
      GROUP BY m.id, m.last_name, m.first_name, m.rank, att.any_present
      ORDER BY m.last_name, m.first_name
    `, [req.params.shopId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Squadron org chart (visible to all authenticated members) ────────────────

const SHOP_TO_FLIGHT = {
  'WFSM': 'Infrastructure', 'HVAC': 'Infrastructure',
  'Electrical': 'Infrastructure', 'Power Pro': 'Infrastructure',
  'Structures': 'Construction', 'Heavy Equipment': 'Construction',
  'Operations': 'R&O', 'EA': 'R&O',
  'EM': 'EM', 'C2': 'Squadron Staff',
};

const FLIGHT_ORDER = ['Infrastructure', 'Construction', 'R&O', 'EM'];

// Legacy allowlist. Roster admins now get all-shop access from can_manage_roster
// below, which covers everyone here; kept so a leader who somehow loses the admin
// flag doesn't silently lose the switcher too.
const SQUADRON_WIDE_SLUGS = new Set(['gablin']);

// ── My Shop switcher: which shops a leader may view/manage ───────────────────
// Returns the leader's flight shops (+ their own shop). Squadron staff and
// roster admins get every shop. Drives the shop-switcher dropdown.
//
// Roster admins are included because they already see every member in the
// squadron on the Roster page — withholding the switcher hid a view they were
// entitled to rather than protecting anything.
app.get('/api/shop/overseen', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const { rows: meRows } = await pool.query(
      `SELECT m.flight, m.slug, m.shop_id, m.can_manage_roster, s.name AS shop_name
       FROM members m JOIN shops s ON s.id = m.shop_id
       WHERE m.id = $1`,
      [req.session.memberId]
    );
    if (!meRows.length) return res.status(401).json({ error: 'Session invalid' });
    const me = meRows[0];

    const allShops = !me.flight || me.flight === 'Squadron Staff'
      || me.can_manage_roster === true || SQUADRON_WIDE_SLUGS.has(me.slug);

    let shops;
    if (allShops) {
      ({ rows: shops } = await pool.query('SELECT id, name FROM shops ORDER BY name'));
    } else {
      const flightShopNames = Object.keys(SHOP_TO_FLIGHT).filter(n => SHOP_TO_FLIGHT[n] === me.flight);
      const names = Array.from(new Set([...flightShopNames, me.shop_name]));
      ({ rows: shops } = await pool.query(
        'SELECT id, name FROM shops WHERE name = ANY($1) ORDER BY name', [names]
      ));
    }

    res.json({ shops, ownShopId: me.shop_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/squadron/org-chart', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.rank, m.first_name, m.last_name, m.role,
             m.shop_id, s.name AS shop_name, m.flight, m.position
      FROM members m
      LEFT JOIN shops s ON s.id = m.shop_id
      WHERE m.active = true
      ORDER BY m.last_name, m.first_name
    `);

    const staff = [];
    const flightMap = new Map();
    for (const f of FLIGHT_ORDER) {
      flightMap.set(f, { name: f, leaders: [], shops: new Map() });
    }

    for (const r of rows) {
      const person = {
        id: r.id, rank: r.rank, first_name: r.first_name,
        last_name: r.last_name, position: r.position || null,
        shop: r.shop_name,
      };

      const memberFlight = r.flight || SHOP_TO_FLIGHT[r.shop_name] || 'Squadron Staff';

      // Squadron Staff goes to the top banner
      if (memberFlight === 'Squadron Staff') {
        if (r.role === 'leadership') staff.push(person);
        // Non-leadership C2 members don't show on org chart (no shop card for C2)
        continue;
      }

      const flight = flightMap.get(memberFlight);
      if (!flight) continue;

      // Flight-level leaders (superintendent, OIC, UTM) — have flight set explicitly + leadership role
      if (r.flight && r.role === 'leadership' && !['NCOIC', 'SNCOIC'].includes(r.position)) {
        flight.leaders.push(person);
        continue;
      }

      // Shop-level: NCOIC/SNCOIC (leadership with position), supervisors, members
      const shopName = r.shop_name;
      if (!shopName || shopName === 'C2') continue;

      if (!flight.shops.has(shopName)) {
        flight.shops.set(shopName, { name: shopName, ncoic: null, supervisors: [], members: [] });
      }
      const shop = flight.shops.get(shopName);

      if (r.role === 'leadership' && (r.position === 'NCOIC' || r.position === 'SNCOIC')) {
        shop.ncoic = person;
      } else if (r.role === 'supervisor') {
        shop.supervisors.push(person);
      } else {
        shop.members.push(person);
      }
    }

    // Sort staff: Commander first, then Chief, then First Sergeant, then rest
    const posOrder = { 'Commander': 0, 'Chief Enlisted Manager': 1, 'First Sergeant': 2, 'BCE/Engineering OIC': 3 };
    staff.sort((a, b) => (posOrder[a.position] ?? 99) - (posOrder[b.position] ?? 99));

    const flights = FLIGHT_ORDER.map(name => {
      const f = flightMap.get(name);
      return { name: f.name, leaders: f.leaders, shops: Array.from(f.shops.values()) };
    });

    res.json({ staff, flights });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Notifications API ───────────────────────────────────────────────────────

// Recent notifications for the signed-in member, plus the unread count.
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, type, title, body, link, read_at, created_at
      FROM notifications
      WHERE member_id = $1
      ORDER BY (read_at IS NULL) DESC, created_at DESC
      LIMIT 30
    `, [req.session.memberId]);
    const { rows: [c] } = await pool.query(
      'SELECT COUNT(*)::int AS unread FROM notifications WHERE member_id = $1 AND read_at IS NULL',
      [req.session.memberId]
    );
    res.json({ notifications: rows, unread: c.unread });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark a single notification read ({ id }) or all of them ({ all: true }).
app.post('/api/notifications/read', requireAuth, async (req, res) => {
  try {
    const { id, all } = req.body;
    if (all) {
      await pool.query(
        'UPDATE notifications SET read_at = NOW() WHERE member_id = $1 AND read_at IS NULL',
        [req.session.memberId]
      );
    } else if (id) {
      await pool.query(
        'UPDATE notifications SET read_at = NOW() WHERE id = $1 AND member_id = $2',
        [id, req.session.memberId]
      );
    } else {
      return res.status(400).json({ error: 'id or all is required' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Web Push ────────────────────────────────────────────────────────────────
// One row per browser+device. The client posts PushSubscription.toJSON(), which
// is {endpoint, keys:{p256dh, auth}}. Delivery itself is a flush job, not a
// direct send — see lib/push.js for why.

// The client needs the public key to call pushManager.subscribe(). Returning
// null rather than 404 when unset lets the UI hide the toggle cleanly instead
// of treating a deliberate no-op as an error.
app.get('/api/push/vapid-key', requireAuth, (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    const p256dh = keys && keys.p256dh, auth = keys && keys.auth;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')
        || typeof p256dh !== 'string' || typeof auth !== 'string') {
      return res.status(400).json({ error: 'A push subscription is required' });
    }
    // Re-subscribing is routine: browsers rotate endpoints, and the same device
    // re-registers on every load where permission is already granted. Upsert on
    // endpoint so that is idempotent, and reassign member_id so a shared phone
    // moves the subscription to whoever is signed in rather than notifying the
    // previous member.
    await pool.query(`
      INSERT INTO push_subscriptions (member_id, endpoint, p256dh, auth, user_agent)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (endpoint) DO UPDATE
        SET member_id = EXCLUDED.member_id, p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent
    `, [req.session.memberId, endpoint, p256dh, auth, (req.get('user-agent') || '').slice(0, 300)]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint is required' });
    // Scoped to the caller so one member cannot unsubscribe another's device.
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND member_id = $2',
      [endpoint, req.session.memberId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Roster management (capability-gated: members.can_manage_roster) ──────────
function rosterFail(res, e) {
  if (e instanceof roster.RosterError) {
    return res.status(e.status).json({ error: e.code, message: e.message });
  }
  console.error(e);
  res.status(500).json({ error: 'Server error' });
}

// Shared by `grant` below and `active` in the update route just below that:
// both setRosterAdmin and updateMember (lib/roster.js) are safe once they
// receive a real boolean, but this is the HTTP boundary, and JSON/query values
// arrive as whatever the caller sent. The *string* "false" is truthy in JS, so
// a bare `!!req.body.grant` (or `!!req.body.active`) would silently flip a
// revoke or deactivate request into its opposite. Accept real booleans and the
// strings "true"/"false"; reject anything else with 400 instead of guessing.
function parseStrictBool(v) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
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
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid member id' });
  // The HTTP boundary stays lenient on purpose: JSON can carry the *strings*
  // "true"/"false" (naive clients), which parseStrictBool accepts and
  // converts to real booleans before lib/roster.js ever sees them — that
  // library now rejects any non-boolean `active` outright rather than
  // coercing it. `active` is optional (undefined means "don't touch it"), so
  // only validate when present.
  const body = { ...req.body };
  if (body.active !== undefined) {
    const active = parseStrictBool(body.active);
    if (active === undefined) {
      return res.status(400).json({ error: 'BAD_ACTIVE', message: 'active must be true or false' });
    }
    body.active = active;
  }
  try { res.json(await roster.updateMember(pool, id, body, req.session.memberId)); }
  catch (e) { rosterFail(res, e); }
});

app.delete('/api/roster/members/:id', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid member id' });
  try { res.json(await roster.deleteMember(pool, id)); }
  catch (e) { rosterFail(res, e); }
});

app.patch('/api/roster/members/:id/admin', requireAuth, requireRosterAdmin, requireOnboarded, async (req, res) => {
  const id = reqId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid member id' });
  const grant = parseStrictBool(req.body.grant);
  if (grant === undefined) {
    return res.status(400).json({ error: 'BAD_GRANT', message: 'grant must be true or false' });
  }
  try {
    res.json(await roster.setRosterAdmin(pool, id, grant, req.session.memberId));
  } catch (e) { rosterFail(res, e); }
});

// ── Export: printable shop handouts ──────────────────────────────────────────
// One payload for the whole squadron: the live cycle, every shop's schedule
// items / work orders / emphasis items, and every member's task list. The
// /export page renders it as a single print document, one shop per page, so
// the training NCO can hand each shop lead their pages. Squadron-wide timeline
// events ship once at the top level; the page merges them into each shop's
// per-day schedule (a formation belongs on every handout).

// Seniority for the handout's high-to-low member ordering. Nothing else in the
// app sorts by rank, so this map lives here with its only consumer. Unknown
// ranks sort last rather than throwing — a data typo shouldn't break printing.
const RANK_SENIORITY = {
  'AB': 1, 'Amn': 2, 'A1C': 3, 'SrA': 4, 'SSgt': 5, 'TSgt': 6,
  'MSgt': 7, 'SMSgt': 8, 'CMSgt': 9,
  'Lt Select': 10, '2d Lt': 11, '1st Lt': 12, 'Capt': 13,
  'Maj': 14, 'Lt Col': 15, 'Col': 16,
};

app.get('/api/export/shop-lists', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    // to_char for the same reason as /api/squadron/timeline above: `cycle` ships
    // to the client whole, and public/export.html reads the dates with
    // String(d).slice(0, 10) to build the handout's day names and date range. A
    // bare DATE would arrive as a UTC-serialised local midnight and print the
    // previous day in any zone ahead of UTC.
    const { rows: [cycle] } = await pool.query(
      `SELECT id, name, to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD') AS end_date
         FROM uta_cycles WHERE is_current = true LIMIT 1`);
    if (!cycle) return res.status(404).json({ error: 'No live cycle' });

    const [shopsQ, sqEventsQ, shopEventsQ, membersQ, tasksQ] = await Promise.all([
      pool.query(`SELECT id, name FROM shops ORDER BY name`),
      pool.query(
        `SELECT day, start_time, end_time, title, details
         FROM squadron_events WHERE uta_cycle_id = $1
         ORDER BY sort_order, id`, [cycle.id]),
      pool.query(
        `SELECT shop_id, event_type, day, start_time, end_time, title, details,
                wo_number, status
         FROM shop_events WHERE uta_cycle_id = $1
         ORDER BY sort_order, id`, [cycle.id]),
      pool.query(
        `SELECT id, shop_id, rank, first_name, last_name
         FROM members WHERE active = true`),
      // Same ordering as the member task view, so a handout reads like the
      // app: category blocks in category order, flagged items first within.
      pool.query(`
        SELECT t.member_id, t.title, t.details, t.urgency, t.is_upcoming,
               t.appt_day, t.appt_time, t.appt_location,
               cat.label AS category_label,
               COALESCE(tc.state, 'none') AS state
        FROM tasks t
        JOIN task_categories cat ON cat.id = t.category_id
        LEFT JOIN task_completions tc ON tc.task_id = t.id
        WHERE t.uta_cycle_id = $1
        ORDER BY cat.sort_order, t.is_flagged DESC NULLS LAST, t.sort_order, t.id
      `, [cycle.id]),
    ]);

    const tasksByMember = new Map();
    for (const t of tasksQ.rows) {
      const { member_id, ...task } = t;
      if (!tasksByMember.has(member_id)) tasksByMember.set(member_id, []);
      tasksByMember.get(member_id).push(task);
    }

    const membersByShop = new Map();
    for (const m of membersQ.rows) {
      if (!membersByShop.has(m.shop_id)) membersByShop.set(m.shop_id, []);
      membersByShop.get(m.shop_id).push({
        rank: m.rank, first_name: m.first_name, last_name: m.last_name,
        tasks: tasksByMember.get(m.id) || [],
      });
    }
    for (const list of membersByShop.values()) {
      list.sort((a, b) =>
        ((RANK_SENIORITY[b.rank] ?? 0) - (RANK_SENIORITY[a.rank] ?? 0))
        || a.last_name.localeCompare(b.last_name));
    }

    const shops = shopsQ.rows.map(s => {
      const evs = shopEventsQ.rows.filter(e => e.shop_id === s.id);
      const strip = ({ shop_id, event_type, ...rest }) => rest;
      return {
        id: s.id, name: s.name,
        schedule:    evs.filter(e => e.event_type === 'schedule').map(strip),
        work_orders: evs.filter(e => e.event_type === 'work_order').map(strip),
        emphasis:    evs.filter(e => e.event_type === 'emphasis').map(strip),
        members: membersByShop.get(s.id) || [],
      };
    });

    res.json({ cycle, squadron_events: sqEventsQ.rows, shops });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Static ────────────────────────────────────────────────────────────────────

// ── Service worker ──────────────────────────────────────────────────────────
// Served from a route rather than public/, for three reasons:
//   · SW_MODE=kill swaps in the self-destruct worker from a Railway variable,
//     with no code change and no deploy of new source — the only way to retire a
//     worker already living on members' phones.
//   · The cache name can carry the commit SHA without a build step, so every
//     deploy is a byte-different worker and clients update on next open.
//   · no-store is guaranteed. Browsers already bypass the HTTP cache for the
//     worker script, but losing remote control of this file is not a risk worth
//     taking for nothing.
// MUST precede express.static, or a file of the same name would win.
const SW_SRC  = fs.readFileSync(path.join(__dirname, 'lib', 'sw', 'sw.js'), 'utf8');
const SW_KILL = fs.readFileSync(path.join(__dirname, 'lib', 'sw', 'sw-kill.js'), 'utf8');
const SW_VERSION = process.env.RAILWAY_GIT_COMMIT_SHA || String(Date.now());
app.get('/sw.js', (req, res) => {
  const body = process.env.SW_MODE === 'kill' ? SW_KILL : SW_SRC;
  res.set({
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.send(`const VERSION = ${JSON.stringify(SW_VERSION)};
${body}`);
});

app.use(express.static(path.join(__dirname, 'public')));

// Standalone task-builder prototype for review (public, no auth) — clean URL
// without the .html so it's easy to share. Must sit before the SPA catch-all,
// or '*' would serve index.html instead.
app.get('/task-builder-mockup', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'task-builder-mockup.html'))
);

// Leadership task-builder page shell. Gated to logged-in members; the APIs it
// calls enforce requireRole('leadership') so a non-leader just sees 403s/empty
// state. Must sit before the SPA catch-all, or '*' would serve index.html.
function requireLeadershipPage(req, res, next) {
  if (!req.session.memberId) return res.redirect('/');
  next();
}
app.get('/build', requireLeadershipPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'build.html'))
);

// Records page shell (leadership + supervisor member browser / history review).
// Gated the same way as /build; must sit before the SPA catch-all.
app.get('/records', requireLeadershipPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'records.html'))
);

// Spec §9.1: /roster redirects unless the session holds can_manage_roster —
// including when there is no session at all, same as /build and /records
// (requireLeadershipPage redirects rather than 401-JSON-ing a logged-out or
// expired-session browser landing here from a stale bookmark). Unlike /build
// and /records, the shell itself is ALSO gated on the capability: this page
// lists every member including inactive ones, so there is no reason to serve
// the frame to a logged-in member who cannot use it either. Must sit before
// the SPA catch-all.
app.get('/roster', requireLeadershipPage, (req, res) => {
  if (!req.session.canManageRoster) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'roster.html'));
});

// Printable shop handouts. Gated like /build; the API it calls enforces
// requireRole('leadership'), so a non-leader who lands here sees the 403
// message rather than data. Must sit before the SPA catch-all.
app.get('/export', requireLeadershipPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'export.html'))
);

// The full UTA newsletter, built from the live cycle. Renders every shop — what
// lands on the page is whatever has been entered for the cycle, so a thin section
// means thin data rather than a broken generator.
//
// ?uta=<id> renders a specific cycle (a draft being prepared, or a past one for
// the record); with no parameter it uses whichever cycle is currently live.
//
// NOT gated by requireLeadershipPage alone. That helper only proves *someone* is
// signed in — /build and /export get their real protection from the leadership-only
// APIs their shells call afterwards. This route renders the data itself, server
// side, and the page carries every member's medical requirements, EPB status and
// overdue CBTs. Without the role check below, any signed-in member could read the
// whole squadron's record by typing the URL.
app.get('/newsletter', async (req, res) => {
  // Page semantics: send a signed-out visitor to the login screen, but answer a
  // signed-in non-leader in plain words rather than a JSON blob in a blank tab.
  if (!req.session.memberId) return res.redirect('/');
  if (req.session.role !== 'leadership') {
    return res.status(403).type('html').send(
      '<p style="font:15px system-ui;padding:40px;max-width:34em">The newsletter covers the whole '
      + 'squadron, so it is limited to squadron leadership. Your own tasks are on the tracker '
      + '&mdash; <a href="/">go back</a>.</p>');
  }
  try {
    const utaId = req.query.uta ? reqId(req.query.uta) : null;
    if (req.query.uta && !utaId) return res.status(400).send('Invalid uta id');

    const { buildFromDb } = require('./newsletter/from-db');
    const { renderNewsletter } = require('./newsletter/render');
    const data = await buildFromDb(pool, utaId);
    res.type('html').send(renderNewsletter(data));
  } catch (err) {
    console.error('newsletter render failed:', err);
    res.status(500).send('Could not build the newsletter. Check the server log.');
  }
});

// Unknown /api/* paths must fail as JSON. Without this they fall through to the
// SPA catch-all below and return index.html with a 200, so the caller's .json()
// throws an opaque SyntaxError instead of surfacing a real status. Sits after
// every real API route, so only genuinely unmatched paths reach it.
app.all('/api/*', (req, res) =>
  res.status(404).json({ error: 'Not found' })
);

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// Body-parser rejections (an over-size document upload, malformed JSON) are
// thrown, not returned, so without this they reach Express's default handler and
// come back as an HTML error page — which a fetch().json() caller reports as a
// SyntaxError instead of "that file is too large".
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'That file is too large. The limit is 10 MB.' });
  }
  if (err && err.status === 400 && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// Exported so tests can drive the app in-process with fetch() against an
// ephemeral port (app.listen(0, ...)), rather than re-deriving every route's
// auth/authz behaviour by reading the middleware instead of exercising it.
// Guarded below so merely requiring this module never binds PORT or starts
// the cron schedules — both are startup side effects that belong only to the
// actual running server, not to anything that requires server.js as a library.
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

  // ── Scheduled jobs (in-process) ───────────────────────────────────────────
  // Completion digests + email flushing run on a timer inside the web process.
  // Disable with ENABLE_CRON=false (e.g. for local/dev or one-off scripts).
  if (process.env.ENABLE_CRON !== 'false') {
    const cron = require('node-cron');
    const { runDigests } = require('./notify-digests');
    const { flushEmails } = require('./notify-emails');

    // Completion digest once a day at 21:00 (end of a typical drill day).
    cron.schedule('0 21 * * *', () => {
      runDigests({ pool }).catch(e => console.error('digest job failed:', e.message));
    });

    // Flush pending notification emails every 5 minutes.
    cron.schedule('*/5 * * * *', () => {
      flushEmails({ pool }).catch(e => console.error('email job failed:', e.message));
    });

    // Push catch-up every minute. notify() already kicks a flush inline, so this
    // exists for the rows it does not write — notify-digests.js inserts directly
    // — and for any send that failed transiently. A no-op when VAPID is unset.
    const { flushPush } = require('./lib/push');
    cron.schedule('* * * * *', () => {
      flushPush({ pool }).catch(e => console.error('push job failed:', e.message));
    });

    console.log('Scheduled jobs registered (digests 21:00 daily, email flush every 5m)');
  }
}
