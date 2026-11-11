// Workflows with an Instagram source run on our server (server/workflows.js),
// so they keep working while this page is closed. This file holds the session
// with the server, hands workflows over and reads back what they picked up.
import { integrations } from './config';
import * as store from './store';
import type { Account, DeliveryStatus, Post, Workflow } from './store';

const keyName = () => `crosspost:server:${(store.currentUser()?.email ?? '').toLowerCase()}`;
const getKey = () => { try { return localStorage.getItem(keyName()); } catch { return null; } };
const setKey = (k: string | null) => { try { if (k) localStorage.setItem(keyName(), k); else localStorage.removeItem(keyName()); } catch { /* private mode */ } };

const serverUrl = () => integrations().serverUrl;
export const hasServerSession = () => !!getKey();

/** A connected account proves to the server who you are; Instagram's sign-in never expires. */
function identityAccount(): Account | undefined {
  const live = store.accounts().filter((a) => a.auth && (!a.auth.expiresAt || a.auth.expiresAt > Date.now() + 60_000));
  return ['instagram', 'youtube', 'tiktok', 'facebook'].map((p) => live.find((a) => a.platform === p)).find(Boolean);
}

async function sessionKey(): Promise<string> {
  const existing = getKey();
  if (existing) return existing;
  const acc = identityAccount();
  if (!acc?.auth) throw new Error('Connect Instagram, YouTube or TikTok first – the server recognises you by that account.');
  const res = await fetch(`${serverUrl()}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: acc.platform, access_token: acc.auth.accessToken, account_id: acc.auth.remoteId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.key) throw new Error(data.error || `Server answered ${res.status}`);
  setKey(data.key);
  return data.key;
}

/** A request with the server session; an ended session is set up again once. */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = async () => fetch(`${serverUrl()}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${await sessionKey()}` } });
  let res = await send();
  if (res.status === 401) { setKey(null); res = await send(); }
  return res;
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await authedFetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server answered ${res.status}`);
  return data as T;
}

/** Runs on the server: the source is Instagram, connected for real. */
export function runsOnServer(w: Workflow) {
  const src = store.account(w.sourceId);
  return !!serverUrl() && src?.platform === 'instagram' && !!src.auth;
}

/** Hand the server-side workflows and the sign-ins of connected accounts (for workflows and planned posts) to the server. */
export async function syncNow() {
  if (!serverUrl()) return;
  const flows = store.workflows().filter(runsOnServer);
  const live = store.accounts().filter((a) => a.auth);
  if (!live.length) return;
  const accounts = live.slice(0, 15).map((a) => ({
    id: a.id, platform: a.platform, handle: a.handle, remote_id: a.auth!.remoteId,
    access_token: a.auth!.accessToken, refresh_token: a.auth!.refreshToken, expires_at: a.auth!.expiresAt,
  }));
  await api('/api/sync', 'PUT', {
    accounts,
    workflows: flows.map((w) => ({
      id: w.id, name: w.name, source_id: w.sourceId, destination_ids: w.destinationIds, active: w.active, auto_publish: w.autoPublish,
      caption_template: w.captionTemplate, hashtags: w.hashtags, delay_minutes: w.delayMinutes,
    })),
  });
}

let syncTimer: number | undefined;
/** Sync shortly after a change; several changes in a row make one request. */
export function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => { syncNow().catch((e) => console.warn('Workflow sync failed:', e)); }, 400);
}

// ---------- planned posts and older Instagram videos ----------
export interface InstagramVideo { id: string; caption: string; thumbnail_url: string | null; permalink: string | null; timestamp: number | null; reel: boolean; downloadable: boolean; crossposted: boolean }

export async function listInstagramVideos(accountId: string, after?: string) {
  await syncNow();
  return api<{ videos: InstagramVideo[]; next: string | null }>(`/api/instagram/media?account=${encodeURIComponent(accountId)}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
}

/** Keep a file on the server until its planned time. */
export async function uploadForLater(file: File): Promise<string> {
  const res = await authedFetch(`/media?purpose=schedule&name=${encodeURIComponent(file.name)}`, { method: 'PUT', headers: { 'Content-Type': file.type || 'video/mp4' }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.key) throw new Error(data.error || 'The video could not be uploaded to the server.');
  return data.key;
}

export type PostSource = { type: 'upload'; key: string; thumbnail_url?: string } | { type: 'instagram'; account_id: string; media_id: string; permalink?: string; thumbnail_url?: string };
export interface ServerDelivery { account_id: string; caption: string; options?: Record<string, unknown> }

/** The server publishes at scheduled_at, also while this page is closed. */
export async function planServerPost(body: { title: string; caption: string; source: PostSource; scheduled_at: number; draft: boolean; deliveries: ServerDelivery[] }) {
  await syncNow();
  const r = await api<{ id: string; scheduled_at: number }>('/api/posts', 'POST', body);
  if (!body.draft && r.scheduled_at <= Date.now() + 5000) await api('/api/tick', 'POST').catch(() => {});
  await refreshServerPosts().catch(() => {});
  return r;
}

// ---------- what the server picked up ----------
interface ServerJob { id: string; account_id: string; platform: string; status: string; caption: string | null; url: string | null; error: string | null; scheduled_at: number; updated_at: number | null; options: string | null }

const inInbox = (j: ServerJob) => j.platform === 'tiktok' && j.status === 'published' && /"tiktok_mode":"inbox"/.test(j.options ?? '');
interface ServerItem { id: string; kind: 'workflow' | 'upload' | 'instagram'; title: string | null; workflow_id: string; source_media_id: string; source_account_id: string | null; caption: string | null; permalink: string | null; thumbnail_url: string | null; created_at: number; jobs: ServerJob[] }
export interface ServerWorkflowState { id: string; active: number; last_checked: number | null; last_error: string | null }

const STATUS: Record<string, DeliveryStatus> = { draft: 'draft', scheduled: 'scheduled', processing: 'publishing', published: 'published', failed: 'failed' };
let flowState = new Map<string, ServerWorkflowState>();
export const serverWorkflowState = (id: string) => flowState.get(id);

function toPost(i: ServerItem): Post {
  const caption = i.caption ?? '';
  const waiting = i.jobs.filter((j) => j.status === 'scheduled' || j.status === 'draft').map((j) => j.scheduled_at);
  const fromInstagram = i.kind !== 'upload';
  return {
    id: `srv-${i.id}`,
    remote: { itemId: i.id, permalink: i.permalink ?? undefined, kind: i.kind, mediaId: fromInstagram ? i.source_media_id : undefined, sourceAccountId: i.source_account_id ?? undefined },
    title: (i.title || caption.split('\n').map((s) => s.trim()).find(Boolean) || (fromInstagram ? 'Instagram video' : 'Video')).slice(0, 80), caption,
    mediaName: fromInstagram ? 'Instagram video' : 'Video', mediaType: 'video/mp4', mediaSize: 0, thumb: i.thumbnail_url ?? undefined,
    createdAt: i.created_at, scheduledAt: waiting.length ? Math.min(...waiting) : i.created_at, workflowId: i.kind === 'workflow' ? i.workflow_id : undefined,
    deliveries: i.jobs.map((j) => ({ accountId: j.account_id, status: STATUS[j.status] ?? 'failed', caption: j.caption ?? '', error: j.error ?? undefined, url: j.url ?? undefined, at: j.updated_at ?? undefined, label: inInbox(j) ? store.TIKTOK_INBOX_LABEL : undefined })),
  };
}

export async function refreshServerPosts() {
  if (!serverUrl() || !getKey()) return;
  const data = await api<{ items: ServerItem[]; workflows: ServerWorkflowState[] }>('/api/posts');
  flowState = new Map(data.workflows.map((w) => [w.id, w]));
  store.setRemotePosts(data.items.map(toPost));
}

/** While the page is open, move due jobs along faster than the 5-minute cron. */
export async function serverHeartbeat() {
  await refreshServerPosts();
  const now = Date.now();
  const busy = store.allPosts().some((p) => p.remote && p.deliveries.some((d) => d.status === 'publishing' || (d.status === 'scheduled' && p.scheduledAt <= now)));
  if (busy) {
    await api('/api/tick', 'POST');
    await refreshServerPosts();
  }
}

export async function runServerWorkflow(id: string) {
  await syncNow();
  const r = await api<{ found: number; processed: number }>(`/api/workflows/${id}/run`, 'POST');
  await refreshServerPosts().catch(() => {});
  return r;
}

export async function itemAction(itemId: string, action: 'approve' | 'retry' | 'delete') {
  await api(action === 'delete' ? `/api/items/${itemId}` : `/api/items/${itemId}/${action}`, action === 'delete' ? 'DELETE' : 'POST');
  if (action !== 'delete') await api('/api/tick', 'POST').catch(() => {});
  await refreshServerPosts();
}
