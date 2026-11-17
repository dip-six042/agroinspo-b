-- Phase 4 · Business & advertising (PRD §22.5, §24 sponsorship, §30): business profiles and
-- verification, product/service listings, enquiries (leads), advert campaigns with measured
-- metrics, and event sponsorship packages.

-- Payments gain advert and sponsorship purposes.
CREATE TABLE payments_v4 (
  id            TEXT PRIMARY KEY,
  reference     TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL REFERENCES users(id),
  purpose       TEXT NOT NULL CHECK (purpose IN ('job_listing','event_ticket','consultation','book_purchase','advert','sponsorship')),
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
INSERT INTO payments_v4 SELECT * FROM payments;
DROP TABLE payments;
ALTER TABLE payments_v4 RENAME TO payments;
CREATE INDEX idx_payments_user ON payments(user_id, created_at);

-- Files gain verification evidence and campaign/listing/sponsor images.
CREATE TABLE files_v4 (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('cv','book','book_sample','cover','business_evidence','ad_image','listing_image','sponsor_logo')),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
INSERT INTO files_v4 SELECT * FROM files;
DROP TABLE files;
ALTER TABLE files_v4 RENAME TO files;

-- Reports can target adverts and listings.
CREATE TABLE reports_v4 (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('post','comment','user','job','event','ad','listing')),
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
INSERT INTO reports_v4 SELECT * FROM reports;
DROP TABLE reports;
ALTER TABLE reports_v4 RENAME TO reports;
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

/* ---------- business profiles & verification (PRD §22.5) ---------- */
CREATE TABLE business_profiles (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  legal_name          TEXT NOT NULL DEFAULT '',
  trading_name        TEXT NOT NULL DEFAULT '',
  category            TEXT NOT NULL DEFAULT 'inputs',
  rc_number           TEXT NOT NULL DEFAULT '',      -- CAC registration number
  address             TEXT NOT NULL DEFAULT '',
  region              TEXT NOT NULL DEFAULT '',
  service_area        TEXT NOT NULL DEFAULT '',
  contact_name        TEXT NOT NULL DEFAULT '',
  contact_role        TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',      -- private: shared only with admins
  website             TEXT NOT NULL DEFAULT '',
  socials             TEXT NOT NULL DEFAULT '[]',
  about               TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  verification_scope  TEXT NOT NULL DEFAULT '',      -- what was actually checked, shown publicly
  verification_note   TEXT NOT NULL DEFAULT '',      -- reason given to the business
  evidence            TEXT NOT NULL DEFAULT '[]',    -- [{fileId, label}]
  submitted_at        TEXT,
  verified_at         TEXT,
  verified_by         TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

/* ---------- products & services ---------- */
CREATE TABLE business_listings (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('product','service')),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  topic         TEXT NOT NULL,
  price_type    TEXT NOT NULL DEFAULT 'quote' CHECK (price_type IN ('fixed','from','quote')),
  price_ngn     INTEGER,
  unit          TEXT NOT NULL DEFAULT '',
  service_area  TEXT NOT NULL DEFAULT '',
  availability  TEXT NOT NULL DEFAULT '',
  image_file_id TEXT,
  status        TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','hidden','removed')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_listings_business ON business_listings(business_id, status);

/* ---------- enquiries (leads) ---------- */
CREATE TABLE enquiries (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id      TEXT,
  ad_id           TEXT,
  sponsorship_id  TEXT,
  message         TEXT NOT NULL,
  share_phone     TEXT NOT NULL DEFAULT '',           -- only if the enquirer chose to share it
  conversation_id TEXT,
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','won','closed')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_enquiries_business ON enquiries(business_id, created_at);

/* ---------- advert campaigns (PRD §30) ---------- */
CREATE TABLE ad_campaigns (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  placement      TEXT NOT NULL CHECK (placement IN ('feed','events','jobs')),
  package        TEXT NOT NULL,
  days           INTEGER NOT NULL,
  headline       TEXT NOT NULL,
  body           TEXT NOT NULL,
  image_file_id  TEXT,
  cta            TEXT NOT NULL CHECK (cta IN ('enquire','website')),
  listing_id     TEXT,
  url            TEXT NOT NULL DEFAULT '',
  target_topic   TEXT NOT NULL DEFAULT '',
  target_region  TEXT NOT NULL DEFAULT '',
  starts_on      TEXT NOT NULL,                       -- YYYY-MM-DD
  ends_on        TEXT NOT NULL,
  price_ngn      INTEGER NOT NULL,
  flags          TEXT NOT NULL DEFAULT '[]',          -- automatic restricted-content flags for reviewers
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','payment_pending','in_review','approved','paused','rejected','suspended','cancelled','ended')),
  review_note    TEXT NOT NULL DEFAULT '',
  payment_id     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_ads_serving ON ad_campaigns(status, placement, starts_on, ends_on);

-- Measured, deduplicated interactions. Impressions and clicks count once per viewer per day.
CREATE TABLE ad_events (
  ad_id      TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('impression','click')),
  viewer_key TEXT NOT NULL,                           -- user id, or a salted hash of the anonymous session
  day        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ad_id, kind, viewer_key, day)
);

/* ---------- event sponsorship (PRD §24, §30) ---------- */
CREATE TABLE sponsorship_packages (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  price_ngn     INTEGER NOT NULL,
  benefits      TEXT NOT NULL,                        -- placement, mentions, audience exposure, in plain words
  deliverables  TEXT NOT NULL DEFAULT '[]',           -- ["Logo on event page", "Two verbal mentions", ...]
  speaking_slot INTEGER NOT NULL DEFAULT 0,
  exclusive     INTEGER NOT NULL DEFAULT 0,
  slots         INTEGER NOT NULL DEFAULT 1,
  cancellation  TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE event_sponsorships (
  id            TEXT PRIMARY KEY,
  package_id    TEXT NOT NULL REFERENCES sponsorship_packages(id),
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  business_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message       TEXT NOT NULL DEFAULT '',
  display_name  TEXT NOT NULL,
  link          TEXT NOT NULL DEFAULT '',
  logo_file_id  TEXT,
  status        TEXT NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested','accepted','declined','confirmed','cancelled','refunded','completed')),
  decline_note  TEXT NOT NULL DEFAULT '',
  payment_id    TEXT,
  deliverables  TEXT NOT NULL DEFAULT '[]',           -- [{item, done, evidence, doneAt}]
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_sponsorships_event ON event_sponsorships(event_id, status);
