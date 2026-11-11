-- Posts planned on the site and older Instagram videos cross-posted by hand
-- run through the same items and jobs as workflows.

-- workflow: picked up by a workflow · upload: a file uploaded on the site (R2 sched/…) · instagram: an existing Instagram video
ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'workflow';
ALTER TABLE items ADD COLUMN title TEXT;
-- For kind "instagram": the account the video is downloaded with.
ALTER TABLE items ADD COLUMN source_account_id TEXT;

-- Per destination, JSON: YouTube { title, privacy, categoryId, tags, madeForKids, short },
-- Instagram { trial: "MANUAL" | "SS_PERFORMANCE" }, TikTok { tiktok_mode: "inbox" | "direct" }.
ALTER TABLE jobs ADD COLUMN options TEXT;
