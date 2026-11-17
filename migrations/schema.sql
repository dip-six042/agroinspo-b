-- Agro Inspo · Phase 1 schema
-- Written in portable SQL (SQLite now; Postgres-compatible types and constraints where possible).
-- JSON columns hold small structured preferences; everything relational is normalised.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('enthusiast','farmer','specialist','business','admin')),
  title           TEXT NOT NULL DEFAULT '',
  location        TEXT NOT NULL DEFAULT '',
  bio             TEXT NOT NULL DEFAULT '',
  avatar_url      TEXT NOT NULL DEFAULT '',
  interests       TEXT NOT NULL DEFAULT '[]',   -- JSON array of topic slugs
  goals           TEXT NOT NULL DEFAULT '[]',   -- JSON array of goal slugs
  privacy         TEXT NOT NULL DEFAULT '{}',   -- JSON: {profileVisibility, showLocation, showActivity}
  notif_prefs     TEXT NOT NULL DEFAULT '{}',   -- JSON: {comments, likes, follows, email}
  email_verified  INTEGER NOT NULL DEFAULT 0,
  onboarded       INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  terms_accepted_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Session tokens are stored only as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  user_agent  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One-time tokens for email verification and password reset (hashed).
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('verify_email','reset_password')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id           TEXT PRIMARY KEY,
  author_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic        TEXT NOT NULL,
  body         TEXT NOT NULL,
  image_url    TEXT NOT NULL DEFAULT '',
  is_sponsored INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','removed')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_posts_topic ON posts(topic);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_saves (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES comments(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','removed')),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

-- Follow a topic (target = topic slug) or a person (target = user id).
CREATE TABLE IF NOT EXISTS follows (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('topic','user')),
  target      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, target_type, target)
);

-- Block hides both ways; mute hides the target's content from the muter only.
CREATE TABLE IF NOT EXISTS user_blocks (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('block','mute')),
  created_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, target_user_id, kind)
);

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('post','comment','user')),
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
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS appeals (
  id          TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','overturned')),
  decision_note TEXT NOT NULL DEFAULT '',
  decided_by  TEXT REFERENCES users(id),
  decided_at  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (report_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

-- Append-only record of sensitive actions (PRD FR-18). Never updated or deleted by the app.
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  details     TEXT NOT NULL DEFAULT '{}',
  ip          TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- Development email outbox: every email the platform would send lands here
-- until a real provider is configured (see server/mailer.js).
CREATE TABLE IF NOT EXISTS email_outbox (
  id         TEXT PRIMARY KEY,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
