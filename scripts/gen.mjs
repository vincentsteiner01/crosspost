// Writes the static HTML entry pages before Vite builds them, so shared
// markup (the login card, the provider pages) lives in one place.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { icons } from '../src/lib/icons.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = 'Crosspost';
// Sub-folder the site is served from (GitHub Pages: /<repository>/). Vite fixes
// scripts, styles and pictures itself; plain links are prefixed here.
const BASE = (process.env.BASE_PATH || '/').replace(/\/?$/, '/');

function page({ title, body, script, bodyClass = '', lang = '' }) {
  return `<!doctype html>
<html${lang ? ` lang="${lang}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${BRAND}">
<title>${title}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body class="${bodyClass}">
${body}
<script type="module" src="${script}"></script>
</body>
</html>
`;
}

function write(rel, html) {
  html = html.replace(/(<a\b[^>]*?\bhref=")\/(?!\/)/g, `$1${BASE}`);
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

// Blurred backdrop: a drawn stand-in for the marketing page behind the card.
const backdrop = `<img src="/img/signup-bg.svg" alt="" class="bg-image">`;

const providerButtons = [
  { id: 'loginWithGoogle', href: '/loginWithGoogle', icon: icons.google, label: 'Continue with Google' },
  { id: 'loginWithEmailBtn', button: true, icon: icons.mail, label: 'Continue with email' },
  { id: 'loginWithYoutube', href: '/loginWithYoutube', icon: icons.youtube, label: 'Continue with YouTube' },
  { id: 'signupWithFacebook', href: '/signupWithFacebook', icon: icons.facebook, label: 'Continue with Facebook' },
  { id: 'loginWithAmazon', href: '/signinWithAmazon', icon: icons.amazon, label: 'Continue with Amazon' },
];

function socialButtons() {
  return providerButtons
    .map((b) =>
      b.button
        ? `<div class="form-group"><button type="button" class="provider-btn" id="${b.id}">${b.icon}<strong>${b.label}</strong></button></div>`
        : `<div class="form-group"><a class="provider-btn provider-link" id="${b.id}" href="${b.href}">${b.icon}<strong>${b.label}</strong></a></div>`,
    )
    .join('\n');
}

function authCard({ mode }) {
  const isLogin = mode === 'login';
  const title = isLogin ? 'Welcome back!' : 'Create your account';
  const subtitle = isLogin ? 'Sign in to start repurposing' : 'Start repurposing your content for free';
  const emailTitle = isLogin ? 'Continue with email' : 'Sign up with email';
  const submit = isLogin ? 'Sign In' : 'Create account';
  const footer = isLogin
    ? `<span class="muted-black">Don't have an account?</span> <a href="/signup" class="pink-link" id="signin-btn-link">Sign up for free</a>`
    : `<span class="muted-black">Already have an account?</span> <a href="/login" class="pink-link" id="signin-btn-link">Sign in</a>`;
  return `
<div class="bg-section">
  ${backdrop}
  <div class="login-main">
    <div class="login-card">
      <form id="form-auth" data-mode="${mode}" novalidate>
        <div id="titleSection" class="title-section">
          <h3 class="form-title">${title}</h3>
          <span class="form-subtitle">${subtitle}</span>
        </div>
        <div id="auth-error" class="auth-error" hidden></div>
        <div id="socialButtons">
${socialButtons()}
        </div>
        <div id="emailSection" hidden>
          <button class="back-button" id="backButton" type="button">${icons.chevronLeft}<h1 class="back-title">${emailTitle}</h1></button>
          ${isLogin ? '' : `<div class="form-group field"><label class="custom-label" for="auth-name">Name</label><input type="text" id="auth-name" class="form-control" placeholder="Enter your name" autocomplete="name"></div>`}
          <div class="form-group field">
            <label class="custom-label" for="auth-email">Email</label>
            <input type="text" id="auth-email" class="form-control" placeholder="Enter your email address" autocomplete="email">
          </div>
          <div class="form-group field">
            <label class="custom-label" for="auth-password">Password</label>
            <div class="password-wrapper">
              <input type="password" id="auth-password" class="form-control" placeholder="Password" maxlength="100" autocomplete="${isLogin ? 'current-password' : 'new-password'}">
              <button type="button" id="toggle-password" class="toggle-password" aria-label="Show password">${icons.eye}</button>
            </div>
          </div>
          ${isLogin ? `<div class="forgot-row"><a href="/forgot" class="forgot-link">Forgot your password?</a></div>` : ''}
          <button id="auth-submit" type="submit" class="submit-btn">${icons.spinner}<span>${submit}</span></button>
        </div>
      </form>
      <div class="signup-row">${footer}</div>
      <div class="terms-row"><a href="/terms" target="_blank">Terms of service</a> - <a href="/privacy" target="_blank">Privacy policy</a></div>
    </div>
  </div>
</div>`;
}

write('index.html', page({ title: `Login - ${BRAND}`, body: authCard({ mode: 'login' }), script: '/src/pages/login.ts', bodyClass: 'auth-page' }));
write('login/index.html', page({ title: `Login - ${BRAND}`, body: authCard({ mode: 'login' }), script: '/src/pages/login.ts', bodyClass: 'auth-page' }));
write('signup/index.html', page({ title: `Sign up - ${BRAND}`, body: authCard({ mode: 'signup' }), script: '/src/pages/login.ts', bodyClass: 'auth-page' }));

// Forgot password: a simple card in the same frame.
write(
  'forgot/index.html',
  page({
    title: `Forgot password - ${BRAND}`,
    bodyClass: 'auth-page',
    script: '/src/pages/forgot.ts',
    body: `<div class="bg-section">${backdrop}<div class="login-main"><div class="login-card">
      <form id="form-forgot" novalidate>
        <a class="back-button" href="/login">${icons.chevronLeft}<h1 class="back-title">Reset your password</h1></a>
        <p class="form-subtitle small">Enter the email address of your account. We will send you a link to choose a new password.</p>
        <div id="forgot-msg" class="auth-error" hidden></div>
        <div class="form-group field"><label class="custom-label" for="forgot-email">Email</label><input type="text" id="forgot-email" class="form-control" placeholder="Enter your email address"></div>
        <button type="submit" class="submit-btn">${icons.spinner}<span>Send reset link</span></button>
      </form>
      <div class="signup-row"><span class="muted-black">Remembered it?</span> <a href="/login" class="pink-link">Sign in</a></div>
    </div></div></div>`,
  }),
);

// Plain text pages linked from the footer.
const textPage = (heading, paras) => `<main class="text-page"><a href="/login" class="text-back">${icons.chevronLeft} Back to sign in</a><h1>${heading}</h1>${paras.map((p) => `<p>${p}</p>`).join('')}</main>`;
write(
  'privacy/index.html',
  page({
    title: `Privacy policy - ${BRAND}`,
    script: '/src/pages/plain.ts',
    body: textPage('Privacy policy', [
      'Your profile, workflows and posts are kept in your own browser (local storage).',
      'When you connect Facebook, Instagram, TikTok, YouTube or Snapchat, you sign in on that platform and allow this app to publish for you. The access it receives is stored in your browser and used only to publish the posts you create or approve.',
      'Videos you publish to Facebook, Instagram or TikTok are uploaded to our server so the platform can fetch them, and are deleted after publishing. YouTube uploads go straight from your browser to YouTube.',
      '<strong>Deleting your data:</strong> disconnect an account under Connected accounts, or delete everything under Settings → Your data. You can also remove the app in the settings of each platform (for example Facebook → Settings → Apps and websites). Questions: write to the address given in the imprint of this site.',
    ]),
  }),
);
write(
  'terms/index.html',
  page({
    title: `Terms of service - ${BRAND}`,
    script: '/src/pages/plain.ts',
    body: textPage('Terms of service', [
      'Sample terms for this rebuild. Replace this text with your own terms before you publish the tool.',
      'Only post content you own or have the rights to share, and follow the rules of every platform you publish to.',
    ]),
  }),
);

// Provider pages: our own "connect your account" step, with no password field.
// Three layouts, following where each original puts its parts.
const providers = [
  { path: 'loginWithGoogle', key: 'google', name: 'Google', icon: icons.google, connects: 'youtube', layout: 'card', lang: 'de' },
  { path: 'loginWithYoutube', key: 'youtube', name: 'YouTube', icon: icons.youtube, connects: 'youtube', layout: 'card', lang: 'de' },
  { path: 'signupWithFacebook', key: 'facebook', name: 'Facebook', icon: icons.facebook, connects: 'facebook', layout: 'split', lang: 'de' },
  { path: 'signinWithAmazon', key: 'amazon', name: 'Amazon', icon: icons.amazon, connects: 'amazon', layout: 'box', lang: 'de-DE' },
];

const helpText = (p) => `<p class="connect-help" id="connect-help-text" hidden>Ist die Verbindung zu ${p.name} eingerichtet, leitet dich diese Seite direkt zur Anmeldung bei ${p.name} weiter – dein Passwort gibst du nur dort ein, nie hier. Solange sie nicht eingerichtet ist, wird das Konto nur als Demo in diesem Browser gemerkt.</p>`;
const footLinks = `<nav><a href="/login">Hilfe</a><a href="/privacy">Datenschutz</a><a href="/terms">Nutzungsbedingungen</a></nav>`;

function cardLayout(p) {
  return `<div class="connect-wrap">
  <main class="connect-card" data-provider="${p.key}" data-connects="${p.connects}">
    <div class="connect-head">${p.icon}<span>Über ${p.name} anmelden</span></div>
    <div class="connect-body">
      <div class="connect-logo">${icons.logoMark}</div>
      <h1>Anmeldung</h1>
      <p class="connect-sub">Weiter zu <a href="/login">${BRAND}</a></p>
      <form id="connect-form" novalidate>
        <div class="outlined">
          <label for="connect-email">E-Mail oder Name des Kontos</label>
          <input id="connect-email" type="text" autocomplete="email">
        </div>
        <div id="connect-error" class="connect-error" hidden></div>
        <a href="#" class="connect-link" id="connect-help">Was passiert mit meinen Daten?</a>
        ${helpText(p)}
        <p class="connect-note">Bevor Sie ${BRAND} verwenden, können Sie die <a href="/privacy">Datenschutzerklärung</a> und die <a href="/terms">Nutzungsbedingungen</a> lesen, die für diese App gelten.</p>
        <div class="connect-actions">
          <a href="/signup" class="connect-link">Konto erstellen</a>
          <button type="submit" class="connect-next">Weiter</button>
        </div>
      </form>
    </div>
  </main>
  <footer class="connect-foot">
    <div class="connect-lang"><select aria-label="Sprache ändern"><option>Deutsch</option><option>English (United States)</option><option>Español</option><option>Français</option><option>Português (Brasil)</option></select><i></i></div>
    <ul class="connect-links"><li><a href="/login">Hilfe</a></li><li><a href="/privacy">Datenschutz</a></li><li><a href="/terms">Nutzungsbedingungen</a></li></ul>
  </footer>
</div>`;
}

function splitLayout(p) {
  return `<div class="split-wrap">
  <header class="split-head"><a href="/login" class="split-logo" aria-label="${BRAND}">${icons.logoMark}</a></header>
  <main class="split-main">
    <section class="split-hero">
      <div class="split-art" aria-hidden="true"><i></i><i></i><i></i></div>
      <h2>Poste<br>einmal,<br>erreiche<br><span>alle<br>Kanäle.</span></h2>
    </section>
    <section class="split-form connect-card" data-provider="${p.key}" data-connects="${p.connects}">
      <h1>Mit ${p.name} fortfahren</h1>
      <form id="connect-form" novalidate>
        <div class="split-field"><input id="connect-email" type="text" autocomplete="email" placeholder="E-Mail-Adresse oder Kontoname" aria-label="E-Mail-Adresse oder Kontoname"></div>
        <div class="split-field split-field-2"><input id="connect-page" type="text" placeholder="Facebook-Seite, auf der du posten willst (optional)" aria-label="Facebook-Seite (optional)"></div>
        <div id="connect-error" class="connect-error" hidden></div>
        <button type="submit" class="connect-next split-btn">Weiter</button>
        <p class="split-center"><a href="#" class="connect-link" id="connect-help">Was passiert hier?</a></p>
        ${helpText(p)}
        <p class="split-center split-business"><a href="/privacy" class="connect-link">Welche Daten werden gespeichert?</a></p>
        <div class="connect-actions split-actions"><a href="/signup" class="split-outline connect-link">Neues Konto erstellen</a></div>
      </form>
      <p class="split-brand">${icons.logoMark}<span>${BRAND}</span></p>
    </section>
  </main>
  <footer class="split-foot">
    <nav class="split-langs"><a href="#">Deutsch</a><a href="#">English (US)</a><a href="#">Türkçe</a><a href="#">Polski</a><a href="#">Italiano</a><a href="#">Română</a><a href="#">Français (France)</a><a href="#">Weitere Sprachen …</a></nav>
  </footer>
  <div class="consent-back" id="consent" hidden>
    <div class="consent" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div class="consent-scroll">
        <div class="consent-top"><button type="button" class="consent-more" aria-label="Mehr Optionen">···</button></div>
        <h2 id="consent-title">Darf ${BRAND} Daten zu deinem ${p.name}-Konto in diesem Browser merken?</h2>
        <p>Damit du dein ${p.name}-Konto verbinden und Beiträge planen kannst, speichert ${BRAND} einige Angaben lokal in diesem Browser: dein Profil, die verbundenen Konten, deine Workflows und Beiträge. Sie verlassen deinen Browser nur, wenn du etwas veröffentlichst: Dann geht das Video an die Plattform und bei Facebook, Instagram und TikTok an unseren Server.</p>
        <ul>
          <li>Notwendige Speicherung: Anmeldung, verbundene Konten und geplante Beiträge. Ohne sie kann die App nichts für dich veröffentlichen und nichts behalten.</li>
          <li>Optionale Speicherung: Sprache, die zuletzt gewählte Ansicht im Kalender, benutzte Filter und Entwürfe, die du noch nicht gespeichert hast. Sie machen die Bedienung bequemer und lassen sich jederzeit in den Einstellungen unter „Your data“ löschen.</li>
        </ul>
        <p>Du entscheidest, ob wir die optionalen Daten speichern dürfen. In der <a href="/privacy">Datenschutzerklärung</a> steht genau, was gespeichert wird und wie du es wieder löschst. Deine Auswahl kannst du jederzeit in den Einstellungen ändern.</p>
        <hr>
        <h3>Mehr dazu lesen</h3>
        <div class="consent-cards"><div class="consent-card"><i></i><b>Was wird gespeichert?</b></div><div class="consent-card"><i></i><b>Wie lösche ich es?</b></div></div>
      </div>
      <div class="consent-actions"><button type="button" class="consent-decline" data-consent="necessary">Nur Notwendiges erlauben</button><button type="button" class="consent-accept" data-consent="all">Alles erlauben</button></div>
    </div>
  </div>
</div>`;
}

function boxLayout(p) {
  return `<div class="box-wrap">
  <header class="box-logo"><a href="/login">${icons.logoMark}<span>${BRAND}</span></a></header>
  <main>
    <div class="box-card connect-card" data-provider="${p.key}" data-connects="${p.connects}">
      <h1>Anmelden</h1>
      <form id="connect-form" novalidate>
        <label for="connect-email" class="box-label">${p.name}-Konto oder E-Mail-Adresse eingeben</label>
        <input id="connect-email" class="box-input" type="text" autocomplete="email">
        <div id="connect-error" class="connect-error" hidden></div>
        <button type="submit" class="connect-next box-btn">Weiter</button>
        <p class="box-small">Indem Sie fortfahren, erklären Sie sich mit den <a href="/terms">Nutzungsbedingungen</a> und der <a href="/privacy">Datenschutzerklärung</a> von ${BRAND} einverstanden.</p>
        <a href="#" class="box-help" id="connect-help">Benötigst du Hilfe? <i></i></a>
        ${helpText(p)}
        <div class="connect-actions" hidden><a href="/signup" class="connect-link">Konto erstellen</a></div>
      </form>
    </div>
    <div class="box-divider"><span>Neu bei ${BRAND}?</span></div>
    <a href="/signup" class="box-create">Dein ${BRAND}-Konto erstellen</a>
  </main>
  <footer class="box-foot">
    <ul class="box-links"><li><a href="/terms">Nutzungsbedingungen</a></li><li><a href="/privacy">Datenschutzerklärung</a></li><li><a href="/login">Hilfe</a></li></ul>
    <p>© 2026 ${BRAND}</p>
  </footer>
</div>`;
}

for (const p of providers) {
  const body = p.layout === 'split' ? splitLayout(p) : p.layout === 'box' ? boxLayout(p) : cardLayout(p);
  write(
    `${p.path}/index.html`,
    page({ title: `Mit ${p.name} anmelden - ${BRAND}`, script: '/src/pages/connect.ts', bodyClass: `connect-page layout-${p.layout}`, body, lang: p.lang }),
  );
}

// Where every platform sends the person back after signing in.
write(
  'oauth/callback/index.html',
  page({
    title: `Verbinden - ${BRAND}`,
    script: '/src/pages/callback.ts',
    bodyClass: 'auth-page',
    body: `<main class="text-page"><h1 id="oauth-status">Verbinde Konto …</h1><p id="oauth-detail">Einen Moment bitte.</p><a id="oauth-back" class="pink-link" href="/login" hidden>Zurück</a></main>`,
  }),
);

// The app behind the login.
write(
  'dashboard/index.html',
  page({ title: `Dashboard - ${BRAND}`, script: '/src/pages/app.ts', bodyClass: 'app-page', body: `<div id="app"></div>` }),
);

export const entries = [
  'index.html', 'login/index.html', 'signup/index.html', 'forgot/index.html', 'privacy/index.html', 'terms/index.html',
  ...providers.map((p) => `${p.path}/index.html`), 'dashboard/index.html', 'oauth/callback/index.html',
];
console.log(`wrote ${entries.length} pages`);
