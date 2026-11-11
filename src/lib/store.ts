// Everything the app remembers lives in this browser's local storage.
import { RETIRED_PLATFORMS, type PlatformId } from './platforms';

export interface User { name: string; email: string; passwordHash?: string; method: string; timezone: string; createdAt: number }
/** Sign-in result from the platform; absent for demo connections. */
export interface AccountAuth { accessToken: string; refreshToken?: string; expiresAt?: number; remoteId?: string; scope?: string }
/** cloud: the server has this account's sign-in (maybe connected on another device), so it can post through the server. */
export interface Account { id: string; platform: PlatformId; handle: string; connectedAt: number; auth?: AccountAuth; cloud?: boolean }
/** Posts for real: signed in here, or through the server. */
export const isLive = (a?: Account) => !!(a && (a.auth || a.cloud));
/** synced: the server has it; dirty: changed here since the last sync. */
export interface Workflow {
  id: string; name: string; sourceId: string; destinationIds: string[];
  active: boolean; autoPublish: boolean; captionTemplate: string; hashtags: string;
  removeWatermark: boolean; delayMinutes: number; createdAt: number; runs: number;
  synced?: boolean; dirty?: boolean;
}
/** 'handed-over': uploaded and waiting on the platform's own schedule (YouTube publishAt). */
export type DeliveryStatus = 'scheduled' | 'publishing' | 'published' | 'handed-over' | 'failed' | 'draft';
/** label: shown instead of "Published", e.g. for a TikTok draft that waits in the TikTok inbox. */
export interface Delivery { accountId: string; status: DeliveryStatus; caption: string; error?: string; at?: number; url?: string; progress?: number; label?: string }
export const TIKTOK_INBOX_LABEL = 'Im TikTok-Posteingang';
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

interface Removed { accounts: string[]; workflows: string[] }
interface Db { users: User[]; session: string | null; accounts: Record<string, Account[]>; workflows: Record<string, Workflow[]>; posts: Record<string, Post[]>; removed?: Record<string, Removed> }

function load(): Db {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall through to a fresh store */ }
  return { users: [], session: null, accounts: {}, workflows: {}, posts: {} };
}

let db = load();
// Accounts of platforms the app no longer offers go, and so do their places in workflows.
{
  const retired = new Set(RETIRED_PLATFORMS);
  for (const [who, list] of Object.entries(db.accounts ?? {})) {
    const gone = new Set(list.filter((a) => retired.has(a.platform as string)).map((a) => a.id));
    if (!gone.size) continue;
    db.accounts[who] = list.filter((a) => !gone.has(a.id));
    for (const w of db.workflows?.[who] ?? []) {
      w.destinationIds = w.destinationIds.filter((id) => !gone.has(id));
      if (gone.has(w.sourceId)) w.active = false;
    }
  }
}
// Posts saved before the app was German keep their old English label.
for (const list of Object.values(db.posts ?? {})) for (const p of list) for (const d of p.deliveries) if (d.label === 'In your TikTok inbox') d.label = TIKTOK_INBOX_LABEL;
const listeners = new Set<() => void>();
/** Tell the views something changed that isn't stored here (e.g. the inbox). */
export const notify = () => listeners.forEach((l) => l());

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

const removed = (): Removed => (db.removed ??= {})[me()] ??= { accounts: [], workflows: [] };

export function disconnectAccount(id: string) {
  const a = account(id);
  // Tell the server on the next sync, so the account goes on every device.
  if (a?.auth || a?.cloud) removed().accounts.push(id);
  db.accounts[me()] = accounts().filter((a) => a.id !== id);
  for (const w of workflows()) {
    w.destinationIds = w.destinationIds.filter((d) => d !== id);
    if (w.sourceId === id) w.active = false;
  }
  save();
}

export function saveWorkflow(w: Workflow) {
  w.dirty = true;
  const list = workflows();
  const i = list.findIndex((x) => x.id === w.id);
  if (i >= 0) list[i] = w; else list.unshift(w);
  save();
}

export function deleteWorkflow(id: string) {
  if (workflows().find((w) => w.id === id)?.synced) removed().workflows.push(id);
  db.workflows[me()] = workflows().filter((w) => w.id !== id);
  save();
}

// ---------- the same accounts and workflows on every device ----------
export interface CloudAccount { id: string; platform: PlatformId; handle: string | null; remote_id: string | null; updated_at: number | null }
export interface CloudWorkflow { id: string; name: string; source_id: string; destination_ids: string[]; active: boolean; auto_publish: boolean; caption_template: string | null; hashtags: string | null; delay_minutes: number }

export const pendingRemovals = (): Removed => ({ accounts: [...removed().accounts], workflows: [...removed().workflows] });

/** Take over what the server knows; things another device removed go here too. */
export function mergeCloudState(cloudAccounts: CloudAccount[], cloudFlows: CloudWorkflow[]) {
  const ids = new Set(cloudAccounts.map((a) => a.id));
  const gone = removed();
  // Removed elsewhere: was on the server before, isn't now.
  db.accounts[me()] = accounts().filter((a) => !a.cloud || ids.has(a.id));
  for (const c of cloudAccounts) {
    if (gone.accounts.includes(c.id)) continue;
    const local = account(c.id);
    if (local) { local.cloud = true; if (!local.handle && c.handle) local.handle = c.handle; }
    else accounts().push({ id: c.id, platform: c.platform, handle: c.handle || c.platform, connectedAt: c.updated_at || Date.now(), cloud: true });
  }
  const flowIds = new Set(cloudFlows.map((w) => w.id));
  db.workflows[me()] = workflows().filter((w) => !w.synced || flowIds.has(w.id));
  for (const c of cloudFlows) {
    if (gone.workflows.includes(c.id)) continue;
    const local = workflows().find((w) => w.id === c.id);
    if (local?.dirty) continue; // changed here; this device's version goes up next
    const w: Workflow = {
      id: c.id, name: c.name, sourceId: c.source_id, destinationIds: c.destination_ids, active: c.active, autoPublish: c.auto_publish,
      captionTemplate: c.caption_template ?? '{caption}', hashtags: c.hashtags ?? '', delayMinutes: c.delay_minutes,
      removeWatermark: local?.removeWatermark ?? true, createdAt: local?.createdAt ?? Date.now(), runs: local?.runs ?? 0, synced: true, dirty: false,
    };
    if (local) Object.assign(local, w); else workflows().unshift(w);
  }
  save();
}

/** The server took these: mark them, and forget the removals it has carried out. */
export function markSynced(accountIds: string[], flowIds: string[], sent: Removed) {
  for (const a of accounts()) if (accountIds.includes(a.id)) a.cloud = true;
  for (const w of workflows()) if (flowIds.includes(w.id)) { w.synced = true; w.dirty = false; }
  const r = removed();
  r.accounts = r.accounts.filter((id) => !sent.accounts.includes(id));
  r.workflows = r.workflows.filter((id) => !sent.workflows.includes(id));
  save();
}

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

/**
 * There is no sign-in: this browser has one profile. From the former sign-in,
 * the first profile with connected accounts or posts is used, so nothing is lost.
 */
function ensureProfile() {
  if (db.session && findUser(db.session)) return;
  const has = (u: User) => !!(db.accounts[u.email.toLowerCase()]?.length || db.posts[u.email.toLowerCase()]?.length || db.workflows[u.email.toLowerCase()]?.length);
  const u = db.users.find(has) ?? db.users[0] ?? createUser({ name: '', email: LOCAL_EMAIL, method: 'local' });
  db.session = u.email.toLowerCase();
  save();
}
export const LOCAL_EMAIL = 'me@crosspost.local';
ensureProfile();
