// Server-side workflows: a new video on Instagram becomes a post on every
// destination – also while the site is closed.
//
// API (everything except /api/session needs "Authorization: Bearer <session key>"):
//   POST   /api/session               prove a connected account, get a session key
//   PUT    /api/sync                  a device hands over its sign-ins and workflows (adds and updates; removes only what it names)
//   GET    /api/state                 accounts (without sign-ins) and workflows, for every device
//   POST   /api/inbox                 send a video in (raw body), e.g. from the iPhone share menu; answers with a link to post it
//   GET    /api/inbox, DELETE /api/inbox/:id
//   POST   /api/shortcut-key          a key for the iPhone Shortcut (replaces the previous one)
//   POST   /api/link                  { code } → session key; one-time codes come with the inbox link
//   GET    /api/posts                 videos the workflows picked up, with one job per destination
//   POST   /api/workflows/:id/run     check the source now (takes the newest video if nothing is new)
//   POST   /api/posts                 plan a post: an uploaded file or an existing Instagram video, to many accounts
//   GET    /api/instagram/media       the videos on a connected Instagram account (to cross-post older ones)
//   POST   /api/tick                  move this user's due jobs along
//   POST   /api/items/:id/approve     publish jobs that wait for approval
//   POST   /api/items/:id/retry       try failed jobs again
//   DELETE /api/items/:id             forget a video (and its copy)
//   /api/stats…                       views, likes, comments per platform (see stats.js)
// Cron (wrangler.toml [triggers]): check the sources and publish what is due; hourly: read the statistics.
//
// Needs the bindings DB (D1) and MEDIA (R2), the secret TOKEN_KEY (32 random
// bytes, base64; encrypts the stored sign-ins) and the vars PUBLIC_URL (this
// worker's address – TikTok fetches videos from there) and SITE_URL (the app's
// address, for links the inbox hands out).

import { cleanupStmts, nextCheck, statsEngine, trackStmt } from './stats.js';

const DESTINATIONS = ['youtube', 'tiktok', 'instagram', 'facebook'];
const CAPTION_LIMITS = { tiktok: 2200, instagram: 2200, youtube: 5000, facebook: 63206 };
// The free Workers plan allows 50 outgoing requests and 50 database queries per run.
const MAX_JOBS_PER_RUN = 3;
const MAX_WORKFLOWS_PER_RUN = 8;
const LEASE_MS = 5 * 60_000;
const STATUS_EVERY_MS = 30_000;
const MAX_STATUS_CHECKS = 40;
// R2 deletes copies (wf/) after a day or two; copy again when the copy is older than this.
const COPY_FRESH_MS = 20 * 3600_000;

/** Keep only the per-destination settings we know, with sane values. */
function cleanOptions(platform, o) {
  if (!o || typeof o !== 'object') return {};
  if (platform === 'instagram') return ['MANUAL', 'SS_PERFORMANCE'].includes(o.trial) ? { trial: o.trial } : {};
  if (platform === 'tiktok') return ['inbox', 'direct'].includes(o.tiktok_mode) ? { tiktok_mode: o.tiktok_mode } : {};
  if (platform === 'youtube') {
    return {
      title: typeof o.title === 'string' ? o.title.slice(0, 100) : undefined,
      privacy: ['public', 'unlisted', 'private'].includes(o.privacy) ? o.privacy : undefined,
      categoryId: /^\d{1,3}$/.test(o.categoryId || '') ? o.categoryId : undefined,
      tags: typeof o.tags === 'string' ? o.tags.slice(0, 500) : undefined,
      madeForKids: o.madeForKids === true,
      short: o.short === true,
    };
  }
  return {};
}
const LICENSED = 'Instagram gibt dieses Video nicht zum Herunterladen frei – meist, weil es lizenzierte Musik enthält. Lade stattdessen die Originaldatei hoch.';

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
  if (!env.TOKEN_KEY) throw new Error('Server-Einstellung TOKEN_KEY fehlt');
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
    if (!env.DB) throw new Error('Datenbank DB ist nicht eingebunden');
    return env.DB;
  };
  const publicUrl = (env) => {
    if (!env.PUBLIC_URL) throw new Error('Server-Einstellung PUBLIC_URL fehlt');
    return env.PUBLIC_URL.replace(/\/$/, '');
  };
  const stats = statsEngine({ call, publishStatus, freshToken, db, GRAPH, TIKTOK, HttpError });
  /** Statistics are extra: a problem there never stops a post. */
  const followStats = (env, stmts) => (stmts.length ? db(env).batch(stmts).catch((e) => console.log(JSON.stringify({ event: 'stats_track_failed', error: String(e.message || e) }))) : undefined);

  // ---------- who is asking ----------
  async function requireUser(request, env) {
    const m = /^Bearer\s+([0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
    if (!m) throw new HttpError(401, 'Nicht beim Server angemeldet');
    const row = await db(env).prepare('SELECT user_id FROM sessions WHERE key_hash = ?').bind(await sha256(m[1])).first();
    if (!row) throw new HttpError(401, 'Die Sitzung beim Server ist abgelaufen – lade die Seite neu');
    return row.user_id;
  }

  /** The platform confirms whose sign-in this is; the answer names the user. */
  async function verifyIdentity({ platform, access_token, account_id }) {
    if (!access_token) throw new Error('access_token ist erforderlich');
    const t = encodeURIComponent(access_token);
    if (platform === 'instagram') {
      if (!account_id) throw new Error('account_id ist erforderlich');
      const me = await call(`${GRAPH}/${encodeURIComponent(account_id)}?fields=id&access_token=${t}`);
      if (String(me.id) !== String(account_id)) throw new Error('Diese Anmeldung gehört nicht zu diesem Instagram-Konto');
      return `instagram:${me.id}`;
    }
    if (platform === 'facebook') {
      const me = await call(`${GRAPH}/me?fields=id&access_token=${t}`);
      return `facebook:${me.id}`;
    }
    if (platform === 'tiktok') {
      const me = await call(`${TIKTOK}/user/info/?fields=open_id`, { headers: { Authorization: `Bearer ${access_token}` } });
      const id = me.data?.user?.open_id;
      if (!id) throw new Error('TikTok hat das Konto nicht bestätigt');
      return `tiktok:${id}`;
    }
    if (platform === 'youtube') {
      const me = await call('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', { headers: { Authorization: `Bearer ${access_token}` } });
      const id = me.items?.[0]?.id;
      if (!id) throw new Error('Dieses Google-Konto hat keinen YouTube-Kanal');
      return `youtube:${id}`;
    }
    throw new Error(`Anmelden mit ${platform} wird nicht unterstützt`);
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
    return { key: await newSession(env, userId, 'web') };
  }

  async function newSession(env, userId, label) {
    const key = hex(crypto.getRandomValues(new Uint8Array(32)));
    await db(env).prepare('INSERT INTO sessions (key_hash, user_id, created_at, label) VALUES (?, ?, ?, ?)').bind(await sha256(key), userId, now(), label).run();
    return key;
  }

  /** One-time code for a link that signs a browser in (15 minutes). */
  async function newLinkCode(env, userId) {
    const code = hex(crypto.getRandomValues(new Uint8Array(24)));
    await db(env).prepare('INSERT INTO link_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(code), userId, now() + 15 * 60_000).run();
    return code;
  }

  async function useLinkCode(body, env) {
    const D = db(env);
    const code = String(body?.code || '');
    if (!/^[0-9a-f]{48}$/.test(code)) throw new HttpError(400, 'Dieser Link ist ungültig.');
    const hash = await sha256(code);
    const row = await D.prepare('SELECT user_id, expires_at FROM link_codes WHERE code_hash = ?').bind(hash).first();
    await D.prepare('DELETE FROM link_codes WHERE code_hash = ? OR expires_at < ?').bind(hash, now()).run();
    if (!row || row.expires_at < now()) throw new HttpError(400, 'Dieser Link ist abgelaufen – teile das Video noch einmal oder verbinde Instagram auf diesem Gerät.');
    return { key: await newSession(env, row.user_id, 'web') };
  }

  async function shortcutKey(userId, env) {
    // One Shortcut key at a time: a new one ends the old one.
    await db(env).prepare("DELETE FROM sessions WHERE user_id = ? AND label = 'shortcut'").bind(userId).run();
    return { key: await newSession(env, userId, 'shortcut') };
  }

  // ---------- the site hands over workflows and accounts ----------
  async function sync(userId, body, env) {
    const D = db(env);
    const accounts = (Array.isArray(body?.accounts) ? body.accounts : []).filter((a) => a?.id && a.platform && a.access_token).slice(0, 25);
    const workflows = (Array.isArray(body?.workflows) ? body.workflows : []).filter((w) => w?.id && w.source_id && Array.isArray(w.destination_ids)).slice(0, 25);
    const ids = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.length <= 64).slice(0, 50) : []);
    const removedAccounts = ids(body?.removed?.accounts);
    const removedFlows = ids(body?.removed?.workflows);
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
    // Each device sends what it knows; only what it explicitly removed goes (another device may know more).
    for (const id of removedAccounts) stmts.push(D.prepare('DELETE FROM accounts WHERE user_id = ? AND id = ?').bind(userId, id));

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
    for (const id of removedFlows) stmts.push(D.prepare('DELETE FROM workflows WHERE user_id = ? AND id = ?').bind(userId, id));

    if (stmts.length) await D.batch(stmts);
    return { ok: true, accounts: accounts.length, workflows: workflows.length };
  }

  /** What every device should show: accounts (never their sign-ins) and workflows. */
  async function state(userId, env) {
    const D = db(env);
    const accounts = (await D.prepare('SELECT id, platform, handle, remote_id, expires_at, refresh_token IS NOT NULL AS renewable, updated_at FROM accounts WHERE user_id = ? ORDER BY updated_at').bind(userId).all()).results;
    const workflows = (await D.prepare('SELECT id, name, source_id, destination_ids, active, auto_publish, caption_template, hashtags, delay_minutes, last_checked, last_error FROM workflows WHERE user_id = ?').bind(userId).all()).results;
    return {
      accounts: accounts.map((a) => ({ ...a, renewable: !!a.renewable })),
      workflows: workflows.map((w) => ({ ...w, destination_ids: JSON.parse(w.destination_ids || '[]'), active: !!w.active, auto_publish: !!w.auto_publish })),
    };
  }

  // ---------- inbox: videos sent in, waiting to be posted ----------
  async function addToInbox(userId, request, url, env) {
    if (!env.SITE_URL) throw new Error('Server-Einstellung SITE_URL fehlt');
    const name = (url.searchParams.get('name') || 'video.mp4').replace(/[^\w.-]+/g, '_').slice(-80);
    const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
    const mediaType = /^video\//.test(type) ? type : 'video/mp4';
    const id = newId();
    const key = `inbox/${id}-${name}`;
    // R2 needs to know the length up front; without it, read the body first (Workers allow 100 MB per request).
    const length = Number(request.headers.get('Content-Length'));
    const body = length > 0 ? request.body : await request.arrayBuffer();
    const put = await env.MEDIA.put(key, body, { httpMetadata: { contentType: mediaType } });
    const size = put?.size ?? (length > 0 ? length : body.byteLength);
    if (!size) { await env.MEDIA.delete(key).catch(() => {}); throw new HttpError(400, 'Es ist kein Video angekommen – teile direkt die Videodatei.'); }
    await db(env).prepare('INSERT INTO inbox (id, user_id, r2_key, name, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, userId, key, name, mediaType, size, now()).run();
    const code = await newLinkCode(env, userId);
    return { id, open_url: `${env.SITE_URL.replace(/\/?$/, '/')}#/create?inbox=${id}&link=${code}` };
  }

  async function listInbox(userId, env) {
    const rows = (await db(env).prepare('SELECT id, r2_key, name, type, size, created_at FROM inbox WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(userId).all()).results;
    return { items: rows.map(({ r2_key, ...r }) => ({ ...r, url: `${publicUrl(env)}/media/${r2_key}` })) };
  }

  async function removeFromInbox(userId, id, env) {
    const D = db(env);
    const row = await D.prepare('SELECT r2_key FROM inbox WHERE user_id = ? AND id = ?').bind(userId, id).first();
    if (!row) throw new HttpError(404, 'Nicht gefunden');
    await D.prepare('DELETE FROM inbox WHERE user_id = ? AND id = ?').bind(userId, id).run();
    await env.MEDIA.delete(row.r2_key).catch(() => {});
    return { deleted: true };
  }

  // ---------- reading back ----------
  async function listPosts(userId, env) {
    const D = db(env);
    const items = (await D.prepare('SELECT id, kind, workflow_id, title, caption, permalink, thumbnail_url, source_media_id, source_account_id, created_at FROM items WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(userId).all()).results;
    const jobs = items.length
      ? (await D.prepare(`SELECT id, item_id, account_id, platform, status, caption, url, error, scheduled_at, updated_at, options FROM jobs
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
      if (!accounts.has(accountId)) { status = 'failed'; error = 'Dieses Konto ist nur als Demo verbunden. Verbinde es live und versuch es dann noch einmal.'; }
      else if (!DESTINATIONS.includes(platform)) { status = 'failed'; error = `Workflows können noch nicht auf ${platform} posten.`; }
      const options = platform === 'tiktok' ? { tiktok_mode: env.TIKTOK_DEFAULT_MODE === 'direct' ? 'direct' : 'inbox' } : {};
      return D.prepare('INSERT INTO jobs (id, user_id, item_id, account_id, platform, caption, status, scheduled_at, error, options, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(newId(), w.user_id, itemId, accountId, platform, fitCaption(applyTemplate(w, media.caption || ''), platform), status, at, error, JSON.stringify(options), now());
    });
    if (stmts.length) await D.batch(stmts);
    // The original on Instagram goes into the statistics too.
    await followStats(env, [trackStmt(D, { user_id: w.user_id, platform: 'instagram', remote_id: media.id, account_id: w.source_id, url: media.permalink, posted_at: media.ts || now(), next_check: now() })]);
    return 1;
  }

  /** Look for new videos on the workflow's source. `manual`: take the newest unseen video when nothing is new. */
  async function pollWorkflow(env, w, { manual = false } = {}) {
    const D = db(env);
    const checked = now();
    try {
      const src = await D.prepare('SELECT platform, remote_id, access_token FROM accounts WHERE user_id = ? AND id = ?').bind(w.user_id, w.source_id).first();
      if (!src) throw new Error('Das Quellkonto ist nicht live verbunden.');
      if (src.platform !== 'instagram') throw new Error(`Bisher kann nur Instagram eine Quelle sein, nicht ${src.platform}.`);
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
    if (!rt) throw new Error('Die Anmeldung ist abgelaufen – verbinde das Konto neu.');
    const t = await refresh({ platform: job.acc_platform, refresh_token: rt }, env);
    await db(env).prepare('UPDATE accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, updated_at = ? WHERE user_id = ? AND id = ?')
      .bind(await seal(env, t.access_token), await seal(env, t.refresh_token), t.expires_in ? now() + t.expires_in * 1000 : null, now(), job.user_id, job.account_id).run();
    return t.access_token;
  }

  /** Our own copy of the video in R2: platforms fetch it from PUBLIC_URL, YouTube gets it uploaded. */
  async function ensureCopy(env, job) {
    const D = db(env);
    const item = await D.prepare('SELECT id, kind, user_id, workflow_id, source_media_id, source_account_id, r2_key, copied_at FROM items WHERE id = ?').bind(job.item_id).first();
    if (!item) throw new Error('Das Video wurde gelöscht.');
    if (item.kind === 'upload') {
      if (item.r2_key && await env.MEDIA.head(item.r2_key)) return item.r2_key;
      throw new Error('Das hochgeladene Video ist nicht mehr da – plane den Post noch einmal mit der Datei.');
    }
    if (item.r2_key && now() - (item.copied_at || 0) < COPY_FRESH_MS && await env.MEDIA.head(item.r2_key)) return item.r2_key;
    // Ask Instagram for a fresh download address with the source account's sign-in.
    const src = item.kind === 'instagram'
      ? await D.prepare('SELECT access_token FROM accounts WHERE user_id = ? AND id = ?').bind(item.user_id, item.source_account_id).first()
      : await D.prepare(`SELECT a.access_token FROM workflows w JOIN accounts a ON a.user_id = w.user_id AND a.id = w.source_id
        WHERE w.user_id = ? AND w.id = ?`).bind(item.user_id, item.workflow_id).first();
    if (!src) throw new Error(item.kind === 'instagram' ? 'Das Instagram-Konto ist nicht mehr verbunden.' : 'Den Workflow oder sein Quellkonto gibt es nicht mehr.');
    const token = await unseal(env, src.access_token);
    const media = await call(`${GRAPH}/${item.source_media_id}?fields=media_url&access_token=${encodeURIComponent(token)}`);
    if (!media.media_url) throw new Error(LICENSED);
    const res = await fetch(media.media_url);
    if (!res.ok || !res.body) throw new Error(`Das Video konnte nicht von Instagram geladen werden (${res.status}).`);
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
  async function youtubeUpload(env, token, key, caption, o = {}, itemTitle = '') {
    const obj = await env.MEDIA.get(key);
    if (!obj) throw new Error('Die Kopie des Videos ist nicht mehr da – versuch es erneut, dann wird sie neu angelegt.');
    const clean = (s) => s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    let title = clean(o.title || itemTitle || firstLine(caption)) || 'Video';
    if (o.short && !/#shorts/i.test(title)) title = `${title.slice(0, 92)} #Shorts`;
    const tags = (o.tags || '').split(/[,#]/).map((t) => t.trim()).filter(Boolean);
    const meta = {
      snippet: { title: title.slice(0, 100), description: caption.replace(/[<>]/g, '').slice(0, 5000), categoryId: o.categoryId || '22', ...(tags.length ? { tags } : {}) },
      status: { privacyStatus: o.privacy || 'public', selfDeclaredMadeForKids: !!o.madeForKids },
    };
    const start = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(obj.size) },
      body: JSON.stringify(meta),
    });
    if (!start.ok) { await obj.body.cancel().catch(() => {}); throw new Error(`YouTube hat den Upload abgelehnt: ${await googleReason(start)}`); }
    const location = start.headers.get('Location');
    if (!location) { await obj.body.cancel().catch(() => {}); throw new Error('YouTube hat keine Upload-Adresse geliefert.'); }
    const { readable, writable } = new FixedLengthStream(obj.size);
    const [put] = await Promise.all([fetch(location, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: readable }), obj.body.pipeTo(writable)]);
    if (!put.ok) throw new Error(`Der Upload zu YouTube ist fehlgeschlagen: ${await googleReason(put)}`);
    const video = await put.json();
    return { id: video.id, url: `https://www.youtube.com/watch?v=${video.id}` };
  }

  /** Every destination has the video: our copy is no longer needed. */
  async function dropCopyWhenDone(env, itemId) {
    const D = db(env);
    const left = await D.prepare("SELECT COUNT(*) AS n FROM jobs WHERE item_id = ? AND status != 'published'").bind(itemId).first();
    if (left?.n) return;
    const item = await D.prepare('SELECT r2_key FROM items WHERE id = ?').bind(itemId).first();
    if (!item?.r2_key) return;
    await env.MEDIA.delete(item.r2_key).catch(() => {});
    await D.prepare('UPDATE items SET r2_key = NULL, copied_at = NULL WHERE id = ?').bind(itemId).run();
  }

  async function runJob(env, job) {
    const set = (fields) => {
      const keys = Object.keys(fields);
      return db(env).prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, lease_until = NULL, updated_at = ? WHERE id = ?`)
        .bind(...keys.map((k) => fields[k]), now(), job.id).run();
    };
    try {
      if (!job.acc_platform) throw new Error('Dieses Konto ist nicht mehr verbunden.');
      const platform = job.acc_platform;
      if (!DESTINATIONS.includes(platform)) throw new Error(`Workflows können noch nicht auf ${platform} posten.`);
      const token = await freshToken(env, job);
      let options = {};
      try { options = JSON.parse(job.options || '{}') || {}; } catch { /* keep defaults */ }
      let res;
      if (job.status === 'processing') {
        if (job.attempts >= MAX_STATUS_CHECKS) throw new Error('Die Verarbeitung des Videos dauert schon über 20 Minuten. Schau direkt im Konto nach.');
        // since: an Instagram Reel that went out despite an error is looked up among the newest posts.
        res = await publishStatus({ platform, access_token: token, account_id: job.acc_remote_id, container_id: job.container_id, since: now() - 45 * 60_000, caption: job.caption || '' });
      } else {
        const key = await ensureCopy(env, job);
        res = platform === 'youtube'
          ? await youtubeUpload(env, token, key, job.caption || '', options, job.item_title || '')
          : await publish({ platform, access_token: token, account_id: job.acc_remote_id, caption: job.caption || '', title: job.item_title || firstLine(job.caption), video_url: `${publicUrl(env)}/media/${key}`, options }, env);
      }
      if (res.pending) await set({ status: 'processing', container_id: res.container_id || job.container_id, scheduled_at: now() + STATUS_EVERY_MS, attempts: (job.attempts || 0) + 1 });
      else {
        // The platform's id of the video, for the statistics. TikTok has one only for public posts;
        // drafts get theirs once they are posted (stats.js asks TikTok now and then).
        let remoteId = (platform === 'tiktok' ? res.video_id : res.id) || null;
        let url = res.url || null;
        // A Reel found afterwards (already_published) that another job already has is not this one.
        if (res.already_published && remoteId && await db(env).prepare("SELECT 1 FROM jobs WHERE user_id = ? AND platform = ? AND remote_id = ? AND id != ?").bind(job.user_id, platform, String(remoteId), job.id).first().catch(() => null)) {
          remoteId = null;
          url = null;
        }
        await set({ status: 'published', url, error: null });
        if (remoteId) {
          const D = db(env);
          const t = now();
          await followStats(env, [
            D.prepare('UPDATE jobs SET remote_id = ? WHERE id = ?').bind(String(remoteId), job.id),
            trackStmt(D, { user_id: job.user_id, platform, remote_id: remoteId, account_id: job.account_id, url, posted_at: t, next_check: nextCheck(t, t), job_id: job.id }),
          ]);
        }
        await dropCopyWhenDone(env, job.item_id);
      }
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
    const due = (await D.prepare(`SELECT j.*, a.platform AS acc_platform, a.remote_id AS acc_remote_id, a.access_token, a.refresh_token, a.expires_at, i.title AS item_title
      FROM jobs j LEFT JOIN accounts a ON a.user_id = j.user_id AND a.id = j.account_id LEFT JOIN items i ON i.id = j.item_id
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
    if (!w) throw new HttpError(404, 'Dieser Workflow ist noch nicht auf dem Server.');
    const found = await pollWorkflow(env, w, { manual: true });
    return { found, processed: await processDue(env, userId) };
  }

  /** Plan a post: { title, caption, source, scheduled_at, draft, deliveries: [{ account_id, caption, options }] }. */
  async function createPost(userId, body, env) {
    const D = db(env);
    const src = body?.source || {};
    const deliveries = (Array.isArray(body?.deliveries) ? body.deliveries : []).filter((d) => d?.account_id).slice(0, 15);
    if (!deliveries.length) throw new Error('Wähle mindestens ein Konto aus.');
    const accounts = new Map((await D.prepare('SELECT id, platform FROM accounts WHERE user_id = ?').bind(userId).all()).results.map((a) => [a.id, a.platform]));
    const itemId = newId();
    const t = now();
    const at = Math.max(t, Number(body.scheduled_at) || t);
    let item;
    const stmts = [];
    if (src.type === 'inbox') {
      const row = await D.prepare('SELECT r2_key FROM inbox WHERE user_id = ? AND id = ?').bind(userId, String(src.id || '')).first();
      if (!row || !await env.MEDIA.head(row.r2_key)) throw new Error('Dieses Video ist nicht mehr in deinem Eingang.');
      // The post takes over the file; it leaves the inbox.
      stmts.push(D.prepare('DELETE FROM inbox WHERE user_id = ? AND id = ?').bind(userId, String(src.id)));
      const thumb = typeof src.thumbnail_url === 'string' && src.thumbnail_url.length < 40_000 && /^data:image\/jpeg;base64,[\w+/=]+$/.test(src.thumbnail_url) ? src.thumbnail_url : null;
      item = { kind: 'upload', media: itemId, r2: row.r2_key, copied: t, account: null, permalink: null, thumb };
    } else if (src.type === 'upload') {
      if (!/^(sched|tmp|inbox)\/[\w.-]+$/.test(src.key || '') || !await env.MEDIA.head(src.key)) throw new Error('Das hochgeladene Video wurde nicht gefunden – lade es noch einmal hoch.');
      // A small JPEG frame from the site, for the content list.
      const thumb = typeof src.thumbnail_url === 'string' && src.thumbnail_url.length < 40_000 && /^data:image\/jpeg;base64,[\w+/=]+$/.test(src.thumbnail_url) ? src.thumbnail_url : null;
      item = { kind: 'upload', media: itemId, r2: src.key, copied: t, account: null, permalink: null, thumb };
    } else if (src.type === 'instagram') {
      if (accounts.get(src.account_id) !== 'instagram' || !/^\w{1,40}$/.test(String(src.media_id || ''))) throw new Error('Wähle ein Video von einem verbundenen Instagram-Konto aus.');
      const https = (v) => (typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v) ? v.slice(0, 2000) : null);
      item = { kind: 'instagram', media: String(src.media_id), r2: null, copied: null, account: src.account_id, permalink: https(src.permalink), thumb: https(src.thumbnail_url) };
    } else throw new Error('Füge zuerst ein Video hinzu.');

    stmts.push(D.prepare(`INSERT INTO items (id, user_id, workflow_id, kind, source_media_id, source_account_id, title, caption, permalink, thumbnail_url, r2_key, copied_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(itemId, userId, itemId, item.kind, item.media, item.account, String(body.title || '').slice(0, 200), String(body.caption || '').slice(0, 63206), item.permalink, item.thumb, item.r2, item.copied, t));
    for (const d of deliveries) {
      const platform = accounts.get(d.account_id) || 'unknown';
      let status = body.draft ? 'draft' : 'scheduled';
      let error = null;
      if (!accounts.has(d.account_id)) { status = 'failed'; error = 'Dieses Konto ist nur als Demo verbunden. Verbinde es live und versuch es dann noch einmal.'; }
      else if (!DESTINATIONS.includes(platform)) { status = 'failed'; error = `Der Server kann noch nicht auf ${platform} posten.`; }
      else if (item.kind === 'instagram' && d.account_id === item.account) { status = 'failed'; error = 'Dieses Video ist schon auf diesem Instagram-Konto.'; }
      stmts.push(D.prepare('INSERT INTO jobs (id, user_id, item_id, account_id, platform, caption, status, scheduled_at, error, options, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(newId(), userId, itemId, d.account_id, platform, fitCaption(String(d.caption ?? body.caption ?? ''), platform), status, at, error, JSON.stringify(cleanOptions(platform, d.options)), t));
    }
    await D.batch(stmts);
    // An older Instagram video: its numbers on Instagram go next to the new posts' (the first reading brings its real date).
    if (item.kind === 'instagram') await followStats(env, [trackStmt(D, { user_id: userId, platform: 'instagram', remote_id: item.media, account_id: item.account, url: item.permalink, posted_at: t, next_check: t })]);
    return { id: itemId, scheduled_at: at };
  }

  /** Videos on a connected Instagram account, newest first, 24 at a time. */
  async function listInstagramMedia(userId, url, env) {
    const D = db(env);
    const acc = await D.prepare('SELECT platform, remote_id, access_token FROM accounts WHERE user_id = ? AND id = ?').bind(userId, url.searchParams.get('account') || '').first();
    if (!acc || acc.platform !== 'instagram') throw new HttpError(404, 'Dieses Instagram-Konto ist auf dem Server noch nicht verbunden – lade die Seite neu.');
    const after = url.searchParams.get('after');
    const token = encodeURIComponent(await unseal(env, acc.access_token));
    const page = await call(`${GRAPH}/${acc.remote_id}/media?fields=id,caption,media_type,media_product_type,thumbnail_url,permalink,timestamp,media_url&limit=24${after ? `&after=${encodeURIComponent(after)}` : ''}&access_token=${token}`);
    const videos = (page.data || []).filter((m) => m.media_type === 'VIDEO');
    const posted = new Set(videos.length
      ? (await D.prepare(`SELECT DISTINCT source_media_id FROM items WHERE user_id = ? AND source_media_id IN (${videos.map(() => '?').join(',')})`).bind(userId, ...videos.map((m) => m.id)).all()).results.map((r) => r.source_media_id)
      : []);
    return {
      videos: videos.map((m) => ({
        id: m.id, caption: m.caption || '', thumbnail_url: m.thumbnail_url || null, permalink: m.permalink || null, timestamp: parseTime(m.timestamp) || null,
        reel: m.media_product_type === 'REELS', downloadable: !!m.media_url, crossposted: posted.has(m.id),
      })),
      next: page.paging?.next ? page.paging?.cursors?.after || null : null,
    };
  }

  async function itemAction(userId, itemId, action, env) {
    const D = db(env);
    const item = await D.prepare('SELECT id, kind, source_media_id, r2_key FROM items WHERE user_id = ? AND id = ?').bind(userId, itemId).first();
    if (!item) throw new HttpError(404, 'Nicht gefunden');
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
    // Its numbers go too (unless another video in Crosspost is the same one).
    const keys = await D.prepare("SELECT platform, remote_id FROM jobs WHERE user_id = ? AND item_id = ? AND remote_id IS NOT NULL AND remote_id != ''").bind(userId, itemId).all()
      .then((r) => r.results.map((j) => [j.platform, j.remote_id]), () => []);
    if (item.kind !== 'upload') keys.push(['instagram', item.source_media_id]);
    await D.batch([
      D.prepare('DELETE FROM jobs WHERE user_id = ? AND item_id = ?').bind(userId, itemId),
      D.prepare('DELETE FROM items WHERE user_id = ? AND id = ?').bind(userId, itemId),
    ]);
    await followStats(env, cleanupStmts(D, userId, keys));
    if (item.r2_key && env.MEDIA) await env.MEDIA.delete(item.r2_key).catch(() => {});
    return { deleted: true };
  }

  /** Routes under /api/. Returns undefined for any other path. */
  async function handle(request, env, url) {
    const p = url.pathname;
    const m = request.method;
    if (!p.startsWith('/api/')) return undefined;
    if (m === 'POST' && p === '/api/session') return createSession(await request.json(), env);
    if (m === 'POST' && p === '/api/link') return useLinkCode(await request.json(), env);
    const userId = await requireUser(request, env);
    if (m === 'POST' && p === '/api/inbox') return addToInbox(userId, request, url, env);
    if (m === 'GET' && p === '/api/inbox') return listInbox(userId, env);
    if (m === 'GET' && p === '/api/state') return state(userId, env);
    if (m === 'POST' && p === '/api/shortcut-key') return shortcutKey(userId, env);
    if (m === 'PUT' && p === '/api/sync') return sync(userId, await request.json(), env);
    if (m === 'GET' && p === '/api/posts') return listPosts(userId, env);
    if (m === 'POST' && p === '/api/tick') return { processed: await processDue(env, userId) };
    if (m === 'POST' && p === '/api/posts') return createPost(userId, await request.json(), env);
    if (m === 'GET' && p === '/api/instagram/media') return listInstagramMedia(userId, url, env);
    let r = /^\/api\/inbox\/([\w-]{1,64})$/.exec(p);
    if (m === 'DELETE' && r) return removeFromInbox(userId, r[1], env);
    r = /^\/api\/workflows\/([\w-]{1,64})\/run$/.exec(p);
    if (m === 'POST' && r) return runNow(userId, r[1], env);
    const s = await stats.handle(request, env, url, userId);
    if (s !== undefined) return s;
    r = /^\/api\/items\/([\w-]{1,64})(?:\/(approve|retry))?$/.exec(p);
    if (r && ((m === 'POST' && r[2]) || (m === 'DELETE' && !r[2]))) return itemAction(userId, r[1], r[2] || 'delete', env);
    throw new HttpError(404, 'Nicht gefunden');
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

  return { handle, scheduled, statsCron: stats.cron, requireUser };
}
