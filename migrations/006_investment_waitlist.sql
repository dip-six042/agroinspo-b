-- Investment portal waiting list. No payments, pledges or allocations.
-- The two-year window is computed from official_launch_at in platform_settings.

CREATE TABLE platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE investment_waitlist (
  id             TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  phone          TEXT NOT NULL,
  sector         TEXT NOT NULL,
  capacity_ngn   INTEGER,
  country        TEXT NOT NULL,
  location       TEXT NOT NULL,
  updates_opt_in INTEGER NOT NULL DEFAULT 1,
  consent_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_investment_waitlist_created ON investment_waitlist(created_at);
CREATE INDEX idx_investment_waitlist_sector ON investment_waitlist(sector);
