// Public settings for the platform connections. Client IDs are not secret:
// they are part of every sign-in link. Secrets live only on the server
// (see server/worker.js). Values come from the build (VITE_* variables, set as
// GitHub repository variables) and can be overridden in Settings.

export type OAuthPlatform = 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'snapchat';
export const OAUTH_PLATFORMS: OAuthPlatform[] = ['facebook', 'instagram', 'tiktok', 'youtube', 'snapchat'];

export interface Integrations {
  serverUrl: string;
  /** Meta app ID – used for Facebook and Instagram. */
  facebook: string;
  /** Configuration ID of the Meta login configuration "Instagram API (Unified Login)". */
  metaConfigId: string;
  tiktok: string;
  youtube: string;
  snapchat: string;
}

const env = import.meta.env;
const built: Integrations = {
  serverUrl: env.VITE_SERVER_URL ?? '',
  facebook: env.VITE_FACEBOOK_APP_ID ?? '',
  metaConfigId: env.VITE_META_CONFIG_ID ?? '',
  tiktok: env.VITE_TIKTOK_CLIENT_KEY ?? '',
  youtube: env.VITE_GOOGLE_CLIENT_ID ?? '',
  snapchat: env.VITE_SNAPCHAT_CLIENT_ID ?? '',
};

const KEY = 'crosspost:integrations';

export function integrations(): Integrations {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Integrations>;
    const merged = { ...built };
    for (const k of Object.keys(merged) as (keyof Integrations)[]) if (saved[k]) merged[k] = saved[k]!.trim();
    merged.serverUrl = merged.serverUrl.replace(/\/+$/, '');
    return merged;
  } catch {
    return built;
  }
}

export function saveIntegrations(values: Partial<Integrations>) {
  localStorage.setItem(KEY, JSON.stringify(values));
}

/** The public client ID a platform's sign-in uses. Instagram signs in through the Meta app (Unified Login). */
export function clientIdFor(p: OAuthPlatform, c = integrations()): string {
  return p === 'instagram' ? c.facebook : c[p];
}

/** Whether a platform can use its real sign-in. YouTube and Snapchat work from the browser alone. */
export function isConfigured(p: OAuthPlatform): boolean {
  const c = integrations();
  if (!clientIdFor(p, c)) return false;
  if (p === 'instagram' && !c.metaConfigId) return false;
  return p === 'youtube' || p === 'snapchat' ? true : !!c.serverUrl;
}
