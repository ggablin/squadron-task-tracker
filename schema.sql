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
  created_at     TIMESTAMP DEFAULT NOW()
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
  created_by_id INTEGER REFERENCES members(id),
  sort_order    INTEGER DEFAULT 99,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Migration: add columns to existing tables (safe to run multiple times)
DO $$ BEGIN
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT false;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS flagged_by_id INTEGER REFERENCES members(id);
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by_id INTEGER REFERENCES members(id);
  ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS created_by_id INTEGER REFERENCES members(id);
EXCEPTION WHEN others THEN NULL;
END $$;

-- Session storage for connect-pg-simple
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR    NOT NULL COLLATE "default",
  sess   JSON       NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
