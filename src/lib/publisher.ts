// Real publishing for accounts connected through OAuth.
//   YouTube   – resumable upload straight from the browser (YouTube Data API v3,
//             videos.insert). Scheduled posts can be handed to YouTube at once
//             (private + status.publishAt), so they go live even with the app closed.
//   Facebook, Instagram, TikTok – the video is put on our server first (they
//             fetch it from a public address), then the server publishes it.
//   Snapchat  – Login Kit has no posting permission for ordinary apps, so
//             posts there stay manual.
import { integrations } from './config';
import { refreshAuth, serverCall } from './oauth';
import { commit, defaultYouTubeOptions, type Account, type Post } from './store';
import { authedFetch } from './server';
import { keptVideo } from './videos';

/** Picked files stay in memory for this session; scheduled posts after a reload need the server copy. */
const files = new Map<string, File>();
export const rememberFile = (postId: string, file: File) => files.set(postId, file);
export const hasFile = (postId: string) => files.has(postId);

export class PublishError extends Error {}

interface PublishReply { url?: string; id?: string; pending?: boolean; container_id?: string }

/** Make sure the access token is still valid, refreshing it through our server when possible. */
async function freshAuth(acc: Account) {
  const auth = acc.auth!;
  if (!auth.expiresAt || auth.expiresAt - 120_000 > Date.now()) return auth;
  if (auth.refreshToken && integrations().serverUrl && (acc.platform === 'youtube' || acc.platform === 'tiktok')) {
    acc.auth = await refreshAuth(acc.platform, auth);
    commit();
    return acc.auth;
  }
  throw new PublishError(acc.platform === 'youtube'
    ? 'Der YouTube-Zugang ist abgelaufen (ohne Server gilt er nur eine Stunde). Verbinde das Konto neu – mit eingerichtetem Server bleibt er dauerhaft bestehen.'
    : 'Die Anmeldung ist abgelaufen – verbinde das Konto neu.');
}

// YouTube refuses < and > in titles; titles max. 100, descriptions max. 5000 characters, tags max. 500 in total.
const cleanTitle = (t: string) => t.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
function youtubeMeta(post: Post, caption: string, file: File, publishAt?: number) {
  const o = { ...defaultYouTubeOptions(), ...post.youtube };
  let title = cleanTitle(post.title || file.name.replace(/\.[^.]+$/, '')) || 'Video';
  if (o.short && !/#shorts/i.test(title)) title = `${title.slice(0, 92)} #Shorts`;
  const tags: string[] = [];
  let total = 0;
  for (const t of o.tags.split(/[,#]/).map((x) => x.trim()).filter(Boolean)) {
    if (total + t.length + 1 > 500) break;
    tags.push(t);
    total += t.length + 1;
  }
  return {
    snippet: { title: title.slice(0, 100), description: caption.replace(/[<>]/g, '').slice(0, 5000), tags, categoryId: o.categoryId || '22' },
    status: publishAt
      ? { privacyStatus: 'private', publishAt: new Date(publishAt).toISOString(), selfDeclaredMadeForKids: o.madeForKids }
      : { privacyStatus: o.privacy, selfDeclaredMadeForKids: o.madeForKids },
  };
}

function putWithProgress(uploadUrl: string, file: File, onProgress?: (pct: number) => void): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'video/*');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new PublishError('Die Verbindung zu YouTube ist abgebrochen.'));
    xhr.send(file);
  });
}

async function youtubeUpload(acc: Account, post: Post, caption: string, file: File, onProgress?: (pct: number) => void, publishAt?: number) {
  const begin = async (token: string) => fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': file.type || 'video/*',
      'X-Upload-Content-Length': String(file.size),
    },
    body: JSON.stringify(youtubeMeta(post, caption, file, publishAt)),
  });
  let start = await begin((await freshAuth(acc)).accessToken);
  if (start.status === 401 && acc.auth?.refreshToken && integrations().serverUrl) {
    acc.auth = await refreshAuth('youtube', acc.auth);
    commit();
    start = await begin(acc.auth.accessToken);
  }
  if (start.status === 401) throw new PublishError('Die YouTube-Anmeldung ist abgelaufen – verbinde das Konto neu.');
  if (start.status === 403) {
    const err = await start.json().catch(() => ({}));
    const reason = err.error?.errors?.[0]?.reason || err.error?.message || '';
    throw new PublishError(/quota|limit/i.test(reason) ? 'Das tägliche Upload-Kontingent von YouTube ist aufgebraucht. Versuch es morgen noch einmal.' : `YouTube hat den Upload verweigert (${reason || 403}).`);
  }
  if (!start.ok) throw new PublishError(`YouTube hat den Upload abgelehnt (${start.status}).`);
  const uploadUrl = start.headers.get('Location');
  if (!uploadUrl) throw new PublishError('YouTube hat keine Upload-Adresse geliefert.');
  const put = await putWithProgress(uploadUrl, file, onProgress);
  if (put.status < 200 || put.status >= 300) throw new PublishError(`Der Upload zu YouTube ist fehlgeschlagen (${put.status}).`);
  const video = JSON.parse(put.body);
  return video.snippet?.title && /#shorts/i.test(video.snippet.title) ? `https://www.youtube.com/shorts/${video.id}` : `https://www.youtube.com/watch?v=${video.id}`;
}

/** Scheduled YouTube posts that can be uploaded now and published by YouTube itself. */
export function canHandOver(acc: Account, post: Post) {
  const o = { ...defaultYouTubeOptions(), ...post.youtube };
  return acc.platform === 'youtube' && !!acc.auth && o.platformSchedule && o.privacy === 'public' && files.has(post.id) && post.scheduledAt > Date.now() + 15 * 60_000;
}

/** Upload now; YouTube publishes at post.scheduledAt. */
export async function handOverToYouTube(acc: Account, post: Post, caption: string, onProgress?: (pct: number) => void) {
  return youtubeUpload(acc, post, caption, files.get(post.id)!, onProgress, post.scheduledAt);
}

async function uploadToServer(post: Post, file: File): Promise<string> {
  // Uploads need a server session, so strangers can't store files on our server.
  const res = await authedFetch(`/media?name=${encodeURIComponent(file.name)}`, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new PublishError(data.error || 'Das Video konnte nicht auf den Server hochgeladen werden.');
  post.mediaUrl = data.url;
  return data.url;
}

/** Publish one post to one connected account. Returns a link to the post when the platform gives one. */
export async function publishReal(acc: Account, post: Post, caption: string, onProgress?: (pct: number) => void): Promise<string | undefined> {
  if (!acc.auth) throw new PublishError('Das Konto ist nur als Demo verbunden.');
  // After a reload the file is no longer in memory, but this browser may have kept it.
  let file = files.get(post.id);
  if (!file) { file = await keptVideo(post.id); if (file) files.set(post.id, file); }

  if (acc.platform === 'snapchat') {
    throw new PublishError('Snapchat erlaubt normalen Apps kein automatisches Posten. Teile das Video direkt in der Snapchat-App.');
  }
  if (acc.platform === 'youtube') {
    if (!file) throw new PublishError('Das Video ist nicht mehr im Browser. Öffne den Post und wähl die Datei noch einmal aus.');
    return youtubeUpload(acc, post, caption, file, onProgress);
  }

  if (!integrations().serverUrl) throw new PublishError('Der Server ist noch nicht eingerichtet (Einstellungen → Integrationen).');
  const auth = await freshAuth(acc);
  let videoUrl = post.mediaUrl;
  if (!videoUrl) {
    if (!file) throw new PublishError('Das Video ist nicht mehr im Browser. Wähle die Datei noch einmal aus.');
    videoUrl = await uploadToServer(post, file);
  }
  let reply = await serverCall<PublishReply>('/publish', {
    platform: acc.platform,
    access_token: auth.accessToken,
    refresh_token: auth.refreshToken,
    account_id: acc.auth.remoteId,
    title: post.title,
    caption,
    video_url: videoUrl,
    options: { trial: post.instagram?.trial || undefined, tiktok_mode: post.tiktok?.mode },
  });
  // Instagram and TikTok fetch and process the video first (often a minute or more).
  // Ask again in short requests – one long request gets cut off along the way.
  for (let i = 0; reply.pending && i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    reply = await serverCall<PublishReply>('/publish/status', {
      platform: acc.platform,
      access_token: auth.accessToken,
      account_id: acc.auth.remoteId,
      container_id: reply.container_id,
    });
  }
  if (reply.pending) {
    const name = acc.platform === 'tiktok' ? 'TikTok' : 'Instagram';
    throw new PublishError(`${name} verarbeitet das Video nach 10 Minuten immer noch. Schau später in ${name} nach.`);
  }
  return reply.url;
}
