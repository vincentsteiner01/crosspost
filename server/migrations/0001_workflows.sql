-- Server-side workflows: who may use the server, the accounts and workflows
-- the site hands over, and every video a workflow picked up.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- A connected social account proved by a valid sign-in, e.g. "instagram:1784…".
-- Signing in with the same account on another device finds the same user.
CREATE TABLE identities (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Only the SHA-256 of a session key is stored.
CREATE TABLE sessions (
  key_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER
);

-- Accounts as the site knows them (same ids); tokens are encrypted with TOKEN_KEY.
CREATE TABLE accounts (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT,
  remote_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE workflows (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT,
  source_id TEXT NOT NULL,
  destination_ids TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  auto_publish INTEGER NOT NULL DEFAULT 1,
  caption_template TEXT,
  hashtags TEXT,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  -- Only videos posted after this moment are picked up automatically.
  active_since INTEGER,
  last_checked INTEGER,
  last_error TEXT,
  PRIMARY KEY (user_id, id)
);

-- One video from a source; its copy lives in R2 under r2_key.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  source_media_id TEXT NOT NULL,
  caption TEXT,
  permalink TEXT,
  thumbnail_url TEXT,
  media_timestamp INTEGER,
  r2_key TEXT,
  copied_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (workflow_id, source_media_id)
);
CREATE INDEX items_user ON items (user_id, created_at);

-- One video to one destination account.
-- status: draft (waits for approval) → scheduled → processing (platform is working on it) → published | failed
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  caption TEXT,
  status TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  container_id TEXT,
  url TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  updated_at INTEGER
);
CREATE INDEX jobs_due ON jobs (status, scheduled_at);
CREATE INDEX jobs_item ON jobs (item_id);
