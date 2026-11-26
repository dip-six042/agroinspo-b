-- A member's country, suggested from the city or state they type and confirmed on the profile.
-- Listings stay worldwide: country is a label, not a lock.
ALTER TABLE users ADD COLUMN country TEXT NOT NULL DEFAULT '';
