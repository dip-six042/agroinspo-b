-- Phase 2 · Events & Jobs (PRD §24, §25) plus payments (§9, §28).
-- Applied once by server/db.js; recorded in schema_migrations.

-- Reports can now target jobs and events too. SQLite can't alter a CHECK
-- constraint, so the table is rebuilt (db.js runs this with foreign keys off).
CREATE TABLE reports_v2 (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('post','comment','user','job','event')),
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('spam','scam','harassment','misinformation','inappropriate','other')),
  details      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  action       TEXT,
  resolution_note TEXT NOT NULL DEFAULT '',
  resolved_by  TEXT REFERENCES users(id),
  resolved_at  TEXT,
  created_at   TEXT NOT NULL
);
INSERT INTO reports_v2 SELECT * FROM reports;
DROP TABLE reports;
ALTER TABLE reports_v2 RENAME TO reports;
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

-- Private uploaded files (CVs now; evidence and documents later). Bytes live on disk
-- under data/uploads, never in a public folder; access is checked per request.
CREATE TABLE files (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('cv')),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE jobseeker_profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline     TEXT NOT NULL DEFAULT '',
  skills       TEXT NOT NULL DEFAULT '[]',
  experience   TEXT NOT NULL DEFAULT '',
  qualifications TEXT NOT NULL DEFAULT '',
  preferred_locations TEXT NOT NULL DEFAULT '',
  visibility   TEXT NOT NULL DEFAULT 'employers' CHECK (visibility IN ('employers','hidden')),
  job_alerts   INTEGER NOT NULL DEFAULT 1,
  cv_file_id   TEXT REFERENCES files(id) ON DELETE SET NULL,
  updated_at   TEXT NOT NULL
);

-- Listing states follow PRD §25.2.
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  employer_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  responsibilities TEXT NOT NULL DEFAULT '[]',
  qualifications  TEXT NOT NULL DEFAULT '[]',
  category        TEXT NOT NULL,
  employment_type TEXT NOT NULL CHECK (employment_type IN ('full-time','part-time','contract','seasonal','internship')),
  work_mode       TEXT NOT NULL DEFAULT 'onsite' CHECK (work_mode IN ('onsite','remote','hybrid')),
  location        TEXT NOT NULL,
  pay_min         INTEGER,
  pay_max         INTEGER,
  pay_period      TEXT CHECK (pay_period IN ('month','year','project','day')),
  openings        INTEGER NOT NULL DEFAULT 1,
  closing_date    TEXT NOT NULL,
  apply_method    TEXT NOT NULL DEFAULT 'platform' CHECK (apply_method IN ('platform','external')),
  external_url    TEXT NOT NULL DEFAULT '',
  plan            TEXT NOT NULL DEFAULT 'standard',
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','payment_pending','under_review','published','paused','expired','rejected','closed','archived')),
  flags           TEXT NOT NULL DEFAULT '[]',   -- automatic anti-scam screening hints for reviewers
  review_note     TEXT NOT NULL DEFAULT '',
  reviewed_by     TEXT REFERENCES users(id),
  published_at    TEXT,
  expires_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status, published_at);
CREATE INDEX idx_jobs_employer ON jobs(employer_id);

CREATE TABLE saved_jobs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id)
);

CREATE TABLE job_applications (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  applicant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cover_note   TEXT NOT NULL DEFAULT '',
  cv_file_id   TEXT REFERENCES files(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'submitted'
               CHECK (status IN ('submitted','reviewing','shortlisted','interview','offered','hired','rejected','withdrawn')),
  employer_note TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (job_id, applicant_id)
);
CREATE INDEX idx_applications_applicant ON job_applications(applicant_id);

CREATE TABLE events (
  id               TEXT PRIMARY KEY,
  host_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  topic            TEXT NOT NULL,
  speakers         TEXT NOT NULL DEFAULT '',
  starts_at        TEXT NOT NULL,
  duration_min     INTEGER NOT NULL,
  capacity         INTEGER,
  price_ngn        INTEGER NOT NULL DEFAULT 0,
  recording        INTEGER NOT NULL DEFAULT 0,
  replay_access    TEXT NOT NULL DEFAULT 'registrants' CHECK (replay_access IN ('members','registrants')),
  status           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended','cancelled')),
  room_id          TEXT NOT NULL,
  replay_url       TEXT NOT NULL DEFAULT '',
  replay_published INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT,
  ended_at         TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_events_start ON events(starts_at);

CREATE TABLE event_registrations (
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('pending_payment','registered','cancelled')),
  payment_id   TEXT,
  reminded_24h INTEGER NOT NULL DEFAULT 0,
  reminded_1h  INTEGER NOT NULL DEFAULT 0,
  notified_live INTEGER NOT NULL DEFAULT 0,
  recording_consent_at TEXT,
  joined_at    TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

-- Live chat and Q&A during an event. Kept for the event's record; not a general messenger.
CREATE TABLE event_messages (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','question')),
  body       TEXT NOT NULL,
  answered   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_event_messages ON event_messages(event_id, created_at);

-- Every payment the platform asks for (PRD FR-10). Amounts are whole naira.
CREATE TABLE payments (
  id            TEXT PRIMARY KEY,
  reference     TEXT NOT NULL UNIQUE,         -- our reference, sent to the provider
  user_id       TEXT NOT NULL REFERENCES users(id),
  purpose       TEXT NOT NULL CHECK (purpose IN ('job_listing','event_ticket')),
  subject_id    TEXT NOT NULL,                -- job id or event id
  description   TEXT NOT NULL,
  amount_ngn    INTEGER NOT NULL,
  fee_ngn       INTEGER NOT NULL DEFAULT 0,   -- provider fee reported back
  currency      TEXT NOT NULL DEFAULT 'NGN',
  provider      TEXT NOT NULL,                -- 'kora' or 'kora-dummy'
  provider_ref  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'initiated'
                CHECK (status IN ('initiated','pending','successful','failed','refunded','under_review')),
  checkout_url  TEXT NOT NULL DEFAULT '',
  meta          TEXT NOT NULL DEFAULT '{}',
  paid_at       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_payments_user ON payments(user_id, created_at);

-- Raw provider events, for idempotency and reconciliation.
CREATE TABLE payment_events (
  id          TEXT PRIMARY KEY,
  payment_id  TEXT REFERENCES payments(id),
  event_key   TEXT NOT NULL UNIQUE,           -- provider event + reference + status
  payload     TEXT NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
