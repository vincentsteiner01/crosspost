-- Statistics: views, likes, comments … of every published video, side by side per platform.

-- The platform's own id of the published video (Instagram media id, YouTube video id,
-- TikTok video id, Facebook video id). TikTok drafts get it once they are posted publicly.
ALTER TABLE jobs ADD COLUMN remote_id TEXT;
-- TikTok drafts: when we last asked TikTok whether the draft has been posted.
ALTER TABLE jobs ADD COLUMN remote_checked_at INTEGER;

-- One row per video on a platform, with its latest numbers (NULL: the platform doesn't tell).
-- Linked to the videos in Crosspost through jobs.remote_id and items.source_media_id (Instagram source).
CREATE TABLE stats (
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  url TEXT,
  posted_at INTEGER,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,
  reach INTEGER,
  -- Last successful reading, and last attempt (also failed ones).
  fetched_at INTEGER,
  checked_at INTEGER,
  -- When the cron reads the numbers next (NULL: no longer by itself, only on "Aktualisieren").
  next_check INTEGER,
  error TEXT,
  -- Something missing that is not an error, e.g. Instagram's statistics permission.
  note TEXT,
  PRIMARY KEY (user_id, platform, remote_id)
);
CREATE INDEX stats_due ON stats (next_check);
-- Finding the video a reading belongs to, and whether anything still points to it.
CREATE INDEX jobs_remote ON jobs (user_id, platform, remote_id);
CREATE INDEX items_source ON items (user_id, source_media_id);

-- Every reading, to compare videos at the same age (e.g. after 24 hours).
CREATE TABLE stat_history (
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,
  reach INTEGER
);
CREATE INDEX stat_history_video ON stat_history (user_id, platform, remote_id, taken_at);

-- Published before this existed: take the ids from the addresses we kept.
UPDATE jobs SET remote_id = substr(url, length('https://www.youtube.com/watch?v=') + 1)
  WHERE platform = 'youtube' AND status = 'published' AND url LIKE 'https://www.youtube.com/watch?v=%';
-- (TikTok: the addresses kept so far were built from rounded numbers – those ids are found again by the server.)
UPDATE jobs SET remote_id = rtrim(substr(url, instr(url, '/videos/') + length('/videos/')), '/')
  WHERE platform = 'facebook' AND status = 'published' AND url LIKE 'https://www.facebook.com/%/videos/%';
INSERT OR IGNORE INTO stats (user_id, platform, remote_id, account_id, url, posted_at, next_check)
  SELECT user_id, platform, remote_id, account_id, url, updated_at, 0 FROM jobs
  WHERE status = 'published' AND remote_id IS NOT NULL AND remote_id != '';
INSERT OR IGNORE INTO stats (user_id, platform, remote_id, account_id, url, posted_at, next_check)
  SELECT i.user_id, 'instagram', i.source_media_id, COALESCE(i.source_account_id, w.source_id), i.permalink, COALESCE(i.media_timestamp, i.created_at), 0
  FROM items i LEFT JOIN workflows w ON w.user_id = i.user_id AND w.id = i.workflow_id
  WHERE i.kind != 'upload' AND COALESCE(i.source_account_id, w.source_id) IS NOT NULL;
