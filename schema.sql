-- 108th CES Squadron Task Tracker — Database Schema

CREATE TABLE IF NOT EXISTS shops (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS uta_cycles (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  start_date DATE,
  end_date   DATE,
  is_current BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uta_cycles_one_current ON uta_cycles (is_current) WHERE is_current;

CREATE TABLE IF NOT EXISTS task_categories (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(20) UNIQUE NOT NULL,
  label      VARCHAR(100) NOT NULL,
  sort_order INTEGER DEFAULT 99
);

CREATE TABLE IF NOT EXISTS members (
  id            SERIAL PRIMARY KEY,
  last_name     VARCHAR(100) NOT NULL,
  first_name    VARCHAR(100) NOT NULL,
  rank          VARCHAR(20)  NOT NULL,
  shop_id       INTEGER REFERENCES shops(id),
  role          VARCHAR(20)  NOT NULL CHECK (role IN ('member','supervisor','leadership')),
  slug          VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  active        BOOLEAN DEFAULT true,
  email         VARCHAR(255),
  flight        VARCHAR(30),
  position      VARCHAR(50),
  must_change_password BOOLEAN DEFAULT true,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id             SERIAL PRIMARY KEY,
  uta_cycle_id   INTEGER REFERENCES uta_cycles(id),
  member_id      INTEGER REFERENCES members(id),
  category_id    INTEGER REFERENCES task_categories(id),
  title          VARCHAR(255) NOT NULL,
  details        TEXT,
  urgency        VARCHAR(20) DEFAULT 'this_uta'
                   CHECK (urgency IN ('overdue','this_uta','next_uta','future','info')),
  appt_day       VARCHAR(20),
  appt_time      VARCHAR(20),
  appt_location  VARCHAR(100),
  is_upcoming    BOOLEAN DEFAULT false,
  is_flagged     BOOLEAN DEFAULT false,
  flagged_by_id  INTEGER REFERENCES members(id),
  created_by_id  INTEGER REFERENCES members(id),
  sort_order     INTEGER DEFAULT 99,
  created_at     TIMESTAMP DEFAULT NOW(),
  -- C7/TB1: dedupe key so sync-tasks.js / the task builder can INSERT ... ON CONFLICT DO NOTHING
  UNIQUE (uta_cycle_id, member_id, category_id, title)
);

CREATE TABLE IF NOT EXISTS task_completions (
  id              SERIAL PRIMARY KEY,
  task_id         INTEGER REFERENCES tasks(id) UNIQUE,
  completed_by_id INTEGER REFERENCES members(id),
  state           VARCHAR(20) DEFAULT 'none'
                    CHECK (state IN ('none','partial','done')),
  note            TEXT,
  updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shop_events (
  id            SERIAL PRIMARY KEY,
  uta_cycle_id  INTEGER REFERENCES uta_cycles(id),
  shop_id       INTEGER REFERENCES shops(id),
  event_type    VARCHAR(20) CHECK (event_type IN ('schedule','work_order','emphasis')),
  day           VARCHAR(20),
  start_time    VARCHAR(10),
  end_time      VARCHAR(10),
  title         VARCHAR(255) NOT NULL,
  details       TEXT,
  wo_number     VARCHAR(50),
  status        VARCHAR(20) DEFAULT 'open'
                  CHECK (status IN ('open','in_progress','complete')),
  created_by_id INTEGER REFERENCES members(id),
  sort_order    INTEGER DEFAULT 99,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Append-only history of work-order status changes (full timeline, mandatory note).
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

CREATE TABLE IF NOT EXISTS task_batches (
  id            SERIAL PRIMARY KEY,
  uta_cycle_id  INTEGER REFERENCES uta_cycles(id),
  label         VARCHAR(255) NOT NULL,
  kind          VARCHAR(20) CHECK (kind IN ('new_task','copy_forward')),
  created_by_id INTEGER REFERENCES members(id),
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Migration: add columns to existing tables (safe to run multiple times)
DO $$ BEGIN
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
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES task_batches(id);
EXCEPTION WHEN others THEN NULL;
END $$;

-- C7/TB1: dedupe constraint for additive task sync. Idempotent/collision-safe —
-- skips silently if it already exists OR if legacy duplicate (member, category,
-- title) rows still need de-duping. If sync-tasks.js later reports a missing
-- constraint, de-dupe those rows and re-run this.
DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT tasks_cycle_member_cat_title_uniq
    UNIQUE (uta_cycle_id, member_id, category_id, title);
EXCEPTION WHEN others THEN NULL;
END $$;

-- In-app + email notifications (single source of truth for both channels)
CREATE TABLE IF NOT EXISTS notifications (
  id            SERIAL PRIMARY KEY,
  member_id     INTEGER NOT NULL REFERENCES members(id),  -- recipient
  type          VARCHAR(30) NOT NULL
                  CHECK (type IN ('tasks_live','task_assigned','completion_digest')),
  title         VARCHAR(255) NOT NULL,
  body          TEXT,
  link          VARCHAR(50),          -- view name for in-app deep-link (e.g. 'member','supervisor')
  read_at       TIMESTAMP,            -- NULL = unread
  emailed_at    TIMESTAMP,            -- NULL = not yet emailed
  created_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications (member_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_unemailed ON notifications (emailed_at) WHERE emailed_at IS NULL;

-- Session storage for connect-pg-simple
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR    NOT NULL COLLATE "default",
  sess   JSON       NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
