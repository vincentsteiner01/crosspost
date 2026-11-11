// Everything the app remembers lives in this browser's local storage.
import type { PlatformId } from './platforms';

export interface User { name: string; email: string; passwordHash?: string; method: string; timezone: string; createdAt: number }
/** Sign-in result from the platform; absent for demo connections. */
export interface AccountAuth { accessToken: string; refreshToken?: string; expiresAt?: number; remoteId?: string; scope?: string }
export interface Account { id: string; platform: PlatformId; handle: string; connectedAt: number; auth?: AccountAuth }
export interface Workflow {
  id: string; name: string; sourceId: string; destinationIds: string[];
  active: boolean; autoPublish: boolean; captionTemplate: string; hashtags: string;
  removeWatermark: boolean; delayMinutes: number; createdAt: number; runs: number;
}
/** 'handed-over': uploaded and waiting on the platform's own schedule (YouTube publishAt). */
export type DeliveryStatus = 'scheduled' | 'publishing' | 'published' | 'handed-over' | 'failed' | 'draft';
/** label: shown instead of "Published", e.g. for a TikTok draft that waits in the TikTok inbox. */
export interface Delivery { accountId: string; status: DeliveryStatus; caption: string; error?: string; at?: number; url?: string; progress?: number; label?: string }
export const TIKTOK_INBOX_LABEL = 'In your TikTok inbox';
export interface YouTubeOptions {
  privacy: 'public' | 'unlisted' | 'private';
  /** Add #Shorts so vertical clips up to 3 minutes show in the Shorts feed. */
  short: boolean;
  tags: string;
  madeForKids: boolean;
  categoryId: string;
  /** For scheduled posts: upload at once and let YouTube publish at the planned time. */
  platformSchedule: boolean;
}
export const defaultYouTubeOptions = (): YouTubeOptions => ({ privacy: 'public', short: false, tags: '', madeForKids: false, categoryId: '22', platformSchedule: true });
/** trial: share as a trial reel (Test-Reel) – shown to non-followers first. MANUAL: you share it with followers in the app; SS_PERFORMANCE: Instagram does when it performs well. */
export interface InstagramOptions { trial: '' | 'MANUAL' | 'SS_PERFORMANCE' }
/** inbox: the video lands as a draft in the TikTok app and you post it there; direct: posted right away. */
export interface TikTokOptions { mode: 'inbox' | 'direct' }
export interface Post {
  id: string; title: string; caption: string; mediaName: string; mediaType: string; mediaSize: number;
  thumb?: string; createdAt: number; scheduledAt: number; deliveries: Delivery[]; workflowId?: string;
  /** Public address of the video on our server, once uploaded there. */
  mediaUrl?: string;
  youtube?: YouTubeOptions;
  instagram?: InstagramOptions;
  tiktok?: TikTokOptions;
  /** Picked up by a workflow on the server (lib/server.ts); lives there, not in this browser. */
  remote?: { itemId: string; permalink?: string; kind?: 'workflow' | 'upload' | 'instagram'; mediaId?: string; sourceAccountId?: string };
}

const KEY = 'crosspost:v1';

interface Db { users: User[]; session: string | null; accounts: Record<string, Account[]>; workflows: Record<string, Workflow[]>; posts: Record<string, Post[]> }

function load(): Db {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall through to a fresh store */ }
  return { users: [], session: null, accounts: {}, workflows: {}, posts: {} };
}

let db = load();
const listeners = new Set<() => void>();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    // Storage full (large thumbnails): drop thumbnails of the oldest posts and retry once.
    for (const list of Object.values(db.posts)) list.slice(20).forEach((p) => delete p.thumb);
    localStorage.setItem(KEY, JSON.stringify(db));
  }
  listeners.forEach((l) => l());
}

window.addEventListener('storage', (e) => { if (e.key === KEY) { db = load(); listeners.forEach((l) => l()); } });

export const onChange = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export async function hashPassword(pw: string): Promise<string> {
  const data = new TextEncoder().encode('crosspost:' + pw);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

export const findUser = (email: string) => db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());

export function createUser(u: Omit<User, 'createdAt' | 'timezone'>): User {
  const user: User = { ...u, timezone: tz(), createdAt: Date.now() };
  db.users.push(user);
  save();
  return user;
}

export function signIn(email: string) { db.session = email.toLowerCase(); save(); }
export function signOut() { db.session = null; save(); }
export const currentUser = (): User | undefined => (db.session ? findUser(db.session) : undefined);

export function updateUser(patch: Partial<User>) {
  const u = currentUser();
  if (!u) return;
  Object.assign(u, patch);
  save();
}

const me = () => db.session ?? '';

export const accounts = () => (db.accounts[me()] ??= []);
export const workflows = () => (db.workflows[me()] ??= []);
export const posts = () => (db.posts[me()] ??= []);
export const account = (id: string) => accounts().find((a) => a.id === id);

export function connectAccount(platform: PlatformId, handle: string, auth?: AccountAuth): Account {
  const existing = accounts().find((a) => a.platform === platform && a.handle.toLowerCase() === handle.toLowerCase());
  if (existing) {
    if (auth) { existing.auth = auth; save(); }
    return existing;
  }
  const a: Account = { id: uid(), platform, handle, connectedAt: Date.now(), auth };
  accounts().push(a);
  save();
  return a;
}

export function disconnectAccount(id: string) {
  db.accounts[me()] = accounts().filter((a) => a.id !== id);
  for (const w of workflows()) {
    w.destinationIds = w.destinationIds.filter((d) => d !== id);
    if (w.sourceId === id) w.active = false;
  }
  save();
}

export function saveWorkflow(w: Workflow) {
  const list = workflows();
  const i = list.findIndex((x) => x.id === w.id);
  if (i >= 0) list[i] = w; else list.unshift(w);
  save();
}

export function deleteWorkflow(id: string) { db.workflows[me()] = workflows().filter((w) => w.id !== id); save(); }

export function savePost(p: Post) {
  const list = posts();
  const i = list.findIndex((x) => x.id === p.id);
  if (i >= 0) list[i] = p; else list.unshift(p);
  save();
}

export function deletePost(id: string) { db.posts[me()] = posts().filter((p) => p.id !== id); save(); }

// Posts that server-side workflows made; refreshed from the server, never stored here.
let remote: Post[] = [];
export function setRemotePosts(list: Post[]) {
  const changed = JSON.stringify(list) !== JSON.stringify(remote);
  remote = list;
  if (changed) listeners.forEach((l) => l());
}
/** Posts made here and by server-side workflows, newest first. */
export const allPosts = () => [...remote, ...posts()].sort((a, b) => b.createdAt - a.createdAt);

export const commit = save;
