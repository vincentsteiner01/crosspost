import '../styles/base.css';
import '../styles/app.css';
import { icons } from '../lib/icons';
import { PLATFORMS, badge, platform, type PlatformId } from '../lib/platforms';
import * as store from '../lib/store';
import type { Account, Delivery, Post, Workflow } from '../lib/store';
import { OAUTH_PLATFORMS, integrations, isConfigured, saveIntegrations, type Integrations, type OAuthPlatform } from '../lib/config';
import { redirectUri, startOAuth } from '../lib/oauth';
import { canHandOver, handOverToYouTube, publishReal, rememberFile } from '../lib/publisher';
import { defaultYouTubeOptions, type InstagramOptions, type TikTokOptions, type YouTubeOptions } from '../lib/store';
import { url } from '../lib/paths';
import { forgetAllVideos, forgetVideo, keepVideo, keptVideo, keptVideosUsage } from '../lib/videos';
import { createShortcutKey, deleteInboxItem, hasServerSession, inboxEndpoint, inboxItems, itemAction, linkWithCode, listInstagramVideos, planServerPost, refreshInbox, runServerWorkflow, runsOnServer, scheduleSync, serverHeartbeat, serverWorkflowState, syncNow, uploadForLater, type InboxItem, type InstagramVideo, type PostSource } from '../lib/server';


const root = document.getElementById('app')!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const isOAuth = (id: PlatformId): id is OAuthPlatform => (OAUTH_PLATFORMS as string[]).includes(id);

// ---------- formatting ----------
const fmtDate = (t: number) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const accountsText = (n: number) => (n === 1 ? '1 Konto' : `${n} Konten`);
const toLocalInput = (t: number) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const STATUS_LABEL: Record<string, string> = { scheduled: 'Geplant', publishing: 'Wird veröffentlicht…', published: 'Veröffentlicht', 'handed-over': 'Bei YouTube geplant', failed: 'Fehlgeschlagen', draft: 'Wartet auf Freigabe' };

function postStatus(p: Post): string {
  const s = p.deliveries.map((d) => d.status);
  if (!s.length || s.every((x) => x === 'draft')) return 'draft';
  if (s.some((x) => x === 'publishing')) return 'publishing';
  if (s.some((x) => x === 'scheduled' || x === 'handed-over')) return 'scheduled';
  if (s.some((x) => x === 'failed')) return 'failed';
  return 'published';
}

function toast(msg: string) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function modal(html: string, onMount: (el: HTMLElement, close: () => void) => void) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
  document.body.appendChild(back);
  onMount(back.querySelector('.modal')!, close);
}

function confirmBox(title: string, text: string, ok: string, onOk: () => void) {
  modal(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="row"><button class="btn" data-x>Abbrechen</button><button class="btn primary" data-ok>${esc(ok)}</button></div>`, (el, close) => {
    el.querySelector('[data-x]')!.addEventListener('click', close);
    el.querySelector('[data-ok]')!.addEventListener('click', () => { close(); onOk(); });
  });
}

// ---------- publishing ----------
// Accounts connected through the platform's own sign-in publish for real
// (see lib/publisher.ts). Demo connections are simulated: a due delivery moves
// to "publishing" and then to "published", unless the caption breaks the
// platform's limit.
function checkDelivery(d: Delivery, post: Post): string | undefined {
  const acc = store.account(d.accountId);
  if (!acc) return 'Das Konto wurde getrennt';
  const p = platform(acc.platform);
  if (p.limit && d.caption.length > p.limit) return `Die Beschreibung hat ${d.caption.length} Zeichen, ${p.name} erlaubt ${p.limit}`;
  if (!post.mediaName && ['tiktok', 'youtube', 'snapchat', 'amazon'].includes(p.id)) return `${p.name} braucht ein Video`;
  if (post.mediaType && !post.mediaType.startsWith('video') && ['tiktok', 'youtube'].includes(p.id)) return `${p.name} nimmt nur Videos, keine Bilder`;
  return undefined;
}

/** Show upload progress in steps of 5 %, so the screen isn't redrawn for every byte. */
function progressReporter(d: Delivery) {
  return (pct: number) => {
    if (d.progress === undefined || pct - d.progress >= 5 || pct === 100) { d.progress = pct; store.commit(); }
  };
}

function processQueue() {
  const now = Date.now();
  let changed = false;
  for (const post of store.posts()) {
    for (const d of post.deliveries) {
      // YouTube has already been told when to publish; mark it done once that time has come.
      if (d.status === 'handed-over' && post.scheduledAt <= now) { d.status = 'published'; changed = true; continue; }
      const acc0 = d.status === 'scheduled' && post.scheduledAt > now ? store.account(d.accountId) : undefined;
      if (acc0 && canHandOver(acc0, post) && !checkDelivery(d, post)) {
        d.status = 'publishing';
        changed = true;
        handOverToYouTube(acc0, post, d.caption, progressReporter(d))
          .then((link) => { d.status = 'handed-over'; d.url = link; d.error = undefined; })
          .catch((e: Error) => { d.status = 'failed'; d.error = e.message; })
          .finally(() => { d.progress = undefined; d.at = Date.now(); store.commit(); });
        continue;
      }
      if (d.status === 'scheduled' && post.scheduledAt <= now) {
        d.status = 'publishing';
        changed = true;
        const acc = store.account(d.accountId);
        if (acc?.cloud && !acc.auth) {
          d.status = 'failed';
          d.error = 'Dieses Konto ist über den Server verbunden – Posts dorthin brauchen ein Video und laufen über den Server. Erstelle den Post noch einmal mit Video.';
          d.at = Date.now();
          continue;
        }
        if (acc?.auth) {
          const err = checkDelivery(d, post);
          (err ? Promise.reject(new Error(err)) : publishReal(acc, post, d.caption, progressReporter(d)))
            .then((link) => { d.status = 'published'; d.url = link; d.error = undefined; d.label = acc.platform === 'tiktok' && post.tiktok?.mode === 'inbox' ? store.TIKTOK_INBOX_LABEL : undefined; })
            .catch((e: Error) => { d.status = 'failed'; d.error = e.message; })
            .finally(() => { d.progress = undefined; d.at = Date.now(); store.commit(); });
          continue;
        }
        const delay = 900 + Math.random() * 1600;
        setTimeout(() => {
          const err = checkDelivery(d, post);
          d.status = err ? 'failed' : 'published';
          d.error = err;
          d.at = Date.now();
          store.commit();
        }, delay);
      }
    }
  }
  if (changed) store.commit();
}

// A run of a workflow: new content from the source becomes a post for each destination.
function runWorkflow(w: Workflow, title?: string) {
  const src = store.account(w.sourceId);
  if (!src) { toast('Verbinde zuerst das Quellkonto'); return; }
  const dests = w.destinationIds.map(store.account).filter(Boolean) as Account[];
  if (!dests.length) { toast('Wähle mindestens ein Ziel aus'); return; }
  w.runs += 1;
  const t = title ?? `Neu: ${platform(src.platform).formats[0] ?? 'Post'} von @${src.handle} #${w.runs}`;
  const caption = applyTemplate(w, t, `Beispieltext von ${platform(src.platform).name}`);
  const post: Post = {
    id: store.uid(), title: t, caption, mediaName: `${src.handle}-${w.runs}.mp4`, mediaType: 'video/mp4', mediaSize: 8_400_000,
    createdAt: Date.now(), scheduledAt: Date.now() + w.delayMinutes * 60000, workflowId: w.id,
    deliveries: dests.map((a) => ({ accountId: a.id, status: w.autoPublish ? 'scheduled' : 'draft', caption: fitCaption(caption, a.platform) })),
  };
  store.saveWorkflow(w);
  store.savePost(post);
  processQueue();
  toast(w.autoPublish ? 'Workflow ausgeführt: Post wird veröffentlicht' : 'Workflow ausgeführt: Post wartet auf deine Freigabe');
}

function applyTemplate(w: Workflow, title: string, caption: string) {
  let out = (w.captionTemplate || '{caption}').replaceAll('{caption}', caption).replaceAll('{title}', title);
  if (w.hashtags.trim()) out += `\n\n${w.hashtags.trim()}`;
  return out;
}

function fitCaption(caption: string, id: PlatformId) {
  const lim = platform(id).limit;
  return lim && caption.length > lim ? caption.slice(0, lim - 1) + '…' : caption;
}

// ---------- layout ----------
const NAV = [
  { href: '#/', label: 'Übersicht', icon: icons.home },
  { href: '#/create', label: 'Post erstellen', icon: icons.plus },
  { href: '#/workflows', label: 'Workflows', icon: icons.flow },
  { href: '#/inbox', label: 'Eingang', icon: icons.upload },
  { href: '#/posts', label: 'Inhalte', icon: icons.film },
  { href: '#/calendar', label: 'Kalender', icon: icons.calendar },
  { href: '#/accounts', label: 'Verbundene Konten', icon: icons.link },
  { href: '#/settings', label: 'Einstellungen', icon: icons.gear },
];

function shell(title: string, body: string, route: string) {
  const u = store.currentUser()!;
  const pending = store.allPosts().filter((p) => postStatus(p) === 'draft').length;
  return `<div class="shell">
  <aside class="sidebar">
    <a class="brand" href="#/">${icons.logoMark}<span>Crosspost</span></a>
    <nav class="nav">${NAV.map((n) => `<a href="${n.href}" class="${route === n.href ? 'active' : ''}">${n.icon}<span>${n.label}</span>${n.href === '#/posts' && pending ? `<span class="count">${pending}</span>` : ''}${n.href === '#/inbox' && inboxItems().length ? `<span class="count">${inboxItems().length}</span>` : ''}</a>`).join('')}</nav>
    <div class="side-foot">
      <a class="me" href="#/settings"><div class="avatar">${esc((u.name || 'C')[0]!.toUpperCase())}</div><div class="me-text"><b>${esc(u.name || 'Dein Crosspost')}</b><small>${u.email === store.LOCAL_EMAIL ? 'Einstellungen' : esc(u.email)}</small></div></a>
    </div>
  </aside>
  <div class="scrim" data-action="close-menu"></div>
  <div class="main">
    <header class="topbar">
      <button class="menu-btn" data-action="menu" aria-label="Menü">${icons.menu}</button>
      <h1>${esc(title)}</h1>
      ${OAUTH_PLATFORMS.some(isConfigured) ? '' : `<span class="demo-pill" title="Noch keine Plattform-Anmeldung eingerichtet (Einstellungen → Integrationen) – Veröffentlichen wird deshalb nur simuliert.">Demo-Modus</span>`}
      <span class="spacer"></span>
      ${route === '#/create' ? '' : `<a class="btn primary" href="#/create">${icons.plus}<span class="label">Post erstellen</span></a>`}
    </header>
    <main class="content">${body}</main>
  </div>
</div>`;
}

// ---------- views ----------
function postRow(p: Post, actions = true) {
  const status = postStatus(p);
  return `<div class="post-row">
    <a class="thumb" href="#/post?id=${encodeURIComponent(p.id)}" aria-label="Post öffnen">${p.thumb ? `<img src="${esc(p.thumb)}" alt="">` : icons.play}</a>
    <div class="post-main">
      <a class="post-link" href="#/post?id=${encodeURIComponent(p.id)}"><b>${esc(p.title || 'Post ohne Titel')}</b></a>
      <small>${STATUS_LABEL[status]} · ${fmtDate(p.scheduledAt)}${p.workflowId ? ' · über Workflow' : ''}${p.remote?.permalink ? ` · <a href="${esc(p.remote.permalink)}" target="_blank" rel="noopener">Original</a>` : ''}</small>
      <div class="chips">${p.deliveries.map((d) => {
        const a = store.account(d.accountId);
        return `<${d.url ? `a href="${esc(d.url)}" target="_blank" rel="noopener"` : 'span'} class="chip ${d.status}" title="${esc(d.error ?? (d.label === store.TIKTOK_INBOX_LABEL ? 'Öffne die TikTok-App → Posteingang → die Benachrichtigung von Crosspost Studio und poste das Video dort' : STATUS_LABEL[d.status]!))}">${a ? badge(a.platform, 18) : ''}${a ? '@' + esc(a.handle) : 'getrennt'} · ${d.status === 'published' && d.label ? esc(d.label) : STATUS_LABEL[d.status]}${d.status === 'publishing' && d.progress !== undefined ? ` ${d.progress}&nbsp;%` : ''}${d.error ? ' – ' + esc(d.error) : ''}</${d.url ? 'a' : 'span'}>`;
      }).join('')}</div>
    </div>
    ${actions ? `<div class="post-actions">
      ${status === 'draft' ? `<button class="btn small primary" data-action="approve" data-id="${p.id}">Freigeben</button>` : ''}
      ${p.deliveries.some((d) => d.status === 'failed') ? `<button class="btn small" data-action="retry" data-id="${p.id}">Erneut versuchen</button>` : ''}
      ${(status === 'draft' || status === 'scheduled') && !p.remote ? `<a class="btn small" href="#/create?edit=${p.id}">Bearbeiten</a>` : ''}
      <button class="icon-btn" data-action="delete-post" data-id="${p.id}" aria-label="Löschen">${icons.trash}</button>
    </div>` : ''}
  </div>`;
}

function viewDashboard() {
  const accs = store.accounts();
  const wfs = store.workflows();
  const posts = store.allPosts();
  const deliveries = posts.flatMap((p) => p.deliveries);
  const hasSource = accs.some((a) => platform(a.platform).source);
  const hasDest = accs.some((a) => platform(a.platform).destination);
  const steps = [
    { done: hasSource, title: 'Quelle verbinden', text: 'Woher deine Inhalte kommen, z. B. TikTok oder YouTube.', href: '#/accounts' },
    { done: accs.filter((a) => platform(a.platform).destination).length >= 2, title: 'Ziele verbinden', text: 'Überall, wo du veröffentlichen willst.', href: '#/accounts' },
    { done: wfs.length > 0, title: 'Workflow erstellen', text: 'Neue Inhalte automatisch von einem Konto an viele schicken.', href: '#/workflows/new' },
    { done: deliveries.some((d) => d.status === 'published'), title: 'Ersten Post veröffentlichen', text: 'Einmal hochladen, überall posten.', href: '#/create' },
  ];
  const u = store.currentUser()!;
  return shell('Übersicht', `
    <section class="card welcome">
      <h2>Hallo${u.name ? ` ${esc(u.name)}` : ''}, bereit zum Crossposten?</h2>
      <p>Lade ein Video einmal hoch und veröffentliche es auf all deinen Kanälen – oder lass einen Workflow jeden neuen Post automatisch übernehmen.</p>
      <div class="row"><a class="btn" href="#/create">${icons.upload}Hochladen &amp; crossposten</a><a class="btn" href="#/workflows/new">${icons.flow}Neuer Workflow</a></div>
    </section>
    <div class="stats">
      <div class="stat"><span>Verbundene Konten</span><b>${accs.length}</b></div>
      <div class="stat"><span>Aktive Workflows</span><b>${wfs.filter((w) => w.active).length}</b></div>
      <div class="stat"><span>Geplant</span><b>${deliveries.filter((d) => d.status === 'scheduled' || d.status === 'draft').length}</b></div>
      <div class="stat"><span>Veröffentlicht</span><b>${deliveries.filter((d) => d.status === 'published').length}</b></div>
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="section-head"><h2>Neueste Posts</h2><a href="#/posts" class="btn small ghost">Alle ansehen</a></div>
        ${posts.length ? posts.slice(0, 5).map((p) => postRow(p, false)).join('') : `<div class="empty"><b>Noch keine Posts</b>Erstelle deinen ersten Post und schick ihn auf einen Schlag an alle Plattformen.<br><a class="btn primary" href="#/create">Post erstellen</a></div>`}
      </section>
      <section class="card">
        <h2>Erste Schritte</h2>
        <p class="sub">${steps.filter((s) => s.done).length} von ${steps.length} erledigt${hasDest ? '' : ' · verbinde, wo du veröffentlichst'}</p>
        <ul class="steps">${steps.map((s, i) => `<li class="${s.done ? 'done' : ''}"><span class="tick">${s.done ? icons.check : i + 1}</span><span class="grow"><b>${s.title}</b><small>${s.text}</small></span>${s.done ? '' : `<a class="btn small" href="${s.href}">Los</a>`}</li>`).join('')}</ul>
      </section>
    </div>`, '#/');
}

// Composer state survives re-renders while the person is on the page.
interface Draft {
  yt: YouTubeOptions; insta: InstagramOptions; tt: TikTokOptions;
  /** A video already on Instagram, cross-posted through the server instead of a file. */
  ig?: { accountId: string; mediaId: string; permalink?: string };
  /** A video shared in from the iPhone, waiting on the server. */
  inbox?: { id: string };
  id: string; title: string; caption: string; file?: File; mediaUrl?: string; mediaName: string; mediaType: string; mediaSize: number; thumb?: string; selected: Set<string>; overrides: Record<string, string>; open: Set<string>; when: 'now' | 'later'; at: number }
let draft: Draft | null = null;

function newDraft(editId?: string): Draft {
  const p = editId ? store.posts().find((x) => x.id === editId) : undefined;
  if (p) {
    return {
      yt: { ...defaultYouTubeOptions(), ...p.youtube }, insta: { trial: p.instagram?.trial ?? '' }, tt: { mode: p.tiktok?.mode ?? 'inbox' },
      id: p.id, title: p.title, caption: p.caption, mediaName: p.mediaName, mediaType: p.mediaType, mediaSize: p.mediaSize, thumb: p.thumb,
      selected: new Set(p.deliveries.map((d) => d.accountId)),
      overrides: Object.fromEntries(p.deliveries.filter((d) => d.caption !== p.caption).map((d) => [d.accountId, d.caption])),
      open: new Set(), when: p.scheduledAt > Date.now() + 60000 ? 'later' : 'now', at: Math.max(p.scheduledAt, Date.now() + 3600000),
    };
  }
  return { yt: defaultYouTubeOptions(), insta: { trial: '' }, tt: { mode: 'inbox' }, id: store.uid(), title: '', caption: '', mediaName: '', mediaType: '', mediaSize: 0, selected: new Set(store.accounts().filter((a) => platform(a.platform).destination).map((a) => a.id)), overrides: {}, open: new Set(), when: 'now', at: Date.now() + 3600000 };
}

let inboxLoading: string | null = null;

/** A video shared from the iPhone: sign in with the link's one-time code if needed, then put it into a new post. */
async function openInboxVideo(id: string, code: string | null) {
  inboxLoading = id;
  render();
  try {
    if (code && !hasServerSession()) await linkWithCode(code);
    // Drop the one-time code from the address, so a reload doesn't try it again.
    history.replaceState(null, '', `#/create?inbox=${encodeURIComponent(id)}`);
    await syncNow();
    const item = (await refreshInbox()).find((x) => x.id === id);
    if (!item) { toast('Dieses Video ist nicht mehr in deinem Eingang'); location.hash = '#/inbox'; return; }
    draft = inboxDraft(item);
    makeThumb({ type: item.type }, item.url).then((t) => { if (draft?.inbox?.id === id && t) { draft.thumb = t; render(); } });
  } catch (e) {
    toast((e as Error).message);
  } finally {
    inboxLoading = null;
    render();
  }
}

function inboxDraft(item: InboxItem): Draft {
  const d = newDraft();
  Object.assign(d, { inbox: { id: item.id }, mediaUrl: item.url, mediaName: item.name, mediaType: item.type, mediaSize: item.size });
  return d;
}

function viewCreate(params: URLSearchParams) {
  const editId = params.get('edit') ?? undefined;
  const inboxId = params.get('inbox');
  if (inboxId && draft?.inbox?.id !== inboxId && inboxLoading !== inboxId) {
    const item = inboxItems().find((x) => x.id === inboxId);
    if (item && !params.get('link')) draft = inboxDraft(item);
    else queueMicrotask(() => openInboxVideo(inboxId, params.get('link')));
  }
  if (!draft || (editId && draft.id !== editId) || (!editId && !inboxId && store.posts().some((p) => p.id === draft!.id))) draft = newDraft(editId);
  const d = draft;
  const dests = store.accounts().filter((a) => platform(a.platform).destination);
  const ig = liveInstagram();
  const media = d.mediaName
    ? `<div class="media-chosen"><div class="thumb">${d.thumb ? `<img src="${esc(d.thumb)}" alt="">` : icons.play}</div><div class="post-main"><b>${esc(d.mediaName)}</b><small>${d.ig ? `Von Instagram${d.ig.permalink ? ` · <a href="${esc(d.ig.permalink)}" target="_blank" rel="noopener">öffnen</a>` : ''}` : d.inbox ? `Aus deinem Eingang · ${fmtSize(d.mediaSize)}` : `${esc(d.mediaType || 'Datei')} · ${fmtSize(d.mediaSize)}`}</small></div><button class="btn small" data-action="${d.ig ? 'pick-ig' : 'pick-media'}">Ersetzen</button><button class="icon-btn" data-action="clear-media" aria-label="Entfernen">${icons.trash}</button></div>`
    : inboxLoading ? `<div class="drop">${icons.upload}<b>Video wird aus deinem Eingang geladen…</b></div>`
    : `<label class="drop" id="drop">${icons.upload}<b>Video oder Bild hierher ziehen</b><span>oder klicken und Datei auswählen · MP4, MOV, JPG, PNG</span></label>${ig ? `<button class="btn small" data-action="pick-ig" style="margin-top:10px">${badge('instagram', 18)}Video von Instagram übernehmen</button>` : ''}`;
  return shell(editId ? 'Post bearbeiten' : 'Post erstellen', `
    <div class="composer">
      <div class="stack">
        <section class="card stack">
          <div><span class="field-label">Medien</span>${media}<input type="file" id="media-input" accept="video/*,image/*" hidden></div>
          <div><label class="field-label" for="c-title">Titel</label><input class="input" id="c-title" maxlength="100" placeholder="Wird als YouTube-Titel und in deiner Inhaltsliste verwendet" value="${esc(d.title)}"></div>
          <div><label class="field-label" for="c-caption">Beschreibung</label><textarea class="textarea" id="c-caption" placeholder="Schreib eine Beschreibung für alle Plattformen. Unten kannst du sie pro Konto anpassen.">${esc(d.caption)}</textarea><div class="counter" id="c-count">${d.caption.length} Zeichen</div></div>
        </section>
        <section class="card">
          <div class="section-head"><div><h2>Veröffentlichen auf</h2><p class="sub" style="margin:0">${d.selected.size} von ${accountsText(dests.length)} ausgewählt</p></div><a class="btn small" href="#/accounts">${icons.plus}Konto verbinden</a></div>
          ${dests.length ? `<div class="dest-list">${dests.map((a) => destRow(a, d)).join('')}</div>` : `<div class="empty"><b>Keine Ziele verbunden</b>Verbinde TikTok, Instagram, YouTube und mehr, um dort zu veröffentlichen.<br><a class="btn primary" href="#/accounts">Konten verbinden</a></div>`}
        </section>
        ${youtubeCard(d)}${instagramCard(d)}${tiktokCard(d)}
        <section class="card">
          <h2>Wann</h2>
          <p class="sub">Alle Zeiten in der Zeitzone ${esc(store.currentUser()!.timezone)}.</p>
          <div class="row"><div class="seg"><button data-action="when" data-v="now" class="${d.when === 'now' ? 'active' : ''}">Jetzt veröffentlichen</button><button data-action="when" data-v="later" class="${d.when === 'later' ? 'active' : ''}">Planen</button></div>
          ${d.when === 'later' ? `<input type="datetime-local" class="input" id="c-at" style="max-width:240px" value="${toLocalInput(d.at)}">` : ''}</div>
          <div class="row" style="margin-top:20px;justify-content:flex-end"><button class="btn" data-action="save-draft">Als Entwurf speichern</button><button class="btn primary" data-action="publish" ${d.selected.size ? '' : 'disabled'}>${d.when === 'now' ? 'Jetzt veröffentlichen' : 'Post planen'}</button></div>
        </section>
      </div>
      <aside class="card sticky"><h2>Vorschau</h2><p class="sub">So sieht es in einem Hochkant-Feed aus.</p>
        <div class="phone">${d.mediaUrl && d.mediaType.startsWith('video') ? `<video src="${d.mediaUrl}" muted loop autoplay playsinline></video>` : d.mediaUrl || d.thumb ? `<img src="${d.mediaUrl ?? d.thumb}" alt="">` : `<div class="ph-empty">Hier erscheint dein Video</div>`}<div class="ph-cap" id="ph-cap">${esc(d.caption)}</div></div>
      </aside>
    </div>`, '#/create');
}

/** Settings that only YouTube uses; shown while a YouTube account is selected. */
function youtubeCard(d: Draft) {
  const yts = [...d.selected].map(store.account).filter((a) => a?.platform === 'youtube') as Account[];
  if (!yts.length) return '';
  const o = d.yt;
  const live = yts.some((a) => store.isLive(a));
  const opt = (v: string, label: string) => `<option value="${v}" ${o.privacy === v ? 'selected' : ''}>${label}</option>`;
  const cat = (v: string, label: string) => `<option value="${v}" ${o.categoryId === v ? 'selected' : ''}>${label}</option>`;
  return `<section class="card stack" id="yt-card">
    <div><h2>${badge('youtube', 22)} YouTube</h2><p class="sub" style="margin:0">Der Titel oben wird zum Videotitel (max. 100 Zeichen), die Beschreibung zur Videobeschreibung.</p></div>
    <div class="form-grid">
      <div><label class="field-label" for="yt-privacy">Sichtbarkeit</label><select class="select" id="yt-privacy">${opt('public', 'Öffentlich')}${opt('unlisted', 'Nicht gelistet')}${opt('private', 'Privat')}</select></div>
      <div><label class="field-label" for="yt-category">Kategorie</label><select class="select" id="yt-category">${cat('22', 'Menschen &amp; Blogs')}${cat('24', 'Unterhaltung')}${cat('26', 'Praktische Tipps &amp; Styling')}${cat('27', 'Bildung')}${cat('28', 'Wissenschaft &amp; Technik')}${cat('10', 'Musik')}${cat('17', 'Sport')}${cat('20', 'Gaming')}${cat('19', 'Reisen &amp; Events')}${cat('15', 'Tiere')}${cat('23', 'Comedy')}${cat('25', 'Nachrichten &amp; Politik')}</select></div>
    </div>
    <div><label class="field-label" for="yt-tags">Tags</label><input class="input" id="yt-tags" placeholder="reels, tutorial, hinter den kulissen" value="${esc(o.tags)}"><div class="hint">Mit Kommas getrennt, insgesamt höchstens 500 Zeichen.</div></div>
    <label class="check-row"><input type="checkbox" id="yt-short" ${o.short ? 'checked' : ''}><span><b>Als Short veröffentlichen</b><small>Hängt #Shorts an den Titel an. Hochkant-Videos bis 3 Minuten erscheinen im Shorts-Feed.</small></span></label>
    <label class="check-row"><input type="checkbox" id="yt-kids" ${o.madeForKids ? 'checked' : ''}><span><b>Speziell für Kinder</b><small>YouTube verlangt diese Angabe gesetzlich (COPPA). Bei Videos für Kinder sind Kommentare und einige Funktionen abgeschaltet.</small></span></label>
    ${live && !integrations().serverUrl ? `<label class="check-row"><input type="checkbox" id="yt-schedule" ${o.platformSchedule ? 'checked' : ''}><span><b>Geplante Posts von YouTube veröffentlichen lassen</b><small>Das Video wird sofort privat hochgeladen und YouTube schaltet es zur geplanten Zeit öffentlich – auch wenn diese App geschlossen ist. Braucht mindestens 15 Minuten Vorlauf und die Sichtbarkeit „Öffentlich“.</small></span></label>` : ''}
  </section>`;
}

/** Instagram's own options; shown while an Instagram account connected for real is selected. */
function instagramCard(d: Draft) {
  if (![...d.selected].some((id) => { const a = store.account(id); return a?.platform === 'instagram' && store.isLive(a); })) return '';
  const t = d.insta.trial;
  return `<section class="card stack" id="ig-card">
    <div><h2>${badge('instagram', 22)} Instagram</h2><p class="sub" style="margin:0">Wird als Reel gepostet.</p></div>
    <label class="check-row"><input type="checkbox" id="ig-trial" ${t ? 'checked' : ''}><span><b>Als Test-Reel teilen</b><small>Instagram zeigt es zuerst Leuten, die dir nicht folgen. Gut, um eine Idee auszuprobieren, bevor deine Follower sie sehen.</small></span></label>
    ${t ? `<div><label class="field-label" for="ig-grad">Mit deinen Followern teilen</label><select class="select" id="ig-grad"><option value="MANUAL" ${t === 'MANUAL' ? 'selected' : ''}>Selbst, später in der Instagram-App</option><option value="SS_PERFORMANCE" ${t === 'SS_PERFORMANCE' ? 'selected' : ''}>Automatisch, wenn es gut ankommt</option></select></div>` : ''}
  </section>`;
}

/** How the video reaches TikTok; shown while a TikTok account connected for real is selected. */
function tiktokCard(d: Draft) {
  if (![...d.selected].some((id) => { const a = store.account(id); return a?.platform === 'tiktok' && store.isLive(a); })) return '';
  const radio = (v: TikTokOptions['mode'], title: string, text: string) => `<label class="check-row"><input type="radio" name="tt-mode" value="${v}" ${d.tt.mode === v ? 'checked' : ''}><span><b>${title}</b><small>${text}</small></span></label>`;
  return `<section class="card stack" id="tt-card">
    <div><h2>${badge('tiktok', 22)} TikTok</h2></div>
    ${radio('inbox', 'Als Entwurf an die TikTok-App senden', 'Das Video wartet in deinem TikTok-Posteingang. Füge dort Sound und Text hinzu und poste es selbst.')}
    ${radio('direct', 'Direkt posten', 'Solange TikTok diese App noch nicht geprüft hat, sind direkte Posts nur für dich sichtbar und dein Konto muss privat sein.')}
  </section>`;
}

const liveInstagram = () => (integrations().serverUrl ? store.accounts().find((a) => a.platform === 'instagram' && store.isLive(a)) : undefined);

function instagramPicker() {
  const acc = liveInstagram();
  if (!acc) { toast('Verbinde zuerst Instagram'); return; }
  modal(`<h3>${badge('instagram', 26)}Videos auf @${esc(acc.handle)}</h3><p>Neueste zuerst. Videos mit lizenzierter Musik gibt Instagram nicht zum Herunterladen frei – lade dafür die Originaldatei hoch.</p><div class="ig-grid" id="ig-grid"><p class="hint">Wird geladen…</p></div><div class="row"><button class="btn" data-more hidden>Mehr laden</button><button class="btn" data-x>Schließen</button></div>`, (el, close) => {
    el.classList.add('wide');
    const grid = el.querySelector<HTMLElement>('#ig-grid')!;
    const more = el.querySelector<HTMLButtonElement>('[data-more]')!;
    let list: InstagramVideo[] = [];
    let next: string | null = null;
    const day = (t: number | null) => (t ? new Date(t).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
    const tile = (v: InstagramVideo) => `<button type="button" class="ig-tile" data-ig="${esc(v.id)}" ${v.downloadable ? '' : 'disabled'} title="${esc(v.caption.slice(0, 200))}">${v.thumbnail_url ? `<img src="${esc(v.thumbnail_url)}" alt="" loading="lazy">` : ''}<span class="ig-meta">${day(v.timestamp)}${v.crossposted ? '<br>Schon weitergepostet' : ''}${v.downloadable ? '' : '<br>Lizenzierte Musik – kein Download'}</span></button>`;
    const load = async (after?: string) => {
      more.disabled = true;
      try {
        const r = await listInstagramVideos(acc.id, after);
        list = after ? [...list, ...r.videos] : r.videos;
        next = r.next;
        grid.innerHTML = list.length ? list.map(tile).join('') : '<p class="hint">Auf diesem Konto gibt es noch keine Videos.</p>';
        more.hidden = !next;
      } catch (e) {
        grid.innerHTML = `<p class="hint">${esc((e as Error).message)}</p>`;
      }
      more.disabled = false;
    };
    grid.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-ig]');
      const v = b && !b.disabled ? list.find((x) => x.id === b.dataset.ig) : undefined;
      if (!v) return;
      close();
      pickInstagram(acc, v);
    });
    more.addEventListener('click', () => { if (next) load(next); });
    el.querySelector('[data-x]')!.addEventListener('click', close);
    load();
  });
}

function pickInstagram(acc: Account, v: InstagramVideo) {
  const d = draft!;
  syncDraftFromForm(d);
  if (d.mediaUrl) URL.revokeObjectURL(d.mediaUrl);
  Object.assign(d, { file: undefined, mediaUrl: undefined, mediaName: 'Instagram-Video', mediaType: 'video/mp4', mediaSize: 0, thumb: v.thumbnail_url ?? undefined, ig: { accountId: acc.id, mediaId: v.id, permalink: v.permalink ?? undefined } });
  if (!d.caption.trim()) d.caption = v.caption;
  if (!d.title.trim()) d.title = (v.caption.split('\n').map((x) => x.trim()).find(Boolean) ?? '').slice(0, 100);
  // It is already on this Instagram account.
  d.selected.delete(acc.id);
  render();
}

function destRow(a: Account, d: Draft) {
  const p = platform(a.platform);
  const on = d.selected.has(a.id);
  const cap = d.overrides[a.id] ?? d.caption;
  const over = p.limit && cap.length > p.limit;
  return `<div class="dest ${on ? 'on' : ''}">
    <label class="dest-top"><input type="checkbox" data-action="toggle-dest" data-id="${a.id}" ${on ? 'checked' : ''}>${badge(a.platform, 30)}<span class="name"><b>${p.name}</b><small>@${esc(a.handle)} · ${p.formats.join(', ')}</small></span>
    <span class="warn" data-warn="${a.id}">${over ? `${cap.length}/${p.limit}` : ''}</span></label>
    ${on ? `<div class="override">${d.open.has(a.id)
      ? `<textarea class="textarea" data-override="${a.id}" placeholder="Beschreibung für ${p.name}">${esc(cap)}</textarea><div class="hint">${p.hint}${p.limit ? ` Höchstens ${p.limit} Zeichen.` : ''} <a href="#" data-action="reset-override" data-id="${a.id}">Allgemeine Beschreibung verwenden</a></div>`
      : `<a href="#" class="hint" data-action="open-override" data-id="${a.id}">Beschreibung für ${p.name} anpassen</a>`}</div>` : ''}
  </div>`;
}

// Read the fields once more on save, so pasted or autofilled text is never lost.
function syncDraftFromForm(d: Draft) {
  const t = root.querySelector<HTMLInputElement>('#c-title');
  const c = root.querySelector<HTMLTextAreaElement>('#c-caption');
  const at = root.querySelector<HTMLInputElement>('#c-at');
  if (t) d.title = t.value;
  if (c) d.caption = c.value;
  if (at?.value) d.at = new Date(at.value).getTime();
  root.querySelectorAll<HTMLTextAreaElement>('[data-override]').forEach((o) => { d.overrides[o.dataset.override!] = o.value; });
  const igTrial = root.querySelector<HTMLInputElement>('#ig-trial');
  if (igTrial) d.insta.trial = igTrial.checked ? ((root.querySelector<HTMLSelectElement>('#ig-grad')?.value as InstagramOptions['trial']) || 'MANUAL') : '';
  const ttMode = root.querySelector<HTMLInputElement>('input[name=tt-mode]:checked');
  if (ttMode) d.tt.mode = ttMode.value as TikTokOptions['mode'];
  const yt = root.querySelector('#yt-card');
  if (yt) {
    d.yt.privacy = root.querySelector<HTMLSelectElement>('#yt-privacy')!.value as YouTubeOptions['privacy'];
    d.yt.categoryId = root.querySelector<HTMLSelectElement>('#yt-category')!.value;
    d.yt.tags = root.querySelector<HTMLInputElement>('#yt-tags')!.value;
    d.yt.short = root.querySelector<HTMLInputElement>('#yt-short')!.checked;
    d.yt.madeForKids = root.querySelector<HTMLInputElement>('#yt-kids')!.checked;
    const sched = root.querySelector<HTMLInputElement>('#yt-schedule');
    if (sched) d.yt.platformSchedule = sched.checked;
  }
}

function savePostFromDraft(publish: boolean, force = false) {
  const d = draft!;
  syncDraftFromForm(d);
  if (publish && !d.selected.size) { toast('Wähle mindestens ein Konto aus'); return; }
  if (publish && !d.mediaName && !d.caption.trim()) { toast('Füge zuerst ein Video oder eine Beschreibung hinzu'); return; }
  const at = d.when === 'now' ? Date.now() : d.at;
  if (publish && d.when === 'later' && at < Date.now()) { toast('Wähle eine Zeit in der Zukunft'); return; }
  if (publish && !force) {
    const probe: Post = { id: d.id, title: d.title, caption: d.caption, mediaName: d.mediaName, mediaType: d.mediaType, mediaSize: d.mediaSize, createdAt: 0, scheduledAt: at, deliveries: [] };
    const problems = [...d.selected]
      .map((id) => ({ id, err: checkDelivery({ accountId: id, status: 'scheduled', caption: d.overrides[id] ?? d.caption }, probe) }))
      .filter((x) => x.err);
    if (problems.length) {
      const list = problems.map((x) => `@${store.account(x.id)?.handle ?? '?'}: ${x.err}`).join(' · ');
      confirmBox('Bei einigen Konten klappt es nicht', `${list}. Trotzdem veröffentlichen? Diese Konten werden als fehlgeschlagen angezeigt; du kannst es erneut versuchen, sobald du den Post korrigiert hast.`, 'Trotzdem veröffentlichen', () => savePostFromDraft(true, true));
      return;
    }
  }
  // With a server, every real post with a video goes through it: it publishes on time,
  // also while this page is closed, and for accounts connected on another device.
  const live = [...d.selected].filter((id) => store.isLive(store.account(id)));
  const viaServer = !!integrations().serverUrl && live.length > 0 && (!!d.ig || !!d.inbox || (publish && d.mediaType.startsWith('video')));
  if ((d.ig || d.inbox) && !viaServer) { toast('Wähle mindestens ein live verbundenes Konto aus'); return; }
  if (viaServer) { submitViaServer(d, at, publish, live); return; }
  saveLocalPost(d, at, publish, [...d.selected]);
  draft = null;
  processQueue();
  toast(publish ? (d.when === 'now' ? `Wird auf ${accountsText(d.selected.size)} veröffentlicht…` : `Geplant für ${fmtDate(at)}`) : 'Entwurf gespeichert');
  location.hash = '#/posts';
}

function saveLocalPost(d: Draft, at: number, publish: boolean, ids: string[]) {
  const has = (p: string) => ids.some((id) => store.account(id)?.platform === p);
  const post: Post = {
    id: d.id, title: d.title.trim() || d.mediaName || d.caption.slice(0, 40) || 'Post ohne Titel', caption: d.caption,
    mediaName: d.mediaName, mediaType: d.mediaType, mediaSize: d.mediaSize, thumb: d.thumb,
    mediaUrl: d.file ? undefined : store.posts().find((p) => p.id === d.id)?.mediaUrl,
    youtube: has('youtube') ? { ...d.yt } : undefined,
    instagram: has('instagram') ? { ...d.insta } : undefined,
    tiktok: has('tiktok') ? { ...d.tt } : undefined,
    createdAt: store.posts().find((p) => p.id === d.id)?.createdAt ?? Date.now(), scheduledAt: at,
    deliveries: ids.map((id) => ({ accountId: id, status: publish ? 'scheduled' : 'draft', caption: d.overrides[id] ?? d.caption })),
  };
  if (d.file) { rememberFile(post.id, d.file); keepVideo(post.id, d.file); }
  store.savePost(post);
}

/** Per-account settings the server passes on to the platform. */
function serverOptions(id: string, d: Draft): Record<string, unknown> | undefined {
  const p = store.account(id)?.platform;
  if (p === 'youtube') return { ...d.yt, title: d.title.trim() || undefined };
  if (p === 'instagram') return d.insta.trial ? { trial: d.insta.trial } : undefined;
  if (p === 'tiktok') return { tiktok_mode: d.tt.mode };
  return undefined;
}

async function submitViaServer(d: Draft, at: number, publish: boolean, live: string[]) {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-action="publish"], [data-action="save-draft"]')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    let source: PostSource;
    if (d.ig) source = { type: 'instagram', account_id: d.ig.accountId, media_id: d.ig.mediaId, permalink: d.ig.permalink, thumbnail_url: d.thumb };
    else if (d.inbox) source = { type: 'inbox', id: d.inbox.id, thumbnail_url: d.thumb };
    else {
      if (!d.file) throw new Error('Wähle die Videodatei noch einmal aus – sie ist nicht mehr in diesem Browser.');
      const btn = buttons.find((b) => b.dataset.action === 'publish');
      const label = btn?.textContent ?? '';
      const key = await uploadForLater(d.file, (pct) => { if (btn) btn.textContent = `Wird hochgeladen… ${pct}\u00a0%`; }).finally(() => { if (btn) btn.textContent = label; });
      source = { type: 'upload', key, thumbnail_url: d.thumb };
    }
    const planned = await planServerPost({
      title: d.title.trim(), caption: d.caption, source, scheduled_at: at, draft: !publish,
      deliveries: live.map((id) => ({ account_id: id, caption: d.overrides[id] ?? d.caption, options: serverOptions(id, d) })),
    });
    if (d.file) keepVideo(`srv-${planned.id}`, d.file);
    // Accounts only connected as a demo keep the simulated post.
    const demo = [...d.selected].filter((id) => !live.includes(id));
    if (demo.length) { saveLocalPost({ ...d, id: store.uid() }, at, publish, demo); processQueue(); }
    draft = null;
    toast(!publish ? 'Gespeichert – gib den Post unter „Inhalte“ frei, wenn du so weit bist' : at <= Date.now() + 60_000 ? `Wird auf ${accountsText(live.length)} veröffentlicht…` : `Geplant für ${fmtDate(at)} – der Server veröffentlicht den Post, auch wenn diese Seite geschlossen ist`);
    location.hash = '#/posts';
  } catch (e) {
    toast((e as Error).message);
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// A small frame grab for the content list.
function makeThumb(file: { type: string }, url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const draw = (src: CanvasImageSource, w: number, h: number) => {
      const c = document.createElement('canvas');
      const s = 160 / Math.max(w, h);
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
      try { resolve(c.toDataURL('image/jpeg', 0.7)); } catch { resolve(undefined); }
    };
    if (file.type.startsWith('image')) {
      const img = new Image();
      img.onload = () => draw(img, img.naturalWidth, img.naturalHeight);
      img.onerror = () => resolve(undefined);
      img.src = url;
    } else {
      const v = document.createElement('video');
      if (/^https?:/.test(url)) v.crossOrigin = 'anonymous'; // a video on our server: allowed to draw from it
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
      v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
      v.onseeked = () => draw(v, v.videoWidth, v.videoHeight);
      v.onerror = () => resolve(undefined);
      setTimeout(() => resolve(undefined), 4000);
    }
  });
}

async function setMedia(file: File) {
  const d = draft!;
  syncDraftFromForm(d);
  if (d.mediaUrl) URL.revokeObjectURL(d.mediaUrl);
  d.file = file;
  d.ig = undefined;
  d.inbox = undefined;
  d.mediaUrl = URL.createObjectURL(file);
  d.mediaName = file.name; d.mediaType = file.type; d.mediaSize = file.size;
  if (!d.title) d.title = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  d.thumb = undefined;
  render();
  d.thumb = await makeThumb(file, d.mediaUrl);
  if (draft === d) render();
}

// ---------- inbox: videos shared from the iPhone ----------
function viewInbox() {
  const items = inboxItems();
  return shell('Eingang', `
    <p class="sub">Hier landen Videos, die du vom iPhone teilst (z. B. aus der Edits-App). Mach daraus einen Post – hier oder auf jedem anderen Gerät.${hasServerSession() ? '' : ' Verbinde zuerst Instagram, damit der Server dich erkennt.'}</p>
    <section class="card">${items.length ? items.map((v) => `<div class="post-row">
      <a class="thumb" href="#/create?inbox=${encodeURIComponent(v.id)}" aria-label="Post erstellen">${icons.play}</a>
      <div class="post-main"><a class="post-link" href="#/create?inbox=${encodeURIComponent(v.id)}"><b>${esc(v.name)}</b></a><small>${fmtDate(v.created_at)} · ${fmtSize(v.size)}</small></div>
      <div class="post-actions"><a class="btn small primary" href="#/create?inbox=${encodeURIComponent(v.id)}">Post erstellen</a><button class="icon-btn" data-action="inbox-delete" data-id="${esc(v.id)}" aria-label="Löschen">${icons.trash}</button></div>
    </div>`).join('') : `<div class="empty"><b>Noch nichts da</b>Richte einmal unter „Einstellungen“ den iPhone-Kurzbefehl ein und teile dann ein Video aus Edits (oder Fotos) über „An Crosspost senden“.<br><a class="btn" href="#/settings">iPhone einrichten</a></div>`}</section>`, '#/inbox');
}

// ---------- one post, to look at again ----------
const YT_PRIVACY: Record<string, string> = { public: 'Öffentlich', unlisted: 'Nicht gelistet', private: 'Privat' };

function deliveryBlock(d: Delivery, p: Post) {
  const a = store.account(d.accountId);
  const label = d.status === 'published' && d.label ? d.label : STATUS_LABEL[d.status]!;
  return `<div class="detail-dest">
    <div class="detail-dest-top">${a ? badge(a.platform, 28) : ''}<span class="grow"><b>${a ? platform(a.platform).name : 'Getrenntes Konto'}</b><small>${a ? '@' + esc(a.handle) : ''}${d.at ? ` · ${fmtDate(d.at)}` : ''}</small></span><span class="chip ${d.status}">${esc(label)}</span>${d.url ? `<a class="btn small" href="${esc(d.url)}" target="_blank" rel="noopener">Öffnen</a>` : ''}</div>
    ${d.error ? `<p class="detail-error">${esc(d.error)}</p>` : ''}
    ${d.caption !== p.caption ? `<details><summary>Eigene Beschreibung für dieses Konto</summary><div class="detail-text">${esc(d.caption) || '<span class="hint">Leer</span>'}</div></details>` : ''}
  </div>`;
}

function postSettings(p: Post) {
  const rows: string[] = [];
  if (p.youtube) {
    const y = p.youtube;
    rows.push(`<li>${badge('youtube', 20)}<span>${YT_PRIVACY[y.privacy] ?? y.privacy}${y.short ? ' · Short' : ''}${y.madeForKids ? ' · Speziell für Kinder' : ''}${y.tags ? ` · Tags: ${esc(y.tags)}` : ''}</span></li>`);
  }
  if (p.instagram?.trial) rows.push(`<li>${badge('instagram', 20)}<span>Test-Reel · ${p.instagram.trial === 'MANUAL' ? 'du teilst es selbst in der App mit deinen Followern' : 'wird mit deinen Followern geteilt, wenn es gut ankommt'}</span></li>`);
  if (p.tiktok) rows.push(`<li>${badge('tiktok', 20)}<span>${p.tiktok.mode === 'inbox' ? 'Als Entwurf an die TikTok-App gesendet' : 'Direkt gepostet'}</span></li>`);
  return rows.length ? `<section class="card"><h2>Einstellungen</h2><ul class="detail-settings">${rows.join('')}</ul></section>` : '';
}

function viewPost(params: URLSearchParams) {
  const p = store.allPosts().find((x) => x.id === params.get('id'));
  if (!p) return shell('Post', `<section class="card"><div class="empty"><b>Post nicht gefunden</b>Vielleicht wurde er gelöscht.<br><a class="btn" href="#/posts">Zurück zu den Inhalten</a></div></section>`, '#/posts');
  const status = postStatus(p);
  const origin = p.remote
    ? (p.remote.kind === 'upload' ? 'Hier hochgeladen, vom Server veröffentlicht' : p.workflowId ? 'Von einem Workflow aus Instagram übernommen' : 'Von Instagram weitergepostet')
    : 'Aus diesem Browser veröffentlicht';
  return shell('Post', `
    <div class="section-head"><a class="btn small" href="#/posts">${icons.chevronLeft}Inhalte</a>
      <div class="row">
        <button class="btn small" data-action="post-again" data-id="${p.id}">Erneut posten</button>
        ${status === 'draft' ? `<button class="btn small primary" data-action="approve" data-id="${p.id}">Freigeben</button>` : ''}
        ${p.deliveries.some((d) => d.status === 'failed') ? `<button class="btn small" data-action="retry" data-id="${p.id}">Erneut versuchen</button>` : ''}
        ${(status === 'draft' || status === 'scheduled') && !p.remote ? `<a class="btn small" href="#/create?edit=${p.id}">Bearbeiten</a>` : ''}
        <button class="icon-btn" data-action="delete-post" data-id="${p.id}" aria-label="Löschen">${icons.trash}</button>
      </div>
    </div>
    <div class="post-detail">
      <section class="card detail-media" id="detail-media" data-id="${esc(p.id)}">
        ${p.thumb ? `<img src="${esc(p.thumb)}" alt="">` : `<div class="ph-empty">${icons.play}</div>`}
        <p class="hint" id="detail-note">Video wird gesucht…</p>
      </section>
      <div class="stack">
        <section class="card stack">
          <div><div class="copy-row"><span class="field-label">Titel</span><button class="btn small" data-action="copy" data-v="d-title">Kopieren</button></div><div class="detail-title" id="d-title">${esc(p.title)}</div></div>
          <div><div class="copy-row"><span class="field-label">Beschreibung</span><button class="btn small" data-action="copy" data-v="d-caption">Kopieren</button></div><div class="detail-text" id="d-caption">${esc(p.caption)}</div></div>
          <p class="sub" style="margin:0">${STATUS_LABEL[status]} · ${fmtDate(p.scheduledAt)} · ${origin}${p.remote?.permalink ? ` · <a href="${esc(p.remote.permalink)}" target="_blank" rel="noopener">Original auf Instagram</a>` : ''}</p>
        </section>
        <section class="card"><h2>Ziele</h2>${p.deliveries.map((d) => deliveryBlock(d, p)).join('') || '<p class="hint">Keine Konten.</p>'}</section>
        ${postSettings(p)}
      </div>
    </div>`, '#/posts');
}

// One object URL for the video on screen; reused across re-renders, released when another video shows.
let viewer: { id: string; url: string } | null = null;

async function mountPostMedia() {
  const box = root.querySelector<HTMLElement>('#detail-media');
  if (!box) return;
  const id = box.dataset.id!;
  const show = (src: string) => {
    box.querySelector('img, .ph-empty')?.remove();
    box.querySelector('#detail-note')?.remove();
    const v = document.createElement('video');
    v.src = src; v.controls = true; v.playsInline = true; v.preload = 'metadata';
    box.prepend(v);
  };
  if (viewer?.id === id) { show(viewer.url); return; }
  const file = await keptVideo(id);
  if (!root.contains(box)) return;
  if (file) {
    if (viewer) URL.revokeObjectURL(viewer.url);
    viewer = { id, url: URL.createObjectURL(file) };
    show(viewer.url);
    return;
  }
  const p = store.allPosts().find((x) => x.id === id);
  // A copy on our server lives about a day after posting.
  if (p?.mediaUrl && Date.now() - p.createdAt < 20 * 3600_000) { show(p.mediaUrl); return; }
  const note = box.querySelector('#detail-note');
  if (!note) return;
  const link = p?.remote?.permalink ?? p?.deliveries.find((d) => d.url)?.url;
  note.innerHTML = `Dieser Browser hat keine Kopie des Videos${p?.remote ? '' : ' (gepostet, bevor Videos aufbewahrt wurden, oder von einem anderen Gerät)'}.${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">Hier ansehen</a>.` : ''}`;
}

/** A new post with the same video, text and accounts. */
async function draftFromPost(p: Post): Promise<Draft> {
  const d = newDraft();
  d.title = p.title;
  d.caption = p.caption;
  d.selected = new Set(p.deliveries.map((x) => x.accountId).filter((id) => store.account(id)));
  d.overrides = Object.fromEntries(p.deliveries.filter((x) => x.caption !== p.caption).map((x) => [x.accountId, x.caption]));
  d.open = new Set(Object.keys(d.overrides));
  if (p.youtube) d.yt = { ...d.yt, ...p.youtube };
  if (p.instagram) d.insta = { ...p.instagram };
  if (p.tiktok) d.tt = { ...p.tiktok };
  const file = await keptVideo(p.id);
  if (file) {
    Object.assign(d, { file, mediaUrl: URL.createObjectURL(file), mediaName: file.name, mediaType: file.type, mediaSize: file.size, thumb: p.thumb });
  } else if (p.remote?.mediaId) {
    const accountId = p.remote.sourceAccountId ?? store.workflows().find((w) => w.id === p.workflowId)?.sourceId;
    if (accountId && store.account(accountId)) {
      Object.assign(d, { ig: { accountId, mediaId: p.remote.mediaId, permalink: p.remote.permalink }, mediaName: 'Instagram-Video', mediaType: 'video/mp4', thumb: p.thumb });
      d.selected.delete(accountId);
    }
  }
  return d;
}

const POST_TABS = ['all', 'scheduled', 'draft', 'published', 'failed'] as const;
let postTab: (typeof POST_TABS)[number] = 'all';

function viewPosts() {
  const list = store.allPosts().filter((p) => postTab === 'all' || postStatus(p) === postTab || (postTab === 'failed' && p.deliveries.some((d) => d.status === 'failed')));
  const names = { all: 'Alle', scheduled: 'Geplant', draft: 'Entwürfe & Freigaben', published: 'Veröffentlicht', failed: 'Fehlgeschlagen' };
  return shell('Inhalte', `
    <div class="section-head"><div class="tabs">${POST_TABS.map((t) => `<button data-action="tab" data-v="${t}" class="${postTab === t ? 'active' : ''}">${names[t]}</button>`).join('')}</div></div>
    <section class="card">${list.length ? list.map((p) => postRow(p)).join('') : `<div class="empty"><b>Noch nichts da</b>Hier erscheinen Posts, die du erstellst oder die Workflows reinholen.<br><a class="btn primary" href="#/create">Post erstellen</a></div>`}</section>`, '#/posts');
}

let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

function viewCalendar() {
  const first = new Date(calMonth);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const days: Date[] = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const today = new Date().toDateString();
  const posts = store.allPosts();
  const label = first.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  return shell('Kalender', `
    <section class="card">
      <div class="section-head"><div class="cal-head"><button class="icon-btn" data-action="cal" data-v="-1" aria-label="Vorheriger Monat">${icons.chevronLeft}</button><h2>${label}</h2><button class="icon-btn" data-action="cal" data-v="1" aria-label="Nächster Monat" style="transform:scaleX(-1)">${icons.chevronLeft}</button></div><button class="btn small" data-action="cal" data-v="0">Heute</button></div>
      <div class="cal">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => `<div class="dow">${d}</div>`).join('')}
      ${days.map((day) => {
        const items = posts.filter((p) => new Date(p.scheduledAt).toDateString() === day.toDateString());
        return `<div class="day ${day.getMonth() !== first.getMonth() ? 'out' : ''} ${day.toDateString() === today ? 'today' : ''}"><span class="num">${day.getDate()}</span>${items.map((p) => `<a class="ev ${postStatus(p)}" href="#/posts" title="${esc(p.title)}">${new Date(p.scheduledAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} ${esc(p.title)}</a>`).join('')}</div>`;
      }).join('')}</div>
    </section>`, '#/calendar');
}

function viewWorkflows() {
  const wfs = store.workflows();
  return shell('Workflows', `
    <div class="section-head"><p class="sub" style="margin:0">Ein Workflow beobachtet ein Konto und veröffentlicht alles Neue auf den Zielen, die du auswählst.</p><a class="btn primary" href="#/workflows/new">${icons.plus}Neuer Workflow</a></div>
    ${wfs.length ? `<div class="wf-list">${wfs.map((w) => {
      const src = store.account(w.sourceId);
      const server = runsOnServer(w);
      const st = server ? serverWorkflowState(w.id) : undefined;
      const runsText = server ? `Läuft auf dem Server${st?.last_checked ? ` · zuletzt geprüft ${new Date(st.last_checked).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : ''}` : `${w.runs} ${w.runs === 1 ? 'Durchlauf' : 'Durchläufe'} (Demo)`;
      return `<section class="card wf">
        <label class="switch" title="${w.active ? 'Aktiv' : 'Pausiert'}"><input type="checkbox" data-action="wf-toggle" data-id="${w.id}" ${w.active ? 'checked' : ''}><span></span></label>
        <div class="wf-meta"><b>${esc(w.name)}</b><small>${w.active ? 'Aktiv' : 'Pausiert'} · ${w.autoPublish ? 'Veröffentlicht automatisch' : 'Wartet auf Freigabe'} · ${runsText}</small>${st?.last_error ? `<small style="display:block;color:#c0263d">Letzte Prüfung fehlgeschlagen: ${esc(st.last_error)}</small>` : ''}</div>
        <div class="wf-route">${src ? badge(src.platform, 32) : '<span class="tag">Keine Quelle</span>'}<span class="arrow">${icons.arrow}</span><span class="wf-dests">${w.destinationIds.map((id) => store.account(id)).filter(Boolean).map((a) => badge(a!.platform, 32)).join('') || '<span class="tag">Keine Ziele</span>'}</span></div>
        <div class="row"><button class="btn small" data-action="wf-run" data-id="${w.id}">${icons.play}Jetzt ausführen</button><a class="btn small" href="#/workflows/edit?id=${w.id}">Bearbeiten</a><button class="icon-btn" data-action="wf-delete" data-id="${w.id}" aria-label="Löschen">${icons.trash}</button></div>
      </section>`;
    }).join('')}</div>` : `<section class="card"><div class="empty"><b>Noch keine Workflows</b>Verbinde eine Quelle wie TikTok und schick jedes neue Video an Instagram, YouTube Shorts, Facebook und mehr.<br><a class="btn primary" href="#/workflows/new">Ersten Workflow erstellen</a></div></section>`}`, '#/workflows');
}

function viewWorkflowEdit(params: URLSearchParams) {
  const existing = store.workflows().find((w) => w.id === params.get('id'));
  const accs = store.accounts();
  const sources = accs.filter((a) => platform(a.platform).source);
  const dests = accs.filter((a) => platform(a.platform).destination);
  const w: Workflow = existing ?? { id: store.uid(), name: '', sourceId: sources[0]?.id ?? '', destinationIds: [], active: true, autoPublish: true, captionTemplate: '{caption}', hashtags: '', removeWatermark: true, delayMinutes: 0, createdAt: Date.now(), runs: 0 };
  return shell(existing ? 'Workflow bearbeiten' : 'Neuer Workflow', `
    <form class="card stack" id="wf-form" data-id="${w.id}" data-new="${existing ? '' : '1'}">
      <div><label class="field-label" for="wf-name">Name des Workflows</label><input class="input" id="wf-name" placeholder="z. B. TikTok überallhin" value="${esc(w.name)}"></div>
      <div><span class="field-label">1. Quelle: woher neue Inhalte kommen</span>
        ${sources.length ? `<div class="pick-grid">${sources.map((a) => `<label class="pick ${w.sourceId === a.id ? 'on' : ''}"><input type="radio" name="wf-src" value="${a.id}" ${w.sourceId === a.id ? 'checked' : ''}>${badge(a.platform, 28)}<span><b>${platform(a.platform).name}</b><small>@${esc(a.handle)}</small></span></label>`).join('')}</div>
        <p class="hint">Der Server prüft ein live verbundenes Instagram-Konto alle 5 Minuten – auch wenn diese Seite geschlossen ist. Jedes neue Reel oder Video geht an die Ziele unten. Andere Quellen laufen bisher nur als Demo.</p>` : `<p class="hint">Verbinde zuerst eine Quelle (TikTok, Instagram, YouTube, Facebook, Dropbox, Google Drive oder einen Podcast). <a href="#/accounts">Konten verbinden</a></p>`}
      </div>
      <div><span class="field-label">2. Ziele: wo veröffentlicht wird</span>
        ${dests.length ? `<div class="pick-grid">${dests.map((a) => `<label class="pick ${w.destinationIds.includes(a.id) ? 'on' : ''}"><input type="checkbox" name="wf-dest" value="${a.id}" ${w.destinationIds.includes(a.id) ? 'checked' : ''}>${badge(a.platform, 28)}<span><b>${platform(a.platform).name}</b><small>@${esc(a.handle)}</small></span></label>`).join('')}</div>` : `<p class="hint">Noch keine Ziele verbunden. <a href="#/accounts">Konten verbinden</a></p>`}
      </div>
      <div class="form-grid">
        <div><label class="field-label" for="wf-template">Vorlage für die Beschreibung</label><textarea class="textarea" id="wf-template" style="min-height:90px">${esc(w.captionTemplate)}</textarea><div class="hint">{caption} ist die ursprüngliche Beschreibung, {title} der ursprüngliche Titel.</div></div>
        <div><label class="field-label" for="wf-tags">Hashtags hinzufügen</label><input class="input" id="wf-tags" placeholder="#reels #shorts" value="${esc(w.hashtags)}">
          <label class="field-label" for="wf-delay" style="margin-top:16px">Wartezeit vor dem Veröffentlichen</label><select class="select" id="wf-delay">${[0, 15, 60, 180, 720, 1440].map((m) => `<option value="${m}" ${w.delayMinutes === m ? 'selected' : ''}>${m === 0 ? 'Sofort veröffentlichen' : m < 60 ? `${m} Minuten` : m === 60 ? '1 Stunde' : `${m / 60} Stunden`}</option>`).join('')}</select></div>
      </div>
      <label class="check-row"><input type="checkbox" id="wf-auto" ${w.autoPublish ? 'checked' : ''}><span><b>Automatisch veröffentlichen</b><small>Aus: Neue Posts warten unter „Inhalte“, bis du sie freigibst.</small></span></label>
      <label class="check-row"><input type="checkbox" id="wf-wm" ${w.removeWatermark ? 'checked' : ''}><span><b>Video ohne Wasserzeichen verwenden</b><small>Lädt das saubere Original von der Quelle, wo die Plattform das erlaubt.</small></span></label>
      <label class="check-row"><input type="checkbox" id="wf-active" ${w.active ? 'checked' : ''}><span><b>Workflow ist aktiv</b><small>Pausierte Workflows holen keine neuen Inhalte.</small></span></label>
      <div class="row" style="justify-content:flex-end"><a class="btn" href="#/workflows">Abbrechen</a><button class="btn primary" type="submit">${existing ? 'Workflow speichern' : 'Workflow erstellen'}</button></div>
    </form>`, '#/workflows');
}

function viewAccounts() {
  const accs = store.accounts();
  const card = (id: PlatformId) => {
    const p = platform(id);
    const linked = accs.filter((a) => a.platform === id);
    return `<section class="card acc">
      <div class="acc-top">${badge(id, 40)}<div><b>${p.name}</b><span class="tagline">${p.source ? '<span class="tag">Quelle</span>' : ''}${p.destination ? '<span class="tag">Ziel</span>' : ''}</span></div></div>
      <div class="acc-hint">${p.hint}${isOAuth(id) ? (isConfigured(id) ? ' <span class="tag live">Echte Anmeldung</span>' : ' <span class="tag">Demo – noch nicht eingerichtet</span>') : ''}</div>
      ${linked.length ? `<div class="acc-linked">${linked.map((a) => `<div class="linked ${store.isLive(a) ? '' : 'demo'}">${icons.check.replace('<svg', '<svg width="14" height="14"')}<span>@${esc(a.handle)}</span><small class="conn-kind" title="${a.cloud && !a.auth ? 'Auf einem anderen Gerät verbunden; Posts laufen über den Server' : ''}">${a.auth ? (a.auth.expiresAt && a.auth.expiresAt < Date.now() && !a.auth.refreshToken && !a.cloud ? 'abgelaufen' : 'Live') : a.cloud ? 'Live' : 'Demo'}</small>${store.isLive(a) && isOAuth(a.platform) && isConfigured(a.platform) ? `<button class="btn small" data-action="connect" data-v="${a.platform}" title="Neu anmelden, z. B. um neue Berechtigungen zu erteilen">Neu verbinden</button>` : ''}<button class="icon-btn" data-action="disconnect" data-id="${a.id}" aria-label="Trennen" title="Trennen">${icons.close}</button></div>`).join('')}</div>` : ''}
      <button class="btn small ${linked.length ? '' : 'primary'}" data-action="connect" data-v="${id}">${linked.length ? 'Weiteres Konto' : 'Verbinden'}</button>
    </section>`;
  };
  return shell('Verbundene Konten', `
    <p class="sub">Verbinde die Konten, von denen du postest, und die, auf denen du veröffentlichst. Pro Plattform kannst du mehrere Konten verbinden. Facebook, Instagram, TikTok, YouTube und Snapchat nutzen die Anmeldung der jeweiligen Plattform, sobald sie unter <a href="#/settings">Einstellungen → Integrationen</a> eingerichtet sind.</p>
    <div class="acc-grid">${PLATFORMS.map((p) => card(p.id)).join('')}</div>`, '#/accounts');
}

// `platform`: whose readiness tag the field shows.
const INTEGRATION_FIELDS: { key: keyof Integrations; platform?: OAuthPlatform; label: string; hint: string }[] = [
  { key: 'serverUrl', label: 'Serveradresse', hint: 'Adresse deines eingerichteten Servers (server/worker.js), z. B. https://crosspost-api.&lt;name&gt;.workers.dev. Nötig für Facebook, Instagram und TikTok.' },
  { key: 'facebook', platform: 'facebook', label: 'Meta-App-ID', hint: 'Meta for Developers → deine App → App settings → Basic. Wird für Facebook und Instagram verwendet.' },
  { key: 'metaConfigId', platform: 'instagram', label: 'Instagram-Konfigurations-ID', hint: 'Meta for Developers → deine App → Facebook Login for Business → Configurations → „Instagram API (Unified Login)“.' },
  { key: 'tiktok', platform: 'tiktok', label: 'TikTok-Client-Key', hint: 'TikTok for Developers → deine App → App details.' },
  { key: 'youtube', platform: 'youtube', label: 'Google-OAuth-Client-ID', hint: 'Google Cloud Console → APIs & Services → Credentials (Typ: Web application). Ohne Server gilt der Zugang nur 1 Stunde pro Anmeldung; mit GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET auf deinem Server bleibt YouTube dauerhaft verbunden.' },
  { key: 'snapchat', platform: 'snapchat', label: 'Öffentliche Snapchat-OAuth-Client-ID', hint: 'Snap Developer Portal → deine App → OAuth client ID (public).' },
];

function integrationsCard() {
  const c = integrations();
  return `<form class="card stack" id="integrations-form" style="margin-top:20px">
    <div><h2>Integrationen</h2><p class="sub" style="margin:0">Echte Anmeldung für Facebook, Instagram, TikTok, YouTube und Snapchat. Client-IDs sind öffentlich, Secrets gehören nur auf den Server. Werte aus dem Build der Seite sind schon eingetragen.</p></div>
    <div><span class="field-label">Redirect-URI</span><input class="input" readonly value="${esc(redirectUri())}" onclick="this.select()"><div class="hint">Trag genau diese Adresse in den Entwicklereinstellungen jeder Plattform als erlaubte Redirect- bzw. Callback-URL ein.</div></div>
    <div class="form-grid">${INTEGRATION_FIELDS.map((f) => `<div><label class="field-label" for="int-${f.key}">${f.label}${f.platform ? (isConfigured(f.platform) ? ' <span class="tag live">bereit</span>' : ' <span class="tag">nicht gesetzt</span>') : ''}</label><input class="input" id="int-${f.key}" data-int="${f.key}" value="${esc(c[f.key])}" autocomplete="off" spellcheck="false"><div class="hint">${f.hint}</div></div>`).join('')}</div>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">Integrationen speichern</button></div>
  </form>`;
}

// The Shortcut key stays on screen (also across re-renders) until the page is reloaded.
let shortcutShown: string | null = null;

/** How to build the Shortcut on the iPhone; the key is shown once. */
function shortcutSteps(key: string) {
  const field = (id: string, label: string, value: string) => `<div><label class="field-label" for="${id}">${label}</label><div class="copy-row"><input class="input" id="${id}" readonly value="${esc(value)}" onclick="this.select()"><button class="btn small" data-action="copy-value" data-v="${id}">Kopieren</button></div></div>`;
  return `<div class="stack shortcut-steps">
    ${field('sc-url', 'Adresse (URL)', inboxEndpoint())}
    ${field('sc-auth', 'Text für den Header „Authorization“ (nicht weitergeben)', `Bearer ${key}`)}
    <ol class="steps-list">
      <li>Öffne auf dem iPhone die App <b>Kurzbefehle</b>, tippe auf <b>+</b> und nenne den Kurzbefehl <b>An Crosspost senden</b>.</li>
      <li>Tippe auf <b>ⓘ</b> (oder oben auf den Namen → <b>Details</b>) und schalte <b>Im Share-Sheet anzeigen</b> ein. Als Eingabe lässt du nur <b>Medien</b> zu.</li>
      <li>Füge die Aktion <b>Inhalte von URL abrufen</b> hinzu und setze als URL die <b>Adresse</b> von oben ein. Stell die Methode auf <b>POST</b> und füge unter <b>Header</b> einen neuen Header hinzu: Schlüssel <b>Authorization</b>, Text: der Wert aus dem Feld darüber (beginnt mit „Bearer“). Stell den Anfragetext (je nach iOS-Version „Haupttext anfordern“) auf <b>Datei</b> und wähle dort <b>Kurzbefehleingabe</b>.</li>
      <li>Füge die Aktion <b>Wörterbuchwert abrufen</b> hinzu: Schlüssel <b>open_url</b>, Wörterbuch <b>Inhalte der URL</b>.</li>
      <li>Füge die Aktion <b>URLs öffnen</b> hinzu – sie nimmt den <b>Wörterbuchwert</b>. Fertig.</li>
      <li>In Edits: Exportiere das Video und tippe auf <b>Teilen</b> → <b>An Crosspost senden</b>. Crosspost öffnet sich mit dem Video in einem neuen Post.</li>
    </ol>
    <p class="hint">Videos bis 100 MB. Der Schlüssel wird nur jetzt angezeigt – wenn du ihn verlierst, richte einfach einen neuen ein.</p>
  </div>`;
}

function viewSettings() {
  const u = store.currentUser()!;
  let zones: string[] = [];
  try { zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { zones = [u.timezone]; }
  if (!zones.includes(u.timezone)) zones.unshift(u.timezone);
  return shell('Einstellungen', `
    <div class="grid-2">
      <form class="card stack" id="settings-form">
        <h2>Profil</h2>
        <div><label class="field-label" for="s-name">Name</label><input class="input" id="s-name" value="${esc(u.name)}"></div>
        <div><label class="field-label" for="s-tz">Zeitzone</label><select class="select" id="s-tz">${zones.map((z) => `<option ${z === u.timezone ? 'selected' : ''}>${z}</option>`).join('')}</select></div>
        <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">Änderungen speichern</button></div>
      </form>
      <section class="card stack">
        <h2>Deine Daten</h2>
        <p class="sub">Deine Posts werden in diesem Browser gespeichert. Verbundene Konten und Workflows liegen zusätzlich auf dem Server, die Anmeldungen verschlüsselt – so gehen Posts auch raus, wenn diese Seite geschlossen ist, und jedes deiner Geräte zeigt dieselben Konten.</p>
        <div class="row"><button class="btn" data-action="export">Meine Daten herunterladen</button><button class="btn danger" data-action="wipe">Posts &amp; Workflows löschen</button></div>
        <h2 style="margin-top:24px">Videos in diesem Browser</h2>
        <p class="sub">Videos, die du postest, werden hier aufbewahrt (bis 1 GB pro Video) – so kannst du einen Post noch einmal ansehen und erneut posten. <span id="kept-usage"></span></p>
        <div class="row"><button class="btn" data-action="forget-videos">Aufbewahrte Videos entfernen</button></div>
        <h2 style="margin-top:24px">iPhone: aus Edits teilen</h2>
        <p class="sub">Ein Kurzbefehl bringt „An Crosspost senden“ ins Teilen-Menü des iPhones. Geteilte Videos landen in deinem Eingang und öffnen sich direkt in einem neuen Post.</p>
        <div class="row"><button class="btn" data-action="shortcut-key">Kurzbefehl einrichten</button></div>
        <div id="shortcut-setup">${shortcutShown ? shortcutSteps(shortcutShown) : ''}</div>
        <h2 style="margin-top:24px">So wird veröffentlicht</h2>
        <p class="sub">Konten mit <b>Live</b> veröffentlichen wirklich, bei Konten mit <b>Demo</b> wird das Veröffentlichen nur simuliert. Posts mit Video und Workflows von Instagram laufen über den Server – rund um die Uhr.</p>
      </section>
    </div>
    ${integrationsCard()}`, '#/settings');
}

// ---------- router ----------
function render() {
  const [path, query] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(query);
  const views: Record<string, () => string> = {
    '/': viewDashboard, '/create': () => viewCreate(params), '/posts': viewPosts, '/calendar': viewCalendar,
    '/workflows': viewWorkflows, '/workflows/new': () => viewWorkflowEdit(params), '/workflows/edit': () => viewWorkflowEdit(params),
    '/accounts': viewAccounts, '/settings': viewSettings, '/post': () => viewPost(params), '/inbox': viewInbox,
  };
  const view = views[path!] ?? viewDashboard;
  const scroll = window.scrollY;
  const focusId = (document.activeElement as HTMLElement | null)?.id;
  root.innerHTML = view();
  document.title = `${root.querySelector('.topbar h1')?.textContent ?? 'Übersicht'} – Crosspost`;
  window.scrollTo(0, scroll);
  if (focusId) document.getElementById(focusId)?.focus();
  mount(path!);
}

function mount(path: string) {
  if (path === '/inbox') refreshInbox().catch((e: Error) => toast(e.message));
  if (path === '/post') mountPostMedia();
  if (path === '/settings') {
    keptVideosUsage().then((u) => { const el = root.querySelector('#kept-usage'); if (el) el.textContent = u.count ? `Aktuell: ${u.count} ${u.count === 1 ? 'Video' : 'Videos'}, ${fmtSize(u.bytes)}.` : 'Noch keine aufbewahrt.'; });
  }
  if (path === '/create') {
    const d = draft!;
    const fileInput = root.querySelector<HTMLInputElement>('#media-input')!;
    fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) setMedia(f); });
    const drop = root.querySelector<HTMLElement>('#drop');
    if (drop) {
      drop.addEventListener('click', () => fileInput.click());
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) setMedia(f); });
    }
    root.querySelector<HTMLInputElement>('#c-title')!.addEventListener('input', (e) => { d.title = (e.target as HTMLInputElement).value; });
    root.querySelector<HTMLTextAreaElement>('#c-caption')!.addEventListener('input', (e) => {
      d.caption = (e.target as HTMLTextAreaElement).value;
      root.querySelector('#c-count')!.textContent = `${d.caption.length} Zeichen`;
      root.querySelector('#ph-cap')!.textContent = d.caption;
      updateWarnings();
    });
    root.querySelector<HTMLInputElement>('#c-at')?.addEventListener('change', (e) => { const v = (e.target as HTMLInputElement).value; if (v) d.at = new Date(v).getTime(); });
    root.querySelectorAll<HTMLTextAreaElement>('[data-override]').forEach((t) => t.addEventListener('input', () => { d.overrides[t.dataset.override!] = t.value; updateWarnings(); }));
    root.querySelector<HTMLInputElement>('#ig-trial')?.addEventListener('change', () => { syncDraftFromForm(d); render(); });
  }
  if (path.startsWith('/workflows/')) {
    const form = root.querySelector<HTMLFormElement>('#wf-form')!;
    form.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'wf-src') form.querySelectorAll('input[name=wf-src]').forEach((r) => r.closest('.pick')!.classList.toggle('on', (r as HTMLInputElement).checked));
      if (t.name === 'wf-dest') t.closest('.pick')!.classList.toggle('on', t.checked);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = (id: string) => form.querySelector<HTMLInputElement>(id)!;
      const sourceId = form.querySelector<HTMLInputElement>('input[name=wf-src]:checked')?.value ?? '';
      const destinationIds = [...form.querySelectorAll<HTMLInputElement>('input[name=wf-dest]:checked')].map((i) => i.value);
      if (!sourceId) { toast('Wähle ein Quellkonto aus'); return; }
      if (!destinationIds.length) { toast('Wähle mindestens ein Ziel aus'); return; }
      const old = store.workflows().find((w) => w.id === form.dataset.id);
      const src = store.account(sourceId)!;
      store.saveWorkflow({
        id: form.dataset.id!, name: val('#wf-name').value.trim() || `${platform(src.platform).name} an ${accountsText(destinationIds.length)}`,
        sourceId, destinationIds, active: val('#wf-active').checked, autoPublish: val('#wf-auto').checked,
        captionTemplate: (form.querySelector('#wf-template') as HTMLTextAreaElement).value, hashtags: val('#wf-tags').value,
        removeWatermark: val('#wf-wm').checked, delayMinutes: Number((form.querySelector('#wf-delay') as HTMLSelectElement).value),
        createdAt: old?.createdAt ?? Date.now(), runs: old?.runs ?? 0,
      });
      scheduleSync();
      toast(old ? 'Workflow gespeichert' : 'Workflow erstellt');
      location.hash = '#/workflows';
    });
  }
  if (path === '/settings') {
    root.querySelector<HTMLFormElement>('#integrations-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const values: Record<string, string> = {};
      root.querySelectorAll<HTMLInputElement>('[data-int]').forEach((i) => { values[i.dataset.int!] = i.value.trim(); });
      saveIntegrations(values);
      toast('Integrationen gespeichert');
      render();
    });
    root.querySelector<HTMLFormElement>('#settings-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      store.updateUser({ name: root.querySelector<HTMLInputElement>('#s-name')!.value.trim(), timezone: root.querySelector<HTMLSelectElement>('#s-tz')!.value });
      toast('Einstellungen gespeichert');
    });
  }
}

function updateWarnings() {
  const d = draft!;
  root.querySelectorAll<HTMLElement>('[data-warn]').forEach((el) => {
    const a = store.account(el.dataset.warn!);
    if (!a) return;
    const lim = platform(a.platform).limit;
    const len = (d.overrides[a.id] ?? d.caption).length;
    el.textContent = lim && len > lim ? `${len}/${lim}` : '';
  });
}

function connectDialog(id: PlatformId) {
  const p = platform(id);
  modal(`<h3>${badge(id, 30)}${p.name} verbinden</h3><p>${p.hint} Gib den Namen des Kontos ein, das du verbinden willst.</p>
    <label class="field-label" for="m-handle">Kontoname</label><input class="input" id="m-handle" placeholder="@deinname">
    <div class="row"><button class="btn" data-x>Abbrechen</button><button class="btn primary" data-ok>Verbinden</button></div>`, (el, close) => {
    const input = el.querySelector<HTMLInputElement>('#m-handle')!;
    input.focus();
    const ok = () => {
      const h = input.value.trim().replace(/^@/, '');
      if (!h) { input.focus(); return; }
      close();
      store.connectAccount(id, h);
      toast(`${p.name} @${h} verbunden`);
    };
    el.querySelector('[data-x]')!.addEventListener('click', close);
    el.querySelector('[data-ok]')!.addEventListener('click', ok);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  });
}

// One click handler for every button marked with data-action.
root.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) {
    if ((e.target as HTMLElement).closest('.nav a')) root.querySelector('.shell')?.classList.remove('open');
    return;
  }
  const { action, id, v } = el.dataset;
  const post = id ? store.allPosts().find((p) => p.id === id) : undefined;
  const remoteDo = (p: Post, act: 'approve' | 'retry' | 'delete', done: string) => itemAction(p.remote!.itemId, act).then(() => toast(done)).catch((err: Error) => toast(err.message));
  switch (action) {
    case 'menu': root.querySelector('.shell')!.classList.add('open'); break;
    case 'close-menu': root.querySelector('.shell')!.classList.remove('open'); break;
    case 'pick-media': root.querySelector<HTMLInputElement>('#media-input')!.click(); break;
    case 'clear-media': if (draft) { if (draft.mediaUrl) URL.revokeObjectURL(draft.mediaUrl); Object.assign(draft, { file: undefined, mediaUrl: undefined, mediaName: '', mediaType: '', mediaSize: 0, thumb: undefined, ig: undefined, inbox: undefined }); render(); } break;
    case 'pick-ig': instagramPicker(); break;
    case 'toggle-dest': if (draft) { syncDraftFromForm(draft); const on = (el as HTMLInputElement).checked; if (on) draft.selected.add(id!); else draft.selected.delete(id!); render(); } break;
    case 'open-override': e.preventDefault(); syncDraftFromForm(draft!); draft!.open.add(id!); render(); break;
    case 'reset-override': e.preventDefault(); delete draft!.overrides[id!]; draft!.open.delete(id!); render(); break;
    case 'when': syncDraftFromForm(draft!); draft!.when = v as 'now' | 'later'; render(); break;
    case 'save-draft': savePostFromDraft(false); break;
    case 'publish': savePostFromDraft(true); break;
    case 'approve': if (post?.remote) remoteDo(post, 'approve', 'Freigegeben – wird veröffentlicht'); else if (post) { post.deliveries.forEach((d) => { if (d.status === 'draft') d.status = 'scheduled'; }); if (post.scheduledAt < Date.now()) post.scheduledAt = Date.now(); store.savePost(post); processQueue(); toast('Freigegeben – wird veröffentlicht'); } break;
    case 'retry': if (post?.remote) remoteDo(post, 'retry', 'Neuer Versuch läuft'); else if (post) { post.deliveries.forEach((d) => { if (d.status === 'failed') { d.status = 'scheduled'; d.error = undefined; } }); post.scheduledAt = Math.min(post.scheduledAt, Date.now()); store.savePost(post); processQueue(); } break;
    case 'delete-post': if (post) confirmBox('Diesen Post löschen?', 'Er verschwindet aus deiner Inhaltsliste, und das in diesem Browser aufbewahrte Video wird auch entfernt. Bereits veröffentlichte Posts bleiben auf den Plattformen.', 'Löschen', () => {
      forgetVideo(post.id);
      if (post.remote) remoteDo(post, 'delete', 'Post gelöscht'); else { store.deletePost(post.id); toast('Post gelöscht'); }
      if (location.hash.startsWith('#/post')) location.hash = '#/posts';
    }); break;
    case 'post-again': if (post) draftFromPost(post).then((d) => { draft = d; location.hash = '#/create?from=' + encodeURIComponent(post.id); toast(d.mediaName ? 'In einen neuen Post kopiert' : 'Text kopiert – wähle das Video noch einmal aus'); }); break;
    case 'copy': { const t = document.getElementById(v!)?.innerText ?? ''; navigator.clipboard.writeText(t).then(() => toast('Kopiert'), () => toast('Kopieren ist hier nicht erlaubt')); break; }
    case 'inbox-delete': if (id) confirmBox('Dieses Video löschen?', 'Es wird aus deinem Eingang und vom Server entfernt.', 'Löschen', () => { deleteInboxItem(id).then(() => toast('Gelöscht'), (err: Error) => toast(err.message)); }); break;
    case 'shortcut-key': confirmBox('iPhone-Kurzbefehl einrichten?', 'Du bekommst einen neuen Schlüssel für den Kurzbefehl. Ein früherer Schlüssel funktioniert dann nicht mehr.', 'Schlüssel erstellen', () => {
      createShortcutKey().then((key) => { shortcutShown = key; render(); }, (err: Error) => toast(err.message));
    }); break;
    case 'copy-value': { const t = root.querySelector<HTMLInputElement>(`#${v}`)?.value ?? ''; navigator.clipboard.writeText(t).then(() => toast('Kopiert'), () => toast('Kopieren ist hier nicht erlaubt')); break; }
    case 'forget-videos': confirmBox('Aufbewahrte Videos entfernen?', 'Posts bleiben in deiner Inhaltsliste – nur die Videokopien in diesem Browser werden entfernt. Veröffentlichte Posts bleiben auf den Plattformen.', 'Entfernen', () => { forgetAllVideos().then(() => { toast('Aufbewahrte Videos entfernt'); render(); }); }); break;
    case 'tab': postTab = v as typeof postTab; render(); break;
    case 'cal': calMonth = v === '0' ? new Date(new Date().getFullYear(), new Date().getMonth(), 1) : new Date(calMonth.getFullYear(), calMonth.getMonth() + Number(v), 1); render(); break;
    case 'wf-toggle': { const w = store.workflows().find((x) => x.id === id); if (w) { w.active = (el as HTMLInputElement).checked; store.saveWorkflow(w); scheduleSync(); toast(w.active ? 'Workflow aktiv' : 'Workflow pausiert'); } break; }
    case 'wf-run': {
      const w = store.workflows().find((x) => x.id === id);
      if (w && runsOnServer(w)) {
        toast('Instagram wird geprüft…');
        runServerWorkflow(w.id)
          .then((r) => toast(r.found ? 'Neuestes Video übernommen – siehe „Inhalte“' : 'Kein neues Video auf Instagram'))
          .catch((err: Error) => toast(err.message));
      } else if (w) runWorkflow(w);
      break;
    }
    case 'wf-delete': { const w = store.workflows().find((x) => x.id === id); if (w) confirmBox('Workflow löschen?', `„${w.name}“ holt dann keine neuen Inhalte mehr.`, 'Löschen', () => { store.deleteWorkflow(w.id); scheduleSync(); toast('Workflow gelöscht'); }); break; }
    case 'connect': {
      const id = v as PlatformId;
      if (isOAuth(id) && isConfigured(id)) startOAuth(id).catch((e: Error) => toast(e.message));
      else connectDialog(id);
      break;
    }
    case 'disconnect': { const a = store.account(id!); if (a) confirmBox(`@${a.handle} trennen?`, 'Workflows mit diesem Konto senden dann nicht mehr dorthin.', 'Trennen', () => { store.disconnectAccount(a.id); scheduleSync(); }); break; }
    case 'export': {
      const data = { user: { ...store.currentUser(), passwordHash: undefined }, accounts: store.accounts(), workflows: store.workflows(), posts: store.posts().map((p) => ({ ...p, thumb: undefined })) };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = 'crosspost-data.json';
      a.click();
      break;
    }
    case 'wipe': confirmBox('Alle Posts und Workflows löschen?', 'Verbundene Konten bleiben. Das lässt sich nicht rückgängig machen.', 'Alle löschen', () => { store.posts().slice().forEach((p) => store.deletePost(p.id)); store.workflows().slice().forEach((w) => store.deleteWorkflow(w.id)); scheduleSync(); toast('Gelöscht'); }); break;
  }
});

window.addEventListener('hashchange', () => { root.querySelector('.shell')?.classList.remove('open'); window.scrollTo(0, 0); render(); });
// Re-render on data changes, but never while typing in the composer or a form.
store.onChange(() => {
  const a = document.activeElement;
  if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && root.contains(a) && (a as HTMLInputElement).type !== 'checkbox') return;
  if (document.querySelector('.modal-back')) return;
  const playing = root.querySelector<HTMLVideoElement>('#detail-media video');
  if (playing && !playing.paused) return;
  render();
});

// Scheduled posts go out when their time comes, as long as the app is open.
setInterval(processQueue, 4000);

// Server-side workflows: hand over the latest sign-ins, then follow what they publish.
const heartbeat = () => serverHeartbeat().catch((e: Error) => console.warn('Server workflows:', e.message));
setInterval(heartbeat, 20_000);

if (store.currentUser()) {
  render();
  processQueue();
  syncNow().catch((e: Error) => console.warn('Workflow sync failed:', e.message)).finally(heartbeat);
}
