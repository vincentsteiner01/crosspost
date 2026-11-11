-- Several devices per user, and videos shared from a phone.

-- "web" for a browser, "shortcut" for the iPhone Shortcut that sends videos in.
ALTER TABLE sessions ADD COLUMN label TEXT;

-- Videos sent in (e.g. from the iPhone share menu), waiting to be posted. File in R2 under inbox/.
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  name TEXT,
  type TEXT,
  size INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX inbox_user ON inbox (user_id, created_at);

-- One-time codes (15 minutes) that sign a browser in, e.g. in the link the Shortcut opens.
CREATE TABLE link_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
