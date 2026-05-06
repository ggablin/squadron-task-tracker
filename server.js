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
             cat.code  AS category_code,
             cat.label AS category_label,
             COALESCE(tc.state, 'none') AS state,
             tc.note
      FROM tasks t
      JOIN task_categories cat ON cat.id = t.category_id
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE t.member_id = $1
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      ORDER BY cat.sort_order, t.sort_order, t.id
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

// ── My Shop ───────────────────────────────────────────────────────────────────

app.get('/api/shop/events', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM shop_events
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

app.get('/api/shop/members', requireAuth, requireRole('supervisor'), async (req, res) => {
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
      SELECT t.id, t.title, t.details, t.urgency, t.is_upcoming,
             cat.code  AS category_code,
             cat.label AS category_label,
             COALESCE(tc.state, 'none') AS state,
             tc.note
      FROM tasks t
      JOIN task_categories cat ON cat.id = t.category_id
      LEFT JOIN task_completions tc ON tc.task_id = t.id
      WHERE t.member_id = $1
        AND t.uta_cycle_id = (SELECT id FROM uta_cycles WHERE is_current = true LIMIT 1)
      ORDER BY cat.sort_order, t.sort_order, t.id
    `, [memberId]);
    res.json(rows);
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

// ── Static ────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
