// Writes the static HTML entry pages before Vite builds them.
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

// Plain text pages linked from the footer.
const textPage = (heading, paras) => `<main class="text-page"><a href="/dashboard/" class="text-back">${icons.chevronLeft} Back to Crosspost</a><h1>${heading}</h1>${paras.map((p) => `<p>${p}</p>`).join('')}</main>`;
write(
  'privacy/index.html',
  page({
    title: `Privacy policy - ${BRAND}`,
    script: '/src/pages/plain.ts',
    body: textPage('Privacy policy', [
      'Your profile, posts and workflows are kept in your own browser (local storage). Videos you post from this browser are kept there too, so you can watch a post again; you can remove them under Settings.',
      'When you connect Facebook, Instagram, TikTok, YouTube or Snapchat, you sign in on that platform and allow this app to publish for you. The access it receives is stored in your browser. For workflows and scheduled posts it is also stored on our server, encrypted, so posts can go out while the app is closed; disconnecting an account removes it there as well.',
      'Videos you schedule or publish through the server are kept there only until every platform has fetched them (at most 60 days for scheduled posts) and are then deleted. YouTube uploads made right away go straight from your browser to YouTube.',
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

// Where every platform sends the person back after signing in.
write(
  'oauth/callback/index.html',
  page({
    title: `Verbinden - ${BRAND}`,
    script: '/src/pages/callback.ts',
    bodyClass: 'auth-page',
    body: `<main class="text-page"><h1 id="oauth-status">Verbinde Konto …</h1><p id="oauth-detail">Einen Moment bitte.</p><a id="oauth-back" class="pink-link" href="/dashboard/#/accounts" hidden>Zurück</a></main>`,
  }),
);

// The app itself – there is no sign-in.
write(
  'dashboard/index.html',
  page({ title: `Dashboard - ${BRAND}`, script: '/src/pages/app.ts', bodyClass: 'app-page', body: `<div id="app"></div>` }),
);

// No sign-in: the start page and the old sign-in addresses lead straight into the app.
const redirect = (to) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${to}">
<title>${BRAND}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body><a href="${to}">${BRAND} öffnen</a></body>
</html>
`;
write('index.html', redirect('dashboard/'));
write('login/index.html', redirect('../dashboard/'));
write('signup/index.html', redirect('../dashboard/'));

export const entries = [
  'index.html', 'login/index.html', 'signup/index.html', 'privacy/index.html', 'terms/index.html', 'dashboard/index.html', 'oauth/callback/index.html',
];
console.log(`wrote ${entries.length} pages`);
