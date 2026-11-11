// Crosspost server – a Cloudflare Worker.
//
// The website itself is static (GitHub Pages) and must never hold an app
// secret. This worker holds them and does the three things that need them:
//   POST /oauth/exchange   swap a sign-in code for an access token
//   POST /oauth/refresh    get a new access token with a refresh token
//   PUT  /media            keep an uploaded video at a public address
//   POST /publish          publish a video to Facebook, Instagram or TikTok
//   POST /publish/status   Instagram: publish the Reel once processed; TikTok: is the post through?
//
// Secrets (set with `npx wrangler secret put NAME`):
//   FACEBOOK_APP_ID, FACEBOOK_APP_SECRET   (the Meta app – used for Facebook and Instagram)
//   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
//   SNAPCHAT_CLIENT_ID, SNAPCHAT_CLIENT_SECRET (optional; the site can also sign in to Snapchat alone)
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   (YouTube: lasting access, so scheduled uploads work later)
// Settings (wrangler.toml [vars]):
//   ALLOWED_ORIGIN    the site's address, e.g. https://<name>.github.io
//   TIKTOK_PRIVACY    privacy level for TikTok posts (unaudited apps may only post SELF_ONLY)
//   TIKTOK_VERIFICATION_FILENAME / TIKTOK_VERIFICATION_CONTENT
//                     the file TikTok asks you to host to verify this worker's address
// Binding: MEDIA – an R2 bucket for uploaded videos.

const GRAPH = 'https://graph.facebook.com/v25.0';
const TIKTOK = 'https://open.tiktokapis.com/v2';

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    try {
      if (env.TIKTOK_VERIFICATION_FILENAME && url.pathname === `/${env.TIKTOK_VERIFICATION_FILENAME}`) {
        return new Response(env.TIKTOK_VERIFICATION_CONTENT || '', { headers: { 'Content-Type': 'text/plain' } });
      }
      if (request.method === 'POST' && url.pathname === '/oauth/exchange') return json(await exchange(await request.json(), env));
      if (request.method === 'POST' && url.pathname === '/oauth/refresh') return json(await refresh(await request.json(), env));
      if (request.method === 'PUT' && url.pathname === '/media') return json(await putMedia(request, env, url));
      if (request.method === 'GET' && url.pathname.startsWith('/media/')) return getMedia(env, url.pathname.slice(7), cors);
      if (request.method === 'POST' && url.pathname === '/publish') return json(await publish(await request.json(), env));
      if (request.method === 'POST' && url.pathname === '/publish/status') return json(await publishStatus(await request.json()));
      if (url.pathname === '/') return json({ ok: true, service: 'crosspost' });
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 400);
    }
  },
};

class UpstreamError extends Error {
  constructor(message, detail) { super(message); this.detail = detail || {}; }
}

/** The address without anything secret in it, for logs. */
const redact = (input) => {
  try {
    const u = new URL(typeof input === 'string' ? input : input.url);
    for (const k of ['access_token', 'client_secret', 'code', 'fb_exchange_token', 'input_token', 'refresh_token']) if (u.searchParams.has(k)) u.searchParams.set(k, '…');
    return u.toString();
  } catch { return '?'; }
};

async function call(input, init) {
  const res = await fetch(input, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  const e = data.error;
  // TikTok answers every request with an error object; code "ok" means success.
  const failed = !res.ok || (e && !(typeof e === 'object' && e.code === 'ok'));
  if (!failed) return data;
  let msg;
  if (e && typeof e === 'object') {
    // Meta: error_user_title / error_user_msg explain the problem; code and subcode identify it.
    msg = [e.error_user_title, e.error_user_msg || e.message].filter(Boolean).join(': ') || 'Unknown error';
    const ids = [e.code != null && `code ${e.code}`, e.error_subcode && `subcode ${e.error_subcode}`].filter(Boolean).join(', ');
    if (ids) msg += ` (${ids})`;
  } else {
    msg = data.error_description || e || data.message || data.raw || `HTTP ${res.status}`;
  }
  console.log(JSON.stringify({ event: 'upstream_error', url: redact(input), status: res.status, error: e ?? data }));
  throw new UpstreamError(typeof msg === 'string' ? msg : JSON.stringify(msg), typeof e === 'object' ? e : {});
}

const form = (values) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
const need = (env, ...names) => { for (const n of names) if (!env[n]) throw new Error(`Server setting ${n} is missing`); };

// ---------- sign-in ----------
async function exchange({ platform, code, redirect_uri, code_verifier }, env) {
  if (!code || !redirect_uri) throw new Error('code and redirect_uri are required');

  if (platform === 'facebook') {
    need(env, 'FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET');
    const short = await call(`${GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, redirect_uri, code })}`);
    // A long-lived user token gives page tokens that don't expire.
    const long = await call(`${GRAPH}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, fb_exchange_token: short.access_token })}`);
    const pages = await call(`${GRAPH}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(long.access_token)}`);
    const page = pages.data?.[0];
    if (!page) throw new Error('No Facebook Page found. Posting needs a Page you manage.');
    return { access_token: page.access_token, account_id: page.id, name: page.name, pages: pages.data.map((p) => ({ id: p.id, name: p.name })) };
  }

  if (platform === 'instagram') {
    // Unified Login (Facebook Login for Business with the configuration
    // "Instagram API (Unified Login)"): the code becomes a business-integration
    // system-user token, which does not expire.
    need(env, 'FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET');
    const app = { client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET };
    const t = await call(`${GRAPH}/oauth/access_token?${new URLSearchParams({ ...app, redirect_uri, code })}`);
    let token = t.access_token;
    let expires_in = t.expires_in;
    if (expires_in) {
      // A configuration that hands out user tokens instead: make it last 60 days.
      const long = await call(`${GRAPH}/oauth/access_token?${new URLSearchParams({ ...app, grant_type: 'fb_exchange_token', fb_exchange_token: token })}`).catch(() => null);
      if (long?.access_token) { token = long.access_token; expires_in = long.expires_in; }
    }
    const { accounts, via, diag } = await findInstagramAccounts(token, env);
    if (!accounts.length) {
      // Only what Meta said about the token (no token itself), to see where the account went.
      console.log(JSON.stringify({ event: 'instagram_no_account', diag }));
      // Typical cause: the account was shared with Crosspost before. Meta then marks it
      // "Zuvor geteilt" and keeps it with the earlier system user, not the new one.
      throw new Error('Meta did not share an Instagram account with this sign-in. If the account was connected before: in Meta Business Suite open Settings → Connected apps → Crosspost, remove the app, then connect Instagram again and select your account.');
    }
    console.log(JSON.stringify({ event: 'instagram_connected', via, accounts }));
    return { access_token: token, expires_in, account_id: accounts[0].id, name: accounts[0].username, accounts: accounts.map((a) => ({ id: a.id, name: a.username })) };
  }

  if (platform === 'tiktok') {
    need(env, 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET');
    const t = await call(`${TIKTOK}/oauth/token/`, form({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri }));
    const info = await call(`${TIKTOK}/user/info/?fields=open_id,display_name`, { headers: { Authorization: `Bearer ${t.access_token}` } }).catch(() => null);
    return { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in, account_id: t.open_id, scope: t.scope, name: info?.data?.user?.display_name };
  }

  if (platform === 'youtube') {
    need(env, 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
    const t = await call('https://oauth2.googleapis.com/token', form({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri }));
    return { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in, scope: t.scope };
  }

  if (platform === 'snapchat') {
    need(env, 'SNAPCHAT_CLIENT_ID');
    const values = { grant_type: 'authorization_code', client_id: env.SNAPCHAT_CLIENT_ID, redirect_uri, code };
    if (code_verifier) values.code_verifier = code_verifier;
    if (env.SNAPCHAT_CLIENT_SECRET) values.client_secret = env.SNAPCHAT_CLIENT_SECRET;
    const t = await call('https://accounts.snapchat.com/accounts/oauth2/token', form(values));
    return { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in };
  }

  throw new Error(`Unknown platform ${platform}`);
}

/**
 * Instagram accounts the person shared in the Unified Login dialog – no Facebook Page involved.
 * 1. /me/assigned_instagram_accounts (the system user's assigned accounts)
 * 2. the token's granular scopes (debug_token): the IDs picked for instagram_* permissions
 */
async function findInstagramAccounts(token, env) {
  const t = encodeURIComponent(token);
  const diag = {};
  const attempt = async (label, url) => {
    try { return await call(url); } catch (e) { diag[label] = { error: e.message }; return null; }
  };

  const assigned = await attempt('assigned', `${GRAPH}/me/assigned_instagram_accounts?fields=id,username&access_token=${t}`);
  const direct = (assigned?.data || []).filter((a) => a.id);
  if (assigned) diag.assigned = direct.map((a) => a.id);
  if (direct.length) return { accounts: direct, via: 'assigned_instagram_accounts', diag };

  const appToken = encodeURIComponent(`${env.FACEBOOK_APP_ID}|${env.FACEBOOK_APP_SECRET}`);
  const dbg = (await attempt('debug_token', `${GRAPH}/debug_token?input_token=${t}&access_token=${appToken}`))?.data || {};
  diag.token = { type: dbg.type, is_valid: dbg.is_valid, expires_at: dbg.expires_at, scopes: dbg.scopes, granular_scopes: dbg.granular_scopes };
  const ids = [...new Set((dbg.granular_scopes || []).filter((g) => /^instagram_/.test(g.scope)).flatMap((g) => g.target_ids || []))];
  const found = [];
  for (const id of ids.slice(0, 10)) {
    const node = await attempt(`node_${id}`, `${GRAPH}/${id}?fields=id,username&access_token=${t}`);
    if (node?.username) found.push({ id: node.id, username: node.username });
  }
  if (found.length) return { accounts: found, via: 'granular_scopes', diag };

  // 3. Instagram accounts owned by the business the token belongs to.
  const me = await attempt('me', `${GRAPH}/me?fields=id,client_business_id&access_token=${t}`);
  diag.me = me ? { id: me.id, client_business_id: me.client_business_id } : diag.me;
  const igOnly = (list) => (list?.data || []).filter((a) => a.id && a.username).map((a) => ({ id: a.id, username: a.username }));
  if (me?.client_business_id) {
    for (const edge of ['instagram_business_accounts', 'owned_instagram_accounts']) {
      const r = await attempt(edge, `${GRAPH}/${me.client_business_id}/${edge}?fields=id,username&access_token=${t}`);
      if (r) diag[edge] = (r.data || []).map((a) => a.id);
      if (igOnly(r).length) return { accounts: igOnly(r), via: edge, diag };
    }
  }

  // 4. The Instagram account behind Facebook Pages assigned to the token (account linked to a Page).
  for (const edge of ['assigned_pages', 'accounts']) {
    const r = await attempt(edge, `${GRAPH}/me/${edge}?fields=id,instagram_business_account{id,username}&access_token=${t}`);
    const viaPage = (r?.data || []).map((p) => p.instagram_business_account).filter((a) => a?.id && a.username);
    if (r) diag[edge] = (r.data || []).map((p) => ({ page: p.id, ig: p.instagram_business_account?.id || null }));
    if (viaPage.length) return { accounts: viaPage.map((a) => ({ id: a.id, username: a.username })), via: edge, diag };
  }
  return { accounts: [], via: null, diag };
}

async function refresh({ platform, refresh_token }, env) {
  if (!refresh_token) throw new Error('refresh_token is required');

  if (platform === 'youtube') {
    need(env, 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
    const t = await call('https://oauth2.googleapis.com/token', form({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token, grant_type: 'refresh_token' }));
    return { access_token: t.access_token, expires_in: t.expires_in, scope: t.scope };
  }

  if (platform === 'tiktok') {
    need(env, 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET');
    const t = await call(`${TIKTOK}/oauth/token/`, form({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token }));
    return { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in };
  }

  throw new Error(`Refreshing ${platform} is not supported`);
}

// ---------- media ----------
async function putMedia(request, env, url) {
  if (!env.MEDIA) throw new Error('R2 bucket MEDIA is not bound');
  const name = (url.searchParams.get('name') || 'video.mp4').replace(/[^\w.-]+/g, '_').slice(-80);
  const key = `${crypto.randomUUID()}-${name}`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: request.headers.get('Content-Type') || 'video/mp4' } });
  return { url: `${url.origin}/media/${key}` };
}

async function getMedia(env, key, cors) {
  const obj = await env.MEDIA.get(decodeURIComponent(key));
  if (!obj) return new Response('Not found', { status: 404, headers: cors });
  return new Response(obj.body, { headers: { ...cors, 'Content-Type': obj.httpMetadata?.contentType || 'video/mp4', 'Content-Length': String(obj.size) } });
}

// ---------- publishing ----------
async function publish({ platform, access_token, account_id, title, caption, video_url }, env) {
  if (!access_token || !video_url) throw new Error('access_token and video_url are required');

  if (platform === 'facebook') {
    const v = await call(`${GRAPH}/${account_id}/videos`, form({ file_url: video_url, description: caption || '', title: title || '', access_token }));
    return { id: v.id, url: `https://www.facebook.com/${account_id}/videos/${v.id}` };
  }

  if (platform === 'instagram') {
    if (!account_id) throw new Error('Instagram account ID is missing – connect Instagram again.');
    const container = await call(`${GRAPH}/${account_id}/media`, form({ media_type: 'REELS', video_url, caption: caption || '', access_token }));
    // Instagram fetches and processes the video first, which can take minutes.
    // Instead of one long request the site asks POST /publish/status until it is done.
    return { pending: true, container_id: container.id };
  }

  if (platform === 'tiktok') {
    const auth = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json; charset=UTF-8' };
    const creator = await call(`${TIKTOK}/post/publish/creator_info/query/`, { method: 'POST', headers: auth });
    const options = creator.data?.privacy_level_options || ['SELF_ONLY'];
    // A public account offers PUBLIC_TO_EVERYONE; unaudited apps may only post to private accounts.
    console.log(JSON.stringify({ event: 'tiktok_creator', privacy_level_options: options, max_video_post_duration_sec: creator.data?.max_video_post_duration_sec }));
    const wanted = env.TIKTOK_PRIVACY || 'SELF_ONLY';
    const privacy_level = options.includes(wanted) ? wanted : options[0];
    const init = await call(`${TIKTOK}/post/publish/video/init/`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        post_info: { title: (caption || title || '').slice(0, 2200), privacy_level },
        source_info: { source: 'PULL_FROM_URL', video_url },
      }),
    });
    // TikTok fetches the video and posts it in the background; the site asks POST /publish/status.
    return { pending: true, container_id: init.data?.publish_id };
  }

  throw new Error(`Publishing to ${platform} is not supported by this server`);
}

/** TikTok: is the post through? */
async function tiktokStatus(access_token, publish_id) {
  const s = await call(`${TIKTOK}/post/publish/status/fetch/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ publish_id }),
  });
  const d = s.data || {};
  if (d.status === 'FAILED') {
    console.log(JSON.stringify({ event: 'tiktok_failed', fail_reason: d.fail_reason }));
    throw new Error(`TikTok could not post the video: ${d.fail_reason || 'unknown reason'}`);
  }
  if (d.status !== 'PUBLISH_COMPLETE' && d.status !== 'SEND_TO_USER_INBOX') return { pending: true, container_id: publish_id, status: d.status };
  const postId = d.publicaly_available_post_id?.[0];
  return { id: String(postId || publish_id), url: postId ? `https://www.tiktok.com/video/${postId}` : undefined };
}

/** Instagram: check a Reel container; once Instagram has processed the video, publish it. TikTok: check the post. */
async function publishStatus({ platform, access_token, account_id, container_id }) {
  if (platform === 'tiktok') {
    if (!access_token || !container_id) throw new Error('access_token and container_id are required');
    return tiktokStatus(access_token, container_id);
  }
  if (platform !== 'instagram') throw new Error(`Status checks are not supported for ${platform}`);
  if (!access_token || !account_id || !container_id) throw new Error('access_token, account_id and container_id are required');
  const token = encodeURIComponent(access_token);
  const s = await call(`${GRAPH}/${container_id}?fields=status_code,status&access_token=${token}`);
  if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram could not process the video: ${s.status || s.status_code}`);
  if (s.status_code === 'PUBLISHED') return { already_published: true };
  if (s.status_code !== 'FINISHED') return { pending: true, container_id, status: s.status_code };

  const publishOnce = () => call(`${GRAPH}/${account_id}/media_publish`, form({ creation_id: container_id, access_token }));
  let media;
  try {
    media = await publishOnce();
  } catch (err) {
    // Meta sometimes reports an error although the Reel went out – look before giving up.
    const after = await call(`${GRAPH}/${container_id}?fields=status_code&access_token=${token}`).catch(() => ({}));
    if (after.status_code === 'PUBLISHED') return { already_published: true };
    // Temporary errors (Meta marks them is_transient, or code 1/2/-1): one more try.
    const d = err.detail || {};
    if (!(d.is_transient || [1, 2, -1].includes(d.code))) throw err;
    await new Promise((r) => setTimeout(r, 4000));
    media = await publishOnce();
  }
  const info = await call(`${GRAPH}/${media.id}?fields=permalink&access_token=${token}`).catch(() => ({}));
  return { id: media.id, url: info.permalink };
}
