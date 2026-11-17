-- Phase 3 · Paid expertise (PRD §22.4, §26–29): consultations, ledger and payouts, books,
-- creator screening, support and disputes, messaging.

-- Payments gain new purposes and partial-refund tracking (table rebuilt for the CHECK change).
CREATE TABLE payments_v3 (
  id            TEXT PRIMARY KEY,
  reference     TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL REFERENCES users(id),
  purpose       TEXT NOT NULL CHECK (purpose IN ('job_listing','event_ticket','consultation','book_purchase')),
  subject_id    TEXT NOT NULL,
  description   TEXT NOT NULL,
  amount_ngn    INTEGER NOT NULL,
  fee_ngn       INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'NGN',
  provider      TEXT NOT NULL,
  provider_ref  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'initiated'
                CHECK (status IN ('initiated','pending','successful','failed','refunded','partially_refunded','under_review')),
  refunded_ngn  INTEGER NOT NULL DEFAULT 0,
  checkout_url  TEXT NOT NULL DEFAULT '',
  meta          TEXT NOT NULL DEFAULT '{}',
  paid_at       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
INSERT INTO payments_v3 (id, reference, user_id, purpose, subject_id, description, amount_ngn, fee_ngn, currency, provider, provider_ref,
  status, checkout_url, meta, paid_at, created_at, updated_at)
  SELECT id, reference, user_id, purpose, subject_id, description, amount_ngn, fee_ngn, currency, provider, provider_ref,
  status, checkout_url, meta, paid_at, created_at, updated_at FROM payments;
DROP TABLE payments;
ALTER TABLE payments_v3 RENAME TO payments;
CREATE INDEX idx_payments_user ON payments(user_id, created_at);

-- Files gain book, sample and cover kinds.
CREATE TABLE files_v3 (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('cv','book','book_sample','cover')),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
INSERT INTO files_v3 SELECT * FROM files;
DROP TABLE files;
ALTER TABLE files_v3 RENAME TO files;

-- Posts: ordinary discussions, or educational articles that need creator approval for the topic.
ALTER TABLE posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'discussion';

/* ---------- specialists & consultations (PRD §22.4, §27) ---------- */
CREATE TABLE specialist_profiles (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline         TEXT NOT NULL DEFAULT '',
  specialties      TEXT NOT NULL DEFAULT '[]',
  languages        TEXT NOT NULL DEFAULT '["English"]',
  service_area     TEXT NOT NULL DEFAULT '',
  experience_years INTEGER NOT NULL DEFAULT 0,
  credentials      TEXT NOT NULL DEFAULT '[]',   -- self-declared list
  credential_status TEXT NOT NULL DEFAULT 'unverified' CHECK (credential_status IN ('unverified','pending','verified')),
  credential_note  TEXT NOT NULL DEFAULT '',     -- what was checked, by whom, when (PRD §14)
  accepting        INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT NOT NULL
);

CREATE TABLE consultation_services (
  id            TEXT PRIMARY KEY,
  specialist_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  topic         TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('video','audio')),
  duration_min  INTEGER NOT NULL,
  price_ngn     INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_services_specialist ON consultation_services(specialist_id);

CREATE TABLE availability_slots (
  id            TEXT PRIMARY KEY,
  specialist_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at     TEXT NOT NULL,
  duration_min  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','held','booked','removed')),
  held_until    TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (specialist_id, starts_at)
);
CREATE INDEX idx_slots_specialist ON availability_slots(specialist_id, starts_at);

-- Booking statuses follow PRD §27.
CREATE TABLE bookings (
  id             TEXT PRIMARY KEY,
  service_id     TEXT NOT NULL REFERENCES consultation_services(id),
  specialist_id  TEXT NOT NULL REFERENCES users(id),
  client_id      TEXT NOT NULL REFERENCES users(id),
  slot_id        TEXT REFERENCES availability_slots(id),
  starts_at      TEXT NOT NULL,
  duration_min   INTEGER NOT NULL,
  mode           TEXT NOT NULL,
  objective      TEXT NOT NULL,
  price_ngn      INTEGER NOT NULL,
  commission_ngn INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'payment_pending'
                 CHECK (status IN ('payment_pending','confirmed','in_progress','completed','cancelled','no_show','refunded','disputed')),
  payment_id     TEXT,
  room_id        TEXT NOT NULL,
  cancelled_by   TEXT,
  cancel_reason  TEXT NOT NULL DEFAULT '',
  specialist_notes TEXT NOT NULL DEFAULT '',
  rescheduled    INTEGER NOT NULL DEFAULT 0,   -- moved by the specialist: client may cancel for a full refund
  client_joined_at TEXT,
  specialist_joined_at TEXT,
  reminded       INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT,
  completed_at   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_bookings_client ON bookings(client_id, starts_at);
CREATE INDEX idx_bookings_specialist ON bookings(specialist_id, starts_at);

CREATE TABLE reviews (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  client_id     TEXT NOT NULL REFERENCES users(id),
  specialist_id TEXT NOT NULL REFERENCES users(id),
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
  created_at    TEXT NOT NULL
);

/* ---------- ledger & payouts (PRD §28) ---------- */
-- Append-only. account_id NULL = the platform's own account. Positive = owed to the account.
CREATE TABLE ledger_entries (
  id           TEXT PRIMARY KEY,
  account_id   TEXT REFERENCES users(id),
  entry_type   TEXT NOT NULL CHECK (entry_type IN ('sale','platform_fee','provider_fee','refund','payout','payout_reversal','adjustment')),
  amount_ngn   INTEGER NOT NULL,
  source_type  TEXT NOT NULL,          -- booking | book_purchase | event_ticket | job_listing | payout | adjustment
  source_id    TEXT NOT NULL,
  payment_id   TEXT,
  available_at TEXT NOT NULL,          -- when it stops being "pending"
  memo         TEXT NOT NULL DEFAULT '',
  created_by   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_ledger_account ON ledger_entries(account_id, available_at);
CREATE INDEX idx_ledger_source ON ledger_entries(source_type, source_id);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;

-- Holds keep earnings from becoming available (disputes, fraud review). Released, never deleted.
CREATE TABLE earning_holds (
  id          TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  released_at TEXT,
  released_by TEXT
);
CREATE INDEX idx_holds_source ON earning_holds(source_type, source_id);

CREATE TABLE payout_accounts (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bank_code      TEXT NOT NULL,
  bank_name      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name   TEXT NOT NULL,
  verified_at    TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE payout_batches (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','completed','cancelled')),
  total_ngn    INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL REFERENCES users(id),
  approved_by  TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  approved_at  TEXT,
  completed_at TEXT
);

CREATE TABLE payouts (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES payout_batches(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  amount_ngn    INTEGER NOT NULL,
  reference     TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','paid','failed','cancelled')),
  account_snapshot TEXT NOT NULL,       -- bank details used, for reconciliation
  provider_ref  TEXT NOT NULL DEFAULT '',
  failure_reason TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  paid_at       TEXT,
  UNIQUE (batch_id, user_id)
);

-- Which ledger entries each payout covered (traceability, PRD §28.1).
CREATE TABLE payout_items (
  payout_id TEXT NOT NULL REFERENCES payouts(id),
  entry_id  TEXT NOT NULL REFERENCES ledger_entries(id),
  PRIMARY KEY (payout_id, entry_id)
);

/* ---------- support & disputes ---------- */
CREATE TABLE support_tickets (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  category     TEXT NOT NULL CHECK (category IN ('dispute','refund','payment','account','technical','other')),
  subject_type TEXT NOT NULL DEFAULT '',   -- booking | book_purchase | event_ticket | job_listing | payout
  subject_id   TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting_on_user','resolved')),
  resolution   TEXT NOT NULL DEFAULT '',
  hold_id      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE ticket_messages (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  from_staff INTEGER NOT NULL DEFAULT 0,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

/* ---------- books (PRD §29) ---------- */
CREATE TABLE books (
  id            TEXT PRIMARY KEY,
  author_id     TEXT NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  subtitle      TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL,
  topic         TEXT NOT NULL,
  language      TEXT NOT NULL DEFAULT 'English',
  pages         INTEGER,
  price_ngn     INTEGER NOT NULL,
  cover_file_id TEXT REFERENCES files(id),
  sample_file_id TEXT REFERENCES files(id),
  book_file_id  TEXT REFERENCES files(id),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','under_review','published','rejected','suspended')),
  rights_declared_at TEXT,
  review_note   TEXT NOT NULL DEFAULT '',
  published_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE book_purchases (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books(id),
  buyer_id    TEXT NOT NULL REFERENCES users(id),
  payment_id  TEXT,
  price_ngn   INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','refunded')),
  downloads   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  paid_at     TEXT
);
CREATE INDEX idx_purchases_buyer ON book_purchases(buyer_id);

/* ---------- creator screening (PRD §26) ---------- */
CREATE TABLE creator_applications (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  topic        TEXT NOT NULL,
  sample       TEXT NOT NULL,
  quiz_score   INTEGER NOT NULL,            -- percent
  quiz_answers TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('failed_quiz','pending','approved','rejected','info_requested')),
  reviewer_id  TEXT REFERENCES users(id),
  review_note  TEXT NOT NULL DEFAULT '',
  decided_at   TEXT,
  retest_after TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE creator_topics (
  user_id     TEXT NOT NULL REFERENCES users(id),
  topic       TEXT NOT NULL,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT NOT NULL,
  review_by   TEXT,                          -- re-screening date
  revoked_at  TEXT,
  PRIMARY KEY (user_id, topic)
);

/* ---------- messaging (FR-15) ---------- */
CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  user_a     TEXT NOT NULL REFERENCES users(id),   -- user_a < user_b
  user_b     TEXT NOT NULL REFERENCES users(id),
  last_at    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_a, user_b)
);
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  read_at         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);
