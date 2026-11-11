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
import { itemAction, listInstagramVideos, planServerPost, runServerWorkflow, runsOnServer, scheduleSync, serverHeartbeat, serverWorkflowState, syncNow, uploadForLater, type InstagramVideo, type PostSource } from '../lib/server';

const user = store.currentUser();
if (!user) location.replace(url('login/'));

const root = document.getElementById('app')!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Provider buttons that have their own sign-in page; others connect in a dialog.
const PROVIDER_PAGE: Partial<Record<PlatformId, string>> = {
  youtube: url('loginWithYoutube/'), facebook: url('signupWithFacebook/'), amazon: url('signinWithAmazon/'),
};
const isOAuth = (id: PlatformId): id is OAuthPlatform => (OAUTH_PLATFORMS as string[]).includes(id);

// ---------- formatting ----------
const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const toLocalInput = (t: number) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const STATUS_LABEL: Record<string, string> = { scheduled: 'Scheduled', publishing: 'Publishing…', published: 'Published', 'handed-over': 'Scheduled on YouTube', failed: 'Failed', draft: 'Needs approval' };

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
  modal(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="row"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>${esc(ok)}</button></div>`, (el, close) => {
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
  if (!acc) return 'Account was disconnected';
  const p = platform(acc.platform);
  if (p.limit && d.caption.length > p.limit) return `Caption is ${d.caption.length} characters; ${p.name} allows ${p.limit}`;
  if (!post.mediaName && ['tiktok', 'youtube', 'snapchat', 'amazon'].includes(p.id)) return `${p.name} needs a video`;
  if (post.mediaType && !post.mediaType.startsWith('video') && ['tiktok', 'youtube'].includes(p.id)) return `${p.name} takes videos only, not pictures`;
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
  if (!src) { toast('Connect the source account first'); return; }
  const dests = w.destinationIds.map(store.account).filter(Boolean) as Account[];
  if (!dests.length) { toast('Pick at least one destination'); return; }
  w.runs += 1;
  const t = title ?? `New ${platform(src.platform).formats[0]?.toLowerCase() ?? 'post'} from @${src.handle} #${w.runs}`;
  const caption = applyTemplate(w, t, `Sample caption from ${platform(src.platform).name}`);
  const post: Post = {
    id: store.uid(), title: t, caption, mediaName: `${src.handle}-${w.runs}.mp4`, mediaType: 'video/mp4', mediaSize: 8_400_000,
    createdAt: Date.now(), scheduledAt: Date.now() + w.delayMinutes * 60000, workflowId: w.id,
    deliveries: dests.map((a) => ({ accountId: a.id, status: w.autoPublish ? 'scheduled' : 'draft', caption: fitCaption(caption, a.platform) })),
  };
  store.saveWorkflow(w);
  store.savePost(post);
  processQueue();
  toast(w.autoPublish ? 'Workflow ran: post queued for publishing' : 'Workflow ran: post waits for your approval');
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
  { href: '#/', label: 'Dashboard', icon: icons.home },
  { href: '#/create', label: 'Create post', icon: icons.plus },
  { href: '#/workflows', label: 'Workflows', icon: icons.flow },
  { href: '#/posts', label: 'Content', icon: icons.film },
  { href: '#/calendar', label: 'Calendar', icon: icons.calendar },
  { href: '#/accounts', label: 'Connected accounts', icon: icons.link },
  { href: '#/settings', label: 'Settings', icon: icons.gear },
];

function shell(title: string, body: string, route: string) {
  const u = store.currentUser()!;
  const pending = store.allPosts().filter((p) => postStatus(p) === 'draft').length;
  return `<div class="shell">
  <aside class="sidebar">
    <a class="brand" href="#/">${icons.logoMark}<span>Crosspost</span></a>
    <nav class="nav">${NAV.map((n) => `<a href="${n.href}" class="${route === n.href ? 'active' : ''}">${n.icon}<span>${n.label}</span>${n.href === '#/posts' && pending ? `<span class="count">${pending}</span>` : ''}</a>`).join('')}</nav>
    <div class="side-foot">
      <div class="me"><div class="avatar">${esc((u.name || u.email)[0]!.toUpperCase())}</div><div class="me-text"><b>${esc(u.name || 'You')}</b><small>${esc(u.email)}</small></div></div>
      <button class="logout" data-action="logout">${icons.logout}Log out</button>
    </div>
  </aside>
  <div class="scrim" data-action="close-menu"></div>
  <div class="main">
    <header class="topbar">
      <button class="menu-btn" data-action="menu" aria-label="Menu">${icons.menu}</button>
      <h1>${esc(title)}</h1>
      ${OAUTH_PLATFORMS.some(isConfigured) ? '' : `<span class="demo-pill" title="No platform sign-in is set up yet (Settings → Integrations), so publishing is simulated.">Demo mode</span>`}
      <span class="spacer"></span>
      ${route === '#/create' ? '' : `<a class="btn primary" href="#/create">${icons.plus}<span class="label">Create post</span></a>`}
    </header>
    <main class="content">${body}</main>
  </div>
</div>`;
}

// ---------- views ----------
function postRow(p: Post, actions = true) {
  const status = postStatus(p);
  return `<div class="post-row">
    <div class="thumb">${p.thumb ? `<img src="${p.thumb}" alt="">` : icons.play}</div>
    <div class="post-main">
      <b>${esc(p.title || 'Untitled post')}</b>
      <small>${STATUS_LABEL[status]} · ${fmtDate(p.scheduledAt)}${p.workflowId ? ' · via workflow' : ''}${p.remote?.permalink ? ` · <a href="${esc(p.remote.permalink)}" target="_blank" rel="noopener">Original</a>` : ''}</small>
      <div class="chips">${p.deliveries.map((d) => {
        const a = store.account(d.accountId);
        return `<${d.url ? `a href="${esc(d.url)}" target="_blank" rel="noopener"` : 'span'} class="chip ${d.status}" title="${esc(d.error ?? (d.label === store.TIKTOK_INBOX_LABEL ? 'Open the TikTok app → Inbox → the notification from Crosspost Studio, then post it there' : STATUS_LABEL[d.status]!))}">${a ? badge(a.platform, 18) : ''}${a ? '@' + esc(a.handle) : 'removed'} · ${d.status === 'published' && d.label ? esc(d.label) : STATUS_LABEL[d.status]}${d.status === 'publishing' && d.progress !== undefined ? ` ${d.progress}%` : ''}${d.error ? ' – ' + esc(d.error) : ''}</${d.url ? 'a' : 'span'}>`;
      }).join('')}</div>
    </div>
    ${actions ? `<div class="post-actions">
      ${status === 'draft' ? `<button class="btn small primary" data-action="approve" data-id="${p.id}">Approve</button>` : ''}
      ${p.deliveries.some((d) => d.status === 'failed') ? `<button class="btn small" data-action="retry" data-id="${p.id}">Retry</button>` : ''}
      ${(status === 'draft' || status === 'scheduled') && !p.remote ? `<a class="btn small" href="#/create?edit=${p.id}">Edit</a>` : ''}
      <button class="icon-btn" data-action="delete-post" data-id="${p.id}" aria-label="Delete">${icons.trash}</button>
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
    { done: hasSource, title: 'Connect a source', text: 'Where your content comes from, e.g. TikTok or YouTube.', href: '#/accounts' },
    { done: accs.filter((a) => platform(a.platform).destination).length >= 2, title: 'Connect destinations', text: 'Every place you want to publish to.', href: '#/accounts' },
    { done: wfs.length > 0, title: 'Create a workflow', text: 'Send new content from one account to many, automatically.', href: '#/workflows/new' },
    { done: deliveries.some((d) => d.status === 'published'), title: 'Publish your first post', text: 'Upload once, post everywhere.', href: '#/create' },
  ];
  const u = store.currentUser()!;
  return shell('Dashboard', `
    <section class="card welcome">
      <h2>Hi ${esc(u.name || 'there')}, ready to repurpose?</h2>
      <p>Upload a video once and publish it to all your channels, or let a workflow copy every new post automatically.</p>
      <div class="row"><a class="btn" href="#/create">${icons.upload}Upload &amp; cross-post</a><a class="btn" href="#/workflows/new">${icons.flow}New workflow</a></div>
    </section>
    <div class="stats">
      <div class="stat"><span>Connected accounts</span><b>${accs.length}</b></div>
      <div class="stat"><span>Active workflows</span><b>${wfs.filter((w) => w.active).length}</b></div>
      <div class="stat"><span>Scheduled</span><b>${deliveries.filter((d) => d.status === 'scheduled' || d.status === 'draft').length}</b></div>
      <div class="stat"><span>Published</span><b>${deliveries.filter((d) => d.status === 'published').length}</b></div>
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="section-head"><h2>Recent posts</h2><a href="#/posts" class="btn small ghost">View all</a></div>
        ${posts.length ? posts.slice(0, 5).map((p) => postRow(p, false)).join('') : `<div class="empty"><b>No posts yet</b>Create your first post and send it to every platform at once.<br><a class="btn primary" href="#/create">Create post</a></div>`}
      </section>
      <section class="card">
        <h2>Getting started</h2>
        <p class="sub">${steps.filter((s) => s.done).length} of ${steps.length} done${hasDest ? '' : ' · connect where you publish'}</p>
        <ul class="steps">${steps.map((s, i) => `<li class="${s.done ? 'done' : ''}"><span class="tick">${s.done ? icons.check : i + 1}</span><span class="grow"><b>${s.title}</b><small>${s.text}</small></span>${s.done ? '' : `<a class="btn small" href="${s.href}">Start</a>`}</li>`).join('')}</ul>
      </section>
    </div>`, '#/');
}

// Composer state survives re-renders while the person is on the page.
interface Draft {
  yt: YouTubeOptions; insta: InstagramOptions; tt: TikTokOptions;
  /** A video already on Instagram, cross-posted through the server instead of a file. */
  ig?: { accountId: string; mediaId: string; permalink?: string };
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

function viewCreate(params: URLSearchParams) {
  const editId = params.get('edit') ?? undefined;
  if (!draft || (editId && draft.id !== editId) || (!editId && store.posts().some((p) => p.id === draft!.id))) draft = newDraft(editId);
  const d = draft;
  const dests = store.accounts().filter((a) => platform(a.platform).destination);
  const ig = liveInstagram();
  const media = d.mediaName
    ? `<div class="media-chosen"><div class="thumb">${d.thumb ? `<img src="${esc(d.thumb)}" alt="">` : icons.play}</div><div class="post-main"><b>${esc(d.mediaName)}</b><small>${d.ig ? `From Instagram${d.ig.permalink ? ` · <a href="${esc(d.ig.permalink)}" target="_blank" rel="noopener">open</a>` : ''}` : `${esc(d.mediaType || 'file')} · ${fmtSize(d.mediaSize)}`}</small></div><button class="btn small" data-action="${d.ig ? 'pick-ig' : 'pick-media'}">Replace</button><button class="icon-btn" data-action="clear-media" aria-label="Remove">${icons.trash}</button></div>`
    : `<label class="drop" id="drop">${icons.upload}<b>Drop a video or picture here</b><span>or click to choose a file · MP4, MOV, JPG, PNG</span></label>${ig ? `<button class="btn small" data-action="pick-ig" style="margin-top:10px">${badge('instagram', 18)}Use a video already on Instagram</button>` : ''}`;
  return shell(editId ? 'Edit post' : 'Create post', `
    <div class="composer">
      <div class="stack">
        <section class="card stack">
          <div><span class="field-label">Media</span>${media}<input type="file" id="media-input" accept="video/*,image/*" hidden></div>
          <div><label class="field-label" for="c-title">Title</label><input class="input" id="c-title" maxlength="100" placeholder="Used as the YouTube title and in your content list" value="${esc(d.title)}"></div>
          <div><label class="field-label" for="c-caption">Caption</label><textarea class="textarea" id="c-caption" placeholder="Write one caption for every platform. You can change it per account below.">${esc(d.caption)}</textarea><div class="counter" id="c-count">${d.caption.length} characters</div></div>
        </section>
        <section class="card">
          <div class="section-head"><div><h2>Publish to</h2><p class="sub" style="margin:0">${d.selected.size} of ${dests.length} accounts selected</p></div><a class="btn small" href="#/accounts">${icons.plus}Connect account</a></div>
          ${dests.length ? `<div class="dest-list">${dests.map((a) => destRow(a, d)).join('')}</div>` : `<div class="empty"><b>No destinations connected</b>Connect TikTok, Instagram, YouTube and more to publish there.<br><a class="btn primary" href="#/accounts">Connect accounts</a></div>`}
        </section>
        ${youtubeCard(d)}${instagramCard(d)}${tiktokCard(d)}
        <section class="card">
          <h2>When</h2>
          <p class="sub">Times are in ${esc(store.currentUser()!.timezone)}.</p>
          <div class="row"><div class="seg"><button data-action="when" data-v="now" class="${d.when === 'now' ? 'active' : ''}">Publish now</button><button data-action="when" data-v="later" class="${d.when === 'later' ? 'active' : ''}">Schedule</button></div>
          ${d.when === 'later' ? `<input type="datetime-local" class="input" id="c-at" style="max-width:240px" value="${toLocalInput(d.at)}">` : ''}</div>
          <div class="row" style="margin-top:20px;justify-content:flex-end"><button class="btn" data-action="save-draft">Save as draft</button><button class="btn primary" data-action="publish" ${d.selected.size ? '' : 'disabled'}>${d.when === 'now' ? 'Publish now' : 'Schedule post'}</button></div>
        </section>
      </div>
      <aside class="card sticky"><h2>Preview</h2><p class="sub">How it looks in a vertical feed.</p>
        <div class="phone">${d.mediaUrl && d.mediaType.startsWith('video') ? `<video src="${d.mediaUrl}" muted loop autoplay playsinline></video>` : d.mediaUrl || d.thumb ? `<img src="${d.mediaUrl ?? d.thumb}" alt="">` : `<div class="ph-empty">Your video appears here</div>`}<div class="ph-cap" id="ph-cap">${esc(d.caption)}</div></div>
      </aside>
    </div>`, '#/create');
}

/** Settings that only YouTube uses; shown while a YouTube account is selected. */
function youtubeCard(d: Draft) {
  const yts = [...d.selected].map(store.account).filter((a) => a?.platform === 'youtube') as Account[];
  if (!yts.length) return '';
  const o = d.yt;
  const live = yts.some((a) => a.auth);
  const opt = (v: string, label: string) => `<option value="${v}" ${o.privacy === v ? 'selected' : ''}>${label}</option>`;
  const cat = (v: string, label: string) => `<option value="${v}" ${o.categoryId === v ? 'selected' : ''}>${label}</option>`;
  return `<section class="card stack" id="yt-card">
    <div><h2>${badge('youtube', 22)} YouTube</h2><p class="sub" style="margin:0">The title above becomes the video title (max. 100 characters), the caption its description.</p></div>
    <div class="form-grid">
      <div><label class="field-label" for="yt-privacy">Visibility</label><select class="select" id="yt-privacy">${opt('public', 'Public')}${opt('unlisted', 'Unlisted')}${opt('private', 'Private')}</select></div>
      <div><label class="field-label" for="yt-category">Category</label><select class="select" id="yt-category">${cat('22', 'People &amp; Blogs')}${cat('24', 'Entertainment')}${cat('26', 'Howto &amp; Style')}${cat('27', 'Education')}${cat('28', 'Science &amp; Technology')}${cat('10', 'Music')}${cat('17', 'Sports')}${cat('20', 'Gaming')}${cat('19', 'Travel &amp; Events')}${cat('15', 'Pets &amp; Animals')}${cat('23', 'Comedy')}${cat('25', 'News &amp; Politics')}</select></div>
    </div>
    <div><label class="field-label" for="yt-tags">Tags</label><input class="input" id="yt-tags" placeholder="reels, tutorial, behind the scenes" value="${esc(o.tags)}"><div class="hint">Separated by commas, 500 characters in total.</div></div>
    <label class="check-row"><input type="checkbox" id="yt-short" ${o.short ? 'checked' : ''}><span><b>Publish as Short</b><small>Adds #Shorts to the title. Vertical videos up to 3 minutes appear in the Shorts feed.</small></span></label>
    <label class="check-row"><input type="checkbox" id="yt-kids" ${o.madeForKids ? 'checked' : ''}><span><b>Made for kids</b><small>YouTube requires this answer by law (COPPA). Comments and some features are turned off for kids' videos.</small></span></label>
    ${live && !integrations().serverUrl ? `<label class="check-row"><input type="checkbox" id="yt-schedule" ${o.platformSchedule ? 'checked' : ''}><span><b>Let YouTube publish scheduled posts</b><small>Uploads right away as private and YouTube makes it public at the planned time, even if this app is closed. Needs at least 15 minutes ahead and visibility “Public”.</small></span></label>` : ''}
  </section>`;
}

/** Instagram's own options; shown while an Instagram account connected for real is selected. */
function instagramCard(d: Draft) {
  if (![...d.selected].some((id) => { const a = store.account(id); return a?.platform === 'instagram' && a.auth; })) return '';
  const t = d.insta.trial;
  return `<section class="card stack" id="ig-card">
    <div><h2>${badge('instagram', 22)} Instagram</h2><p class="sub" style="margin:0">Posted as a Reel.</p></div>
    <label class="check-row"><input type="checkbox" id="ig-trial" ${t ? 'checked' : ''}><span><b>Share as trial reel (Test-Reel)</b><small>Instagram first shows it to people who don't follow you. Good for trying an idea before your followers see it.</small></span></label>
    ${t ? `<div><label class="field-label" for="ig-grad">Share it with your followers</label><select class="select" id="ig-grad"><option value="MANUAL" ${t === 'MANUAL' ? 'selected' : ''}>Myself, later in the Instagram app</option><option value="SS_PERFORMANCE" ${t === 'SS_PERFORMANCE' ? 'selected' : ''}>Automatically, when it performs well</option></select></div>` : ''}
  </section>`;
}

/** How the video reaches TikTok; shown while a TikTok account connected for real is selected. */
function tiktokCard(d: Draft) {
  if (![...d.selected].some((id) => { const a = store.account(id); return a?.platform === 'tiktok' && a.auth; })) return '';
  const radio = (v: TikTokOptions['mode'], title: string, text: string) => `<label class="check-row"><input type="radio" name="tt-mode" value="${v}" ${d.tt.mode === v ? 'checked' : ''}><span><b>${title}</b><small>${text}</small></span></label>`;
  return `<section class="card stack" id="tt-card">
    <div><h2>${badge('tiktok', 22)} TikTok</h2></div>
    ${radio('inbox', 'Send to the TikTok app as a draft', 'The video waits in your TikTok inbox; add sound and text there and post it yourself.')}
    ${radio('direct', 'Post directly', 'Until TikTok has reviewed this app, direct posts are only visible to you and your account has to be private.')}
  </section>`;
}

const liveInstagram = () => (integrations().serverUrl ? store.accounts().find((a) => a.platform === 'instagram' && a.auth) : undefined);

function instagramPicker() {
  const acc = liveInstagram();
  if (!acc) { toast('Connect Instagram first'); return; }
  modal(`<h3>${badge('instagram', 26)}Videos on @${esc(acc.handle)}</h3><p>Newest first. Instagram doesn't release videos with licensed music for download – upload the original file for those.</p><div class="ig-grid" id="ig-grid"><p class="hint">Loading…</p></div><div class="row"><button class="btn" data-more hidden>Load more</button><button class="btn" data-x>Close</button></div>`, (el, close) => {
    el.classList.add('wide');
    const grid = el.querySelector<HTMLElement>('#ig-grid')!;
    const more = el.querySelector<HTMLButtonElement>('[data-more]')!;
    let list: InstagramVideo[] = [];
    let next: string | null = null;
    const day = (t: number | null) => (t ? new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '');
    const tile = (v: InstagramVideo) => `<button type="button" class="ig-tile" data-ig="${esc(v.id)}" ${v.downloadable ? '' : 'disabled'} title="${esc(v.caption.slice(0, 200))}">${v.thumbnail_url ? `<img src="${esc(v.thumbnail_url)}" alt="" loading="lazy">` : ''}<span class="ig-meta">${day(v.timestamp)}${v.crossposted ? '<br>Cross-posted before' : ''}${v.downloadable ? '' : '<br>Licensed music – no download'}</span></button>`;
    const load = async (after?: string) => {
      more.disabled = true;
      try {
        const r = await listInstagramVideos(acc.id, after);
        list = after ? [...list, ...r.videos] : r.videos;
        next = r.next;
        grid.innerHTML = list.length ? list.map(tile).join('') : '<p class="hint">No videos on this account yet.</p>';
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
  Object.assign(d, { file: undefined, mediaUrl: undefined, mediaName: 'Instagram video', mediaType: 'video/mp4', mediaSize: 0, thumb: v.thumbnail_url ?? undefined, ig: { accountId: acc.id, mediaId: v.id, permalink: v.permalink ?? undefined } });
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
      ? `<textarea class="textarea" data-override="${a.id}" placeholder="Caption for ${p.name}">${esc(cap)}</textarea><div class="hint">${p.hint}${p.limit ? ` Limit ${p.limit} characters.` : ''} <a href="#" data-action="reset-override" data-id="${a.id}">Use main caption</a></div>`
      : `<a href="#" class="hint" data-action="open-override" data-id="${a.id}">Customize caption for ${p.name}</a>`}</div>` : ''}
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
  if (publish && !d.selected.size) { toast('Choose at least one account'); return; }
  if (publish && !d.mediaName && !d.caption.trim()) { toast('Add a video or a caption first'); return; }
  const at = d.when === 'now' ? Date.now() : d.at;
  if (publish && d.when === 'later' && at < Date.now()) { toast('Pick a time in the future'); return; }
  if (publish && !force) {
    const probe: Post = { id: d.id, title: d.title, caption: d.caption, mediaName: d.mediaName, mediaType: d.mediaType, mediaSize: d.mediaSize, createdAt: 0, scheduledAt: at, deliveries: [] };
    const problems = [...d.selected]
      .map((id) => ({ id, err: checkDelivery({ accountId: id, status: 'scheduled', caption: d.overrides[id] ?? d.caption }, probe) }))
      .filter((x) => x.err);
    if (problems.length) {
      const list = problems.map((x) => `@${store.account(x.id)?.handle ?? '?'}: ${x.err}`).join(' · ');
      confirmBox('Some accounts will fail', `${list}. Publish anyway? Those accounts will show as failed and you can retry after fixing the post.`, 'Publish anyway', () => savePostFromDraft(true, true));
      return;
    }
  }
  // Planned posts and videos from Instagram go through the server: it publishes on time, also while this page is closed.
  const live = [...d.selected].filter((id) => !!store.account(id)?.auth);
  const viaServer = !!integrations().serverUrl && live.length > 0 && (!!d.ig || (publish && d.when === 'later' && d.mediaType.startsWith('video')));
  if (d.ig && !viaServer) { toast('Choose at least one account connected for real'); return; }
  if (viaServer) { submitViaServer(d, at, publish, live); return; }
  saveLocalPost(d, at, publish, [...d.selected]);
  draft = null;
  processQueue();
  toast(publish ? (d.when === 'now' ? `Publishing to ${d.selected.size} accounts…` : `Scheduled for ${fmtDate(at)}`) : 'Draft saved');
  location.hash = '#/posts';
}

function saveLocalPost(d: Draft, at: number, publish: boolean, ids: string[]) {
  const has = (p: string) => ids.some((id) => store.account(id)?.platform === p);
  const post: Post = {
    id: d.id, title: d.title.trim() || d.mediaName || d.caption.slice(0, 40) || 'Untitled post', caption: d.caption,
    mediaName: d.mediaName, mediaType: d.mediaType, mediaSize: d.mediaSize, thumb: d.thumb,
    mediaUrl: d.file ? undefined : store.posts().find((p) => p.id === d.id)?.mediaUrl,
    youtube: has('youtube') ? { ...d.yt } : undefined,
    instagram: has('instagram') ? { ...d.insta } : undefined,
    tiktok: has('tiktok') ? { ...d.tt } : undefined,
    createdAt: store.posts().find((p) => p.id === d.id)?.createdAt ?? Date.now(), scheduledAt: at,
    deliveries: ids.map((id) => ({ accountId: id, status: publish ? 'scheduled' : 'draft', caption: d.overrides[id] ?? d.caption })),
  };
  if (d.file) rememberFile(post.id, d.file);
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
    else {
      if (!d.file) throw new Error('Choose the video file again – it is no longer in this browser.');
      toast('Uploading the video to the server…');
      source = { type: 'upload', key: await uploadForLater(d.file), thumbnail_url: d.thumb };
    }
    await planServerPost({
      title: d.title.trim(), caption: d.caption, source, scheduled_at: at, draft: !publish,
      deliveries: live.map((id) => ({ account_id: id, caption: d.overrides[id] ?? d.caption, options: serverOptions(id, d) })),
    });
    // Accounts only connected as a demo keep the simulated post.
    const demo = [...d.selected].filter((id) => !live.includes(id));
    if (demo.length) { saveLocalPost({ ...d, id: store.uid() }, at, publish, demo); processQueue(); }
    draft = null;
    toast(!publish ? 'Saved – approve it under Content when you are ready' : at <= Date.now() + 60_000 ? `Publishing to ${live.length} accounts…` : `Scheduled for ${fmtDate(at)} – the server publishes it, even with this page closed`);
    location.hash = '#/posts';
  } catch (e) {
    toast((e as Error).message);
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// A small frame grab for the content list.
function makeThumb(file: File, url: string): Promise<string | undefined> {
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
      v.muted = true; v.preload = 'auto'; v.src = url;
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
  d.mediaUrl = URL.createObjectURL(file);
  d.mediaName = file.name; d.mediaType = file.type; d.mediaSize = file.size;
  if (!d.title) d.title = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  d.thumb = undefined;
  render();
  d.thumb = await makeThumb(file, d.mediaUrl);
  if (draft === d) render();
}

const POST_TABS = ['all', 'scheduled', 'draft', 'published', 'failed'] as const;
let postTab: (typeof POST_TABS)[number] = 'all';

function viewPosts() {
  const list = store.allPosts().filter((p) => postTab === 'all' || postStatus(p) === postTab || (postTab === 'failed' && p.deliveries.some((d) => d.status === 'failed')));
  const names = { all: 'All', scheduled: 'Scheduled', draft: 'Drafts & approvals', published: 'Published', failed: 'Failed' };
  return shell('Content', `
    <div class="section-head"><div class="tabs">${POST_TABS.map((t) => `<button data-action="tab" data-v="${t}" class="${postTab === t ? 'active' : ''}">${names[t]}</button>`).join('')}</div></div>
    <section class="card">${list.length ? list.map((p) => postRow(p)).join('') : `<div class="empty"><b>Nothing here yet</b>Posts you create or workflows bring in show up here.<br><a class="btn primary" href="#/create">Create post</a></div>`}</section>`, '#/posts');
}

let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

function viewCalendar() {
  const first = new Date(calMonth);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const days: Date[] = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const today = new Date().toDateString();
  const posts = store.allPosts();
  const label = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return shell('Calendar', `
    <section class="card">
      <div class="section-head"><div class="cal-head"><button class="icon-btn" data-action="cal" data-v="-1" aria-label="Previous month">${icons.chevronLeft}</button><h2>${label}</h2><button class="icon-btn" data-action="cal" data-v="1" aria-label="Next month" style="transform:scaleX(-1)">${icons.chevronLeft}</button></div><button class="btn small" data-action="cal" data-v="0">Today</button></div>
      <div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('')}
      ${days.map((day) => {
        const items = posts.filter((p) => new Date(p.scheduledAt).toDateString() === day.toDateString());
        return `<div class="day ${day.getMonth() !== first.getMonth() ? 'out' : ''} ${day.toDateString() === today ? 'today' : ''}"><span class="num">${day.getDate()}</span>${items.map((p) => `<a class="ev ${postStatus(p)}" href="#/posts" title="${esc(p.title)}">${new Date(p.scheduledAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ${esc(p.title)}</a>`).join('')}</div>`;
      }).join('')}</div>
    </section>`, '#/calendar');
}

function viewWorkflows() {
  const wfs = store.workflows();
  return shell('Workflows', `
    <div class="section-head"><p class="sub" style="margin:0">A workflow watches one account and publishes everything new to the destinations you pick.</p><a class="btn primary" href="#/workflows/new">${icons.plus}New workflow</a></div>
    ${wfs.length ? `<div class="wf-list">${wfs.map((w) => {
      const src = store.account(w.sourceId);
      const server = runsOnServer(w);
      const st = server ? serverWorkflowState(w.id) : undefined;
      const runsText = server ? `Runs on the server${st?.last_checked ? ` · checked ${new Date(st.last_checked).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}` : `${w.runs} runs (demo)`;
      return `<section class="card wf">
        <label class="switch" title="${w.active ? 'Active' : 'Paused'}"><input type="checkbox" data-action="wf-toggle" data-id="${w.id}" ${w.active ? 'checked' : ''}><span></span></label>
        <div class="wf-meta"><b>${esc(w.name)}</b><small>${w.active ? 'Active' : 'Paused'} · ${w.autoPublish ? 'Publishes automatically' : 'Waits for approval'} · ${runsText}</small>${st?.last_error ? `<small style="display:block;color:#c0263d">Last check failed: ${esc(st.last_error)}</small>` : ''}</div>
        <div class="wf-route">${src ? badge(src.platform, 32) : '<span class="tag">No source</span>'}<span class="arrow">${icons.arrow}</span><span class="wf-dests">${w.destinationIds.map((id) => store.account(id)).filter(Boolean).map((a) => badge(a!.platform, 32)).join('') || '<span class="tag">No destinations</span>'}</span></div>
        <div class="row"><button class="btn small" data-action="wf-run" data-id="${w.id}">${icons.play}Run now</button><a class="btn small" href="#/workflows/edit?id=${w.id}">Edit</a><button class="icon-btn" data-action="wf-delete" data-id="${w.id}" aria-label="Delete">${icons.trash}</button></div>
      </section>`;
    }).join('')}</div>` : `<section class="card"><div class="empty"><b>No workflows yet</b>Connect a source like TikTok and send every new video to Instagram, YouTube Shorts, Facebook and more.<br><a class="btn primary" href="#/workflows/new">Create your first workflow</a></div></section>`}`, '#/workflows');
}

function viewWorkflowEdit(params: URLSearchParams) {
  const existing = store.workflows().find((w) => w.id === params.get('id'));
  const accs = store.accounts();
  const sources = accs.filter((a) => platform(a.platform).source);
  const dests = accs.filter((a) => platform(a.platform).destination);
  const w: Workflow = existing ?? { id: store.uid(), name: '', sourceId: sources[0]?.id ?? '', destinationIds: [], active: true, autoPublish: true, captionTemplate: '{caption}', hashtags: '', removeWatermark: true, delayMinutes: 0, createdAt: Date.now(), runs: 0 };
  return shell(existing ? 'Edit workflow' : 'New workflow', `
    <form class="card stack" id="wf-form" data-id="${w.id}" data-new="${existing ? '' : '1'}">
      <div><label class="field-label" for="wf-name">Workflow name</label><input class="input" id="wf-name" placeholder="e.g. TikTok to everywhere" value="${esc(w.name)}"></div>
      <div><span class="field-label">1. Source: where new content comes from</span>
        ${sources.length ? `<div class="pick-grid">${sources.map((a) => `<label class="pick ${w.sourceId === a.id ? 'on' : ''}"><input type="radio" name="wf-src" value="${a.id}" ${w.sourceId === a.id ? 'checked' : ''}>${badge(a.platform, 28)}<span><b>${platform(a.platform).name}</b><small>@${esc(a.handle)}</small></span></label>`).join('')}</div>
        <p class="hint">An Instagram account connected for real is checked on the server every 5 minutes, also while this page is closed: every new Reel or video goes to the destinations below. Other sources only run as a demo so far.</p>` : `<p class="hint">Connect a source first (TikTok, Instagram, YouTube, Facebook, Dropbox, Google Drive or a podcast). <a href="#/accounts">Connect accounts</a></p>`}
      </div>
      <div><span class="field-label">2. Destinations: where it gets published</span>
        ${dests.length ? `<div class="pick-grid">${dests.map((a) => `<label class="pick ${w.destinationIds.includes(a.id) ? 'on' : ''}"><input type="checkbox" name="wf-dest" value="${a.id}" ${w.destinationIds.includes(a.id) ? 'checked' : ''}>${badge(a.platform, 28)}<span><b>${platform(a.platform).name}</b><small>@${esc(a.handle)}</small></span></label>`).join('')}</div>` : `<p class="hint">No destinations connected yet. <a href="#/accounts">Connect accounts</a></p>`}
      </div>
      <div class="form-grid">
        <div><label class="field-label" for="wf-template">Caption template</label><textarea class="textarea" id="wf-template" style="min-height:90px">${esc(w.captionTemplate)}</textarea><div class="hint">{caption} is the original caption, {title} the original title.</div></div>
        <div><label class="field-label" for="wf-tags">Add hashtags</label><input class="input" id="wf-tags" placeholder="#reels #shorts" value="${esc(w.hashtags)}">
          <label class="field-label" for="wf-delay" style="margin-top:16px">Wait before publishing</label><select class="select" id="wf-delay">${[0, 15, 60, 180, 720, 1440].map((m) => `<option value="${m}" ${w.delayMinutes === m ? 'selected' : ''}>${m === 0 ? 'Publish right away' : m < 60 ? `${m} minutes` : `${m / 60} hours`}</option>`).join('')}</select></div>
      </div>
      <label class="check-row"><input type="checkbox" id="wf-auto" ${w.autoPublish ? 'checked' : ''}><span><b>Publish automatically</b><small>Off: new posts wait in Content until you approve them.</small></span></label>
      <label class="check-row"><input type="checkbox" id="wf-wm" ${w.removeWatermark ? 'checked' : ''}><span><b>Use the video without watermark</b><small>Download the clean original from the source where the platform allows it.</small></span></label>
      <label class="check-row"><input type="checkbox" id="wf-active" ${w.active ? 'checked' : ''}><span><b>Workflow is active</b><small>Paused workflows don't pick up new content.</small></span></label>
      <div class="row" style="justify-content:flex-end"><a class="btn" href="#/workflows">Cancel</a><button class="btn primary" type="submit">${existing ? 'Save workflow' : 'Create workflow'}</button></div>
    </form>`, '#/workflows');
}

function viewAccounts() {
  const accs = store.accounts();
  const card = (id: PlatformId) => {
    const p = platform(id);
    const linked = accs.filter((a) => a.platform === id);
    return `<section class="card acc">
      <div class="acc-top">${badge(id, 40)}<div><b>${p.name}</b><span class="tagline">${p.source ? '<span class="tag">Source</span>' : ''}${p.destination ? '<span class="tag">Destination</span>' : ''}</span></div></div>
      <div class="acc-hint">${p.hint}${isOAuth(id) ? (isConfigured(id) ? ' <span class="tag live">Echte Anmeldung</span>' : ' <span class="tag">Demo – noch nicht eingerichtet</span>') : ''}</div>
      ${linked.length ? `<div class="acc-linked">${linked.map((a) => `<div class="linked ${a.auth ? '' : 'demo'}">${icons.check.replace('<svg', '<svg width="14" height="14"')}<span>@${esc(a.handle)}</span><small class="conn-kind">${a.auth ? (a.auth.expiresAt && a.auth.expiresAt < Date.now() && !a.auth.refreshToken ? 'expired' : 'Live') : 'Demo'}</small>${a.auth && isOAuth(a.platform) && isConfigured(a.platform) ? `<button class="btn small" data-action="connect" data-v="${a.platform}" title="Sign in again, e.g. to grant new permissions">Reconnect</button>` : ''}<button class="icon-btn" data-action="disconnect" data-id="${a.id}" aria-label="Disconnect" title="Disconnect">${icons.close}</button></div>`).join('')}</div>` : ''}
      <button class="btn small ${linked.length ? '' : 'primary'}" data-action="connect" data-v="${id}">${linked.length ? 'Add another' : 'Connect'}</button>
    </section>`;
  };
  return shell('Connected accounts', `
    <p class="sub">Connect the accounts you post from and the ones you publish to. You can connect several accounts per platform. Facebook, Instagram, TikTok, YouTube and Snapchat use each platform's own sign-in once they are set up under <a href="#/settings">Settings → Integrations</a>.</p>
    <div class="acc-grid">${PLATFORMS.map((p) => card(p.id)).join('')}</div>`, '#/accounts');
}

// `platform`: whose readiness tag the field shows.
const INTEGRATION_FIELDS: { key: keyof Integrations; platform?: OAuthPlatform; label: string; hint: string }[] = [
  { key: 'serverUrl', label: 'Server address', hint: 'Address of your deployed server (server/worker.js), e.g. https://crosspost-api.<name>.workers.dev. Needed for Facebook, Instagram and TikTok.' },
  { key: 'facebook', platform: 'facebook', label: 'Meta App ID', hint: 'Meta for Developers → your app → App settings → Basic. Used for Facebook and Instagram.' },
  { key: 'metaConfigId', platform: 'instagram', label: 'Instagram configuration ID', hint: 'Meta for Developers → your app → Facebook Login for Business → Configurations → “Instagram API (Unified Login)”.' },
  { key: 'tiktok', platform: 'tiktok', label: 'TikTok Client key', hint: 'TikTok for Developers → your app → App details.' },
  { key: 'youtube', platform: 'youtube', label: 'Google OAuth Client ID', hint: 'Google Cloud console → APIs & Services → Credentials (type: Web application). Works on its own for 1 hour per sign-in; with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on your server, YouTube access stays connected.' },
  { key: 'snapchat', platform: 'snapchat', label: 'Snapchat Public OAuth Client ID', hint: 'Snap Developer Portal → your app → OAuth client ID (public).' },
];

function integrationsCard() {
  const c = integrations();
  return `<form class="card stack" id="integrations-form" style="margin-top:20px">
    <div><h2>Integrations</h2><p class="sub" style="margin:0">Real sign-in for Facebook, Instagram, TikTok, YouTube and Snapchat. Client IDs are public; secrets belong only on the server. Values set while building the site are filled in already.</p></div>
    <div><span class="field-label">Redirect URI</span><input class="input" readonly value="${esc(redirectUri())}" onclick="this.select()"><div class="hint">Enter exactly this address as the allowed redirect / callback URL in every platform's developer settings.</div></div>
    <div class="form-grid">${INTEGRATION_FIELDS.map((f) => `<div><label class="field-label" for="int-${f.key}">${f.label}${f.platform ? (isConfigured(f.platform) ? ' <span class="tag live">ready</span>' : ' <span class="tag">not set</span>') : ''}</label><input class="input" id="int-${f.key}" data-int="${f.key}" value="${esc(c[f.key])}" autocomplete="off" spellcheck="false"><div class="hint">${f.hint}</div></div>`).join('')}</div>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">Save integrations</button></div>
  </form>`;
}

function viewSettings() {
  const u = store.currentUser()!;
  let zones: string[] = [];
  try { zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { zones = [u.timezone]; }
  if (!zones.includes(u.timezone)) zones.unshift(u.timezone);
  return shell('Settings', `
    <div class="grid-2">
      <form class="card stack" id="settings-form">
        <h2>Profile</h2>
        <div><label class="field-label" for="s-name">Name</label><input class="input" id="s-name" value="${esc(u.name)}"></div>
        <div><label class="field-label" for="s-email">Email</label><input class="input" id="s-email" value="${esc(u.email)}" disabled><div class="hint">Signed in with ${esc(u.method)}.</div></div>
        <div><label class="field-label" for="s-tz">Time zone</label><select class="select" id="s-tz">${zones.map((z) => `<option ${z === u.timezone ? 'selected' : ''}>${z}</option>`).join('')}</select></div>
        <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">Save changes</button></div>
      </form>
      <section class="card stack">
        <h2>Your data</h2>
        <p class="sub">Your posts, workflows and accounts are stored in this browser. Workflows with an Instagram source are also kept on the server, together with the sign-ins they need (encrypted), so they run while this page is closed.</p>
        <div class="row"><button class="btn" data-action="export">Download my data</button><button class="btn danger" data-action="wipe">Delete posts &amp; workflows</button></div>
        <h2 style="margin-top:24px">About publishing</h2>
        <p class="sub">Accounts marked <b>Live</b> publish for real. Accounts marked <b>Demo</b> are simulated. Posts you schedule here go out while the app is open in a browser; workflows from Instagram run on the server around the clock.</p>
      </section>
    </div>
    ${integrationsCard()}`, '#/settings');
}

// ---------- router ----------
function render() {
  if (!store.currentUser()) { location.replace(url('login/')); return; }
  const [path, query] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(query);
  const views: Record<string, () => string> = {
    '/': viewDashboard, '/create': () => viewCreate(params), '/posts': viewPosts, '/calendar': viewCalendar,
    '/workflows': viewWorkflows, '/workflows/new': () => viewWorkflowEdit(params), '/workflows/edit': () => viewWorkflowEdit(params),
    '/accounts': viewAccounts, '/settings': viewSettings,
  };
  const view = views[path!] ?? viewDashboard;
  const scroll = window.scrollY;
  const focusId = (document.activeElement as HTMLElement | null)?.id;
  root.innerHTML = view();
  document.title = `${root.querySelector('.topbar h1')?.textContent ?? 'Dashboard'} - Crosspost`;
  window.scrollTo(0, scroll);
  if (focusId) document.getElementById(focusId)?.focus();
  mount(path!);
}

function mount(path: string) {
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
      root.querySelector('#c-count')!.textContent = `${d.caption.length} characters`;
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
      if (!sourceId) { toast('Choose a source account'); return; }
      if (!destinationIds.length) { toast('Choose at least one destination'); return; }
      const old = store.workflows().find((w) => w.id === form.dataset.id);
      const src = store.account(sourceId)!;
      store.saveWorkflow({
        id: form.dataset.id!, name: val('#wf-name').value.trim() || `${platform(src.platform).name} to ${destinationIds.length} accounts`,
        sourceId, destinationIds, active: val('#wf-active').checked, autoPublish: val('#wf-auto').checked,
        captionTemplate: (form.querySelector('#wf-template') as HTMLTextAreaElement).value, hashtags: val('#wf-tags').value,
        removeWatermark: val('#wf-wm').checked, delayMinutes: Number((form.querySelector('#wf-delay') as HTMLSelectElement).value),
        createdAt: old?.createdAt ?? Date.now(), runs: old?.runs ?? 0,
      });
      scheduleSync();
      toast(old ? 'Workflow saved' : 'Workflow created');
      location.hash = '#/workflows';
    });
  }
  if (path === '/settings') {
    root.querySelector<HTMLFormElement>('#integrations-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const values: Record<string, string> = {};
      root.querySelectorAll<HTMLInputElement>('[data-int]').forEach((i) => { values[i.dataset.int!] = i.value.trim(); });
      saveIntegrations(values);
      toast('Integrations saved');
      render();
    });
    root.querySelector<HTMLFormElement>('#settings-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      store.updateUser({ name: root.querySelector<HTMLInputElement>('#s-name')!.value.trim(), timezone: root.querySelector<HTMLSelectElement>('#s-tz')!.value });
      toast('Settings saved');
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
  const page = PROVIDER_PAGE[id];
  modal(`<h3>${badge(id, 30)}Connect ${p.name}</h3><p>${p.hint} Enter the account name you want to connect.</p>
    <label class="field-label" for="m-handle">Account name</label><input class="input" id="m-handle" placeholder="@yourname">
    ${page ? `<p class="hint" style="margin-top:10px">Or use the <a href="${page}">${p.name} sign-in page</a>.</p>` : ''}
    <div class="row"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Connect</button></div>`, (el, close) => {
    const input = el.querySelector<HTMLInputElement>('#m-handle')!;
    input.focus();
    const ok = () => {
      const h = input.value.trim().replace(/^@/, '');
      if (!h) { input.focus(); return; }
      close();
      store.connectAccount(id, h);
      toast(`${p.name} @${h} connected`);
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
    case 'logout': store.signOut(); location.href = url('login/'); break;
    case 'pick-media': root.querySelector<HTMLInputElement>('#media-input')!.click(); break;
    case 'clear-media': if (draft) { if (draft.mediaUrl) URL.revokeObjectURL(draft.mediaUrl); Object.assign(draft, { file: undefined, mediaUrl: undefined, mediaName: '', mediaType: '', mediaSize: 0, thumb: undefined, ig: undefined }); render(); } break;
    case 'pick-ig': instagramPicker(); break;
    case 'toggle-dest': if (draft) { syncDraftFromForm(draft); const on = (el as HTMLInputElement).checked; if (on) draft.selected.add(id!); else draft.selected.delete(id!); render(); } break;
    case 'open-override': e.preventDefault(); syncDraftFromForm(draft!); draft!.open.add(id!); render(); break;
    case 'reset-override': e.preventDefault(); delete draft!.overrides[id!]; draft!.open.delete(id!); render(); break;
    case 'when': syncDraftFromForm(draft!); draft!.when = v as 'now' | 'later'; render(); break;
    case 'save-draft': savePostFromDraft(false); break;
    case 'publish': savePostFromDraft(true); break;
    case 'approve': if (post?.remote) remoteDo(post, 'approve', 'Approved: publishing'); else if (post) { post.deliveries.forEach((d) => { if (d.status === 'draft') d.status = 'scheduled'; }); if (post.scheduledAt < Date.now()) post.scheduledAt = Date.now(); store.savePost(post); processQueue(); toast('Approved: publishing'); } break;
    case 'retry': if (post?.remote) remoteDo(post, 'retry', 'Trying again'); else if (post) { post.deliveries.forEach((d) => { if (d.status === 'failed') { d.status = 'scheduled'; d.error = undefined; } }); post.scheduledAt = Math.min(post.scheduledAt, Date.now()); store.savePost(post); processQueue(); } break;
    case 'delete-post': if (post) confirmBox('Delete this post?', 'It is removed from your content list. Posts already published stay on the platforms.', 'Delete', () => { if (post.remote) remoteDo(post, 'delete', 'Post deleted'); else { store.deletePost(post.id); toast('Post deleted'); } }); break;
    case 'tab': postTab = v as typeof postTab; render(); break;
    case 'cal': calMonth = v === '0' ? new Date(new Date().getFullYear(), new Date().getMonth(), 1) : new Date(calMonth.getFullYear(), calMonth.getMonth() + Number(v), 1); render(); break;
    case 'wf-toggle': { const w = store.workflows().find((x) => x.id === id); if (w) { w.active = (el as HTMLInputElement).checked; store.saveWorkflow(w); scheduleSync(); toast(w.active ? 'Workflow active' : 'Workflow paused'); } break; }
    case 'wf-run': {
      const w = store.workflows().find((x) => x.id === id);
      if (w && runsOnServer(w)) {
        toast('Checking Instagram…');
        runServerWorkflow(w.id)
          .then((r) => toast(r.found ? `Picked up the latest video – see Content` : 'No new video on Instagram'))
          .catch((err: Error) => toast(err.message));
      } else if (w) runWorkflow(w);
      break;
    }
    case 'wf-delete': { const w = store.workflows().find((x) => x.id === id); if (w) confirmBox('Delete workflow?', `"${w.name}" stops picking up new content.`, 'Delete', () => { store.deleteWorkflow(w.id); scheduleSync(); toast('Workflow deleted'); }); break; }
    case 'connect': {
      const id = v as PlatformId;
      if (isOAuth(id) && isConfigured(id)) startOAuth(id).catch((e: Error) => toast(e.message));
      else connectDialog(id);
      break;
    }
    case 'disconnect': { const a = store.account(id!); if (a) confirmBox(`Disconnect @${a.handle}?`, 'Workflows that use this account stop sending to it.', 'Disconnect', () => { store.disconnectAccount(a.id); scheduleSync(); }); break; }
    case 'export': {
      const data = { user: { ...store.currentUser(), passwordHash: undefined }, accounts: store.accounts(), workflows: store.workflows(), posts: store.posts().map((p) => ({ ...p, thumb: undefined })) };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = 'crosspost-data.json';
      a.click();
      break;
    }
    case 'wipe': confirmBox('Delete all posts and workflows?', 'Connected accounts stay. This cannot be undone.', 'Delete all', () => { store.posts().slice().forEach((p) => store.deletePost(p.id)); store.workflows().slice().forEach((w) => store.deleteWorkflow(w.id)); scheduleSync(); toast('Deleted'); }); break;
  }
});

window.addEventListener('hashchange', () => { root.querySelector('.shell')?.classList.remove('open'); window.scrollTo(0, 0); render(); });
// Re-render on data changes, but never while typing in the composer or a form.
store.onChange(() => {
  const a = document.activeElement;
  if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && root.contains(a) && (a as HTMLInputElement).type !== 'checkbox') return;
  if (document.querySelector('.modal-back')) return;
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
