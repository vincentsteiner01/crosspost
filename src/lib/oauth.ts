// OAuth 2.0 sign-in for each platform (authorization code flow, with PKCE
// where the platform supports it). Endpoints and scopes follow the official
// developer documentation of each platform:
//   Facebook   – Facebook Login, manual flow (Graph API v25.0)
//   Instagram  – Meta "Unified Login": Facebook Login for Business with the
//                configuration "Instagram API (Unified Login)" (config_id
//                instead of scope). The server turns the code into a system-user
//                token that does not expire and finds the Instagram account
//                via /me/assigned_instagram_accounts – no Facebook Page needed.
//   TikTok     – Login Kit for Web (+ Content Posting API scope)
//   YouTube    – Google OAuth 2.0: with our server, the web-server flow with
//                offline access (lasting refresh token); without it, the
//                client-side flow (token in the browser, valid one hour)
//   Snapchat   – Login Kit, client-side PKCE
// Codes from Facebook, Instagram and TikTok are exchanged on our server, the
// only place that may know the app secrets.
import { clientIdFor, integrations, type OAuthPlatform } from './config';
import { absoluteUrl } from './paths';
import type { AccountAuth } from './store';

interface Provider {
  authorize: string;
  clientParam: string;
  scope: string;
  scopeSeparator: string;
  responseType: 'code' | 'token';
  pkce: boolean;
  extra?: Record<string, string>;
}

const PROVIDERS: Record<OAuthPlatform, Provider> = {
  facebook: {
    authorize: 'https://www.facebook.com/v25.0/dialog/oauth',
    clientParam: 'client_id',
    scope: 'public_profile,pages_show_list,pages_read_engagement,pages_manage_posts',
    scopeSeparator: ',',
    responseType: 'code',
    pkce: false,
  },
  instagram: {
    // The permissions come from the Meta login configuration (config_id), not from a scope.
    authorize: 'https://www.facebook.com/v25.0/dialog/oauth',
    clientParam: 'client_id',
    scope: '',
    scopeSeparator: ',',
    responseType: 'code',
    pkce: false,
    extra: { override_default_response_type: 'true' },
  },
  tiktok: {
    authorize: 'https://www.tiktok.com/v2/auth/authorize/',
    clientParam: 'client_key',
    // video.upload: send videos as drafts to the TikTok app (works before TikTok's audit).
    scope: 'user.info.basic,video.publish,video.upload',
    scopeSeparator: ',',
    responseType: 'code',
    pkce: false,
  },
  youtube: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    clientParam: 'client_id',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    scopeSeparator: ' ',
    responseType: 'token',
    pkce: false,
    extra: { include_granted_scopes: 'true', prompt: 'select_account' },
  },
  snapchat: {
    authorize: 'https://accounts.snapchat.com/accounts/oauth2/auth',
    clientParam: 'client_id',
    scope: 'https://auth.snapchat.com/oauth2/api/user.display_name https://auth.snapchat.com/oauth2/api/user.external_id',
    scopeSeparator: ' ',
    responseType: 'code',
    pkce: true,
  },
};

const PENDING = 'crosspost:oauth';
export const redirectUri = () => absoluteUrl('oauth/callback/');

interface Pending { platform: OAuthPlatform; state: string; verifier?: string; signIn: boolean; startedAt: number }

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function challengeFor(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** YouTube asks Google for a code (exchanged on our server) once a server is set up. */
function providerFor(platform: OAuthPlatform): Provider {
  const p = PROVIDERS[platform];
  if (platform === 'youtube' && integrations().serverUrl) {
    return { ...p, responseType: 'code', extra: { ...p.extra, access_type: 'offline', prompt: 'consent select_account' } };
  }
  if (platform === 'instagram') {
    const configId = integrations().metaConfigId;
    if (!configId) throw new Error('Die Instagram-Konfigurations-ID fehlt (Einstellungen → Integrationen).');
    return { ...p, extra: { ...p.extra, config_id: configId } };
  }
  return p;
}

/** Send the person to the platform's consent screen. */
export async function startOAuth(platform: OAuthPlatform, opts: { signIn?: boolean } = {}) {
  const p = providerFor(platform);
  const clientId = clientIdFor(platform);
  if (!clientId) throw new Error(`Für ${platform} fehlt die Client-ID.`);
  const pending: Pending = { platform, state: randomString(), signIn: !!opts.signIn, startedAt: Date.now() };
  const q = new URLSearchParams({
    [p.clientParam]: clientId,
    redirect_uri: redirectUri(),
    response_type: p.responseType,
    scope: p.scope,
    state: pending.state,
    ...p.extra,
  });
  if (!p.scope) q.delete('scope');
  if (p.pkce) {
    pending.verifier = randomString(48);
    q.set('code_challenge', await challengeFor(pending.verifier));
    q.set('code_challenge_method', 'S256');
  }
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
  location.assign(`${p.authorize}?${q}`);
}

export interface OAuthResult { platform: OAuthPlatform; handle: string; auth: AccountAuth; signIn: boolean; email?: string }

async function serverCall<T>(path: string, body: unknown): Promise<T> {
  const server = integrations().serverUrl;
  if (!server) throw new Error('Der Server für die Anmeldung ist noch nicht eingerichtet (Einstellungen → Integrationen).');
  const res = await fetch(server + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Der Server antwortete mit ${res.status}`);
  return data as T;
}

interface ExchangeReply { access_token: string; refresh_token?: string; expires_in?: number; account_id?: string; name?: string; scope?: string }

async function youtubeChannel(token: string) {
  const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const ch = data.items?.[0];
  return { id: ch?.id as string | undefined, name: (ch?.snippet?.title as string | undefined) ?? 'YouTube' };
}

async function snapchatToken(code: string, verifier: string): Promise<ExchangeReply> {
  const c = integrations();
  // A public client may swap the code itself (PKCE); use our server when there is one.
  if (c.serverUrl) return serverCall<ExchangeReply>('/oauth/exchange', { platform: 'snapchat', code, code_verifier: verifier, redirect_uri: redirectUri() });
  const res = await fetch('https://accounts.snapchat.com/accounts/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: c.snapchat, redirect_uri: redirectUri(), code, code_verifier: verifier }),
  });
  if (!res.ok) throw new Error(`Snapchat hat die Anmeldung abgelehnt (${res.status}).`);
  return res.json();
}

/** Finish the sign-in on the callback page: check the state and turn the answer into tokens. */
export async function finishOAuth(): Promise<OAuthResult> {
  const pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null') as Pending | null;
  sessionStorage.removeItem(PENDING);
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.slice(1));
  const get = (k: string) => params.get(k) ?? hash.get(k);

  const err = get('error_description') || get('error_message') || get('error');
  if (err) throw new Error(`Die Anmeldung wurde abgebrochen: ${err}`);
  if (!pending) throw new Error('Diese Anmeldung wurde nicht hier gestartet. Klick bitte noch einmal auf „Verbinden“.');
  if (get('state') !== pending.state) throw new Error('Die Sicherheitsprüfung ist fehlgeschlagen (state stimmt nicht). Versuch es bitte noch einmal.');

  const { platform } = pending;
  const now = Date.now();

  if (platform === 'youtube' && get('code')) {
    const reply = await serverCall<ExchangeReply>('/oauth/exchange', { platform, code: get('code'), redirect_uri: redirectUri() });
    const ch = await youtubeChannel(reply.access_token);
    return {
      platform, signIn: pending.signIn, handle: ch.name,
      auth: { accessToken: reply.access_token, refreshToken: reply.refresh_token, expiresAt: now + (reply.expires_in ?? 3600) * 1000, remoteId: ch.id, scope: reply.scope },
    };
  }

  if (platform === 'youtube') {
    const token = get('access_token');
    if (!token) throw new Error('Google hat keinen Zugang zurückgegeben.');
    const ch = await youtubeChannel(token);
    const expires = Number(get('expires_in') || 3600);
    return { platform, signIn: pending.signIn, handle: ch.name, auth: { accessToken: token, expiresAt: now + expires * 1000, remoteId: ch.id, scope: get('scope') ?? undefined } };
  }

  const code = get('code');
  if (!code) throw new Error('Die Plattform hat keinen Anmelde-Code zurückgegeben.');
  const reply = platform === 'snapchat'
    ? await snapchatToken(code, pending.verifier!)
    : await serverCall<ExchangeReply>('/oauth/exchange', { platform, code, redirect_uri: redirectUri() });

  let name = reply.name;
  if (platform === 'snapchat' && !name) {
    const me = await fetch('https://kit.snapchat.com/v1/me', {
      method: 'POST',
      headers: { Authorization: `Bearer ${reply.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{me{displayName externalId}}' }),
    }).then((r) => r.json()).catch(() => null);
    name = me?.data?.me?.displayName;
  }
  return {
    platform,
    signIn: pending.signIn,
    handle: name || platform,
    auth: {
      accessToken: reply.access_token,
      refreshToken: reply.refresh_token,
      expiresAt: reply.expires_in ? now + reply.expires_in * 1000 : undefined,
      remoteId: reply.account_id,
      scope: reply.scope,
    },
  };
}

/** Get a fresh access token with the refresh token kept from sign-in (needs our server). */
export async function refreshAuth(platform: OAuthPlatform, auth: AccountAuth): Promise<AccountAuth> {
  if (!auth.refreshToken) throw new Error('Kein dauerhafter Zugang gespeichert – verbinde das Konto neu.');
  const reply = await serverCall<ExchangeReply>('/oauth/refresh', { platform, refresh_token: auth.refreshToken });
  return {
    ...auth,
    accessToken: reply.access_token,
    refreshToken: reply.refresh_token || auth.refreshToken,
    expiresAt: reply.expires_in ? Date.now() + reply.expires_in * 1000 : undefined,
  };
}

export { serverCall };
