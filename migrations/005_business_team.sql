-- Business teams (PRD §22.5: "Only authorised business representatives can administer the profile,
-- buy promotions, view leads, or access billing details"). The business account is the owner; staff use
-- their own logins and act for the business within the permissions of their role.
CREATE TABLE business_members (
  business_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('admin','marketing','sales')),
  added_by    TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX idx_business_members_user ON business_members(user_id);

-- Invites are matched to the invitee's verified email address, so no secret link is needed.
CREATE TABLE business_invites (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','marketing','sales')),
  invited_by  TEXT NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);
CREATE INDEX idx_business_invites_email ON business_invites(email, status);

-- Replies a staff member sends on the business's behalf keep a record of who wrote them.
ALTER TABLE messages ADD COLUMN sent_by TEXT REFERENCES users(id);
