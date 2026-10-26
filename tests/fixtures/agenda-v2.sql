
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('once', 'interval')),
  at INTEGER,
  interval_ms INTEGER,
  next_at INTEGER,
  content TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'completed')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_occurrence_at INTEGER,
  CHECK ((kind = 'once' AND at IS NOT NULL AND interval_ms IS NULL) OR
         (kind = 'interval' AND at IS NULL AND interval_ms IS NOT NULL))
) STRICT;
CREATE INDEX schedules_due ON schedules (state, next_at, id);
CREATE INDEX schedules_page ON schedules (created_at, id);
CREATE TABLE occurrences (
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  scheduled_at INTEGER NOT NULL,
  schedule_revision INTEGER NOT NULL CHECK (schedule_revision > 0),
  client_request_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'accepted', 'withdrawn', 'blocked')),
  turn_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (schedule_id, scheduled_at),
  CHECK ((state = 'accepted' AND turn_id IS NOT NULL) OR state <> 'accepted')
) STRICT;
CREATE INDEX occurrences_pending ON occurrences (state, attempts, updated_at, schedule_id, scheduled_at);
CREATE INDEX occurrences_terminal ON occurrences (state, updated_at, schedule_id, scheduled_at);
CREATE INDEX occurrences_schedule_state ON occurrences (schedule_id, state);
