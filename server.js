const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
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
      ALTER TABLE members ADD COLUMN IF NOT EXISTS flight VARCHAR(30);
      ALTER TABLE members ADD COLUMN IF NOT EXISTS position VARCHAR(50);
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

// ── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const { slug, password } = req.body;
    if (!slug || !password) return res.status(400).json({ error: 'Missing credentials' });

    const { rows } = await pool.query(
      `SELECT m.*, s.name AS shop_name
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

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.first_name, m.last_name, m.rank, m.role, m.slug, s.name AS shop
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

app.put('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const { state, note } = req.body;

    const { rows: tr } = await pool.query(
      'SELECT member_id FROM tasks WHERE id = $1', [taskId]
    );
    if (!tr.length) return res.status(404).json({ error: 'Task not found' });

    const isSupervisorPlus = ['supervisor', 'leadership'].includes(req.session.role);
    if (tr[0].member_id !== req.session.memberId && !isSupervisorPlus) {
      return res.status(403).json({ error: 'Forbidden' });
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

app.post('/api/tasks', requireAuth, requireRole('supervisor'), async (req, res) => {
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

    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Delete Task (supervisor: own shop, leadership: any) ─────────────────────

app.delete('/api/tasks/:id', requireAuth, requireRole('supervisor'), async (req, res) => {
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

app.put('/api/tasks/:id/flag', requireAuth, requireRole('supervisor'), async (req, res) => {
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

// ── My Shop ───────────────────────────────────────────────────────────────────

app.get('/api/shop/events', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, event_type, day, start_time, end_time, title, details, wo_number, sort_order FROM shop_events
      WHERE shop_id = $1
        AND uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      ORDER BY sort_order
    `, [req.session.shopId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Create Shop Event (supervisor: own shop, leadership: any) ────────────────

app.post('/api/shop/events', requireAuth, requireRole('supervisor'), async (req, res) => {
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

app.delete('/api/shop/events/:id', requireAuth, requireRole('supervisor'), async (req, res) => {
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

app.get('/api/shop/members', requireAuth, async (req, res) => {
  try {
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
    `, [req.session.shopId]);
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
    if (!mr.length || mr[0].shop_id !== req.session.shopId) {
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
          / NULLIF(COUNT(t.id) FILTER (WHERE NOT t.is_upcoming), 0)) ASC NULLS FIRST
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

// ── Static ────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
