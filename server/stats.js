// Statistics: views, likes, comments, shares … of every published video, platform by platform.
//
// An hourly cron reads the numbers at fixed ages of a video (1 hour, 6 hours, 1 day, 3 days,
// 7 days, 30 days, then weekly until 90 days); the site can ask for fresh numbers any time.
// Readings are kept, so videos can be compared at the same age (e.g. after 24 hours).
//
// API (with the session):
//   GET  /api/stats                   every video with its numbers per platform
//   POST /api/stats/refresh           read the numbers now (each video at most every 10 minutes)
//   GET  /api/tiktok/videos?account=  the latest videos of a TikTok account, to link a draft by hand
//   POST /api/stats/link              { job_id, remote_id }: this TikTok video came from that draft
//
// What each platform tells: Instagram likes and comments; views, shares and saves (the media's
// counters, or its insights); reach only with the permission instagram_manage_insights.
// YouTube views, likes, comments (youtube.readonly). TikTok views, likes, comments, shares
// (video.list). Facebook likes and comments.

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const CHECK_AT = [HOUR, 6 * HOUR, DAY, 3 * DAY, 7 * DAY, 30 * DAY];
const WEEKLY_UNTIL = 90 * DAY;
const RETRY_MS = 12 * HOUR;
const MANUAL_EVERY_MS = 10 * 60_000;
// Readings the site compares: a video's numbers about 1 hour, 24 hours, 7 days and 30 days
// after posting (keep in sync with AGE_WINDOWS in src/pages/app.ts). [from, to] in ms of age.
const MINUTE = 60_000;
const HISTORY_WINDOWS = [[30 * MINUTE, 3 * 3600_000], [18 * 3600_000, 39 * 3600_000], [6 * 86_400_000, 9 * 86_400_000], [27 * 86_400_000, 35 * 86_400_000]];
const inWindowSql = (age) => `(${HISTORY_WINDOWS.map(([a, b]) => `(${age}) BETWEEN ${a} AND ${b}`).join(' OR ')})`;
const inWindow = (age) => HISTORY_WINDOWS.some(([a, b]) => age >= a && age <= b);
// A manual reading ("Aktualisieren") is kept in the history only inside those windows and at
// most every 45 minutes; scheduled readings are always kept.
const HISTORY_GAP_MS = 45 * MINUTE;
// TikTok drafts: ask every 3 hours, for 30 days, whether the draft has been posted.
const DRAFT_LOOK_EVERY_MS = 3 * HOUR;
export const DRAFT_LOOK_FOR_MS = 30 * DAY;
const MAX_ROWS = 100;
// Outgoing requests per run (the free Workers plan allows 50).
const CRON_BUDGET = 35;
const SITE_BUDGET = 30;
const NAMES = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook' };

const now = () => Date.now();
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const chunks = (list, size) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };
// Instagram writes "+0000"; make it an offset every engine reads.
const parseTime = (s) => Date.parse(String(s || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) || null;
const METRICS = ['views', 'likes', 'comments', 'shares', 'saves', 'reach'];

/** When to read a video's numbers next; null: no longer by itself. */
export function nextCheck(postedAt, t) {
  const base = postedAt || t;
  const age = t - base;
  for (const a of CHECK_AT) if (age < a) return base + a;
  return age < WEEKLY_UNTIL ? t + 7 * DAY : null;
}

/**
 * Statement that starts following a video (keeps the numbers when it is followed already).
 * job_id: only while that job still exists (the post may have been deleted meanwhile).
 */
export function trackStmt(D, { user_id, platform, remote_id, account_id, url, posted_at, next_check, job_id = null }) {
  return D.prepare(`INSERT INTO stats (user_id, platform, remote_id, account_id, url, posted_at, next_check)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM jobs WHERE id = ?)
    ON CONFLICT (user_id, platform, remote_id) DO UPDATE SET account_id = excluded.account_id, url = COALESCE(excluded.url, stats.url),
      next_check = COALESCE(stats.next_check, excluded.next_check)`)
    .bind(user_id, platform, String(remote_id), account_id, url || null, posted_at || null, next_check ?? null, job_id, job_id);
}

/**
 * Statements that forget the numbers of these videos ([platform, remote_id] pairs) when no
 * video in Crosspost points to them any more. Run them after the item or job changed.
 */
export function cleanupStmts(D, userId, keys) {
  const list = (keys || []).filter((k) => k && k[0] && k[1]).map((k) => [String(k[0]), String(k[1])]);
  if (!list.length) return [];
  const json = JSON.stringify(list);
  const orphan = (t) => `${t}.user_id = ? AND (${t}.platform, ${t}.remote_id) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.user_id = ${t}.user_id AND j.platform = ${t}.platform AND j.remote_id = ${t}.remote_id)
    AND NOT EXISTS (SELECT 1 FROM items i WHERE i.user_id = ${t}.user_id AND ${t}.platform = 'instagram' AND i.kind != 'upload' AND i.source_media_id = ${t}.remote_id)`;
  return [
    D.prepare(`DELETE FROM stat_history WHERE ${orphan('stat_history')}`).bind(userId, json),
    D.prepare(`DELETE FROM stats WHERE ${orphan('stats')}`).bind(userId, json),
  ];
}

const OUT_OF_BUDGET = new Error('out of budget');
const budgetOf = (n) => ({ left: n, take() { if (this.left <= 0) return false; this.left--; return true; } });
/** The sign-in no longer works: the whole account gets one message instead of a request per video. */
const signInError = (message) => Object.assign(new Error(message), { signIn: true });
const signInProblem = (e) => !!e?.signIn || /abgelaufen|expired|revoked|invalid_grant|access_token_invalid|Error validating access token|code 190\b/i.test(e?.message || '');

/**
 * What a Meta error means for one video:
 * signin – the sign-in is gone · later – rate limit or a hiccup, try in the next run ·
 * gone – the video was deleted (or isn't reachable) · field – this API version doesn't know a field ·
 * permission – a permission is missing (e.g. instagram_manage_insights) · other.
 */
function metaKind(err) {
  const code = Number(err?.code);
  const msg = String(err?.message || '');
  if ([190, 102, 463, 467].includes(code)) return 'signin';
  if ([1, 2, 4, 17, 32, 341, 368, 613, 80001, 80002].includes(code) || err?.is_transient || err?.status >= 500) return 'later';
  if (/nonexisting field/i.test(msg)) return 'field';
  // "Object with ID … does not exist, cannot be loaded due to missing permissions …" is a missing video, not a missing permission.
  if (code === 803 || (code === 100 && Number(err?.error_subcode) === 33) || /does not exist|do not exist/i.test(msg)) return 'gone';
  if (([10, 200].includes(code) || /permission/i.test(msg)) && !/viewers/i.test(msg)) return 'permission';
  return 'other';
}

export function statsEngine({ call, publishStatus, freshToken, db, GRAPH, TIKTOK, HttpError }) {
  /** A working sign-in for the account behind `row`; one per account and run. */
  async function tokenFor(env, row, budget, cache) {
    const key = `${row.user_id}\n${row.account_id}`;
    if (cache.has(key)) return cache.get(key);
    // Renewing the sign-in is one more request.
    if (row.expires_at && row.expires_at - 120_000 <= now() && !budget.take()) throw OUT_OF_BUDGET;
    const token = await freshToken(env, row);
    cache.set(key, token);
    return token;
  }

  // ---------- reading the numbers, platform by platform ----------
  // Each reader answers remote_id → { views, likes, …, posted_at?, url?, note? } or { error }.
  // Videos it didn't get to (out of requests, rate limit) are left out and stay due.
  // A sign-in that no longer works is thrown (signInError): the whole account gets one message.

  /**
   * Meta's batch API: up to 50 requests in one, each with its own answer – so one deleted
   * video doesn't spoil the others. Returns [{ data } | { error }] in the order of `paths`,
   * or null when the run is out of requests.
   */
  async function graphBatch(token, paths, budget) {
    if (!budget.take()) return null;
    let res;
    try {
      res = await call(`${GRAPH}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: token, include_headers: 'false', batch: JSON.stringify(paths.map((relative_url) => ({ method: 'GET', relative_url }))) }),
      });
    } catch (e) {
      const kind = metaKind(e.detail || { message: e.message });
      if (kind === 'signin' || signInProblem(e)) throw signInError(e.message);
      // Meta is busy or the request as a whole failed: these videos stay due.
      return paths.map(() => ({ error: { message: e.message, ...(e.detail || {}), is_transient: kind === 'later' || kind === 'other' } }));
    }
    if (!Array.isArray(res)) return paths.map(() => ({ error: { message: 'Meta hat unerwartet geantwortet.', is_transient: true } }));
    return paths.map((_, i) => {
      const r = res[i];
      if (!r) return { error: { message: 'Zeitüberschreitung bei Meta', is_transient: true } };
      let body = {};
      try { body = JSON.parse(r.body || '{}'); } catch { /* keep {} */ }
      if (r.code >= 200 && r.code < 300 && !body.error) return { data: body };
      return { error: { message: body.error?.message || `HTTP ${r.code}`, code: body.error?.code, error_subcode: body.error?.error_subcode, is_transient: body.error?.is_transient, status: r.code } };
    });
  }

  async function readYouTube(token, ids, budget) {
    const out = new Map();
    for (const part of chunks(ids, 50)) {
      if (!budget.take()) break;
      try {
        const r = await call(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${part.map(encodeURIComponent).join(',')}`, { headers: { Authorization: `Bearer ${token}` } });
        const found = new Map((r.items || []).map((v) => [v.id, v.statistics || {}]));
        for (const id of part) {
          const s = found.get(id);
          out.set(id, s ? { views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount) } : { error: 'YouTube findet dieses Video nicht (mehr) – gelöscht oder auf einem anderen Kanal?' });
        }
      } catch (e) {
        const reason = e.detail?.errors?.[0]?.reason || '';
        // Quota used up or YouTube busy: try in a later run.
        if (/quotaExceeded|rateLimitExceeded|userRateLimitExceeded|backendError/.test(reason) || Number(e.detail?.code) >= 500) break;
        if (Number(e.detail?.code) === 401) throw signInError(e.message);
        const scope = e.detail?.status === 'PERMISSION_DENIED' || /insufficient|scope/i.test(e.message);
        const msg = scope ? 'YouTube erlaubt das Lesen der Statistiken nicht – verbinde YouTube unter „Verbundene Konten“ neu.' : `YouTube: ${e.message}`;
        for (const id of part) out.set(id, { error: msg });
      }
    }
    return out;
  }

  // Instagram, in up to three steps per video: with insights (needs instagram_manage_insights),
  // with the media's own counters, with likes and comments only.
  const IG_BASE = 'like_count,comments_count,timestamp,permalink';
  const IG_STEPS = [
    { key: 'insights', fields: `${IG_BASE},insights.metric(views,reach,shares,saved)` },
    { key: 'counts', fields: `${IG_BASE},total_views_count,shares_count,saved_count` },
    { key: 'base', fields: IG_BASE },
  ];
  const IG_GONE = 'Instagram findet dieses Video nicht mehr – gelöscht?';
  const IG_NOTES = {
    counts: { permission: 'Die Reichweite liefert Instagram erst mit der Statistik-Berechtigung. Verbinde Instagram dafür unter „Verbundene Konten“ neu.', other: null },
    base: {
      permission: 'Aufrufe, Reichweite, Geteilt und Gespeichert liefert Instagram erst mit der Statistik-Berechtigung. Verbinde Instagram dafür unter „Verbundene Konten“ neu.',
      other: 'Für dieses Video liefert Instagram nur Likes und Kommentare.',
    },
  };

  function igValues(m, step, why) {
    const ins = Object.fromEntries((m.insights?.data || []).map((d) => [d.name, d.values?.[0]?.value ?? d.total_value?.value]));
    const v = {
      likes: num(m.like_count), comments: num(m.comments_count), posted_at: parseTime(m.timestamp), url: m.permalink || null,
      views: num(ins.views ?? m.total_views_count), shares: num(ins.shares ?? m.shares_count), saves: num(ins.saved ?? m.saved_count), reach: num(ins.reach),
      note: step === 'insights' ? null : IG_NOTES[step][why === 'permission' ? 'permission' : 'other'],
    };
    return v;
  }

  async function readInstagram(token, ids, budget) {
    const out = new Map();
    const why = new Map(); // why a video went on to the next step
    let pending = [...ids];
    for (const [s, step] of IG_STEPS.entries()) {
      if (!pending.length) break;
      const next = [];
      for (const part of chunks(pending, 50)) {
        const res = await graphBatch(token, part.map((id) => `${encodeURIComponent(id)}?fields=${encodeURIComponent(step.fields)}`), budget);
        if (!res) return out; // out of requests: the rest stays due
        part.forEach((id, i) => {
          const r = res[i];
          if (r.data) { out.set(id, igValues(r.data, step.key, why.get(id))); return; }
          const kind = metaKind(r.error);
          if (kind === 'signin') throw signInError(r.error.message);
          if (kind === 'later') return; // stays due
          if (kind === 'gone') { out.set(id, { error: IG_GONE }); return; }
          if (s < IG_STEPS.length - 1) {
            if (!why.has(id) || kind === 'permission') why.set(id, kind);
            next.push(id);
            return;
          }
          out.set(id, { error: `Instagram: ${r.error.message}` });
        });
      }
      pending = next;
    }
    return out;
  }

  async function readTikTok(token, ids, budget) {
    const out = new Map();
    for (const part of chunks(ids, 20)) {
      if (!budget.take()) break;
      try {
        const r = await call(`${TIKTOK}/video/query/?fields=id,view_count,like_count,comment_count,share_count,create_time,share_url`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ filters: { video_ids: part } }),
        });
        const found = new Map((r.data?.videos || []).map((v) => [String(v.id), v]));
        for (const id of part) {
          const v = found.get(id);
          out.set(id, v
            ? { views: num(v.view_count), likes: num(v.like_count), comments: num(v.comment_count), shares: num(v.share_count), posted_at: v.create_time ? v.create_time * 1000 : null, url: v.share_url || null }
            : { error: 'TikTok findet dieses Video nicht – gelöscht oder nicht öffentlich?' });
        }
      } catch (e) {
        const code = e.detail?.code;
        if (code === 'rate_limit_exceeded' || code === 'internal_error') break; // try in a later run
        if (code === 'access_token_invalid') throw signInError(e.message);
        const msg = code === 'scope_not_authorized'
          ? 'Für TikTok-Statistiken fehlt noch die Berechtigung „video.list“. Verbinde TikTok dafür unter „Verbundene Konten“ neu.'
          : `TikTok: ${e.message}`;
        for (const id of part) out.set(id, { error: msg });
      }
    }
    return out;
  }

  async function readFacebook(token, ids, budget) {
    const out = new Map();
    const fields = 'created_time,permalink_url,likes.summary(true).limit(0),comments.summary(true).limit(0)';
    for (const part of chunks(ids, 50)) {
      const res = await graphBatch(token, part.map((id) => `${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`), budget);
      if (!res) break;
      part.forEach((id, i) => {
        const r = res[i];
        if (r.data) {
          const v = r.data;
          out.set(id, { likes: num(v.likes?.summary?.total_count), comments: num(v.comments?.summary?.total_count), posted_at: parseTime(v.created_time), url: v.permalink_url ? new URL(v.permalink_url, 'https://www.facebook.com').toString() : null });
          return;
        }
        const kind = metaKind(r.error);
        if (kind === 'signin') throw signInError(r.error.message);
        if (kind === 'later') return;
        out.set(id, { error: kind === 'gone' ? 'Facebook findet dieses Video nicht mehr – gelöscht?' : `Facebook: ${r.error.message}` });
      });
    }
    return out;
  }

  const READERS = { youtube: readYouTube, instagram: readInstagram, tiktok: readTikTok, facebook: readFacebook };

  /**
   * Statements that store readings: ok rows replace the numbers (a number the platform didn't
   * send this time keeps its last value) and add a reading; failed rows keep the numbers.
   */
  function writeStmts(D, ok, failed, t) {
    const where = "stats.user_id = json_extract(u.value, '$.user_id') AND stats.platform = json_extract(u.value, '$.platform') AND stats.remote_id = json_extract(u.value, '$.remote_id')";
    const stmts = [];
    if (ok.length) {
      const json = JSON.stringify(ok);
      stmts.push(D.prepare(`INSERT INTO stat_history (user_id, platform, remote_id, taken_at, ${METRICS.join(', ')})
        SELECT json_extract(value, '$.user_id'), json_extract(value, '$.platform'), json_extract(value, '$.remote_id'), ?, ${METRICS.map((m) => `json_extract(value, '$.${m}')`).join(', ')}
        FROM json_each(?) WHERE json_extract(value, '$.history') = 1 AND (json_extract(value, '$.manual') = 0
          OR NOT EXISTS (SELECT 1 FROM stat_history h WHERE h.user_id = json_extract(value, '$.user_id')
            AND h.platform = json_extract(value, '$.platform') AND h.remote_id = json_extract(value, '$.remote_id') AND h.taken_at > ?))`).bind(t, json, t - HISTORY_GAP_MS));
      stmts.push(D.prepare(`UPDATE stats SET ${METRICS.map((m) => `${m} = COALESCE(json_extract(u.value, '$.${m}'), stats.${m})`).join(', ')},
          posted_at = COALESCE(json_extract(u.value, '$.posted_at'), stats.posted_at), url = COALESCE(json_extract(u.value, '$.url'), stats.url),
          note = json_extract(u.value, '$.note'), error = NULL, fetched_at = ?, checked_at = ?, next_check = json_extract(u.value, '$.next_check')
        FROM json_each(?) AS u WHERE ${where}`).bind(t, t, json));
    }
    if (failed.length) {
      stmts.push(D.prepare(`UPDATE stats SET error = json_extract(u.value, '$.error'), checked_at = ?, next_check = json_extract(u.value, '$.next_check')
        FROM json_each(?) AS u WHERE ${where}`).bind(t, JSON.stringify(failed)));
    }
    return stmts;
  }

  /**
   * Turn readings into rows for writeStmts. `manual`: read on request ("Aktualisieren", linking);
   * a row that was due anyway counts as the scheduled reading.
   */
  function sortReadings(list, results, t, ok, failed, manual = false) {
    for (const x of list) {
      const r = results.get(x.remote_id);
      if (!r) continue; // not read this time: stays due
      const key = { user_id: x.user_id, platform: x.platform, remote_id: x.remote_id };
      if (r.error) {
        const age = t - (x.posted_at || t);
        failed.push({ ...key, error: String(r.error).slice(0, 300), next_check: age < WEEKLY_UNTIL ? t + RETRY_MS : null });
      } else {
        const posted = r.posted_at || x.posted_at || null;
        const extra = manual && !(x.next_check != null && x.next_check <= t);
        ok.push({
          ...key, ...Object.fromEntries(METRICS.map((m) => [m, r[m] ?? null])), posted_at: r.posted_at || null, url: r.url || null, note: r.note || null, next_check: nextCheck(posted, t),
          manual: extra ? 1 : 0, history: !extra || (posted && inWindow(t - posted)) ? 1 : 0,
        });
      }
    }
  }

  /**
   * TikTok drafts (and private posts) get their video id only once they are posted publicly:
   * ask TikTok now and then until it is there.
   */
  async function findTikTokPosts(env, userId, budget, tokens) {
    const D = db(env);
    const t = now();
    const jobs = (await D.prepare(`SELECT j.id, j.user_id, j.account_id, j.container_id, a.platform AS acc_platform, a.access_token, a.refresh_token, a.expires_at
      FROM jobs j JOIN accounts a ON a.user_id = j.user_id AND a.id = j.account_id
      WHERE j.platform = 'tiktok' AND j.status = 'published' AND (j.remote_id IS NULL OR j.remote_id = '') AND j.container_id IS NOT NULL
        AND j.updated_at > ? AND COALESCE(j.remote_checked_at, 0) < ? ${userId ? 'AND j.user_id = ?' : ''}
      ORDER BY COALESCE(j.remote_checked_at, 0) LIMIT 5`).bind(t - DRAFT_LOOK_FOR_MS, t - DRAFT_LOOK_EVERY_MS, ...(userId ? [userId] : [])).all()).results;
    const stmts = [];
    for (const j of jobs) {
      if (budget.left < 4) break;
      let found = null;
      try {
        const token = await tokenFor(env, j, budget, tokens);
        if (!budget.take()) break;
        const res = await publishStatus({ platform: 'tiktok', access_token: token, container_id: j.container_id });
        if (res.video_id) found = res;
      } catch (e) {
        if (e === OUT_OF_BUDGET) break;
        console.log(JSON.stringify({ event: 'tiktok_draft_check_failed', job: j.id, error: String(e.message || e).slice(0, 200) }));
      }
      if (found) {
        stmts.push(D.prepare('UPDATE jobs SET remote_checked_at = ?, remote_id = ?, url = COALESCE(?, url) WHERE id = ?').bind(t, String(found.video_id), found.url || null, j.id));
        stmts.push(trackStmt(D, { user_id: j.user_id, platform: 'tiktok', remote_id: found.video_id, account_id: j.account_id, url: found.url, posted_at: t, next_check: t, job_id: j.id }));
      } else {
        stmts.push(D.prepare('UPDATE jobs SET remote_checked_at = ? WHERE id = ?').bind(t, j.id));
      }
    }
    if (stmts.length) await D.batch(stmts);
    return jobs.length;
  }

  /** Read due numbers (cron), or all of one user's that weren't tried in the last 10 minutes (`force`). */
  async function refresh(env, { userId = null, force = false, budget }) {
    const D = db(env);
    const tokens = new Map();
    await findTikTokPosts(env, userId, budget, tokens).catch((e) => console.log(JSON.stringify({ event: 'tiktok_draft_check_failed', error: String(e.message || e) })));
    // After the drafts: a TikTok video found just now is read in this run already.
    const t = now();
    const rows = (await D.prepare(`SELECT s.user_id, s.platform, s.remote_id, s.account_id, s.posted_at, s.next_check,
        a.platform AS acc_platform, a.access_token, a.refresh_token, a.expires_at
      FROM stats s LEFT JOIN accounts a ON a.user_id = s.user_id AND a.id = s.account_id
      WHERE ${force ? 's.user_id = ? AND a.id IS NOT NULL AND COALESCE(s.checked_at, 0) < ?' : 's.next_check IS NOT NULL AND s.next_check <= ?'}
      ORDER BY ${force ? 's.error IS NOT NULL, COALESCE(s.posted_at, 0) DESC' : 's.next_check'} LIMIT ${MAX_ROWS}`).bind(...(force ? [userId, t - MANUAL_EVERY_MS] : [t])).all()).results;
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.user_id}\n${r.account_id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const ok = [];
    const failed = [];
    for (const list of groups.values()) {
      const first = list[0];
      const name = NAMES[first.platform] || first.platform;
      const ids = list.map((x) => x.remote_id);
      const all = (error) => new Map(ids.map((id) => [id, { error }]));
      let results;
      if (!first.acc_platform) results = all(`Das ${name}-Konto ist nicht mehr verbunden – verbinde es unter „Verbundene Konten“ neu.`);
      else if (first.acc_platform !== first.platform || !READERS[first.platform]) results = all(`Statistiken von ${name} gibt es noch nicht.`);
      else {
        try {
          results = await READERS[first.platform](await tokenFor(env, first, budget, tokens), ids, budget);
        } catch (e) {
          if (e === OUT_OF_BUDGET) break;
          results = all(signInProblem(e)
            ? `Die Anmeldung bei ${name} ist abgelaufen – verbinde das Konto unter „Verbundene Konten“ neu.`
            : String(e.message || e).slice(0, 300));
        }
      }
      sortReadings(list, results, t, ok, failed, force);
      if (budget.left <= 0) break;
    }
    const stmts = writeStmts(D, ok, failed, t);
    if (stmts.length) await D.batch(stmts);
    return { read: ok.length, failed: failed.length, due: rows.length };
  }

  // ---------- for the site ----------
  async function list(userId, env) {
    const D = db(env);
    const items = (await D.prepare(`SELECT id, kind, workflow_id, title, caption, thumbnail_url, permalink, source_media_id, source_account_id, created_at
      FROM items WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).bind(userId).all()).results;
    if (!items.length) return { videos: [] };
    const jobs = (await D.prepare(`SELECT id, item_id, account_id, platform, status, url, remote_id, container_id, options, updated_at FROM jobs
      WHERE user_id = ? AND status = 'published' AND item_id IN (SELECT id FROM items WHERE user_id = ? ORDER BY created_at DESC LIMIT 50)`).bind(userId, userId).all()).results;
    const accounts = new Map((await D.prepare('SELECT id, platform, handle FROM accounts WHERE user_id = ?').bind(userId).all()).results.map((a) => [a.id, a]));
    const sources = new Map((await D.prepare('SELECT id, source_id FROM workflows WHERE user_id = ?').bind(userId).all()).results.map((w) => [w.id, w.source_id]));

    // Only the numbers and readings of the videos shown here.
    const keys = [
      ...items.filter((i) => i.kind !== 'upload').map((i) => ['instagram', i.source_media_id]),
      ...jobs.filter((j) => j.remote_id).map((j) => [j.platform, j.remote_id]),
    ];
    const keyJson = JSON.stringify(keys);
    const inKeys = (t) => `${t}.user_id = ? AND (${t}.platform, ${t}.remote_id) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`;
    const rows = keys.length ? (await D.prepare(`SELECT * FROM stats s WHERE ${inKeys('s')}`).bind(userId, keyJson).all()).results : [];
    // Only the readings the site compares (about 1 h, 24 h, 7 days, 30 days after posting).
    const hist = rows.length
      ? (await D.prepare(`SELECT h.platform, h.remote_id, h.taken_at, ${METRICS.map((m) => `h.${m}`).join(', ')}
          FROM stat_history h JOIN stats s ON s.user_id = h.user_id AND s.platform = h.platform AND s.remote_id = h.remote_id
          WHERE ${inKeys('h')} AND s.posted_at IS NOT NULL AND ${inWindowSql('h.taken_at - s.posted_at')}
          ORDER BY h.taken_at DESC LIMIT 5000`).bind(userId, keyJson).all()).results
      : [];

    const key = (platform, id) => `${platform}\n${id}`;
    const byKey = new Map(rows.map((s) => [key(s.platform, s.remote_id), s]));
    const history = new Map();
    for (const h of hist.reverse()) {
      const k = key(h.platform, h.remote_id);
      if (!history.has(k)) history.set(k, []);
      history.get(k).push([h.taken_at, ...METRICS.map((m) => h[m])]);
    }
    const entry = (platform, accountId, s, extra) => ({
      platform, account_id: accountId, handle: accounts.get(accountId)?.handle ?? null, ...extra,
      ...(s ? {
        state: 'ok', remote_id: s.remote_id, url: s.url, posted_at: s.posted_at, fetched_at: s.fetched_at, next_check: s.next_check, error: s.error, note: s.note,
        ...Object.fromEntries(METRICS.map((m) => [m, s[m]])), history: history.get(key(platform, s.remote_id)) || [],
      } : {}),
    });

    const t = now();
    const videos = [];
    for (const i of items) {
      const entries = [];
      if (i.kind !== 'upload') {
        const accountId = i.source_account_id || sources.get(i.workflow_id);
        const s = byKey.get(key('instagram', i.source_media_id));
        if (s) entries.push(entry('instagram', accountId || s.account_id, s, { source: true, url: i.permalink }));
      }
      for (const j of jobs.filter((x) => x.item_id === i.id)) {
        const s = j.remote_id ? byKey.get(key(j.platform, j.remote_id)) : undefined;
        if (s) { entries.push(entry(j.platform, j.account_id, s, { job_id: j.id })); continue; }
        if (j.platform === 'tiktok') {
          // A TikTok draft or private post: no video id until it is posted publicly – or linked by hand.
          let mode = 'direct';
          try { mode = JSON.parse(j.options || '{}').tiktok_mode === 'inbox' ? 'inbox' : 'direct'; } catch { /* direct */ }
          entries.push(entry('tiktok', j.account_id, null, { job_id: j.id, state: 'link', mode, searching: !!j.container_id && j.updated_at > t - DRAFT_LOOK_FOR_MS, url: j.url }));
        } else entries.push(entry(j.platform, j.account_id, null, { job_id: j.id, state: 'none', url: j.url }));
      }
      if (!entries.length) continue;
      videos.push({
        id: i.id, kind: i.kind, title: i.title || '', caption: String(i.caption || '').slice(0, 300), created_at: i.created_at,
        // Frames from the site (data:) are large; the site has them from the content list.
        thumbnail_url: /^https:/.test(i.thumbnail_url || '') ? i.thumbnail_url : null,
        entries,
      });
    }
    return { videos };
  }

  /** The latest videos of a TikTok account (to link a draft that was posted in the app). */
  async function tiktokVideos(userId, url, env) {
    const D = db(env);
    const acc = await D.prepare('SELECT id AS account_id, user_id, platform AS acc_platform, access_token, refresh_token, expires_at FROM accounts WHERE user_id = ? AND id = ?').bind(userId, url.searchParams.get('account') || '').first();
    if (!acc || acc.acc_platform !== 'tiktok') throw new HttpError(404, 'Dieses TikTok-Konto ist auf dem Server nicht verbunden – lade die Seite neu.');
    const token = await tokenFor(env, acc, budgetOf(3), new Map());
    let r;
    try {
      r = await call(`${TIKTOK}/video/list/?fields=id,title,video_description,create_time,cover_image_url,share_url,view_count`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ max_count: 20 }),
      });
    } catch (e) {
      if (e.detail?.code === 'scope_not_authorized') throw new HttpError(400, 'Dafür braucht TikTok noch die Berechtigung „video.list“. Verbinde TikTok dafür unter „Verbundene Konten“ neu.');
      throw e;
    }
    const videos = r.data?.videos || [];
    const ids = videos.map((v) => String(v.id));
    const linked = new Set(ids.length
      ? (await D.prepare(`SELECT remote_id FROM jobs WHERE user_id = ? AND platform = 'tiktok' AND remote_id IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(ids)).all()).results.map((x) => x.remote_id)
      : []);
    return {
      videos: videos.map((v) => ({
        id: String(v.id), title: String(v.title || v.video_description || '').slice(0, 200), created_at: v.create_time ? v.create_time * 1000 : null,
        cover: /^https:/.test(v.cover_image_url || '') ? v.cover_image_url : null, url: /^https:/.test(v.share_url || '') ? v.share_url : null,
        views: num(v.view_count), linked: linked.has(String(v.id)),
      })),
    };
  }

  /** This TikTok video came from that draft: { job_id, remote_id }. */
  async function link(userId, body, env) {
    const D = db(env);
    const remote = String(body?.remote_id || '');
    if (!/^\d{1,30}$/.test(remote)) throw new HttpError(400, 'Wähle ein TikTok-Video aus.');
    const job = await D.prepare(`SELECT j.id, j.user_id, j.account_id, j.platform, j.status, j.remote_id AS old_remote, a.platform AS acc_platform, a.access_token, a.refresh_token, a.expires_at
      FROM jobs j LEFT JOIN accounts a ON a.user_id = j.user_id AND a.id = j.account_id WHERE j.user_id = ? AND j.id = ?`).bind(userId, String(body?.job_id || '')).first();
    if (!job || job.platform !== 'tiktok' || job.status !== 'published') throw new HttpError(404, 'Diesen TikTok-Post gibt es nicht (mehr).');
    if (!job.acc_platform) throw new HttpError(400, 'Das TikTok-Konto ist nicht mehr verbunden.');
    // Read it right away: shows the numbers and proves the video belongs to this account.
    const budget = budgetOf(3);
    const t = now();
    let res;
    try {
      res = await readTikTok(await tokenFor(env, job, budget, new Map()), [remote], budget);
    } catch (e) {
      throw new HttpError(400, signInProblem(e) ? 'Die Anmeldung bei TikTok ist abgelaufen – verbinde TikTok unter „Verbundene Konten“ neu.' : e.message);
    }
    const r = res.get(remote);
    if (!r || r.error) throw new HttpError(400, r?.error || 'TikTok ist gerade nicht erreichbar – versuch es gleich noch einmal.');
    const ok = [];
    sortReadings([{ user_id: userId, platform: 'tiktok', remote_id: remote, posted_at: r.posted_at, next_check: null }], res, t, ok, [], true);
    await D.batch([
      D.prepare('UPDATE jobs SET remote_id = ?, url = COALESCE(?, url), remote_checked_at = ? WHERE id = ?').bind(remote, r.url || null, t, job.id),
      trackStmt(D, { user_id: userId, platform: 'tiktok', remote_id: remote, account_id: job.account_id, url: r.url, posted_at: r.posted_at, next_check: null, job_id: job.id }),
      ...writeStmts(D, ok, [], t),
      // A video linked before (another choice) is forgotten when nothing else points to it.
      ...cleanupStmts(D, userId, job.old_remote && job.old_remote !== remote ? [['tiktok', job.old_remote]] : []),
    ]);
    return { linked: true };
  }

  /** Routes; undefined for any other path. */
  async function handle(request, env, url, userId) {
    const p = url.pathname;
    const m = request.method;
    if (m === 'GET' && p === '/api/stats') return list(userId, env);
    if (m === 'POST' && p === '/api/stats/refresh') {
      const done = await refresh(env, { userId, force: true, budget: budgetOf(SITE_BUDGET) });
      return { ...(await list(userId, env)), refreshed: done };
    }
    if (m === 'GET' && p === '/api/tiktok/videos') return tiktokVideos(userId, url, env);
    if (m === 'POST' && p === '/api/stats/link') return link(userId, await request.json(), env);
    return undefined;
  }

  /** Hourly cron: read what is due, then drop old readings the site never compares (a few hundred at a time). */
  async function cron(env) {
    const r = await refresh(env, { budget: budgetOf(CRON_BUDGET) });
    const pruned = await db(env).prepare(`DELETE FROM stat_history WHERE rowid IN (SELECT h.rowid FROM stat_history h
        LEFT JOIN stats s ON s.user_id = h.user_id AND s.platform = h.platform AND s.remote_id = h.remote_id
        WHERE h.taken_at < ? AND (s.posted_at IS NULL OR NOT ${inWindowSql('h.taken_at - s.posted_at')}) LIMIT 500)`).bind(now() - 40 * DAY).run()
      .then((x) => x.meta?.changes || 0, () => 0);
    console.log(JSON.stringify({ event: 'stats_cron', ...r, pruned }));
    return { ...r, pruned };
  }

  return { handle, cron };
}
