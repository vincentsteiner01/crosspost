// Crosspost server – a Cloudflare Worker.
//
// The website itself is static (GitHub Pages) and must never hold an app
// secret. This worker holds them and does the three things that need them:
//   POST /oauth/exchange   swap a sign-in code for an access token
//   POST /oauth/refresh    get a new access token with a refresh token
//   PUT  /media            keep an uploaded video at a public address
//   POST /publish          publish a video to Facebook, Instagram or TikTok
//
// Secrets (set with `npx wrangler secret put NAME`):
//   FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
//   INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET
//   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
//   SNAPCHAT_CLIENT_ID, SNAPCHAT_CLIENT_SECRET (optional; the site can also sign in to Snapchat alone)
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   (YouTube: lasting access, so scheduled uploads work later)
// Settings (wrangler.toml [vars]):
//   ALLOWED_ORIGIN    the site's address, e.g. https://<name>.github.io
//   TIKTOK_PRIVACY    privacy level for TikTok posts (unaudited apps may only post SELF_ONLY)
//   TIKTOK_VERIFICATION_FILENAME / TIKTOK_VERIFICATION_CONTENT
//                     the file TikTok asks you to host to verify this worker's address
// Binding: MEDIA – an R2 bucket for uploaded videos.

const GRAPH = 'https://graph.facebook.com/v21.0';
const IG_GRAPH = 'https://graph.instagram.com/v21.0';
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
      if (url.pathname === '/') return json({ ok: true, service: 'crosspost' });
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 400);
    }
  },
};

async function call(input, init) {
  const res = await fetch(input, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data.error) {
    const msg = data.error?.message || data.error_description || data.error?.code || data.error || data.message || `HTTP ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
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
    need(env, 'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET');
    const short = await call('https://api.instagram.com/oauth/access_token', form({ client_id: env.INSTAGRAM_APP_ID, client_secret: env.INSTAGRAM_APP_SECRET, grant_type: 'authorization_code', redirect_uri, code }));
    const long = await call(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: env.INSTAGRAM_APP_SECRET, access_token: short.access_token })}`);
    const me = await call(`${IG_GRAPH}/me?fields=user_id,username&access_token=${encodeURIComponent(long.access_token)}`);
    return { access_token: long.access_token, expires_in: long.expires_in, account_id: me.user_id || me.id || String(short.user_id), name: me.username };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function publish({ platform, access_token, account_id, title, caption, video_url }, env) {
  if (!access_token || !video_url) throw new Error('access_token and video_url are required');

  if (platform === 'facebook') {
    const v = await call(`${GRAPH}/${account_id}/videos`, form({ file_url: video_url, description: caption || '', title: title || '', access_token }));
    return { id: v.id, url: `https://www.facebook.com/${account_id}/videos/${v.id}` };
  }

  if (platform === 'instagram') {
    const container = await call(`${IG_GRAPH}/${account_id}/media`, form({ media_type: 'REELS', video_url, caption: caption || '', access_token }));
    // Instagram fetches and processes the video first.
    for (let i = 0; i < 20; i++) {
      const s = await call(`${IG_GRAPH}/${container.id}?fields=status_code,status&access_token=${encodeURIComponent(access_token)}`);
      if (s.status_code === 'FINISHED') break;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram could not process the video: ${s.status || s.status_code}`);
      await sleep(3000);
    }
    const media = await call(`${IG_GRAPH}/${account_id}/media_publish`, form({ creation_id: container.id, access_token }));
    const info = await call(`${IG_GRAPH}/${media.id}?fields=permalink&access_token=${encodeURIComponent(access_token)}`).catch(() => ({}));
    return { id: media.id, url: info.permalink };
  }

  if (platform === 'tiktok') {
    const auth = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json; charset=UTF-8' };
    const creator = await call(`${TIKTOK}/post/publish/creator_info/query/`, { method: 'POST', headers: auth });
    const options = creator.data?.privacy_level_options || ['SELF_ONLY'];
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
    return { id: init.data?.publish_id };
  }

  throw new Error(`Publishing to ${platform} is not supported by this server`);
}
