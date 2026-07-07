const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const crypto = require('crypto');
const { assertTaskInLiveCycle } = require('./lib/tasks');
const cycles = require('./lib/cycles');
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
      DO $$ BEGIN
        ALTER TABLE tasks ADD CONSTRAINT tasks_cycle_member_cat_title_uniq
          UNIQUE (uta_cycle_id, member_id, category_id, title);
      EXCEPTION WHEN others THEN NULL;
      END $$;
    `);
    console.log('Migration check complete');
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

// Blocks every state-changing endpoint until a defaulted account sets its own
// password. Session flag is set from members.must_change_password at login and
// cleared by POST /api/auth/password. Read-only endpoints are intentionally
// exempt so a not-yet-onboarded member can still see their tasks.
function requireOnboarded(req, res, next) {
  if (req.session.mustChange) return res.status(403).json({ error: 'You must change your password before continuing' });
  next();
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

    req.session.memberId = member.id;
    req.session.role     = member.role;
    req.session.shopId   = member.shop_id;
    req.session.shopName = member.shop_name;
    req.session.mustChange = member.must_change_password;

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
    res.json(rows[0]);
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

app.delete('/api/tasks/:id', requireAuth, requireRole('supervisor'), requireOnboarded, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);

    // Check task exists and caller has permission
    const { rows: tr } = await pool.query(`
      SELECT t.member_id, m.shop_id FROM tasks t
      JOIN members m ON m.id = t.member_id
      WHERE t.id = $1
    `, [taskId]);
    if (!tr.length) return res.status(404).json({ error: 'Task not found' });
    if (req.session.role === 'supervisor' && tr[0].shop_id !== req.session.shopId) {
      return res.status(403).json({ error: 'Cannot delete tasks outside your shop' });
    }

    await pool.query('DELETE FROM task_completions WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
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
    res.json(await cycles.createDraft(pool, name));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

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
             COUNT(t.id) FILTER (WHERE NOT t.is_upcoming)                    AS total_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'done' AND NOT t.is_upcoming)   AS done_tasks,
             COUNT(tc.id) FILTER (WHERE tc.state = 'partial' AND NOT t.is_upcoming) AS partial_tasks
      FROM members m
      LEFT JOIN tasks t ON t.member_id = m.id
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE m.shop_id = $1 AND m.active = true
      GROUP BY m.id, m.last_name, m.first_name, m.rank, m.role
      ORDER BY m.last_name
    `, [targetShopId]);
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

// ── Static ────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// Standalone task-builder prototype for review (public, no auth) — clean URL
// without the .html so it's easy to share. Must sit before the SPA catch-all,
// or '*' would serve index.html instead.
app.get('/task-builder-mockup', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'task-builder-mockup.html'))
);

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ── Scheduled jobs (in-process) ─────────────────────────────────────────────
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
