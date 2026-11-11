// Videos you post from this browser are kept here (IndexedDB), so a post can be
// watched again later and used once more – without keeping them on the server.
const DB = 'crosspost-videos';
const STORE = 'videos';
/** Bigger files are not kept, so the browser's storage doesn't fill up. */
export const MAX_KEEP_BYTES = 1024 * 1024 * 1024;

interface Saved { id: string; blob: Blob; name: string; type: string; size: number; savedAt: number }

let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  });
  return opening;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Keep the file for this post. Never throws: keeping a copy is a convenience. */
export async function keepVideo(postId: string, file: File) {
  if (file.size > MAX_KEEP_BYTES) return false;
  try {
    // Ask the browser not to clear this storage on its own when space runs low.
    navigator.storage?.persist?.().catch(() => {});
    await run('readwrite', (s) => s.put({ id: postId, blob: file, name: file.name, type: file.type, size: file.size, savedAt: Date.now() } satisfies Saved));
    return true;
  } catch (e) {
    console.warn('Could not keep the video in this browser:', e);
    return false;
  }
}

/** The kept file for a post, if this browser has it. */
export async function keptVideo(postId: string): Promise<File | undefined> {
  try {
    const v = await run<Saved | undefined>('readonly', (s) => s.get(postId) as IDBRequest<Saved | undefined>);
    return v ? new File([v.blob], v.name, { type: v.type }) : undefined;
  } catch { return undefined; }
}

export async function forgetVideo(postId: string) {
  try { await run('readwrite', (s) => s.delete(postId)); } catch { /* nothing kept */ }
}

export async function keptVideosUsage(): Promise<{ count: number; bytes: number }> {
  try {
    const all = await run<Saved[]>('readonly', (s) => s.getAll() as IDBRequest<Saved[]>);
    return { count: all.length, bytes: all.reduce((n, v) => n + v.size, 0) };
  } catch { return { count: 0, bytes: 0 }; }
}

export async function forgetAllVideos() {
  try { await run('readwrite', (s) => s.clear()); } catch { /* nothing kept */ }
}
