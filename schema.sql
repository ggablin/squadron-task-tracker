-- 108th CES Squadron Task Tracker — Database Schema

-- manages_work_orders marks the shop that runs work control for the squadron
-- (Operations). Everyone assigned to it may create, edit, delete and close work
-- orders in every shop — and nothing else in another shop. It sits on the shop
-- rather than on each member so arrivals and departures need no bookkeeping.
CREATE TABLE IF NOT EXISTS shops (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(100) UNIQUE NOT NULL,
  manages_work_orders BOOLEAN NOT NULL DEFAULT false
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
  -- Stamped on every successful login. must_change_password answers *whether* a
  -- member ever signed in (only their own password change clears it); this answers
  -- *when*, which the boolean alone can't.
  last_login_at TIMESTAMP,
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
  status        VARCHAR(20) NOT NULL CHECK (status IN
                  ('agr_at_orders','present','ruta_excused','unexcused','awol','maternity','transfer','separated','equiv_training')),
  note          TEXT,
  marked_by_id  INTEGER REFERENCES members(id),
  updated_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE (uta_cycle_id, member_id, period)
);
CREATE INDEX IF NOT EXISTS idx_attendance_cycle_shop ON attendance (uta_cycle_id, shop_id);



-- Squadron forms shown on the Resources tab (RUTA request, excusal, dental, …).
--
-- The bytes live in Postgres rather than on disk on purpose: the app runs on
-- Railway, whose container filesystem is rebuilt on every deploy, so a file
-- written to disk would silently disappear at the next push. These are a handful
-- of small PDFs, well inside what a bytea column should hold.
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
-- Listing queries filter on active and order by category; `content` is never in
-- them, so the bytes stay off that path.
CREATE INDEX IF NOT EXISTS idx_documents_listing
  ON documents (active, category, sort_order, title);

-- The CREATE TABLE above is a no-op once the table exists; a column added after
-- the first deploy needs its own ALTER. Every schema.sql migration has a twin in
-- server.js's startup block, which is what production actually runs.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS mime VARCHAR(120) NOT NULL DEFAULT 'application/pdf';

-- Student Flight: trainees awaiting BMT / Tech School, flagged on the member so
-- they keep their shop, login and tasks. The First Sergeant's tracking dates all
-- ride along; they mean nothing unless is_student_flight is set.
ALTER TABLE members ADD COLUMN IF NOT EXISTS is_student_flight BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE members ADD COLUMN IF NOT EXISTS bmt_start     DATE;
ALTER TABLE members ADD COLUMN IF NOT EXISTS bmt_grad      DATE;
ALTER TABLE members ADD COLUMN IF NOT EXISTS tech_start    DATE;
ALTER TABLE members ADD COLUMN IF NOT EXISTS tech_grad     DATE;
ALTER TABLE members ADD COLUMN IF NOT EXISTS student_notes VARCHAR(500);

-- Task helpers: an optional link and/or an attached Resources form per task.
-- These sit BELOW the documents table on purpose — document_id's REFERENCES
-- would hit "relation does not exist" inside the earlier migration DO block on
-- a fresh database, and that block's exception guard swallows errors (see the
-- notifications_type_check comment above for the crater that causes).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS link_url    VARCHAR(500);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS document_id INTEGER REFERENCES documents(id);

-- Session storage for connect-pg-simple
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR    NOT NULL COLLATE "default",
  sess   JSON       NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);

-- ── Web Push subscriptions ─────────────────────────────────────────────────
-- One row per browser+device that has granted notification permission. A member
-- with a phone and a laptop has two. endpoint is the push service's URL for that
-- installation and is the natural key: browsers rotate it, and the same device
-- re-registering must update the existing row rather than accumulate duplicates,
-- so writes are ON CONFLICT (endpoint) DO UPDATE.
--
-- ON DELETE CASCADE because a removed member's subscriptions are dead weight —
-- the push service would 410 them anyway, and lib/push.js prunes on that.
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

-- Mirrors notifications.emailed_at: NULL means "not yet delivered by push".
-- The partial index keeps the flush query cheap as the table grows, exactly as
-- idx_notifications_unemailed does for the email channel.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_notifications_unpushed
  ON notifications (pushed_at) WHERE pushed_at IS NULL;

-- ── Resources reference tables ─────────────────────────────────────────────
-- Additional duties ("who do I see about X"), the calendar year's drill dates,
-- and the TDY / training rotations. Every member reads them, roster admins edit
-- them, and the newsletter renders the first two. These CREATEs are the twins of
-- the DDL in lib/duties.js, lib/drill-calendar.js and lib/calendar-events.js,
-- which the server.js boot block runs — with one difference: the boot block also
-- seeds the initial rows the first time it creates each table. This copy creates
-- them empty, which is what the tests and seed.js want.
CREATE TABLE IF NOT EXISTS additional_duties (
  id              SERIAL PRIMARY KEY,
  duty            VARCHAR(120) NOT NULL,
  primary_owner   VARCHAR(200),          -- free text; NULL = needs owner
  alternate_owner VARCHAR(200),
  updated_by_id   INTEGER REFERENCES members(id),
  updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS additional_duties_duty_key
  ON additional_duties (lower(duty));

CREATE TABLE IF NOT EXISTS drill_dates (
  id            SERIAL PRIMARY KEY,
  start_date    DATE NOT NULL UNIQUE,
  end_date      DATE NOT NULL,
  note          VARCHAR(80),             -- 'Jan & Feb combined'
  updated_by_id INTEGER REFERENCES members(id),
  updated_at    TIMESTAMP DEFAULT NOW(),
  CHECK (end_date >= start_date AND end_date - start_date < 7)
);

-- Events legitimately overlap each other and drills, and a DFT runs a fortnight,
-- so there is no overlap check, no uniqueness and no 7-day cap here.
CREATE TABLE IF NOT EXISTS calendar_events (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(120) NOT NULL,
  location      VARCHAR(120),
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  attendees     VARCHAR(600),
  status        VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','complete','cancelled')),
  note          VARCHAR(200),
  updated_by_id INTEGER REFERENCES members(id),
  updated_at    TIMESTAMP DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events (start_date);
