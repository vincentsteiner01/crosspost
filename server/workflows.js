// Server-side workflows: a new video on Instagram becomes a post on every
// destination – also while the site is closed.
//
// API (everything except /api/session needs "Authorization: Bearer <session key>"):
//   POST   /api/session               prove a connected account, get a session key
//   PUT    /api/sync                  the site hands over its workflows and the accounts they use
//   GET    /api/posts                 videos the workflows picked up, with one job per destination
//   POST   /api/workflows/:id/run     check the source now (takes the newest video if nothing is new)
//   POST   /api/tick                  move this user's due jobs along
//   POST   /api/items/:id/approve     publish jobs that wait for approval
//   POST   /api/items/:id/retry       try failed jobs again
//   DELETE /api/items/:id             forget a video (and its copy)
// Cron (wrangler.toml [triggers]): check the sources and publish what is due.
//
// Needs the bindings DB (D1) and MEDIA (R2), the secret TOKEN_KEY (32 random
// bytes, base64; encrypts the stored sign-ins) and the var PUBLIC_URL (this
// worker's address – TikTok fetches videos from there).

const DESTINATIONS = ['youtube', 'tiktok', 'instagram', 'facebook'];
const CAPTION_LIMITS = { tiktok: 2200, instagram: 2200, youtube: 5000, facebook: 63206 };
// The free Workers plan allows 50 outgoing requests and 50 database queries per run.
const MAX_JOBS_PER_RUN = 3;
const MAX_WORKFLOWS_PER_RUN = 8;
const LEASE_MS = 5 * 60_000;
const STATUS_EVERY_MS = 30_000;
const MAX_STATUS_CHECKS = 40;
// R2 deletes uploads after a day; copy again when the copy is older than this.
const COPY_FRESH_MS = 20 * 3600_000;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const now = () => Date.now();
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const toB64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const firstLine = (s) => (s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
// Instagram writes "+0000"; make it an offset every engine reads.
const parseTime = (s) => Date.parse(String(s || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) || 0;

// ---------- stored sign-ins are encrypted (AES-GCM) ----------
let keyCache;
async function tokenKey(env) {
  if (!env.TOKEN_KEY) throw new Error('Server setting TOKEN_KEY is missing');
  if (keyCache?.raw !== env.TOKEN_KEY) {
    keyCache = { raw: env.TOKEN_KEY, key: await crypto.subtle.importKey('raw', fromB64(env.TOKEN_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']) };
  }
  return keyCache.key;
}
export async function seal(env, text) {
  if (text == null || text === '') return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tokenKey(env), new TextEncoder().encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `v1:${toB64(out)}`;
}
export async function unseal(env, sealed) {
  if (!sealed) return null;
  const raw = fromB64(sealed.slice(3));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await tokenKey(env), raw.slice(12));
  return new TextDecoder().decode(pt);
}

export function workflowEngine({ call, publish, publishStatus, refresh, GRAPH, TIKTOK }) {
  const db = (env) => {
    if (!env.DB) throw new Error('Database DB is not bound');
    return env.DB;
  };
  const publicUrl = (env) => {
    if (!env.PUBLIC_URL) throw new Error('Server setting PUBLIC_URL is missing');
    return env.PUBLIC_URL.replace(/\/$/, '');
  };

  // ---------- who is asking ----------
  async function requireUser(request, env) {
    const m = /^Bearer\s+([0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
    if (!m) throw new HttpError(401, 'Not signed in to the server');
    const row = await db(env).prepare('SELECT user_id FROM sessions WHERE key_hash = ?').bind(await sha256(m[1])).first();
    if (!row) throw new HttpError(401, 'The server session has ended – reload the page');
    return row.user_id;
  }

  /** The platform confirms whose sign-in this is; the answer names the user. */
  async function verifyIdentity({ platform, access_token, account_id }) {
    if (!access_token) throw new Error('access_token is required');
    const t = encodeURIComponent(access_token);
    if (platform === 'instagram') {
      if (!account_id) throw new Error('account_id is required');
      const me = await call(`${GRAPH}/${encodeURIComponent(account_id)}?fields=id&access_token=${t}`);
      if (String(me.id) !== String(account_id)) throw new Error('This sign-in does not belong to that Instagram account');
      return `instagram:${me.id}`;
    }
    if (platform === 'facebook') {
      const me = await call(`${GRAPH}/me?fields=id&access_token=${t}`);
      return `facebook:${me.id}`;
    }
    if (platform === 'tiktok') {
      const me = await call(`${TIKTOK}/user/info/?fields=open_id`, { headers: { Authorization: `Bearer ${access_token}` } });
      const id = me.data?.user?.open_id;
      if (!id) throw new Error('TikTok did not confirm the account');
      return `tiktok:${id}`;
    }
    if (platform === 'youtube') {
      const me = await call('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', { headers: { Authorization: `Bearer ${access_token}` } });
      const id = me.items?.[0]?.id;
      if (!id) throw new Error('This Google account has no YouTube channel');
      return `youtube:${id}`;
    }
    throw new Error(`Signing in with ${platform} is not supported`);
  }

  async function createSession(body, env) {
    const D = db(env);
    const identity = await verifyIdentity(body || {});
    let userId = (await D.prepare('SELECT user_id FROM identities WHERE key = ?').bind(identity).first())?.user_id;
    if (!userId) {
      const fresh = newId();
      await D.batch([
        D.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(fresh, now()),
        D.prepare('INSERT OR IGNORE INTO identities (key, user_id, created_at) VALUES (?, ?, ?)').bind(identity, fresh, now()),
      ]);
      // Two devices at the same moment: the first one wins.
      userId = (await D.prepare('SELECT user_id FROM identities WHERE key = ?').bind(identity).first()).user_id;
    }
    const key = hex(crypto.getRandomValues(new Uint8Array(32)));
    await D.prepare('INSERT INTO sessions (key_hash, user_id, created_at) VALUES (?, ?, ?)').bind(await sha256(key), userId, now()).run();
    return { key };
  }

  // ---------- the site hands over workflows and accounts ----------
  async function sync(userId, body, env) {
    const D = db(env);
    const accounts = (Array.isArray(body?.accounts) ? body.accounts : []).filter((a) => a?.id && a.platform && a.access_token).slice(0, 15);
    const workflows = (Array.isArray(body?.workflows) ? body.workflows : []).filter((w) => w?.id && w.source_id && Array.isArray(w.destination_ids)).slice(0, 15);
    const oldAccounts = new Map((await D.prepare('SELECT id, expires_at FROM accounts WHERE user_id = ?').bind(userId).all()).results.map((r) => [r.id, r]));
    const oldFlows = new Map((await D.prepare('SELECT id, active, active_since FROM workflows WHERE user_id = ?').bind(userId).all()).results.map((r) => [r.id, r]));
    const t = now();
    const stmts = [];

    for (const a of accounts) {
      const old = oldAccounts.get(a.id);
      const expires = Number(a.expires_at) || null;
      if (old?.expires_at && expires && old.expires_at > expires) {
        // The server refreshed this sign-in after the site last did: keep the server's.
        stmts.push(D.prepare('UPDATE accounts SET handle = ?, remote_id = ?, updated_at = ? WHERE user_id = ? AND id = ?').bind(a.handle || null, a.remote_id || null, t, userId, a.id));
        continue;
      }
      stmts.push(D.prepare(`INSERT INTO accounts (user_id, id, platform, handle, remote_id, access_token, refresh_token, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, id) DO UPDATE SET platform = excluded.platform, handle = excluded.handle, remote_id = excluded.remote_id,
          access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, accounts.refresh_token),
          expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
        .bind(userId, a.id, a.platform, a.handle || null, a.remote_id || null, await seal(env, a.access_token), await seal(env, a.refresh_token), expires, t));
    }
    // Disconnected on the site: forget the sign-in here too.
    const keepAccounts = new Set(accounts.map((a) => a.id));
    for (const id of oldAccounts.keys()) if (!keepAccounts.has(id)) stmts.push(D.prepare('DELETE FROM accounts WHERE user_id = ? AND id = ?').bind(userId, id));

    for (const w of workflows) {
      const prev = oldFlows.get(w.id);
      const active = w.active ? 1 : 0;
      // Only videos posted after the workflow was switched on are picked up by themselves.
      const since = active ? (prev?.active && prev.active_since ? prev.active_since : t) : null;
      stmts.push(D.prepare(`INSERT INTO workflows (user_id, id, name, source_id, destination_ids, active, auto_publish, caption_template, hashtags, delay_minutes, active_since)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, source_id = excluded.source_id, destination_ids = excluded.destination_ids,
          active = excluded.active, auto_publish = excluded.auto_publish, caption_template = excluded.caption_template,
          hashtags = excluded.hashtags, delay_minutes = excluded.delay_minutes, active_since = excluded.active_since`)
        .bind(userId, w.id, String(w.name || '').slice(0, 120), w.source_id, JSON.stringify(w.destination_ids.slice(0, 20)), active, w.auto_publish === false ? 0 : 1,
          String(w.caption_template ?? '{caption}').slice(0, 3000), String(w.hashtags || '').slice(0, 1000), Math.max(0, Math.min(10080, Number(w.delay_minutes) || 0)), since));
    }
    const keepFlows = new Set(workflows.map((w) => w.id));
    for (const id of oldFlows.keys()) if (!keepFlows.has(id)) stmts.push(D.prepare('DELETE FROM workflows WHERE user_id = ? AND id = ?').bind(userId, id));

    if (stmts.length) await D.batch(stmts);
    return { ok: true, accounts: accounts.length, workflows: workflows.length };
  }

  // ---------- reading back ----------
  async function listPosts(userId, env) {
    const D = db(env);
    const items = (await D.prepare('SELECT id, workflow_id, caption, permalink, thumbnail_url, created_at FROM items WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(userId).all()).results;
    const jobs = items.length
      ? (await D.prepare(`SELECT id, item_id, account_id, platform, status, caption, url, error, scheduled_at, updated_at FROM jobs
          WHERE user_id = ? AND item_id IN (SELECT id FROM items WHERE user_id = ? ORDER BY created_at DESC LIMIT 50)`).bind(userId, userId).all()).results
      : [];
    const flows = (await D.prepare('SELECT id, active, last_checked, last_error FROM workflows WHERE user_id = ?').bind(userId).all()).results;
    return {
      items: items.map((i) => ({ ...i, jobs: jobs.filter((j) => j.item_id === i.id).map(({ item_id, ...j }) => j) })),
      workflows: flows,
    };
  }

  // ---------- picking up new videos ----------
  function applyTemplate(w, caption) {
    let out = (w.caption_template || '{caption}').replaceAll('{caption}', caption).replaceAll('{title}', firstLine(caption));
    if ((w.hashtags || '').trim()) out += `\n\n${w.hashtags.trim()}`;
    return out.trim();
  }
  function fitCaption(caption, platform) {
    const lim = CAPTION_LIMITS[platform];
    return lim && caption.length > lim ? `${caption.slice(0, lim - 1)}…` : caption;
  }

  async function addItem(env, w, media) {
    const D = db(env);
    const itemId = newId();
    const added = await D.prepare(`INSERT OR IGNORE INTO items (id, user_id, workflow_id, source_media_id, caption, permalink, thumbnail_url, media_timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(itemId, w.user_id, w.id, media.id, media.caption || '', media.permalink || null, media.thumbnail_url || null, media.ts || null, now()).run();
    if (!added.meta?.changes) return 0;
    const accounts = new Map((await D.prepare('SELECT id, platform FROM accounts WHERE user_id = ?').bind(w.user_id).all()).results.map((a) => [a.id, a.platform]));
    const at = now() + (w.delay_minutes || 0) * 60_000;
    const stmts = JSON.parse(w.destination_ids || '[]').filter((id) => id !== w.source_id).map((accountId) => {
      const platform = accounts.get(accountId) || 'unknown';
      let status = w.auto_publish ? 'scheduled' : 'draft';
      let error = null;
      if (!accounts.has(accountId)) { status = 'failed'; error = 'This account is only connected as a demo. Connect it for real, then retry.'; }
      else if (!DESTINATIONS.includes(platform)) { status = 'failed'; error = `Workflows can't post to ${platform} yet.`; }
      return D.prepare('INSERT INTO jobs (id, user_id, item_id, account_id, platform, caption, status, scheduled_at, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(newId(), w.user_id, itemId, accountId, platform, fitCaption(applyTemplate(w, media.caption || ''), platform), status, at, error, now());
    });
    if (stmts.length) await D.batch(stmts);
    return 1;
  }

  /** Look for new videos on the workflow's source. `manual`: take the newest unseen video when nothing is new. */
  async function pollWorkflow(env, w, { manual = false } = {}) {
    const D = db(env);
    const checked = now();
    try {
      const src = await D.prepare('SELECT platform, remote_id, access_token FROM accounts WHERE user_id = ? AND id = ?').bind(w.user_id, w.source_id).first();
      if (!src) throw new Error('The source account is not connected for real.');
      if (src.platform !== 'instagram') throw new Error(`Only Instagram can be a source so far, not ${src.platform}.`);
      const token = await unseal(env, src.access_token);
      const list = await call(`${GRAPH}/${src.remote_id}/media?fields=id,caption,media_type,thumbnail_url,permalink,timestamp&limit=10&access_token=${encodeURIComponent(token)}`);
      const videos = (list.data || []).filter((m) => m.media_type === 'VIDEO').map((m) => ({ ...m, ts: parseTime(m.timestamp) }));
      let fresh = w.active_since ? videos.filter((m) => m.ts > w.active_since) : [];
      if (manual) {
        const known = new Set((await D.prepare('SELECT source_media_id FROM items WHERE user_id = ? AND workflow_id = ?').bind(w.user_id, w.id).all()).results.map((r) => r.source_media_id));
        fresh = fresh.filter((m) => !known.has(m.id));
        if (!fresh.length) {
          const newest = videos.find((m) => !known.has(m.id));
          fresh = newest ? [newest] : [];
        }
      }
      let found = 0;
      // Oldest first, a few per run.
      for (const m of fresh.sort((a, b) => a.ts - b.ts).slice(0, 3)) found += await addItem(env, w, m);
      await D.prepare('UPDATE workflows SET last_checked = ?, last_error = NULL WHERE user_id = ? AND id = ?').bind(checked, w.user_id, w.id).run();
      return found;
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      await D.prepare('UPDATE workflows SET last_checked = ?, last_error = ? WHERE user_id = ? AND id = ?').bind(checked, msg, w.user_id, w.id).run();
      if (manual) throw e;
      console.log(JSON.stringify({ event: 'poll_failed', workflow: w.id, error: msg }));
      return 0;
    }
  }

  // ---------- publishing ----------
  async function freshToken(env, job) {
    const access = await unseal(env, job.access_token);
    if (!job.expires_at || job.expires_at - 120_000 > now()) return access;
    const rt = await unseal(env, job.refresh_token);
    if (!rt) throw new Error('The sign-in has expired – connect the account again.');
    const t = await refresh({ platform: job.acc_platform, refresh_token: rt }, env);
    await db(env).prepare('UPDATE accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, updated_at = ? WHERE user_id = ? AND id = ?')
      .bind(await seal(env, t.access_token), await seal(env, t.refresh_token), t.expires_in ? now() + t.expires_in * 1000 : null, now(), job.user_id, job.account_id).run();
    return t.access_token;
  }

  /** Our own copy of the video in R2: platforms fetch it from PUBLIC_URL, YouTube gets it uploaded. */
  async function ensureCopy(env, job) {
    const D = db(env);
    const item = await D.prepare('SELECT id, user_id, workflow_id, source_media_id, r2_key, copied_at FROM items WHERE id = ?').bind(job.item_id).first();
    if (!item) throw new Error('The video was deleted.');
    if (item.r2_key && now() - (item.copied_at || 0) < COPY_FRESH_MS && await env.MEDIA.head(item.r2_key)) return item.r2_key;
    // Ask Instagram for a fresh download address with the source account's sign-in.
    const src = await D.prepare(`SELECT a.access_token FROM workflows w JOIN accounts a ON a.user_id = w.user_id AND a.id = w.source_id
      WHERE w.user_id = ? AND w.id = ?`).bind(item.user_id, item.workflow_id).first();
    if (!src) throw new Error('The workflow or its source account is gone.');
    const token = await unseal(env, src.access_token);
    const media = await call(`${GRAPH}/${item.source_media_id}?fields=media_url&access_token=${encodeURIComponent(token)}`);
    if (!media.media_url) throw new Error('Instagram did not give a download address for this video.');
    const res = await fetch(media.media_url);
    if (!res.ok || !res.body) throw new Error(`Downloading the video from Instagram failed (${res.status}).`);
    const key = `wf/${item.id}-${now().toString(36)}.mp4`;
    const meta = { httpMetadata: { contentType: 'video/mp4' } };
    const len = Number(res.headers.get('Content-Length'));
    if (len > 0) {
      // Stream straight into R2 – the video never sits in memory.
      const { readable, writable } = new FixedLengthStream(len);
      await Promise.all([res.body.pipeTo(writable), env.MEDIA.put(key, readable, meta)]);
    } else {
      await env.MEDIA.put(key, await res.arrayBuffer(), meta);
    }
    if (item.r2_key) await env.MEDIA.delete(item.r2_key).catch(() => {});
    await D.prepare('UPDATE items SET r2_key = ?, copied_at = ? WHERE id = ?').bind(key, now(), item.id).run();
    return key;
  }

  async function googleReason(res) {
    const text = await res.text();
    try {
      const e = JSON.parse(text).error;
      const reason = e?.errors?.[0]?.reason;
      return reason ? `${e.message} (${reason})` : e?.message || `HTTP ${res.status}`;
    } catch { return `HTTP ${res.status}`; }
  }

  /** YouTube: resumable upload from our R2 copy. */
  async function youtubeUpload(env, token, key, caption) {
    const obj = await env.MEDIA.get(key);
    if (!obj) throw new Error('The copy of the video is gone – retry to copy it again.');
    const clean = (s) => s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    const meta = {
      snippet: { title: (clean(firstLine(caption)) || 'Video').slice(0, 100), description: caption.replace(/[<>]/g, '').slice(0, 5000), categoryId: '22' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    };
    const start = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(obj.size) },
      body: JSON.stringify(meta),
    });
    if (!start.ok) { await obj.body.cancel().catch(() => {}); throw new Error(`YouTube refused the upload: ${await googleReason(start)}`); }
    const location = start.headers.get('Location');
    if (!location) { await obj.body.cancel().catch(() => {}); throw new Error('YouTube did not give an upload address.'); }
    const { readable, writable } = new FixedLengthStream(obj.size);
    const [put] = await Promise.all([fetch(location, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: readable }), obj.body.pipeTo(writable)]);
    if (!put.ok) throw new Error(`Uploading to YouTube failed: ${await googleReason(put)}`);
    const video = await put.json();
    return { id: video.id, url: `https://www.youtube.com/watch?v=${video.id}` };
  }

  async function runJob(env, job) {
    const set = (fields) => {
      const keys = Object.keys(fields);
      return db(env).prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, lease_until = NULL, updated_at = ? WHERE id = ?`)
        .bind(...keys.map((k) => fields[k]), now(), job.id).run();
    };
    try {
      if (!job.acc_platform) throw new Error('This account is no longer connected for real.');
      const platform = job.acc_platform;
      if (!DESTINATIONS.includes(platform)) throw new Error(`Workflows can't post to ${platform} yet.`);
      const token = await freshToken(env, job);
      let res;
      if (job.status === 'processing') {
        if (job.attempts >= MAX_STATUS_CHECKS) throw new Error(`${platform} was still processing the video after 20 minutes. Check the account itself.`);
        res = await publishStatus({ platform, access_token: token, account_id: job.remote_id, container_id: job.container_id });
      } else {
        const key = await ensureCopy(env, job);
        res = platform === 'youtube'
          ? await youtubeUpload(env, token, key, job.caption || '')
          : await publish({ platform, access_token: token, account_id: job.remote_id, caption: job.caption || '', title: firstLine(job.caption), video_url: `${publicUrl(env)}/media/${key}` }, env);
      }
      if (res.pending) await set({ status: 'processing', container_id: res.container_id || job.container_id, scheduled_at: now() + STATUS_EVERY_MS, attempts: (job.attempts || 0) + 1 });
      else await set({ status: 'published', url: res.url || null, error: null });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 500);
      console.log(JSON.stringify({ event: 'job_failed', job: job.id, platform: job.platform, error: msg }));
      await set({ status: 'failed', error: msg });
    }
  }

  /** Publish what is due (a few per run). `userId`: only that user's jobs. */
  async function processDue(env, userId) {
    const D = db(env);
    const t = now();
    const due = (await D.prepare(`SELECT j.*, a.platform AS acc_platform, a.remote_id, a.access_token, a.refresh_token, a.expires_at
      FROM jobs j LEFT JOIN accounts a ON a.user_id = j.user_id AND a.id = j.account_id
      WHERE j.status IN ('scheduled', 'processing') AND j.scheduled_at <= ? AND (j.lease_until IS NULL OR j.lease_until < ?)
      ${userId ? 'AND j.user_id = ?' : ''} ORDER BY j.scheduled_at LIMIT ?`)
      .bind(...(userId ? [t, t, userId, MAX_JOBS_PER_RUN] : [t, t, MAX_JOBS_PER_RUN])).all()).results;
    let done = 0;
    for (const job of due) {
      // The cron and the site may run at once: whoever takes the lease does the job.
      const claim = await D.prepare('UPDATE jobs SET lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)').bind(t + LEASE_MS, job.id, t).run();
      if (!claim.meta?.changes) continue;
      await runJob(env, job);
      done++;
    }
    return done;
  }

  async function runNow(userId, id, env) {
    const w = await db(env).prepare('SELECT * FROM workflows WHERE user_id = ? AND id = ?').bind(userId, id).first();
    if (!w) throw new HttpError(404, 'This workflow is not on the server yet.');
    const found = await pollWorkflow(env, w, { manual: true });
    return { found, processed: await processDue(env, userId) };
  }

  async function itemAction(userId, itemId, action, env) {
    const D = db(env);
    const item = await D.prepare('SELECT id, r2_key FROM items WHERE user_id = ? AND id = ?').bind(userId, itemId).first();
    if (!item) throw new HttpError(404, 'Not found');
    const t = now();
    if (action === 'approve') {
      const r = await D.prepare("UPDATE jobs SET status = 'scheduled', scheduled_at = MAX(scheduled_at, ?), updated_at = ? WHERE user_id = ? AND item_id = ? AND status = 'draft'").bind(t, t, userId, itemId).run();
      return { changed: r.meta?.changes || 0 };
    }
    if (action === 'retry') {
      const r = await D.prepare(`UPDATE jobs SET status = 'scheduled', error = NULL, container_id = NULL, attempts = 0, lease_until = NULL, scheduled_at = ?, updated_at = ?,
        platform = COALESCE((SELECT platform FROM accounts WHERE accounts.user_id = jobs.user_id AND accounts.id = jobs.account_id), platform)
        WHERE user_id = ? AND item_id = ? AND status = 'failed'`).bind(t, t, userId, itemId).run();
      return { changed: r.meta?.changes || 0 };
    }
    await D.batch([D.prepare('DELETE FROM jobs WHERE user_id = ? AND item_id = ?').bind(userId, itemId), D.prepare('DELETE FROM items WHERE user_id = ? AND id = ?').bind(userId, itemId)]);
    if (item.r2_key && env.MEDIA) await env.MEDIA.delete(item.r2_key).catch(() => {});
    return { deleted: true };
  }

  /** Routes under /api/. Returns undefined for any other path. */
  async function handle(request, env, url) {
    const p = url.pathname;
    const m = request.method;
    if (!p.startsWith('/api/')) return undefined;
    if (m === 'POST' && p === '/api/session') return createSession(await request.json(), env);
    const userId = await requireUser(request, env);
    if (m === 'PUT' && p === '/api/sync') return sync(userId, await request.json(), env);
    if (m === 'GET' && p === '/api/posts') return listPosts(userId, env);
    if (m === 'POST' && p === '/api/tick') return { processed: await processDue(env, userId) };
    let r = /^\/api\/workflows\/([\w-]{1,64})\/run$/.exec(p);
    if (m === 'POST' && r) return runNow(userId, r[1], env);
    r = /^\/api\/items\/([\w-]{1,64})(?:\/(approve|retry))?$/.exec(p);
    if (r && ((m === 'POST' && r[2]) || (m === 'DELETE' && !r[2]))) return itemAction(userId, r[1], r[2] || 'delete', env);
    throw new HttpError(404, 'Not found');
  }

  /** Cron: check the sources that waited longest, then publish what is due. */
  async function scheduled(env) {
    const flows = (await db(env).prepare('SELECT * FROM workflows WHERE active = 1 ORDER BY COALESCE(last_checked, 0) LIMIT ?').bind(MAX_WORKFLOWS_PER_RUN).all()).results;
    let found = 0;
    for (const w of flows) found += await pollWorkflow(env, w);
    const jobs = await processDue(env);
    console.log(JSON.stringify({ event: 'cron', workflows: flows.length, found, jobs }));
    return { workflows: flows.length, found, jobs };
  }

  return { handle, scheduled, requireUser };
}
