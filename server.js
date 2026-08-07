const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const crypto = require('crypto');
const { assertTaskInLiveCycle, listGroups, addTaskBatch, copyForward } = require('./lib/tasks');
const tasksLib = require('./lib/tasks');
const cycles = require('./lib/cycles');
const attendance = require('./lib/attendance');
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

app.use(express.json());

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  },
}));

// ── Auto-migration (runs once on startup) ──────────────────────────────────
(async () => {
  try {
    await pool.query(`
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
        status        VARCHAR(12) NOT NULL CHECK (status IN
                        ('present','excused','unexcused','ruta','at','deployed')),
        note          TEXT,
        marked_by_id  INTEGER REFERENCES members(id),
        updated_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE (uta_cycle_id, member_id, period)
      );
      CREATE INDEX IF NOT EXISTS idx_attendance_cycle_shop ON attendance (uta_cycle_id, shop_id);
      ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS event_group_id INTEGER;
      ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS kind VARCHAR(20);
      CREATE INDEX IF NOT EXISTS idx_shop_events_group ON shop_events (event_group_id);
    `);
    console.log('Migration check complete');

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
  } catch (e) {
    console.error('Migration warning:', e.message);
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

// Blocks every state-changing endpoint until a defaulted account sets its own
// password. Session flag is set from members.must_change_password at login and
// cleared by POST /api/auth/password. Read-only endpoints are intentionally
// exempt so a not-yet-onboarded member can still see their tasks.
function requireOnboarded(req, res, next) {
  if (req.session.mustChange) return res.status(403).json({ error: 'You must change your password before continuing' });
  next();
}

// Parse a route :id param to a positive integer, or null if malformed.
function reqId(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }

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
      `SELECT m.*, s.name AS shop_name,
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
      `SELECT m.id, m.first_name, m.last_name, m.rank, m.role, m.slug, m.must_change_password, s.name AS shop,
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
             cat.code  AS category_code,
             cat.label AS category_label,
             COALESCE(tc.state, 'none') AS state,
             tc.note
      FROM tasks t
      JOIN task_categories cat ON cat.id = t.category_id
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
      SELECT t.member_id, m.shop_id FROM tasks t
      JOIN members m ON m.id = t.member_id
      WHERE t.id = $1
    `, [taskId]);
    if (!tr.length) return res.status(404).json({ error: 'Task not found' });

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

    const { rows: [task] } = await pool.query(`
      INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency,
                         appt_day, appt_time, appt_location, is_upcoming, created_by_id, sort_order)
      VALUES ((SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1),
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 99)
      RETURNING *
    `, [member_id, catRows[0].id, title, details || null, urgency || 'this_uta',
        appt_day || null, appt_time || null, appt_location || null,
        is_upcoming || false, req.session.memberId]);

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

    // Insert one task per active recipient in a single statement.
    // shopId NULL ⇒ every active member (whole squadron).
    const { rows } = await pool.query(`
      INSERT INTO tasks (uta_cycle_id, member_id, category_id, title, details, urgency,
                         appt_day, appt_time, appt_location, is_upcoming, created_by_id, sort_order)
      SELECT (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1),
             m.id, $1, $2, $3, $4, $5, $6, $7, false, $8, 99
      FROM members m
      WHERE m.active = true AND ($9::int IS NULL OR m.shop_id = $9)
      RETURNING member_id
    `, [catRows[0].id, title, details || null, urgency || 'this_uta',
        appt_day || null, appt_time || null, appt_location || null,
        req.session.memberId, shopId]);

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
    const r = await addTaskBatch(pool, id, {
      title, category_code, details, assignments, created_by_id: req.session.memberId,
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

  const fields = pickFields(req.body, ['urgency', 'details']);
  if ('urgency' in fields && !VALID_URGENCY.includes(fields.urgency)) {
    return res.status(400).json({ error: `urgency must be one of: ${VALID_URGENCY.join(', ')}` });
  }
  try {
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

  const fields = pickFields(req.body, ['urgency', 'details', 'appt_day', 'appt_time', 'appt_location']);
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

// ── Create Shop Event (supervisor: own shop, leadership: any) ────────────────

app.post('/api/shop/events', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  try {
    const { event_type, day, start_time, end_time, title, details, wo_number, shop_id } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!event_type || !['schedule','work_order','emphasis'].includes(event_type)) {
      return res.status(400).json({ error: 'event_type must be schedule, work_order, or emphasis' });
    }

    const targetShopId = req.session.role === 'leadership' && shop_id ? shop_id : req.session.shopId;
    if (req.session.role === 'supervisor' && shop_id && shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Cannot add events to other shops' });
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

// ── Delete Shop Event (supervisor: own shop, leadership: any) ────────────────

app.delete('/api/shop/events/:id', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id);
    const { rows: er } = await pool.query('SELECT shop_id FROM shop_events WHERE id = $1', [eventId]);
    if (!er.length) return res.status(404).json({ error: 'Event not found' });
    if (req.session.role === 'supervisor' && er[0].shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Cannot delete events from other shops' });
    }

    await pool.query('DELETE FROM shop_events WHERE id = $1', [eventId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Edit Shop Event (supervisor: own shop, leadership: any) ──────────────────
// Status is intentionally not editable here — it changes only via the status
// endpoint so the history log stays authoritative.

app.put('/api/shop/events/:id', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id);
    const { event_type, day, start_time, end_time, title, details, wo_number } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!event_type || !['schedule','work_order','emphasis'].includes(event_type)) {
      return res.status(400).json({ error: 'event_type must be schedule, work_order, or emphasis' });
    }

    const { rows: er } = await pool.query('SELECT shop_id FROM shop_events WHERE id = $1', [eventId]);
    if (!er.length) return res.status(404).json({ error: 'Event not found' });
    if (req.session.role === 'supervisor' && er[0].shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Cannot edit events from other shops' });
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

    const { rows: er } = await pool.query('SELECT shop_id FROM shop_events WHERE id = $1', [eventId]);
    if (!er.length) return res.status(404).json({ error: 'Event not found' });
    // Members and supervisors may only touch their own shop; leadership any shop.
    if (req.session.role !== 'leadership' && er[0].shop_id !== req.session.shopId) {
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
    const { rows: er } = await pool.query('SELECT shop_id FROM shop_events WHERE id = $1', [eventId]);
    if (!er.length) return res.status(404).json({ error: 'Event not found' });
    if (req.session.role !== 'leadership' && er[0].shop_id !== req.session.shopId) {
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
             COUNT(t.id) FILTER (WHERE NOT t.is_upcoming)                    AS total_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT t.is_upcoming)   AS done_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'partial' AND NOT t.is_upcoming) AS partial_tasks
      FROM members m
      LEFT JOIN tasks t ON t.member_id = m.id
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
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
             cat.code  AS category_code,
             cat.label AS category_label,
             COALESCE(tc.state, 'none') AS state,
             tc.note
      FROM tasks t
      JOIN task_categories cat ON cat.id = t.category_id
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
    const { rows: utaRows } = await pool.query(
      `SELECT id, name, start_date, end_date FROM uta_cycles WHERE is_current = true LIMIT 1`
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

app.get('/api/squadron', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.name AS shop,
             COUNT(DISTINCT m.id)                                                           AS member_count,
             COUNT(t.id) FILTER (WHERE NOT t.is_upcoming)                                  AS total_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT t.is_upcoming)            AS done_tasks
      FROM shops s
      LEFT JOIN members m ON m.shop_id = s.id AND m.active = true
      LEFT JOIN tasks t ON t.member_id = m.id
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
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
             COUNT(t.id) FILTER (WHERE NOT t.is_upcoming)                         AS total,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT t.is_upcoming)  AS done
      FROM task_categories cat
      JOIN tasks t ON t.category_id = cat.id
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      GROUP BY cat.code, cat.label, cat.sort_order
      HAVING COUNT(t.id) FILTER (WHERE NOT t.is_upcoming) > 0
      ORDER BY cat.sort_order
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/squadron/members', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.last_name, m.first_name, m.rank, s.name AS shop,
             COUNT(t.id) FILTER (WHERE NOT t.is_upcoming)                         AS total_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT t.is_upcoming)  AS done_tasks
      FROM members m
      JOIN shops s ON s.id = m.shop_id
      LEFT JOIN tasks t ON t.member_id = m.id
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE m.active = true
      GROUP BY m.id, m.last_name, m.first_name, m.rank, s.name
      HAVING COUNT(t.id) FILTER (WHERE NOT t.is_upcoming) > 0
      ORDER BY
        (COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT t.is_upcoming)::float
          / NULLIF(COUNT(t.id) FILTER (WHERE NOT t.is_upcoming), 0)) ASC NULLS FIRST,
        (COUNT(t.id) FILTER (WHERE NOT t.is_upcoming)
          - COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT t.is_upcoming)) DESC
      LIMIT 10
    `);
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
             COUNT(t.id) FILTER (WHERE NOT t.is_upcoming)                         AS total_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT t.is_upcoming)  AS done_tasks
      FROM members m
      LEFT JOIN tasks t ON t.member_id = m.id
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE m.active = true AND m.shop_id = $1
      GROUP BY m.id, m.last_name, m.first_name, m.rank
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

// Leaders granted all-shop access regardless of flight (same reach as squadron staff).
const SQUADRON_WIDE_SLUGS = new Set(['gablin']);

// ── My Shop switcher: which shops a leader may view/manage ───────────────────
// Returns the leader's flight shops (+ their own shop). Squadron staff and
// allowlisted leaders get every shop. Drives the shop-switcher dropdown.
app.get('/api/shop/overseen', requireAuth, requireRole('leadership'), async (req, res) => {
  try {
    const { rows: meRows } = await pool.query(
      `SELECT m.flight, m.slug, m.shop_id, s.name AS shop_name
       FROM members m JOIN shops s ON s.id = m.shop_id
       WHERE m.id = $1`,
      [req.session.memberId]
    );
    if (!meRows.length) return res.status(401).json({ error: 'Session invalid' });
    const me = meRows[0];

    const allShops = !me.flight || me.flight === 'Squadron Staff' || SQUADRON_WIDE_SLUGS.has(me.slug);

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
    const { rows: [cycle] } = await pool.query(
      `SELECT id, name, start_date, end_date FROM uta_cycles WHERE is_current = true LIMIT 1`);
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

    console.log('Scheduled jobs registered (digests 21:00 daily, email flush every 5m)');
  }
}
