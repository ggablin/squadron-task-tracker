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
  ALTER TABLE members ADD COLUMN IF NOT EXISTS can_manage_roster BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;
  ALTER TABLE members ADD COLUMN IF NOT EXISTS updated_by_id INTEGER REFERENCES members(id);
  ALTER TABLE uta_cycles ADD COLUMN IF NOT EXISTS status VARCHAR(20) CHECK (status IN ('draft','live','archived'));
  UPDATE uta_cycles SET status = CASE WHEN is_current THEN 'live' ELSE 'archived' END WHERE status IS NULL;
  ALTER TABLE uta_cycles ALTER COLUMN status SET DEFAULT 'draft';
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES task_batches(id);
  -- Drill length in half-days. Derived from start_date/end_date on write, never
  -- typed. Default 4 covers legacy rows whose dates were never captured.
  ALTER TABLE uta_cycles ADD COLUMN IF NOT EXISTS period_count SMALLINT DEFAULT 4;
  -- A scheduled event authored for N shops writes N rows. event_group_id ties
  -- them together so it can be edited or deleted as the one event it is;
  -- without it, dropping a shop from an event's audience is unexpressible.
  -- Legacy rows keep NULL and behave as standalone, which is what they are.
  ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS event_group_id INTEGER;
  -- squadron_events already carries kind and the timeline renders it as a pill.
  -- Mirroring it here means switching an event's audience from All to a shop
  -- no longer silently discards the value.
  ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS kind VARCHAR(20);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_shop_events_group ON shop_events (event_group_id);

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

-- Widen the notifications type CHECK to include task_escalated.
-- MUST stay after CREATE TABLE notifications above. This used to live in the
-- earlier migration DO block (schema.sql:132), before the table existed on a
-- fresh database — the ALTER hit "relation does not exist", got swallowed by
-- that block's EXCEPTION WHEN others THEN NULL, and silently rolled back
-- everything else the block had done, including shop_events.event_group_id,
-- which then made the CREATE INDEX right after it fail with undefined_column
-- and abort the whole script: a fresh database ended up with NO TABLES AT
-- ALL. Fixed in the commit that added this comment; see also commit bdbebe6,
-- which fixed the same bug once already for server.js's copy of this migration.
DO $$ BEGIN
  ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('tasks_live','task_assigned','completion_digest','task_escalated'));
EXCEPTION WHEN others THEN NULL;
END $$;

-- Per-period UTA attendance, marked by shop supervisors.
-- A row's EXISTENCE means "marked" — there is deliberately no 'unmarked'
-- status and no implicit 'present', so a supervisor who never opens the app
-- cannot produce a clean full-attendance record for their whole shop.
-- shop_id is snapshotted rather than joined through members, so a transfer
-- doesn't silently re-attribute someone's past attendance to their new shop.
-- The period CHECK is a garbage guard, not the real limit: the real bound is
-- the cycle's own period_count, enforced per write in the API.
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

-- Session storage for connect-pg-simple
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR    NOT NULL COLLATE "default",
  sess   JSON       NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
